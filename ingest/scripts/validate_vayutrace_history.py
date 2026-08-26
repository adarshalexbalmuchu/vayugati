"""Backtest VayuTrace kernel against 3+ years of historical Delhi data.

Why this script exists
----------------------
The live weather table starts July 2026 (when the platform went live), so
the calibration script can only see ~30 days of paired (reading, weather)
data at a time.  But `readings` contains CPCB data back to October 2022 —
three full winters of Delhi smog episodes.

This script fills the weather gap the honest way: for each ward that has
CPCB stations, it fetches historical hourly wind data from the Open-Meteo
archive API (ERA5-reanalysis, free, no key, goes back to 1940), joins those
winds to historical readings, and runs the same Spearman calibration used in
calibrate_vayutrace_sigma.py.

It also runs a kernel-comparison test: old kernel (no calm-wind blending,
single sigma=7 for all types) vs new kernel (calm-wind isotropic below 1 m/s,
per-type sigma) on the same historical pairs, showing whether the literature-
grounded changes produce a measurably higher Spearman ρ.

Outputs
-------
  - Per-season calibration tables (winter / summer) with Spearman ρ vs sigma
  - Kernel comparison table: old vs new, split by wind regime (calm / blend /
    directional) and by season
  - Recommended σ_summer and σ_winter (if enough winter data exists)

Usage
-----
  python3 ingest/scripts/validate_vayutrace_history.py
  python3 ingest/scripts/validate_vayutrace_history.py --from 2022-10-01
  python3 ingest/scripts/validate_vayutrace_history.py --season winter
  python3 ingest/scripts/validate_vayutrace_history.py --compare  # old vs new kernel
"""

from __future__ import annotations

import argparse
import bisect
import math
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx
import numpy as np
from scipy import stats
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.vayutrace_industrial_zones import zones_as_dicts
from app.vayutrace_kernel import (
    _wind_factor,
    _distance_decay,
    _WINTER_MONTHS,
    SIGMA_WINTER_KM,
    SIGMA_SUMMER_KM,
    SIGMA_ROAD_KM,
    SIGMA_FIRE_KM,
    CALM_BLEND_LO_MS,
    CALM_BLEND_HI_MS,
    CALM_ISOTROPIC_FACTOR,
)

# ── Config ────────────────────────────────────────────────────────────────────

SIGMA_CANDIDATES: list[float] = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15]
P_THRESHOLD = 0.05
MIN_READINGS_PER_STATION = 20  # for station-median mode

# Open-Meteo archive endpoint (ERA5 reanalysis, free, no key)
OM_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"

# Supabase REST helpers ────────────────────────────────────────────────────────

def _sb_headers() -> dict:
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not key:
        print("ERROR: SUPABASE_SERVICE_ROLE_KEY not set in ingest/.env")
        sys.exit(1)
    return {"apikey": key, "Authorization": f"Bearer {key}"}


def _sb_url() -> str:
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    if not url:
        print("ERROR: SUPABASE_URL not set")
        sys.exit(1)
    return url


def _get(path: str, params: dict | None = None) -> list[dict]:
    base = _sb_url() + "/rest/v1/" + path.lstrip("/")
    headers = {**_sb_headers(), "Prefer": "count=none"}
    rows: list[dict] = []
    offset, limit = 0, 1000
    while True:
        p = dict(params or {})
        p.update({"limit": str(limit), "offset": str(offset)})
        resp = httpx.get(base, headers=headers, params=p, timeout=60)
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

def fetch_stations() -> list[dict]:
    return _get("stations", {
        "select": "id,name,lat,lng,ward_id",
        "lat": "not.is.null", "lng": "not.is.null",
    })


def fetch_readings(station_ids: list[int], from_date: str,
                   to_date: str) -> list[dict]:
    """Fetch (station_id, ts, pm25) for the date range."""
    print(f"  Fetching readings {from_date} → {to_date} …", end="", flush=True)
    rows = _get("readings", {
        "select": "station_id,ts,pm25",
        "station_id": f"in.({','.join(str(i) for i in station_ids)})",
        "ts": f"gte.{from_date}T00:00:00Z",
        "pm25": "not.is.null",
        "order": "ts.asc",
    })
    # Apply to_date filter client-side (PostgREST range queries can be slow)
    cutoff_ts = datetime.fromisoformat(to_date + "T23:59:59+00:00").timestamp()
    rows = [r for r in rows
            if datetime.fromisoformat(r["ts"].replace("Z", "+00:00")).timestamp()
            <= cutoff_ts]
    print(f" {len(rows):,} rows")
    return rows


# ── Open-Meteo archive ────────────────────────────────────────────────────────

def fetch_om_historical_wind(lat: float, lng: float,
                              start: str, end: str) -> list[tuple]:
    """Fetch hourly (ts_epoch, wind_dir, wind_speed_ms) from Open-Meteo archive.

    start/end: 'YYYY-MM-DD' strings.  Returns sorted list of tuples.
    Retries once on network error.
    """
    for attempt in range(2):
        try:
            r = httpx.get(OM_ARCHIVE, params={
                "latitude": round(lat, 4),
                "longitude": round(lng, 4),
                "start_date": start,
                "end_date": end,
                "hourly": "wind_speed_10m,wind_direction_10m",
                "wind_speed_unit": "ms",
                "timezone": "UTC",
            }, timeout=30)
            r.raise_for_status()
            data = r.json()["hourly"]
            result = []
            for t_str, spd, dir_ in zip(
                data["time"],
                data["wind_speed_10m"],
                data["wind_direction_10m"],
            ):
                if spd is None or dir_ is None:
                    continue
                ts_epoch = datetime.fromisoformat(t_str + "+00:00").timestamp()
                result.append((ts_epoch, float(dir_), float(spd)))
            return result
        except (httpx.HTTPError, KeyError) as e:
            if attempt == 0:
                time.sleep(2)
            else:
                print(f"    WARNING: Open-Meteo archive failed for {lat},{lng}: {e}")
                return []
    return []


def build_ward_weather_cache(
    ward_centroids: dict[int, tuple[float, float]],
    start: str, end: str,
    verbose: bool = True,
) -> dict[int, list[tuple]]:
    """Fetch Open-Meteo archive winds for every ward centroid.

    Returns {ward_id: [(ts_epoch, wind_dir, wind_speed_ms), ...]} sorted by ts.
    """
    cache: dict[int, list[tuple]] = {}
    if verbose:
        print(f"  Fetching ERA5 archive winds for {len(ward_centroids)} wards "
              f"({start} → {end}) …")
    for i, (wid, (lat, lng)) in enumerate(ward_centroids.items(), 1):
        rows = fetch_om_historical_wind(lat, lng, start, end)
        cache[wid] = rows
        if verbose and i % 10 == 0:
            print(f"    {i}/{len(ward_centroids)} wards done")
        time.sleep(0.05)  # be a polite API citizen
    if verbose:
        total = sum(len(v) for v in cache.values())
        print(f"  ERA5 weather loaded: {total:,} hourly entries across {len(cache)} wards")
    return cache


# ── Geometry ──────────────────────────────────────────────────────────────────

def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def build_station_zone_geometry(stations: list[dict],
                                zones: list[dict]) -> dict[int, list[tuple]]:
    """Pre-compute (dist_km, bearing_zone→station, emission_weight) per station."""
    geo: dict[int, list[tuple]] = {}
    for s in stations:
        sid = s["id"]
        lat, lng = float(s["lat"]), float(s["lng"])
        pairs = []
        for z in zones:
            zlat, zlng = z["lat"], z["lng"]
            dist = _haversine_km(lat, lng, zlat, zlng)
            phi1, phi2 = math.radians(zlat), math.radians(lat)
            dlam = math.radians(lng - zlng)
            x = math.sin(dlam) * math.cos(phi2)
            y = (math.cos(phi1) * math.sin(phi2)
                 - math.sin(phi1) * math.cos(phi2) * math.cos(dlam))
            bearing = (math.degrees(math.atan2(x, y)) + 360) % 360
            pairs.append((dist, bearing, float(z["emission_weight"])))
        geo[sid] = pairs
    return geo


def _find_nearest_weather(ts_epoch: float,
                          weather_list: list[tuple]) -> tuple | None:
    if not weather_list:
        return None
    times = [w[0] for w in weather_list]
    idx = bisect.bisect_left(times, ts_epoch)
    candidates = [weather_list[i] for i in (idx - 1, idx)
                  if 0 <= i < len(weather_list)]
    if not candidates:
        return None
    best = min(candidates, key=lambda w: abs(w[0] - ts_epoch))
    return best if abs(best[0] - ts_epoch) <= 3 * 3600 else None


# ── Wind score functions ──────────────────────────────────────────────────────

def _wind_score_new(geo_pairs: list[tuple], wind_dir: float,
                    wind_speed: float, sigma: float) -> float:
    """New kernel: uses imported _wind_factor (calm-wind blend included)."""
    scores = [
        ew * _wind_factor(bearing, wind_dir, wind_speed) * _distance_decay(dist, sigma)
        for dist, bearing, ew in geo_pairs
    ]
    return float(np.mean(scores)) if scores else 0.0


def _wind_factor_old(bearing: float, wind_from: float, speed: float) -> float:
    """Old kernel wind factor: purely directional, no calm-wind blending."""
    wind_toward = (wind_from + 180.0) % 360.0
    delta = abs(bearing - wind_toward)
    if delta > 180:
        delta = 360 - delta
    return max(0.0, math.cos(math.radians(delta))) * (1.0 + speed / 10.0)


def _wind_score_old(geo_pairs: list[tuple], wind_dir: float,
                    wind_speed: float, sigma: float = 7.0) -> float:
    """Old kernel: directional-only wind factor, fixed sigma=7."""
    scores = [
        ew * _wind_factor_old(bearing, wind_dir, wind_speed) * _distance_decay(dist, sigma)
        for dist, bearing, ew in geo_pairs
    ]
    return float(np.mean(scores)) if scores else 0.0


# ── Season helpers ────────────────────────────────────────────────────────────

def _month_of(ts_str: str) -> int:
    return datetime.fromisoformat(ts_str.replace("Z", "+00:00")).month


def _is_winter(ts_str: str) -> bool:
    return _month_of(ts_str) in _WINTER_MONTHS


def _wind_regime(speed: float) -> str:
    if speed <= CALM_BLEND_LO_MS:
        return "calm"
    if speed <= CALM_BLEND_HI_MS:
        return "blend"
    return "directional"


# ── Core: build paired dataset ────────────────────────────────────────────────

def build_pairs(
    readings: list[dict],
    stations: list[dict],
    ward_weather: dict[int, list[tuple]],
    season: str = "all",
) -> dict:
    """Join readings to ERA5 weather, compute local PM2.5 excess.

    Returns a dict with arrays ready for Spearman correlation.
    """
    sid_to_ward = {s["id"]: s["ward_id"] for s in stations if s.get("ward_id")}

    # Season filter on readings
    if season == "winter":
        readings = [r for r in readings if _is_winter(r["ts"])]
    elif season == "summer":
        readings = [r for r in readings if not _is_winter(r["ts"])]

    # Hourly city-wide PM2.5 median
    hour_buckets: dict[int, list[float]] = {}
    for r in readings:
        ts_epoch = datetime.fromisoformat(r["ts"].replace("Z", "+00:00")).timestamp()
        h = int((ts_epoch // 3600) * 3600)
        if r.get("pm25") is not None:
            hour_buckets.setdefault(h, []).append(float(r["pm25"]))
    hourly_city_median = {h: float(np.median(v)) for h, v in hour_buckets.items()}

    pairs_sid:    list[int]   = []
    pairs_wdir:   list[float] = []
    pairs_wspeed: list[float] = []
    pairs_excess: list[float] = []
    pairs_ts:     list[str]   = []
    skipped = {"no_ward": 0, "no_weather": 0, "no_city_med": 0}

    for r in readings:
        sid  = r["station_id"]
        pm25 = r.get("pm25")
        if pm25 is None:
            continue
        ts_str   = r["ts"]
        ts_epoch = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
        h        = int((ts_epoch // 3600) * 3600)
        city_med = hourly_city_median.get(h)
        if city_med is None:
            skipped["no_city_med"] += 1
            continue
        ward_id = sid_to_ward.get(sid)
        if ward_id is None:
            skipped["no_ward"] += 1
            continue
        wx = _find_nearest_weather(ts_epoch, ward_weather.get(ward_id, []))
        if wx is None:
            skipped["no_weather"] += 1
            continue
        _, wind_dir, wind_speed = wx
        pairs_sid.append(sid)
        pairs_wdir.append(wind_dir)
        pairs_wspeed.append(wind_speed)
        pairs_excess.append(float(pm25) - city_med)
        pairs_ts.append(ts_str)

    return {
        "sid":    pairs_sid,
        "wdir":   pairs_wdir,
        "wspeed": pairs_wspeed,
        "excess": pairs_excess,
        "ts":     pairs_ts,
        "skipped": skipped,
        "n": len(pairs_sid),
    }


# ── Spearman calibration ──────────────────────────────────────────────────────

def calibrate(pairs: dict, geo: dict[int, list[tuple]],
              sigma_candidates: list[float] | None = None,
              label: str = "") -> dict:
    """Run Spearman grid-search over sigma for the given pairs."""
    candidates = sigma_candidates or SIGMA_CANDIDATES
    n = pairs["n"]
    if n < 100:
        return {"n": n, "results": [], "optimal_sigma": None, "max_rho": None,
                "p_value": None, "significant": False}

    local_excesses = np.array(pairs["excess"])
    results = []
    for sigma in candidates:
        scores = np.array([
            _wind_score_new(geo[sid], wd, ws, sigma)
            for sid, wd, ws in zip(pairs["sid"], pairs["wdir"], pairs["wspeed"])
            if sid in geo
        ])
        if len(scores) != len(local_excesses):
            # Some sids may not be in geo (no coordinate) — filter both arrays
            valid = [i for i, sid in enumerate(pairs["sid"]) if sid in geo]
            scores = np.array([
                _wind_score_new(geo[sid], pairs["wdir"][i], pairs["wspeed"][i], sigma)
                for i, sid in enumerate(pairs["sid"]) if sid in geo
            ])
            ex = np.array([pairs["excess"][i] for i in valid])
        else:
            ex = local_excesses

        rho, pval = stats.spearmanr(scores, ex)
        results.append({
            "sigma": sigma,
            "rho": round(float(rho), 4),
            "p_value": round(float(pval), 6),
        })

    best = max(results, key=lambda r: abs(r["rho"]))
    return {
        "label": label,
        "n": n,
        "results": results,
        "optimal_sigma": best["sigma"],
        "max_rho": best["rho"],
        "p_value": best["p_value"],
        "significant": best["p_value"] < P_THRESHOLD,
    }


def print_calibration(result: dict, target_var: str) -> None:
    label = result.get("label", "")
    n = result["n"]
    if n < 100:
        print(f"  {label}: insufficient data (n={n})")
        return
    print(f"\n  {label} (n={n:,} pairs)")
    print(f"  {'Sigma':>8}  {'rho':>8}  {'p':>10}  {'Sig?':>5}")
    print("  " + "─" * 36)
    for r in result["results"]:
        marker = " ←" if r["sigma"] == result["optimal_sigma"] else ""
        sig = "yes" if r["p_value"] < P_THRESHOLD else "no"
        print(f"  {r['sigma']:>8.1f}  {r['rho']:>8.4f}  {r['p_value']:>10.6f}  {sig:>5}{marker}")
    current = SIGMA_WINTER_KM if "winter" in label.lower() else SIGMA_SUMMER_KM
    print(f"\n  Optimal: {result['optimal_sigma']} km  "
          f"(ρ={result['max_rho']:.4f}, p={result['p_value']:.6f})  "
          f"Sig: {'yes' if result['significant'] else 'NO'}")
    print(f"  Target: {target_var} (current={current} km)")


# ── Kernel comparison: old vs new ────────────────────────────────────────────

def compare_kernels(pairs: dict, geo: dict[int, list[tuple]],
                    sigma_new: float, sigma_old: float = 7.0) -> None:
    """Compare old kernel (directional-only) vs new kernel (calm-wind blend)
    on the same historical pairs, split by wind regime and season."""

    print(f"\n{'─'*64}")
    print("OLD KERNEL vs NEW KERNEL comparison")
    print(f"  Old: directional wind factor only, σ={sigma_old} km (single type)")
    print(f"  New: calm-wind isotropic blend, σ=industrial {SIGMA_SUMMER_KM}/{SIGMA_WINTER_KM} km "
          f"(summer/winter), road {SIGMA_ROAD_KM} km, fire {SIGMA_FIRE_KM} km")
    print(f"{'─'*64}")

    # Filter to sids with geometry
    valid_idx = [i for i, sid in enumerate(pairs["sid"]) if sid in geo]
    if not valid_idx:
        print("  No pairs with geometry available.")
        return

    sids   = [pairs["sid"][i]    for i in valid_idx]
    wdirs  = [pairs["wdir"][i]   for i in valid_idx]
    wspds  = [pairs["wspeed"][i] for i in valid_idx]
    excess = np.array([pairs["excess"][i] for i in valid_idx])
    ts_arr = [pairs["ts"][i]     for i in valid_idx]

    regimes = {"calm": [], "blend": [], "directional": []}
    seasons = {"winter": [], "summer": []}
    for i, (sid, wd, ws, ts) in enumerate(zip(sids, wdirs, wspds, ts_arr)):
        regimes[_wind_regime(ws)].append(i)
        seasons["winter" if _is_winter(ts) else "summer"].append(i)
    all_idx = list(range(len(sids)))

    def _rho_both(indices: list[int]) -> tuple[float | None, float | None]:
        if len(indices) < 30:
            return None, None
        ex_sub = excess[indices]
        s_old = np.array([_wind_score_old(geo[sids[i]], wdirs[i], wspds[i], sigma_old)
                          for i in indices])
        s_new = np.array([_wind_score_new(geo[sids[i]], wdirs[i], wspds[i],
                                          SIGMA_WINTER_KM if _is_winter(ts_arr[i]) else SIGMA_SUMMER_KM)
                          for i in indices])
        rho_o, _ = stats.spearmanr(s_old, ex_sub)
        rho_n, _ = stats.spearmanr(s_new, ex_sub)
        return round(float(rho_o), 4), round(float(rho_n), 4)

    print(f"\n  {'Subset':<22}  {'n':>7}  {'ρ old':>8}  {'ρ new':>8}  {'Δρ':>8}")
    print("  " + "─" * 58)
    rows = [
        ("All pairs",         all_idx),
        ("Calm ≤1 m/s",       regimes["calm"]),
        ("Blend 1–2 m/s",     regimes["blend"]),
        ("Directional >2 m/s",regimes["directional"]),
        ("Winter (Oct–Feb)",  seasons["winter"]),
        ("Summer (Mar–Sep)",  seasons["summer"]),
    ]
    for label, idx in rows:
        n = len(idx)
        if n < 30:
            print(f"  {label:<22}  {n:>7}  {'—':>8}  {'—':>8}  {'—':>8}  (n<30)")
            continue
        rho_o, rho_n = _rho_both(idx)
        if rho_o is None:
            continue
        delta = round(rho_n - rho_o, 4)
        arrow = "↑" if delta > 0.001 else ("↓" if delta < -0.001 else "≈")
        print(f"  {label:<22}  {n:>7}  {rho_o:>8.4f}  {rho_n:>8.4f}  {delta:>+8.4f} {arrow}")

    print()


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backtest VayuTrace kernel against historical Delhi data",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--from", dest="from_date", default="2022-10-01",
                        help="Start date YYYY-MM-DD (default: 2022-10-01)")
    parser.add_argument("--to", dest="to_date",
                        default=date.today().isoformat(),
                        help="End date YYYY-MM-DD (default: today)")
    parser.add_argument("--season", choices=["winter", "summer", "all"], default="all",
                        help="Calibrate for winter, summer, or all (default: all)")
    parser.add_argument("--compare", action="store_true",
                        help="Show old vs new kernel Spearman comparison")
    args = parser.parse_args()

    print("=" * 64)
    print("VayuTrace historical backtest")
    print(f"  Period: {args.from_date} → {args.to_date}")
    print(f"  Season: {args.season}")
    print("=" * 64)

    # 1. Load zones and stations
    zones    = zones_as_dicts()
    stations = fetch_stations()
    sid_to_ward = {s["id"]: s.get("ward_id") for s in stations if s.get("ward_id")}
    station_ids = [s["id"] for s in stations]
    print(f"\nLoaded {len(zones)} industrial zones, {len(stations)} stations")

    # 2. Fetch historical readings from DB
    print()
    readings = fetch_readings(station_ids, args.from_date, args.to_date)
    if not readings:
        print("No readings found for this date range.")
        sys.exit(0)

    # 3. Build ward centroid map (mean lat/lng of stations in each ward)
    ward_station_coords: dict[int, list[tuple]] = {}
    for s in stations:
        wid = s.get("ward_id")
        if wid and s.get("lat") and s.get("lng"):
            ward_station_coords.setdefault(wid, []).append(
                (float(s["lat"]), float(s["lng"]))
            )
    ward_centroids = {
        wid: (
            float(np.mean([c[0] for c in coords])),
            float(np.mean([c[1] for c in coords])),
        )
        for wid, coords in ward_station_coords.items()
    }

    # 4. Fetch ERA5 archive winds for each ward centroid
    print()
    ward_weather = build_ward_weather_cache(ward_centroids, args.from_date, args.to_date)

    # 5. Build geometry
    geo = build_station_zone_geometry(stations, zones)

    # 6. Build paired dataset
    print("\nJoining readings to ERA5 weather …")
    pairs_all = build_pairs(readings, stations, ward_weather, season="all")
    n_calm    = sum(1 for v in pairs_all["wspeed"] if v <= CALM_BLEND_LO_MS)
    n_blend   = sum(1 for v in pairs_all["wspeed"] if CALM_BLEND_LO_MS < v <= CALM_BLEND_HI_MS)
    n_dir     = pairs_all["n"] - n_calm - n_blend
    sk = pairs_all["skipped"]
    print(f"Valid pairs: {pairs_all['n']:,}  "
          f"(skipped {sk['no_weather']:,} no-weather, "
          f"{sk['no_ward']:,} no-ward, {sk['no_city_med']:,} no-city-med)")
    print(f"Wind regime: {n_calm:,} calm (≤1 m/s), "
          f"{n_blend:,} blend (1–2 m/s), {n_dir:,} directional (>2 m/s)")

    # 7. Calibration
    season_targets = (
        [args.season] if args.season != "all" else ["winter", "summer", "all"]
    )
    season_labels = {
        "winter": ("Winter (Oct–Feb)", "SIGMA_WINTER_KM"),
        "summer": ("Summer (Mar–Sep)", "SIGMA_SUMMER_KM"),
        "all":    ("All seasons",       "SIGMA_SUMMER_KM"),
    }

    print(f"\n{'─'*64}")
    print("INDUSTRIAL SIGMA CALIBRATION")
    print(f"{'─'*64}")

    for s in season_targets:
        label, tvar = season_labels[s]
        pairs_s = build_pairs(readings, stations, ward_weather, season=s)
        result  = calibrate(pairs_s, geo, label=label)
        print_calibration(result, tvar)

    # 8. Kernel comparison
    if args.compare:
        compare_kernels(pairs_all, geo, sigma_new=SIGMA_SUMMER_KM)

    print()


if __name__ == "__main__":
    main()
