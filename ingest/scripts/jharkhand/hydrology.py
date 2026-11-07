"""Water flow over Jharkhand from the FABDEM bare-earth elevation (offline; run once, the browser reads the result).

Run (needs numpy < 2.4 (pysheds uses np.in1d), scipy, rasterio, numba and pysheds; use a scratch environment, they are not in requirements.txt):

    python hydrology.py dem     # FABDEM tiles -> 90 m elevation grid
    python hydrology.py flow    # fill depressions, D8 flow direction, flow accumulation
    python hydrology.py flow burn   # the same after lowering the India-WRIS major rivers into the elevation (stream burning)
    python hydrology.py check   # compare the computed streams with the India-WRIS major rivers
    python hydrology.py pack    # the files the web app loads (web/public/city-packs/jharkhand/water/)

Method (the standard one, written down so it can be repeated and questioned):
- Elevation: FABDEM V1-2 (University of Bristol, CC BY-NC-SA 4.0; bare earth: forests and buildings removed from Copernicus
  GLO-30). The 30 m grid is averaged 3 x 3 to 90 m; the flow is computed at 90 m, where one cell is about 0.8 hectare.
- Pits and depressions are filled (pysheds fill_pits, fill_depressions), flats are resolved, flow goes to the steepest
  downhill of the 8 neighbours (D8), accumulation counts the cells draining through each cell.
- Stream burning (optional, `burn`): the 25 India-WRIS major rivers are lowered by BURN_M (8 m) along their line (and 3.2 m on the cells beside
  it), the standard way to make flow follow mapped channels through reservoirs and flat floodplains, where a 90 m grid alone loses
  the river. It ties the network to India-WRIS, so it is judged on independent figures (dam catchment areas), not on the river check.
- Streams are cells whose drainage area is at least STREAM_KM2 (a display and snapping choice, not a mapped fact).
- The grid covers 83-88 E, 21-26 N (the 25 FABDEM tiles). Drainage that comes from outside this box is cut at the edge: the
  web app says so when a catchment touches it.
India-WRIS (Central Water Commission) stays the authority we show for river names and basins; this computation is a
terrain-based estimate and is checked against it (`check`).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
FAB = ROOT / "data" / "jharkhand" / "sources" / "fabdem"
WRIS = ROOT / "data" / "jharkhand" / "sources" / "wris"
OUT = ROOT / "data" / "jharkhand" / "processed" / "hydro"
PACK = ROOT / "web" / "public" / "city-packs" / "jharkhand" / "water"

W, S, E, N = 83, 21, 88, 26  # tile corners: 5 x 5 one-degree tiles
STEP = 3  # 30 m -> 90 m
CELL_DEG = STEP / 3600
NCOL = (E - W) * 3600 // STEP
NROW = (N - S) * 3600 // STEP
STREAM_KM2 = 10.0  # minimum drainage area of a drawn stream
BURN = "burn" in sys.argv[2:]
SUFFIX = "_burn" if BURN else ""
BURN_M = float(os.environ.get("BURN_M", "8"))  # metres the river line is lowered
BURN_SHOULDER_M = BURN_M / 2.5


def dem() -> None:
    import rasterio
    from rasterio.transform import from_origin

    OUT.mkdir(parents=True, exist_ok=True)
    arr = np.full((NROW, NCOL), np.nan, dtype=np.float32)
    per = 3600 // STEP
    for lat in range(S, N):
        for lon in range(W, E):
            p = FAB / f"N{lat:02d}E{lon:03d}_FABDEM_V1-2.tif"
            with rasterio.open(p) as r:
                a = r.read(1).astype(np.float32)
                a[a == r.nodata] = np.nan
            a = np.nanmean(a.reshape(per, STEP, per, STEP), axis=(1, 3)) if np.isnan(a).any() else a.reshape(per, STEP, per, STEP).mean(axis=(1, 3))
            row0 = (N - 1 - lat) * per
            col0 = (lon - W) * per
            arr[row0 : row0 + per, col0 : col0 + per] = a
            print("tile", p.name, flush=True)
    with rasterio.open(
        OUT / "dem90.tif", "w", driver="GTiff", height=NROW, width=NCOL, count=1, dtype="float32",
        crs="EPSG:4326", transform=from_origin(W, N, CELL_DEG, CELL_DEG), nodata=-9999, compress="deflate",
    ) as w:
        w.write(np.where(np.isnan(arr), -9999, arr), 1)
    print("dem90.tif", arr.shape, "cells with no data:", int(np.isnan(arr).sum()))


def _burned_dem() -> Path:
    """dem90.tif with the India-WRIS major rivers lowered into it; returns the new file."""
    import rasterio

    with rasterio.open(OUT / "dem90.tif") as r:
        arr = r.read(1)
        prof = r.profile
    fc = json.loads((PACK.parent / "majorrivers.geojson").read_text())
    line = np.zeros(arr.shape, dtype=bool)
    for f in fc["features"]:
        g = f["geometry"]
        for part in (g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]):
            pts = np.asarray(part)
            for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
                n = max(2, int(max(abs(x1 - x0), abs(y1 - y0)) / (CELL_DEG / 3)))
                xs, ys = np.linspace(x0, x1, n), np.linspace(y0, y1, n)
                cs, rs = ((xs - W) / CELL_DEG).astype(int), ((N - ys) / CELL_DEG).astype(int)
                ok = (cs >= 0) & (cs < NCOL) & (rs >= 0) & (rs < NROW)
                line[rs[ok], cs[ok]] = True
    from scipy import ndimage

    shoulder = ndimage.binary_dilation(line, iterations=1) & ~line
    arr = arr.copy()
    arr[shoulder] -= BURN_SHOULDER_M
    arr[line] -= BURN_M
    print("burned", int(line.sum()), "river cells and", int(shoulder.sum()), "shoulder cells")
    dst = OUT / "dem90_burn.tif"
    with rasterio.open(dst, "w", **prof) as w:
        w.write(arr, 1)
    return dst


def flow() -> None:
    from pysheds.grid import Grid

    src = OUT / "dem90.tif"
    if BURN:
        src = _burned_dem()
    grid = Grid.from_raster(str(src))
    d = grid.read_raster(str(src))
    print("fill pits", flush=True)
    d = grid.fill_pits(d)
    print("fill depressions", flush=True)
    d = grid.fill_depressions(d)
    print("resolve flats", flush=True)
    d = grid.resolve_flats(d)
    print("flow direction", flush=True)
    fdir = grid.flowdir(d)
    np.save(OUT / f"fdir{SUFFIX}.npy", np.asarray(fdir).astype(np.int16))
    print("accumulation", flush=True)
    acc = grid.accumulation(fdir)
    np.save(OUT / f"acc{SUFFIX}.npy", np.asarray(acc).astype(np.float32))
    print("done", np.asarray(fdir).shape, float(np.asarray(acc).max()))


def _area_km2(acc: np.ndarray) -> np.ndarray:
    """Drainage area of every cell in km2: cells counted times the area of a cell at that latitude."""
    lat = N - (np.arange(NROW) + 0.5) * CELL_DEG
    cell = (CELL_DEG * 110.54) * (CELL_DEG * 111.32 * np.cos(np.radians(lat)))
    return acc * cell[:, None].astype(np.float32)


def check() -> None:
    """How well do the computed streams follow the India-WRIS major rivers? Distance from points along each river to the
    nearest computed stream cell (drainage area >= STREAM_KM2)."""
    from scipy import ndimage

    acc = np.load(OUT / f"acc{SUFFIX}.npy")
    stream = _area_km2(acc) >= STREAM_KM2
    dist = ndimage.distance_transform_edt(~stream)  # in cells
    fc = json.loads((PACK.parent / "majorrivers.geojson").read_text())
    report = []
    for f in fc["features"]:
        g = f["geometry"]
        lines = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
        ds = []
        for line in lines:
            pts = np.asarray(line)
            for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
                n = max(1, int(max(abs(x1 - x0), abs(y1 - y0)) / 0.004))
                for t in np.linspace(0, 1, n, endpoint=False):
                    x, y = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
                    c, r = int((x - W) / CELL_DEG), int((N - y) / CELL_DEG)
                    if 0 <= r < NROW and 0 <= c < NCOL:
                        ds.append(float(dist[r, c]))
        if not ds:
            continue
        d = np.asarray(ds)
        report.append({
            "river": f["properties"].get("name"), "points": len(d),
            "within_270m_pct": round(100 * float((d <= 3).mean()), 1),
            "within_900m_pct": round(100 * float((d <= 10).mean()), 1),
            "median_m": round(float(np.median(d)) * CELL_DEG * 111320 * 0.92),
        })
    report.sort(key=lambda r: -r["points"])
    (OUT / f"check{SUFFIX}.json").write_text(json.dumps(report, indent=1))
    tot = sum(r["points"] for r in report)
    w270 = sum(r["within_270m_pct"] * r["points"] for r in report) / tot
    w900 = sum(r["within_900m_pct"] * r["points"] for r in report) / tot
    for r in report:
        print(f"{str(r['river']):28s} {r['points']:5d} pts  within 270 m {r['within_270m_pct']:5.1f}%  within 900 m {r['within_900m_pct']:5.1f}%  median {r['median_m']} m")
    print(f"ALL {tot} points: within 270 m {w270:.1f}%, within 900 m {w900:.1f}%")


ESRI_TO_INDEX = {1: 1, 2: 2, 4: 3, 8: 4, 16: 5, 32: 6, 64: 7, 128: 8}  # E SE S SW W NW N NE; 0 = no outflow


# What the browser gets: the state with a margin (the rest of the grid is not needed to follow water inside Jharkhand).
PACK_W, PACK_E, PACK_S, PACK_N = 83.05, 88.0, 21.75, 25.6
SNAP_KM2 = 1.0  # cells draining less than this carry no accumulation byte (so the file compresses well)


def pack() -> None:
    """The files the browser loads on demand (only when the water tool is first used): direction index (1-8, 0 none) and a
    log2-scaled accumulation that exists only for cells draining at least SNAP_KM2 (0 elsewhere), one byte per cell,
    gzip-compressed by us and stored as plain .bin files (a .gz name makes some servers add their own Content-Encoding); plus a small JSON with the grid. Decode: drainage cells = 2 ** (byte / 10)."""
    import gzip

    PACK.mkdir(parents=True, exist_ok=True)
    c0, c1 = int(round((PACK_W - W) / CELL_DEG)), int(round((PACK_E - W) / CELL_DEG))
    r0, r1 = int(round((N - PACK_N) / CELL_DEG)), int(round((N - PACK_S) / CELL_DEG))
    fdir = np.load(OUT / f"fdir{SUFFIX}.npy")
    idx = np.zeros(fdir.shape, dtype=np.uint8)
    for k, v in ESRI_TO_INDEX.items():
        idx[fdir == k] = v
    acc = np.load(OUT / f"acc{SUFFIX}.npy")
    lg = np.clip(np.round(np.log2(np.maximum(acc, 1)) * 10), 0, 255).astype(np.uint8)
    lg[_area_km2(acc) < SNAP_KM2] = 0
    for name, a in (("flowdir", idx[r0:r1, c0:c1]), ("flowacc", lg[r0:r1, c0:c1])):
        (PACK / f"{name}.bin").write_bytes(gzip.compress(np.ascontiguousarray(a).tobytes(), 9))
        print(name, a.shape, (PACK / f"{name}.bin").stat().st_size // 1024, "KB")
    meta = {
        "west": W + c0 * CELL_DEG, "north": N - r0 * CELL_DEG, "cellDeg": CELL_DEG, "ncol": c1 - c0, "nrow": r1 - r0,
        "directions": "1 E, 2 SE, 3 S, 4 SW, 5 W, 6 NW, 7 N, 8 NE; 0 no outflow",
        "accDecode": "drainage cells = 2 ** (byte / 10); 0 = less than snapKm2 or none",
        "snapKm2": SNAP_KM2, "streamKm2": STREAM_KM2,
        "source": "FABDEM V1-2 (University of Bristol, CC BY-NC-SA 4.0), averaged to 90 m; India-WRIS major rivers lowered 8 m into it (stream burning); D8 flow after filling depressions (pysheds); computed by Vayu Gati",
    }
    (PACK / "hydro.json").write_text(json.dumps(meta, indent=1))


if __name__ == "__main__":
    {"dem": dem, "flow": flow, "check": check, "pack": pack}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: print(__doc__))()
