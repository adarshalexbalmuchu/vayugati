"""Calibrate VayuTrace dispersion kernel sigma (Gaussian decay length).

Approach
--------
For each Delhi CPCB station we compute the kernel's industrial proximity
score using pure Gaussian distance decay (wind-averaged — calibrating the
spatial scale, not directional alignment) at a grid of candidate sigma
values, then find the sigma that maximises the Spearman rank correlation
between:

    proximity score  — how close / large are the industrial zones?
    local PM2.5 excess  — station PM2.5 median minus city-wide background

A higher correlation means the kernel correctly places heavier estimated
load on stations near industrial clusters.  The optimal sigma is then used
to update DEFAULT_SIGMA_KM in vayutrace_kernel.py.

Why Spearman?  The kernel produces a relative score, not absolute µg/m³.
Spearman captures monotonic relationships without requiring linearity, and
is more robust to PM2.5's right-skewed distribution.

Why local excess (not raw PM2.5)?  Delhi stations share a strong regional
background (stubble transport, city-wide mixing) that swamps the local
industrial signal.  Subtracting the city-wide median removes that common
mode and isolates the part of PM2.5 that actually varies with station-level
proximity to local sources.

Usage
-----
  python ingest/scripts/calibrate_vayutrace_sigma.py            # all defaults
  python ingest/scripts/calibrate_vayutrace_sigma.py --days 60  # more history
  python ingest/scripts/calibrate_vayutrace_sigma.py --apply    # update kernel

Outputs
-------
  - table of Spearman rho vs sigma for each candidate
  - recommended sigma and whether it passes a 95% significance threshold
  - (with --apply) writes the new DEFAULT_SIGMA_KM to vayutrace_kernel.py
"""

from __future__ import annotations

import argparse
import math
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import numpy as np
from scipy import stats
from dotenv import load_dotenv

# Load .env from ingest/ directory so SUPABASE_URL / SERVICE_ROLE_KEY are available
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# Make ingest/app importable (for zones and kernel helpers only — not db.py)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.vayutrace_industrial_zones import zones_as_dicts

# ── Sigma candidates to evaluate (km) ────────────────────────────────────────

SIGMA_CANDIDATES: list[float] = [1, 2, 3, 5, 7, 10, 15, 20, 30, 50]

# Minimum number of PM2.5 readings a station must have to be included.
MIN_READINGS = 20

# p-value threshold for the Spearman test to flag a result as significant.
P_THRESHOLD = 0.05

# Path to the kernel file so --apply can patch DEFAULT_SIGMA_KM.
KERNEL_FILE = Path(__file__).resolve().parent.parent / "app" / "vayutrace_kernel.py"


# ── Geometry helpers (inlined to avoid importing db.py) ───────────────────────

def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def _distance_decay(dist_km: float, sigma_km: float) -> float:
    return math.exp(-(dist_km ** 2) / (2.0 * sigma_km ** 2))


# ── Supabase REST client (httpx, no supabase-py needed) ──────────────────────

def _sb_headers() -> dict:
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not key:
        print("ERROR: SUPABASE_SERVICE_ROLE_KEY not set. Copy .env.example to .env and fill it in.")
        sys.exit(1)
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def _sb_url() -> str:
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    if not url:
        print("ERROR: SUPABASE_URL not set. Copy .env.example to .env and fill it in.")
        sys.exit(1)
    return url


def _get(path: str, params: dict | None = None) -> list[dict]:
    """GET from Supabase PostgREST and return rows (handles pagination)."""
    base = _sb_url() + "/rest/v1/" + path.lstrip("/")
    headers = _sb_headers()
    headers["Prefer"] = "count=none"
    rows: list[dict] = []
    offset = 0
    limit = 1000
    while True:
        p = dict(params or {})
        p["limit"] = str(limit)
        p["offset"] = str(offset)
        resp = httpx.get(base, headers=headers, params=p, timeout=30)
        resp.raise_for_status()
        page = resp.json()
        if not page:
            break
        rows.extend(page)
        if len(page) < limit:
            break
        offset += limit
    return rows


def fetch_stations_with_coords() -> list[dict]:
    return _get("stations", {"select": "id,name,lat,lng", "lat": "not.is.null", "lng": "not.is.null"})


def fetch_pm25_medians(station_ids: list[int], days: int) -> dict[int, float]:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    rows = _get("readings", {
        "select": "station_id,pm25",
        "station_id": f"in.({','.join(str(i) for i in station_ids)})",
        "ts": f"gte.{cutoff}",
        "pm25": "not.is.null",
    })
    by_station: dict[int, list[float]] = {}
    for r in rows:
        sid = r["station_id"]
        val = r.get("pm25")
        if val is not None:
            by_station.setdefault(sid, []).append(float(val))
    return {
        sid: float(np.median(vals))
        for sid, vals in by_station.items()
        if len(vals) >= MIN_READINGS
    }


# ── Core calibration ──────────────────────────────────────────────────────────

def industrial_proximity_score(
    station_lat: float,
    station_lng: float,
    zones: list[dict],
    sigma_km: float,
) -> float:
    """Mean Gaussian-weighted industrial emission weight toward this station.

    Wind is omitted — calibrating spatial scale, not directional alignment.
    """
    if not zones:
        return 0.0
    scores = [
        z["emission_weight"] * _distance_decay(
            _haversine_km(station_lat, station_lng, z["lat"], z["lng"]),
            sigma_km,
        )
        for z in zones
    ]
    return float(np.mean(scores))


def run_calibration(days: int = 30, verbose: bool = True) -> dict:
    zones = zones_as_dicts()
    if verbose:
        print(f"Loaded {len(zones)} industrial zones")

    stations = fetch_stations_with_coords()
    if not stations:
        print("ERROR: no stations with coordinates found. Check SUPABASE_URL and station lat/lng data.")
        sys.exit(1)
    if verbose:
        print(f"Found {len(stations)} stations with coordinates")

    station_ids = [s["id"] for s in stations]
    medians = fetch_pm25_medians(station_ids, days=days)
    if verbose:
        print(f"Stations with ≥{MIN_READINGS} readings in last {days} days: {len(medians)}")

    if len(medians) < 3:
        print(
            f"\nInsufficient data: only {len(medians)} station(s) have ≥{MIN_READINGS} "
            f"PM2.5 readings in the last {days} days.\n"
            f"Try --days with a larger value, or run after more data accumulates.\n"
            f"Keeping DEFAULT_SIGMA_KM = 10.0 (no change)."
        )
        sys.exit(0)

    station_map = {s["id"]: s for s in stations}
    all_medians = list(medians.values())
    city_background = float(np.median(all_medians))

    station_data = []
    for sid, pm25_med in medians.items():
        s = station_map.get(sid)
        if s is None:
            continue
        station_data.append({
            "id": sid,
            "name": s.get("name", f"station_{sid}"),
            "lat": float(s["lat"]),
            "lng": float(s["lng"]),
            "pm25_median": round(pm25_med, 1),
            "local_excess": round(pm25_med - city_background, 1),
        })

    if verbose:
        print(f"\nCity-wide PM2.5 background (median of station medians): {city_background:.1f} µg/m³")
        print(f"\n{'Station':<30} {'PM2.5 med':>10} {'Local excess':>12}")
        print("─" * 56)
        for sd in sorted(station_data, key=lambda x: x["local_excess"], reverse=True):
            print(f"{sd['name']:<30} {sd['pm25_median']:>10.1f} {sd['local_excess']:>+12.1f}")

    local_excesses = np.array([sd["local_excess"] for sd in station_data])

    results = []
    for sigma in SIGMA_CANDIDATES:
        scores = np.array([
            industrial_proximity_score(sd["lat"], sd["lng"], zones, sigma)
            for sd in station_data
        ])
        rho, pval = stats.spearmanr(scores, local_excesses)
        results.append({"sigma": sigma, "rho": round(float(rho), 4), "p_value": round(float(pval), 4)})

    best = max(results, key=lambda r: abs(r["rho"]))
    optimal_sigma = best["sigma"]
    max_rho = best["rho"]
    best_pval = best["p_value"]
    significant = best_pval < P_THRESHOLD
    n = len(station_data)

    if verbose:
        print(f"\n{'Sigma (km)':>10}  {'Spearman rho':>13}  {'p-value':>10}  {'Sig?':>6}")
        print("─" * 46)
        for r in results:
            marker = "  ← BEST" if r["sigma"] == optimal_sigma else ""
            sig = "yes" if r["p_value"] < P_THRESHOLD else "no"
            print(f"{r['sigma']:>10.0f}  {r['rho']:>13.4f}  {r['p_value']:>10.4f}  {sig:>6}{marker}")

        print(f"\nOptimal sigma: {optimal_sigma} km  (rho={max_rho:.4f}, p={best_pval:.4f}, n={n})")
        if significant:
            print(f"Correlation is statistically significant (p < {P_THRESHOLD})")
        else:
            print(
                f"Correlation is NOT statistically significant (p={best_pval:.4f} >= {P_THRESHOLD}).\n"
                f"With {n} station(s), need n >= 5 and |rho| > ~0.9 for 95% confidence.\n"
                "Result shown for reference; default 10 km unchanged unless --force-apply."
            )

    return {
        "optimal_sigma": optimal_sigma,
        "max_rho": max_rho,
        "p_value": best_pval,
        "significant": significant,
        "n_stations": n,
        "city_background_pm25": round(city_background, 1),
        "results": results,
        "station_data": station_data,
    }


# ── Kernel patcher ────────────────────────────────────────────────────────────

def apply_sigma(new_sigma: float, kernel_file: Path = KERNEL_FILE) -> None:
    text = kernel_file.read_text()
    new_text = re.sub(
        r"^(DEFAULT_SIGMA_KM\s*:\s*float\s*=\s*)\d+(?:\.\d+)?",
        rf"\g<1>{new_sigma}",
        text,
        flags=re.MULTILINE,
    )
    if new_text == text:
        print(f"WARNING: could not find DEFAULT_SIGMA_KM in {kernel_file}")
        return
    kernel_file.write_text(new_text)
    print(f"Updated DEFAULT_SIGMA_KM = {new_sigma} in {kernel_file.name}")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Calibrate VayuTrace sigma_km")
    parser.add_argument("--days", type=int, default=30, help="Days of PM2.5 history (default 30)")
    parser.add_argument("--apply", action="store_true", help="Write optimal sigma to kernel (only if significant)")
    parser.add_argument("--force-apply", action="store_true", help="Write even if not significant")
    args = parser.parse_args()

    print(f"VayuTrace sigma calibration — last {args.days} days of CPCB data\n")
    result = run_calibration(days=args.days, verbose=True)

    if args.apply or args.force_apply:
        if result["significant"] or args.force_apply:
            print(f"\nApplying sigma = {result['optimal_sigma']} km …")
            apply_sigma(result["optimal_sigma"])
        else:
            print(f"\n--apply set but result not significant (p={result['p_value']:.4f}). Use --force-apply to override.")
    else:
        print(f"\nTo apply: python3 ingest/scripts/calibrate_vayutrace_sigma.py --days {args.days} --apply")


if __name__ == "__main__":
    main()
