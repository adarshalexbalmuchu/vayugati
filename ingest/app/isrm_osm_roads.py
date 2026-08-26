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
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

log = logging.getLogger("ingest.isrm_osm_roads")

_DEFAULT_PBF = Path("/data/osm/northern-zone-latest.osm.pbf")
_PBFPATH = Path(os.getenv("OSM_PBF_PATH", str(_DEFAULT_PBF)))

# Delhi bounding box — only roads whose centroid falls inside are returned.
_BBOX = (76.84, 28.40, 77.35, 28.90)  # (min_lng, min_lat, max_lng, max_lat)

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


def load_delhi_roads(pbf_path: Path | None = None) -> list[dict]:
    """Return road-segment dicts for Delhi from the Geofabrik .pbf.

    Each dict contains:
        lat, lng        — float, centroid of the road way (mean of node coords)
        highway_type    — str, OSM highway tag value
        emission_weight — int, 1–3 relative emission proxy
        source_type     — str, always 'road'

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
        log.info("Loaded %d road segments from %s", len(handler.segments), path)
        return handler.segments
    except Exception:
        log.exception("Failed to parse OSM .pbf at %s", path)
        return []


class _HighwayHandler:
    """Collect highway way centroids using osmium's SimpleHandler pattern."""

    def __init__(self) -> None:
        self.segments: list[dict] = []

    def apply_file(self, path: str, locations: bool = True) -> None:
        import osmium  # noqa: PLC0415

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

                inner_self.out.append({
                    "lat":            round(lat, 5),
                    "lng":            round(lng, 5),
                    "highway_type":   hw,
                    "emission_weight": weight,
                    "source_type":    "road",
                })

        h = _Inner()
        h.apply_file(path, locations=True)
