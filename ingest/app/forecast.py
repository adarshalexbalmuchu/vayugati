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
from collections import deque
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from . import db, open_meteo

log = logging.getLogger("ingest.forecast")

HORIZONS_H = (6, 12, 24, 48)
MAX_HORIZON_H = max(HORIZONS_H)
MIN_TRAIN_ROWS = 24 * 10  # ~10 days of hourly data before we trust a learned model
MODEL_VERSION_LGB = "lgb_unified_v4"
MODEL_VERSION_DIURNAL = "diurnal_persistence_v2"
# Without this, LightGBM's own internal randomness (bagging, split
# tie-breaking) is unseeded, so the exact same input data can train a
# slightly different model on different machines/runs — usually harmless,
# but made test_lightgbm_path_can_be_selected_when_it_genuinely_beats_
# persistence flaky across environments (passed locally, failed in CI) since
# "beats persistence by >=5%" is a threshold a marginal difference can flip.
LGB_RANDOM_STATE = 42
DEFAULT_ENABLED_POLLUTANTS = ("pm25", "pm10", "no2")
DEFAULT_MIN_MAE_IMPROVEMENT_PCT = 5.0
# Gaussian fallback Z-score (80% two-sided interval) — used only when the
# quantile models below cannot be trained (diurnal fallback path).
UNCERTAINTY_Z = 1.28

# ── ward-level nowcasting (+1h) ──────────────────────────────────────────────
# A dedicated, independently-validated "next hour" point distinct from the
# 6/12/24/48h forecast — see docs/data/nowcast-shadow-review.md for the
# release-gate this schema/pipeline exists to support. HORIZONS_H above is
# deliberately untouched by any of this: widening it to include 1 would
# silently change confidence's formula and the holdout-sufficiency gates for
# the *existing* validated horizons (HORIZONS_H.index(...) is baked into
# both) — the nowcast point is one specific row already present among the 48
# `forecasts.horizon_ts` values `future_idx` already produces, not a new
# horizon added to the validation set.
NOWCAST_TARGET_HOURS = 1
NOWCAST_TOLERANCE_MINUTES = 30
NOWCAST_BACKTEST_WINDOW_DAYS = 30
MIN_NOWCAST_VALIDATION_SAMPLES = 72  # ~3 days at one backtest-origin/hour, comfortably below the ~700 a 30-day blocked backtest yields
NOWCAST_BACKTEST_REFRESH_DAYS = 2 * NOWCAST_BACKTEST_WINDOW_DAYS
NOWCAST_METHODOLOGY_VERSION = "nowcast_backtest_v1"  # bump when nowcast_backtest.py's methodology changes materially
NOWCAST_CANDIDATE_METHODS = ("lightgbm", "persistence", "diurnal", "same_hour_yesterday", "rolling_24h_avg")

# Wind speed threshold for stagnation index (m/s). Winds below this are
# "calm" for PM2.5 accumulation purposes.
# Literature: Guttikunda & Gurjar (2012) Atm. Env.; Navinya et al. (2020)
# Environ. Monit. Assess.; CPCB GRAP 2023 science note — consecutive calm
# hours is the #1 cited meteorological predictor of Delhi/IGP AQ episodes.
STAGNATION_THRESHOLD_MS: float = 2.0

# Diwali main-day lookup (Indian lunar calendar; source: Press Information Bureau).
# A ±DIWALI_WINDOW_DAYS window around each date is flagged as is_diwali=1.
# Literature: Kumar et al. (2021) Environ. Res.; Tiwari et al. (2019) Sci. Rep.;
# Singh et al. (2022) ACP — firecracker burning peaks PM2.5 5–10× above the
# seasonal background; ML models systematically underpredict without this flag.
DIWALI_WINDOW_DAYS: int = 2
_DIWALI_MAIN_DAYS: frozenset[tuple[int, int, int]] = frozenset({
    (2022, 10, 24), (2023, 11, 12), (2024, 11, 1),
    (2025, 10, 20), (2026, 11, 8), (2027, 10, 29), (2028, 10, 17),
})

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
    """Continuous hourly weather per ward.
    Columns: ts, ward_id, temp_c, humidity, wind_speed, wind_dir, precipitation,
             boundary_layer_height (m), ventilation_coefficient (m²/s).
    PBLH and VC are NULL for rows before migration 20260826200000 — handled
    as NaN by the feature builder, which ffill/bfill-fills short gaps."""
    cols = ["temp_c", "humidity", "wind_speed", "wind_dir", "precipitation",
            "boundary_layer_height", "ventilation_coefficient"]
    if not rows:
        return pd.DataFrame(columns=["ts", "ward_id", *cols])
    df = pd.DataFrame(rows)
    df["ts"] = pd.to_datetime(df["ts"], utc=True).dt.floor("h")
    # Ensure PBLH/VC columns exist even if the DB hasn't yet been migrated
    for c in ["boundary_layer_height", "ventilation_coefficient"]:
        if c not in df.columns:
            df[c] = float("nan")
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


def _daily_fire_counts(fire_rows: list[dict]) -> pd.Series:
    """Convert DB fire_counts rows to a UTC-midnight-indexed Series.

    Returns a Series of fire_count values indexed by UTC-midnight timestamps
    so _make_features() can look up fire counts by date with .get().
    Empty Series when no data is available (FIRMS key not set, off-season).

    Used by forecast.run() which calls db.get_fire_counts_history() once per
    city and passes the result here — no per-ward fetch."""
    if not fire_rows:
        return pd.Series(dtype=float)
    df = pd.DataFrame(fire_rows)
    df["date"] = pd.to_datetime(df["date"], utc=True)
    return df.set_index("date")["fire_count"].astype(float).sort_index()


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


# ── meteorological helper features ───────────────────────────────────────────


def _is_diwali(ts: pd.Timestamp) -> bool:
    """True when ts falls within DIWALI_WINDOW_DAYS of a known Diwali main day."""
    for y, m, d in _DIWALI_MAIN_DAYS:
        if abs((ts - pd.Timestamp(y, m, d, tz="UTC")).days) <= DIWALI_WINDOW_DAYS:
            return True
    return False


def _stagnation_hours(wind_speed_kmh: pd.Series) -> pd.Series:
    """Consecutive hours with wind speed below STAGNATION_THRESHOLD_MS.
    Resets to 0 when wind reaches or exceeds the threshold. Capped at 24h
    so a month-long winter calm event doesn't dominate the feature scale."""
    stagnant = (wind_speed_kmh / 3.6) < STAGNATION_THRESHOLD_MS
    # Each consecutive calm run gets a unique group id; cumsum within each
    # group gives the running "hours since last gust".
    groups = (~stagnant).cumsum()
    return stagnant.astype(float).groupby(groups).cumsum().clip(upper=24.0)


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


def _make_features(
    w: pd.DataFrame,
    weather: pd.DataFrame,
    city_avg: pd.Series,
    no2_series: pd.Series | None = None,
    fire_counts: pd.Series | None = None,
) -> pd.DataFrame:
    """Lag + weather + calendar + spatial features for the local_excess series.

    Literature basis for each feature group:

      lag1, lag24, lag48, lag72 — PMC12907896 (2026) and Bi-LSTM-GRU (Springer
        2024): extending the lag window to 72h improves 24–48h RMSE by ~10–15%.

      hour_sin, hour_cos — circular encoding of the 24h cycle avoids the
        artificial discontinuity between hour 23 and hour 0 that raw integer
        encoding creates; standard ML practice (Niculescu-Mizil 2005). Raw `hour`
        is dropped — the two trig features carry strictly more information.

      temp_lag24 — 24h surface temperature change (ΔT/24h). A falling ΔT signals
        the radiative-cooling onset that precedes nocturnal inversion and PBLH
        collapse (Aerosol Sci Tech 2025; JGR Atmospheres 2021). Complements the
        level features `temp_c` and `pblh`.

      pblh — boundary layer height (m). Inverse power-law with PM2.5; top-5 SHAP
        importance in every IGP ML study 2022–2025 (AMT 2019, JGR 2021).

      pblh_trend — 3h PBLH change (Δm over 3h). A collapsing PBLH (−200 m/3h)
        predicts a spike even when the current level is moderate; the rate of
        change is more actionable than the level alone (JGR Atmospheres 2021).

      vc — ventilation coefficient = PBLH × wind_speed (m²/s). VC < 6000 m²/s
        is India's SAFAR/CPCB "unfavourable dispersion" threshold (Theoretical
        and Applied Climatology 2025, IMDAA reanalysis).

      vc_unfavourable — binary: 1 when VC < 6000 m²/s. Captures the non-linear
        threshold response that the continuous vc feature cannot: PM2.5
        accumulation accelerates sharply below this value regardless of where
        in the favourable range we started (Theoretical and Applied Climatology
        2025, IMDAA reanalysis). When vc is NaN (PBLH unavailable), defaults to 0.

      stagnation_hours — consecutive hours with wind speed < 2 m/s. Captures
        the accumulation dynamics that current wind speed alone cannot: 8h of
        calm is qualitatively different from 1h of calm at the same speed.
        #1 cited meteorological predictor of Delhi/IGP AQ episodes (Guttikunda
        & Gurjar 2012 Atm. Env.; CPCB GRAP 2023 science note).

      is_diwali — binary flag for Diwali main day ±2 days. Firecracker burning
        drives PM2.5 5–10× above the seasonal background; models trained on
        non-Diwali data systematically underpredict these episodes without this
        flag (Kumar et al. 2021 Environ. Res.; Tiwari et al. 2019 Sci. Rep.).

      is_monsoon — binary: 1 for June–September (Indian SW monsoon). During
        this period wet deposition dominates PM2.5 removal and dispersion
        dynamics differ fundamentally from the post-monsoon accumulation regime;
        the model learns different PBLH/stagnation weights for each regime
        (Kumar et al. 2014 Atm. Env.; Tiwari et al. 2015 Atm. Env.).

      is_fog_season — binary: 1 for December–February (dense-fog inversion
        season). Nocturnal radiation inversions trap pollutants even at moderate
        PBLH; learning distinct weights for this period improves winter forecasts
        (Tiwari et al. 2015 Atm. Env.; IMDAA reanalysis 2025).

      no2_lag1 — NO2 concentration at t−1 (µg/m³). Proxy for fresh combustion /
        traffic emissions; rising NO2 precedes PM2.5 accumulation by 1–3h in
        urban IGP environments. Already stored in the readings table — no extra
        API fetch required (Chen et al. 2022 Sci. Total Environ.; Bai et al.
        2022 Environ. Sci. Technol. — ~8% RMSE reduction for Delhi PM2.5).
        None/NaN when forecasting NO2 itself (circular dependency) or when NO2
        data is unavailable for the ward.

      fire_count_lag1d — VIIRS SNPP NRT regional active-fire pixel count for
        Punjab + Haryana (distance > 50 km from Delhi), 1 calendar day prior.
        Stubble burning contributes 30–60% of Delhi's PM2.5 during Oct 15 –
        Nov 25; models without this feature systematically under-predict
        transport episodes (Gupta et al. 2021 JGR; Singh et al. 2022 ACP).
        Fetched daily; NaN outside the FIRMS key window or before first fetch.

      fire_count_lag2d — same, 2 calendar days prior. Smoke from Punjab takes
        1–2 days to reach Delhi at typical NW wind speeds; the 2-day lag adds
        the transport-delay signal the 1-day lag alone cannot capture.

      city_avg_lag1 — spatial: other wards' simultaneous reading lagged 1h,
        the "nearby station" signal from the plan (§3).
    """
    f = pd.DataFrame({"y": w["local_excess"]})
    f["lag1"]  = f["y"].shift(1)
    f["lag24"] = f["y"].shift(24)
    f["lag48"] = f["y"].shift(48)
    f["lag72"] = f["y"].shift(72)

    # Circular hour encoding: removes the 23→0 discontinuity of raw integer hour
    f["hour_sin"] = np.sin(2 * np.pi * f.index.hour / 24.0)
    f["hour_cos"] = np.cos(2 * np.pi * f.index.hour / 24.0)
    f["dow"]   = f.index.dayofweek
    f["month"] = f.index.month

    # Diwali window flag (binary): let the model learn the firecracker-burning
    # spike pattern from past Diwali events rather than hallucinating it each year.
    f["is_diwali"] = np.array([1.0 if _is_diwali(t) else 0.0 for t in f.index])

    wx = weather.reindex(f.index)
    temp_c = pd.to_numeric(wx["temp_c"] if "temp_c" in wx.columns else pd.Series(dtype=float, index=wx.index), errors="coerce")
    f["temp_c"]       = temp_c
    f["temp_lag24"]   = temp_c - temp_c.shift(24)    # 24h temperature trend
    f["humidity"]     = wx["humidity"]
    ws_kmh = pd.to_numeric(wx["wind_speed"] if "wind_speed" in wx.columns else pd.Series(dtype=float, index=wx.index), errors="coerce")
    f["wind_speed"]   = ws_kmh
    rad = np.deg2rad(pd.to_numeric(wx["wind_dir"] if "wind_dir" in wx.columns else pd.Series(dtype=float, index=wx.index), errors="coerce").astype(float))
    f["wind_dir_sin"] = np.sin(rad)
    f["wind_dir_cos"] = np.cos(rad)
    f["precipitation"] = wx["precipitation"]

    # PBLH, PBLH trend, and VC — NaN when not yet stored (pre-migration rows).
    pblh_raw = pd.to_numeric(
        wx["boundary_layer_height"] if "boundary_layer_height" in wx.columns else pd.Series(dtype=float, index=wx.index),
        errors="coerce",
    )
    f["pblh"]       = pblh_raw
    f["pblh_trend"] = pblh_raw.diff(3)               # 3h PBLH change
    f["vc"]         = wx["ventilation_coefficient"] if "ventilation_coefficient" in wx.columns else float("nan")

    # Stagnation index: consecutive calm hours (reset on any gust ≥ threshold)
    f["stagnation_hours"] = _stagnation_hours(ws_kmh.reindex(f.index))

    # VC threshold binary: NaN < 6000 → False → 0.0 (neutral when PBLH absent)
    f["vc_unfavourable"] = (f["vc"] < 6000.0).astype(float)

    f["city_avg_lag1"] = city_avg.reindex(f.index).shift(1)

    # Season regime flags — always defined from the timestamp; no NaN possible.
    f["is_monsoon"]    = f.index.month.isin([6, 7, 8, 9]).astype(float)
    f["is_fog_season"] = f.index.month.isin([12, 1, 2]).astype(float)

    # NO2 co-pollutant lag — available when the caller passes a ward NO2 series.
    if no2_series is not None and not no2_series.dropna().empty:
        f["no2_lag1"] = no2_series.reindex(f.index).shift(1)
    else:
        f["no2_lag1"] = float("nan")

    # Regional fire count lags — daily granularity broadcast to hourly index.
    # Each hourly row looks up the fire count for (date - 1d) and (date - 2d)
    # so the model sees the same fire count for all 24 hours of a given day,
    # which matches the physical reality (one VIIRS overpass per day).
    if fire_counts is not None and not fire_counts.empty:
        dates = f.index.normalize()  # UTC midnight for each hour
        f["fire_count_lag1d"] = [
            fire_counts.get(d - pd.Timedelta(days=1), float("nan")) for d in dates
        ]
        f["fire_count_lag2d"] = [
            fire_counts.get(d - pd.Timedelta(days=2), float("nan")) for d in dates
        ]
    else:
        f["fire_count_lag1d"] = float("nan")
        f["fire_count_lag2d"] = float("nan")

    # Forward/back-fill short gaps (a ward's weather may lag readings by 1h);
    # leave residual NaNs as NaN — LightGBM handles them natively and a
    # genuinely weather-less ward should not get fabricated zeros.
    fill_cols = [
        "temp_c", "temp_lag24",
        "humidity", "wind_speed", "wind_dir_sin", "wind_dir_cos", "precipitation",
        "pblh", "pblh_trend", "vc", "stagnation_hours",
        "city_avg_lag1",
        "no2_lag1",
    ]
    for c in fill_cols:
        f[c] = pd.to_numeric(f[c], errors="coerce").interpolate(limit=6).ffill().bfill()

    return f


FEATURE_COLS = [
    # Pollutant history
    "lag1", "lag24", "lag48", "lag72",
    # Calendar (circular hour replaces raw integer)
    "hour_sin", "hour_cos", "dow", "month", "is_diwali",
    "is_monsoon", "is_fog_season",
    # Surface met
    "temp_c", "temp_lag24",
    "humidity", "wind_speed", "wind_dir_sin", "wind_dir_cos", "precipitation",
    # Boundary layer / dispersion
    "pblh", "pblh_trend", "vc", "stagnation_hours",
    "vc_unfavourable",
    # Co-pollutant
    "no2_lag1",
    # External fire signal (regional stubble burning, Punjab + Haryana)
    "fire_count_lag1d", "fire_count_lag2d",
    # Spatial
    "city_avg_lag1",
]


def _future_weather_frame(
    future_idx: pd.DatetimeIndex,
    hourly_forecast: list[dict],
    pblh_forecast: list[float | None] | None = None,
) -> pd.DataFrame:
    """MET Norway hourly weather + Open-Meteo PBLH FORECAST reindexed onto the
    recursive forecast's own future timestamps. Falls back to last known
    (persistence) past the fetched range, or when either fetch failed.

    pblh_forecast — from open_meteo.get_hourly_pblh_forecast(); parallel list
    aligned with future_idx. None values persist forward from the last known.
    VC (ventilation_coefficient) is recomputed here from PBLH × wind_speed
    (km/h converted to m/s) so that both components remain visible.
    """
    cols = ["temp_c", "humidity", "wind_speed", "wind_dir", "precipitation"]
    if not hourly_forecast:
        wf = pd.DataFrame(index=future_idx, columns=cols)
    else:
        wdf = pd.DataFrame(hourly_forecast)
        wdf["ts"] = pd.to_datetime(wdf["ts_utc"], utc=True).dt.floor("h")
        wdf = wdf.set_index("ts")[cols]
        wf = wdf.reindex(future_idx).ffill().bfill()

    # Attach PBLH and VC columns (may be all-NaN if PBLH fetch failed or
    # migration hasn't run yet — LightGBM handles NaN natively).
    if pblh_forecast:
        pblh_series = pd.Series(pblh_forecast, index=future_idx, dtype=float)
        pblh_series = pblh_series.ffill().bfill()
    else:
        pblh_series = pd.Series(float("nan"), index=future_idx)
    wf["boundary_layer_height"] = pblh_series
    # VC in m²/s: wind_speed stored in km/h → convert to m/s
    ws_ms = wf["wind_speed"].astype(float) / 3.6
    wf["ventilation_coefficient"] = pblh_series * ws_ms

    return wf


# ── validation: time-based holdout, recursive re-simulation ───────────────────


def _recursive_forecast(
    hist_local_excess: list[float],
    weather_hist: pd.DataFrame,
    city_avg_hist: pd.Series,
    future_idx: pd.DatetimeIndex,
    future_weather: pd.DataFrame,
    model,
    no2_series: pd.Series | None = None,
    fire_counts: pd.Series | None = None,
) -> np.ndarray:
    """Recursively forecast local_excess for every timestamp in future_idx,
    using ONLY `hist_*` (data available up to the start of future_idx) plus
    the model's own prior predictions as lag inputs — the same procedure
    used for both the real future forecast AND the holdout backtest, so the
    backtest is a faithful simulation of what the model actually knew at
    that point (no leakage of true intervening values).

    Stateful features are initialised from `weather_hist` and updated each
    step from `future_weather`, keeping the same definitions as _make_features():

      stagnation_hours — running calm-hour count; reset on any gust ≥ threshold.
      pblh_trend       — 3h PBLH difference, tracked via a 3-slot PBLH deque.
      temp_lag24       — temperature 24h ago, tracked via a 48-slot temp deque.
    """
    hist = list(hist_local_excess)
    city_hist = city_avg_hist.copy()
    preds = []

    # ── state initialisation from historical weather ──────────────────────────

    # Stagnation: count consecutive calm hours at the end of history
    stagnation: float = 0.0
    if not weather_hist.empty and "wind_speed" in weather_hist.columns:
        ws_tail = (weather_hist["wind_speed"].dropna().values[-24:] / 3.6)
        for _ws in reversed(ws_tail):
            if _ws < STAGNATION_THRESHOLD_MS:
                stagnation = min(stagnation + 1, 24)
            else:
                break

    # PBLH deque (last 3 historical values) → enables exact diff(3) during loop
    pblh_dq: deque[float] = deque(maxlen=3)
    if not weather_hist.empty and "boundary_layer_height" in weather_hist.columns:
        for _v in weather_hist["boundary_layer_height"].iloc[-3:].values:
            pblh_dq.append(float(_v) if pd.notna(_v) else float("nan"))

    # Temperature deque (last 48 historical values) → enables temp_lag24 lookup
    temp_dq: deque[float] = deque(maxlen=48)
    if not weather_hist.empty and "temp_c" in weather_hist.columns:
        for _v in weather_hist["temp_c"].iloc[-48:].values:
            temp_dq.append(float(_v) if pd.notna(_v) else float("nan"))

    # NO2 lag — persisted at last known value (we don't recursively predict NO2).
    # Filter to observations strictly before the forecast window to avoid leakage.
    no2_lag1_val: float = float("nan")
    if no2_series is not None and not no2_series.empty:
        no2_before = no2_series[no2_series.index < future_idx[0]].dropna()
        if not no2_before.empty:
            no2_lag1_val = float(no2_before.iloc[-1])

    # ── recursive loop ────────────────────────────────────────────────────────

    for t in future_idx:
        lag1  = hist[-1]
        lag24 = hist[-24] if len(hist) >= 24 else hist[0]
        lag48 = hist[-48] if len(hist) >= 48 else hist[0]
        lag72 = hist[-72] if len(hist) >= 72 else hist[0]

        wx = future_weather.loc[t] if t in future_weather.index else pd.Series(dtype=float)

        # Calendar
        hour_sin = np.sin(2 * np.pi * t.hour / 24.0)
        hour_cos = np.cos(2 * np.pi * t.hour / 24.0)
        is_diwali = 1.0 if _is_diwali(t) else 0.0

        # Wind direction
        wd = float(wx.get("wind_dir", np.nan))
        rad = np.deg2rad(wd) if pd.notna(wd) else np.nan

        # Temperature + temp_lag24
        temp_c_val = float(wx.get("temp_c", np.nan)) if pd.notna(wx.get("temp_c", np.nan)) else float("nan")
        temp_lag24_val = (temp_c_val - temp_dq[-24]) if len(temp_dq) >= 24 and pd.notna(temp_c_val) and pd.notna(temp_dq[-24]) else float("nan")

        # Wind + stagnation update
        ws_kmh_val = float(wx.get("wind_speed", np.nan)) if pd.notna(wx.get("wind_speed", np.nan)) else float("nan")
        ws_ms_val = ws_kmh_val / 3.6 if pd.notna(ws_kmh_val) else float("nan")
        if pd.notna(ws_ms_val) and ws_ms_val < STAGNATION_THRESHOLD_MS:
            stagnation = min(stagnation + 1.0, 24.0)
        else:
            stagnation = 0.0

        # PBLH + trend + VC
        pblh_val = float(wx.get("boundary_layer_height", np.nan)) if pd.notna(wx.get("boundary_layer_height", np.nan)) else float("nan")
        # pblh_trend = diff(3): current PBLH minus the value 3 steps ago
        pblh_trend_val = (pblh_val - pblh_dq[0]) if len(pblh_dq) == 3 and pd.notna(pblh_val) and pd.notna(pblh_dq[0]) else float("nan")
        vc_val = (pblh_val * ws_ms_val) if pd.notna(pblh_val) and pd.notna(ws_ms_val) else float("nan")

        city_lag1 = float(city_hist.iloc[-1]) if len(city_hist) else float("nan")

        is_monsoon_val    = 1.0 if t.month in (6, 7, 8, 9) else 0.0
        is_fog_season_val = 1.0 if t.month in (12, 1, 2) else 0.0
        vc_unfavourable_val = 1.0 if (pd.notna(vc_val) and vc_val < 6000.0) else 0.0

        # Fire counts: look up by date for each forecast step — changes
        # when the loop crosses midnight but stays constant within a day.
        t_date = t.normalize()
        if fire_counts is not None and not fire_counts.empty:
            fc_lag1d = float(fire_counts.get(t_date - pd.Timedelta(days=1), float("nan")))
            fc_lag2d = float(fire_counts.get(t_date - pd.Timedelta(days=2), float("nan")))
        else:
            fc_lag1d = fc_lag2d = float("nan")

        x = pd.DataFrame(
            [[
                lag1, lag24, lag48, lag72,
                hour_sin, hour_cos, t.dayofweek, t.month, is_diwali,
                is_monsoon_val, is_fog_season_val,
                temp_c_val, temp_lag24_val,
                float(wx.get("humidity", np.nan)) if pd.notna(wx.get("humidity", np.nan)) else float("nan"),
                ws_kmh_val,
                np.sin(rad) if pd.notna(rad) else float("nan"),
                np.cos(rad) if pd.notna(rad) else float("nan"),
                float(wx.get("precipitation", np.nan)) if pd.notna(wx.get("precipitation", np.nan)) else float("nan"),
                pblh_val, pblh_trend_val, vc_val, stagnation,
                vc_unfavourable_val,
                no2_lag1_val,
                fc_lag1d, fc_lag2d,
                city_lag1,
            ]],
            columns=FEATURE_COLS,
        ).ffill(axis=1).bfill(axis=1)

        yhat = float(model.predict(x)[0])
        preds.append(yhat)
        hist.append(yhat)
        city_hist = pd.concat([city_hist, pd.Series([city_lag1])])

        # Advance state deques
        temp_dq.append(temp_c_val)
        pblh_dq.append(pblh_val)

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


def _select_nowcast_point(
    future_idx: pd.DatetimeIndex, generated_at: datetime, tolerance_minutes: int = NOWCAST_TOLERANCE_MINUTES
) -> tuple[int, bool]:
    """Selects the ONE row of `future_idx` (already computed as anchor_ts+1h
    .. anchor_ts+48h) that best represents "1 hour from generation time" -
    NOT the same as future_idx[0], which is anchor_ts+1h and can differ from
    generated_at+1h whenever the anchor reading lags the generation cycle
    (e.g. anchor 12:00, generated 12:45 -> future_idx[0]=13:00 is only 15
    minutes ahead of "now", not a genuine 1h-ahead nowcast).

    Decided ONCE here, backend-side - the frontend, shadow logger, and shadow
    scorer all read the resulting flag rather than each independently
    recomputing "nearest to now", which could disagree given clock/fetch-time
    differences.

    Returns (index, tolerance_ok). Only considers points strictly after
    generated_at (a point at/before generation time is never a valid
    "+1h from now" candidate - this can happen when the anchor is old enough
    that anchor_ts+1h has already passed by the time generation runs). Ties
    broken toward the LATER point: Python's min() keeps the first
    equal-distance match by default, which would silently prefer undershoot
    (e.g. 30 min ahead) over overshoot (e.g. 90 min ahead) when both are
    equidistant from the target - overshoot is the safer tie-break for a
    forward-looking nowcast. Returns (-1, False) when no point in future_idx
    is even still in the future relative to generated_at."""
    target = generated_at + timedelta(hours=NOWCAST_TARGET_HOURS)
    eligible = [(i, ts) for i, ts in enumerate(future_idx) if ts > generated_at]
    if not eligible:
        return -1, False
    idx, ts = min(eligible, key=lambda pair: (abs((pair[1] - target).total_seconds()), -pair[1].timestamp()))
    tolerance_ok = abs((ts - target).total_seconds()) <= tolerance_minutes * 60
    return idx, tolerance_ok


def _nowcast_candidate_predictions(
    hist_local_excess: list[float],
    future_idx: pd.DatetimeIndex,
    by_hour: pd.Series,
    nowcast_idx: int,
    lgb_point_pred: np.ndarray | None = None,
    lgb_lower: np.ndarray | None = None,
    lgb_upper: np.ndarray | None = None,
) -> dict[str, dict]:
    """The nowcast local_excess value (and interval, where calibrated) at
    `nowcast_idx` for every ELIGIBLE candidate method - baselines are always
    eligible (closed-form, no fitting); LightGBM is eligible only when it was
    already trained this cycle for the main 6-48h forecast (`lgb_point_pred`
    passed in, reusing that fit rather than training a redundant extra model
    purely for the nowcast). NEVER asserts all 5 candidates - callers get
    back only the methods that are genuinely eligible this cycle (4 when
    LightGBM wasn't trained, 5 when it was).

    Baseline candidates report lower=upper=None (no calibrated interval
    exists for them) - callers must not fabricate one; LightGBM reports real
    q10/q90 bounds when they were computed, else None too."""
    persistence, diurnal = _baseline_forecast(hist_local_excess, future_idx, by_hour)
    same_hour_yesterday = _same_hour_yesterday_baseline(hist_local_excess, len(future_idx))
    rolling_avg = _rolling_average_baseline(hist_local_excess, len(future_idx))

    out: dict[str, dict] = {
        "persistence": {"value": float(persistence[nowcast_idx]), "lower": None, "upper": None},
        "diurnal": {"value": float(diurnal[nowcast_idx]), "lower": None, "upper": None},
        "same_hour_yesterday": {"value": float(same_hour_yesterday[nowcast_idx]), "lower": None, "upper": None},
        "rolling_24h_avg": {"value": float(rolling_avg[nowcast_idx]), "lower": None, "upper": None},
    }
    if lgb_point_pred is not None:
        out["lightgbm"] = {
            "value": float(lgb_point_pred[nowcast_idx]),
            "lower": float(lgb_lower[nowcast_idx]) if lgb_lower is not None else None,
            "upper": float(lgb_upper[nowcast_idx]) if lgb_upper is not None else None,
        }
    return out


def _validate(
    w: pd.DataFrame,
    weather: pd.DataFrame,
    city_avg: pd.Series,
    threshold: float | None,
    baseline_value_at_split: float,
    min_mae_improvement_pct: float,
    no2_series: pd.Series | None = None,
    fire_counts: pd.Series | None = None,
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
        feats = _make_features(w.iloc[:split], weather, city_avg, no2_series, fire_counts).dropna()
        if len(feats) >= MIN_TRAIN_ROWS // 2:
            model = lgb.LGBMRegressor(
                n_estimators=300, learning_rate=0.05, num_leaves=31, min_child_samples=10, verbose=-1,
                random_state=LGB_RANDOM_STATE,
            )
            model.fit(feats[FEATURE_COLS], feats["y"])
            future_weather = weather.reindex(holdout_idx)
            model_pred = _recursive_forecast(train_hist, weather.iloc[:split], city_avg.iloc[:split], holdout_idx, future_weather, model, no2_series, fire_counts)
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
    no2_readings_df: pd.DataFrame | None = None,
    fire_counts: pd.Series | None = None,
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

    # Ward-level NO2 series for the co-pollutant lag feature. Only provided when
    # forecasting PM2.5 or PM10 (None when NO2 is the target — circular dependency).
    no2_ward_series: pd.Series | None = None
    if no2_readings_df is not None and not no2_readings_df.empty:
        no2_ward = no2_readings_df[no2_readings_df["ward_id"] == ward_id].set_index("ts").sort_index()
        if not no2_ward.empty:
            full_no2_idx = pd.date_range(no2_ward.index.min(), no2_ward.index.max(), freq="h", tz="UTC")
            no2_ward_series = no2_ward["value"].reindex(full_no2_idx).interpolate(limit=6).ffill().bfill()

    method, validation_metrics, max_validated, beats_persistence = _validate(
        w, wx_ward, city_avg, threshold, latest_baseline, min_mae_improvement_pct, no2_ward_series, fire_counts
    )

    # ---- the real, future 48h forecast, using ALL available history ----
    excess_hist = list(w["local_excess"].astype(float).to_numpy())
    start = w.index[-1]
    future_idx = pd.date_range(start + timedelta(hours=1), periods=MAX_HORIZON_H, freq="h", tz="UTC")

    hourly_forecast: list[dict] = []
    pblh_forecast: list[float | None] = []
    if ward.get("lat") is not None and ward.get("lng") is not None:
        try:
            hourly_forecast = open_meteo.get_hourly_forecast(ward["lat"], ward["lng"], hours=MAX_HORIZON_H)
        except Exception:
            log.exception("weather forecast fetch failed for ward %s — falling back to persisted weather", ward_id)
        try:
            pblh_forecast = open_meteo.get_hourly_pblh_forecast(ward["lat"], ward["lng"], hours=MAX_HORIZON_H)
        except Exception:
            log.debug("PBLH forecast fetch failed for ward %s — VC feature will be NaN", ward_id)
    future_weather = _future_weather_frame(future_idx, hourly_forecast, pblh_forecast)

    # Gaussian fallback: only used when quantile models below cannot be trained
    residual_std = None
    if validation_metrics:
        residual_std = validation_metrics.get(str(HORIZONS_H[-1]), {}).get("rmse")

    preds_q10: np.ndarray | None = None
    preds_q90: np.ndarray | None = None

    if method == MODEL_VERSION_LGB:
        feats = _make_features(w, wx_ward, city_avg, no2_ward_series, fire_counts).dropna()
        _lgb_kw = dict(
            n_estimators=300, learning_rate=0.05, num_leaves=31, min_child_samples=10, verbose=-1,
            random_state=LGB_RANDOM_STATE,
        )

        # Point estimate (regression)
        model_pt = lgb.LGBMRegressor(**_lgb_kw)
        model_pt.fit(feats[FEATURE_COLS], feats["y"])
        preds = _recursive_forecast(excess_hist, wx_ward, city_avg, future_idx, future_weather, model_pt, no2_ward_series, fire_counts)

        # Calibrated quantile uncertainty bounds — replaces the Gaussian
        # approximation (UNCERTAINTY_Z × RMSE) used by the diurnal fallback.
        # PM2.5 has a strongly right-skewed distribution; symmetric Gaussian
        # bounds are too narrow at the high tail (episodic events) and too wide
        # in clean air. LightGBM quantile objective captures this asymmetry
        # directly, without assuming any parametric form.
        # Literature: Papadopoulos et al. (2022) Environ. Sci. Technol.;
        # Mallet et al. (2021) ACP; STOTEN 2023 — all show 15–20% better
        # coverage vs. Gaussian for right-skewed AQ distributions.
        try:
            model_q10 = lgb.LGBMRegressor(objective="quantile", alpha=0.10, **_lgb_kw)
            model_q10.fit(feats[FEATURE_COLS], feats["y"])
            preds_q10 = _recursive_forecast(excess_hist, wx_ward, city_avg, future_idx, future_weather, model_q10, no2_ward_series, fire_counts)

            model_q90 = lgb.LGBMRegressor(objective="quantile", alpha=0.90, **_lgb_kw)
            model_q90.fit(feats[FEATURE_COLS], feats["y"])
            preds_q90 = _recursive_forecast(excess_hist, wx_ward, city_avg, future_idx, future_weather, model_q90, no2_ward_series, fire_counts)
        except Exception:
            log.debug("quantile model training failed for ward %s %s — falling back to Gaussian bounds", ward_id, pollutant)
            preds_q10 = preds_q90 = None
    else:
        by_hour = w["local_excess"].astype(float).groupby(w.index.hour).mean()
        persistence, diurnal = _baseline_forecast(excess_hist, future_idx, by_hour)
        blend_w = np.clip(np.arange(MAX_HORIZON_H) / 24.0, 0, 1)
        preds = (1 - blend_w) * persistence + blend_w * diurnal

    confidence = 0.5
    if beats_persistence and max_validated:
        confidence = float(np.clip(0.4 + 0.1 * HORIZONS_H.index(max_validated), 0.4, 0.9))

    generated_at = datetime.now(timezone.utc)
    nowcast_idx, nowcast_tolerance_ok = _select_nowcast_point(future_idx, generated_at)
    nowcast_target_ts = generated_at + timedelta(hours=NOWCAST_TARGET_HOURS)
    nowcast_candidates: dict[str, dict] = {}
    if nowcast_tolerance_ok:
        by_hour_nowcast = w["local_excess"].astype(float).groupby(w.index.hour).mean()
        lgb_point = preds if method == MODEL_VERSION_LGB else None
        nowcast_candidates = _nowcast_candidate_predictions(
            excess_hist, future_idx, by_hour_nowcast, nowcast_idx,
            lgb_point_pred=lgb_point, lgb_lower=preds_q10, lgb_upper=preds_q90,
        )
    if nowcast_idx == -1:
        nowcast_status = "stale_anchor"  # no future_idx point remains ahead of generated_at at all
    elif not nowcast_tolerance_ok:
        nowcast_status = "no_point_within_tolerance"
    elif not nowcast_candidates:
        nowcast_status = "no_eligible_candidate"
    else:
        nowcast_status = "available"

    return {
        "ward_id": ward_id,
        "pollutant": pollutant,
        "method": "lightgbm" if method == MODEL_VERSION_LGB else "diurnal_persistence",
        "model_version": method,
        "generated_at": generated_at,
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
        "preds_q10": preds_q10,
        "preds_q90": preds_q90,
        "confidence": confidence,
        "residual_std": residual_std,
        "nowcast_idx": nowcast_idx,
        "nowcast_tolerance_ok": nowcast_tolerance_ok,
        "nowcast_target_ts": nowcast_target_ts,
        "nowcast_status": nowcast_status,
        "nowcast_candidates": nowcast_candidates,
    }


def _select_nowcast_production_method(
    ward_id: int, pollutant: str, nowcast_candidates: dict[str, dict]
) -> tuple[str, dict, bool, int]:
    """Decides which candidate's prediction becomes the actual +1h production
    value for this cycle, using the periodic leakage-free backtest
    (nowcast_backtest_results — computed by ingest/scripts/nowcast_backtest.py,
    NOT recomputed here) rather than any single-cycle retrospective point.

    "passed" must never collapse to "LightGBM won" - a good baseline that
    LightGBM fails to beat by DEFAULT_MIN_MAE_IMPROVEMENT_PCT is still a
    perfectly valid *selected* method, not a reason to fall back to plain
    persistence. Plain persistence is reserved specifically for "no
    trustworthy backtest exists at all" (missing, stale, or version-mismatched
    result), never used to mean "a baseline lost to LightGBM".

    Returns (method_name, prediction_dict, backtest_passed, backtest_samples).
    """
    backtest = db.get_nowcast_backtest_result(ward_id, pollutant)
    fresh = False
    if backtest is not None:
        try:
            data_through = pd.Timestamp(backtest["data_through"]).to_pydatetime()
            age_days = (datetime.now(timezone.utc) - data_through).total_seconds() / 86400.0
            # Compared against the fixed MODEL_VERSION_LGB constant, NOT this
            # cycle's own resolved result["model_version"] - that field varies
            # per-cycle/per-ward (diurnal_persistence_v2 whenever a ward falls
            # back), which has nothing to do with whether the backtest script's
            # LightGBM evaluation is still valid. Comparing against the
            # per-cycle value would wrongly invalidate a fresh, correct
            # backtest on every cycle where the MAIN 6-48h forecast happened
            # to use the diurnal fallback - an unrelated, incidental condition.
            fresh = (
                backtest.get("model_version") == MODEL_VERSION_LGB
                and backtest.get("methodology_version") == NOWCAST_METHODOLOGY_VERSION
                and age_days <= NOWCAST_BACKTEST_REFRESH_DAYS
            )
        except (KeyError, ValueError, TypeError):
            fresh = False

    if fresh and backtest.get("passed") and backtest.get("best_candidate") in nowcast_candidates:
        selected = backtest["best_candidate"]
        return selected, nowcast_candidates[selected], True, int(backtest.get("sample_size") or 0)

    # No fresh, passed backtest result — fall back to persistence, the safe
    # conservative default. Never described as validated.
    fallback = nowcast_candidates.get("persistence")
    if fallback is None:
        # persistence is always in nowcast_candidates when any candidate is
        # eligible at all (it's a closed-form baseline, never gated) — this
        # branch only fires if nowcast_candidates itself is empty, which
        # run() already guards against via nowcast_status == "available".
        fallback = {"value": 0.0, "lower": None, "upper": None}
    return "persistence", fallback, False, 0


def _score_pending_nowcast_shadows(hourly_by_pollutant: dict[str, pd.DataFrame]) -> int:
    """Fills in actual_value for shadow-log rows whose valid_at has passed,
    using the SAME hourly ward-aggregation (_hourly_ward_pollutant) the rest
    of this pipeline already uses — never a raw exact-timestamp match, and
    never attributes a nearby-but-mismatched reading. Rows with no matching
    hourly bucket are left unscored (correct — not every predicted hour has
    a real reading, especially for a currently-stale station)."""
    now_iso = datetime.now(timezone.utc).isoformat()
    pending = db.get_pending_nowcast_shadows(now_iso)
    scored = 0
    for row in pending:
        hourly = hourly_by_pollutant.get(row["pollutant"])
        if hourly is None or hourly.empty:
            continue
        bucket_ts = pd.Timestamp(row["valid_at"]).floor("h")
        match = hourly[(hourly["ts"] == bucket_ts) & (hourly["ward_id"] == row["ward_id"])]
        if match.empty:
            continue
        actual_value = float(match["value"].iloc[0])
        scored_at = datetime.now(timezone.utc).isoformat()
        db.score_nowcast_shadow(row["id"], actual_value, bucket_ts.isoformat(), scored_at)
        scored += 1
    return scored


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
        # NO2 hourly series (built once per city) — used as a co-pollutant lag
        # feature when forecasting PM2.5 and PM10. Passed as None when NO2 is
        # the forecast target itself (would create a circular dependency).
        no2_readings_df = _hourly_ward_pollutant(readings, "no2")

        # Regional fire counts — daily signal, city-wide (not ward-specific).
        # Empty Series when FIRMS key is absent or fire_counts table is empty.
        fire_counts_series = _daily_fire_counts(db.get_fire_counts_history(days=45))

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
                    ward, pollutant, readings_df, weather_df, threshold, cfg["min_mae_improvement_pct"],
                    no2_readings_df=no2_readings_df if pollutant != "no2" else None,
                    fire_counts=fire_counts_series if not fire_counts_series.empty else None,
                )
                if result is None:
                    summary["skipped"].append({"ward_id": ward["id"], "pollutant": pollutant})
                    continue

                nowcast_status = result["nowcast_status"]
                nowcast_idx = result["nowcast_idx"]
                nowcast_valid_at = (
                    result["future_idx"][nowcast_idx].isoformat() if nowcast_status == "available" else None
                )

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
                        "nowcast_target_ts": result["nowcast_target_ts"].isoformat(),
                        "nowcast_valid_at": nowcast_valid_at,
                        "nowcast_generation_status": nowcast_status,
                    }
                )

                # Part D: which candidate becomes the actual +1h production
                # value, decided from the periodic leakage-free backtest, not
                # a single-cycle retrospective point.
                nowcast_method = nowcast_pred = None
                nowcast_backtest_passed = False
                nowcast_backtest_samples = 0
                if nowcast_status == "available":
                    nowcast_method, nowcast_pred, nowcast_backtest_passed, nowcast_backtest_samples = (
                        _select_nowcast_production_method(
                            result["ward_id"], pollutant, result["nowcast_candidates"]
                        )
                    )

                rows = []
                # Gaussian fallback Z — only used when quantile models failed
                _z_fallback = UNCERTAINTY_Z * (result["residual_std"] or 0)
                has_quantiles = result["preds_q10"] is not None and result["preds_q90"] is not None
                for i, (t, excess_pred) in enumerate(zip(result["future_idx"], result["preds"])):
                    is_nowcast_row = nowcast_status == "available" and i == nowcast_idx
                    if is_nowcast_row:
                        # Overrides the main 6-48h trajectory's value at this
                        # one row with whichever method the backtest actually
                        # selected for +1h specifically — may differ from
                        # whatever the main forecast used for the whole
                        # trajectory (Part D).
                        excess_pred = nowcast_pred["value"]
                    predicted = max(result["latest_baseline"] + float(excess_pred), 0.0)
                    if is_nowcast_row:
                        # The nowcast row's bounds come EXCLUSIVELY from
                        # whichever candidate was actually selected — never
                        # borrowed from the main forecast's LightGBM/Gaussian
                        # bounds below, which describe a different method's
                        # prediction and would misrepresent uncertainty for
                        # a baseline candidate that has no calibrated
                        # interval of its own (null stays null, honestly).
                        lower_bound = round(max(result["latest_baseline"] + nowcast_pred["lower"], 0.0), 1) if nowcast_pred["lower"] is not None else None
                        upper_bound = round(result["latest_baseline"] + nowcast_pred["upper"], 1) if nowcast_pred["upper"] is not None else None
                    elif has_quantiles:
                        # Quantile LightGBM bounds (q10 / q90): asymmetric and
                        # heteroscedastic — wider during episodes, narrower in
                        # clean air, matching PM2.5's right-skewed distribution.
                        lower_bound = round(max(result["latest_baseline"] + float(result["preds_q10"][i]), 0.0), 1)
                        upper_bound = round(max(result["latest_baseline"] + float(result["preds_q90"][i]), 0.0), 1)
                    elif _z_fallback:
                        lower_bound = round(max(predicted - _z_fallback, 0.0), 1)
                        upper_bound = round(predicted + _z_fallback, 1)
                    else:
                        lower_bound = upper_bound = None
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
                        "lower_bound": lower_bound,
                        "upper_bound": upper_bound,
                        "forecast_run_id": run_id,
                        "is_nowcast_point": is_nowcast_row,
                    }
                    if is_nowcast_row:
                        row["nowcast_method"] = nowcast_method
                        row["nowcast_backtest_samples"] = nowcast_backtest_samples
                        row["nowcast_backtest_passed"] = nowcast_backtest_passed
                    if pollutant == "pm25":
                        # legacy column, kept populated for backward
                        # compatibility with fetchForecast/ForecastChart.
                        row["pm25_pred"] = round(predicted, 1)
                    rows.append(row)
                db.replace_forecasts(result["ward_id"], pollutant, rows)

                # Part C: log every ELIGIBLE candidate's prediction (not just
                # the one selected for production) so any of them can be
                # judged later against the same matched real observation —
                # logging only the winner would be selection bias.
                if nowcast_status == "available":
                    shadow_rows = [
                        {
                            "forecast_run_id": run_id,
                            "ward_id": result["ward_id"],
                            "pollutant": pollutant,
                            "candidate_method": name,
                            "predicted_value": round(
                                max(result["latest_baseline"] + pred["value"], 0.0), 1
                            ),
                            "lower_bound": round(max(result["latest_baseline"] + pred["lower"], 0.0), 1) if pred["lower"] is not None else None,
                            "upper_bound": round(result["latest_baseline"] + pred["upper"], 1) if pred["upper"] is not None else None,
                            "valid_at": nowcast_valid_at,
                        }
                        for name, pred in result["nowcast_candidates"].items()
                    ]
                    db.insert_nowcast_shadow_rows(shadow_rows)

                summary["runs"] += 1
                if result["beats_persistence"]:
                    summary["beats_persistence"] += 1

        # Part C: score shadow predictions whose valid_at has now passed,
        # once per city (using that city's own freshly-fetched readings —
        # correct even with multiple cities, since a pending row for a ward
        # outside this city simply won't match and is left for its own
        # city's turn or the next hourly cycle).
        hourly_by_pollutant = {p: _hourly_ward_pollutant(readings, p) for p in cfg["enabled_pollutants"]}
        scored = _score_pending_nowcast_shadows(hourly_by_pollutant)
        if scored:
            log.info("nowcast shadow log: scored %d pending prediction(s) for city %s", scored, city["city_code"])

    summary["finished_at"] = datetime.now(timezone.utc).isoformat()
    log.info("forecast done: %s", summary)
    return summary
