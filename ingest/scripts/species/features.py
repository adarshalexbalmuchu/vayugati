"""Shared feature builder for per-species model experiments.

Produces, for every CPCB station ward, STATIC source-proximity features
(distance-weighted road length by class at several decay lengths,
industrial and construction load) plus hourly meteorology, so a model can
LEARN the road-class weights and dispersion scale that VayuTrace currently
hand-sets (class weights 3/2/1, SIGMA_ROAD_KM = 1.0).

Multiple decay lengths per class is the standard land-use-regression (LUR)
"buffer" design: rather than asserting one sigma, offer several and let
cross-validated fitting pick the combination the observations support.

Receptor positions use exactly the kernel's own logic (real point, else
boundary_area_centroid) so learned features describe the same locations
VayuTrace scores.
"""

from __future__ import annotations

import pickle
import statistics
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app import db  # noqa: E402
from app.vayutrace_kernel import boundary_area_centroid  # noqa: E402

CACHE = Path(__file__).resolve().parents[2] / "data" / "species_cache" / "ward_features.pkl"

ROAD_GROUPS = {
    "major": {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link"},
    "mid":   {"secondary", "secondary_link", "tertiary", "tertiary_link"},
    "minor": {"residential", "unclassified", "living_street", "service"},
}
SIGMAS_KM = (0.25, 0.5, 1.0, 2.0, 4.0)
IND_SIGMAS_KM = (1.0, 3.0, 7.0)

KM_PER_DEG_LAT = 110.574
KM_PER_DEG_LNG = 111.320 * np.cos(np.radians(28.6))


def _hour_key(ts: str) -> str:
    return ts[:13]


def _pairwise_km(wlat, wlng, slat, slng):
    dy = (slat[None, :] - wlat[:, None]) * KM_PER_DEG_LAT
    dx = (slng[None, :] - wlng[:, None]) * KM_PER_DEG_LNG
    return np.sqrt(dx * dx + dy * dy)


def station_ward_positions() -> dict[int, tuple[float, float]]:
    wards = {w["id"]: w for w in db.get_wards_with_city()}
    out = {}
    for s in db.get_stations_with_coords():
        wid = s.get("ward_id")
        w = wards.get(wid) if wid is not None else None
        if not w:
            continue
        lat, lng = w.get("lat"), w.get("lng")
        if lat is None or lng is None:
            c = boundary_area_centroid(w.get("boundary"))
            if c is None:
                continue
            lat, lng = c
        out[wid] = (float(lat), float(lng))
    return out


def station_positions() -> dict[int, tuple[float, float]]:
    """The monitor's OWN coordinates, keyed by the ward it reports for.

    station_ward_positions() above returns the ward CENTROID — the point the
    live kernel scores. Stage 1 measured the median monitor sitting 1.05 km
    from that centroid (max 7.5 km), which is the same scale as the road
    kernel, so a model trained against a monitor should see what is around
    the monitor. Wards with several monitors get their mean position.
    """
    acc: dict[int, list[tuple[float, float]]] = {}
    for s in db.get_stations_with_coords():
        wid, lat, lng = s.get("ward_id"), s.get("lat"), s.get("lng")
        if wid is None or lat is None or lng is None:
            continue
        acc.setdefault(wid, []).append((float(lat), float(lng)))
    return {w: (sum(a for a, _ in v) / len(v), sum(b for _, b in v) / len(v)) for w, v in acc.items()}


def load_sources(bbox=None):
    """(roads, industrial, construction) from the OSM extracts.

    bbox=None keeps the live kernel's Delhi box and file. A wider box is for
    training on monitors beyond Delhi: every Geofabrik zone file present in
    ingest/data/osm/ is read (northern-zone alone has no Uttar Pradesh, so
    Ghaziabad/Noida/Greater Noida monitors would look road-free), with the
    loaders' module-level _BBOX swapped for the parse and restored after.

    Geofabrik writes a border-crossing way/area COMPLETE into every zone it
    touches, so duplicates are byte-identical and dedupe on their values.
    """
    from app import vayutrace_osm_construction as con, vayutrace_osm_industrial as ind, vayutrace_osm_roads as rd

    if bbox is None:
        return rd.load_delhi_roads(), ind.load_delhi_industrial_zones(), con.load_delhi_construction_sites()
    pbfs = sorted((Path(__file__).resolve().parents[2] / "data" / "osm").glob("*-latest.osm.pbf"))
    tag = "_".join(p.name.split("-")[0] for p in pbfs)
    f = Path(__file__).resolve().parents[2] / "data" / "species_cache" / f"osm_{'_'.join(map(str, bbox))}_{tag}.pkl"
    if f.exists():
        return pickle.loads(f.read_bytes())
    saved = rd._BBOX, ind._BBOX, con._BBOX
    rd._BBOX = ind._BBOX = con._BBOX = tuple(bbox)
    try:
        ways, inds, cons = {}, {}, {}
        for p in pbfs:
            h = rd._HighwayHandler()
            h.apply_file(str(p), locations=True)
            for w in h.segments:
                ways.setdefault((w["lat"], w["lng"], w["highway_type"], round(w["length_km"], 5)), w)
            for z in ind.load_delhi_industrial_zones(pbf_path=p):
                inds.setdefault((round(z["lat"], 5), round(z["lng"], 5), round(z["emission_weight"], 4)), z)
            for c in con.load_delhi_construction_sites(pbf_path=p):
                cons.setdefault((round(c["lat"], 5), round(c["lng"], 5), round(c["area_m2"])), c)
        out = rd.aggregate_roads_to_grid(list(ways.values())), list(inds.values()), list(cons.values())
    finally:
        rd._BBOX, ind._BBOX, con._BBOX = saved
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(pickle.dumps(out))
    return out


def static_features(pos: dict[int, tuple[float, float]], bbox=None) -> tuple[list[int], list[str], np.ndarray]:
    roads, ind, sites = load_sources(bbox)

    ward_ids = sorted(pos)
    wlat = np.array([pos[w][0] for w in ward_ids])
    wlng = np.array([pos[w][1] for w in ward_ids])

    rlat = np.array([c["lat"] for c in roads])
    rlng = np.array([c["lng"] for c in roads])
    group_len = {g: np.zeros(len(roads)) for g in ROAD_GROUPS}
    for i, c in enumerate(roads):
        for cls, km in (c.get("length_km_by_class") or {}).items():
            for g, members in ROAD_GROUPS.items():
                if cls in members:
                    group_len[g][i] += km
    d_road = _pairwise_km(wlat, wlng, rlat, rlng)

    names, cols = [], []
    for g in ROAD_GROUPS:
        for s in SIGMAS_KM:
            k = np.exp(-(d_road ** 2) / (2 * s * s))
            names.append(f"road_{g}_s{s}")
            cols.append(k @ group_len[g])

    ilat = np.array([z["lat"] for z in ind]); ilng = np.array([z["lng"] for z in ind])
    iw = np.array([z["emission_weight"] for z in ind])
    d_ind = _pairwise_km(wlat, wlng, ilat, ilng)
    for s in IND_SIGMAS_KM:
        names.append(f"industrial_s{s}")
        cols.append(np.exp(-(d_ind ** 2) / (2 * s * s)) @ iw)

    clat = np.array([x["lat"] for x in sites]); clng = np.array([x["lng"] for x in sites])
    carea = np.array([x["area_m2"] * x["activity_weight"] for x in sites])
    d_con = _pairwise_km(wlat, wlng, clat, clng)
    names.append("construction_s1.5")
    cols.append(np.exp(-(d_con ** 2) / (2 * 1.5 * 1.5)) @ carea)

    return ward_ids, names, np.column_stack(cols)


def hourly_table(hours: int, species: str):
    """(ward_id, hour_key) -> observed species value, plus per ward-hour met."""
    readings = db.get_readings_history(hours=hours)
    obs = defaultdict(list)
    for r in readings:
        v = r.get(species)
        if v is None or r.get("ward_id") is None:
            continue
        obs[(r["ward_id"], _hour_key(r["ts"]))].append(float(v))
    obs = {k: statistics.fmean(v) for k, v in obs.items()}

    met = {}
    for w in db.get_weather_history(hours=hours):
        if w.get("ward_id") is None:
            continue
        k = (w["ward_id"], _hour_key(w["ts"]))
        prev = met.get(k)
        if prev is not None and prev.get("boundary_layer_height") is not None \
                and w.get("boundary_layer_height") is None:
            continue
        met[k] = w
    return obs, met


def build(hours: int = 24 * 120, species: str = "no2", use_cache: bool = True):
    key = (hours, species)
    if use_cache and CACHE.exists():
        cached = pickle.loads(CACHE.read_bytes())
        if key in cached:
            return cached[key]
    pos = station_ward_positions()
    ward_ids, names, X = static_features(pos)
    obs, met = hourly_table(hours, species)
    result = {"ward_ids": ward_ids, "feature_names": names, "X_static": X,
              "obs": obs, "met": met, "pos": pos}
    cached = pickle.loads(CACHE.read_bytes()) if CACHE.exists() else {}
    cached[key] = result
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_bytes(pickle.dumps(cached))
    return result
