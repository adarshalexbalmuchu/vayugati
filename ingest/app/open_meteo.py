"""Weather from two sources:

  1. MET Norway (api.met.no) — current + 90h hourly forecast.
     Variables: temp, humidity, wind_speed, wind_dir, precipitation, pressure.
     Docs: https://api.met.no/weatherapi/locationforecast/2.0/documentation
     Terms: Creative Commons 4.0 BY; User-Agent mandatory.

  2. Open-Meteo (api.open-meteo.com) — boundary layer height (PBLH).
     Published literature ranks PBLH as the #1–5 meteorological predictor
     of surface PM2.5 in Delhi/IGP:
       • AMT 2019 (lidar): winter PBLH collapses to 200–400 m, trapping emissions.
       • JGR Atmospheres 2021: PM2.5 ∝ PBLH^(−0.8 to −1.2).
       • Multiple ML studies (2022–2025): PBLH in top-5 SHAP feature importance.
     Open-Meteo is free, no API key, returns WRF/ECMWF boundary_layer_height.
     Docs: https://open-meteo.com/en/docs
"""

import logging

import httpx

log = logging.getLogger("ingest")

# ── MET Norway ────────────────────────────────────────────────────────────────

_BASE = "https://api.met.no/weatherapi/locationforecast/2.0/compact"

# MET Norway requires a descriptive User-Agent; requests without one are blocked.
_HEADERS = {"User-Agent": "vayugati-ingest/1.0 (ward-level AQ platform; Delhi)"}

# ── Open-Meteo (PBLH) ────────────────────────────────────────────────────────

_OM_FORECAST_BASE = "https://api.open-meteo.com/v1/forecast"


def _parse_series_entry(entry: dict) -> dict:
    """Extract current-conditions dict from one timeseries entry."""
    instant = entry["data"]["instant"]["details"]
    # precipitation lives in next_1_hours when available, else 0
    next1 = entry["data"].get("next_1_hours") or {}
    precip = (next1.get("details") or {}).get("precipitation_amount", 0.0)
    return {
        "ts_utc": entry["time"],          # already "2026-07-31T10:00:00Z"
        "temp_c": instant["air_temperature"],
        "humidity": instant["relative_humidity"],
        "wind_speed": instant["wind_speed"],
        "wind_dir": instant["wind_from_direction"],
        "precipitation": precip,
        "pressure": instant.get("air_pressure_at_sea_level"),
    }


def _fetch_timeseries(lat: float, lng: float) -> list[dict]:
    """Raw timeseries for one location (raises on HTTP error)."""
    resp = httpx.get(
        _BASE,
        params={"lat": round(lat, 4), "lon": round(lng, 4)},
        headers=_HEADERS,
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["properties"]["timeseries"]


def get_current(lat: float, lng: float) -> dict:
    """Current weather at a single point."""
    series = _fetch_timeseries(lat, lng)
    return _parse_series_entry(series[0])


def get_current_batch(locations: list[tuple[float, float]]) -> list[dict | None]:
    """Current weather for multiple locations.

    api.met.no has no batch endpoint, so this makes one request per location
    — a real sequential loop of individual HTTP calls, not a true batch
    (the name is legacy from when this only ever covered 13 wards; kept for
    now to avoid a wider rename across every caller).

    Bug fix (Sept 2026): a single failed/rate-limited call used to raise
    and abort the ENTIRE loop — since _fetch_timeseries() calls
    resp.raise_for_status() with no try/except here, one bad request meant
    every location queued after it in the same call silently got NO
    weather data, not just the one that failed. This mattered far more
    once this function's caller (ingest.py) was extended from 13 to up to
    265 locations per cycle (Sept 2026) — a failure partway through a
    13-item loop lost little; the same failure partway through a 265-item
    loop could lose the vast majority of a cycle's weather data with no
    indication beyond one logged exception for the one location that
    actually failed.

    Each location's failure is now isolated: returns None in that
    location's slot (same order as `locations`, unchanged contract) rather
    than raising, so 264 good results aren't discarded because of 1 bad
    one. Callers must handle None entries (ingest.py does, via the
    `if w is None: continue` guard added alongside this fix)."""
    results: list[dict | None] = []
    for i, (lat, lng) in enumerate(locations):
        try:
            series = _fetch_timeseries(lat, lng)
            results.append(_parse_series_entry(series[0]))
        except Exception:
            log.warning(
                "get_current_batch: location %d/%d (%.4f, %.4f) failed — "
                "continuing with the rest of the batch",
                i + 1, len(locations), lat, lng, exc_info=True,
            )
            results.append(None)
        if (i + 1) % 25 == 0 or (i + 1) == len(locations):
            log.info("get_current_batch: %d/%d locations done", i + 1, len(locations))
    return results


def get_hourly_forecast(lat: float, lng: float, hours: int = 48) -> list[dict]:
    """Hourly weather forecast for the next `hours` hours.

    Returns [{ts_utc, temp_c, humidity, wind_speed, wind_dir, precipitation}, ...]
    in ascending time order. Met.no returns up to ~90 hours of hourly data on
    the compact endpoint; we truncate to `hours`."""
    series = _fetch_timeseries(lat, lng)
    out = []
    for entry in series[:hours]:
        parsed = _parse_series_entry(entry)
        # Forecast callers don't use pressure — omit so the shape matches
        # the old Open-Meteo contract exactly.
        out.append({k: v for k, v in parsed.items() if k != "pressure"})
    return out


# ── Open-Meteo: PBLH ─────────────────────────────────────────────────────────


def get_current_pblh(lat: float, lng: float) -> float | None:
    """Planetary Boundary Layer Height (metres) for the current hour.

    Uses Open-Meteo's free API (api.open-meteo.com), which returns ECMWF/WRF
    boundary_layer_height.  Returns None on any error so the caller can
    degrade gracefully — PBLH is a feature improvement, not a hard requirement.

    Literature basis:
      • AMT 2019 (doi:10.5194/amt-12-2595-2019): lidar PBLH measurements over
        New Delhi; winter PBLH 200–400 m, summer 1500–2000 m.
      • JGR Atmospheres 2021 (doi:10.1029/2021JD035681): PM2.5 ∝ PBLH^(−1.0)
        during Delhi winter inversion episodes.
    """
    try:
        resp = httpx.get(
            _OM_FORECAST_BASE,
            params={
                "latitude": round(lat, 4),
                "longitude": round(lng, 4),
                "hourly": "boundary_layer_height",
                "forecast_days": 1,
                "timezone": "UTC",
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        hourly = data.get("hourly") or {}
        values = hourly.get("boundary_layer_height") or []
        # Return the first non-None value (current hour)
        for v in values:
            if v is not None:
                return float(v)
        return None
    except Exception:
        log.debug("Open-Meteo PBLH fetch failed for (%.4f, %.4f)", lat, lng, exc_info=True)
        return None


def get_hourly_pblh_forecast(lat: float, lng: float, hours: int = 48) -> list[float | None]:
    """Hourly PBLH forecast for the next `hours` hours from Open-Meteo.

    Returns a list of floats (metres), one per hour starting from the current
    hour. Any missing values are None. Used in recursive PM2.5 forecasting
    to provide future PBLH as a feature input (rather than persisting last known).

    Ventilation coefficient (VC = PBLH × wind_speed) is computed by the caller
    (forecast.py) so both components remain visible and separately useful.
    """
    try:
        resp = httpx.get(
            _OM_FORECAST_BASE,
            params={
                "latitude": round(lat, 4),
                "longitude": round(lng, 4),
                "hourly": "boundary_layer_height",
                "forecast_days": min(7, max(1, (hours + 23) // 24)),
                "timezone": "UTC",
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        values = (data.get("hourly") or {}).get("boundary_layer_height") or []
        result = [float(v) if v is not None else None for v in values[:hours]]
        # Pad with None if the response was shorter than requested
        result += [None] * (hours - len(result))
        return result
    except Exception:
        log.debug("Open-Meteo hourly PBLH fetch failed for (%.4f, %.4f)", lat, lng, exc_info=True)
        return [None] * hours


# ── Open-Meteo archive (ERA5 reanalysis) ─────────────────────────────────────
#
# Historical weather for any coordinate and any past date, free and keyless,
# same provider as the PBLH forecast above.
#
# Added Sept 2026 to backfill the weather history the VayuTrace validation
# harness needs. Per-ward weather was only extended from the original 13
# "hotspot" wards to all 265 in Sept 2026, so validation could only cover
# ~12 wards (~4.5% of those the kernel scores) — the binding constraint was
# weather HISTORY, not readings (all 44 stations report ~950 pm25 rows per
# 60 days). Backfilling from ERA5 lifts validation coverage to every
# station-bearing ward without waiting months for live ingestion to
# accumulate.
#
# IMPORTANT — this is REANALYSIS, not observation. ERA5 is a model
# reconstruction on a ~9-31 km grid, so a backfilled row is NOT the same
# kind of data as a live MET Norway reading, and is coarser than Delhi's
# ward scale. Rows written from here must be marked so they are never
# silently mixed with live rows (see scripts/backfill_weather_history.py).
#
# Docs: https://open-meteo.com/en/docs/historical-weather-api
_OM_ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive"


def get_historical_hourly(
    lat: float,
    lng: float,
    start_date: str,
    end_date: str,
) -> list[dict]:
    """Hourly ERA5 reanalysis weather for one location over a date range.

    `start_date`/`end_date` are 'YYYY-MM-DD' (inclusive, UTC).

    Returns [{ts_utc, temp_c, humidity, wind_speed, wind_dir, precipitation,
    boundary_layer_height}, ...], one entry per hour, or [] on any failure —
    never raises, matching the rest of this module's fail-soft contract.

    wind_speed is requested explicitly in m/s (`wind_speed_unit=ms`); the
    archive API defaults to km/h, which would silently inflate every
    ventilation coefficient by 3.6x if taken as-is.
    """
    try:
        resp = httpx.get(
            _OM_ARCHIVE_BASE,
            params={
                "latitude": round(lat, 4),
                "longitude": round(lng, 4),
                "start_date": start_date,
                "end_date": end_date,
                "hourly": (
                    "boundary_layer_height,wind_speed_10m,wind_direction_10m,"
                    "temperature_2m,relative_humidity_2m,precipitation"
                ),
                "wind_speed_unit": "ms",   # see docstring — default is km/h
                "timezone": "UTC",
            },
            timeout=60,
        )
        resp.raise_for_status()
        hourly = (resp.json() or {}).get("hourly") or {}
        times = hourly.get("time") or []

        def _col(name: str) -> list:
            return hourly.get(name) or [None] * len(times)

        pblh = _col("boundary_layer_height")
        ws   = _col("wind_speed_10m")
        wd   = _col("wind_direction_10m")
        temp = _col("temperature_2m")
        rh   = _col("relative_humidity_2m")
        prcp = _col("precipitation")

        out: list[dict] = []
        for i, t in enumerate(times):
            out.append({
                # Archive returns naive UTC ("2026-08-01T00:00"); normalise to
                # the same "...Z" shape _parse_series_entry emits so downstream
                # timestamp handling is identical for live and backfilled rows.
                "ts_utc": f"{t}:00Z" if len(t) == 16 else t,
                "temp_c": temp[i],
                "humidity": rh[i],
                "wind_speed": ws[i],
                "wind_dir": wd[i],
                "precipitation": prcp[i],
                "boundary_layer_height": pblh[i],
            })
        return out
    except Exception:
        log.debug(
            "Open-Meteo archive fetch failed for (%.4f, %.4f) %s..%s",
            lat, lng, start_date, end_date, exc_info=True,
        )
        return []
