"""Real hourly concentrations -> readings_hourly (see migration 20260927010000).

CPCB/data.gov.in publishes only AQI-window averages (24h; 8h CO/O3), so the
platform's hourly values come from OpenAQ's hourly archive for the same
stations: /sensors/{id}/hours gives each clock hour's MEAN, keyed by the
hour's start. (OpenAQ's /latest is not used here: it returns a single
15-minute value stamped at its measurement time, not an hourly mean.)

sync(hours_back) runs hourly from the scheduler with a short look-back so
late-arriving hours fill in; backfill() is the same walk over a long
window, month by month. Both pace their calls: the OpenAQ key's 60/min
limit is shared with ingest's fallback and with research pulls.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone

import httpx

from . import db, openaq

log = logging.getLogger("ingest")

SECONDS_PER_CALL = 2.0          # ~30 calls/min, half the key's limit
CURRENT_SENSOR_MAX_AGE_H = 72   # a sensor counts as live if /latest saw it this recently
MAX_UGM3 = {"pm25": 999.9, "pm10": 1999.9, "no2": 999.9, "so2": 4999.9, "o3": 1999.9, "nh3": 4999.9}
MAX_CO_MG = 99.9


def _co_mg(value: float, unit: str | None) -> float:
    """Same unit rule as ingest._openaq_co_mg: the CPCB feed's "ppb" label
    on CO is really mg/m3; "µg/m³" sensors are ug/m3."""
    if unit == "µg/m³":
        return value / 1000.0
    if unit == "ppm":
        return value * 1.145
    return value


def _paced(fn, *args):
    """One OpenAQ call, paced, with a single back-off retry on 429/5xx or a
    network-level failure (a TLS handshake reset was seen in the first live run)."""
    for attempt in range(2):
        time.sleep(SECONDS_PER_CALL)
        try:
            return fn(*args)
        except httpx.HTTPStatusError as e:
            if attempt == 0 and (e.response.status_code == 429 or e.response.status_code >= 500):
                time.sleep(30)
                continue
            raise
        except httpx.TransportError:
            if attempt == 0:
                time.sleep(30)
                continue
            raise


def _current_sensors(location_id: int) -> dict[int, tuple[str, str | None]]:
    """sensor_id -> (our pollutant column, unit label) for the location's
    sensors that are still reporting (retired ones stay listed by OpenAQ)."""
    loc = _paced(openaq.get_location, location_id)
    latest = _paced(openaq.get_latest, location_id)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=CURRENT_SENSOR_MAX_AGE_H)
    live = {m["sensor_id"] for m in latest
            if datetime.fromisoformat(m["ts_utc"].replace("Z", "+00:00")) >= cutoff}
    out = {}
    for sid in live:
        col = openaq.PARAMS.get(loc["sensors"].get(sid) or "")
        if col:
            out[sid] = (col, (loc.get("units") or {}).get(sid))
    return out


def _rows_for_station(station_id: int, sensors, date_from: datetime, date_to: datetime) -> list[dict]:
    by_hour: dict[str, dict] = {}
    for sid, (col, unit) in sensors.items():
        a = date_from
        while a < date_to:
            b = min(a + timedelta(days=30), date_to)
            for r in _paced(openaq.get_sensor_hours, sid, a.strftime("%Y-%m-%dT%H:%M:%SZ"),
                            b.strftime("%Y-%m-%dT%H:%M:%SZ")):
                v = r["value"]
                if v is None or v < 0:
                    continue
                if col == "co":
                    v = _co_mg(v, unit)
                    if v > MAX_CO_MG:
                        continue
                elif v > MAX_UGM3.get(col, float("inf")):
                    continue
                ts = datetime.fromisoformat(r["ts_utc"].replace("Z", "+00:00")).isoformat()
                by_hour.setdefault(ts, {})[col] = v
            a = b
    return [{"station_id": station_id, "ts": ts, **vals} for ts, vals in by_hour.items()]


def _walk(date_from: datetime, date_to: datetime, station_ids: set[int] | None = None, sink=None) -> dict:
    """sink(rows) stores each station's rows: the database by default, or the
    local training archive (archive())."""
    sink = sink or db.upsert_readings_hourly
    summary = {"stations": 0, "rows": 0, "errors": []}
    for st in db.get_all_stations():
        loc = st.get("openaq_location_id")
        if not loc or (station_ids and st["id"] not in station_ids):
            continue
        try:
            sensors = _current_sensors(loc)
            rows = _rows_for_station(st["id"], sensors, date_from, date_to)
            if rows:
                sink(rows)
            summary["stations"] += 1
            summary["rows"] += len(rows)
        except Exception as e:  # one station must not stop the rest
            log.exception("hourly readings failed for station_id=%s", st["id"])
            summary["errors"].append(f"station_id={st['id']}: {type(e).__name__}")
    return summary


def archive(date_from: datetime, date_to: datetime, station_ids: set[int] | None = None) -> dict:
    """Same walk as backfill(), but into the local training archive
    (history_archive.py) instead of the size-limited database."""
    from . import history_archive
    return _walk(date_from, date_to, station_ids, sink=history_archive.append)


def sync(hours_back: int = 6) -> dict:
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    s = _walk(now - timedelta(hours=hours_back), now + timedelta(hours=1))
    log.info("hourly readings sync: %d rows for %d stations, %d errors", s["rows"], s["stations"], len(s["errors"]))
    return s


def backfill(days: int = 120, station_ids: set[int] | None = None) -> dict:
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    return _walk(now - timedelta(days=days), now + timedelta(hours=1), station_ids)
