"""Build the Jharkhand / Dhanbad-Jharia map layers into data/jharkhand/processed/.

Usage (from ingest/, with the venv):
    .venv/bin/python scripts/jharkhand/build_layers.py all
    .venv/bin/python scripts/jharkhand/build_layers.py boundaries|stations|fires|osm

Steps:
    boundaries  geoBoundaries ADM2 (ODbL) -> state, 24 districts, Dhanbad 3 km grid
    stations    CPCB data.gov.in real-time feed + OpenAQ -> continuous stations; adds manual (NAMP)
                and planned (JSPCB tender) station counts to the district layer
    fires       NASA FIRMS VIIRS (SNPP + NOAA-20), last 5 days, Jharkhand bounding box
    osm         Geofabrik eastern-zone extract -> mines, industry, power plants, works, major roads, Dhanbad area
    osm_state   the same for all of Jharkhand (features inside the state outline; roads trunk to secondary)
    osm_base    statewide base layers: railways, rivers and water bodies, forest and protected areas,
                towns and villages, built-up areas, schools and hospitals, peaks, waterfalls and dams,
                stations and airports, power lines and substations, brick kilns (clipped to the state)
    landcover   ESA WorldCover 2021 (10 m, read at 1/8 = about 75 m from the public AWS COGs), cut to the
                state, as a Web Mercator PNG overlay + per-district class shares (landcover_districts.json)
    towngrids   3 km grids over the main towns (district HQs and the big industrial towns), cells chosen from
                ESA WorldCover built-up land near each town; clearly a grid, not wards
    pack        web pack: state layers plus the Dhanbad-area features just across the West Bengal border
                -> web/public/city-packs/jharkhand/
    curate      keeps only power plants and works on the checked list below (runs at the end of osm)

No block layer: geoBoundaries ADM3 has 11 Census-era blocks for Dhanbad (e.g. Jharia-Cum-Jorapokhar-Cum-
Sindri) where the district now has 10 (dhanbad.nic.in), and no official block boundaries are published
for download. Add blocks only from an official source (Survey of India, JSAC).

Keys (DATA_GOV_API_KEY, OPENAQ_API_KEY, FIRMS_MAP_KEY) come from ingest/.env and are never written out.
Downloads go to ingest/data/ (gitignored); only the processed layers are committed.
"""

from __future__ import annotations

import collections
import csv
import io
import json
import math
import sys
from pathlib import Path

import httpx
from dotenv import dotenv_values
from shapely.affinity import scale
from shapely.geometry import box, mapping, shape, Point
from shapely.ops import unary_union
from shapely.validation import make_valid

REPO = Path(__file__).resolve().parents[3]
OUT = REPO / "data" / "jharkhand" / "processed"
DOWNLOADS = REPO / "ingest" / "data" / "downloads" / "geoboundaries"
PBF = REPO / "ingest" / "data" / "osm" / "eastern-zone-latest.osm.pbf"
RAW = REPO / "ingest" / "data" / "osm"  # uncurated OSM output (gitignored); curate() reads from here
ENV = dotenv_values(REPO / "ingest" / ".env")
UA = {"User-Agent": "vayugati-mapping/1.0"}

CELL_KM = 3.0  # 265 cells over Dhanbad district: about Delhi's 265 wards, so the ward pipeline can carry it
JH_DISTRICTS = {
    "Bokaro", "Chatra", "Deoghar", "Dhanbad", "Dumka", "Garhwa", "Giridih", "Godda", "Gumla", "Hazaribagh",
    "Jamtara", "Khunti", "Kodarma", "Latehar", "Lohardaga", "Pakur", "Palamu", "Pashchimi Singhbhum",
    "Purbi Singhbhum", "Ramgarh", "Ranchi", "Sahibganj", "Saraikela-Kharsawan", "Simdega",
}
JH_BOX = box(83.2, 21.8, 88.0, 25.5)
FIRE_BBOX = "83.3,21.9,87.95,25.35"
DHANBAD_BBOX = (86.05, 23.55, 86.85, 24.15)  # W, S, E, N for the OSM extract

# Manual NAMP stations by district (CPCB list as on 19.11.2024): Dhanbad 3 + Jharia 1 + Sindri 1 = 5,
# Jamshedpur 2, Ranchi 1, Saraikela 1, Barajamda (West Singhbhum) 1.
MANUAL_NAMP = {"Dhanbad": 5, "Purbi Singhbhum": 2, "Ranchi": 1, "Saraikela-Kharsawan": 1, "Pashchimi Singhbhum": 1}
# Planned continuous stations, JSPCB tender JSPCB/CAAQMS/2025-26 (6 Dec 2025). Parasnath Hills -> Giridih,
# Netarhat and Betla National Park -> Latehar, Patratu Valley -> Ramgarh.
PLANNED_CAAQMS = {"Ranchi": 1, "Dumka": 1, "Sahibganj": 1, "Pakur": 1, "Kodarma": 1, "Giridih": 2, "Hazaribagh": 1,
                  "Saraikela-Kharsawan": 1, "Pashchimi Singhbhum": 1, "Palamu": 1, "Garhwa": 1, "Latehar": 2,
                  "Ramgarh": 1}
KEEP_CITIES = {"Dhanbad", "Jorapokhar", "Asansol", "Durgapur"}


def _round(o):
    if isinstance(o, float):
        return round(o, 5)
    if isinstance(o, (list, tuple)):
        return [_round(x) for x in o]
    if isinstance(o, dict):
        return {k: _round(v) for k, v in o.items()}
    return o


def _save(name: str, obj, compact: bool = True) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / name, "w") as f:
        json.dump(_round(obj), f, separators=(",", ":") if compact else None, indent=None if compact else 1,
                  ensure_ascii=False)


def _fc(features):
    return {"type": "FeatureCollection", "features": features}


def _feat(geom, **props):
    return {"type": "Feature", "properties": props, "geometry": mapping(geom)}


def _area_km2(g, lat0: float = 23.6) -> float:
    return scale(g, xfact=111.32 * math.cos(math.radians(lat0)), yfact=110.57, origin=(0, 0)).area


def _geoboundaries(level: str) -> dict:
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    path = DOWNLOADS / f"IND_{level}.geojson"
    if not path.exists():
        meta = httpx.get(f"https://www.geoboundaries.org/api/current/gbOpen/IND/{level}/", timeout=60).json()
        with httpx.stream("GET", meta["gjDownloadURL"], follow_redirects=True, timeout=600) as r:
            r.raise_for_status()
            with open(path, "wb") as f:
                for chunk in r.iter_bytes():
                    f.write(chunk)
    return json.load(open(path))


DATAMEET = REPO / "ingest" / "data" / "datameet_districts"
DATAMEET_URL = "https://raw.githubusercontent.com/datameet/maps/master/Districts/Census_2011/2011_Dist.{ext}"
DISTRICT_ALIAS = {"Saraikela-kharsawan": "Saraikela-Kharsawan"}
DISTRICT_SIMPLIFY = 0.0006  # degrees, about 65 m, applied to the whole coverage so shared borders stay shared


def _datameet_districts(simplify: bool = True) -> dict:
    """Jharkhand's 24 districts from Datameet's India district map (CC BY 2.5 India), compiled from Bhuvan taluk
    boundaries with names and extent from the Census of India 2011 Administrative Atlas. Measured 5 Nov 2026
    against Survey of India areas (ISFR 2023): mean error 1.7%, against 5.2% for geoBoundaries ADM2, which had
    Kodarma -29%, Lohardaga +23%, Hazaribagh +16%. No overlaps between districts; tiny gaps are filled here."""
    import shapely
    sys.path.insert(0, str(Path(__file__).parent))
    import shp_read
    from shapely.geometry import Polygon

    DATAMEET.mkdir(parents=True, exist_ok=True)
    for ext in ("shp", "shx", "dbf"):
        if not (DATAMEET / f"2011_Dist.{ext}").exists():
            r = httpx.get(DATAMEET_URL.format(ext=ext), follow_redirects=True, timeout=300)
            r.raise_for_status()
            (DATAMEET / f"2011_Dist.{ext}").write_bytes(r.content)
    rows = shp_read.read_dbf(str(DATAMEET / "2011_Dist.dbf"))
    geoms = shp_read.read_shp(str(DATAMEET / "2011_Dist.shp"))
    out = {}
    for row, g in zip(rows, geoms):
        if row["ST_NM"].lower() != "jharkhand" or g is None:
            continue
        rings = sorted((Polygon(r) for r in g), key=lambda p: -p.area)
        parts: list = []
        for ring in rings:  # shapefile rings: outer rings, and holes inside them
            for i, q in enumerate(parts):
                if q.contains(ring):
                    parts[i] = q.difference(ring)
                    break
            else:
                parts.append(ring)
        name = DISTRICT_ALIAS.get(row["DISTRICT"], row["DISTRICT"])
        out[name] = make_valid(unary_union(parts))
    assert set(out) == JH_DISTRICTS, sorted(set(out) ^ JH_DISTRICTS)
    # fill the tiny gaps between districts: each goes to the neighbour it shares the longest border with
    union = unary_union(list(out.values()))
    holes = [Polygon(r) for p in (union.geoms if union.geom_type == "MultiPolygon" else [union]) for r in p.interiors]
    for h in holes:
        best = max(out, key=lambda n: out[n].boundary.intersection(h.boundary.buffer(1e-6)).length)
        out[best] = make_valid(unary_union([out[best], h]))
    if not simplify:
        return out
    names = list(out)
    simp = shapely.coverage_simplify([out[n] for n in names], DISTRICT_SIMPLIFY)
    return {n: make_valid(g) for n, g in zip(names, simp)}


def _osm_districts() -> dict:
    """OSM admin_level 5 districts, extracted from the Geofabrik pbf (OSM data as of 3 Nov 2026) and kept in
    data/jharkhand/sources/ (re-extract with the scan described in that folder's README)."""
    name_map = {"East Singhbhum": "Purbi Singhbhum", "West Singhbhum": "Pashchimi Singhbhum",
                "Seraikela-Kharsawan": "Saraikela-Kharsawan"}
    out = {}
    for f in json.load(open(REPO / "data" / "jharkhand" / "sources" / "osm_districts_admin5_2026-11-03.geojson"))["features"]:
        if f["properties"]["admin_level"] == "5":
            out[name_map.get(f["properties"]["name"], f["properties"]["name"])] = make_valid(shape(f["geometry"]))
    return out


def _soi_areas() -> dict:
    return {r["district"]: float(r["area_km2_soi"])
            for r in csv.DictReader(open(REPO / "data" / "jharkhand" / "sources" / "isfr2023_district_forest.csv"))}


# Towns whose district is certain (district HQs and well-known block HQs). They are a second check on the
# borders, because an area can match while a border sits in the wrong place (Datameet puts Mandu, a Ramgarh
# block, in Hazaribagh). Each wrongly placed town costs TOWN_PENALTY points of mean area error.
TEST_TOWNS = {
    "Ranchi": "Ranchi", "Jamshedpur": "Purbi Singhbhum", "Dhanbad": "Dhanbad", "Bokaro": "Bokaro", "Chas": "Bokaro",
    "Deoghar": "Deoghar", "Madhupur": "Deoghar", "Hazaribagh": "Hazaribagh", "Barhi": "Hazaribagh",
    "Barkagaon": "Hazaribagh", "Ichak": "Hazaribagh", "Giridih": "Giridih", "Bagodar": "Giridih",
    "Dhanwar": "Giridih", "Ramgarh": "Ramgarh", "Patratu": "Ramgarh", "Mandu": "Ramgarh", "Gola": "Ramgarh",
    "Chitarpur": "Ramgarh", "Medininagar": "Palamu", "Daltonganj": "Palamu", "Chaibasa": "Pashchimi Singhbhum",
    "Dumka": "Dumka", "Godda": "Godda", "Sahibganj": "Sahibganj", "Pakur": "Pakur", "Gumla": "Gumla",
    "Lohardaga": "Lohardaga", "Kuru": "Lohardaga", "Khunti": "Khunti", "Torpa": "Khunti", "Latehar": "Latehar",
    "Netarhat": "Latehar", "Chatra": "Chatra", "Simaria": "Chatra", "Kodarma": "Kodarma", "Jhumri Tilaiya": "Kodarma",
    "Jamtara": "Jamtara", "Mihijam": "Jamtara", "Simdega": "Simdega", "Garhwa": "Garhwa", "Saraikela": "Saraikela-Kharsawan",
    "Adityapur": "Saraikela-Kharsawan", "Bero": "Ranchi",
}
TOWN_PENALTY = 0.5


def _test_points() -> list[tuple[str, str, "Point"]]:
    places: dict[str, list] = {}
    for f in json.load(open(OUT / "state_places.geojson"))["features"]:
        places.setdefault(f["properties"]["name"], []).append(tuple(f["geometry"]["coordinates"]))
    pts = []
    for town, district in TEST_TOWNS.items():
        if town in places:
            pts.append((town, district, places[town]))
    return pts


def _fused_districts() -> tuple[dict, dict]:
    """Best open district borders, by checking against Survey of India's areas (ISFR 2023).

    Three open sources (Datameet / Census 2011, OpenStreetMap, geoBoundaries) each draw the 24 districts
    slightly differently. Start from Datameet; for each district try the other sources' version and keep it if
    the mean area error over all 24 improves. Where a version is taken, it keeps its land and neighbours give
    way; leftover gaps go to the neighbour sharing the longest border. Measured 6 Nov 2026: mean error 0.8%
    (Datameet alone 1.7%, OSM 3.5%, geoBoundaries 5.2%), largest 4.1%. The area is the only check: a district
    can match in area and still have a wrong shape, so this is "closer to", not "equal to", Survey of India."""
    soi = _soi_areas()
    names = sorted(soi)
    dm = _datameet_districts(simplify=False)
    gb = {n: g for n, g in _districts_geoboundaries().items()}
    sources = {"DM": dm, "OSM": _osm_districts(), "GB": gb}
    state = unary_union(list(dm.values()))
    state = shapely_fill_holes(state)

    tests = _test_points()

    def misplaced(out) -> list[str]:
        bad = []
        for town, district, cands in tests:
            # the place of that name nearest the true district (a name can occur in several districts)
            pt = Point(min(cands, key=lambda c: out[district].distance(Point(c))))
            if not out[district].contains(pt):
                bad.append(town)
        return bad

    def err(out):
        e = [abs(100 * (_area_km2(out[n]) - soi[n]) / soi[n]) for n in names]
        return sum(e) / len(e) + TOWN_PENALTY * len(misplaced(out))

    def build(assign):
        g = {n: sources[assign[n]][n].intersection(state) for n in names}
        out, taken = {}, None
        for n in sorted(names, key=lambda n: (assign[n] == "DM", n)):  # non-Datameet versions keep their land
            geo = g[n] if taken is None else g[n].difference(taken)
            out[n] = geo
            taken = geo if taken is None else unary_union([taken, geo])
        gap = state.difference(unary_union(list(out.values())))
        for piece in (gap.geoms if hasattr(gap, "geoms") else [gap]):
            if piece.is_empty or piece.area <= 0:
                continue
            best = max(names, key=lambda n: out[n].boundary.intersection(piece.buffer(1e-5)).length)
            out[best] = unary_union([out[best], piece])
        return out

    assign = {n: "DM" for n in names}
    best = err(build(assign))
    improved = True
    while improved:
        improved = False
        for n in names:
            for src in ("DM", "OSM", "GB"):
                if src == assign[n] or n not in sources[src]:
                    continue
                trial = {**assign, n: src}
                e = err(build(trial))
                if e < best - 0.01:
                    assign, best, improved = trial, e, True
    out = build(assign)
    print("known towns in the wrong district:", misplaced(out) or "none",
          f"(of {len(tests)} checked); mean area error {err(out) - TOWN_PENALTY * len(misplaced(out)):.2f}%")
    return out, assign


def _districts() -> dict:
    import shapely

    fused, assign = _fused_districts()
    print("district sources:", {n: s for n, s in assign.items() if s != "DM"}, "(others: Datameet)")
    # snap seams to a 1e-6 degree grid (about 0.1 m), drop crumbs, then simplify as one coverage
    names = list(fused)
    snapped = []
    for n in names:
        g = shapely.set_precision(fused[n], 1e-6)
        parts = [p for p in (g.geoms if g.geom_type == "MultiPolygon" else [g]) if _area_km2(p) >= 0.05]
        snapped.append(make_valid(unary_union(parts)))
    simp = shapely.coverage_simplify(snapped, DISTRICT_SIMPLIFY)
    return {n: make_valid(g) for n, g in zip(names, simp)}


def _districts_geoboundaries() -> dict:
    out = {}
    for f in _geoboundaries("ADM2")["features"]:
        name = f["properties"]["shapeName"]
        g = make_valid(shape(f["geometry"]))
        if name in JH_DISTRICTS and JH_BOX.contains(g.representative_point()):
            out[name] = g
    assert len(out) == 24, sorted(out)
    return out


def shapely_fill_holes(g):
    from shapely.geometry import Polygon, MultiPolygon
    parts = g.geoms if g.geom_type == "MultiPolygon" else [g]
    filled = [Polygon(p.exterior) for p in parts]
    return filled[0] if len(filled) == 1 else MultiPolygon(filled)


def boundaries() -> None:
    """State and district outlines (Datameet / Census 2011), with the public-monitor counts per district.
    The Dhanbad 3 km grid is NOT regenerated: its 265 cells are imported into the database as wards, and a new
    district outline would change them. It is only built if the file is missing."""
    dist = _districts()
    old = {}
    if (OUT / "districts.geojson").exists():
        old = {f["properties"]["name"]: f["properties"] for f in json.load(open(OUT / "districts.geojson"))["features"]}
    counts = collections.Counter()
    if (OUT / "stations.geojson").exists():
        for f in json.load(open(OUT / "stations.geojson"))["features"]:
            p = Point(f["geometry"]["coordinates"])
            for n, g in dist.items():
                if g.contains(p):
                    counts[n] += 1
    feats = []
    for n, g in sorted(dist.items()):
        feats.append(_feat(g, name=n, area_km2=round(_area_km2(g)), continuous_in_feed=counts.get(n, 0),
                           manual_namp=MANUAL_NAMP.get(n, 0), planned_caaqms=PLANNED_CAAQMS.get(n, 0)))
    _save("districts.geojson", _fc(feats))
    state = unary_union(list(dist.values()))
    state = shapely_fill_holes(state)
    _save("state.geojson", _fc([_feat(state, name="Jharkhand")]))
    print(f"boundaries: {len(feats)} districts (Datameet / Census 2011), state {round(_area_km2(state))} km2")
    grid = OUT / f"dhanbad_grid_{int(CELL_KM)}km.geojson"
    if grid.exists():
        return
    dh = dist["Dhanbad"]
    minx, miny, maxx, maxy = dh.bounds
    dlat = CELL_KM / 110.57
    dlng = CELL_KM / (111.32 * math.cos(math.radians((miny + maxy) / 2)))
    cells, row, y = [], 0, miny
    while y < maxy:
        col, x = 0, minx
        while x < maxx:
            c = box(x, y, x + dlng, y + dlat).intersection(dh)
            if not c.is_empty and _area_km2(c) >= 0.5:
                pt = c.representative_point()
                cells.append(_feat(c, id=f"DH-{row:02d}-{col:02d}", lat=round(pt.y, 5), lng=round(pt.x, 5),
                                   area_km2=round(_area_km2(c), 2)))
            x += dlng
            col += 1
        y += dlat
        row += 1
    _save(grid.name, _fc(cells))
    print(f"{len(cells)} Dhanbad grid cells")


def _cpcb(state: str) -> list[dict]:
    rows, off, total = [], 0, None
    while total is None or off < total:
        r = httpx.get("https://api.data.gov.in/resource/3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69", headers=UA,
                      params={"api-key": ENV["DATA_GOV_API_KEY"], "format": "json", "limit": 100, "offset": off,
                              "filters[state]": state}, timeout=60)
        r.raise_for_status()
        d = r.json()
        total = int(d.get("total", 0))
        if not d.get("records"):
            break
        rows += d["records"]
        off += 100
    return rows


def stations() -> None:
    by_station: dict[str, dict] = {}
    for state in ("Jharkhand", "West Bengal"):
        for x in _cpcb(state):
            if x.get("city") not in KEEP_CITIES:
                continue
            s = by_station.setdefault(x["station"], {"x": x, "pollutants": set()})
            s["pollutants"].add(x.get("pollutant_id"))
    r = httpx.get("https://api.openaq.org/v3/locations", params={"bbox": FIRE_BBOX, "limit": 1000},
                  headers={"X-API-Key": ENV["OPENAQ_API_KEY"]}, timeout=60)
    r.raise_for_status()
    openaq = []
    for x in r.json().get("results", []):
        c = x.get("coordinates") or {}
        openaq.append({"id": x["id"], "name": x["name"], "provider": (x.get("provider") or {}).get("name"),
                       "is_monitor": x.get("isMonitor"), "lat": c.get("latitude"), "lng": c.get("longitude"),
                       "last": (x.get("datetimeLast") or {}).get("utc"),
                       "sensors": sorted({s["parameter"]["name"] for s in x.get("sensors", [])})})
    _save("openaq_locations.json", openaq, compact=False)
    oq_by_lat = {round(o["lat"], 4): o for o in openaq if o["lat"]}
    feats, seen = [], set()
    for name, s in by_station.items():
        x = s["x"]
        lat, lng = float(x["latitude"]), float(x["longitude"])
        o = oq_by_lat.get(round(lat, 4))
        seen.add(round(lat, 4))
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lng, lat]}, "properties": {
            "name": name, "city": x["city"], "state": x["state"], "type": "continuous",
            "role": "jharkhand" if x["state"] == "Jharkhand" else "reference_candidate",
            "pollutants": sorted(p for p in s["pollutants"] if p), "openaq_id": o["id"] if o else None,
            "source": "CPCB data.gov.in real-time feed"}})
    # Stations OpenAQ carries in the same cities that today's CPCB feed did not list.
    for o in openaq:
        city = next((c for c in KEEP_CITIES if c.lower() in o["name"].lower()), None)
        if city and o["lat"] and round(o["lat"], 4) not in seen and (o["last"] or "") >= "2026":
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [o["lng"], o["lat"]]},
                          "properties": {"name": o["name"], "city": city,
                                         "state": "Jharkhand" if "JSPCB" in o["name"] else "West Bengal",
                                         "type": "continuous",
                                         "role": "jharkhand" if "JSPCB" in o["name"] else "reference_candidate",
                                         "pollutants": o["sensors"], "openaq_id": o["id"], "source": "OpenAQ"}})
    _save("stations.geojson", _fc(feats), compact=False)
    d = json.load(open(OUT / "districts.geojson"))
    continuous = collections.Counter()
    dist_geoms = {f["properties"]["name"]: shape(f["geometry"]) for f in d["features"]}
    for f in feats:
        p = Point(f["geometry"]["coordinates"])
        for n, g in dist_geoms.items():
            if g.contains(p):
                continuous[n] += 1
    for f in d["features"]:
        n = f["properties"]["name"]
        f["properties"].update({"continuous_in_feed": continuous.get(n, 0), "manual_namp": MANUAL_NAMP.get(n, 0),
                                "planned_caaqms": PLANNED_CAAQMS.get(n, 0)})
    _save("districts.geojson", d)
    print(f"stations: {len(feats)} continuous ({sum(1 for f in feats if f['properties']['role'] == 'jharkhand')} "
          f"in Jharkhand); manual {sum(MANUAL_NAMP.values())}, planned {sum(PLANNED_CAAQMS.values())}")


def fires() -> None:
    feats = []
    for src in ("VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT"):
        # The FIRMS area API accepts at most 5 days per request.
        r = httpx.get(f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{ENV['FIRMS_MAP_KEY']}/{src}/{FIRE_BBOX}/5",
                      timeout=60)
        r.raise_for_status()
        for row in csv.DictReader(io.StringIO(r.text)):
            feats.append({"type": "Feature",
                          "geometry": {"type": "Point", "coordinates": [float(row["longitude"]), float(row["latitude"])]},
                          "properties": {"source": src, "date": row["acq_date"], "time": row["acq_time"],
                                         "confidence": row["confidence"], "frp": float(row["frp"] or 0),
                                         "daynight": row["daynight"]}})
    _save("fires_firms_5d.geojson", _fc(feats))
    print(f"fires: {len(feats)} detections in the Jharkhand box, last 5 days")


def osm() -> None:
    _osm(DHANBAD_BBOX, "sources_osm.geojson", "roads_major.geojson", clip=None)
    curate("sources_osm.geojson")


def osm_state() -> None:
    state = make_valid(shape(json.load(open(OUT / "state.geojson"))["features"][0]["geometry"]))
    _osm(state.bounds, "state_sources_osm.geojson", "state_roads.geojson", clip=state, simplify=0.0003)
    curate("state_sources_osm.geojson")


def _osm(bbox, sources_name: str, roads_name: str, clip=None, simplify: float = 0.0) -> None:
    import osmium
    from osmium.geom import GeoJSONFactory

    if not PBF.exists():
        sys.exit(f"missing {PBF}: download https://download.geofabrik.de/asia/india/eastern-zone-latest.osm.pbf")
    w, s, e, n = bbox
    fab = GeoJSONFactory()

    def inside(lon, lat):
        return w <= lon <= e and s <= lat <= n

    def kind(t):
        if t.get("power") == "plant":
            return "power_plant"
        if (t.get("landuse") == "quarry" or t.get("industrial") in ("mine", "mining", "coal_mine")
                or t.get("man_made") in ("mineshaft", "adit") or t.get("resource") == "coal"):
            return "mine"
        if t.get("man_made") == "works":
            return "works"
        if t.get("landuse") == "industrial" or "industrial" in t:
            return "industrial"
        return None

    roads_kept = {"motorway", "trunk", "primary", "secondary"}

    class Handler(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.areas, self.points, self.roads = [], [], []

        def node(self, nd):
            t = dict(nd.tags)
            k = kind(t)
            if k and nd.location.valid() and inside(nd.location.lon, nd.location.lat):
                self.points.append({"type": "Feature", "geometry": json.loads(fab.create_point(nd)),
                                    "properties": {"kind": k, "name": t.get("name", ""),
                                                   "operator": t.get("operator", "")}})

        def way(self, wy):
            t = dict(wy.tags)
            if t.get("highway") in roads_kept:
                try:
                    if any(inside(x.lon, x.lat) for x in wy.nodes if x.location.valid()):
                        self.roads.append({"type": "Feature", "geometry": json.loads(fab.create_linestring(wy)),
                                           "properties": {"highway": t["highway"], "ref": t.get("ref", ""),
                                                          "name": t.get("name", "")}})
                except Exception:  # noqa: BLE001 - incomplete ways at the extract edge
                    pass

        def area(self, a):
            t = dict(a.tags)
            k = kind(t)
            if not k:
                return
            try:
                g = json.loads(fab.create_multipolygon(a))
            except Exception:  # noqa: BLE001 - broken multipolygons are skipped
                return
            lon, lat = g["coordinates"][0][0][0]
            if inside(lon, lat):
                self.areas.append({"type": "Feature", "geometry": g,
                                   "properties": {"kind": k, "name": t.get("name", ""),
                                                  "operator": t.get("operator", ""), "osm_id": a.orig_id()}})

    h = Handler()
    h.apply_file(str(PBF), locations=True)
    sources, roads = h.areas + h.points, h.roads
    if clip is not None:
        from shapely.prepared import prep
        inside_state = prep(clip)

        def keep(f):
            try:
                g = make_valid(shape(f["geometry"]))
            except Exception:  # noqa: BLE001
                return None
            if g.is_empty or not inside_state.intersects(g.representative_point()):
                return None
            if simplify and g.geom_type != "Point":
                g = g.simplify(simplify, preserve_topology=True)
                if g.is_empty:
                    return None
            f["geometry"] = mapping(g)
            return f

        sources = [f for f in map(keep, sources) if f]
        roads = [f for f in map(keep, roads) if f]
    with open(RAW / sources_name, "w") as fh:
        json.dump(_fc(sources), fh)
    _save(roads_name, _fc(roads))
    print(f"{sources_name}:", dict(collections.Counter(f["properties"]["kind"] for f in sources)),
          f"{roads_name}", len(roads))


# Power plants and large works kept on the map, keyed by their OpenStreetMap name, with the name and
# operator as published by the operator. Anything not on this list (unnamed features, small workshops,
# plants whose identity or status could not be confirmed) is dropped. Checked 5 Nov 2026.
CHECKED_SITES = {
    "Chandrapura Thermal Power Station": ("Chandrapura Thermal Power Station", "Damodar Valley Corporation (DVC)"),
    "Maithon Power Plant": ("Maithon Right Bank Thermal Power Station",
                            "Maithon Power Ltd, a Tata Power (74%) and DVC (26%) joint venture"),
    "Santhaldih": ("Santaldih Thermal Power Station", "West Bengal Power Development Corporation (WBPDCL)"),
    "Raghunathpur Thermal Power Station": ("Raghunathpur Thermal Power Station", "Damodar Valley Corporation (DVC)"),
    "Panchet hydroelectric power station": ("Panchet hydroelectric station", "Damodar Valley Corporation (DVC)"),
    "Maithon hydroelectric power station": ("Maithon hydroelectric station", "Damodar Valley Corporation (DVC)"),
    "HINDUSTAN URVARAK & RASAYAN LIMITED SINDRI (HURL)": ("HURL Sindri fertiliser plant",
                                                         "Hindustan Urvarak & Rasayan Ltd (HURL)"),
    "ACC": ("ACC Sindri cement grinding unit", "ACC Ltd (Adani Group)"),
    # Statewide (Jharkhand). Not added: Mahadev Prasad STPP (current owner unconfirmed), a second
    # "Jojobera Tata Unit 6" feature (same plant), dams, solar mini-grids, unnamed or small sites.
    "Bokaro Thermal Power Station": ("Bokaro Thermal Power Station", "Damodar Valley Corporation (DVC)"),
    "Koderma Thermal Power Station": ("Koderma Thermal Power Station", "Damodar Valley Corporation (DVC)"),
    "Tenughat Thermal Power Plant": ("Tenughat Thermal Power Station",
                                     "Tenughat Vidyut Nigam Ltd (TVNL), Government of Jharkhand"),
    "North Karanpura Thermal Power Station": ("North Karanpura Super Thermal Power Project", "NTPC Ltd"),
    "Jojobera power plant": ("Jojobera Power Plant", "Tata Power"),
    "Godda Thermal Power Station": ("Godda Ultra Supercritical Thermal Power Plant", "Adani Power (Adani Group)"),
}


def curate(name: str = "sources_osm.geojson") -> None:
    fc = json.load(open(RAW / name if (RAW / name).exists() else OUT / name))
    kept, dropped = [], []
    for f in fc["features"]:
        p = f["properties"]
        if p["kind"] in ("power_plant", "works"):
            checked = CHECKED_SITES.get(p.get("name", "")) or next(  # already curated: re-running is safe
                (v for v in CHECKED_SITES.values() if p.get("checked") and v[0] == p.get("name")), None)
            if not checked:
                dropped.append(p.get("name") or f"unnamed {p['kind']}")
                continue
            p["name"], p["operator"] = checked
            p["checked"] = True
            if f["geometry"]["type"] != "Point":  # one dot per site, not one per outline vertex
                f["geometry"] = mapping(make_valid(shape(f["geometry"])).representative_point())
        kept.append(f)
    _save(name, _fc(kept))
    print(f"curate {name}: dropped", len(dropped), dropped)


def osm_base() -> None:
    """Statewide base layers from the same OSM extract. Small features are dropped to keep the web pack light."""
    import osmium
    from osmium.geom import GeoJSONFactory
    from shapely.prepared import prep

    state = make_valid(shape(json.load(open(OUT / "state.geojson"))["features"][0]["geometry"]))
    inside_state = prep(state)
    w, s, e, n = state.bounds
    fab = GeoJSONFactory()

    def in_box(lon, lat):
        return w <= lon <= e and s <= lat <= n

    class H(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.f = collections.defaultdict(list)

        def node(self, nd):
            t = dict(nd.tags)
            if not nd.location.valid() or not in_box(nd.location.lon, nd.location.lat):
                return
            place = t.get("place")
            amen = t.get("amenity")
            pt = Point(nd.location.lon, nd.location.lat)
            if place in ("city", "town", "village") and t.get("name"):
                self.f["places"].append(_feat(pt, kind=place, name=t["name"]))
            elif amen in ("school", "college", "university", "hospital", "clinic"):
                self.f["facilities"].append(_feat(pt, kind=amen, name=t.get("name", "")))
            elif t.get("natural") == "peak":
                self.f["landmarks"].append(_feat(pt, kind="peak", name=t.get("name", ""), ele=t.get("ele", "")))
            elif t.get("waterway") in ("waterfall", "dam") or t.get("natural") == "waterfall":
                self.f["landmarks"].append(_feat(pt, kind="waterfall" if "fall" in (t.get("waterway", "") + t.get("natural", "")) else "dam",
                                                 name=t.get("name", "")))
            elif t.get("railway") in ("station", "halt"):
                self.f["transport"].append(_feat(pt, kind="rail_station", name=t.get("name", "")))
            elif t.get("aeroway") in ("aerodrome", "airport"):
                self.f["transport"].append(_feat(pt, kind="airport", name=t.get("name", "")))
            elif t.get("power") == "substation":
                self.f["power"].append(_feat(pt, kind="substation", name=t.get("name", "")))
            elif t.get("industrial") == "brickworks" or t.get("man_made") == "kiln" or t.get("craft") == "brick_maker":
                self.f["kilns"].append(_feat(pt, kind="brick_kiln", name=t.get("name", "")))

        def way(self, wy):
            t = dict(wy.tags)
            rail = t.get("railway")
            ww = t.get("waterway")
            if t.get("power") == "line":
                try:
                    g = json.loads(fab.create_linestring(wy))
                except Exception:  # noqa: BLE001
                    return
                if in_box(*g["coordinates"][0]):
                    self.f["power"].append({"type": "Feature", "geometry": g, "properties": {
                        "kind": "line", "name": t.get("name", ""), "voltage": t.get("voltage", "")}})
                return
            if rail in ("rail", "narrow_gauge") or ww in ("river", "canal"):
                try:
                    g = json.loads(fab.create_linestring(wy))
                except Exception:  # noqa: BLE001
                    return
                lon, lat = g["coordinates"][0]
                if not in_box(lon, lat):
                    return
                if rail:
                    kind = "siding" if t.get("service") in ("siding", "spur", "yard") else "main"
                    self.f["railways"].append({"type": "Feature", "geometry": g, "properties": {
                        "kind": kind, "name": t.get("name", ""), "usage": t.get("usage", "")}})
                else:
                    self.f["rivers"].append({"type": "Feature", "geometry": g, "properties": {
                        "kind": ww, "name": t.get("name", "")}})

        def area(self, a):
            t = dict(a.tags)
            amen = t.get("amenity")
            kind = None
            if t.get("boundary") in ("protected_area", "national_park") or t.get("leisure") == "nature_reserve":
                kind, layer, min_km2 = "protected", "protected", 0.5
            elif t.get("landuse") == "forest" or t.get("natural") == "wood":
                kind, layer, min_km2 = "forest", "forest", 0.5
            elif t.get("natural") == "water" or t.get("landuse") == "reservoir":
                kind, layer, min_km2 = "water", "water", 0.05
            elif amen in ("school", "college", "university", "hospital", "clinic"):
                kind, layer, min_km2 = amen, "facilities", 0
            elif t.get("aeroway") == "aerodrome":
                kind, layer, min_km2 = "airport", "transport", 0
            elif t.get("power") in ("substation", "plant") and t.get("power") == "substation":
                kind, layer, min_km2 = "substation", "power", 0
            elif t.get("industrial") == "brickworks" or t.get("man_made") == "kiln":
                kind, layer, min_km2 = "brick_kiln", "kilns", 0
            elif t.get("landuse") == "residential":
                kind, layer, min_km2 = "built_up", "builtup", 0.05
            if not kind:
                return
            try:
                g = make_valid(shape(json.loads(fab.create_multipolygon(a))))
            except Exception:  # noqa: BLE001
                return
            if g.is_empty or not in_box(*g.representative_point().coords[0]):
                return
            if layer in ("facilities", "transport", "power", "kilns"):  # one point per site
                self.f[layer].append(_feat(g.representative_point(), kind=kind, name=t.get("name", "")))
                return
            if _area_km2(g) < min_km2:
                return
            self.f[layer].append(_feat(g.simplify(0.0005, preserve_topology=True), kind=kind,
                                       name=t.get("name", ""), protect_class=t.get("protect_class", "")))

    h = H()
    h.apply_file(str(PBF), locations=True)
    for layer, feats in h.f.items():
        kept = []
        for f in feats:
            g = make_valid(shape(f["geometry"]))
            if g.is_empty or not inside_state.intersects(g.representative_point()):
                continue
            if g.geom_type in ("LineString", "MultiLineString"):
                g = g.simplify(0.0003, preserve_topology=True)
            f["geometry"] = mapping(g)
            kept.append(f)
        _save(f"state_{layer}.geojson", _fc(kept))
        print(f"osm_base {layer}: {len(kept)}", dict(collections.Counter(f["properties"]["kind"] for f in kept)))


WORLDCOVER = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{t}_Map.tif"
WORLDCOVER_CLASSES = {  # value: (label, colour) as in the ESA WorldCover product user manual
    10: ("Tree cover", "#006400"), 20: ("Shrubland", "#FFBB22"), 30: ("Grassland", "#FFFF4C"),
    40: ("Cropland", "#F096FF"), 50: ("Built-up", "#FA0000"), 60: ("Bare / sparse vegetation", "#B4B4B4"),
    70: ("Snow and ice", "#F0F0F0"), 80: ("Permanent water", "#0064C8"), 90: ("Herbaceous wetland", "#0096A0"),
    95: ("Mangroves", "#00CF75"), 100: ("Moss and lichen", "#FAE6A0"),
}


def landcover() -> None:
    import numpy as np
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.features import geometry_mask
    from rasterio.transform import from_bounds
    from rasterio.warp import reproject, transform_bounds

    state = make_valid(shape(json.load(open(OUT / "state.geojson"))["features"][0]["geometry"]))
    w, s, e, n = state.bounds
    step = 1 / 600  # 0.00167 deg, about 180 m; ESA tiles are read at 1/8 (about 75 m) and mode-resampled
    W, H = math.ceil((e - w) / step), math.ceil((n - s) / step)
    geo_tf = from_bounds(w, s, e, n, W, H)
    mosaic = np.zeros((H, W), dtype=np.uint8)
    for lat in (21, 24):
        for lon in (81, 84, 87):
            t = f"N{lat:02d}E{lon:03d}"
            with rasterio.open(WORLDCOVER.format(t=t)) as src:
                dst = np.zeros((H, W), dtype=np.uint8)
                reproject(rasterio.band(src, 1), dst, dst_transform=geo_tf, dst_crs="EPSG:4326",
                          resampling=Resampling.mode, src_nodata=0, dst_nodata=0)
                mosaic = np.where(dst > 0, dst, mosaic)
            print("landcover tile", t)
    # per-district class shares, on the geographic grid
    districts = json.load(open(OUT / "districts.geojson"))["features"]
    shares = {}
    for d in districts:
        m = ~geometry_mask([d["geometry"]], (H, W), geo_tf)
        v = mosaic[m & (mosaic > 0)]
        tot = v.size or 1
        shares[d["properties"]["name"]] = {WORLDCOVER_CLASSES[c][0]: round(float((v == c).sum()) * 100 / tot, 1)
                                           for c in WORLDCOVER_CLASSES if (v == c).any()}
    with open(OUT / "landcover_districts.json", "w") as fh:
        json.dump({"source": "ESA WorldCover 10 m 2021 v200 (European Space Agency); class shares computed by "
                             "Vayu Gati at about 180 m over geoBoundaries district outlines", "districts": shares},
                  fh, indent=1)
    # Web Mercator overlay, transparent outside the state
    mw, ms, me, mn = transform_bounds("EPSG:4326", "EPSG:3857", w, s, e, n)
    MW, MH = math.ceil((me - mw) / 150), math.ceil((mn - ms) / 150)
    merc_tf = from_bounds(mw, ms, me, mn, MW, MH)
    merc = np.zeros((MH, MW), dtype=np.uint8)
    reproject(mosaic, merc, src_transform=geo_tf, src_crs="EPSG:4326", dst_transform=merc_tf, dst_crs="EPSG:3857",
              resampling=Resampling.nearest, src_nodata=0, dst_nodata=0)
    from shapely.ops import transform as shp_transform

    def to_m(x, y, z=None):  # EPSG:4326 -> EPSG:3857 (spherical Mercator)
        r = 6378137.0
        return (np.radians(x) * r, np.log(np.tan(np.pi / 4 + np.radians(y) / 2)) * r)
    outside = geometry_mask([mapping(shp_transform(to_m, state))], (MH, MW), merc_tf)
    rgba = np.zeros((4, MH, MW), dtype=np.uint8)
    for c, (_, col) in WORLDCOVER_CLASSES.items():
        sel = (merc == c) & ~outside
        for i in range(3):
            rgba[i][sel] = int(col[1 + 2 * i:3 + 2 * i], 16)
        rgba[3][sel] = 255
    web = REPO / "web" / "public" / "city-packs" / "jharkhand"
    web.mkdir(parents=True, exist_ok=True)
    with rasterio.open(web / "landcover_2021.png", "w", driver="PNG", width=MW, height=MH, count=4, dtype="uint8") as dst:
        dst.write(rgba)
    for extra in web.glob("landcover_2021.png.aux.xml"):
        extra.unlink()
    with open(web / "landcover_2021.json", "w") as fh:
        json.dump({"coordinates": [[w, n], [e, n], [e, s], [w, s]],
                   "classes": [{"value": c, "label": l, "color": col} for c, (l, col) in WORLDCOVER_CLASSES.items()
                               if c not in (70, 95, 100)],
                   "source": "ESA WorldCover 10 m 2021 v200, European Space Agency (CC BY 4.0)"}, fh, indent=1)
    print(f"landcover: {MW}x{MH} px overlay; district shares for {len(shares)} districts")


# Towns for the grids: name -> (lng, lat, district). Coordinates come from the OSM places layer, except where marked.
# Dhanbad, Jharia, Sindri and Chirkunda are covered by the Dhanbad district grid.
TOWNS = {
    "Ranchi": (85.325, 23.370, "Ranchi"), "Jamshedpur": (86.203, 22.802, "Purbi Singhbhum"),
    "Adityapur": (86.159, 22.790, "Saraikela-Kharsawan"), "Saraikela": (85.931, 22.700, "Saraikela-Kharsawan"),
    "Bokaro Steel City": (86.146, 23.654, "Bokaro"), "Chas": (86.175, 23.633, "Bokaro"),
    "Phusro": (85.975, 23.760, "Bokaro"), "Ramgarh": (85.522, 23.630, "Ramgarh"),
    "Hazaribagh": (85.362, 23.992, "Hazaribagh"), "Deoghar": (86.699, 24.490, "Deoghar"),
    "Madhupur": (86.639, 24.274, "Deoghar"), "Giridih": (86.309, 24.186, "Giridih"),
    "Medininagar": (84.066, 24.040, "Palamu"), "Chaibasa": (85.802, 22.550, "Pashchimi Singhbhum"),
    "Gua": (85.388, 22.214, "Pashchimi Singhbhum"), "Godda": (87.212, 24.827, "Godda"),
    "Sahibganj": (87.635, 25.244, "Sahibganj"), "Pakur": (87.842, 24.639, "Pakur"),
    "Gumla": (84.542, 23.043, "Gumla"), "Lohardaga": (84.680, 23.433, "Lohardaga"),
    "Khunti": (85.280, 23.077, "Khunti"), "Latehar": (84.500, 23.744, "Latehar"),
    "Chatra": (84.871, 24.206, "Chatra"), "Kodarma": (85.594, 24.468, "Kodarma"),
    "Jamtara": (86.803, 23.963, "Jamtara"), "Mihijam": (86.879, 23.853, "Jamtara"),
    "Simdega": (84.501, 22.612, "Simdega"), "Garhwa": (83.808, 24.160, "Garhwa"),
    "Dumka": (87.250, 24.270, "Dumka"),  # manual: Dumka is not in the OSM places layer
}
TOWN_GRID_KM = 3.0
TOWN_RADIUS_KM = 12.0
BUILTUP_MIN_PCT = 4.0  # a cell is kept if at least this share of it is built-up (ESA WorldCover class 50)


def towngrids() -> None:
    import numpy as np
    import rasterio
    from concurrent.futures import ThreadPoolExecutor
    from rasterio.windows import from_bounds

    state = make_valid(shape(json.load(open(OUT / "state.geojson"))["features"][0]["geometry"]))
    lat0 = 23.6
    dlat = TOWN_GRID_KM / 110.57
    dlng = TOWN_GRID_KM / (111.32 * math.cos(math.radians(lat0)))  # one global grid, so cells never overlap
    w0, s0 = 83.2, 21.8
    cands = {}  # (row, col) -> (town, distance_km)
    for town, (lng, lat, _) in TOWNS.items():
        r0, r1 = int((lat - 0.12 - s0) / dlat), int((lat + 0.12 - s0) / dlat) + 1
        c0, c1 = int((lng - 0.13 - w0) / dlng), int((lng + 0.13 - w0) / dlng) + 1
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                cx, cy = w0 + (c + 0.5) * dlng, s0 + (r + 0.5) * dlat
                d = math.hypot((cx - lng) * 111.32 * math.cos(math.radians(lat)), (cy - lat) * 110.57)
                if d <= TOWN_RADIUS_KM and state.contains(Point(cx, cy)) and d < cands.get((r, c), ("", 1e9))[1]:
                    cands[(r, c)] = (town, d)
    tiles = {}

    def open_tile(lat, lon):
        key = (lat, lon)
        if key not in tiles:
            tiles[key] = rasterio.open(WORLDCOVER.format(t=f"N{lat:02d}E{lon:03d}"))
        return tiles[key]

    def builtup_pct(rc):
        r, c = rc
        w, s, e, n = w0 + c * dlng, s0 + r * dlat, w0 + (c + 1) * dlng, s0 + (r + 1) * dlat
        hit = tot = 0
        for lat in (21, 24):
            for lon in (81, 84, 87):
                if e <= lon or w >= lon + 3 or n <= lat or s >= lat + 3:
                    continue
                src = open_tile(lat, lon)
                win = from_bounds(max(w, lon), max(s, lat), min(e, lon + 3), min(n, lat + 3), src.transform)
                a = src.read(1, window=win, out_shape=(30, 30), resampling=rasterio.enums.Resampling.nearest)
                hit += int((a == 50).sum())
                tot += a.size
        return rc, (100.0 * hit / tot if tot else 0.0)

    # Open tiles up front (rasterio datasets are not thread-safe: one reader pool, sequential reads).
    out = [builtup_pct(rc) for rc in sorted(cands)]
    feats, per_town = [], collections.Counter()
    for (r, c), pct in out:
        town, d = cands[(r, c)]
        if pct < BUILTUP_MIN_PCT and d > TOWN_GRID_KM:  # always keep the cell(s) under the town centre
            continue
        w, s, e, n = w0 + c * dlng, s0 + r * dlat, w0 + (c + 1) * dlng, s0 + (r + 1) * dlat
        g = box(w, s, e, n)
        per_town[town] += 1
        feats.append(_feat(g, id=f"JH-{r:03d}-{c:03d}", town=town, district=TOWNS[town][2],
                           builtup_pct=round(pct, 1), area_km2=round(_area_km2(g), 2)))
    _save("town_grids_3km.geojson", _fc(feats))
    print(f"towngrids: {len(feats)} cells over {len(per_town)} towns:", dict(per_town))


def pack() -> None:
    import shutil

    web = REPO / "web" / "public" / "city-packs" / "jharkhand"
    web.mkdir(parents=True, exist_ok=True)
    state = make_valid(shape(json.load(open(OUT / "state.geojson"))["features"][0]["geometry"]))
    for state_name, local_name, out_name in (("state_sources_osm.geojson", "sources_osm.geojson", "sources.geojson"),
                                             ("state_roads.geojson", "roads_major.geojson", "roads.geojson")):
        feats = json.load(open(OUT / state_name))["features"]
        across = [f for f in json.load(open(OUT / local_name))["features"]
                  if not state.contains(make_valid(shape(f["geometry"])).representative_point())]
        with open(web / out_name, "w") as fh:
            json.dump(_round(_fc(feats + across)), fh, separators=(",", ":"), ensure_ascii=False)
        print(f"pack {out_name}: {len(feats)} in Jharkhand + {len(across)} across the border")
    for name in ("state.geojson", "districts.geojson", "fires_firms_5d.geojson", "stations.geojson"):
        shutil.copy(OUT / name, web / name)
    if (OUT / "town_grids_3km.geojson").exists():
        shutil.copy(OUT / "town_grids_3km.geojson", web / "town_grids.geojson")
    for layer in ("railways", "rivers", "water", "forest", "protected", "places", "facilities", "landmarks",
                  "transport", "power", "kilns", "builtup"):
        if (OUT / f"state_{layer}.geojson").exists():
            shutil.copy(OUT / f"state_{layer}.geojson", web / f"{layer}.geojson")


STEPS = {"boundaries": boundaries, "stations": stations, "fires": fires, "osm": osm, "osm_state": osm_state,
         "curate": curate, "osm_base": osm_base, "landcover": landcover, "towngrids": towngrids, "pack": pack}

if __name__ == "__main__":
    wanted = sys.argv[1:] or ["all"]
    for step in (list(STEPS) if wanted == ["all"] else wanted):
        STEPS[step]()
