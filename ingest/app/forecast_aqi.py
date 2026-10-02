"""Forecast AQI per ward, built the way CPCB builds the AQI itself.

At a future hour T the AQI is the highest sub-index over the pollutants'
24h means (max 8h mean for O3/CO) for the window ending at T, needing at
least three pollutants including PM2.5 or PM10 and 75% of the hours
(aqi.window_concentrations / aqi.aqi_from_window: the same rule the live
fallback AQI uses, which matches CPCB's published AQI to a median 5
points). Hours up to a pollutant's latest reading are its observed hourly
values; later hours come from that pollutant's forecast
(forecast_global.serve). So at +1 h the AQI is 23 observed hours and one
forecast hour, and from +24 h it is forecast entirely.

The range runs every pollutant along its own q10 path (low) and q90 path
(high). Errors within a day and across pollutants move together (the same
weather drives them), so this treats them as fully correlated; the
backtest (scripts/aqi_forecast_backtest.py) checks the coverage that
gives, and AQI_BAND_SCALE widens it to 80% if it falls short.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from . import aqi

log = logging.getLogger("ingest")
MODEL_VERSION = "aqi_cpcb_rule_v1"
GATE_FILE = Path(__file__).resolve().parents[1] / "data" / "models" / "aqi_forecast_gate.json"

POLLUTANTS = ("pm25", "pm10", "no2", "so2", "co", "o3")
MAX_POLLUTANT_LAG_H = 6        # a pollutant whose latest reading is older than this is not forecast
CATEGORY_BREAKS = (50, 100, 200, 300, 400)
CATEGORY_NAMES = ("Good", "Satisfactory", "Moderate", "Poor", "Very Poor", "Severe")


def category(a: float | None) -> int | None:
    """NAQI category index 0-5 (Good .. Severe)."""
    if a is None or not np.isfinite(a):
        return None
    return int(np.searchsorted(CATEGORY_BREAKS, a, side="left"))


def _grid_path(observed: pd.Series | None, served: dict | None, path: str,
               grid: pd.DatetimeIndex) -> np.ndarray:
    """Hourly values on `grid`: observed up to the pollutant's own origin,
    its forecast `path` ("total" | "q10" | "q90") after it; NaN where neither."""
    v = np.full(len(grid), np.nan)
    origin = served["origin"] if served else None
    if observed is not None and not observed.empty:
        o = observed.reindex(grid).to_numpy(dtype=float)
        keep = grid <= origin if origin is not None else np.ones(len(grid), dtype=bool)
        v[keep] = o[keep]
    if served:
        f = pd.Series(served[path], index=served["future_idx"]).reindex(grid).to_numpy(dtype=float)
        after = grid > origin
        v[after] = f[after]
    return v


def forecast_ward(observed: dict[str, pd.Series], served: dict[str, dict], max_h: int = 48,
                  band_scale: float = 1.0) -> dict | None:
    """observed: pollutant -> the ward's hourly series (hour-start index, UTC);
    served: pollutant -> forecast_global.serve()'s entry for this ward.

    Returns {origin, future_idx, aqi, low, high, dominant} with one value per
    lead 1..max_h (NaN / None where the AQI rule is not met), or None if the
    ward has no forecast PM."""
    fresh = {p: s for p, s in served.items() if s and s.get("origin") is not None}
    if not any(p in fresh for p in ("pm25", "pm10")):
        return None
    origin = max(s["origin"] for s in fresh.values())
    fresh = {p: s for p, s in fresh.items()
             if origin - s["origin"] <= pd.Timedelta(hours=MAX_POLLUTANT_LAG_H)}
    grid = pd.date_range(origin - pd.Timedelta(hours=23), origin + pd.Timedelta(hours=max_h), freq="h", tz="UTC")
    pols = [p for p in POLLUTANTS if observed.get(p) is not None or p in fresh]
    paths = {path: {p: _grid_path(observed.get(p), fresh.get(p), path, grid) for p in pols}
             for path in ("total", "q10", "q90")}
    out = {"origin": origin, "future_idx": grid[24:], "aqi": np.full(max_h, np.nan),
           "low": np.full(max_h, np.nan), "high": np.full(max_h, np.nan), "dominant": [None] * max_h}
    for i in range(1, max_h + 1):
        res = {}
        for path, by_p in paths.items():
            hourly = {}
            for p, v in by_p.items():
                w = v[i : i + 24]
                hourly[p] = list(w[~np.isnan(w)])
            res[path] = aqi.aqi_from_window(aqi.window_concentrations(hourly))
        a, dom = res["total"]
        if a is None:
            continue
        low = res["q10"][0] if res["q10"][0] is not None else a
        high = res["q90"][0] if res["q90"][0] is not None else a
        if band_scale != 1.0 and a > 0:
            low = a * (max(min(low, a), 1) / a) ** band_scale
            high = a * (max(high, a) / a) ** band_scale
        out["aqi"][i - 1] = a
        out["low"][i - 1] = min(low, a)
        out["high"][i - 1] = min(max(high, a), 500)
        out["dominant"][i - 1] = dom
    return out


def observed_aqi(observed: dict[str, pd.Series], T: pd.Timestamp) -> tuple[int | None, str | None]:
    """The AQI the monitors themselves give for the 24h window ending at T."""
    lo = T - pd.Timedelta(hours=23)
    hourly = {}
    for p, s in observed.items():
        if s is None:
            continue
        w = s[(s.index >= lo) & (s.index <= T)].dropna()
        hourly[p] = list(w.to_numpy())
    return aqi.aqi_from_window(aqi.window_concentrations(hourly))


def load_gate() -> dict | None:
    """The backtest's decision (scripts/aqi_forecast_backtest.py gate):
    {"max_lead": h, "band_scale": s, ...}. None -> publish nothing."""
    try:
        g = json.loads(GATE_FILE.read_text())
        return g if int(g.get("max_lead") or 0) > 0 else None
    except (OSError, ValueError):
        return None


def publish(ward_ids, observed: dict[str, dict[int, pd.Series]], served: dict[str, dict[int, dict]],
            now: datetime, max_origin_age_h: float, write) -> dict:
    """Forecast AQI for each ward -> write(ward_id, rows) (db.replace_aqi_forecasts).

    observed: pollutant -> ward -> hourly series; served: pollutant -> ward ->
    forecast_global.serve() entry. Wards with no fresh forecast get an empty
    write, which clears their old rows."""
    gate = load_gate()
    if gate is None:
        log.info("forecast AQI: no validated gate file; not publishing")
        return {"published": 0, "cleared": 0}
    max_lead, scale = int(gate["max_lead"]), float(gate.get("band_scale") or 1.0)
    published = cleared = 0
    generated = now.isoformat()
    for w in ward_ids:
        sv = {p: served.get(p, {}).get(w) for p in POLLUTANTS}
        fc = None
        fresh = [s for s in sv.values() if s and s.get("origin") is not None
                 and (pd.Timestamp(now) - s["origin"]).total_seconds() / 3600 <= max_origin_age_h]
        if fresh:
            fc = forecast_ward({p: observed.get(p, {}).get(w) for p in POLLUTANTS},
                               {p: s for p, s in sv.items() if s}, band_scale=scale)
        rows = []
        if fc is not None:
            for h in range(1, max_lead + 1):
                a = fc["aqi"][h - 1]
                if not np.isfinite(a):
                    continue
                rows.append({"ward_id": int(w), "lead_hours": h, "origin_ts": fc["origin"].isoformat(),
                             "target_ts": fc["future_idx"][h - 1].isoformat(), "aqi": int(round(a)),
                             "aqi_low": int(round(fc["low"][h - 1])), "aqi_high": int(round(fc["high"][h - 1])),
                             "dominant_pollutant": fc["dominant"][h - 1], "model_version": MODEL_VERSION,
                             "generated_at": generated})
        write(int(w), rows)
        if rows:
            published += 1
        else:
            cleared += 1
    log.info("forecast AQI: %d wards published, %d cleared (max lead %dh)", published, cleared, max_lead)
    return {"published": published, "cleared": cleared}
