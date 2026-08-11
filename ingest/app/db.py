"""Supabase access. Uses the service_role key: writes bypass RLS by design."""

import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from supabase import Client, create_client

from . import config


@lru_cache(maxsize=1)
def client() -> Client:
    config.require_env()
    return create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY)


def get_wards() -> dict[str, dict]:
    """wards.name -> {id, lat, lng}"""
    rows = client().table("wards").select("id, name, lat, lng").execute().data
    return {r["name"]: r for r in rows}


def get_wards_with_city() -> list[dict]:
    """[{id, name, lat, lng, city_id}, ...] — for per-city forecasting/detection loops."""
    return client().table("wards").select("id, name, lat, lng, city_id").execute().data


def get_hotspot_wards() -> list[dict]:
    """[{id, name, lat, lng}, ...] for the monitored hotspot set only (same
    `is_hotspot=true` scope the frontend's fetchAllWardsAqi() uses) - for
    context layers that should score against the same ward set the rest of
    the app already treats as "the wards that matter" (transit_activity.py)."""
    return client().table("wards").select("id, name, lat, lng").eq("is_hotspot", True).execute().data


def get_active_cities(city_code: str | None = None) -> list[dict]:
    """Active city_config rows (optionally filtered to one city_code), each
    with its own `config` jsonb (pollutant_priority, forecasting config, …)."""
    q = client().table("city_config").select("id, city_code, name, pollutant_priority, config").eq("is_active", True)
    if city_code:
        q = q.eq("city_code", city_code)
    return q.execute().data


def get_all_stations() -> list[dict]:
    """[{id, name, ward_id, external_ref}, ...] - every station, for the
    CPCB/data.gov latest-reading reconciliation (station_matching.py +
    latest_readings.py) and the ingest OpenAQ-fallback dedup check.
    external_ref is the OpenAQ location id string (or None for stations
    not sourced from OpenAQ). Not scoped to hotspot wards — a station can
    exist without its ward being in the monitored hotspot set."""
    return client().table("stations").select("id, name, ward_id, external_ref").neq("is_active", False).execute().data


def get_latest_readings_by_station(station_ids: list[int]) -> dict[int, dict]:
    """station_id -> {ts, pm25, pm10, no2, so2, co, o3, aqi} for each
    station's single most recent reading. Uses one IN query to fetch recent
    rows for all stations, then picks the latest per station in Python —
    replaces N sequential round-trips (one per station) with one request."""
    if not station_ids:
        return {}
    # Fetch the latest 2 hours of readings for all stations in one query.
    # The readings(station_id, ts desc) index makes this efficient regardless
    # of table size. 2h window covers any realistic ingest cadence while
    # keeping the result set small.
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    rows = (
        client()
        .table("readings")
        .select("station_id, ts, pm25, pm10, no2, so2, co, o3, aqi")
        .in_("station_id", station_ids)
        .gte("ts", cutoff)
        .order("ts", desc=True)
        .execute()
        .data
    )
    # Keep only the first (latest) row per station.
    out: dict[int, dict] = {}
    for row in rows:
        sid = row["station_id"]
        if sid not in out:
            out[sid] = row
    return out


def get_station_by_ref(external_ref: str) -> dict | None:
    rows = (
        client()
        .table("stations")
        .select("id, external_ref")
        .eq("external_ref", external_ref)
        .execute()
        .data
    )
    return rows[0] if rows else None


def insert_station(
    ward_id: int, name: str, external_ref: str, lat: float | None, lng: float | None
) -> dict:
    row = {
        "ward_id": ward_id,
        "name": name,
        "source": "dpcc",  # OpenAQ wraps DPCC/CPCB; refine per station later if needed
        "external_ref": external_ref,
        "lat": lat,
        "lng": lng,
    }
    return client().table("stations").insert(row).execute().data[0]


def set_station_agency(station_id: int, agency: str) -> None:
    """Write the monitoring agency (DPCC/IMD/IITM) onto the stations row.
    Called from the CPCB ingest path which extracts it from the station-name
    suffix ("Anand Vihar, Delhi - DPCC" -> "DPCC"). Idempotent: safe to call
    every ingest cycle; the value rarely if ever changes in practice."""
    client().table("stations").update({"agency": agency}).eq("id", station_id).execute()


def upsert_reading(row: dict) -> None:
    # merge-duplicates: only the columns present in `row` are updated,
    # so a later sensor for the same hour fills in, not wipes, the rest.
    client().table("readings").upsert(row, on_conflict="station_id,ts").execute()


def bulk_upsert_readings(rows: list[dict], chunk: int = 500) -> int:
    """Upsert many readings in batched requests (one REST call per `chunk`
    rows) rather than one call per row — the historical backfill writes
    thousands of rows at once, where per-row upserts are impractically slow.
    Same on_conflict target as `upsert_reading`, so a re-run or an overlap
    with the live hourly feed merges rather than duplicates."""
    if not rows:
        return 0
    written = 0
    for i in range(0, len(rows), chunk):
        batch = rows[i : i + chunk]
        client().table("readings").upsert(batch, on_conflict="station_id,ts").execute()
        written += len(batch)
    return written


def upsert_weather(row: dict) -> None:
    client().table("weather").upsert(row, on_conflict="ward_id,ts").execute()


# ── history reads (for forecast + attribution) ───────────────────────────────

def _is_transient_network_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(s in msg for s in ("disconnected", "connection reset", "connection error", "eof occurred"))


def _fetch_all(query_builder, page_size: int = 1000) -> list[dict]:
    """Fetch every row of a PostgREST query, page by page. PostgREST caps a
    single response at its server-configured max (1000 rows on Supabase by
    default), silently, regardless of any larger `.limit()` — so a plain
    `.limit(50000)` returns at most 1000 rows. This walks `.range()` windows
    until a short page signals the end. Matters now that a ward can have
    thousands of hourly readings in the forecast window (historical backfill);
    with only a few dozen readings it never surfaced.

    Retries each page up to 3 times with exponential backoff on transient
    Render→Supabase TCP resets ("Server disconnected", ECONNRESET)."""
    out: list[dict] = []
    start = 0
    while True:
        for attempt in range(3):
            try:
                page = query_builder.range(start, start + page_size - 1).execute().data
                break
            except Exception as exc:
                if attempt < 2 and _is_transient_network_error(exc):
                    time.sleep(2 ** attempt)
                    continue
                raise
        out.extend(page)
        if len(page) < page_size:
            break
        start += page_size
    return out


def get_readings_history(hours: int = 24 * 30) -> list[dict]:
    """Flattened readings joined to their ward: [{ts, ward_id, pm25, pm10, no2, aqi}].

    no2 was added in Phase 8 (unified forecasting, plan §1's "keep NO2 as
    optional/supporting") — additive to the returned dict, so the existing
    attribution.py caller (which only reads pm25/wind_dir) is unaffected.

    station_id → ward_id is resolved in Python from a single small stations
    query rather than via a PostgREST embedded join on every paginated row —
    the embed makes each page slow enough to hit Render→Supabase TCP timeouts
    on a multi-thousand-row result set (30 days × 13 stations × hourly reads).
    """
    stations = client().table("stations").select("id, ward_id").execute().data or []
    sid_to_ward: dict[int, int] = {
        s["id"]: s["ward_id"] for s in stations if s.get("ward_id") is not None
    }
    if not sid_to_ward:
        return []

    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    rows = _fetch_all(
        client()
        .table("readings")
        .select("ts, station_id, pm25, pm10, no2, aqi")
        .gte("ts", cutoff)
        .order("ts")
    )
    out = []
    for r in rows:
        ward_id = sid_to_ward.get(r["station_id"])
        if ward_id is None:
            continue
        out.append(
            {
                "ts": r["ts"],
                "ward_id": ward_id,
                "pm25": r["pm25"],
                "pm10": r["pm10"],
                "no2": r["no2"],
                "aqi": r["aqi"],
            }
        )
    return out


def get_weather_history(hours: int = 24 * 30) -> list[dict]:
    """[{ts, ward_id, wind_dir, wind_speed, temp_c, humidity, precipitation}]."""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    return _fetch_all(
        client()
        .table("weather")
        .select("ts, ward_id, wind_dir, wind_speed, temp_c, humidity, precipitation")
        .gte("ts", cutoff)
        .order("ts")
    )


# ── forecast + attribution writes ────────────────────────────────────────────

def get_last_forecast_times(city_id: int) -> dict[tuple[int, str], datetime]:
    """(ward_id, pollutant) -> generated_at of the most recent forecast_runs row.
    Used by forecast.py to skip retraining when no new readings have arrived."""
    rows = (
        client()
        .table("forecast_runs")
        .select("ward_id, pollutant, generated_at")
        .eq("city_id", city_id)
        .order("generated_at", desc=True)
        .execute()
        .data
    )
    seen: dict[tuple[int, str], datetime] = {}
    for r in rows:
        key = (r["ward_id"], r["pollutant"])
        if key not in seen:
            seen[key] = datetime.fromisoformat(r["generated_at"].replace("Z", "+00:00"))
    return seen


def replace_forecasts(ward_id: int, pollutant: str, rows: list[dict]) -> None:
    """Swap in a fresh forecast generation for one ward+pollutant (delete old,
    insert new). Scoped to `pollutant` since Phase 8: `forecasts` now holds
    pm25/pm10/no2 rows for the same ward side by side — an unscoped delete
    would wipe out every OTHER pollutant's current forecast for this ward."""
    client().table("forecasts").delete().eq("ward_id", ward_id).eq("pollutant", pollutant).execute()
    if rows:
        client().table("forecasts").insert(rows).execute()


def insert_forecast_run(row: dict) -> int:
    """Insert one forecast_runs row (the validation record for a generation). Returns its id."""
    return client().table("forecast_runs").insert(row).execute().data[0]["id"]


def replace_attribution(ward_id: int, row: dict) -> None:
    """Keep one current attribution per ward."""
    client().table("attributions").delete().eq("ward_id", ward_id).execute()
    client().table("attributions").insert(row).execute()


# ── notifications (Phase 9) ──────────────────────────────────────────────────

def get_pending_notifications(max_retries: int) -> list[dict]:
    """Notifications still eligible for a delivery attempt (status='pending',
    retry_count within budget). `notifications.py` owns what happens next."""
    return (
        client()
        .table("notifications")
        .select("id, channel, recipient_contact, message_body, template_key, retry_count")
        .eq("status", "pending")
        .lte("retry_count", max_retries)
        .execute()
        .data
    )


def mark_notification_sent(notification_id: int, sent_at_iso: str) -> None:
    client().table("notifications").update(
        {"status": "sent", "sent_at": sent_at_iso}
    ).eq("id", notification_id).execute()


def mark_notification_retry_or_failed(
    notification_id: int, failure_reason: str, retry_count: int, terminal: bool
) -> None:
    client().table("notifications").update(
        {
            "status": "failed" if terminal else "pending",
            "failure_reason": failure_reason,
            "retry_count": retry_count,
        }
    ).eq("id", notification_id).execute()
