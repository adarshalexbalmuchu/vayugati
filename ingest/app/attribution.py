"""Directional source attribution via a pollution rose.

For each ward we bin every hour's PM2.5 by the wind direction it arrived on, then
ask: which compass sector carries the highest pollution load into this station?
That sector is the directional "look here now" pointer the field officer needs —
time-specific and directional, not the static annual "this ward is dust-dominant"
label DPCC already publishes.

Method limits are stated honestly in `method`/`confidence`: this is a wind-load
rose, not a full source-apportionment model.
"""

import logging
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import db

log = logging.getLogger("ingest.attribution")

SECTORS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
METHOD = "pollution_rose_v1"
MIN_SAMPLES = 12  # need at least this many paired hours to say anything


def _sector(deg: float) -> str:
    return SECTORS[int((deg % 360) / 45.0 + 0.5) % 8]


def run() -> dict:
    summary = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "wards_attributed": 0,
        "skipped": [],
    }

    readings = db.get_readings_history(hours=24 * 30)
    weather = db.get_weather_history(hours=24 * 30)
    if not readings or not weather:
        log.warning("insufficient readings/weather for attribution")
        summary["finished_at"] = datetime.now(timezone.utc).isoformat()
        return summary

    r = pd.DataFrame(readings).dropna(subset=["pm25"])
    w = pd.DataFrame(weather).dropna(subset=["wind_dir"])
    if r.empty or w.empty:
        summary["finished_at"] = datetime.now(timezone.utc).isoformat()
        return summary

    for df in (r, w):
        df["ts"] = pd.to_datetime(df["ts"], utc=True).dt.floor("h")
    r = r.groupby(["ts", "ward_id"], as_index=False)["pm25"].mean()
    w = w.groupby(["ts", "ward_id"], as_index=False)["wind_dir"].mean()

    merged = r.merge(w, on=["ts", "ward_id"], how="inner")
    if merged.empty:
        summary["finished_at"] = datetime.now(timezone.utc).isoformat()
        return summary
    merged["sector"] = merged["wind_dir"].apply(_sector)

    ts_now = datetime.now(timezone.utc).isoformat()

    for ward_id in sorted(merged["ward_id"].unique()):
        try:
            sub = merged[merged["ward_id"] == ward_id]
            if len(sub) < MIN_SAMPLES:
                summary["skipped"].append(int(ward_id))
                continue

            # mean pm2.5 load per wind sector
            load = sub.groupby("sector")["pm25"].mean()
            breakdown = {s: round(float(load.get(s, 0.0)), 1) for s in SECTORS}
            total = sum(breakdown.values()) or 1.0
            normalized = {s: round(v / total, 3) for s, v in breakdown.items()}

            direction = max(breakdown, key=breakdown.get)

            # confidence: how much the top sector stands out, scaled by sample size
            vals = np.array(list(breakdown.values()))
            contrast = (vals.max() - vals.mean()) / (vals.mean() + 1e-6)
            vol = min(len(sub) / (24 * 7), 1.0)  # a week of data → full volume weight
            confidence = float(np.clip(contrast * vol, 0.0, 0.95))

            db.replace_attribution(
                int(ward_id),
                {
                    "ward_id": int(ward_id),
                    "ts": ts_now,
                    "breakdown": normalized,
                    "direction": direction,
                    "confidence": round(confidence, 2),
                    "method": METHOD,
                },
            )
            summary["wards_attributed"] += 1
        except Exception:
            log.exception("attribution failed for ward_id=%s", ward_id)
            summary["skipped"].append(int(ward_id))

    summary["finished_at"] = datetime.now(timezone.utc).isoformat()
    log.info("attribution done: %s", summary)
    return summary
