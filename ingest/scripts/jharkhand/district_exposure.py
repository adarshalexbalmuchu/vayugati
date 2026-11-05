"""How many people live near mapped pollution-related sites, per district.

Usage (from ingest/, with the venv):
    .venv/bin/python scripts/jharkhand/district_exposure.py

Population: WorldPop 2020 (University of Southampton), 1 km grid, "Aggregated" (not adjusted to UN totals), CC BY 4.0.
It is a model estimate: its state total is 40.0 million against the Census 2011's 33.0 million (about 1.8% growth
a year), and districts differ (Sahibganj is 1.57x its Census figure), so everything here is a share of the
WorldPop-estimated population, not of the Census count.

Sites: from the map's own files, so exactly what the map shows: mapped mining and quarry areas, mapped brick kilns
(OpenStreetMap, 3 Nov 2026, volunteer-mapped and incomplete), and the checked power plants and large works. "Within
R km" counts a 1 km cell if its centre lies within R km of the site. At 1 km resolution, 2 km is coarse; the numbers are
indications, not exact counts. Output: data/jharkhand/processed/district_exposure.json.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import geometry_mask
from shapely.affinity import scale
from shapely.geometry import shape
from shapely.ops import unary_union
from shapely.validation import make_valid

REPO = Path(__file__).resolve().parents[3]
OUT = REPO / "data" / "jharkhand" / "processed"
WEB = REPO / "web" / "public" / "city-packs" / "jharkhand"
TIF = REPO / "ingest" / "data" / "worldpop" / "ind_ppp_2020_1km.tif"
KX, KY = 111.32 * math.cos(math.radians(23.6)), 110.57  # km per degree at Jharkhand's latitude
RADII = (2, 5)


def to_km(g):
    return scale(g, xfact=KX, yfact=KY, origin=(0, 0))


def to_deg(g):
    return scale(g, xfact=1 / KX, yfact=1 / KY, origin=(0, 0))


def load_sites() -> dict[str, list]:
    src = json.load(open(WEB / "sources.geojson"))["features"]
    kilns = json.load(open(WEB / "kilns.geojson"))["features"]
    pick = lambda fs, pred: [make_valid(shape(f["geometry"])) for f in fs if pred(f["properties"])]
    return {
        "mines": pick(src, lambda p: p.get("kind") == "mine"),
        "kilns": pick(kilns, lambda p: True),
        "plants": pick(src, lambda p: p.get("kind") in ("power_plant", "works") and p.get("checked")),
    }


def main() -> None:
    districts = {f["properties"]["name"]: make_valid(shape(f["geometry"])) for f in json.load(open(OUT / "districts.geojson"))["features"]}
    sites = load_sites()
    with rasterio.open(TIF) as s:
        arr = s.read(1).astype("float64")
        arr[(arr == s.nodata) | (arr < 0)] = 0
        shape_px = (s.height, s.width)
        tf = s.transform
    masks = {}
    for kind, geoms in sites.items():
        km = [to_km(g) for g in geoms]
        for r in RADII:
            buf = to_deg(unary_union([g.buffer(r, resolution=8) for g in km]))
            masks[(kind, r)] = geometry_mask([buf.__geo_interface__], shape_px, tf, invert=True)
        print(kind, len(geoms), "sites", flush=True)
    result = {}
    for name, g in districts.items():
        inside = geometry_mask([g.__geo_interface__], shape_px, tf, invert=True)
        total = float(arr[inside].sum())
        row = {"population_worldpop_2020": round(total)}
        for (kind, r), m in masks.items():
            near = float(arr[inside & m].sum())
            row[f"{kind}_{r}km_people"] = round(near)
            row[f"{kind}_{r}km_pct"] = round(100 * near / total, 1) if total else None
        result[name] = row
    state_total = sum(r["population_worldpop_2020"] for r in result.values())
    state = {"population_worldpop_2020": state_total}
    for (kind, r) in masks:
        n = sum(x[f"{kind}_{r}km_people"] for x in result.values())
        state[f"{kind}_{r}km_people"] = n
        state[f"{kind}_{r}km_pct"] = round(100 * n / state_total, 1)
    doc = {
        "source": "Population: WorldPop 2020, 1 km grid, University of Southampton (CC BY 4.0), a model estimate "
                  "(state total 40.0 million vs Census 2011 33.0 million). Sites: the map's own layers (OpenStreetMap, "
                  "3 Nov 2026, volunteer-mapped and incomplete; checked power plants and works). A 1 km cell counts if "
                  "its centre is within the distance of a site: an indication, not an exact count.",
        "radii_km": list(RADII), "state": state, "districts": result,
    }
    json.dump(doc, open(OUT / "district_exposure.json", "w"), indent=1)
    for n, r in sorted(result.items(), key=lambda kv: -kv[1]["mines_5km_pct"])[:8]:
        print(f"{n:20s} pop {r['population_worldpop_2020']:8d}  within 2 km of mines {r['mines_2km_pct']:5.1f}%  5 km {r['mines_5km_pct']:5.1f}%  kilns2km {r['kilns_2km_pct']:5.1f}%  plants5km {r['plants_5km_pct']:5.1f}%")
    print("state:", state)


if __name__ == "__main__":
    main()
