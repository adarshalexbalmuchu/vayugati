"""Delhi industrial-zone emission source inventory — real OSM landuse=industrial
polygons from the same Geofabrik static extract vayutrace_osm_roads.py uses,
replacing the 60 hand-typed "approximate locality centroid" points that used
to live in vayutrace_industrial_zones.py.

-- Why this replaced the hardcoded 60-zone list (Sept 2026) --

vayutrace_industrial_zones.py's own docstring already flagged this as the
intended next step: "Coordinates are APPROXIMATE LOCALITY CENTROIDS...
Refine with DDA Master Plan zoning shapefile or OSM landuse=industrial
polygons." That list was sourced from DSIIDC/MSME/MPD-2021/CPCB documents —
real, but each zone reduced to one hand-typed point with a qualitative 1-3
emission-weight guess per category (planned/flatted_factory/non_conforming),
the same kind of proxy the OSM road fix (this same session) replaced for
roads. OSM's northern-zone extract has real digitized polygons for Delhi's
industrial land use — 298 landuse=industrial areas inside the Delhi bbox,
254 after excluding non-emission-source tags (utilities, depots, water
infrastructure — see _EXCLUDE_TAGS below), confirmed live this session.

-- What changed vs. the old hardcoded list --

  1. REAL geometry instead of one typed point per zone: area-weighted
     centroid (same shoelace-formula approach boundary_area_centroid() in
     vayutrace_kernel.py already uses for ward positions), computed from
     the polygon's own outer ring.
  2. Real polygon AREA as the emission-weight basis instead of a bare 1-3
     qualitative class guess — same reasoning as the road fix's length-
     weighting: a physically bigger industrial zone should contribute
     more, and area is a real, measurable quantity OSM's geometry already
     gives us, not another hand-picked number. `emission_weight` here is
     therefore an unbounded area-derived intensity (see
     AREA_WEIGHT_MULTIPLIER below), matching how the road loader already
     changed road's `emission_weight` semantics from a bounded 1-3 score
     to an unbounded length-weighted one.
  3. A secondary OSM `industrial=*` sub-tag multiplier where present
     (factory/steel_mill=heavier, warehouse=lighter) — real tagged
     information when OSM has it, not fabricated; zones without a
     sub-tag get a neutral multiplier of 1.0, not a guessed category.

-- What was deliberately excluded --

_EXCLUDE_TAGS filters out landuse=industrial polygons that are not actual
emission sources: power plants/substations (own separate physical process,
not a general "industrial" emitter in the sense this kernel models),
wastewater/water treatment (pollution TREATMENT, not a source — same
reasoning vayutrace_industrial_zones.py already used to exclude CETPs),
and depot/bus_depot/communication (transit/logistics facilities, not
manufacturing). 44 of the 298 Delhi-bbox polygons were excluded this way.

-- What was NOT attempted --

No attempt to preserve the DSIIDC/MSME/MPD-2021/CPCB document-sourced
category labels (planned/flatted_factory/non_conforming) by matching them
against OSM polygons by name/proximity — many OSM industrial polygons here
have no `name` tag at all (171 of 298, confirmed live this session), which
would make that matching unreliable and partial. Real OSM geometry with an
area-based weight is a more complete, structurally consistent replacement
than a partial name-matched hybrid.

Path/parser conventions match vayutrace_osm_roads.py exactly (same .pbf
file, same OSM_PBF_PATH env var, same osmium optional-dependency guard,
same "never fabricate, return [] when the file/library is absent" rule).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from . import osm_cache

log = logging.getLogger("ingest.vayutrace_osm_industrial")

_DEFAULT_PBF = Path("/data/osm/northern-zone-latest.osm.pbf")
_PBFPATH = Path(os.getenv("OSM_PBF_PATH", str(_DEFAULT_PBF)))

# Delhi bounding box — only polygons whose centroid falls inside are returned.
_BBOX = (76.84, 28.40, 77.35, 28.90)  # (min_lng, min_lat, max_lng, max_lat)

# Real OSM secondary tags confirmed present in this extract (checked live
# this session — the full observed set, not a guessed list) that mean the
# polygon is NOT an emission source in the sense this kernel models: power
# generation/distribution infrastructure, water/wastewater treatment
# (pollution TREATMENT, matching vayutrace_industrial_zones.py's own CETP
# exclusion), and depot/communication (transit/logistics, not manufacturing).
_EXCLUDE_TAGS: set[tuple[str, str]] = {
    ("power", "plant"),
    ("power", "substation"),
    ("power", "generator"),
    ("man_made", "wastewater_plant"),
    ("man_made", "wastewater_treatment"),
    ("man_made", "water_works"),
    ("industrial", "depot"),
    ("industrial", "bus_depot"),
    ("industrial", "water"),
    ("industrial", "communication"),
    ("amenity", "marketplace"),
}

# Real OSM industrial=* sub-tag, where present, as a multiplier on the
# area-derived base weight — heavier/dirtier process types get a higher
# multiplier, matching the qualitative reasoning the old hardcoded 1-3
# scale used (metal/chemicals=heaviest, warehousing=lightest), but only
# applied when OSM itself has tagged the sub-type, never guessed.
_SUBTYPE_MULTIPLIER: dict[str, float] = {
    "steel_mill": 1.5,
    "factory": 1.2,
    "food_industry": 1.1,
    "construction": 1.1,
    "warehouse": 0.6,
}
_DEFAULT_SUBTYPE_MULTIPLIER = 1.0

# Converts the shoelace-formula area (in squared degrees at Delhi's ~28.6°N
# latitude) into a workable emission_weight scale comparable in ORDER OF
# MAGNITUDE to the old hardcoded 1-3 scores' typical total mass, so this
# swap doesn't silently blow up the industrial:road calibration the kernel
# already performs (_calibrate_road_industrial_scale in vayutrace_kernel.py
# calibrates against DECAY-WEIGHTED mass, not raw totals, so it self-
# corrects for a different absolute scale regardless — this constant only
# keeps intermediate numbers in a sane, inspectable range, it is not
# load-bearing for correctness the way the calibration step is).
AREA_WEIGHT_MULTIPLIER = 1_000_000.0


def _shoelace_centroid(ring: list[tuple[float, float]]) -> tuple[float, float, float] | None:
    """(lng, lat, |area|) via the shoelace formula, or None for a degenerate
    ring. Same approach as vayutrace_kernel.py's boundary_area_centroid()
    (ward positions) — reused conceptually, not imported, since this
    module's input is raw osmium ring objects, not GeoJSON dicts."""
    n = len(ring)
    if n < 3:
        return None
    cx = cy = area = 0.0
    for i in range(n):
        j = i - 1
        x_i, y_i = ring[i]
        x_j, y_j = ring[j]
        cross = x_j * y_i - x_i * y_j
        area += cross
        cx += (x_j + x_i) * cross
        cy += (y_j + y_i) * cross
    area /= 2.0
    if area == 0:
        return None
    return (cx / (6 * area), cy / (6 * area), abs(area))


def load_delhi_industrial_zones(pbf_path: Path | None = None) -> list[dict]:
    """Industrial zones from the shipped cache; parses the .pbf only for an explicit path."""
    if pbf_path is None:
        cached = osm_cache.load("industrial")
        if cached is not None:
            return cached
    return parse_delhi_industrial_zones(pbf_path)


def parse_delhi_industrial_zones(pbf_path: Path | None = None) -> list[dict]:
    """Return industrial-zone source dicts for Delhi from the Geofabrik
    .pbf, replacing vayutrace_industrial_zones.zones_as_dicts()'s old
    hardcoded list (see this module's own docstring for the full
    rationale).

    Each dict contains:
        lat, lng          — float, area-weighted centroid of the polygon
        emission_weight    — float, polygon area × AREA_WEIGHT_MULTIPLIER ×
                              the OSM industrial=* sub-tag multiplier
                              (unbounded — not the old 1-3 class value)
        source_type        — str, always 'industrial'
        name                — str, OSM name tag, '' when absent (171/298
                              polygons have none — never fabricated)

    Returns [] when the .pbf file is absent or osmium is not installed —
    same contract as vayutrace_osm_roads.load_delhi_roads().
    """
    path = pbf_path or _PBFPATH
    if not path.exists():
        log.info(
            "OSM .pbf not found at %s — industrial-zone data unavailable. "
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
        handler = _IndustrialLanduseHandler()
        handler.apply_file(str(path))
        log.info(
            "Loaded %d industrial zones from %s (%d excluded as non-emission-source)",
            len(handler.zones), path, handler.excluded_count,
        )
        return handler.zones
    except Exception:
        log.exception("Failed to parse OSM .pbf at %s", path)
        return []


class _IndustrialLanduseHandler:
    """Collect landuse=industrial polygon centroids + areas using osmium's
    SimpleHandler pattern. `area()` (not `way()`) — osmium's area callback
    handles both simple ways and multipolygon relations, assembling
    closed-ring geometry from either, which a way-level handler wouldn't."""

    def __init__(self) -> None:
        self.zones: list[dict] = []
        self.excluded_count = 0

    def apply_file(self, path: str) -> None:
        import osmium  # noqa: PLC0415

        outer_shoelace = _shoelace_centroid

        class _Inner(osmium.SimpleHandler):
            def __init__(inner_self) -> None:
                super().__init__()
                inner_self.out = self.zones

            def area(inner_self, a) -> None:  # noqa: N805
                if a.tags.get("landuse") != "industrial":
                    return
                tags = dict(a.tags)
                if any((k, v) in _EXCLUDE_TAGS for k, v in tags.items()):
                    self.excluded_count += 1
                    return

                try:
                    rings = list(a.outer_rings())
                except Exception:
                    return
                if not rings:
                    return

                coords = [(n.lon, n.lat) for n in rings[0] if n.location.valid()]
                c = outer_shoelace(coords)
                if not c:
                    return
                lng, lat, area_deg2 = c

                min_lng, min_lat, max_lng, max_lat = _BBOX
                if not (min_lat <= lat <= max_lat and min_lng <= lng <= max_lng):
                    return  # outside Delhi bbox

                subtype = tags.get("industrial", "")
                multiplier = _SUBTYPE_MULTIPLIER.get(subtype, _DEFAULT_SUBTYPE_MULTIPLIER)
                weight = area_deg2 * AREA_WEIGHT_MULTIPLIER * multiplier

                inner_self.out.append({
                    "name":             tags.get("name", ""),
                    "lat":              round(lat, 5),
                    "lng":              round(lng, 5),
                    "emission_weight":  weight,
                    "source_type":      "industrial",
                })

        h = _Inner()
        h.apply_file(path, locations=True, idx="flex_mem")
