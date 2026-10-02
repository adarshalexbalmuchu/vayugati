"""ward_estimates: c x N x R_w with an honest 90% range."""

from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from app import ward_estimates as we

MODEL = {"model_version": "test", "ward_ids": [1, 2],
         "species": {"pm25": {"log_ratio": [0.0, float(np.log(1.5))], "range_factor_90": 2.0,
                              "network_calibration": 0.9}}}


def _rows(n_stations=3, hours=24, value=40.0, end=datetime(2026, 9, 24, 12, tzinfo=timezone.utc)):
    # a daily cycle that averages to value + s over 24 h (a flat day would be read as a stuck analyser)
    return [{"station_id": s, "ts": (end - timedelta(hours=h + 1)).isoformat(),
             "pm25": value + s + 10 * np.sin(2 * np.pi * h / 24), "no2": None}
            for s in range(n_stations) for h in range(hours)]


def test_estimate_is_calibrated_network_times_ward_ratio_with_range():
    out = we.compute(_rows(), MODEL)
    by = {r["ward_id"]: r for r in out}
    N = np.mean([40, 41, 42])
    assert by[1]["estimate"] == pytest.approx(0.9 * N, abs=0.2)
    assert by[2]["estimate"] == pytest.approx(0.9 * N * 1.5, abs=0.2)
    assert by[2]["lower_90"] == pytest.approx(round(by[2]["estimate"] / 2, 1), abs=0.2)
    assert by[2]["upper_90"] == pytest.approx(round(by[2]["estimate"] * 2, 1), abs=0.2)
    assert by[1]["n_stations"] == 3 and by[1]["window_hours"] == 24


def test_too_few_full_days_skips_the_pollutant():
    assert we.compute(_rows(n_stations=2), MODEL) == []           # < 3 stations
    assert we.compute(_rows(hours=12), MODEL) == []               # < 18 h each


def test_window_ends_at_newest_hour_so_outages_date_the_estimate():
    out = we.compute(_rows(), MODEL)
    assert out[0]["window_end"] == datetime(2026, 9, 24, 12, tzinfo=timezone.utc).isoformat()


def test_exported_model_file_is_consistent():
    m = we._load()
    assert len(m["ward_ids"]) == 265
    for sp, v in m["species"].items():
        assert len(v["log_ratio"]) == len(m["ward_ids"]) and v["range_factor_90"] > 1
        assert 0.5 < v["network_calibration"] < 1.5


def test_stuck_station_is_left_out_of_the_network():
    end = datetime(2026, 9, 24, 12, tzinfo=timezone.utc)
    rows = _rows(end=end) + [{"station_id": 9, "ts": (end - timedelta(hours=h + 1)).isoformat(),
                              "pm25": 1.0, "no2": None} for h in range(24)]
    by = {r["ward_id"]: r for r in we.compute(rows, MODEL)}
    assert by[1]["n_stations"] == 3
    assert by[1]["estimate"] == pytest.approx(0.9 * np.mean([40, 41, 42]), abs=0.2)
