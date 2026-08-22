"""Deterministic tests for O3's genuine formula discontinuity at 748 ug/m3
— decoded verbatim from the workbook's BIFF8 formula record (see
profiles/cpcb_workbook_formula_exact.py's _o3_sub_index_uncapped and
methodology_manifest.json's o3_discontinuity). This is preserved exactly,
not smoothed into a continuous curve — these tests exist specifically to
catch anyone "fixing" it later without updating the manifest."""

from aqi_harness.compare import compare
from aqi_harness.models import ComparisonInput

TS = "2026-08-21T00:00:00Z"


def _inp(concentration: float) -> ComparisonInput:
    return ComparisonInput(
        pollutant="o3",
        concentration=concentration,
        declared_unit="ug/m3",
        averaging_window="8h",
        observation_ts=TS,
        fixture_id=f"o3_disc_{concentration}",
    )


def test_o3_tier5_uses_the_workbook_actual_539_divisor_not_540():
    # 748-208=540, which would be the "clean" divisor — the decoded formula
    # uses 539 instead (confirmed twice independently as a genuine PtgInt
    # literal in the raw BIFF8 bytes, not a decoder artifact).
    result = compare(_inp(748))
    raw = result.cpcb_workbook_formula_exact.raw_sub_index
    assert raw == 300 + (748 - 208) * 100 / 539
    assert raw != 400.0  # what a clean /540 divisor would give exactly


def test_o3_formula_jumps_upward_discontinuously_at_748():
    just_at = compare(_inp(748)).cpcb_workbook_formula_exact.raw_sub_index
    just_above = compare(_inp(748.001)).cpcb_workbook_formula_exact.raw_sub_index
    # A continuous formula would have just_above ~= just_at (differ by a
    # tiny epsilon). The real decoded formula jumps by roughly 64 points
    # instead, because its tail term anchors on 400, not 748.
    assert just_above - just_at > 60, "the workbook's real discontinuity should still be ~64 AQI points"


def test_o3_tail_formula_matches_the_decoded_400_anchor_exactly():
    # 400.0+(C18-400.0)*100.0/539.0 — transcribed verbatim, not "corrected"
    # to anchor on 748.
    result = compare(_inp(1000))
    raw = result.cpcb_workbook_formula_exact.raw_sub_index
    assert raw == 400 + (1000 - 400) * 100 / 539


def test_o3_discontinuity_warning_fires_only_past_748():
    # Wording deliberately says "workbook formula artifact under
    # investigation", not "confirmed CPCB policy" — this is preserved
    # transcription, not an assertion about CPCB's intent.
    below = compare(_inp(700))
    at = compare(_inp(748))
    above = compare(_inp(749))
    assert not any("workbook formula artifact under investigation" in w for w in below.unresolved_policy_warnings)
    assert not any("workbook formula artifact under investigation" in w for w in at.unresolved_policy_warnings)
    assert any("workbook formula artifact under investigation" in w for w in above.unresolved_policy_warnings)
    assert any("NOT a confirmed CPCB policy" in w for w in above.unresolved_policy_warnings)


def test_o3_formula_branch_labels_the_discontinuous_region():
    result = compare(_inp(900))
    assert "DISCONTINUOUS" in result.cpcb_workbook_formula_exact.formula_branch
