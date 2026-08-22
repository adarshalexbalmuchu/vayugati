"""Deterministic tests for half-up rounding — both profiles use
math.floor(raw + 0.5), confirmed against the workbook's own NH3 example
(34 ug/m3 -> raw 8.5 -> rounded 9, not Python's banker's-rounding 8)."""

from aqi_harness.compare import compare
from aqi_harness.models import ComparisonInput

TS = "2026-08-21T00:00:00Z"


def _inp(pollutant: str, concentration: float) -> ComparisonInput:
    return ComparisonInput(
        pollutant=pollutant,
        concentration=concentration,
        declared_unit="ug/m3",
        averaging_window="24h",
        observation_ts=TS,
        fixture_id=f"round_{pollutant}_{concentration}",
    )


def test_nh3_half_integer_rounds_up_matching_workbook_example():
    # This is the exact workbook-verified case: NH3=34 -> raw 8.5 -> 9.
    # Python's round(8.5) would give 8 (banker's rounding) — this MUST be 9.
    result = compare(_inp("nh3", 34))
    assert result.repo_current.raw_sub_index == 8.5
    assert result.repo_current.rounded_sub_index == 9
    assert result.cpcb_workbook_formula_exact.raw_sub_index == 8.5
    assert result.cpcb_workbook_formula_exact.rounded_sub_index == 9


def test_pm25_workbook_example_raw_value_exact():
    # Also workbook-verified: PM2.5=34 -> raw 56.666666666666664 -> 57.
    result = compare(_inp("pm25", 34))
    assert result.repo_current.raw_sub_index == 56.666666666666664
    assert result.repo_current.rounded_sub_index == 57


def test_pm10_workbook_example_exact():
    # Workbook-verified: PM10=121 -> 114 (already integral, doesn't exercise
    # rounding on its own, but confirms the interpolation formula itself).
    result = compare(_inp("pm10", 121))
    assert result.repo_current.rounded_sub_index == 114
    assert result.cpcb_workbook_formula_exact.rounded_sub_index == 114


def test_another_half_integer_case_rounds_up():
    # PM10 tier (100,250,100,200): value=104.375 -> raw = 100 + 100*4.375/150
    # = 102.916... not a clean half-integer; use a value engineered to land
    # exactly on .5: C such that 100*(C-100)/150 = k+0.5 for integer k.
    # k=0 -> C-100 = 0.75 -> C=100.75
    result = compare(_inp("pm10", 100.75))
    assert result.repo_current.raw_sub_index == 100.5
    assert result.repo_current.rounded_sub_index == 101  # half-up, not banker's-rounding-to-100
