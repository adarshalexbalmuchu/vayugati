"""Import the Dhanbad-Jharia city pack into Supabase: one city_config row, the 265 grid cells of
data/jharkhand/processed/dhanbad_grid_3km.geojson as wards, and the Jharkhand continuous stations.

Usage (from ingest/, with the venv and ingest/.env's service key):
    .venv/bin/python scripts/jharkhand/import_city_pack.py            # dry run: prints what it would write
    .venv/bin/python scripts/jharkhand/import_city_pack.py --apply    # writes

Idempotent: the city is matched on city_code, wards upsert on (city_id, ward_number), stations are
matched on openaq_location_id. Reference stations in Asansol and Durgapur lie outside Dhanbad district,
so they have no grid cell to belong to and are not imported here.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from shapely.geometry import Point, shape

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app import db  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "data" / "jharkhand" / "processed"
CITY_CODE = "dhanbad"


# Cells are named by grid id only. They used to carry block names from geoBoundaries ADM3, but those are
# Census-era blocks (11, e.g. Jharia-Cum-Jorapokhar-Cum-Sindri) and Dhanbad now has 10 (dhanbad.nic.in).
# Put block names back only from an official boundary source.
ZONE = "Dhanbad district"


def build() -> tuple[dict, list[dict], list[dict]]:
    delhi = db.client().table("city_config").select("config").eq("city_code", "delhi").single().execute().data
    city = {
        "city_code": CITY_CODE,
        "name": "Dhanbad–Jharia",
        "country": "India",
        "timezone": "Asia/Kolkata",
        "default_language": "hi",
        "supported_languages": ["hi", "en"],
        "pollutant_priority": ["pm25", "pm10", "so2", "no2"],
        "is_active": True,
        # Delhi's operational config (attribution weights, dispatch approval rules) as the starting point;
        # map centre and bounds come from web/src/lib/cities.ts.
        "config": {**(delhi or {}).get("config", {}), "city_pack": {
            "units": "3 km grid over Dhanbad district", "source": "data/jharkhand/processed/dhanbad_grid_3km.geojson"}},
    }
    cells = json.load(open(DATA / "dhanbad_grid_3km.geojson"))["features"]
    wards = []
    for n, f in enumerate(sorted(cells, key=lambda f: f["properties"]["id"]), start=1):
        p = f["properties"]
        wards.append({
            "ward_number": n,
            "name": f"Dhanbad grid {p['id']}",
            "zone": ZONE,
            "is_hotspot": False,
            "lat": p["lat"],
            "lng": p["lng"],
            "boundary": f["geometry"],
            "metadata": {"cell_id": p["id"], "area_km2": p["area_km2"],
                         "source_document": "data/jharkhand/processed/dhanbad_grid_3km.geojson"},
        })
    stations = []
    for f in json.load(open(DATA / "stations.geojson"))["features"]:
        p = f["properties"]
        if p["role"] != "jharkhand":
            continue
        lng, lat = f["geometry"]["coordinates"]
        cell = next((w for w, c in zip(wards, sorted(cells, key=lambda f: f["properties"]["id"]))
                     if shape(c["geometry"]).contains(Point(lng, lat))), None)
        stations.append({"name": p["name"], "lat": lat, "lng": lng, "sensor_type": "regulatory", "agency": "JSPCB",
                         "is_active": True, "is_primary": True, "openaq_location_id": p["openaq_id"],
                         "_ward_number": cell["ward_number"] if cell else None})
    return city, wards, stations


def main(apply: bool) -> None:
    city, wards, stations = build()
    zones = {}
    for w in wards:
        zones[w["zone"]] = zones.get(w["zone"], 0) + 1
    print(f"city: {city['city_code']} ({city['name']})")
    print(f"wards: {len(wards)} grid cells; zones: {dict(sorted(zones.items()))}")
    for s in stations:
        print(f"station: {s['name']} -> ward_number {s['_ward_number']} (OpenAQ {s['openaq_location_id']})")
    if not apply:
        print("dry run: nothing written. Re-run with --apply to write.")
        return

    c = db.client()
    existing = c.table("city_config").select("id").eq("city_code", CITY_CODE).execute().data
    if existing:
        city_id = existing[0]["id"]
        c.table("city_config").update(city).eq("id", city_id).execute()
    else:
        city_id = c.table("city_config").insert(city).execute().data[0]["id"]
    rows = [{**w, "city_id": city_id} for w in wards]
    for i in range(0, len(rows), 50):
        c.table("wards").upsert(rows[i:i + 50], on_conflict="city_id,ward_number").execute()
    ids = {w["ward_number"]: w["id"] for w in
           c.table("wards").select("id, ward_number").eq("city_id", city_id).execute().data}
    for s in stations:
        row = {k: v for k, v in s.items() if not k.startswith("_")}
        row["ward_id"] = ids.get(s["_ward_number"])
        found = c.table("stations").select("id").eq("openaq_location_id", s["openaq_location_id"]).execute().data
        if found:
            c.table("stations").update(row).eq("id", found[0]["id"]).execute()
        else:
            c.table("stations").insert(row).execute()
    print(f"written: city_id {city_id}, {len(ids)} wards, {len(stations)} stations")


if __name__ == "__main__":
    main("--apply" in sys.argv[1:])
