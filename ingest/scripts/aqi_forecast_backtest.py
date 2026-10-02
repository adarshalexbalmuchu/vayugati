"""Backtest of the forecast AQI (app/forecast_aqi.py) before it is published.

For each test week, the six pollutant forecasters are trained only on data
before it, with production's features, leads, band widening and blends
(forecast_global; gates as live: every lead served by the model). From an
origin every ORIGIN_STEP_H hours in the week, each ward's pollutants are
forecast with forecast_global.serve() on the data up to that hour, and the
AQI is built with forecast_aqi.forecast_ward(): exactly the live path.

Scored against the AQI the monitors gave (same CPCB rule, observed hours
only), next to two rules:
  persistence   the AQI now, held
  rule_fill     each pollutant's latest hour held, then the same AQI rule

Weeks: three in winter (when AQI forecasts matter most) and three across
the rest of the year.

    python scripts/aqi_forecast_backtest.py run [week ...]   # trains and scores (~1.5 h; background)
    python scripts/aqi_forecast_backtest.py report    # reads the saved scores
    python scripts/aqi_forecast_backtest.py gate      # report + write the publish gate
    python scripts/aqi_forecast_backtest.py refresh   # monthly (main.py): rescore the 3 latest
                                                      # complete weeks, keep the winter weeks, re-gate

Publish rule (fixed before the results were seen): a lead passes when, in
each season, the forecast AQI's mean error is no worse than "the AQI now,
held", and from 6 h on its gain is significant (95% CI above zero, all
weeks pooled). max_lead is the longest run of passing leads from 1 h. The
range is widened in log space (band_scale) until it holds 80% of outcomes
over the published leads.
"""

from __future__ import annotations

import os
import pickle
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

OUT = Path(__file__).resolve().parents[1] / "data" / "backtests" / "aqi_forecast.pkl"
# 2026-01-12 was the plan, but the history archive has no readings for
# 10-20 Jan 2026 (every pollutant), so the week after the gap is used.
WINTER_WEEKS = ("2025-11-10", "2025-12-15", "2026-01-26")
WEEKS = WINTER_WEEKS + ("2026-04-13", "2026-06-15", "2026-09-14")
MIN_RECENT_ROWS = 5000        # refresh keeps the current gate if the recent weeks score fewer
ORIGIN_STEP_H = 6
LEADS = (1, 3, 6, 12, 24, 36, 48)
WORKERS = 3
THREADS = 3
SERVE_LOOKBACK_D = 8          # serve() only needs the last ~2 days of lags


def _fold(week: str) -> pd.DataFrame:
    import warnings
    warnings.filterwarnings("ignore")
    from app import forecast as F, forecast_aqi as FA, forecast_global as G
    from scripts.forecast_rolling_backtest import load_inputs

    data = load_inputs()
    T = pd.Timestamp(week, tz="UTC")
    T_end = T + pd.Timedelta(days=7)
    from app import db
    Fr = F._forecast_weather_frames(db.get_wards_with_city(), data["readings"])[0]
    gates_all = {}
    for p in FA.POLLUTANTS:
        g = G.load_gates(p)
        gates_all[p] = g[0] if g else {}

    dfs, gms, full = {}, {}, {}
    for p in FA.POLLUTANTS:
        df = F._hourly_ward_pollutant(data["readings"], p)
        full[p] = df[df["ts"] < T_end + pd.Timedelta(hours=48)]
        df = df[df["ts"] < T_end]
        dfs[p] = df
        Y = G._panel(df)
        W = G._weather(data["weather"], Y)
        trainY = Y[Y.index < T]
        diurnal, level = trainY.groupby(trainY.index.hour).mean(), trainY.mean()
        mask = lambda L, h: L.index.get_level_values("origin") + pd.Timedelta(hours=h) < T  # noqa: E731
        models = {}
        for h in G.TRAIN_HORIZONS:
            p50, cols = G._train_horizon(Y, W, h, diurnal, level, mask, F=Fr)
            if p50 is None:
                continue
            q10, _ = G._train_horizon(Y, W, h, diurnal, level, mask, "quantile", 0.10, 200, F=Fr)
            q90, _ = G._train_horizon(Y, W, h, diurnal, level, mask, "quantile", 0.90, 200, F=Fr)
            models[h] = {"p50": p50, "q10": q10, "q90": q90, "cols": cols}
        gt = gates_all[p]
        gms[p] = G.GlobalModel(
            pollutant=p, fitted_at=T.to_pydatetime(), feature_cols=next(iter(models.values()))["cols"] if models else [],
            models=models, gates={g: True for g in G.GATE_HORIZONS}, best_baseline={}, baseline_bands={},
            pooled={}, diurnal=diurnal, level=level, schema=G.SCHEMA, band_kind="multiplicative",
            model_band_scale={g: float(gt.get(g, {}).get("model_band_scale") or 1.0) for g in G.GATE_HORIZONS},
            uses_fc=Fr is not None,
            blend={g: (gt[g]["blend_rule"], float(gt[g]["blend_w"])) for g in G.GATE_HORIZONS
                   if gt.get(g, {}).get("blend_rule")})
        print(f"{week} {p}: {len(models)} lead models trained", flush=True)

    # observed hourly series per ward: inputs (cut at each origin) and truth
    obs = {p: {w: g.set_index("ts")["value"].sort_index() for w, g in df.groupby("ward_id")} for p, df in full.items()}
    wards = sorted(set().union(*[set(o) for o in obs.values()]))
    rows = []
    for T0 in pd.date_range(T, T_end - pd.Timedelta(hours=ORIGIN_STEP_H), freq=f"{ORIGIN_STEP_H}h", tz="UTC"):
        lo = T0 - pd.Timedelta(days=SERVE_LOOKBACK_D)
        served = {}
        for p, df in dfs.items():
            d = df[(df["ts"] >= lo) & (df["ts"] <= T0)]
            if d.empty:
                continue
            s = G.serve(gms[p], d, data["weather"], F=Fr)
            served[p] = {w: v for w, v in s.items() if T0 - v["origin"] <= pd.Timedelta(hours=F.MAX_ORIGIN_AGE_H)}
        for w in wards:
            past = {p: (obs[p][w][obs[p][w].index <= T0] if w in obs[p] else None) for p in FA.POLLUTANTS}
            sv = {p: served.get(p, {}).get(w) for p in FA.POLLUTANTS}
            truth = {p: (obs[p][w] if w in obs[p] else None) for p in FA.POLLUTANTS}
            fc = FA.forecast_ward(past, {p: s for p, s in sv.items() if s})
            if fc is None:
                continue
            now_aqi, _ = FA.observed_aqi(past, T0)
            # rule_fill: each pollutant's latest value held
            held = {}
            for p, s in past.items():
                if s is not None and not s.dropna().empty and T0 - s.dropna().index.max() <= pd.Timedelta(hours=F.MAX_ORIGIN_AGE_H):
                    last = s.dropna()
                    v = np.full(48, float(last.iloc[-1]))
                    held[p] = {"origin": last.index.max(), "future_idx": pd.date_range(last.index.max() + pd.Timedelta(hours=1), periods=48, freq="h", tz="UTC"),
                               "total": v, "q10": v, "q90": v}
            rf = FA.forecast_ward(past, held)
            for h in LEADS:
                Tt = fc["origin"] + pd.Timedelta(hours=h)
                act, act_dom = FA.observed_aqi(truth, Tt)
                if act is None:
                    continue
                rule = np.nan
                if rf is not None:
                    j = np.searchsorted(rf["future_idx"], Tt)
                    if j < len(rf["aqi"]) and rf["future_idx"][j] == Tt:
                        rule = rf["aqi"][j]
                rows.append({"week": week, "origin": fc["origin"], "ward": w, "h": h, "actual": act, "actual_dom": act_dom,
                             "fc": fc["aqi"][h - 1], "low": fc["low"][h - 1], "high": fc["high"][h - 1],
                             "fc_dom": fc["dominant"][h - 1], "persist": now_aqi, "rule_fill": rule})
    print(f"{week}: {len(rows)} scored rows", flush=True)
    return pd.DataFrame(rows)


def run(weeks=WEEKS, keep=WEEKS, refresh_inputs=False) -> pd.DataFrame:
    """Score `weeks`; saved rows for the other weeks in `keep` are kept."""
    os.environ["OMP_NUM_THREADS"] = str(THREADS)
    from scripts.forecast_rolling_backtest import load_inputs
    load_inputs(refresh=refresh_inputs)  # warm the cache once before the workers read it
    with ProcessPoolExecutor(min(WORKERS, len(weeks))) as ex:
        parts = list(ex.map(_fold, weeks))
    if OUT.exists():
        old = pd.read_pickle(OUT)
        parts.append(old[old["week"].isin(set(keep) - set(weeks))])
    df = pd.concat(parts, ignore_index=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_pickle(OUT)
    print(f"saved {len(df)} rows -> {OUT}")
    report(df)
    return df


def recent_weeks(newest: pd.Timestamp, n: int = 3) -> tuple[str, ...]:
    """The n latest Monday-start weeks whose 48 h of truth after the week
    has already been observed."""
    last_end = (newest - pd.Timedelta(hours=48)).normalize()
    last_start = last_end - pd.Timedelta(days=7)
    last_start -= pd.Timedelta(days=last_start.dayofweek)
    return tuple(str((last_start - pd.Timedelta(weeks=k)).date()) for k in reversed(range(n)))


def refresh():
    """Monthly: rescore the latest complete weeks on fresh data, keep the
    saved winter weeks (both seasons stay judged), and re-gate by the same
    rule. During a data outage the recent weeks score too little: the
    current gate is then left as it is."""
    from scripts.forecast_rolling_backtest import load_inputs
    data = load_inputs(refresh=True)
    newest = pd.Timestamp(max(r["ts"] for r in data["readings"]))
    weeks = recent_weeks(newest)
    print(f"refresh: newest reading {newest}; scoring {weeks}; keeping {WINTER_WEEKS}")
    df = run(weeks, keep=WINTER_WEEKS)
    n_recent = int(df["week"].isin(weeks).sum())
    if n_recent < MIN_RECENT_ROWS:
        print(f"refresh: only {n_recent} rows for the recent weeks; gate left unchanged")
        return
    write_gate()


def _boot(d: pd.DataFrame, a: str, b: str, rng, n=2000) -> tuple[float, float, float]:
    """% MAE improvement of a over b, 95% CI by resampling whole days."""
    d = d.assign(day=d["origin"].dt.floor("D"), ea=(d[a] - d["actual"]).abs(), eb=(d[b] - d["actual"]).abs())
    g = d.groupby("day")[["ea", "eb"]].sum()
    est = 100 * (1 - g["ea"].sum() / g["eb"].sum())
    idx = rng.integers(0, len(g), size=(n, len(g)))
    ea, eb = g["ea"].to_numpy()[idx].sum(1), g["eb"].to_numpy()[idx].sum(1)
    lo, hi = np.percentile(100 * (1 - ea / eb), [2.5, 97.5])
    return est, lo, hi


def report(df: pd.DataFrame | None = None):
    from app import forecast_aqi as FA
    df = pd.read_pickle(OUT) if df is None else df
    df = df.dropna(subset=["fc", "persist", "actual"])
    df["season"] = np.where(df["origin"].dt.month.isin([11, 12, 1, 2]), "winter", "rest")
    cat = lambda s: s.map(FA.category)  # noqa: E731
    rng = np.random.default_rng(0)
    for season in ("winter", "rest"):
        print(f"\n== {season}: {df[df.season == season]['week'].nunique()} weeks, "
              f"{df[df.season == season]['ward'].nunique()} wards")
        print("  lead   n     MAE fc / persist / rule   gain vs persist [95% CI]   gain vs rule [95% CI]   "
              "category fc / persist   range covers   bias")
        for h in LEADS:
            d = df[(df.season == season) & (df.h == h)].dropna(subset=["rule_fill"])
            if d.empty:
                continue
            m = {k: (d[k] - d["actual"]).abs().mean() for k in ("fc", "persist", "rule_fill")}
            gp, gpl, gph = _boot(d, "fc", "persist", rng)
            gr, grl, grh = _boot(d, "fc", "rule_fill", rng)
            ca, cp = (cat(d["fc"]) == cat(d["actual"])).mean(), (cat(d["persist"]) == cat(d["actual"])).mean()
            cov = ((d["low"] <= d["actual"]) & (d["actual"] <= d["high"])).mean()
            print(f"  {h:>3}h {len(d):>5}   {m['fc']:5.1f} / {m['persist']:5.1f} / {m['rule_fill']:5.1f}   "
                  f"{gp:+5.1f}% [{gpl:+.1f}, {gph:+.1f}]        {gr:+5.1f}% [{grl:+.1f}, {grh:+.1f}]     "
                  f"{ca:.0%} / {cp:.0%}            {cov:.0%}        {(d['fc'] - d['actual']).mean():+.1f}")
        d = df[(df.season == season) & (df.h == 24)]
        if not d.empty:
            agree = (d["fc_dom"] == d["actual_dom"]).mean()
            print(f"  +24h: forecast names the pollutant setting the AQI correctly {agree:.0%} of the time")


def _covers(d: pd.DataFrame, s: float) -> float:
    a = d["fc"].clip(lower=1)
    lo = a * (d["low"].clip(lower=1) / a).clip(upper=1) ** s
    hi = a * (d["high"].clip(lower=1) / a).clip(lower=1) ** s
    return float(((lo <= d["actual"]) & (d["actual"] <= hi.clip(upper=500))).mean())


def write_gate():
    import json
    from datetime import datetime, timezone
    from app import forecast_aqi as FA
    df = pd.read_pickle(OUT).dropna(subset=["fc", "persist", "actual"])
    df["season"] = np.where(df["origin"].dt.month.isin([11, 12, 1, 2]), "winter", "rest")
    rng = np.random.default_rng(1)
    max_lead, checks = 0, {}
    for h in LEADS:
        d = df[df.h == h]
        pooled = _boot(d, "fc", "persist", rng)
        by_season = {s: 100 * (1 - (g["fc"] - g["actual"]).abs().sum() / (g["persist"] - g["actual"]).abs().sum())
                     for s, g in d.groupby("season")}
        ok = all(v >= 0 for v in by_season.values()) and (h < 6 or pooled[1] > 0)
        checks[h] = {"gain_vs_persistence_pct": round(pooled[0], 1), "ci95": [round(pooled[1], 1), round(pooled[2], 1)],
                     "gain_by_season_pct": {k: round(v, 1) for k, v in by_season.items()},
                     "mae": round(float((d["fc"] - d["actual"]).abs().mean()), 1), "passes": bool(ok)}
        if not ok:
            break
        max_lead = h
    pub = df[df.h <= max_lead]
    scale = next((s for s in np.arange(1.0, 3.01, 0.05) if _covers(pub, s) >= 0.80), 3.0) if max_lead else 1.0
    gate = {"generated_at": datetime.now(timezone.utc).isoformat(), "weeks": sorted(df["week"].unique().tolist()),
            "max_lead": max_lead,
            "band_scale": round(float(scale), 2),
            "coverage_after_scale": {s: round(_covers(g, scale), 3) for s, g in pub.groupby("season")} if max_lead else {},
            "leads": checks}
    FA.GATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    FA.GATE_FILE.write_text(json.dumps(gate, indent=1))
    print(json.dumps(gate, indent=1))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "report"
    if cmd == "run":
        run(tuple(sys.argv[2:]) or WEEKS)
    elif cmd == "refresh":
        refresh()
    elif cmd == "gate":
        report()
        write_gate()
    else:
        report()
