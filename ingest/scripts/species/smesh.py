"""S-MESH-style hybrid for India: ML downscaling of CAMS with monitors,
satellite, weather and land use (after S-MESH, Europe 2024), evaluated with
whole cities held out.

Target: a monitor's DAILY mean (IST day, >= 18 valid hours), log scale.
Predictors per (site, day):
  CAMS      the species and all others (PM2.5, PM10, NO2, O3, SO2, CO, dust,
            AOD) at the site's 0.4 deg cell: transport, secondary aerosol,
            dust, smoke and chemistry
  weather   ERA5 daily PBLH, wind, humidity, temperature, rain
  satellite MAIAC AOD that day (PM) / TROPOMI NO2 that month (NO2)
  land use  roads, population, built-up, satellite-NO2 climatology
  network   same-day mean of monitors within NET_KM, never from the
            held-out city (this is what live monitors offer at run time)
  time      day of year, weekday
Model: one LightGBM pooled over sites and days.

Compared on the SAME folds with: raw CAMS; CAMS with a linear bias
correction; the nearby-monitor mean; and the current ward model (network x
land-use ratio + IDW). Reports daily R2 / MAE, the site-mean rank, and
honest 90% ranges from out-of-fold errors in other folds.

    python scripts/species/smesh.py pm25|no2
"""

from __future__ import annotations

import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.species import cams as CAMS  # noqa: E402
from scripts.species import raster_features as RF  # noqa: E402
from scripts.species import sites as S  # noqa: E402
from scripts.species import site_model as SM  # noqa: E402
from scripts.species.features import static_features  # noqa: E402

NET_KM, MIN_NET, GROUP_KM, FOLDS = 150.0, 3, 15.0, 10
CAMS_KEY = {"pm25": "pm2_5", "pm10": "pm10", "no2": "nitrogen_dioxide", "o3": "ozone",
            "so2": "sulphur_dioxide", "co": "carbon_monoxide"}


def daily_table(species: str):
    d = S.load(species, region="igp", log=lambda *a: None)
    good = SM.qc(d, lambda *a: None)
    sites = sorted((s for s in d["sites"] if s["site"] in good), key=lambda s: s["site"])
    sid = [s["site"] for s in sites]
    pos = {s["site"]: (s["lat"], s["lng"]) for s in sites}
    ist = lambda h: datetime.utcfromtimestamp(h * 3600) + timedelta(hours=5, minutes=30)
    # daily means of the monitor
    acc = defaultdict(list)
    for s in sid:
        for h, v in good[s].items():
            acc[(s, ist(h).date())].append(v)
    day = {k: float(np.mean(v)) for k, v in acc.items() if len(v) >= 18}
    # daily weather means
    wacc = defaultdict(lambda: defaultdict(list))
    for (s, hk), m in d["met"].items():
        if s not in pos or not m:
            continue
        dd = (datetime.strptime(hk, "%Y-%m-%dT%H") + timedelta(hours=5, minutes=30)).date()
        for k in ("boundary_layer_height", "wind_speed", "humidity", "temp_c", "precipitation"):
            if m.get(k) is not None:
                wacc[(s, dd)][k].append(m[k])
    wx = {k: {v: float(np.mean(x)) for v, x in vv.items()} for k, vv in wacc.items()}
    # daily CAMS means at each site's cell
    cams_pts = CAMS.at_points([pos[s] for s in sid], log=lambda *a: None)
    cacc = defaultdict(lambda: defaultdict(list))
    for i, s in enumerate(sid):
        for hk, vals in cams_pts[i].items():
            dd = (datetime.strptime(hk, "%Y-%m-%dT%H") + timedelta(hours=5, minutes=30)).date()
            for v, x in vals.items():
                if x is not None:
                    cacc[(s, dd)][v].append(x)
    cm = {k: {v: float(np.mean(x)) for v, x in vv.items()} for k, vv in cacc.items()}
    return d, good, sites, sid, pos, day, wx, cm


def run(species: str, log=print):
    import lightgbm as lgb
    from scipy.stats import spearmanr
    from sklearn.linear_model import RidgeCV
    from sklearn.preprocessing import StandardScaler

    d, good, sites, sid, pos, day, wx, cm = daily_table(species)
    n = len(sid)
    col = {s: i for i, s in enumerate(sid)}
    # static land use
    _, fn, X = static_features(pos, bbox=SM._feature_bbox(sites))
    fi = {k: i for i, k in enumerate(fn)}
    first = min(min(good[s]) for s in sid); last = max(max(good[s]) for s in sid)
    months = sorted({datetime.utcfromtimestamp(h * 3600).strftime("%Y%m") for h in range(first, last + 1, 24 * 15)})
    rn, RX = RF.features([pos[s] for s in sid], months, f"{species}_igp_{n}")
    ri = {k: i for i, k in enumerate(rn)}
    sat_clim = np.log(np.clip(RX[:, ri["trop_no2"]], 1, None))
    static = np.column_stack([np.log1p(X[:, fi["road_major_s4.0"]]), np.log1p(X[:, fi["road_mid_s2.0"]]),
                              np.log1p(X[:, fi["industrial_s3.0"]]), np.log1p(X[:, fi["construction_s1.5"]]),
                              sat_clim, np.log1p(RX[:, ri["pop_s1.0"]]), np.log1p(RX[:, ri["pop_s4.0"]]),
                              np.nan_to_num(RX[:, ri["built_s0.5"]])])
    static_names = ["road_major", "road_mid", "industry", "construction", "sat_no2_clim", "pop1", "pop4", "built"]
    # MAIAC daily AOD at sites (PM) — nearest sampled point within 1 km
    maiac = {}
    if species in ("pm25", "pm10"):
        import pickle
        st = pickle.loads((RF.RASTERS / "maiac_points.pkl").read_bytes())
        src = np.array(st["points"])
        near = {}
        for s in sid:
            la, lo = pos[s]
            dd = np.hypot((src[:, 0] - la) * 110.574, (src[:, 1] - lo) * 111.32 * np.cos(np.radians(la)))
            j = int(np.argmin(dd))
            if dd[j] <= 1.0:
                near[j] = s
        for (j, dstr), v in st["aod"].items():
            if j in near:
                maiac[(near[j], datetime.fromisoformat(dstr).date())] = v

    keys = sorted(day)
    days = sorted({k[1] for k in keys})
    didx = {dd: i for i, dd in enumerate(days)}
    Y = np.full((n, len(days)), np.nan)
    for (s, dd), v in day.items():
        Y[col[s], didx[dd]] = v
    OBS = np.isfinite(Y).astype(float); Y0 = np.nan_to_num(Y)
    D = np.array([[S._km(pos[a], pos[b]) for b in sid] for a in sid])
    ADJ = (D <= NET_KM).astype(float); np.fill_diagonal(ADJ, 0)
    G = SM.groups(sites, GROUP_KM)
    rng = np.random.default_rng(0)
    order = rng.permutation(len(G))
    folds = [sum((G[k] for k in order[f::FOLDS]), []) for f in range(FOLDS)]
    fold_of = {s: f for f, grp in enumerate(folds) for s in grp}

    ck = CAMS_KEY[species]
    cvars = list(CAMS.VARS)
    rows = []
    for (s, dd), v in day.items():
        c = cm.get((s, dd), {})
        w = wx.get((s, dd), {})
        rows.append(dict(site=s, day=dd, y=v, **{f"cams_{k}": c.get(k, np.nan) for k in cvars},
                         **{f"wx_{k}": w.get(k, np.nan) for k in ("boundary_layer_height", "wind_speed", "humidity", "temp_c", "precipitation")},
                         maiac=maiac.get((s, dd), np.nan), doy_sin=np.sin(2 * np.pi * dd.timetuple().tm_yday / 365),
                         doy_cos=np.cos(2 * np.pi * dd.timetuple().tm_yday / 365), wkd=float(dd.weekday() >= 5)))
    df = pd.DataFrame(rows)
    for j, nm in enumerate(static_names):
        df[nm] = static[[col[s] for s in df["site"]], j]
    df["fold"] = [fold_of[s] for s in df["site"]]
    df = df[np.isfinite(df[f"cams_{ck}"])].reset_index(drop=True)
    log(f"{species}: {n} sites, {len(days)} days, {len(df)} site-days, {len(G)} city groups -> {FOLDS} folds")

    preds = defaultdict(lambda: np.full(len(df), np.nan))
    feat = [c for c in df.columns if c.startswith(("cams_", "wx_")) or c in ("maiac", "doy_sin", "doy_cos", "wkd")] \
        + static_names + ["net", "net_log_ratio_cams"]
    for f, grp in enumerate(folds):
        te_sites = [col[s] for s in grp]
        A = ADJ.copy(); A[:, te_sites] = 0
        NUM, CNT = A @ Y0, A @ OBS
        with np.errstate(invalid="ignore", divide="ignore"):
            NET = np.where(CNT >= MIN_NET, NUM / CNT, np.nan)
        df["net"] = NET[[col[s] for s in df["site"]], [didx[x] for x in df["day"]]]
        # training rows: their own network excludes themselves too
        own = Y0[[col[s] for s in df["site"]], [didx[x] for x in df["day"]]]
        cnt_own = CNT[[col[s] for s in df["site"]], [didx[x] for x in df["day"]]]
        df["net_log_ratio_cams"] = np.log1p(df["net"]) - np.log1p(df[f"cams_{ck}"])
        tr = (df["fold"] != f) & np.isfinite(df["net"]); te = (df["fold"] == f)
        m = lgb.LGBMRegressor(objective="l2", learning_rate=0.05, num_leaves=31, min_child_samples=100,
                              n_estimators=500, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1,
                              verbose=-1, random_state=0)
        m.fit(df.loc[tr, feat], np.log1p(df.loc[tr, "y"]))
        # Duan smearing: exp(E[log]) underestimates E[y]; rescale by the mean
        # training back-transform ratio (fold-internal, no test data used).
        sm1 = float(np.mean(np.expm1(np.log1p(df.loc[tr, "y"])) ) / np.mean(np.expm1(m.predict(df.loc[tr, feat]))))
        preds["S-MESH-IN (CAMS+sat+wx+landuse+network)"][te.to_numpy()] = np.expm1(m.predict(df.loc[te, feat])) * sm1
        # same model without the live network (pure downscaling: works with NO monitors at all)
        feat_nn = [c for c in feat if c not in ("net", "net_log_ratio_cams")]
        m2 = lgb.LGBMRegressor(objective="l2", learning_rate=0.05, num_leaves=31, min_child_samples=100,
                               n_estimators=500, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1,
                               verbose=-1, random_state=0)
        m2.fit(df.loc[tr, feat_nn], np.log1p(df.loc[tr, "y"]))
        sm2 = float(np.mean(df.loc[tr, "y"]) / np.mean(np.expm1(m2.predict(df.loc[tr, feat_nn]))))
        preds["S-MESH-IN, no live monitors"][te.to_numpy()] = np.expm1(m2.predict(df.loc[te, feat_nn])) * sm2
        # baselines
        preds["raw CAMS"][te.to_numpy()] = df.loc[te, f"cams_{ck}"]
        a, b = np.polyfit(np.log1p(df.loc[tr, f"cams_{ck}"]), np.log1p(df.loc[tr, "y"]), 1)
        sm3 = float(np.mean(df.loc[tr, "y"]) / np.mean(np.expm1(a * np.log1p(df.loc[tr, f"cams_{ck}"]) + b)))
        preds["CAMS, bias-corrected (linear)"][te.to_numpy()] = np.expm1(a * np.log1p(df.loc[te, f"cams_{ck}"]) + b) * sm3
        preds["nearby-monitor mean"][te.to_numpy()] = df.loc[te, "net"]
        # current ward model: net x exp(ridge(static) + IDW residual) on site log-ratios
        site_ratio = {}
        for s in sid:
            if fold_of[s] == f:
                continue
            r_ = df[(df["site"] == s) & np.isfinite(df["net"])]
            if len(r_) >= 60:
                site_ratio[s] = float(np.log(r_["y"].mean() / r_["net"].mean()))
        T = sorted(site_ratio); yT = np.array([site_ratio[s] for s in T])
        ZT = static[[col[s] for s in T]]
        sc = StandardScaler().fit(ZT); rg = RidgeCV(alphas=np.logspace(-2, 3, 30)).fit(sc.transform(ZT), yT)
        res_T = yT - rg.predict(sc.transform(ZT))
        for s in grp:
            w_ = np.array([1 / max(D[col[s], col[t]], 0.5) ** 2 for t in T])
            lr = float(rg.predict(sc.transform(static[[col[s]]]))[0] + (w_ @ res_T) / w_.sum())
            mk = (df["site"] == s).to_numpy()
            preds["current ward model (network x land-use ratio)"][mk] = df.loc[mk, "net"] * np.exp(lr)
        log(f"  fold {f + 1}/{FOLDS}")

    y = df["y"].to_numpy(); site = df["site"].to_numpy(); fold = df["fold"].to_numpy()
    log(f"\n{species.upper()} — DAILY means at held-out CITIES (mean {np.nanmean(y):.1f})")
    log(f"  {'method':48s} {'R2':>6s} {'MAE':>6s} {'bias':>6s} | site-rank rho | 90% range: inside, width")
    out = {}
    for k, p in preds.items():
        ok = np.isfinite(p) & np.isfinite(y)
        r2 = 1 - np.sum((y[ok] - p[ok]) ** 2) / np.sum((y[ok] - y[ok].mean()) ** 2)
        mae = float(np.mean(np.abs(y[ok] - p[ok]))); bias = float(np.mean(p[ok] - y[ok]))
        sm = pd.DataFrame({"s": site[ok], "y": y[ok], "p": p[ok]}).groupby("s").mean()
        rho = spearmanr(sm["p"], sm["y"])[0]
        e = np.abs(np.log1p(y[ok]) - np.log1p(np.clip(p[ok], 0, None))); fo = fold[ok]
        inside, widths = [], []
        for ff in np.unique(fo):
            q = np.quantile(e[fo != ff], 0.9)
            inside.append(np.mean(e[fo == ff] <= q)); widths.append(q)
        out[k] = dict(r2=r2, mae=mae, bias=bias, rho=rho, cover=float(np.mean(inside)), width=float(np.exp(np.mean(widths))))
        log(f"  {k:48s} {r2:+6.2f} {mae:6.1f} {bias:+6.1f} | {rho:+.2f} | {100*np.mean(inside):3.0f}%, x/{np.exp(np.mean(widths)):.2f}")
    return out


if __name__ == "__main__":
    import warnings
    warnings.filterwarnings("ignore")
    run(sys.argv[1] if len(sys.argv) > 1 else "pm25")
