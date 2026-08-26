"""OSM road network — the traffic source-category proxy.

DESIGN DECISION, made from what this build actually found, not assumed:

Live Overpass API was tested against three independent public mirrors
during this build (overpass-api.de, overpass.kumi.systems,
overpass.openstreetmap.ru) - all three returned connection failures
(HTTP 502/503, "upstream connect error") within the same few minutes.
Unrelated domains (github.com, NASA FIRMS, EDGAR) all returned clean
HTTP 200 in the same environment at the same time, so this was a genuine
outage on OSM's live-query infrastructure, not a problem on this end.

But even setting the outage aside: a production pipeline that queries
live Overpass on every request is the wrong design regardless - Overpass
is a community resource with real usage limits, not meant for that
pattern. The correct approach, confirmed reachable this build, is a
periodic static extract:

  https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf
  (VERIFIED: download.geofabrik.de/asia/india.html returned HTTP 200 and
  lists northern-zone-latest.osm.pbf among India's regional extracts -
  Delhi/NCT falls within Geofabrik's "northern zone" split.)

Process: download the .pbf periodically (daily/weekly cron, not per-
request), extract road ways within Delhi's bounding box with a tool like
osmium or pyrosm, filter to `highway=*` tags, done offline. This file
defines that pipeline's shape; it does not implement the actual .pbf
parsing here (needs osmium-tool or pyrosm as a dependency, not yet
confirmed available in the target deployment environment).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

GEOFABRIK_NORTHERN_ZONE_URL = "https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf"

DELHI_BBOX = (76.8, 28.4, 77.4, 28.9)  # (west, south, east, north)

# Road classes worth weighting differently for a traffic-emissions proxy -
# a highway isn't the same emissions density as a residential street.
# This weighting is a starting assumption, not calibrated yet - flag it
# as such wherever it's used downstream.
HIGHWAY_TAG_WEIGHTS = {
    "motorway": 1.0,
    "trunk": 0.9,
    "primary": 0.7,
    "secondary": 0.5,
    "tertiary": 0.3,
    "residential": 0.15,
    "unclassified": 0.1,
}


@dataclass(frozen=True)
class RoadSegment:
    osm_id: int
    highway_type: str
    weight: float
    # Centerline points kept minimal (start/end) rather than full geometry -
    # sufficient for a distance-based kernel; full geometry can be added
    # later if the kernel design needs it.
    lat_start: float
    lng_start: float
    lat_end: float
    lng_end: float


def download_extract(dest_path: str) -> None:
    """NOT CALLED ANYWHERE YET. Confirmed reachable (HTTP 200 on the
    listing page); the .pbf file itself was not downloaded and parsed in
    this build - that's real disk space and a real osmium/pyrosm
    dependency, appropriate to do once, deliberately, not as a side effect
    of writing this module."""
    raise NotImplementedError(
        f"curl -L -o {dest_path!r} {GEOFABRIK_NORTHERN_ZONE_URL!r}, then "
        f"filter to DELHI_BBOX and highway=* tags with osmium-tool or pyrosm."
    )


def load_road_segments_from_extract(pbf_path: str) -> list[RoadSegment]:
    """Stub - the actual .pbf -> RoadSegment parsing, once osmium/pyrosm
    is confirmed available and a real extract has been downloaded."""
    raise NotImplementedError("Depends on download_extract() + osmium-tool/pyrosm - not yet done.")
