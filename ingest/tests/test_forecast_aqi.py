import numpy as np
import pandas as pd

from app import aqi
from app import forecast_aqi as FA

ORIGIN = pd.Timestamp("2026-01-10 12:00", tz="UTC")


def _obs(value: float, hours: int = 30) -> pd.Series:
    idx = pd.date_range(ORIGIN - pd.Timedelta(hours=hours - 1), ORIGIN, freq="h", tz="UTC")
    return pd.Series(value, index=idx)


def _served(value: float, lo: float | None = None, hi: float | None = None, origin=ORIGIN) -> dict:
    idx = pd.date_range(origin + pd.Timedelta(hours=1), periods=48, freq="h", tz="UTC")
    return {"origin": origin, "future_idx": idx, "total": np.full(48, value),
            "q10": np.full(48, lo if lo is not None else value), "q90": np.full(48, hi if hi is not None else value)}


def _aqi(pm25, pm10, no2):
    return aqi.compute_cpcb_aqi(pm25, pm10, no2=no2)


def test_flat_forecast_equal_to_observed_keeps_the_aqi():
    obs = {"pm25": _obs(100), "pm10": _obs(150), "no2": _obs(40)}
    out = FA.forecast_ward(obs, {p: _served(v) for p, v in (("pm25", 100), ("pm10", 150), ("no2", 40))})
    assert np.all(out["aqi"] == _aqi(100, 150, 40))
    assert out["dominant"][0] == "pm25"


def test_window_blends_observed_and_forecast_hours():
    """At +6h the 24h window is 18 observed hours and 6 forecast hours."""
    obs = {"pm25": _obs(100), "pm10": _obs(100), "no2": _obs(40)}
    out = FA.forecast_ward(obs, {"pm25": _served(200), "pm10": _served(100), "no2": _served(40)})
    expect_pm25 = (18 * 100 + 6 * 200) / 24
    assert out["aqi"][5] == _aqi(expect_pm25, 100, 40)
    # from +24h the window is all forecast
    assert out["aqi"][23] == _aqi(200, 100, 40)


def test_range_follows_the_q10_and_q90_paths():
    obs = {"pm25": _obs(100), "pm10": _obs(150), "no2": _obs(40)}
    sv = {"pm25": _served(100, 60, 160), "pm10": _served(150, 100, 220), "no2": _served(40, 30, 55)}
    out = FA.forecast_ward(obs, sv)
    assert out["low"][47] == _aqi(60, 100, 30)
    assert out["high"][47] == _aqi(160, 220, 55)
    assert np.all(out["low"] <= out["aqi"]) and np.all(out["aqi"] <= out["high"])


def test_needs_three_pollutants_including_pm():
    obs = {"pm25": _obs(100), "no2": _obs(40)}
    out = FA.forecast_ward(obs, {"pm25": _served(100), "no2": _served(40)})
    assert np.all(np.isnan(out["aqi"]))
    assert FA.forecast_ward({"no2": _obs(40)}, {"no2": _served(40)}) is None


def test_stale_pollutant_is_not_forecast_and_drops_out():
    """A pollutant whose latest hour is > 6 h older than the others' is not
    forecast; once its observed hours leave the window, it stops counting."""
    old = ORIGIN - pd.Timedelta(hours=7)
    obs = {"pm25": _obs(100), "pm10": _obs(150), "no2": _obs(40)[_obs(40).index <= old]}
    out = FA.forecast_ward(obs, {"pm25": _served(100), "pm10": _served(150), "no2": _served(400, origin=old)})
    # +1h: the window still holds 16 observed NO2 hours; the stale forecast (400) is never used
    assert out["aqi"][0] == _aqi(100, 150, 40)
    # +2h: 15 NO2 hours -> NO2 drops out -> two pollutants -> no AQI, as CPCB would report
    assert np.isnan(out["aqi"][1])


def test_observed_aqi_matches_the_window_rule():
    obs = {"pm25": _obs(100), "pm10": _obs(150), "no2": _obs(40)}
    assert FA.observed_aqi(obs, ORIGIN) == (_aqi(100, 150, 40), "pm25")


def test_category():
    assert [FA.category(v) for v in (0, 50, 51, 100, 201, 301, 401, 500)] == [0, 0, 1, 1, 3, 4, 5, 5]
    assert FA.category(None) is None


def _publish(monkeypatch, gate, served_origin=ORIGIN, now=ORIGIN + pd.Timedelta(hours=1)):
    monkeypatch.setattr(FA, "load_gate", lambda: gate)
    writes = {}
    obs = {p: {7: _obs(v)} for p, v in (("pm25", 100), ("pm10", 150), ("no2", 40))}
    sv = {p: {7: _served(v, origin=served_origin)} for p, v in (("pm25", 100), ("pm10", 150), ("no2", 40))}
    res = FA.publish([7], obs, sv, now.to_pydatetime(), 6, lambda w, rows: writes.__setitem__(w, rows))
    return res, writes


def test_publish_nothing_without_a_validated_gate(monkeypatch):
    res, writes = _publish(monkeypatch, None)
    assert res == {"published": 0, "cleared": 0} and writes == {}


def test_publish_caps_leads_at_the_gate(monkeypatch):
    res, writes = _publish(monkeypatch, {"max_lead": 24, "band_scale": 1.0})
    rows = writes[7]
    assert res["published"] == 1 and [r["lead_hours"] for r in rows] == list(range(1, 25))
    r = rows[0]
    assert r["aqi"] == _aqi(100, 150, 40) and r["aqi_low"] <= r["aqi"] <= r["aqi_high"]
    assert r["dominant_pollutant"] == "pm25" and r["target_ts"] == (ORIGIN + pd.Timedelta(hours=1)).isoformat()


def test_publish_clears_a_stale_ward(monkeypatch):
    res, writes = _publish(monkeypatch, {"max_lead": 24}, now=ORIGIN + pd.Timedelta(hours=10))
    assert res == {"published": 0, "cleared": 1} and writes[7] == []
