#!/usr/bin/env python3
"""Backfill VIIRS regional fire counts into the fire_counts table.

Fetches daily fire counts from NASA FIRMS for the IGP airshed (Punjab +
Haryana bounding box) for the last N days and inserts them into Supabase.

Run AFTER the 20260827000000_fire_counts.sql migration has been applied.

Usage:
    cd /path/to/vayugati
    python3 scripts/backfill_fire_counts.py             # last 60 days
    python3 scripts/backfill_fire_counts.py --days 30   # last 30 days
    python3 scripts/backfill_fire_counts.py --from 2026-07-01  # from a date
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import date, timedelta
from pathlib import Path

# Load .env from ingest directory
_here = Path(__file__).resolve().parent
_env_file = _here.parent / "ingest" / ".env"
if _env_file.exists():
    for line in _env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())

sys.path.insert(0, str(_here.parent / "ingest"))
from app import config, db
from app.vayutrace_firms import fetch_igp_fires


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=60, help="how many past days to backfill (default: 60)")
    ap.add_argument("--from", dest="from_date", type=str, help="backfill from this date (YYYY-MM-DD), overrides --days")
    ap.add_argument("--dry-run", action="store_true", help="fetch and print counts but don't write to DB")
    args = ap.parse_args()

    if not config.FIRMS_MAP_KEY:
        print("ERROR: FIRMS_MAP_KEY not set in ingest/.env — cannot fetch FIRMS data.")
        return 1

    today = date.today()
    if args.from_date:
        start = date.fromisoformat(args.from_date)
    else:
        start = today - timedelta(days=args.days)
    end = today - timedelta(days=1)  # yesterday (today's data not yet complete)

    total_days = (end - start).days + 1
    print(f"Backfilling fire counts from {start} to {end} ({total_days} days)...")
    print(f"FIRMS product: VIIRS SNPP NRT (≤7 days) / Standard Processing (older)")
    print(f"Dry run: {args.dry_run}")
    print()

    written = 0
    skipped = 0
    errors = 0

    current = start
    while current <= end:
        try:
            fires = fetch_igp_fires(day=current)
            regional = [f for f in fires if f.get("fire_class") == "regional"]
            count = len(regional)

            if args.dry_run:
                print(f"  {current}: {count:4d} regional fires  ({len(fires)} total in IGP bbox)  [DRY RUN]")
            else:
                db.upsert_fire_count(current.isoformat(), "igp_regional", count)
                print(f"  {current}: {count:4d} regional fires  ({len(fires)} total in IGP bbox)  ✓")
                written += 1

            # FIRMS NRT API rate limit: be polite — 1 request/second is safe.
            # No rate limit concern for < 60 requests total.
            time.sleep(1.0)

        except Exception as exc:
            print(f"  {current}: ERROR — {exc}")
            errors += 1

        current += timedelta(days=1)

    print()
    print(f"Done. Written: {written}  Skipped: {skipped}  Errors: {errors}")
    if errors:
        print("Re-run for failed dates or check FIRMS_MAP_KEY validity.")
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
