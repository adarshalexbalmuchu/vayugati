"""Stage 2b: decomposed hourly model — level x modulation.

Stage 2 showed a single gradient-boosted model overfits ward IDENTITY: with
~38 training wards the static source features act as ward fingerprints, the
trees memorise per-ward levels, and those levels do not transfer to an
unseen ward (held-out R2 went NEGATIVE).

The fix separates the two things being learned:

    C(w,t) = L(w)       x   M(t | w)
             level          modulation
             from source    from weather + time, trained on each ward's
             geometry       ratio to ITS OWN mean, so no model ever sees a
                            ward's absolute level and cannot memorise it

L(w) is fitted leave-one-ward-out as a 1-D log-linear map from a single
road-load feature (stage 1 showed the richer version does not generalise
at n=39). M is a gradient-boosted model on weather/time only.
"""

from __future__ import annotations

import statistics
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.species.features import build, static_features  # noqa: E402
from scripts.species.temporal import _ist_hour_dow, network_mean  # noqa: E402

MET_NAMES = ["wind_speed", "pblh", "vc", "temp", "rh", "precip", "hour_sin", "hour_cos", "weekend"]


def _met(m, hk):
    h, dow = _ist_hour_dow(hk)
    def f(k):
        v = m.get(k)
        return float(v) if v is not None else np.nan
    return [f("wind_speed"), f("boundary_layer_height"), f("ventilation_coefficient"),
            f("temp_c"), f("humidity"), float(m.get("precipitation") or 0),
            np.sin(2 * np.pi * h / 24), np.cos(2 * np.pi * h / 24), 1.0 if dow >= 5 else 0.0]


def run(species="no2", hours=24 * 120, receptor_pos=None, level_feature="kernel", verbose=True):
    import lightgbm as lgb
    from scipy.stats import spearmanr

    d = build(hours, species)
    pos = receptor_pos or d["pos"]
    wids, names, X = static_features({w: pos[w] for w in d["pos"] if w in pos})
    c = {n: i for i, n in enumerate(names)}
    if level_feature == "kernel":      # today's hand-set weighting
        load = 3 * X[:, c["road_major_s1.0"]] + 2 * X[:, c["road_mid_s1.0"]] + X[:, c["road_minor_s1.0"]]
    else:                              # stage-1 learned: sigma 2km, major 0, minor 0.5
        load = X[:, c["road_mid_s2.0"]] + 0.5 * X[:, c["road_minor_s2.0"]]
    ward_load = {w: np.log1p(load[i]) for i, w in enumerate(wids)}

    rows = []
    for (w, hk), v in d["obs"].items():
        m = d["met"].get((w, hk))
        if w in ward_load and m and m.get("wind_speed") is not None and v > 0:
            rows.append((w, hk, v, _met(m, hk)))
    wmean = defaultdict(list)
    for w, hk, v, _ in rows:
        wmean[w].append(v)
    wmean = {w: statistics.fmean(v) for w, v in wmean.items()}
    wards = sorted(w for w in wmean if len(d and [1]) and sum(1 for r in rows if r[0] == w) >= 200)

    params = dict(objective="regression", learning_rate=0.05, num_leaves=15, min_data_in_leaf=200,
                  feature_fraction=0.9, bagging_fraction=0.8, bagging_freq=1, lambda_l2=5.0,
                  verbose=-1, seed=42)
    res = defaultdict(list)
    for held in wards:
        tr_w = [w for w in wards if w != held]
        # ---- level: 1-D log-linear on training wards only ----
        a = np.array([ward_load[w] for w in tr_w]); b = np.log([wmean[w] for w in tr_w])
        slope, icpt = np.polyfit(a, b, 1)
        L = float(np.exp(icpt + slope * ward_load[held]))
        # ---- modulation: weather/time -> log(v / own ward mean), training wards only ----
        trX, trY = [], []
        for w, hk, v, met in rows:
            if w != held and w in wmean:
                trX.append(met); trY.append(np.log(v / wmean[w]))
        mod = lgb.train(params, lgb.Dataset(np.array(trX), np.array(trY)), num_boost_round=300)
        # correct the lognormal back-transform bias so exp(mean log ratio) is not biased low
        bias = float(np.mean(np.exp(np.array(trY) - mod.predict(np.array(trX)))))
        tot, cnt = network_mean(rows_as_net(rows), held)
        # ---- D4: modulation on weather + the network anomaly ----
        # Each training row gets the network mean WITHOUT itself (and without
        # the held-out ward, which network_mean already dropped), so no row
        # sees its own value in its features.
        nbar = np.mean([tot[h] / cnt[h] for h in tot if cnt[h] >= 3])
        tr4X, tr4Y = [], []
        for w, hk, v, met in rows:
            if w == held or cnt.get(hk, 0) < 4:
                continue
            nm_ex = (tot[hk] - v) / (cnt[hk] - 1)
            if nm_ex <= 0:
                continue
            tr4X.append(met + [np.log(nm_ex / nbar)]); tr4Y.append(np.log(v / wmean[w]))
        mod4 = lgb.train(params, lgb.Dataset(np.array(tr4X), np.array(tr4Y)), num_boost_round=300)
        bias4 = float(np.mean(np.exp(np.array(tr4Y) - mod4.predict(np.array(tr4X)))))
        te = [(hk, v, met) for w, hk, v, met in rows if w == held and cnt.get(hk, 0) >= 3]
        if len(te) < 50:
            continue
        M = np.exp(mod.predict(np.array([m for _, _, m in te]))) * bias
        M4 = np.exp(mod4.predict(np.array([m + [np.log(max(tot[hk] / cnt[hk], 1e-6) / nbar)]
                                            for hk, _, m in te]))) * bias4
        for (hk, v, _), mm, m4 in zip(te, M, M4):
            nm = tot[hk] / cnt[hk]
            res["y"].append(v); res["ward"].append(held)
            res["B1 network mean"].append(nm)
            res["D1 level only"].append(L)
            res["D2 level x weather"].append(L * mm)
            # hybrid: network carries the regional swing, level carries the ward offset
            net_ratio = L / np.exp(np.mean(np.log([wmean[w] for w in tr_w])))
            res["D3 network x level-ratio"].append(nm * net_ratio)
            res["D4 level x (weather+network)"].append(L * m4)

    y = np.array(res["y"]); W = np.array(res["ward"])
    out = {}
    for tag in ("B1 network mean", "D1 level only", "D2 level x weather", "D3 network x level-ratio",
                "D4 level x (weather+network)"):
        p = np.array(res[tag])
        r2 = 1 - np.sum((y - p) ** 2) / np.sum((y - y.mean()) ** 2)
        within = [spearmanr(p[W == w], y[W == w])[0] for w in np.unique(W)]
        within = [x for x in within if x == x]
        wm_o = [y[W == w].mean() for w in np.unique(W)]; wm_p = [p[W == w].mean() for w in np.unique(W)]
        o = dict(r2=r2, rmse=float(np.sqrt(np.mean((y - p) ** 2))),
                 within=float(np.median(within)) if within else float("nan"),
                 within_pos=float(np.mean([x > 0 for x in within])) if within else float("nan"),
                 spatial=float(spearmanr(wm_p, wm_o)[0]))
        out[tag] = o
        if verbose:
            print("  %-26s R2 %+.3f  RMSE %5.1f  within-ward %+.3f (%3.0f%% pos)  ward-mean rank %+.3f"
                  % (tag, o["r2"], o["rmse"], o["within"], 100 * o["within_pos"] if o["within_pos"] == o["within_pos"] else 0, o["spatial"]))
    if verbose:
        print("  (%d held-out ward-hours, %d wards)" % (len(y), len(np.unique(W))))
    return out


def rows_as_net(rows):
    """Adapter: network_mean expects (w, hk, v, static, met)."""
    return [(w, hk, v, None, met) for w, hk, v, met in rows]
