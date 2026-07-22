"""Official data.gov.in CPCB real-time AQI client - the preferred source
for LATEST station readings (see docs/data/cpcb-data-gov-primary-latest-
integration-report.md). Does not touch OpenAQ, forecast.py, or historical
backfill - those keep running exactly as before. Server-side only.

Security: DATA_GOV_API_KEY is read from env and used only in the outgoing
request's query string - never logged, never returned from any function
here. Same defensive logging discipline as delhi_otd.py: httpx exceptions
are never logged with exc_info=True or str(exc), since both embed the full
request URL (key included) - only status codes / exception type names.
"""

from __future__ import annotations

import logging

import httpx

from . import config

RESOURCE_ID = "3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69"
BASE_URL = f"https://api.data.gov.in/resource/{RESOURCE_ID}"
UA = {"User-Agent": "vayugati-cpcb-latest/1.0"}
PAGE_SIZE = 100
# Delhi's real record count is ~300-400 (one row per station/pollutant
# pair) - this is a generous safety ceiling against a runaway loop, not a
# tuned expectation.
MAX_RECORDS = 2000

logger = logging.getLogger("ingest")

# CPCB pollutant_id -> our internal pollutant key (readings columns /
# aqi.py's compute_aqi params). NH3 has no home in our schema (openaq.py's
# own PARAMS never included it either) - kept in the map so it's parsed and
# visible in the raw record, just never contributes to a matched pollutant.
POLLUTANT_MAP: dict[str, str] = {
    "PM2.5": "pm25",
    "PM10": "pm10",
    "NO2": "no2",
    "SO2": "so2",
    "CO": "co",
    "OZONE": "o3",
    "O3": "o3",
    "NH3": "nh3",
}


def _parse_float(value: object) -> float | None:
    try:
        if value in (None, "", "NA"):
            return None
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def fetch_delhi_records() -> list[dict] | None:
    """Paginated fetch of every Delhi record this cycle. Returns None
    (never raises) on any failure - including a mid-pagination failure,
    which discards the partial page rather than reconciling against an
    incomplete fetch and calling it complete."""
    if not config.DATA_GOV_API_KEY:
        return None

    records: list[dict] = []
    offset = 0
    total: int | None = None
    while total is None or (offset < total and offset < MAX_RECORDS):
        try:
            resp = httpx.get(
                BASE_URL,
                params={
                    "api-key": config.DATA_GOV_API_KEY,
                    "format": "json",
                    "limit": PAGE_SIZE,
                    "offset": offset,
                    "filters[state]": "Delhi",
                },
                headers=UA,
                timeout=30,
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            logger.warning("data.gov.in CPCB fetch failed: HTTP %s", exc.response.status_code)
            return None
        except httpx.HTTPError as exc:
            logger.warning("data.gov.in CPCB fetch failed: %s", type(exc).__name__)
            return None

        payload = resp.json()
        page = payload.get("records", [])
        if not page:
            break
        records.extend(page)
        total = payload.get("total", len(records))
        offset += PAGE_SIZE

    return records


def group_by_station(records: list[dict]) -> dict[str, dict]:
    """Raw CPCB `station` name (not yet matched to our own stations) ->
    {station, last_update, lat, lng, pollutants: {our_key: {avg, min, max}}}.
    One CPCB record is one (station, pollutant) row; this groups them back
    into one entry per station, the shape latest_readings.py reconciles
    against our own per-station latest data."""
    grouped: dict[str, dict] = {}
    for r in records:
        name = r.get("station")
        if not name:
            continue
        entry = grouped.setdefault(
            name,
            {
                "station": name,
                "last_update": r.get("last_update"),
                "lat": _parse_float(r.get("latitude")),
                "lng": _parse_float(r.get("longitude")),
                "pollutants": {},
            },
        )
        pollutant_key = POLLUTANT_MAP.get((r.get("pollutant_id") or "").strip().upper())
        avg = _parse_float(r.get("avg_value"))
        if pollutant_key and avg is not None:
            entry["pollutants"][pollutant_key] = {
                "avg": avg,
                "min": _parse_float(r.get("min_value")),
                "max": _parse_float(r.get("max_value")),
            }
    return grouped
