"""Build the district profiles shown when a Jharkhand district is picked on the map.

Usage (from ingest/, with the venv):
    .venv/bin/python scripts/jharkhand/district_profiles.py

Every value comes from a government source, or from a computation on government data that is
labelled as such. Anything without one is written as null and shown as "NA".

    area, forest      FSI, ISFR 2023, Jharkhand Table 10.11.3 (area calculated by Survey of India)
                      -> data/jharkhand/sources/isfr2023_district_forest.csv
    population        Census of India 2011, Table A-02 -> data/jharkhand/sources/census2011_population.csv
    highest/lowest    Copernicus DEM GLO-90 (ESA / EU Copernicus programme, 90 m), from the public AWS
                      bucket; median and highest cell inside the district outline, computed by Vayu Gati.
                      (AWS Terrain Tiles were tried first and rejected: spike artefacts of hundreds of metres.)
    heat detections   NASA FIRMS VIIRS, the 5 days in processed/fires_firms_5d.geojson
    power plants      the checked sites in processed/state_sources_osm.geojson (CHECKED_SITES)
    air monitors      CPCB feed (continuous), CPCB NAMP list 19.11.2024 (manual), JSPCB tender 6.12.2025 (planned)
    mining area       null: no official district-wise figure found (OpenStreetMap areas are not official)

Output: data/jharkhand/processed/district_profiles.json, copied to web/public/city-packs/jharkhand/.
DEM tiles are cached in ingest/data/dem/copernicus90/ (gitignored).
"""

from __future__ import annotations

import csv
import json
import math
import shutil
from pathlib import Path

import httpx
import numpy as np
import shapely
from shapely.geometry import mapping, shape
from shapely.validation import make_valid

REPO = Path(__file__).resolve().parents[3]
OUT = REPO / "data" / "jharkhand" / "processed"
SRC = REPO / "data" / "jharkhand" / "sources"
WEB = REPO / "web" / "public" / "city-packs" / "jharkhand"
DEM = REPO / "ingest" / "data" / "dem" / "copernicus90"
COP_URL = "https://copernicus-dem-90m.s3.amazonaws.com"


def _cop_tile(lat: int, lon: int) -> Path | None:
    """Copernicus GLO-90 1x1 degree tile with south-west corner (lat, lon); None if ESA publishes none."""
    name = f"Copernicus_DSM_COG_30_N{lat:02d}_00_E{lon:03d}_00_DEM"
    p = DEM / f"{name}.tif"
    if not p.exists():
        r = httpx.get(f"{COP_URL}/{name}/{name}.tif", timeout=120)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        DEM.mkdir(parents=True, exist_ok=True)
        p.write_bytes(r.content)
    return p


def _elevation_stats(geom) -> tuple[int, int]:
    """Median and highest DEM cell inside the outline. The lowest cell is not used: it falls on open-cast
    pit floors (a surface model sees the pit) and river water (Ganga: below 0 m), not on ground level."""
    import rasterio
    from rasterio.mask import mask

    w, s, e, n = geom.bounds
    values = []
    for lat in range(math.floor(s), math.floor(n) + 1):
        for lon in range(math.floor(w), math.floor(e) + 1):
            path = _cop_tile(lat, lon)
            if path is None:
                continue
            with rasterio.open(path) as src:
                part = geom.intersection(shapely.box(*src.bounds))
                if part.is_empty:
                    continue
                arr, _ = mask(src, [mapping(part)], crop=True, filled=True, nodata=-32767)
                v = arr[0][arr[0] > -32767]
                if v.size:
                    values.append(v.astype(np.float32))
    allv = np.concatenate(values)
    return round(float(np.median(allv))), round(float(allv.max()))


def main() -> None:
    districts = json.load(open(OUT / "districts.geojson"))["features"]
    isfr = {r["district"]: r for r in csv.DictReader(open(SRC / "isfr2023_district_forest.csv"))}
    census = {r["district"]: int(r["population_2011"]) for r in csv.DictReader(open(SRC / "census2011_population.csv"))
              if r["district_code"] != "000"}
    fires = json.load(open(OUT / "fires_firms_5d.geojson"))["features"]
    fire_dates = sorted({f["properties"]["date"] for f in fires})
    plants = [f for f in json.load(open(OUT / "state_sources_osm.geojson"))["features"]
              if f["properties"].get("checked")]
    missing = [d["properties"]["name"] for d in districts if d["properties"]["name"] not in isfr or
               d["properties"]["name"] not in census]
    assert not missing, f"district names not matched: {missing}"

    lc_path = OUT / "landcover_districts.json"
    landcover = json.load(open(lc_path))["districts"] if lc_path.exists() else {}
    profiles = {}
    for d in districts:
        p = d["properties"]
        name = p["name"]
        g = make_valid(shape(d["geometry"]))
        med, hi = _elevation_stats(g)
        fx = np.array([f["geometry"]["coordinates"][0] for f in fires])
        fy = np.array([f["geometry"]["coordinates"][1] for f in fires])
        n_fires = int(shapely.contains_xy(g, fx, fy).sum()) if len(fires) else 0
        in_plants = [pl["properties"] for pl in plants
                     if g.contains(shape(pl["geometry"]))]
        f = isfr[name]
        profiles[name] = {
            "area_km2": int(f["area_km2_soi"]),
            "population_2011": census[name],
            "forest_km2": float(f["forest_total_km2"]),
            "forest_pct": float(f["forest_pct"]),
            "forest_very_dense_km2": float(f["vdf_km2"]),
            "forest_moderately_dense_km2": float(f["mdf_km2"]),
            "forest_open_km2": float(f["open_forest_km2"]),
            "elevation_median_m": med,
            "elevation_max_m": hi,
            "heat_detections": n_fires,
            "power_plants": [{"name": x["name"], "operator": x["operator"]} for x in in_plants if x["kind"] == "power_plant"],
            "large_works": [{"name": x["name"], "operator": x["operator"]} for x in in_plants if x["kind"] == "works"],
            "monitors_continuous_in_feed": p.get("continuous_in_feed"),
            "monitors_manual_namp": p.get("manual_namp"),
            "monitors_planned_jspcb": p.get("planned_caaqms"),
            "mining_area_km2": None,
            "landcover_pct": landcover.get(name),
        }
        print(f"{name:22s} area {f['area_km2_soi']:>5}  pop {census[name]:>8}  median {med:>4} m, highest {hi:>4} m  "
              f"fires {n_fires:>3}  plants {len(in_plants)}")

    doc = {
        "sources": {
            "area_km2": "Survey of India calculated area, in FSI India State of Forest Report 2023, Jharkhand Table 10.11.3",
            "forest": "Forest Survey of India, India State of Forest Report 2023 (published Dec 2024), Jharkhand Table 10.11.3",
            "population_2011": "Census of India 2011, Table A-02 (Office of the Registrar General & Census Commissioner)",
            "elevation": "Copernicus DEM GLO-90 (ESA), 90 m grid; median and highest cell inside the district "
                         "outline, computed by Vayu Gati. Checked: Giridih 1,361 m (Parasnath, about 1,350-1,365 m), "
                         "Bokaro 975 m (Lugu, about 980 m)",
            "heat_detections": f"NASA FIRMS VIIRS (S-NPP and NOAA-20), {fire_dates[0]} to {fire_dates[-1]} (UTC)"
                               if fire_dates else "NASA FIRMS VIIRS",
            "power_plants": "Power plants and large works whose names and operators were checked by Vayu Gati, Nov 2026; "
                            "locations from OpenStreetMap",
            "monitors": "CPCB real-time feed (continuous, 5 Nov 2026); CPCB NAMP station list 19.11.2024 (manual); "
                        "JSPCB tender JSPCB/CAAQMS/2025-26 of 6.12.2025 (planned)",
            "mining_area_km2": "No official district-wise figure found",
            "landcover": "ESA WorldCover 10 m 2021 v200 (European Space Agency); shares computed by Vayu Gati at "
                         "about 180 m over the district outline",
            "outline": "District outlines: Datameet India district map (CC BY 2.5 India), compiled from Bhuvan taluk data with names and extent from the Census of India 2011 Atlas. Areas checked against Survey of India (ISFR 2023): mean difference 1.7%, largest 7.2% (Sahibganj). Not Survey of India's own file",
        },
        "heat_detection_dates": fire_dates,
        "districts": profiles,
    }
    with open(OUT / "district_profiles.json", "w") as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
    WEB.mkdir(parents=True, exist_ok=True)
    shutil.copy(OUT / "district_profiles.json", WEB / "district_profiles.json")
    print("wrote", OUT / "district_profiles.json")


if __name__ == "__main__":
    main()
