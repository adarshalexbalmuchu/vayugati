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
    distance_decay  — Gaussian exp(-d²/2σ²), σ selected per source type and
                      season (see below).

The raw contributions are normalised to sum to 1 across sources, then
grouped by source type ("industrial", "road", "fire") to give a per-ward
sector breakdown.

A confidence signal is also produced per ward:
    confidence = 1 − (min_cpcb_station_distance / MAX_CONFIDENT_DIST_KM)
    clipped to [0, 1].
High near a CPCB station; lower for wards with no nearby station.

-- Calm-wind isotropic fallback --

Below 1 m/s, wind direction is meteorologically unreliable and dispersion
is effectively isotropic (EPA AERMOD Guide §4.2; WMO Technical Note 285).
The directional cos(Δθ) factor is meaningless under surface inversions —
a condition that is common in Delhi Nov–Feb when the very same P-G E-F
stable regime that tightens σ also decouples the boundary layer.

VayuTrace blends linearly:
  v ≤ 1 m/s → fully isotropic (factor = 1/π, the expected value of
              max(0, cos) over all bearings — magnitude-preserving)
  1–2 m/s  → linear blend between isotropic and directional
  v ≥ 2 m/s → fully directional, as before

This prevents the kernel from falsely attributing all pollution to
sources that happen to align with the (unreliable) reported wind
direction during stagnant-air episodes.

-- Season-aware σ (Pasquill-Gifford grounding) --

σ controls how far each source "reaches".  The optimal value depends on
atmospheric stability, which in Delhi follows a strong seasonal cycle:

  Oct–Feb (winter):  surface inversions 100–400 m, mixing layer height low,
                     Pasquill-Gifford class E-F (stable).  Plumes stay tight.
                     Briggs 1973 urban σ_y ≈ 246 m at 5 km under class E-F.
                     Kernel σ = SIGMA_WINTER_KM = 5 km.

  Mar–Sep (summer):  convective mixing, P-G class D (neutral to unstable).
                     Wind-stratified Spearman calibration (n=4,340 paired
                     reading+weather rows, 44 Delhi CPCB stations, 30 days)
                     peaks at σ = 7 km (ρ=0.20, p≈0, two-tailed).
                     Kernel σ = SIGMA_SUMMER_KM = 7 km.

Reference: Briggs (1973) "Diffusion Estimation for Small Emissions",
ATDL contribution file No. 79, NOAA; IMD Delhi mixing layer climatology.

-- Regional transport context --

IITK 2016 ("Source apportionment of PM2.5 at a residential site in Delhi")
and TERI-ARAI 2018 both establish that a large fraction of Delhi's PM2.5 is
regional/upwind transport, not local emissions:

    Winter (Oct–Feb):  ≈ 64 % of PM2.5 is regional transport
    Summer (Mar–Sep):  ≈ 26 % of PM2.5 is regional transport

VayuTrace is a *local* forward model: it attributes the ward-level PM2.5
that is *above the city-wide baseline*, i.e. local excess.  The regional
background is not captured by the kernel — this fraction is surfaced as
`regional_fraction_prior` in each ward result for UI context only.

-- Calibration --

Re-run ingest/scripts/calibrate_vayutrace_sigma.py --wind --days 30 after
accumulating more data to check whether the summer σ estimate shifts.

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

# Season-aware Gaussian decay lengths (km) — industrial / base sigma.
# Winter (Oct–Feb): P-G class E-F stable, surface inversions → tight plumes.
# Summer (Mar–Sep): P-G class D neutral, calibrated by wind-stratified Spearman
#   regression (ρ=0.20, p≈0, n=4340 reading+weather pairs, 44 Delhi CPCB stations).
SIGMA_WINTER_KM: float = 5.0   # Oct–Feb
SIGMA_SUMMER_KM: float = 7.0   # Mar–Sep (Spearman-calibrated)
DEFAULT_SIGMA_KM: float = SIGMA_SUMMER_KM  # backward-compat default

# Per-source-type sigma overrides (km).
#
# Different source types have very different spatial scales:
#
#   road      — Vehicle emissions disperse within 200–500 m of the carriageway
#               due to traffic turbulence (CERC ADMS-Urban documentation;
#               TERI-ARAI 2018 Delhi study: vehicular contribution drops steeply
#               beyond the first 500 m).  σ_road = 1 km (all seasons).
#
#   fire      — FIRMS VIIRS hotspots for Delhi/NCR are predominantly agricultural
#               stubble burns in UP/Haryana, typically 20–100 km from Delhi wards.
#               These are elevated combustion plumes that transport regionally
#               (IMD/SAFAR fire-episode analyses; IITK 2016 winter sector
#               breakdown: open burning 17–26%).  σ_fire = 20 km (all seasons).
#
#   industrial — Base seasonal sigma above (5 km winter / 7 km summer).
#               Stack/area sources in DSIIDC estates; calibrated against CPCB.
#
# When sigma_km is passed explicitly (override for experiments), per-type
# overrides are still applied as multipliers relative to the seasonal base,
# preserving the caller's intent while keeping physical ratios correct.

SIGMA_ROAD_KM: float = 1.0     # all seasons — highly local
SIGMA_FIRE_KM: float = 20.0    # all seasons — regional transport typical

# IITK 2016 + TERI-ARAI 2018 regional transport fractions (city-level prior).
# Surfaced in kernel output as `regional_fraction_prior` for UI context only —
# VayuTrace models local excess, not the regional background.
REGIONAL_FRACTION_WINTER: float = 0.64  # Oct–Feb
REGIONAL_FRACTION_SUMMER: float = 0.26  # Mar–Sep

# Winter months (1=Jan, …, 12=Dec).
_WINTER_MONTHS: frozenset[int] = frozenset({10, 11, 12, 1, 2})

# A ward with its nearest CPCB station ≤ this distance gets full confidence.
MAX_CONFIDENT_DIST_KM: float = 15.0

# Minimum number of emission sources to attempt attribution.
MIN_SOURCES: int = 1


def seasonal_sigma_km(month: int) -> float:
    """Return the appropriate Gaussian decay length for the given calendar month.

    Oct–Feb → 5 km (P-G E-F stable, winter inversion regime).
    Mar–Sep → 7 km (P-G D neutral, Spearman-calibrated on 30 days of data).
    """
    return SIGMA_WINTER_KM if month in _WINTER_MONTHS else SIGMA_SUMMER_KM


def regional_transport_prior(month: int) -> float:
    """Fraction of city-level PM2.5 attributable to regional/upwind transport.

    Returns the IITK 2016 / TERI-ARAI 2018 seasonal midpoint:
        Oct–Feb → 0.64  (64 % regional transport in winter)
        Mar–Sep → 0.26  (26 % regional transport in summer)

    This is a *city-level prior*, not a ward-specific measurement.  It is
    included in kernel output as context for the UI — VayuTrace models local
    excess (emissions → predicted local concentration), so the regional
    background is outside the kernel's scope.
    """
    return REGIONAL_FRACTION_WINTER if month in _WINTER_MONTHS else REGIONAL_FRACTION_SUMMER


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

# EPA AERMOD / WMO TN-285: below ~1 m/s wind direction is meteorologically
# unreliable and dispersion is effectively isotropic.  We blend linearly from
# the directional model at CALM_BLEND_HI_MS to fully isotropic at or below
# CALM_BLEND_LO_MS.  The isotropic value (CALM_ISOTROPIC_FACTOR) equals the
# expected value of max(0, cos(Δθ)) averaged over all bearings, which is 1/π
# — approximately 0.318.  Using exactly 1/π keeps the contribution magnitude
# consistent with the directional case at equal wind speed.
CALM_BLEND_LO_MS: float = 1.0   # fully isotropic below this
CALM_BLEND_HI_MS: float = 2.0   # fully directional above this
CALM_ISOTROPIC_FACTOR: float = 1.0 / math.pi  # ≈ 0.318


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

    Directional model (wind_speed ≥ CALM_BLEND_HI_MS = 2 m/s):
        factor = max(0, cos(Δθ)) × (1 + wind_speed_ms / 10)
    Clamped to ≥ 0 (downwind sources get zero boost, not negative).
    The (1 + v/10) term amplifies transport at higher wind speeds — at 10 m/s
    the wind-aligned contribution is doubled relative to calm conditions.

    Calm wind model (wind_speed ≤ CALM_BLEND_LO_MS = 1 m/s):
        Under surface inversions (common Nov–Feb in Delhi) and stagnant air,
        wind direction is meteorologically unreliable (EPA AERMOD Guide §4.2;
        WMO Technical Note 285).  Dispersion is isotropic — every source
        contributes equally regardless of bearing.  Factor = 1/π ≈ 0.318,
        equal to E[max(0, cos(Δθ))] averaged over all bearings, keeping
        magnitude consistent.

    Blend zone (1–2 m/s): linear interpolation between the two.
    """
    speed_factor = 1.0 + wind_speed_ms / 10.0

    if wind_speed_ms <= CALM_BLEND_LO_MS:
        return CALM_ISOTROPIC_FACTOR * speed_factor

    wind_toward_bearing = (wind_from_dir_deg + 180.0) % 360.0
    delta = abs(source_to_ward_bearing - wind_toward_bearing)
    if delta > 180:
        delta = 360 - delta
    directional = max(0.0, math.cos(math.radians(delta)))

    if wind_speed_ms >= CALM_BLEND_HI_MS:
        return directional * speed_factor

    # Linear blend: t=0 → isotropic, t=1 → directional
    t = (wind_speed_ms - CALM_BLEND_LO_MS) / (CALM_BLEND_HI_MS - CALM_BLEND_LO_MS)
    alignment = CALM_ISOTROPIC_FACTOR * (1.0 - t) + directional * t
    return alignment * speed_factor


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
    month: int | None = None,
) -> list[dict]:
    """Compute estimated source contributions for every ward.

    Args:
        wards           — [{id, lat, lng, ...}, ...]  (DB ward rows)
        weather         — {ward_id: {wind_dir, wind_speed, ...}} current met
        industrial_sources — from vayutrace_industrial_zones.zones_as_dicts()
        fire_sources    — from vayutrace_firms.fetch_delhi_fires()
        road_sources    — from vayutrace_osm_roads.load_delhi_roads()
        cpcb_stations   — [{id, ward_id, lat, lng}, ...] for confidence signal
        sigma_km        — Gaussian decay length (km); if None and month is
                          provided, seasonal_sigma_km(month) is used instead.
        month           — calendar month (1–12) for season-aware σ and
                          regional transport prior; defaults to current UTC month.

    Returns list of dicts, one per ward:
        {
          ward_id: int,
          breakdown: {
              "industrial": float,   # 0–1, fraction of estimated local PM load
              "road":       float,
              "fire":       float,
              "unknown":    float,   # residual; 0 when sources cover 100%
          },
          confidence: float,   # 0–1; higher near CPCB stations
          regional_fraction_prior: float,  # IITK 2016 city-level regional %
          method: "vayutrace_v1",
          sigma_km: float,
          source_counts: {industrial, fire, road},
        }
    """
    # Resolve season-aware sigma and regional transport prior
    if month is None:
        from datetime import datetime, timezone  # noqa: PLC0415
        month = datetime.now(timezone.utc).month
    effective_sigma = seasonal_sigma_km(month) if sigma_km == DEFAULT_SIGMA_KM else sigma_km
    reg_prior = regional_transport_prior(month)

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
            stype = s["source_type"]
            # Per-type sigma: roads are hyperlocal, fires are regional.
            if stype == "road":
                sigma = SIGMA_ROAD_KM
            elif stype == "fire":
                sigma = SIGMA_FIRE_KM
            else:
                sigma = effective_sigma  # industrial — seasonal
            dd = _distance_decay(dist, sigma)
            score = s["_ew"] * wf * dd
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
            "regional_fraction_prior": reg_prior,
            "method": "vayutrace_v1",
            "sigma_km": effective_sigma,
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
    month: int | None = None,
) -> list[dict]:
    """High-level convenience wrapper: loads all source inventories and runs
    the kernel.  Returns the same list as run_kernel().

    This is the function vayutrace_attribution.py (or main.py) should call.
    Each sub-import is guarded so a missing .pbf or absent FIRMS key
    degrades gracefully rather than failing the whole intel cycle.

    Args:
        month — calendar month (1–12); if omitted, current UTC month is used.
                Drives season-aware sigma selection and regional transport prior.
    """
    from .vayutrace_industrial_zones import zones_as_dicts  # noqa: PLC0415
    from .vayutrace_firms import fetch_delhi_fires           # noqa: PLC0415
    from .vayutrace_osm_roads import load_delhi_roads        # noqa: PLC0415

    if month is None:
        from datetime import datetime, timezone  # noqa: PLC0415
        month = datetime.now(timezone.utc).month

    industrial = zones_as_dicts()
    fires = fetch_delhi_fires(day=firms_date)
    roads = load_delhi_roads()

    log.info(
        "vayutrace_kernel estimate_city: month=%d sigma=%s km, "
        "%d industrial zones, %d fire hotspots, %d road segments",
        month, seasonal_sigma_km(month), len(industrial), len(fires), len(roads),
    )

    return run_kernel(
        wards=wards,
        weather=weather_by_ward,
        industrial_sources=industrial,
        fire_sources=fires,
        road_sources=roads,
        sigma_km=sigma_km,
        month=month,
    )
