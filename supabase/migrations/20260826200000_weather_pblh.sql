-- ============================================================
-- weather — add boundary_layer_height (PBLH) column
--
-- Planetary Boundary Layer Height is the single most important
-- meteorological predictor of surface PM2.5 in the IGP.  The
-- negative correlation with PM2.5 is robustly established:
--
--   • AMT 2019 (lidar, New Delhi): winter PBLH collapses to
--     200–400 m, trapping emissions near the surface.
--   • JGR Atmospheres 2021: PM2.5 ∝ PBLH^(-0.8 to -1.2).
--   • Multiple Delhi ML papers (2022–2025) rank PBLH in the
--     top-5 feature importances for PM2.5 forecasting.
--
-- Ventilation coefficient = PBLH × wind_speed (m²/s), a combined
-- dispersion capacity metric:
--   • Theoretical and Applied Climatology 2025 (IMDAA reanalysis):
--     VC < 6000 m²/s defines "unfavourable dispersion" in the Indian context.
--   • Frontiers in Climate 2026 BiLSTM study uses VC as an
--     engineered feature directly.
--
-- Values are fetched from api.open-meteo.com (free, no API key,
-- returns WRF/ECMWF boundary_layer_height hourly) during each
-- ingest cycle and stored alongside MET Norway weather.  NULL for
-- rows written before this migration.
-- ============================================================

alter table weather
  add column if not exists boundary_layer_height double precision,  -- metres
  add column if not exists ventilation_coefficient double precision; -- m²/s
