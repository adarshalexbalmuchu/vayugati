"""Calibrate VayuTrace industrial-source Gaussian decay length (sigma_km).

Background
----------
The VayuTrace kernel now uses:
  - Per-source-type sigma: road=1 km (fixed, CERC/TERI-ARAI grounded),
    fire=20 km (fixed, agricultural-burn transport range).
  - Season-aware industrial sigma: SIGMA_WINTER_KM (Oct–Feb, P-G E-F
    stable) and SIGMA_SUMMER_KM (Mar–Sep, P-G D neutral, Spearman-
    calibrated).  This script calibrates those two values from live data.

The calm-wind blending added in the kernel (< 1 m/s → isotropic) is
included here via direct import, so the calibration uses the exact same
wind-factor formula as the kernel — no stale inlined copy.

Approach
--------
Wind-stratified mode (--wind, strongly preferred):

  For each (CPCB station, timestamp) pair that has both a PM2.5 reading
  and a matched weather row, compute:

      score(sigma) = mean over industrial zones of
                     [ew × wind_factor(bearing, wind_dir, speed)
                         × exp(-dist²/2σ²)]
      local_excess = pm25 − hourly_city_median_pm25

  Spearman-correlate across all pairs.  When wind blows from an industrial
  zone toward a station, PM2.5 should rise — if sigma is correct.

  Season flag:
    --season winter  → use only Oct–Feb readings to calibrate SIGMA_WINTER_KM
    --season summer  → use only Mar–Sep readings to calibrate SIGMA_SUMMER_KM
    --season all     → use all readings (default, backward-compatible)

Station-median mode (default, faster but weaker):

  Spearman between per-station PM2.5 medians and distance-only proximity
  scores.  Useful as a quick sanity check; the wind mode is more sensitive.

Sigma candidates
----------------
Only the industrial range is tested: 2–15 km.  Road (1 km) and fire
(20 km) are physics-fixed and not varied here.

Usage
-----
  # Calibrate summer sigma (recommended, re-run after 30+ days of data):
  python3 ingest/scripts/calibrate_vayutrace_sigma.py --wind --season summer

  # Calibrate winter sigma:
  python3 ingest/scripts/calibrate_vayutrace_sigma.py --wind --season winter

  # Apply result if significant:
  python3 ingest/scripts/calibrate_vayutrace_sigma.py --wind --season summer --apply
"""

from __future__ import annotations

import argparse
import bisect
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

# Load .env from ingest/ directory
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# Make ingest/app importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.vayutrace_industrial_zones import zones_as_dicts
from app.vayutrace_kernel import (
    _wind_factor,       # includes calm-wind isotropic blending
    _distance_decay,
    _WINTER_MONTHS,
    SIGMA_WINTER_KM,
    SIGMA_SUMMER_KM,
)

# ── Sigma candidates (km) — industrial range only ────────────────────────────

# Granular grid around the plausible industrial range (2–15 km).
# Road (1 km) and fire (20 km) sigmas are physics-fixed; don't include them.
SIGMA_CANDIDATES: list[float] = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15]

MIN_READINGS = 20       # minimum readings for a station to be included (median mode)
P_THRESHOLD  = 0.05     # significance level

KERNEL_FILE  = Path(__file__).resolve().parent.parent / "app" / "vayutrace_kernel.py"


# ── Geometry helper (inlined to avoid importing db.py) ───────────────────────

def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


# ── Supabase REST client ──────────────────────────────────────────────────────

def _sb_headers() -> dict:
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not key:
        print("ERROR: SUPABASE_SERVICE_ROLE_KEY not set. Copy ingest/.env.example to ingest/.env and fill it in.")
        sys.exit(1)
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def _sb_url() -> str:
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    if not url:
        print("ERROR: SUPABASE_URL not set.")
        sys.exit(1)
    return url


def _get(path: str, params: dict | None = None) -> list[dict]:
    """GET from Supabase PostgREST, auto-paginated."""
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


# ── Data fetchers ─────────────────────────────────────────────────────────────

def fetch_stations_with_coords() -> list[dict]:
    return _get("stations", {"select": "id,name,lat,lng,ward_id",
                             "lat": "not.is.null", "lng": "not.is.null"})


def fetch_pm25_medians(station_ids: list[int], days: int,
                       season: str = "all") -> dict[int, float]:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    rows = _get("readings", {
        "select": "station_id,ts,pm25",
        "station_id": f"in.({','.join(str(i) for i in station_ids)})",
        "ts": f"gte.{cutoff}",
        "pm25": "not.is.null",
    })
    if season != "all":
        rows = [r for r in rows if _is_target_season(r["ts"], season)]
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


def fetch_weather_by_ward(ward_ids: list[int], days: int) -> dict[int, list[tuple]]:
    """Returns {ward_id: [(ts_epoch, wind_dir, wind_speed), ...]} sorted by ts."""
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
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    return _get("readings", {
        "select": "station_id,ts,pm25",
        "station_id": f"in.({','.join(str(i) for i in station_ids)})",
        "ts": f"gte.{cutoff}",
        "pm25": "not.is.null",
        "order": "ts.asc",
    })


# ── Season filter ─────────────────────────────────────────────────────────────

def _is_target_season(ts_str: str, season: str) -> bool:
    """Return True if the timestamp falls in the requested season.

    season: "winter" (Oct–Feb), "summer" (Mar–Sep), "all"
    """
    if season == "all":
        return True
    month = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).month
    in_winter = month in _WINTER_MONTHS
    return in_winter if season == "winter" else not in_winter


# ── Geometry pre-computation ──────────────────────────────────────────────────

def build_station_zone_geometry(station_data: list[dict],
                                zones: list[dict]) -> dict[int, list[tuple]]:
    """Pre-compute (dist_km, bearing, emission_weight) for every station-zone pair.

    bearing is FROM zone TO station (direction the plume must travel).
    Avoids repeating haversine on every reading timestamp.
    """
    geo: dict[int, list[tuple]] = {}
    for sd in station_data:
        sid = sd["id"]
        lat, lng = float(sd["lat"]), float(sd["lng"])
        pairs = []
        for z in zones:
            zlat, zlng = z["lat"], z["lng"]
            dist = _haversine_km(lat, lng, zlat, zlng)
            phi1, phi2 = math.radians(zlat), math.radians(lat)
            dlam = math.radians(lng - zlng)
            x = math.sin(dlam) * math.cos(phi2)
            y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlam)
            bearing = (math.degrees(math.atan2(x, y)) + 360) % 360
            pairs.append((dist, bearing, float(z["emission_weight"])))
        geo[sid] = pairs
    return geo


def wind_weighted_score(geo_pairs: list[tuple], wind_dir: float,
                        wind_speed: float, sigma: float) -> float:
    """Mean wind-weighted industrial score for one (station, reading, sigma).

    Uses the kernel's _wind_factor directly — calm-wind blending included.
    """
    scores = [
        ew * _wind_factor(bearing, wind_dir, wind_speed) * _distance_decay(dist, sigma)
        for dist, bearing, ew in geo_pairs
    ]
    return float(np.mean(scores)) if scores else 0.0


# ── Weather matching ──────────────────────────────────────────────────────────

def _find_nearest_weather(ts_epoch: float, weather_list: list[tuple]) -> tuple | None:
    """Binary search for the weather entry closest to ts_epoch (≤3 h window)."""
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
    if abs(best[0] - ts_epoch) > 3 * 3600:
        return None
    return best


# ── Wind-stratified calibration (primary) ────────────────────────────────────

def run_wind_calibration(days: int = 30, season: str = "all",
                         verbose: bool = True) -> dict:
    """Calibrate industrial sigma using per-reading wind-weighted scores.

    With season="winter" or "summer", only readings from that season are
    used, so the calibration is specific to that atmospheric stability regime.
    """
    season_label = {"winter": "Oct–Feb", "summer": "Mar–Sep", "all": "all months"}[season]

    zones = zones_as_dicts()
    if verbose:
        print(f"Loaded {len(zones)} industrial zones")

    stations = fetch_stations_with_coords()
    if not stations:
        print("ERROR: no stations with coordinates.")
        sys.exit(1)
    station_ids = [s["id"] for s in stations]
    if verbose:
        print(f"Found {len(stations)} stations with coordinates")

    sid_to_ward = {s["id"]: s["ward_id"] for s in stations if s.get("ward_id")}
    ward_ids = list(set(sid_to_ward.values()))
    if verbose:
        print(f"Fetching weather for {len(ward_ids)} wards …")

    weather_by_ward = fetch_weather_by_ward(ward_ids, days=days)
    if verbose:
        total_wx = sum(len(v) for v in weather_by_ward.values())
        print(f"Fetched {total_wx:,} weather rows")
        print(f"Fetching readings for last {days} days ({season_label}) …")

    raw_readings = fetch_all_readings_with_ts(station_ids, days=days)
    if verbose:
        print(f"Fetched {len(raw_readings):,} readings")

    # Season filter
    if season != "all":
        raw_readings = [r for r in raw_readings if _is_target_season(r["ts"], season)]
        if verbose:
            print(f"After {season} filter: {len(raw_readings):,} readings")

    # Hourly city-wide PM2.5 median for local-excess computation
    hour_buckets: dict[int, list[float]] = {}
    for r in raw_readings:
        ts = datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))
        h = int(ts.replace(minute=0, second=0, microsecond=0).timestamp())
        if r.get("pm25") is not None:
            hour_buckets.setdefault(h, []).append(float(r["pm25"]))
    hourly_city_median: dict[int, float] = {
        h: float(np.median(v)) for h, v in hour_buckets.items()
    }

    # Join readings to weather
    geo = build_station_zone_geometry(stations, zones)
    pairs_sid:    list[int]   = []
    pairs_wdir:   list[float] = []
    pairs_wspeed: list[float] = []
    pairs_excess: list[float] = []
    skipped_no_weather = skipped_no_ward = 0

    for r in raw_readings:
        sid  = r["station_id"]
        pm25 = r.get("pm25")
        if pm25 is None or sid not in geo:
            continue
        ts_epoch = datetime.fromisoformat(r["ts"].replace("Z", "+00:00")).timestamp()
        h = int((ts_epoch // 3600) * 3600)
        city_med = hourly_city_median.get(h)
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
        pairs_sid.append(sid)
        pairs_wdir.append(wind_dir)
        pairs_wspeed.append(wind_speed)
        pairs_excess.append(float(pm25) - city_med)

    n_pairs = len(pairs_excess)
    if verbose:
        print(f"\nValid (reading, weather) pairs: {n_pairs:,}  "
              f"(skipped {skipped_no_weather:,} no-weather, {skipped_no_ward:,} no-ward)")

    if n_pairs < 100:
        print("Insufficient paired data — need ≥100 pairs. Try --days with a larger value.")
        sys.exit(0)

    # Calm-wind statistics (informational)
    n_calm = sum(1 for v in pairs_wspeed if v <= 1.0)
    n_blend = sum(1 for v in pairs_wspeed if 1.0 < v <= 2.0)
    if verbose:
        print(f"Wind regime: {n_calm:,} calm (≤1 m/s, isotropic), "
              f"{n_blend:,} blend (1–2 m/s), "
              f"{n_pairs - n_calm - n_blend:,} directional (>2 m/s)")

    local_excesses = np.array(pairs_excess)

    results = []
    for sigma in SIGMA_CANDIDATES:
        scores = np.array([
            wind_weighted_score(geo[sid], wd, ws, sigma)
            for sid, wd, ws in zip(pairs_sid, pairs_wdir, pairs_wspeed)
        ])
        rho, pval = stats.spearmanr(scores, local_excesses)
        results.append({"sigma": sigma, "rho": round(float(rho), 4),
                        "p_value": round(float(pval), 6)})

    best = max(results, key=lambda r: abs(r["rho"]))
    optimal_sigma = best["sigma"]
    max_rho       = best["rho"]
    best_pval     = best["p_value"]
    significant   = best_pval < P_THRESHOLD

    if verbose:
        print(f"\n{'Sigma (km)':>10}  {'Spearman rho':>13}  {'p-value':>12}  {'Sig?':>6}")
        print("─" * 50)
        for r in results:
            marker = "  ← BEST" if r["sigma"] == optimal_sigma else ""
            sig = "yes" if r["p_value"] < P_THRESHOLD else "no"
            print(f"{r['sigma']:>10.1f}  {r['rho']:>13.4f}  {r['p_value']:>12.6f}  {sig:>6}{marker}")

        target_var = "SIGMA_WINTER_KM" if season == "winter" else "SIGMA_SUMMER_KM"
        current    = SIGMA_WINTER_KM   if season == "winter" else SIGMA_SUMMER_KM
        print(f"\nOptimal sigma: {optimal_sigma} km  "
              f"(rho={max_rho:.4f}, p={best_pval:.6f}, n={n_pairs:,} pairs)")
        print(f"Target variable: {target_var}  (current value: {current} km)")
        if significant:
            print(f"Statistically significant (p < {P_THRESHOLD})")
        else:
            print(
                f"NOT statistically significant (p={best_pval:.6f} ≥ {P_THRESHOLD}).\n"
                f"With n={n_pairs:,} pairs, even tiny effects are detectable — a\n"
                "non-significant result means the industrial wind signal is genuinely\n"
                "weak vs. total PM2.5 variance (expected in a heavily mixed city)."
            )

    return {
        "optimal_sigma": optimal_sigma,
        "target_variable": "SIGMA_WINTER_KM" if season == "winter" else "SIGMA_SUMMER_KM",
        "max_rho": max_rho,
        "p_value": best_pval,
        "significant": significant,
        "n_pairs": n_pairs,
        "season": season,
        "results": results,
    }


# ── Station-median calibration (quick sanity check) ───────────────────────────

def _proximity_score_median(station_lat: float, station_lng: float,
                            zones: list[dict], sigma_km: float) -> float:
    """Mean Gaussian-weighted proximity score (no wind — spatial calibration only)."""
    if not zones:
        return 0.0
    return float(np.mean([
        z["emission_weight"] * _distance_decay(
            _haversine_km(station_lat, station_lng, z["lat"], z["lng"]), sigma_km)
        for z in zones
    ]))


def run_calibration(days: int = 30, season: str = "all",
                    verbose: bool = True) -> dict:
    """Station-median calibration (distance-only, faster, less sensitive)."""
    zones = zones_as_dicts()
    stations = fetch_stations_with_coords()
    if not stations:
        print("ERROR: no stations with coordinates.")
        sys.exit(1)

    station_ids = [s["id"] for s in stations]
    medians = fetch_pm25_medians(station_ids, days=days, season=season)

    if verbose:
        season_label = {"winter": "Oct–Feb", "summer": "Mar–Sep", "all": "all months"}[season]
        print(f"Loaded {len(zones)} zones, {len(stations)} stations")
        print(f"Stations with ≥{MIN_READINGS} readings ({season_label}): {len(medians)}")

    if len(medians) < 3:
        print(f"Insufficient data: {len(medians)} stations. Try --days with a larger value.")
        sys.exit(0)

    station_map = {s["id"]: s for s in stations}
    city_bg = float(np.median(list(medians.values())))

    station_data = [
        {
            "id": sid,
            "name": station_map[sid].get("name", f"station_{sid}"),
            "lat": float(station_map[sid]["lat"]),
            "lng": float(station_map[sid]["lng"]),
            "pm25_median": round(pm25, 1),
            "local_excess": round(pm25 - city_bg, 1),
        }
        for sid, pm25 in medians.items()
        if sid in station_map
    ]

    if verbose:
        print(f"\nCity PM2.5 background: {city_bg:.1f} µg/m³")
        print(f"\n{'Station':<30} {'PM2.5 med':>10} {'Local excess':>12}")
        print("─" * 56)
        for sd in sorted(station_data, key=lambda x: x["local_excess"], reverse=True):
            print(f"{sd['name']:<30} {sd['pm25_median']:>10.1f} {sd['local_excess']:>+12.1f}")

    local_excesses = np.array([sd["local_excess"] for sd in station_data])
    results = []
    for sigma in SIGMA_CANDIDATES:
        scores = np.array([
            _proximity_score_median(sd["lat"], sd["lng"], zones, sigma)
            for sd in station_data
        ])
        rho, pval = stats.spearmanr(scores, local_excesses)
        results.append({"sigma": sigma, "rho": round(float(rho), 4),
                        "p_value": round(float(pval), 4)})

    best = max(results, key=lambda r: abs(r["rho"]))
    optimal_sigma = best["sigma"]
    max_rho       = best["rho"]
    best_pval     = best["p_value"]
    significant   = best_pval < P_THRESHOLD
    n = len(station_data)

    if verbose:
        print(f"\n{'Sigma (km)':>10}  {'Spearman rho':>13}  {'p-value':>10}  {'Sig?':>6}")
        print("─" * 48)
        for r in results:
            marker = "  ← BEST" if r["sigma"] == optimal_sigma else ""
            sig = "yes" if r["p_value"] < P_THRESHOLD else "no"
            print(f"{r['sigma']:>10.1f}  {r['rho']:>13.4f}  {r['p_value']:>10.4f}  {sig:>6}{marker}")

        from scipy.stats import t as t_dist
        t_crit = t_dist.ppf(0.975, df=max(n - 2, 1))
        rho_crit = round(t_crit / math.sqrt(t_crit ** 2 + n - 2), 2)
        target_var = "SIGMA_WINTER_KM" if season == "winter" else "SIGMA_SUMMER_KM"
        print(f"\nOptimal sigma: {optimal_sigma} km  (rho={max_rho:.4f}, p={best_pval:.4f}, n={n})")
        print(f"Target variable: {target_var}")
        if not significant:
            print(f"NOT significant — 95% bar at n={n} is |rho| > ~{rho_crit}")

    return {
        "optimal_sigma": optimal_sigma,
        "target_variable": "SIGMA_WINTER_KM" if season == "winter" else "SIGMA_SUMMER_KM",
        "max_rho": max_rho,
        "p_value": best_pval,
        "significant": significant,
        "n_stations": n,
        "results": results,
    }


# ── Kernel patcher ────────────────────────────────────────────────────────────

def apply_sigma(new_sigma: float, target_var: str,
                kernel_file: Path = KERNEL_FILE) -> None:
    """Patch SIGMA_WINTER_KM or SIGMA_SUMMER_KM in vayutrace_kernel.py."""
    text = kernel_file.read_text()
    pattern = rf"^({re.escape(target_var)}\s*:\s*float\s*=\s*)\d+(?:\.\d+)?"
    new_text = re.sub(pattern, rf"\g<1>{new_sigma}", text, flags=re.MULTILINE)
    if new_text == text:
        print(f"WARNING: could not find {target_var} in {kernel_file.name}")
        return
    kernel_file.write_text(new_text)
    print(f"Updated {target_var} = {new_sigma} km in {kernel_file.name}")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Calibrate VayuTrace industrial sigma_km",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--days", type=int, default=30,
                        help="Days of history to use (default 30)")
    parser.add_argument("--wind", action="store_true",
                        help="Wind-stratified mode (recommended — uses per-reading "
                             "wind direction/speed including calm-wind blending)")
    parser.add_argument("--season", choices=["winter", "summer", "all"], default="all",
                        help="Season to calibrate: winter=Oct–Feb (SIGMA_WINTER_KM), "
                             "summer=Mar–Sep (SIGMA_SUMMER_KM), all=combined (default)")
    parser.add_argument("--apply", action="store_true",
                        help="Write optimal sigma to kernel if significant")
    parser.add_argument("--force-apply", action="store_true",
                        help="Write even if not significant")
    args = parser.parse_args()

    mode = "wind-stratified" if args.wind else "station-median"
    season_label = {"winter": "Oct–Feb", "summer": "Mar–Sep", "all": "all months"}[args.season]
    print(f"VayuTrace industrial sigma calibration [{mode}] — "
          f"last {args.days} days, {season_label}\n")

    if args.wind:
        result = run_wind_calibration(days=args.days, season=args.season, verbose=True)
    else:
        result = run_calibration(days=args.days, season=args.season, verbose=True)

    if args.apply or args.force_apply:
        if result["significant"] or args.force_apply:
            print(f"\nApplying {result['target_variable']} = {result['optimal_sigma']} km …")
            apply_sigma(result["optimal_sigma"], result["target_variable"])
        else:
            fmt = ".6f" if args.wind else ".4f"
            print(
                f"\n--apply set but result not significant "
                f"(p={result['p_value']:{fmt}}). Use --force-apply to override."
            )
    else:
        flag = "--wind " if args.wind else ""
        season_flag = f"--season {args.season} " if args.season != "all" else ""
        print(f"\nTo apply: python3 ingest/scripts/calibrate_vayutrace_sigma.py "
              f"{flag}{season_flag}--days {args.days} --apply")


if __name__ == "__main__":
    main()
