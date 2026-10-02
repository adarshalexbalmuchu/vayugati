-- Forecast AQI per monitored ward, by CPCB's own rule: at each future hour,
-- the highest sub-index over the pollutants' 24h means (max 8h for O3/CO),
-- at least three pollutants including PM2.5 or PM10, 75% of hours present.
-- Observed hours up to the latest reading, forecast hours after it
-- (ingest/app/forecast_aqi.py). The range runs every pollutant along its
-- q10 / q90 forecast. Only the leads the backtest validated are written
-- (scripts/aqi_forecast_backtest.py -> data/models/aqi_forecast_gate.json).
--
-- One row per ward and lead: each run replaces the ward's rows, and a ward
-- whose readings are stale has its rows removed rather than left to look
-- current.
create table if not exists aqi_forecasts (
  ward_id             int not null references wards(id) on delete cascade,
  lead_hours          int not null check (lead_hours between 1 and 48),
  origin_ts           timestamptz not null,
  target_ts           timestamptz not null,
  aqi                 int not null check (aqi between 0 and 500),
  aqi_low             int not null check (aqi_low between 0 and 500),
  aqi_high            int not null check (aqi_high between 0 and 500),
  dominant_pollutant  text not null check (dominant_pollutant in ('pm25', 'pm10', 'no2', 'so2', 'co', 'o3', 'nh3')),
  model_version       text not null,
  generated_at        timestamptz not null default now(),
  primary key (ward_id, lead_hours),
  check (aqi_low <= aqi and aqi <= aqi_high)
);
create index if not exists aqi_forecasts_target_idx on aqi_forecasts (target_ts);

alter table aqi_forecasts enable row level security;
drop policy if exists aqi_forecasts_read on aqi_forecasts;
create policy aqi_forecasts_read on aqi_forecasts for select using (auth.role() = 'authenticated');
