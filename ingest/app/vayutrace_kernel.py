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

#   dust      — Resuspended road dust and construction dust are mechanically
#               generated at ground level and are markedly coarser than
#               combustion aerosol, so they deposit close to source. Even
#               the PM2.5 fraction modelled here (AP-42 k factor) originates
#               from a coarse-dominated size distribution and behaves more
#               locally than a buoyant stack plume.
#
#               Set slightly wider than roads (1 km) because construction
#               sites are area sources rather than line sources, but well
#               inside the industrial seasonal sigma (5-7 km). This ordering
#               — road < dust < industrial < fire — is the physically
#               defensible part; the specific 1.5 km is an engineering
#               choice, not a calibrated value, and is a natural candidate
#               for the validation harness to sweep.
SIGMA_DUST_KM: float = 1.5

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

# -- Atmospheric dilution (ventilation) --------------------------------------
#
# Added Sept 2026 after the validation harness (scripts/validate_vayutrace.py)
# measured, against ~5,300 matched ward-hours of real CPCB readings, that the
# kernel had NO dynamic skill whatsoever: within-ward Spearman rho = -0.054,
# i.e. it could not predict when a given ward would get worse, and the
# directional wind factor was the ONLY term making output vary over time.
#
# Measured alternatives, same wards/hours, within-ward median rho:
#     current model (directional wind factor only)      -0.054
#     1 / wind_speed alone                              +0.084
#     1 / boundary_layer_height alone                   +0.169
#     geometry / boundary_layer_height                  +0.102
#     geometry / ventilation_coefficient                +0.198   <-- adopted
#     geometry x wind_factor / boundary_layer_height    +0.036
#
# The physical reading: at ward scale with hourly data, HOW MUCH ATMOSPHERE
# the emissions are diluted into dominates WHICH DIRECTION they came from.
# Ventilation coefficient (VC = PBLH x wind_speed, m^2/s) is the standard
# meteorological measure of exactly that dilution capacity — a shallow,
# stagnant boundary layer traps emissions (low VC, high concentration), a
# deep windy one flushes them (high VC, low concentration). This is
# textbook air-quality meteorology (Holzworth 1967 mixing-height/ventilation
# work; used operationally in smoke-management and burn-permit systems), not
# a fitted curve.
#
# Note the last row above: keeping the directional wind factor AND adding
# PBLH scores far WORSE (+0.036) than dropping the directional term
# entirely (+0.198). The directional cos(dTheta) alignment is not merely
# weak — it actively injects noise, because a single receptor-point wind
# reading is a poor proxy for true transport along a multi-km path (see
# gap 6 in the model's own known-limitations list). It is therefore
# DOWN-WEIGHTED, not removed: see WIND_DIRECTION_BLEND below.
#
# VC_REFERENCE_M2S normalises the dilution factor to ~1.0 under typical
# Delhi conditions so that emission_weight retains roughly its previous
# magnitude and the road/industrial calibration step stays in a sane range.
# Chosen as a round central value of observed Delhi VC, not fitted.
VC_REFERENCE_M2S: float = 3000.0

# ── Monte Carlo uncertainty quantification ──────────────────────────────────
#
# Until Sept 2026 every breakdown percentage was a bare point estimate:
# "43.2% road" carried identical apparent precision whether the underlying
# inputs were solid or garbage. That was the model's single least defensible
# property — R-AASMAN, the government CMB system this is measured against,
# at least propagates per-species measurement uncertainty through its matrix
# inversion.
#
# The approach: resample the kernel's genuinely uncertain inputs N times,
# rerun the attribution per draw, and report the 10th-90th percentile spread
# per source type alongside the median. That converts every output from a
# false-precision point estimate into an honest interval.
#
# The perturbation ranges below are NOT invented — each is tied to a
# documented uncertainty in the underlying method or inventory. They are
# deliberately wide, because the honest answer is that these inputs are
# poorly constrained, and a narrow interval here would be its own kind of
# fabrication.
# 16 draws, chosen by measurement rather than by feel. The reported band
# width is what matters, and it converges early — measured on 40 real wards:
#
#     draws=16   5.3s   median dominant-source band width 0.391
#     draws=32  10.0s   0.380
#     draws=64  19.7s   0.416
#
# i.e. 4x the compute buys no additional resolution, and the intervals are
# wide enough that sampling noise is far from the limiting factor. At 265
# wards this is the difference between ~70s and ~280s per hourly cycle.
MC_DEFAULT_DRAWS: int = 16

# Emission-weight uncertainty, as a lognormal sigma (multiplicative).
#
#   road   AP-42 13.2.1's own silt-loading exponent has a published 95% CI
#          of 0.677-1.14 on a nominal 0.91, and EPA states that using
#          DEFAULT silt loadings (which is what this does — no local
#          measurement) yields "only an order-of-magnitude estimate" and
#          drops the quality rating two levels. Indian silt loading is
#          itself cited at 25-30x developed-nation values with large
#          scatter. 0.7 in log space is roughly a factor of 2 either way.
#   industrial  Emission weight is polygon area x a hand-assigned subtype
#          multiplier, with no measured stack data at all.
#   dust   Inherits road's silt uncertainty plus the WRAP construction
#          factor's own spread (0.11 vs 0.42 ton/acre/month between average
#          and worst case, itself a factor of ~4).
#   fire   FRP is a real satellite measurement, so this is the best
#          constrained of the four — but the FRP-to-emission conversion is
#          still a literature proxy.
# WHY THE RESULTING BANDS ARE SO WIDE, and why narrowing them here would
# be dishonest.
#
# Measured contribution to the final interval (40 real wards, 32 draws):
#     all three sources of uncertainty      median band 0.431
#     emission weight alone                 median band 0.431
#     sigma + wind direction alone          median band 0.044
# i.e. emission-weight uncertainty causes essentially ALL of it. The
# dispersion physics is not what makes the answer vague; the inventory is.
#
# What these sigmas assert, as 95% multiplicative ranges:
#     road       0.70 -> 0.25x .. 3.9x nominal
#     industrial 0.60 -> 0.31x .. 3.2x
#     dust       0.80 -> 0.21x .. 4.8x
#     fire       0.40 -> 0.46x .. 2.2x
#
# Those look alarming until checked against what the inputs actually are.
# EPA states that using DEFAULT silt loadings — which is exactly what this
# does, having no local measurement — yields "only an order-of-magnitude
# estimate" and drops the emission factor's quality rating two letters.
# Indian road silt is separately cited at 25-30x developed-nation values
# with large scatter (Katiyar et al. 2024, 259 locations / 32 cities).
# Industrial weight is polygon area times a hand-assigned subtype
# multiplier with no stack measurement anywhere in the chain. Against that,
# a factor-of-4 span is not pessimistic; it is arguably generous.
#
# Tightening these to get a prettier interval was considered and rejected.
# The relationship is direct and was measured:
#     sigmas as below          -> +-22 percentage points
#     halved                   -> +-11
#     quartered                -> +-6
# A +-6 band would require asserting road emissions are known to within
# about +-20%, which contradicts the cited sources. That is choosing the
# answer and back-filling the error bars.
#
# THE CORRECT WAY TO NARROW THESE IS TO FIX THE INPUTS, not the sigmas:
#   - real Delhi silt-loading measurements (Katiyar et al.'s per-road-type
#     table would alone justify roughly halving `road` and `dust`)
#   - any traffic-count data at all, replacing road class as an ADT proxy
#   - CPCB CEMS data for the formally-registered industrial estates
# Each of those is a real, obtainable input, and each would shrink the
# band on evidence rather than by assertion.
MC_EMISSION_LOGSIGMA: dict[str, float] = {
    "road":       0.70,
    "industrial": 0.60,
    "dust":       0.80,
    "fire":       0.40,
}
_MC_DEFAULT_LOGSIGMA: float = 0.60

# Sigma (dispersion length) uncertainty, as a fraction of the nominal value.
# Pasquill-Gifford stability classes are coarse and the kernel collapses
# them to a two-state seasonal switch (see SIGMA_WINTER_KM/SIGMA_SUMMER_KM),
# so the true effective sigma for any given hour is materially uncertain.
MC_SIGMA_REL_SD: float = 0.30

# Wind-direction uncertainty, degrees (1 sd). A single receptor-point
# reading is a poor proxy for transport along a multi-km path — this is
# gap 6 in the model's known-limitations list, quantified rather than just
# noted. Only bites when WIND_DIRECTION_BLEND > 0.
MC_WIND_DIR_SD_DEG: float = 25.0


# DISABLED BY DEFAULT — the dilution term measurably HURTS the kernel.
#
# Set True only to re-test it; do not enable in production without new
# evidence. Full sweep against 39 wards / 60 days, raw-PM2.5 target
# (the target that can actually see meteorological skill — see
# scripts/validate_vayutrace.py's two-targets note):
#
#     dilution OFF              raw +0.198   100% of wards positive
#     dilution ON, floor=200    raw +0.039    62%
#     dilution ON, floor=50     raw +0.019    64%
#     dilution ON, floor=10     raw +0.017    64%
#
# Monotonic, replicated at two sample sizes, and the effect is large: the
# term roughly halves-to-tenths the kernel's skill and knocks a third of
# wards from positive to negative. Correcting VC_FLOOR_M2S (which had been
# clipping 36% of real data) made it WORSE, not better, which ruled out
# the floor as the explanation.
#
# Why it fails, most likely: applying VC as a single per-ward multiplier
# double-counts dispersion that the Gaussian sigma already represents,
# while contributing a factor that varies mostly in TIME and almost not at
# all between wards — so it injects citywide temporal noise into a score
# whose job is spatial discrimination.
#
# Note this is not a claim that ventilation is physically irrelevant; it
# plainly is not. It is a claim that THIS formulation of it is wrong. A
# correct treatment would more likely modulate the effective sigma (a
# shallow, stagnant boundary layer should make plumes tighter and stronger
# near-source) rather than uniformly rescale the summed result. That is a
# real avenue, and the machinery below is retained for it.
DILUTION_ENABLED: bool = False

# Floor on VC before division, guarding against divide-by-zero and against
# a single near-zero VC reading producing an absurd concentration spike
# during a total-calm hour.
#
# WARNING — this constant was set to 200.0 on the reasoning that it is
# "about as low as Delhi gets", which was simply wrong, and it silently
# crippled the dilution term for an entire development cycle.
#
# Measured against 48,904 real ward-hours: VC spans p1=4, p5=18, p25=111,
# median=388, p75=1187, p95=3076 m^2/s. 36.3% of all hours fall BELOW 200,
# so the floor collapsed more than a third of the data onto a single
# constant (the resulting dilution factor was pinned at its 15.0 ceiling
# for everything from p75 upward). Nighttime boundary layers over Delhi
# genuinely do collapse to a few tens of metres, and ERA5 reproduces that;
# it is real signal, not noise to be clipped.
#
# The floor's job is only to stop a division blowing up, so it should sit
# well below the real distribution rather than inside it.
VC_FLOOR_M2S: float = 10.0

# How much the directional wind term counts, versus pure isotropic
# dispersion.
#
#   0.0 = ignore wind direction entirely
#   1.0 = full cos(dTheta) directional weighting (the original behaviour)
#
# MEASUREMENT HISTORY — read this before changing the value.
#
# First swept at n=12 wards, which appeared decisive and monotonic:
#     blend = 0.00  ->  within-ward rho  +0.107
#     blend = 0.25  ->  within-ward rho  +0.006
#     blend = 1.00  ->  within-ward rho  -0.008
#
# Re-swept at n=39 wards after the ERA5 weather backfill
# (scripts/backfill_weather_history.py) lifted validation coverage from
# ~12 wards / 4.7k paired observations to 39 wards / 29.2k:
#     blend = 0.00  ->  within-ward rho  -0.060   (31% of wards positive)
#     blend = 1.00  ->  within-ward rho  -0.055   (31% of wards positive)
#
# The two settings are INDISTINGUISHABLE at the larger sample. The apparent
# monotonic harm at n=12 did not replicate — it was a small-sample artifact,
# the same way the dilution "improvement" was (see the VC block above).
#
# Kept at 0.0, but on physical reasoning rather than a measured win: a
# single receptor-point wind reading is a poor proxy for transport along a
# multi-km path (gap 6 in the model's known-limitations list), so the
# simpler isotropic form is preferred when the data cannot distinguish
# them. Do NOT cite this as a measured improvement.
#
# The blending machinery is deliberately retained so this can be re-swept
# once a spatially-resolved wind field exists, at which point the
# directional term should be expected to earn its place.
WIND_DIRECTION_BLEND: float = 0.0

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


def boundary_bbox_center(geometry: dict | None) -> tuple[float, float] | None:
    """Bounding-box centre of a ward's GeoJSON Polygon/MultiPolygon boundary —
    a receptor point for wards with no captured lat/lng point (252 of 265,
    confirmed live this session).

    Deliberate PORT of web/src/components/overview/OverviewChoroplethMap.tsx's
    own `boundingBoxCenter()` (same min/max-then-midpoint approach, same
    reason: a real ward boundary exists for every one of those 252 wards —
    confirmed via a live DB check this session, 0 wards have neither a point
    nor a boundary) — kept identical to that function rather than a different
    approximation, so a ward's kernel receptor point and its frontend fly-to
    point are the same location, not two independently-computed guesses.

    Returns None for missing/malformed geometry — never fabricates a point.
    """
    if not geometry or not isinstance(geometry, dict):
        return None
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if not coords:
        return None

    # Polygon: coordinates = [ring, ring, ...] (first ring is the outer shell).
    # MultiPolygon: coordinates = [polygon, polygon, ...], each a list of rings.
    # Normalise both to "list of polygons, each a list of rings" so the same
    # nested loop below handles either shape (matches the TS version exactly).
    if gtype == "Polygon":
        polygons = [coords]
    elif gtype == "MultiPolygon":
        polygons = coords
    else:
        return None

    min_lng, max_lng = math.inf, -math.inf
    min_lat, max_lat = math.inf, -math.inf
    for polygon in polygons:
        for ring in polygon:
            for point in ring:
                lng, lat = point[0], point[1]
                if lng < min_lng: min_lng = lng
                if lng > max_lng: max_lng = lng
                if lat < min_lat: min_lat = lat
                if lat > max_lat: max_lat = lat

    if not math.isfinite(min_lng) or not math.isfinite(min_lat):
        return None
    return ((min_lat + max_lat) / 2.0, (min_lng + max_lng) / 2.0)


# -- Area-weighted polygon centroid (Sept 2026, position-accuracy fix) ────────
#
# boundary_bbox_center() above is a deliberate, intentionally-crude min/max
# midpoint — fine for the frontend's flyTo camera target (its own doc
# comment explicitly says "doesn't need to be a true area centroid"), but
# not for the KERNEL's receptor point: a wrong point shifts every distance/
# bearing calculation feeding the Gaussian decay, and confirmed live this
# session, real ward polygons average ~4.7km bbox-diagonal — comparable to
# or larger than SIGMA_ROAD_KM=1km, so bbox-center error is not negligible
# here the way it is for a map camera.
#
# This is a faithful PORT of web/src/lib/dataQualityRules.ts's own
# geometryCentroid()/ringSignedAreaCentroid()/polygonInteriorPoint()/
# scanForInteriorPoint(), which already existed in the frontend for the
# same "252 of 265 wards have no real point" problem (used there for
# monitoring-coverage classification) — reused rather than inventing a
# third independent approximation for the same underlying geometry. Uses:
#   1. Shoelace-formula area-weighted centroid (exact for a simple polygon)
#   2. Point-in-polygon verification (ray casting, hole-aware) — a
#      concave (L/U/C-shaped) ward's shoelace centroid can land OUTSIDE the
#      polygon; unverified, that would be worse than bbox-center, not better
#   3. Multi-position horizontal-scanline fallback, each candidate PIP-
#      verified, when the shoelace centroid fails that check
#   4. MultiPolygon: applies the above to the largest-area sub-polygon
#      (an area-weighted centroid across disconnected parts, e.g. an
#      exclave ward, can land in the empty gap between them)
#
# ingest/app/db.py's `boundary` column is the same GeoJSON already stored
# for boundary_bbox_center() above, so this needs no new data source.
def _ring_signed_area_centroid(ring: list[list[float]]) -> tuple[float, float, float] | None:
    """Shoelace formula. Returns (lng, lat, |area|) or None for a degenerate
    ring (<3 points or zero enclosed area)."""
    n = len(ring)
    if n < 3:
        return None
    cx = cy = area = 0.0
    for i in range(n):
        j = i - 1  # previous index, wrapping
        x_i, y_i = ring[i][0], ring[i][1]
        x_j, y_j = ring[j][0], ring[j][1]
        cross = x_j * y_i - x_i * y_j
        area += cross
        cx += (x_j + x_i) * cross
        cy += (y_j + y_i) * cross
    area /= 2.0
    if area == 0:
        return None
    return (cx / (6 * area), cy / (6 * area), abs(area))


def _raycast_inside_ring(lng: float, lat: float, ring: list[list[float]]) -> bool:
    inside = False
    n = len(ring)
    for i in range(n):
        j = i - 1
        x_i, y_i = ring[i][0], ring[i][1]
        x_j, y_j = ring[j][0], ring[j][1]
        if (y_i > lat) != (y_j > lat) and lng < (x_j - x_i) * (lat - y_i) / (y_j - y_i) + x_i:
            inside = not inside
    return inside


def _point_in_polygon_rings(lng: float, lat: float, rings: list[list[list[float]]]) -> bool:
    if not rings:
        return False
    if not _raycast_inside_ring(lng, lat, rings[0]):
        return False
    # Holes: a point inside a hole is outside the polygon.
    for hole in rings[1:]:
        if _raycast_inside_ring(lng, lat, hole):
            return False
    return True


def _point_in_geometry(lat: float, lng: float, geometry: dict) -> bool:
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "Polygon":
        return _point_in_polygon_rings(lng, lat, coords)
    if gtype == "MultiPolygon":
        return any(_point_in_polygon_rings(lng, lat, rings) for rings in coords)
    return False


def _scanline_at_lat(ring: list[list[float]], scan_lat: float) -> tuple[float, float] | None:
    """Candidate (lat, lng) at the midpoint of the widest interior span at
    this latitude. Only checks the exterior ring — caller PIP-verifies
    against the full geometry (including holes)."""
    xs: list[float] = []
    n = len(ring)
    for i in range(n):
        j = i - 1
        x1, y1 = ring[j][0], ring[j][1]
        x2, y2 = ring[i][0], ring[i][1]
        if (y1 <= scan_lat < y2) or (y2 <= scan_lat < y1):
            xs.append(x1 + (scan_lat - y1) * (x2 - x1) / (y2 - y1))
    if len(xs) < 2:
        return None
    xs.sort()
    best_mid, best_width = 0.0, -1.0
    for i in range(0, len(xs) - 1, 2):
        width = xs[i + 1] - xs[i]
        if width > best_width:
            best_width, best_mid = width, (xs[i] + xs[i + 1]) / 2.0
    return (scan_lat, best_mid) if best_width > 0 else None


def _scan_for_interior_point(ring: list[list[float]], geometry: dict) -> tuple[float, float] | None:
    lats = [p[1] for p in ring]
    lat_min, lat_max = min(lats), max(lats)
    span = lat_max - lat_min
    for f in (0.5, 0.4, 0.6, 0.25, 0.75):
        scan_lat = lat_min + span * f + span * 1e-6  # tiny offset avoids vertex/horizontal-edge hits
        candidate = _scanline_at_lat(ring, scan_lat)
        if candidate and _point_in_geometry(candidate[0], candidate[1], geometry):
            return candidate
    return None


def _polygon_interior_point(geometry: dict) -> tuple[float, float] | None:
    ring = geometry["coordinates"][0]
    c = _ring_signed_area_centroid(ring)
    if not c:
        return None
    lng, lat, _area = c
    if _point_in_geometry(lat, lng, geometry):
        return (lat, lng)
    return _scan_for_interior_point(ring, geometry)


def boundary_area_centroid(geometry: dict | None) -> tuple[float, float] | None:
    """Area-weighted, point-in-polygon-verified interior point for a ward's
    GeoJSON Polygon/MultiPolygon boundary — see the module-level comment
    above for the full rationale. This is the kernel's receptor-point
    fallback for wards with no captured lat/lng (used in place of the
    cruder boundary_bbox_center() as of Sept 2026); that function is kept
    for the frontend's own flyTo use, which doesn't need this precision.

    Returns None for missing/malformed/degenerate geometry — never
    fabricates a point."""
    if not geometry or not isinstance(geometry, dict):
        return None
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if not coords:
        return None

    if gtype == "Polygon":
        return _polygon_interior_point(geometry)

    if gtype == "MultiPolygon":
        # Interior point of the sub-polygon with the largest area — an
        # area-weighted centroid across disconnected parts can land in
        # empty space between them (e.g. an exclave ward).
        largest_point: tuple[float, float] | None = None
        largest_area = 0.0
        for polygon_coords in coords:
            c = _ring_signed_area_centroid(polygon_coords[0])
            if not c:
                continue
            _lng, _lat, area = c
            if area > largest_area:
                largest_area = area
                largest_point = _polygon_interior_point({"type": "Polygon", "coordinates": polygon_coords})
        return largest_point

    return None


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


def dilution_factor(
    ventilation_coefficient: float | None,
    boundary_layer_height: float | None = None,
    wind_speed_ms: float | None = None,
) -> float:
    """Atmospheric dilution multiplier from ventilation coefficient.

    Returns VC_REFERENCE_M2S / VC, so a STAGNANT atmosphere (low VC) yields
    a factor > 1 (emissions concentrate) and a WELL-VENTILATED one yields
    < 1 (emissions disperse). ~1.0 under typical Delhi conditions.

    This is the single highest-value term in the kernel's meteorology — see
    the VC_REFERENCE_M2S block above for the measurements that established
    that (within-ward rho went from -0.054 to +0.198 on real CPCB data).

    VC is taken directly when available (ingest.py already computes and
    stores it as PBLH x wind_speed). When only PBLH and wind speed are
    present it is recomputed here rather than skipped, since either input
    alone still beat the previous model.

    Returns 1.0 (a no-op multiplier) when no usable meteorology exists, so a
    ward with missing weather degrades to pure geometry rather than being
    dropped or silently assigned someone else's conditions.
    """
    if not DILUTION_ENABLED:
        return 1.0
    vc = ventilation_coefficient
    if vc is None and boundary_layer_height is not None and wind_speed_ms is not None:
        vc = float(boundary_layer_height) * float(wind_speed_ms)
    if vc is None:
        return 1.0
    try:
        vc = float(vc)
    except (TypeError, ValueError):
        return 1.0
    if vc <= 0 or vc != vc:  # non-positive or NaN
        return 1.0
    return VC_REFERENCE_M2S / max(vc, VC_FLOOR_M2S)


def _blended_wind_factor(
    bearing_deg: float, wind_from_dir_deg: float, wind_speed_ms: float
) -> float:
    """_wind_factor() blended toward isotropic by WIND_DIRECTION_BLEND.

    The pure directional factor measured WORSE than no wind term at all
    (see WIND_DIRECTION_BLEND's own comment), so it is down-weighted rather
    than trusted at full strength — but deliberately not deleted, because
    upwind sources genuinely do contribute more and a future spatially-
    resolved wind field should be able to recover that signal properly.

    At blend=0 this returns 1.0 (pure isotropic, direction ignored);
    at blend=1 it returns _wind_factor() unchanged.
    """
    directional = _wind_factor(bearing_deg, wind_from_dir_deg, wind_speed_ms)
    return (1.0 - WIND_DIRECTION_BLEND) + WIND_DIRECTION_BLEND * directional


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


# -- Road/industrial scale calibration (Sept 2026 fix) ────────────────────────
#
# The grid-aggregation fix in vayutrace_osm_roads.py (see that module's own
# docstring) correctly stopped roads from being over-counted by OSM way-
# fragment COUNT — but it left a separate, pre-existing unit mismatch:
# industrial_sources carry a bounded 1-3 "qualitative strength" class score
# (city-wide raw total ≈117 for 60 zones), while road_sources now carry
# length_km × class_weight (city-wide raw total ≈41,000 across ~9,000 grid
# cells) — two source types measured in incompatible units, confirmed live
# this session. Left uncorrected, roads still won every ward at 74-95%
# purely from this scale mismatch, even after fragmentation was fixed.
#
# vayutrace_sector_priors.py already carries exactly the calibration target
# needed: IITK (2016)/TERI-ARAI (2018) receptor-modelled Delhi PM2.5 source
# apportionment gives a real vehicles:industrial ratio of ≈2.5:1 (winter
# consensus) / ≈2.6:1 (summer consensus) — nowhere close to today's ~350:1.
#
# First attempt (Sept 2026, same session) scaled road's RAW city-wide total
# to hit that ratio directly — and overshot the other way, confirmed live:
# industrial then dominated every ward at ~86-98%. Root cause: road's
# SIGMA_ROAD_KM=1km means only ~1-2% of the ~9,000 road cells contribute
# appreciably (Gaussian decay > 0.01) at any given ward, while industrial's
# much wider seasonal sigma (5-7km) means ~90%+ of the 60 zones contribute
# to every ward — confirmed live at a real ward (129/8963 road cells vs.
# 55/60 industrial zones). Road's raw city-wide total and its EFFECTIVE
# per-ward reach are related by a factor the raw-sum calibration never
# accounted for, so matching literature on raw totals doesn't survive the
# kernel's own decay physics.
#
# Fixed by calibrating against DECAY-WEIGHTED mass instead — the same
# distance-decay function run_kernel() itself applies per ward, averaged
# across every ward (not a single sample, so no one ward's geometry skews
# the result) — which is what actually reaches the breakdown sum. This
# still touches only the two source types' relative starting scale, not
# the kernel's real per-ward spatial differentiation (which still runs
# entirely unchanged on top, once this calibration sets fair starting
# masses). Matches vayutrace_sector_priors.py's own stated role:
# "calibration / sanity-checking... not as direct per-ward estimates."
#
# Fire is deliberately left uncalibrated here (Sept 2026, direct decision):
# this fix is scoped to the specific road-vs-industrial mismatch just found
# and confirmed; fire's own priors/index already come from a physically
# distinct model (regional_fraction_nowcast, FRP-based), and folding it into
# this same correction was explicitly deferred rather than done speculatively.
def _calibrate_road_industrial_scale(
    all_sources: list[dict],
    wards: list[dict],
    month: int,
    effective_sigma: float,
) -> None:
    """Mutates `_ew` on every road-type entry in `all_sources` in place so
    road's DECAY-WEIGHTED mass (averaged across every ward, using the same
    distance-decay function run_kernel() applies) matches the IITK/TERI-ARAI
    consensus vehicles:industrial ratio relative to industrial's own
    decay-weighted mass. No-op if either source type is entirely absent, or
    if no ward has usable coordinates — never fabricates a ratio when one
    side of it is missing."""
    from .vayutrace_sector_priors import consensus_midpoints  # noqa: PLC0415

    industrial_sources = [s for s in all_sources if s["source_type"] == "industrial"]
    road_sources_ = [s for s in all_sources if s["source_type"] == "road"]
    if not industrial_sources or not road_sources_:
        return

    industrial_totals: list[float] = []
    road_totals: list[float] = []
    for ward in wards:
        wlat, wlng = ward.get("lat"), ward.get("lng")
        if wlat is None or wlng is None:
            fallback = boundary_area_centroid(ward.get("boundary"))
            if fallback is None:
                continue
            wlat, wlng = fallback

        ind_mass = sum(
            s["_ew"] * _distance_decay(_haversine_km(wlat, wlng, s["lat"], s["lng"]), effective_sigma)
            for s in industrial_sources
        )
        road_mass = sum(
            s["_ew"] * _distance_decay(_haversine_km(wlat, wlng, s["lat"], s["lng"]), SIGMA_ROAD_KM)
            for s in road_sources_
        )
        industrial_totals.append(ind_mass)
        road_totals.append(road_mass)

    if not industrial_totals:
        return
    industrial_mean = sum(industrial_totals) / len(industrial_totals)
    road_mean = sum(road_totals) / len(road_totals)
    if industrial_mean <= 0 or road_mean <= 0:
        return

    season = "winter" if month in _WINTER_MONTHS else "summer"
    priors = consensus_midpoints(season)
    target_ratio = priors["vehicles"] / priors["industrial"]

    current_ratio = road_mean / industrial_mean
    scale = target_ratio / current_ratio

    for s in road_sources_:
        s["_ew"] *= scale


def _score_ward(
    wlat: float,
    wlng: float,
    all_sources: list[dict],
    wind_dir: float,
    wind_speed: float,
    effective_sigma: float,
    ew_scale: dict[str, float] | None = None,
    sigma_scale: float = 1.0,
) -> dict[str, float]:
    """Summed contribution per source type at one receptor point.

    Shared by the point estimate and every Monte Carlo draw so the two can
    never drift apart — a draw that computed scores differently from the
    headline number would make the resulting interval meaningless.

    `ew_scale`    per-source-type multiplier on emission weight (MC draws).
    `sigma_scale` multiplier on every dispersion length (MC draws).
    """
    acc: dict[str, float] = {"industrial": 0.0, "road": 0.0, "fire": 0.0, "dust": 0.0}
    for s in all_sources:
        dist = _haversine_km(wlat, wlng, s["lat"], s["lng"])
        bearing = _bearing_deg(s["lat"], s["lng"], wlat, wlng)
        wf = _blended_wind_factor(bearing, wind_dir, wind_speed)
        stype = s["source_type"]
        if stype == "road":
            sigma = SIGMA_ROAD_KM
        elif stype == "dust":
            sigma = SIGMA_DUST_KM
        elif stype == "fire":
            sigma = SIGMA_FIRE_KM
        else:
            sigma = effective_sigma
        dd = _distance_decay(dist, sigma * sigma_scale)
        score = s["_ew"] * wf * dd
        if ew_scale:
            score *= ew_scale.get(stype, 1.0)
        if stype in acc:
            acc[stype] += score
        else:
            acc["industrial"] += score  # catch-all
    return acc


def _monte_carlo_breakdown(
    wlat: float,
    wlng: float,
    all_sources: list[dict],
    wind_dir: float,
    wind_speed: float,
    effective_sigma: float,
    draws: int,
    rng: "np.random.Generator",
) -> dict[str, dict[str, float]]:
    """Resample the kernel's uncertain inputs and return per-type p10/p50/p90
    of the resulting BREAKDOWN FRACTIONS.

    Perturbs, per draw:
      - emission weight per source type (lognormal, MC_EMISSION_LOGSIGMA)
      - dispersion length          (normal, MC_SIGMA_REL_SD, floored)
      - wind direction             (normal, MC_WIND_DIR_SD_DEG)

    Fractions rather than raw scores, deliberately: the raw score is in
    arbitrary units (see local_score), so a raw interval would not be
    interpretable, whereas "road is 38-61% of local load" is exactly the
    statement a user needs and the one the point estimate currently makes
    with unearned precision.

    Returns {source_type: {"p10": x, "p50": y, "p90": z}}.
    """
    samples: dict[str, list[float]] = {"industrial": [], "road": [], "fire": [], "dust": []}
    types = list(samples.keys())

    for _ in range(draws):
        ew_scale = {
            t: float(rng.lognormal(
                mean=0.0,
                sigma=MC_EMISSION_LOGSIGMA.get(t, _MC_DEFAULT_LOGSIGMA),
            ))
            for t in types
        }
        # Floored at 0.2 so a tail draw cannot collapse sigma to ~0, which
        # would make every source infinitely local and is not a physically
        # meaningful scenario.
        sigma_scale = max(0.2, float(rng.normal(1.0, MC_SIGMA_REL_SD)))
        wd = (wind_dir + float(rng.normal(0.0, MC_WIND_DIR_SD_DEG))) % 360.0

        acc = _score_ward(
            wlat, wlng, all_sources, wd, wind_speed, effective_sigma,
            ew_scale=ew_scale, sigma_scale=sigma_scale,
        )
        total = sum(acc.values())
        if total <= 0:
            continue
        for t in types:
            samples[t].append(acc[t] / total)

    out: dict[str, dict[str, float]] = {}
    for t, vals in samples.items():
        if not vals:
            out[t] = {"p10": 0.0, "p50": 0.0, "p90": 0.0}
            continue
        vals.sort()
        n = len(vals)
        out[t] = {
            "p10": round(vals[int(0.10 * (n - 1))], 4),
            "p50": round(vals[int(0.50 * (n - 1))], 4),
            "p90": round(vals[int(0.90 * (n - 1))], 4),
        }
    return out


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
    dust_sources: list[dict] | None = None,
    mc_draws: int = MC_DEFAULT_DRAWS,
    mc_seed: int = 20260922,
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
    # Dust (AP-42 road resuspension + WRAP construction) — see
    # vayutrace_dust.py, including why windblown/soil dust is deliberately
    # absent. Optional so existing callers and tests are unaffected.
    for s in (dust_sources or []):
        all_sources.append({**s, "source_type": "dust",
                             "_ew": float(s.get("emission_weight", 0))})

    _calibrate_road_industrial_scale(all_sources, wards, month, effective_sigma)

    if len(all_sources) < MIN_SOURCES:
        log.warning("vayutrace_kernel: fewer than %d sources — returning empty results", MIN_SOURCES)
        return []

    # Pre-compute source coordinates as arrays for vectorised distance
    src_lats = np.array([s["lat"] for s in all_sources])
    src_lngs = np.array([s["lng"] for s in all_sources])

    results: list[dict] = []
    skipped_no_coords = 0
    # Seeded so a rerun on unchanged inputs reproduces the same intervals —
    # an attribution whose error bars moved every hour for no reason would
    # be worse than useless operationally.
    rng = np.random.default_rng(mc_seed)

    for ward in wards:
        wid = ward["id"]
        wlat, wlng = ward["lat"], ward["lng"]
        # Bug fix (Sept 2026): most wards (252 of 265, confirmed live this
        # session) have NULL lat/lng — only ~13 "hotspot" wards were ever
        # given a real point. Every call to _haversine_km/_bearing_deg below
        # crashed with "must be real number, not NoneType" the instant it
        # hit the first such ward, which propagates up through run_kernel()
        # -> estimate_city() -> vayutrace_attribution.run(), and main.py's
        # run_intel() swallows that exception (bare except, logs and moves
        # on) — so this kernel silently failed on EVERY scheduled run since
        # it was written; a live DB check this session confirmed zero rows
        # with method='vayutrace_v1' had ever been written before this fix.
        #
        # Fixed properly (not just skipped) by falling back to the ward's
        # boundary polygon, confirmed via a live DB check this session to
        # exist for all 252 of the affected wards (0 wards have neither a
        # point nor a boundary). A ward genuinely missing both is still
        # skipped, not fabricated a location.
        #
        # Upgraded (Sept 2026, 2nd pass) from boundary_bbox_center() to
        # boundary_area_centroid() — see that function's own module-level
        # comment for the full reasoning: a bbox midpoint is fine for a map
        # flyTo camera target but not for this kernel's receptor point,
        # since real ward polygons average ~4.7km bbox-diagonal (confirmed
        # live this session) — comparable to or larger than
        # SIGMA_ROAD_KM=1km, so the position error was not negligible here.
        if wlat is None or wlng is None:
            fallback = boundary_area_centroid(ward.get("boundary"))
            if fallback is None:
                skipped_no_coords += 1
                continue
            wlat, wlng = fallback

        met = weather.get(wid) or {}
        wind_dir = float(met.get("wind_dir") or met.get("wind_from_direction") or 180.0)
        wind_speed = float(met.get("wind_speed") or 0.0)

        # Atmospheric dilution for this ward-hour (Sept 2026). Applied as a
        # single per-ward multiplier AFTER the per-source sum below: dilution
        # acts on the whole local air parcel, not on individual plumes, so it
        # scales every local source identically and therefore does NOT change
        # the breakdown fractions — only the local_score magnitude, which is
        # exactly the quantity validation measures. See dilution_factor().
        dilution = dilution_factor(
            met.get("ventilation_coefficient"),
            met.get("boundary_layer_height"),
            wind_speed,
        )

        # Per-source contribution score, SUMMED per type (bug fix, Sept
        # 2026 — this used to average: sum_of_scores / count. That was
        # picked deliberately to stop a 200k-segment road inventory from
        # "crowding out" 60 industrial zones, but it did the opposite of
        # its own intent: a Gaussian plume model's whole physical basis is
        # LINEAR SUPERPOSITION — each source's concentration field at a
        # receptor is independent and they ADD, the same way two smoke-
        # stacks' plumes add rather than average at a point downwind
        # (verified against atmospheric-dispersion-modelling fundamentals
        # this session: no dispersion model averages source contributions
        # by source count — the total lambda concentration is a sum over
        # sources). Averaging by segment count instead made industrial
        # (60 entries) mathematically WIN over road (204,039 real segments,
        # confirmed live from the actual Delhi OSM extract) regardless of
        # true proximity or wind alignment, EVEN WHEN road's raw summed
        # score was ~50x larger for a real tested ward (631 vs 12.5) —
        # confirmed live this session: every one of 265 wards showed 0%
        # road contribution before this fix, a structural artifact of
        # dividing by the wrong denominator, not roads genuinely being
        # irrelevant. Distance decay (sigma) already does the real physical
        # work of making a far-away segment contribute ~0 to the sum, so a
        # segment 10 km away correctly adds almost nothing regardless of
        # how many such distant segments exist — no separate "crowding
        # out" protection is needed once summation is used correctly.
        # Point estimate. Shares _score_ward() with the Monte Carlo draws
        # below so the headline number and its interval can never diverge.
        contributions = _score_ward(
            wlat, wlng, all_sources, wind_dir, wind_speed, effective_sigma,
        )

        total = sum(contributions.values()) or 1.0
        breakdown = {k: round(v / total, 4) for k, v in contributions.items()}
        breakdown["unknown"] = 0.0  # forward model has no residual by design

        # Raw (un-normalised) summed score — the model's actual predicted
        # LOCAL CONCENTRATION PROXY, in arbitrary units, before it is divided
        # away into fractions above.
        #
        # Added Sept 2026 for validation (see scripts/validate_vayutrace.py).
        # This number is the only genuinely falsifiable output the kernel
        # produces: the breakdown fractions can't be checked against CPCB
        # data (stations measure total PM2.5, not per-source splits — that
        # needs the chemical speciation VayuTrace deliberately doesn't have),
        # but the claim "wards/hours this kernel scores higher should ACTUALLY
        # have higher observed PM2.5 local excess" is directly testable
        # against the readings already in the DB. Without exposing this,
        # every physics change to the kernel (sigma, wind factor, emission
        # weights) is unfalsifiable — we could only check that outputs
        # changed, never that they got BETTER.
        #
        # Units are arbitrary/uncalibrated (emission_weight × wind_factor ×
        # distance_decay summed over sources), so only its RANK CORRELATION
        # against observed concentration is meaningful, never its absolute
        # value. Never present this as a µg/m³ prediction.
        local_score = sum(contributions.values()) * dilution

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

        # Monte Carlo interval on the breakdown fractions.
        uncertainty = (
            _monte_carlo_breakdown(
                wlat, wlng, all_sources, wind_dir, wind_speed,
                effective_sigma, mc_draws, rng,
            )
            if mc_draws > 0 else None
        )

        # Station proximity — kept, but no longer called "confidence".
        #
        # This measures how close a ward is to a CPCB station, which is a
        # proxy for how well-anchored the model is there. It was previously
        # reported as `confidence`, which overstated it: a ward 500 m from a
        # station still gets a wrong answer if the emission geometry near it
        # is wrong, and the old name gave no hint of that.
        if cpcb_stations:
            min_dist = min(
                _haversine_km(wlat, wlng, st.get("lat", wlat), st.get("lng", wlng))
                for st in cpcb_stations
            )
            station_proximity = float(np.clip(1.0 - min_dist / MAX_CONFIDENT_DIST_KM, 0.0, 1.0))
        else:
            station_proximity = 0.5  # unknown station proximity → mid-range

        # Real confidence: how TIGHT is the Monte Carlo interval on the
        # dominant source? A narrow band means the attribution is robust to
        # the inputs' known uncertainty; a wide one means it is not, and the
        # user should be told so. Falls back to station proximity only when
        # MC is switched off, preserving the previous behaviour.
        if uncertainty:
            dominant = max(uncertainty, key=lambda t: uncertainty[t]["p50"])
            spread = uncertainty[dominant]["p90"] - uncertainty[dominant]["p10"]
            # spread is a fraction in [0,1]; 0 -> fully determined, >=0.5 ->
            # essentially unconstrained.
            confidence = float(np.clip(1.0 - 2.0 * spread, 0.0, 1.0))
        else:
            confidence = station_proximity

        results.append({
            "ward_id": wid,
            "breakdown": breakdown,
            "confidence": round(confidence, 3),
            # p10/p50/p90 per source type from the Monte Carlo draws — the
            # honest version of `breakdown`. None when MC is disabled.
            "breakdown_uncertainty": uncertainty,
            "station_proximity": round(station_proximity, 3),
            "regional_fraction_prior": reg_fraction,
            "regional_fire_index": reg_fire_idx,
            "method": "vayutrace_v1",
            "sigma_km": effective_sigma,
            # Validation-only; arbitrary units, rank-meaningful only.
            # See the local_score assignment above for why this exists.
            "local_score": local_score,
            "per_type_score": dict(contributions),
            "source_counts": {
                "industrial": len(industrial_sources),
                "fire":       len(fire_sources),
                "road":          len(road_sources),
                "regional_fire": len(regional_fire_sources or []),
            },
        })

    if skipped_no_coords:
        log.warning(
            "run_kernel: skipped %d/%d wards with no lat/lng (no receptor point available) — "
            "see this function's own bug-fix comment above; %d wards produced results",
            skipped_no_coords, len(wards), len(results),
        )

    return results


# -- Convenience: run full pipeline for one city ──────────────────────────────

def estimate_city(
    wards: list[dict],
    weather_by_ward: dict[int, dict],
    *,
    sigma_km: float = DEFAULT_SIGMA_KM,
    firms_date: Any = None,
    month: int | None = None,
    cpcb_stations: list[dict] | None = None,
) -> list[dict]:
    """High-level convenience wrapper: loads all source inventories and runs
    the kernel.  Returns the same list as run_kernel().

    This is the function vayutrace_attribution.py (or main.py) should call.
    Each sub-import is guarded so a missing .pbf or absent FIRMS key
    degrades gracefully rather than failing the whole intel cycle.

    Args:
        month — calendar month (1–12); if omitted, current UTC month is used.
                Drives season-aware sigma selection and regional transport prior.
        cpcb_stations — Bug fix (Sept 2026): this parameter was missing
            entirely before, so run_kernel()'s own cpcb_stations argument
            (which drives the real, distance-based confidence score) was
            NEVER passed through from vayutrace_attribution.run() — which
            already fetches db.get_stations_with_coords() into a local
            `stations` variable and then never uses it. Every ward's
            confidence has been silently defaulting to a flat 0.5
            (run_kernel()'s own "unknown station proximity" fallback) in
            every production run, confirmed live this session. Now
            threaded through properly.
    """
    from .vayutrace_osm_industrial import load_delhi_industrial_zones  # noqa: PLC0415
    from .vayutrace_firms import fetch_igp_fires                    # noqa: PLC0415
    from .vayutrace_osm_roads import load_delhi_roads               # noqa: PLC0415

    if month is None:
        from datetime import datetime, timezone  # noqa: PLC0415
        month = datetime.now(timezone.utc).month

    # Real OSM landuse=industrial polygons (Sept 2026) replaced the old
    # vayutrace_industrial_zones.zones_as_dicts() — 60 hand-typed
    # "approximate locality centroid" points — with real geometry, same
    # reasoning/precedent as the road fix just below. See
    # vayutrace_osm_industrial.py's own module docstring for the full
    # rationale (what was excluded as non-emission-source, why category
    # labels weren't preserved via name-matching, area-based weighting).
    industrial = load_delhi_industrial_zones()
    roads      = load_delhi_roads()

    # Dust sources (Sept 2026) — AP-42 13.2.1 road resuspension + WRAP
    # construction-area dust. See vayutrace_dust.py for the emission
    # factors, and for why windblown/soil dust (the LARGEST dust
    # sub-category per ARAI/TERI 2018) is deliberately not modelled.
    #
    # The precipitation correction is applied city-wide here using the
    # median of the current per-ward precipitation, rather than per ward.
    # Rain is spatially coherent at Delhi's scale over an hour, and a
    # per-source precipitation factor would require rebuilding the whole
    # dust inventory per ward — 9,200 sources x 265 wards per hour — for a
    # refinement finer than AP-42's own binary wet/dry resolution.
    from .vayutrace_dust import (  # noqa: PLC0415
        build_construction_dust_sources,
        build_road_dust_sources,
        precipitation_factor,
    )
    from .vayutrace_osm_construction import load_delhi_construction_sites  # noqa: PLC0415

    precips = [
        float(m["precipitation"])
        for m in (weather_by_ward or {}).values()
        if m.get("precipitation") is not None
    ]
    city_precip = sorted(precips)[len(precips) // 2] if precips else None
    precip_f = precipitation_factor(city_precip)

    dust = (
        build_road_dust_sources(roads, precip_factor=precip_f)
        + build_construction_dust_sources(load_delhi_construction_sites())
    )

    # Fetch the full IGP airshed (Punjab, Haryana, UP, Rajasthan) and split
    # into local fires (< 50 km, Gaussian kernel) and regional fires (≥ 50 km,
    # travel-time transport index).
    igp_fires      = fetch_igp_fires(day=firms_date)
    local_fires    = [f for f in igp_fires if f.get("fire_class") == "local"]
    regional_fires = [f for f in igp_fires if f.get("fire_class") == "regional"]

    log.info(
        "vayutrace_kernel estimate_city: month=%d sigma=%s km, "
        "%d industrial, %d local fires, %d regional IGP fires, %d road segments, "
        "%d dust sources (precip factor %.2f)",
        month, seasonal_sigma_km(month),
        len(industrial), len(local_fires), len(regional_fires), len(roads),
        len(dust), precip_f,
    )

    return run_kernel(
        wards=wards,
        weather=weather_by_ward,
        industrial_sources=industrial,
        fire_sources=local_fires,
        road_sources=roads,
        cpcb_stations=cpcb_stations,
        sigma_km=sigma_km,
        month=month,
        regional_fire_sources=regional_fires,
        dust_sources=dust,
    )
