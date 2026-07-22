"""Derived, non-identifying summary of Delhi OTD vehicle positions - pure
functions, no I/O, unit-tested directly (test_transit_activity.py) same as
overviewRules.ts's own convention on the frontend.

This is a public-transport ACTIVITY signal only. Nothing here is, or is
labelled as, pollution evidence, traffic congestion, or vehicular-emission
attribution - see docs/data/delhi-otd-transport-context-integration-report.md.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

# Ward "nearby" buffer for the density summary - a fixed, documented radius,
# not tuned against anything. 3km comfortably covers one hotspot ward's own
# footprint plus its immediate surroundings without blurring together
# adjacent wards (Delhi's hotspot wards are typically several km apart).
WARD_BUFFER_KM = 3.0

# Activity-level buckets for the per-ward count - informational only, not a
# traffic/pollution measure. Thresholds are a simple, documented split, not
# fit to any observed distribution.
_ACTIVITY_THRESHOLDS = [(0, "none"), (5, "low"), (15, "medium")]


def _activity_level(count: int) -> str:
    level = "high"
    for threshold, label in _ACTIVITY_THRESHOLDS:
        if count <= threshold:
            level = label
            break
    return level


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def summarize_activity(
    vehicles: list[dict],
    wards: list[dict],
    buffer_km: float = WARD_BUFFER_KM,
) -> dict:
    """`vehicles`: [{vehicle_id, trip_id, route_id, lat, lng, timestamp}, ...]
    (VehiclePosition.as_dict() shape). `wards`: [{id, name, lat, lng}, ...] -
    only wards with real lat/lng are scored (matches the frontend's own
    "never fabricate a missing centroid" rule for wards, e.g. WardBoundary in
    data.ts).

    Returns a fully-derived, non-identifying summary: counts and per-ward
    buckets only - no raw vehicle-level data leaves this function, and
    nothing here is written to disk by any caller (see delhi_otd.py)."""
    live_buses_tracked = len(vehicles)
    active_routes = len({v["route_id"] for v in vehicles if v.get("route_id")})

    per_ward = []
    for ward in wards:
        if ward.get("lat") is None or ward.get("lng") is None:
            continue
        nearby = sum(
            1
            for v in vehicles
            if v.get("lat") is not None
            and v.get("lng") is not None
            and haversine_km(ward["lat"], ward["lng"], v["lat"], v["lng"]) <= buffer_km
        )
        per_ward.append(
            {
                "ward_id": ward["id"],
                "ward_name": ward["name"],
                "vehicle_count": nearby,
                "activity_level": _activity_level(nearby),
            }
        )

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "live_buses_tracked": live_buses_tracked,
        "active_routes": active_routes,
        "buffer_km": buffer_km,
        "per_ward": per_ward,
        "label": "Public transport activity via Delhi Open Transit Data.",
        "disclaimer": "Context layer only — not proof of emissions or congestion.",
    }


def unavailable_summary(reason: str) -> dict:
    """Same shape as summarize_activity's return, but explicitly empty and
    flagged - so a frontend consumer never has to guess whether an empty
    per_ward list means "checked, zero activity" vs. "couldn't check"."""
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "live_buses_tracked": None,
        "active_routes": None,
        "buffer_km": WARD_BUFFER_KM,
        "per_ward": [],
        "label": "Public transport activity via Delhi Open Transit Data.",
        "disclaimer": "Context layer only — not proof of emissions or congestion.",
        "unavailable_reason": reason,
    }
