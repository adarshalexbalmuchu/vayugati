"""Deterministic tests for JSON/CSV generation — same fixtures must always
produce byte-identical output, and both formats must round-trip cleanly."""

import csv
import json
from io import StringIO

from aqi_harness.compare import compare
from aqi_harness.fixtures.severe_fixtures import ALL_SEVERE_FIXTURES
from aqi_harness.output import CSV_COLUMNS, to_csv, to_json


def _results():
    return [compare(fx) for fx in ALL_SEVERE_FIXTURES]


def test_json_output_is_byte_identical_across_runs():
    a = to_json(_results())
    b = to_json(_results())
    assert a == b


def test_csv_output_is_byte_identical_across_runs():
    a = to_csv(_results())
    b = to_csv(_results())
    assert a == b


def test_json_output_is_valid_and_has_one_entry_per_fixture():
    parsed = json.loads(to_json(_results()))
    assert isinstance(parsed, list)
    assert len(parsed) == len(ALL_SEVERE_FIXTURES)
    assert {entry["input"]["fixture_id"] for entry in parsed} == {fx.fixture_id for fx in ALL_SEVERE_FIXTURES}


def test_json_output_keeps_all_five_separated_concepts_per_profile():
    parsed = json.loads(to_json(_results()))
    entry = parsed[0]
    for profile_key in ("repo_current", "cpcb_workbook_formula_exact"):
        profile = entry[profile_key]
        for field in ("raw_sub_index", "rounded_sub_index", "cap_applied", "display_value", "category_label"):
            assert field in profile


def test_csv_output_has_expected_header_and_row_count():
    text = to_csv(_results())
    reader = csv.reader(StringIO(text))
    rows = list(reader)
    assert rows[0] == CSV_COLUMNS
    assert len(rows) - 1 == len(ALL_SEVERE_FIXTURES)


def test_csv_capped_and_uncapped_rows_are_distinguishable():
    text = to_csv(_results())
    reader = csv.DictReader(StringIO(text))
    rows = {row["fixture_id"]: row for row in reader}
    capped_row = rows["pm10_1400"]
    assert capped_row["repo_current_cap_applied"] == "True"
    assert capped_row["cpcb_workbook_formula_exact_cap_applied"] == "False"
    assert capped_row["repo_current_rounded_sub_index"] == "500"
    assert int(capped_row["cpcb_workbook_formula_exact_rounded_sub_index"]) > 500
    assert capped_row["absolute_difference_rounded"] != ""


def test_csv_unresolved_warnings_column_is_populated_for_co_and_o3():
    text = to_csv(_results())
    reader = csv.DictReader(StringIO(text))
    rows = {row["fixture_id"]: row for row in reader}
    assert "unresolved" in rows["co_48mg"]["unresolved_policy_warnings"]
    assert "unresolved" in rows["o3_1000"]["unresolved_policy_warnings"]
