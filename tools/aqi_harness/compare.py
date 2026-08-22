"""Runs one ComparisonInput through both profiles and assembles a
ComparisonResult. Pure function, no I/O — output.py handles serialization,
run_comparison.py handles the CLI/fixture loop."""

from __future__ import annotations

from .models import ComparisonInput, ComparisonResult
from .profiles import cpcb_workbook_formula_exact, repo_current


def _comparison_range(pollutant: str, concentration: float) -> str:
    # Only PM10 has an explicit named-range requirement in the harness
    # brief; other pollutants get a generic in-range/above-ceiling split
    # against their own top breakpoint so the same "range" concept still
    # means something per pollutant.
    if pollutant == "pm10":
        if 430 <= concentration <= 510:
            return "430-510"
        if 510 < concentration <= 600:
            return "510-600"
        if concentration > 600:
            return "above_600"
        return "below_430"
    if pollutant == "o3":
        # O3's tier 5 ends at 748 (see profiles/cpcb_workbook_formula_exact.py) —
        # that's also exactly where its formula's discontinuity begins.
        return "above_ceiling" if concentration > 748 else "in_range"
    from .profiles.cpcb_workbook_formula_exact import _TIERS_BY_POLLUTANT  # noqa: PLC0415

    ceiling = _TIERS_BY_POLLUTANT[pollutant][-1][1]
    return "above_ceiling" if concentration > ceiling else "in_range"


def compare(inp: ComparisonInput) -> ComparisonResult:
    repo_result = repo_current.evaluate(inp)
    cpcb_result = cpcb_workbook_formula_exact.evaluate(inp)

    abs_raw = (
        abs(repo_result.raw_sub_index - cpcb_result.raw_sub_index)
        if repo_result.raw_sub_index is not None and cpcb_result.raw_sub_index is not None
        else None
    )
    abs_rounded = (
        abs(repo_result.rounded_sub_index - cpcb_result.rounded_sub_index)
        if repo_result.rounded_sub_index is not None and cpcb_result.rounded_sub_index is not None
        else None
    )

    unresolved = tuple(
        dict.fromkeys(  # de-duplicate while preserving order
            [*repo_result.warnings, *cpcb_result.warnings]
        )
    )

    return ComparisonResult(
        input=inp,
        repo_current=repo_result,
        cpcb_workbook_formula_exact=cpcb_result,
        absolute_difference_raw=abs_raw,
        absolute_difference_rounded=abs_rounded,
        comparison_range=_comparison_range(inp.pollutant, inp.concentration),
        unresolved_policy_warnings=unresolved,
    )
