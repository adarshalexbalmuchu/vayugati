"""Regression test: a CPCB outage must degrade, not crash.

Sept 2026 incident. data.gov.in began returning HTTP 502, so
data_gov_cpcb.fetch_delhi_records() returned None. _ingest_from_cpcb's
early-return path for that case returned FIVE values while its success
path and its caller in run() both used SIX, so every ingest cycle died
with "not enough values to unpack (expected 6, got 5)".

The effect was badly disproportionate to the cause: a recoverable
upstream outage became a hard job failure every 15 minutes for ~25 hours,
readings went stale, and the entire UI dropped into its stale-data state
(blank AQI badges, no forecasts, uncoloured map) — which looked like a
frontend fault and was not.

The OpenAQ fallback exists precisely so a CPCB outage is survivable. This
test pins the arity contract that lets it be reached.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import ingest  # noqa: E402


def test_cpcb_fetch_failure_returns_the_full_six_tuple(monkeypatch):
    """The outage path must match the success path's arity exactly."""
    monkeypatch.setattr(ingest.data_gov_cpcb, "fetch_delhi_records", lambda: None)

    result = ingest._ingest_from_cpcb({})

    assert len(result) == 6, (
        f"CPCB failure path returned {len(result)} values; run() unpacks 6. "
        "This is the exact mismatch that crashed ingest for ~25h."
    )


def test_cpcb_fetch_failure_unpacks_the_way_run_does(monkeypatch):
    """Unpack exactly as run() does, so the real call site is exercised
    rather than just the length."""
    monkeypatch.setattr(ingest.data_gov_cpcb, "fetch_delhi_records", lambda: None)

    rows, errors, covered, unmatched, station_ts, by_station = ingest._ingest_from_cpcb({})

    assert rows == 0
    assert errors and "CPCB fetch returned None" in errors[0]
    # Empty-but-correct types, so downstream code degrades instead of
    # tripping over a None.
    assert covered == set()
    assert unmatched == []
    assert station_ts == {}
    assert by_station == {}


def test_cpcb_sub_indices_are_stored_as_concentrations_with_cpcb_aqi(monkeypatch):
    """Sept 2026 finding: data.gov.in publishes sub-indices. The stored row
    must hold concentrations, and its AQI must be the max published sub-index
    (CPCB's own AQI), not an index-of-an-index."""
    records = [
        {"station": "ITO, Delhi - CPCB", "last_update": "24-09-2026 10:00:00",
         "latitude": "28.63", "longitude": "77.24", "pollutant_id": pid,
         "avg_value": str(v), "min_value": "NA", "max_value": "NA"}
        for pid, v in (("PM2.5", 150), ("PM10", 120), ("NO2", 25), ("CO", 47))
    ]
    monkeypatch.setattr(ingest.data_gov_cpcb, "fetch_delhi_records", lambda: records)
    monkeypatch.setattr(ingest.station_matching, "match_station", lambda name, idx: 7)
    monkeypatch.setattr(ingest.db, "set_station_agency", lambda *a: None)
    written = []
    monkeypatch.setattr(ingest.db, "upsert_reading", lambda row: written.append(row))

    rows, errors, covered, _, _, _ = ingest._ingest_from_cpcb({})

    assert rows == 1 and not errors and covered == {7}
    row = written[0]
    assert row["pm25"] == 75.0          # index 150 -> 75 ug/m3 (60-90 bucket), not 150
    assert row["no2"] == 20.0           # index 25 -> 20 ug/m3
    assert abs(row["co"] - 0.94) < 1e-9  # mg/m3, not 0.047
    assert row["aqi"] == 150            # = max published sub-index


def test_run_does_not_re_average_cpcb_rows(monkeypatch):
    """CPCB values are already 24h means; the 24h recompute must not see them.
    run() is stopped at the first log line after the CPCB stage (OpenAQ
    disabled), so no later stage touches the network."""
    class _Stop(Exception):
        pass

    class _Log:
        def info(self, msg, *a):
            if msg.startswith("OPENAQ_API_KEY not set"):
                raise _Stop
        warning = exception = debug = error = lambda self, *a, **k: None

    seen = []
    monkeypatch.setattr(ingest, "log", _Log())
    monkeypatch.setattr(ingest, "_recompute_24h_aqi", lambda ts: seen.append(dict(ts)) or 0)
    monkeypatch.setattr(ingest, "_ingest_from_cpcb",
                        lambda idx: (1, [], {7}, [], {7: "2026-09-24T04:30:00+00:00"}, {}))
    monkeypatch.setattr(ingest.db, "get_all_stations", lambda: [])
    monkeypatch.setattr(ingest.config, "OPENAQ_API_KEY", "")

    try:
        ingest.run()
    except _Stop:
        pass
    assert seen == []
