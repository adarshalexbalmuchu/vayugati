"""Blank out hourly values from stuck analysers.

A stuck analyser often jitters by a decimal, so the usual "N identical
hours" test misses it. The rule here: split each station-pollutant series
into 24 h windows counted back from its newest hour (so the latest window
is exactly the trailing day); a window with >= 18 values whose standard
deviation is under 3% of its mean is stuck, and all its values are dropped.

Why 3%: at working Delhi monitors < 1% of days are that flat, while in
Sept 2026 IHBAS NO2 (11 of 36 days), Sirifort NO2, DTU SO2 (22 of 39) and
PM2.5 fixed at 1.0 ug/m3 all day (Major Dhyan Chand, Anand Vihar) were.
Across 227 IGP NO2 monitors, 18% of days failed it (whole Faridabad and
Moradabad networks reading one number for months). Removing those days from
the ward model's training data improved whole-city held-out NO2 R2
(0.205 -> 0.230); see scripts/species/site_model.py:qc, the same rule.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime

import numpy as np

STUCK_CV = 0.03
MIN_HOURS = 18
WINDOW_S = 24 * 3600


def _ts(v) -> float:
    return (v if isinstance(v, datetime) else datetime.fromisoformat(str(v))).timestamp()


def stuck_indices(ts: list[float], values: list[float]) -> set[int]:
    """Indices (into ts/values, one station-pollutant) that sit in a stuck window."""
    if not ts:
        return set()
    newest = max(ts)
    windows: dict[int, list[int]] = defaultdict(list)
    for i, t in enumerate(ts):
        windows[int((newest - t) // WINDOW_S)].append(i)
    out: set[int] = set()
    for idx in windows.values():
        v = np.array([values[i] for i in idx], dtype=float)
        if len(v) >= MIN_HOURS and v.mean() > 0 and v.std() < STUCK_CV * v.mean():
            out.update(idx)
    return out


def drop_stuck(rows: list[dict], pollutants: tuple[str, ...], station_key: str = "station_id") -> tuple[list[dict], int]:
    """Copies of wide hourly rows ({station_key, ts, <pollutant>: value, ...})
    with stuck values set to None, and how many values were blanked."""
    series: dict[tuple, list[int]] = defaultdict(list)
    for i, r in enumerate(rows):
        for p in pollutants:
            if r.get(p) is not None:
                series[(r[station_key], p)].append(i)
    out = [dict(r) for r in rows]
    blanked = 0
    for (_, p), idx in series.items():
        bad = stuck_indices([_ts(rows[i]["ts"]) for i in idx], [float(rows[i][p]) for i in idx])
        for k in bad:
            out[idx[k]][p] = None
        blanked += len(bad)
    return out, blanked
