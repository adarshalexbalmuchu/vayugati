"""Train + evaluate a per-species model on every NCR reference monitor.

    C(s,t) = N(t) x R(s) x G(met, t | s)
             network   level   modulation (optional)

N(t)  concurrent mean of all OTHER monitors. It carries the regional and
      meteorological swing every site shares; stage 2 showed no trained
      model beat it on timing.
R(s)  the site's ratio to that network mean, predicted from what is around
      it. The target is the RATIO, not the raw site mean: coverage differs
      by site (some report mostly in winter), and a raw mean would score a
      winter-heavy site as "dirty" for reasons that have nothing to do with
      its sources.
G     gradient-boosted residual on weather/time, trained on residuals after
      each training site's true ratio is removed, so it cannot memorise
      site levels (the failure mode of stage 2).

Evaluation is leave-one-GROUP-out: monitors within GROUP_KM of each other
are held out together, so a neighbour sharing the same roads cannot leak
the answer. Every level model is compared against two baselines it must
beat to be worth anything:
    road proxy : a single road-density number
    IDW        : interpolating the ratios of nearby monitors
"""

from __future__ import annotations

import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.species import sites as S  # noqa: E402
from scripts.species.features import SIGMAS_KM, static_features  # noqa: E402

MIN_NET = 5          # an hour's network mean needs >= 5 other monitors reporting
MIN_HOURS = 2000     # a site needs ~3 months of valid hours to have a stable ratio
FLATLINE_H = 6       # >= 6 identical consecutive hours = stuck analyser (common CPCB fault)
MAX_UGM3 = {"no2": 1000.0, "so2": 1000.0, "o3": 1000.0, "pm25": 2000.0, "pm10": 3000.0, "co": 50000.0}
WINTER = {11, 12, 1, 2}


def _h(hk: str) -> int:
    return int(datetime.strptime(hk, "%Y-%m-%dT%H").timestamp() // 3600)


def qc(d, log=print):
    """Range + flatline screening, then drop sites with too few hours."""
    ser = defaultdict(dict)
    for (s, hk), v in d["obs"].items():
        ser[s][_h(hk)] = v
    hi = MAX_UGM3[d["species"]]
    out, dropped = {}, defaultdict(int)
    for s, x in ser.items():
        hs = sorted(x)
        bad = set()
        run = [hs[0]] if hs else []
        for a, b in zip(hs, hs[1:]):
            if b == a + 1 and x[b] == x[a]:
                run.append(b)
            else:
                if len(run) >= FLATLINE_H:
                    bad.update(run)
                run = [b]
        if len(run) >= FLATLINE_H:
            bad.update(run)
        good = {h: v for h, v in x.items() if 0 < v <= hi and h not in bad}
        dropped["flatline"] += len(bad)
        dropped["range"] += sum(1 for h, v in x.items() if not (0 < v <= hi))
        if len(good) >= MIN_HOURS:
            out[s] = good
        else:
            dropped["short_site"] += 1
    log("QC: kept %d/%d sites; removed %d flatline hours, %d out-of-range; %d sites too short"
        % (len(out), len(ser), dropped["flatline"], dropped["range"], dropped["short_site"]))
    return out


def groups(sites, km):
    """Single-linkage clusters: monitors within `km` are held out together."""
    ids = [s["site"] for s in sites]
    pos = {s["site"]: (s["lat"], s["lng"]) for s in sites}
    parent = {i: i for i in ids}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i in ids:
        for j in ids:
            if i < j and S._km(pos[i], pos[j]) < km:
                parent[find(i)] = find(j)
    g = defaultdict(list)
    for i in ids:
        g[find(i)].append(i)
    return list(g.values())


def _met_row(m, h):
    t = datetime.utcfromtimestamp(h * 3600) + timedelta(hours=5, minutes=30)
    f = lambda k: float(m[k]) if m and m.get(k) is not None else np.nan
    ws, pbl = f("wind_speed"), f("boundary_layer_height")
    hr = t.hour + t.minute / 60
    return [ws, pbl, ws * pbl, f("temp_c"), f("humidity"), f("precipitation") if m else np.nan,
            np.sin(2 * np.pi * hr / 24), np.cos(2 * np.pi * hr / 24), 1.0 if t.weekday() >= 5 else 0.0,
            np.sin(2 * np.pi * t.month / 12), np.cos(2 * np.pi * t.month / 12)]


def run(species="no2", region=None, group_km=2.0, net_km=None, min_net=MIN_NET, n_folds=None,
        modulation=True, verbose=True, seed=0, raster=False):
    """group_km : monitors closer than this are held out together (2 = new site,
                  ~15 = a whole new city with all its monitors).
    net_km     : the network mean uses monitors within this radius (None = all).
    n_folds    : None = leave-one-group-out; k = groups split into k folds.
    """
    import lightgbm as lgb
    from scipy.stats import spearmanr
    from sklearn.linear_model import RidgeCV
    from sklearn.preprocessing import StandardScaler

    log = print if verbose else (lambda *a: None)
    d = S.load(species, region=region)
    good = qc(d, log)
    sites = sorted((s for s in d["sites"] if s["site"] in good), key=lambda s: s["site"])
    sid = [s["site"] for s in sites]
    n = len(sid)
    pos = {s["site"]: (s["lat"], s["lng"]) for s in sites}
    _, fnames, X = static_features(pos, bbox=_feature_bbox(sites))   # rows follow sorted(pos) == sid
    fi = {nm: i for i, nm in enumerate(fnames)}
    logX = np.log1p(X)
    if raster:
        from scripts.species import raster_features as RF
        first = min(min(good[s]) for s in sid); last = max(max(good[s]) for s in sid)
        months = sorted({datetime.utcfromtimestamp(h * 3600).strftime("%Y%m")
                         for h in range(first, last + 1, 24 * 15)})
        rnames, RX = RF.features([pos[s] for s in sid], months, f"{species}_{region or 'ncr'}_{n}")
        ri = {nm: i for i, nm in enumerate(rnames)}
        sat = np.log(np.clip(RX[:, ri["trop_no2"]], 1, None))
        if np.isnan(sat).any():
            sat = np.where(np.isnan(sat), np.nanmean(sat), sat)
        RZ = np.column_stack([sat, np.log1p(RX[:, ri["pop_s1.0"]]), np.log1p(RX[:, ri["pop_s4.0"]]),
                              np.nan_to_num(RX[:, ri["built_s0.5"]], nan=0.0)])

    hours = sorted({h for s in sid for h in good[s]})
    hidx = {h: i for i, h in enumerate(hours)}
    V = np.full((n, len(hours)), np.nan, dtype=np.float64)
    for i, s in enumerate(sid):
        for h, v in good[s].items():
            V[i, hidx[h]] = v
    hk = [datetime.utcfromtimestamp(h * 3600).strftime("%Y-%m-%dT%H") for h in hours]
    ist_month = np.array([(datetime.utcfromtimestamp(h * 3600) + timedelta(hours=5.5)).month for h in hours])
    MET = np.full((n, len(hours), 11), np.nan, dtype=np.float32)
    for i, s in enumerate(sid):
        for j in np.flatnonzero(~np.isnan(V[i])):
            MET[i, j] = _met_row(d["met"].get((s, hk[j])), hours[j])
    V0 = np.nan_to_num(V)
    OBS = (~np.isnan(V)).astype(np.float64)
    D = np.array([[S._km(pos[a], pos[b]) for b in sid] for a in sid])
    ADJ = np.ones((n, n)) if net_km is None else (D <= net_km).astype(float)
    np.fill_diagonal(ADJ, 0.0)

    G = groups(sites, group_km) if group_km > 0 else [[s] for s in sid]
    if n_folds:
        rng0 = np.random.default_rng(seed)
        order = rng0.permutation(len(G))
        folds = [sum((G[k] for k in order[f::n_folds]), []) for f in range(n_folds)]
    else:
        folds = G
    col = {s: i for i, s in enumerate(sid)}
    log("%d sites, %d groups at %s km -> %d folds; network %s; %d site-hours, %s -> %s"
        % (n, len(G), group_km, len(folds), "all monitors" if net_km is None else f"within {net_km} km",
           int(OBS.sum()), datetime.utcfromtimestamp(hours[0] * 3600).date(),
           datetime.utcfromtimestamp(hours[-1] * 3600).date()))

    def proxy(sig, wmaj, wmin):
        return np.log1p(wmaj * X[:, fi[f"road_major_s{sig}"]] + X[:, fi[f"road_mid_s{sig}"]]
                        + wmin * X[:, fi[f"road_minor_s{sig}"]])
    fixed_proxy = proxy(2.0, 0.0, 0.5)
    grid = [(sg, a, b) for sg in SIGMAS_KM for a in (0.0, 0.5, 1.0) for b in (0.0, 0.5, 1.0)]
    grid_x = {k: proxy(*k) for k in grid}

    res = defaultdict(list)
    site_res = defaultdict(dict)
    choices = []
    for fk, fold in enumerate(folds):
        te = np.array([col[s] for s in fold])
        A = ADJ.copy()
        A[:, te] = 0.0                                   # nobody's network may see the held-out sites
        NUM, CNT = A @ V0, A @ OBS
        with np.errstate(invalid="ignore", divide="ignore"):
            NM = np.where(CNT >= min_net, NUM / CNT, np.nan)
        tr = np.array([i for i in range(n) if i not in set(te)])
        ok = ~np.isnan(V) & ~np.isnan(NM)
        ratio = {}
        for i in tr:
            m = ok[i]
            if m.sum() >= 200:
                ratio[i] = float(V[i, m].mean() / NM[i, m].mean())
        T = np.array(sorted(ratio))
        y = np.log([ratio[i] for i in T])

        preds = {}
        a, b = np.polyfit(fixed_proxy[T], y, 1)
        preds["road proxy (fixed)"] = a * fixed_proxy + b
        best = None
        for k in grid:                                     # nested: inner leave-one-site-out
            xv = grid_x[k][T]
            e = 0.0
            for j in range(len(T)):
                m = np.arange(len(T)) != j
                aa, bb = np.polyfit(xv[m], y[m], 1)
                e += (aa * xv[j] + bb - y[j]) ** 2
            if best is None or e < best[0]:
                best = (e, k)
        choices.append(best[1])
        a, b = np.polyfit(grid_x[best[1]][T], y, 1)
        preds["road proxy (nested)"] = a * grid_x[best[1]] + b
        sc = StandardScaler().fit(logX[T])
        rg = RidgeCV(alphas=np.logspace(-2, 3, 30)).fit(sc.transform(logX[T]), y)
        preds["ridge (all features)"] = rg.predict(sc.transform(logX))

        def idw(vals):
            w = 1.0 / np.maximum(D[:, T], 0.5) ** 2
            return (w @ vals) / w.sum(axis=1)
        preds["IDW of neighbours"] = idw(y)
        preds["ridge + IDW residual"] = preds["ridge (all features)"] + idw(y - rg.predict(sc.transform(logX[T])))
        xp = grid_x[best[1]]
        preds["road proxy + IDW residual"] = preds["road proxy (nested)"] + idw(y - (a * xp[T] + b))
        # three physically distinct source terms, no more (n~60 cannot support 19)
        Z = np.column_stack([xp, logX[:, fi["industrial_s3.0"]], logX[:, fi["construction_s1.5"]]])
        sz = StandardScaler().fit(Z[T])
        r3 = RidgeCV(alphas=np.logspace(-2, 3, 30)).fit(sz.transform(Z[T]), y)
        preds["roads+industry+construction"] = r3.predict(sz.transform(Z))
        if raster:
            a1, b1 = np.polyfit(RZ[T, 0], y, 1)
            preds["satellite NO2 only"] = a1 * RZ[:, 0] + b1
            L = np.column_stack([xp, RZ])          # roads, satellite, pop 1km, pop 4km, built 0.5km
            sl = StandardScaler().fit(L[T])
            rl = RidgeCV(alphas=np.logspace(-2, 3, 30)).fit(sl.transform(L[T]), y)
            preds["LUR: roads+sat+pop+built"] = rl.predict(sl.transform(L))
            preds["LUR + IDW residual"] = preds["LUR: roads+sat+pop+built"] + idw(y - rl.predict(sl.transform(L[T])))

        if modulation:
            rows = [(i, np.flatnonzero(ok[i])) for i in T]
            nbar = float(np.nanmean(NM[T]))
            tS = np.concatenate([np.full(len(j), i) for i, j in rows])
            tJ = np.concatenate([j for _, j in rows])
            base = np.array([ratio[i] for i in tS]) * NM[tS, tJ]
            feats = np.column_stack([MET[tS, tJ], np.log(NM[tS, tJ] / nbar)])
            tgt = np.log(V[tS, tJ] / base)
            params = dict(objective="regression", learning_rate=0.05, num_leaves=31, min_data_in_leaf=500,
                          feature_fraction=0.9, bagging_fraction=0.7, bagging_freq=1, lambda_l2=5.0,
                          verbose=-1, seed=seed, num_threads=8)
            gm = lgb.train(params, lgb.Dataset(feats, tgt), num_boost_round=300)
            smear = float(np.mean(np.exp(tgt - gm.predict(feats))))
            f2 = np.column_stack([feats, logX[tS]])
            gm2 = lgb.train(params, lgb.Dataset(f2, tgt), num_boost_round=300)
            smear2 = float(np.mean(np.exp(tgt - gm2.predict(f2))))

        for i in te:
            m = ok[i]
            if m.sum() < 200:
                continue
            nm, v = NM[i, m], V[i, m]
            s = sid[i]
            site_res[s]["obs"] = float(np.log(v.mean() / nm.mean()))
            res["y"] += list(v); res["site"] += [s] * len(v); res["month"] += list(ist_month[m])
            res["B  network mean only"] += list(nm)
            for tag, p in preds.items():
                site_res[s][tag] = float(p[i])
                res["N x R: " + tag] += list(nm * np.exp(p[i]))
            if modulation:
                lvl = np.exp(preds["ridge + IDW residual"][i])
                f_te = np.column_stack([MET[i, m], np.log(nm / nbar)])
                res["N x R x G(weather)"] += list(nm * lvl * np.exp(gm.predict(f_te)) * smear)
                f2t = np.column_stack([f_te, np.repeat(logX[i][None], m.sum(), axis=0)])
                res["N x R x G(weather+sources)"] += list(nm * lvl * np.exp(gm2.predict(f2t)) * smear2)
        if verbose and (fk % 10 == 0 or fk == len(folds) - 1):
            log("  fold %d/%d" % (fk + 1, len(folds)))
    return _report(res, site_res, choices, len(G), seed, log)


def _feature_bbox(sites, margin_deg=0.15):
    """Sources are loaded for the sites' extent plus ~15 km so 4 km features aren't clipped."""
    lat = [s["lat"] for s in sites]; lng = [s["lng"] for s in sites]
    return (round(min(lng) - margin_deg, 2), round(min(lat) - margin_deg, 2),
            round(max(lng) + margin_deg, 2), round(max(lat) + margin_deg, 2))


def _report(res, site_res, choices, n_groups, seed, log):
    from collections import Counter

    from scipy.stats import spearmanr

    y = np.array(res["y"]); W = np.array(res["site"]); mo = np.array(res["month"])
    rng = np.random.default_rng(seed)
    scored = sorted(site_res)
    obs = np.array([site_res[s]["obs"] for s in scored])
    out = {"n_sites": len(scored), "n_groups": n_groups, "n_hours": len(y), "site": {}, "hourly": {}}
    log("\nSITE LEVEL: rank of each held-out monitor's ratio to its network (n=%d monitors)" % len(scored))
    for tag in [t for t in site_res[scored[0]] if t != "obs"]:
        p = np.array([site_res[s][tag] for s in scored])
        rho = spearmanr(p, obs)[0]
        boots = []
        for _ in range(2000):
            i = rng.integers(0, len(scored), len(scored))
            boots.append(spearmanr(p[i], obs[i])[0])
        lo, hi = np.nanpercentile(boots, [2.5, 97.5])
        r2 = 1 - np.sum((obs - p) ** 2) / np.sum((obs - obs.mean()) ** 2)
        out["site"][tag] = dict(rho=float(rho), lo=float(lo), hi=float(hi), r2=float(r2))
        log("  %-24s rho %+.3f  [95%% %+.2f, %+.2f]   R2(log ratio) %+.3f" % (tag, rho, lo, hi, r2))
    if choices:
        log("  nested proxy choice (sigma, w_major, w_minor): %s" % Counter(choices).most_common(3))
    log("\nHOURLY at held-out monitors (%d site-hours)" % len(y))
    wmask = np.isin(mo, list(WINTER))
    for tag in [t for t in res if t not in ("y", "site", "month")]:
        p = np.array(res[tag])
        def r2(mk): return 1 - np.sum((y[mk] - p[mk]) ** 2) / np.sum((y[mk] - y[mk].mean()) ** 2)
        within = np.array([x for x in (spearmanr(p[W == s], y[W == s])[0] for s in np.unique(W)) if x == x])
        o = dict(r2=float(r2(np.ones_like(y, bool))), r2_winter=float(r2(wmask)), r2_rest=float(r2(~wmask)),
                 rmse=float(np.sqrt(np.mean((y - p) ** 2))), within=float(np.median(within)),
                 within_pos=float(np.mean(within > 0)))
        out["hourly"][tag] = o
        log("  %-36s R2 %+.3f (winter %+.3f, rest %+.3f)  RMSE %5.1f  within-site rho %+.3f (%3.0f%% +)"
            % (tag, o["r2"], o["r2_winter"], o["r2_rest"], o["rmse"], o["within"], 100 * o["within_pos"]))
    return out


if __name__ == "__main__":
    import warnings
    warnings.filterwarnings("ignore")
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("species", nargs="?", default="no2")
    ap.add_argument("--region", default=None)
    ap.add_argument("--group-km", type=float, default=2.0)
    ap.add_argument("--net-km", type=float, default=None)
    ap.add_argument("--min-net", type=int, default=MIN_NET)
    ap.add_argument("--folds", type=int, default=None)
    ap.add_argument("--no-modulation", action="store_true")
    ap.add_argument("--raster", action="store_true", help="add satellite NO2 / population / built-up features")
    a = ap.parse_args()
    run(a.species, region=a.region, group_km=a.group_km, net_km=a.net_km, min_net=a.min_net,
        n_folds=a.folds, modulation=not a.no_modulation, raster=a.raster)
