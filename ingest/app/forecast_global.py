"""Global, direct, horizon-gated forecaster (Sept 2026).

Replaces the per-ward model in forecast.py, which had three problems,
measured on real hourly data (scripts/forecast_experiment.py):
  1. It forecast only a ward's EXCESS over the city median and froze that
     median for all 48h, so the diurnal cycle and weather-driven swings,
     most of what moves, were never forecast.
  2. Its validation added the same constant to prediction and truth,
     scoring the excess only, never the forecast users see.
  3. Each ward's model-vs-baseline choice rested on ONE 48h holdout
     (~48 points), which is close to noise.

This module fits LightGBM models pooled over all wards (global models
beat per-series ones when series are short and related; Montero-Manso &
Hyndman 2021): one DIRECT model per lead time (no recursion), L1 loss,
forecasting the TOTAL concentration in a RELATIVE form, the log-ratio of
the target to the ward's own trailing 24h mean, with lags, city level and
diurnal norms expressed the same way.

Both choices were measured on ward data (last 14 days held out, Sept
2026). A single model with lead time as a feature lost to persistence at
1h (MAE 13.0 vs 9.1, per-lead model 9.3). Absolute targets lost to a 24h
rolling mean at 6-48h for PM2.5 when levels shifted at the monsoon's end;
the relative form narrows that gap and gains 3-7% at 1-3h. NO2 gains
9-24% over the best simple rule at every lead. Validation: the last VALIDATION_DAYS, origins every
ORIGIN_STEP_H hours, pooled across wards, scored on total concentration
against persistence, same-hour-yesterday, diurnal mean and 24h mean. At
each gate horizon the model is served only where it beats the best of
those by min_mae_improvement_pct; elsewhere the best baseline is served,
with bands from its own validation residuals. A served forecast is never
worse (in validation) than the simplest honest alternative.

Weather: conditions at the forecast origin only. Target-hour weather
forecasts helped further in the experiment (real archived forecasts,
Open-Meteo Previous Runs), but training on them needs that archive per
ward; a follow-up.
"""

from __future__ import annotations

import logging
import pickle
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

log = logging.getLogger("ingest")

MODEL_VERSION_GLOBAL = "lgb_global_direct_v1"
# Direct models are trained at these lead times; others use the nearest one.
TRAIN_HORIZONS = (1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 21, 24, 30, 36, 42, 48)
GATE_HORIZONS = (1, 3, 6, 12, 24, 48)
MAX_H = 48
VALIDATION_DAYS = 14
ORIGIN_STEP_H = 2
MIN_WARDS = 5
MIN_HOURS = 24 * 21
BASELINES = ("persistence", "same_hour_yesterday", "diurnal", "rolling_24h_avg")
WX = ("wind_speed", "boundary_layer_height", "temp_c", "humidity", "precipitation", "ventilation_coefficient")
CACHE_DIR = Path(__file__).resolve().parents[1] / "data" / "models"
LGB_PARAMS = dict(learning_rate=0.05, num_leaves=31, min_child_samples=50, feature_fraction=0.9,
                  bagging_fraction=0.8, bagging_freq=1, n_estimators=400, verbose=-1, random_state=42)


@dataclass
class GlobalModel:
    pollutant: str
    fitted_at: datetime
    feature_cols: list[str]
    models: dict                      # lead time -> {"p50" | "q10" | "q90" -> LGBMRegressor}
    gates: dict[int, bool]            # gate horizon -> serve the model?
    best_baseline: dict[int, str]     # gate horizon -> best simple baseline
    baseline_bands: dict[int, tuple[float, float]]  # gate horizon -> (q10, q90) residual of best baseline
    pooled: dict[int, dict]           # gate horizon -> pooled validation MAEs
    per_ward: dict[int, dict[int, dict]] = field(default_factory=dict)  # ward -> gate h -> metrics
    diurnal: pd.DataFrame | None = None
    level: pd.Series | None = None
    train_start: pd.Timestamp | None = None
    train_end: pd.Timestamp | None = None
    n_rows: int = 0


def gate_for(h: int) -> int:
    return next(g for g in GATE_HORIZONS if g >= h)


# ── data ──────────────────────────────────────────────────────────────────────

def _panel(readings_df: pd.DataFrame) -> pd.DataFrame:
    """(ts, ward_id, value) -> hourly wide frame, wards as columns."""
    wide = readings_df.pivot_table(index="ts", columns="ward_id", values="value", aggfunc="mean")
    idx = pd.date_range(wide.index.min(), wide.index.max(), freq="h", tz="UTC")
    return wide.reindex(idx).clip(lower=0)


def _weather(weather_df: pd.DataFrame, Y: pd.DataFrame) -> dict[str, pd.DataFrame]:
    out = {}
    for m in WX:
        if weather_df is None or weather_df.empty or m not in weather_df.columns:
            out[m] = pd.DataFrame(np.nan, index=Y.index, columns=Y.columns)
            continue
        w = weather_df.pivot_table(index="ts", columns="ward_id", values=m, aggfunc="mean")
        out[m] = w.reindex(index=Y.index, columns=Y.columns)
    return out


def _features(Y: pd.DataFrame, W: dict, h: int, diurnal: pd.DataFrame, level: pd.Series) -> pd.DataFrame:
    """Long frame indexed (origin, ward) for horizon h, with 'target'."""
    city = Y.median(axis=1)
    sh = 24 * int(np.ceil(h / 24))
    tgt = Y.index + pd.Timedelta(hours=h)
    hours = np.asarray(tgt.hour)
    wide = {
        "y0": Y, "y1": Y.shift(1), "y2": Y.shift(2), "y3": Y.shift(3), "y6": Y.shift(6), "y12": Y.shift(12),
        "y_same_hour": Y.shift(sh - h),
        "roll6": Y.rolling(6, min_periods=3).mean(), "roll24": Y.rolling(24, min_periods=12).mean(),
        "city0": pd.DataFrame(np.repeat(city.to_numpy()[:, None], Y.shape[1], 1), index=Y.index, columns=Y.columns),
        "city24": pd.DataFrame(np.repeat(city.rolling(24, min_periods=12).mean().to_numpy()[:, None], Y.shape[1], 1),
                               index=Y.index, columns=Y.columns),
        "diurnal_t": pd.DataFrame({c: diurnal[c].reindex(hours).to_numpy() if c in diurnal else np.nan
                                   for c in Y.columns}, index=Y.index),
        "level": pd.DataFrame({c: level.get(c, np.nan) for c in Y.columns}, index=Y.index),
        "target": Y.shift(-h),
    }
    for m, Wm in W.items():
        wide[f"{m}_0"] = Wm
    long = pd.concat({k: v.stack(future_stack=True) for k, v in wide.items()}, axis=1)
    long.index.names = ["origin", "ward"]
    o = long.index.get_level_values("origin")
    th = (o + pd.Timedelta(hours=h)).hour
    long["hour_sin"] = np.sin(2 * np.pi * th / 24)
    long["hour_cos"] = np.cos(2 * np.pi * th / 24)
    long["dow_t"] = (o + pd.Timedelta(hours=h)).dayofweek
    long["h"] = h
    return long


def _baseline_preds(L: pd.DataFrame) -> dict[str, np.ndarray]:
    return {"persistence": L["y0"].to_numpy(), "same_hour_yesterday": L["y_same_hour"].to_numpy(),
            "diurnal": L["diurnal_t"].to_numpy(), "rolling_24h_avg": L["roll24"].to_numpy()}


def _stack(Y, W, horizons, diurnal, level, origin_mask_fn) -> pd.DataFrame:
    parts = []
    for h in horizons:
        L = _features(Y, W, h, diurnal, level)
        L = L[origin_mask_fn(L, h) & L["target"].notna() & L["y0"].notna()]
        parts.append(L)
    return pd.concat(parts) if parts else pd.DataFrame()


# ── relative form ───────────────────────────────────────────────────────────

REL_COLS = ("y0", "y1", "y2", "y3", "y6", "y12", "y_same_hour", "roll6", "city0", "city24", "diurnal_t", "level")


def _rel(L: pd.DataFrame) -> pd.DataFrame:
    """Express levels against the ward's trailing 24h mean (log-ratio), so the
    model learns shape, not an absolute level that drifts between seasons."""
    base = np.log1p(L["roll24"].clip(lower=1))
    out = pd.DataFrame(index=L.index)
    for c in REL_COLS:
        out[c + "_r"] = np.log1p(L[c].clip(lower=0)) - base
    for c in L.columns:
        if c in ("hour_sin", "hour_cos", "dow_t") or (c.endswith("_0") and not c.startswith("y")):
            out[c] = L[c]
    return out


def _to_total(pred_rel: np.ndarray, L: pd.DataFrame) -> np.ndarray:
    return np.expm1(pred_rel + np.log1p(L["roll24"].clip(lower=1).to_numpy()))


def _target_rel(L: pd.DataFrame) -> pd.Series:
    return np.log1p(L["target"].clip(lower=0)) - np.log1p(L["roll24"].clip(lower=1))


# ── fit ───────────────────────────────────────────────────────────────────────

def _train_horizon(Y, W, h, diurnal, level, mask_fn, objective="l1", alpha=None, n_estimators=None):
    import lightgbm as lgb

    L = _stack(Y, W, (h,), diurnal, level, mask_fn)
    L = L[L["roll24"].notna()]
    if len(L) < 2000:
        return None, None
    X = _rel(L)
    params = dict(LGB_PARAMS)
    if n_estimators:
        params["n_estimators"] = n_estimators
    kw = {"objective": objective} | ({"alpha": alpha} if alpha is not None else {})
    return lgb.LGBMRegressor(**kw, **params).fit(X, _target_rel(L)), list(X.columns)


def fit(pollutant: str, readings_df: pd.DataFrame, weather_df: pd.DataFrame,
        min_improvement_pct: float = 5.0) -> GlobalModel | None:
    if readings_df is None or readings_df.empty:
        return None
    Y = _panel(readings_df)
    if Y.shape[1] < MIN_WARDS or len(Y) < MIN_HOURS:
        log.info("global forecaster %s: too little data (%d wards, %d h)", pollutant, Y.shape[1], len(Y))
        return None
    W = _weather(weather_df, Y)
    val_start = Y.index.max() - pd.Timedelta(days=VALIDATION_DAYS)
    trainY = Y[Y.index < val_start]
    diurnal, level = trainY.groupby(trainY.index.hour).mean(), trainY.mean()

    def train_mask(L, h):
        return L.index.get_level_values("origin") + pd.Timedelta(hours=h) < val_start

    def val_mask(L, h):
        o = L.index.get_level_values("origin")
        return (o >= val_start) & (o.hour % ORIGIN_STEP_H == 0)

    gates, best_bl, bands, pooled, per_ward = {}, {}, {}, {}, {}
    for g in GATE_HORIZONS:
        m, cols = _train_horizon(Y, W, g, diurnal, level, train_mask)
        V = _stack(Y, W, (g,), diurnal, level, val_mask)
        if m is None or V.empty:
            gates[g] = False
            best_bl[g] = "persistence"
            continue
        y = V["target"].to_numpy()
        pm = _to_total(m.predict(_rel(V)[cols]), V)
        bp = _baseline_preds(V)
        ok = np.isfinite(y) & np.isfinite(pm) & np.all([np.isfinite(v) for v in bp.values()], axis=0)
        mae = {k: float(np.mean(np.abs(v[ok] - y[ok]))) for k, v in bp.items()}
        mae["model"] = float(np.mean(np.abs(pm[ok] - y[ok])))
        best = min(BASELINES, key=lambda k: mae[k])
        gates[g] = mae["model"] <= mae[best] * (1 - min_improvement_pct / 100.0)
        best_bl[g] = best
        resid = y[ok] - bp[best][ok]
        bands[g] = (float(np.quantile(resid, 0.10)), float(np.quantile(resid, 0.90)))
        pooled[g] = mae | {"n": int(ok.sum()), "best_baseline": best, "model_served": bool(gates[g])}
        wards = V.index.get_level_values("ward").to_numpy()
        for wid in np.unique(wards):
            k = ok & (wards == wid)
            if k.sum() >= 10:
                per_ward.setdefault(int(wid), {})[g] = {"y": y[k], "model": pm[k], **{b: bp[b][k] for b in BASELINES}}

    # Serving models, refit on ALL data, only for lead times some gate serves.
    diurnal_all, level_all = Y.groupby(Y.index.hour).mean(), Y.mean()
    all_mask = lambda L, h: np.ones(len(L), dtype=bool)
    models, feature_cols, n_rows = {}, None, 0
    for h in TRAIN_HORIZONS:
        if not gates.get(gate_for(h)):
            continue
        p50, cols = _train_horizon(Y, W, h, diurnal_all, level_all, all_mask)
        if p50 is None:
            continue
        q10, _ = _train_horizon(Y, W, h, diurnal_all, level_all, all_mask, "quantile", 0.10, 200)
        q90, _ = _train_horizon(Y, W, h, diurnal_all, level_all, all_mask, "quantile", 0.90, 200)
        models[h] = {"p50": p50, "q10": q10, "q90": q90}
        feature_cols = cols
    gm = GlobalModel(pollutant=pollutant, fitted_at=datetime.now(timezone.utc), feature_cols=feature_cols or [],
                     models=models, gates=gates, best_baseline=best_bl, baseline_bands=bands, pooled=pooled,
                     per_ward=per_ward, diurnal=diurnal_all, level=level_all,
                     train_start=Y.index.min(), train_end=Y.index.max(), n_rows=int(Y.notna().sum().sum()))
    log.info("global forecaster %s fitted: %d lead-time models, served %s", pollutant, len(models),
             {g: ("model" if v else best_bl.get(g)) for g, v in gates.items()})
    return gm


def fit_cached(pollutant, readings_df, weather_df, min_improvement_pct=5.0, max_age_h: float = 24.0):
    """Refit at most every max_age_h (city_config retraining_frequency_hours);
    cached on disk so a service restart doesn't force a refit."""
    f = CACHE_DIR / f"forecast_global_{pollutant}.pkl"
    if f.exists():
        try:
            gm = pickle.loads(f.read_bytes())
            fresh = (datetime.now(timezone.utc) - gm.fitted_at).total_seconds() < max_age_h * 3600
            # A model fitted on other wards can't serve these ones (no level or
            # diurnal norm for them): refit rather than reuse.
            wards_now = set(readings_df["ward_id"].unique()) if readings_df is not None and not readings_df.empty else set()
            covers = gm.level is not None and wards_now <= set(gm.level.index)
            if fresh and covers:
                return gm
        except Exception:
            log.warning("global forecaster cache unreadable for %s — refitting", pollutant)
    gm = fit(pollutant, readings_df, weather_df, min_improvement_pct)
    if gm is not None:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        f.write_bytes(pickle.dumps(gm))
    return gm


# ── serve ─────────────────────────────────────────────────────────────────────

def _model_for(gm: GlobalModel, h: int):
    if not gm.models:
        return None
    k = min(gm.models, key=lambda t: (abs(t - h), t))
    return gm.models[k]


def serve(gm: GlobalModel, readings_df: pd.DataFrame, weather_df: pd.DataFrame) -> dict[int, dict]:
    """ward -> {origin, future_idx, total, q10, q90, source[h]} for h = 1..MAX_H,
    from each ward's latest observed hour."""
    Y = _panel(readings_df)
    W = _weather(weather_df, Y)
    last = {w: Y[w].last_valid_index() for w in Y.columns}
    out = {w: {"origin": t, "total": np.full(MAX_H, np.nan), "q10": np.full(MAX_H, np.nan),
               "q90": np.full(MAX_H, np.nan), "source": [""] * MAX_H} for w, t in last.items() if t is not None}
    keys = [(o["origin"], w) for w, o in out.items()]
    for h in range(1, MAX_H + 1):
        L = _features(Y, W, h, gm.diurnal, gm.level)
        rows = L.reindex(pd.MultiIndex.from_tuples(keys, names=["origin", "ward"]))
        g = gate_for(h)
        mdl = _model_for(gm, h) if gm.gates.get(g) else None
        if mdl is not None:
            X = _rel(rows)[gm.feature_cols]
            p = _to_total(mdl["p50"].predict(X), rows)
            lo = _to_total(mdl["q10"].predict(X), rows) if mdl.get("q10") else p
            hi = _to_total(mdl["q90"].predict(X), rows) if mdl.get("q90") else p
        for i, (o, w) in enumerate(keys):
            r = rows.iloc[i]
            if pd.isna(r["y0"]):
                continue
            if mdl is not None and np.isfinite(p[i]):
                val, low, high, src = p[i], lo[i], hi[i], "model"
            else:
                name = gm.best_baseline.get(g, "persistence")
                val = {"persistence": r["y0"], "same_hour_yesterday": r["y_same_hour"],
                       "diurnal": r["diurnal_t"], "rolling_24h_avg": r["roll24"]}[name]
                if not np.isfinite(val):
                    val, name = r["y0"], "persistence"
                b = gm.baseline_bands.get(g, (0.0, 0.0))
                low, high, src = val + b[0], val + b[1], name
            out[w]["total"][h - 1] = max(float(val), 0.0)
            out[w]["q10"][h - 1] = max(min(float(low), float(val)), 0.0)
            out[w]["q90"][h - 1] = max(float(high), float(val))
            out[w]["source"][h - 1] = src
    for w, o in out.items():
        o["future_idx"] = pd.date_range(o["origin"] + pd.Timedelta(hours=1), periods=MAX_H, freq="h", tz="UTC")
    return out


def ward_validation_metrics(gm: GlobalModel, ward_id: int, horizons, threshold_fn) -> tuple[dict, int | None]:
    """Per-ward metrics in forecast_runs.validation_metrics' existing shape,
    from this ward's rows of the pooled validation. 'beats_persistence'
    reports whether the MODEL is served at that horizon (the pooled gate)."""
    metrics, max_validated = {}, None
    wm = gm.per_ward.get(int(ward_id), {})
    for h in horizons:
        g = gate_for(h)
        d = wm.get(g)
        if not d:
            continue
        y = d["y"]
        served = d["model"] if gm.gates.get(g) else d[gm.best_baseline[g]]
        mae = lambda p: float(np.mean(np.abs(p - y)))
        bl = {b: mae(d[b]) for b in BASELINES}
        best = min(bl, key=bl.get)
        recall, false_alarm = threshold_fn(served, y)
        metrics[str(h)] = {
            "mae": round(mae(served), 2), "rmse": round(float(np.sqrt(np.mean((served - y) ** 2))), 2),
            "bias": round(float(np.mean(served - y)), 2),
            "threshold_recall": round(recall, 2) if recall is not None else None,
            "false_alarm_rate": round(false_alarm, 2) if false_alarm is not None else None,
            "persistence_mae": round(bl["persistence"], 2), "diurnal_mae": round(bl["diurnal"], 2),
            "same_hour_yesterday_mae": round(bl["same_hour_yesterday"], 2),
            "rolling_24h_avg_mae": round(bl["rolling_24h_avg"], 2),
            "best_baseline": best, "best_baseline_mae": round(bl[best], 2),
            "beats_persistence": bool(gm.gates.get(g)),
            "pooled_model_mae": round(gm.pooled[g]["model"], 2),
            "pooled_best_baseline_mae": round(gm.pooled[g][gm.pooled[g]["best_baseline"]], 2),
        }
        if all(gm.gates.get(gate_for(hh)) for hh in horizons if hh <= h):
            max_validated = h
    return metrics, max_validated
