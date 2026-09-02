-- Ward-level nowcasting (+1h). See docs/data/nowcast-shadow-review.md for
-- the release-gate criteria this schema exists to support.

-- ── Part A: select ONE nowcast point per generation cycle ───────────────────
-- The pipeline already writes 48 hourly forecast rows per ward+pollutant;
-- this flags exactly one of them (the row closest to generated_at + 1h,
-- within tolerance) as THE production nowcast point. Backend, frontend,
-- shadow logger and shadow scorer all read this flag rather than
-- independently recomputing "nearest to now" - a single source of truth.
alter table forecasts add column if not exists is_nowcast_point boolean not null default false;

create unique index if not exists forecasts_one_nowcast_point_per_run
  on forecasts (forecast_run_id)
  where is_nowcast_point;

-- ── Part D: production nowcast method selection, honest status fields ──────
-- Three separate facts rather than one overloaded "validated" boolean.
-- Populated only on the row where is_nowcast_point = true.
alter table forecasts
  add column if not exists nowcast_method text,
  add column if not exists nowcast_backtest_samples int,
  add column if not exists nowcast_backtest_passed boolean not null default false;

-- ── Part C: record every cycle's nowcast-generation outcome, including
-- failures - without this, "stale/unavailable rate" has no real denominator.
alter table forecast_runs
  add column if not exists nowcast_target_ts timestamptz,
  add column if not exists nowcast_valid_at timestamptz,
  add column if not exists nowcast_generation_status text check (
    nowcast_generation_status in (
      'available', 'missing_anchor', 'stale_anchor', 'no_point_within_tolerance', 'no_eligible_candidate'
    )
  );

-- ── Part C: forward shadow-accuracy log ─────────────────────────────────────
-- One row PER CANDIDATE method per cycle (not just the winner) - comparing
-- only a winner's error to itself is selection bias; every eligible
-- candidate is logged so any of them can be judged later against the same
-- matched real observations.
create table if not exists nowcast_shadow_log (
  id bigserial primary key,
  forecast_run_id bigint not null references forecast_runs(id) on delete cascade,
  ward_id int not null references wards(id) on delete cascade,
  pollutant text not null check (pollutant in ('pm25', 'pm10', 'no2')),
  candidate_method text not null check (
    candidate_method in ('lightgbm', 'persistence', 'diurnal', 'same_hour_yesterday', 'rolling_24h_avg')
  ),
  predicted_value double precision not null,
  lower_bound double precision,   -- null for candidates without a calibrated interval
  upper_bound double precision,
  valid_at timestamptz not null,  -- = the SAME horizon_ts as the is_nowcast_point row, never independently recomputed
  actual_value double precision,
  actual_observed_at timestamptz,
  scored_at timestamptz,
  unique (forecast_run_id, ward_id, pollutant, valid_at, candidate_method)
);
create index if not exists nowcast_shadow_log_ward_pollutant_valid_at on nowcast_shadow_log (ward_id, pollutant, valid_at);
create index if not exists nowcast_shadow_log_pending on nowcast_shadow_log (valid_at) where actual_value is null;
alter table nowcast_shadow_log enable row level security;
-- Ingest writes/reads via the service-role key, same as forecasts/forecast_runs
-- already do - no browser-facing policy added, the frontend never reads this table.

-- ── Part B: leakage-free periodic backtest results ──────────────────────────
-- Computed by ingest/scripts/nowcast_backtest.py (a separate, periodic job -
-- NOT run inside the hourly forecast cycle, which would be both leaky for
-- LightGBM and far too expensive to re-run 24x/day). Upserted per
-- ward+pollutant; the hourly cycle reads the latest still-fresh row here
-- (Part D) to decide which method to use for that cycle's nowcast point.
create table if not exists nowcast_backtest_results (
  ward_id int not null references wards(id) on delete cascade,
  pollutant text not null check (pollutant in ('pm25', 'pm10', 'no2')),
  computed_at timestamptz not null default now(),
  candidates jsonb not null,   -- {name: {mae, rmse, bias, coverage, avg_interval_width, sample_size}}
  best_candidate text,
  sample_size int not null,
  passed boolean not null default false,   -- sample_size >= threshold AND best_candidate beats the improvement bar
  model_version text not null,       -- which forecast.py model_version this backtest evaluated
  methodology_version text not null, -- bump when the backtest script's own methodology changes materially
  data_through timestamptz not null, -- latest history timestamp the backtest actually used
  primary key (ward_id, pollutant)
);
alter table nowcast_backtest_results enable row level security;
-- service-role only, same as nowcast_shadow_log - no browser-facing policy needed.
