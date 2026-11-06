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


# The forest report's areas disagree with the districts' own official figures for these two (found 6 Nov 2026):
# Kodarma ISFR 2,540 vs 1,655.61 km2 on the Koderma district website (Forest Department: 1,500); Hazaribagh ISFR
# 3,555 vs 4,302 km2 on the Hazaribagh district website and the Central Ground Water Board profile (2011).
# OpenStreetMap's borders give 1,661 and 4,387, which match the official figures. The check uses the official ones.
AREA_CHECK_OVERRIDES = {"Kodarma": 1655.61, "Hazaribagh": 4302.0}


def _soi_areas() -> dict:
    """Area yardstick for the border check: ISFR 2023 (Survey of India calculated areas), except where the
    district's own official figure differs by a lot (AREA_CHECK_OVERRIDES)."""
    areas = {r["district"]: float(r["area_km2_soi"])
             for r in csv.DictReader(open(REPO / "data" / "jharkhand" / "sources" / "isfr2023_district_forest.csv"))}
    areas.update(AREA_CHECK_OVERRIDES)
    return areas


# Towns whose district is certain (district HQs and well-known block HQs). They are a second check on the
# borders, because an area can match while a border sits in the wrong place (Datameet puts Mandu, a Ramgarh
# block, in Hazaribagh). Each wrongly placed town costs TOWN_PENALTY points of mean area error.
TEST_TOWNS = {
    "Ranchi": "Ranchi", "Jamshedpur": "Purbi Singhbhum", "Dhanbad": "Dhanbad", "Bokaro": "Bokaro", "Chas": "Bokaro",
    "Deoghar": "Deoghar", "Madhupur": "Deoghar", "Hazaribagh": "Hazaribagh", "Barhi": "Hazaribagh",
    "Barkagaon": "Hazaribagh", "Ichak": "Hazaribagh", "Giridih": "Giridih", "Bagodar": "Giridih",
    "Dhanwar": "Giridih", "Barkatha": "Hazaribagh", "Chalkusa": "Hazaribagh", "Chauparan": "Hazaribagh", "Ramgarh": "Ramgarh", "Patratu": "Ramgarh", "Mandu": "Ramgarh", "Gola": "Ramgarh",
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
    "Chandrapura Thermal Power Station": ("Chandrapura Thermal Power Station", "Damodar Valley Corporation (DVC)"),  # Coal
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


# Checked plant (our name) -> its exact entry name in the WRI Global Power Plant Database (built from the Central
# Electricity Authority list; this release's capacity data is from about 2019-20). Only unambiguous matches: a plant
# is left out when the database has no entry or splits it (Bokaro), or is newer than the release (Godda, North
# Karanpura). Capacity is as listed there, which can lag units added or retired since.
WRI_NAME = {
    "Chandrapura Thermal Power Station": "CHANDRAPURA",
    "Maithon Right Bank Thermal Power Station": "MAITHON RB TPP",
    "Koderma Thermal Power Station": "KODERMA",
    "Jojobera Power Plant": "JOJBERA",
    "Tenughat Thermal Power Station": "TENUGHAT",
    "Santaldih Thermal Power Station": "SANTALDIH",
    "Panchet hydroelectric station": "PANCHET",
    "Maithon hydroelectric station": "MAITHON",
}


def _plant_capacity(our_name: str, lng: float, lat: float) -> tuple[float, str, str] | None:
    wri = WRI_NAME.get(our_name)
    path = REPO / "data" / "jharkhand" / "sources" / "wri_gppd_jharkhand_area_plants.csv"
    if not wri or not path.exists():
        return None
    for r in csv.DictReader(open(path)):
        if r["name"].strip().upper() != wri:
            continue
        d = math.hypot((float(r["longitude"]) - lng) * 111.32 * math.cos(math.radians(lat)), (float(r["latitude"]) - lat) * 110.57)
        if d <= 15:  # sanity: the same place
            return float(r["capacity_mw"]), f"{r['name'].title()} ({r['commissioning_year'][:4] or 'year n/a'})", r["gppd_idnr"]
    return None


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
            ax = shape(f["geometry"]).representative_point()
            cap = _plant_capacity(checked[0], ax.x, ax.y)
            p.pop("capacity_mw", None); p.pop("capacity_note", None); p.pop("capacity_ids", None)
            if cap:
                p["capacity_mw"], p["capacity_note"], p["capacity_ids"] = cap[0], cap[1], cap[2]
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
            elif t.get("waterway") == "waterfall" or t.get("natural") == "waterfall":  # dams: see wris()
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


WRIS = REPO / "data" / "jharkhand" / "sources" / "wris"


def _title(v) -> str:
    v = (v or "").strip()
    return "" if v.lower() in ("", "none", "<null>", "null") else v.title()


def _num(v):
    try:
        return None if v is None else round(float(v), 2)
    except (TypeError, ValueError):
        return None


def wris() -> None:
    """Official layers from India-WRIS (Central Water Commission / NWIC, Ministry of Jal Shakti), fetched by wris_fetch.py:
    large dams (National Register of Large Dams), river basins and sub-basins (CWC), and the notified wildlife
    sanctuaries and national parks (year and area). Attributes are copied as published; a missing value stays missing."""
    state = make_valid(shape(json.load(open(OUT / "state.geojson"))["features"][0]["geometry"]))

    def load(name):
        return json.load(open(WRIS / f"{name}.geojson"))["features"]

    # Large dams: only those located in the state.
    dams = []
    for f in load("dams"):
        g = f.get("geometry")
        p = f["properties"]
        if not g or not state.contains(Point(*g["coordinates"][:2])):
            continue
        dams.append(_feat(Point(*g["coordinates"][:2]), kind="dam", name=_title(p.get("dm_name")),
                          river=_title(p.get("rivcode")), year=p.get("dm_cmp_yr") or None,
                          height_m=_num(p.get("dm_height")), storage_mcm=_num(p.get("grs_stor_c")),
                          purpose=(p.get("purpose") or "").strip(), owner=(p.get("incharge") or "").strip(),
                          nrld=p.get("nrld_no") or ""))
    _save("state_dams.geojson", _fc(dams))
    print("wris dams:", len(dams))

    # Basins and sub-basins, cut to the state outline.
    basins = []
    for f in load("subbasins"):
        g = make_valid(shape(f["geometry"])).intersection(state)
        if g.is_empty:
            continue
        p = f["properties"]
        basins.append(_feat(g, basin=(p.get("ba_name") or "").replace(" Basin", "").strip(), sub_basin=(p.get("sub_basin") or "").strip()))
    _save("state_basins.geojson", _fc(basins))
    print("wris sub-basins in the state:", len(basins))

    # The 44 major rivers India-WRIS names, cut to the state outline. Only the name and basin are kept: its
    # free-text "origin" and "tributary" fields are partly outdated (e.g. "Ranchi district of Bihar").
    rivers = []
    for f in load("streams"):
        g = make_valid(shape(f["geometry"])).intersection(state)
        if g.is_empty or g.geom_type not in ("LineString", "MultiLineString", "GeometryCollection"):
            continue
        if g.geom_type == "GeometryCollection":
            g = unary_union([x for x in g.geoms if x.geom_type in ("LineString", "MultiLineString")])
            if g.is_empty:
                continue
        p = f["properties"]
        rivers.append(_feat(g, name=(p.get("rivname") or "").strip(), basin=(p.get("ba_name") or "").strip(),
                            sub_basin=(p.get("sub_basin") or "").strip() if (p.get("sub_basin") or "").strip().lower() != "none" else ""))
    _save("state_majorrivers.geojson", _fc(rivers))
    print("wris major rivers in the state:", len(rivers), sorted({r["properties"]["name"] for r in rivers}))

    # Notified protected areas (replace the volunteer-drawn ones).
    parks = []
    for f in load("national_parks"):
        p = f["properties"]
        if p.get("state") != "JH":
            continue
        name = (p.get("name") or "").strip()
        for suffix in (" WLS", " NP"):
            if name.endswith(suffix):
                name = name[: -len(suffix)]
        parks.append(_feat(make_valid(shape(f["geometry"])), kind="protected", name=name, category=p.get("type") or "",
                           tiger_reserve=(p.get("sub_type") or "") == "Tiger Reserve",
                           year=int(p["year_of_notification"]) if str(p.get("year_of_notification") or "").isdigit() else None,
                           notified_km2=_num(p.get("reported_area"))))
    _save("state_protected.geojson", _fc(parks))
    print("wris protected areas:", len(parks))

    # Dams now come from the register above, not from OpenStreetMap.
    lm = json.load(open(OUT / "state_landmarks.geojson"))["features"]
    kept = [f for f in lm if f["properties"].get("kind") != "dam"]
    if len(kept) != len(lm):
        _save("state_landmarks.geojson", _fc(kept))
        print(f"landmarks: dropped {len(lm) - len(kept)} OpenStreetMap dams")



CANAL_TYPE = {1: "Main canal", 2: "Branch canal", 3: "Distributary", 4: "Minor", 5: "Sub-minor", 6: "Sub-sub-minor",
              7: "Power channel", 8: "Feeder", 9: "Approach channel", 10: "Pipe", 11: "Other"}


def _norm(name: str) -> str:
    import re
    return re.sub(r"[^a-z]", "", (name or "").lower())


def _clean_town(name: str) -> str:
    import re
    return re.sub(r"\s*\([^)]*\)\s*$", "", (name or "").strip()).strip()


def wris_census() -> None:
    """Census 2011 villages and towns, CD blocks with ground water assessment, assembly constituencies, water monitoring
    stations and canals, all from India-WRIS (fetched by wris_fetch.py). Values are copied as published."""
    state = make_valid(shape(json.load(open(OUT / "state.geojson"))["features"][0]["geometry"]))
    districts = [(f["properties"]["name"], make_valid(shape(f["geometry"])))
                 for f in json.load(open(OUT / "districts.geojson"))["features"]]

    def load(name):
        return json.load(open(WRIS / f"{name}.geojson"))["features"]

    def district_of(g):
        pt = g.representative_point()
        for name, dg in districts:
            if dg.contains(pt):
                return name
        return ""

    # Towns and villages (replace the volunteer-mapped places).
    places = []
    for f in load("towns"):
        p = f["properties"]
        g = f["geometry"]
        pop = p.get("town_population_census_2011") or p.get("total_population_of_town")
        places.append({"type": "Feature", "geometry": g, "properties": {
            "kind": "city" if p.get("class") == "I" else "town", "name": _clean_town(p.get("town_name")),
            "status": (p.get("civic_status_of_town") or "").strip(), "pop": int(pop) if pop is not None else None,
            "pop2001": int(p["town_population_census_2001"]) if p.get("town_population_census_2001") else None,
            "hh": int(p["total_households"]) if p.get("total_households") is not None else None,
            "km2": p.get("area_sqkm"), "density": p.get("density_census_2011"), "sex_ratio": p.get("sex_ratio_census_2011"),
            "district": p.get("district_name") or ""}})
    n_towns = len(places)
    for f in load("villages"):
        p = f["properties"]
        ha = p.get("total_geographical_area__in_hec")
        places.append({"type": "Feature", "geometry": f["geometry"], "properties": {
            "kind": "village", "code": p.get("village_code"), "name": (p.get("village_name") or "").strip(),
            "pop": p.get("total_population_of_village"),
            "hh": p.get("total___households"), "km2": round(ha / 100, 2) if ha is not None else None,
            "block": (p.get("cd_block_name") or "").strip()}})
    _save("state_places_census.geojson", _fc(places))
    print(f"census places: {n_towns} towns, {len(places) - n_towns} villages")

    # CD blocks, each with the CGWB ground water assessment of the block it overlaps most (both are block maps of the
    # same 260 blocks, but spell names differently, so they are joined by area, not by name).
    from shapely.strtree import STRtree
    gwf = [(make_valid(shape(f["geometry"])), f["properties"]) for f in load("gwr_blocks")]
    tree = STRtree([g for g, _ in gwf])
    blocks, weak = [], []
    for f in load("blocks"):
        g = make_valid(shape(f["geometry"])).intersection(state)
        if g.is_empty:
            continue
        name = (f["properties"].get("block_name") or f["properties"].get("block") or "").strip()
        props = {"name": name, "district": district_of(g)}
        best, share = None, 0.0
        for i in tree.query(g):
            inter = g.intersection(gwf[i][0]).area
            union = g.union(gwf[i][0]).area
            if union and inter / union > share:
                best, share = gwf[i][1], inter / union
        if best is not None and share >= 0.6:
            props.update({"gw_class": best.get("class") or "", "gw_stage_pct": _num(best.get("sgw_dev_pe")),
                          "gw_net_ham": _num(best.get("na_gwa")), "gw_draft_ham": _num(best.get("agwd_tot"))})
            if _norm(best.get("block")) != _norm(name):
                weak.append(f"{name} ~ {best.get('block')} ({share:.2f})")
        else:
            weak.append(f"{name}: NO ground water match (best overlap {share:.2f})")
        blocks.append(_feat(g, **props))
    _save("state_blocks.geojson", _fc(blocks))
    withgw = sum(1 for b in blocks if "gw_class" in b["properties"])
    print(f"blocks: {len(blocks)}, with ground water assessment: {withgw}; spelling differences / no match: {len(weak)}")
    for w in weak[:40]:
        print("   ", w)

    # Earthquake zones and major aquifers, cut to the state.
    seis = []
    for f in load("seismic"):
        zone = (f["properties"].get("seismic_zo") or "").strip()
        g = make_valid(shape(f["geometry"])).intersection(state)
        if zone and not g.is_empty:
            seis.append(_feat(g, zone=zone.replace("Seismic Zone-", ""), intensity=(f["properties"].get("intensity_mm") or "").strip()))
    _save("state_seismic.geojson", _fc(seis))
    print("seismic zones:", sorted((x["properties"]["zone"] for x in seis)))
    aq = []
    for f in load("aquifers"):
        p = f["properties"]
        g = make_valid(shape(f["geometry"])).intersection(state)
        if not g.is_empty:
            aq.append(_feat(g, aquifer=(p.get("aquifer") or "").strip(), detail=(p.get("aquifer0") or "").strip().replace("\n", " "),
                            code=(p.get("newcode14") or "").strip()))
    _save("state_aquifers.geojson", _fc(aq))
    print("aquifers:", len(aq), sorted({a["properties"]["aquifer"] for a in aq}))

    # Village details (Census 2011 village directory), keyed by village code; loaded by the app when a village is clicked.
    water = ["tap_water_treated__status_a_1__", "tap_water_untreated__status_a_1", "covered_well__status_a_1__na_2_",
             "uncovered__well__status_a_1__na", "hand_pump__status_a_1__na_2__", "tube_wells_borehole__status_a_1",
             "spring__status_a_1__na_2__", "river_canal__status_a_1__na_2__", "tank_pond_lake__status_a_1__na_"]
    land = ["net_area_sown__in_hectares_", "forest_area__in_hectares_", "area_irrigated_by_source__in_he",
            "fallows_land_other_than_current", "current_fallows_area__in_hectar", "culturable_waste_land_area__in_",
            "area_under_non_agricultural_use", "barren___un_cultivable_land_are"]
    rows = {}
    for f in load("village_details"):
        p = f["properties"]
        mask = -1 if all(p.get(k) is None for k in water) else sum(1 << i for i, k in enumerate(water) if p.get(k) == 1)
        rows[str(p["village_code"])] = [
            (p.get("gram_panchayat_name") or "").strip().title(), (p.get("nearest_town_name") or "").strip().title(),
            p.get("nearest_town_distance_from_vill"), p.get("total_male_population_of_villag"),
            p.get("total_female_population_of_vill"), *[p.get(k) for k in land], mask]
    doc = {"fields": ["gram_panchayat", "nearest_town", "nearest_town_km", "male", "female",
                      "net_sown_ha", "forest_ha", "irrigated_ha", "fallow_other_ha", "fallow_current_ha",
                      "culturable_waste_ha", "non_agricultural_ha", "barren_ha", "water_sources_mask"],
           "water_sources": ["Tap water (treated)", "Tap water (untreated)", "Covered well", "Uncovered well", "Hand pump",
                             "Tube well or borehole", "Spring", "River or canal", "Tank, pond or lake"],
           "source": "Census of India 2011 village directory, via India-WRIS", "villages": rows}
    with open(OUT / "village_details.json", "w") as fh:
        json.dump(doc, fh, separators=(",", ":"), ensure_ascii=False)
    print("village details:", len(rows))

    # Assembly constituencies.
    asm = [_feat(make_valid(shape(f["geometry"])).intersection(state), name=(f["properties"].get("ac_name") or "").strip())
           for f in load("assembly")]
    _save("state_assembly.geojson", _fc(asm))
    print("assembly constituencies:", len(asm))

    # Water monitoring stations.
    kinds = {"stations_gw_level": "groundwater_level", "stations_quality": "water_quality",
             "stations_rain": "rainfall", "stations_reservoir": "reservoir"}
    mon = []
    for file, kind in kinds.items():
        for f in load(file):
            p = f["properties"]
            if not f["geometry"] or not state.contains(Point(*f["geometry"]["coordinates"][:2])):
                continue
            mon.append({"type": "Feature", "geometry": f["geometry"], "properties": {
                "kind": kind, "name": (p.get("station_name") or p.get("station_code") or "").strip(),
                "code": (p.get("station_code") or "").strip(), "agency": (p.get("agency_name") or "").strip(),
                "medium": (p.get("station_type") or "").strip(), "district": _title(p.get("district_name")),
                "block": _title(p.get("block_name")) if (p.get("block_name") or "").upper() != "NULL" else ""}})
    _save("state_monitors.geojson", _fc(mon))
    print("monitoring stations:", dict(collections.Counter(m["properties"]["kind"] for m in mon)))

    # Canals in the state.
    canals = []
    for f in load("canals"):
        p = f["properties"]
        if p.get("state") != "JH":
            continue
        g = make_valid(shape(f["geometry"])).intersection(state)
        if g.is_empty:
            continue
        canals.append(_feat(g, name=(p.get("canname") or "").strip(), kind=CANAL_TYPE.get(p.get("can_type"), ""),
                            project=(p.get("prjname") or "").strip()))
    _save("state_canals.geojson", _fc(canals))
    print("canals:", len(canals))


GEM = REPO / "data" / "jharkhand" / "sources" / "gem"


def _gem_owner(v) -> str:
    """'Bharat Coking Coal Ltd [100.0%]' -> 'Bharat Coking Coal Ltd'; shared ownership keeps each share."""
    import re
    parts = [x.strip() for x in str(v or "").split(";") if x.strip()]
    out = []
    for x in parts:
        m = re.match(r"^(.*?)\s*\[([\d.]+)%\]$", x)
        if m and float(m.group(2)) >= 99.99 and len(parts) == 1:
            out.append(m.group(1))
        elif m:
            out.append(f"{m.group(1)} ({float(m.group(2)):g}%)")
        else:
            out.append(x)
    return "; ".join(out)


def gem() -> None:
    """Coal mines of Jharkhand from Global Energy Monitor's Global Coal Mine Tracker (August 2026 release, CC BY 4.0), with
    the mine boundaries of its 'Coal Mine Boundaries and Methane Sources' data set (v1.0.2) where it has them. The files are
    downloaded by hand from globalenergymonitor.org into data/jharkhand/sources/gem/ (not committed). Values are copied as
    published; GEM's own location accuracy ('Exact' or 'Approximate') is kept."""
    import openpyxl

    state = make_valid(shape(json.load(open(OUT / "state.geojson"))["features"][0]["geometry"]))
    wb = openpyxl.load_workbook(GEM / "gcmt_2026-08.xlsx", read_only=True, data_only=True)

    def table(sheet):
        rows = list(wb[sheet].iter_rows(values_only=True))
        head = [str(h).replace("\n", " ") if h else "" for h in rows[0]]
        return [dict(zip(head, r)) for r in rows[1:]]

    def val(r, k):
        v = r.get(k)
        return None if v in (None, "", "-") else v

    def num(r, k, d=3):
        try:
            return round(float(r.get(k)), d)
        except (TypeError, ValueError):
            return None

    jh = [r for r in table("Non-closed mines") if r.get("Country / Area") == "India" and str(r.get("State, Province") or "").lower().startswith("jharkhand")]
    closed = [r for r in table("Closed mines") if r.get("Country / Area") == "India" and str(r.get("State, Province") or "").lower().startswith("jharkhand")]
    by_id: dict[str, list] = {}
    for r in jh:
        by_id.setdefault(r["GEM Mine ID"], []).append(r)
    feats, outside = [], []
    for mid, group in by_id.items():
        # one mine, possibly with an expansion listed as a second row: the existing mine row leads.
        group.sort(key=lambda r: (r.get("Status") != "Operating", r.get("Status") != "Mothballed"))
        r = group[0]
        exp = next((g for g in group[1:] if g.get("Status") == "Proposed"), None)
        lon, lat = num(r, "Longitude", 6), num(r, "Latitude", 6)
        if lon is None or lat is None:
            continue
        pt = Point(lon, lat)
        if not state.contains(pt):
            outside.append(r["Mine Name"])
            continue
        feats.append(_feat(pt, id=mid, name=str(r["Mine Name"]).strip(), status=r.get("Status"), status_detail=val(r, "Status Detail"),
                           owner=_gem_owner(r.get("Owners")), capacity_mtpa=num(r, "Capacity (Mtpa)"), output_mt=num(r, "Production (Mtpa)"),
                           output_year=int(float(r["Year of Production"])) if val(r, "Year of Production") else None,
                           mine_type=val(r, "Mine Type"), method=val(r, "Mining Method"), coal_type=val(r, "Coal Type"),
                           grade=val(r, "Coal Grade"), opened=int(float(r["Opening Year"])) if val(r, "Opening Year") else None,
                           coalfield=val(r, "Coalfield"), accuracy=val(r, "Location Accuracy"),
                           workforce=int(float(r["Workforce Size"])) if val(r, "Workforce Size") else None,
                           expansion_mtpa=num(exp, "Capacity (Mtpa)") if exp else None,
                           expansion_status=(exp.get("Status Detail") or exp.get("Status")) if exp else None))
    for r in closed:
        lon, lat = num(r, "Longitude", 6), num(r, "Latitude", 6)
        if lon is None or lat is None or not state.contains(Point(lon, lat)):
            continue
        feats.append(_feat(Point(lon, lat), id=r["GEM Mine ID"], name=str(r["Mine Name"]).strip(), status="Closed",
                           status_detail=val(r, "Reason for Closure"), owner=_gem_owner(r.get("Owners")),
                           capacity_mtpa=num(r, "Capacity (Mtpa)"), output_mt=num(r, "Production (Mtpa)"),
                           output_year=int(float(r["Year of Production"])) if val(r, "Year of Production") else None,
                           mine_type=val(r, "Mine Type"), method=val(r, "Mining Method"), coal_type=val(r, "Coal Type"),
                           grade=val(r, "Coal Grade"), opened=int(float(r["Opening Year"])) if val(r, "Opening Year") else None,
                           closed=int(float(r["Closing Year"])) if val(r, "Closing Year") else None,
                           coalfield=val(r, "Coalfield"), accuracy=val(r, "Location Accuracy")))
    _save("state_coalmines.geojson", _fc(feats))
    print("GEM coal mines:", dict(collections.Counter(f["properties"]["status"] for f in feats)), "outside the state, dropped:", outside)

    ids = {f["properties"]["id"]: f["properties"]["name"] for f in feats}
    bounds = []
    for path in sorted((GEM / "boundaries").glob("*, India, M*.geojson")):
        mid = path.stem.rsplit(", ", 1)[-1]
        if mid not in ids:
            continue
        for f in json.load(open(path))["features"]:
            props = f["properties"]
            if props.get("mine feature category") != "mine boundary":
                continue
            g = make_valid(shape(f["geometry"]))
            note = " ".join(str(props.get("notes") or "").split())
            bounds.append(_feat(g, id=mid, name=ids[mid], kind=props.get("mine feature subcategory") or "",
                                dated=str(props.get("data source date") or "")[:10], note=note[:520]))
    _save("state_coalboundaries.geojson", _fc(bounds))
    print("GEM mine boundaries:", len(bounds), "for", len({b['properties']['id'] for b in bounds}), "mines")

    # Coal power plants (Global Coal Plant Tracker, July 2026 release, CC BY 4.0): one point per plant, units listed.
    wbp = openpyxl.load_workbook(GEM / "gcpt_2026-07.xlsx", read_only=True, data_only=True)
    prow = list(wbp["Units"].iter_rows(values_only=True))
    ph = [str(h) if h else "" for h in prow[0]]
    units = [dict(zip(ph, r)) for r in prow[1:]
             if r[ph.index("Country/Area")] == "India"
             and str(r[ph.index("Subnational unit (province, state)")] or "").lower().startswith("jharkhand")]
    plants: dict[str, list] = {}
    for u in units:
        if u["Status"] == "cancelled":
            continue
        plants.setdefault(u["GEM location ID"], []).append(u)
    pfeats, pout = [], []
    order = ["operating", "construction", "announced", "retired"]
    for lid, us in plants.items():
        u0 = us[0]
        pt = Point(float(u0["Longitude"]), float(u0["Latitude"]))
        if not state.contains(pt):
            pout.append(u0["Plant name"])
            continue
        status = next(st for st in order if any(u["Status"] == st for u in us))
        live = [u for u in us if u["Status"] == "operating"]
        lines = []
        for u in sorted(us, key=lambda x: (str(x.get("Unit name")), )):
            bits = [str(u.get("Unit name") or "").strip(), f"{u['Capacity (MW)']:g} MW" if u.get("Capacity (MW)") else None, u["Status"]]
            if u.get("Start year"):
                bits.append(f"since {int(u['Start year'])}")
            lines.append(" · ".join(b for b in bits if b))
        owners = sorted({_gem_owner(u.get("Owner")) for u in us if u.get("Owner")})
        techs = sorted({u["Combustion technology"] for u in us if u.get("Combustion technology") and u["Combustion technology"] != "unknown"})
        captive = sorted({u["Captive industry use"] for u in us if u.get("Captive industry use")})
        pfeats.append(_feat(pt, id=lid, name=str(u0["Plant name"]).strip(), status=status,
                            operating_mw=round(sum(u["Capacity (MW)"] or 0 for u in live), 1) or None,
                            total_mw=round(sum(u["Capacity (MW)"] or 0 for u in us), 1),
                            owner="; ".join(owners), technology=", ".join(techs), captive=", ".join(captive),
                            units="\n".join(lines[:14]) + (f"\n+{len(lines) - 14} more units" if len(lines) > 14 else ""),
                            accuracy=u0.get("Location accuracy")))
    _save("state_coalplants.geojson", _fc(pfeats))
    print("GEM coal plants:", dict(collections.Counter(f["properties"]["status"] for f in pfeats)), "outside:", pout)



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
    for layer in ("railways", "rivers", "water", "forest", "protected", "places", "facilities", "landmarks",
                  "transport", "power", "kilns", "builtup", "dams", "basins", "majorrivers", "blocks", "assembly",
                  "monitors", "canals", "seismic", "aquifers", "coalmines", "coalboundaries", "coalplants"):
        src = OUT / f"state_{layer}.geojson"
        if layer == "places" and (OUT / "state_places_census.geojson").exists():
            src = OUT / "state_places_census.geojson"  # Census 2011 list replaces the volunteer-mapped places
        if src.exists():
            shutil.copy(src, web / f"{layer}.geojson")
    if (OUT / "village_details.json").exists():
        shutil.copy(OUT / "village_details.json", web / "village_details.json")


STEPS = {"boundaries": boundaries, "stations": stations, "fires": fires, "osm": osm, "osm_state": osm_state,
         "curate": curate, "osm_base": osm_base, "landcover": landcover, "wris": wris, "wris_census": wris_census, "gem": gem, "pack": pack}

if __name__ == "__main__":
    wanted = sys.argv[1:] or ["all"]
    for step in (list(STEPS) if wanted == ["all"] else wanted):
        STEPS[step]()
