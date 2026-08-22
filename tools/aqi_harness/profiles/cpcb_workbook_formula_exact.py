"""cpcb_workbook_formula_exact profile — transcribed DIRECTLY from the actual BIFF8
formula records in CPCB's official AQI-Calculator.xls, decoded via
xlrd.formula.decompile_formula (see
formula_extraction/extract_formulas.py and
formula_extraction/decoded_formulas.json). NOT derived from
ingest/app/aqi.py, and NOT curve-fit to any expected output — every
breakpoint number and slope below is copied verbatim from the decoded
formula text.

CORRECTION HISTORY: an earlier version of this profile copied
ingest/app/aqi.py's breakpoint tables directly, on the assumption that
repo_current's numbers already matched the official workbook (they matched
for the tiers this workbook's own worked example exercises — see
methodology_manifest.json). They do NOT match for the workbook's SEVERE
band: PM10, SO2, NO2, and CO all use a materially different top-tier
formula than ingest/app/aqi.py assumes. See
methodology_manifest.json -> contamination_audit for the pollutant-by-
pollutant comparison. This file has been corrected to match the decoded
formulas exactly.

Every pollutant except O3 has the SAME shape once decoded: five finite
tiers (identical to the CPCB 2014 table's Good..Very-Poor bands), and then
an unconditional `IF(C > tier5_ceiling, tier5_I_hi + (C - tier5_ceiling) *
tier5_slope)` — i.e. the workbook does not define a distinct "Severe" tier
with its own slope at all. It just keeps extending the Very-Poor tier's
own slope forever, uncapped. Nothing in the file's IF-chain ever tests
against 500 or clamps to it.

O3 is different and is NOT modelled as "extend the last tier's slope" —
its own decoded formula's tail term is
`400.0+(C18-400.0)*100.0/539.0` for C18>748, which anchors on 400 instead
of 748 (the tier boundary) and divides by 539 instead of 540 (the tier's
own concentration span, 748-208). This is a workbook formula artifact
under investigation, not a confirmed CPCB policy — this profile preserves
it exactly rather than "fixing" it — see
_o3_sub_index_uncapped's own docstring and
methodology_manifest.json -> o3_discontinuity.
"""

from __future__ import annotations

import math

from ..models import ComparisonInput, ProfileResult

PROFILE_VERSION = (
    "cpcb_workbook_formula_exact@2 (AQI-Calculator.xls sha256 in manifest; "
    "formulas decoded verbatim from BIFF8 records, see formula_extraction/)"
)

# Five real, finite tiers per pollutant — decoded verbatim from
# formula_extraction/decoded_formulas.json. Identical numbers to
# ingest/app/aqi.py's tiers 1-5 for every pollutant (confirmed in
# methodology_manifest.json's contamination_audit); the divergence is
# entirely in what happens AFTER tier 5, handled by
# sub_index_uncapped below, not in these tuples.
PM25_TIERS = [(0, 30, 0, 50), (30, 60, 50, 100), (60, 90, 100, 200), (90, 120, 200, 300), (120, 250, 300, 400)]
PM10_TIERS = [(0, 50, 0, 50), (50, 100, 50, 100), (100, 250, 100, 200), (250, 350, 200, 300), (350, 430, 300, 400)]
NO2_TIERS = [(0, 40, 0, 50), (40, 80, 50, 100), (80, 180, 100, 200), (180, 280, 200, 300), (280, 400, 300, 400)]
SO2_TIERS = [(0, 40, 0, 50), (40, 80, 50, 100), (80, 380, 100, 200), (380, 800, 200, 300), (800, 1600, 300, 400)]
# mg/m3 — the workbook's own column header reads "concentration in µg/m3
# (except for CO)", confirming CO is the one pollutant NOT in µg/m³ there too.
CO_TIERS_MG = [(0, 1, 0, 50), (1, 2, 50, 100), (2, 10, 100, 200), (10, 17, 200, 300), (17, 34, 300, 400)]
NH3_TIERS = [(0, 200, 0, 50), (200, 400, 50, 100), (400, 800, 100, 200), (800, 1200, 200, 300), (1200, 1800, 300, 400)]
# O3's first four tiers only — its 5th tier and tail are handled by
# _o3_sub_index_uncapped, not by sub_index_uncapped's generic tier-5-slope
# extension, because O3's tail does not continue tier 5's slope from tier
# 5's own boundary (see module docstring).
O3_TIERS_HEAD = [(0, 50, 0, 50), (50, 100, 50, 100), (100, 168, 100, 200), (168, 208, 200, 300)]

_TIERS_BY_POLLUTANT = {
    "pm25": PM25_TIERS,
    "pm10": PM10_TIERS,
    "no2": NO2_TIERS,
    "so2": SO2_TIERS,
    "co": CO_TIERS_MG,
    "nh3": NH3_TIERS,
}

_EXPECTED_UNIT = {p: ("mg/m3" if p == "co" else "ug/m3") for p in (*_TIERS_BY_POLLUTANT, "o3")}

_CATEGORY_LABELS = [
    (50, "Good"),
    (100, "Satisfactory"),
    (200, "Moderate"),
    (300, "Poor"),
    (400, "Very Poor"),
    (500, "Severe"),
]


def _category_label(rounded: int | None) -> str | None:
    # The harness must not assume CPCB's public-display policy above 500 —
    # so no label is ever returned above 500, even though this profile is
    # perfectly capable of computing a rounded value up there.
    if rounded is None or rounded > 500:
        return None
    for ceiling, label in _CATEGORY_LABELS:
        if rounded <= ceiling:
            return label
    return None


def _normalize_unit(raw: str) -> str:
    # Spelling normalization only (µ/μ -> u, ³ -> 3, drop whitespace) — never
    # a unit CONVERSION. "µg/m³" and "ug/m3" are the same declared unit
    # written differently; "mg/m3" and "ug/m3" are not, and must not be
    # collapsed here.
    return raw.strip().lower().replace("µ", "u").replace("μ", "u").replace("³", "3").replace(" ", "")


def co_ug_to_mg(value: float) -> float:
    return value / 1000.0


def sub_index_uncapped(value: float, tiers: list[tuple]) -> tuple[float, str]:
    """The shared shape every pollutant except O3 decodes to: five finite
    tiers, then unconditionally extend tier 5's own slope from tier 5's own
    upper boundary, forever, uncapped. Returns (raw_value, formula_branch)."""
    if value <= 0:
        return 0.0, "value<=0:zero"
    for idx, (c_lo, c_hi, i_lo, i_hi) in enumerate(tiers):
        if value <= c_hi:
            raw = i_lo + (i_hi - i_lo) * (value - c_lo) / (c_hi - c_lo)
            return raw, f"tier {idx + 1}/{len(tiers)}: [{c_lo},{c_hi}] -> [{i_lo},{i_hi}]"
    c_lo, c_hi, i_lo, i_hi = tiers[-1]
    raw = i_lo + (i_hi - i_lo) * (value - c_lo) / (c_hi - c_lo)
    return raw, f"above_tier{len(tiers)}:extrapolated_same_slope_uncapped"


def _o3_sub_index_uncapped(value: float) -> tuple[float, str]:
    """O3's decoded formula, transcribed EXACTLY, including its quirks:

        IF(C<=50, C)
        IF(50<C<=100, 50+(C-50)*50/50)
        IF(100<C<=168, 100+(C-100)*100/68)
        IF(168<C<=208, 200+(C-168)*100/40)
        IF(208<C<=748, 300+(C-208)*100/539)      <- divisor is 539, not
                                                     748-208=540. Genuine
                                                     off-by-one in the
                                                     source workbook,
                                                     preserved as-is.
        IF(C>748,      400+(C-400)*100/539)      <- anchors on 400, NOT
                                                     748 (the tier
                                                     boundary) or even 208.
                                                     This creates a real
                                                     ~64-point DOWNWARD-then-
                                                     jump discontinuity at
                                                     C=748: the tier-5
                                                     branch gives ~400.19 at
                                                     C=748 itself, but the
                                                     very next value above
                                                     748 jumps to ~464.56.
                                                     Confirmed by decoding
                                                     the raw BIFF8 bytes
                                                     twice independently
                                                     (both occurrences of
                                                     539 are genuine PtgInt
                                                     literals, not a
                                                     decoder artifact — see
                                                     methodology_manifest.json
                                                     -> o3_discontinuity).

    This is a workbook formula artifact under investigation, not a
    confirmed CPCB policy or intentional design choice — a plausible
    hypothesis is an authoring typo in the original 2014/2015 spreadsheet
    (400 where 748 was perhaps meant, and/or 539 where 540 was perhaps
    meant), but that hypothesis is unconfirmed. This harness's job is to
    transcribe the workbook, not silently correct it. Every caller of this
    function gets an unresolved warning for any value that lands past 748
    (see evaluate() below).
    """
    if value <= 0:
        return 0.0, "value<=0:zero"
    if value <= 50:
        return value, "tier 1/5: [0,50] -> [0,50] (C, not interpolated)"
    if value <= 100:
        return 50 + (value - 50) * 50 / 50, "tier 2/5: [50,100] -> [50,100]"
    if value <= 168:
        return 100 + (value - 100) * 100 / 68, "tier 3/5: [100,168] -> [100,200]"
    if value <= 208:
        return 200 + (value - 168) * 100 / 40, "tier 4/5: [168,208] -> [200,300]"
    if value <= 748:
        return 300 + (value - 208) * 100 / 539, "tier 5/5: [208,748] -> [300,400] (workbook divisor is 539, not 540)"
    return (
        400 + (value - 400) * 100 / 539,
        "above_748:DISCONTINUOUS — workbook anchors this branch on 400, not 748; see docstring",
    )


def evaluate(inp: ComparisonInput) -> ProfileResult:
    warnings: list[str] = []
    pollutant = inp.pollutant
    expected_unit = _EXPECTED_UNIT[pollutant]
    declared = _normalize_unit(inp.declared_unit) if inp.declared_unit else ""

    value = inp.concentration

    if pollutant == "co":
        warnings.append(
            "unresolved: CO unit semantics — declared_unit is trusted at face value; whether every "
            "upstream source reliably distinguishes mg/m3 from ug/m3 for CO has not been independently "
            "verified against live CPCB station payloads (evidence-collection phase, DATA_GOV_API_KEY)."
        )
        if declared == "mg/m3":
            pass
        elif declared == "ug/m3":
            value = co_ug_to_mg(inp.concentration)
        else:
            warnings.append(
                f"unresolved-policy: CO declared_unit {inp.declared_unit!r} is neither mg/m3 nor ug/m3 — "
                "not silently interpreted. No sub-index computed."
            )
            return ProfileResult(
                profile="cpcb_workbook_formula_exact",
                profile_version=PROFILE_VERSION,
                raw_sub_index=None,
                rounded_sub_index=None,
                cap_applied=False,
                display_value=None,
                category_label=None,
                formula_branch="unit_undeclared_or_unrecognized",
                warnings=tuple(warnings),
            )
    elif declared and declared != expected_unit:
        warnings.append(
            f"unresolved-policy: declared_unit {inp.declared_unit!r} does not match the unit this profile "
            f"is defined for ({expected_unit!r}) for {pollutant}. Not silently converted. No sub-index computed."
        )
        return ProfileResult(
            profile="cpcb_workbook_formula_exact",
            profile_version=PROFILE_VERSION,
            raw_sub_index=None,
            rounded_sub_index=None,
            cap_applied=False,
            display_value=None,
            category_label=None,
            formula_branch="unit_mismatch",
            warnings=tuple(warnings),
        )
    elif not declared:
        warnings.append(
            f"unresolved-policy: no declared_unit provided for {pollutant} — assumed to match this "
            f"profile's expected unit ({expected_unit!r}), but this was NOT confirmed by the input."
        )

    if pollutant == "o3":
        if inp.concentration > 208:
            warnings.append(
                "unresolved: O3 averaging behaviour above 208 µg/m3 — CPCB documentation elsewhere describes "
                "averaging-window nuances for O3 that this harness has not verified against the workbook or "
                "live data; averaging_window is used as declared, unexamined."
            )
        if inp.concentration > 748:
            warnings.append(
                "unresolved: workbook formula artifact under investigation — O3's decoded formula produces an "
                "abrupt ~64-point upward jump at 748 µg/m3 (the branch for values above 748 anchors on 400 "
                "rather than the tier boundary 748, and divides by 539 instead of 540). This is NOT a confirmed "
                "CPCB policy or intentional design — it is preserved exactly as decoded from the BIFF8 formula "
                "record because this harness transcribes the workbook rather than correcting it, pending "
                "independent confirmation of whether it's an authoring error. See "
                "profiles/cpcb_workbook_formula_exact.py's _o3_sub_index_uncapped docstring."
            )
        raw, branch = _o3_sub_index_uncapped(value)
    else:
        raw, branch = sub_index_uncapped(value, _TIERS_BY_POLLUTANT[pollutant])

    rounded = math.floor(raw + 0.5)

    return ProfileResult(
        profile="cpcb_workbook_formula_exact",
        profile_version=PROFILE_VERSION,
        raw_sub_index=raw,
        rounded_sub_index=rounded,
        cap_applied=False,  # this profile never caps, by definition
        display_value=rounded if rounded <= 500 else None,
        category_label=_category_label(rounded),
        formula_branch=branch,
        warnings=tuple(warnings),
    )
