"""hourly_readings: real hourly means from OpenAQ's archive -> readings_hourly."""

from datetime import datetime, timedelta, timezone

from app import hourly_readings as hr


def _setup(monkeypatch, latest, hours_by_sensor, units):
    monkeypatch.setattr(hr, "SECONDS_PER_CALL", 0)
    monkeypatch.setattr(hr.db, "get_all_stations", lambda: [{"id": 7, "openaq_location_id": 99},
                                                            {"id": 8, "openaq_location_id": None}])
    monkeypatch.setattr(hr.openaq, "get_location", lambda lid: {
        "sensors": {1: "no2", 2: "co", 3: "pm25"}, "units": units})
    monkeypatch.setattr(hr.openaq, "get_latest", lambda lid: latest)
    monkeypatch.setattr(hr.openaq, "get_sensor_hours", lambda sid, a, b: hours_by_sensor.get(sid, []))
    written = []
    monkeypatch.setattr(hr.db, "upsert_readings_hourly", lambda rows: written.extend(rows))
    return written


def _z(hours_ago):
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:00:00Z")


def test_sync_writes_hourly_means_merged_per_hour_with_units(monkeypatch):
    t = _z(2)
    written = _setup(monkeypatch,
                     latest=[{"sensor_id": 1, "ts_utc": _z(1), "value": 1}, {"sensor_id": 2, "ts_utc": _z(1), "value": 1}],
                     hours_by_sensor={1: [{"value": 30.0, "ts_utc": t}], 2: [{"value": 0.9, "ts_utc": t}]},
                     units={1: "ppb", 2: "ppb"})
    s = hr.sync(hours_back=6)
    assert s["stations"] == 1 and not s["errors"]
    iso = datetime.fromisoformat(t.replace("Z", "+00:00")).isoformat()
    assert written == [{"station_id": 7, "ts": iso, "no2": 30.0, "co": 0.9}]   # 'ppb' CO is mg/m3


def test_retired_sensors_are_not_fetched(monkeypatch):
    fetched = []
    written = _setup(monkeypatch,
                     latest=[{"sensor_id": 1, "ts_utc": _z(1), "value": 1},
                             {"sensor_id": 3, "ts_utc": "2018-02-21T20:45:00Z", "value": 1}],
                     hours_by_sensor={}, units={})
    monkeypatch.setattr(hr.openaq, "get_sensor_hours", lambda sid, a, b: fetched.append(sid) or [])
    hr.sync()
    assert fetched == [1] and written == []


def test_out_of_range_and_negative_values_dropped(monkeypatch):
    t = _z(2)
    written = _setup(monkeypatch,
                     latest=[{"sensor_id": 3, "ts_utc": _z(1), "value": 1}, {"sensor_id": 2, "ts_utc": _z(1), "value": 1}],
                     hours_by_sensor={3: [{"value": -1, "ts_utc": t}, {"value": 5000.0, "ts_utc": _z(3)}],
                                      2: [{"value": 1500.0, "ts_utc": t}]},
                     units={2: "µg/m³"})
    hr.sync()
    assert written == [{"station_id": 7, "ts": datetime.fromisoformat(t.replace("Z", "+00:00")).isoformat(), "co": 1.5}]


def test_one_station_failure_does_not_stop_the_rest(monkeypatch):
    _setup(monkeypatch, latest=[], hours_by_sensor={}, units={})
    monkeypatch.setattr(hr.db, "get_all_stations", lambda: [{"id": 7, "openaq_location_id": 99},
                                                            {"id": 9, "openaq_location_id": 98}])
    def boom(lid):
        if lid == 99:
            raise RuntimeError("x")
        return {"sensors": {}, "units": {}}
    monkeypatch.setattr(hr.openaq, "get_location", boom)
    s = hr.sync()
    assert s["stations"] == 1 and len(s["errors"]) == 1


def test_upsert_batches_by_column_set_so_nothing_is_nulled(monkeypatch):
    from app import db
    sent = []

    class _T:
        def upsert(self, batch, on_conflict):
            sent.append([sorted(r) for r in batch]); return self
        def execute(self):
            return self

    class _C:
        def table(self, name):
            assert name == "readings_hourly"; return _T()

    monkeypatch.setattr(db, "client", lambda: _C())
    db.upsert_readings_hourly([
        {"station_id": 1, "ts": "a", "no2": 1.0},
        {"station_id": 1, "ts": "b", "no2": 2.0, "co": 0.5},
        {"station_id": 1, "ts": "c", "no2": 3.0}])
    assert len(sent) == 2
    for batch in sent:
        assert len({tuple(r) for r in batch}) == 1   # one column set per request


def test_paced_retries_once_on_network_error(monkeypatch):
    import httpx
    monkeypatch.setattr(hr, "SECONDS_PER_CALL", 0)
    monkeypatch.setattr(hr.time, "sleep", lambda s: None)
    calls = []
    def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectError("tls reset")
        return "ok"
    assert hr._paced(flaky) == "ok" and len(calls) == 2
