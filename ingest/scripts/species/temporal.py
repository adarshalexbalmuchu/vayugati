"""Stage 2: hourly per-species model, leave-one-ward-out.

Tests whether a trained model can predict a ward's HOURLY concentration
without ever having seen that ward — the situation for every unmonitored
ward. Three tiers, deliberately separated so the value of each input is
visible rather than folded into one number:

  B1  concurrent network mean   mean of the other wards' readings that
                                hour. Needs live stations. The bar any
                                model must clear to be worth running when
                                the network is up.
  M1  physics + weather only    static source features + meteorology +
                                time-of-day. Needs NO live stations, so it
                                is the model that would have kept running
                                through the Sept 2026 CPCB outage.
  M2  hybrid                    M1 + the concurrent network mean.

Network means are always computed leaving out BOTH the row's own ward and
the held-out ward, so no fold ever sees the ward it is scored on.
"""

from __future__ import annotations

import datetime as dt
import statistics
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.species.features import build, static_features  # noqa: E402

STATIC_KEEP = ("road_major_s2.0", "road_mid_s2.0", "road_minor_s2.0",
               "road_mid_s4.0", "road_minor_s4.0", "industrial_s3.0",
               "construction_s1.5")


def _ist_hour_dow(hk: str) -> tuple[int, int]:
    t = dt.datetime.strptime(hk, "%Y-%m-%dT%H") + dt.timedelta(hours=5, minutes=30)
    return t.hour, t.weekday()


def assemble(species: str, hours: int, receptor_pos=None):
    d = build(hours, species)
    pos = receptor_pos or d["pos"]
    wids, names, X = static_features({w: pos[w] for w in d["pos"] if w in pos})
    sidx = [names.index(n) for n in STATIC_KEEP]
    static = {w: np.log1p(X[i, sidx]) for i, w in enumerate(wids)}

    rows = []
    for (w, hk), v in d["obs"].items():
        if w not in static:
            continue
        m = d["met"].get((w, hk))
        if not m or m.get("wind_speed") is None:
            continue
        h, dow = _ist_hour_dow(hk)
        met = [
            float(m.get("wind_speed") or 0),
            float(m.get("boundary_layer_height") or np.nan),
            float(m.get("ventilation_coefficient") or np.nan),
            float(m.get("temp_c") if m.get("temp_c") is not None else np.nan),
            float(m.get("humidity") if m.get("humidity") is not None else np.nan),
            float(m.get("precipitation") or 0),
            np.sin(2 * np.pi * h / 24), np.cos(2 * np.pi * h / 24),
            1.0 if dow >= 5 else 0.0,
        ]
        rows.append((w, hk, v, static[w], met))
    feat_names = list(STATIC_KEEP) + ["wind_speed", "pblh", "vc", "temp", "rh",
                                      "precip", "hour_sin", "hour_cos", "weekend"]
    return rows, feat_names


def network_mean(rows, exclude_ward: int):
    """Per hour: sum and count over all wards EXCEPT exclude_ward."""
    tot = defaultdict(float); cnt = defaultdict(int)
    for w, hk, v, _, _ in rows:
        if w == exclude_ward:
            continue
        tot[hk] += v; cnt[hk] += 1
    return tot, cnt


def run(species: str = "no2", hours: int = 24 * 120, receptor_pos=None, verbose=True):
    import lightgbm as lgb
    from scipy.stats import spearmanr

    rows, fnames = assemble(species, hours, receptor_pos)
    wards = sorted({r[0] for r in rows})
    obs_all, b1_all, m1_all, m2_all, ward_all = [], [], [], [], []

    params = dict(objective="regression", learning_rate=0.05, num_leaves=15,
                  min_data_in_leaf=50, feature_fraction=0.8, bagging_fraction=0.8,
                  bagging_freq=1, lambda_l2=1.0, verbose=-1, seed=42)

    for held in wards:
        tot, cnt = network_mean(rows, held)
        tr_X1, tr_X2, tr_y, te = [], [], [], []
        for w, hk, v, st, met in rows:
            if w == held:
                if cnt.get(hk, 0) >= 3:
                    te.append((hk, v, st, met, tot[hk] / cnt[hk]))
                continue
            c = cnt.get(hk, 0) - 1          # also leave the row's own ward out
            if c < 3:
                continue
            nm = (tot[hk] - v) / c
            f = list(st) + met
            tr_X1.append(f); tr_X2.append(f + [np.log1p(nm)]); tr_y.append(np.log1p(v))
        if len(te) < 50:
            continue
        m1 = lgb.train(params, lgb.Dataset(np.array(tr_X1), np.array(tr_y)), num_boost_round=300)
        m2 = lgb.train(params, lgb.Dataset(np.array(tr_X2), np.array(tr_y)), num_boost_round=300)
        TX1 = np.array([list(st) + met for _, _, st, met, _ in te])
        TX2 = np.array([list(st) + met + [np.log1p(nm)] for _, _, st, met, nm in te])
        obs_all += [v for _, v, _, _, _ in te]
        b1_all += [nm for *_, nm in te]
        m1_all += list(np.expm1(m1.predict(TX1)))
        m2_all += list(np.expm1(m2.predict(TX2)))
        ward_all += [held] * len(te)

    y = np.array(obs_all); W = np.array(ward_all)
    out = {}
    for tag, p in (("B1 network mean", b1_all), ("M1 physics+weather", m1_all), ("M2 hybrid", m2_all)):
        p = np.array(p)
        r2 = 1 - np.sum((y - p) ** 2) / np.sum((y - y.mean()) ** 2)
        within = [spearmanr(p[W == w], y[W == w])[0] for w in np.unique(W) if (W == w).sum() >= 50]
        within = [x for x in within if x == x]
        wm_o = [y[W == w].mean() for w in np.unique(W)]
        wm_p = [p[W == w].mean() for w in np.unique(W)]
        out[tag] = dict(r2=r2, rmse=float(np.sqrt(np.mean((y - p) ** 2))),
                        within=float(np.median(within)), within_pos=float(np.mean([x > 0 for x in within])),
                        spatial=float(spearmanr(wm_p, wm_o)[0]))
        if verbose:
            o = out[tag]
            print("  %-22s R2 %+.3f  RMSE %5.1f  within-ward rho %+.3f (%3.0f%% pos)  ward-mean rank %+.3f"
                  % (tag, o["r2"], o["rmse"], o["within"], 100 * o["within_pos"], o["spatial"]))
    if verbose:
        print("  (%d held-out ward-hours across %d wards)" % (len(y), len(np.unique(W))))
    return out
