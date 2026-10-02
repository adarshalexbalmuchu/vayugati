"""Observed (ERA5) hourly weather for monitored wards, kept OUT of the database.

The weather table starts 2026-07-14; training on the long readings archive
(history_archive.py) needs the same origin-hour weather for older hours.
Pulled from the Open-Meteo ERA5 archive per 0.1-degree cell of each
monitored ward's centroid, stored as one local pickle, and merged into the
forecaster's weather frame for hours the weather table does not cover.
"""

from __future__ import annotations

import pickle
import time
from datetime import date
from pathlib import Path

import pandas as pd

from . import db, open_meteo

ARCHIVE = Path(__file__).resolve().parents[1] / "data" / "history" / "weather_archive.pkl"
COLS = ("temp_c", "humidity", "wind_speed", "wind_dir", "precipitation", "boundary_layer_height")


def _ward_points() -> dict[int, tuple[float, float]]:
    from .vayutrace_kernel import boundary_area_centroid
    station_wards = {s["ward_id"] for s in db.get_all_stations() if s.get("ward_id")}
    pts = {}
    for w in db.get_wards_with_city():
        if w["id"] not in station_wards:
            continue
        c = (w["lat"], w["lng"]) if w.get("lat") is not None else boundary_area_centroid(w.get("boundary"))
        if c:
            pts[w["id"]] = (float(c[0]), float(c[1]))
    return pts


def build(start: date, end: date) -> int:
    """Fetch ERA5 for every monitored ward (deduplicated by 0.1-degree cell)."""
    by_cell: dict[tuple, list[int]] = {}
    for wid, (la, lo) in _ward_points().items():
        by_cell.setdefault((round(la, 1), round(lo, 1)), []).append(wid)
    frames = []
    for (la, lo), wids in by_cell.items():
        rows = open_meteo.get_historical_hourly(la, lo, start.isoformat(), end.isoformat())
        time.sleep(1.0)
        if not rows:
            continue
        df = pd.DataFrame(rows)
        df["ts"] = pd.to_datetime(df["ts_utc"], utc=True)
        for wid in wids:
            frames.append(df.assign(ward_id=wid)[["ward_id", "ts", *COLS]])
    if not frames:
        return 0
    out = pd.concat(frames, ignore_index=True)
    out["ventilation_coefficient"] = out["boundary_layer_height"] * out["wind_speed"]
    ARCHIVE.parent.mkdir(parents=True, exist_ok=True)
    ARCHIVE.write_bytes(pickle.dumps(out))
    return len(out)


def frame_before(before) -> pd.DataFrame:
    """Archived rows with ts < before, in forecast._hourly_ward_weather's shape."""
    if not ARCHIVE.exists():
        return pd.DataFrame()
    df = pickle.loads(ARCHIVE.read_bytes())
    return df[df["ts"] < pd.Timestamp(before)].reset_index(drop=True)
