"""Long hourly history for training, kept OUT of the database.

The forecaster gains most from training on every season it has seen (forecast
lab, Oct 2026: winter PM2.5 error -5.5 to -6.6% at 12-48 h with all history
against a 90-day window). The live readings_hourly table keeps recent months;
this archive holds older hours, pulled from the same OpenAQ hourly endpoint by
hourly_readings.archive(), in a local pickle next to the model cache. Putting
~20 months in Postgres would add ~0.5 M rows to a size-limited project.

Rows are wide, {station_id, ts, pm25, pm10, no2, so2, co, o3}, exactly what
readings_hourly holds, so db.get_hourly_history can merge the two.
"""

from __future__ import annotations

import pickle
import threading
from pathlib import Path

import pandas as pd

ARCHIVE = Path(__file__).resolve().parents[1] / "data" / "history" / "readings_hourly_archive.pkl"
COLS = ("pm25", "pm10", "no2", "so2", "co", "o3")
_lock = threading.Lock()


def _read() -> pd.DataFrame:
    if not ARCHIVE.exists():
        return pd.DataFrame(columns=["station_id", "ts", *COLS])
    return pickle.loads(ARCHIVE.read_bytes())


def append(rows: list[dict]) -> int:
    """Merge rows into the archive (newest value wins per station and hour)."""
    if not rows:
        return 0
    new = pd.DataFrame(rows)
    new["ts"] = pd.to_datetime(new["ts"], utc=True)
    for c in COLS:
        if c not in new:
            new[c] = float("nan")
    new = new[["station_id", "ts", *COLS]]
    with _lock:
        old = _read()
        df = pd.concat([old, new], ignore_index=True) if len(old) else new
        df = df.drop_duplicates(["station_id", "ts"], keep="last").sort_values(["ts", "station_id"])
        ARCHIVE.parent.mkdir(parents=True, exist_ok=True)
        tmp = ARCHIVE.with_suffix(".tmp")
        tmp.write_bytes(pickle.dumps(df.reset_index(drop=True)))
        tmp.replace(ARCHIVE)
    return len(new)


def rows_before(before, station_ids: set[int] | None = None) -> list[dict]:
    """Archive rows with ts < before, as readings_hourly-shaped dicts (ts ISO)."""
    df = _read()
    if df.empty:
        return []
    df = df[df["ts"] < pd.Timestamp(before)]
    if station_ids is not None:
        df = df[df["station_id"].isin(station_ids)]
    out = df.assign(ts=df["ts"].map(lambda t: t.isoformat())).to_dict("records")
    for r in out:
        for c in COLS:
            if r[c] != r[c]:          # NaN -> None, as the DB returns
                r[c] = None
    return out


def span() -> tuple | None:
    df = _read()
    return (df["ts"].min(), df["ts"].max(), len(df)) if len(df) else None
