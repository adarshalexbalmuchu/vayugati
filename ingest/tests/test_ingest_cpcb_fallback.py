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
