"""Weather FORECASTS as forecaster inputs (ECMWF IFS 0.25 via Open-Meteo).

Forecast lab, Oct 2026 (scripts/forecast_lab.py, v3b): a compact set of
forecast-weather features at the target hour and over (origin, target]
cut error 1-4% at 6-48 h. Training uses ARCHIVED forecasts (Open-Meteo
Previous Runs: the value forecast for each hour by the run d days earlier),
so the model learns from forecasts as they were, errors included. A lead of
h hours uses the run at least h + 6 hours old (fc_day). Serving uses the
latest forecast run for future hours.

Frames are per 0.25-degree cell of each monitored ward, cached locally under
data/history/ and extended as time passes.
"""

from __future__ import annotations

import pickle
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import numpy as np
import pandas as pd

CACHE = Path(__file__).resolve().parents[1] / "data" / "history"
VARS = ("temperature_2m", "relative_humidity_2m", "wind_speed_10m", "wind_speed_100m", "wind_direction_10m",
        "precipitation", "cloud_cover", "shortwave_radiation", "surface_pressure")
DAYS = (1, 2, 3)
ARCHIVE_START = "2025-01-25"
MIN_H = 6                      # forecast features only from this lead: shorter leads gained nothing


def fc_day(h: int) -> int:
    """The newest archived run certainly available at the origin (lead >= h + 6 h)."""
    return 1 if h <= 18 else int(np.ceil((h + 6) / 24))


def cell(lat: float, lng: float) -> tuple[float, float]:
    return round(round(lat / 0.25) * 0.25, 2), round(round(lng / 0.25) * 0.25, 2)


def _get(url: str, params: dict) -> dict:
    for attempt in range(4):
        try:
            r = httpx.get(url, params=params, timeout=120)
            if r.status_code == 200:
                return r.json()
        except httpx.TransportError:
            pass
        time.sleep(15 * (attempt + 1))
    raise RuntimeError(f"Open-Meteo request failed: {url}")


def archive(c: tuple[float, float], until: datetime | None = None) -> pd.DataFrame:
    """Previous-runs archive for one cell, cached and extended to `until`."""
    f = CACHE / f"prevruns_{c[0]}_{c[1]}.pkl"
    df = pd.read_pickle(f) if f.exists() else pd.DataFrame()
    until = (until or datetime.now(timezone.utc)).date()
    start = (df.index.max() - pd.Timedelta(days=3)).date() if len(df) else pd.Timestamp(ARCHIVE_START).date()
    hourly = ",".join(f"{v}_previous_day{d}" for v in VARS for d in DAYS)
    a = start
    parts = [df] if len(df) else []
    while a <= until:
        b = min(a + timedelta(days=180), until)
        js = _get("https://previous-runs-api.open-meteo.com/v1/forecast", {
            "latitude": c[0], "longitude": c[1], "hourly": hourly, "start_date": a.isoformat(),
            "end_date": b.isoformat(), "timezone": "UTC", "models": "ecmwf_ifs025", "wind_speed_unit": "ms"})
        h = js["hourly"]
        parts.append(pd.DataFrame({k: v for k, v in h.items() if k != "time"},
                                  index=pd.to_datetime(h["time"], utc=True), dtype=float))
        a = b + timedelta(days=1)
        time.sleep(1.0)
    out = pd.concat(parts).sort_index()
    out = out[~out.index.duplicated(keep="last")]
    CACHE.mkdir(parents=True, exist_ok=True)
    out.to_pickle(f)
    return out


def latest(c: tuple[float, float]) -> pd.DataFrame:
    """The current ECMWF forecast for one cell: yesterday to 3 days ahead."""
    js = _get("https://api.open-meteo.com/v1/forecast", {
        "latitude": c[0], "longitude": c[1], "hourly": ",".join(VARS), "past_days": 1, "forecast_days": 3,
        "timezone": "UTC", "models": "ecmwf_ifs025", "wind_speed_unit": "ms"})
    h = js["hourly"]
    return pd.DataFrame({k: v for k, v in h.items() if k != "time"}, index=pd.to_datetime(h["time"], utc=True), dtype=float)


class Frames:
    """Callable F(h, columns, index) -> {var: frame (index x ward columns)}.

    Training (live=False): the archived run fc_day(h) days old.
    Serving (live=True): the latest run, falling back to the archive for
    hours the latest run does not cover."""

    def __init__(self, ward_cells: dict[int, tuple[float, float]], live: bool = False):
        self.ward_cells, self.live = ward_cells, live
        cells = set(ward_cells.values())
        self.arch = {c: archive(c) for c in cells}
        self.cur = {c: latest(c) for c in cells} if live else {}

    def __call__(self, h: int, columns, index: pd.DatetimeIndex) -> dict[str, pd.DataFrame]:
        d = fc_day(h)
        out = {}
        for v in VARS:
            cols = {}
            for w in columns:
                c = self.ward_cells.get(w)
                if c is None:
                    cols[w] = np.full(len(index), np.nan)
                    continue
                s = self.arch[c][f"{v}_previous_day{d}"].reindex(index)
                if self.live:
                    s = self.cur[c][v].reindex(index).combine_first(s)
                cols[w] = s.to_numpy()
            out[v] = pd.DataFrame(cols, index=index)
        return out
