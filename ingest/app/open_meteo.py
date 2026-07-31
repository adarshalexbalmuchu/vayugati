"""Open-Meteo current + hourly-forecast weather. Free, no key. Docs: https://open-meteo.com/en/docs"""

import time
import logging

import httpx

from . import config

log = logging.getLogger("ingest")

_FREE_BASE = "https://api.open-meteo.com/v1/forecast"
_COMMERCIAL_BASE = "https://customer-api.open-meteo.com/v1/forecast"

# Kept for callers that import BASE directly (none currently, but exported for safety).
BASE = _FREE_BASE

CURRENT_VARS = (
    "temperature_2m,relative_humidity_2m,precipitation,"
    "surface_pressure,wind_speed_10m,wind_direction_10m"
)

HOURLY_VARS = (
    "temperature_2m,relative_humidity_2m,precipitation,"
    "wind_speed_10m,wind_direction_10m"
)

# Sent on every request so Open-Meteo can distinguish our traffic from generic
# scraper traffic. Required for the commercial endpoint; courteous for free.
_HEADERS = {"User-Agent": "vayugati-ingest/1.0 (air quality platform; Delhi)"}


def _base_url() -> str:
    return _COMMERCIAL_BASE if config.OPEN_METEO_API_KEY else _FREE_BASE


def _inject_key(params: dict) -> dict:
    """Add apikey to params dict when a key is configured."""
    if config.OPEN_METEO_API_KEY:
        params = {**params, "apikey": config.OPEN_METEO_API_KEY}
    return params


def _get_with_retry(params: dict, timeout: int = 30) -> httpx.Response:
    """GET _base_url() with exponential back-off on 429.

    Retries up to 3 times (1 s, 2 s, 4 s delays) before re-raising.
    The commercial endpoint has much higher limits so 429s there are very
    unlikely; this guard mainly protects the free endpoint on shared IPs."""
    url = _base_url()
    params = _inject_key(params)
    last_exc: Exception | None = None
    for attempt in range(4):  # 0, 1, 2, 3
        try:
            resp = httpx.get(url, params=params, headers=_HEADERS, timeout=timeout)
            if resp.status_code == 429 and attempt < 3:
                delay = 2 ** attempt  # 1 s, 2 s, 4 s
                log.warning(
                    "Open-Meteo 429 (attempt %d/4) — retrying in %ds", attempt + 1, delay
                )
                time.sleep(delay)
                continue
            resp.raise_for_status()
            return resp
        except httpx.HTTPStatusError as exc:
            last_exc = exc
            if exc.response.status_code == 429 and attempt < 3:
                delay = 2 ** attempt
                log.warning(
                    "Open-Meteo 429 (attempt %d/4) — retrying in %ds", attempt + 1, delay
                )
                time.sleep(delay)
            else:
                raise
    raise last_exc  # type: ignore[misc]


def _parse_current(item: dict) -> dict:
    cur = item["current"]
    return {
        "ts_utc": cur["time"] + ":00Z",  # Open-Meteo returns e.g. "2026-07-14T07:15"
        "temp_c": cur["temperature_2m"],
        "humidity": cur["relative_humidity_2m"],
        "wind_speed": cur["wind_speed_10m"],
        "wind_dir": cur["wind_direction_10m"],
        "precipitation": cur["precipitation"],
        "pressure": cur["surface_pressure"],
    }


def get_current(lat: float, lng: float) -> dict:
    """Current weather at a single point."""
    resp = _get_with_retry(
        {"latitude": lat, "longitude": lng, "current": CURRENT_VARS, "timezone": "UTC"}
    )
    return _parse_current(resp.json())


def get_current_batch(locations: list[tuple[float, float]]) -> list[dict]:
    """Current weather for multiple locations in one request — eliminates the
    per-ward sequential loop that produced 429s on Render's shared egress IP.

    Open-Meteo accepts comma-separated latitude/longitude arrays and returns a
    JSON array in the same order. One network round-trip replaces N sequential
    ones regardless of how many wards are configured. The single location case
    (returns a plain dict, not a list) is normalised to a one-element list so
    callers never need to branch on response shape.

    locations: [(lat, lng), ...] — must be non-empty (validated by caller).
    Returns weather dicts in the same order as `locations`."""
    lats = ",".join(str(lat) for lat, _ in locations)
    lngs = ",".join(str(lng) for _, lng in locations)
    resp = _get_with_retry(
        {"latitude": lats, "longitude": lngs, "current": CURRENT_VARS, "timezone": "UTC"}
    )
    data = resp.json()
    # Single-location responses are a plain dict; multi-location are a list.
    if isinstance(data, dict):
        data = [data]
    return [_parse_current(item) for item in data]


def get_hourly_forecast(lat: float, lng: float, hours: int = 48) -> list[dict]:
    """Real, genuinely-forecasted (not persisted) hourly weather for the next
    `hours` hours — the "weather forecast" input plan §3 asks for, distinct
    from `get_current`'s single now-reading. Open-Meteo's free tier already
    provides up to 16 days of hourly forecast; we only ask for what the
    pollutant forecast horizon actually needs.

    Returns [{ts_utc, temp_c, humidity, wind_speed, wind_dir, precipitation}, ...].
    """
    resp = _get_with_retry(
        {
            "latitude": lat,
            "longitude": lng,
            "hourly": HOURLY_VARS,
            "forecast_hours": hours,
            "timezone": "UTC",
        }
    )
    h = resp.json()["hourly"]
    out = []
    for i, t in enumerate(h["time"]):
        out.append(
            {
                "ts_utc": t + ":00Z",
                "temp_c": h["temperature_2m"][i],
                "humidity": h["relative_humidity_2m"][i],
                "wind_speed": h["wind_speed_10m"][i],
                "wind_dir": h["wind_direction_10m"][i],
                "precipitation": h["precipitation"][i],
            }
        )
    return out
