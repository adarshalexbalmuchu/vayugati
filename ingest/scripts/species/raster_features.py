"""Raster covariates at monitor sites: satellite NO2, population, built-up land.

These are the predictors land-use-regression studies find strongest beyond
road length (e.g. Larkin et al. 2017's global NO2 LUR, where satellite NO2
was the single largest term):

  trop_no2       TROPOMI tropospheric NO2 column, monthly means averaged over
                 the training window (KNMI/TEMIS 0.125 deg grids, open access)
  pop_s{σ}       WorldPop 2020 constrained population (100 m), Gaussian-
                 weighted sum within σ km
  built_s{σ}     ESA WorldCover 2021 (10 m) built-up fraction (class 50),
                 Gaussian-weighted, read remotely from the public COGs

Files live in ingest/data/rasters/ (gitignored); results are cached per site
set under ingest/data/species_cache/.
"""

from __future__ import annotations

import gzip
import math
import pickle
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2] / "data"
RASTERS = ROOT / "rasters"
WORLDPOP = RASTERS / "ind_ppp_2020_UNadj_constrained.tif"
WORLDCOVER_URL = ("/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
                  "ESA_WorldCover_10m_2021_v200_{ns}{lat:02d}E{lng:03d}_Map.tif")
POP_SIGMAS = (0.5, 1.0, 2.0, 4.0)
BUILT_SIGMAS = (0.25, 0.5, 1.0, 2.0)


# ---------------------------------------------------------------- TROPOMI ---
def _read_temis(path: Path) -> np.ndarray:
    """TEMIS 'TOMS format' ASCII: 1440 lat rows (S->N) x 2880 lon bins, each
    value a fixed-width 4-char integer in 1e13 molec/cm2, -999 = no data."""
    lines = gzip.decompress(path.read_bytes()).decode("latin-1").splitlines()
    grid = np.full((1440, 2880), np.nan, dtype=np.float32)
    row, buf = -1, []
    for ln in lines[4:]:
        if ln.startswith("lat="):
            if row >= 0:
                grid[row] = buf[:2880]
            row += 1
            buf = []
            continue
        buf.extend(int(ln[i:i + 4]) for i in range(0, len(ln.rstrip()), 4))
    if row >= 0 and buf:
        grid[row] = buf[:2880]
    grid[grid <= -999] = np.nan
    return grid


def trop_no2_at(points: list[tuple[float, float]], months: list[str]) -> np.ndarray:
    """Multi-month mean column at each (lat, lng), bilinear between 0.125 deg
    cell centres. `months` are 'YYYYMM'; missing files are skipped."""
    acc = np.zeros(len(points)); n = np.zeros(len(points))
    for m in months:
        f = RASTERS / "tropomi" / f"no2_{m}.asc.gz"
        if not f.exists():
            continue
        g = _read_temis(f)
        for k, (lat, lng) in enumerate(points):
            y = (lat + 89.9375) / 0.125; x = (lng + 179.9375) / 0.125
            y0, x0 = int(math.floor(y)), int(math.floor(x)); fy, fx = y - y0, x - x0
            cells = g[y0:y0 + 2, x0:x0 + 2]
            w = np.array([[(1 - fy) * (1 - fx), (1 - fy) * fx], [fy * (1 - fx), fy * fx]])
            ok = ~np.isnan(cells)
            if ok.any():
                acc[k] += float((cells[ok] * w[ok]).sum() / w[ok].sum()); n[k] += 1
    with np.errstate(invalid="ignore"):
        return acc / n


# -------------------------------------------------------- Gaussian windows ---
def _gauss_weights(shape, transform, lat, lng, sigma_km):
    rows, cols = np.indices(shape)
    xs = transform.c + (cols + 0.5) * transform.a
    ys = transform.f + (rows + 0.5) * transform.e
    dx = (xs - lng) * 111.320 * math.cos(math.radians(lat))
    dy = (ys - lat) * 110.574
    return np.exp(-(dx * dx + dy * dy) / (2 * sigma_km * sigma_km))


def population_at(points) -> np.ndarray:
    import rasterio
    from rasterio.windows import from_bounds

    out = np.zeros((len(points), len(POP_SIGMAS)))
    half_deg = 3 * max(POP_SIGMAS) / 100.0  # ~12 km
    with rasterio.open(WORLDPOP) as r:
        for k, (lat, lng) in enumerate(points):
            win = from_bounds(lng - half_deg, lat - half_deg, lng + half_deg, lat + half_deg, r.transform)
            a = r.read(1, window=win, boundless=True, fill_value=0).astype(np.float64)
            a[(a < 0) | ~np.isfinite(a)] = 0
            t = r.window_transform(win)
            for j, s in enumerate(POP_SIGMAS):
                out[k, j] = float((a * _gauss_weights(a.shape, t, lat, lng, s)).sum())
    return out


def built_at(points, px=300) -> np.ndarray:
    """Built-up fraction from WorldCover, read at a decimated resolution
    through the COG overviews (sampling a class map this way is an unbiased
    estimate of its fraction). Windows crossing a 3-degree tile edge are
    stitched from every tile they touch."""
    import rasterio
    from rasterio.windows import from_bounds

    out = np.full((len(points), len(BUILT_SIGMAS)), np.nan)
    half = 3 * max(BUILT_SIGMAS) / 100.0  # ~6 km
    for k, (lat, lng) in enumerate(points):
        b = (lng - half, lat - half, lng + half, lat + half)
        mosaic = np.zeros((px, px), dtype=np.uint8)
        tiles = {(math.floor(la / 3) * 3, math.floor(lo / 3) * 3) for la in (b[1], b[3]) for lo in (b[0], b[2])}
        for tla, tlo in tiles:
            url = WORLDCOVER_URL.format(ns="N" if tla >= 0 else "S", lat=abs(tla), lng=tlo)
            try:
                with rasterio.open(url) as r:
                    win = from_bounds(*b, r.transform)
                    a = r.read(1, window=win, out_shape=(px, px), boundless=True, fill_value=0)
                    mosaic = np.where(mosaic == 0, a, mosaic)
            except Exception:
                continue
        valid = mosaic > 0
        if not valid.any():
            continue
        from affine import Affine
        t = Affine((b[2] - b[0]) / px, 0, b[0], 0, -(b[3] - b[1]) / px, b[3])
        built = (mosaic == 50).astype(float)
        for j, s in enumerate(BUILT_SIGMAS):
            w = _gauss_weights((px, px), t, lat, lng, s) * valid
            out[k, j] = float((built * w).sum() / w.sum())
    return out


def maiac_at(points, max_km: float = 1.0) -> np.ndarray:
    """MAIAC AOD per point from maiac.py's output: [mean over all valid
    days, mean over winter (Nov-Feb), number of valid days]. A point is
    matched to the nearest sampled point within max_km (the pull stores
    monitor sites by coordinate); NaN when none is close or no day was valid."""
    f = RASTERS / "maiac_points.pkl"
    out = np.full((len(points), 3), np.nan)
    if not f.exists():
        return out
    st = pickle.loads(f.read_bytes())
    src = np.array(st["points"])
    vals: dict[int, list[tuple[str, float]]] = {}
    for (k, day), v in st["aod"].items():
        vals.setdefault(k, []).append((day, v))
    for i, (lat, lng) in enumerate(points):
        d = np.hypot((src[:, 0] - lat) * 110.574, (src[:, 1] - lng) * 111.320 * math.cos(math.radians(lat)))
        j = int(np.argmin(d))
        if d[j] > max_km or j not in vals:
            continue
        days = vals[j]
        allv = [v for _, v in days]
        win = [v for day, v in days if int(day[5:7]) in (11, 12, 1, 2)]
        out[i] = [np.mean(allv), np.mean(win) if win else np.nan, len(allv)]
    return out


def features(points: list[tuple[float, float]], months: list[str], cache_key: str):
    """-> (names, X) for the given points, cached by cache_key."""
    f = ROOT / "species_cache" / f"raster_{cache_key}.pkl"
    if f.exists():
        return pickle.loads(f.read_bytes())
    no2 = trop_no2_at(points, months)
    pop = population_at(points)
    blt = built_at(points)
    names = ["trop_no2"] + [f"pop_s{s}" for s in POP_SIGMAS] + [f"built_s{s}" for s in BUILT_SIGMAS]
    X = np.column_stack([no2, pop, blt])
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(pickle.dumps((names, X)))
    return names, X
