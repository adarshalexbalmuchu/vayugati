-- Model estimates of 24h PM2.5 / NO2 for every ward, including the ~226
-- wards with no monitor, with an honest 90% range.
--
-- estimate = c x N x R_w, where N is the live network's 24h mean, c calibrates
-- our stations to the 150 km training network, and R_w is the ward's usual
-- ratio to it (land use [+ power plants for PM2.5] + nearby-monitor
-- correction). Validated by 2 km-group CV on Indo-Gangetic-plain monitors,
-- daily: PM2.5 R2 0.72 (range x/2.0), NO2 R2 0.35 (range x/3.3). See
-- ingest/scripts/species/export_ward_model.py and app/ward_estimates.py.
create table if not exists ward_estimates (
  ward_id        int not null references wards(id) on delete cascade,
  pollutant      text not null check (pollutant in ('pm25', 'no2')),
  window_end     timestamptz not null,
  window_hours   int not null default 24,
  estimate       double precision not null,
  lower_90       double precision not null,
  upper_90       double precision not null,
  network_mean   double precision not null,
  n_stations     int not null,
  model_version  text not null,
  created_at     timestamptz not null default now(),
  primary key (ward_id, pollutant, window_end)
);
create index if not exists ward_estimates_latest_idx on ward_estimates (pollutant, window_end desc);

alter table ward_estimates enable row level security;
drop policy if exists ward_estimates_read on ward_estimates;
create policy ward_estimates_read on ward_estimates for select using (auth.role() = 'authenticated');
