"""stuck_sensors: flat trailing days from stuck analysers are dropped."""

from datetime import datetime, timedelta, timezone

import numpy as np

from app import stuck_sensors as ss

END = datetime(2026, 9, 24, 12, tzinfo=timezone.utc)


def _series(values, station=1, pollutant="no2"):
    n = len(values)
    return [{"station_id": station, "ts": (END - timedelta(hours=n - 1 - i)).isoformat(), pollutant: v}
            for i, v in enumerate(values)]


def test_jittering_flat_day_is_dropped():
    # beats the identical-consecutive-hours test: never the same value twice in a row
    vals = [25.0 + (0.1 if i % 2 else -0.1) for i in range(24)]
    out, n = ss.drop_stuck(_series(vals), ("no2",))
    assert n == 24 and all(r["no2"] is None for r in out)


def test_normal_diurnal_day_is_kept():
    vals = [40 + 20 * np.sin(2 * np.pi * i / 24) for i in range(24)]
    out, n = ss.drop_stuck(_series(vals), ("no2",))
    assert n == 0 and [r["no2"] for r in out] == vals


def test_only_the_stuck_window_is_dropped():
    varied = [40 + 20 * np.sin(2 * np.pi * i / 24) for i in range(24)]
    out, n = ss.drop_stuck(_series(varied + [1.0] * 24, pollutant="pm25"), ("pm25",))
    assert n == 24
    assert [r["pm25"] for r in out[:24]] == varied and all(r["pm25"] is None for r in out[24:])


def test_short_window_is_not_judged():
    out, n = ss.drop_stuck(_series([25.0] * 12), ("no2",))
    assert n == 0 and all(r["no2"] == 25.0 for r in out)


def test_each_station_and_pollutant_is_judged_separately_and_input_is_not_mutated():
    good = [40 + 20 * np.sin(2 * np.pi * i / 24) for i in range(24)]
    rows = [dict(a, pm25=g) for a, g in zip(_series([25.0] * 24), good)] + _series(good, station=2)
    out, n = ss.drop_stuck(rows, ("no2", "pm25"))
    assert n == 24
    assert all(r["no2"] is None and r["pm25"] is not None for r in out[:24])
    assert all(r["no2"] is not None for r in out[24:])
    assert rows[0]["no2"] == 25.0
