-- ============================================================
-- weather — add `source` provenance column
--
-- Until now every weather row came from the same live path
-- (MET Norway for the met variables + Open-Meteo for PBLH), so
-- provenance was implicit and a column was unnecessary.
--
-- Sept 2026 introduces a second, fundamentally different path:
-- historical backfill from Open-Meteo's ERA5 archive
-- (scripts/backfill_weather_history.py), added because the
-- VayuTrace validation harness could only cover ~12 of 265 wards
-- — per-ward weather was extended from the original 13 "hotspot"
-- wards to all 265 only in Sept 2026, so there was no weather
-- history to validate the other wards against.
--
-- These two kinds of row must never be silently conflated:
--
--   'live'     — MET Norway forecast/nowcast + Open-Meteo PBLH,
--                written each ingest cycle. What the platform
--                actually runs on in production.
--
--   'era5'     — ECMWF ERA5 reanalysis, a MODEL RECONSTRUCTION of
--                past conditions on a coarse (~9-31 km) grid, i.e.
--                considerably coarser than a Delhi ward. Suitable
--                for model validation and as training history;
--                NOT an observation, and not interchangeable with
--                a live reading for operational display.
--
-- Defaulting existing rows to 'live' is correct: every row written
-- before this migration came from the live path by construction.
--
-- Nullable-with-default rather than NOT NULL so the migration
-- cannot fail on a large existing table, matching the additive,
-- idempotent style of the other weather migrations.
-- ============================================================

alter table weather
  add column if not exists source text not null default 'live';

-- Guard against a typo silently creating a third, unhandled class of row.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'weather_source_check'
  ) then
    alter table weather
      add constraint weather_source_check
      check (source in ('live', 'era5'));
  end if;
end $$;

comment on column weather.source is
  'Provenance: ''live'' = MET Norway + Open-Meteo PBLH written by the ingest '
  'cycle; ''era5'' = Open-Meteo ERA5 reanalysis backfill (model '
  'reconstruction, ~9-31km grid, NOT an observation).';

-- Validation and training queries routinely filter on this, and the
-- existing (ward_id, ts desc) index does not cover it.
create index if not exists weather_source_idx on weather (source);
