"""Open-Meteo current + hourly-forecast weather. Free, no key. Docs: https://open-meteo.com/en/docs"""

import httpx

BASE = "https://api.open-meteo.com/v1/forecast"

CURRENT_VARS = (
    "temperature_2m,relative_humidity_2m,precipitation,"
    "surface_pressure,wind_speed_10m,wind_direction_10m"
)

HOURLY_VARS = (
    "temperature_2m,relative_humidity_2m,precipitation,"
    "wind_speed_10m,wind_direction_10m"
)


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
    resp = httpx.get(
        BASE,
        params={"latitude": lat, "longitude": lng, "current": CURRENT_VARS, "timezone": "UTC"},
        timeout=30,
    )
    resp.raise_for_status()
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
    resp = httpx.get(
        BASE,
        params={"latitude": lats, "longitude": lngs, "current": CURRENT_VARS, "timezone": "UTC"},
        timeout=30,
    )
    resp.raise_for_status()
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
    resp = httpx.get(
        BASE,
        params={
            "latitude": lat,
            "longitude": lng,
            "hourly": HOURLY_VARS,
            "forecast_hours": hours,
            "timezone": "UTC",
        },
        timeout=30,
    )
    resp.raise_for_status()
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
