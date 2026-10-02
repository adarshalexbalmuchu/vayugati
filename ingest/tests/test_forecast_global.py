"""forecast_global: pooled, direct, horizon-gated forecaster."""

from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest

from app import forecast_global as fg


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(fg, "LGB_PARAMS", dict(fg.LGB_PARAMS, n_estimators=30))
    monkeypatch.setattr(fg, "TRAIN_HORIZONS", (1, 3, 6, 12, 24, 48))
    monkeypatch.setattr(fg, "MIN_HOURS", 24 * 10)


def _data(n_wards=6, days=45, seed=0, noise=1.0):
    """A shared daily cycle on top of a slowly drifting level (AR(1), phi 0.98),
    plus ward offsets. Persistence misses the cycle and same-hour-yesterday
    misses the drift; a model combining both should beat each at 3-12h.
    (On a purely periodic series same-hour-yesterday is already optimal, and
    the gate rightly refuses the model.)"""
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2026-06-01", periods=24 * days, freq="h", tz="UTC")
    drift = np.zeros(len(idx))
    for i in range(1, len(idx)):
        drift[i] = 0.98 * drift[i - 1] + rng.normal(0, 3)
    rows = []
    for w in range(1, n_wards + 1):
        base = 60 + 5 * w
        v = base + drift + 20 * np.sin(2 * np.pi * idx.hour / 24) + rng.normal(0, noise, len(idx))
        rows += [{"ts": t, "ward_id": w, "value": max(x, 0.1)} for t, x in zip(idx, v)]
    return pd.DataFrame(rows)


def test_gate_for_maps_every_lead_to_a_gate():
    assert [fg.gate_for(h) for h in (1, 2, 3, 4, 6, 7, 13, 25, 48)] == [1, 3, 3, 6, 6, 12, 24, 48, 48]


def test_fit_serves_model_where_it_beats_baselines_and_serve_is_complete():
    df = _data()
    gm = fg.fit("no2", df, pd.DataFrame(), min_improvement_pct=5.0)
    assert gm is not None
    assert gm.gates[6] or gm.gates[12]          # the cycle is learnable; persistence can't follow it
    out = fg.serve(gm, df, pd.DataFrame())
    assert set(out) == set(range(1, 7))
    for o in out.values():
        assert np.isfinite(o["total"]).all() and (o["total"] >= 0).all()
        assert (o["q10"] <= o["total"] + 1e-9).all() and (o["q90"] >= o["total"] - 1e-9).all()
        assert len(o["future_idx"]) == fg.MAX_H and o["future_idx"][0] == o["origin"] + pd.Timedelta(hours=1)


def test_gates_fall_back_to_a_baseline_when_the_model_cannot_win(monkeypatch):
    # Pure noise around a constant: nothing to learn beyond the level.
    rng = np.random.default_rng(1)
    idx = pd.date_range("2026-06-01", periods=24 * 45, freq="h", tz="UTC")
    df = pd.DataFrame([{"ts": t, "ward_id": w, "value": 50 + rng.normal(0, 5)} for w in range(1, 7) for t in idx])
    gm = fg.fit("pm25", df, pd.DataFrame(), min_improvement_pct=50.0)   # impossible margin
    assert not any(gm.gates.values()) and gm.models == {}
    out = fg.serve(gm, df, pd.DataFrame())
    assert all(src != "model" for o in out.values() for src in o["source"])


def test_too_little_data_returns_none():
    assert fg.fit("no2", _data(n_wards=3), pd.DataFrame()) is None


def test_ward_validation_metrics_shape():
    gm = fg.fit("no2", _data(), pd.DataFrame(), 5.0)
    m, max_v = fg.ward_validation_metrics(gm, 1, (6, 12, 24, 48), lambda p, a: (None, None))
    assert set(m) <= {"6", "12", "24", "48"} and m
    for v in m.values():
        assert {"mae", "persistence_mae", "best_baseline", "beats_persistence"} <= set(v)


# ── backtest gates file and bands (Sept 2026) ─────────────────────────────────

def _write_gates(entries: dict, generated_at: datetime | None = None, pollutant="no2"):
    import json
    f = fg.gates_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"generated_at": (generated_at or datetime.now(timezone.utc)).isoformat(),
                             "pollutants": {pollutant: {str(g): e for g, e in entries.items()}}}))


def _entry(serve, rule="rolling_24h_avg", scale=1.0):
    return {"serve_model": serve, "best_rule": rule, "model_band_scale": scale}


def test_load_gates_missing_stale_or_other_pollutant_is_none():
    assert fg.load_gates("no2") is None
    _write_gates({6: _entry(True)}, generated_at=datetime.now(timezone.utc) - pd.Timedelta(days=fg.GATES_MAX_AGE_DAYS + 1))
    assert fg.load_gates("no2") is None
    _write_gates({6: _entry(True)})
    assert fg.load_gates("pm25") is None
    entries, source = fg.load_gates("no2")
    assert entries[6]["serve_model"] is True and source.startswith("rolling_backtest")


def test_backtest_gates_override_the_single_window_gate():
    df = _data()
    _write_gates({g: _entry(False, "persistence") for g in fg.GATE_HORIZONS})
    gm = fg.fit("no2", df, pd.DataFrame(), 5.0)
    assert not any(gm.gates.values()) and gm.models == {}
    assert set(gm.best_baseline.values()) == {"persistence"} and gm.gate_source.startswith("rolling_backtest")
    _write_gates({g: _entry(g == 6) for g in fg.GATE_HORIZONS})
    gm = fg.fit("no2", df, pd.DataFrame(), 5.0)
    assert gm.gates == {g: g == 6 for g in fg.GATE_HORIZONS}
    assert set(gm.models) == {h for h in fg.TRAIN_HORIZONS if fg.gate_for(h) == 6}


def test_rule_bands_scale_with_the_level():
    df = _data()
    _write_gates({g: _entry(False) for g in fg.GATE_HORIZONS})
    gm = fg.fit("no2", df, pd.DataFrame(), 5.0)
    assert gm.band_kind == "multiplicative"
    out = fg.serve(gm, df, pd.DataFrame())
    lo, hi = gm.baseline_bands[1]
    for o in out.values():
        # h=1: q90 / total is the same ratio for every ward, whatever its level
        assert o["q90"][0] == pytest.approx(o["total"][0] * np.exp(hi), rel=1e-6)
        assert o["q10"][0] == pytest.approx(max(o["total"][0] * np.exp(lo), 0), rel=1e-6)


def test_model_band_scale_widens_the_model_range():
    df = _data()
    _write_gates({g: _entry(True, scale=1.0) for g in fg.GATE_HORIZONS})
    narrow = fg.serve(fg.fit("no2", df, pd.DataFrame(), 5.0), df, pd.DataFrame())
    _write_gates({g: _entry(True, scale=2.0) for g in fg.GATE_HORIZONS})
    wide = fg.serve(fg.fit("no2", df, pd.DataFrame(), 5.0), df, pd.DataFrame())
    for w in narrow:
        assert np.allclose(narrow[w]["total"], wide[w]["total"])
        assert (wide[w]["q90"] - wide[w]["q10"] >= narrow[w]["q90"] - narrow[w]["q10"] - 1e-9).all()
        assert (wide[w]["q90"] - wide[w]["q10"]).sum() > (narrow[w]["q90"] - narrow[w]["q10"]).sum()


def test_fit_cached_refits_for_an_old_schema_or_newer_gates(monkeypatch):
    import pickle
    df = _data()
    gm = fg.fit_cached("no2", df, pd.DataFrame())
    assert fg.fit_cached("no2", df, pd.DataFrame()).fitted_at == gm.fitted_at      # fresh cache reused
    old = pickle.loads((fg.CACHE_DIR / "forecast_global_no2.pkl").read_bytes())
    old.schema = 1
    (fg.CACHE_DIR / "forecast_global_no2.pkl").write_bytes(pickle.dumps(old))
    gm2 = fg.fit_cached("no2", df, pd.DataFrame())
    assert gm2.fitted_at > gm.fitted_at and gm2.schema == fg.SCHEMA
    _write_gates({g: _entry(False) for g in fg.GATE_HORIZONS})                     # written after gm2
    gm3 = fg.fit_cached("no2", df, pd.DataFrame())
    assert gm3.fitted_at > gm2.fitted_at and not any(gm3.gates.values())


# ── v2: season + forecast-weather features, blend, exceedance (Oct 2026) ──────

class _FakeF:
    """Stands in for forecast_weather.Frames: smooth synthetic weather."""
    def __call__(self, h, columns, index):
        t = np.arange(len(index))
        base = {"temperature_2m": 25 + 5 * np.sin(2 * np.pi * t / 24), "relative_humidity_2m": 60 + 0 * t,
                "wind_speed_10m": 2 + np.cos(2 * np.pi * t / 24), "wind_speed_100m": 4 + 0 * t,
                "wind_direction_10m": 270 + 0 * t, "precipitation": 0 * t, "cloud_cover": 20 + 0 * t,
                "shortwave_radiation": np.clip(500 * np.sin(2 * np.pi * t / 24), 0, None), "surface_pressure": 990 + 0 * t}
        return {v: pd.DataFrame({c: arr for c in columns}, index=index) for v, arr in base.items()}


def test_forecast_weather_and_season_features_reach_the_models():
    df = _data()
    gm = fg.fit("no2", df, pd.DataFrame(), 5.0, F=_FakeF())
    assert gm.uses_fc and gm.schema == fg.SCHEMA
    assert {"doy_sin", "doy_cos"} <= set(gm.feature_cols)
    long_h = [h for h in gm.models if h >= 6]
    if long_h:
        assert any(c.startswith("fc_") for c in gm.feature_cols)
    out = fg.serve(gm, df, pd.DataFrame(), F=_FakeF())
    for o in out.values():
        assert np.isfinite(o["total"]).all()


def test_exceedance_probabilities_and_severe_flag():
    df = _data()
    thr = float(df["value"].quantile(0.8))
    gm = fg.fit("pm25", df, pd.DataFrame(), 5.0, thresholds={"alert": thr, "severe": None})
    assert thr in gm.exceed and gm.exceed[thr]
    gm.exceed_skill = {thr: {g: 0.5 for g in gm.exceed[thr]}}
    out = fg.serve(gm, df, pd.DataFrame(), severe_threshold=thr)
    for o in out.values():
        p = o["p_exceed"][thr]
        assert np.nanmin(p) >= 0 and np.nanmax(p) <= 1 and np.isfinite(p).any()
        assert o["severe_elevated"].dtype == bool
    # already above the severe level now -> flagged even with no skilful classifier
    gm.exceed_skill = {thr: {g: -0.1 for g in gm.exceed[thr]}}
    low = float(df["value"].min()) - 1
    out = fg.serve(gm, df, pd.DataFrame(), severe_threshold=low)
    assert all(o["severe_elevated"].all() for o in out.values())


def test_blend_from_backtest_gates_is_applied():
    df = _data()
    _write_gates({g: _entry(True) | {"blend_rule": "persistence", "blend_w": 0.7} for g in fg.GATE_HORIZONS})
    gm = fg.fit("no2", df, pd.DataFrame(), 5.0)
    assert gm.blend and all(v == ("persistence", 0.7) for v in gm.blend.values())
    out = fg.serve(gm, df, pd.DataFrame())
    srcs = {s for o in out.values() for s in o["source"]}
    assert "model_blend" in srcs


def test_exceedance_with_forecast_weather_serves_every_lead():
    """Leads of 4-5 h sit under gate 6, whose classifier was trained WITH
    forecast-weather inputs; they must use a short-lead classifier instead."""
    df = _data()
    thr = float(df["value"].quantile(0.8))
    gm = fg.fit("pm25", df, pd.DataFrame(), 5.0, F=_FakeF(), thresholds={"alert": thr})
    gm.exceed_skill = {thr: {g: 0.5 for g in gm.exceed.get(thr, {})}}
    out = fg.serve(gm, df, pd.DataFrame(), F=_FakeF())
    for o in out.values():
        assert np.isfinite(o["p_exceed"][thr][3:5]).all()      # leads 4 and 5 h
