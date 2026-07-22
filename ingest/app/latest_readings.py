"""Reconciles CPCB/data.gov's live latest-reading feed against our own
OpenAQ-sourced `readings` table, per station - CPCB preferred when matched
and fresh, OpenAQ fallback otherwise. Pure function given already-fetched
data (no I/O here) - unit-tested directly (test_latest_readings.py).

Never changes forecast.py's inputs or OpenAQ's historical backfill - this
only decides what LATEST value to show, nothing about training data.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from . import aqi
from .station_matching import match_station

# Same 180-minute staleness convention already shared by ops.ts's
# STATION_STALE_MINUTES and overviewRules.ts's HOTSPOT_READING_STALE_MINUTES
# on the frontend - "stale" means the same thing here as everywhere else.
STALE_MINUTES = 180

# A CPCB vs. OpenAQ AQI differing by more than this many points on the same
# station is flagged for a human to look at, not silently reconciled away.
# A round, documented threshold - not fit to any observed distribution.
VALUE_MISMATCH_AQI_THRESHOLD = 50

OPENAQ_POLLUTANT_KEYS = ("pm25", "pm10", "no2", "so2", "co", "o3")

# data.gov.in's real-time CPCB feed reports `last_update` as a naive
# "DD-MM-YYYY HH:MM:SS" string in IST, not ISO 8601 - confirmed live during
# this integration's own testing (every station showed the current IST wall
# clock, not UTC). Getting this wrong silently makes every CPCB reading look
# ~5.5h "stale" and permanently falls back to OpenAQ - caught by comparing
# real fetched numbers against expectations before trusting this module, not
# assumed correct from the API docs alone.
_IST = timezone(timedelta(hours=5, minutes=30))


def _age_minutes(ts: str | None, now: datetime) -> float | None:
    if not ts:
        return None
    parsed: datetime | None = None
    try:
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        try:
            parsed = datetime.strptime(ts, "%d-%m-%Y %H:%M:%S").replace(tzinfo=_IST)
        except ValueError:
            return None
    return (now - parsed).total_seconds() / 60


def reconcile_latest(
    our_stations: list[dict],
    cpcb_by_station: dict[str, dict],
    match_index: dict[str, int],
    our_latest_by_station: dict[int, dict],
    now: datetime | None = None,
) -> list[dict]:
    """`our_stations`: [{id, name, ward_id}, ...] (db.get_all_stations()).
    `cpcb_by_station`: data_gov_cpcb.group_by_station()'s return.
    `match_index`: station_matching.build_match_index(our_stations)'s return.
    `our_latest_by_station`: db.get_latest_readings_by_station()'s return.

    Returns one row per our-station - never fabricates a row for a CPCB
    station we don't track, and never silently drops one of our own
    stations even if CPCB has nothing for it (matched=False, source_used
    falls back to openaq)."""
    now = now or datetime.now(timezone.utc)

    # cpcb_by_station is keyed by CPCB's own raw name; re-key it by OUR
    # station id via the match index. If two CPCB names both resolve to the
    # same station id (not observed in this integration's own live test
    # run, but not structurally impossible), the later one in dict
    # iteration order wins - a known, documented limitation, not a crash.
    cpcb_by_our_station_id: dict[int, dict] = {}
    for cpcb_name, entry in cpcb_by_station.items():
        sid = match_station(cpcb_name, match_index)
        if sid is not None:
            cpcb_by_our_station_id[sid] = entry

    results = []
    for station in our_stations:
        sid = station["id"]
        cpcb_entry = cpcb_by_our_station_id.get(sid)
        openaq_entry = our_latest_by_station.get(sid)

        flags: list[str] = []
        matched = cpcb_entry is not None
        if not matched:
            flags.append("unmatched")

        cpcb_missing = cpcb_entry is None or not cpcb_entry.get("pollutants")
        if matched and cpcb_missing:
            flags.append("cpcb_missing")

        cpcb_age = _age_minutes(cpcb_entry.get("last_update"), now) if cpcb_entry else None
        cpcb_stale = cpcb_age is None or cpcb_age > STALE_MINUTES
        if matched and not cpcb_missing and cpcb_stale:
            flags.append("cpcb_stale")

        openaq_age = _age_minutes(openaq_entry.get("ts"), now) if openaq_entry else None
        openaq_stale = openaq_entry is None or openaq_age is None or openaq_age > STALE_MINUTES
        if openaq_stale:
            flags.append("openaq_stale")

        cpcb_usable = matched and not cpcb_missing and not cpcb_stale
        source_used = "cpcb" if cpcb_usable else "openaq_fallback"
        if not cpcb_usable:
            flags.append("fallback_used")

        cpcb_aqi = None
        if cpcb_usable:
            pollutants = cpcb_entry["pollutants"]
            cpcb_aqi = aqi.compute_aqi(
                pollutants.get("pm25", {}).get("avg"),
                pollutants.get("pm10", {}).get("avg"),
            )

        openaq_aqi = openaq_entry.get("aqi") if openaq_entry else None

        if cpcb_aqi is not None and openaq_aqi is not None and abs(cpcb_aqi - openaq_aqi) > VALUE_MISMATCH_AQI_THRESHOLD:
            flags.append("value_mismatch")

        results.append(
            {
                "station_id": sid,
                "station_name": station["name"],
                "ward_id": station.get("ward_id"),
                "matched": matched,
                "cpcb_station_name": cpcb_entry["station"] if cpcb_entry else None,
                "cpcb_last_update": cpcb_entry.get("last_update") if cpcb_entry else None,
                "openaq_last_update": openaq_entry.get("ts") if openaq_entry else None,
                "cpcb_pollutants": cpcb_entry.get("pollutants") if cpcb_entry else {},
                "openaq_pollutants": (
                    {k: openaq_entry.get(k) for k in OPENAQ_POLLUTANT_KEYS if openaq_entry.get(k) is not None}
                    if openaq_entry
                    else {}
                ),
                "cpcb_aqi": cpcb_aqi,
                "openaq_aqi": openaq_aqi,
                "source_used": source_used,
                "flags": flags,
            }
        )
    return results
