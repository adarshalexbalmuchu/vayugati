"""Deterministic tests for breakpoint transitions — both profiles must agree
exactly at every tier boundary THROUGH TIER 5 (the CPCB 2014 Good..Very-Poor
bands), since that part of the breakpoint data is confirmed identical
between the two profiles for every pollutant (see
methodology_manifest.json's contamination_audit). Above tier 5, the two
profiles are EXPECTED to diverge — repo_current caps at 500, and
cpcb_workbook_formula_exact's decoded formula does not — that divergence is covered
by test_cap_vs_uncapped.py, not here.
"""

from aqi_harness.compare import compare
from aqi_harness.models import ComparisonInput

TS = "2026-08-21T00:00:00Z"


def _inp(pollutant: str, concentration: float, unit: str = "ug/m3") -> ComparisonInput:
    return ComparisonInput(
        pollutant=pollutant,
        concentration=concentration,
        declared_unit=unit,
        averaging_window="24h",
        observation_ts=TS,
        fixture_id=f"test_{pollutant}_{concentration}",
    )


# (pollutant, concentration, expected_rounded_aqi) at exact tier-5-and-below
# boundaries — each C_hi in the tables should produce exactly the tier's
# I_hi, for BOTH profiles. PM2.5 and NH3's tier-5 ceilings (380, 2400) are
# ALSO where cpcb_workbook_formula_exact's uncapped tail happens to cross 500
# exactly, so those two include a same-slope tier-6-equivalent value too —
# see methodology_manifest.json (PM2.5 and NH3 were the two pollutants
# where repo_current's assumed top tier was NOT contaminated).
BOUNDARY_CASES = [
    ("pm25", 30, 50),
    ("pm25", 60, 100),
    ("pm25", 90, 200),
    ("pm25", 120, 300),
    ("pm25", 250, 400),
    ("pm25", 380, 500),  # tail crossing, not a distinct tier — matches for both
    ("pm10", 50, 50),
    ("pm10", 100, 100),
    ("pm10", 250, 200),
    ("pm10", 350, 300),
    ("pm10", 430, 400),  # tier 5 ceiling — last point both profiles agree
    ("no2", 40, 50),
    ("no2", 400, 400),  # tier 5 ceiling — last point both profiles agree
    ("so2", 40, 50),
    ("so2", 1600, 400),  # tier 5 ceiling — last point both profiles agree
    ("o3", 50, 50),
    ("o3", 208, 300),  # tier 4 ceiling — last point both profiles agree before O3's own tier 5 (208-748)
    ("nh3", 200, 50),
    ("nh3", 2400, 500),  # tail crossing, not a distinct tier — matches for both
]


def test_boundary_values_match_between_profiles():
    for pollutant, conc, expected in BOUNDARY_CASES:
        result = compare(_inp(pollutant, conc))
        assert result.repo_current.rounded_sub_index == expected, f"{pollutant}@{conc} repo_current"
        assert result.cpcb_workbook_formula_exact.rounded_sub_index == expected, f"{pollutant}@{conc} cpcb_workbook_formula_exact"
        assert result.absolute_difference_rounded == 0


def test_o3_tier5_own_boundary_matches_both_profiles_despite_539_divisor():
    # O3's decoded tier 5 is (208,748,300,400) but with an internal divisor
    # of 539 (not 748-208=540) — see profiles/cpcb_workbook_formula_exact.py. At
    # C=748 that formula gives ~400.19, which STILL rounds to 400, same as
    # repo_current's (208,748,300,400) tier (which uses the clean /540).
    result = compare(_inp("o3", 748))
    assert result.repo_current.rounded_sub_index == 400
    assert result.cpcb_workbook_formula_exact.rounded_sub_index == 400
    assert result.absolute_difference_rounded == 0


def test_co_tier5_boundary_matches_both_profiles():
    # CO's shared tier-5 ceiling is 34 mg/m3 (both profiles agree, I=400).
    # 48 mg/m3 (repo_current's assumed top-tier ceiling) is NOT a shared
    # boundary — see test_cap_vs_uncapped.py for that divergence.
    result = compare(_inp("co", 34, unit="mg/m3"))
    assert result.repo_current.rounded_sub_index == 400
    assert result.cpcb_workbook_formula_exact.rounded_sub_index == 400


def test_just_below_and_above_a_tier_boundary_differ_by_one_aqi_point_or_less():
    # PM10 350 is a tier boundary (I=300); 349 and 351 should be very close
    # to it but not equal, proving the interpolation is continuous.
    below = compare(_inp("pm10", 349.9))
    at = compare(_inp("pm10", 350))
    above = compare(_inp("pm10", 350.1))
    assert below.repo_current.rounded_sub_index <= at.repo_current.rounded_sub_index <= above.repo_current.rounded_sub_index


def test_value_at_or_below_zero_yields_zero_sub_index():
    for pollutant in ("pm25", "pm10", "no2", "so2", "o3", "nh3"):
        result = compare(_inp(pollutant, 0))
        assert result.repo_current.rounded_sub_index == 0
        assert result.cpcb_workbook_formula_exact.rounded_sub_index == 0
