"""Unified pollutant forecasting (Phase 8): PM2.5 (core), PM10 (once a ward has
enough history), NO2 (optional/supporting) — one shared pipeline and one
shared validation methodology, replacing the earlier PM2.5-only version.

Local excess = ward value - city-wide median value at the same hour, for
whichever pollutant is being forecast. That is the part a ward officer can
actually move (dust, construction, burning, industry) — no ward action shifts
the regional baseline, so we forecast the controllable delta, exactly as
before.

Model: LightGBM on pollutant lags + weather (historical AND a genuine
Open-Meteo hourly FORECAST, not persisted current weather) + calendar +
spatial (other-wards) features, once there is enough history; a diurnal-
persistence fallback until then. Every generation is validated with a
TIME-BASED holdout (never random — plan's own explicit requirement): the
model is asked to recursively forecast the SAME holdout window using only
information available at the split point (exactly mirroring what it does
for real future forecasts — no leakage of the true intervening lags), then
compared against a flat-persistence baseline and a seasonal/hourly (diurnal)
baseline at each of the four supported horizons (6/12/24/48h). A horizon is
only ever marked "validated" if the model beats persistence there (and every
smaller horizon) by at least the city's configured margin — "a model must
not be marked production-ready unless it beats persistence" is therefore a
stored, checked fact (`forecast_runs.beats_persistence`/
`max_validated_horizon_hours`), never an assumption.

Every generation writes ONE `forecast_runs` row (method actually used,
training period, per-horizon metrics, data-quality status) plus up to 48
`forecasts` rows (one per hour, with `predicted_value`/`lower_bound`/
`upper_bound` and a `forecast_run_id` back-reference) — see
supabase/migrations/20260723000000_unified_forecasting.sql. The anomaly-
detection engine (`evaluate_station_pollutant_anomaly`, SQL) reads these
`forecast_runs` rows directly to decide whether a "predicted" incident may
use the validated forecast or must fall back to its own raw-reading trend
projection — this module never touches `incidents` itself.
"""

import logging
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from . import db, open_meteo

log = logging.getLogger("ingest.forecast")

HORIZONS_H = (6, 12, 24, 48)
MAX_HORIZON_H = max(HORIZONS_H)
MIN_TRAIN_ROWS = 24 * 10  # ~10 days of hourly data before we trust a learned model
MODEL_VERSION_LGB = "lgb_unified_v2"
MODEL_VERSION_DIURNAL = "diurnal_persistence_v2"
DEFAULT_ENABLED_POLLUTANTS = ("pm25", "pm10", "no2")
DEFAULT_MIN_MAE_IMPROVEMENT_PCT = 5.0
# ~80% two-sided interval under a normal residual approximation — a stated,
# simple choice (not a quantile-regression model), documented as such in
# docs/DATA_QUALITY_AND_SCIENCE.md.
UNCERTAINTY_Z = 1.28

try:
    import lightgbm as lgb

    _HAS_LGB = True
except Exception:  # pragma: no cover - lightgbm optional at runtime
    _HAS_LGB = False


# ── config ────────────────────────────────────────────────────────────────────


def _forecasting_config(city_row: dict) -> dict:
    """Read city_config.config->'forecasting', with documented fallbacks —
    same pattern as the Phase 6/7 SQL functions' own city-configurable reads,
    kept in Python here because the model itself only exists in Python."""
    cfg = (city_row.get("config") or {}).get("forecasting") or {}
    return {
        "enabled_pollutants": cfg.get("enabled_pollutants") or list(DEFAULT_ENABLED_POLLUTANTS),
        "horizons_hours": tuple(cfg.get("horizons_hours") or HORIZONS_H),
        "min_mae_improvement_pct": cfg.get("min_mae_improvement_pct", DEFAULT_MIN_MAE_IMPROVEMENT_PCT),
        "pollutant_thresholds": ((city_row.get("config") or {}).get("anomaly_detection") or {}).get(
            "pollutant_thresholds", {}
        ),
    }


# ── data assembly ────────────────────────────────────────────────────────────


def _hourly_ward_pollutant(rows: list[dict], pollutant: str) -> pd.DataFrame:
    """Continuous hourly value per ward for one pollutant. Columns: ts, ward_id, value."""
    if not rows:
        return pd.DataFrame(columns=["ts", "ward_id", "value"])
    df = pd.DataFrame(rows).dropna(subset=[pollutant])
    if df.empty:
        return pd.DataFrame(columns=["ts", "ward_id", "value"])
    df["ts"] = pd.to_datetime(df["ts"], utc=True).dt.floor("h")
    out = df.groupby(["ts", "ward_id"], as_index=False)[pollutant].mean()
    return out.rename(columns={pollutant: "value"})


def _hourly_ward_weather(rows: list[dict]) -> pd.DataFrame:
    """Continuous hourly weather per ward. Columns: ts, ward_id, temp_c, humidity, wind_speed, wind_dir, precipitation."""
    cols = ["temp_c", "humidity", "wind_speed", "wind_dir", "precipitation"]
    if not rows:
        return pd.DataFrame(columns=["ts", "ward_id", *cols])
    df = pd.DataFrame(rows)
    df["ts"] = pd.to_datetime(df["ts"], utc=True).dt.floor("h")
    return df.groupby(["ts", "ward_id"], as_index=False)[cols].mean()


def _with_local_excess(df: pd.DataFrame) -> pd.DataFrame:
    """Add city baseline (median across wards per hour) and local_excess."""
    baseline = df.groupby("ts")["value"].median().rename("baseline")
    df = df.merge(baseline, on="ts", how="left")
    df["local_excess"] = df["value"] - df["baseline"]
    return df


def _city_avg_series(df: pd.DataFrame) -> pd.Series:
    """City-wide mean value per hour — the "nearby station readings" spatial
    signal (plan §3): every OTHER ward's simultaneous reading, aggregated."""
    return df.groupby("ts")["value"].mean()


def _ward_series(df: pd.DataFrame, ward_id: int) -> pd.DataFrame:
    """Continuous hourly series for one ward, gaps interpolated."""
    w = df[df["ward_id"] == ward_id].set_index("ts").sort_index()
    if w.empty:
        return w
    full = pd.date_range(w.index.min(), w.index.max(), freq="h", tz="UTC")
    w = w.reindex(full)
    w["local_excess"] = w["local_excess"].interpolate(limit=6).ffill().bfill()
    w["baseline"] = w["baseline"].interpolate(limit=6).ffill().bfill()
    w["value"] = w["value"].interpolate(limit=6).ffill().bfill()
    return w


# ── metrics (plan §4: MAE, RMSE, bias, threshold recall, false-alarm rate) ────


def _mae(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(np.abs(a - b)))


def _rmse(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.sqrt(np.mean((a - b) ** 2)))


def _bias(pred: np.ndarray, actual: np.ndarray) -> float:
    """Mean signed error: positive = systematically over-predicting."""
    return float(np.mean(pred - actual))


def _threshold_metrics(pred: np.ndarray, actual: np.ndarray, threshold: float | None) -> tuple[float | None, float | None]:
    """(threshold_recall, false_alarm_rate). None when there is no threshold
    configured or no actual/predicted crossing events to score against —
    never a fabricated 0/1."""
    if threshold is None:
        return None, None
    actual_pos = actual >= threshold
    pred_pos = pred >= threshold
    recall = float((actual_pos & pred_pos).sum() / actual_pos.sum()) if actual_pos.sum() > 0 else None
    false_alarm = float((pred_pos & ~actual_pos).sum() / pred_pos.sum()) if pred_pos.sum() > 0 else None
    return recall, false_alarm


# ── features ─────────────────────────────────────────────────────────────────


def _make_features(w: pd.DataFrame, weather: pd.DataFrame, city_avg: pd.Series) -> pd.DataFrame:
    """Lag + weather + calendar + spatial features for the local_excess series.

    Inputs used (plan §3): pollutant lags (lag1/lag24), weather (temp/
    humidity/wind speed/wind direction as sin+cos/rainfall), hour/day/month
    (season proxy), nearby-station (city-average) reading, local excess
    itself (the target). Deliberately does NOT invent traffic or satellite
    features — none exist anywhere in this codebase (plan's own explicit limit).
    """
    f = pd.DataFrame({"y": w["local_excess"]})
    f["lag1"] = f["y"].shift(1)
    f["lag24"] = f["y"].shift(24)
    f["hour"] = f.index.hour
    f["dow"] = f.index.dayofweek
    f["month"] = f.index.month

    wx = weather.reindex(f.index)
    f["temp_c"] = wx["temp_c"]
    f["humidity"] = wx["humidity"]
    f["wind_speed"] = wx["wind_speed"]
    rad = np.deg2rad(wx["wind_dir"].astype(float))
    f["wind_dir_sin"] = np.sin(rad)
    f["wind_dir_cos"] = np.cos(rad)
    f["precipitation"] = wx["precipitation"]

    f["city_avg_lag1"] = city_avg.reindex(f.index).shift(1)

    # Weather/spatial gaps are common (a ward's own weather may lag readings by
    # an hour); forward/back-fill a short gap rather than dropping the whole
    # row, then leave any still-missing value as NaN — never a fabricated 0.
    for c in ["temp_c", "humidity", "wind_speed", "wind_dir_sin", "wind_dir_cos", "precipitation", "city_avg_lag1"]:
        # A ward with no weather rows at all reindexes to an all-NaN object-
        # dtype column, which pandas' interpolate() refuses outright — force
        # numeric first so a genuinely weather-less ward degrades to "every
        # weather feature missing" (later dropped by the caller's .dropna())
        # rather than crashing the whole run.
        f[c] = pd.to_numeric(f[c], errors="coerce").interpolate(limit=6).ffill().bfill()

    return f


FEATURE_COLS = [
    "lag1", "lag24", "hour", "dow", "month",
    "temp_c", "humidity", "wind_speed", "wind_dir_sin", "wind_dir_cos", "precipitation",
    "city_avg_lag1",
]


def _future_weather_frame(future_idx: pd.DatetimeIndex, hourly_forecast: list[dict]) -> pd.DataFrame:
    """Real Open-Meteo hourly FORECAST (plan §3's "weather forecast" input),
    reindexed onto the recursive forecast's own future timestamps. Falls back
    to the last known weather (persistence) hour-by-hour past the fetched
    range, or when the fetch failed — stated, not silently guessed as zero."""
    if not hourly_forecast:
        return pd.DataFrame(index=future_idx, columns=["temp_c", "humidity", "wind_speed", "wind_dir", "precipitation"])
    wf = pd.DataFrame(hourly_forecast)
    wf["ts"] = pd.to_datetime(wf["ts_utc"], utc=True).dt.floor("h")
    wf = wf.set_index("ts")[["temp_c", "humidity", "wind_speed", "wind_dir", "precipitation"]]
    return wf.reindex(future_idx).ffill().bfill()


# ── validation: time-based holdout, recursive re-simulation ───────────────────


def _recursive_forecast(
    hist_local_excess: list[float],
    weather_hist: pd.DataFrame,
    city_avg_hist: pd.Series,
    future_idx: pd.DatetimeIndex,
    future_weather: pd.DataFrame,
    model,
) -> np.ndarray:
    """Recursively forecast local_excess for every timestamp in future_idx,
    using ONLY `hist_*` (data available up to the start of future_idx) plus
    the model's own prior predictions as lag inputs — the same procedure
    used for both the real future forecast AND the holdout backtest, so the
    backtest is a faithful simulation of what the model actually knew at
    that point (no leakage of true intervening values)."""
    hist = list(hist_local_excess)
    city_hist = city_avg_hist.copy()
    preds = []
    for t in future_idx:
        lag1 = hist[-1]
        lag24 = hist[-24] if len(hist) >= 24 else hist[0]
        wx = future_weather.loc[t] if t in future_weather.index else pd.Series(dtype=float)
        rad = np.deg2rad(float(wx.get("wind_dir", np.nan))) if pd.notna(wx.get("wind_dir", np.nan)) else np.nan
        city_lag1 = city_hist.iloc[-1] if len(city_hist) else np.nan
        x = pd.DataFrame(
            [[
                lag1, lag24, t.hour, t.dayofweek, t.month,
                wx.get("temp_c", np.nan), wx.get("humidity", np.nan), wx.get("wind_speed", np.nan),
                np.sin(rad) if pd.notna(rad) else np.nan, np.cos(rad) if pd.notna(rad) else np.nan,
                wx.get("precipitation", np.nan), city_lag1,
            ]],
            columns=FEATURE_COLS,
        ).ffill(axis=1).bfill(axis=1)  # a single missing weather cell should not blank the whole row
        yhat = float(model.predict(x)[0])
        preds.append(yhat)
        hist.append(yhat)
        # the "nearby stations" series has no future model of its own here —
        # persistence is the honest, stated assumption for that one input.
        city_hist = pd.concat([city_hist, pd.Series([city_lag1])])
    return np.array(preds)


def _baseline_forecast(hist_local_excess: list[float], future_idx: pd.DatetimeIndex, by_hour: pd.Series) -> tuple[np.ndarray, np.ndarray]:
    """(persistence, diurnal) baseline trajectories over future_idx."""
    last = hist_local_excess[-1]
    persistence = np.full(len(future_idx), last)
    diurnal = np.array([by_hour.get(t.hour, last) for t in future_idx])
    return persistence, diurnal


ROLLING_AVG_WINDOW_H = 24


def _same_hour_yesterday_baseline(hist_local_excess: list[float], n_future: int) -> np.ndarray:
    """Seasonal-naive baseline: hour i of the forecast repeats hour i of the
    most recent 24h of known history (cycled forward for i > 24). Every
    referenced value is drawn from `hist_local_excess` alone — never from
    the baseline's own prior predictions or anything in `future_idx` — so
    this stays causally valid (no peeking at data that wouldn't exist yet
    at real forecast-generation time) for every one of the 4 supported
    horizons, including 48h, unlike a naive `t - 24h` lookup (which for
    i > 24 would land inside the forecast window itself).
    Falls back to flat persistence (the last known value, repeated) when
    there's under 24h of history to draw a cycle from — a real, honest
    degradation, not a crash."""
    if len(hist_local_excess) < ROLLING_AVG_WINDOW_H:
        return np.full(n_future, hist_local_excess[-1])
    last_24h = np.array(hist_local_excess[-ROLLING_AVG_WINDOW_H:])
    reps = int(np.ceil(n_future / ROLLING_AVG_WINDOW_H))
    return np.tile(last_24h, reps)[:n_future]


def _rolling_average_baseline(hist_local_excess: list[float], n_future: int) -> np.ndarray:
    """Flat baseline at the mean of the most recent ROLLING_AVG_WINDOW_H
    hours of known history (or all of history, if there's less than that) —
    smooths out single-hour noise persistence can't, at the cost of
    reacting slower to a genuine trend."""
    window = hist_local_excess[-ROLLING_AVG_WINDOW_H:] if len(hist_local_excess) >= ROLLING_AVG_WINDOW_H else hist_local_excess
    return np.full(n_future, float(np.mean(window)))


def _validate(
    w: pd.DataFrame,
    weather: pd.DataFrame,
    city_avg: pd.Series,
    threshold: float | None,
    baseline_value_at_split: float,
    min_mae_improvement_pct: float,
) -> tuple[str, dict, int | None, bool]:
    """Time-based holdout validation. Returns (method, validation_metrics,
    max_validated_horizon_hours, beats_persistence_overall)."""
    excess = w["local_excess"].astype(float)
    n = len(excess)
    split = max(n - MAX_HORIZON_H, int(n * 0.8))
    if split < 24 or n - split < HORIZONS_H[0]:
        # not even enough holdout to evaluate the smallest horizon
        return MODEL_VERSION_DIURNAL, {}, None, False

    train_hist = list(excess.iloc[:split].to_numpy())
    holdout_idx = w.index[split:split + MAX_HORIZON_H]
    holdout_actual = excess.reindex(holdout_idx).to_numpy()
    valid_mask = ~np.isnan(holdout_actual)
    if valid_mask.sum() < HORIZONS_H[0]:
        return MODEL_VERSION_DIURNAL, {}, None, False

    by_hour = excess.iloc[:split].groupby(excess.iloc[:split].index.hour).mean()
    persistence, diurnal = _baseline_forecast(train_hist, holdout_idx, by_hour)
    same_hour_yesterday = _same_hour_yesterday_baseline(train_hist, len(holdout_idx))
    rolling_avg = _rolling_average_baseline(train_hist, len(holdout_idx))
    # Named once here so both the per-horizon loop and the "which baseline
    # won" bookkeeping stay in lockstep — add a fifth candidate by adding
    # one entry to this dict, nowhere else.
    baseline_preds = {
        "persistence": persistence,
        "diurnal": diurnal,
        "same_hour_yesterday": same_hour_yesterday,
        "rolling_24h_avg": rolling_avg,
    }

    use_lgb = n >= MIN_TRAIN_ROWS and _HAS_LGB
    model_pred = diurnal
    method = MODEL_VERSION_DIURNAL
    if use_lgb:
        feats = _make_features(w.iloc[:split], weather, city_avg).dropna()
        if len(feats) >= MIN_TRAIN_ROWS // 2:
            model = lgb.LGBMRegressor(n_estimators=300, learning_rate=0.05, num_leaves=31, min_child_samples=10, verbose=-1)
            model.fit(feats[FEATURE_COLS], feats["y"])
            future_weather = weather.reindex(holdout_idx)
            model_pred = _recursive_forecast(train_hist, weather.iloc[:split], city_avg.iloc[:split], holdout_idx, future_weather, model)
            method = MODEL_VERSION_LGB

    metrics: dict = {}
    max_validated = None
    for h in HORIZONS_H:
        upto = min(h, len(holdout_idx))
        mask = valid_mask[:upto]
        if mask.sum() == 0:
            continue
        a = holdout_actual[:upto][mask] + baseline_value_at_split
        m = model_pred[:upto][mask] + baseline_value_at_split

        model_mae = _mae(m, a)
        recall, false_alarm = _threshold_metrics(m, a, threshold)

        # Every candidate baseline's MAE at this horizon — persistence is
        # kept as its own named field below (existing consumers, notably
        # PredictedIncidentPanel.tsx, read `persistence_mae` directly and
        # display it verbatim; that number's meaning is unchanged). The
        # model is now judged against whichever candidate is hardest to
        # beat, not persistence alone — same-hour-yesterday and a 24h
        # rolling average are real, cheap-to-compute baselines that can
        # legitimately beat persistence at short horizons for a noisy
        # pollutant series (confirmed for Rohini/pm25 in
        # docs/data/rohini-pm25-forecast-validation.md), so a model that
        # only clears persistence isn't yet a genuinely useful upgrade.
        baseline_maes = {name: _mae(pred[:upto][mask] + baseline_value_at_split, a) for name, pred in baseline_preds.items()}
        best_baseline = min(baseline_maes, key=baseline_maes.get)
        best_baseline_mae = baseline_maes[best_baseline]
        beats = best_baseline_mae > 0 and model_mae <= best_baseline_mae * (1 - min_mae_improvement_pct / 100.0)

        metrics[str(h)] = {
            "mae": round(model_mae, 2),
            "rmse": round(_rmse(m, a), 2),
            "bias": round(_bias(m, a), 2),
            "threshold_recall": round(recall, 2) if recall is not None else None,
            "false_alarm_rate": round(false_alarm, 2) if false_alarm is not None else None,
            "persistence_mae": round(baseline_maes["persistence"], 2),
            "diurnal_mae": round(baseline_maes["diurnal"], 2),
            "same_hour_yesterday_mae": round(baseline_maes["same_hour_yesterday"], 2),
            "rolling_24h_avg_mae": round(baseline_maes["rolling_24h_avg"], 2),
            "best_baseline": best_baseline,
            "best_baseline_mae": round(best_baseline_mae, 2),
            # Kept as `beats_persistence` (not renamed — forecast_runs has no
            # schema for a differently-named column, and PredictedIncidentPanel.tsx
            # reads this exact key) but now means "beat the strongest of ALL
            # candidate baselines", a strictly harder bar than the old
            # persistence-only check: best_baseline_mae <= persistence_mae
            # always (persistence is itself one of the candidates), so
            # beats=true here still guarantees the model beat plain
            # persistence too — this can only make the flag true LESS often
            # than before, never more. Existing readers (the anomaly-
            # detection SQL's `fr.beats_persistence` gate, the UI's
            # "Persistence MAE" tooltip) become more conservative, not wrong.
            "beats_persistence": bool(beats),
        }
        # Monotonic and conservative on purpose: this horizon only becomes
        # the new max-validated one if it AND every smaller configured
        # horizon have all beaten the strongest available baseline — a
        # model that wins at 24h but loses at 6h is not "validated to 24h".
        if all(metrics.get(str(hh), {}).get("beats_persistence") for hh in HORIZONS_H if hh <= h):
            max_validated = h

    beats_overall = max_validated is not None
    return (method if beats_overall else MODEL_VERSION_DIURNAL), metrics, max_validated, beats_overall


# ── per ward+pollutant orchestration ─────────────────────────────────────────


def _forecast_ward_pollutant(
    ward: dict,
    pollutant: str,
    readings_df: pd.DataFrame,
    weather_df: pd.DataFrame,
    threshold: float | None,
    min_mae_improvement_pct: float,
) -> dict | None:
    ward_id = int(ward["id"])
    df = _with_local_excess(readings_df)
    city_avg = _city_avg_series(readings_df)
    w = _ward_series(df, ward_id)
    if w.empty or w["local_excess"].dropna().empty:
        return None

    n = len(w)
    expected_hours = max((w.index.max() - w.index.min()).total_seconds() / 3600.0, 1)
    completeness = min(1.0, n / expected_hours)
    data_quality_status = "ok"
    if n < HORIZONS_H[0]:
        data_quality_status = "insufficient_data"
    elif completeness < 0.5:
        data_quality_status = "stale_inputs"

    wx_ward = weather_df[weather_df["ward_id"] == ward_id].set_index("ts").sort_index()
    latest_baseline = float(df.sort_values("ts")["baseline"].iloc[-1])

    method, validation_metrics, max_validated, beats_persistence = _validate(
        w, wx_ward, city_avg, threshold, latest_baseline, min_mae_improvement_pct
    )

    # ---- the real, future 48h forecast, using ALL available history ----
    excess_hist = list(w["local_excess"].astype(float).to_numpy())
    start = w.index[-1]
    future_idx = pd.date_range(start + timedelta(hours=1), periods=MAX_HORIZON_H, freq="h", tz="UTC")

    hourly_forecast: list[dict] = []
    if ward.get("lat") is not None and ward.get("lng") is not None:
        try:
            hourly_forecast = open_meteo.get_hourly_forecast(ward["lat"], ward["lng"], hours=MAX_HORIZON_H)
        except Exception:
            log.exception("weather forecast fetch failed for ward %s — falling back to persisted weather", ward_id)
    future_weather = _future_weather_frame(future_idx, hourly_forecast)

    residual_std = None
    if validation_metrics:
        # a stated, simple uncertainty proxy: RMSE at the horizon closest to
        # what we're about to predict, from the SAME validated run.
        residual_std = validation_metrics.get(str(HORIZONS_H[-1]), {}).get("rmse")

    if method == MODEL_VERSION_LGB:
        feats = _make_features(w, wx_ward, city_avg).dropna()
        model = lgb.LGBMRegressor(n_estimators=300, learning_rate=0.05, num_leaves=31, min_child_samples=10, verbose=-1)
        model.fit(feats[FEATURE_COLS], feats["y"])
        preds = _recursive_forecast(excess_hist, wx_ward, city_avg, future_idx, future_weather, model)
    else:
        by_hour = w["local_excess"].astype(float).groupby(w.index.hour).mean()
        persistence, diurnal = _baseline_forecast(excess_hist, future_idx, by_hour)
        blend_w = np.clip(np.arange(MAX_HORIZON_H) / 24.0, 0, 1)
        preds = (1 - blend_w) * persistence + blend_w * diurnal

    confidence = 0.5
    if beats_persistence and max_validated:
        confidence = float(np.clip(0.4 + 0.1 * HORIZONS_H.index(max_validated), 0.4, 0.9))

    return {
        "ward_id": ward_id,
        "pollutant": pollutant,
        "method": "lightgbm" if method == MODEL_VERSION_LGB else "diurnal_persistence",
        "model_version": method,
        "generated_at": datetime.now(timezone.utc),
        "training_period_start": w.index.min().to_pydatetime(),
        "training_period_end": w.index.max().to_pydatetime(),
        "training_rows": n,
        "data_completeness": round(completeness, 3),
        "data_quality_status": data_quality_status,
        "validation_metrics": validation_metrics,
        "max_validated_horizon_hours": max_validated,
        "beats_persistence": beats_persistence,
        "latest_baseline": latest_baseline,
        "future_idx": future_idx,
        "preds": preds,
        "confidence": confidence,
        "residual_std": residual_std,
    }


def run(city_code: str | None = None) -> dict:
    """Compute and store a validated, multi-pollutant forecast per ward.
    Idempotent (replaces per ward+pollutant)."""
    summary = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "runs": 0,
        "skipped": [],
        "beats_persistence": 0,
    }

    cities = db.get_active_cities(city_code)
    wards = {w["id"]: w for w in db.get_wards_with_city()}

    for city in cities:
        cfg = _forecasting_config(city)
        city_wards = [w for w in wards.values() if w.get("city_id") == city["id"]]
        if not city_wards:
            continue

        # Fetch once per city (not per pollutant) — all three pollutants read
        # the same 30-day window; re-fetching inside the loop triples the
        # number of large paginated DB requests for no benefit.
        readings = db.get_readings_history(hours=24 * 30)
        weather_df = _hourly_ward_weather(db.get_weather_history(hours=24 * 30))
        last_forecast_times = db.get_last_forecast_times(city["id"])

        for pollutant in cfg["enabled_pollutants"]:
            readings_df = _hourly_ward_pollutant(readings, pollutant)
            if readings_df.empty:
                log.info("no %s readings yet for city %s — nothing to forecast", pollutant, city["city_code"])
                continue
            threshold = cfg["pollutant_thresholds"].get(pollutant)

            for ward in city_wards:
                # Skip retraining if no new readings have arrived since the last
                # forecast for this ward+pollutant — the model would produce
                # identical results. Saves ~1 LightGBM retrain per ward per hour
                # when the ingest cycle hasn't yet written new data.
                last_forecast = last_forecast_times.get((ward["id"], pollutant))
                if last_forecast is not None:
                    ward_rows = readings_df[readings_df["ward_id"] == ward["id"]]
                    if not ward_rows.empty:
                        latest_ts = ward_rows["ts"].max()
                        if pd.Timestamp(latest_ts) <= last_forecast:
                            log.debug(
                                "ward %s %s: no new readings since last forecast (%s) — skipping",
                                ward["id"], pollutant, last_forecast.isoformat(),
                            )
                            continue
                result = _forecast_ward_pollutant(
                    ward, pollutant, readings_df, weather_df, threshold, cfg["min_mae_improvement_pct"]
                )
                if result is None:
                    summary["skipped"].append({"ward_id": ward["id"], "pollutant": pollutant})
                    continue

                run_id = db.insert_forecast_run(
                    {
                        "city_id": city["id"],
                        "ward_id": result["ward_id"],
                        "pollutant": pollutant,
                        "method": result["method"],
                        "model_version": result["model_version"],
                        "generated_at": result["generated_at"].isoformat(),
                        "training_period_start": result["training_period_start"].isoformat(),
                        "training_period_end": result["training_period_end"].isoformat(),
                        "training_rows": result["training_rows"],
                        "data_completeness": result["data_completeness"],
                        "data_quality_status": result["data_quality_status"],
                        "validation_metrics": result["validation_metrics"],
                        "max_validated_horizon_hours": result["max_validated_horizon_hours"],
                        "beats_persistence": result["beats_persistence"],
                    }
                )

                rows = []
                z = UNCERTAINTY_Z * (result["residual_std"] or 0)
                for t, excess_pred in zip(result["future_idx"], result["preds"]):
                    predicted = max(result["latest_baseline"] + float(excess_pred), 0.0)
                    row = {
                        "ward_id": result["ward_id"],
                        "pollutant": pollutant,
                        "generated_at": result["generated_at"].isoformat(),
                        "horizon_ts": t.isoformat(),
                        "baseline_pred": round(result["latest_baseline"], 1),
                        "local_excess": round(float(excess_pred), 1),
                        "confidence": round(result["confidence"], 2),
                        "model_version": result["model_version"],
                        "predicted_value": round(predicted, 1),
                        "lower_bound": round(max(predicted - z, 0.0), 1) if z else None,
                        "upper_bound": round(predicted + z, 1) if z else None,
                        "forecast_run_id": run_id,
                    }
                    if pollutant == "pm25":
                        # legacy column, kept populated for backward
                        # compatibility with fetchForecast/ForecastChart.
                        row["pm25_pred"] = round(predicted, 1)
                    rows.append(row)
                db.replace_forecasts(result["ward_id"], pollutant, rows)

                summary["runs"] += 1
                if result["beats_persistence"]:
                    summary["beats_persistence"] += 1

    summary["finished_at"] = datetime.now(timezone.utc).isoformat()
    log.info("forecast done: %s", summary)
    return summary
