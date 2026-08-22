"""Deterministic tests for unit handling — the harness must never silently
convert or interpret a declared_unit it can't confirm."""

from aqi_harness.compare import compare
from aqi_harness.models import ComparisonInput

TS = "2026-08-21T00:00:00Z"


def _inp(pollutant: str, concentration: float, unit: str) -> ComparisonInput:
    return ComparisonInput(
        pollutant=pollutant,
        concentration=concentration,
        declared_unit=unit,
        averaging_window="24h",
        observation_ts=TS,
        fixture_id="unit_test",
    )


def test_co_with_unrecognized_unit_computes_nothing():
    result = compare(_inp("co", 40, "ppm"))
    assert result.repo_current.rounded_sub_index is None
    assert result.repo_current.formula_branch == "unit_undeclared_or_unrecognized"
    assert any("not silently interpreted" in w for w in result.repo_current.warnings)
    assert result.cpcb_workbook_formula_exact.rounded_sub_index is None


def test_co_with_no_declared_unit_computes_nothing():
    result = compare(_inp("co", 40, ""))
    assert result.repo_current.rounded_sub_index is None
    assert result.cpcb_workbook_formula_exact.rounded_sub_index is None


def test_co_unit_semantics_warning_always_present_even_when_unit_is_unambiguous():
    result = compare(_inp("co", 40, "mg/m3"))
    assert result.repo_current.rounded_sub_index is not None  # DOES compute...
    assert any("unresolved: CO unit semantics" in w for w in result.unresolved_policy_warnings)  # ...but still flags


def test_co_ug_to_mg_conversion_matches_equivalent_mg_value():
    mg_result = compare(_inp("co", 10, "mg/m3"))
    ug_result = compare(_inp("co", 10_000, "ug/m3"))
    assert mg_result.repo_current.rounded_sub_index == ug_result.repo_current.rounded_sub_index
    assert mg_result.cpcb_workbook_formula_exact.rounded_sub_index == ug_result.cpcb_workbook_formula_exact.rounded_sub_index


def test_pm10_with_mismatched_unit_computes_nothing():
    # Declaring PM10 in mg/m3 (not ug/m3) must not be silently reinterpreted
    # as if it were the expected unit, nor silently converted.
    result = compare(_inp("pm10", 0.6, "mg/m3"))
    assert result.repo_current.rounded_sub_index is None
    assert result.repo_current.formula_branch == "unit_mismatch"
    assert result.cpcb_workbook_formula_exact.rounded_sub_index is None


def test_pm10_with_equivalent_unit_spelling_is_recognized_not_converted():
    # "µg/m³" and "ug/m3" are the SAME declared unit, different spelling —
    # normalizing spelling is not the same as converting a different unit.
    plain = compare(_inp("pm10", 200, "ug/m3"))
    unicode_spelling = compare(_inp("pm10", 200, "µg/m³"))
    assert plain.repo_current.rounded_sub_index == unicode_spelling.repo_current.rounded_sub_index


def test_missing_unit_still_computes_but_warns():
    # No declared_unit at all: computed (assuming the profile's only defined
    # unit), but the assumption is surfaced, not hidden.
    result = compare(_inp("pm10", 200, ""))
    assert result.repo_current.rounded_sub_index is not None
    assert any("no declared_unit provided" in w for w in result.repo_current.warnings)


def test_o3_above_208_always_carries_averaging_behaviour_warning():
    result = compare(_inp("o3", 300, "ug/m3"))
    assert any("O3 averaging behaviour above 208" in w for w in result.unresolved_policy_warnings)


def test_o3_at_or_below_208_does_not_carry_the_averaging_warning():
    result = compare(_inp("o3", 100, "ug/m3"))
    assert not any("O3 averaging behaviour" in w for w in result.unresolved_policy_warnings)
