"""Forecast experiment on real hourly data: is there a better forecaster?

Compares, on TOTAL concentration (what users see), from many forecast
origins in a held-out final period:

  persistence          y(t)
  same-hour-yesterday  last observed value at the target's clock hour
  diurnal              the station's mean for the target hour (training period)
  production-like      what the live forecaster mostly serves: the city median
                       frozen at t, plus the station's excess blended from
                       persistence to its diurnal mean over 24h
  global LGB           ONE LightGBM per horizon, pooled over all stations,
                       direct (not recursive), L1 loss; two variants:
                         (a) + weather at the TARGET hour: observed ERA5
                             standing in for a forecast ("perfect prognosis",
                             an upper bound on what weather forecasts give)
                         (b) weather at the origin only: a lower bound

Train/test: the last TEST_DAYS days are held out; training targets all
fall before the test period starts (no leakage). Origins every 3h.

    python scripts/forecast_experiment.py [pollutant ...]
"""

from __future__ import annotations

import pickle
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402

HORIZONS = (1, 3, 6, 12, 24, 48)
TEST_DAYS = 30
ORIGIN_EVERY_H = 3
ERA5 = Path(__file__).resolve().parents[1] / "data" / "species_cache" / "forecast_era5_stations.pkl"
MET = ("wind_speed", "boundary_layer_height", "temp_c", "humidity", "precipitation")
PREV = Path(__file__).resolve().parents[1] / "data" / "species_cache" / "forecast_prevruns_stations.pkl"
FC_VARS = {"temperature_2m": "temp_c", "relative_humidity_2m": "humidity",
           "wind_speed_10m": "wind_speed", "precipitation": "precipitation"}


def panel(pollutant: str) -> tuple[pd.DataFrame, pd.DatetimeIndex]:
    rows = db._fetch_all(lambda: db.client().table("readings_hourly")
                         .select(f"station_id, ts, {pollutant}").not_.is_(pollutant, "null")
                         .order("ts").order("station_id"))
    df = pd.DataFrame(rows)
    df["ts"] = pd.to_datetime(df["ts"], utc=True).dt.floor("h")
    wide = df.pivot_table(index="ts", columns="station_id", values=pollutant, aggfunc="mean")
    idx = pd.date_range(wide.index.min(), wide.index.max(), freq="h", tz="UTC")
    return wide.reindex(idx), idx


def weather(stations, idx) -> dict[str, pd.DataFrame]:
    era = pickle.loads(ERA5.read_bytes())
    keys = [t.strftime("%Y-%m-%dT%H") for t in idx]
    out = {}
    for m in MET:
        cols = {}
        for s in stations:
            e = era.get(s, {})
            cols[s] = [(e.get(k) or {}).get(m) for k in keys]
        out[m] = pd.DataFrame(cols, index=idx, dtype=float)
    out["vc"] = out["wind_speed"] * out["boundary_layer_height"]
    return out


def forecasts(stations, idx, day: int) -> dict[str, pd.DataFrame]:
    """Archived weather FORECASTS (Open-Meteo Previous Runs API) valid at each
    hour, issued `day` days earlier. What a live forecaster actually has.
    PBLH is not archived as a past forecast, so it's absent here."""
    prev = pickle.loads(PREV.read_bytes())
    keys = [t.strftime("%Y-%m-%dT%H") for t in idx]
    out = {}
    for src, name in FC_VARS.items():
        k = f"{src}_previous_day{day}"
        out[name] = pd.DataFrame({s: [(prev.get(s, {}).get(t) or {}).get(k) for t in keys] for s in stations},
                                 index=idx, dtype=float)
    return out


def build(Y: pd.DataFrame, W: dict, h: int, train_end: pd.Timestamp, diurnal: pd.DataFrame, level: pd.Series,
          F: dict | None = None):
    """Long table of (station, origin) rows for horizon h."""
    city = Y.median(axis=1)
    lag = lambda k: Y.shift(k)
    sh = 24 * int(np.ceil(h / 24))                      # same clock hour, most recent observed day
    feats = {
        "y0": Y, "y1": lag(1), "y2": lag(2), "y3": lag(3), "y6": lag(6), "y12": lag(12),
        "y_same_hour": Y.shift(sh - h),                 # value at target clock-hour, `sh` before target
        "roll6": Y.rolling(6, min_periods=3).mean(), "roll24": Y.rolling(24, min_periods=12).mean(),
        "city0": pd.DataFrame({s: city for s in Y.columns}),
        "city24": pd.DataFrame({s: city.rolling(24, min_periods=12).mean() for s in Y.columns}),
    }
    tgt_time = Y.index + pd.Timedelta(hours=h)
    hour_t = pd.DataFrame({s: tgt_time.hour for s in Y.columns}, index=Y.index)
    feats["diurnal_t"] = hour_t.apply(lambda col: diurnal[col.name].reindex(col.values).to_numpy())
    feats["level"] = pd.DataFrame({s: level.get(s, np.nan) for s in Y.columns}, index=Y.index)
    feats["hour_sin"] = np.sin(2 * np.pi * hour_t / 24); feats["hour_cos"] = np.cos(2 * np.pi * hour_t / 24)
    feats["dow_t"] = pd.DataFrame({s: tgt_time.dayofweek for s in Y.columns}, index=Y.index)
    for m, Wm in W.items():
        feats[f"{m}_0"] = Wm                                    # at origin (both variants)
        feats[f"{m}_t"] = Wm.shift(-h)                          # at target (variant a only)
    feats["pblh_change"] = W["boundary_layer_height"].shift(-h) - W["boundary_layer_height"]
    for m, Fm in (F or {}).items():
        feats[f"fc_{m}"] = Fm.shift(-h)                         # forecast valid at target (variant c)
    target = Y.shift(-h)
    long = pd.concat({k: v.stack(future_stack=True) for k, v in feats.items()} | {"target": target.stack(future_stack=True)}, axis=1)
    long.index.names = ["origin", "station"]
    return long


def run(pollutant: str) -> dict:
    import lightgbm as lgb

    Y, idx = panel(pollutant)
    Y = Y.clip(lower=0)
    stations = list(Y.columns)
    W = weather(stations, idx)
    F1, F2 = forecasts(stations, idx, 1), forecasts(stations, idx, 2)
    test_start = idx.max() - pd.Timedelta(days=TEST_DAYS)
    train_Y = Y[Y.index < test_start]
    diurnal = train_Y.groupby(train_Y.index.hour).mean()
    level = train_Y.mean()
    res = {}
    print(f"\n{pollutant}: {len(stations)} stations, {idx.min():%Y-%m-%d} -> {idx.max():%Y-%m-%d}, test from {test_start:%Y-%m-%d}")
    print(f"  {'horizon':>7} | {'persist':>8} {'sameHrY':>8} {'diurnal':>8} {'prodlike':>8} {'LGB(b)':>8} {'LGB(c)':>8} {'LGB(a)':>8} | skill vs best simple rule: b / c(real wx fc) / a")
    for h in HORIZONS:
        L = build(Y, W, h, test_start, diurnal, level, F1 if h <= 24 else F2)
        o = L.index.get_level_values("origin")
        tgt_time = o + pd.Timedelta(hours=h)
        train = L[(tgt_time < test_start) & L["target"].notna() & L["y0"].notna()]
        test = L[(o >= test_start) & (o.hour % ORIGIN_EVERY_H == 0) & L["target"].notna() & L["y0"].notna()]
        cols_b = [c for c in L.columns if c != "target" and not c.endswith("_t") and c != "pblh_change"
                  and not c.startswith("fc_")] + ["diurnal_t", "hour_sin", "hour_cos", "dow_t"]
        cols_b = list(dict.fromkeys(cols_b))
        cols_c = cols_b + [c for c in L.columns if c.startswith("fc_")]
        cols_a = [c for c in L.columns if c != "target" and not c.startswith("fc_")]
        params = dict(objective="l1", learning_rate=0.05, num_leaves=31, min_child_samples=50,
                      feature_fraction=0.9, bagging_fraction=0.8, bagging_freq=1, n_estimators=400, verbose=-1, random_state=42)
        preds = {}
        for name, cols in (("LGB(b)", cols_b), ("LGB(c)", cols_c), ("LGB(a)", cols_a)):
            m = lgb.LGBMRegressor(**params).fit(train[cols], train["target"])
            preds[name] = m.predict(test[cols])
        y = test["target"].to_numpy()
        city0 = test["city0"].to_numpy()
        excess0 = test["y0"].to_numpy() - city0
        st = test.index.get_level_values("station")
        diur_ex = test["diurnal_t"].to_numpy() - np.array([train_Y.median(axis=1).groupby(train_Y.index.hour).mean().get(t.hour, np.nan)
                                                            for t in test.index.get_level_values("origin") + pd.Timedelta(hours=h)])
        b = min(h / 24.0, 1.0)
        base = {
            "persist": test["y0"].to_numpy(),
            "sameHrY": test["y_same_hour"].to_numpy(),
            "diurnal": test["diurnal_t"].to_numpy(),
            "prodlike": city0 + (1 - b) * excess0 + b * np.nan_to_num(diur_ex, nan=0.0),
        }
        allp = base | preds
        mask = np.isfinite(y)
        for v in allp.values():
            mask &= np.isfinite(v)
        mae = {k: float(np.mean(np.abs(v[mask] - y[mask]))) for k, v in allp.items()}
        res[h] = mae | {"n": int(mask.sum())}
        best = min(mae["persist"], mae["sameHrY"], mae["diurnal"])
        sk = {k: 1 - mae[k] / best for k in ("LGB(b)", "LGB(c)", "LGB(a)")}
        res[h]["best_simple"] = best
        print(f"  {h:>6}h | " + " ".join(f"{mae[k]:8.2f}" for k in ("persist", "sameHrY", "diurnal", "prodlike", "LGB(b)", "LGB(c)", "LGB(a)"))
              + f" | {100*sk['LGB(b)']:+5.1f}% / {100*sk['LGB(c)']:+5.1f}% / {100*sk['LGB(a)']:+5.1f}%  (n={int(mask.sum())})")
    return res


if __name__ == "__main__":
    import warnings
    warnings.filterwarnings("ignore")
    import json
    out = {p: run(p) for p in (sys.argv[1:] or ["pm25", "no2", "pm10", "o3", "so2", "co"])}
    dest = Path(__file__).resolve().parents[1] / "data" / "species_cache" / "forecast_experiment.json"
    dest.write_text(json.dumps(out, indent=1))
