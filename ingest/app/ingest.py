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

# IST offset for parsing CPCB's 'DD-MM-YYYY HH:MM:SS' last_update strings.
# The same constant appears in latest_readings.py — one source of truth for
# the IST convention that CPCB's live feed uses.
_IST = timezone(timedelta(hours=5, minutes=30))


def _hour_floor_utc(ts_iso: str) -> str:
    dt = datetime.fromisoformat(ts_iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    return dt.replace(minute=0, second=0, microsecond=0).isoformat()


def _parse_cpcb_agency(cpcb_name: str) -> str | None:
    """Extract monitoring agency from a CPCB station-name suffix.
    'Anand Vihar, Delhi - DPCC' -> 'DPCC'
    Returns None when no '- ' suffix is present."""
    if " - " in cpcb_name:
        suffix = cpcb_name.rsplit(" - ", 1)[-1].strip().upper()
        return suffix or None
    return None


def _parse_cpcb_ts(ts_str: str) -> str | None:
    """Parse CPCB's 'DD-MM-YYYY HH:MM:SS' IST string -> UTC ISO hour floor.
    Returns None on any parse failure rather than raising."""
    try:
        dt = datetime.strptime(ts_str, "%d-%m-%Y %H:%M:%S").replace(tzinfo=_IST)
        return dt.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0).isoformat()
    except (ValueError, TypeError):
        return None


def _ingest_from_cpcb(match_index: dict[str, int]) -> tuple[int, list[str], set[int]]:
    """Fetch CPCB/data.gov.in latest readings and write matched ones to Supabase.

    One API call per cycle returns all Delhi stations — no per-station loop,
    no per-month quota. Returns (rows_written, errors, station_ids_covered) so
    the caller knows which stations the OpenAQ fallback can skip."""
    records = data_gov_cpcb.fetch_delhi_records()
    if records is None:
        msg = "CPCB fetch returned None — DATA_GOV_API_KEY unset or API unavailable"
        log.warning(msg)
        return 0, [msg], set()

    cpcb_by_station = data_gov_cpcb.group_by_station(records)
    rows_written = 0
    errors: list[str] = []
    covered: set[int] = set()
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
            continue  # CPCB station not in our monitored set — skip

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
        row: dict = {"station_id": sid, "ts": ts_hour}
        for col in ("pm25", "pm10", "no2", "so2", "co", "o3"):
            val = (pollutants.get(col) or {}).get("avg")
            if val is not None and val >= 0:
                row[col] = val

        if len(row) <= 2:
            continue  # only station_id + ts, no pollutant data — nothing to write

        computed_aqi = aqi.compute_aqi(
            row.get("pm25"), row.get("pm10"),
            no2=row.get("no2"), so2=row.get("so2"),
            o3=row.get("o3"),
        )
        if computed_aqi is not None:
            row["aqi"] = computed_aqi

        try:
            db.upsert_reading(row)
            covered.add(sid)
            rows_written += 1
            agency = _parse_cpcb_agency(cpcb_name)
            if agency:
                db.set_station_agency(sid, agency)
        except Exception as e:
            log.exception("CPCB upsert failed for %r (station_id=%s)", cpcb_name, sid)
            errors.append(f"cpcb_upsert {cpcb_name}: {e}")

    log.info(
        "CPCB ingest: %d rows written, %d stations matched out of %d CPCB records, %d errors",
        rows_written, len(covered), len(cpcb_by_station), len(errors),
    )
    return rows_written, errors, covered


# ── OpenAQ fallback (for stations CPCB didn't cover) ─────────────────────────

def _ensure_station_openaq(entry: dict, wards: dict[str, dict]) -> int | None:
    """Find or create the stations row for an OpenAQ-configured station."""
    ref = str(entry["openaq_location_id"])
    existing = db.get_station_by_ref(ref)
    if existing:
        return existing["id"]

    ward = wards.get(entry["ward"])
    if ward is None:
        log.error("ward %r not found in wards table, skipping station %s", entry["ward"], ref)
        return None

    meta = openaq.get_location(entry["openaq_location_id"])
    created = db.insert_station(ward["id"], meta["name"], ref, meta["lat"], meta["lng"])
    log.info("registered station %s (%s) for ward %s", meta["name"], ref, entry["ward"])
    return created["id"]


def _ingest_station_openaq(entry: dict, wards: dict[str, dict]) -> int:
    """Pull latest readings for one station via OpenAQ. Returns rows upserted."""
    station_id = _ensure_station_openaq(entry, wards)
    if station_id is None:
        return 0

    sensors = openaq.get_location(entry["openaq_location_id"])["sensors"]
    latest = openaq.get_latest(entry["openaq_location_id"])

    by_hour: dict[str, dict] = {}
    for m in latest:
        param = sensors.get(m["sensor_id"])
        col = openaq.PARAMS.get(param or "")
        if col is None or m["value"] is None or m["value"] < 0:
            continue
        ts = _hour_floor_utc(m["ts_utc"])
        by_hour.setdefault(ts, {})[col] = m["value"]

    for ts, values in by_hour.items():
        row = {"station_id": station_id, "ts": ts, **values}
        computed_aqi = aqi.compute_aqi(
            values.get("pm25"), values.get("pm10"),
            no2=values.get("no2"), so2=values.get("so2"),
            o3=values.get("o3"),
        )
        if computed_aqi is not None:
            row["aqi"] = computed_aqi
        db.upsert_reading(row)
    return len(by_hour)


# ── Main entry point ──────────────────────────────────────────────────────────

def run() -> dict:
    """One full ingestion pass. CPCB/data.gov.in is the primary AQ source;
    OpenAQ runs only for stations that CPCB's name-match didn't cover (or
    when DATA_GOV_API_KEY is unset). Open-Meteo weather is independent.
    Safe to run every hour; all upserts are idempotent."""
    summary: dict = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "cpcb_rows_written": 0,
        "openaq_rows_written": 0,
        "openaq_stations_tried": 0,
        "stations_skipped_no_id": [],
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

    cpcb_rows, cpcb_errors, cpcb_covered = _ingest_from_cpcb(match_index)
    summary["cpcb_rows_written"] = cpcb_rows
    summary["errors"].extend(cpcb_errors)

    # ── OpenAQ fallback ───────────────────────────────────────────────────────
    # Only runs when OPENAQ_API_KEY is set, and only for stations that CPCB's
    # name-match didn't cover — avoids burning quota on stations already written.
    if config.OPENAQ_API_KEY:
        stations_cfg = config.load_stations()
        wards = db.get_wards()
        for entry in stations_cfg:
            if not entry.get("openaq_location_id"):
                if not entry.get("known_no_station"):
                    summary["stations_skipped_no_id"].append(entry["ward"])
                continue
            # Skip if CPCB already wrote a reading for this station this cycle
            sid = ref_to_sid.get(str(entry["openaq_location_id"]))
            if sid and sid in cpcb_covered:
                continue
            summary["openaq_stations_tried"] += 1
            try:
                n = _ingest_station_openaq(entry, wards)
                summary["openaq_rows_written"] += n
            except Exception as e:
                log.exception("OpenAQ fallback failed for ward %s", entry["ward"])
                summary["errors"].append(f"openaq {entry['ward']}: {e}")
        if summary["stations_skipped_no_id"]:
            log.warning(
                "no openaq_location_id configured for: %s — fill stations.yaml",
                ", ".join(summary["stations_skipped_no_id"]),
            )
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
                    }
                )
                summary["weather_upserted"] += 1
        except Exception as e:
            log.exception("batch weather fetch failed")
            summary["errors"].append(f"weather batch: {e}")

    summary["finished_at"] = datetime.now(timezone.utc).isoformat()
    log.info("ingest done: %s", summary)
    return summary
