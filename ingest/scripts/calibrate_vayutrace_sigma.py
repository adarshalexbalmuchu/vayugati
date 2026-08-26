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


# ── Wind-stratified data fetching ────────────────────────────────────────────

def fetch_stations_with_ward(station_ids: list[int]) -> dict[int, int]:
    """Returns {station_id: ward_id} for stations that have a ward assignment."""
    rows = _get("stations", {
        "select": "id,ward_id",
        "id": f"in.({','.join(str(i) for i in station_ids)})",
        "ward_id": "not.is.null",
    })
    return {r["id"]: r["ward_id"] for r in rows}


def fetch_weather_by_ward(ward_ids: list[int], days: int) -> dict[int, list[tuple]]:
    """Returns {ward_id: [(ts_epoch, wind_dir, wind_speed), ...]} sorted by ts.

    Used to look up the closest weather entry for each reading timestamp.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    rows = _get("weather", {
        "select": "ward_id,ts,wind_dir,wind_speed",
        "ward_id": f"in.({','.join(str(i) for i in ward_ids)})",
        "ts": f"gte.{cutoff}",
        "wind_dir": "not.is.null",
    })
    result: dict[int, list[tuple]] = {}
    for r in rows:
        wid = r["ward_id"]
        ts_epoch = datetime.fromisoformat(r["ts"].replace("Z", "+00:00")).timestamp()
        result.setdefault(wid, []).append(
            (ts_epoch, float(r["wind_dir"]), float(r.get("wind_speed") or 0.0))
        )
    for wid in result:
        result[wid].sort(key=lambda x: x[0])
    return result


def fetch_all_readings_with_ts(station_ids: list[int], days: int) -> list[dict]:
    """Fetch all (station_id, ts, pm25) rows for last N days — paginated."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    return _get("readings", {
        "select": "station_id,ts,pm25",
        "station_id": f"in.({','.join(str(i) for i in station_ids)})",
        "ts": f"gte.{cutoff}",
        "pm25": "not.is.null",
        "order": "ts.asc",
    })


def _find_nearest_weather(ts_epoch: float, weather_list: list[tuple]) -> tuple | None:
    """Binary search for the weather entry nearest to ts_epoch."""
    import bisect
    if not weather_list:
        return None
    times = [w[0] for w in weather_list]
    idx = bisect.bisect_left(times, ts_epoch)
    candidates = []
    if idx > 0:
        candidates.append(weather_list[idx - 1])
    if idx < len(weather_list):
        candidates.append(weather_list[idx])
    best = min(candidates, key=lambda w: abs(w[0] - ts_epoch))
    # Accept only if within 3 hours (readings and weather cadences may differ)
    if abs(best[0] - ts_epoch) > 3 * 3600:
        return None
    return best


def _wind_factor(bearing_deg: float, wind_from_dir: float, wind_speed: float) -> float:
    """How much does wind carry emissions from source toward this station?

    Same formula as vayutrace_kernel._wind_factor — inlined to avoid import.
    bearing_deg: direction from industrial zone TO station (degrees, 0=N)
    wind_from_dir: meteorological wind-from direction (0=N, Open-Meteo convention)
    """
    wind_toward = (wind_from_dir + 180.0) % 360.0
    delta = abs(bearing_deg - wind_toward)
    if delta > 180:
        delta = 360 - delta
    alignment = max(0.0, math.cos(math.radians(delta)))
    return alignment * (1.0 + wind_speed / 10.0)


def build_station_zone_geometry(station_data: list[dict], zones: list[dict]) -> dict[int, list[tuple]]:
    """Pre-compute (dist_km, bearing, emission_weight) for every station-zone pair.

    Avoids recomputing haversine and bearing for every reading — these are
    fixed by station and zone positions.  Returns {station_id: [(dist, bearing, ew), ...]}.
    """
    geo: dict[int, list[tuple]] = {}
    for sd in station_data:
        sid = sd["id"]
        lat, lng = float(sd["lat"]), float(sd["lng"])
        pairs = []
        for z in zones:
            zlat, zlng = z["lat"], z["lng"]
            dist = _haversine_km(lat, lng, zlat, zlng)
            # Bearing FROM zone TO station (direction plume travels)
            phi1, phi2 = math.radians(zlat), math.radians(lat)
            dlam = math.radians(lng - zlng)
            x = math.sin(dlam) * math.cos(phi2)
            y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlam)
            bearing = (math.degrees(math.atan2(x, y)) + 360) % 360
            pairs.append((dist, bearing, float(z["emission_weight"])))
        geo[sid] = pairs
    return geo


def wind_weighted_score_vec(geo_pairs: list[tuple], wind_dir: float, wind_speed: float, sigma: float) -> float:
    """Mean wind-weighted industrial score for one station+reading+sigma.

    geo_pairs: [(dist_km, bearing_zone_to_station, emission_weight), ...]
    """
    scores = [
        ew * _wind_factor(bearing, wind_dir, wind_speed) * _distance_decay(dist, sigma)
        for dist, bearing, ew in geo_pairs
    ]
    return float(np.mean(scores)) if scores else 0.0


# ── Wind-stratified calibration ───────────────────────────────────────────────

def run_wind_calibration(days: int = 30, verbose: bool = True) -> dict:
    """Calibrate sigma using every individual reading, not just per-station medians.

    For each (station, timestamp) pair that has both a PM2.5 reading and a
    matched weather row, compute:
        wind_weighted_score(sigma) = mean over zones of
            [ew × wind_factor(bearing, wind_dir, speed) × distance_decay(dist, sigma)]
        local_excess = pm25 − hourly_city_median_pm25

    Spearman-correlate across all pairs.  With thousands of data points this
    tests the actual physical mechanism: when wind blows from an industrial
    zone toward a station, does PM2.5 rise?
    """
    # 1. Load zones and station geometry
    zones = zones_as_dicts()
    if verbose:
        print(f"Loaded {len(zones)} industrial zones")

    stations = fetch_stations_with_coords()
    if not stations:
        print("ERROR: no stations with coordinates found.")
        sys.exit(1)
    station_map = {s["id"]: s for s in stations}
    station_ids = [s["id"] for s in stations]
    if verbose:
        print(f"Found {len(stations)} stations with coordinates")

    # 2. Get station → ward mapping for weather join
    sid_to_ward = fetch_stations_with_ward(station_ids)
    ward_ids = list(set(sid_to_ward.values()))
    if verbose:
        print(f"Fetching weather for {len(ward_ids)} wards …")

    weather_by_ward = fetch_weather_by_ward(ward_ids, days=days)
    total_weather = sum(len(v) for v in weather_by_ward.values())
    if verbose:
        print(f"Fetched {total_weather:,} weather rows")
        print(f"Fetching readings for last {days} days (may take a moment) …")

    # 3. Fetch all readings
    raw_readings = fetch_all_readings_with_ts(station_ids, days=days)
    if verbose:
        print(f"Fetched {len(raw_readings):,} readings")

    # 4. Build hourly city-median lookup: ts_hour → median pm25 across all stations
    hour_buckets: dict[int, list[float]] = {}
    for r in raw_readings:
        ts = datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))
        hour_key = int(ts.replace(minute=0, second=0, microsecond=0).timestamp())
        val = r.get("pm25")
        if val is not None:
            hour_buckets.setdefault(hour_key, []).append(float(val))
    hourly_city_median: dict[int, float] = {
        h: float(np.median(vals)) for h, vals in hour_buckets.items()
    }

    # 5. Join readings to weather and compute local excess
    geo = build_station_zone_geometry(stations, zones)
    pairs_wind_dir: list[float] = []
    pairs_wind_speed: list[float] = []
    pairs_local_excess: list[float] = []
    pairs_station_id: list[int] = []
    skipped_no_weather = 0
    skipped_no_ward = 0

    for r in raw_readings:
        sid = r["station_id"]
        pm25 = r.get("pm25")
        if pm25 is None or sid not in geo:
            continue

        ts_epoch = datetime.fromisoformat(r["ts"].replace("Z", "+00:00")).timestamp()
        hour_key = int((ts_epoch // 3600) * 3600)
        city_med = hourly_city_median.get(hour_key)
        if city_med is None:
            continue

        ward_id = sid_to_ward.get(sid)
        if ward_id is None:
            skipped_no_ward += 1
            continue

        wx = _find_nearest_weather(ts_epoch, weather_by_ward.get(ward_id, []))
        if wx is None:
            skipped_no_weather += 1
            continue

        _, wind_dir, wind_speed = wx
        pairs_station_id.append(sid)
        pairs_wind_dir.append(wind_dir)
        pairs_wind_speed.append(wind_speed)
        pairs_local_excess.append(float(pm25) - city_med)

    n_pairs = len(pairs_local_excess)
    if verbose:
        print(f"\nValid (reading, weather) pairs: {n_pairs:,} "
              f"(skipped {skipped_no_weather:,} no-weather, {skipped_no_ward:,} no-ward)")

    if n_pairs < 100:
        print("Insufficient paired data — need at least 100 reading+weather pairs. "
              "Try --days with a larger value.")
        sys.exit(0)

    local_excesses = np.array(pairs_local_excess)

    # 6. For each sigma, compute wind-weighted scores and Spearman correlation
    results = []
    for sigma in SIGMA_CANDIDATES:
        scores = np.array([
            wind_weighted_score_vec(geo[sid], wd, ws, sigma)
            for sid, wd, ws in zip(pairs_station_id, pairs_wind_dir, pairs_wind_speed)
        ])
        rho, pval = stats.spearmanr(scores, local_excesses)
        results.append({"sigma": sigma, "rho": round(float(rho), 4), "p_value": round(float(pval), 6)})

    best = max(results, key=lambda r: abs(r["rho"]))
    optimal_sigma = best["sigma"]
    max_rho = best["rho"]
    best_pval = best["p_value"]
    significant = best_pval < P_THRESHOLD

    if verbose:
        print(f"\n{'Sigma (km)':>10}  {'Spearman rho':>13}  {'p-value':>12}  {'Sig?':>6}")
        print("─" * 50)
        for r in results:
            marker = "  ← BEST" if r["sigma"] == optimal_sigma else ""
            sig = "yes" if r["p_value"] < P_THRESHOLD else "no"
            print(f"{r['sigma']:>10.0f}  {r['rho']:>13.4f}  {r['p_value']:>12.6f}  {sig:>6}{marker}")

        print(f"\nOptimal sigma: {optimal_sigma} km  (rho={max_rho:.4f}, p={best_pval:.6f}, n={n_pairs:,} pairs)")
        if significant:
            print(f"Correlation is statistically significant (p < {P_THRESHOLD})")
        else:
            print(
                f"Correlation is NOT statistically significant (p={best_pval:.6f} >= {P_THRESHOLD}).\n"
                f"With n={n_pairs:,} pairs, even a tiny true effect would be detectable —\n"
                "a non-significant result here means the industrial wind signal is genuinely\n"
                "weak relative to the total PM2.5 variance (expected for a heavily mixed city)."
            )

    return {
        "optimal_sigma": optimal_sigma,
        "max_rho": max_rho,
        "p_value": best_pval,
        "significant": significant,
        "n_pairs": n_pairs,
        "results": results,
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
        # Critical rho for two-tailed Spearman at p=0.05 with n observations.
        # Approximated via the t-distribution: t_crit = scipy.stats.t.ppf(0.975, df=n-2)
        # rho_crit = t_crit / sqrt(t_crit^2 + n - 2).  At n=44, rho_crit ≈ 0.30.
        from scipy.stats import t as t_dist
        t_crit = t_dist.ppf(0.975, df=max(n - 2, 1))
        rho_crit = round(t_crit / math.sqrt(t_crit ** 2 + n - 2), 2)

        if significant:
            print(f"Correlation is statistically significant (p < {P_THRESHOLD})")
        else:
            print(
                f"Correlation is NOT statistically significant (p={best_pval:.4f} >= {P_THRESHOLD}).\n"
                f"With n={n}, the 95% significance threshold is |rho| > ~{rho_crit}.\n"
                f"Observed |rho| = {abs(max_rho):.3f} — below that bar.\n"
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
    parser.add_argument("--days", type=int, default=30, help="Days of history to use (default 30)")
    parser.add_argument(
        "--wind", action="store_true",
        help="Wind-stratified mode: correlate per-reading wind-weighted scores against "
             "instantaneous local PM2.5 excess (uses every reading, not station medians)",
    )
    parser.add_argument("--apply", action="store_true", help="Write optimal sigma to kernel (only if significant)")
    parser.add_argument("--force-apply", action="store_true", help="Write even if not significant")
    args = parser.parse_args()

    if args.wind:
        print(f"VayuTrace sigma calibration [wind-stratified] — last {args.days} days\n")
        result = run_wind_calibration(days=args.days, verbose=True)
    else:
        print(f"VayuTrace sigma calibration [station-median] — last {args.days} days of CPCB data\n")
        result = run_calibration(days=args.days, verbose=True)

    if args.apply or args.force_apply:
        if result["significant"] or args.force_apply:
            print(f"\nApplying sigma = {result['optimal_sigma']} km …")
            apply_sigma(result["optimal_sigma"])
        else:
            print(
                f"\n--apply set but result not significant "
                f"(p={result['p_value']:.6f if args.wind else result['p_value']:.4f}). "
                "Use --force-apply to override."
            )
    else:
        flag = "--wind " if args.wind else ""
        print(f"\nTo apply: python3 ingest/scripts/calibrate_vayutrace_sigma.py {flag}--days {args.days} --apply")


if __name__ == "__main__":
    main()
