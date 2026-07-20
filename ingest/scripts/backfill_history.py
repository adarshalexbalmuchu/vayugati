#!/usr/bin/env python3
"""Historical backfill of REAL hourly OpenAQ history into the real `readings`.

Why this exists: the live ingest (`app/ingest.py`) only ever pulls
`get_latest` — one newest reading per sensor per hour, going forward. But
`app/forecast.py` needs ~10 days of hourly history per ward (MIN_TRAIN_ROWS
= 240) before it will train a real LightGBM model instead of the
diurnal-persistence fallback. Waiting for the live feed to accumulate that
is not an option, and fabricating data is not allowed. This script closes
the gap the honest way: it backfills the SAME real CPCB/DPCC-via-OpenAQ
sensor data, just historical, for every station in `stations.yaml`.

It writes to the SAME real wards/stations the live ingest writes to, using
the SAME idempotent upsert (`readings` on conflict station_id,ts) and the
SAME AQI computation — so it is safe to re-run and safe to run alongside
the live feed (a re-run just refreshes the hours it covers; it never
clobbers a live row for an hour outside its window).

Usage (run from the ingest/ directory, with ingest/.env filled in):
    python scripts/backfill_history.py --days 60
    python scripts/backfill_history.py --days 30 --dry-run
    python scripts/backfill_history.py --days 45 --only Wazirpur --only Rohini
"""
from __future__ import annotations

import argparse
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

# make the `app` package importable when run as a plain script from ingest/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import aqi, config, db, openaq  # noqa: E402


def _hour_floor_utc(ts_iso: str) -> str:
    dt = datetime.fromisoformat(ts_iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    return dt.replace(minute=0, second=0, microsecond=0).isoformat()


def _ensure_station(entry: dict, wards: dict[str, dict]) -> int | None:
    """Find or create the stations row for a configured station. Returns its
    id. Mirrors app/ingest._ensure_station exactly (find by external_ref,
    else create from OpenAQ location metadata) so backfilled and live
    readings land on the identical station row."""
    ref = str(entry["openaq_location_id"])
    existing = db.get_station_by_ref(ref)
    if existing:
        return existing["id"]

    ward = wards.get(entry["ward"])
    if ward is None:
        print(f"  ! ward {entry['ward']!r} not in wards table — skipping station {ref}")
        return None

    meta = openaq.get_location(entry["openaq_location_id"])
    created = db.insert_station(ward["id"], meta["name"], ref, meta["lat"], meta["lng"])
    print(f"  + registered station {meta['name']} ({ref}) for ward {entry['ward']}")
    return created["id"]


def backfill_station(
    entry: dict,
    wards: dict[str, dict],
    date_from: str,
    date_to: str,
    dry_run: bool,
    request_pause: float,
) -> dict:
    """Backfill one station across every pollutant sensor it exposes."""
    ref = str(entry["openaq_location_id"])
    station_id = _ensure_station(entry, wards)
    if station_id is None:
        return {"ward": entry["ward"], "skipped": "no station", "rows": 0}

    meta = openaq.get_location(entry["openaq_location_id"])
    sensors = meta["sensors"]  # {sensor_id: parameter_name}

    # merge every sensor's hourly series into one row per hour for this station
    by_hour: dict[str, dict] = defaultdict(dict)
    per_pollutant: dict[str, int] = defaultdict(int)
    for sensor_id, param in sensors.items():
        col = openaq.PARAMS.get(param or "")
        if col is None:
            continue  # a parameter we don't model (e.g. relative humidity sensor)
        try:
            series = openaq.get_sensor_hours(sensor_id, date_from, date_to)
        except Exception as e:  # one bad sensor must not lose the rest of the station
            print(f"  ! {entry['ward']} sensor {sensor_id} ({param}) failed: {e}")
            continue
        for m in series:
            val = m["value"]
            if val is None or val < 0:
                continue
            ts = _hour_floor_utc(m["ts_utc"])
            by_hour[ts][col] = val
            per_pollutant[col] += 1
        time.sleep(request_pause)  # stay under OpenAQ's free-tier rate limit

    reading_rows = []
    for ts, values in sorted(by_hour.items()):
        row = {"station_id": station_id, "ts": ts, **values}
        row_aqi = aqi.compute_aqi(values.get("pm25"), values.get("pm10"))
        if row_aqi is not None:
            row["aqi"] = row_aqi
        reading_rows.append(row)

    rows = len(reading_rows)
    if not dry_run:
        db.bulk_upsert_readings(reading_rows)

    summary = {
        "ward": entry["ward"],
        "station_id": station_id,
        "hours": rows,
        "by_pollutant": dict(per_pollutant),
    }
    pol = ", ".join(f"{k}:{v}" for k, v in sorted(summary["by_pollutant"].items())) or "none"
    print(f"  {'(dry) ' if dry_run else ''}{entry['ward']}: {rows} hourly rows [{pol}]")
    return summary


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--days", type=int, default=60, help="how many days of history to pull (default 60)")
    ap.add_argument("--dry-run", action="store_true", help="fetch and summarise, but write nothing")
    ap.add_argument(
        "--only",
        action="append",
        default=[],
        metavar="WARD",
        help="restrict to specific ward name(s); repeatable. Default: all configured stations",
    )
    ap.add_argument("--pause", type=float, default=0.4, help="seconds to sleep between OpenAQ calls (default 0.4)")
    args = ap.parse_args()

    config.require_env()

    date_to = datetime.now(timezone.utc)
    date_from = date_to - timedelta(days=args.days)
    df_iso = date_from.strftime("%Y-%m-%dT%H:%M:%SZ")
    dt_iso = date_to.strftime("%Y-%m-%dT%H:%M:%SZ")

    stations = config.load_stations()
    if args.only:
        wanted = {w.lower() for w in args.only}
        stations = [s for s in stations if s["ward"].lower() in wanted]
    configured = [s for s in stations if s.get("openaq_location_id")]
    skipped_no_id = [s["ward"] for s in stations if not s.get("openaq_location_id")]

    print(f"== backfilling {args.days}d of hourly history ({df_iso} -> {dt_iso}) ==")
    print(f"   {len(configured)} station(s) with an OpenAQ id"
          + (f"; skipping (no id): {', '.join(skipped_no_id)}" if skipped_no_id else ""))
    if args.dry_run:
        print("   DRY RUN — no rows will be written")

    wards = db.get_wards()
    total_hours = 0
    results = []
    for entry in configured:
        try:
            r = backfill_station(entry, wards, df_iso, dt_iso, args.dry_run, args.pause)
            results.append(r)
            total_hours += r.get("hours", 0)
        except Exception as e:  # one bad station must not kill the whole backfill
            print(f"  ! {entry['ward']} failed hard: {e}")
            results.append({"ward": entry["ward"], "error": str(e), "hours": 0})

    print(f"\n== done: {total_hours} hourly rows across {len(configured)} station(s) "
          f"{'(dry run, nothing written)' if args.dry_run else 'written'} ==")
    # a quick per-ward table so it's obvious which wards now have enough to train
    print("\nward                     hours   (need ~240 for LightGBM)")
    for r in sorted(results, key=lambda x: -x.get("hours", 0)):
        flag = "  <-- trainable" if r.get("hours", 0) >= 240 else ""
        print(f"  {r['ward']:<22} {r.get('hours', 0):>5}{flag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
