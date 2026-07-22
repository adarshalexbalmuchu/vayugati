"""Known inputs, checked outputs - latest_readings.py's reconciliation."""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.latest_readings import reconcile_latest  # noqa: E402
from app.station_matching import build_match_index  # noqa: E402

NOW = datetime(2026, 7, 22, 12, 0, tzinfo=timezone.utc)
FRESH = (NOW - timedelta(minutes=10)).isoformat()
STALE = (NOW - timedelta(hours=4)).isoformat()

STATION = {"id": 1, "name": "Narela, Delhi - DPCC", "ward_id": 1}


_DEFAULT_POLLUTANTS = {"pm25": {"avg": 90.0, "min": 80.0, "max": 100.0}, "pm10": {"avg": 150.0, "min": 140.0, "max": 160.0}}
_UNSET = object()


def cpcb_grouped(name="Narela, Delhi - DPCC", last_update=FRESH, pollutants=_UNSET):
    if pollutants is _UNSET:
        pollutants = _DEFAULT_POLLUTANTS
    return {name: {"station": name, "last_update": last_update, "lat": 28.85, "lng": 77.09, "pollutants": pollutants}}


def openaq_latest(ts=FRESH, aqi=180, pm25=90.0):
    return {1: {"ts": ts, "pm25": pm25, "pm10": 150.0, "no2": 40.0, "so2": None, "co": None, "o3": None, "aqi": aqi}}


class TestSourceSelection:
    def test_prefers_cpcb_when_matched_and_fresh(self):
        rows = reconcile_latest([STATION], cpcb_grouped(), build_match_index([STATION]), openaq_latest(), now=NOW)
        assert rows[0]["source_used"] == "cpcb"
        assert rows[0]["matched"] is True
        assert "fallback_used" not in rows[0]["flags"]

    def test_carries_ward_id_through_for_ward_keyed_frontend_lookups(self):
        rows = reconcile_latest([STATION], cpcb_grouped(), build_match_index([STATION]), openaq_latest(), now=NOW)
        assert rows[0]["ward_id"] == STATION["ward_id"]

    def test_falls_back_to_openaq_when_cpcb_stale(self):
        rows = reconcile_latest([STATION], cpcb_grouped(last_update=STALE), build_match_index([STATION]), openaq_latest(), now=NOW)
        assert rows[0]["source_used"] == "openaq_fallback"
        assert "cpcb_stale" in rows[0]["flags"]
        assert "fallback_used" in rows[0]["flags"]

    def test_falls_back_when_unmatched(self):
        rows = reconcile_latest([STATION], cpcb_grouped(name="Some Other Station, Delhi - DPCC"), build_match_index([STATION]), openaq_latest(), now=NOW)
        assert rows[0]["source_used"] == "openaq_fallback"
        assert rows[0]["matched"] is False
        assert "unmatched" in rows[0]["flags"]

    def test_falls_back_when_cpcb_has_no_recognized_pollutants(self):
        rows = reconcile_latest([STATION], cpcb_grouped(pollutants={}), build_match_index([STATION]), openaq_latest(), now=NOW)
        assert rows[0]["source_used"] == "openaq_fallback"
        assert rows[0]["matched"] is True
        assert "cpcb_missing" in rows[0]["flags"]

    def test_flags_openaq_stale_independently_of_source_used(self):
        rows = reconcile_latest([STATION], cpcb_grouped(), build_match_index([STATION]), openaq_latest(ts=STALE), now=NOW)
        assert rows[0]["source_used"] == "cpcb"  # CPCB still wins even though OpenAQ happens to be stale
        assert "openaq_stale" in rows[0]["flags"]

    def test_flags_openaq_stale_when_no_openaq_reading_at_all(self):
        rows = reconcile_latest([STATION], cpcb_grouped(), build_match_index([STATION]), {}, now=NOW)
        assert "openaq_stale" in rows[0]["flags"]
        assert rows[0]["openaq_last_update"] is None


class TestAqiAndMismatch:
    def test_computes_cpcb_aqi_from_pm25_pm10_via_shared_breakpoint_logic(self):
        rows = reconcile_latest([STATION], cpcb_grouped(), build_match_index([STATION]), openaq_latest(), now=NOW)
        # Same aqi.compute_aqi(pm25=90, pm10=150) the app uses everywhere else:
        # pm25 sub-index 200, pm10 sub-index 134, max wins.
        assert rows[0]["cpcb_aqi"] == 200

    def test_no_cpcb_aqi_when_falling_back(self):
        rows = reconcile_latest([STATION], cpcb_grouped(last_update=STALE), build_match_index([STATION]), openaq_latest(), now=NOW)
        assert rows[0]["cpcb_aqi"] is None

    def test_flags_value_mismatch_when_aqis_diverge_sharply(self):
        rows = reconcile_latest([STATION], cpcb_grouped(), build_match_index([STATION]), openaq_latest(aqi=20), now=NOW)
        assert "value_mismatch" in rows[0]["flags"]

    def test_does_not_flag_value_mismatch_for_close_readings(self):
        # cpcb_aqi is 200 (see the AQI test above) - 20 points off is well
        # within the 50-point threshold.
        rows = reconcile_latest([STATION], cpcb_grouped(), build_match_index([STATION]), openaq_latest(aqi=220), now=NOW)
        assert "value_mismatch" not in rows[0]["flags"]


class TestCpcbTimestampFormat:
    """data.gov.in's real feed uses "DD-MM-YYYY HH:MM:SS" in IST, not ISO
    8601 - confirmed live during this integration (see latest_readings.py's
    own comment on _age_minutes). NOW = 2026-07-22 12:00 UTC = 17:30 IST."""

    def test_recent_cpcb_style_timestamp_is_not_treated_as_stale(self):
        rows = reconcile_latest([STATION], cpcb_grouped(last_update="22-07-2026 17:20:00"), build_match_index([STATION]), openaq_latest(), now=NOW)
        assert rows[0]["source_used"] == "cpcb"
        assert "cpcb_stale" not in rows[0]["flags"]

    def test_old_cpcb_style_timestamp_is_treated_as_stale(self):
        rows = reconcile_latest([STATION], cpcb_grouped(last_update="22-07-2026 12:00:00"), build_match_index([STATION]), openaq_latest(), now=NOW)
        # 12:00 IST is 5.5h before 17:30 IST "now" - well past the 180-minute cutoff
        assert "cpcb_stale" in rows[0]["flags"]
        assert rows[0]["source_used"] == "openaq_fallback"

    def test_unparseable_timestamp_is_treated_as_stale_not_a_crash(self):
        rows = reconcile_latest([STATION], cpcb_grouped(last_update="not a real timestamp"), build_match_index([STATION]), openaq_latest(), now=NOW)
        assert "cpcb_stale" in rows[0]["flags"]
        assert rows[0]["source_used"] == "openaq_fallback"


class TestNeverDropsOurOwnStations:
    def test_every_one_of_our_stations_gets_a_row_even_with_no_cpcb_data_at_all(self):
        rows = reconcile_latest([STATION], {}, build_match_index([STATION]), openaq_latest(), now=NOW)
        assert len(rows) == 1
        assert rows[0]["station_id"] == 1
        assert rows[0]["source_used"] == "openaq_fallback"

    def test_returns_one_row_per_input_station_never_a_cpcb_only_row(self):
        # A CPCB station with no corresponding entry in our_stations must
        # never produce an output row - only OUR stations are ever rows.
        cpcb = cpcb_grouped()
        cpcb["Some Untracked Station, Delhi - IITM"] = {"station": "Some Untracked Station, Delhi - IITM", "last_update": FRESH, "lat": None, "lng": None, "pollutants": {"pm25": {"avg": 50.0, "min": None, "max": None}}}
        rows = reconcile_latest([STATION], cpcb, build_match_index([STATION]), openaq_latest(), now=NOW)
        assert len(rows) == 1
