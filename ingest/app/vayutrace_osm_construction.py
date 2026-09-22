"""Construction-site dust sources from OSM landuse polygons.

Companion to vayutrace_osm_industrial.py, sharing its parsing approach
(osmium area handler, shoelace centroid, Delhi bbox filter). Separate
module because the emission basis is completely different: industrial
zones use a relative area x subtype weight, whereas construction uses an
absolute published emission factor per unit area (WRAP), so the area must
be converted to real square metres rather than left in square degrees.

See vayutrace_dust.py for the emission factor itself and for why
windblown/soil dust is deliberately not modelled.

Counts in the current Delhi extract (verified directly):
    landuse=construction  181
    landuse=landfill       34
    landuse=brownfield     18
    landuse=quarry          4

landfill/brownfield/quarry are included alongside active construction
because all are disturbed, largely unvegetated surfaces subject to the
same mechanical dust generation, and WRAP's factor is a general
"construction and demolition" area factor rather than a building-specific
one. They carry their own activity weights below.
"""

from __future__ import annotations

import logging
import math
import os
from pathlib import Path

log = logging.getLogger("ingest.vayutrace_osm_construction")

_DEFAULT_PBF = Path("/data/osm/northern-zone-latest.osm.pbf")
_PBFPATH = Path(os.getenv("OSM_PBF_PATH", str(_DEFAULT_PBF)))

_BBOX = (76.84, 28.40, 77.35, 28.90)  # (min_lng, min_lat, max_lng, max_lat)

# Relative activity weighting per landuse type, multiplying the WRAP
# construction factor.
#
# These are ASSUMPTIONS, not citations — WRAP publishes one factor for
# construction/demolition generally, not a per-landuse breakdown. They
# encode only the uncontroversial ordering that an active building site
# disturbs more surface per unit area than a dormant brownfield.
_LANDUSE_ACTIVITY: dict[str, float] = {
    "construction": 1.0,   # active building site — the WRAP reference case
    "quarry":       1.0,   # active extraction, continuous surface disturbance
    "landfill":     0.6,   # working face is active; much of the area is capped
    "brownfield":   0.3,   # disturbed and unvegetated, but not actively worked
}

# Square metres per square degree at Delhi's latitude (~28.6 N).
#
# 1 deg latitude  = 110,574 m (essentially constant)
# 1 deg longitude = 111,320 * cos(28.6 deg) = 97,760 m
# Product gives the area of a 1x1 degree cell locally. Exact enough at
# Delhi's ~0.5 degree span; a proper equal-area projection would be
# overkill given the emission factor's own uncertainty.
_M2_PER_DEG2: float = 110_574.0 * (111_320.0 * math.cos(math.radians(28.6)))


def _shoelace_centroid(ring: list[tuple[float, float]]) -> tuple[float, float, float] | None:
    """(lng, lat, |area in deg^2|) or None for a degenerate ring.

    Same formulation as vayutrace_osm_industrial._shoelace_centroid and
    vayutrace_kernel.boundary_area_centroid; kept local so this module has
    no cross-dependency on either.
    """
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


def load_delhi_construction_sites(pbf_path: Path | None = None) -> list[dict]:
    """Construction/disturbed-land polygons for Delhi.

    Returns [{name, lat, lng, area_m2, landuse, activity_weight}, ...].
    Emission weights are NOT computed here — vayutrace_dust applies the
    WRAP factor, keeping geometry parsing and emission modelling separate.

    Returns [] when the .pbf is absent or osmium is not installed, matching
    the fail-soft contract of the other loaders.
    """
    path = pbf_path or _PBFPATH
    if not path.exists():
        log.info(
            "OSM .pbf not found at %s — construction dust unavailable. "
            "Run: python ingest/scripts/download_osm_extract.py",
            path,
        )
        return []

    try:
        import osmium  # noqa: PLC0415 — optional dep, import guarded here
    except ImportError:
        log.warning("osmium not installed — cannot parse OSM .pbf for construction sites.")
        return []

    try:
        handler = _ConstructionHandler()
        handler.apply_file(str(path))
        log.info("Loaded %d construction/disturbed-land sites from %s",
                 len(handler.sites), path)
        return handler.sites
    except Exception:
        log.exception("Failed to parse OSM .pbf at %s for construction sites", path)
        return []


class _ConstructionHandler:
    """Collect construction/disturbed-land polygon centroids and real areas."""

    def __init__(self) -> None:
        self.sites: list[dict] = []

    def apply_file(self, path: str) -> None:
        import osmium  # noqa: PLC0415

        outer_shoelace = _shoelace_centroid

        class _Inner(osmium.SimpleHandler):
            def __init__(inner_self) -> None:
                super().__init__()
                inner_self.out = self.sites

            def area(inner_self, a) -> None:  # noqa: N805
                landuse = a.tags.get("landuse", "")
                activity = _LANDUSE_ACTIVITY.get(landuse)
                if activity is None:
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
                    return

                inner_self.out.append({
                    "name":            a.tags.get("name", ""),
                    "lat":             round(lat, 5),
                    "lng":             round(lng, 5),
                    "area_m2":         area_deg2 * _M2_PER_DEG2,
                    "landuse":         landuse,
                    "activity_weight": activity,
                })

        h = _Inner()
        h.apply_file(path, locations=True, idx="flex_mem")
