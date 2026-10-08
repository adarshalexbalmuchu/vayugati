"""Supabase access. Uses the service_role key: writes bypass RLS by design."""

import concurrent.futures
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from supabase import Client, create_client

from . import config, stuck_sensors


@lru_cache(maxsize=1)
def client() -> Client:
    config.require_env()
    return create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY)


def _wards_paged(columns: str, page: int = 15) -> list[dict]:
    """All wards, a few rows per request: the polygons are ~8.6 MB of JSON and a
    single response peaked near 440 MB of RAM while it was parsed."""
    rows: list[dict] = []
    while True:
        chunk = _with_retry(lambda: client().table("wards").select(columns).order("id")
                            .range(len(rows), len(rows) + page - 1).execute().data)
        rows.extend(chunk)
        if len(chunk) < page:
            return rows


def get_wards() -> dict[str, dict]:
    """wards.name -> {id, lat, lng, boundary}.

    `boundary` added Sept 2026 alongside get_wards_with_city()'s own same
    change — see that function's doc comment. ingest.py's weather-fetch
    step uses it to compute a boundary-centroid receptor point for the 252
    of 265 wards with no captured lat/lng, instead of skipping them."""
    rows = _wards_paged("id, name, lat, lng, boundary")
    return {r["name"]: r for r in rows}


def get_wards_with_city(with_boundary: bool = True) -> list[dict]:
    """[{id, name, lat, lng, city_id, boundary}, ...] — for per-city
    forecasting/detection loops.

    `boundary` (GeoJSON Polygon/MultiPolygon, null for most rows) added
    Sept 2026 so vayutrace_kernel.run_kernel()'s boundary_bbox_center()
    fallback can compute a receptor point for the 252 of 265 wards that
    have no captured lat/lng — confirmed live this session that every one
    of those 252 has a real boundary. Callers that don't need it (the
    original use before this change) simply ignore the extra key; nothing
    existing reads `boundary` today except vayutrace_kernel.py."""
    return _wards_paged("id, name, lat, lng, city_id" + (", boundary" if with_boundary else ""))


def attach_ward_boundaries(wards: list[dict], ward_ids: set[int]) -> None:
    """Set `boundary` on the given wards in place, fetching only those ids."""
    need = sorted(ward_ids)
    for i in range(0, len(need), 15):
        ids = need[i : i + 15]
        rows = _with_retry(lambda ids=ids: client().table("wards").select("id, boundary").in_("id", ids).execute().data)
        found = {r["id"]: r["boundary"] for r in rows}
        for w in wards:
            if w["id"] in found:
                w["boundary"] = found[w["id"]]


def get_hotspot_wards() -> list[dict]:
    """[{id, name, lat, lng}, ...] for the ORIGINAL 13 is_hotspot=true wards
    only. Deprecated for scoring/context-layer use (Sept 2026) — its doc
    comment used to claim this "same scope fetchAllWardsAqi() uses," but
    that function was itself extended to all 265 wards; this function
    wasn't updated to match, and was the last caller (run_transit() in
    main.py) still silently restricted to the 13. Fixed by switching that
    caller to get_wards_with_city() (all 265, with `boundary` for the
    centroid fallback) instead. Kept only in case a genuinely
    hotspot-scoped query is needed again later — not currently called
    anywhere."""
    return client().table("wards").select("id, name, lat, lng").eq("is_hotspot", True).execute().data


def get_active_cities(city_code: str | None = None) -> list[dict]:
    """Active city_config rows (optionally filtered to one city_code), each
    with its own `config` jsonb (pollutant_priority, forecasting config, …)."""
    q = client().table("city_config").select("id, city_code, name, pollutant_priority, config").eq("is_active", True)
    if city_code:
        q = q.eq("city_code", city_code)
    return q.execute().data


def get_all_stations() -> list[dict]:
    """[{id, name, ward_id, external_ref, openaq_location_id}, ...] — every
    active station. openaq_location_id is the integer OpenAQ location id for
    stations that have an OpenAQ source (populated by migration 20260812); None
    for CPCB-only stations matched by name. Used by the OpenAQ fallback loop to
    replace the retired stations.yaml as the single source of truth."""
    return (
        client()
        .table("stations")
        .select("id, name, ward_id, external_ref, openaq_location_id")
        .neq("is_active", False)
        .execute()
        .data
    )


LAST_KNOWN_HOURS = 72


def get_latest_readings_by_station(station_ids: list[int]) -> dict[int, dict]:
    """station_id -> {ts, pm25, pm10, no2, so2, co, o3, aqi} for each
    station's single most recent reading. Uses one IN query to fetch recent
    rows for all stations, then picks the latest per station in Python —
    replaces N sequential round-trips (one per station) with one request."""
    if not station_ids:
        return {}
    # Look back LAST_KNOWN_HOURS (72h, the same horizon the frontend's
    # last-known fallback uses: web/src/lib/data.ts LAST_KNOWN_READING_HOURS)
    # so a prolonged upstream outage still returns each station's last real
    # reading. With 24h, the Sept 2026 data.gov.in outage passed that mark
    # after a day, every station came back empty, and the dashboard blanked
    # every ward's AQI. Paged: 72h x ~40 stations x up to 4 rows/h can exceed
    # PostgREST's 1000-row page.
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=LAST_KNOWN_HOURS)).isoformat()
    rows = _fetch_all(
        lambda: client()
        .table("readings")
        .select("station_id, ts, pm25, pm10, no2, so2, co, o3, aqi, ingest_source")
        .in_("station_id", station_ids)
        .gte("ts", cutoff)
        .order("ts", desc=True)
        .order("station_id")
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
    _with_retry(lambda: client().table("stations").update({"agency": agency}).eq("id", station_id).execute())


def upsert_reading(row: dict) -> None:
    # merge-duplicates: only the columns present in `row` are updated,
    # so a later sensor for the same hour fills in, not wipes, the rest.
    _with_retry(lambda: client().table("readings").upsert(row, on_conflict="station_id,ts").execute())


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
        _with_retry(lambda: client().table("readings").upsert(batch, on_conflict="station_id,ts").execute())
        written += len(batch)
    return written


def upsert_readings_hourly(rows: list[dict], chunk: int = 500) -> None:
    """Real hourly concentrations (OpenAQ) — see migration
    20260927010000_readings_hourly.sql for why they are kept apart from
    `readings`, whose CPCB rows are 24h averages.

    Rows carry only the pollutants seen for that hour. A bulk upsert fills
    missing columns with NULL, which would wipe values an earlier run stored
    for the same hour. So rows are batched by their exact column set: every
    row in a batch has the same columns, and none are nulled."""
    groups: dict[frozenset, list[dict]] = {}
    for r in rows:
        groups.setdefault(frozenset(r), []).append(r)
    for batch_rows in groups.values():
        for i in range(0, len(batch_rows), chunk):
            batch = batch_rows[i : i + chunk]
            _with_retry(lambda batch=batch: client().table("readings_hourly")
                        .upsert(batch, on_conflict="station_id,ts").execute())


def get_hourly_history(hours: int = 24 * 30, include_archive: bool = False) -> list[dict]:
    """Real hourly concentrations from readings_hourly, in exactly
    get_readings_history()'s shape ([{ts, ward_id, pm25, ..., aqi}]) so
    forecasting and attribution can switch source without other changes.

    Why not `readings`: since 2026-08-11 its CPCB rows are 24h (8h CO/O3)
    averages, not hourly values (value_basis='naqi_window'). A model trained
    on those learns a smoothed, lagged series. aqi is None here: AQI is
    defined on 24h averages, not on single hours.

    include_archive=True prepends the local training archive
    (history_archive.py) for hours before the database's own earliest row in
    the window, so the forecaster can train on every season without the
    database holding them.
    """
    stations = _with_retry(lambda: client().table("stations").select("id, ward_id").execute().data) or []
    sid_to_ward = {s["id"]: s["ward_id"] for s in stations if s.get("ward_id") is not None}
    if not sid_to_ward:
        return []
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    rows = _fetch_all(
        lambda: client()
        .table("readings_hourly")
        .select("ts, station_id, pm25, pm10, no2, so2, co, o3")
        .gte("ts", cutoff)
        .order("ts")
        .order("station_id")
    )
    if include_archive:
        from . import history_archive
        first = rows[0]["ts"] if rows else datetime.now(timezone.utc).isoformat()
        older = [r for r in history_archive.rows_before(datetime.fromisoformat(first), set(sid_to_ward))
                 if r["ts"] >= cutoff]
        rows = older + rows
    rows, blanked = stuck_sensors.drop_stuck(rows, ("pm25", "pm10", "no2", "so2", "co", "o3"))
    if blanked:
        _db_log.info("hourly history: dropped %d values from stuck analysers", blanked)
    return [
        {"ts": r["ts"], "ward_id": sid_to_ward[r["station_id"]], "pm25": r["pm25"], "pm10": r["pm10"],
         "no2": r["no2"], "so2": r["so2"], "co": r["co"], "o3": r["o3"], "aqi": None}
        for r in rows if r["station_id"] in sid_to_ward
    ]


def upsert_weather(row: dict) -> None:
    _with_retry(lambda: client().table("weather").upsert(row, on_conflict="ward_id,ts").execute())


def bulk_upsert_weather(rows: list[dict], chunk: int = 500) -> int:
    """Chunked upsert for weather rows, returning the number written.

    Added Sept 2026 for the ERA5 history backfill
    (scripts/backfill_weather_history.py), which writes on the order of
    40k+ rows — one HTTP round-trip per row via upsert_weather() above
    would take hours. Mirrors bulk_upsert_readings()'s existing contract:
    same on_conflict key, same retry wrapper, chunked to stay under
    PostgREST's request-size limits.
    """
    written = 0
    for i in range(0, len(rows), chunk):
        batch = rows[i:i + chunk]
        _with_retry(
            lambda b=batch: client().table("weather")
            .upsert(b, on_conflict="ward_id,ts").execute()
        )
        written += len(batch)
    return written


# ── history reads (for forecast + attribution) ───────────────────────────────

def _is_transient_network_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    # String-match patterns for TCP-level resets from Render → Supabase.
    if any(s in msg for s in ("disconnected", "connection reset", "connection error", "eof occurred")):
        return True
    # HTTP/2 stream-state errors: the server closed or reset an idle connection
    # and the client tried to reuse it. "send_headers in state" is the canonical
    # httpcore LocalProtocolError message for this scenario.
    exc_type = type(exc).__name__.lower()
    if "send_headers in state" in msg or "localprotocolerror" in exc_type:
        return True
    # HTTP/2 RemoteProtocolError: the server terminated the connection mid-stream
    # (ConnectionTerminated error_code:1). Seen from Supabase after idle periods.
    if "remoteprotocolerror" in exc_type or "connectionterminated" in msg:
        return True
    return False


def _with_retry(fn, max_attempts: int = 3):
    """Execute fn() and retry up to max_attempts times on transient
    Render→Supabase TCP resets. Same backoff as _fetch_all's per-page retry."""
    for attempt in range(max_attempts):
        try:
            return fn()
        except Exception as exc:
            if attempt < max_attempts - 1 and _is_transient_network_error(exc):
                time.sleep(2 ** attempt)
                continue
            raise


def _fetch_all(query_factory, page_size: int = 1000) -> list[dict]:
    """Fetch every row of a PostgREST query, page by page. PostgREST caps a
    single response at its server-configured max (1000 rows on Supabase by
    default), silently, regardless of any larger `.limit()` — so a plain
    `.limit(50000)` returns at most 1000 rows. This walks `.range()` windows
    until a short page signals the end. Matters now that a ward can have
    thousands of hourly readings in the forecast window (historical backfill);
    with only a few dozen readings it never surfaced.

    Accepts a zero-argument factory that returns a FRESH query builder each
    call. The factory pattern avoids accumulated offset/limit params: postgrest-
    py's `.range()` uses QueryParams.add() which appends rather than replaces,
    so calling it twice on the same builder produces `?offset=0&offset=1000`
    instead of the intended `?offset=1000`. A fresh builder per page is the
    simplest fix.

    Retries each page up to 3 times with exponential backoff on transient
    Render→Supabase TCP resets ("Server disconnected", ECONNRESET)."""
    out: list[dict] = []
    start = 0
    while True:
        for attempt in range(3):
            try:
                page = query_factory().range(start, start + page_size - 1).execute().data
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
    """Flattened readings joined to their ward:
    [{ts, ward_id, pm25, pm10, no2, so2, co, o3, aqi}].

    no2 was added in Phase 8 (unified forecasting, plan §1's "keep NO2 as
    optional/supporting") — additive to the returned dict, so the existing
    attribution.py caller (which only reads pm25/wind_dir) is unaffected.

    so2/co/o3 added Sept 2026 so forecast.py could stop hardcoding
    DEFAULT_ENABLED_POLLUTANTS to just (pm25, pm10, no2) — this was the
    actual reason AQI/SO2/CO/O3 had no forecast of their own and silently
    fell back to displaying PM2.5's curve labelled "(proxy)" everywhere in
    the frontend (see forecastPollutantFor() in web/src/lib/mapRules.ts):
    the readings.so2/co/o3 columns, the forecast_runs/forecasts CHECK
    constraints (pollutant IN (..., 'so2','co','o3')), and the anomaly-
    detection SQL all already supported these three pollutants — the
    Python forecasting pipeline was simply never given the readings data
    to train against. Confirmed live this session: ~50-61k non-null rows
    each for so2/co/o3, comparable in volume to pm25/no2, not sparse.

    station_id → ward_id is resolved in Python from a single small stations
    query rather than via a PostgREST embedded join on every paginated row —
    the embed makes each page slow enough to hit Render→Supabase TCP timeouts
    on a multi-thousand-row result set (30 days × 13 stations × hourly reads).
    """
    stations = _with_retry(lambda: client().table("stations").select("id, ward_id").execute().data) or []
    sid_to_ward: dict[int, int] = {
        s["id"]: s["ward_id"] for s in stations if s.get("ward_id") is not None
    }
    if not sid_to_ward:
        return []

    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    rows = _fetch_all(
        lambda: client()
        .table("readings")
        .select("ts, station_id, pm25, pm10, no2, so2, co, o3, aqi")
        .gte("ts", cutoff)
        # (ts, station_id), not ts alone: many rows share a ts, and range
        # paging over a non-unique order can skip or repeat rows (Sept 2026).
        .order("ts")
        .order("station_id")
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
                "so2": r["so2"],
                "co": r["co"],
                "o3": r["o3"],
                "aqi": r["aqi"],
            }
        )
    return out


def get_weather_history(hours: int = 24 * 30, ward_ids: list[int] | None = None) -> list[dict]:
    """[{ts, ward_id, wind_dir, wind_speed, temp_c, humidity, precipitation,
         boundary_layer_height, ventilation_coefficient}].
    boundary_layer_height / ventilation_coefficient are NULL for rows written
    before migration 20260826200000 — forecast.py handles NaN gracefully."""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()

    def query():
        q = (client().table("weather")
             .select("ts, ward_id, wind_dir, wind_speed, temp_c, humidity, precipitation, boundary_layer_height, ventilation_coefficient")
             .gte("ts", cutoff))
        if ward_ids is not None:
            q = q.in_("ward_id", ward_ids)
        return q.order("ts")

    return _fetch_all(query)


# ── forecast + attribution writes ────────────────────────────────────────────

def get_last_forecast_times(city_id: int) -> dict[tuple[int, str], datetime]:
    """(ward_id, pollutant) -> generated_at of the most recent forecast_runs row.
    Used by forecast.py to skip retraining when no new readings have arrived."""
    rows = _with_retry(lambda: (
        client()
        .table("forecast_runs")
        .select("ward_id, pollutant, generated_at")
        .eq("city_id", city_id)
        .order("generated_at", desc=True)
        .execute()
        .data
    )) or []
    seen: dict[tuple[int, str], datetime] = {}
    for r in rows:
        key = (r["ward_id"], r["pollutant"])
        if key not in seen:
            seen[key] = datetime.fromisoformat(r["generated_at"].replace("Z", "+00:00"))
    return seen


import logging as _log_module
_db_log = _log_module.getLogger("ingest.db")


def get_24h_avg_concentrations(station_ids: list[int]) -> dict[int, dict]:
    """Per-station concentrations for AQI recomputation, matching CPCB's exact
    averaging methodology AND minimum data-availability requirements:

      PM2.5 / PM10 / NO2 / SO2 / NH3:
        24h simple average of hourly means, minimum 16 distinct clock-hours.
      O3 / CO:
        Maximum 8h rolling average of hourly means, minimum 6 distinct clock-hours.

    Every clock-hour gets equal weight, matching CPCB's calculation. DPCC
    stations often go offline 11 PM–7 AM, so the hours present skew to the
    polluted daytime; the minimum-hours check below is what keeps that from
    inflating the AQI.

    WHY THE MINIMUM-HOURS CHECK MATTERS
    ─────────────────────────────────────
    CPCB requires 75% data availability (16/24 hours) before computing AQI.
    A station with only 4–6 hours of peak-morning readings yields a "24h average"
    that is the average of the worst hours of the day — not a meaningful 24h value.
    Below the minimum, the pollutant is excluded from AQI so its sub-index is
    absent rather than artificially inflated by sparse coverage.

    SOURCE: readings_hourly only (true OpenAQ hourly means, hour-start
    labels, CO already mg/m³), with the same stuck-analyser filter the models
    use. Not `readings`: its CPCB rows are already 24h/8h window averages
    (value_basis='naqi_window'), and its OpenAQ rows are provisional
    end-of-hour snapshots labelled one hour later than the same hour in
    readings_hourly. Averaging those together mixed three bases."""
    if not station_ids:
        return {}
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    rows = _with_retry(lambda: client()
        .table("readings_hourly")
        .select("station_id, ts, pm25, pm10, no2, so2, co, o3")
        .in_("station_id", station_ids)
        .gte("ts", cutoff)
        .order("ts")
        .execute()
    ).data or []
    rows, _ = stuck_sensors.drop_stuck(rows, ("pm25", "pm10", "no2", "so2", "co", "o3"))

    by_station: dict[int, list[dict]] = {}
    for row in rows:
        by_station.setdefault(row["station_id"], []).append(row)

    result: dict[int, dict] = {}
    for sid, readings in by_station.items():
        # ── Step 1: one value per clock-hour per pollutant ───────────────────
        # hr_key = ts[:13] e.g. "2026-08-26T14" — unique per UTC hour.
        hourly_buckets: dict[str, dict[str, list[float]]] = {}
        for r in readings:
            hr_key = (r.get("ts") or "")[:13]
            if not hr_key:
                continue
            bucket = hourly_buckets.setdefault(hr_key, {})
            for col in ("pm25", "pm10", "no2", "so2", "nh3", "o3", "co"):
                v = r.get(col)
                if v is not None:
                    bucket.setdefault(col, []).append(float(v))

        # ── Step 2: mean within each clock-hour (one float per hour) ─────────
        # sorted() ensures the hourly_means list is time-ordered (required by
        # the 8h rolling window computation).
        hourly_means: dict[str, list[float]] = {}
        for hr_key in sorted(hourly_buckets):
            for col, vals in hourly_buckets[hr_key].items():
                if vals:
                    hourly_means.setdefault(col, []).append(sum(vals) / len(vals))

        # ── Step 3: CPCB windows (24h mean; max 8h for O3/CO) with the
        # 75% availability minimum (aqi.window_concentrations) ─────────────
        avg = aqi.window_concentrations(hourly_means)

        result[sid] = avg
    return result


def set_reading_aqi(station_id: int, ts: str, aqi_value: int) -> None:
    """Patch the AQI on an already-written reading. Used by the 24h-average AQI
    recomputation step in ingest.py to replace the per-hour snapshot AQI with
    the rolling 24h average that CPCB's breakpoints are calibrated for."""
    _with_retry(lambda: client().table("readings").update({"aqi": aqi_value}).eq("station_id", station_id).eq("ts", ts).execute())


def upsert_fire_count(date_str: str, region: str, fire_count: int) -> None:
    """Write (or update) the daily VIIRS regional fire count for one region.
    Idempotent on (date, region) — safe to call daily even if the previous
    day's fetch is retried. Used by main.run_fire_counts()."""
    _with_retry(lambda: client().table("fire_counts").upsert(
        {"date": date_str, "region": region, "fire_count": fire_count},
        on_conflict="date,region",
    ).execute())


def get_fire_counts_history(days: int = 45, region: str = "igp_regional") -> list[dict]:
    """[{date, fire_count}] for the last `days` calendar days for `region`.
    45 days covers the 30-day training window plus a 15-day buffer. Ordered
    oldest-first so callers can build a date-indexed Series directly."""
    from datetime import timezone
    cutoff = (datetime.now(timezone.utc).date() - timedelta(days=days)).isoformat()
    return (_with_retry(lambda: client()
        .table("fire_counts")
        .select("date, fire_count")
        .eq("region", region)
        .gte("date", cutoff)
        .order("date")
        .execute()
    ).data or [])


def delete_old_readings(days: int = 90) -> int:
    """Delete readings older than `days` days. Returns the number deleted.
    Called by the daily retention job in main.py to keep the readings table
    from growing unboundedly (~4 400 rows/day at 46 stations × 15-min cadence).
    Uses lt() on the indexed ts column — the (station_id, ts desc) index makes
    this a fast range scan regardless of table size."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    resp = _with_retry(lambda: client().table("readings").delete().lt("ts", cutoff).execute())
    deleted = len(resp.data) if resp.data else 0
    return deleted


def call_rpc(name: str, params: dict, timeout: float = 30.0) -> list:
    """Call a Supabase RPC with transient-error retry + a hard wall-clock timeout.

    postgrest-py's httpx client defaults to no timeout, so a slow or hung
    Supabase stored-procedure call can block the APScheduler thread indefinitely
    (seen: escalation job stuck >60 min). ThreadPoolExecutor.result(timeout=...)
    gives us a portable deadline that works from worker threads (signal.alarm
    is main-thread-only and would raise ValueError here).
    """
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(_with_retry, lambda: client().rpc(name, params).execute())
        try:
            resp = future.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            raise TimeoutError(f"call_rpc({name!r}) timed out after {timeout}s")
    return resp.data or []


def replace_forecasts(ward_id: int, pollutant: str, rows: list[dict]) -> None:
    """Swap in a fresh forecast generation for one ward+pollutant (delete old,
    insert new). Scoped to `pollutant` since Phase 8: `forecasts` now holds
    pm25/pm10/no2 rows for the same ward side by side — an unscoped delete
    would wipe out every OTHER pollutant's current forecast for this ward."""
    _with_retry(lambda: client().table("forecasts").delete().eq("ward_id", ward_id).eq("pollutant", pollutant).execute())
    if rows:
        _with_retry(lambda: client().table("forecasts").insert(rows).execute())


def replace_aqi_forecasts(ward_id: int, rows: list[dict]) -> None:
    """Swap in a ward's forecast AQI (aqi_forecasts: one row per lead). An
    empty list removes the ward's rows, so a stale forecast never lingers."""
    _with_retry(lambda: client().table("aqi_forecasts").delete().eq("ward_id", ward_id).execute())
    if rows:
        _with_retry(lambda: client().table("aqi_forecasts").insert(rows).execute())


def insert_forecast_run(row: dict) -> int:
    """Insert one forecast_runs row (the validation record for a generation). Returns its id."""
    return _with_retry(lambda: client().table("forecast_runs").insert(row).execute().data[0]["id"])


# ── ward-level nowcasting (+1h) ──────────────────────────────────────────────

def get_nowcast_backtest_result(ward_id: int, pollutant: str) -> dict | None:
    """Latest nowcast_backtest_results row for one ward+pollutant, or None if
    the periodic backtest script (ingest/scripts/nowcast_backtest.py) hasn't
    run for this pair yet. One row per (ward_id, pollutant) — upserted, not
    accumulated — so this is always simply the current row, if any."""
    rows = _with_retry(
        lambda: client()
        .table("nowcast_backtest_results")
        .select("*")
        .eq("ward_id", ward_id)
        .eq("pollutant", pollutant)
        .limit(1)
        .execute()
        .data
    )
    return rows[0] if rows else None


def upsert_nowcast_backtest_result(row: dict) -> None:
    """Called only by ingest/scripts/nowcast_backtest.py — one row per
    (ward_id, pollutant), replaced wholesale each time the script runs."""
    _with_retry(
        lambda: client().table("nowcast_backtest_results").upsert(row, on_conflict="ward_id,pollutant").execute()
    )


def insert_nowcast_shadow_rows(rows: list[dict]) -> None:
    """One row per eligible candidate method for one ward+pollutant+cycle.
    The unique (forecast_run_id, ward_id, pollutant, valid_at, candidate_method)
    constraint makes a retried run() idempotent rather than duplicating rows —
    upsert (ignore-duplicates) rather than a plain insert so a retry doesn't error."""
    if not rows:
        return
    _with_retry(
        lambda: client()
        .table("nowcast_shadow_log")
        .upsert(rows, on_conflict="forecast_run_id,ward_id,pollutant,valid_at,candidate_method", ignore_duplicates=True)
        .execute()
    )


def get_pending_nowcast_shadows(before_iso: str, limit: int = 500) -> list[dict]:
    """Shadow-log rows whose valid_at has passed and haven't been scored yet."""
    return _fetch_all(
        lambda: client()
        .table("nowcast_shadow_log")
        .select("id, ward_id, pollutant, valid_at")
        .lte("valid_at", before_iso)
        .is_("actual_value", "null")
        .limit(limit)
    )


def score_nowcast_shadow(row_id: int, actual_value: float, actual_observed_at: str, scored_at: str) -> None:
    _with_retry(
        lambda: client()
        .table("nowcast_shadow_log")
        .update({"actual_value": actual_value, "actual_observed_at": actual_observed_at, "scored_at": scored_at})
        .eq("id", row_id)
        .execute()
    )


def replace_attribution(ward_id: int, row: dict) -> None:
    """Keep one current attribution per ward."""
    _with_retry(lambda: client().table("attributions").delete().eq("ward_id", ward_id).execute())
    _with_retry(lambda: client().table("attributions").insert(row).execute())


def replace_attribution_by_method(ward_id: int, method: str, row: dict) -> None:
    """Keep one current attribution per (ward_id, method) pair.

    Unlike replace_attribution() which deletes ALL attributions for a ward,
    this only replaces rows with the given method — so wind-rose (pollution_rose_v1)
    and VayuTrace kernel (vayutrace_v1) results coexist in the same table without
    overwriting each other.
    """
    _with_retry(
        lambda: client()
        .table("attributions")
        .delete()
        .eq("ward_id", ward_id)
        .eq("method", method)
        .execute()
    )
    _with_retry(lambda: client().table("attributions").insert(row).execute())


def get_stations_with_coords() -> list[dict]:
    """[{id, ward_id, lat, lng}, ...] for stations that have coordinates.

    Used by the VayuTrace kernel's confidence signal (distance to nearest monitoring
    station). Stations without lat/lng are excluded — the kernel falls back to
    0.5 confidence for wards with no nearby station on record."""
    rows = (
        client()
        .table("stations")
        .select("id, ward_id, lat, lng")
        .not_.is_("lat", "null")
        .not_.is_("lng", "null")
        .execute()
        .data
    )
    return rows


def get_latest_weather_by_ward() -> dict[int, dict]:
    """Most recent weather row per ward — {ward_id: {wind_dir, wind_speed, ...}}.

    Used by the VayuTrace kernel which needs current met conditions, not the full
    30-day history that the wind-rose attribution uses."""
    rows = _fetch_all(
        lambda: client()
        .table("weather")
        .select("ts, ward_id, wind_dir, wind_speed, temp_c, humidity")
        .order("ts", desc=True)
        .limit(500)  # more than enough wards; latest-per-ward extracted in Python
    )
    latest: dict[int, dict] = {}
    for r in rows:
        wid = r["ward_id"]
        if wid not in latest:
            latest[wid] = r
    return latest


# ── notifications (Phase 9) ──────────────────────────────────────────────────

def get_pending_notifications(max_retries: int) -> list[dict]:
    """Notifications still eligible for a delivery attempt (status='pending',
    retry_count within budget). `notifications.py` owns what happens next."""
    return _with_retry(lambda: (
        client()
        .table("notifications")
        .select("id, channel, recipient_contact, message_body, template_key, retry_count")
        .eq("status", "pending")
        .lte("retry_count", max_retries)
        .execute()
        .data
    )) or []


def mark_notification_sent(notification_id: int, sent_at_iso: str) -> None:
    _with_retry(lambda: client().table("notifications").update(
        {"status": "sent", "sent_at": sent_at_iso}
    ).eq("id", notification_id).execute())


def mark_notification_retry_or_failed(
    notification_id: int, failure_reason: str, retry_count: int, terminal: bool
) -> None:
    _with_retry(lambda: client().table("notifications").update(
        {
            "status": "failed" if terminal else "pending",
            "failure_reason": failure_reason,
            "retry_count": retry_count,
        }
    ).eq("id", notification_id).execute())
