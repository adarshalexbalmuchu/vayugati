"""Rolling-origin backtest of the global forecaster (app/forecast_global.py).

The live gate decides model-vs-simple-rule on ONE 14-day window, the same
window that reports the gain. This script asks whether those wins are real:

  folds   every FOLD_DAYS-day block after MIN_TRAIN_DAYS of history is a test
          fold; the model for it is trained only on the (at most
          TRAIN_CAP_DAYS) days before it, with the exact production
          features, target, parameters and baselines.
  A       per gate horizon: MAE of the model and each simple rule, pooled and
          per fold; how many folds the model beats the best rule; the
          improvement over the best rule with a 95% CI from resampling whole
          days (hours within a day and wards within an hour are not
          independent, days roughly are).
  B       the gating POLICY out of sample: for each fold, decide
          model-vs-rule (and which rule) from the PREVIOUS fold only, as the
          live refit does, and score what would have been served.
  C       bands: coverage of the model's q10-q90 (nominal 80%) and of the
          rule's band built two ways from the previous fold's errors,
          additive (live: value + fixed ug/m3 offsets) and multiplicative
          (value x/÷ ratio quantiles), split by concentration tercile.
  D       exceedances of the city's alert threshold: share of real crossings
          caught and share of predicted crossings that were false, model vs
          best rule.

Reads 130 days of readings_hourly (stuck-analyser values dropped, as live)
and weather once, caches them under data/backtests/, writes the results as
JSON next to them.

--write-gates also writes the live gates file (forecast_global.gates_file(),
read by every refit), from the last GATE_FOLDS folds only so it follows the
season: per gate horizon, serve the model only if its gain over the best
rule has a 95% CI above zero AND it won >= 2/3 of the folds; the rule to
serve otherwise; and the log-space factor that widens the model's q10-q90
to 80% coverage in the backtest. main.py runs this weekly.

    python scripts/forecast_rolling_backtest.py [--write-gates] [--refresh] [pollutant ...]
"""

from __future__ import annotations

import json
import pickle
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402
from app import forecast as F  # noqa: E402
from app import forecast_global as G  # noqa: E402

OUT_DIR = Path(__file__).resolve().parents[1] / "data" / "backtests"
HISTORY_DAYS = 730            # live forecaster: all history (local archive + database)
FOLD_DAYS = 7
MIN_TRAIN_DAYS = 28
TRAIN_CAP_DAYS = None         # live: all history (forecast.GLOBAL_TRAIN_DAYS)
MIN_IMPROVEMENT_PCT = 5.0     # live default
N_BOOT = 2000
GATE_FOLDS = 12               # ~3 months: the gate follows the season
WIN_SHARE = 2 / 3
MIN_CROSSINGS = 30           # exceedance skill needs at least this many real crossings


def load_inputs(refresh: bool = False):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    f = OUT_DIR / "inputs.pkl"
    if f.exists() and not refresh:
        return pickle.loads(f.read_bytes())
    readings = db.get_hourly_history(hours=24 * HISTORY_DAYS, include_archive=True)
    weather = F._long_weather(F._hourly_ward_weather(db.get_weather_history(hours=24 * HISTORY_DAYS)))
    city = db.get_active_cities("delhi")[0]
    thresholds = F._forecasting_config(city)["pollutant_thresholds"]
    data = {"readings": readings, "weather": weather, "thresholds": thresholds,
            "fetched_at": datetime.now(timezone.utc).isoformat()}
    f.write_bytes(pickle.dumps(data))
    return data


_JOB: dict = {}


def _init_job(Y, W, Fr, thresholds):
    _JOB.update(Y=Y, W=W, F=Fr, thresholds=thresholds)


def _fold_job(args):
    """Score one test fold: regression (p50, q10, q90) and exceedance
    classifiers, each trained only on data before the fold."""
    import warnings
    warnings.filterwarnings("ignore")
    k, T = args
    Y, W, Fr, thresholds = _JOB["Y"], _JOB["W"], _JOB["F"], _JOB["thresholds"]
    T = pd.Timestamp(T)
    T_end = T + pd.Timedelta(days=FOLD_DAYS)
    lo = Y.index.min() if TRAIN_CAP_DAYS is None else max(Y.index.min(), T - pd.Timedelta(days=TRAIN_CAP_DAYS))
    Yk = Y[(Y.index >= lo) & (Y.index < T_end)]   # lags inside the test week are real past values
    trainY = Yk[Yk.index < T]
    diurnal, level = trainY.groupby(trainY.index.hour).mean(), trainY.mean()
    Wk = {m: w.reindex(index=Yk.index, columns=Yk.columns) for m, w in W.items()}

    def train_mask(L, h, T=T):
        return L.index.get_level_values("origin") + pd.Timedelta(hours=h) < T

    def test_mask(L, h, T=T, T_end=T_end):
        o = L.index.get_level_values("origin")
        return (o >= T) & (o < T_end) & (o.hour % G.ORIGIN_STEP_H == 0)

    rows = []
    for h in G.GATE_HORIZONS:
        p50, cols = G._train_horizon(Yk, Wk, h, diurnal, level, train_mask, F=Fr)
        if p50 is None:
            continue
        q10, _ = G._train_horizon(Yk, Wk, h, diurnal, level, train_mask, "quantile", 0.10, 200, F=Fr)
        q90, _ = G._train_horizon(Yk, Wk, h, diurnal, level, train_mask, "quantile", 0.90, 200, F=Fr)
        V = G._stack(Yk, Wk, (h,), diurnal, level, test_mask, Fr)
        V = V[V["roll24"].notna()]
        if V.empty:
            continue
        X = G._rel(V)[cols]
        bp = G._baseline_preds(V)
        o = V.index.get_level_values("origin")
        extra = {}
        if thresholds:
            Lt = G._stack(Yk, Wk, (h,), diurnal, level, train_mask, Fr)
            Lt = Lt[Lt["roll24"].notna()]
            for name, thr in thresholds.items():
                clf, ccols = G._fit_classifier(Lt, thr)
                if clf is not None:
                    extra[f"p_{name}"] = clf.predict_proba(G._exceed_X(V)[ccols])[:, 1]
                    extra[f"base_{name}"] = float((Lt["target"] >= thr).mean())
        rows.append(pd.DataFrame({
            "fold": k, "h": h, "origin": o, "ward": V.index.get_level_values("ward"),
            "day": (o + pd.Timedelta(hours=h)).floor("D"),
            "y": V["target"].to_numpy(),
            "model": G._to_total(p50.predict(X), V), "q10": G._to_total(q10.predict(X), V),
            "q90": G._to_total(q90.predict(X), V), **bp, **extra}))
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()


def run_folds(Y: pd.DataFrame, W: dict, Fr=None, thresholds: dict | None = None, last_folds: int | None = None,
              workers: int = 6, log=print) -> pd.DataFrame:
    """One row per scored (fold, horizon, origin, ward). last_folds limits
    scoring to the most recent folds (the gates use only those)."""
    from concurrent.futures import ProcessPoolExecutor
    t0 = Y.index.min().normalize() + pd.Timedelta(days=MIN_TRAIN_DAYS)
    starts = list(pd.date_range(t0, Y.index.max() - pd.Timedelta(days=FOLD_DAYS - 1), freq=f"{FOLD_DAYS}D"))
    jobs = list(enumerate(starts))
    if last_folds:
        jobs = jobs[-last_folds:]
    with ProcessPoolExecutor(workers, initializer=_init_job, initargs=(Y, W, Fr, thresholds or {})) as ex:
        parts = list(ex.map(_fold_job, [(k, str(T)) for k, T in jobs]))
    log(f"   {len(jobs)} folds scored")
    df = pd.concat([p for p in parts if not p.empty], ignore_index=True)
    ok = np.isfinite(df["y"]) & np.all([np.isfinite(df[c]) for c in ("model", *G.BASELINES)], axis=0)
    return df[ok].reset_index(drop=True)


def blend_choice(d: pd.DataFrame, rng) -> dict:
    """Best (rule, weight on model) over these folds, kept only if its gain over
    the model alone has a 95% CI below zero error change (lab: PM2.5 12-24 h)."""
    best = ("persistence", 1.0, np.inf)
    for rule in G.BASELINES:
        for w in np.round(np.arange(0.5, 1.0, 0.1), 2):
            m = np.abs(w * d["model"] + (1 - w) * d[rule] - d["y"]).mean()
            if m < best[2]:
                best = (rule, float(w), m)
    rule, w, _ = best
    x = d.assign(blend=w * d["model"] + (1 - w) * d[rule])
    g = x.assign(em=(x["model"] - x["y"]).abs(), eb=(x["blend"] - x["y"]).abs()).groupby("day")[["em", "eb"]].sum()
    em, eb = g["em"].to_numpy(), g["eb"].to_numpy()
    idx = rng.integers(0, len(em), (N_BOOT, len(em)))
    hi = np.percentile(100 * (eb[idx].sum(1) / em[idx].sum(1) - 1), 97.5)
    return {"blend_rule": rule, "blend_w": w} if hi < 0 else {"blend_rule": None, "blend_w": 1.0}


def exceed_scores(d: pd.DataFrame, thresholds: dict) -> dict:
    """Brier skill score (vs each fold's training base rate) per threshold."""
    out = {}
    for name, thr in (thresholds or {}).items():
        col, base = f"p_{name}", f"base_{name}"
        if col not in d or d[col].isna().all():
            continue
        x = d[d[col].notna()]
        act = (x["y"] >= thr).astype(float)
        clim = float(np.mean((x[base] - act) ** 2))
        n = int(act.sum())
        # a skill score from a handful of crossings is noise: publish nothing below MIN_CROSSINGS
        bss = float(1 - np.mean((x[col] - act) ** 2) / clim) if clim > 0 and n >= MIN_CROSSINGS else None
        out[name] = {"threshold": thr, "bss": bss, "n_crossings": n}
    return out


def _boot_improvement(d: pd.DataFrame, base: str, rng) -> tuple[float, float, float]:
    """% MAE improvement of model over `base`, with a 95% day-block bootstrap CI."""
    g = d.assign(em=(d["model"] - d["y"]).abs(), eb=(d[base] - d["y"]).abs()).groupby("day")[["em", "eb"]].agg(["sum", "count"])
    em, eb, n = g[("em", "sum")].to_numpy(), g[("eb", "sum")].to_numpy(), g[("em", "count")].to_numpy()
    point = 100 * (1 - em.sum() / eb.sum())
    idx = rng.integers(0, len(em), (N_BOOT, len(em)))
    boots = 100 * (1 - em[idx].sum(1) / eb[idx].sum(1))
    lo, hi = np.percentile(boots, [2.5, 97.5])
    return float(point), float(lo), float(hi)


def band_scale(d: pd.DataFrame, target: float = 0.80) -> float:
    """Smallest log-space factor s (>= 1) for which [p x (q10/p)^s, p x (q90/p)^s]
    holds `target` of the outcomes (the live serve() applies the same s)."""
    p = d["model"].clip(lower=0.1).to_numpy()
    r_lo = np.minimum(np.log(d["q10"].clip(lower=0.1).to_numpy() / p), 0)
    r_hi = np.maximum(np.log(d["q90"].clip(lower=0.1).to_numpy() / p), 0)
    e = np.log(d["y"].clip(lower=0.1).to_numpy() / p)
    for s in np.arange(1.0, 5.001, 0.05):
        if np.mean((e >= s * r_lo) & (e <= s * r_hi)) >= target:
            return round(float(s), 2)
    return 5.0


def analyse(df: pd.DataFrame, threshold: float | None, log=print, thresholds: dict | None = None) -> dict:
    rng = np.random.default_rng(0)
    out = {}
    folds = sorted(df["fold"].unique())
    for h in G.GATE_HORIZONS:
        d = df[df["h"] == h]
        if d.empty:
            continue
        r = {"n": int(len(d)), "n_days": int(d["day"].nunique()), "n_folds": len(folds)}
        mae = {c: float((d[c] - d["y"]).abs().mean()) for c in ("model", *G.BASELINES)}
        best = min(G.BASELINES, key=lambda c: mae[c])
        pt, lo, hi = _boot_improvement(d, best, rng)
        per_fold = d.groupby("fold").apply(
            lambda x: pd.Series({c: (x[c] - x["y"]).abs().mean() for c in ("model", *G.BASELINES)}), include_groups=False)
        best_rule_fold = per_fold[list(G.BASELINES)].min(axis=1)
        wins = int((per_fold["model"] < best_rule_fold).sum())
        r |= {"mae": mae, "best_rule_pooled": best, "improvement_pct": pt, "ci95": [lo, hi],
              "folds_model_wins": wins,
              "folds_model_clears_gate": int((per_fold["model"] <= best_rule_fold * (1 - MIN_IMPROVEMENT_PCT / 100)).sum()),
              "serve_model": bool(lo > 0 and wins >= WIN_SHARE * len(per_fold)),
              "model_band_scale": band_scale(d)}
        r |= blend_choice(d, rng) if r["serve_model"] else {"blend_rule": None, "blend_w": 1.0}
        r["exceed"] = exceed_scores(d, thresholds)

        # B: live-style policy, decided on the previous fold only.
        served, rule_only, model_only = [], [], []
        decisions = []
        for a, b in zip(folds, folds[1:]):
            if a not in per_fold.index or b not in per_fold.index:
                continue
            pa = per_fold.loc[a]
            rule = min(G.BASELINES, key=lambda c: pa[c])
            use_model = pa["model"] <= pa[rule] * (1 - MIN_IMPROVEMENT_PCT / 100)
            x = d[d["fold"] == b]
            served.append((x["model" if use_model else rule] - x["y"]).abs().sum())
            rule_only.append((x[rule] - x["y"]).abs().sum())
            model_only.append((x["model"] - x["y"]).abs().sum())
            decisions.append("model" if use_model else rule)
        n_scored = d[d["fold"].isin(folds[1:])].shape[0]
        if n_scored:
            r["policy"] = {"served_mae": float(sum(served) / n_scored), "rule_of_prev_fold_mae": float(sum(rule_only) / n_scored),
                           "always_model_mae": float(sum(model_only) / n_scored), "decisions": decisions,
                           "switches": int(sum(1 for p, q in zip(decisions, decisions[1:]) if p != q))}

        # C: bands. Model q10-q90; rule bands from the previous fold's errors.
        inside_m = (d["y"] >= np.minimum(d["q10"], d["model"])) & (d["y"] <= np.maximum(d["q90"], d["model"]))
        terc = pd.qcut(d["y"], 3, labels=["low", "mid", "high"])
        add_in, mul_in, rows_b = [], [], []
        for a, b in zip(folds, folds[1:]):
            xa, xb = d[d["fold"] == a], d[d["fold"] == b]
            if xa.empty or xb.empty:
                continue
            rule = min(G.BASELINES, key=lambda c: (xa[c] - xa["y"]).abs().mean())
            res = xa["y"] - xa[rule]
            q_a = np.quantile(res, [0.10, 0.90])
            ratio = np.log((xa["y"].clip(lower=0.1)) / xa[rule].clip(lower=0.1))
            q_m = np.quantile(ratio, [0.10, 0.90])
            add_in.append((xb["y"] >= xb[rule] + q_a[0]) & (xb["y"] <= xb[rule] + q_a[1]))
            mul_in.append((xb["y"] >= xb[rule] * np.exp(q_m[0])) & (xb["y"] <= xb[rule] * np.exp(q_m[1])))
            rows_b.append(xb.index)
        bands = {"model_q10_q90": {"all": float(inside_m.mean()),
                                   **{t: float(inside_m[terc == t].mean()) for t in ("low", "mid", "high")}}}
        if rows_b:
            ib = np.concatenate([np.asarray(i) for i in rows_b])
            tb = terc.loc[ib].to_numpy()
            for name, arr in (("rule_additive_live", add_in), ("rule_multiplicative", mul_in)):
                v = np.concatenate([np.asarray(a) for a in arr])
                bands[name] = {"all": float(v.mean()), **{t: float(v[tb == t].mean()) for t in ("low", "mid", "high")}}
        r["bands_nominal_80"] = bands

        # D: exceedances.
        if threshold:
            act = d["y"] >= threshold
            ex = {"threshold": threshold, "actual_crossings": int(act.sum())}
            for c in ("model", best):
                pred = d[c] >= threshold
                ex[c] = {"caught": float((act & pred).sum() / act.sum()) if act.sum() else None,
                         "false_alarm": float((pred & ~act).sum() / pred.sum()) if pred.sum() else None,
                         "predicted_crossings": int(pred.sum())}
            r["exceedance"] = ex
        out[h] = r

        pol = r.get("policy", {})
        log(f"  {h:>2}h  model {mae['model']:6.2f} vs best rule {best:19s} {mae[best]:6.2f}  "
            f"gain {pt:+5.1f}% [{lo:+5.1f}, {hi:+5.1f}]  wins {r['folds_model_wins']}/{len(per_fold)} folds "
            f"(clears 5%: {r['folds_model_clears_gate']})  | policy served {pol.get('served_mae', float('nan')):6.2f} "
            f"vs prev-fold rule {pol.get('rule_of_prev_fold_mae', float('nan')):6.2f}, {pol.get('switches', 0)} switches"
            f"  => {'MODEL' if r['serve_model'] else 'rule ' + best}, band x{r['model_band_scale']}")
        b = r["bands_nominal_80"]
        log("       80% bands: model " + "/".join(f"{b['model_q10_q90'][t]:.0%}" for t in ("all", "low", "mid", "high"))
            + ("  | rule +/- (live) " + "/".join(f"{b['rule_additive_live'][t]:.0%}" for t in ("all", "low", "mid", "high"))
               + "  | rule x/÷ " + "/".join(f"{b['rule_multiplicative'][t]:.0%}" for t in ("all", "low", "mid", "high"))
               if "rule_additive_live" in b else "") + "   (all/low/mid/high conc.)")
        if "exceedance" in r:
            e = r["exceedance"]
            fmt = lambda v: "-" if v is None else f"{v:.0%}"  # noqa: E731
            log(f"       >= {e['threshold']}: {e['actual_crossings']} real crossings; model caught {fmt(e['model']['caught'])}, "
                f"false alarms {fmt(e['model']['false_alarm'])}; {best} caught {fmt(e[best]['caught'])}, "
                f"false alarms {fmt(e[best]['false_alarm'])}")
    return out


def write_gates(results: dict, period: tuple[str, str]) -> Path:
    """Atomically (re)write the live gates file, keeping other pollutants' entries
    (locked: pollutants may run in parallel processes)."""
    import fcntl

    f = G.gates_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    with open(f.with_suffix(".lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        return _write_gates_locked(f, results, period)


def _write_gates_locked(f: Path, results: dict, period: tuple[str, str]) -> Path:
    doc = {"pollutants": {}}
    if f.exists():
        try:
            doc = json.loads(f.read_text())
        except Exception:
            pass
    doc.update(generated_at=datetime.now(timezone.utc).isoformat(), gate_folds=GATE_FOLDS, fold_days=FOLD_DAYS,
               period=list(period), rule="serve the model if the 95% CI of its gain over the best rule is above 0 "
                                         "and it won >= 2/3 of folds")
    for p, res in results.items():
        doc["pollutants"][p] = {str(h): {k: r.get(k) for k in ("serve_model", "model_band_scale", "improvement_pct", "ci95",
                                                                "folds_model_wins", "n_folds", "mae", "blend_rule",
                                                                "blend_w", "exceed")}
                                          | {"best_rule": r["best_rule_pooled"]}
                                for h, r in res.items()}
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, indent=1))
    tmp.replace(f)
    return f


def main(pollutants, gates=False, refresh=False):
    import warnings
    warnings.filterwarnings("ignore")
    data = load_inputs(refresh=refresh)
    print(f"inputs fetched {data['fetched_at']}; thresholds {data['thresholds']}")
    results, period = {}, None
    for p in pollutants:
        rdf = F._hourly_ward_pollutant(data["readings"], p)
        if rdf.empty:
            continue
        Y = G._panel(rdf)
        W = G._weather(data["weather"], Y)
        print(f"\n{p}: {Y.shape[1]} wards, {Y.index.min():%Y-%m-%d} .. {Y.index.max():%Y-%m-%d}")
        thr = {k: v for k, v in {"alert": data["thresholds"].get(p), "severe": F.SEVERE_THRESHOLD.get(p)}.items() if v}
        Fr = None
        try:
            Fr = F._forecast_weather_frames(db.get_wards_with_city(), data["readings"])[0]
        except Exception:
            print("   forecast weather unavailable; scoring without it")
        df = run_folds(Y, W, Fr, thr, last_folds=GATE_FOLDS if gates else None, log=lambda *a: None)
        results[p] = analyse(df, data["thresholds"].get(p), thresholds=thr)
        period = (str(df["day"].min().date()), str(df["day"].max().date()))
        (OUT_DIR / f"rolling_{p}.json").write_text(json.dumps(results[p], indent=1, default=str))
    if gates and results:
        print(f"\nwrote {write_gates(results, period)}")
    return results


if __name__ == "__main__":
    args = sys.argv[1:]
    flags = {a for a in args if a.startswith("--")}
    main([a for a in args if not a.startswith("--")] or ["pm25", "pm10", "no2", "so2", "co", "o3"],
         gates="--write-gates" in flags, refresh="--refresh" in flags)
