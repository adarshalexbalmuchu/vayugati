"""Delhi road network — traffic emission proxy from Geofabrik static extract.

Design decision: static Geofabrik .pbf extracts, NOT live Overpass API.
Live Overpass failed across three independent mirrors during the design phase
(genuine service outage) — and static extracts are the right production
design regardless:
  - deterministic: the road geometry doesn't change run-to-run
  - no per-request quota or rate-limit risk
  - can be updated intentionally on a deploy cycle, not silently mid-run

Extract URL (confirmed reachable):
  download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf

Place the file at the path in OSM_PBF_PATH (env var) or the default below.
The extract covers Delhi NCR; we filter to the Delhi bbox after loading.
Parsing requires pyrosm (pip install pyrosm), which in turn needs libspatialindex.

When the .pbf file is absent this module returns an empty list rather than
raising — road data is a secondary signal, not a hard kernel dependency.

Road-type → emission-weight mapping (relative, unitless):
  motorway/trunk/primary  → 3  (highest traffic volume, highest NOx/PM)
  secondary/tertiary      → 2
  residential/unclassified→ 1
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

log = logging.getLogger("ingest.isrm_osm_roads")

# Default path for the Geofabrik extract; override via env var in production.
_DEFAULT_PBF = Path("/data/osm/northern-zone-latest.osm.pbf")
_PBFPATH = Path(os.getenv("OSM_PBF_PATH", str(_DEFAULT_PBF)))

# Delhi bounding box filter — only roads inside this box are returned.
_DELHI_BBOX = (76.84, 28.40, 77.35, 28.90)  # (min_lng, min_lat, max_lng, max_lat)

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


def load_delhi_roads() -> list[dict]:
    """Return a list of road-segment dicts for Delhi from the Geofabrik .pbf.

    Each dict contains:
        lat, lng        — float, centroid of the road segment
        highway_type    — str, OSM highway tag value
        emission_weight — int, 1–3 relative emission proxy
        source_type     — str, always 'road'

    Returns an empty list when the .pbf file is not present (logs at INFO)
    or when pyrosm is not installed (logs at WARNING).
    """
    if not _PBFPATH.exists():
        log.info(
            "OSM .pbf not found at %s — road data unavailable.  "
            "Download: download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf",
            _PBFPATH,
        )
        return []

    try:
        import pyrosm  # noqa: PLC0415 — optional dep, import guarded here
    except ImportError:
        log.warning(
            "pyrosm not installed — cannot parse OSM .pbf.  "
            "Add pyrosm to requirements.txt and re-deploy."
        )
        return []

    try:
        osm = pyrosm.OSM(str(_PBFPATH), bounding_box=list(_DELHI_BBOX))
        roads_gdf = osm.get_network(network_type="driving")
        if roads_gdf is None or roads_gdf.empty:
            log.info("No driving roads found in Delhi bbox from .pbf")
            return []

        result = []
        for _, row in roads_gdf.iterrows():
            hw = row.get("highway") or ""
            if isinstance(hw, list):
                hw = hw[0] if hw else ""
            hw = str(hw)
            weight = _WEIGHT_MAP.get(hw, 1)

            # Centroid of segment geometry
            geom = row.get("geometry")
            if geom is None:
                continue
            centroid = geom.centroid
            result.append({
                "lat": round(centroid.y, 5),
                "lng": round(centroid.x, 5),
                "highway_type": hw,
                "emission_weight": weight,
                "source_type": "road",
            })

        log.info("Loaded %d road segments from OSM .pbf", len(result))
        return result

    except Exception:
        log.exception("Failed to parse OSM .pbf at %s", _PBFPATH)
        return []
