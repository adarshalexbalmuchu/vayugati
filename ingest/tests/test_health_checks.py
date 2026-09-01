"""Phase 10 /health computation tests — fully mocked db.client(), no live
Supabase. Proves the three real states plan §9 asks for: ok, degraded (a
dependency partially unavailable), and down (database itself unreachable)."""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import health_checks  # noqa: E402


class _Query:
    def __init__(self, data=None, error=None):
        self._data = data
        self._error = error

    def select(self, *a, **k):
        return self

    def order(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def execute(self):
        if self._error:
            raise self._error
        return type("R", (), {"data": self._data})()


class _FakeClient:
    def __init__(self, readings=None, wards_error=None, health_rows=None, health_error=None):
        self._readings = readings
        self._wards_error = wards_error
        self._health_rows = health_rows
        self._health_error = health_error

    def table(self, name):
        if name == "readings":
            return _Query(data=self._readings)
        if name == "wards":
            if self._wards_error:
                return _Query(error=self._wards_error)
            return _Query(data=[])
        raise AssertionError(f"unexpected table {name}")

    def rpc(self, name, params):
        if self._health_error:
            raise self._health_error
        return type("R", (), {"execute": lambda self=None: type("R2", (), {"data": self.data if hasattr(self, "data") else None})()})()


def test_status_ok_when_everything_is_fresh(monkeypatch):
    now = datetime.now(timezone.utc)
    fake = _FakeClient(readings=[{"ts": now.isoformat()}])
    monkeypatch.setattr(health_checks.db, "client", lambda: fake)
    monkeypatch.setattr(health_checks, "_job_health", lambda: {"forecast": {"status": "ok"}})
    # _osm_pbf() checks a real file on disk (OSM_PBF_PATH) that doesn't exist
    # in a test/CI environment — unmocked, it correctly reports "missing" and
    # degrades "everything is fresh" for a reason unrelated to what this test
    # is actually about.
    monkeypatch.setattr(health_checks, "_osm_pbf", lambda: {"status": "ok", "size_mb": 222})

    result = health_checks.compute_health()

    assert result["status"] == "ok"
    assert result["checks"]["database"]["status"] == "ok"
    assert result["checks"]["reading_freshness"]["status"] == "ok"


def test_status_degraded_when_readings_are_stale(monkeypatch):
    old = datetime.now(timezone.utc) - timedelta(hours=6)
    fake = _FakeClient(readings=[{"ts": old.isoformat()}])
    monkeypatch.setattr(health_checks.db, "client", lambda: fake)
    monkeypatch.setattr(health_checks, "_job_health", lambda: {})

    result = health_checks.compute_health()

    assert result["status"] == "degraded"
    assert result["checks"]["reading_freshness"]["status"] == "stale"


def test_status_degraded_when_a_job_is_stale_even_if_readings_are_fresh(monkeypatch):
    now = datetime.now(timezone.utc)
    fake = _FakeClient(readings=[{"ts": now.isoformat()}])
    monkeypatch.setattr(health_checks.db, "client", lambda: fake)
    monkeypatch.setattr(health_checks, "_job_health", lambda: {"notifications": {"status": "stale"}})

    result = health_checks.compute_health()

    assert result["status"] == "degraded"


def test_status_down_when_database_is_unreachable(monkeypatch):
    fake = _FakeClient(wards_error=ConnectionError("no route to host"))
    monkeypatch.setattr(health_checks.db, "client", lambda: fake)
    monkeypatch.setattr(health_checks, "_job_health", lambda: {})

    result = health_checks.compute_health()

    assert result["status"] == "down"
    assert result["checks"]["database"]["status"] == "down"


def test_status_no_data_when_there_are_no_readings_at_all(monkeypatch):
    fake = _FakeClient(readings=[])
    monkeypatch.setattr(health_checks.db, "client", lambda: fake)
    monkeypatch.setattr(health_checks, "_job_health", lambda: {})

    result = health_checks.compute_health()

    assert result["checks"]["reading_freshness"]["status"] == "no_data"
