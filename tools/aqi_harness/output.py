"""JSON + CSV serialization for a list of ComparisonResult. Deterministic:
same input list always produces byte-identical output (no dict-ordering or
floating-point-formatting nondeterminism) — see tests/test_output_generation.py.
"""

from __future__ import annotations

import csv
import json
from dataclasses import asdict
from io import StringIO

from .models import ComparisonResult

CSV_COLUMNS = [
    "fixture_id",
    "pollutant",
    "concentration",
    "declared_unit",
    "averaging_window",
    "observation_ts",
    "station_id",
    "station_name",
    "source",
    "comparison_range",
    "repo_current_raw_sub_index",
    "repo_current_rounded_sub_index",
    "repo_current_cap_applied",
    "repo_current_display_value",
    "repo_current_category_label",
    "repo_current_formula_branch",
    "cpcb_workbook_formula_exact_raw_sub_index",
    "cpcb_workbook_formula_exact_rounded_sub_index",
    "cpcb_workbook_formula_exact_cap_applied",
    "cpcb_workbook_formula_exact_display_value",
    "cpcb_workbook_formula_exact_category_label",
    "cpcb_workbook_formula_exact_formula_branch",
    "absolute_difference_raw",
    "absolute_difference_rounded",
    "unresolved_policy_warnings",
]


def to_dict(result: ComparisonResult) -> dict:
    d = asdict(result)
    # asdict() turns tuples into lists, which is fine for JSON — kept as-is.
    return d


def to_json(results: list[ComparisonResult]) -> str:
    payload = [to_dict(r) for r in results]
    # sort_keys=True is what makes this deterministic regardless of dict
    # construction order; indent=2 for human-reviewable example output.
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def _csv_row(result: ComparisonResult) -> list:
    i, rc, cx = result.input, result.repo_current, result.cpcb_workbook_formula_exact
    return [
        i.fixture_id,
        i.pollutant,
        i.concentration,
        i.declared_unit,
        i.averaging_window,
        i.observation_ts,
        i.station_id or "",
        i.station_name or "",
        i.source or "",
        result.comparison_range,
        rc.raw_sub_index if rc.raw_sub_index is not None else "",
        rc.rounded_sub_index if rc.rounded_sub_index is not None else "",
        rc.cap_applied,
        rc.display_value if rc.display_value is not None else "",
        rc.category_label or "",
        rc.formula_branch,
        cx.raw_sub_index if cx.raw_sub_index is not None else "",
        cx.rounded_sub_index if cx.rounded_sub_index is not None else "",
        cx.cap_applied,
        cx.display_value if cx.display_value is not None else "",
        cx.category_label or "",
        cx.formula_branch,
        result.absolute_difference_raw if result.absolute_difference_raw is not None else "",
        result.absolute_difference_rounded if result.absolute_difference_rounded is not None else "",
        " | ".join(result.unresolved_policy_warnings),
    ]


def to_csv(results: list[ComparisonResult]) -> str:
    buf = StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for r in results:
        writer.writerow(_csv_row(r))
    return buf.getvalue()
