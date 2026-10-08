#!/usr/bin/env python3
"""Import CPCB portal raw 15-minute files (airquality.cpcb.gov.in data repository)
into `readings` as CPCB AQI-window rows (ingest_source='cpcb', value_basis='naqi_window').

Row shape matches what the live data.gov.in feed writes: 24h means for
PM2.5/PM10/NO2/SO2/NH3 (16 of 24 hours required), max 8h mean for O3/CO (6 of 8),
and the AQI computed from them. Portal timestamps are IST (verified against
stored live rows); portal PM values are hourly and repeat within the hour.

Usage (from ingest/):
    python scripts/import_cpcb_portal_raw.py                  # dry run, all stations
    python scripts/import_cpcb_portal_raw.py --only Anand     # dry run, one station
    python scripts/import_cpcb_portal_raw.py --apply          # write to the DB
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import aqi, db  # noqa: E402
from app.ingest import _CO_MAX_MG, _CONC_MAX_UGM3  # noqa: E402

IST = timedelta(hours=5, minutes=30)
RAW_DIR = Path(__file__).resolve().parents[2] / "data" / "delhi" / "raw" / "cpcb_portal_2026"
COLUMNS = {
    "pm25": "PM2.5 (µg/m³)", "pm10": "PM10 (µg/m³)", "no2": "NO2 (µg/m³)",
    "so2": "SO2 (µg/m³)", "co": "CO (mg/m³)", "o3": "Ozone (µg/m³)", "nh3": "NH3 (µg/m³)",
}


# Portal sites whose names differ from ours (checked by hand against station names and data).
SITE_TO_STATION_ID = {"105": 32, "109": 36, "114": 21}
# Portal sites with no counterpart in our DB, or with no PM data at all.
SKIP_SITES = {
    "107": "IMD Pusa, not our DPCC Pusa station (that is site 1563)",
    "5395": "no PM data in 2026",
}


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def parse_name(path: Path) -> tuple[str, str, str]:
    """-> (site_id, station slug, agency) from Raw_Data_2026_site_<id>_<slug>_delhi_<agency>_15M.csv"""
    m = re.match(r"Raw_Data_2026_site_(\d+)_(.+)_delhi_([a-z]+)_15M\.csv$", path.name)
    if not m:
        raise ValueError(path.name)
    return m.group(1), m.group(2), m.group(3)


def match_station(slug: str, agency: str, stations: list[dict]) -> list[dict]:
    target = norm(slug)
    hits = []
    for s in stations:
        base = s["name"].split(",")[0]
        if norm(base) == target or norm(base.replace("-", " ")) == target:
            hits.append(s)
    if len(hits) > 1:
        same_agency = [s for s in hits if (s.get("agency") or "").lower() == agency]
        hits = same_agency or hits
    return hits


def hourly_blocks(path: Path) -> dict[datetime, dict[str, float]]:
    """IST hour start -> {pollutant: mean of the valid 15-min rows in [h:00, h:45]}."""
    acc: dict[datetime, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            ts = datetime.strptime(row["Timestamp"], "%Y-%m-%d %H:%M:%S")
            block = ts.replace(minute=0, second=0)
            for col, header in COLUMNS.items():
                raw = row.get(header)
                if raw in (None, "", "NA"):
                    continue
                v = float(raw)
                if v < 0:
                    continue
                limit = _CO_MAX_MG if col == "co" else _CONC_MAX_UGM3.get(col)
                if limit is not None and v > limit:
                    continue
                acc[block][col].append(v)
    return {b: {c: sum(v) / len(v) for c, v in cols.items()} for b, cols in acc.items()}


def window_rows(station_id: int, blocks: dict[datetime, dict[str, float]],
                start_utc: datetime, end_utc: datetime) -> list[dict]:
    rows = []
    for block in sorted(blocks):
        ts = (block - IST).replace(tzinfo=timezone.utc)
        if not (start_utc <= ts <= end_utc):
            continue
        hourly: dict[str, list[float]] = {}
        for i in range(23, -1, -1):  # oldest first, the 24 blocks ending at this one
            vals = blocks.get(block - timedelta(hours=i), {})
            for col, v in vals.items():
                hourly.setdefault(col, []).append(v)
        conc = aqi.window_concentrations(hourly)
        value, _ = aqi.aqi_from_window(conc)
        if value is None:
            continue
        rows.append({
            "station_id": station_id, "ts": ts.isoformat(), "aqi": value,
            "ingest_source": "cpcb", "value_basis": "naqi_window",
            **{c: round(v, 2) for c, v in conc.items()},
        })
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(RAW_DIR))
    ap.add_argument("--from", dest="start", default="2026-09-25T13:45:00+00:00",
                    help="first ts to write (UTC); default = just after the last live CPCB row")
    ap.add_argument("--to", dest="end", default="2026-09-30T18:00:00+00:00",
                    help="last ts to write (UTC); default = end of the portal data")
    ap.add_argument("--only", action="append", default=[], help="substring of a station name; repeatable")
    ap.add_argument("--apply", action="store_true", help="write to the database (default is a dry run)")
    args = ap.parse_args()
    start = datetime.fromisoformat(args.start)
    end = datetime.fromisoformat(args.end)

    stations = db.get_all_stations()
    files = sorted(Path(args.dir).glob("Raw_Data_2026_site_*.csv"))
    digests: dict[str, str] = {}
    plan, skipped = [], []
    for path in files:
        site, slug, agency = parse_name(path)
        digest = hashlib.md5(path.read_bytes()).hexdigest()
        if digest in digests:
            skipped.append(f"{path.name}: identical to {digests[digest]} (wrong download), skipped")
            continue
        digests[digest] = path.name
        if site in SKIP_SITES:
            skipped.append(f"{path.name}: {SKIP_SITES[site]}, skipped")
            continue
        if site in SITE_TO_STATION_ID:
            hits = [s for s in stations if s["id"] == SITE_TO_STATION_ID[site]]
        else:
            hits = match_station(slug, agency, stations)
        if len(hits) != 1:
            skipped.append(f"{path.name}: {'no' if not hits else 'ambiguous'} station match, skipped")
            continue
        if args.only and not any(o.lower() in hits[0]["name"].lower() for o in args.only):
            continue
        plan.append((site, path, hits[0]))

    existing: dict[int, set[str]] = defaultdict(set)
    total, written = 0, 0
    print(f"{'station':40} {'site':>5} {'rows':>5} {'skip(existing)':>14}  AQI min/median/max  last")
    for site, path, station in plan:
        sid = station["id"]
        rows = window_rows(sid, hourly_blocks(path), start, end)
        if rows:
            res = db.client().table("readings").select("ts").eq("station_id", sid) \
                .gte("ts", start.isoformat()).lte("ts", end.isoformat()).limit(2000).execute().data
            have = {datetime.fromisoformat(r["ts"]).isoformat() for r in res}
            fresh = [r for r in rows if datetime.fromisoformat(r["ts"]).isoformat() not in have]
        else:
            fresh = []
        aqis = sorted(r["aqi"] for r in fresh)
        stats = f"{aqis[0]}/{aqis[len(aqis)//2]}/{aqis[-1]}" if aqis else "-"
        last = f"{fresh[-1]['ts'][5:16]} aqi {fresh[-1]['aqi']}" if fresh else "-"
        print(f"{station['name'][:40]:40} {site:>5} {len(fresh):>5} {len(rows)-len(fresh):>14}  {stats:18} {last}")
        total += len(fresh)
        if args.apply and fresh:
            written += db.bulk_upsert_readings(fresh)
    print(f"\nstations planned: {len(plan)}  rows to write: {total}  rows written: {written}")
    for s in skipped:
        print("SKIPPED:", s)
    if not args.apply:
        print("dry run: nothing written (use --apply)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
