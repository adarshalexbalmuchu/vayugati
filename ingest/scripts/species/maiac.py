"""MAIAC aerosol optical depth (MCD19A2 v061, 1 km, daily) at points.

Satellite AOD is the standard spatial covariate for PM2.5 between monitors
in Indian exposure studies. It plays the role for PM2.5 that TROPOMI NO2
plays for NO2 (see raster_features.py).

Files come from NASA LP DAAC via earthaccess (EARTHDATA_USERNAME/PASSWORD in
ingest/.env). For a spatial level feature, a site's typical AOD, every
STEP_DAYS-th day is plenty, and it keeps the pull at about 5 GB instead of
22. Each file is reduced to the requested points' pixels and deleted.

Quality: a pixel counts only if MAIAC's QA says cloud mask = clear (bits
0-2 = 001), adjacency = normal (bits 5-7 = 000) and AOD QA = best (bits
8-11 = 0000). A day's value is the mean over that day's valid passes.
"""

from __future__ import annotations

import math
import pickle
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2] / "data" / "rasters"
TMP = ROOT / "maiac_tmp"
OUT = ROOT / "maiac_points.pkl"
STEP_DAYS = 4
R = 6371007.181
TILE_M = 1111950.519667
PIX_M = TILE_M / 1200


def tile_pixel(lat: float, lng: float) -> tuple[int, int, int, int]:
    """MODIS sinusoidal grid: (h, v, row, col) of the 1 km pixel holding the point."""
    x = R * math.radians(lng) * math.cos(math.radians(lat))
    y = R * math.radians(lat)
    h = int((x + 20015109.354) // TILE_M)
    v = int((10007554.677 - y) // TILE_M)
    col = int((x + 20015109.354 - h * TILE_M) // PIX_M)
    row = int((10007554.677 - y - v * TILE_M) // PIX_M)
    return h, v, row, col


def good_quality(qa: np.ndarray) -> np.ndarray:
    return ((qa & 0b111) == 0b001) & (((qa >> 5) & 0b111) == 0) & (((qa >> 8) & 0b1111) == 0)


def extract(path: str, pix: dict[int, tuple[int, int]]) -> dict[int, float]:
    from pyhdf.SD import SD, SDC

    f = SD(path, SDC.READ)
    aod = f.select("Optical_Depth_055")[:].astype(np.float32)
    qa = f.select("AOD_QA")[:]
    f.end()
    ok = good_quality(qa) & (aod != -28672)
    out = {}
    for k, (row, col) in pix.items():
        v = aod[:, row, col][ok[:, row, col]]
        if v.size:
            out[k] = float(v.mean() * 0.001)
    return out


def run(points: list[tuple[float, float]], start: str, end: str, batch: int = 16):
    import earthaccess

    earthaccess.login(strategy="environment")
    TMP.mkdir(parents=True, exist_ok=True)
    state = pickle.loads(OUT.read_bytes()) if OUT.exists() else {"points": points, "done": set(), "aod": {}}
    if state["points"] != points:
        raise SystemExit("points changed since the last run; move maiac_points.pkl aside first")
    by_tile: dict[tuple[int, int], dict[int, tuple[int, int]]] = {}
    for i, (lat, lng) in enumerate(points):
        h, v, row, col = tile_pixel(lat, lng)
        by_tile.setdefault((h, v), {})[i] = (row, col)
    tiles = {f"h{h:02d}v{v:02d}" for h, v in by_tile}
    lats = [p[0] for p in points]; lngs = [p[1] for p in points]
    bbox = (min(lngs) - 0.1, min(lats) - 0.1, max(lngs) + 0.1, max(lats) + 0.1)

    d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    m = d0
    while m <= d1:
        m_end = min(date(m.year + (m.month == 12), m.month % 12 + 1, 1) - timedelta(days=1), d1)
        found = earthaccess.search_data(short_name="MCD19A2", version="061",
                                        temporal=(m.isoformat(), m_end.isoformat()), bounding_box=bbox)
        todo = []
        for g in found:
            name = g["umm"]["GranuleUR"]
            parts = name.split(".")
            doy = int(parts[1][5:])
            if parts[2] in tiles and doy % STEP_DAYS == 0 and name not in state["done"]:
                todo.append(g)
        for i in range(0, len(todo), batch):
            chunk = todo[i:i + batch]
            files = earthaccess.download(chunk, str(TMP), show_progress=False)
            for fp in files:
                fp = str(fp)
                name = Path(fp).name
                parts = name.split(".")
                h, v = int(parts[2][1:3]), int(parts[2][4:6])
                day = (date(int(parts[1][1:5]), 1, 1) + timedelta(days=int(parts[1][5:]) - 1)).isoformat()
                try:
                    for k, val in extract(fp, by_tile.get((h, v), {})).items():
                        state["aod"][(k, day)] = val
                except Exception as e:
                    print("  skip", name, type(e).__name__, flush=True)
                state["done"].add(name.rsplit(".", 1)[0])
                Path(fp).unlink(missing_ok=True)
            OUT.write_bytes(pickle.dumps(state))
        print(f"{m:%Y-%m}: {len(todo)} files, {len(state['aod'])} point-days so far", flush=True)
        m = m_end + timedelta(days=1)
    return state


if __name__ == "__main__":
    import json
    pts = [tuple(p) for p in json.load(open(sys.argv[1]))]
    run(pts, sys.argv[2], sys.argv[3])
