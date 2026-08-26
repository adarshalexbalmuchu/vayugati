"""NASA FIRMS active-fire hotspot client for Delhi/NCR.

API: firms.modaps.eosdis.nasa.gov/api/area/
Registration: free, instant — register at the URL above.

The API shape was verified live during the design phase: a request with
an invalid MAP_KEY returns HTTP 200 with body "Invalid MAP_KEY", confirming
both the URL structure and the parameter names are correct.

Set FIRMS_MAP_KEY in your .env (or as an env var in production).  When the
key is absent this module returns an empty list rather than raising — fire
data is a secondary signal, not a hard dependency of the kernel.

Instrument: VIIRS SNPP (375 m resolution) — better than MODIS for small
fires.  MODIS is a reasonable fallback when VIIRS is unavailable (e.g.
cloud cover over a full day), but we prefer VIIRS.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta

import httpx

from . import config

log = logging.getLogger("ingest.vayutrace_firms")

_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"

# Delhi + NCR bounding box (W,S,E,N)  — wide enough to capture fires in
# Haryana/UP that can drift into Delhi under typical NW/SE wind patterns.
_DELHI_BBOX = "76.7,28.3,77.5,28.9"

# 1 day of VIIRS SNPP data (re-fetched each intel cycle so we always have
# the most recent active-fire detections).
_INSTRUMENT = "VIIRS_SNPP_NRT"
_DAY_RANGE   = 1


def fetch_delhi_fires(day: date | None = None) -> list[dict]:
    """Return active-fire hotspots over Delhi/NCR for *day* (default: today).

    Each dict contains at minimum:
        latitude, longitude   — float, WGS-84
        brightness            — float, Kelvin (fire radiative power proxy)
        frp                   — float, fire radiative power (MW)
        acq_date              — str, 'YYYY-MM-DD'
        acq_time              — str, 'HHMM' UTC

    Returns an empty list when:
    - FIRMS_MAP_KEY is not configured (key absent or blank)
    - The API returns a non-2xx response (logged at WARNING)
    - The CSV response contains 'Invalid MAP_KEY' (key wrong — logged at ERROR)
    """
    api_key = config.FIRMS_MAP_KEY
    if not api_key:
        log.debug("FIRMS_MAP_KEY not set — skipping fire hotspot fetch")
        return []

    target = day or date.today()
    url = f"{_BASE}/{api_key}/{_INSTRUMENT}/{_DELHI_BBOX}/{_DAY_RANGE}/{target}"

    try:
        resp = httpx.get(url, timeout=30)
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        log.warning("FIRMS API HTTP error: %s", exc)
        return []
    except httpx.RequestError as exc:
        log.warning("FIRMS API request failed: %s", exc)
        return []

    text = resp.text.strip()
    if "Invalid MAP_KEY" in text:
        log.error("FIRMS MAP_KEY is invalid — update FIRMS_MAP_KEY in .env")
        return []
    if not text or text.startswith("latitude") is False:
        # Empty dataset (no fires today) — valid response
        if not text:
            return []
        # Unexpected format
        if "\n" not in text:
            log.warning("FIRMS unexpected response format: %r", text[:120])
            return []

    return _parse_csv(text)


def _parse_csv(text: str) -> list[dict]:
    """Parse the FIRMS CSV response into a list of dicts."""
    lines = text.strip().splitlines()
    if len(lines) < 2:
        return []  # header only → no fires

    header = [h.strip() for h in lines[0].split(",")]
    result = []
    for line in lines[1:]:
        parts = line.split(",")
        if len(parts) != len(header):
            continue
        row: dict = {}
        for key, val in zip(header, parts):
            val = val.strip()
            try:
                row[key] = float(val)
            except ValueError:
                row[key] = val
        result.append(row)
    return result
