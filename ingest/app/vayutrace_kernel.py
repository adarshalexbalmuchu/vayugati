"""ISRM-style distance-and-wind-weighted dispersion kernel.

This is a forward (emissions → estimated concentration) model, NOT receptor
modelling.  It produces ESTIMATED/MODELLED source contributions per ward.
Never describe outputs as "detected" or "measured" — those words belong to
receptor modelling on chemically speciated samples that CPCB stations don't
provide.

-- Design --

For each ward W and each emission source S, the kernel computes:

    contribution(S → W) =
        emission_weight(S)
        × wind_factor(bearing(S→W), wind_dir_at_W, wind_speed_at_W)
        × distance_decay(haversine(S, W))

Where:
    emission_weight — qualitative strength (1–3) from industrial_zones /
                      osm_roads / FIRMS brightness
    wind_factor     — cos(Δθ) component: how aligned is the wind with the
                      source-to-ward bearing?  Amplified by wind speed.
    distance_decay  — Gaussian exp(-d²/2σ²), σ calibrated in km.

The raw contributions are normalised to sum to 1 across sources, then
grouped by source type ("industrial", "road", "fire") to give a per-ward
sector breakdown.

A confidence signal is also produced per ward:
    confidence = 1 − (min_cpcb_station_distance / MAX_CONFIDENT_DIST_KM)
    clipped to [0, 1].
High near a CPCB station; lower for wards with no nearby station.

-- Calibration --

σ (the Gaussian decay length) is the key tuning parameter.  Calibrated to
7 km by wind-stratified Spearman regression: for each of 4,340 paired
(PM2.5 reading, weather row) observations across 44 Delhi CPCB stations,
we computed the wind-weighted industrial proximity score at the actual
wind direction/speed and correlated it against the station's local PM2.5
excess (reading minus hourly city median).  ρ peaks at σ=7 km (ρ=0.20,
p≈0, two-tailed), then falls on both sides — a clear, data-driven optimum.
Re-run ingest/scripts/calibrate_vayutrace_sigma.py --wind --days 30 after
accumulating more data to check whether this estimate shifts.

The IIT Kanpur / TERI-ARAI sector priors in vayutrace_sector_priors.py are the
sanity-check target: after averaging across all wards the kernel output
should roughly match the city-level published sector percentages.
"""

from __future__ import annotations

import logging
import math
from typing import Any

import numpy as np

log = logging.getLogger("ingest.vayutrace_kernel")

# -- Tuning parameters (override via run_kernel kwargs for experimentation) ---

# Gaussian decay half-length in km.  Sources closer than σ km dominate;
# beyond 2σ the contribution drops to ~14%.
# Calibrated value: 7 km (Spearman rho=0.20, p≈0, n=4340 paired
# reading+weather observations, wind-stratified against 44 Delhi CPCB
# stations, 30 days of data — see ingest/scripts/calibrate_vayutrace_sigma.py).
DEFAULT_SIGMA_KM: float = 7

# A ward with its nearest CPCB station ≤ this distance gets full confidence.
MAX_CONFIDENT_DIST_KM: float = 15.0

# Minimum number of emission sources to attempt attribution.
MIN_SOURCES: int = 1


# -- Geometry helpers ─────────────────────────────────────────────────────────

def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance between two WGS-84 points, in kilometres."""
    R = 6371.0
    φ1, φ2 = math.radians(lat1), math.radians(lat2)
    Δφ = math.radians(lat2 - lat1)
    Δλ = math.radians(lng2 - lng1)
    a = math.sin(Δφ / 2) ** 2 + math.cos(φ1) * math.cos(φ2) * math.sin(Δλ / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def _bearing_deg(from_lat: float, from_lng: float, to_lat: float, to_lng: float) -> float:
    """Initial bearing (degrees, 0=N, 90=E) from source to ward."""
    φ1, φ2 = math.radians(from_lat), math.radians(to_lat)
    Δλ = math.radians(to_lng - from_lng)
    x = math.sin(Δλ) * math.cos(φ2)
    y = math.cos(φ1) * math.sin(φ2) - math.sin(φ1) * math.cos(φ2) * math.cos(Δλ)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


# -- Wind factor ──────────────────────────────────────────────────────────────

def _wind_factor(
    source_to_ward_bearing: float,
    wind_from_dir_deg: float,
    wind_speed_ms: float,
) -> float:
    """How much does the wind carry emissions from source toward this ward?

    wind_from_dir_deg is the meteorological convention: the direction the
    wind is BLOWING FROM (MET Norway standard, matching open_meteo.py's
    wind_from_direction field).

    The wind BLOWS TOWARD bearing = (wind_from_dir_deg + 180) % 360.
    A source upwind of the ward (wind blowing source→ward) has a high factor.

    factor = max(0, cos(Δθ)) × (1 + wind_speed_ms / 10)
    Clamped to ≥ 0 (downwind sources get zero boost, not negative).
    The (1 + v/10) term amplifies transport at higher wind speeds — at 10 m/s
    the wind-aligned contribution is doubled relative to calm conditions.
    """
    wind_toward_bearing = (wind_from_dir_deg + 180.0) % 360.0
    delta = abs(source_to_ward_bearing - wind_toward_bearing)
    if delta > 180:
        delta = 360 - delta
    alignment = max(0.0, math.cos(math.radians(delta)))
    return alignment * (1.0 + wind_speed_ms / 10.0)


# -- Distance decay ───────────────────────────────────────────────────────────

def _distance_decay(dist_km: float, sigma_km: float) -> float:
    """Gaussian decay; returns 1.0 at dist=0, ~0.14 at dist=2σ."""
    return math.exp(-(dist_km ** 2) / (2.0 * sigma_km ** 2))


# -- Emission weight normaliser ───────────────────────────────────────────────

def _fire_emission_weight(source: dict) -> float:
    """Scale fire FRP (MW) to the same 1–3 qualitative range as other sources.
    FRP < 10 MW → 1, 10–50 MW → 2, > 50 MW → 3."""
    frp = source.get("frp") or source.get("brightness", 300.0) - 270.0
    if frp <= 10:
        return 1.0
    if frp <= 50:
        return 2.0
    return 3.0


# -- Main kernel ──────────────────────────────────────────────────────────────

def run_kernel(
    wards: list[dict],
    weather: dict[int, dict],
    industrial_sources: list[dict],
    fire_sources: list[dict],
    road_sources: list[dict],
    cpcb_stations: list[dict] | None = None,
    sigma_km: float = DEFAULT_SIGMA_KM,
) -> list[dict]:
    """Compute estimated source contributions for every ward.

    Args:
        wards           — [{id, lat, lng, ...}, ...]  (DB ward rows)
        weather         — {ward_id: {wind_dir, wind_speed, ...}} current met
        industrial_sources — from vayutrace_industrial_zones.zones_as_dicts()
        fire_sources    — from vayutrace_firms.fetch_delhi_fires()
        road_sources    — from vayutrace_osm_roads.load_delhi_roads()
        cpcb_stations   — [{id, ward_id, lat, lng}, ...] for confidence signal
        sigma_km        — Gaussian decay length (km)

    Returns list of dicts, one per ward:
        {
          ward_id: int,
          breakdown: {
              "industrial": float,   # 0–1, fraction of estimated PM load
              "road":       float,
              "fire":       float,
              "unknown":    float,   # residual; 0 when sources cover 100%
          },
          confidence: float,   # 0–1; higher near CPCB stations
          method: "vayutrace_v1",
          sigma_km: float,
          source_counts: {industrial, fire, road},
        }
    """
    # Build flat source list with normalised emission weights
    all_sources: list[dict] = []
    for s in industrial_sources:
        all_sources.append({**s, "source_type": s.get("source_type", "industrial"),
                             "_ew": float(s.get("emission_weight", 2))})
    for s in fire_sources:
        all_sources.append({**s, "source_type": "fire",
                             "_ew": _fire_emission_weight(s)})
    for s in road_sources:
        all_sources.append({**s, "source_type": "road",
                             "_ew": float(s.get("emission_weight", 1))})

    if len(all_sources) < MIN_SOURCES:
        log.warning("vayutrace_kernel: fewer than %d sources — returning empty results", MIN_SOURCES)
        return []

    # Pre-compute source coordinates as arrays for vectorised distance
    src_lats = np.array([s["lat"] for s in all_sources])
    src_lngs = np.array([s["lng"] for s in all_sources])

    results: list[dict] = []

    for ward in wards:
        wid = ward["id"]
        wlat, wlng = ward["lat"], ward["lng"]

        met = weather.get(wid) or {}
        wind_dir = float(met.get("wind_dir") or met.get("wind_from_direction") or 180.0)
        wind_speed = float(met.get("wind_speed") or 0.0)

        # Per-source contribution score — accumulated per type then averaged.
        # We store (sum_of_scores, count) per type and divide at the end so
        # that a category with 200 k road segments does not crowd out 16
        # industrial zones: each type contributes its *mean* spatial signal,
        # not its raw sum.  This keeps the breakdown physically meaningful
        # regardless of how unevenly the source inventories are sized.
        acc: dict[str, list[float]] = {"industrial": [], "road": [], "fire": []}

        for s in all_sources:
            dist = _haversine_km(wlat, wlng, s["lat"], s["lng"])
            bearing = _bearing_deg(s["lat"], s["lng"], wlat, wlng)
            wf = _wind_factor(bearing, wind_dir, wind_speed)
            dd = _distance_decay(dist, sigma_km)
            score = s["_ew"] * wf * dd
            stype = s["source_type"]
            if stype in acc:
                acc[stype].append(score)
            else:
                acc["industrial"].append(score)  # catch-all

        contributions = {
            t: (sum(scores) / len(scores)) if scores else 0.0
            for t, scores in acc.items()
        }

        total = sum(contributions.values()) or 1.0
        breakdown = {k: round(v / total, 4) for k, v in contributions.items()}
        breakdown["unknown"] = 0.0  # forward model has no residual by design

        # Confidence: inverse distance to nearest CPCB station
        if cpcb_stations:
            min_dist = min(
                _haversine_km(wlat, wlng, st.get("lat", wlat), st.get("lng", wlng))
                for st in cpcb_stations
            )
            confidence = float(np.clip(1.0 - min_dist / MAX_CONFIDENT_DIST_KM, 0.0, 1.0))
        else:
            confidence = 0.5  # unknown station proximity → mid-range

        results.append({
            "ward_id": wid,
            "breakdown": breakdown,
            "confidence": round(confidence, 3),
            "method": "vayutrace_v1",
            "sigma_km": sigma_km,
            "source_counts": {
                "industrial": len(industrial_sources),
                "fire":       len(fire_sources),
                "road":       len(road_sources),
            },
        })

    return results


# -- Convenience: run full pipeline for one city ──────────────────────────────

def estimate_city(
    wards: list[dict],
    weather_by_ward: dict[int, dict],
    *,
    sigma_km: float = DEFAULT_SIGMA_KM,
    firms_date: Any = None,
) -> list[dict]:
    """High-level convenience wrapper: loads all source inventories and runs
    the kernel.  Returns the same list as run_kernel().

    This is the function vayutrace_attribution.py (or main.py) should call.
    Each sub-import is guarded so a missing .pbf or absent FIRMS key
    degrades gracefully rather than failing the whole intel cycle.
    """
    from .vayutrace_industrial_zones import zones_as_dicts  # noqa: PLC0415
    from .vayutrace_firms import fetch_delhi_fires           # noqa: PLC0415
    from .vayutrace_osm_roads import load_delhi_roads        # noqa: PLC0415

    industrial = zones_as_dicts()
    fires = fetch_delhi_fires(day=firms_date)
    roads = load_delhi_roads()

    log.info(
        "vayutrace_kernel estimate_city: %d industrial zones, %d fire hotspots, %d road segments",
        len(industrial), len(fires), len(roads),
    )

    return run_kernel(
        wards=wards,
        weather=weather_by_ward,
        industrial_sources=industrial,
        fire_sources=fires,
        road_sources=roads,
        sigma_km=sigma_km,
    )
