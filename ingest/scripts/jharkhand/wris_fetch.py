"""Download the India-WRIS (Ministry of Jal Shakti: CWC / NWIC / CGWB) layers we use, for Jharkhand.

Run:  .venv/bin/python scripts/jharkhand/wris_fetch.py [layer ...]

Public ArcGIS REST services at https://arc.indiawris.gov.in/server/rest/services (read-only queries, normal
certificate checks). Raw responses go to data/jharkhand/sources/wris/ with the date, untouched except that only the
columns we use are requested; build_layers.py reads them from there. Nothing is edited or filled in here.
A layer is selected either by a `where` clause on the state, or by the bounding box of Jharkhand (build_layers.py then
keeps what lies inside the state outline).
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://arc.indiawris.gov.in/server/rest/services"
OUT = Path(__file__).resolve().parents[3] / "data" / "jharkhand" / "sources" / "wris"
BBOX = (83.3, 21.9, 88.0, 25.4)  # a little wider than the state

ADMIN = "Admin/Administrative_Data/FeatureServer"
GWR = "DataDownload/Ground_Water_Resource_Estimation_Data/FeatureServer"
WIMS = "DataDownload/Water_Information_Management_System_WIMS_data/FeatureServer"
WRP = "DataDownload/Water_Resource_Project_Data/FeatureServer"

# name -> service path, layer id, page size, generalise (degrees; 0 = none), where (None = bounding box), out fields (None = all)
LAYERS: dict[str, dict] = {
    "streams": dict(path="Common/River_WRP/FeatureServer", layer=0, page=100, simplify=0.0005),
    "rivers": dict(path="Common/River_WRP/FeatureServer", layer=1, page=300, simplify=0.0005),
    "basins": dict(path="Common/Basin_WRP/MapServer", layer=0, page=50, simplify=0.002),
    "subbasins": dict(path="Common/Basin_WRP/MapServer", layer=1, page=50, simplify=0.002),
    "dams": dict(path=WRP, layer=3, page=500),
    "powerhouses": dict(path=WRP, layer=0, page=500),
    "national_parks": dict(path="DataDownload/Wildlife_Data/FeatureServer", layer=3, page=50, simplify=0.0005),
    # Census 2011 as published through India-WRIS
    "villages": dict(path=ADMIN, layer=2, page=2000, where="state_code=20", fields=[
        "village_code", "village_name", "district_name", "sub_district_name", "cd_block_name",
        "total_geographical_area__in_hec", "total___households", "total_population_of_village"]),
    "towns": dict(path=ADMIN, layer=1, page=500, where="state_name='JH'", fields=[
        "town_code", "town_name", "district_name", "sub_district_name", "total_households", "total_population_of_town",
        "class", "civic_status_of_town", "area_sqkm", "town_population_census_2001", "town_population_census_2011",
        "growth_rate_town_census_2011", "density_census_2011", "sex_ratio_census_2011", "ctype"]),
    "blocks": dict(path=ADMIN, layer=7, page=300, where="state='JH'", simplify=0.0008),
    "assembly": dict(path=ADMIN, layer=9, page=300, where="st_name='JH'", simplify=0.0008),
    # Ground water resources (CGWB / CWC), 2020 assessment
    "gwr_blocks": dict(path=GWR, layer=11, page=300, where="state='JH'", simplify=0.0008),
    "gwr_districts": dict(path=GWR, layer=7, page=100, where="state='JH'", simplify=0.0008),
    # Monitoring stations (WIMS)
    "stations_gw_level": dict(path=WIMS, layer=1, page=2000, where="state_name='Jharkhand'", fields=[
        "station_code", "station_name", "station_type", "lat", "long", "agency_name", "district_name", "block_name", "basin_name"]),
    "stations_quality": dict(path=WIMS, layer=6, page=2000, where="state_name='Jharkhand'", fields=[
        "station_code", "station_name", "station_type", "lat", "long", "agency_name", "district_name", "block_name", "basin_name"]),
    "stations_rain": dict(path=WIMS, layer=4, page=2000, where="state_name='Jharkhand'", fields=[
        "station_code", "station_name", "station_type", "lat", "long", "agency_name", "district_name", "block_name", "basin_name"]),
    "stations_reservoir": dict(path=WIMS, layer=3, page=500, where="state_name='Jharkhand'", fields=[
        "station_code", "station_name", "station_type", "lat", "long", "agency_name", "district_name", "basin_name", "frl"]),
    # Hazards and ground water
    "seismic": dict(path="DataDownload/Extreme_Temperature_Rainfall_Data/FeatureServer", layer=3, page=100, simplify=0.002),
    "aquifers": dict(path="DataDownload/Ground_Water_Layers/FeatureServer", layer=2, page=100, simplify=0.001),
    # Census 2011 village directory details (no geometry; joined to the villages by code)
    "village_details": dict(path=ADMIN, layer=2, page=2000, where="state_code=20", geometry=False, fields=[
        "village_code", "gram_panchayat_name", "nearest_town_name", "nearest_town_distance_from_vill",
        "total_male_population_of_villag", "total_female_population_of_vill",
        "forest_area__in_hectares_", "area_under_non_agricultural_use", "barren___un_cultivable_land_are",
        "permanent_pastures_and_other_gr", "land_under_miscellaneous_tree_c", "culturable_waste_land_area__in_",
        "fallows_land_other_than_current", "current_fallows_area__in_hectar", "net_area_sown__in_hectares_",
        "total_unirrigated_land_area__in", "area_irrigated_by_source__in_he", "canals_area__in_hectares_",
        "wells_tube_wells_area__in_hecta", "tanks_lakes_area__in_hectares_",
        "tap_water_treated__status_a_1__", "tap_water_untreated__status_a_1", "covered_well__status_a_1__na_2_",
        "uncovered__well__status_a_1__na", "hand_pump__status_a_1__na_2__", "tube_wells_borehole__status_a_1",
        "spring__status_a_1__na_2__", "river_canal__status_a_1__na_2__", "tank_pond_lake__status_a_1__na_"]),
    "canals": dict(path=WRP, layer=5, page=1000, simplify=0.0005),
}


def _get(url: str, params: dict) -> dict:
    q = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{url}?{q}", headers={"User-Agent": "Mozilla/5.0 (vayugati data build)"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read())
        except Exception:  # noqa: BLE001 - the service is slow and sometimes drops a request
            if attempt == 3:
                raise
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("unreachable")


def fetch(name: str) -> dict:
    spec = LAYERS[name]
    url = f"{BASE}/{spec['path']}/{spec['layer']}/query"
    feats, offset = [], 0
    page = spec["page"]
    while True:
        params = {
            "outSR": 4326, "f": "geojson", "resultRecordCount": page, "resultOffset": offset, "orderByFields": "objectid",
            "outFields": ",".join(["objectid"] + spec["fields"]) if spec.get("fields") else "*",
        }
        if spec.get("where"):
            params["where"] = spec["where"]
        else:
            params.update({"geometry": ",".join(map(str, BBOX)), "geometryType": "esriGeometryEnvelope", "inSR": 4326,
                           "spatialRel": "esriSpatialRelIntersects"})
        if spec.get("simplify"):
            params["maxAllowableOffset"] = spec["simplify"]
        if spec.get("geometry") is False:
            params["returnGeometry"] = "false"
        d = _get(url, params)
        got = d.get("features", [])
        feats += got
        # The server may return fewer than asked (its own size cap): go on until it says nothing is left.
        if not got or not (d.get("exceededTransferLimit") or len(got) >= page):
            break
        offset += len(got)
    return {"type": "FeatureCollection", "features": feats}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    today = dt.date.today().isoformat()
    names = sys.argv[1:] or list(LAYERS)
    for name in names:
        fc = fetch(name)
        spec = LAYERS[name]
        fc["fetched"] = today
        fc["source"] = f"India-WRIS (Ministry of Jal Shakti): {spec['path']} layer {spec['layer']}"
        (OUT / f"{name}.geojson").write_text(json.dumps(fc))
        print(f"{name}: {len(fc['features'])} features", flush=True)


if __name__ == "__main__":
    main()
