"""FastAPI service: hourly ingestion of OpenAQ + Open-Meteo into Supabase.

Run locally:  uvicorn app.main:app --port 8000
Trigger now:  curl -X POST localhost:8000/run
"""

import logging
import secrets
import threading
import time
from contextlib import asynccontextmanager

import sentry_sdk
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
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
from .logging_utils import cleanup_stuck_jobs, run_tracked

if config.SENTRY_DSN:
    sentry_sdk.init(
        dsn=config.SENTRY_DSN,
        environment=config.ENVIRONMENT,
        traces_sample_rate=0.05,
    )

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
# httpx logs the full request URL (including query-string params) at INFO -
# delhi_otd.py and data_gov_cpcb.py both pass their API key as a query
# param (?key=/?api-key=, the only way those APIs accept it), so leaving
# httpx at the root INFO level would print live secrets into this service's
# logs on every request. Suppressed here, once, for every module that
# imports httpx through this process - not just the two above.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

def _require_ingest_key(x_ingest_key: str = Header(alias="X-Ingest-Key", default="")) -> None:
    """FastAPI dependency — gates every mutating endpoint. /health is public.

    When INGEST_API_KEY is unset (local dev), the check is skipped so local
    curl/test usage doesn't require the header. In staging/production the key
    must be set or the service refuses to start (see require_env below)."""
    if not config.INGEST_API_KEY:
        return  # local/dev: key not configured, allow all
    if not x_ingest_key or not secrets.compare_digest(x_ingest_key, config.INGEST_API_KEY):
        raise HTTPException(status_code=403, detail="Invalid or missing X-Ingest-Key")


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

# Public /refresh cooldown — prevents frontend-triggered reconciles from
# hammering data.gov.in. 10 minutes matches the scheduled reconcile interval.
_REFRESH_COOLDOWN_S = 600
_last_public_refresh_ts: float = 0.0
_public_refresh_lock = threading.Lock()


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


def run_retention() -> dict:
    """Delete readings older than 90 days. Runs once daily at 03:00 UTC.
    At ~4 400 rows/day (46 stations × 15-min cadence), the table grows
    ~1.6 M rows/year without this. 90 days keeps ~400 k rows — within
    Supabase free-tier limits and sufficient for 30-day forecast training."""
    try:
        deleted = db.delete_old_readings(days=90)
        logging.getLogger("ingest").info("retention: deleted %d old readings", deleted)
        return {"deleted": deleted}
    except Exception:
        logging.getLogger("ingest").exception("retention job failed")
        return {"deleted": 0, "error": "see logs"}


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
    # Clear any job_runs rows that are stuck 'running' from a previous process
    # crash. Must run before the scheduler or bootstrap start so the lock is
    # released before the first ingest attempt.
    cleanup_stuck_jobs()
    scheduler = BackgroundScheduler(timezone="UTC")
    # every 10 minutes: re-run the same stuck-row cleanup, not just at startup.
    # Without this, a job_runs row orphaned by a mid-run crash (killed before
    # complete_job_run/fail_job_run) sits at status='running' until the next
    # deploy, silently skipping that job's every future run via lock_contention
    # for however long this process happens to stay up. Uses a larger 60-minute
    # cutoff than the startup call's default 30 — once this process's own jobs
    # are running, "definitely orphaned" can no longer be inferred from
    # ordering alone, so the margin has to outlast every job's realistic
    # worst case instead (see cleanup_stuck_jobs' own docstring).
    scheduler.add_job(cleanup_stuck_jobs, "interval", minutes=10, kwargs={"stale_after_minutes": 60})
    # every 15 minutes: data.gov.in CPCB feed refreshes on the same cadence,
    # so we can capture sub-hourly readings. Timestamps are 15-min-floored in
    # ingest.py, so each 15-min window gets its own (station_id, ts) row.
    scheduler.add_job(run_ingest, "interval", minutes=15)
    # once per hour: recompute forecast + attribution on the freshly-ingested data.
    # Forecast model doesn't benefit from 15-min retraining cadence.
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
    # daily at 03:00 UTC: purge readings older than 90 days to bound table growth.
    scheduler.add_job(run_retention, "cron", hour=3, minute=0)
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


@app.api_route("/health", methods=["GET", "HEAD"])
def health():
    """Degraded, not just up/down (plan §9): reports database connectivity,
    reading freshness, and every tracked job's last-run status via the same
    system_health_summary() the command-centre System Health screen reads.
    HEAD is accepted so load-balancers that probe with HEAD don't get 405."""
    result = compute_health()
    result["last_run"] = _last_run
    result["last_intel"] = _last_intel
    result["last_ops"] = _last_ops
    return JSONResponse(content=result, headers={"Cache-Control": "no-store"})


@app.post("/run", dependencies=[Depends(_require_ingest_key)])
def trigger_run():
    try:
        return run_ingest()
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.post("/transit/refresh", dependencies=[Depends(_require_ingest_key)])
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


@app.post("/readings/refresh", dependencies=[Depends(_require_ingest_key)])
def trigger_readings_refresh():
    """Recompute the CPCB/data.gov preferred-latest-reading reconciliation
    now, same manual-trigger pattern as /run, /intel, /ops, /transit/refresh."""
    try:
        return run_cpcb_reconcile()
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.post("/refresh")
def public_refresh():
    """Public rate-limited endpoint for the frontend Refresh button.

    Runs the CPCB reconcile (reads data.gov.in + Supabase, no DB writes)
    and returns fresh station readings. Rate-limited to once per 10 minutes
    server-side — no auth key required, safe to call from the browser.

    Returns:
      200 {"status": "ok", "refreshed_at": <epoch>, "stations": [...]}
      429 {"status": "recent", "refreshed_at": <epoch>, "next_in_s": <int>}
      409 {"status": "busy"} if another reconcile is already in progress
    """
    global _last_public_refresh_ts
    now = time.time()
    elapsed = now - _last_public_refresh_ts
    remaining = int(_REFRESH_COOLDOWN_S - elapsed)

    if elapsed < _REFRESH_COOLDOWN_S:
        return JSONResponse(
            status_code=429,
            content={
                "status": "recent",
                "refreshed_at": _last_public_refresh_ts,
                "next_in_s": remaining,
            },
            headers={"Retry-After": str(remaining)},
        )

    if not _public_refresh_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="busy")
    try:
        result = run_cpcb_reconcile()
        _last_public_refresh_ts = time.time()
        return {"status": "ok", "refreshed_at": _last_public_refresh_ts, "stations": result}
    finally:
        _public_refresh_lock.release()


@app.get("/readings/latest")
def latest_readings_endpoint():
    """CPCB/data.gov preferred-latest-reading reconciliation, one row per
    station (audit/context integration - see docs/data/cpcb-data-gov-
    primary-latest-integration-report.md). Read-only; DATA_GOV_API_KEY
    never leaves run_cpcb_reconcile(). Returns the last scheduled refresh
    (every 10 minutes) - an empty list before the first refresh completes,
    never an error."""
    return _last_cpcb_reconcile if _last_cpcb_reconcile is not None else []


@app.post("/intel", dependencies=[Depends(_require_ingest_key)])
def trigger_intel():
    """Recompute forecast + attribution now."""
    try:
        return run_intel()
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.post("/ops", dependencies=[Depends(_require_ingest_key)])
def trigger_ops():
    """Drain pending notifications + escalate overdue task dispatches now."""
    try:
        return run_ops()
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.post("/classify", dependencies=[Depends(_require_ingest_key)])
def classify(req: ClassifyRequest):
    """Classify a report and write ai_category + ai_meta back to the reports row."""
    # S-2: verify the report exists before writing AI metadata to it.
    exists = db.client().table("reports").select("id").eq("id", req.report_id).execute().data
    if not exists:
        raise HTTPException(status_code=404, detail=f"Report {req.report_id} not found")
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
