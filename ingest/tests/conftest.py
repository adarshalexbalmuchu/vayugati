import pytest


@pytest.fixture(autouse=True)
def _isolated_forecast_model_cache(tmp_path, monkeypatch):
    """forecast_global caches fitted models on disk; tests must never read a
    model a real run left behind."""
    from app import forecast_global
    monkeypatch.setattr(forecast_global, "CACHE_DIR", tmp_path / "models")
