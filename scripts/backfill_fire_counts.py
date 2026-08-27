#!/usr/bin/env python3
"""Backfill VIIRS regional fire counts into the fire_counts table.

Standalone — uses only stdlib (urllib, csv, json, math). Works on Python 3.9+.

Run AFTER the 20260827000000_fire_counts.sql migration has been applied.

Usage:
    cd /path/to/vayugati
    python3 scripts/backfill_fire_counts.py             # last 60 days
    python3 scripts/backfill_fire_counts.py --days 30   # last 30 days
    python3 scripts/backfill_fire_counts.py --from 2026-07-01
    python3 scripts/backfill_fire_counts.py --dry-run
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path


# ── env loading ───────────────────────────────────────────────────────────────

def _load_env(path: str) -> dict:
    out = {}
    try:
        for line in open(path):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return out


_repo = Path(__file__).resolve().parent.parent
_env = _load_env(str(_repo / "ingest" / ".env"))

SUPABASE_URL = os.environ.get("SUPABASE_URL") or _env.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or _env.get("SUPABASE_SERVICE_ROLE_KEY", "")
FIRMS_KEY = os.environ.get("FIRMS_MAP_KEY") or _env.get("FIRMS_MAP_KEY", "")


# ── FIRMS fetch ───────────────────────────────────────────────────────────────

# Full IGP airshed bounding box (W,S,E,N)
_IGP_BBOX = "73.0,27.0,81.0,32.5"
_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
_DELHI_LAT = 28.65
_DELHI_LNG = 77.22
_REGIONAL_KM = 50.0   # fires beyond this from Delhi centroid = "regional"
_EARTH_R = 6371.0


def _distance_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = phi2 - phi1
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return _EARTH_R * 2 * math.asin(math.sqrt(a))


def fetch_regional_count(day: date) -> tuple[int, int]:
    """Return (regional_fire_count, total_fire_count) for the given day.

    Uses VIIRS_SNPP_NRT for the last 7 days, VIIRS_SNPP_SP (archive) for older.
    Returns (0, 0) if FIRMS key is absent or the API returns no data."""
    if not FIRMS_KEY:
        return 0, 0

    days_ago = (date.today() - day).days
    product = "VIIRS_SNPP_NRT" if days_ago <= 7 else "VIIRS_SNPP_SP"
    url = f"{_BASE}/{FIRMS_KEY}/{product}/{_IGP_BBOX}/1/{day.isoformat()}"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "vayugati-backfill/1.0"})
        with urllib.request.urlopen(req, timeout=45) as resp:
            text = resp.read().decode("utf-8", errors="replace").strip()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"FIRMS HTTP {e.code} for {day}: {e.reason}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"FIRMS request failed for {day}: {e.reason}")

    if "Invalid MAP_KEY" in text:
        raise RuntimeError("FIRMS_MAP_KEY is invalid — update it in ingest/.env")
    if not text or not text.startswith("latitude"):
        return 0, 0   # empty response = no fires that day

    reader = csv.DictReader(io.StringIO(text))
    total = 0
    regional = 0
    for row in reader:
        total += 1
        try:
            lat = float(row["latitude"])
            lng = float(row["longitude"])
        except (KeyError, ValueError):
            continue
        # Drop low-confidence detections (VIIRS confidence: l/n/h)
        conf = (row.get("confidence") or "").lower().strip()
        if conf == "l":
            continue
        dist = _distance_km(lat, lng, _DELHI_LAT, _DELHI_LNG)
        if dist >= _REGIONAL_KM:
            regional += 1
    return regional, total


# ── Supabase upsert ───────────────────────────────────────────────────────────

def upsert_fire_count(day: date, region: str, count: int) -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set")

    payload = json.dumps([{"date": day.isoformat(), "region": region, "fire_count": count}]).encode()
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/fire_counts"
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",  # upsert on primary key
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"Supabase upsert failed HTTP {e.code}: {body[:200]}")


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=60, help="days to backfill (default: 60)")
    ap.add_argument("--from", dest="from_date", help="start date YYYY-MM-DD (overrides --days)")
    ap.add_argument("--dry-run", action="store_true", help="fetch but don't write to Supabase")
    args = ap.parse_args()

    if not FIRMS_KEY:
        print("ERROR: FIRMS_MAP_KEY not set in ingest/.env")
        return 1
    if not args.dry_run and (not SUPABASE_URL or not SUPABASE_KEY):
        print("ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set")
        return 1

    today = date.today()
    start = date.fromisoformat(args.from_date) if args.from_date else today - timedelta(days=args.days)
    end = today - timedelta(days=1)  # yesterday — today's data is incomplete

    total_days = (end - start).days + 1
    print(f"Backfilling {total_days} days  ({start} → {end})")
    print(f"FIRMS key: {FIRMS_KEY[:8]}...  |  Dry run: {args.dry_run}")
    print()

    written = errors = 0
    current = start
    while current <= end:
        try:
            regional, total = fetch_regional_count(current)
            tag = "[DRY RUN]" if args.dry_run else ""
            print(f"  {current}  regional={regional:4d}  total={total:5d}  {tag}")
            if not args.dry_run:
                upsert_fire_count(current, "igp_regional", regional)
            written += 1
        except Exception as exc:
            print(f"  {current}  ERROR: {exc}")
            errors += 1
        time.sleep(1.0)   # 1 req/s — stay well within FIRMS rate limits
        current += timedelta(days=1)

    print()
    print(f"Done.  written={written}  errors={errors}")
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
