"""NASA FIRMS active-fire hotspot client for Delhi's full IGP airshed.

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

-- Two fetch areas --

LOCAL (Delhi + NCR, ≤ 50 km):
    Small bounding box around Delhi. Fires here are modelled with a
    Gaussian decay (σ_fire = 20 km) in the kernel — they're close enough
    for distance-based spatial attribution.

REGIONAL (IGP airshed, 50–500 km):
    The full Indo-Gangetic Plain airshed that feeds Delhi's worst pollution
    episodes. Covers Punjab, Haryana, Rajasthan, and western UP — the
    principal sources of agricultural stubble burning.

    Punjab paddy residue: Oct 15 – Nov 15, peak ~20-25 M kg/day.
    Key source districts: Amritsar (~430 km NW), Ludhiana (~300 km NW),
    Patiala (~270 km NW), Ambala/Haryana (~200 km N).

    Fires here CANNOT be modelled with a Gaussian: at 300 km,
    exp(-300²/(2×20²)) ≈ 10⁻⁵⁰ — effectively zero. Instead, the kernel
    uses a travel-time transport model: FRP × wind_alignment × exp(-t/τ),
    where t = distance / wind_speed and τ = 24 h (aerosol aging constant).
    This is physically grounded in HYSPLIT back-trajectory literature and
    SAFAR/IITM regional transport analyses for the Delhi airshed.

    The IGP "funnel": Delhi is flanked by the Aravalli range (W/SW) and
    Siwalik hills (N). NW winds during stable inversions channel Punjab/
    Haryana smoke directly into the city through the open corridor between
    these barriers — captured by the wind-alignment factor in the kernel.
"""

from __future__ import annotations

import logging
from datetime import date

import httpx

from . import config

log = logging.getLogger("ingest.vayutrace_firms")

_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"

# Delhi + NCR bounding box (W,S,E,N) — local fires within ~50 km.
_DELHI_BBOX = "76.7,28.3,77.5,28.9"

# Full IGP airshed bounding box: Punjab (Amritsar 74.9°E, 31.6°N) through
# western UP (80°E), north to Siwalik foothills (32°N), south to Rajasthan
# desert transition (27°N). Captures all agricultural burning that the
# literature identifies as contributing to Delhi's winter PM2.5.
# References: IITK 2016 DPCC study; SAFAR/IITM fire-episode analyses;
# IMD Delhi airshed climatology.
_IGP_BBOX = "73.0,27.0,81.0,32.5"

_INSTRUMENT = "VIIRS_SNPP_NRT"
_DAY_RANGE   = 1

# Fires beyond this distance from Delhi centroid are classified "regional"
# and handled by the travel-time transport model, not Gaussian decay.
REGIONAL_FIRE_THRESHOLD_KM: float = 50.0

# Delhi centroid (used to classify local vs regional fires by distance)
_DELHI_LAT: float = 28.65
_DELHI_LNG: float = 77.22


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


def fetch_igp_fires(day: date | None = None) -> list[dict]:
    """Return active-fire hotspots across the full IGP airshed for *day*.

    Covers Punjab, Haryana, Rajasthan, and western UP — the sources of
    agricultural stubble burning that drive Delhi's worst winter PM2.5
    episodes (Oct–Nov paddy residue; Apr–May wheat residue).

    Each returned dict is the same shape as fetch_delhi_fires(), with one
    additional field:
        distance_km  — float, great-circle distance from Delhi centroid
        fire_class   — str, 'local' (< 50 km) or 'regional' (≥ 50 km)

    The kernel uses fire_class to route each fire to the right model:
        local    → Gaussian decay (σ_fire = 20 km), added to fire_sources
        regional → travel-time transport index, surfaced as regional_fire_index
    """
    import math

    api_key = config.FIRMS_MAP_KEY
    if not api_key:
        log.debug("FIRMS_MAP_KEY not set — skipping IGP fire fetch")
        return []

    target = day or date.today()
    url = f"{_BASE}/{api_key}/{_INSTRUMENT}/{_IGP_BBOX}/{_DAY_RANGE}/{target}"

    try:
        resp = httpx.get(url, timeout=60)
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        log.warning("FIRMS IGP API HTTP error: %s", exc)
        return []
    except httpx.RequestError as exc:
        log.warning("FIRMS IGP API request failed: %s", exc)
        return []

    text = resp.text.strip()
    if "Invalid MAP_KEY" in text:
        log.error("FIRMS MAP_KEY is invalid")
        return []
    if not text:
        return []

    fires = _parse_csv(text)

    # Tag each fire with distance from Delhi centroid and local/regional class
    R = 6371.0
    dlat, dlng = math.radians(_DELHI_LAT), math.radians(_DELHI_LNG)

    for f in fires:
        flat = float(f.get("latitude", 0))
        flng = float(f.get("longitude", 0))
        phi1, phi2 = math.radians(flat), dlat
        dphi = dlat - phi2
        dlam = dlng - math.radians(flng)
        a = math.sin((phi2 - phi1) / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
        dist = R * 2 * math.asin(math.sqrt(a))
        f["distance_km"] = round(dist, 1)
        f["fire_class"]  = "local" if dist < REGIONAL_FIRE_THRESHOLD_KM else "regional"
        f["lat"]         = flat
        f["lng"]         = flng

    log.info(
        "FIRMS IGP: %d fires total (%d local, %d regional)",
        len(fires),
        sum(1 for f in fires if f["fire_class"] == "local"),
        sum(1 for f in fires if f["fire_class"] == "regional"),
    )
    return fires


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
