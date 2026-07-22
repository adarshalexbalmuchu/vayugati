"""Delhi Open Transit Data (OTD) real-time GTFS-realtime client.

Context layer only (see docs/data/delhi-otd-transport-context-integration-
report.md) — this is public transport activity, never treated as pollution
evidence, congestion measurement, or vehicular-emission attribution. Nothing
here writes to Supabase or touches AQI/forecast data.

Security: DELHI_OTD_API_KEY is read from env and used only in the outgoing
request's query string — never logged, never returned from any function
here. The raw protobuf payload is decoded in memory and discarded; nothing
in this module persists it.
"""

from __future__ import annotations

import logging

import httpx
from google.transit import gtfs_realtime_pb2

from . import config

REALTIME_URL = "https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb"
UA = {"User-Agent": "vayugati-transit-context/1.0"}

logger = logging.getLogger("ingest")


class VehiclePosition:
    __slots__ = ("vehicle_id", "trip_id", "route_id", "lat", "lng", "timestamp")

    def __init__(self, vehicle_id: str | None, trip_id: str | None, route_id: str | None, lat: float, lng: float, timestamp: int | None):
        self.vehicle_id = vehicle_id
        self.trip_id = trip_id
        self.route_id = route_id
        self.lat = lat
        self.lng = lng
        self.timestamp = timestamp

    def as_dict(self) -> dict:
        return {
            "vehicle_id": self.vehicle_id,
            "trip_id": self.trip_id,
            "route_id": self.route_id,
            "lat": self.lat,
            "lng": self.lng,
            "timestamp": self.timestamp,
        }


def fetch_vehicle_positions() -> list[VehiclePosition] | None:
    """One authenticated GET + in-memory decode. Returns None (never raises)
    when the key is unset or the call/decode fails for any reason - callers
    (main.py's run_transit) treat None as "no fresh data this cycle", not an
    error to crash the scheduler over. The raw protobuf `resp.content` bytes
    exist only in this function's local scope and are never written
    anywhere - the return value is already-parsed, plain Python objects."""
    if not config.DELHI_OTD_API_KEY:
        return None
    try:
        resp = httpx.get(REALTIME_URL, params={"key": config.DELHI_OTD_API_KEY}, headers=UA, timeout=30)
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        # Deliberately NOT exc_info=True / str(exc) here - httpx embeds the
        # full request URL (including the ?key=... query param) in both the
        # exception's string form and its traceback. Only the status code is
        # ever logged.
        logger.warning("Delhi OTD real-time fetch failed: HTTP %s", exc.response.status_code)
        return None
    except httpx.HTTPError as exc:
        logger.warning("Delhi OTD real-time fetch failed: %s", type(exc).__name__)
        return None

    try:
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(resp.content)
    except Exception:
        logger.warning("Delhi OTD payload did not decode as GTFS-realtime", exc_info=True)
        return None

    positions: list[VehiclePosition] = []
    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue
        v = entity.vehicle
        if not v.HasField("position"):
            continue
        vehicle_id = v.vehicle.id if v.HasField("vehicle") and v.vehicle.id else (entity.id or None)
        trip_id = v.trip.trip_id if v.HasField("trip") and v.trip.trip_id else None
        route_id = v.trip.route_id if v.HasField("trip") and v.trip.route_id else None
        timestamp = v.timestamp if v.timestamp else None
        positions.append(
            VehiclePosition(
                vehicle_id=vehicle_id,
                trip_id=trip_id,
                route_id=route_id,
                lat=v.position.latitude,
                lng=v.position.longitude,
                timestamp=timestamp,
            )
        )
    return positions
