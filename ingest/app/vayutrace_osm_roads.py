"""Delhi road network — traffic emission proxy from Geofabrik static extract.

Design decision: static Geofabrik .pbf extracts, NOT live Overpass API.
Live Overpass failed across three independent mirrors during the design phase
(genuine service outage) — and static extracts are the right production
design regardless:
  - deterministic: the road geometry doesn't change run-to-run
  - no per-request quota or rate-limit risk
  - updated intentionally on a deploy cycle, not silently mid-run

Extract URL (confirmed reachable):
  https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf

Download once with the script at ingest/scripts/download_osm_extract.py,
or manually:
  curl -L -o /data/osm/northern-zone-latest.osm.pbf \\
    https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf

Parser: osmium (pyosmium) — official OSM Foundation Python bindings.
  pip install osmium
Chosen over pyrosm because it has no geopandas/fiona/GDAL dependency chain,
ships pre-built wheels for Python 3.11 on Linux, and handles .pbf natively.

Path is read from OSM_PBF_PATH env var; defaults to /data/osm/northern-zone-latest.osm.pbf.
When the file is absent this module returns [] (logged at INFO) rather than
raising — road data is a secondary signal, not a hard kernel dependency.

Road-type → emission-weight mapping (relative, unitless):
  motorway / trunk / primary  → 3  (highest traffic, highest NOx/PM)
  secondary / tertiary        → 2
  residential / unclassified  → 1

-- Grid aggregation (Sept 2026 fix) --

Raw OSM ways are NOT fed to the kernel as individual point sources. Delhi's
northern-zone extract yields ~204,000 tagged highway ways (confirmed live
this session) because OSM digitizes a single real street as many short
adjacent "ways" — split at every intersection, tag change, or admin
boundary. Summing per-way scores as if each fragment were an independent
emitter inflates roads by roughly the average fragment count per real
street: confirmed live this session, this made every one of Delhi's 265
wards read ~95-98% "road" dominance in vayutrace_kernel.py's breakdown —
a mirror-image of the earlier "always 100% industrial" bug (which was
roads being entirely ABSENT), not a fix.

No dispersion-modelling literature treats a raw digitized way as an
independent source. Standard practice (EPA SMOKE's line-to-grid spatial
processing for NEI onroad mobile emissions; EDGAR's gridded emission
inventories; SAFAR-India's and UrbanEmissions.info's own Delhi road-
transport emission grids at 0.4-1 km resolution) is always: intersect the
vector road network with a fixed grid, sum LENGTH-weighted emission per
cell, and treat each occupied cell — not each digitized fragment — as one
source. Length-weighting (not segment count) is what makes this
fragmentation-invariant: splitting one 2 km way into four 0.5 km fragments
must not change its total contribution, and Σlength(fragments) =
length(original way) guarantees that while Σcount(fragments) does not.

Deduplicating by OSM 'name' tag instead was considered and rejected:
service/unclassified/residential/*_link ways very commonly have no name
tag at all in this extract, so name-based merging would silently drop or
misgroup exactly the road classes most prone to fragmentation, while doing
nothing to fix the actual problem (spatial density inflation, not naming).

Cell size (500 m ≈ 0.5 × SIGMA_ROAD_KM=1km in vayutrace_kernel.py) is
chosen relative to the kernel's own Gaussian decay length — coarser cells
would throw away real spatial resolution the kernel is built to use;
much finer cells buy nothing (over-resolved relative to what the Gaussian
can distinguish) and reintroduce most of the original blowup. This
matches SAFAR/UrbanEmissions' own ~0.4 km Delhi road-emission grids.

See aggregate_roads_to_grid() below; load_delhi_roads() always returns the
grid-aggregated list, never raw per-way segments — there is no "raw" mode,
since raw per-way output is what caused the bug in the first place.
"""

from __future__ import annotations

import logging
import math
import os
from pathlib import Path

log = logging.getLogger("ingest.vayutrace_osm_roads")

_DEFAULT_PBF = Path("/data/osm/northern-zone-latest.osm.pbf")
_PBFPATH = Path(os.getenv("OSM_PBF_PATH", str(_DEFAULT_PBF)))

# Delhi bounding box — only roads whose centroid falls inside are returned.
_BBOX = (76.84, 28.40, 77.35, 28.90)  # (min_lng, min_lat, max_lng, max_lat)

# ~500 m in degrees latitude (1° lat ≈ 111.32 km everywhere; longitude
# degrees shrink with latitude, but a single fixed value close enough for
# Delhi's ~28.4-28.9°N band keeps both axes' cells roughly comparable in
# real-world size without per-row latitude correction, which this kernel's
# accuracy doesn't need at 500 m resolution).
_GRID_DEG = 0.0045

_WEIGHT_MAP: dict[str, int] = {
    "motorway":         3,
    "motorway_link":    3,
    "trunk":            3,
    "trunk_link":       3,
    "primary":          3,
    "primary_link":     3,
    "secondary":        2,
    "secondary_link":   2,
    "tertiary":         2,
    "tertiary_link":    2,
    "residential":      1,
    "unclassified":     1,
    "living_street":    1,
    "service":          1,
}


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in km. Local copy rather than importing
    vayutrace_kernel's private `_haversine_km` — this module stays
    self-contained (it already only depends on osmium, an optional dep)."""
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _grid_key(lat: float, lng: float) -> tuple[int, int]:
    return (round(lat / _GRID_DEG), round(lng / _GRID_DEG))


def aggregate_roads_to_grid(ways: list[dict]) -> list[dict]:
    """Collapse raw per-way road segments onto a ~500 m grid, summing
    length-weighted emission per occupied cell (see this module's own
    docstring for why: fragmentation-invariant, matches SMOKE/EDGAR/SAFAR
    line-source-to-grid practice, not a name-based merge).

    Args:
        ways — [{lat, lng, length_km, emission_weight, highway_type}, ...],
               one entry per raw OSM way (see _HighwayHandler.way()).

    Returns one dict per occupied cell:
        {lat, lng, emission_weight, source_type, segment_count, total_length_km}
    `emission_weight` is now an unbounded summed length-weighted intensity
    (length_km × class weight, totalled across every way in the cell), not
    the original bounded 1-3 class score — this composes correctly with
    vayutrace_kernel's linear-superposition sum (score = _ew * wf * dd) the
    same way industrial/fire weights already do, but should not be treated
    as a 1-3 class value anywhere downstream.
    """
    cells: dict[tuple[int, int], dict] = {}
    for w in ways:
        key = _grid_key(w["lat"], w["lng"])
        c = cells.setdefault(key, {
            "lat_sum": 0.0, "lng_sum": 0.0, "len_sum": 0.0,
            "weighted_len_sum": 0.0, "n": 0,
            # Road-km broken out by OSM highway class, retained so the dust
            # module (vayutrace_dust.py) can apply AP-42 13.2.1 silt-loading
            # bands, which key on traffic volume and therefore on road class.
            # The traffic kernel itself only needs weighted_len_sum; this is
            # additive and does not change its behaviour.
            "len_by_class": {},
        })
        length = w.get("length_km") or 0.0
        hw = w.get("highway_type")
        if hw and length > 0:
            c["len_by_class"][hw] = c["len_by_class"].get(hw, 0.0) + length
        # Length-weighted centroid where possible; a zero-length way (single
        # node, or a rounding artifact) still needs SOME position, so it
        # falls back to an unweighted add for its own coordinate only —
        # it contributes nothing to weighted_len_sum either way.
        weight_for_pos = length if length > 0 else 1e-9
        c["lat_sum"] += w["lat"] * weight_for_pos
        c["lng_sum"] += w["lng"] * weight_for_pos
        c["len_sum"] += length
        c["weighted_len_sum"] += length * w["emission_weight"]
        c["n"] += 1

    out: list[dict] = []
    for c in cells.values():
        norm = c["len_sum"] if c["len_sum"] > 0 else c["n"] * 1e-9
        out.append({
            "lat":              round(c["lat_sum"] / norm, 5),
            "lng":              round(c["lng_sum"] / norm, 5),
            "emission_weight":  c["weighted_len_sum"],
            "source_type":      "road",
            "segment_count":    c["n"],       # diagnostic only, not used by the kernel
            "total_length_km":  round(c["len_sum"], 3),  # diagnostic only
            # Consumed by vayutrace_dust.py; ignored by the traffic kernel.
            "length_km_by_class": {k: round(v, 4) for k, v in c["len_by_class"].items()},
        })
    return out


def load_delhi_roads(pbf_path: Path | None = None) -> list[dict]:
    """Return grid-aggregated road source dicts for Delhi from the
    Geofabrik .pbf — see this module's own docstring ("Grid aggregation")
    for why raw per-way output is never returned.

    Each dict contains:
        lat, lng          — float, length-weighted centroid of the grid cell
        emission_weight   — float, summed length_km × class-weight for the
                             cell (unbounded — see aggregate_roads_to_grid)
        source_type       — str, always 'road'
        segment_count, total_length_km — diagnostic only

    Returns [] when the .pbf file is absent or osmium is not installed.
    """
    path = pbf_path or _PBFPATH
    if not path.exists():
        log.info(
            "OSM .pbf not found at %s — road data unavailable. "
            "Run: python ingest/scripts/download_osm_extract.py",
            path,
        )
        return []

    try:
        import osmium  # noqa: PLC0415 — optional dep, import guarded here
    except ImportError:
        log.warning(
            "osmium not installed — cannot parse OSM .pbf. "
            "Add 'osmium' to requirements.txt and re-deploy."
        )
        return []

    try:
        handler = _HighwayHandler()
        # locations=True caches node coordinates so way handlers can access them
        handler.apply_file(str(path), locations=True)
        raw_count = len(handler.segments)
        grid_sources = aggregate_roads_to_grid(handler.segments)
        log.info(
            "Loaded %d raw road ways from %s, aggregated to %d grid cells (~%dm)",
            raw_count, path, len(grid_sources), round(_GRID_DEG * 111_320),
        )
        return grid_sources
    except Exception:
        log.exception("Failed to parse OSM .pbf at %s", path)
        return []


class _HighwayHandler:
    """Collect highway way centroids + lengths using osmium's SimpleHandler
    pattern. Returns one dict per raw OSM way — callers must run these
    through aggregate_roads_to_grid() before feeding a dispersion kernel;
    see this module's docstring for why raw ways can't be used directly."""

    def __init__(self) -> None:
        self.segments: list[dict] = []

    def apply_file(self, path: str, locations: bool = True) -> None:
        import osmium  # noqa: PLC0415

        outer_haversine = _haversine_km

        class _Inner(osmium.SimpleHandler):
            def __init__(inner_self) -> None:
                super().__init__()
                inner_self.out = self.segments

            def way(inner_self, w) -> None:  # noqa: N805
                hw = w.tags.get("highway", "")
                weight = _WEIGHT_MAP.get(hw)
                if weight is None:
                    return  # not a road type we care about

                lats = []
                lngs = []
                for node in w.nodes:
                    loc = node.location
                    if loc.valid():
                        lats.append(loc.lat)
                        lngs.append(loc.lon)

                if not lats:
                    return

                lat = sum(lats) / len(lats)
                lng = sum(lngs) / len(lngs)

                min_lng, min_lat, max_lng, max_lat = _BBOX
                if not (min_lat <= lat <= max_lat and min_lng <= lng <= max_lng):
                    return  # outside Delhi bbox

                # Real polyline length (sum of consecutive-node great-circle
                # distances), not just a centroid — needed so grid
                # aggregation can weight by length rather than count (Sept
                # 2026 fix; see aggregate_roads_to_grid's own doc comment
                # for why count-weighting is what caused the 95-98% road
                # over-counting bug in the first place). Uses every node
                # (not just the ones that survived the valid-location
                # filter above in lats/lngs) so a single invalid node
                # doesn't silently join two unrelated points into one long
                # "leg" — walks w.nodes directly instead.
                length_km = 0.0
                prev = None
                for node in w.nodes:
                    loc = node.location
                    if not loc.valid():
                        prev = None  # break the chain across a missing node
                        continue
                    if prev is not None:
                        length_km += outer_haversine(prev[0], prev[1], loc.lat, loc.lon)
                    prev = (loc.lat, loc.lon)

                inner_self.out.append({
                    "lat":            round(lat, 5),
                    "lng":            round(lng, 5),
                    "highway_type":   hw,
                    "emission_weight": weight,
                    "length_km":      length_km,
                    "source_type":    "road",
                })

        h = _Inner()
        h.apply_file(path, locations=True)
