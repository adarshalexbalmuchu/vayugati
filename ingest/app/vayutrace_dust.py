"""Dust emission sources for the VayuTrace kernel — AP-42 based.

WHY THIS EXISTS
===============
Dust is the largest source category VayuTrace did not model at all. Per
ARAI/TERI 2018 (Tables 5.3-5.6), dust is ~17% of Delhi PM2.5 in winter and
~38% in summer — in summer the single biggest category. Everything not
industrial/road-traffic/fire was previously absorbed implicitly into the
other source weights by the calibration step, which is worse than modelling
it explicitly: the calibration was silently compensating for categories the
model had no representation of.

It also targets the specific weakness the validation harness found. The
kernel has no within-ward dynamic skill (it cannot predict WHEN a ward
worsens), and the split by local-source strength showed it fails hardest in
wards where local primary sources are weak — exactly the wards where dust
and secondary aerosol dominate. Road dust additionally carries a genuine
hour-to-hour signal (the precipitation correction below), which is the kind
of temporal variation the kernel currently lacks almost entirely.

WHAT IS AND IS NOT IMPLEMENTED
==============================
Implemented, both from established emission-factor methods:

  road_dust          AP-42 13.2.1 (Jan 2011) paved-road resuspension,
                     with the hourly precipitation correction.
  construction_dust  WRAP Fugitive Dust Handbook area factor applied to
                     OSM landuse=construction polygons.

DELIBERATELY NOT IMPLEMENTED — windblown/soil dust. This is the largest
dust sub-category (ARAI: 12% of PM2.5 in winter, 33% in summer, i.e. ~70%
of winter dust and ~87% of summer dust), so omitting it is a real and
disclosable limitation. It is omitted anyway because every input it needs
is unavailable and has no defensible default:

  - u*t (threshold friction velocity) for disturbed urban Delhi soil
    requires the Chepil hand-sieve test on the actual surface. AP-42
    Table 13.2.5-2 publishes values only for coal piles, scoria and mine
    overburden. No published Delhi value exists.
  - N (disturbances per year) is unknowable from OSM and enters the
    emission linearly.
  - AP-42 13.2.5 Eq 4 requires the FASTEST MILE wind (a ~2-minute gust),
    not an hourly mean. Feeding hourly means into it is a category error.
  - Checked directly against this deployment's own weather history
    (56,912 hours): Delhi 10m wind is median 1.69 m/s, p99 4.06 m/s, max
    6.30 m/s, with only 0.06% of hours above 5 m/s. The AP-42 thresholds
    correspond to ~10-19 m/s at 10m. A mean-wind implementation would
    therefore emit ~zero almost always and spike violently in the rare
    tail — noise, not signal.
  - AP-42 13.2.5 itself states its output "should not be input directly
    into dispersion models that assume steady-state emission rates".

The Marticorena-Bergametti (1995) scheme was also considered and rejected:
its sandblasting efficiency alpha spans 1e-5 to 1e-2 /m depending on soil
clay content, which is three orders of magnitude of freedom with no local
soil texture data to constrain it.

CONSEQUENCE, STATED PLAINLY: this module reproduces only about 30% of
winter dust PM2.5 and about 13% of summer dust PM2.5. Road-dust silt
loading must NOT be inflated to make the totals match — that would be
fitting the right answer with the wrong physics, and would corrupt the
one part of this that is genuinely grounded.

MEASURED EFFECT ON VALIDATION
=============================
A/B through scripts/validate_vayutrace.py (39 wards, 60 days,
dilution-bearing ward-hours only), against BOTH validation targets:

                  vs raw PM2.5          vs local excess
    dust ON     +0.104 (79% pos)      -0.018 (46% pos)
    dust OFF    +0.082 (74% pos)      -0.027 (46% pos)

Against raw PM2.5 that is a +0.022 improvement, about 27% relative, moving
in the same direction on both the median and the share of wards helped.
Against local excess both arms remain ~0.

An earlier revision of this comment reported only the local-excess numbers
and concluded the module's effect was "approximately nil". That conclusion
was an artifact of the harness: local excess subtracts the citywide median
each hour and so discards 54% of per-ward variance — precisely the
meteorological signal dispersion physics predicts best. Every
meteorological predictor, including ones unrelated to this kernel, scored
~0 against it. See the two-targets note in validate_vayutrace.py.

The split between the two targets is itself informative here, and matches
what this module actually does: dust improves the ABSOLUTE load estimate
(its mass and its rain-driven timing are real) without sharpening
ward-versus-ward discrimination, which is expected given that the largest
dust component — windblown/soil, ~70% of winter and ~87% of summer dust —
is deliberately not modelled.

Additional reasons this is kept, independent of either metric:
  - it is literature-grounded, where the previous treatment (silently
    absorbing dust into road/industrial via the calibration) was not;
  - it stops the calibration compensating for missing physics;
  - the dust share varies genuinely across wards (3.4%-37.6%) and
    correlates only weakly with the road share (rho +0.24), so it adds
    independent information to the source SPLIT — the model's actual
    product, which this harness cannot validate at all.

Unpaved roads (AP-42 13.2.2) are also not modelled separately: 87% of
Delhi road ways in the OSM extract carry no `surface` tag (verified
directly), so unpaved segments cannot be identified, and the public-road
equation needs a surface-moisture term M whose default EPA explicitly
discourages. Unpaved/shoulder effects are instead folded into an elevated
silt loading on the paved equation, which is the more honest treatment.

SCALE OF VALIDITY
=================
Per CARB Methodology 7.9, which uses this same road-class-to-silt approach
statewide: defensible for ward and city AGGREGATES, not for individual
street segments.
"""

from __future__ import annotations

import logging
import math

log = logging.getLogger("ingest.vayutrace_dust")

# ── AP-42 13.2.1 paved-road resuspension ─────────────────────────────────────
#
#   E = k * (sL)^0.91 * (W)^1.02        [g / vehicle-km travelled]
#
# k       particle-size multiplier
# sL      road surface silt loading, g/m^2
# W       FLEET-AVERAGE vehicle weight, short tons (not per-class)
#
# Exponents are AP-42's own, from Table 13.2.1-1 / Eq 1. Their published
# 95% confidence intervals are 0.677-1.14 (sL) and 0.85-1.19 (W), i.e. the
# exponents themselves carry roughly +/-25% uncertainty.
AP42_K_PM25_G_PER_VKT: float = 0.15   # Table 13.2.1-1, PM2.5, g/VKT
AP42_SL_EXPONENT: float = 0.91
AP42_W_EXPONENT: float = 1.02

# AP-42's PM2.5 paved-road factor carries quality rating D (PM10 is rated A),
# and using default rather than measured silt loading drops the rating a
# further two levels. Recorded here because it bounds how much weight any
# downstream number deserves.
AP42_PM25_QUALITY_RATING: str = "D"

# Fleet-average vehicle weight, short tons.
#
# Delhi's fleet is ~64% two-wheelers and ~31% cars, so it is far lighter
# than the US fleet CARB models with (2.4 tons). No published Delhi-specific
# fleet-average weight was found, so this is an ASSUMPTION, not a citation.
#
# Note it sits below AP-42 Eq 1's tested validity floor (1.8 Mg = 2.0 tons),
# so this is a mild extrapolation. The W exponent is ~1.0, so sensitivity is
# linear and mild; silt-loading uncertainty dominates by orders of magnitude.
FLEET_AVG_WEIGHT_TONS: float = 1.35

# Baseline silt loading by OSM highway class, g/m^2.
#
# AP-42 Table 13.2.1-2 keys silt loading on ADT (average daily traffic), not
# on road name, so OSM class is used as an ADT surrogate — the standard
# regulatory practice, cf. CARB Methodology 7.9 which assigns silt loading
# by road class across all of California.
#
# NOTE THE INVERSION, which is easy to get backwards: higher traffic means
# LOWER silt loading, because traffic continuously sweeps the surface toward
# a cleaner equilibrium. A motorway is dustier in total only because it
# carries vastly more vehicle-km, not because its surface is dirtier.
_SILT_LOADING_BY_CLASS: dict[str, float] = {
    # OSM class          g/m^2   implied ADT band (AP-42 Table 13.2.1-2)
    "motorway":          0.015,  # >10,000, limited access
    "motorway_link":     0.015,
    "trunk":             0.020,  # >10,000
    "trunk_link":        0.020,
    "primary":           0.030,  # >10,000
    "primary_link":      0.030,
    "secondary":         0.060,  # 5,000-10,000
    "secondary_link":    0.060,
    "tertiary":          0.200,  # 500-5,000
    "tertiary_link":     0.200,
    "residential":       0.600,  # <500
    "unclassified":      0.600,
    "living_street":     0.600,
    "service":           0.600,
}
_DEFAULT_SILT_LOADING: float = 0.200  # unknown class -> mid band, not the extreme

# Multiplier taking AP-42's US baseline silt loadings to Indian conditions.
#
# THIS IS THE DOMINANT UNCERTAINTY IN THE WHOLE MODULE — treat it as the one
# knob to revisit, and the first thing to replace with local measurement.
#
# Evidence:
#   - Katiyar et al. 2024, Sci. Total Environ. 912, DOI
#     10.1016/j.scitotenv.2023.169232: field campaign over 259 locations in
#     32 Indian cities finds Indian road silt loading 25-30x developed-nation
#     values; up to 137 g/m^2 in Rajasthan. (Paywalled; obtained via
#     abstract-level summaries, not the full per-road-type table. Getting
#     that table is the single highest-value refinement available here.)
#   - Delhi-specific silt loadings of roughly 2.0-12.5 g/m^2 are reported in
#     secondary literature, rising to ~40 g/m^2 near construction sites.
#   - ARAI/TERI 2018 sampled silt per AP-42 across arterial, sub-arterial and
#     local roads in Delhi/NCR in both seasons, but does not publish the
#     resulting table.
#
# Chosen at the conservative end of the cited 25-30x range, because these
# baselines are ADT-band values rather than the road types Katiyar sampled,
# and because overstating dust would let it swamp the source split. The
# class RATIOS come from AP-42/CARB; only this LEVEL is Indian.
INDIA_SILT_SCALING: float = 15.0

# ── Precipitation correction (AP-42 13.2.1 Eq 3, hourly special case) ────────
#
# AP-42's own guidance for hour-by-hour use, quoted:
#
#   "For the special case where this equation is used to calculate emissions
#    on an hour by hour basis ... the moisture correction 'credit' should be
#    applied to the first hours following cessation of precipitation. In this
#    special case, it is suggested that this 20% 'credit' be applied on a
#    basis of one hour credit for each hour of precipitation up to a maximum
#    of 12 hours."
#
# So: a raining hour emits nothing; each subsequent hour gets a 20% reduction
# for as many hours as it rained, capped at 12.
#
# EPA's own caveat, worth keeping visible: "the simple assumption underlying
# Equations 2 and 3 has not been verified in any rigorous manner."
#
# Two further honest limits of this method:
#   - It is a BINARY wet/dry switch, not an intensity response: 0.3 mm and
#     30 mm of rain are treated identically. The hourly precipitation data
#     available here is finer than the method's real resolution.
#   - It ignores post-monsoon silt REPLENISHMENT, which Indian studies
#     report is genuinely significant (stagnant water and poor drainage
#     raise silt loads after rain rather than lowering them).
# MEASURED CAVEAT — the rain correction does NOT help the validation metric,
# and it is worth understanding why before anyone "fixes" it.
#
# Against this deployment's real data (39 wards, 60 days), the precipitation
# factor on its own correlates with observed LOCAL EXCESS at rho = -0.003,
# i.e. nothing. It is genuinely active — 16.7% of evaluated hours are fully
# rain-suppressed — so this is not a wiring bug.
#
# The reason is definitional: rain suppresses PM2.5 across the whole city at
# once, and local excess is ward PM2.5 MINUS the city median for that hour,
# so a city-wide effect largely cancels out of the target by construction.
# The correction is still physically right and still belongs here (it makes
# absolute dust emission correct, and would matter for any absolute-
# concentration use), but it should not be expected to move within-ward
# skill against a local-excess target.
#
# Applying it per-ward rather than city-wide would not fix this either;
# Delhi-scale rain is spatially coherent over an hour, so the per-ward
# values are nearly identical anyway.
PRECIP_WET_THRESHOLD_MM: float = 0.254   # AP-42's "wet hour" definition (0.01 in)
PRECIP_CREDIT_FACTOR: float = 0.80       # the 20% credit
PRECIP_CREDIT_MAX_HOURS: int = 12


def precipitation_factor(
    precip_mm: float | None,
    recent_wet_hours: int = 0,
) -> float:
    """Multiplier in [0, 1] applied to road-dust emission for one hour.

    `precip_mm`        this hour's precipitation.
    `recent_wet_hours` consecutive wet hours immediately preceding this one,
                       used to size the post-rain credit window.

    Returns 0.0 while it is raining, 0.8 during the credit window after rain
    stops, and 1.0 otherwise.
    """
    if precip_mm is not None and precip_mm >= PRECIP_WET_THRESHOLD_MM:
        return 0.0
    if recent_wet_hours > 0:
        return PRECIP_CREDIT_FACTOR
    return 1.0


def paved_road_dust_emission(
    length_km_by_class: dict[str, float],
    precip_factor: float = 1.0,
    silt_scaling: float = INDIA_SILT_SCALING,
) -> float:
    """PM2.5 road-dust emission for one grid cell, grams per vehicle-km-ish.

    Applies AP-42 13.2.1 Eq 1 per road class, then length-weights. Units are
    deliberately left RELATIVE rather than absolute: the kernel consumes
    emission weights whose scale is fixed by its own road/industrial
    calibration step, and claiming an absolute g/s here would imply a
    traffic-volume calibration this has no data for (no AADT — see module
    docstring).

    Returns 0.0 for an empty or all-zero-length cell.
    """
    if not length_km_by_class:
        return 0.0

    total = 0.0
    w_term = FLEET_AVG_WEIGHT_TONS ** AP42_W_EXPONENT
    for hw_class, length_km in length_km_by_class.items():
        if not length_km or length_km <= 0:
            continue
        sl = _SILT_LOADING_BY_CLASS.get(hw_class, _DEFAULT_SILT_LOADING) * silt_scaling
        ef = AP42_K_PM25_G_PER_VKT * (sl ** AP42_SL_EXPONENT) * w_term
        # Length-weighted: a cell's dust scales with how much road it holds,
        # exactly as the traffic source's own length weighting does.
        total += ef * length_km
    return total * precip_factor


# ── Construction dust (WRAP Fugitive Dust Handbook) ──────────────────────────
#
# WRAP is preferred over AP-42 13.2.3 here. AP-42 13.2.3 offers a single
# TSP number (1.2 tons/acre/month) derived from one set of field tests, and
# WRAP explicitly declined to adopt it for that reason. WRAP's factors are
# PM10-specific and better documented.
#
#   0.11 ton PM10 / acre / month   (average activity)
#   0.42 ton PM10 / acre / month   (worst case)
#
# 1 acre = 4046.86 m^2; a 30-day month = 2.592e6 s.
#   0.11 short ton = 99,790 g
#   -> 99,790 / (4046.86 * 2.592e6) = 9.51e-6 g/m^2/s PM10
WRAP_CONSTRUCTION_PM10_G_PER_M2_S: float = 9.51e-6

# PM2.5/PM10 ratio for construction and demolition fugitive dust.
#
# WRAP gives 0.10. IIT Kanpur's 2016 Delhi study implies 0.25 (from their
# Table 3.1 size split). That is a real 2.5x disagreement between a
# better-sourced general factor and a Delhi-specific one.
#
# WRAP's 0.10 is used because it is the better-documented value and because
# the conservative choice is preferable while the windblown gap already
# means this module understates total dust — inflating a second parameter
# to compensate would compound an error rather than correct it.
CONSTRUCTION_PM25_PM10_RATIO: float = 0.10

# Fraction of OSM landuse=construction polygons assumed to be ACTIVELY
# worked at any given time.
#
# WRAP's factor is per acre of active construction. OSM construction
# polygons are frequently stale (a site tagged during building often stays
# tagged long after completion) and carry no activity duration. This is an
# explicit ASSUMPTION with no citation behind it, isolated as one named
# constant so it is auditable and easy to revise.
CONSTRUCTION_ACTIVITY_FRACTION: float = 0.5


def construction_dust_emission(area_m2: float) -> float:
    """PM2.5 construction-dust emission for one site, g/s.

    Unlike road dust this IS an absolute rate, because WRAP's factor is
    per unit area and the area is real OSM geometry — no traffic-volume
    surrogate is involved.
    """
    if not area_m2 or area_m2 <= 0:
        return 0.0
    return (
        area_m2
        * WRAP_CONSTRUCTION_PM10_G_PER_M2_S
        * CONSTRUCTION_PM25_PM10_RATIO
        * CONSTRUCTION_ACTIVITY_FRACTION
    )


def build_road_dust_sources(
    road_cells: list[dict],
    precip_factor: float = 1.0,
) -> list[dict]:
    """Convert grid-aggregated road cells into dust sources for the kernel.

    `road_cells` is vayutrace_osm_roads.load_delhi_roads() output, which
    carries `length_km_by_class` for exactly this purpose.

    Emits source dicts of type 'dust' — the same shape every other
    VayuTrace source uses, so run_kernel consumes them with no special
    casing.
    """
    out: list[dict] = []
    for cell in road_cells:
        by_class = cell.get("length_km_by_class") or {}
        ew = paved_road_dust_emission(by_class, precip_factor=precip_factor)
        if ew <= 0:
            continue
        out.append({
            "lat": cell["lat"],
            "lng": cell["lng"],
            "emission_weight": ew,
            "source_type": "dust",
            "dust_kind": "road",   # diagnostic; kernel groups on source_type
        })
    return out


# Scale factor putting the absolute construction rate (g/s) onto the same
# relative footing as the road-dust weights above, which are deliberately
# relative (no AADT — see paved_road_dust_emission).
#
# Without this the two dust kinds are in incompatible units and their ratio
# is meaningless. This is a UNIT-RECONCILIATION constant, not a physical
# one — isolated here so it stays visible and auditable.
#
# CALIBRATED, not guessed. ARAI/TERI 2018 (Tables 5.3-5.6) gives Delhi PM2.5
# contributions of road dust 4% (winter) / 3% (summer) against construction
# 1% / 2%, so construction should total roughly 0.25-0.67x road dust
# city-wide; the midpoint 0.45 is targeted.
#
# Against this deployment's real inventory (8,963 road cells, 238
# construction/disturbed sites totalling ~20.1 km^2):
#     road dust weight total  41,805
#     construction raw        9.10 g/s
#     -> scale = 0.45 * 41805 / 9.10 ~= 2067
#
# An earlier hand-picked value of 4e6 was wrong by ~2000x and made
# construction outweigh road dust ~870:1, inverting the published ratio.
# Recalculate this if the source inventories change materially.
CONSTRUCTION_TO_ROAD_SCALE: float = 2067.0


def build_construction_dust_sources(sites: list[dict]) -> list[dict]:
    """Convert OSM construction/disturbed-land sites into kernel sources.

    `sites` is vayutrace_osm_construction.load_delhi_construction_sites()
    output. Each site's per-landuse activity weight is applied on top of
    the WRAP area factor.
    """
    out: list[dict] = []
    for s in sites:
        g_per_s = construction_dust_emission(s.get("area_m2", 0.0))
        if g_per_s <= 0:
            continue
        ew = g_per_s * float(s.get("activity_weight", 1.0)) * CONSTRUCTION_TO_ROAD_SCALE
        out.append({
            "lat": s["lat"],
            "lng": s["lng"],
            "emission_weight": ew,
            "source_type": "dust",
            "dust_kind": "construction",
        })
    return out
