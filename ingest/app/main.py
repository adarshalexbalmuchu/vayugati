"""FastAPI service: hourly ingestion of OpenAQ + Open-Meteo into Supabase.

Run locally:  uvicorn app.main:app --port 8000
Trigger now:  curl -X POST localhost:8000/run
"""

import logging
import threading
from contextlib import asynccontextmanager

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import anomaly_detection, attribution
from . import classify as classify_mod
from . import (
    config,
    data_gov_cpcb,
    db,
    delhi_otd,
    dispatch,
    forecast,
    ingest,
    latest_readings,
    notifications,
    source_attribution,
    station_matching,
    transit_activity,
)
from .health_checks import compute_health
from .logging_utils import run_tracked

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
# httpx logs the full request URL (including query-string params) at INFO -
# delhi_otd.py and data_gov_cpcb.py both pass their API key as a query
# param (?key=/?api-key=, the only way those APIs accept it), so leaving
# httpx at the root INFO level would print live secrets into this service's
# logs on every request. Suppressed here, once, for every module that
# imports httpx through this process - not just the two above.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

_lock = threading.Lock()
_intel_lock = threading.Lock()
_ops_lock = threading.Lock()
_transit_lock = threading.Lock()
_cpcb_lock = threading.Lock()
_last_run: dict | None = None
_last_intel: dict | None = None
_last_ops: dict | None = None
_last_transit: dict | None = None
_last_cpcb_reconcile: list[dict] | None = None


def run_ingest() -> dict:
    global _last_run
    if not _lock.acquire(blocking=False):
        raise RuntimeError("ingest already running")
    try:
        _last_run = run_tracked("ingest", ingest.run)
        return _last_run
    finally:
        _lock.release()


def run_intel() -> dict:
    """Forecast + attribution + anomaly detection + source attribution. Runs
    after ingest so it sees fresh readings — anomaly detection in particular
    needs the just-ingested rows to evaluate persistence/rate-of-increase
    against, and source attribution runs LAST because it reads anomaly
    detection's own local-excess/regional-pattern signal for the freshest
    incidents.

    Each sub-job is wrapped individually with `run_tracked` (its own
    job_runs row, its own structured log line) rather than the whole bundle
    sharing one row — and, since `run_tracked` never re-raises, one job
    failing does not prevent the others from still running. This
    Python-level in-process lock (`_intel_lock`) only prevents THIS process
    from starting a second overlapping `run_intel()`; `job_runs`' own
    unique-index guard is the broader protection that also holds across
    multiple process instances, should this service ever be scaled out.

    `job_runs.job_name` reserves exactly one 'attribution' slot (matching
    plan §8's own wording, "source attribution") — mapped to
    `source_attribution.py` (Phase 7's per-incident scoring engine), the
    one command actually acts on. `attribution.py`'s older wind-rose
    "look here now" pointer is a smaller, secondary directional hint with
    no incident/dispatch consequences of its own, so it runs plainly
    (still logged on failure, just not job_runs-tracked) rather than
    contending the same tracked name.
    """
    global _last_intel
    if not _intel_lock.acquire(blocking=False):
        raise RuntimeError("intel already running")
    try:
        forecast_result = run_tracked("forecast", forecast.run)
        try:
            attribution_result = attribution.run()
        except Exception:
            logging.getLogger("ingest").exception("attribution (wind-rose) failed")
            attribution_result = None
        _last_intel = {
            "forecast": forecast_result,
            "attribution": attribution_result,
            "anomaly_detection": run_tracked("anomaly_detection", anomaly_detection.run),
            "source_attribution": run_tracked("attribution", source_attribution.run),
        }
        return _last_intel
    finally:
        _intel_lock.release()


def run_ops() -> dict:
    """Notification delivery + SLA escalation (Phase 9). Runs on a shorter
    cadence than run_intel — a dispatched task's acknowledgement/SLA clock is
    already ticking, so this can't wait for the hourly cycle."""
    global _last_ops
    if not _ops_lock.acquire(blocking=False):
        raise RuntimeError("ops already running")
    try:
        _last_ops = {
            "notifications": run_tracked("notifications", notifications.run),
            "escalation": run_tracked("escalation", dispatch.run),
        }
        return _last_ops
    finally:
        _ops_lock.release()


def run_transit() -> dict:
    """Delhi OTD transport-activity context layer (audit-only integration -
    see docs/data/delhi-otd-transport-context-integration-report.md). Runs
    plainly, not via run_tracked(), same as attribution.run() above — its
    result isn't one of job_runs' 6 CHECK-constrained job_name values, and
    adding a 7th needs a migration this integration deliberately avoids.
    Never raises: an unset key or a failed fetch/decode just yields an
    explicitly "unavailable" summary (transit_activity.unavailable_summary),
    so the rest of the app never has to guess why the numbers are empty."""
    global _last_transit
    if not _transit_lock.acquire(blocking=False):
        raise RuntimeError("transit already running")
    try:
        vehicles = delhi_otd.fetch_vehicle_positions()
        if vehicles is None:
            _last_transit = transit_activity.unavailable_summary(
                "Delhi OTD key not configured or the real-time feed did not respond"
            )
        else:
            try:
                wards = db.get_hotspot_wards()
                _last_transit = transit_activity.summarize_activity([v.as_dict() for v in vehicles], wards)
            except Exception:
                logging.getLogger("ingest").exception("transit activity ward lookup failed")
                _last_transit = transit_activity.unavailable_summary("Could not load ward data to score against")
        return _last_transit
    finally:
        _transit_lock.release()


def run_cpcb_reconcile() -> list[dict]:
    """CPCB/data.gov preferred-latest-reading reconciliation (audit/context
    integration - see docs/data/cpcb-data-gov-primary-latest-integration-
    report.md). Runs plainly, not via run_tracked(), same reason as
    run_transit() above. Never raises: an unset DATA_GOV_API_KEY or a
    failed fetch leaves data_gov_cpcb.fetch_delhi_records() returning None,
    which reconcile_latest() below still handles cleanly - every one of our
    stations still gets a row, just with source_used='openaq_fallback'
    across the board, not an empty/broken result."""
    global _last_cpcb_reconcile
    if not _cpcb_lock.acquire(blocking=False):
        raise RuntimeError("cpcb reconcile already running")
    try:
        our_stations = db.get_all_stations()
        our_latest = db.get_latest_readings_by_station([s["id"] for s in our_stations])
        match_index = station_matching.build_match_index(our_stations)

        records = data_gov_cpcb.fetch_delhi_records()
        cpcb_by_station = data_gov_cpcb.group_by_station(records) if records else {}

        _last_cpcb_reconcile = latest_readings.reconcile_latest(our_stations, cpcb_by_station, match_index, our_latest)
        return _last_cpcb_reconcile
    except Exception:
        # Genuinely unexpected (e.g. our own Supabase read failing) - not
        # the missing-key/API-failure paths above, which never reach here.
        logging.getLogger("ingest").exception("cpcb reconcile failed")
        _last_cpcb_reconcile = []
        return _last_cpcb_reconcile
    finally:
        _cpcb_lock.release()


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.require_env()
    scheduler = BackgroundScheduler(timezone="UTC")
    # minute 10 each hour: CPCB/DPCC stations publish on the hour, give them a head start
    scheduler.add_job(run_ingest, "cron", minute=10)
    # minute 25: recompute forecast + attribution on the freshly-ingested data
    scheduler.add_job(run_intel, "cron", minute=25)
    # every 5 minutes: drain pending notifications and escalate overdue tasks
    scheduler.add_job(run_ops, "interval", minutes=5)
    # every 5 minutes: refresh the Delhi OTD transport-activity context layer.
    # A no-op (unavailable_summary) rather than an error when unconfigured -
    # see run_transit's own docstring.
    scheduler.add_job(run_transit, "interval", minutes=5)
    # every 10 minutes: refresh the CPCB/data.gov preferred-latest-reading
    # reconciliation - see run_cpcb_reconcile's own docstring for its
    # graceful-degradation contract.
    scheduler.add_job(run_cpcb_reconcile, "interval", minutes=10)
    scheduler.start()

    # first pass immediately: ingest, then intel once readings land
    def _bootstrap():
        try:
            run_ingest()
        except Exception:
            logging.exception("bootstrap ingest failed")
        try:
            run_intel()
        except Exception:
            logging.exception("bootstrap intel failed")
        try:
            run_ops()
        except Exception:
            logging.exception("bootstrap ops failed")
        try:
            run_transit()
        except Exception:
            logging.exception("bootstrap transit failed")
        try:
            run_cpcb_reconcile()
        except Exception:
            logging.exception("bootstrap cpcb reconcile failed")

    threading.Thread(target=_bootstrap, daemon=True).start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="Vayu Gati ingest", lifespan=lifespan)

if config.ENVIRONMENT == "production" and config.ALLOWED_ORIGINS == config.DEFAULT_ALLOWED_ORIGINS:
    logging.warning(
        "ENVIRONMENT=production but ALLOWED_ORIGINS is still the localhost dev default — "
        "set ALLOWED_ORIGINS to the real deployed frontend domain(s)."
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class ClassifyRequest(BaseModel):
    report_id: int
    description: str
    ward_name: str
    photo_url: str | None = None


@app.get("/health")
def health():
    """Degraded, not just up/down (plan §9): reports database connectivity,
    reading freshness, and every tracked job's last-run status via the same
    system_health_summary() the command-centre System Health screen reads."""
    result = compute_health()
    result["last_run"] = _last_run
    result["last_intel"] = _last_intel
    result["last_ops"] = _last_ops
    return result


@app.post("/run")
def trigger_run():
    try:
        return run_ingest()
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.post("/transit/refresh")
def trigger_transit_refresh():
    """Recompute the transit-activity summary now, same manual-trigger
    pattern as /run, /intel, /ops."""
    try:
        return run_transit()
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.get("/transit/activity")
def transit_activity_endpoint():
    """Delhi OTD public-transport activity context layer (audit-only
    integration - see docs/data/delhi-otd-transport-context-integration-
    report.md). Read-only, no auth beyond this service's own CORS policy -
    it never returns anything more sensitive than a derived vehicle/route
    count per ward; the API key and raw protobuf never leave run_transit().
    Returns the last scheduled refresh (every 5 minutes) rather than
    fetching live on each request, so this endpoint is always fast and
    never itself depends on Delhi OTD being up at request time."""
    if _last_transit is None:
        return transit_activity.unavailable_summary("Not yet refreshed since service start")
    return _last_transit


@app.post("/readings/refresh")
def trigger_readings_refresh():
    """Recompute the CPCB/data.gov preferred-latest-reading reconciliation
    now, same manual-trigger pattern as /run, /intel, /ops, /transit/refresh."""
    try:
        return run_cpcb_reconcile()
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.get("/readings/latest")
def latest_readings_endpoint():
    """CPCB/data.gov preferred-latest-reading reconciliation, one row per
    station (audit/context integration - see docs/data/cpcb-data-gov-
    primary-latest-integration-report.md). Read-only; DATA_GOV_API_KEY
    never leaves run_cpcb_reconcile(). Returns the last scheduled refresh
    (every 10 minutes) - an empty list before the first refresh completes,
    never an error."""
    return _last_cpcb_reconcile if _last_cpcb_reconcile is not None else []


@app.post("/intel")
def trigger_intel():
    """Recompute forecast + attribution now."""
    try:
        return run_intel()
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.post("/ops")
def trigger_ops():
    """Drain pending notifications + escalate overdue task dispatches now."""
    try:
        return run_ops()
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.post("/classify")
def classify(req: ClassifyRequest):
    """Classify a report and write ai_category + ai_meta back to the reports row."""
    result = classify_mod.classify_report(req.description, req.ward_name, req.photo_url)
    db.client().table("reports").update(
        {
            "ai_category": result["category"],
            "ai_meta": {
                "confidence": result.get("confidence"),
                "note_draft": result.get("note_draft"),
                "hindi_advisory": result.get("hindi_advisory"),
            },
        }
    ).eq("id", req.report_id).execute()
    return result
