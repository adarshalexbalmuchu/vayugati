"""24h PM2.5 / NO2 estimates for every ward, including wards with no monitor.

    estimate_w = c x N x R_w        range: estimate /÷ k  to  estimate x k  (90%)

N    the live network's 24h mean: mean over our stations of each station's
     mean over the last 24 hourly values (readings_hourly; >= 18 h required)
c    calibrates our (Delhi-only) network to the 150 km network the model was
     trained on
R_w  the ward's usual ratio to that network: exp(log_ratio) from
     app/data/ward_level_ratios.json, exported by
     scripts/species/export_ward_model.py (land use [+ power plants for
     PM2.5] + nearby-monitor correction)
k    the 90% daily range factor from 2 km-group cross-validation

The window ends at the newest hour the network has, so an upstream outage
produces an older, correctly dated estimate rather than a wrong current one.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from . import db

log = logging.getLogger("ingest")
MODEL_FILE = Path(__file__).resolve().parent / "data" / "ward_level_ratios.json"
MIN_STATIONS = 3
MIN_HOURS = 18
_model: dict | None = None


def _load() -> dict:
    global _model
    if _model is None:
        _model = json.loads(MODEL_FILE.read_text())
    return _model


def network_24h(rows: list[dict], pollutant: str, window_end: datetime) -> tuple[float | None, int]:
    """Mean over stations of each station's 24h mean ending at window_end."""
    start = window_end - timedelta(hours=24)
    by_station: dict[int, list[float]] = {}
    for r in rows:
        v = r.get(pollutant)
        t = datetime.fromisoformat(r["ts"])
        if v is None or not (start <= t < window_end):
            continue
        by_station.setdefault(r["station_id"], []).append(float(v))
    means = [float(np.mean(v)) for v in by_station.values() if len(v) >= MIN_HOURS]
    if len(means) < MIN_STATIONS:
        return None, len(means)
    return float(np.mean(means)), len(means)


def compute(rows: list[dict], model: dict | None = None) -> list[dict]:
    model = model or _load()
    if not rows:
        return []
    newest = max(datetime.fromisoformat(r["ts"]) for r in rows)
    window_end = newest + timedelta(hours=1)   # readings_hourly ts = hour START
    out = []
    for pollutant, spec in model["species"].items():
        N, n_st = network_24h(rows, pollutant, window_end)
        if N is None:
            log.info("ward estimates: %s skipped, only %d stations with a full day", pollutant, n_st)
            continue
        c, k = spec["network_calibration"], spec["range_factor_90"]
        for wid, lr in zip(model["ward_ids"], spec["log_ratio"]):
            est = c * N * float(np.exp(lr))
            out.append({"ward_id": wid, "pollutant": pollutant, "window_end": window_end.isoformat(),
                        "window_hours": 24, "estimate": round(est, 1), "lower_90": round(est / k, 1),
                        "upper_90": round(est * k, 1), "network_mean": round(N, 1), "n_stations": n_st,
                        "model_version": model["model_version"]})
    return out


def run() -> dict:
    # Anchor on the newest hour the network HAS, not the clock: during an
    # upstream outage the estimate is then correctly dated to the last full day.
    newest = db.client().table("readings_hourly").select("ts").order("ts", desc=True).limit(1).execute().data
    if not newest:
        return {"rows": 0, "window_end": None}
    start = datetime.fromisoformat(newest[0]["ts"]) - timedelta(hours=26)
    rows = db._fetch_all(lambda: db.client().table("readings_hourly")
                         .select("station_id, ts, pm25, no2")
                         .gte("ts", start.isoformat())
                         .order("ts").order("station_id"))
    est = compute(rows)
    for i in range(0, len(est), 500):
        db._with_retry(lambda b=est[i:i + 500]: db.client().table("ward_estimates")
                       .upsert(b, on_conflict="ward_id,pollutant,window_end").execute())
    log.info("ward estimates: %d rows written", len(est))
    return {"rows": len(est), "window_end": est[0]["window_end"] if est else None}
