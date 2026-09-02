"""Ward-level nowcasting (+1h) tests — _select_nowcast_point's timeline
anchoring, candidate eligibility/selection semantics, shadow-log scoring, and
an end-to-end run() check that is_nowcast_point/shadow rows actually land
correctly. See docs/data/nowcast-shadow-review.md for the release gate this
pipeline exists to support.
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import db, forecast  # noqa: E402
from tests.test_forecast import _synthetic_readings, _synthetic_weather  # noqa: E402

RNG_SEED = 20260901


# ── _select_nowcast_point ────────────────────────────────────────────────────


def test_select_nowcast_point_worked_example_from_review():
    """anchor 12:00, generated 12:45 -> future_idx[0] (=anchor+1h=13:00) is
    only 15 minutes ahead of "now", not a genuine 1h-ahead nowcast. The
    correct pick is whichever future_idx point is closest to
    generated_at + 1h = 13:45 - here that's future_idx[1] (14:00), 15 minutes
    away and within the 30-minute tolerance."""
    anchor = pd.Timestamp("2026-09-01 12:00", tz="UTC")
    generated_at = datetime(2026, 9, 1, 12, 45, tzinfo=timezone.utc)
    future_idx = pd.date_range(anchor + timedelta(hours=1), periods=48, freq="h", tz="UTC")

    idx, tolerance_ok = forecast._select_nowcast_point(future_idx, generated_at)

    assert future_idx[idx] == pd.Timestamp("2026-09-01 14:00", tz="UTC")
    assert tolerance_ok is True


def test_select_nowcast_point_excludes_points_at_or_before_generation():
    """A stale-enough anchor can put future_idx[0] at/before generated_at -
    such a point is never a valid 'from now' nowcast candidate."""
    anchor = pd.Timestamp("2026-09-01 06:00", tz="UTC")
    generated_at = datetime(2026, 9, 1, 8, 0, tzinfo=timezone.utc)  # anchor is 2h stale
    future_idx = pd.date_range(anchor + timedelta(hours=1), periods=48, freq="h", tz="UTC")
    # future_idx[0] = 07:00, already before generated_at (08:00) - excluded.

    idx, tolerance_ok = forecast._select_nowcast_point(future_idx, generated_at)

    assert future_idx[idx] > generated_at
    # nearest eligible point to 09:00 is future_idx[1] = 08:00... still ahead
    # of generated_at (08:00 is NOT > 08:00, so 08:00 itself is excluded too)
    assert future_idx[idx] == pd.Timestamp("2026-09-01 09:00", tz="UTC")


def test_select_nowcast_point_returns_unavailable_when_anchor_too_stale():
    """When EVERY future_idx point is at/before generated_at, no nowcast
    point exists this cycle - not a crash, an honest (-1, False)."""
    anchor = pd.Timestamp("2026-09-01 00:00", tz="UTC")
    generated_at = datetime(2026, 9, 3, 0, 0, tzinfo=timezone.utc)  # 48h+ stale
    future_idx = pd.date_range(anchor + timedelta(hours=1), periods=48, freq="h", tz="UTC")

    idx, tolerance_ok = forecast._select_nowcast_point(future_idx, generated_at)

    assert idx == -1
    assert tolerance_ok is False


def test_select_nowcast_point_ties_break_toward_the_later_point():
    """Two future_idx points equidistant from the target: the later one
    must win, not whichever Python's min() would keep by default (the
    first-seen, earlier one)."""
    generated_at = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
    target = generated_at + timedelta(hours=1)  # 13:00
    future_idx = pd.DatetimeIndex([target - timedelta(minutes=20), target + timedelta(minutes=20)])

    idx, tolerance_ok = forecast._select_nowcast_point(future_idx, generated_at)

    assert future_idx[idx] == target + timedelta(minutes=20)
    assert tolerance_ok is True


def test_select_nowcast_point_beyond_tolerance_is_flagged_unavailable():
    generated_at = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
    # nearest point is 45 minutes off target - beyond the 30-minute tolerance
    future_idx = pd.DatetimeIndex([generated_at + timedelta(hours=1, minutes=45)])

    idx, tolerance_ok = forecast._select_nowcast_point(future_idx, generated_at)

    assert idx == 0  # still identifies the nearest point...
    assert tolerance_ok is False  # ...but honestly flags it as unusable


# ── _nowcast_candidate_predictions ───────────────────────────────────────────


def test_nowcast_candidate_predictions_never_asserts_a_hardcoded_five():
    hist = [50.0 + i * 0.1 for i in range(100)]
    future_idx = pd.date_range("2026-09-01 13:00", periods=48, freq="h", tz="UTC")
    by_hour = pd.Series({h: 50.0 for h in range(24)})

    without_lgb = forecast._nowcast_candidate_predictions(hist, future_idx, by_hour, nowcast_idx=0)
    assert set(without_lgb.keys()) == {"persistence", "diurnal", "same_hour_yesterday", "rolling_24h_avg"}
    assert "lightgbm" not in without_lgb

    lgb_point = np.full(48, 55.0)
    with_lgb = forecast._nowcast_candidate_predictions(
        hist, future_idx, by_hour, nowcast_idx=0, lgb_point_pred=lgb_point
    )
    assert set(with_lgb.keys()) == {"persistence", "diurnal", "same_hour_yesterday", "rolling_24h_avg", "lightgbm"}
    assert with_lgb["lightgbm"]["value"] == 55.0
    assert with_lgb["lightgbm"]["lower"] is None and with_lgb["lightgbm"]["upper"] is None


def test_nowcast_candidate_predictions_baselines_never_fabricate_an_interval():
    hist = [50.0] * 50
    future_idx = pd.date_range("2026-09-01 13:00", periods=10, freq="h", tz="UTC")
    by_hour = pd.Series({h: 50.0 for h in range(24)})

    candidates = forecast._nowcast_candidate_predictions(hist, future_idx, by_hour, nowcast_idx=0)

    for name in ("persistence", "diurnal", "same_hour_yesterday", "rolling_24h_avg"):
        assert candidates[name]["lower"] is None
        assert candidates[name]["upper"] is None


def test_nowcast_candidate_predictions_lightgbm_reports_real_quantile_bounds_when_available():
    hist = [50.0] * 50
    future_idx = pd.date_range("2026-09-01 13:00", periods=5, freq="h", tz="UTC")
    by_hour = pd.Series({h: 50.0 for h in range(24)})
    lgb_point = np.full(5, 55.0)
    lgb_lo = np.full(5, 48.0)
    lgb_hi = np.full(5, 62.0)

    candidates = forecast._nowcast_candidate_predictions(
        hist, future_idx, by_hour, nowcast_idx=2, lgb_point_pred=lgb_point, lgb_lower=lgb_lo, lgb_upper=lgb_hi
    )

    assert candidates["lightgbm"] == {"value": 55.0, "lower": 48.0, "upper": 62.0}


# ── _select_nowcast_production_method: "passed" must not mean "LightGBM won" ─


def _candidates(**overrides) -> dict:
    base = {
        "persistence": {"value": 10.0, "lower": None, "upper": None},
        "diurnal": {"value": 12.0, "lower": None, "upper": None},
        "same_hour_yesterday": {"value": 11.0, "lower": None, "upper": None},
        "rolling_24h_avg": {"value": 9.0, "lower": None, "upper": None},
    }
    base.update(overrides)
    return base


def test_selection_falls_back_to_persistence_when_no_backtest_exists(monkeypatch):
    monkeypatch.setattr(db, "get_nowcast_backtest_result", lambda ward_id, pollutant: None)

    method, pred, passed, samples = forecast._select_nowcast_production_method(
        1, "pm25", forecast.MODEL_VERSION_LGB, _candidates()
    )

    assert method == "persistence"
    assert pred == {"value": 10.0, "lower": None, "upper": None}
    assert passed is False
    assert samples == 0


def test_selection_uses_the_backtests_own_best_candidate_even_when_its_a_baseline(monkeypatch):
    """A baseline that LightGBM never even beat in the backtest is still a
    perfectly valid *selected* method - "passed" must not collapse to
    "LightGBM won"."""
    monkeypatch.setattr(
        db,
        "get_nowcast_backtest_result",
        lambda ward_id, pollutant: {
            "best_candidate": "rolling_24h_avg",
            "passed": True,
            "sample_size": 500,
            "model_version": forecast.MODEL_VERSION_LGB,
            "methodology_version": forecast.NOWCAST_METHODOLOGY_VERSION,
            "data_through": datetime.now(timezone.utc).isoformat(),
        },
    )

    method, pred, passed, samples = forecast._select_nowcast_production_method(
        1, "pm25", forecast.MODEL_VERSION_LGB, _candidates()
    )

    assert method == "rolling_24h_avg"
    assert pred == {"value": 9.0, "lower": None, "upper": None}
    assert passed is True
    assert samples == 500


def test_selection_ignores_a_backtest_result_from_a_different_model_version(monkeypatch):
    """A stale backtest computed under an old model_version must be treated
    exactly like no result exists - never trusted forever."""
    monkeypatch.setattr(
        db,
        "get_nowcast_backtest_result",
        lambda ward_id, pollutant: {
            "best_candidate": "lightgbm",
            "passed": True,
            "sample_size": 500,
            "model_version": "some_old_version",
            "methodology_version": forecast.NOWCAST_METHODOLOGY_VERSION,
            "data_through": datetime.now(timezone.utc).isoformat(),
        },
    )

    method, pred, passed, samples = forecast._select_nowcast_production_method(
        1, "pm25", forecast.MODEL_VERSION_LGB, _candidates()
    )

    assert method == "persistence"
    assert passed is False


def test_selection_ignores_a_backtest_result_older_than_the_refresh_window(monkeypatch):
    stale_data_through = datetime.now(timezone.utc) - timedelta(days=forecast.NOWCAST_BACKTEST_REFRESH_DAYS + 5)
    monkeypatch.setattr(
        db,
        "get_nowcast_backtest_result",
        lambda ward_id, pollutant: {
            "best_candidate": "lightgbm",
            "passed": True,
            "sample_size": 500,
            "model_version": forecast.MODEL_VERSION_LGB,
            "methodology_version": forecast.NOWCAST_METHODOLOGY_VERSION,
            "data_through": stale_data_through.isoformat(),
        },
    )

    method, pred, passed, samples = forecast._select_nowcast_production_method(
        1, "pm25", forecast.MODEL_VERSION_LGB, _candidates()
    )

    assert method == "persistence"
    assert passed is False


def test_selection_never_selects_a_candidate_absent_from_this_cycles_predictions(monkeypatch):
    """A backtest naming best_candidate="lightgbm" is useless this cycle if
    LightGBM wasn't eligible/trained this cycle - falls back to persistence
    rather than crashing on a KeyError."""
    monkeypatch.setattr(
        db,
        "get_nowcast_backtest_result",
        lambda ward_id, pollutant: {
            "best_candidate": "lightgbm",
            "passed": True,
            "sample_size": 500,
            "model_version": forecast.MODEL_VERSION_LGB,
            "methodology_version": forecast.NOWCAST_METHODOLOGY_VERSION,
            "data_through": datetime.now(timezone.utc).isoformat(),
        },
    )

    method, pred, passed, samples = forecast._select_nowcast_production_method(
        1, "pm25", forecast.MODEL_VERSION_LGB, _candidates()  # no "lightgbm" key this cycle
    )

    assert method == "persistence"
    assert passed is False


# ── _score_pending_nowcast_shadows ───────────────────────────────────────────


def test_score_pending_shadows_fills_matched_rows_and_skips_unmatched(monkeypatch):
    hourly = {
        "pm25": forecast._hourly_ward_pollutant(
            [{"ts": "2026-09-01T13:00:00Z", "ward_id": 1, "pm25": 77.0, "pm10": None, "no2": None, "aqi": None}],
            "pm25",
        )
    }
    scored_calls = []
    monkeypatch.setattr(
        db,
        "get_pending_nowcast_shadows",
        lambda before_iso, limit=500: [
            {"id": 1, "ward_id": 1, "pollutant": "pm25", "valid_at": "2026-09-01T13:00:00Z"},  # has a match
            {"id": 2, "ward_id": 1, "pollutant": "pm25", "valid_at": "2026-09-01T15:00:00Z"},  # no reading that hour
            {"id": 3, "ward_id": 99, "pollutant": "pm25", "valid_at": "2026-09-01T13:00:00Z"},  # wrong ward
        ],
    )
    monkeypatch.setattr(db, "score_nowcast_shadow", lambda *args: scored_calls.append(args))

    scored = forecast._score_pending_nowcast_shadows(hourly)

    assert scored == 1
    assert scored_calls[0][0] == 1  # row id 1
    assert scored_calls[0][1] == 77.0  # actual_value


# ── run() end-to-end: is_nowcast_point + shadow logging actually happen ─────


class _FakeClient:
    def __init__(self):
        self.forecast_runs: list[dict] = []
        self.forecasts: list[dict] = []
        self.nowcast_shadow_log: list[dict] = []


def test_run_marks_exactly_one_nowcast_point_and_logs_shadow_candidates(monkeypatch):
    """Synthetic data anchored close to REAL wall-clock now (not a fixed
    2026-01-01-style date) so _select_nowcast_point's generated_at-relative
    logic actually exercises the 'available' path, not 'stale_anchor'."""
    now = pd.Timestamp.now(tz="UTC").floor("h")
    days = 12
    ward_ids = [1]
    rng = np.random.default_rng(RNG_SEED)
    hours = pd.date_range(now - pd.Timedelta(days=days), periods=days * 24, freq="h")
    readings = [
        {"ts": t.isoformat(), "ward_id": 1, "pm25": max(50 + rng.normal(0, 3), 5), "pm10": None, "no2": None, "aqi": None}
        for t in hours
    ]
    weather = _synthetic_weather(days, ward_ids)
    # _synthetic_weather anchors at a fixed 2026-05-01 date - retime it to
    # line up with the readings above so weather lookups aren't all-NaN.
    weather_hours = pd.date_range(now - pd.Timedelta(days=days), periods=days * 24, freq="h")
    for row, t in zip(weather, weather_hours):
        row["ts"] = t.isoformat()

    fake = _FakeClient()
    monkeypatch.setattr(
        forecast.db,
        "get_active_cities",
        lambda city_code=None: [{"id": 1, "city_code": "delhi", "name": "Delhi", "config": {"forecasting": {"enabled_pollutants": ["pm25"]}}}],
    )
    monkeypatch.setattr(
        forecast.db,
        "get_wards_with_city",
        lambda: [{"id": wid, "name": f"ward{wid}", "lat": 28.6, "lng": 77.2, "city_id": 1} for wid in ward_ids],
    )
    monkeypatch.setattr(forecast.db, "get_readings_history", lambda hours=720: readings)
    monkeypatch.setattr(forecast.db, "get_weather_history", lambda hours=720: weather)
    monkeypatch.setattr(forecast.db, "insert_forecast_run", lambda row: fake.forecast_runs.append(row) or len(fake.forecast_runs))
    monkeypatch.setattr(forecast.db, "replace_forecasts", lambda ward_id, pollutant, rows: fake.forecasts.extend(rows))
    monkeypatch.setattr(forecast.db, "get_last_forecast_times", lambda city_id: {})
    monkeypatch.setattr(forecast.open_meteo, "get_hourly_forecast", lambda lat, lng, hours=48: [])
    monkeypatch.setattr(forecast.db, "get_fire_counts_history", lambda days=45: [])
    monkeypatch.setattr(forecast.db, "get_nowcast_backtest_result", lambda ward_id, pollutant: None)
    monkeypatch.setattr(forecast.db, "insert_nowcast_shadow_rows", lambda rows: fake.nowcast_shadow_log.extend(rows))
    monkeypatch.setattr(forecast.db, "get_pending_nowcast_shadows", lambda before_iso, limit=500: [])
    monkeypatch.setattr(forecast.db, "score_nowcast_shadow", lambda *a, **kw: None)

    forecast.run(city_code="delhi")

    nowcast_rows = [r for r in fake.forecasts if r["is_nowcast_point"]]
    assert len(nowcast_rows) == 1  # exactly one row per ward+pollutant cycle
    assert nowcast_rows[0]["nowcast_method"] == "persistence"  # no backtest result -> conservative fallback
    assert nowcast_rows[0]["nowcast_backtest_passed"] is False

    run_row = fake.forecast_runs[0]
    assert run_row["nowcast_generation_status"] == "available"
    assert run_row["nowcast_valid_at"] is not None

    # every eligible candidate logged to the shadow table, not just the winner
    logged_methods = {r["candidate_method"] for r in fake.nowcast_shadow_log}
    assert logged_methods == {"persistence", "diurnal", "same_hour_yesterday", "rolling_24h_avg"}
    assert all(r["valid_at"] == nowcast_rows[0]["horizon_ts"] for r in fake.nowcast_shadow_log)
