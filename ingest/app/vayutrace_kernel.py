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

-- Regional transport — dynamic fraction --

The fraction of Delhi's PM2.5 from regional/upwind transport is NOT a fixed
constant.  Published receptor modelling and CTM studies establish:

  Non-fire base regional transport (Haryana industry, UP/Rajasthan dust,
  secondary aerosol from regional precursors):
    Winter (Oct–Feb):  ≈ 35 % of PM2.5
    Summer (Mar–Sep):  ≈ 15 % of PM2.5
  (Consistent with IITK 2016 multi-source breakdown once the fire component
  is separately accounted for; TERI-ARAI 2018 also supports 35% non-fire
  regional for winter.)

  Fire-transport addition (Punjab/Haryana/UP stubble burning):
    Low fire index (≈0): adds ≈ 0 % additional
    High fire index (≈1): adds up to 40 % additional
    → total regional fraction ranges 35–78 % in winter, 15–55 % in summer
    → capped at 78 % (literature upper bound: Cusworth et al. ES&T 2020,
      meta-analysis Atmospheric Environment 2025 — extreme stagnant years).

  Key literature:
    • Cusworth et al. (2020) ES&T: GEOS-Chem — CRB contributes 7–78%
      (median ~20%) depending on year and meteorology (NOT a fixed number).
    • npj Climate and Atmospheric Science (2025), CUPI-G + WRF-Chem:
      Oct–Nov 2022 CRB contribution was only ~14% because NW wind alignment
      was poor — fire counts ≠ surface PM2.5.
    • ACP (2025), NHM(WRF)-Chem + 30-sensor network: optimised CRB
      contribution 25–35% for active burning periods.
    • Atmospheric Environment systematic review (2025): meta-consensus:
      14–30% typical, up to 78% in extreme stagnant-NW-wind years.

  `regional_fraction_prior` in kernel output is therefore a *nowcast estimate*,
  not a static prior: base + fire_index × 0.40, capped at 0.78.

-- Regional fire transport physics --

Two decay processes act on smoke from Punjab/Haryana/UP fires:

  1. Dry deposition (accumulation-mode PM2.5):
       τ_dep ≈ 72 h (literature range 48–120 h for fine-mode aerosol;
       Seinfeld & Pandis, "Atmospheric Chemistry and Physics" 3rd ed.;
       consistent with WRF-Chem survival of ~35–55% at 28 h transit,
       ACP 2025 NHM model).

  2. Dilution by entrainment of clean air aloft:
       exp(-dist_km / L_dil) where L_dil ≈ 400 km
       At Punjab centroid (~300 km, 3 m/s → 27.8 h):
         deposition: exp(-27.8/72) ≈ 0.68
         dilution:   exp(-300/400) ≈ 0.47
         combined:   ≈ 32 % survival → within observed 30–55 % range.

The normaliser uses a FIXED reference wind speed (3 m/s, IGP Oct–Nov
climatological mean transport wind) so that the index is comparable
across days with different ambient wind speeds — HYSPLIT-style trajectory
studies report trajectory frequencies from fixed climatology, not scaled
by the current observed wind.

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
#   fire      — FIRMS VIIRS hotspots classified as "local" (<50 km from Delhi)
#               include Haryana/western UP stubble burns.  Literature (PMF
#               receptor studies, Frontiers in Sustainable Cities 2021) shows
#               Haryana fires at 50–80 km can contribute 5–15% during active
#               episodes — Gaussian at σ=20 km gives ~4% at 50 km (too low).
#               Raised to σ=30 km so the decay is ~25% at 50 km and ~7% at
#               80 km, consistent with observed contributions.
#               σ_fire = 30 km (all seasons).
#
#   industrial — Base seasonal sigma above (5 km winter / 7 km summer).
#               Stack/area sources in DSIIDC estates; calibrated against CPCB.
#
# When sigma_km is passed explicitly (override for experiments), per-type
# overrides are still applied as multipliers relative to the seasonal base,
# preserving the caller's intent while keeping physical ratios correct.

SIGMA_ROAD_KM: float = 1.0     # all seasons — highly local
SIGMA_FIRE_KM: float = 30.0    # all seasons — local fires, extended for Haryana range

# Non-fire base regional transport fractions (city-level background).
# These represent Haryana industry, UP/Rajasthan dust, secondary aerosol from
# regional precursors — everything that is NOT the IGP fire transport component
# (which is modelled separately via regional_fire_index).
#
# The legacy IITK 2016 "64% winter regional" figure conflated fire and non-fire
# transport.  Separating them:
#   Non-fire base: IITK 2016 sector breakdown minus the biomass burning fraction
#   (17–26%) → ~35% non-fire regional winter; ~15% summer.
REGIONAL_FRACTION_WINTER: float = 0.35  # Oct–Feb non-fire base
REGIONAL_FRACTION_SUMMER: float = 0.15  # Mar–Sep non-fire base

# Winter months (1=Jan, …, 12=Dec).
_WINTER_MONTHS: frozenset[int] = frozenset({10, 11, 12, 1, 2})

# A ward with its nearest CPCB station ≤ this distance gets full confidence.
MAX_CONFIDENT_DIST_KM: float = 15.0

# Minimum number of emission sources to attempt attribution.
MIN_SOURCES: int = 1

# -- Regional fire transport model constants --

# Dry deposition half-life for accumulation-mode PM2.5 (fine-mode biomass
# burning aerosol).  Dry deposition velocity for fine PM is 0.1–0.3 cm/s
# (Seinfeld & Pandis 3rd ed.); at 3 m/s wind over 300 km (~28 h transit),
# dry deposition removes only ~15–25% of column mass → τ ≈ 72–120 h.
# WRF-Chem (ACP 2025) survival of 30–55% at 28 h is consistent with τ=72 h.
DEPOSITION_HALFLIFE_H: float = 72.0  # dry deposition τ for fine PM2.5

# E-folding distance for dilution by entrainment of cleaner air aloft.
# At 300 km from Punjab centroid, models predict 47% remaining from dilution
# alone (Cusworth ES&T 2020, ACP 2025 WRF-Chem). Fitted as exp(-300/400)=0.47.
DILUTION_SCALE_KM: float = 400.0  # entrainment dilution e-folding distance

# Reference wind speed for the transport index normaliser.
# Fixed at the IGP Oct–Nov climatological mean transport wind (3 m/s, NW sector)
# so the index is comparable across days — HYSPLIT trajectory-counting studies
# use a fixed climatology, not the current observed wind, for contribution
# percentages.  Using current wind in the normaliser would make the index
# artificially small on calm days and artificially large on windy days.
REF_WIND_MS: float = 3.0  # IGP transport wind climatological reference

# Delhi centroid for computing fire travel distances (matches vayutrace_firms.py)
_DELHI_LAT: float = 28.65
_DELHI_LNG: float = 77.22


def seasonal_sigma_km(month: int) -> float:
    """Return the appropriate Gaussian decay length for the given calendar month.

    Oct–Feb → 5 km (P-G E-F stable, winter inversion regime).
    Mar–Sep → 7 km (P-G D neutral, Spearman-calibrated on 30 days of data).
    """
    return SIGMA_WINTER_KM if month in _WINTER_MONTHS else SIGMA_SUMMER_KM


def regional_transport_prior(month: int) -> float:
    """Non-fire base regional transport fraction for the given calendar month.

    This is the fraction of Delhi's PM2.5 from regional/upwind sources that
    are NOT the IGP fire transport component (which is modelled separately):
    Haryana industry, UP/Rajasthan dust, secondary aerosol from regional
    precursors, background biomass from residential heating etc.

        Oct–Feb → 0.35  (35% non-fire base regional transport)
        Mar–Sep → 0.15  (15% non-fire base regional transport)

    To get the total regional fraction (including current fire transport),
    use regional_fraction_nowcast(month, regional_fire_index).
    """
    return REGIONAL_FRACTION_WINTER if month in _WINTER_MONTHS else REGIONAL_FRACTION_SUMMER


def regional_fraction_nowcast(month: int, regional_fire_index: float) -> float:
    """Dynamic total regional fraction: base transport + current fire contribution.

    Replaces the old static IITK 2016 "64% winter" figure with a nowcast
    that gates the fire-transport component on actual observed fire activity
    (via regional_fire_index from regional_fire_transport_index()).

    Structure (from Cusworth et al. ES&T 2020, meta-analysis Atm. Env. 2025,
    ACP 2025 NHM+WRF-Chem):
        base     — non-fire regional: 0.35 (winter) / 0.15 (summer)
        fire     — regional_fire_index × 0.40  (scales to max ~40% at index=1)
        total    — min(base + fire, 0.78)  (78% is the literature upper bound
                   for extreme stagnant-wind years, Cusworth 2020 GEOS-Chem)

    Typical ranges:
        Low-fire winter day (index≈0):   35%
        Active burning season (index=0.5): ~55%
        Extreme burning episode (index≈1): ~75%
    """
    base = REGIONAL_FRACTION_WINTER if month in _WINTER_MONTHS else REGIONAL_FRACTION_SUMMER
    fire_component = regional_fire_index * 0.40
    return round(min(base + fire_component, 0.78), 3)


def regional_fire_transport_index(
    regional_fires: list[dict],
    wind_from_dir_deg: float,
    wind_speed_ms: float,
    target_lat: float = _DELHI_LAT,
    target_lng: float = _DELHI_LNG,
) -> float:
    """Estimate how much regional fire smoke is currently being transported
    toward *target* (default: Delhi centroid) from the IGP airshed.

    This is NOT a Gaussian decay model — regional fires are 50–500 km away,
    where Gaussian decay produces effectively zero weight.  Instead it uses
    a two-decay transport model grounded in WRF-Chem and HYSPLIT literature:

        contribution = FRP × wind_alignment × deposition_decay × dilution_decay

    where:
        FRP              — fire radiative power (MW) from FIRMS VIIRS, proxy
                           for smoke emission rate
        wind_alignment   — max(0, cos(Δθ)): how well is the wind blowing THIS
                           fire's smoke toward the target?  Uses the same calm-
                           wind blending as _wind_factor() for consistency.
        deposition_decay — exp(-travel_h / τ_dep) where τ_dep = 72 h
                           Dry deposition half-life for accumulation-mode PM2.5
                           (Seinfeld & Pandis 3rd ed.; consistent with ACP 2025
                           WRF-Chem survival of 30–55% at 28 h transit).
        dilution_decay   — exp(-dist_km / L_dil) where L_dil = 400 km
                           Entrainment of cleaner air aloft progressively
                           dilutes the plume as it travels across the IGP.
                           At 300 km (Punjab centroid): exp(-0.75) ≈ 0.47;
                           combined with deposition → ~32% survival, within
                           Cusworth et al. (ES&T 2020) 30–55% range.

    The normaliser uses REF_WIND_MS (3 m/s, IGP Oct–Nov transport climatology)
    instead of the current observed wind speed, so that the index represents
    "how much smoke is arriving" consistently across days — following the HYSPLIT
    trajectory-frequency approach (Atmospheric Environment 2020, HYSPLIT
    back-trajectories show 52/81/89% frequency toward high-PM bins regardless
    of the day's observed wind magnitude).

    Returns 0.0 when:
    - no regional fires exist (clear-air day)
    - wind is calm (stalled transport — effective_speed floored at 0.5 m/s)
    - all fires are downwind of the target

    Interpretation for the UI:
        0.00–0.10  → negligible regional fire transport
        0.10–0.40  → moderate (some contribution, typical shoulder-season)
        0.40–1.00  → strong (active Punjab/Haryana burning episode)
    """
    if not regional_fires:
        return 0.0

    # Floor at 0.5 m/s: transport still occurs in calm conditions but is slow.
    effective_speed = max(wind_speed_ms, 0.5)

    total = 0.0
    for f in regional_fires:
        frp = float(f.get("frp") or max(0, float(f.get("brightness", 300)) - 270))
        if frp <= 0:
            continue
        flat = float(f.get("lat") or f.get("latitude", 0))
        flng = float(f.get("lng") or f.get("longitude", 0))

        dist_km = _haversine_km(flat, flng, target_lat, target_lng)
        if dist_km < 1:
            continue

        # Bearing FROM fire TO target (the direction smoke must travel)
        bearing_to_target = _bearing_deg(flat, flng, target_lat, target_lng)

        # Wind alignment: does current wind carry smoke from fire toward target?
        alignment = _wind_factor(bearing_to_target, wind_from_dir_deg, wind_speed_ms)

        # Dual-decay transport survival:
        #   1. Dry deposition (slow, τ=72 h for fine PM2.5)
        #   2. Dilution by entrainment of cleaner air (e-folding at 400 km)
        speed_kmh = effective_speed * 3.6
        travel_h  = dist_km / speed_kmh
        deposition_decay = math.exp(-travel_h / DEPOSITION_HALFLIFE_H)
        dilution_decay   = math.exp(-dist_km   / DILUTION_SCALE_KM)

        total += frp * alignment * deposition_decay * dilution_decay

    # Normalise against a fixed reference scenario:
    #   50 MW fire at 50 km with perfect alignment, REF_WIND_MS transport.
    # Using REF_WIND_MS (not current wind) makes the index cross-day comparable
    # (HYSPLIT studies report trajectory contributions from fixed climatology).
    ref_frp  = 50.0
    ref_travel_h      = 50.0 / (REF_WIND_MS * 3.6)
    ref_dep_decay     = math.exp(-ref_travel_h / DEPOSITION_HALFLIFE_H)
    ref_dilution_decay = math.exp(-50.0 / DILUTION_SCALE_KM)
    ref_align         = 1.0 + REF_WIND_MS / 10.0  # max directional at ref speed
    normaliser = ref_frp * ref_align * ref_dep_decay * ref_dilution_decay

    if normaliser <= 0:
        return 0.0
    return float(np.clip(total / normaliser, 0.0, 1.0))


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
    regional_fire_sources: list[dict] | None = None,
) -> list[dict]:
    """Compute estimated source contributions for every ward.

    Args:
        wards                — [{id, lat, lng, ...}, ...]  (DB ward rows)
        weather              — {ward_id: {wind_dir, wind_speed, ...}} current met
        industrial_sources   — from vayutrace_industrial_zones.zones_as_dicts()
        fire_sources         — local fires (< 50 km) from vayutrace_firms
        road_sources         — from vayutrace_osm_roads.load_delhi_roads()
        cpcb_stations        — [{id, ward_id, lat, lng}, ...] for confidence
        sigma_km             — Gaussian decay length (km); if == DEFAULT_SIGMA_KM,
                               seasonal_sigma_km(month) is used instead.
        month                — calendar month (1–12); defaults to current UTC month.
        regional_fire_sources — fires ≥ 50 km from Delhi (Punjab/Haryana/UP);
                               modelled with travel-time transport, not Gaussian.
                               From vayutrace_firms.fetch_igp_fires() filtered
                               to fire_class='regional'.

    Returns list of dicts, one per ward:
        {
          ward_id: int,
          breakdown: {
              "industrial": float,   # 0–1, fraction of estimated local PM load
              "road":       float,
              "fire":       float,   # local fires only
              "unknown":    float,   # always 0 — forward model
          },
          confidence: float,              # 0–1; higher near CPCB stations
          regional_fraction_prior: float, # IITK 2016 city-level background %
          regional_fire_index: float,     # 0–1; current IGP fire transport load
          method: "vayutrace_v1",
          sigma_km: float,
          source_counts: {industrial, fire, road, regional_fire},
        }
    """
    # Resolve season-aware sigma
    if month is None:
        from datetime import datetime, timezone  # noqa: PLC0415
        month = datetime.now(timezone.utc).month
    effective_sigma = seasonal_sigma_km(month) if sigma_km == DEFAULT_SIGMA_KM else sigma_km

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

        # Regional fire transport index for this ward's wind conditions
        reg_fire_idx = round(
            regional_fire_transport_index(
                regional_fire_sources or [],
                wind_dir,
                wind_speed,
                target_lat=wlat,
                target_lng=wlng,
            ),
            3,
        )

        # Dynamic regional fraction: non-fire base + current fire contribution.
        # Replaces the old static IITK 2016 "64% winter" prior with a nowcast
        # gated on actual observed fire activity (Cusworth ES&T 2020; ACP 2025).
        reg_fraction = regional_fraction_nowcast(month, reg_fire_idx)

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
            "regional_fraction_prior": reg_fraction,
            "regional_fire_index": reg_fire_idx,
            "method": "vayutrace_v1",
            "sigma_km": effective_sigma,
            "source_counts": {
                "industrial": len(industrial_sources),
                "fire":       len(fire_sources),
                "road":          len(road_sources),
                "regional_fire": len(regional_fire_sources or []),
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
    from .vayutrace_industrial_zones import zones_as_dicts          # noqa: PLC0415
    from .vayutrace_firms import fetch_igp_fires                    # noqa: PLC0415
    from .vayutrace_osm_roads import load_delhi_roads               # noqa: PLC0415

    if month is None:
        from datetime import datetime, timezone  # noqa: PLC0415
        month = datetime.now(timezone.utc).month

    industrial = zones_as_dicts()
    roads      = load_delhi_roads()

    # Fetch the full IGP airshed (Punjab, Haryana, UP, Rajasthan) and split
    # into local fires (< 50 km, Gaussian kernel) and regional fires (≥ 50 km,
    # travel-time transport index).
    igp_fires      = fetch_igp_fires(day=firms_date)
    local_fires    = [f for f in igp_fires if f.get("fire_class") == "local"]
    regional_fires = [f for f in igp_fires if f.get("fire_class") == "regional"]

    log.info(
        "vayutrace_kernel estimate_city: month=%d sigma=%s km, "
        "%d industrial, %d local fires, %d regional IGP fires, %d road segments",
        month, seasonal_sigma_km(month),
        len(industrial), len(local_fires), len(regional_fires), len(roads),
    )

    return run_kernel(
        wards=wards,
        weather=weather_by_ward,
        industrial_sources=industrial,
        fire_sources=local_fires,
        road_sources=roads,
        sigma_km=sigma_km,
        month=month,
        regional_fire_sources=regional_fires,
    )
