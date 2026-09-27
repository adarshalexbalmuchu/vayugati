"""CAMS global atmospheric composition (via Open-Meteo's Air Quality API) at points.

The regional/physical backbone for an S-MESH-style hybrid (ML downscaling of
CAMS with satellite + monitors + land use; S-MESH: Europe, 2024). CAMS
global is ~0.4 deg (~40 km), hourly, with transport, secondary aerosol, dust,
smoke and chemistry, and forecasts days ahead. Open-Meteo serves it without
an account.

Monitors sharing a 0.4 deg cell share one request (the model can't tell them
apart anyway), which keeps a 19-month, many-variable pull inside the free
daily quota. Cached under ingest/data/species_cache/cams/.
"""

from __future__ import annotations

import pickle
import sys
import time
from pathlib import Path

import httpx

VARS = ("pm2_5", "pm10", "nitrogen_dioxide", "ozone", "sulphur_dioxide", "carbon_monoxide",
        "dust", "aerosol_optical_depth")
CELL = 0.4
CACHE = Path(__file__).resolve().parents[2] / "data" / "species_cache" / "cams"


def cell_of(lat: float, lng: float) -> tuple[float, float]:
    return round(round(lat / CELL) * CELL, 2), round(round(lng / CELL) * CELL, 2)


def fetch_cell(cell, start: str, end: str) -> dict[str, dict]:
    f = CACHE / f"{cell[0]}_{cell[1]}_{start}_{end}.pkl"
    if f.exists():
        return pickle.loads(f.read_bytes())
    for attempt in range(5):
        r = httpx.get("https://air-quality-api.open-meteo.com/v1/air-quality", params={
            "latitude": cell[0], "longitude": cell[1], "hourly": ",".join(VARS),
            "start_date": start, "end_date": end, "timezone": "UTC", "domains": "cams_global"}, timeout=120)
        if r.status_code == 200:
            break
        time.sleep(20 * (attempt + 1))
    r.raise_for_status()
    h = r.json()["hourly"]
    out = {t[:13]: {v: h[v][i] for v in VARS} for i, t in enumerate(h["time"])}
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(pickle.dumps(out))
    time.sleep(2)
    return out


def at_points(points, start="2025-02-01", end="2026-09-24", log=print) -> dict[int, dict[str, dict]]:
    """point index -> {hour key -> {var: value}}."""
    cells = sorted({cell_of(*p) for p in points})
    log(f"{len(points)} points -> {len(cells)} CAMS cells")
    data = {}
    for i, c in enumerate(cells):
        data[c] = fetch_cell(c, start, end)
        if (i + 1) % 10 == 0:
            log(f"  {i + 1}/{len(cells)} cells")
    return {i: data[cell_of(*p)] for i, p in enumerate(points)}


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from scripts.species import sites as S
    import pickle
    pts = []
    for sp in ("no2", "pm25"):
        # Only datasets already built: S.load() on a missing one would START a
        # full OpenAQ pull (a bug caught in the first run of this script).
        f = next(iter(S.CACHE_DIR.glob(f"sites_{sp}_igp_*.pkl")), None)
        if f is None:
            print(sp, "dataset not built yet — skipped")
            continue
        pts += [(s["lat"], s["lng"]) for s in pickle.loads(f.read_bytes())["sites"]]
    at_points(pts)
    print("done")
