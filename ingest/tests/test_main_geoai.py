"""Rate-limiting and request-validation tests for /geoai/query's supporting
code in app/main.py. Imports app.main directly (safe - main.py only starts
its background scheduler inside the FastAPI lifespan, which a bare import
never triggers) rather than a full TestClient/HTTP layer, matching this
suite's existing convention of testing modules directly."""

import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import main  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_geoai_rate_limit_state():
    """Each test gets a clean rate-limit slate - these are module-level
    globals shared across the whole process, same pattern the real service
    uses, but tests must not leak state into each other."""
    main._geoai_calls_by_ip.clear()
    main._geoai_global_calls.clear()
    yield
    main._geoai_calls_by_ip.clear()
    main._geoai_global_calls.clear()


def test_rate_limit_allows_calls_under_the_per_ip_limit():
    for _ in range(main._GEOAI_PER_IP_LIMIT):
        main._check_geoai_rate_limit("1.2.3.4")  # should not raise


def test_rate_limit_blocks_after_per_ip_limit():
    for _ in range(main._GEOAI_PER_IP_LIMIT):
        main._check_geoai_rate_limit("1.2.3.4")
    with pytest.raises(main.HTTPException) as exc_info:
        main._check_geoai_rate_limit("1.2.3.4")
    assert exc_info.value.status_code == 429
    assert int(exc_info.value.headers["Retry-After"]) > 0


def test_rate_limit_is_per_ip_not_shared():
    for _ in range(main._GEOAI_PER_IP_LIMIT):
        main._check_geoai_rate_limit("1.2.3.4")
    main._check_geoai_rate_limit("5.6.7.8")  # a different IP has its own budget - should not raise


def test_rate_limit_blocks_after_global_ceiling():
    # Exhaust the global ceiling using many distinct IPs, each well under
    # their own per-IP limit, to isolate the global check from the per-IP one.
    for i in range(main._GEOAI_GLOBAL_LIMIT):
        main._check_geoai_rate_limit(f"10.0.0.{i % 250}.{i}")
    with pytest.raises(main.HTTPException) as exc_info:
        main._check_geoai_rate_limit("9.9.9.9")
    assert exc_info.value.status_code == 429


def test_retry_after_is_computed_not_hardcoded():
    """A prior review flagged a hardcoded Retry-After: 60 as inaccurate for
    a 20-per-hour limit - confirm it now reflects the real window instead."""
    for _ in range(main._GEOAI_PER_IP_LIMIT):
        main._check_geoai_rate_limit("1.2.3.4")
    with pytest.raises(main.HTTPException) as exc_info:
        main._check_geoai_rate_limit("1.2.3.4")
    retry_after = int(exc_info.value.headers["Retry-After"])
    # Should be close to the full per-IP window (just filled), not a fixed 60s.
    assert retry_after > 60


def test_stale_ip_entries_are_pruned():
    """A prior review flagged unbounded dict growth - simulate an IP whose
    calls have all aged out and confirm its entry is removed rather than
    kept forever."""
    main._geoai_calls_by_ip["1.2.3.4"] = [0.0]  # a call from the epoch - long expired
    main._check_geoai_rate_limit("5.6.7.8")
    assert "1.2.3.4" not in main._geoai_calls_by_ip


def test_geoai_request_rejects_oversized_question():
    with pytest.raises(ValidationError):
        main.GeoAiRequest(question="a" * 501, entities=[])


def test_geoai_request_rejects_oversized_entity_list():
    entities = [{"type": "ward", "id": str(i), "name": "x"} for i in range(501)]
    with pytest.raises(ValidationError):
        main.GeoAiRequest(question="test", entities=entities)


def test_geoai_request_accepts_valid_payload():
    req = main.GeoAiRequest(question="wards near Anand Vihar", entities=[{"type": "ward", "id": "1", "name": "Anand Vihar"}])
    assert req.question == "wards near Anand Vihar"
    assert req.entities[0].type == "ward"
