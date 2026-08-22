"""Structured types for the AQI comparison harness.

Five concepts are deliberately kept as five separate fields on ProfileResult,
never collapsed into one another:
  raw_sub_index      — the unrounded mathematical interpolation result.
  rounded_sub_index  — raw_sub_index after the profile's rounding policy.
  cap_applied        — whether a hard ceiling (e.g. CPCB's 500) replaced the
                        mathematical result for this pollutant/concentration.
  display_value      — what a public-facing UI could show WITHOUT this
                        harness assuming a display policy above AQI 500. Equal
                        to rounded_sub_index when rounded_sub_index <= 500;
                        None otherwise (see category_label for the same rule).
  category_label      — the CPCB band name (Good..Severe), only assigned for
                        rounded_sub_index <= 500. Never invented above 500.
"""

from __future__ import annotations

from dataclasses import dataclass, field


# ── input ────────────────────────────────────────────────────────────────────

POLLUTANTS = ("pm25", "pm10", "no2", "so2", "co", "o3", "nh3")


@dataclass(frozen=True)
class ComparisonInput:
    """One structured observation to run through both profiles.

    `declared_unit` is exactly what the source claims — the harness never
    infers or silently converts a unit the caller didn't declare. See
    profiles/*.py for what happens when declared_unit doesn't match what a
    profile expects.
    """

    pollutant: str  # one of POLLUTANTS
    concentration: float
    declared_unit: str  # e.g. "ug/m3", "mg/m3" — as declared, verbatim
    averaging_window: str  # e.g. "24h", "8h" — as declared, verbatim
    observation_ts: str  # ISO 8601
    station_id: str | None = None
    station_name: str | None = None
    source: str | None = None
    fixture_id: str = ""
    notes: str = ""

    def __post_init__(self) -> None:
        if self.pollutant not in POLLUTANTS:
            raise ValueError(f"Unknown pollutant {self.pollutant!r} — must be one of {POLLUTANTS}")


# ── per-profile result ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class ProfileResult:
    profile: str  # "repo_current" | "cpcb_workbook_formula_exact"
    profile_version: str
    raw_sub_index: float | None
    rounded_sub_index: int | None
    cap_applied: bool
    display_value: int | None
    category_label: str | None
    formula_branch: str
    warnings: tuple[str, ...] = field(default_factory=tuple)


# ── comparison result (one row of harness output) ──────────────────────────


@dataclass(frozen=True)
class ComparisonResult:
    input: ComparisonInput
    repo_current: ProfileResult
    cpcb_workbook_formula_exact: ProfileResult
    absolute_difference_raw: float | None
    absolute_difference_rounded: int | None
    comparison_range: str  # e.g. "430-510", "510-600", "above_600", "n/a"
    unresolved_policy_warnings: tuple[str, ...] = field(default_factory=tuple)
