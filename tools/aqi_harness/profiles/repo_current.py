"""repo_current profile — reproduces this repository's production AQI logic
EXACTLY by importing ingest/app/aqi.py directly and calling its real,
unmodified functions. Nothing here re-implements or copies the breakpoint
tables: they are read from the live module object, so if production ever
changes, this profile changes with it automatically instead of silently
drifting out of sync.

Read-only: this module only ever calls functions already exported by
ingest/app/aqi.py. It never writes to that module, never patches it, and is
never imported BY it.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path
from types import ModuleType

from ..models import ComparisonInput, ProfileResult

PROFILE_VERSION = "repo_current@ingest/app/aqi.py (imported live, no copy)"


def _load_aqi_module() -> ModuleType:
    """Import the real ingest/app/aqi.py, mirroring how ingest/tests/test_aqi.py
    itself imports it (`from app.aqi import ...` with `ingest/` as the import
    root) — same convention, not a new one invented for this harness."""
    ingest_dir = Path(__file__).resolve().parents[3] / "ingest"
    if not ingest_dir.is_dir():
        raise RuntimeError(f"Expected ingest/ at {ingest_dir}, not found — repo layout changed?")
    ingest_str = str(ingest_dir)
    if ingest_str not in sys.path:
        sys.path.insert(0, ingest_str)
    import app.aqi as aqi_module  # noqa: PLC0415 — deliberate lazy/local import, see module docstring

    return aqi_module


aqi = _load_aqi_module()

_BREAKPOINTS_BY_POLLUTANT = {
    "pm25": aqi.PM25_BREAKPOINTS,
    "pm10": aqi.PM10_BREAKPOINTS,
    "no2": aqi.NO2_BREAKPOINTS,
    "so2": aqi.SO2_BREAKPOINTS,
    "co": aqi.CO_BREAKPOINTS_MG,
    "o3": aqi.O3_BREAKPOINTS,
    "nh3": aqi.NH3_BREAKPOINTS,
}

# What ingest/app/aqi.py's docstring declares as the expected input unit per
# pollutant (see aqi.py:5-10) — used only to detect a MISMATCH between the
# harness input's declared_unit and what production assumes; never to
# silently convert on the harness's own initiative.
_EXPECTED_UNIT = {p: ("mg/m3" if p == "co" else "ug/m3") for p in _BREAKPOINTS_BY_POLLUTANT}

_CATEGORY_LABELS = [
    (50, "Good"),
    (100, "Satisfactory"),
    (200, "Moderate"),
    (300, "Poor"),
    (400, "Very Poor"),
    (500, "Severe"),
]


def _category_label(rounded: int | None) -> str | None:
    if rounded is None or rounded > 500:
        return None
    for ceiling, label in _CATEGORY_LABELS:
        if rounded <= ceiling:
            return label
    return None  # unreachable given the > 500 guard above, kept explicit


def _normalize_unit(raw: str) -> str:
    # Spelling normalization only (µ/μ -> u, ³ -> 3, drop whitespace) — never
    # a unit CONVERSION. "µg/m³" and "ug/m3" are the same declared unit
    # written differently; "mg/m3" and "ug/m3" are not, and must not be
    # collapsed here.
    return raw.strip().lower().replace("µ", "u").replace("μ", "u").replace("³", "3").replace(" ", "")


def _raw_sub_index_if_in_table(value: float, breakpoints: list[tuple]) -> tuple[float | None, str]:
    """Mirrors aqi._sub_index's own bucket-selection loop exactly (same
    condition, same order) purely to recover the UNROUNDED value for
    transparency — aqi._sub_index itself only returns the final rounded/
    capped int and discards the raw float. Returns (raw_value_or_None,
    branch_description). raw_value is None when value is beyond the top
    breakpoint, because production's real code path never computes a raw
    value there either — it short-circuits straight to 500 (aqi.py:102)."""
    if value <= 0:
        return 0.0, "value<=0:zero"
    for idx, (c_lo, c_hi, i_lo, i_hi) in enumerate(breakpoints):
        if value <= c_hi:
            raw = i_lo + (i_hi - i_lo) * (value - c_lo) / (c_hi - c_lo)
            return raw, f"tier {idx + 1}/{len(breakpoints)}: [{c_lo},{c_hi}] -> [{i_lo},{i_hi}]"
    return None, "above_top_breakpoint:capped_500"


def evaluate(inp: ComparisonInput) -> ProfileResult:
    warnings: list[str] = []
    pollutant = inp.pollutant
    breakpoints = _BREAKPOINTS_BY_POLLUTANT[pollutant]
    expected_unit = _EXPECTED_UNIT[pollutant]
    declared = _normalize_unit(inp.declared_unit) if inp.declared_unit else ""

    value_mg_or_ug = inp.concentration

    if pollutant == "co":
        # Reproduces the REAL conversion path production already has
        # (ingest.py checks the CPCB unit field and calls aqi.co_ug_to_mg
        # when it isn't "MG/M3"; the OpenAQ path always converts since
        # OpenAQ reports CO in ug/m3) — not a conversion invented by this
        # harness. Still: CO unit semantics are explicitly unresolved (see
        # methodology_manifest.json) — this warning fires unconditionally
        # for every CO evaluation, not just ambiguous ones, per the harness
        # brief's explicit instruction to keep CO unit handling flagged.
        warnings.append(
            "unresolved: CO unit semantics — declared_unit is trusted at face value; whether every "
            "upstream source reliably distinguishes mg/m3 from ug/m3 for CO has not been independently "
            "verified against live CPCB station payloads (evidence-collection phase, DATA_GOV_API_KEY)."
        )
        if declared == "mg/m3":
            pass
        elif declared == "ug/m3":
            value_mg_or_ug = aqi.co_ug_to_mg(inp.concentration)
        else:
            warnings.append(
                f"unresolved-policy: CO declared_unit {inp.declared_unit!r} is neither mg/m3 nor ug/m3 — "
                "not silently interpreted. No sub-index computed."
            )
            return ProfileResult(
                profile="repo_current",
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
            f"unresolved-policy: declared_unit {inp.declared_unit!r} does not match the unit "
            f"ingest/app/aqi.py assumes ({expected_unit!r}) for {pollutant}. Not silently converted. "
            "No sub-index computed."
        )
        return ProfileResult(
            profile="repo_current",
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
            f"unresolved-policy: no declared_unit provided for {pollutant} — assumed to match "
            f"ingest/app/aqi.py's expected unit ({expected_unit!r}) since that is the only unit this "
            "profile is defined for, but this was NOT confirmed by the input."
        )

    raw, branch = _raw_sub_index_if_in_table(value_mg_or_ug, breakpoints)

    # The actual production call — real function, real breakpoints, real
    # rounding/cap. Everything above this line only reconstructs `raw` and
    # `branch` for transparency; `rounded` below is production's own output,
    # not re-derived by this harness.
    kwargs = {"pm25": None, "pm10": None, "no2": None, "so2": None, "o3": None, "co_mg": None, "nh3": None}
    key = "co_mg" if pollutant == "co" else pollutant
    kwargs[key] = value_mg_or_ug
    rounded = aqi.compute_aqi(**kwargs)

    cap_applied = raw is None and rounded == 500

    return ProfileResult(
        profile="repo_current",
        profile_version=PROFILE_VERSION,
        raw_sub_index=raw,
        rounded_sub_index=rounded,
        cap_applied=cap_applied,
        display_value=rounded if (rounded is not None and rounded <= 500) else None,
        category_label=_category_label(rounded),
        formula_branch=branch,
        warnings=tuple(warnings),
    )
