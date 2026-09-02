#!/usr/bin/env python3
"""Leakage-free periodic backtest for the ward-level +1h nowcast.

Run this BEFORE shadow rollout begins, then periodically (daily/weekly), and
after any material change to forecast.py's model. NOT run inside the hourly
forecast.run() cycle — that would be both leaky for LightGBM (a model fit
once on data through today has implicitly absorbed information from after
any earlier evaluation point, no matter what features are withheld at
inference time) and far too expensive to re-run 24x/day.

Methodology (blocked/expanding-window validation, genuinely leakage-free):
for each historical day D in the last NOWCAST_BACKTEST_WINDOW_DAYS, a FRESH
LightGBM model is trained using only data strictly before D's start, then
asked for 24 real one-step-ahead predictions for D's 24 hours via
forecast._recursive_forecast() — which already enforces causal, hour-by-hour
prediction internally (never builds a day's worth of features in advance
from the completed day). The four baseline candidates (persistence, diurnal,
same-hour-yesterday, rolling-24h-avg) are closed-form lookups with no
fitting involved at all, so they carry no leakage risk regardless of
evaluation density and are scored far more densely than the LightGBM blocks.

Evaluation labels are always the RAW observed reading for that hour, never
the gap-filled/interpolated series forecast._ward_series() produces for
training purposes — .interpolate() is not causal (it can smooth a gap using
a LATER real reading), so treating an interpolated value as ground truth
would leak future information into the evaluation itself, even though using
the interpolated series for TRAINING history is a legitimate, already-
established modelling choice (matches how forecast.py's live pipeline works).

Usage:
    python scripts/nowcast_backtest.py [--city CODE]
"""
from __future__ import annotations

import argparse
import sys
from datetime import timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import db, forecast  # noqa: E402

try:
    import lightgbm as lgb
    _HAS_LGB = True
except ImportError:
    _HAS_LGB = False

log = __import__("logging").getLogger("ingest.nowcast_backtest")

# Evaluation window + the training/feature-lag runway the FIRST evaluation
# block needs before it (MIN_TRAIN_ROWS is ~10 days) — fetch generously more
# than just the 30-day window, or the earliest blocks would train on almost
# nothing.
FETCH_HISTORY_DAYS = forecast.NOWCAST_BACKTEST_WINDOW_DAYS + (forecast.MIN_TRAIN_ROWS // 24) + 5
_LGB_KW = dict(n_estimators=300, learning_rate=0.05, num_leaves=31, min_child_samples=10, verbose=-1)


def _blocked_lightgbm_backtest(
    raw_local_excess: pd.Series,
    filled_local_excess: pd.Series,
    weather_ward: pd.DataFrame,
    city_avg: pd.Series,
    no2_series: pd.Series | None,
    fire_counts: pd.Series | None,
    window_days: int,
) -> dict:
    """Day-blocked, leakage-free LightGBM backtest. Returns a metrics dict
    with sample_size=0 when LightGBM isn't installed or there's not enough
    history for even one block."""
    empty = {"mae": None, "rmse": None, "bias": None, "coverage": None, "avg_interval_width": None, "sample_size": 0}
    if not _HAS_LGB or filled_local_excess.empty:
        return empty

    last_day_start = filled_local_excess.index.max().floor("D")
    day_starts = pd.date_range(end=last_day_start, periods=window_days, freq="D", tz="UTC")

    preds_all: list[float] = []
    actuals_all: list[float] = []
    lo_all: list[float | None] = []
    hi_all: list[float | None] = []

    for day_start in day_starts:
        day_idx = pd.date_range(day_start, day_start + timedelta(hours=23), freq="h", tz="UTC")
        actual_day = raw_local_excess.reindex(day_idx)  # RAW readings only — never interpolated
        if actual_day.dropna().empty:
            continue

        train_mask = filled_local_excess.index < day_start
        train_excess = filled_local_excess[train_mask]
        if len(train_excess) < forecast.MIN_TRAIN_ROWS:
            continue  # not enough training history strictly before this block yet

        wx_train = weather_ward[weather_ward.index < day_start]
        city_avg_train = city_avg[city_avg.index < day_start]
        no2_train = no2_series[no2_series.index < day_start] if no2_series is not None else None

        train_df = pd.DataFrame({"local_excess": train_excess})
        feats = forecast._make_features(train_df, wx_train, city_avg_train, no2_train, fire_counts).dropna()
        if len(feats) < forecast.MIN_TRAIN_ROWS // 2:
            continue

        hist_list = list(train_excess.to_numpy())
        # REAL historical weather for day D (this is a backtest against the
        # past, so real weather is known) — reindexed the same shape
        # forecast._recursive_forecast() expects for future_weather.
        future_weather = weather_ward.reindex(day_idx).ffill().bfill()

        try:
            model_pt = lgb.LGBMRegressor(random_state=forecast.LGB_RANDOM_STATE, **_LGB_KW)
            model_pt.fit(feats[forecast.FEATURE_COLS], feats["y"])
            day_preds = forecast._recursive_forecast(
                hist_list, wx_train, city_avg_train, day_idx, future_weather, model_pt, no2_train, fire_counts
            )
        except Exception:
            log.exception("LightGBM block fit/predict failed for day %s — skipping this block", day_start.date())
            continue

        day_lo = day_hi = None
        try:
            model_q10 = lgb.LGBMRegressor(objective="quantile", alpha=0.10, random_state=forecast.LGB_RANDOM_STATE, **_LGB_KW)
            model_q10.fit(feats[forecast.FEATURE_COLS], feats["y"])
            day_lo = forecast._recursive_forecast(hist_list, wx_train, city_avg_train, day_idx, future_weather, model_q10, no2_train, fire_counts)
            model_q90 = lgb.LGBMRegressor(objective="quantile", alpha=0.90, random_state=forecast.LGB_RANDOM_STATE, **_LGB_KW)
            model_q90.fit(feats[forecast.FEATURE_COLS], feats["y"])
            day_hi = forecast._recursive_forecast(hist_list, wx_train, city_avg_train, day_idx, future_weather, model_q90, no2_train, fire_counts)
        except Exception:
            day_lo = day_hi = None

        for i, ts in enumerate(day_idx):
            actual = actual_day.get(ts)
            if pd.isna(actual):
                continue
            preds_all.append(float(day_preds[i]))
            actuals_all.append(float(actual))
            lo_all.append(float(day_lo[i]) if day_lo is not None else None)
            hi_all.append(float(day_hi[i]) if day_hi is not None else None)

    if not preds_all:
        return empty

    preds_arr, actuals_arr = np.array(preds_all), np.array(actuals_all)
    coverage = avg_width = None
    if lo_all and all(v is not None for v in lo_all):
        lo_arr, hi_arr = np.array(lo_all), np.array(hi_all)
        coverage = float(np.mean((actuals_arr >= lo_arr) & (actuals_arr <= hi_arr)))
        avg_width = float(np.mean(hi_arr - lo_arr))

    return {
        "mae": round(float(forecast._mae(preds_arr, actuals_arr)), 3),
        "rmse": round(float(forecast._rmse(preds_arr, actuals_arr)), 3),
        "bias": round(float(forecast._bias(preds_arr, actuals_arr)), 3),
        "coverage": round(coverage, 3) if coverage is not None else None,
        "avg_interval_width": round(avg_width, 3) if avg_width is not None else None,
        "sample_size": len(preds_all),
    }


def _baseline_backtest(raw_local_excess: pd.Series, filled_local_excess: pd.Series, window_days: int) -> dict[str, dict]:
    """Baselines have no fitting step at all — no leakage risk regardless of
    how densely they're evaluated, so every historical hour in the window
    (not just once/day) is used as its own origin."""
    empty = {"mae": None, "rmse": None, "bias": None, "coverage": None, "avg_interval_width": None, "sample_size": 0}
    if filled_local_excess.empty:
        return {name: dict(empty) for name in ("persistence", "diurnal", "same_hour_yesterday", "rolling_24h_avg")}

    window_start = filled_local_excess.index.max() - timedelta(days=window_days)
    origins = [ts for ts in filled_local_excess.index if ts >= window_start and ts + timedelta(hours=1) <= filled_local_excess.index.max()]

    by_hour = filled_local_excess.groupby(filled_local_excess.index.hour).mean()
    accum: dict[str, list[tuple[float, float]]] = {"persistence": [], "diurnal": [], "same_hour_yesterday": [], "rolling_24h_avg": []}

    for origin in origins:
        target_ts = origin + timedelta(hours=1)
        actual = raw_local_excess.get(target_ts)  # RAW only
        if actual is None or pd.isna(actual):
            continue
        hist = filled_local_excess[filled_local_excess.index <= origin]
        if hist.empty:
            continue
        hist_list = list(hist.to_numpy())
        persistence, diurnal = forecast._baseline_forecast(hist_list, pd.DatetimeIndex([target_ts]), by_hour)
        same_hour_yesterday = forecast._same_hour_yesterday_baseline(hist_list, 1)
        rolling_avg = forecast._rolling_average_baseline(hist_list, 1)
        accum["persistence"].append((float(persistence[0]), float(actual)))
        accum["diurnal"].append((float(diurnal[0]), float(actual)))
        accum["same_hour_yesterday"].append((float(same_hour_yesterday[0]), float(actual)))
        accum["rolling_24h_avg"].append((float(rolling_avg[0]), float(actual)))

    out: dict[str, dict] = {}
    for name, pairs in accum.items():
        if not pairs:
            out[name] = dict(empty)
            continue
        preds_arr = np.array([p for p, _ in pairs])
        actuals_arr = np.array([a for _, a in pairs])
        out[name] = {
            "mae": round(float(forecast._mae(preds_arr, actuals_arr)), 3),
            "rmse": round(float(forecast._rmse(preds_arr, actuals_arr)), 3),
            "bias": round(float(forecast._bias(preds_arr, actuals_arr)), 3),
            "coverage": None,          # no calibrated interval for a closed-form baseline
            "avg_interval_width": None,
            "sample_size": len(pairs),
        }
    return out


def _pick_best_candidate(candidates: dict[str, dict], min_mae_improvement_pct: float) -> tuple[str | None, bool, int]:
    """best_baseline = lowest-MAE eligible baseline; LightGBM only wins if it
    beats best_baseline's MAE by min_mae_improvement_pct — "passed" must
    never collapse to "LightGBM won"; a baseline the model fails to beat is
    still a perfectly valid *selected* method."""
    baseline_names = ("persistence", "diurnal", "same_hour_yesterday", "rolling_24h_avg")
    eligible_baselines = {
        n: c for n, c in candidates.items()
        if n in baseline_names and c["sample_size"] >= forecast.MIN_NOWCAST_VALIDATION_SAMPLES and c["mae"] is not None
    }
    if not eligible_baselines:
        return None, False, 0

    best_baseline_name = min(eligible_baselines, key=lambda n: eligible_baselines[n]["mae"])
    best_baseline = eligible_baselines[best_baseline_name]

    lgb_c = candidates.get("lightgbm")
    if (
        lgb_c is not None
        and lgb_c["mae"] is not None
        and lgb_c["sample_size"] >= forecast.MIN_NOWCAST_VALIDATION_SAMPLES
        and lgb_c["mae"] <= best_baseline["mae"] * (1 - min_mae_improvement_pct / 100.0)
    ):
        return "lightgbm", True, lgb_c["sample_size"]
    return best_baseline_name, True, best_baseline["sample_size"]


def run_for_ward_pollutant(
    ward_id: int,
    pollutant: str,
    df: pd.DataFrame,
    weather_df: pd.DataFrame,
    no2_readings_df: pd.DataFrame | None,
    fire_counts_series: pd.Series | None,
    min_mae_improvement_pct: float,
) -> dict | None:
    ward_raw = df[df["ward_id"] == ward_id].set_index("ts").sort_index()["local_excess"]
    if ward_raw.empty:
        return None
    w = forecast._ward_series(df, ward_id)  # filled/interpolated — training history only, never the evaluation label
    if w.empty:
        return None
    filled = w["local_excess"].astype(float)

    wx_ward = weather_df[weather_df["ward_id"] == ward_id].set_index("ts").sort_index()
    city_avg = forecast._city_avg_series(df)

    no2_ward_series = None
    if no2_readings_df is not None and not no2_readings_df.empty:
        no2_ward = no2_readings_df[no2_readings_df["ward_id"] == ward_id].set_index("ts").sort_index()
        if not no2_ward.empty:
            no2_ward_series = no2_ward["value"]

    lgb_metrics = _blocked_lightgbm_backtest(
        ward_raw, filled, wx_ward, city_avg, no2_ward_series, fire_counts_series, forecast.NOWCAST_BACKTEST_WINDOW_DAYS
    )
    baseline_metrics = _baseline_backtest(ward_raw, filled, forecast.NOWCAST_BACKTEST_WINDOW_DAYS)

    candidates = {**baseline_metrics}
    if lgb_metrics["sample_size"] > 0:
        candidates["lightgbm"] = lgb_metrics

    best_candidate, passed, sample_size = _pick_best_candidate(candidates, min_mae_improvement_pct)

    return {
        "ward_id": ward_id,
        "pollutant": pollutant,
        "candidates": candidates,
        "best_candidate": best_candidate,
        "sample_size": sample_size,
        "passed": passed,
        "model_version": forecast.MODEL_VERSION_LGB,
        "methodology_version": forecast.NOWCAST_METHODOLOGY_VERSION,
        "data_through": ward_raw.index.max().isoformat(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--city", default=None, help="City code (default: all active cities)")
    args = parser.parse_args()

    cities = db.get_active_cities(args.city)
    wards = {w["id"]: w for w in db.get_wards_with_city()}
    hours = FETCH_HISTORY_DAYS * 24
    readings = db.get_readings_history(hours=hours)
    weather_df = forecast._hourly_ward_weather(db.get_weather_history(hours=hours))
    fire_counts_series = forecast._daily_fire_counts(db.get_fire_counts_history(days=hours // 24 + 15))

    written = 0
    for city in cities:
        cfg = forecast._forecasting_config(city)
        city_wards = [w for w in wards.values() if w.get("city_id") == city["id"]]
        no2_readings_df = forecast._hourly_ward_pollutant(readings, "no2")

        for pollutant in cfg["enabled_pollutants"]:
            readings_df = forecast._hourly_ward_pollutant(readings, pollutant)
            if readings_df.empty:
                continue
            df = forecast._with_local_excess(readings_df)

            for ward in city_wards:
                result = run_for_ward_pollutant(
                    ward["id"], pollutant, df, weather_df,
                    no2_readings_df if pollutant != "no2" else None,
                    fire_counts_series if not fire_counts_series.empty else None,
                    cfg["min_mae_improvement_pct"],
                )
                if result is None:
                    continue
                db.upsert_nowcast_backtest_result(result)
                written += 1
                print(
                    f"ward={result['ward_id']} pollutant={pollutant} "
                    f"best_candidate={result['best_candidate']} passed={result['passed']} "
                    f"sample_size={result['sample_size']}"
                )

    print(f"\nnowcast_backtest_results written/updated: {written}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
