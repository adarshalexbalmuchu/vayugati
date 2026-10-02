"""Backfill historical weather from Open-Meteo's ERA5 archive.

WHY
===
The VayuTrace validation harness (scripts/validate_vayutrace.py) could only
evaluate ~12 of the 265 wards the kernel scores — about 4.5%. The binding
constraint was weather HISTORY, not readings:

    - all 44 CPCB stations report healthily (~950 pm25 rows each / 60 days,
      across 39 wards)
    - but per-ward weather was only extended from the original 13 "hotspot"
      wards to all 265 in Sept 2026, and PBLH/ventilation-coefficient
      postdate an even later migration
    - so a 60-day validation window is dominated by the era when only 13
      wards had any weather at all

Waiting for live ingestion to accumulate would take months. ERA5 reanalysis
covers any coordinate and any past date, so the history can simply be
reconstructed — lifting validation coverage from ~12 wards to every
station-bearing ward immediately.

WHAT THIS IS, AND IS NOT
========================
ERA5 is a MODEL REANALYSIS — a physically-constrained reconstruction of past
atmospheric state, on a ~9-31 km grid. It is NOT an observation, and its
grid is considerably coarser than a Delhi ward (~2-5 km). Every row written
here is therefore tagged `source='era5'` (see migration
20260922000000_weather_source_provenance.sql) so it can never be silently
conflated with a live MET Norway reading.

Appropriate uses:  model validation, training history, backfilled features.
NOT appropriate:   presenting to a user as an observed measurement.

By default this script will NOT overwrite existing live rows — see
--overwrite-live, which is deliberately awkward to reach.

USAGE
=====
    # dry run first (fetches nothing, just reports the plan)
    python ingest/scripts/backfill_weather_history.py --days 60 --dry-run

    # backfill 60 days for the wards that have a CPCB station
    python ingest/scripts/backfill_weather_history.py --days 60 --stations-only

    # all 265 wards (slower: one archive request per ward)
    python ingest/scripts/backfill_weather_history.py --days 60
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import db, open_meteo  # noqa: E402
from app.vayutrace_kernel import boundary_area_centroid  # noqa: E402


def _ward_positions(stations_only: bool) -> dict[int, tuple[float, float]]:
    """ward_id -> (lat, lng), using the same real-point-then-boundary-centroid
    fallback the kernel itself uses, so backfilled weather is fetched for
    exactly the coordinate the kernel will later score against."""
    wards = db.get_wards_with_city()
    if stations_only:
        station_wards = {
            s["ward_id"] for s in db.get_stations_with_coords()
            if s.get("ward_id") is not None
        }
        wards = [w for w in wards if w["id"] in station_wards]

    out: dict[int, tuple[float, float]] = {}
    for w in wards:
        lat, lng = w.get("lat"), w.get("lng")
        if lat is None or lng is None:
            c = boundary_area_centroid(w.get("boundary"))
            if c is None:
                continue  # no position at all — skipped, never fabricated
            lat, lng = c
        out[w["id"]] = (float(lat), float(lng))
    return out


def _existing_live_hours(ward_id: int, start: str, end: str) -> set[str]:
    """Hour keys ('YYYY-MM-DDTHH') already covered by LIVE rows for this ward.

    Live data is the real observation path and always wins; ERA5 fills gaps
    around it rather than replacing it.
    """
    rows = (
        db.client().table("weather")
        .select("ts")
        .eq("ward_id", ward_id)
        .eq("source", "live")
        .gte("ts", start)
        .lte("ts", end)
        .execute()
        .data
    ) or []
    return {r["ts"][:13] for r in rows}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--days", type=int, default=60,
                    help="How many days back to backfill (default: 60)")
    ap.add_argument("--stations-only", action="store_true",
                    help="Only wards with a CPCB station. These are the only "
                         "wards validation can use, so this is much faster "
                         "and sufficient for the harness.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Report the plan without fetching or writing.")
    ap.add_argument("--overwrite-live", action="store_true",
                    help="DANGEROUS: also replace hours already covered by "
                         "live observations. Almost never what you want — "
                         "live readings are real observations, ERA5 is a "
                         "coarse model reconstruction.")
    ap.add_argument("--sleep", type=float, default=0.5,
                    help="Seconds between archive requests, to stay well "
                         "inside Open-Meteo's free-tier rate limits "
                         "(default: 0.5)")
    args = ap.parse_args()

    end_d = dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)
    start_d = end_d - dt.timedelta(days=args.days - 1)
    start_s, end_s = start_d.isoformat(), end_d.isoformat()
    start_ts, end_ts = f"{start_s}T00:00:00Z", f"{end_s}T23:59:59Z"

    positions = _ward_positions(args.stations_only)
    print(f"ERA5 weather backfill")
    print(f"  range:  {start_s} .. {end_s}  ({args.days} days)")
    print(f"  wards:  {len(positions)}"
          f"{' (station-bearing only)' if args.stations_only else ' (all)'}")
    print(f"  expect: ~{len(positions) * args.days * 24:,} hourly rows before dedup")
    if args.dry_run:
        print("\n  --dry-run: nothing fetched or written.")
        return

    total_written = 0
    total_skipped = 0
    failures: list[int] = []

    for n, (ward_id, (lat, lng)) in enumerate(sorted(positions.items()), 1):
        series = open_meteo.get_historical_hourly(lat, lng, start_s, end_s)
        if not series:
            failures.append(ward_id)
            print(f"  [{n}/{len(positions)}] ward {ward_id}: FETCH FAILED")
            time.sleep(args.sleep)
            continue

        skip_hours: set[str] = set()
        if not args.overwrite_live:
            skip_hours = _existing_live_hours(ward_id, start_ts, end_ts)

        rows = []
        for e in series:
            ts = e["ts_utc"]
            if ts[:13] in skip_hours:
                continue
            pblh = e.get("boundary_layer_height")
            ws = e.get("wind_speed")
            # VC is stored (not recomputed downstream) to match what the live
            # ingest path writes; both components are kept visible too.
            vc = (float(pblh) * float(ws)) if (pblh is not None and ws is not None) else None
            rows.append({
                "ward_id": ward_id,
                "ts": ts,
                "temp_c": e.get("temp_c"),
                "humidity": e.get("humidity"),
                "wind_speed": ws,
                "wind_dir": e.get("wind_dir"),
                "precipitation": e.get("precipitation"),
                "boundary_layer_height": pblh,
                "ventilation_coefficient": vc,
                "source": "era5",
            })

        written = db.bulk_upsert_weather(rows) if rows else 0
        total_written += written
        total_skipped += len(series) - len(rows)
        print(f"  [{n}/{len(positions)}] ward {ward_id}: "
              f"+{written} rows ({len(series) - len(rows)} live hours preserved)")
        time.sleep(args.sleep)

    print(f"\nDone. {total_written:,} ERA5 rows written, "
          f"{total_skipped:,} hours left to existing live data.")
    if failures:
        print(f"  {len(failures)} ward(s) failed to fetch: {failures}")
    print("  All new rows are tagged source='era5' — reanalysis, not observation.")


if __name__ == "__main__":
    main()
