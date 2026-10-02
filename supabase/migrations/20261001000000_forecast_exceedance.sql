-- Exceedance probabilities and a severe-risk flag on each forecast row.
--
-- Forecast lab (Oct 2026, ingest/scripts/forecast_lab.py): the point forecast
-- is the MOST LIKELY value and cannot warn of crossings by itself. A separate
-- classifier gives a calibrated chance of crossing the city's alert threshold
-- (PM2.5 >= 90: caught 95-97% of winter crossings; probabilities within 1-3
-- points of observed frequencies). For PM2.5's severe level (>= 250) only a
-- coarse flag is honest: "already severe now, or the classifier says so"
-- caught 62-77% of severe hours at 6-48 h, with about 55-62% false alarms.
alter table forecasts add column if not exists exceed_threshold double precision;
alter table forecasts add column if not exists exceed_prob double precision
  check (exceed_prob is null or (exceed_prob >= 0 and exceed_prob <= 1));
alter table forecasts add column if not exists severe_risk text
  check (severe_risk is null or severe_risk in ('elevated'));

comment on column forecasts.exceed_threshold is 'Alert threshold (city_config pollutant_thresholds) that exceed_prob refers to.';
comment on column forecasts.exceed_prob is 'Calibrated probability that the value at horizon_ts reaches exceed_threshold; null where the classifier showed no skill in validation.';
comment on column forecasts.severe_risk is '''elevated'' when a severe-level episode (PM2.5 >= 250) is plausible at horizon_ts; null otherwise.';
