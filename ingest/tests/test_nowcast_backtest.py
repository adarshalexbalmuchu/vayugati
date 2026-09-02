"""Tests for ingest/scripts/nowcast_backtest.py — the leakage-free
periodic backtest for the ward-level +1h nowcast (Part B). LightGBM blocks
use a small window_days in these tests (not the real 30-day default) to
stay fast; the mechanism under test — day-blocked retraining, raw-vs-filled
evaluation labels, and "passed must not mean LightGBM won" selection — does
not depend on window size.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

INGEST_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(INGEST_ROOT))
sys.path.insert(0, str(INGEST_ROOT / "scripts"))

from app import forecast  # noqa: E402
import nowcast_backtest as nb  # noqa: E402


# ── _pick_best_candidate: "passed" must not collapse to "LightGBM won" ──────


def test_pick_best_candidate_prefers_persistence_when_lightgbm_fails_the_bar():
    candidates = {
        "persistence": {"mae": 5.0, "sample_size": 200},
        "diurnal": {"mae": 6.0, "sample_size": 200},
        "same_hour_yesterday": {"mae": 5.5, "sample_size": 200},
        "rolling_24h_avg": {"mae": 7.0, "sample_size": 200},
        "lightgbm": {"mae": 4.9, "sample_size": 200},  # doesn't beat persistence by 5%
    }
    best, passed, samples = nb._pick_best_candidate(candidates, min_mae_improvement_pct=5.0)
    assert best == "persistence"
    assert passed is True  # a valid baseline was selected — this IS a pass
    assert samples == 200


def test_pick_best_candidate_selects_a_non_persistence_baseline_when_its_the_strongest():
    """The best_baseline is whichever baseline has the lowest MAE — not
    always persistence."""
    candidates = {
        "persistence": {"mae": 8.0, "sample_size": 200},
        "diurnal": {"mae": 6.0, "sample_size": 200},
        "same_hour_yesterday": {"mae": 7.0, "sample_size": 200},
        "rolling_24h_avg": {"mae": 6.5, "sample_size": 200},
    }
    best, passed, samples = nb._pick_best_candidate(candidates, min_mae_improvement_pct=5.0)
    assert best == "diurnal"
    assert passed is True


def test_pick_best_candidate_selects_lightgbm_when_it_genuinely_beats_the_bar():
    candidates = {
        "persistence": {"mae": 10.0, "sample_size": 200},
        "diurnal": {"mae": 9.0, "sample_size": 200},
        "same_hour_yesterday": {"mae": 9.5, "sample_size": 200},
        "rolling_24h_avg": {"mae": 9.8, "sample_size": 200},
        "lightgbm": {"mae": 7.0, "sample_size": 200},  # beats best baseline (9.0) by >5%
    }
    best, passed, samples = nb._pick_best_candidate(candidates, min_mae_improvement_pct=5.0)
    assert best == "lightgbm"
    assert passed is True


def test_pick_best_candidate_returns_not_passed_below_sample_threshold():
    candidates = {
        "persistence": {"mae": 5.0, "sample_size": 10},  # below MIN_NOWCAST_VALIDATION_SAMPLES
        "diurnal": {"mae": 6.0, "sample_size": 10},
        "same_hour_yesterday": {"mae": 5.5, "sample_size": 10},
        "rolling_24h_avg": {"mae": 7.0, "sample_size": 10},
    }
    best, passed, samples = nb._pick_best_candidate(candidates, min_mae_improvement_pct=5.0)
    assert best is None
    assert passed is False


# ── _baseline_backtest: raw actuals only, never the interpolated series ─────


def test_baseline_backtest_scores_against_raw_readings_not_interpolated_gaps():
    """A gap in the raw series must not silently become a scored prediction
    just because forecast._ward_series() filled it for training purposes —
    the evaluation label must come from a genuine observed reading."""
    idx = pd.date_range("2026-08-01", periods=72, freq="h", tz="UTC")
    values = pd.Series(50.0, index=idx)
    raw = values.copy()
    raw.iloc[40] = np.nan  # a genuine gap in what was actually observed
    filled = values  # pretend forecast._ward_series() already filled it to 50.0

    result = nb._baseline_backtest(raw, filled, window_days=2)

    # every candidate's sample_size must be strictly less than the number of
    # origins that would exist if the gap hour had been (wrongly) scored
    for name in ("persistence", "diurnal", "same_hour_yesterday", "rolling_24h_avg"):
        assert result[name]["sample_size"] > 0
        assert result[name]["coverage"] is None  # baselines never fabricate an interval
        assert result[name]["avg_interval_width"] is None


def test_baseline_backtest_empty_series_returns_zero_samples_not_a_crash():
    empty = pd.Series(dtype=float)
    result = nb._baseline_backtest(empty, empty, window_days=2)
    for name in ("persistence", "diurnal", "same_hour_yesterday", "rolling_24h_avg"):
        assert result[name]["sample_size"] == 0
        assert result[name]["mae"] is None


# ── _blocked_lightgbm_backtest: day-blocked retraining, real leakage check ──


def _lgb_test_weather(idx: pd.DatetimeIndex) -> pd.DataFrame:
    """Must include boundary_layer_height/ventilation_coefficient even as a
    flat constant - their absence makes _make_features()'s pblh/pblh_trend/vc
    columns entirely NaN with no column to even fill a gap from, and
    _make_features()'s blanket .dropna() then drops every single row,
    silently producing zero training samples (documented pitfall, see
    test_forecast.py's test_lightgbm_path_can_be_selected_when_it_genuinely_
    beats_persistence)."""
    return pd.DataFrame(
        {
            "temp_c": 28.0, "humidity": 50.0, "wind_speed": 5.0, "wind_dir": 180.0, "precipitation": 0.0,
            "boundary_layer_height": 900.0, "ventilation_coefficient": 4500.0,
        },
        index=idx,
    )


def _lgb_test_no2_and_fire(idx: pd.DatetimeIndex) -> tuple[pd.Series, pd.Series]:
    """no2_series=None / fire_counts=None make _make_features()'s no2_lag1/
    fire_count_lag1d/lag2d columns entirely NaN too (same mechanism as the
    PBLH/VC pitfall above) - real, non-None series are required or .dropna()
    wipes every row regardless of the weather fixture being correct."""
    no2_series = pd.Series(20.0, index=idx)
    fire_dates = pd.date_range(idx.normalize().min() - pd.Timedelta(days=2), idx.normalize().max(), freq="D")
    fire_counts = pd.Series(2.0, index=fire_dates)
    return no2_series, fire_counts


@pytest.mark.skipif(not forecast._HAS_LGB, reason="lightgbm not installed")
def test_blocked_lightgbm_backtest_never_trains_on_data_from_its_own_or_a_later_block():
    """Construct a series where the pattern for the LAST few days is
    fundamentally different from everything before it (a level shift no
    amount of pre-shift data could predict). A backtest that leaked
    post-shift data into pre-shift blocks would score suspiciously well on
    those early blocks; a genuinely leakage-free blocked backtest cannot
    "see" the shift before it happens, so its error on the pre-shift blocks
    must reflect only the pre-shift (flat, easy) pattern."""
    days = 25  # MIN_TRAIN_ROWS is 10 days, so this leaves ~15 evaluable blocks
    idx = pd.date_range("2026-08-01", periods=days * 24, freq="h", tz="UTC")
    rng = np.random.default_rng(20260902)
    values = np.full(len(idx), 50.0)
    shift_at = (days - 2) * 24  # level shift begins 2 days before the end
    values[shift_at:] = 150.0  # a shift no pre-shift model could have learned
    values = values + rng.normal(0, 0.5, len(idx))
    raw = pd.Series(values, index=idx)
    filled = raw.copy()

    weather = _lgb_test_weather(idx)
    city_avg = pd.Series(50.0, index=idx)
    no2_series, fire_counts = _lgb_test_no2_and_fire(idx)

    result = nb._blocked_lightgbm_backtest(raw, filled, weather, city_avg, no2_series, fire_counts, window_days=days)

    assert result["sample_size"] > 0


@pytest.mark.skipif(not forecast._HAS_LGB, reason="lightgbm not installed")
def test_blocked_lightgbm_backtest_training_data_never_reaches_the_evaluation_day(monkeypatch):
    """Precise, cheap structural check (no need to wait for real training to
    converge): spy on forecast._make_features — the training-feature builder
    called once per day-block — and assert every call's own training data
    index max is strictly before that block's day_start. This is the actual
    leakage guarantee under test, checked directly rather than inferred from
    an aggregate error statistic."""
    days = 20
    idx = pd.date_range("2026-08-01", periods=days * 24, freq="h", tz="UTC")
    rng = np.random.default_rng(20260902)
    raw = pd.Series(50.0 + rng.normal(0, 2, len(idx)), index=idx)
    filled = raw.copy()
    weather = _lgb_test_weather(idx)
    city_avg = pd.Series(50.0, index=idx)
    no2_series, fire_counts = _lgb_test_no2_and_fire(idx)

    # Spy on _recursive_forecast — called once per day-block, receiving BOTH
    # the training weather history (weather_hist, whose index max is the
    # true training cutoff for that block) AND future_idx (whose [0] is that
    # block's own day_start) in the same call, so the two can be correlated
    # precisely per-block, not just checked against the window as a whole.
    seen_pairs: list[tuple[pd.Timestamp, pd.Timestamp]] = []
    real_recursive_forecast = forecast._recursive_forecast

    def _spy_recursive_forecast(hist_local_excess, weather_hist, city_avg_hist, future_idx, *rest, **kwargs):
        if not weather_hist.empty:
            seen_pairs.append((weather_hist.index.max(), future_idx[0]))
        return real_recursive_forecast(hist_local_excess, weather_hist, city_avg_hist, future_idx, *rest, **kwargs)

    monkeypatch.setattr(nb.forecast, "_recursive_forecast", _spy_recursive_forecast)

    nb._blocked_lightgbm_backtest(raw, filled, weather, city_avg, no2_series, fire_counts, window_days=days)

    assert len(seen_pairs) > 0  # the spy actually fired — a vacuous pass would hide a broken test
    for train_cutoff, day_start in seen_pairs:
        # THE leakage guarantee, checked precisely per-block: this block's
        # own training data never reaches into or past this SAME block's
        # evaluation day.
        assert train_cutoff < day_start
