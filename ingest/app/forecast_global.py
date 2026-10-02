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

Gates and bands, since the rolling backtest (Sept 2026,
scripts/forecast_rolling_backtest.py): one 14-day window is too little to
decide on. Over 13 weekly folds it had switched off real wins (PM2.5 1h,
O3 6h, SO2 12h, CO 24h) and flapped where model and rule tie. When the
backtest's gates file (CACHE_DIR/forecast_gates.json, rewritten weekly) is
present and fresh, it decides model-vs-rule per gate horizon: model only
where its gain over the best rule has a 95% CI above zero across folds and
it won >= 2/3 of them. The 14-day window is then used only for the bands
and the per-ward metrics; without the file the old single-window gate
applies. Rule bands are multiplicative (value x/÷ ratio quantiles):
fixed ug/m3 offsets covered 86-94% of low hours and only 50-67% of high
ones. Model q10/q90 are widened in log space by the backtest's factor
(they covered 54-80% against a nominal 80%).

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

MODEL_VERSION_GLOBAL = "lgb_global_direct_v2"
# Bumped when the pickled GlobalModel's meaning changes; an older cache is refit.
# 3: season features, forecast-weather features (h >= 6), PM2.5 blend,
#    exceedance classifiers (forecast lab, Oct 2026).
SCHEMA = 3
GATES_MAX_AGE_DAYS = 21
MIN_CROSSINGS = 30          # an exceedance skill score needs this many real crossings
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
    schema: int = 1
    band_kind: str = "additive"          # "multiplicative" from schema 2: (lo, hi) are log-ratio quantiles
    model_band_scale: dict[int, float] = field(default_factory=dict)  # gate horizon -> log-space widening
    gate_source: str = "single_window"   # or "rolling_backtest <generated_at>"
    uses_fc: bool = False                # trained with forecast-weather features
    blend: dict[int, tuple[str, float]] = field(default_factory=dict)  # gate h -> (rule, weight on model)
    exceed: dict = field(default_factory=dict)  # threshold -> {gate h: (classifier, cut, feature cols)}
    exceed_skill: dict = field(default_factory=dict)  # threshold -> {gate h: Brier skill score}


def gate_for(h: int) -> int:
    return next(g for g in GATE_HORIZONS if g >= h)


def gates_file() -> Path:
    return CACHE_DIR / "forecast_gates.json"


def load_gates(pollutant: str, now: datetime | None = None) -> tuple[dict[int, dict], str] | None:
    """The rolling backtest's decisions for one pollutant ({gate h: entry},
    source label), or None when the file is missing, unreadable, older than
    GATES_MAX_AGE_DAYS or has nothing for this pollutant."""
    import json

    f = gates_file()
    if not f.exists():
        return None
    try:
        doc = json.loads(f.read_text())
        made = datetime.fromisoformat(doc["generated_at"])
        entries = doc["pollutants"].get(pollutant)
    except Exception:
        log.warning("forecast gates file unreadable; using the single-window gate")
        return None
    age_d = ((now or datetime.now(timezone.utc)) - made).total_seconds() / 86400
    if age_d > GATES_MAX_AGE_DAYS:
        log.warning("forecast gates file is %.0f days old; using the single-window gate", age_d)
        return None
    if not entries:
        return None
    return {int(g): e for g, e in entries.items()}, f"rolling_backtest {doc['generated_at']}"


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


def _fc_wide(Y: pd.DataFrame, W: dict, h: int, F) -> dict[str, pd.DataFrame]:
    """Compact forecast-weather features (lab variant v3b), from h >= 6 only:
    at 1-3 h the current state already carries the weather."""
    from .forecast_weather import MIN_H
    if F is None or h < MIN_H:
        return {}
    fr = F(h, Y.columns, Y.index)
    mean = lambda v: fr[v].rolling(h, min_periods=1).mean().shift(-h)  # noqa: E731
    rad = np.deg2rad(fr["wind_direction_10m"])
    ws_mean = mean("wind_speed_10m")
    out = {"fc_wind_speed_10m_mean": ws_mean,
           "fc_shear_mean": np.log1p(mean("wind_speed_100m")) - np.log1p(ws_mean),
           "fc_shortwave_radiation_mean": mean("shortwave_radiation"),
           "fc_relative_humidity_2m_mean": mean("relative_humidity_2m"),
           "fc_precip_sum": fr["precipitation"].rolling(h, min_periods=1).sum().shift(-h),
           "fc_u_mean": (-fr["wind_speed_10m"] * np.sin(rad)).rolling(h, min_periods=1).mean().shift(-h),
           "fc_v_mean": (-fr["wind_speed_10m"] * np.cos(rad)).rolling(h, min_periods=1).mean().shift(-h),
           "fc_cloud_cover_mean": mean("cloud_cover"),
           "fc_dtemp": fr["temperature_2m"].shift(-h) - W["temp_c"],
           "fc_dwind": np.log1p(ws_mean) - np.log1p(W["wind_speed"])}
    return out


def _features(Y: pd.DataFrame, W: dict, h: int, diurnal: pd.DataFrame, level: pd.Series, F=None) -> pd.DataFrame:
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
    wide.update(_fc_wide(Y, W, h, F))
    long = pd.concat({k: v.stack(future_stack=True) for k, v in wide.items()}, axis=1)
    long.index.names = ["origin", "ward"]
    o = long.index.get_level_values("origin")
    th = (o + pd.Timedelta(hours=h)).hour
    long["hour_sin"] = np.sin(2 * np.pi * th / 24)
    long["hour_cos"] = np.cos(2 * np.pi * th / 24)
    long["dow_t"] = (o + pd.Timedelta(hours=h)).dayofweek
    # season (lab v9): with all history in training, the model can tell winter from monsoon
    doy = (o + pd.Timedelta(hours=h)).dayofyear.to_numpy()
    long["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    long["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
    long["h"] = h
    return long


def _baseline_preds(L: pd.DataFrame) -> dict[str, np.ndarray]:
    return {"persistence": L["y0"].to_numpy(), "same_hour_yesterday": L["y_same_hour"].to_numpy(),
            "diurnal": L["diurnal_t"].to_numpy(), "rolling_24h_avg": L["roll24"].to_numpy()}


def _stack(Y, W, horizons, diurnal, level, origin_mask_fn, F=None) -> pd.DataFrame:
    parts = []
    for h in horizons:
        L = _features(Y, W, h, diurnal, level, F)
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
        if (c in ("hour_sin", "hour_cos", "dow_t") or (c.endswith("_0") and not c.startswith("y"))
                or c.startswith(("fc_", "doy_"))):
            out[c] = L[c]
    return out


def _abs_cols(L: pd.DataFrame) -> pd.DataFrame:
    """Absolute levels for the exceedance classifiers: crossing a FIXED
    threshold depends on the level, which the relative features drop."""
    return pd.DataFrame({"abs_y0": np.log1p(L["y0"].clip(lower=0)), "abs_roll24": np.log1p(L["roll24"].clip(lower=0)),
                         "abs_diurnal_t": np.log1p(L["diurnal_t"].clip(lower=0)),
                         "abs_city0": np.log1p(L["city0"].clip(lower=0))}, index=L.index)


def _to_total(pred_rel: np.ndarray, L: pd.DataFrame) -> np.ndarray:
    return np.expm1(pred_rel + np.log1p(L["roll24"].clip(lower=1).to_numpy()))


def _target_rel(L: pd.DataFrame) -> pd.Series:
    return np.log1p(L["target"].clip(lower=0)) - np.log1p(L["roll24"].clip(lower=1))


# ── fit ───────────────────────────────────────────────────────────────────────

def _train_horizon(Y, W, h, diurnal, level, mask_fn, objective="l1", alpha=None, n_estimators=None, F=None):
    import lightgbm as lgb

    L = _stack(Y, W, (h,), diurnal, level, mask_fn, F)
    L = L[L["roll24"].notna()]
    if len(L) < 2000:
        return None, None
    X = _rel(L)
    params = dict(LGB_PARAMS)
    if n_estimators:
        params["n_estimators"] = n_estimators
    kw = {"objective": objective} | ({"alpha": alpha} if alpha is not None else {})
    return lgb.LGBMRegressor(**kw, **params).fit(X, _target_rel(L)), list(X.columns)


def _exceed_X(L: pd.DataFrame) -> pd.DataFrame:
    return pd.concat([_rel(L), _abs_cols(L)], axis=1)


def _fit_classifier(Lt: pd.DataFrame, thr: float):
    import lightgbm as lgb
    y = (Lt["target"] >= thr).astype(int)
    if y.sum() < 20 or y.sum() == len(y):
        return None, None
    X = _exceed_X(Lt)
    return lgb.LGBMClassifier(**LGB_PARAMS).fit(X, y), list(X.columns)


def _best_cut(prob: np.ndarray, act: np.ndarray) -> float:
    """Decision cut-off that maximises CSI (hits / (hits + misses + false alarms))."""
    best, cut = -1.0, 0.5
    for c in np.arange(0.05, 0.95, 0.025):
        pr = prob >= c
        csi = (pr & act).sum() / max((pr | act).sum(), 1)
        if csi > best:
            best, cut = csi, float(c)
    return cut


def fit(pollutant: str, readings_df: pd.DataFrame, weather_df: pd.DataFrame,
        min_improvement_pct: float = 5.0, F=None, thresholds: dict | None = None) -> GlobalModel | None:
    """thresholds: {"alert": x, "severe": y} (either may be None): exceedance
    classifiers are trained for each, per gate horizon."""
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

    thr_items = [(k, float(v)) for k, v in (thresholds or {}).items() if v]
    gates, best_bl, bands, pooled, per_ward, scale, blend = {}, {}, {}, {}, {}, {}, {}
    cuts: dict = {}
    skill: dict = {}
    backtest = load_gates(pollutant)
    for g in GATE_HORIZONS:
        m, cols = _train_horizon(Y, W, g, diurnal, level, train_mask, F=F)
        V = _stack(Y, W, (g,), diurnal, level, val_mask, F)
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
        if backtest and g in backtest[0]:
            e = backtest[0][g]
            gates[g] = bool(e["serve_model"])
            best_bl[g] = e["best_rule"] if e.get("best_rule") in BASELINES else best
            scale[g] = float(e.get("model_band_scale") or 1.0)
            if e.get("blend_rule") in BASELINES and e.get("blend_w") is not None and float(e["blend_w"]) < 1.0:
                blend[g] = (e["blend_rule"], float(e["blend_w"]))
        rule = bp[best_bl[g]]
        k = ok & (rule > 0) & (y >= 0)
        ratio = np.log(np.clip(y[k], 0.1, None) / np.clip(rule[k], 0.1, None))
        bands[g] = (float(np.quantile(ratio, 0.10)), float(np.quantile(ratio, 0.90)))
        pooled[g] = mae | {"n": int(ok.sum()), "best_baseline": best_bl[g], "model_served": bool(gates[g])}
        wards = V.index.get_level_values("ward").to_numpy()
        for wid in np.unique(wards):
            k = ok & (wards == wid)
            if k.sum() >= 10:
                per_ward.setdefault(int(wid), {})[g] = {"y": y[k], "model": pm[k], **{b: bp[b][k] for b in BASELINES}}
        # exceedance: cut-off and skill on the validation window, from a classifier fitted before it
        if thr_items:
            Lt = _stack(Y, W, (g,), diurnal, level, train_mask, F)
            Lt = Lt[Lt["roll24"].notna()]
            Vv = V[V["roll24"].notna()]
            for name, thr in thr_items:
                clf, ccols = _fit_classifier(Lt, thr)
                if clf is None or Vv.empty:
                    continue
                act = (Vv["target"] >= thr).to_numpy()
                prob = clf.predict_proba(_exceed_X(Vv)[ccols])[:, 1]
                base = float((Lt["target"] >= thr).mean())
                clim = float(np.mean((base - act) ** 2))
                cuts.setdefault(thr, {})[g] = _best_cut(prob, act) if act.sum() >= 5 else 0.5
                # skill needs >= MIN_CROSSINGS real crossings; the weekly backtest's verdict, when present, wins
                skill.setdefault(thr, {})[g] = (float(1 - np.mean((prob - act) ** 2) / clim)
                                                if clim > 0 and act.sum() >= MIN_CROSSINGS else None)
                if backtest and g in backtest[0]:
                    ent = (backtest[0][g].get("exceed") or {}).get(name)
                    if ent is not None:
                        skill[thr][g] = float(ent["bss"]) if ent.get("bss") is not None else None

    # Serving models, refit on ALL data, only for lead times some gate serves.
    diurnal_all, level_all = Y.groupby(Y.index.hour).mean(), Y.mean()
    all_mask = lambda L, h: np.ones(len(L), dtype=bool)  # noqa: E731
    models, feature_cols = {}, None
    for h in TRAIN_HORIZONS:
        if not gates.get(gate_for(h)):
            continue
        p50, cols = _train_horizon(Y, W, h, diurnal_all, level_all, all_mask, F=F)
        if p50 is None:
            continue
        q10, _ = _train_horizon(Y, W, h, diurnal_all, level_all, all_mask, "quantile", 0.10, 200, F=F)
        q90, _ = _train_horizon(Y, W, h, diurnal_all, level_all, all_mask, "quantile", 0.90, 200, F=F)
        models[h] = {"p50": p50, "q10": q10, "q90": q90, "cols": cols}   # cols differ by lead (fc_ from 6 h)
        feature_cols = cols
    exceed = {}
    for _, thr in thr_items:
        for g, cut in cuts.get(thr, {}).items():
            La = _stack(Y, W, (g,), diurnal_all, level_all, all_mask, F)
            La = La[La["roll24"].notna()]
            clf, ccols = _fit_classifier(La, thr)
            if clf is not None:
                exceed.setdefault(thr, {})[g] = (clf, cut, ccols)
    gm = GlobalModel(pollutant=pollutant, fitted_at=datetime.now(timezone.utc), feature_cols=feature_cols or [],
                     models=models, gates=gates, best_baseline=best_bl, baseline_bands=bands, pooled=pooled,
                     per_ward=per_ward, diurnal=diurnal_all, level=level_all,
                     train_start=Y.index.min(), train_end=Y.index.max(), n_rows=int(Y.notna().sum().sum()),
                     schema=SCHEMA, band_kind="multiplicative", model_band_scale=scale,
                     gate_source=backtest[1] if backtest else "single_window", uses_fc=F is not None,
                     blend=blend, exceed=exceed, exceed_skill=skill)
    log.info("global forecaster %s fitted: %d lead-time models, served %s (gates: %s), blend %s, exceedance %s",
             pollutant, len(models), {g: ("model" if v else best_bl.get(g)) for g, v in gates.items()},
             gm.gate_source, blend, {t: sorted(d) for t, d in exceed.items()})
    return gm


def fit_cached(pollutant, readings_df, weather_df, min_improvement_pct=5.0, max_age_h: float = 24.0,
               F=None, thresholds: dict | None = None):
    """Refit at most every max_age_h (city_config retraining_frequency_hours);
    cached on disk so a service restart doesn't force a refit."""
    f = CACHE_DIR / f"forecast_global_{pollutant}.pkl"
    if f.exists():
        try:
            gm = pickle.loads(f.read_bytes())
            fresh = (datetime.now(timezone.utc) - gm.fitted_at).total_seconds() < max_age_h * 3600
            fresh = fresh and getattr(gm, "schema", 1) >= SCHEMA
            # New backtest gates take effect at once, not at the next daily refit.
            f_g = gates_file()
            if f_g.exists() and datetime.fromtimestamp(f_g.stat().st_mtime, timezone.utc) > gm.fitted_at:
                fresh = False
            # A model fitted on other wards can't serve these ones (no level or
            # diurnal norm for them): refit rather than reuse.
            wards_now = set(readings_df["ward_id"].unique()) if readings_df is not None and not readings_df.empty else set()
            covers = gm.level is not None and wards_now <= set(gm.level.index)
            if fresh and covers:
                return gm
        except Exception:
            log.warning("global forecaster cache unreadable for %s — refitting", pollutant)
    gm = fit(pollutant, readings_df, weather_df, min_improvement_pct, F=F, thresholds=thresholds)
    if gm is not None:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        f.write_bytes(pickle.dumps(gm))
    return gm


# ── serve ─────────────────────────────────────────────────────────────────────

def _model_for(gm: GlobalModel, h: int):
    """The nearest trained lead time, on the same side of the forecast-weather
    boundary (a 5 h lead must not borrow the 6 h model's fc_ inputs)."""
    if not gm.models:
        return None
    from .forecast_weather import MIN_H
    same = [t for t in gm.models if (t >= MIN_H) == (h >= MIN_H)] if gm.uses_fc else list(gm.models)
    k = min(same or gm.models, key=lambda t: (abs(t - h), t))
    return gm.models[k]


def _rule_value(r, name: str) -> float:
    return {"persistence": r["y0"], "same_hour_yesterday": r["y_same_hour"],
            "diurnal": r["diurnal_t"], "rolling_24h_avg": r["roll24"]}[name]


def serve(gm: GlobalModel, readings_df: pd.DataFrame, weather_df: pd.DataFrame, F=None,
          severe_threshold: float | None = None) -> dict[int, dict]:
    """ward -> {origin, future_idx, total, q10, q90, source[h], p_exceed{thr: [h]},
    severe_elevated[h]} for h = 1..MAX_H, from each ward's latest observed hour.

    total is the MOST LIKELY value (the median: lab, Oct 2026, it sits 10-17%
    below the average outcome for PM2.5 in winter, by design, and inflating it
    made errors worse); q10/q90 carry the upside risk. p_exceed is published
    only where the classifier showed skill (Brier skill score > 0)."""
    Y = _panel(readings_df)
    # extend into the future so forecast-weather features exist at target hours
    Y = Y.reindex(pd.date_range(Y.index.min(), Y.index.max() + pd.Timedelta(hours=MAX_H), freq="h", tz="UTC"))
    W = _weather(weather_df, Y)
    if not gm.uses_fc:
        F = None
    last = {w: Y[w].last_valid_index() for w in Y.columns}
    out = {w: {"origin": t, "total": np.full(MAX_H, np.nan), "q10": np.full(MAX_H, np.nan),
               "q90": np.full(MAX_H, np.nan), "source": [""] * MAX_H,
               "p_exceed": {thr: np.full(MAX_H, np.nan) for thr in gm.exceed},
               "severe_elevated": np.zeros(MAX_H, dtype=bool)}
           for w, t in last.items() if t is not None}
    keys = [(o["origin"], w) for w, o in out.items()]
    for h in range(1, MAX_H + 1):
        L = _features(Y, W, h, gm.diurnal, gm.level, F)
        rows = L.reindex(pd.MultiIndex.from_tuples(keys, names=["origin", "ward"]))
        g = gate_for(h)
        mdl = _model_for(gm, h) if gm.gates.get(g) else None
        if mdl is not None:
            X = _rel(rows)[mdl.get("cols") or gm.feature_cols]
            p = _to_total(mdl["p50"].predict(X), rows)
            lo = _to_total(mdl["q10"].predict(X), rows) if mdl.get("q10") else p
            hi = _to_total(mdl["q90"].predict(X), rows) if mdl.get("q90") else p
            s = gm.model_band_scale.get(g, 1.0)
            if s != 1.0:
                # widen in log space around the median: lo = p x (lo/p)^s
                pc = np.clip(p, 0.1, None)
                lo = pc * np.exp(s * np.minimum(np.log(np.clip(lo, 0.1, None) / pc), 0))
                hi = pc * np.exp(s * np.maximum(np.log(np.clip(hi, 0.1, None) / pc), 0))
        probs = {}
        # classifiers are per gate horizon; a lead below the forecast-weather
        # boundary must not use a gate at or above it (its inputs include fc_)
        from .forecast_weather import MIN_H
        gc = g if (not gm.uses_fc or h >= MIN_H or g < MIN_H) else max(x for x in GATE_HORIZONS if x < MIN_H)
        for thr, by_g in gm.exceed.items():
            ent = by_g.get(gc)
            sk = (gm.exceed_skill.get(thr) or {}).get(gc)
            if ent is not None and sk is not None and sk > 0:
                clf, cut, ccols = ent
                probs[thr] = (clf.predict_proba(_exceed_X(rows)[ccols])[:, 1], cut)
        for i, (o, w) in enumerate(keys):
            r = rows.iloc[i]
            if pd.isna(r["y0"]):
                continue
            if mdl is not None and np.isfinite(p[i]):
                val, low, high, src = p[i], lo[i], hi[i], "model"
                if g in gm.blend:
                    rname, wt = gm.blend[g]
                    rv = _rule_value(r, rname)
                    if np.isfinite(rv) and val > 0:
                        b = wt * val + (1 - wt) * rv
                        low, high, val, src = low * b / val, high * b / val, b, "model_blend"
            else:
                name = gm.best_baseline.get(g, "persistence")
                val = _rule_value(r, name)
                if not np.isfinite(val):
                    val, name = r["y0"], "persistence"
                b = gm.baseline_bands.get(g, (0.0, 0.0))
                if gm.band_kind == "multiplicative":
                    low, high, src = val * np.exp(b[0]), val * np.exp(b[1]), name
                else:
                    low, high, src = val + b[0], val + b[1], name
            out[w]["total"][h - 1] = max(float(val), 0.0)
            out[w]["q10"][h - 1] = max(min(float(low), float(val)), 0.0)
            out[w]["q90"][h - 1] = max(float(high), float(val))
            out[w]["source"][h - 1] = src
            for thr, (pr, cut) in probs.items():
                out[w]["p_exceed"][thr][h - 1] = float(pr[i])
            if severe_threshold is not None:
                # validated rule (lab): already above it now, OR the classifier says so
                sev = probs.get(severe_threshold)
                out[w]["severe_elevated"][h - 1] = bool(r["y0"] >= severe_threshold
                                                        or (sev is not None and sev[0][i] >= sev[1]))
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
