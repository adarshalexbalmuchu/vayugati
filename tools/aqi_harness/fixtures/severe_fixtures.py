"""Synthetic severe-range fixtures — no live station data, no network calls.
Every fixture is a hand-specified (pollutant, concentration) pair with a
plausible but SYNTHETIC observation_ts; none of these claim to be a real
CPCB reading. See future_cpcb_observations.py for the (currently empty)
schema reserved for real, timestamp-matched station data.
"""

from __future__ import annotations

from ..models import ComparisonInput

_SYNTHETIC_TS = "2026-08-21T00:00:00Z"


def _fx(fixture_id: str, pollutant: str, concentration: float, unit: str, window: str, notes: str = "") -> ComparisonInput:
    return ComparisonInput(
        pollutant=pollutant,
        concentration=concentration,
        declared_unit=unit,
        averaging_window=window,
        observation_ts=_SYNTHETIC_TS,
        source="synthetic_fixture",
        fixture_id=fixture_id,
        notes=notes,
    )


# ── PM10: the explicit values from the harness brief ────────────────────────
# Ranges: 430-510, 510-600, above 600 (see compare._comparison_range). 430 is
# the REAL tier-5 ceiling (both profiles agree there); 510 is where
# cpcb_workbook_formula_exact's uncapped tail crosses 500 (repo_current is still at
# 447 there — see test_cap_vs_uncapped.py); 600 is repo_current's OWN
# top-tier ceiling from ingest/app/aqi.py's (430,600,400,500) tuple, which
# does not exist in the decoded workbook formula at all — reached there via
# repo_current's ordinary in-table interpolation (still 500, cap_applied
# False), not its cap.
PM10_SEVERE_FIXTURES: list[ComparisonInput] = [
    _fx("pm10_430", "pm10", 430, "ug/m3", "24h", "tier-5 ceiling — both profiles agree here, last point they do"),
    _fx("pm10_431", "pm10", 431, "ug/m3", "24h", "one past tier-5 — cpcb_workbook_formula_exact is already in its uncapped tail"),
    _fx("pm10_510", "pm10", 510, "ug/m3", "24h", "cpcb_workbook_formula_exact reaches exactly 500 here; repo_current is still at 447"),
    _fx("pm10_511", "pm10", 511, "ug/m3", "24h", "cpcb_workbook_formula_exact now exceeds 500 (501); repo_current still below its own cap"),
    _fx("pm10_600", "pm10", 600, "ug/m3", "24h", "repo_current's OWN (uncontaminated-looking) top-tier ceiling — still ordinary interpolation for it, cap_applied=False"),
    _fx("pm10_601", "pm10", 601, "ug/m3", "24h", "one past repo_current's table — its hard 500 clamp genuinely engages here"),
    _fx("pm10_756", "pm10", 756, "ug/m3", "24h", "well above ceiling"),
    _fx("pm10_785", "pm10", 785, "ug/m3", "24h", "well above ceiling"),
    _fx("pm10_1400", "pm10", 1400, "ug/m3", "24h", "extreme — 2026 Delhi-plausible worst case"),
]

# ── Severe-range fixtures for every other supported pollutant ──────────────
# One at the table's own top boundary, one clearly past it, for the same
# in-range/above-ceiling contrast PM10 demonstrates. Pb has no fixtures:
# neither ingest/app/aqi.py nor the extracted workbook sheet defines it —
# see methodology_manifest.json.

# PM2.5 was NOT contaminated — repo_current's assumed top-tier slope
# happens to equal the decoded formula's tail slope exactly, so 380 is a
# real crossing point for BOTH profiles (see contamination_audit in the
# manifest). 450 is past it, uncapped divergence only from 500 upward.
PM25_SEVERE_FIXTURES: list[ComparisonInput] = [
    _fx("pm25_380", "pm25", 380, "ug/m3", "24h", "both profiles reach exactly 500 here — not contaminated"),
    _fx("pm25_450", "pm25", 450, "ug/m3", "24h", "past the 500 crossing — repo_current caps, cpcb_workbook_formula_exact keeps climbing"),
]

# NO2 IS contaminated: repo_current's (400,800,400,500) top tier does not
# exist in the decoded formula — the real tail continues tier 5's own
# slope (300,400 -> 400+(C-400)*100/120) from C=400, reaching 500 at
# C=520, not 800.
NO2_SEVERE_FIXTURES: list[ComparisonInput] = [
    _fx("no2_400", "no2", 400, "ug/m3", "24h", "real tier-5 ceiling — both profiles agree here (400)"),
    _fx("no2_520", "no2", 520, "ug/m3", "24h", "cpcb_workbook_formula_exact reaches exactly 500 here; repo_current, still on its own table, is not yet at 500"),
    _fx("no2_800", "no2", 800, "ug/m3", "24h", "repo_current's own (contaminated) top-tier ceiling — 500 for repo_current, 733 for cpcb_workbook_formula_exact"),
    _fx("no2_950", "no2", 950, "ug/m3", "24h", "well above both ceilings"),
]

# SO2 IS contaminated: repo_current's (1600,2100,400,500) top tier does not
# exist in the decoded formula — real tail continues tier 5's slope
# (300,400 -> 400+(C-1600)*100/800) from C=1600, reaching 500 at C=2400,
# not 2100.
SO2_SEVERE_FIXTURES: list[ComparisonInput] = [
    _fx("so2_1600", "so2", 1600, "ug/m3", "24h", "real tier-5 ceiling — both profiles agree here (400)"),
    _fx("so2_2100", "so2", 2100, "ug/m3", "24h", "repo_current's own (contaminated) top-tier ceiling — 500 for repo_current, 463 for cpcb_workbook_formula_exact"),
    _fx("so2_2400", "so2", 2400, "ug/m3", "24h", "cpcb_workbook_formula_exact reaches exactly 500 here; repo_current has been capped at 500 since 2100"),
    _fx("so2_2500", "so2", 2500, "ug/m3", "24h", "above both ceilings"),
]

# CO IS contaminated too (real 500-crossing at 51 mg/m3, not 48). Every CO
# fixture carries the "unresolved: CO unit semantics" warning
# unconditionally (see profiles/*.py) regardless of which declared_unit is
# used here — declared_unit is still varied across fixtures to exercise
# the mg/ug conversion path honestly.
CO_SEVERE_FIXTURES: list[ComparisonInput] = [
    _fx("co_34mg", "co", 34, "mg/m3", "8h", "real tier-5 ceiling — both profiles agree here (400)"),
    _fx("co_48mg", "co", 48, "mg/m3", "8h", "repo_current's own (contaminated) top-tier ceiling — 500 for repo_current, 482 for cpcb_workbook_formula_exact"),
    _fx("co_51mg", "co", 51, "mg/m3", "8h", "cpcb_workbook_formula_exact reaches exactly 500 here; repo_current has been capped at 500 since 48"),
    _fx("co_60mg", "co", 60, "mg/m3", "8h", "above both ceilings, unambiguous unit"),
    _fx("co_48000ug", "co", 48000, "ug/m3", "8h", "same physical concentration as co_48mg, declared in ug/m3 — exercises the conversion path"),
]

# O3 is the one profile whose decoded formula is genuinely discontinuous —
# a workbook formula artifact under investigation, NOT a confirmed CPCB
# policy (see profiles/cpcb_workbook_formula_exact.py's
# _o3_sub_index_uncapped and methodology_manifest.json's o3_discontinuity)
# — fixtures straddle both 208 (averaging-behaviour question starts) and
# 748 (the actual jump).
O3_SEVERE_FIXTURES: list[ComparisonInput] = [
    _fx("o3_208", "o3", 208, "ug/m3", "8h", "tier-4/tier-5 boundary — averaging-behaviour question starts here"),
    _fx("o3_748", "o3", 748, "ug/m3", "8h", "last point before the formula's real discontinuity — still ~400"),
    _fx("o3_749", "o3", 749, "ug/m3", "8h", "one unit past 748 — the ~64-point discontinuous jump has already happened here"),
    _fx("o3_1000", "o3", 1000, "ug/m3", "8h", "well into the discontinuous tail"),
    _fx("o3_1200", "o3", 1200, "ug/m3", "8h", "further into the discontinuous tail"),
]

NH3_SEVERE_FIXTURES: list[ComparisonInput] = [
    _fx("nh3_2400", "nh3", 2400, "ug/m3", "24h", "both profiles reach exactly 500 here — not contaminated"),
    _fx("nh3_2800", "nh3", 2800, "ug/m3", "24h", "past the 500 crossing — repo_current caps, cpcb_workbook_formula_exact keeps climbing"),
]

ALL_SEVERE_FIXTURES: list[ComparisonInput] = [
    *PM10_SEVERE_FIXTURES,
    *PM25_SEVERE_FIXTURES,
    *NO2_SEVERE_FIXTURES,
    *SO2_SEVERE_FIXTURES,
    *CO_SEVERE_FIXTURES,
    *O3_SEVERE_FIXTURES,
    *NH3_SEVERE_FIXTURES,
]
