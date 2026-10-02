"""Context features for the location model: wind, terrain, power plants.

Three things a land-use model misses by default, each added with a
published approach and kept only if the whole-city holdout improves:

  wind     Wind-weighted source loads (Arain et al. 2007, Atmos. Env.):
           a source counts more when the site's own wind rose often blows
           FROM its direction. Normalised so a uniform wind rose gives the
           unweighted value; the features isolate the wind effect.
  terrain  Elevation and elevation RELATIVE to the surroundings (valleys
           and basins trap pollution under night-time inversions; ridges
           block or channel flow) plus 10 km ruggedness. Copernicus GLO-30
           DEM, open COGs on AWS, read remotely.
  plants   Fossil power-plant capacity, distance-weighted (WRI Global Power
           Plant Database v1.3, open).
"""

from __future__ import annotations

import csv
import math
import pickle
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2] / "data"
DEM_URL = ("/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{ns}{lat:02d}_00_{ew}{lon:03d}_00_DEM/"
           "Copernicus_DSM_COG_10_{ns}{lat:02d}_00_{ew}{lon:03d}_00_DEM.tif")
SECTORS = 8
FOSSIL = {"Coal", "Gas", "Oil", "Petcoke"}


def _km(lat1, lng1, lat2, lng2):
    kx = 111.320 * np.cos(np.radians(lat1))
    return np.hypot((lat2 - lat1) * 110.574, (lng2 - lng1) * kx)


def _bearing_sector(lat1, lng1, lat2, lng2):
    """Sector (0 = N, clockwise) of the direction FROM the site TO the source."""
    kx = 111.320 * np.cos(np.radians(lat1))
    b = (np.degrees(np.arctan2((lng2 - lng1) * kx, (lat2 - lat1) * 110.574)) + 360) % 360
    return ((b + 180 / SECTORS) // (360 / SECTORS)).astype(int) % SECTORS


def wind_roses(site_ids, met: dict) -> dict[int, np.ndarray]:
    """Per site: fraction of hours the wind blew FROM each sector (ERA5
    wind_dir is the meteorological 'from' direction)."""
    counts = {s: np.zeros(SECTORS) for s in site_ids}
    for (s, _), m in met.items():
        if s in counts and m and m.get("wind_dir") is not None and (m.get("wind_speed") or 0) > 0.5:
            counts[s][int((m["wind_dir"] + 180 / SECTORS) // (360 / SECTORS)) % SECTORS] += 1
    return {s: (c / c.sum() if c.sum() else np.full(SECTORS, 1 / SECTORS)) for s, c in counts.items()}


def wind_weighted(points, roses, slat, slng, w, sigma_km):
    """sum_src w * gauss(d) * SECTORS * f[sector(src)] per point; = unweighted
    sum when the rose is uniform."""
    out = np.zeros(len(points))
    reach = 4 * sigma_km
    for i, (la, lo) in enumerate(points):
        near = (np.abs(slat - la) * 110.574 <= reach) & (np.abs(slng - lo) * 111.320 * math.cos(math.radians(la)) <= reach)
        if not near.any():
            continue
        d = _km(la, lo, slat[near], slng[near])
        sec = _bearing_sector(la, lo, slat[near], slng[near])
        out[i] = float(np.sum(w[near] * np.exp(-d * d / (2 * sigma_km ** 2)) * SECTORS * roses[i][sec]))
    return out


def plants():
    rows = [r for r in csv.DictReader(open(ROOT / "rasters" / "global_power_plant_database.csv"))
            if r["country"] == "IND" and r["primary_fuel"] in FOSSIL]
    return (np.array([float(r["latitude"]) for r in rows]), np.array([float(r["longitude"]) for r in rows]),
            np.array([float(r["capacity_mw"] or 0) for r in rows]))


def terrain(points, px=160):
    """[elevation, elev - mean within 5 km, elev - mean within 20 km, std within 10 km]
    from a decimated window (~250 m) of the 30 m DEM, stitched across tiles."""
    import rasterio
    from rasterio.windows import from_bounds

    out = np.full((len(points), 4), np.nan)
    for i, (la, lo) in enumerate(points):
        half = 0.2  # deg, ~20 km
        b = (lo - half, la - half, lo + half, la + half)
        mosaic = np.full((px, px), np.nan)
        for tla in range(math.floor(b[1]), math.floor(b[3]) + 1):
            for tlo in range(math.floor(b[0]), math.floor(b[2]) + 1):
                url = DEM_URL.format(ns="N" if tla >= 0 else "S", lat=abs(tla), ew="E" if tlo >= 0 else "W", lon=abs(tlo))
                try:
                    with rasterio.open(url) as r:
                        a = r.read(1, window=from_bounds(*b, r.transform), out_shape=(px, px),
                                   boundless=True, fill_value=-9999).astype(float)
                    a[a <= -1000] = np.nan
                    mosaic = np.where(np.isnan(mosaic), a, mosaic)
                except Exception:
                    continue
        if np.isnan(mosaic).all():
            continue
        yy, xx = np.mgrid[0:px, 0:px]
        dlat = (b[3] - (yy + 0.5) * (2 * half / px)) - la
        dlng = (b[0] + (xx + 0.5) * (2 * half / px)) - lo
        d = np.hypot(dlat * 110.574, dlng * 111.320 * math.cos(math.radians(la)))
        c = px // 2
        e0 = np.nanmean(mosaic[c - 1:c + 1, c - 1:c + 1])
        out[i] = [e0, e0 - np.nanmean(mosaic[d <= 5]), e0 - np.nanmean(mosaic[d <= 20]), np.nanstd(mosaic[d <= 10])]
    return out


def features(points, site_ids, met, roads, ind, cache_key):
    f = ROOT / "species_cache" / f"context_{cache_key}.pkl"
    if f.exists():
        return pickle.loads(f.read_bytes())
    roses = wind_roses(site_ids, met)
    rose_list = [roses[s] for s in site_ids]
    rlat = np.array([c["lat"] for c in roads]); rlng = np.array([c["lng"] for c in roads])
    major = np.array([sum(km for cls, km in (c.get("length_km_by_class") or {}).items()
                          if cls in ("motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link"))
                      for c in roads])
    ilat = np.array([z["lat"] for z in ind]); ilng = np.array([z["lng"] for z in ind])
    iw = np.array([z["emission_weight"] for z in ind])
    plat, plng, pcap = plants()
    from scripts.species.features import _kernel_sums
    pts_lat = np.array([p[0] for p in points]); pts_lng = np.array([p[1] for p in points])
    pp = _kernel_sums(pts_lat, pts_lng, plat, plng, pcap[:, None], (10.0, 30.0, 100.0))[:, :, 0]
    names = ["ww_road_major_s4", "ww_industrial_s3", "ww_plants_s30",
             "plants_s10", "plants_s30", "plants_s100",
             "elev", "elev_rel5", "elev_rel20", "rough10"]
    X = np.column_stack([
        wind_weighted(points, rose_list, rlat, rlng, major, 4.0),
        wind_weighted(points, rose_list, ilat, ilng, iw, 3.0),
        wind_weighted(points, rose_list, plat, plng, pcap, 30.0),
        pp[:, 0], pp[:, 1], pp[:, 2],
        terrain(points),
    ])
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(pickle.dumps((names, X)))
    return names, X
