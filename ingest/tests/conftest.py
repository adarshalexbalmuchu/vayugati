import pytest


@pytest.fixture(autouse=True)
def _isolated_forecast_model_cache(tmp_path, monkeypatch):
    """forecast_global caches fitted models on disk; tests must never read a
    model a real run left behind."""
    from app import forecast_global
    monkeypatch.setattr(forecast_global, "CACHE_DIR", tmp_path / "models")


@pytest.fixture(autouse=True)
def _no_weather_network(monkeypatch):
    """The forecaster fetches ECMWF forecasts and reads local weather
    archives; tests must neither touch the network nor depend on files a real
    run left behind."""
    import pandas as pd

    from app import forecast, weather_archive
    monkeypatch.setattr(forecast, "_forecast_weather_frames", lambda *a, **k: (None, None))
    monkeypatch.setattr(weather_archive, "frame_before", lambda *a, **k: pd.DataFrame())
