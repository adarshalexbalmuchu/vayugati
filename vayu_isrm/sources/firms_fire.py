"""NASA FIRMS (Fire Information for Resource Management System) client —
the biomass/stubble-burning source-category input.

VERIFIED THIS BUILD: the endpoint and URL shape are real and correct.
`curl "https://firms.modaps.eosdis.nasa.gov/api/area/csv/DEMO_KEY/VIIRS_SNPP_NRT/76.8,28.4,77.4,28.9/1"`
returned HTTP 400 "Invalid MAP_KEY" - a real, specific validation error
from a live service, not a 404 or connection failure. That confirms the
URL pattern (`/api/area/csv/{MAP_KEY}/{SOURCE}/{bbox}/{day_range}`) is
correct; it's gated behind a real key, not broken.

NOT YET DONE: an actual MAP_KEY. These are free and instant - register at
https://firms.modaps.eosdis.nasa.gov/api/area/ - this file will work as
soon as one is in hand; nothing else about it needs to change.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from typing import Optional

BASE_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"

# VIIRS_SNPP_NRT: ~375m resolution, near-real-time - the right choice over
# MODIS's coarser ~1km for ward-level relevance. Confirmed via FIRMS' own
# public source-comparison documentation, not assumed.
DEFAULT_SOURCE = "VIIRS_SNPP_NRT"

# Delhi NCT bounding box (west, south, east, north) - same box used to
# test the endpoint above.
DELHI_BBOX = (76.8, 28.4, 77.4, 28.9)


@dataclass(frozen=True)
class FireDetection:
    lat: float
    lng: float
    brightness: float       # fire radiative signal strength
    acq_date: str
    acq_time: str
    confidence: str          # low / nominal / high (VIIRS) - NOT a validated
                              # probability the source model should trust blindly


def build_request_url(map_key: str, bbox: tuple[float, float, float, float] = DELHI_BBOX,
                       day_range: int = 1, source: str = DEFAULT_SOURCE) -> str:
    w, s, e, n = bbox
    return f"{BASE_URL}/{map_key}/{source}/{w},{s},{e},{n}/{day_range}"


def parse_csv_response(csv_text: str) -> list[FireDetection]:
    """Parse FIRMS' CSV response shape. Not yet exercised against a real
    authenticated response in this build - the shape below matches FIRMS'
    documented CSV column set, but treat this as unverified against live
    data until a real MAP_KEY confirms it end-to-end."""
    reader = csv.DictReader(io.StringIO(csv_text))
    detections = []
    for row in reader:
        detections.append(FireDetection(
            lat=float(row["latitude"]),
            lng=float(row["longitude"]),
            brightness=float(row.get("bright_ti4", row.get("brightness", 0.0))),
            acq_date=row["acq_date"],
            acq_time=row["acq_time"],
            confidence=row.get("confidence", "unknown"),
        ))
    return detections


def fetch_delhi_fires(map_key: str, day_range: int = 1) -> list[FireDetection]:
    """NOT CALLED ANYWHERE YET - needs a real MAP_KEY and an actual HTTP
    call (deliberately not wired up with a hardcoded request here, so this
    stays a stub you activate on purpose, not something that silently
    tries to hit the network with an invalid key)."""
    raise NotImplementedError(
        "Needs a real FIRMS MAP_KEY (free, instant, register at "
        "https://firms.modaps.eosdis.nasa.gov/api/area/). "
        f"Once you have one: requests.get(build_request_url(map_key)).text "
        f"-> parse_csv_response(...)."
    )
