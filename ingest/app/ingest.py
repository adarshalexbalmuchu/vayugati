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
) -> tuple[int, list[str], set[int], list[dict], dict[int, str]]:
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
        return 0, [msg], set(), [], {}

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
        row: dict = {"station_id": sid, "ts": ts_hour, "ingest_source": "cpcb"}
        for col in ("pm25", "pm10", "no2", "so2", "co", "o3", "nh3"):
            val = (pollutants.get(col) or {}).get("avg")
            if val is not None and val >= 0:
                row[col] = val

        if len(row) <= 2:
            continue  # only station_id + ts, no pollutant data — nothing to write

        # CO from CPCB data.gov.in is in mg/m³ (pollutant_unit = "MG/M3");
        # convert to mg/m³ defensively in case a rare record comes through as µg/m³.
        # NOTE: We intentionally write raw CO (mg/m³) into readings.co — NOT µg/m³.
        # get_24h_avg_concentrations() knows this and passes co directly as co_mg.
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

        # Snapshot AQI (current hour only) — stored initially, overwritten below
        # by the 24h-average AQI which matches CPCB's official methodology.
        computed_aqi = aqi.compute_aqi(
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
    The data.gov.in API's avg_value is a short-period snapshot (15 min–1 h),
    NOT a 24h average. Computing AQI from the snapshot produces values 1.5–3×
    higher than the CPCB portal's figure for the same station and time.

    WHAT get_24h_avg_concentrations() NOW DOES (corrected methodology)
    ───────────────────────────────────────────────────────────────────
    1. Groups all stored readings into one mean per UTC clock-hour (prevents
       daytime-heavy reporting bias — DPCC stations often go offline 11 PM–7 AM,
       and without hourly aggregation, daytime readings dominate the average).
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
        # readings.co is stored in mg/m³ for CPCB rows (see NOTE above);
        # get_24h_avg_concentrations() normalises OpenAQ µg/m³ rows to mg/m³,
        # so avg["co"] is always mg/m³ and goes straight to co_mg.
        corrected = aqi.compute_aqi(
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


# ── OpenAQ fallback (for stations CPCB didn't cover) ─────────────────────────

def _ingest_station_openaq(station_id: int, openaq_location_id: int) -> tuple[int, dict[int, str]]:
    """Pull latest readings for one station via OpenAQ.
    Returns (rows_upserted, {station_id: latest_ts}) so the caller can pass
    the ts map to _recompute_24h_aqi — same 24h rolling-average AQI correction
    that the CPCB path applies, for consistency across sources."""
    sensors = openaq.get_location(openaq_location_id)["sensors"]
    latest = openaq.get_latest(openaq_location_id)

    by_hour: dict[str, dict] = {}
    for m in latest:
        param = sensors.get(m["sensor_id"])
        col = openaq.PARAMS.get(param or "")
        if col is None or m["value"] is None or m["value"] < 0:
            continue
        # OpenAQ range validation — same limits as the CPCB path.
        # CO from OpenAQ is in µg/m³; convert limit to µg/m³ for comparison.
        if col in _CONC_MAX_UGM3 and m["value"] > _CONC_MAX_UGM3[col]:
            log.warning(
                "OpenAQ out-of-range %s=%.1f µg/m³ for station_id=%s — dropped",
                col, m["value"], station_id,
            )
            continue
        if col == "co":
            co_ug = m["value"]
            if aqi.co_ug_to_mg(co_ug) > _CO_MAX_MG:
                log.warning(
                    "OpenAQ out-of-range co=%.1f µg/m³ (%.2f mg/m³) for station_id=%s — dropped",
                    co_ug, aqi.co_ug_to_mg(co_ug), station_id,
                )
                continue
        ts = _hour_floor_utc(m["ts_utc"])
        by_hour.setdefault(ts, {})[col] = m["value"]

    latest_ts: str | None = None
    for ts, values in by_hour.items():
        row = {"station_id": station_id, "ts": ts, "ingest_source": "openaq", **values}
        # OpenAQ delivers CO in µg/m³; convert before passing to compute_aqi
        # which expects mg/m³. Omitting this makes CO=1000 µg/m³ read as
        # 1000 mg/m³ and peg AQI at 500 for every OpenAQ-sourced station.
        co_raw = values.get("co")
        co_mg = aqi.co_ug_to_mg(co_raw) if co_raw is not None else None
        computed_aqi = aqi.compute_aqi(
            values.get("pm25"), values.get("pm10"),
            no2=values.get("no2"), so2=values.get("so2"),
            o3=values.get("o3"), co_mg=co_mg,
            nh3=values.get("nh3"),
        )
        if computed_aqi is not None:
            row["aqi"] = computed_aqi
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

    # CPCB path: recompute AQI from the 24h rolling average of concentrations.
    # data.gov.in's avg_value is a short-window snapshot (hourly or few-hour),
    # not the 24h average that CPCB's official portal uses. Computing AQI from
    # the raw snapshot produces values 1.5–3× higher than the CPCB website.
    # _recompute_24h_aqi() averages the last 24 hourly DB readings per station
    # and overwrites the just-written AQI with the corrected value.
    summary["aqi_patched"] = _recompute_24h_aqi(cpcb_station_ts)

    # ── OpenAQ fallback ───────────────────────────────────────────────────────
    # Only runs when OPENAQ_API_KEY is set. Iterates over stations that have an
    # openaq_location_id (populated from stations.yaml via migration 20260812 —
    # the YAML is now retired; DB is the single source of truth). Skips any
    # station already covered by CPCB this cycle to avoid burning OpenAQ quota.
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

    # ── Open-Meteo weather (batch — one request for all wards) ───────────────
    # Sequential per-ward calls produced consistent 429s from Render's shared
    # egress IP even with 0.5s pauses. Open-Meteo accepts comma-separated
    # lat/lng arrays and returns results in the same order, so N wards = 1
    # request instead of N.
    wards_all = db.get_wards()
    geo_wards = [(name, ward) for name, ward in wards_all.items()
                 if ward["lat"] is not None and ward["lng"] is not None]
    if geo_wards:
        try:
            locations = [(ward["lat"], ward["lng"]) for _, ward in geo_wards]
            weather_results = open_meteo.get_current_batch(locations)
            for (name, ward), w in zip(geo_wards, weather_results):
                # PBLH from Open-Meteo (separate API, degrades gracefully to None).
                # Literature: PBLH is the #1-5 PM2.5 predictor in IGP ML studies
                # (AMT 2019, JGR Atmospheres 2021, Aerosol Sci Tech 2025).
                pblh = open_meteo.get_current_pblh(ward["lat"], ward["lng"])
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
