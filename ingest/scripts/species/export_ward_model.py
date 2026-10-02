"""Export the validated ward-estimation models for the live service.

Model (chosen by whole-city and new-site holdouts, Sept 2026):
    C_w(24h) = N(24h) x R_w
N  = mean of the live network's 24h means (monitors within NET_KM)
R_w = exp(ridge(land use [+ power plants for PM2.5]) + IDW of monitored-site residuals)

Trained on every Indo-Gangetic-plain monitor (no holdout), then applied
to Delhi's 265 ward centres. The 90% range for a DAILY estimate comes from
2 km-group cross-validation of this exact pipeline (an unmonitored spot
inside a monitored city is the Delhi case). The factor k is the 90th
percentile of |log error| over out-of-fold site-days at monitors within
DELHI_KM of Delhi: the dense network there makes errors smaller than the
IGP-wide figure, which is kept in "validation" for reference, as is the
coverage of k by season.

Writes ingest/app/data/ward_level_ratios.json (small; committed), which
app/ward_estimates.py reads. Re-run to refresh.

    python scripts/species/export_ward_model.py
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app import db  # noqa: E402
from app.vayutrace_kernel import boundary_area_centroid  # noqa: E402
from scripts.species import context_features as CF  # noqa: E402
from scripts.species import raster_features as RF  # noqa: E402
from scripts.species import sites as S  # noqa: E402
from scripts.species import site_model as SM  # noqa: E402
from scripts.species.features import _kernel_sums, static_features  # noqa: E402

NET_KM, MIN_NET = 150.0, 3
DELHI_CENTRE, DELHI_KM = (28.61, 77.21), 40.0
SEASONS = {"winter_nov_feb": (11, 12, 1, 2), "premonsoon_mar_jun": (3, 4, 5, 6), "monsoon_jul_oct": (7, 8, 9, 10)}
OUT = Path(__file__).resolve().parents[2] / "app" / "data" / "ward_level_ratios.json"
SPECIES = {"no2": {"plants": False}, "pm25": {"plants": True}}


def design(points, sp_bbox, months, key, plants: bool):
    """Level-model features, identical for training sites and wards."""
    pos = {i: p for i, p in enumerate(points)}
    _, fn, X = static_features(pos, bbox=sp_bbox)
    fi = {k: i for i, k in enumerate(fn)}
    rn, RX = RF.features(points, months, key)
    ri = {k: i for i, k in enumerate(rn)}
    sat = np.log(np.clip(RX[:, ri["trop_no2"]], 1, None))
    cols = [np.log1p(X[:, fi["road_mid_s4.0"]]),            # nested choice: sigma 4 km, mid roads
            sat, np.log1p(RX[:, ri["pop_s1.0"]]), np.log1p(RX[:, ri["pop_s4.0"]]),
            np.nan_to_num(RX[:, ri["built_s0.5"]])]
    names = ["road_mid_s4", "sat_no2_column", "pop_1km", "pop_4km", "built_0.5km"]
    if plants:
        plat, plng, pcap = CF.plants()
        pp = _kernel_sums(np.array([p[0] for p in points]), np.array([p[1] for p in points]),
                          plat, plng, pcap[:, None], (10.0, 30.0, 100.0))[:, :, 0]
        cols += [np.log1p(pp[:, 0]), np.log1p(pp[:, 1]), np.log1p(pp[:, 2])]
        names += ["plants_10km", "plants_30km", "plants_100km"]
    Z = np.column_stack(cols)
    Z = np.where(np.isfinite(Z), Z, np.nanmedian(Z, axis=0))
    return Z, names


def fit_level(Z, y, D_tr):
    from sklearn.linear_model import RidgeCV
    from sklearn.preprocessing import StandardScaler
    sc = StandardScaler().fit(Z)
    rg = RidgeCV(alphas=np.logspace(-2, 3, 30)).fit(sc.transform(Z), y)
    return sc, rg, y - rg.predict(sc.transform(Z))


def predict_level(sc, rg, resid, Zq, Dq):
    w = 1.0 / np.maximum(Dq, 0.5) ** 2
    return rg.predict(sc.transform(Zq)) + (w @ resid) / w.sum(axis=1)


def run_species(species, wards_pts, log=print):
    d = S.load(species, region="igp", log=lambda *a: None)
    good = SM.qc(d, lambda *a: None)
    sites = sorted((s for s in d["sites"] if s["site"] in good), key=lambda s: s["site"])
    sid = [s["site"] for s in sites]; n = len(sid)
    pts = [(s["lat"], s["lng"]) for s in sites]
    bbox = SM._feature_bbox(sites)
    first = min(min(good[s]) for s in sid); last = max(max(good[s]) for s in sid)
    months = sorted({datetime.utcfromtimestamp(h * 3600).strftime("%Y%m") for h in range(first, last + 1, 24 * 15)})
    plants = SPECIES[species]["plants"]
    Z, names = design(pts, bbox, months, f"{species}_igp_{n}", plants)
    Zw, _ = design(wards_pts, bbox, months, f"{species}_delhi_wards_{len(wards_pts)}", plants)

    # hourly matrix -> network means excluding self (within NET_KM), daily aggregation (IST)
    hours = sorted({h for s in sid for h in good[s]}); hidx = {h: i for i, h in enumerate(hours)}
    V = np.full((n, len(hours)), np.nan)
    for i, s in enumerate(sid):
        for h, v in good[s].items():
            V[i, hidx[h]] = v
    D = np.array([[S._km(a, b) for b in pts] for a in pts])
    ADJ = (D <= NET_KM).astype(float); np.fill_diagonal(ADJ, 0)
    day = np.array([int((h * 3600 + 19800) // 86400) for h in hours])

    def network(A):
        V0, OBS = np.nan_to_num(V), np.isfinite(V).astype(float)
        num, cnt = A @ V0, A @ OBS
        with np.errstate(invalid="ignore", divide="ignore"):
            return np.where(cnt >= MIN_NET, num / cnt, np.nan)

    def ratios(NM, idx):
        y = np.full(len(idx), np.nan)
        for k, i in enumerate(idx):
            ok = np.isfinite(V[i]) & np.isfinite(NM[i])
            if ok.sum() >= 200:
                y[k] = np.log(V[i, ok].mean() / NM[i, ok].mean())
        return y

    def daily(i, NM):
        """(actual daily means, network daily means, IST day numbers) for site i, days with >= 18 h."""
        ok = np.isfinite(V[i]) & np.isfinite(NM[i])
        out_a, out_n, out_d = [], [], []
        for dd in np.unique(day[ok]):
            m = ok & (day == dd)
            if m.sum() >= 18:
                out_a.append(V[i, m].mean()); out_n.append(NM[i, m].mean()); out_d.append(dd)
        return np.array(out_a), np.array(out_n), np.array(out_d)

    # ---- honest daily range: 2 km-group CV of this exact pipeline ----
    G = SM.groups(sites, 2.0)
    rng = np.random.default_rng(0); order = rng.permutation(len(G))
    folds = [sum((G[k] for k in order[f::10]), []) for f in range(10)]
    col = {s: i for i, s in enumerate(sid)}
    near = np.array([S._km(p, DELHI_CENTRE) <= DELHI_KM for p in pts])
    errs, r2_y, r2_p, in_delhi, month = [], [], [], [], []
    for grp in folds:
        te = np.array([col[s] for s in grp]); A = ADJ.copy(); A[:, te] = 0
        NM = network(A)
        tr = np.array([i for i in range(n) if i not in set(te)])
        y = ratios(NM, tr); keep = np.isfinite(y); tr, y = tr[keep], y[keep]
        sc, rg, res = fit_level(Z[tr], y, D[np.ix_(tr, tr)])
        lr = predict_level(sc, rg, res, Z[te], D[np.ix_(te, tr)])
        for k, i in enumerate(te):
            a, nm, dd = daily(i, NM)
            if len(a):
                p = nm * np.exp(lr[k])
                errs += list(np.abs(np.log(a) - np.log(p))); r2_y += list(a); r2_p += list(p)
                in_delhi += [near[i]] * len(a); month += [datetime.utcfromtimestamp(int(x) * 86400).month for x in dd]
    errs = np.array(errs); ya = np.array(r2_y); pa = np.array(r2_p); dm = np.array(in_delhi); month = np.array(month)

    def r2_mae(m):
        return (float(1 - np.sum((ya[m] - pa[m]) ** 2) / np.sum((ya[m] - ya[m].mean()) ** 2)),
                float(np.mean(np.abs(ya[m] - pa[m]))), float(ya[m].mean()))
    k90_igp = float(np.exp(np.quantile(errs, 0.9)))
    k90 = float(np.exp(np.quantile(errs[dm], 0.9)))
    r2, mae, mean_all = r2_mae(np.ones(len(errs), bool))
    r2_d, mae_d, mean_d = r2_mae(dm)
    cover = {name: round(float(np.mean(errs[dm & np.isin(month, ms)] <= np.log(k90))), 3) for name, ms in SEASONS.items()}
    log(f"{species}: 2 km-group CV, daily: IGP R2 {r2:+.2f}, MAE {mae:.1f}, x/{k90_igp:.2f} (n={len(errs)}) | "
        f"Delhi<{DELHI_KM:.0f}km R2 {r2_d:+.2f}, MAE {mae_d:.1f} on mean {mean_d:.1f}, x/{k90:.2f} (n={int(dm.sum())}) "
        f"| coverage by season {cover}")

    # ---- network calibration: live N comes from OUR stations only (Delhi),
    # while the model was trained with every monitor within 150 km. c converts:
    # N_150km ~= c x N_ours, c = median over days of the ratio of their daily means.
    ours = [(s_["lat"], s_["lng"]) for s_ in db.get_stations_with_coords() if s_.get("lat") is not None]
    our_idx = [i for i, p in enumerate(pts) if min(S._km(p, o) for o in ours) < 0.5]
    centre = (28.61, 77.21)
    in150 = [i for i, p in enumerate(pts) if S._km(centre, p) <= NET_KM]
    ratios_c = []
    for dd in np.unique(day):
        m = day == dd
        a = np.nanmean(V[np.ix_(in150, np.flatnonzero(m))]); b = np.nanmean(V[np.ix_(our_idx, np.flatnonzero(m))])
        if np.isfinite(a) and np.isfinite(b) and b > 0:
            ratios_c.append(a / b)
    c = float(np.median(ratios_c))
    log(f"{species}: network calibration c = {c:.3f} ({len(our_idx)} of our stations matched, {len(in150)} monitors within 150 km)")

    # ---- final fit on ALL sites, applied to ward centres ----
    NM = network(ADJ)
    idx = np.arange(n); y = ratios(NM, idx); keep = np.isfinite(y)
    sc, rg, res = fit_level(Z[keep], y[keep], None)
    Dw = np.array([[S._km(w, pts[i]) for i in idx[keep]] for w in wards_pts])
    lr_w = predict_level(sc, rg, res, Zw, Dw)
    return {
        "log_ratio": [round(float(x), 4) for x in lr_w],
        "range_factor_90": round(k90, 3),
        "network_calibration": round(c, 4),
        "features": names,
        "validation": {"design": "2 km-group CV, daily means; range from monitors within "
                                 f"{DELHI_KM:.0f} km of Delhi, stuck-analyser days removed",
                       "r2_daily": round(r2_d, 3), "mae_daily": round(mae_d, 1), "mean_daily": round(mean_d, 1),
                       "n_site_days": int(dm.sum()), "coverage_by_season": cover,
                       "igp": {"r2_daily": round(r2, 3), "mae_daily": round(mae, 1), "mean_daily": round(mean_all, 1),
                               "range_factor_90": round(k90_igp, 3), "n_site_days": int(len(errs))}},
        "training_sites": int(keep.sum()),
        "training_period": [datetime.utcfromtimestamp(hours[0] * 3600).date().isoformat(),
                            datetime.utcfromtimestamp(hours[-1] * 3600).date().isoformat()],
    }


def main():
    wards = []
    for w in db.get_wards_with_city():
        c = (w["lat"], w["lng"]) if w.get("lat") is not None else boundary_area_centroid(w.get("boundary"))
        if c:
            wards.append((w["id"], float(c[0]), float(c[1])))
    wards.sort()
    pts = [(la, lo) for _, la, lo in wards]
    out = {"model_version": "ward_ratio_v1", "generated_at": datetime.now(timezone.utc).isoformat(),
           "net_km": NET_KM, "ward_ids": [w for w, _, _ in wards], "species": {}}
    for sp in SPECIES:
        out["species"][sp] = run_species(sp, pts)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1))
    print(f"wrote {OUT} ({len(wards)} wards)")


if __name__ == "__main__":
    import warnings
    warnings.filterwarnings("ignore")
    main()
