"""Weather via api.met.no (Yr.no/MET Norway). Free, no API key, global coverage.

Docs: https://api.met.no/weatherapi/locationforecast/2.0/documentation
Terms: Creative Commons 4.0 BY — attribution required; User-Agent mandatory.
"""

import logging

import httpx

log = logging.getLogger("ingest")

_BASE = "https://api.met.no/weatherapi/locationforecast/2.0/compact"

# MET Norway requires a descriptive User-Agent; requests without one are blocked.
_HEADERS = {"User-Agent": "vayugati-ingest/1.0 (ward-level AQ platform; Delhi)"}


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


def get_current_batch(locations: list[tuple[float, float]]) -> list[dict]:
    """Current weather for multiple locations.

    api.met.no has no batch endpoint, so this makes one request per location.
    The service is fast, has no per-IP quota (only per-User-Agent), and 13
    sequential calls finish well within the ingest budget. Results are returned
    in the same order as `locations` to match the caller's zip() contract."""
    results = []
    for lat, lng in locations:
        series = _fetch_timeseries(lat, lng)
        results.append(_parse_series_entry(series[0]))
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
