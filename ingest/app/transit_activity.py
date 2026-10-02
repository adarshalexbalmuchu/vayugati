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
    (VehiclePosition.as_dict() shape). `wards`: [{id, name, lat, lng,
    boundary}, ...].

    Bug fix (Sept 2026): this used to skip any ward with lat/lng=None,
    which was ALL BUT 13 of Delhi's 265 wards — confirmed live this
    session, get_hotspot_wards() (the only caller's ward source) queried
    is_hotspot=true, so the transit-activity panel only ever reported
    vehicle activity for the original 13 "hotspot" wards, with the other
    252 silently absent from `per_ward` entirely (not degraded — missing).
    The doc comment here used to justify this as matching "the frontend's
    own 'never fabricate a missing centroid' rule" — but that frontend
    rule was itself upgraded elsewhere in this codebase to use a boundary-
    centroid fallback instead of skipping (see OverviewChoroplethMap.tsx's
    boundingBoxCenter(), dataQualityRules.ts's geometryCentroid(), and this
    same session's vayutrace_kernel.py fix), so this module was the one
    place still using the old skip-only behaviour. Now uses the same
    boundary_area_centroid() fallback vayutrace_kernel.py's dispersion
    kernel already relies on for exactly this — one shared implementation,
    not a third independently-written approximation of the same geometry.

    Returns a fully-derived, non-identifying summary: counts and per-ward
    buckets only - no raw vehicle-level data leaves this function, and
    nothing here is written to disk by any caller (see delhi_otd.py)."""
    from .vayutrace_kernel import boundary_area_centroid  # noqa: PLC0415 — avoids a module-load-order/import-cycle risk; only needed here

    live_buses_tracked = len(vehicles)
    active_routes = len({v["route_id"] for v in vehicles if v.get("route_id")})

    per_ward = []
    for ward in wards:
        wlat, wlng = ward.get("lat"), ward.get("lng")
        if wlat is None or wlng is None:
            fallback = boundary_area_centroid(ward.get("boundary"))
            if fallback is None:
                continue  # genuinely no usable position — still skipped, not fabricated
            wlat, wlng = fallback
        ward = {**ward, "lat": wlat, "lng": wlng}
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
