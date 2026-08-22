#!/usr/bin/env python3
"""CLI entrypoint — runs every fixture through compare() and writes JSON +
CSV output. No network access, no database access, no import of anything in
web/ or supabase/. The only production code touched is a read-only import
of ingest/app/aqi.py (see profiles/repo_current.py).

Usage:
    python3 tools/aqi_harness/run_comparison.py
    python3 tools/aqi_harness/run_comparison.py --out-dir tools/aqi_harness/output
"""

from __future__ import annotations

import argparse
from pathlib import Path

from .compare import compare
from .fixtures.future_cpcb_observations import FUTURE_CPCB_OBSERVATIONS
from .fixtures.severe_fixtures import ALL_SEVERE_FIXTURES
from .output import to_csv, to_json


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).parent / "output",
        help="Directory to write comparison.json and comparison.csv into.",
    )
    args = parser.parse_args()

    if FUTURE_CPCB_OBSERVATIONS:
        raise RuntimeError(
            "FUTURE_CPCB_OBSERVATIONS is non-empty but this harness has no logic to convert a "
            "CpcbStationObservation into a ComparisonInput yet — that mapping (and what to do with "
            "published_aqi/published_label once real rows exist) is an unresolved decision for the "
            "evidence-collection phase, not something to guess at silently here."
        )

    results = [compare(fx) for fx in ALL_SEVERE_FIXTURES]

    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "comparison.json").write_text(to_json(results), encoding="utf-8")
    (args.out_dir / "comparison.csv").write_text(to_csv(results), encoding="utf-8")

    diverging = [r for r in results if r.absolute_difference_rounded not in (None, 0)]
    print(f"{len(results)} fixtures compared, {len(diverging)} diverge between profiles.")
    print(f"Wrote {args.out_dir / 'comparison.json'} and {args.out_dir / 'comparison.csv'}.")


if __name__ == "__main__":
    main()
