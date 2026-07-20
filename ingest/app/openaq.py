"""OpenAQ v3 client. Docs: https://docs.openaq.org"""

import httpx

from . import config

BASE = "https://api.openaq.org/v3"

# OpenAQ parameter name -> readings column
PARAMS = {"pm25": "pm25", "pm10": "pm10", "no2": "no2", "so2": "so2", "co": "co", "o3": "o3"}


def _get(path: str) -> dict:
    resp = httpx.get(
        f"{BASE}{path}",
        headers={"X-API-Key": config.OPENAQ_API_KEY},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def get_location(location_id: int) -> dict:
    """Location metadata: name, coordinates, and its sensors (sensor id -> parameter)."""
    loc = _get(f"/locations/{location_id}")["results"][0]
    return {
        "name": loc["name"],
        "lat": loc["coordinates"]["latitude"],
        "lng": loc["coordinates"]["longitude"],
        "sensors": {s["id"]: s["parameter"]["name"] for s in loc.get("sensors", [])},
    }


def get_latest(location_id: int) -> list[dict]:
    """Latest value per sensor: [{sensor_id, value, ts_utc}, ...]."""
    results = _get(f"/locations/{location_id}/latest")["results"]
    return [
        {
            "sensor_id": r["sensorsId"],
            "value": r["value"],
            "ts_utc": r["datetime"]["utc"],
        }
        for r in results
    ]


def get_sensor_hours(
    sensor_id: int, date_from: str, date_to: str, page_limit: int = 1000
) -> list[dict]:
    """Historical HOURLY-aggregated measurements for one sensor between
    date_from and date_to (ISO 8601 UTC strings). Returns
    [{value, ts_utc}, ...] where ts_utc is the START of each aggregated hour
    (period.datetimeFrom.utc) — the same hour-flooring convention the live
    ingest already uses.

    This is the historical counterpart to `get_latest`: the live feed only
    ever exposes the newest reading per sensor, so training-length history
    (needed before forecast.py will train a real LightGBM model rather than
    fall back to diurnal-persistence) has to come from this endpoint. It is
    the same real CPCB/DPCC-via-OpenAQ data, just backfilled instead of
    waiting for it to trickle in hourly. Paginated — OpenAQ caps a page at
    1000 results, so a multi-week window is walked page by page."""
    out: list[dict] = []
    page = 1
    while True:
        data = _get(
            f"/sensors/{sensor_id}/hours"
            f"?datetime_from={date_from}&datetime_to={date_to}"
            f"&limit={page_limit}&page={page}"
        )
        results = data.get("results", []) or []
        for r in results:
            val = r.get("value")
            period = r.get("period") or {}
            dt = (period.get("datetimeFrom") or {}).get("utc")
            if val is None or dt is None:
                continue
            out.append({"value": val, "ts_utc": dt})
        # a short final page (or empty) means we've reached the end of the range
        if len(results) < page_limit:
            break
        page += 1
        if page > 500:  # safety valve — 500k rows is far past any real window
            break
    return out
