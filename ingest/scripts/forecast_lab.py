"""Forecast lab: head-to-head tests of forecaster variants on 19 months of
hourly data at Delhi's monitors, including the 2025-26 winter.

Why a lab separate from forecast_rolling_backtest.py: readings_hourly holds
only June-Sept 2026 (no winter, few exceedances). The research pull
(scripts/species/sites.py, OpenAQ hourly + ERA5 per monitor) has Feb 2025 -
Sept 2026 for PM2.5 and NO2 at ~45 Delhi monitors, stuck-analyser days
removed by site_model.qc. Monitors play the role of wards.

Design: FOLD_DAYS-day test blocks from TEST_START; each block's model is
trained on the TRAIN_CAP_DAYS before it (live: 90 days, refit daily; here
refit per block, slightly pessimistic). A variant = the production pipeline
(forecast_global._features/_rel/_to_total, LightGBM L1 on the log-ratio
target) plus a named change. compare() reports MAE per horizon and season
with a paired day-block bootstrap CI of the difference, and exceedance skill.

    python scripts/forecast_lab.py run <variant> [pm25|no2 ...]
    python scripts/forecast_lab.py compare <variant_a> <variant_b> [pm25|no2 ...]
"""

from __future__ import annotations

import pickle
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import forecast_global as G  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "data" / "backtests" / "lab"
DELHI, DELHI_KM = (28.61, 77.21), 25.0
DATA_START, DATA_END = "2025-02-01", "2026-09-24"
TEST_START = "2025-04-01"
FOLD_DAYS = 14
TRAIN_CAP_DAYS = 90
HORIZONS = (1, 3, 6, 12, 24, 48)
WINTER = (10, 11, 12, 1, 2)
THRESHOLDS = {"pm25": (90.0, 250.0), "no2": (80.0, 180.0)}
N_BOOT = 2000


# ── data ──────────────────────────────────────────────────────────────────────

def dataset(species: str):
    """(Y, W): hourly UTC panel, monitors as columns, and ERA5 weather frames
    shaped like Y (forecast_global.WX names)."""
    f = OUT / f"data_{species}.pkl"
    if f.exists():
        return pickle.loads(f.read_bytes())
    from scripts.species import sites as S
    from scripts.species import site_model as SM
    d = S.load(species, region="igp", log=lambda *a: None)
    good = SM.qc(d, lambda *a: None)
    sites = [s for s in d["sites"] if s["site"] in good and S._km((s["lat"], s["lng"]), DELHI) <= DELHI_KM]
    idx = pd.date_range(DATA_START, DATA_END, freq="h", tz="UTC", inclusive="left")
    Y = pd.DataFrame(np.nan, index=idx, columns=[s["site"] for s in sites])
    pos = {t: i for i, t in enumerate((idx - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(hours=1))}
    for s in sites:
        col = Y.columns.get_loc(s["site"])
        for h, v in good[s["site"]].items():
            i = pos.get(h)
            if i is not None:
                Y.iat[i, col] = v
    W = {m: pd.DataFrame(np.nan, index=idx, columns=Y.columns) for m in G.WX}
    hk = idx.strftime("%Y-%m-%dT%H")
    for s in sites:
        rows = [d["met"].get((s["site"], k)) or {} for k in hk]
        for m in ("wind_speed", "boundary_layer_height", "temp_c", "humidity", "precipitation"):
            W[m][s["site"]] = [r.get(m) for r in rows]
    W["ventilation_coefficient"] = W["boundary_layer_height"] * W["wind_speed"]
    meta = {s["site"]: {"name": s["name"], "lat": s["lat"], "lng": s["lng"]} for s in sites}
    OUT.mkdir(parents=True, exist_ok=True)
    f.write_bytes(pickle.dumps((Y, W, meta)))
    return Y, W, meta


# ── variants ──────────────────────────────────────────────────────────────────
# A variant hooks into three places: extra feature columns for the long frame
# (after forecast_global._rel), the LightGBM objective/params, and the
# training window. Registered by name so worker processes can look them up.

VARIANTS: dict[str, dict] = {}


def variant(name, **spec):
    VARIANTS[name] = {"extra": None, "objective": "l1", "params": {}, "train_cap_days": TRAIN_CAP_DAYS} | spec


variant("v1_production")


def _long(frames: dict, L: pd.DataFrame) -> pd.DataFrame:
    """Wide (time x site) frames -> columns aligned to L's (origin, ward) index."""
    return pd.concat({k: v.stack(future_stack=True) for k, v in frames.items()}, axis=1).reindex(L.index)


def wx_target(Y, W, h, L, meta):
    """Weather AT the target hour and averaged over (origin, target]:
    what a weather forecast would supply. From ERA5 here (an upper bound:
    a perfect forecast); real archived forecasts are a separate variant."""
    fr = {}
    for m in ("boundary_layer_height", "wind_speed", "ventilation_coefficient", "temp_c", "humidity"):
        fr[f"{m}_t"] = W[m].shift(-h)
        fr[f"{m}_mean"] = W[m].rolling(h, min_periods=1).mean().shift(-h)
    fr["precip_sum"] = W["precipitation"].rolling(h, min_periods=1).sum().shift(-h)
    X = _long(fr, L)
    X["vent_ratio"] = np.log1p(X["ventilation_coefficient_mean"]) - np.log1p(L["ventilation_coefficient_0"])
    X["blh_ratio"] = np.log1p(X["boundary_layer_height_t"]) - np.log1p(L["boundary_layer_height_0"])
    return X


variant("v2_wx_target_oracle", extra=wx_target)


# ── archived weather forecasts (Open-Meteo Previous Runs, ECMWF IFS 0.25) ────
FC_VARS = ("temperature_2m", "relative_humidity_2m", "wind_speed_10m", "wind_speed_100m", "wind_direction_10m",
           "precipitation", "cloud_cover", "shortwave_radiation", "surface_pressure")
FC_DAYS = (1, 2, 3)


def _cell(lat, lng):
    return round(round(lat / 0.25) * 0.25, 2), round(round(lng / 0.25) * 0.25, 2)


def fetch_prevruns(cell) -> pd.DataFrame:
    """Hourly archived forecasts for one grid cell, DATA_START..DATA_END:
    columns '<var>_previous_day<d>' = the value forecast for that hour by the
    run d days earlier."""
    import time

    import httpx
    f = OUT / f"prevruns_{cell[0]}_{cell[1]}.pkl"
    if f.exists():
        return pd.read_pickle(f)
    parts = []
    for a, b in (("2025-01-25", "2025-09-30"), ("2025-10-01", "2026-04-30"), ("2026-05-01", DATA_END)):
        hourly = ",".join(f"{v}_previous_day{d}" for v in FC_VARS for d in FC_DAYS)
        for attempt in range(4):
            r = httpx.get("https://previous-runs-api.open-meteo.com/v1/forecast", timeout=120, params={
                "latitude": cell[0], "longitude": cell[1], "hourly": hourly, "start_date": a, "end_date": b,
                "timezone": "UTC", "models": "ecmwf_ifs025", "wind_speed_unit": "ms"})
            if r.status_code == 200:
                break
            time.sleep(20 * (attempt + 1))
        r.raise_for_status()
        h = r.json()["hourly"]
        parts.append(pd.DataFrame({k: v for k, v in h.items() if k != "time"},
                                  index=pd.to_datetime(h["time"], utc=True), dtype=float))
        time.sleep(2)
    df = pd.concat(parts).sort_index()
    df = df[~df.index.duplicated()]
    OUT.mkdir(parents=True, exist_ok=True)
    df.to_pickle(f)
    return df


def forecasts(species: str) -> dict[int, dict[str, pd.DataFrame]]:
    """{previous_day d: {var: frame shaped like Y}} for the species' monitors."""
    f = OUT / f"fc_{species}.pkl"
    if f.exists():
        return pickle.loads(f.read_bytes())
    Y, _, meta = dataset(species)
    cells = {s: _cell(m["lat"], m["lng"]) for s, m in meta.items() if s in Y.columns}
    raw = {c: fetch_prevruns(c).reindex(Y.index) for c in set(cells.values())}
    out = {d: {v: pd.DataFrame({s: raw[cells[s]][f"{v}_previous_day{d}"].to_numpy() for s in Y.columns},
                               index=Y.index) for v in FC_VARS} for d in FC_DAYS}
    f.write_bytes(pickle.dumps(out))
    return out


def fc_day(h: int) -> int:
    """The newest archived run certainly available at the origin: lead >= h + 6 h."""
    return 1 if h <= 18 else int(np.ceil((h + 6) / 24))


_FC_CACHE: dict = {}


def wx_forecast(Y, W, h, L, meta):
    """What a live forecaster knows about the weather to come: archived ECMWF
    forecasts valid at the target hour and averaged over (origin, target]."""
    sp = "pm25" if set(Y.columns) <= set(dataset("pm25")[0].columns) else "no2"
    if sp not in _FC_CACHE:
        _FC_CACHE[sp] = forecasts(sp)
    F = {v: fr.loc[Y.index, Y.columns] for v, fr in _FC_CACHE[sp][fc_day(h)].items()}
    fr = {}
    for v in ("temperature_2m", "relative_humidity_2m", "wind_speed_10m", "wind_speed_100m", "cloud_cover",
              "shortwave_radiation"):
        fr[f"fc_{v}_t"] = F[v].shift(-h)
        fr[f"fc_{v}_mean"] = F[v].rolling(h, min_periods=1).mean().shift(-h)
    fr["fc_precip_sum"] = F["precipitation"].rolling(h, min_periods=1).sum().shift(-h)
    fr["fc_pressure_change"] = F["surface_pressure"].shift(-h) - F["surface_pressure"]
    rad = np.deg2rad(F["wind_direction_10m"])
    fr["fc_u_mean"] = (-F["wind_speed_10m"] * np.sin(rad)).rolling(h, min_periods=1).mean().shift(-h)
    fr["fc_v_mean"] = (-F["wind_speed_10m"] * np.cos(rad)).rolling(h, min_periods=1).mean().shift(-h)
    X = _long(fr, L)
    # stability proxy: 100 m / 10 m wind ratio (large on stable, inverted nights)
    X["fc_shear_t"] = np.log1p(X["fc_wind_speed_100m_t"]) - np.log1p(X["fc_wind_speed_10m_t"])
    X["fc_shear_mean"] = np.log1p(X["fc_wind_speed_100m_mean"]) - np.log1p(X["fc_wind_speed_10m_mean"])
    return X


variant("v3_wx_forecast", extra=wx_forecast)

WX_MIN_H = 6


def wx_forecast_compact(Y, W, h, L, meta):
    """A small, physically chosen set, only from WX_MIN_H: at 1-3 h the
    current state already carries the weather and 22 columns were noise."""
    if h < WX_MIN_H:
        return pd.DataFrame(index=L.index)
    X = wx_forecast(Y, W, h, L, meta)
    keep = ["fc_wind_speed_10m_mean", "fc_shear_mean", "fc_shortwave_radiation_mean", "fc_relative_humidity_2m_mean",
            "fc_precip_sum", "fc_u_mean", "fc_v_mean", "fc_cloud_cover_mean"]
    out = X[keep].copy()
    out["fc_dtemp"] = X["fc_temperature_2m_t"] - L["temp_c_0"]
    out["fc_dwind"] = np.log1p(X["fc_wind_speed_10m_mean"]) - np.log1p(L["wind_speed_0"])
    return out


variant("v3b_wx_forecast_compact", extra=wx_forecast_compact)


# ── regional fires (NASA FIRMS, VIIRS on NOAA-21, NRT: one continuous product
# from 2024-01; the SNPP standard archive had May 2026 missing, which read as
# "no fires" in the middle of the wheat-burning season) ─────────────────────
FIRE_BOX = (73.8, 28.0, 78.5, 32.6)          # Punjab, Haryana, western UP: the stubble belt upwind of Delhi


def fire_daily() -> pd.DataFrame:
    """Daily fire count and total FRP (MW) in FIRE_BOX, UTC days."""
    import io
    import time

    import httpx

    from app import config
    f = OUT / "fires_daily.pkl"
    if f.exists():
        return pd.read_pickle(f)
    days = pd.date_range("2025-01-20", DATA_END, freq="D")
    rows, d0 = [], days[0]
    src = "VIIRS_NOAA21_NRT"
    while d0 <= days[-1]:                     # chunks of <= 5 days (API limit)
        last = min(d0 + pd.Timedelta(days=4), days[-1])
        n = (last - d0).days + 1
        url = (f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{config.FIRMS_MAP_KEY}/{src}/"
               f"{','.join(map(str, FIRE_BOX))}/{n}/{d0.date()}")
        for attempt in range(4):
            r = httpx.get(url, timeout=120)
            if r.status_code == 200:
                break
            time.sleep(15 * (attempt + 1))
        if r.status_code != 200:
            # never raise with the URL: it carries the MAP_KEY
            raise RuntimeError(f"FIRMS {src} {d0.date()} +{n}d: HTTP {r.status_code}: {r.text[:200]}")
        if r.text.strip() and "acq_date" in r.text:
            rows.append(pd.read_csv(io.StringIO(r.text))[["acq_date", "frp"]])
        time.sleep(1)
        d0 = last + pd.Timedelta(days=1)
    fires = pd.concat(rows) if rows else pd.DataFrame(columns=["acq_date", "frp"])
    fires["acq_date"] = pd.to_datetime(fires["acq_date"])
    out = fires.groupby("acq_date").agg(count=("frp", "size"), frp=("frp", "sum"))
    out = out.reindex(days, fill_value=0)
    OUT.mkdir(parents=True, exist_ok=True)
    out.to_pickle(f)
    return out


def fire_features(Y, W, h, L, meta):
    """Fires on the last full UTC day known at the origin (FIRMS latency ~3 h:
    before 04 UTC use the day before), the 3-day sum, and FRP."""
    fd = fire_daily()
    o = L.index.get_level_values("origin")
    known = (o - pd.Timedelta(hours=4)).tz_convert(None).floor("D") - pd.Timedelta(days=1)
    c = fd["count"].reindex(known).to_numpy()
    frp = fd["frp"].reindex(known).to_numpy()
    c3 = fd["count"].rolling(3, min_periods=1).sum().reindex(known).to_numpy()
    c7 = fd["count"].rolling(7, min_periods=1).sum().reindex(known).to_numpy()
    return pd.DataFrame({"fire_n1": np.log1p(c), "fire_frp1": np.log1p(frp), "fire_n3": np.log1p(c3),
                         "fire_n7": np.log1p(c7)}, index=L.index)


def wx_forecast_fire(Y, W, h, L, meta):
    return pd.concat([wx_forecast_compact(Y, W, h, L, meta), fire_features(Y, W, h, L, meta)], axis=1)


variant("v4_wx_forecast_fire", extra=wx_forecast_fire)


def season_features(Y, W, h, L, meta):
    o = L.index.get_level_values("origin") + pd.Timedelta(hours=h)
    doy = o.dayofyear.to_numpy()
    return pd.DataFrame({"doy_sin": np.sin(2 * np.pi * doy / 365.25), "doy_cos": np.cos(2 * np.pi * doy / 365.25)},
                        index=L.index)


variant("v5_all_history_season", extra=season_features, train_cap_days=None)


_CO: dict = {}


def co_pollutant(Y, W, h, L, meta):
    """The other species at the same monitor (matched by name): NO2 for
    PM2.5 and PM2.5 for NO2, now and its change, relative to its own 24h mean."""
    sp = "pm25" if set(Y.columns) <= set(dataset("pm25")[0].columns) else "no2"
    other = "no2" if sp == "pm25" else "pm25"
    if other not in _CO:
        Yo, _, mo = dataset(other)
        by_name = {m["name"]: s for s, m in mo.items()}
        _CO[other] = (Yo, by_name)
    Yo, by_name = _CO[other]
    cols = {s: by_name.get(meta[s]["name"]) for s in Y.columns}
    Z = pd.DataFrame({s: (Yo[c] if c is not None else np.nan) for s, c in cols.items()}, index=Yo.index).loc[Y.index]
    base = np.log1p(Z.rolling(24, min_periods=12).mean().clip(lower=1))
    fr = {f"co_{other}_0_r": np.log1p(Z.clip(lower=0)) - base,
          f"co_{other}_d3": np.log1p(Z.clip(lower=0)) - np.log1p(Z.shift(3).clip(lower=0)),
          f"co_{other}_city_r": np.log1p(Z.median(axis=1)).to_frame().reindex(columns=[0]).squeeze()
          .pipe(lambda c: pd.DataFrame({s: c for s in Y.columns})) - np.log1p(
              Z.median(axis=1).rolling(24, min_periods=12).mean()).pipe(lambda c: pd.DataFrame({s: c for s in Y.columns}))}
    return _long(fr, L)


variant("v6_co_pollutant", extra=co_pollutant)
variant("v7_capacity", params={"n_estimators": 900, "learning_rate": 0.03, "num_leaves": 63, "min_child_samples": 100})


# ── round 2: each on top of the champion (v3b: compact forecast weather) ────

def _with(*fns):
    def f(Y, W, h, L, meta):
        return pd.concat([fn(Y, W, h, L, meta) for fn in fns], axis=1)
    return f


def fire_transport(Y, W, h, L, meta):
    """Stubble smoke reaches Delhi on north-westerlies: recent fires x the
    forecast NW wind component over the window, only from 12 h."""
    if h < 12:
        return pd.DataFrame(index=L.index)
    fx = fire_features(Y, W, h, L, meta)
    wx = wx_forecast(Y, W, h, L, meta)
    # wind FROM the north-west blows toward the south-east: u > 0, v < 0
    nw = ((wx["fc_u_mean"] - wx["fc_v_mean"]) / np.sqrt(2)).clip(lower=0)
    return pd.DataFrame({"fire_nw": fx["fire_n3"] * nw}, index=L.index)


variant("v8_champ_fire_nw", extra=_with(wx_forecast_compact, fire_transport))
variant("v9_champ_all_history", extra=_with(wx_forecast_compact, season_features), train_cap_days=None)
variant("v10_champ_co_pollutant", extra=_with(wx_forecast_compact, co_pollutant))
variant("v9q_champ_quantiles", extra=_with(wx_forecast_compact, season_features), train_cap_days=None, quantiles=True)
variant("v11_champ_capacity", extra=wx_forecast_compact,
        params={"n_estimators": 900, "learning_rate": 0.03, "num_leaves": 63, "min_child_samples": 100})


# ── fold runner ───────────────────────────────────────────────────────────────

def _fold(args):
    import warnings
    warnings.filterwarnings("ignore")
    import lightgbm as lgb
    species, vname, T = args
    spec = VARIANTS[vname]
    Y, W, meta = dataset(species)
    T = pd.Timestamp(T)
    T_end = T + pd.Timedelta(days=FOLD_DAYS)
    lo = T - pd.Timedelta(days=spec["train_cap_days"]) if spec["train_cap_days"] else Y.index.min()
    Yk = Y[(Y.index >= lo) & (Y.index < T_end)]
    Wk = {m: w.loc[Yk.index] for m, w in W.items()}
    trainY = Yk[Yk.index < T]
    diurnal, level = trainY.groupby(trainY.index.hour).mean(), trainY.mean()
    out = []
    for h in HORIZONS:
        L = G._features(Yk, Wk, h, diurnal, level)
        L = L[L["target"].notna() & L["y0"].notna() & L["roll24"].notna()]
        o = L.index.get_level_values("origin")
        X = G._rel(L)
        if spec["extra"] is not None:
            X = pd.concat([X, spec["extra"](Yk, Wk, h, L, meta)], axis=1)
        tr = (o + pd.Timedelta(hours=h)) < T
        te = (o >= T) & (o < T_end) & (o.hour % G.ORIGIN_STEP_H == 0)
        if tr.sum() < 2000 or te.sum() == 0:
            continue
        params = dict(G.LGB_PARAMS) | {"n_jobs": 1} | spec["params"]
        tgt = G._target_rel(L)
        m = lgb.LGBMRegressor(objective=spec["objective"], **params).fit(X[tr], tgt[tr])
        pred = G._to_total(m.predict(X[te]), L[te])
        qcols = {}
        if spec.get("quantiles"):
            qp = params | {"n_estimators": 200}
            for name, alpha in (("q10", 0.10), ("q90", 0.90)):
                mq = lgb.LGBMRegressor(objective="quantile", alpha=alpha, **qp).fit(X[tr], tgt[tr])
                qcols[name] = G._to_total(mq.predict(X[te]), L[te])
        Lt = L[te]
        bp = G._baseline_preds(Lt)
        ot = o[te]
        out.append(pd.DataFrame({"fold": str(T.date()), "h": h, "origin": ot, "site": Lt.index.get_level_values("ward"),
                                 "day": (ot + pd.Timedelta(hours=h)).floor("D"), "y": Lt["target"].to_numpy(),
                                 "pred": pred, **bp, **qcols}))
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()


def run(vname: str, species: str, workers: int = 8) -> pd.DataFrame:
    f = OUT / f"run_{vname}_{species}.pkl"
    if f.exists():
        return pd.read_pickle(f)
    from concurrent.futures import ProcessPoolExecutor
    dataset(species)   # build the cache once, before the workers read it
    starts = pd.date_range(TEST_START, pd.Timestamp(DATA_END) - pd.Timedelta(days=FOLD_DAYS), freq=f"{FOLD_DAYS}D", tz="UTC")
    with ProcessPoolExecutor(workers) as ex:
        parts = list(ex.map(_fold, [(species, vname, str(T)) for T in starts]))
    df = pd.concat([p for p in parts if not p.empty], ignore_index=True)
    ok = np.isfinite(df["y"]) & np.isfinite(df["pred"]) & np.all([np.isfinite(df[c]) for c in G.BASELINES], axis=0)
    df = df[ok].reset_index(drop=True)
    df.to_pickle(f)
    return df


# ── scoring ───────────────────────────────────────────────────────────────────

def _paired(a: pd.DataFrame, b: pd.DataFrame, col_a="pred", col_b="pred", rng=None):
    """% MAE change of b vs a (negative = b better), day-block bootstrap 95% CI."""
    rng = rng or np.random.default_rng(0)
    key = ["h", "origin", "site"]
    m = a[key + ["day", "y", col_a]].merge(b[key + [col_b]].rename(columns={col_b: "_b"}), on=key)
    g = m.assign(ea=(m[col_a] - m["y"]).abs(), eb=(m["_b"] - m["y"]).abs()).groupby("day")[["ea", "eb"]].sum()
    ea, eb = g["ea"].to_numpy(), g["eb"].to_numpy()
    point = 100 * (eb.sum() / ea.sum() - 1)
    idx = rng.integers(0, len(ea), (N_BOOT, len(ea)))
    boots = 100 * (eb[idx].sum(1) / ea[idx].sum(1) - 1)
    return point, *np.percentile(boots, [2.5, 97.5])


def _exceed(d: pd.DataFrame, col: str, thr: float):
    act, pred = d["y"] >= thr, d[col] >= thr
    hits = (act & pred).sum()
    pod = hits / act.sum() if act.sum() else np.nan
    far = (pred & ~act).sum() / pred.sum() if pred.sum() else np.nan
    csi = hits / (act | pred).sum() if (act | pred).sum() else np.nan
    return pod, far, csi, int(act.sum())


def season_of(df):
    return np.where(df["day"].dt.month.isin(WINTER), "winter", "rest")


def compare(va: str, vb: str, species: str, log=print):
    a, b = run(va, species), run(vb, species)
    rng = np.random.default_rng(0)
    log(f"\n{species}: {vb}  vs  {va}   (MAE change of {vb}; negative = better; 95% CI by day blocks)")
    for season in ("winter", "rest"):
        sa, sb = a[season_of(a) == season], b[season_of(b) == season]
        for h in HORIZONS:
            xa, xb = sa[sa["h"] == h], sb[sb["h"] == h]
            if xa.empty:
                continue
            mae_a = (xa["pred"] - xa["y"]).abs().mean()
            mae_b = (xb["pred"] - xb["y"]).abs().mean()
            best_rule = min(G.BASELINES, key=lambda c: (xa[c] - xa["y"]).abs().mean())
            rule_mae = (xa[best_rule] - xa["y"]).abs().mean()
            pt, lo, hi = _paired(xa, xb, rng=rng)
            flag = "BETTER" if hi < 0 else ("worse" if lo > 0 else "")
            ex = []
            for thr in THRESHOLDS.get(species, ()):
                pa, fa, ca, n = _exceed(xa, "pred", thr)
                pb, fb, cb, _ = _exceed(xb, "pred", thr)
                pr, fr, cr, _ = _exceed(xa, best_rule, thr)
                ex.append(f">={thr:.0f}(n={n}) CSI {ca:.2f}->{cb:.2f} POD {pa:.2f}->{pb:.2f} [rule CSI {cr:.2f}]")
            log(f"  {season:6s} {h:>2}h  {va[:14]} {mae_a:6.2f}  {vb[:14]} {mae_b:6.2f}  ({pt:+5.1f}% [{lo:+5.1f},{hi:+5.1f}]) {flag:6s} "
                f"| best rule {best_rule[:12]} {rule_mae:6.2f} | " + " ; ".join(ex))



def report(vname: str, species: str, log=print):
    """A variant against the best simple rule (chosen per season and horizon)."""
    a = run(vname, species)
    rng = np.random.default_rng(0)
    log(f"\n{species}: {vname} vs best simple rule (gain = MAE reduction; 95% CI by day blocks)")
    for season in ("winter", "rest"):
        s = a[season_of(a) == season]
        for h in HORIZONS:
            x = s[s["h"] == h]
            rule = min(G.BASELINES, key=lambda c: (x[c] - x["y"]).abs().mean())
            pt, lo, hi = _paired(x, x, col_a=rule, col_b="pred", rng=rng)
            ex = []
            for thr in THRESHOLDS.get(species, ()):
                pm, fm, cm, n = _exceed(x, "pred", thr)
                pr, fr, cr, _ = _exceed(x, rule, thr)
                ex.append(f">={thr:.0f} n={n}: model POD {pm:.2f} FAR {fm:.2f} CSI {cm:.2f} | rule POD {pr:.2f} CSI {cr:.2f}")
            log(f"  {season:6s} {h:>2}h model {(x['pred'] - x['y']).abs().mean():6.2f} rule {rule[:10]:10s} "
                f"{(x[rule] - x['y']).abs().mean():6.2f} gain {-pt:+5.1f}% [{-hi:+5.1f},{-lo:+5.1f}] (mean {x['y'].mean():5.1f}) || " + " ; ".join(ex))


# ── exceedance forecast: P(y >= threshold) per horizon ─────────────────────────

def _exceed_fold(args):
    import warnings
    warnings.filterwarnings("ignore")
    import lightgbm as lgb
    species, vname, T, thr = args
    spec = VARIANTS[vname]
    Y, W, meta = dataset(species)
    T = pd.Timestamp(T)
    T_end = T + pd.Timedelta(days=FOLD_DAYS)
    lo = T - pd.Timedelta(days=spec["train_cap_days"]) if spec["train_cap_days"] else Y.index.min()
    Yk = Y[(Y.index >= lo) & (Y.index < T_end)]
    Wk = {m: w.loc[Yk.index] for m, w in W.items()}
    trainY = Yk[Yk.index < T]
    diurnal, level = trainY.groupby(trainY.index.hour).mean(), trainY.mean()
    out = []
    for h in HORIZONS:
        L = G._features(Yk, Wk, h, diurnal, level)
        L = L[L["target"].notna() & L["y0"].notna() & L["roll24"].notna()]
        o = L.index.get_level_values("origin")
        X = G._rel(L)
        if spec["extra"] is not None:
            X = pd.concat([X, spec["extra"](Yk, Wk, h, L, meta)], axis=1)
        # crossing a FIXED threshold depends on the absolute level too
        X["abs_y0"] = np.log1p(L["y0"].clip(lower=0))
        X["abs_roll24"] = np.log1p(L["roll24"].clip(lower=0))
        X["abs_diurnal_t"] = np.log1p(L["diurnal_t"].clip(lower=0))
        X["abs_city0"] = np.log1p(L["city0"].clip(lower=0))
        y = (L["target"] >= thr).astype(int)
        tgt_t = o + pd.Timedelta(hours=h)
        tr = tgt_t < T
        te = (o >= T) & (o < T_end) & (o.hour % G.ORIGIN_STEP_H == 0)
        if tr.sum() < 2000 or te.sum() == 0 or y[tr].sum() < 20:
            continue
        # pick the decision cut-off on the last 14 training days (inner split), never on the test block
        inner = tgt_t >= (T - pd.Timedelta(days=14))
        fit_m = tr & ~inner
        params = dict(G.LGB_PARAMS) | {"n_jobs": 1}
        cut = 0.5
        if y[fit_m].sum() >= 20 and y[tr & inner].sum() >= 5:
            m0 = lgb.LGBMClassifier(**params).fit(X[fit_m], y[fit_m])
            pi, yi = m0.predict_proba(X[tr & inner])[:, 1], y[tr & inner].to_numpy()
            best = -1
            for c in np.arange(0.05, 0.95, 0.025):
                pr = pi >= c
                csi = (pr & (yi == 1)).sum() / max(((pr) | (yi == 1)).sum(), 1)
                if csi > best:
                    best, cut = csi, c
        m = lgb.LGBMClassifier(**params).fit(X[tr], y[tr])
        p = m.predict_proba(X[te])[:, 1]
        Lt = L[te]
        out.append(pd.DataFrame({"fold": str(T.date()), "h": h, "origin": o[te], "site": Lt.index.get_level_values("ward"),
                                 "day": (o[te] + pd.Timedelta(hours=h)).floor("D"), "y": Lt["target"].to_numpy(),
                                 "prob": p, "cut": cut, "base_rate": float(y[tr].mean())}))
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()


def run_exceed(vname: str, species: str, thr: float, workers: int = 8) -> pd.DataFrame:
    f = OUT / f"exceed_{vname}_{species}_{int(thr)}.pkl"
    if f.exists():
        return pd.read_pickle(f)
    from concurrent.futures import ProcessPoolExecutor
    starts = pd.date_range(TEST_START, pd.Timestamp(DATA_END) - pd.Timedelta(days=FOLD_DAYS), freq=f"{FOLD_DAYS}D", tz="UTC")
    with ProcessPoolExecutor(workers) as ex:
        parts = list(ex.map(_exceed_fold, [(species, vname, str(T), thr) for T in starts]))
    df = pd.concat([p for p in parts if not p.empty], ignore_index=True)
    df.to_pickle(f)
    return df


def report_exceed(vname: str, species: str, thr: float, reg_variant: str, log=print):
    """Classifier vs the regression model's point forecast vs the best rule,
    same (h, origin, site) rows."""
    e = run_exceed(vname, species, thr)
    r = run(reg_variant, species)
    key = ["h", "origin", "site"]
    m = e.merge(r[key + ["pred", *G.BASELINES]], on=key)
    log(f"\n{species} >= {thr:.0f}: exceedance classifier ({vname}) vs regression ({reg_variant}) vs best rule")
    for season in ("winter", "rest"):
        s = m[season_of(m) == season]
        for h in HORIZONS:
            x = s[s["h"] == h]
            if x.empty:
                continue
            act = x["y"] >= thr
            def sc(pred):
                hits = (pred & act).sum()
                return (hits / max(act.sum(), 1), (pred & ~act).sum() / max(pred.sum(), 1), hits / max((pred | act).sum(), 1))
            rule = max(G.BASELINES, key=lambda c: sc(x[c] >= thr)[2])
            pc, fc, cc = sc(x["prob"] >= x["cut"])
            pr_, fr_, cr_ = sc(x["pred"] >= thr)
            pb, fb, cb = sc(x[rule] >= thr)
            brier = np.mean((x["prob"] - act) ** 2)
            clim = np.mean((x["base_rate"] - act) ** 2)
            log(f"  {season:6s} {h:>2}h n+={int(act.sum()):5d}  classifier POD {pc:.2f} FAR {fc:.2f} CSI {cc:.2f} (BSS {1 - brier / clim:+.2f}) "
                f"| regression CSI {cr_:.2f} (POD {pr_:.2f}) | best rule {rule[:12]} CSI {cb:.2f} (POD {pb:.2f})")


if __name__ == "__main__":
    import warnings
    warnings.filterwarnings("ignore")
    cmd, *rest = sys.argv[1:]
    if cmd == "run":
        v, *sps = rest
        for sp in sps or ["pm25", "no2"]:
            df = run(v, sp)
            print(v, sp, len(df), "rows")
    elif cmd == "compare":
        va, vb, *sps = rest
        for sp in sps or ["pm25", "no2"]:
            compare(va, vb, sp)
    elif cmd == "exceed":
        # exceed <classifier variant> <regression variant> <species> <threshold> [...]
        v, reg, *pairs = rest
        for sp, thr in zip(pairs[::2], pairs[1::2]):
            report_exceed(v, sp, float(thr), reg)
