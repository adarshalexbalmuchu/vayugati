"""Deterministic tests for capped (repo_current) vs uncapped
(cpcb_workbook_formula_exact) behaviour above tier 5 — this is the one behavioural
difference the whole harness exists to surface.

PM10's real divergence point is C=430 (tier 5's own ceiling), NOT 600 —
repo_current's breakpoint table has an extra, WRONG (430,600,400,500) tier
that the decoded workbook formula does not contain (see
methodology_manifest.json's contamination_audit). Expected values below
(510->500, 511->501, 600->613, 601->614, 756->808, 785->844, 1400->1613)
are transcribed directly from the decoded BIFF8 formula, verified with
exact fraction arithmetic during this harness's correction pass — not
fitted to match anything.
"""

from aqi_harness.compare import compare
from aqi_harness.fixtures.severe_fixtures import PM10_SEVERE_FIXTURES
from aqi_harness.models import ComparisonInput

TS = "2026-08-21T00:00:00Z"


def _by_id(fixture_id: str) -> ComparisonInput:
    return next(f for f in PM10_SEVERE_FIXTURES if f.fixture_id == fixture_id)


def test_both_profiles_agree_through_tier_5_ceiling():
    # PM10=430 is tier 5's own ceiling — the last point where repo_current's
    # table and the decoded workbook formula are the same formula.
    result = compare(_by_id("pm10_430"))
    assert result.repo_current.rounded_sub_index == 400
    assert result.repo_current.cap_applied is False
    assert result.cpcb_workbook_formula_exact.rounded_sub_index == 400
    assert result.cpcb_workbook_formula_exact.cap_applied is False
    assert result.absolute_difference_rounded == 0


def test_cpcb_workbook_formula_exact_reaches_500_at_510_not_600():
    result = compare(_by_id("pm10_510"))
    assert result.cpcb_workbook_formula_exact.rounded_sub_index == 500
    assert result.cpcb_workbook_formula_exact.category_label == "Severe"
    # repo_current, still following its own (430,600,400,500) tier, has
    # NOT reached 500 yet at 510 — this is exactly the divergence this
    # correction pass exists to surface.
    assert result.repo_current.rounded_sub_index == 447
    assert result.absolute_difference_rounded == 53


def test_pm10_expected_values_transcribed_from_the_decoded_formula():
    expected = {
        "pm10_510": 500,
        "pm10_511": 501,
        "pm10_600": 613,
        "pm10_601": 614,
        "pm10_756": 808,
        "pm10_785": 844,
        "pm10_1400": 1613,
    }
    for fixture_id, expected_aqi in expected.items():
        result = compare(_by_id(fixture_id))
        assert result.cpcb_workbook_formula_exact.rounded_sub_index == expected_aqi, fixture_id
        assert result.cpcb_workbook_formula_exact.cap_applied is False


def test_repo_current_never_exceeds_500_no_matter_how_extreme():
    # pm10_600 sits exactly at repo_current's own (wrong, but real) top
    # tier ceiling (430,600,400,500) — reached via ordinary in-table
    # interpolation, cap_applied=False there. 601 and beyond genuinely fall
    # through repo_current's table and hit its hard-coded 500 clamp.
    for fixture_id in ("pm10_601", "pm10_756", "pm10_785", "pm10_1400"):
        result = compare(_by_id(fixture_id))
        assert result.repo_current.rounded_sub_index == 500
        assert result.repo_current.cap_applied is True
        assert result.repo_current.display_value == 500
        assert result.repo_current.category_label == "Severe"

    at_repos_own_ceiling = compare(_by_id("pm10_600"))
    assert at_repos_own_ceiling.repo_current.rounded_sub_index == 500
    assert at_repos_own_ceiling.repo_current.cap_applied is False


def test_cpcb_workbook_formula_exact_grows_monotonically_with_concentration_uncapped():
    values = [compare(f).cpcb_workbook_formula_exact.rounded_sub_index for f in PM10_SEVERE_FIXTURES]
    assert values == sorted(values), "uncapped profile must be monotonically non-decreasing with concentration"
    assert values[-1] > 500, "the most extreme fixture (1400 ug/m3) must exceed 500 when uncapped"


def test_cpcb_workbook_formula_exact_above_500_has_no_display_value_or_category_label():
    # The harness must not assume CPCB's public-display policy above 500.
    result = compare(_by_id("pm10_1400"))
    assert result.cpcb_workbook_formula_exact.rounded_sub_index > 500
    assert result.cpcb_workbook_formula_exact.display_value is None
    assert result.cpcb_workbook_formula_exact.category_label is None


def test_absolute_difference_grows_with_concentration_above_the_ceiling():
    d601 = compare(_by_id("pm10_601")).absolute_difference_rounded
    d756 = compare(_by_id("pm10_756")).absolute_difference_rounded
    d1400 = compare(_by_id("pm10_1400")).absolute_difference_rounded
    assert d601 < d756 < d1400


def test_so2_no2_co_also_diverge_from_repo_above_their_real_tier5_ceiling():
    # The contamination wasn't PM10-only — SO2, NO2, and CO all had a wrong
    # top-tier slope in the pre-correction profile too.
    so2 = compare(ComparisonInput(pollutant="so2", concentration=2100, declared_unit="ug/m3", averaging_window="24h", observation_ts=TS, fixture_id="t"))
    assert so2.repo_current.rounded_sub_index == 500  # repo's (1600,2100,400,500) tier says so
    assert so2.cpcb_workbook_formula_exact.rounded_sub_index == 463  # real formula: 400+(2100-1600)*100/800

    no2 = compare(ComparisonInput(pollutant="no2", concentration=800, declared_unit="ug/m3", averaging_window="24h", observation_ts=TS, fixture_id="t"))
    assert no2.repo_current.rounded_sub_index == 500  # repo's (400,800,400,500) tier says so
    assert no2.cpcb_workbook_formula_exact.rounded_sub_index == 733  # real formula: 400+(800-400)*100/120

    co = compare(ComparisonInput(pollutant="co", concentration=48, declared_unit="mg/m3", averaging_window="8h", observation_ts=TS, fixture_id="t"))
    assert co.repo_current.rounded_sub_index == 500  # repo's (34,48,400,500) tier says so
    assert co.cpcb_workbook_formula_exact.rounded_sub_index == 482  # real formula: 400+(48-34)*100/17


def test_pm25_and_nh3_were_not_contaminated():
    # These two happened to already be correct — repo_current's assumed
    # top-tier slope matches the decoded formula's tail slope exactly for
    # both, so both profiles agree even past repo's "cap" boundary, right
    # up to where cpcb_workbook_formula_exact stops being capped.
    pm25 = compare(ComparisonInput(pollutant="pm25", concentration=380, declared_unit="ug/m3", averaging_window="24h", observation_ts=TS, fixture_id="t"))
    assert pm25.repo_current.rounded_sub_index == 500
    assert pm25.cpcb_workbook_formula_exact.rounded_sub_index == 500
    assert pm25.absolute_difference_rounded == 0

    nh3 = compare(ComparisonInput(pollutant="nh3", concentration=2400, declared_unit="ug/m3", averaging_window="24h", observation_ts=TS, fixture_id="t"))
    assert nh3.repo_current.rounded_sub_index == 500
    assert nh3.cpcb_workbook_formula_exact.rounded_sub_index == 500
    assert nh3.absolute_difference_rounded == 0
