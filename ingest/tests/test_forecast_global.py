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
