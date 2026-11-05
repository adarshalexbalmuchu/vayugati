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


def _districts() -> dict:
    out = {}
    for f in _geoboundaries("ADM2")["features"]:
        name = f["properties"]["shapeName"]
        g = make_valid(shape(f["geometry"]))
        if name in JH_DISTRICTS and JH_BOX.contains(g.representative_point()):
            out[name] = g
    assert len(out) == 24, sorted(out)
    return out


def boundaries() -> None:
    dist = _districts()
    _save("districts.geojson", _fc([_feat(g.simplify(0.002), name=n, area_km2=round(_area_km2(g)))
                                    for n, g in sorted(dist.items())]))
    _save("state.geojson", _fc([_feat(unary_union(list(dist.values())).simplify(0.003), name="Jharkhand")]))
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
    _save(f"dhanbad_grid_{int(CELL_KM)}km.geojson", _fc(cells))
    print(f"boundaries: 24 districts, {len(cells)} grid cells "
          f"({CELL_KM:g} km), Dhanbad {round(_area_km2(dh))} km2")


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


STEPS = {"boundaries": boundaries, "stations": stations, "fires": fires, "osm": osm, "osm_state": osm_state,
         "curate": curate, "pack": pack}

if __name__ == "__main__":
    wanted = sys.argv[1:] or ["all"]
    for step in (list(STEPS) if wanted == ["all"] else wanted):
        STEPS[step]()
