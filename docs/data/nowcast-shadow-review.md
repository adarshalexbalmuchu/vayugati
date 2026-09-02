# Ward-level nowcasting (+1h) — shadow-accuracy release review

`NOWCAST_FEATURE_ENABLED` (`web/src/lib/nowcastConfig.ts`) gates the +1h mode
in both places it can be triggered — the Map toolbar and GeoAI's action
executor (`GeoAiPanel.tsx`). It stays `false` until this review's
pre-registered criteria are checked against real accumulated data and pass.
This is a manual, human-reviewed gate, not an automated statistical release
pipeline — appropriately scoped for a project at this size, but still a real
gate: flipping the flag is a documented decision recorded here, not a
one-off judgment call made after glancing at the numbers.

**The criteria below must be fixed before opening any query results.**
Choosing a threshold after seeing how the numbers look defeats the point of
pre-registration.

## Prerequisites before this review can run

1. `ingest/scripts/nowcast_backtest.py` has run at least once against real
   production data (`python scripts/nowcast_backtest.py`), populating
   `nowcast_backtest_results`.
2. The hourly forecast cycle (`forecast.run()`) has been live long enough
   for `nowcast_shadow_log` to accumulate real, scored (forward-looking)
   samples — not the retrospective backtest, the actual predict-now-score-
   later log. Recommended minimum: **7–14 days** of continuous operation.
   `MIN_NOWCAST_VALIDATION_SAMPLES = 72` (`ingest/app/forecast.py`) is
   typically reached in ~3 days per ward+pollutant pair, but the longer
   window buys coverage across more wards, weather conditions, and
   pollution episodes than the raw sample count alone guarantees.

## Pre-registered numeric criteria

| # | Criterion | Threshold | Why this number |
|---|---|---|---|
| 1 | Minimum matched (scored) shadow-log samples per ward+pollutant pair | ≥ 200 | Above `MIN_NOWCAST_VALIDATION_SAMPLES = 72` (the *backtest*'s bar) — forward shadow data is the stronger of the two evidence sources, so it gets a higher bar before a pair counts as reviewable. |
| 2 | Required improvement over the strongest baseline (for LightGBM to be the selected method) | Same `min_mae_improvement_pct` `_validate()` already uses elsewhere (`DEFAULT_MIN_MAE_IMPROVEMENT_PCT = 5.0` unless a city overrides it) | Reused, not reinvented — one definition of "genuinely better," not a second one specific to nowcasting. |
| 3 | Maximum acceptable bias | *Computed below, before opening results* | See "Deriving criterion 3" — grounded in each pollutant's actual historical hourly variance, not an arbitrary percentage picked in the abstract. |
| 4 | Interval coverage target | ~80%, computed only over rows/candidates with a real interval (never fabricated for a baseline) | Matches `UNCERTAINTY_Z = 1.28`'s already-implied 80% two-sided CI used elsewhere in `forecast.py`. |
| 4b | Average interval width | Reported alongside coverage, no fixed threshold | 80% coverage is trivially achievable with an unhelpfully wide interval — width is what reveals whether that happened. |
| 5 | Maximum stale/unavailable rate | < 10% of attempted cycles | Based on `forecast_runs.nowcast_generation_status` (`missing_anchor`/`stale_anchor`/`no_point_within_tolerance`/`no_eligible_candidate` vs. `available`) — the complete per-cycle denominator, not just successful attempts. |
| 6 | Ward/pollutant coverage required before flipping the flag | *Computed below, before opening results* | See "Deriving criterion 6" — set from existing data availability, not from how the nowcast happens to perform. |

### Deriving criterion 3 (bias threshold)

Before opening `nowcast_shadow_log`, run against real historical `readings`
(NOT shadow-log data) to compute each pollutant's typical hourly volatility:

```sql
select pollutant, stddev(value) as hourly_stddev
from (
  select r.pm25 as value, 'pm25' as pollutant from readings r where r.pm25 is not null
  union all
  select r.pm10, 'pm10' from readings r where r.pm10 is not null
  union all
  select r.no2, 'no2' from readings r where r.no2 is not null
) x
group by pollutant;
```

Record the three `hourly_stddev` values here, then set each pollutant's max
acceptable `|bias|` as **15% of its own `hourly_stddev`** — an explicit,
documented, arguable constant (same convention as `ACTIONABILITY_WEIGHTS` in
`actionabilityRules.ts`: a named number a reviewer can challenge, not an
implicit judgment call). Record the resulting three thresholds here before
proceeding to the shadow-log query below.

*(To be filled in at review time — leave blank until the query above has
actually been run against production data:)*

- pm25: hourly_stddev = ___, max |bias| = ___
- pm10: hourly_stddev = ___, max |bias| = ___
- no2: hourly_stddev = ___, max |bias| = ___

### Deriving criterion 6 (ward/pollutant coverage)

Before opening shadow-log results, compute what fraction of wards/pollutants
already have enough history to be `nowcast_backtest_passed`-eligible today
(independent of how well the nowcast performs):

```sql
select pollutant, count(*) as eligible_pairs
from nowcast_backtest_results
where sample_size >= 72  -- MIN_NOWCAST_VALIDATION_SAMPLES
group by pollutant;
```

Record the result here and set the required coverage fraction from it
(e.g., "at least 80% of the pairs already eligible per this query must also
pass the shadow-log review below") — again, set from what already exists in
the data, not from the forward-looking performance this review is about to
examine.

*(To be filled in at review time.)*

## The review query

Run once the prerequisites above are met and criteria 3/6 are recorded:

```sql
select
  s.ward_id,
  s.pollutant,
  s.candidate_method,
  count(*) filter (where s.actual_value is not null) as scored_samples,
  avg(abs(s.predicted_value - s.actual_value)) filter (where s.actual_value is not null) as mae,
  sqrt(avg(power(s.predicted_value - s.actual_value, 2))) filter (where s.actual_value is not null) as rmse,
  avg(s.predicted_value - s.actual_value) filter (where s.actual_value is not null) as bias,
  avg(
    case when s.lower_bound is not null and s.upper_bound is not null and s.actual_value is not null
      then (s.actual_value between s.lower_bound and s.upper_bound)::int
    end
  ) as interval_coverage,
  avg(s.upper_bound - s.lower_bound) filter (where s.lower_bound is not null) as avg_interval_width
from nowcast_shadow_log s
group by s.ward_id, s.pollutant, s.candidate_method
order by s.ward_id, s.pollutant, s.candidate_method;
```

Stale/unavailable rate, from `forecast_runs`:

```sql
select
  nowcast_generation_status,
  count(*) as cycles,
  round(100.0 * count(*) / sum(count(*)) over (), 1) as pct
from forecast_runs
where nowcast_generation_status is not null
group by nowcast_generation_status
order by cycles desc;
```

## Checklist (record the outcome of each check here)

- [ ] Backtest script has run at least once (`nowcast_backtest_results` populated)
- [ ] Shadow log has accumulated for at least 7 days
- [ ] Criterion 3 (bias thresholds) computed and recorded, before opening shadow-log results
- [ ] Criterion 6 (coverage requirement) computed and recorded, before opening shadow-log results
- [ ] Criterion 1: ≥ 200 scored samples for the pairs being enabled
- [ ] Criterion 2: any LightGBM selection genuinely beat the improvement bar (not just tied)
- [ ] Criterion 3: bias within the recorded pollutant-specific threshold
- [ ] Criterion 4: interval coverage ~80%, average width reported and judged reasonable (not suspiciously wide)
- [ ] Criterion 5: stale/unavailable rate < 10%
- [ ] Criterion 6: required ward/pollutant coverage met
- [ ] `NOWCAST_FEATURE_ENABLED` flipped to `true` in `web/src/lib/nowcastConfig.ts`, with a commit message referencing this checklist

## Release granularity

`NOWCAST_FEATURE_ENABLED` is a single **global** UI-capability flag — it does
not mean every ward individually passed. Per-ward/per-pollutant unevenness
is already handled gracefully by the existing suppression logic
(`nowcast_backtest_passed = false` → "Not yet validated for this ward —
showing the conservative baseline" caveat in `NowcastBlock.tsx`; an unusable
anchor → "Nowcast unavailable"). A ward that hasn't individually cleared
validation degrades honestly rather than needing its own separate flag.
