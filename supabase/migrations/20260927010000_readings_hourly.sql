-- Real hourly concentrations, stored beside CPCB's AQI-window averages.
--
-- Since 2026-08-11 the primary source (data.gov.in CPCB) publishes only
-- AQI-window averages (24h; 8h for CO/O3) — see readings.value_basis. The
-- same stations' true HOURLY values reach us only through OpenAQ. They get
-- their own table rather than sharing `readings`: CPCB and OpenAQ rows for
-- one station often land on the same (station_id, ts), and `readings`
-- upserts merge columns, so one row would end up mixing hourly values with
-- 24h averages.
--
-- Units match `readings`: ug/m3, CO in mg/m3. ts = OpenAQ's reported
-- timestamp floored to 15 min, the same convention as readings' hourly rows.
create table if not exists readings_hourly (
  station_id  int not null references stations(id) on delete cascade,
  ts          timestamptz not null,
  pm25        double precision,
  pm10        double precision,
  no2         double precision,
  so2         double precision,
  co          double precision,
  o3          double precision,
  nh3         double precision,
  source      text not null default 'openaq' check (source in ('openaq')),
  ingested_at timestamptz not null default now(),
  primary key (station_id, ts)
);
create index if not exists readings_hourly_ts_idx on readings_hourly (ts desc);

alter table readings_hourly enable row level security;
-- Same posture as readings (schema.sql readings_read): any authenticated user
-- reads; no write policy — only the ingest service (service_role) writes.
drop policy if exists readings_hourly_read on readings_hourly;
create policy readings_hourly_read on readings_hourly for select using (auth.role() = 'authenticated');
