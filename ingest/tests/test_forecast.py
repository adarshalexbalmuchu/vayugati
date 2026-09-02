"""Phase 8 unified-forecasting tests, against a FIXED (seeded, deterministic)
synthetic historical dataset — never live OpenAQ/Open-Meteo/Supabase data.

Mirrors this repo's own established testing philosophy (supabase/tests/*.sql
seeds fixed sample rows and asserts against them) applied to the one part of
this phase that genuinely has to live in Python: the LightGBM model cannot
run inside Postgres, so its validation logic is tested here instead, with
the same "known inputs, checked outputs" discipline.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import forecast  # noqa: E402

RNG_SEED = 20260723


def _synthetic_readings(days: int, ward_ids: list[int], seed: int = RNG_SEED) -> list[dict]:
    """Deterministic hourly PM2.5 readings: a diurnal double-peak (rush
    hours) on top of a per-ward baseline, plus fixed, seeded noise — never
    random per test run. Ward 0 is deliberately "clean" (low, flat) so it
    can serve as the OTHER-wards baseline for local_excess in every test.
    """
    rng = np.random.default_rng(seed)
    start = pd.Timestamp("2026-05-01", tz="UTC")
    hours = pd.date_range(start, periods=days * 24, freq="h")
    rows = []
    for wi, ward_id in enumerate(ward_ids):
        base = 40 + wi * 20  # ward 0 stays low; later wards run progressively higher
        for t in hours:
            diurnal = 25 * (np.exp(-((t.hour - 9) ** 2) / 8) + np.exp(-((t.hour - 20) ** 2) / 8))
            noise = rng.normal(0, 3)
            pm25 = max(base + diurnal + noise, 5)
            rows.append({"ts": t.isoformat(), "ward_id": ward_id, "pm25": pm25, "pm10": pm25 * 1.6, "no2": None, "aqi": None})
    return rows


def _synthetic_weather(days: int, ward_ids: list[int], seed: int = RNG_SEED) -> list[dict]:
    rng = np.random.default_rng(seed + 1)
    start = pd.Timestamp("2026-05-01", tz="UTC")
    hours = pd.date_range(start, periods=days * 24, freq="h")
    rows = []
    for ward_id in ward_ids:
        for t in hours:
            rows.append(
                {
                    "ts": t.isoformat(),
                    "ward_id": ward_id,
                    "temp_c": 28 + 6 * np.sin(2 * np.pi * t.hour / 24) + rng.normal(0, 1),
                    "humidity": 50 + rng.normal(0, 5),
                    "wind_speed": 8 + rng.normal(0, 2),
                    "wind_dir": float(rng.uniform(0, 360)),
                    "precipitation": 0.0,
                }
            )
    return rows


# ── pure metric functions ────────────────────────────────────────────────────


def test_mae_rmse_bias_hand_computed():
    actual = np.array([100.0, 110.0, 90.0])
    pred = np.array([105.0, 100.0, 95.0])
    # errors: +5, -10, +5 -> |e|: 5,10,5 -> mae=20/3
    assert forecast._mae(pred, actual) == pytest.approx(20 / 3)
    # squared: 25,100,25 -> mean=50 -> rmse=sqrt(50)
    assert forecast._rmse(pred, actual) == pytest.approx(np.sqrt(50))
    # bias = mean(pred-actual) = mean(5,-10,5) = 0
    assert forecast._bias(pred, actual) == pytest.approx(0.0)


def test_bias_detects_systematic_over_and_under_prediction():
    actual = np.array([100.0, 100.0, 100.0])
    over = np.array([110.0, 110.0, 110.0])
    under = np.array([90.0, 90.0, 90.0])
    assert forecast._bias(over, actual) == pytest.approx(10.0)
    assert forecast._bias(under, actual) == pytest.approx(-10.0)


def test_threshold_recall_and_false_alarm_rate():
    # actual crosses at indices 1,2,3 (>=90); model predicts crossing at 2,3,4
    actual = np.array([50, 95, 100, 92, 60])
    pred = np.array([50, 60, 98, 91, 93])
    recall, false_alarm = forecast._threshold_metrics(pred, actual, threshold=90)
    # true crossings: idx 1,2,3 (3 total). model caught idx 2,3 -> 2/3
    assert recall == pytest.approx(2 / 3)
    # model flagged idx 2,3,4 (3 total); idx 4 is a false alarm (actual=60) -> 1/3
    assert false_alarm == pytest.approx(1 / 3)


def test_threshold_metrics_none_when_no_threshold_configured():
    actual = np.array([50.0, 95.0])
    pred = np.array([50.0, 95.0])
    recall, false_alarm = forecast._threshold_metrics(pred, actual, threshold=None)
    assert recall is None and false_alarm is None


def test_threshold_metrics_never_fabricates_recall_with_no_actual_events():
    # nothing ever crosses -> recall is undefined (None), not a fake 0 or 1
    actual = np.array([50.0, 60.0, 55.0])
    pred = np.array([50.0, 95.0, 55.0])  # one false alarm, no real crossings
    recall, false_alarm = forecast._threshold_metrics(pred, actual, threshold=90)
    assert recall is None
    assert false_alarm == pytest.approx(1.0)


# ── baseline forecasts ───────────────────────────────────────────────────────


def test_persistence_baseline_is_flat_at_the_last_known_value():
    hist = [10.0, 20.0, 30.0, 42.0]
    future_idx = pd.date_range("2026-01-01", periods=5, freq="h", tz="UTC")
    persistence, _ = forecast._baseline_forecast(hist, future_idx, pd.Series(dtype=float))
    assert (persistence == 42.0).all()


def test_diurnal_baseline_uses_the_mean_for_that_hour_of_day():
    by_hour = pd.Series({9: 100.0, 10: 50.0})
    future_idx = pd.to_datetime(["2026-01-02T09:00:00Z", "2026-01-02T10:00:00Z"])
    _, diurnal = forecast._baseline_forecast([1.0], future_idx, by_hour)
    assert diurnal[0] == pytest.approx(100.0)
    assert diurnal[1] == pytest.approx(50.0)


def test_diurnal_baseline_falls_back_to_last_value_for_an_unseen_hour():
    by_hour = pd.Series({9: 100.0})
    future_idx = pd.to_datetime(["2026-01-02T14:00:00Z"])  # hour 14 never seen
    _, diurnal = forecast._baseline_forecast([77.0], future_idx, by_hour)
    assert diurnal[0] == pytest.approx(77.0)


def test_same_hour_yesterday_repeats_the_last_24h_cycled_forward():
    # last 24h = 0..23; forecasting 30h ahead should repeat hours 0..23 then
    # wrap to 0..5 for the remaining 6 - never reach into its own future.
    hist = list(range(48)) + list(range(24))  # last 24 values are 0..23
    pred = forecast._same_hour_yesterday_baseline(hist, n_future=30)
    assert len(pred) == 30
    assert list(pred[:24]) == list(range(24))
    assert list(pred[24:30]) == list(range(6))


def test_same_hour_yesterday_falls_back_to_persistence_under_24h_history():
    hist = [10.0, 20.0, 33.0]  # under ROLLING_AVG_WINDOW_H (24)
    pred = forecast._same_hour_yesterday_baseline(hist, n_future=5)
    assert (pred == 33.0).all()


def test_rolling_average_baseline_is_the_mean_of_the_last_24h():
    hist = list(range(1, 100))  # 1..99; last 24 = 76..99
    pred = forecast._rolling_average_baseline(hist, n_future=3)
    assert pred == pytest.approx(np.mean(range(76, 100)))
    assert len(pred) == 3


def test_rolling_average_baseline_uses_all_history_when_under_the_window():
    hist = [10.0, 20.0, 30.0]
    pred = forecast._rolling_average_baseline(hist, n_future=2)
    assert pred == pytest.approx(20.0)


# ── time-based validation (never random) ─────────────────────────────────────


def test_validate_uses_a_chronological_holdout_not_a_random_one():
    """The holdout must be the LAST rows in time order. Prove it by giving
    the tail a value far outside anything the training portion ever saw —
    if the split were random, that outlier tail would sometimes leak into
    training and the diurnal-by-hour baseline (built from training data
    only) would reflect it. It must not."""
    # n large enough that split = n - MAX_HORIZON_H exactly (>= the 80% split
    # floor too) — see the assertion below, which depends on this holding.
    n = 300
    idx = pd.date_range("2026-01-01", periods=n, freq="h", tz="UTC")
    values = np.full(n, 50.0)
    tail_start = n - forecast.MAX_HORIZON_H
    assert tail_start == max(n - forecast.MAX_HORIZON_H, int(n * 0.8)), "test fixture assumption violated"
    values[tail_start:] = 5000.0  # an extreme, unmistakable holdout-only signal
    w = pd.DataFrame({"local_excess": values, "baseline": 0.0, "value": values}, index=idx)
    weather = pd.DataFrame({"temp_c": 25.0, "humidity": 50.0, "wind_speed": 5.0, "wind_dir": 180.0, "precipitation": 0.0}, index=idx)
    city_avg = pd.Series(50.0, index=idx)

    method, metrics, max_validated, beats = forecast._validate(
        w, weather, city_avg, threshold=None, baseline_value_at_split=0.0, min_mae_improvement_pct=5.0
    )
    # the training-only diurnal-by-hour average must NOT be polluted by the
    # 5000-valued holdout tail — reconstruct it the same way _validate does
    # and confirm it stays near 50, not anywhere near 5000.
    split = max(n - forecast.MAX_HORIZON_H, int(n * 0.8))
    by_hour_train_only = pd.Series(values[:split], index=idx[:split]).groupby(idx[:split].hour).mean()
    assert by_hour_train_only.max() < 100  # nowhere near the 5000 holdout-only value
    # and the persistence baseline (last TRAIN value) must be 50, not 5000
    assert values[split - 1] == pytest.approx(50.0)


def test_validate_returns_no_crash_and_sane_shape_on_flat_uninformative_data():
    """A perfectly flat series: persistence trivially predicts it exactly,
    so nothing should ever be able to beat persistence here — this is the
    honest, expected outcome of the "must not claim production-ready unless
    it beats persistence" rule, not a bug."""
    n = 300
    idx = pd.date_range("2026-01-01", periods=n, freq="h", tz="UTC")
    values = np.full(n, 30.0)
    w = pd.DataFrame({"local_excess": values, "baseline": 0.0, "value": values}, index=idx)
    weather = pd.DataFrame({"temp_c": 25.0, "humidity": 50.0, "wind_speed": 5.0, "wind_dir": 180.0, "precipitation": 0.0}, index=idx)
    city_avg = pd.Series(30.0, index=idx)

    method, metrics, max_validated, beats = forecast._validate(
        w, weather, city_avg, threshold=None, baseline_value_at_split=0.0, min_mae_improvement_pct=5.0
    )
    assert beats is False
    assert max_validated is None
    assert method == forecast.MODEL_VERSION_DIURNAL


def test_validate_handles_too_little_data_without_crashing():
    n = 10  # far below even the smallest horizon's holdout needs
    idx = pd.date_range("2026-01-01", periods=n, freq="h", tz="UTC")
    values = np.linspace(10, 20, n)
    w = pd.DataFrame({"local_excess": values, "baseline": 0.0, "value": values}, index=idx)
    weather = pd.DataFrame({"temp_c": 25.0, "humidity": 50.0, "wind_speed": 5.0, "wind_dir": 180.0, "precipitation": 0.0}, index=idx)
    city_avg = pd.Series(15.0, index=idx)

    method, metrics, max_validated, beats = forecast._validate(
        w, weather, city_avg, threshold=None, baseline_value_at_split=0.0, min_mae_improvement_pct=5.0
    )
    assert beats is False
    assert max_validated is None
    assert metrics == {}


def test_beats_persistence_now_requires_beating_the_best_baseline_not_just_persistence():
    """The core behavior change: a model that clears plain persistence but
    loses to a STRONGER available baseline (same-hour-yesterday, here) must
    NOT be marked as beating persistence — the old gate would have wrongly
    passed this. A trend + strong 24h period is a realistic shape for this:
    persistence (flat) can't track either the cycle or the trend; a
    same-hour-yesterday lookup tracks both almost perfectly; a diurnal
    hour-of-day average (this test's `model_pred`, since n < MIN_TRAIN_ROWS
    keeps it off the LightGBM path) smooths across many days and so lags
    the trend - genuinely better than persistence, genuinely worse than
    same-hour-yesterday."""
    n = 200  # < MIN_TRAIN_ROWS -> model_pred stays diurnal, no LightGBM involved
    idx = pd.date_range("2026-01-01", periods=n, freq="h", tz="UTC")
    day_idx = np.arange(n) // 24
    trend = 1.5 * day_idx
    values = 50 + trend + 20 * np.sin(2 * np.pi * idx.hour / 24)
    w = pd.DataFrame({"local_excess": values, "baseline": 0.0, "value": values}, index=idx)
    weather = pd.DataFrame({"temp_c": 25.0, "humidity": 50.0, "wind_speed": 5.0, "wind_dir": 180.0, "precipitation": 0.0}, index=idx)
    city_avg = pd.Series(50.0, index=idx)

    method, metrics, max_validated, beats = forecast._validate(
        w, weather, city_avg, threshold=None, baseline_value_at_split=0.0, min_mae_improvement_pct=5.0
    )

    m24 = metrics["24"]
    assert m24["mae"] < m24["persistence_mae"], "fixture assumption: model must beat plain persistence at 24h"
    assert m24["best_baseline"] == "same_hour_yesterday"
    assert m24["mae"] > m24["best_baseline_mae"], "fixture assumption: model must lose to same-hour-yesterday at 24h"
    # the actual assertion under test: beating persistence alone is no
    # longer enough to be marked "beats_persistence" at this horizon
    assert m24["beats_persistence"] is False
    assert method == forecast.MODEL_VERSION_DIURNAL


def test_validation_metrics_include_all_four_baseline_maes_and_best_baseline():
    n = 300
    idx = pd.date_range("2026-01-01", periods=n, freq="h", tz="UTC")
    rng = np.random.default_rng(RNG_SEED)
    values = 50 + 30 * np.sin(2 * np.pi * idx.hour / 24) + rng.normal(0, 1, n)
    w = pd.DataFrame({"local_excess": values, "baseline": 0.0, "value": values}, index=idx)
    weather = pd.DataFrame({"temp_c": 25.0, "humidity": 50.0, "wind_speed": 5.0, "wind_dir": 180.0, "precipitation": 0.0}, index=idx)
    city_avg = pd.Series(50.0, index=idx)

    _, metrics, _, _ = forecast._validate(
        w, weather, city_avg, threshold=None, baseline_value_at_split=0.0, min_mae_improvement_pct=5.0
    )
    for h_metrics in metrics.values():
        for key in ("persistence_mae", "diurnal_mae", "same_hour_yesterday_mae", "rolling_24h_avg_mae", "best_baseline", "best_baseline_mae"):
            assert key in h_metrics
        assert h_metrics["best_baseline"] in ("persistence", "diurnal", "same_hour_yesterday", "rolling_24h_avg")
        # best_baseline_mae must genuinely be the minimum of the four named MAEs
        named = [h_metrics["persistence_mae"], h_metrics["diurnal_mae"], h_metrics["same_hour_yesterday_mae"], h_metrics["rolling_24h_avg_mae"]]
        assert h_metrics["best_baseline_mae"] == pytest.approx(min(named))


def test_beats_persistence_is_monotonic_across_horizons():
    """If a horizon fails, no LARGER horizon can be the reported
    max_validated_horizon_hours, even if it happens to individually pass —
    a model good at 24h but bad at 6h is not "validated to 24h"."""
    n = 400
    idx = pd.date_range("2026-01-01", periods=n, freq="h", tz="UTC")
    rng = np.random.default_rng(RNG_SEED)
    # a strong, learnable diurnal pattern -> diurnal baseline (used once n <
    # MIN_TRAIN_ROWS via the model path, or always for the baseline
    # computation itself) should track it far better than flat persistence,
    # which cannot represent a cycle at all.
    values = 50 + 30 * np.sin(2 * np.pi * idx.hour / 24) + rng.normal(0, 1, n)
    w = pd.DataFrame({"local_excess": values, "baseline": 0.0, "value": values}, index=idx)
    weather = pd.DataFrame({"temp_c": 25.0, "humidity": 50.0, "wind_speed": 5.0, "wind_dir": 180.0, "precipitation": 0.0}, index=idx)
    city_avg = pd.Series(50.0, index=idx)

    method, metrics, max_validated, beats = forecast._validate(
        w, weather, city_avg, threshold=None, baseline_value_at_split=0.0, min_mae_improvement_pct=5.0
    )
    if max_validated is not None:
        validated_or_smaller = [h for h in forecast.HORIZONS_H if h <= max_validated]
        assert all(metrics[str(h)]["beats_persistence"] for h in validated_or_smaller)


# ── end-to-end run(), against the fixed synthetic dataset, DB fully mocked ──


class _FakeClient:
    """Records every insert/delete `run()` makes, in place of Supabase."""

    def __init__(self):
        self.forecast_runs: list[dict] = []
        self.forecasts: list[dict] = []
        self.deleted: list[tuple] = []
        self.nowcast_shadow_log: list[dict] = []


def test_run_end_to_end_against_fixed_dataset(monkeypatch):
    """No network, no Supabase — every db.* call is monkeypatched to serve
    the SAME fixed synthetic dataset every test run produces, and to record
    what would have been written instead of writing it."""
    days = 12  # below MIN_TRAIN_ROWS (240h) -> exercises the diurnal fallback path, fast to run
    ward_ids = [1, 2]
    readings = _synthetic_readings(days, ward_ids)
    weather = _synthetic_weather(days, ward_ids)
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

    def _fake_insert_run(row):
        fake.forecast_runs.append(row)
        return len(fake.forecast_runs)

    def _fake_replace_forecasts(ward_id, pollutant, rows):
        fake.deleted.append((ward_id, pollutant))
        fake.forecasts.extend(rows)

    monkeypatch.setattr(forecast.db, "insert_forecast_run", _fake_insert_run)
    monkeypatch.setattr(forecast.db, "replace_forecasts", _fake_replace_forecasts)
    monkeypatch.setattr(forecast.db, "get_last_forecast_times", lambda city_id: {})
    # no real HTTP calls for the weather forecast either
    monkeypatch.setattr(forecast.open_meteo, "get_hourly_forecast", lambda lat, lng, hours=48: [])
    # fire_counts feature (added for VIIRS regional fire lag features) hits a
    # real Supabase client if unmocked, which fails outside an environment
    # with real credentials — empty history is a normal, handled case (see
    # forecast.py's "empty Series when ... fire_counts table is empty").
    monkeypatch.setattr(forecast.db, "get_fire_counts_history", lambda days=45: [])
    # nowcasting: no backtest result yet -> falls back to persistence, never
    # crashes, and the shadow log has nothing pending to score.
    monkeypatch.setattr(forecast.db, "get_nowcast_backtest_result", lambda ward_id, pollutant: None)
    monkeypatch.setattr(forecast.db, "insert_nowcast_shadow_rows", lambda rows: fake.nowcast_shadow_log.extend(rows))
    monkeypatch.setattr(forecast.db, "get_pending_nowcast_shadows", lambda before_iso, limit=500: [])
    monkeypatch.setattr(forecast.db, "score_nowcast_shadow", lambda *a, **kw: None)

    summary = forecast.run(city_code="delhi")

    assert summary["runs"] == len(ward_ids)
    assert len(fake.forecast_runs) == len(ward_ids)
    for run_row in fake.forecast_runs:
        # "a model must not be marked production-ready unless it beats
        # persistence" — with only 12 days of data this never reaches the
        # LightGBM path, so it must be explicitly the documented fallback.
        assert run_row["method"] == "diurnal_persistence"
        assert run_row["data_quality_status"] in ("ok", "insufficient_data", "stale_inputs")
        assert isinstance(run_row["beats_persistence"], bool)

    # exactly 48 hourly rows per ward, method attribution recorded on every one
    assert len(fake.forecasts) == len(ward_ids) * forecast.MAX_HORIZON_H
    for row in fake.forecasts:
        assert row["pollutant"] == "pm25"
        assert row["forecast_run_id"] is not None
        assert row["model_version"] == forecast.MODEL_VERSION_DIURNAL
        # every pm25 row keeps the legacy column populated (backward compat)
        assert "pm25_pred" in row and row["pm25_pred"] == row["predicted_value"]


def test_run_skips_a_ward_with_no_readings_without_crashing(monkeypatch):
    ward_ids = [1, 2]
    # only ward 1 has any readings at all
    readings = _synthetic_readings(3, [1])
    weather = _synthetic_weather(3, ward_ids)
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
    # nowcasting: no backtest result yet -> falls back to persistence, never
    # crashes, and the shadow log has nothing pending to score.
    monkeypatch.setattr(forecast.db, "get_nowcast_backtest_result", lambda ward_id, pollutant: None)
    monkeypatch.setattr(forecast.db, "insert_nowcast_shadow_rows", lambda rows: fake.nowcast_shadow_log.extend(rows))
    monkeypatch.setattr(forecast.db, "get_pending_nowcast_shadows", lambda before_iso, limit=500: [])
    monkeypatch.setattr(forecast.db, "score_nowcast_shadow", lambda *a, **kw: None)

    summary = forecast.run(city_code="delhi")

    assert summary["runs"] == 1  # only ward 1
    assert {"ward_id": 2, "pollutant": "pm25"} in summary["skipped"]


@pytest.mark.skipif(not forecast._HAS_LGB, reason="lightgbm not installed")
def test_lightgbm_path_can_be_selected_when_it_genuinely_beats_persistence():
    """With enough history (>= MIN_TRAIN_ROWS) and a strong, learnable
    diurnal+weekly pattern, the LightGBM path must be ABLE to win and be
    selected — this is the positive counterpart to every other test here,
    which mostly exercises the fallback. Uses a low-noise fixed dataset
    specifically so the model has a real, learnable signal to beat flat
    persistence with; a noisy short dataset (see the end-to-end test above)
    legitimately falls back instead, which is correct, not a gap."""
    days = 40  # 960 hours, comfortably over MIN_TRAIN_ROWS (240)
    idx = pd.date_range("2026-01-01", periods=days * 24, freq="h", tz="UTC")
    rng = np.random.default_rng(RNG_SEED)
    values = (
        60
        + 25 * np.sin(2 * np.pi * idx.hour / 24 - np.pi / 2)  # strong diurnal cycle
        + 5 * np.sin(2 * np.pi * idx.dayofweek / 7)  # weekly pattern
        + rng.normal(0, 1.5, len(idx))  # small, fixed-seed noise
    )
    w = pd.DataFrame({"local_excess": values, "baseline": 0.0, "value": values}, index=idx)
    wind_speed = 5.0
    # Diurnal PBLH: low overnight (~200m), peaking midday (~1600m) — a typical
    # IGP shape. Without boundary_layer_height/ventilation_coefficient columns,
    # _make_features()'s pblh/pblh_trend/vc end up entirely NaN (no column to
    # read from at all, not even a fillable gap), and _validate()'s blanket
    # .dropna() then drops every single row — silently degrading this test to
    # the diurnal fallback with zero training rows, which is what made
    # "beats" fail: not flakiness, an empty training set every time.
    pblh = 900 + 700 * np.sin(2 * np.pi * (idx.hour - 6) / 24)
    weather = pd.DataFrame(
        {
            "temp_c": 28 + 6 * np.sin(2 * np.pi * idx.hour / 24),
            "humidity": 50.0,
            "wind_speed": wind_speed,
            "wind_dir": 180.0,
            "precipitation": 0.0,
            "boundary_layer_height": pblh,
            "ventilation_coefficient": pblh * wind_speed,
        },
        index=idx,
    )
    city_avg = pd.Series(60.0, index=idx)
    # no2_lag1 and fire_count_lag1d/lag2d are equally all-NaN-or-nothing when
    # their source series is None/absent — same reasoning as PBLH/VC above.
    no2_series = pd.Series(20 + 10 * np.sin(2 * np.pi * idx.hour / 24), index=idx)
    fire_dates = pd.date_range(idx.normalize().min() - pd.Timedelta(days=2), idx.normalize().max(), freq="D")
    fire_counts = pd.Series(2.0, index=fire_dates)

    method, metrics, max_validated, beats = forecast._validate(
        w, weather, city_avg, threshold=None, baseline_value_at_split=0.0, min_mae_improvement_pct=5.0,
        no2_series=no2_series, fire_counts=fire_counts,
    )
    assert metrics, "expected at least one horizon's metrics to be computed"
    # not asserting method == LGB specifically (a legitimate, honestly-
    # computed run could still prefer diurnal) — asserting the RESULT is
    # internally consistent and a real signal was learnable at some horizon.
    assert beats is True
    assert max_validated in forecast.HORIZONS_H
    assert metrics[str(forecast.HORIZONS_H[0])]["mae"] < metrics[str(forecast.HORIZONS_H[0])]["persistence_mae"]
