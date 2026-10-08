"""One ingestion run: CPCB/data.gov (primary) + OpenAQ fallback + Open-Meteo -> Supabase.

CPCB/data.gov.in is now the primary AQ source: one paginated API call returns
the latest reading for every Delhi station in a single round-trip, with no
per-month quota. OpenAQ remains a fallback for stations that CPCB's name-
matching doesn't cover, or for deployments where DATA_GOV_API_KEY is unset.
Open-Meteo weather is independent of either AQ source.
"""

import logging
from datetime import datetime, timedelta, timezone

from . import aqi, config, data_gov_cpcb, db, open_meteo, openaq, station_matching
from .vayutrace_kernel import boundary_bbox_center

log = logging.getLogger("ingest")

# Last CPCB fetch cached so main.py can rebuild the live-display reconcile
# after each ingest without a second data.gov.in API call.
_last_cpcb_fetch: tuple[dict, dict] | None = None  # (cpcb_by_station, match_index)


def get_last_cpcb_fetch() -> tuple[dict, dict] | None:
    """Returns (cpcb_by_station, match_index) from the most recent run().
    Call this from main.py immediately after run_tracked("ingest", ingest.run)."""
    return _last_cpcb_fetch


# IST offset for parsing CPCB's 'DD-MM-YYYY HH:MM:SS' last_update strings.
# The same constant appears in latest_readings.py — one source of truth for
# the IST convention that CPCB's live feed uses.
_IST = timezone(timedelta(hours=5, minutes=30))

# Upper plausibility limits for pollutant concentrations. Any value above
# these is treated as a sensor malfunction or CPCB feed error and dropped
# rather than stored — otherwise one faulty reading inflates the 24h average.
# Limits are intentionally generous (roughly 2–3× the highest CPCB breakpoint)
# to preserve genuine extreme events (Diwali PM2.5 to ~999 µg/m³, dust-storm
# PM10) while filtering obvious instrument failures (PM2.5 = 5000 µg/m³).
# Source: CPCB National AQI 2014 breakpoints; SAFAR/IMD CAAQMS QC guidelines.
_CONC_MAX_UGM3: dict[str, float] = {
    "pm25": 999.9,    # µg/m³  (AQI-500 entry = 380; 999 observed on extreme Diwali nights)
    "pm10": 1999.9,   # µg/m³  (AQI-500 entry = 600; 2000 during severe dust storms)
    "no2":  1999.9,   # µg/m³
    "so2":  4999.9,   # µg/m³
    "o3":   1999.9,   # µg/m³
    "nh3":  4999.9,   # µg/m³
}
_CO_MAX_MG: float = 99.9  # mg/m³  (AQI-500 entry = 48 mg/m³)


def _15min_floor_utc(ts_iso: str) -> str:
    dt = datetime.fromisoformat(ts_iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    q = (dt.minute // 15) * 15
    return dt.replace(minute=q, second=0, microsecond=0).isoformat()


# Keep the old name as an alias so existing callers (OpenAQ path) don't need changes.
_hour_floor_utc = _15min_floor_utc


def _parse_cpcb_agency(cpcb_name: str) -> str | None:
    """Extract monitoring agency from a CPCB station-name suffix.
    'Anand Vihar, Delhi - DPCC' -> 'DPCC'
    Returns None when no '- ' suffix is present."""
    if " - " in cpcb_name:
        suffix = cpcb_name.rsplit(" - ", 1)[-1].strip().upper()
        return suffix or None
    return None


def _parse_cpcb_ts(ts_str: str) -> str | None:
    """Parse CPCB's 'DD-MM-YYYY HH:MM:SS' IST string -> UTC ISO 15-min floor.
    Returns None on any parse failure rather than raising."""
    try:
        dt = datetime.strptime(ts_str, "%d-%m-%Y %H:%M:%S").replace(tzinfo=_IST)
        utc = dt.astimezone(timezone.utc)
        q = (utc.minute // 15) * 15
        return utc.replace(minute=q, second=0, microsecond=0).isoformat()
    except (ValueError, TypeError):
        return None


def _ingest_from_cpcb(
    match_index: dict[str, int],
) -> tuple[int, list[str], set[int], list[dict], dict[int, str], dict[int, list[dict]]]:
    """Fetch CPCB/data.gov.in latest readings and write matched ones to Supabase.

    One API call per cycle returns all Delhi stations — no per-station loop,
    no per-month quota. Returns (rows_written, errors, station_ids_covered,
    unmatched_stations, station_ts, cpcb_by_station) where station_ts maps
    station_id -> ts of the row just written (used by the 24h-average AQI
    recomputation step) and cpcb_by_station is the raw grouped CPCB feed
    (cached by run() so main.py can rebuild the live reconcile without a
    second API call)."""
    records = data_gov_cpcb.fetch_delhi_records()
    if records is None:
        msg = "CPCB fetch returned None — DATA_GOV_API_KEY unset or API unavailable"
        log.warning(msg)
        # Six values, matching the success path below and this function's
        # annotation. Bug fix (Sept 2026): this path returned only five,
        # so every CPCB outage crashed run() with "not enough values to
        # unpack (expected 6, got 5)" instead of degrading to the OpenAQ
        # fallback. Confirmed live: data.gov.in was returning HTTP 502 and
        # the ingest job had been failing every 15-minute cycle for ~25h,
        # which in turn left the whole UI in its stale-data state.
        return 0, [msg], set(), [], {}, {}

    cpcb_by_station = data_gov_cpcb.group_by_station(records)
    rows_written = 0
    errors: list[str] = []
    covered: set[int] = set()
    unmatched: list[dict] = []
    station_ts: dict[int, str] = {}
    # Collision guard: tracks station_id -> first CPCB name that matched it
    # this cycle. If a second CPCB record normalizes to the same station_id,
    # the second write is skipped and a warning is logged — turns a silent
    # overwrite (readings AND agency) into a visible signal. If the warning
    # fires in practice, it confirms case B: two genuinely distinct CPCB
    # records (e.g. one IMD, one IITM) resolving to the same internal station.
    first_match: dict[int, str] = {}

    for cpcb_name, entry in cpcb_by_station.items():
        sid = station_matching.match_station(cpcb_name, match_index)
        if sid is None:
            log.info(
                "CPCB unmatched (not in stations table): %r  lat=%s lng=%s",
                cpcb_name, entry.get("lat"), entry.get("lng"),
            )
            unmatched.append({
                "cpcb_name": cpcb_name,
                "lat": entry.get("lat"),
                "lng": entry.get("lng"),
            })
            continue

        if sid in first_match:
            log.warning(
                "CPCB collision: station_id=%s matched by both %r and %r — "
                "skipping second record to avoid silent overwrite",
                sid, first_match[sid], cpcb_name,
            )
            continue
        first_match[sid] = cpcb_name

        ts_str = entry.get("last_update")
        if not ts_str:
            continue

        ts_hour = _parse_cpcb_ts(ts_str)
        if ts_hour is None:
            errors.append(f"CPCB bad timestamp for {cpcb_name!r}: {ts_str!r}")
            continue

        pollutants = entry.get("pollutants") or {}
        row: dict = {"station_id": sid, "ts": ts_hour, "ingest_source": "cpcb",
                     "value_basis": "naqi_window"}
        for col in ("pm25", "pm10", "no2", "so2", "co", "o3", "nh3"):
            val = (pollutants.get(col) or {}).get("avg")
            if val is not None and val >= 0:
                row[col] = val

        if len(row) <= 4:
            continue  # only the key + provenance fields, no pollutant data — nothing to write

        # data_gov_cpcb.group_by_station() has already turned the feed's
        # sub-indices into concentrations, with CO in mg/m³ (unit "MG/M3");
        # the ug->mg branch below stays only as a guard for a future feed change.
        # NOTE: We intentionally write raw CO (mg/m³) into readings.co — NOT µg/m³.
        co_raw = pollutants.get("co") or {}
        co_val = row.get("co")
        co_mg: float | None = None
        if co_val is not None:
            co_mg = co_val if co_raw.get("unit", "MG/M3") == "MG/M3" else aqi.co_ug_to_mg(co_val)
            row["co"] = co_mg  # always store as mg/m³ so 24h-avg recompute is unit-consistent

        # ── Concentration range validation ────────────────────────────────────
        # Drop physically impossible values (instrument malfunction / CPCB feed
        # error) before storing or computing AQI. Even one extreme outlier in
        # the 24h rolling average can inflate AQI by hundreds of units.
        # The check happens AFTER CO unit conversion so co is already in mg/m³.
        for _col, _limit in _CONC_MAX_UGM3.items():
            _v = row.get(_col)
            if _v is not None and _v > _limit:
                log.warning(
                    "CPCB out-of-range %s=%.1f µg/m³ at %r %s — dropped (limit %.1f)",
                    _col, _v, cpcb_name, ts_hour, _limit,
                )
                row.pop(_col)
        _co_v = row.get("co")
        if _co_v is not None and _co_v > _CO_MAX_MG:
            log.warning(
                "CPCB out-of-range co=%.2f mg/m³ at %r %s — dropped (limit %.1f)",
                _co_v, cpcb_name, ts_hour, _CO_MAX_MG,
            )
            row.pop("co")
        co_mg = row.get("co")   # refresh after possible drop

        # These concentrations are CPCB's own AQI-window averages (24h; 8h for
        # CO/O3), so the AQI computed from them IS CPCB's AQI — no further
        # averaging (see run(): CPCB rows are not passed to _recompute_24h_aqi).
        computed_aqi = aqi.compute_cpcb_aqi(
            row.get("pm25"), row.get("pm10"),
            no2=row.get("no2"), so2=row.get("so2"),
            o3=row.get("o3"), co_mg=co_mg,
            nh3=row.get("nh3"),
        )
        if computed_aqi is not None:
            row["aqi"] = computed_aqi

        try:
            db.upsert_reading(row)
            covered.add(sid)
            station_ts[sid] = ts_hour
            rows_written += 1
            agency = _parse_cpcb_agency(cpcb_name)
            if agency:
                db.set_station_agency(sid, agency)
        except Exception as e:
            log.exception("CPCB upsert failed for %r (station_id=%s)", cpcb_name, sid)
            errors.append(f"cpcb_upsert {cpcb_name}: {e}")

    log.info(
        "CPCB ingest: %d rows written, %d stations matched out of %d CPCB records, "
        "%d unmatched, %d errors",
        rows_written, len(covered), len(cpcb_by_station), len(unmatched), len(errors),
    )
    return rows_written, errors, covered, unmatched, station_ts, cpcb_by_station


def _recompute_24h_aqi(station_ts: dict[int, str]) -> int:
    """Recompute AQI for just-written rows using the time-weighted 24h average
    of concentrations, then patch the reading with the corrected value.

    WHY THIS IS NECESSARY
    ─────────────────────
    CPCB's AQI breakpoints are calibrated for 24h time-averaged concentrations.
    OpenAQ's latest values are hourly, so their AQI must come from a 24h
    average. This is used for the OpenAQ path only: CPCB/data.gov.in values
    are already 24h averages (published as sub-indices, converted in
    data_gov_cpcb), and averaging them again was a bug until Sept 2026.

    WHAT get_24h_avg_concentrations() NOW DOES (corrected methodology)
    ───────────────────────────────────────────────────────────────────
    1. Reads the station's true hourly means from readings_hourly (never the
       CPCB 24h-window rows or the provisional snapshots in `readings`), one
       value per UTC clock-hour, stuck analysers removed.
    2. Computes the 24h simple average across the clock-hour means (equal weight
       per hour of the day, matching CPCB's methodology).
    3. Applies the CPCB minimum data-availability rule: 16+ distinct hours for
       PM2.5/PM10/NO2/SO2/NH3; 6+ for O3/CO. Below these thresholds the pollutant
       is excluded from AQI (marked as absent, not 0) — same behaviour as CPCB's
       portal which shows "Insufficient Data" rather than an inflated AQI.
    Source: CPCB National AQI 2014 Technical Document, Appendix I."""
    if not station_ts:
        return 0
    avgs = db.get_24h_avg_concentrations(list(station_ts.keys()))
    patched = 0
    for sid, avg in avgs.items():
        ts = station_ts.get(sid)
        if ts is None:
            continue
        # readings_hourly.co is mg/m³, so avg["co"] goes straight to co_mg.
        corrected = aqi.compute_cpcb_aqi(
            avg.get("pm25"), avg.get("pm10"),
            no2=avg.get("no2"), so2=avg.get("so2"),
            o3=avg.get("o3"), co_mg=avg.get("co"),
            nh3=avg.get("nh3"),
        )
        if corrected is not None:
            try:
                db.set_reading_aqi(sid, ts, corrected)
                patched += 1
            except Exception:
                log.exception("24h AQI patch failed for station_id=%s ts=%s", sid, ts)
    log.info("24h AQI recompute: patched %d/%d stations", patched, len(station_ts))
    return patched


# ── OpenAQ: hourly values for every station; fallback rows for uncovered ones ─

# location -> {sensor_id: parameter}. Sensors change rarely, so caching this
# halves the OpenAQ calls per cycle (the key's 60/min limit is shared).
_SENSOR_CACHE: dict[int, tuple[float, dict]] = {}
_SENSOR_CACHE_TTL_S = 24 * 3600


# OpenAQ's /latest returns every sensor's LAST value, retired sensors
# included — e.g. 2016-2022 values from sensors replaced in 2025. Anything
# older than this is not a current reading (49 such rows had reached
# `readings` via the fallback before this guard, Sept 2026).
OPENAQ_MAX_LATEST_AGE_H = 72


def _openaq_sensors(openaq_location_id: int) -> tuple[dict, dict]:
    """-> ({sensor_id: parameter}, {sensor_id: unit label}), cached."""
    now = datetime.now(timezone.utc).timestamp()
    hit = _SENSOR_CACHE.get(openaq_location_id)
    if hit and now - hit[0] < _SENSOR_CACHE_TTL_S:
        return hit[1]
    loc = openaq.get_location(openaq_location_id)
    val = (loc["sensors"], loc.get("units") or {})
    _SENSOR_CACHE[openaq_location_id] = (now, val)
    return val


def _openaq_co_mg(value: float, unit: str | None) -> float:
    """CO in mg/m3 from an OpenAQ value, by the sensor's unit label.

    The Indian CPCB feed on OpenAQ labels its current gas sensors "ppb" but
    carries CPCB's native units: ug/m3 for NO2 (verified against CPCB,
    Sept 2026) and mg/m3 for CO (e.g. 0.81 at a Delhi station; 0.81 ppb of
    CO would be ~100x below global background). Older sensors labelled
    "µg/m³" do report ug/m3."""
    if unit == "µg/m³":
        return aqi.co_ug_to_mg(value)
    if unit == "ppm":
        return value * 1.145
    return value  # "ppb" (CPCB mislabel, really mg/m3) or "mg/m³"


def _ingest_station_openaq(station_id: int, openaq_location_id: int) -> tuple[int, dict[int, str]]:
    """Pull latest readings for one station via OpenAQ (fallback for a
    station CPCB did not cover this cycle). Real hourly means for EVERY
    station are written separately, by hourly_readings.sync().

    Returns (rows_upserted, {station_id: latest_ts}) so the caller can pass
    the ts map to _recompute_24h_aqi."""
    sensors, units = _openaq_sensors(openaq_location_id)
    latest = openaq.get_latest(openaq_location_id)
    oldest_ok = datetime.now(timezone.utc) - timedelta(hours=OPENAQ_MAX_LATEST_AGE_H)

    by_hour: dict[str, dict] = {}
    for m in latest:
        param = sensors.get(m["sensor_id"])
        col = openaq.PARAMS.get(param or "")
        if col is None or m["value"] is None or m["value"] < 0:
            continue
        if datetime.fromisoformat(m["ts_utc"].replace("Z", "+00:00")) < oldest_ok:
            continue  # a retired sensor's last value, not a current reading
        # OpenAQ range validation — same limits as the CPCB path.
        # CO from OpenAQ is in µg/m³; convert limit to µg/m³ for comparison.
        if col != "co" and col in _CONC_MAX_UGM3 and m["value"] > _CONC_MAX_UGM3[col]:
            log.warning(
                "OpenAQ out-of-range %s=%.1f µg/m³ for station_id=%s — dropped",
                col, m["value"], station_id,
            )
            continue
        value = m["value"]
        if col == "co":
            value = _openaq_co_mg(value, units.get(m["sensor_id"]))  # by_hour holds CO in mg/m³
            if value > _CO_MAX_MG:
                log.warning(
                    "OpenAQ out-of-range co=%.2f mg/m³ for station_id=%s — dropped",
                    value, station_id,
                )
                continue
        ts = _hour_floor_utc(m["ts_utc"])
        by_hour.setdefault(ts, {})[col] = value


    latest_ts: str | None = None
    for ts, values in by_hour.items():
        row = {"station_id": station_id, "ts": ts, "ingest_source": "openaq",
               "value_basis": "hourly", **values}
        # CO is already mg/m³ in by_hour (converted per sensor unit above);
        # compute_aqi and readings.co both expect mg/m³.
        co_mg = values.get("co")
        if co_mg is not None:
            row["co"] = co_mg
        else:
            row.pop("co", None)
        # No AQI here: one hour is not CPCB's 24h basis. _recompute_24h_aqi
        # sets it once 16+ hours of history exist; until then it stays null.
        db.upsert_reading(row)
        if latest_ts is None or ts > latest_ts:
            latest_ts = ts
    station_ts = {station_id: latest_ts} if latest_ts else {}
    return len(by_hour), station_ts


# ── Main entry point ──────────────────────────────────────────────────────────

def run() -> dict:
    """One full ingestion pass. CPCB/data.gov.in is the primary AQ source;
    OpenAQ runs only for stations that CPCB's name-match didn't cover (or
    when DATA_GOV_API_KEY is unset). Open-Meteo weather is independent.
    Safe to run every 15 minutes; all upserts are idempotent (station_id,ts).
    Caches (cpcb_by_station, match_index) in _last_cpcb_fetch so main.py can
    rebuild the live-display reconcile without a second data.gov.in call."""
    global _last_cpcb_fetch
    summary: dict = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "cpcb_rows_written": 0,
        "cpcb_unmatched_stations": [],
        "openaq_rows_written": 0,
        "openaq_stations_tried": 0,
        "weather_upserted": 0,
        "errors": [],
    }

    # ── CPCB primary pass ─────────────────────────────────────────────────────
    all_stations = db.get_all_stations()
    # Build external_ref -> station_id map for cheap OpenAQ dedup check below
    ref_to_sid: dict[str, int] = {
        s["external_ref"]: s["id"]
        for s in all_stations
        if s.get("external_ref")
    }
    match_index = station_matching.build_match_index(all_stations)

    cpcb_rows, cpcb_errors, cpcb_covered, cpcb_unmatched, cpcb_station_ts, cpcb_by_station = _ingest_from_cpcb(match_index)
    _last_cpcb_fetch = (cpcb_by_station, match_index)
    summary["cpcb_rows_written"] = cpcb_rows
    summary["cpcb_unmatched_stations"] = cpcb_unmatched
    summary["errors"].extend(cpcb_errors)

    # CPCB path: NO 24h recompute. data.gov.in's values were long assumed to
    # be short-window snapshots, and this step averaged 24h of them. They are
    # in fact sub-indices OF the trailing-24h mean (Sept 2026 finding, see
    # aqi.concentration_from_sub_index), so the recompute averaged an average
    # of index values read as concentrations: the stored AQI was in the wrong
    # category for ~45% of rows from 2026-08-11 until this fix. The AQI written
    # with each CPCB row above is already CPCB's own.
    summary["aqi_patched"] = 0

    # ── OpenAQ fallback ───────────────────────────────────────────────────────
    # Only runs when OPENAQ_API_KEY is set. Iterates over stations that have an
    # openaq_location_id (populated from stations.yaml via migration 20260812 —
    # the YAML is now retired; DB is the single source of truth). Skips any
    # station already covered by CPCB this cycle to avoid burning OpenAQ quota.
    # Real hourly values for every station come from hourly_readings.sync(),
    # scheduled separately (main.py), not from this fallback.
    openaq_station_ts: dict[int, str] = {}
    if config.OPENAQ_API_KEY:
        for station in all_stations:
            oa_id = station.get("openaq_location_id")
            if not oa_id:
                continue
            if station["id"] in cpcb_covered:
                continue
            summary["openaq_stations_tried"] += 1
            try:
                n, oa_ts = _ingest_station_openaq(station["id"], oa_id)
                summary["openaq_rows_written"] += n
                openaq_station_ts.update(oa_ts)
            except Exception as e:
                log.exception(
                    "OpenAQ fallback failed for station_id=%s openaq_id=%s",
                    station["id"], oa_id,
                )
                summary["errors"].append(f"openaq station_id={station['id']}: {e}")
        if openaq_station_ts:
            summary["aqi_patched"] += _recompute_24h_aqi(openaq_station_ts)
    else:
        log.info("OPENAQ_API_KEY not set — OpenAQ fallback skipped")

    summary["readings_upserted"] = summary["cpcb_rows_written"] + summary["openaq_rows_written"]

    # ── Weather (MET Norway via open_meteo.py; PBLH via Open-Meteo) ──────────
    # CORRECTION (Sept 2026): despite this function's name and the comment
    # that used to be here, get_current_batch() is NOT a real batched
    # request — MET Norway has no batch endpoint (see that function's own
    # doc comment), so it's a sequential loop of individual HTTP calls, one
    # per location, each with its own 15s timeout and no rate-limiting or
    # backoff. get_current_pblh() below adds a SECOND individual call per
    # ward on top of that.
    #
    # Bug fix (Sept 2026, direct request): this used to filter to only wards
    # with a real captured lat/lng — 13 of 265 — silently leaving the other
    # 252 with no weather row at all. That meant vayutrace_kernel.py's
    # boundary-centroid fallback (added the same session, for the SAME 252
    # wards) still fell back to a hardcoded calm-wind default (180°, 0 m/s)
    # for all of them, since get_latest_weather_by_ward() had nothing real
    # to return. Fixed by computing the same boundary-centroid fallback
    # here as the QUERY location for wards with no point — never writing a
    # fabricated lat/lng back to the ward row itself, only using it to ask
    # "what's the weather roughly here".
    #
    # REAL, ACCEPTED TRADEOFF (explicit go-ahead given, not defaulted into):
    # this takes the weather step from ~13 to up to ~265 wards, i.e. up to
    # ~530 sequential external HTTP calls per ingest cycle instead of ~26 —
    # meaningfully longer cycle time and real exposure to MET
    # Norway/Open-Meteo rate limits, with no protection against either
    # added here. If ingest cycles start timing out, running long, or
    # logging weather-batch errors/429s, this is the first place to look —
    # a per-call delay or a hard time budget for this whole step would be
    # the fix, not reverting the ward coverage.
    wards_all = db.get_wards()
    geo_wards: list[tuple[str, dict, float, float]] = []
    skipped_no_location = 0
    for name, ward in wards_all.items():
        if ward["lat"] is not None and ward["lng"] is not None:
            geo_wards.append((name, ward, ward["lat"], ward["lng"]))
            continue
        fallback = boundary_bbox_center(ward.get("boundary"))
        if fallback is None:
            skipped_no_location += 1
            continue
        flat, flng = fallback
        geo_wards.append((name, ward, flat, flng))
    if skipped_no_location:
        log.warning(
            "weather batch: %d/%d wards have neither a point nor a boundary — skipped",
            skipped_no_location, len(wards_all),
        )
    if geo_wards:
        try:
            locations = [(qlat, qlng) for _, _, qlat, qlng in geo_wards]
            weather_results = open_meteo.get_current_batch(locations)
            for (name, ward, qlat, qlng), w in zip(geo_wards, weather_results):
                # Bug fix (Sept 2026): get_current_batch() now isolates
                # per-location failures instead of raising and losing every
                # ward queued after the failure — see that function's own
                # updated doc comment. w is None for a ward whose individual
                # MET Norway call failed; skip just that ward, not the rest.
                if w is None:
                    continue
                # PBLH from Open-Meteo (separate API, degrades gracefully to None).
                # Literature: PBLH is the #1-5 PM2.5 predictor in IGP ML studies
                # (AMT 2019, JGR Atmospheres 2021, Aerosol Sci Tech 2025).
                pblh = open_meteo.get_current_pblh(qlat, qlng)
                wind_speed_ms = (w["wind_speed"] or 0.0) / 3.6  # km/h → m/s for VC
                vc = round(pblh * wind_speed_ms, 1) if pblh is not None else None
                db.upsert_weather(
                    {
                        "ward_id": ward["id"],
                        "ts": _hour_floor_utc(w["ts_utc"]),
                        "temp_c": w["temp_c"],
                        "humidity": w["humidity"],
                        "wind_speed": w["wind_speed"],
                        "wind_dir": w["wind_dir"],
                        "precipitation": w["precipitation"],
                        "pressure": w["pressure"],
                        "boundary_layer_height": pblh,
                        "ventilation_coefficient": vc,
                    }
                )
                summary["weather_upserted"] += 1
        except Exception as e:
            log.exception("batch weather fetch failed")
            summary["errors"].append(f"weather batch: {e}")

    summary["finished_at"] = datetime.now(timezone.utc).isoformat()
    log.info("ingest done: %s", summary)
    return summary
