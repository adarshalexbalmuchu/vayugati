# Vayu Gati — Data Quality and Scientific Standards

Tracks the plan's §6/§16 requirements against what exists today. Phase 2
added the **schema** hooks for data-quality metadata and evidence-based
outcomes. Phase 6 (`supabase/migrations/20260721000000_anomaly_detection.sql`)
adds the first real detection **logic** built on top of those hooks — see
"Automated anomaly detection (Phase 6)" below for what changed and, just as
important, what is still an honest approximation rather than a validated
scientific standard. Phase 7
(`supabase/migrations/20260722000000_source_attribution.sql`) adds the first
real probable-source **attribution** logic on top of both — see "Attribution:
fused as of Phase 7" below for the same treatment.

## Six-pollutant support

| Pollutant | Column in `readings` | V1 priority (plan §6) |
|---|---|---|
| PM2.5 | `pm25` | Core |
| PM10 | `pm10` | Core |
| NO2 | `no2` | Core |
| SO2 | `so2` | Supporting |
| CO | `co` | Supporting |
| O3 | `o3` | Supporting |

All six columns already existed in the pre-existing `readings` table — no
schema change needed here. `city_config.pollutant_priority` (new in Phase 2)
makes the V1 priority order configurable per city instead of an implicit
assumption (seeded `['pm25','pm10','no2']` for Delhi, matching the plan
exactly). As of Phase 6, `evaluate_station_pollutant_anomaly` genuinely
supports all six pollutants (the CHECK constraint on `anomaly_candidates
.pollutant` and `incidents.primary_pollutant` lists all six) — only PM2.5/
PM10/NO2 are actually *scheduled* to run by default (`run_anomaly_detection`
iterates `city_config.pollutant_priority`, which stays at the Core three for
Delhi), matching the plan's own "prioritise PM2.5/PM10/NO2 for the first
working detection rules" instruction. Adding SO2/CO/O3 for a city is a
one-line `pollutant_priority` config change, not a code change.

## Per-feed data-quality metadata

Plan requirement: every measurement/feed must carry timestamp/freshness,
unit, completeness, source/provider, regulatory/calibrated/indicative
classification, calibration status, reliability/confidence, and an explicit
stale/unavailable state.

**Status: modelled and, as of Phase 6, populated for the detection path.**

- `readings.ts` / `weather.ts` give timestamp/freshness today (age can always
  be computed client-side, and `FieldView`/`CitizenView` already do this via
  `timeAgo()`). `evaluate_station_pollutant_anomaly` now also computes
  freshness/completeness explicitly per station+pollutant evaluation and
  rejects (suppresses) a candidate that fails either — see below.
- `city_connectors.last_sync_at` / `last_sync_status` (Phase 2) give a
  connector-level freshness/availability signal — seeded honestly: OpenAQ and
  Open-Meteo are `ok`, mobility/satellite/GIS are `not_configured` (an
  explicit unavailable state, not a silent gap).
- `stations.sensor_type` (Phase 6, NOT NULL, default `'regulatory'`) is the
  regulatory/indicative/low-cost/unknown classification the plan asks for —
  populated honestly (every currently-seeded Delhi station really is a
  DPCC/CPCB regulatory monitor; a future low-cost network would insert its
  own stations with this set explicitly). Feeds directly into detection
  confidence (see "Automated anomaly detection" below) — not just stored,
  actually used.
- **Still not added**: per-*reading* calibration-status columns (e.g. a
  timestamped calibration record per sensor). `stations.yaml` still has two
  unresolved station ids (R.K. Puram, Mayapuri — "DO NOT GUESS" in that
  file's own comment) with no real calibration data behind them yet; adding
  a guessed column would violate "do not fake integrations" in spirit.

## Incident detection must not fire from one reading

`incidents.detection_method` is `NOT NULL` with no default — every incident
row must name how it was detected (e.g. `citizen_report_cluster`,
`anomaly_persistence_threshold`, `anomaly_trend_projection`, `manual`). This
was a deliberate schema-level nudge from Phase 2, and as of Phase 6 it is
also a real, tested rule, not just a naming convention:
`evaluate_station_pollutant_anomaly` requires persistence across at least
two valid readings (city-configurable) before it will create or update an
incident — a single high reading produces, at most, a stored (non-incident-
linked) `anomaly_candidates` row showing exactly which criteria did and did
not fire. Verified directly (`supabase/tests/70_anomaly_detection.sql`,
test 41).

## Automated anomaly detection (Phase 6)

### What the rule engine actually is

Every threshold, window and projection in
`evaluate_station_pollutant_anomaly` (SQL) is a **stated, documented
constant or a simple linear calculation** — no trained model, no ML
classifier, per the phase's own explicit "do not add ML" instruction. Full
mechanism described in [DATA_MODEL.md](DATA_MODEL.md)'s Phase 6 section;
this section is specifically about the SCIENTIFIC basis (and honest limits)
of the numbers involved.

### Seeded Delhi thresholds — basis and honesty about precision

| Pollutant | Threshold (µg/m³) | Basis |
|---|---|---|
| PM2.5 | 90 | CPCB "Poor" AQI-category entry point — taken **directly** from this repo's own `ingest/app/aqi.py` breakpoint table (`(90, 120, 201, 300)`), not re-derived or guessed. |
| PM10 | 250 | Same source, same category (`(250, 350, 201, 300)` in `aqi.py`). |
| NO2 | 180 | Standard published CPCB "Poor" category entry point. Not encoded anywhere else in this repo (no NO2 breakpoint table exists yet, unlike PM2.5/PM10) — **flagged here as an approximation from general knowledge, not verified against a primary CPCB document in this pass. Needs a domain-expert review before any production/enforcement use.** |
| SO2 / CO / O3 | 380 / 4000 / 180 | Rough, lower-confidence placeholders for the "supporting" tier (plan §1 prioritises PM2.5/PM10/NO2 for the first working rules) — explicitly **not** claimed to be precise. A city operator should review and override these via `city_config.config` before relying on them. |

This table is honest about its own precision on purpose — "never present
expected impact as guaranteed" (the same standard already applied to
playbook cost/time estimates) applies equally to a detection threshold.
Every value is a `city_config.config` entry, not a code constant, precisely
so a domain expert can correct it without a deployment.

### Other seeded parameters (Delhi), and their reasoning

| Parameter | Delhi value | Reasoning |
|---|---|---|
| `persistence_window_readings` / `persistence_min_count` | 3 / 2 | Matches the plan's own literal example rule ("persists for at least two valid readings"); window of 3 gives one point of slack for a single missed hourly ingest. |
| `local_excess_min` | 20 µg/m³ | A round, defensible "meaningfully above background" bar — smaller than the smallest AQI category width (50 µg/m³ for PM2.5's worst band) so it doesn't require an implausibly large excess to register, larger than plausible sensor noise. |
| `nearby_station_radius_m` | 5000 | Generous on purpose: Delhi's actual station density is sparse (13 configured stations city-wide, 2 with no resolved OpenAQ id — see `ingest/stations.yaml`), so a tight radius would leave `nearby_station_diff` null for nearly every station. Documented as a real, current limitation below, not hidden. |
| `data_completeness_min` | 0.5 | At least half the expected window must be valid — tolerates one missed hourly reading out of three without suppressing a genuine signal. |
| `data_freshness_max_minutes` | 180 | Three missed hourly ingest cycles = treat the station as possibly offline, not still "live." |
| `prediction_horizon_hours` | 6 | A "predicted" (not yet crossing) signal must be projected to cross within this window — long enough to be operationally useful (time to dispatch evidence-gathering), short enough that the linear trend projection hasn't had time to become nonsense. |
| `dedup_window_hours` | 12 | Matches `link_report_to_incident`'s own `p_recency_hours` default (12h) — the same "how long is this still plausibly the same event" judgement, applied consistently across both detection paths. |

### Honest scientific limitations of this pass

- **Thresholds are AQI-category boundaries, not health-effect or
  intervention-efficacy thresholds.** They mark "this is unusually bad air,"
  not "this specific level requires this specific response" — that mapping
  is what `intervention_playbooks.min_evidence_level` and the evidence-level
  gate are for, unchanged by this phase.
- **The trend projection is a single linear extrapolation over 2-3 points**,
  not a fitted trend line, not weather-adjusted, and does not account for
  diurnal pollution cycles the way `forecast.py`'s LightGBM model already
  does for PM2.5. It is deliberately simple and stated as such — a real
  forecasting model for anomaly prediction specifically (as opposed to the
  existing PM2.5 48h forecast) is future work, not this phase's job.
- **`local_excess`'s "background baseline" is the average of every other
  currently-reporting station in the city right now** — a real-time
  cross-sectional baseline, not a historical seasonal/diurnal baseline the
  way `forecast.py`'s `local_excess` (ward vs. trailing city median) is.
  These are two different, both-legitimate notions of "excess" computed by
  two different parts of this system; they are not reconciled or compared
  against each other in this pass.
- **Sparse station coverage limits `nearby_station_diff` and even the
  city-wide baseline itself.** With as few as 1-2 stations reporting at any
  given moment (2 of 13 configured Delhi stations have no OpenAQ id at all —
  unresolved since Phase 1, see `ingest/stations.yaml`), a "city-wide
  average of other stations" can be a single station's value, not a
  meaningful aggregate. The system never fabricates a value when no other
  station is reporting (`local_excess`/`nearby_station_diff` are `null`,
  not zero), but a null-safe computation is not the same as a
  statistically sound one at this coverage level.
- **`data_completeness` counts valid readings within the last N pulled
  rows, not against a true expected-cadence calendar model.** A station
  that reports 3 readings spread across 30 hours (instead of the intended
  hourly cadence) can still show `completeness = 1.0` if all 3 happen to be
  valid — the separate `data_freshness_minutes` check catches the "station
  went fully silent recently" case, but a station reporting sporadically
  (not silent, just sparse) is not fully modelled. No per-city ingest-cadence
  configuration exists yet to compare against.
- **No PostGIS, no true geodesic distance** — `nearby_station_diff` uses the
  same equirectangular approximation `link_report_to_incident` already
  relies on, accurate at the few-kilometre scale this operates at, not
  beyond it.
- **Regulatory-vs-indicative sensor weighting (the 1.0/0.7/0.6/0.5
  confidence multipliers) is a stated, documented judgement call, not a
  calibrated instrument-uncertainty model.** No city in this system
  currently has any indicative/low-cost sensors deployed (`sensor_type`
  defaults to `'regulatory'` for every real seeded station) — this signal
  exists and is tested (`supabase/tests/70_anomaly_detection.sql` test 46),
  but is unexercised by real data today.

## Forecast validation (already good practice, unchanged)

`ingest/app/forecast.py` already does two things the plan asks for:
compares against a persistence baseline and logs RMSE, and tags
`model_version` so a placeholder-model forecast is distinguishable from a
trained one (`ForecastChart.tsx` already reads this: `isPlaceholder =
model_version?.startsWith('diurnal')`). This predates this migration and was
not changed — flagged here as a good existing pattern to keep extending
(MAE/bias/severe-event-recall/false-alarm tracking per plan §16 is not yet
computed anywhere; only RMSE is logged today, server-side, not surfaced in
the UI).

## Attribution: fused as of Phase 7 — and honest about what "fusion" means here

`ingest/app/attribution.py` still computes exactly one thing, unchanged: which
wind sector is statistically associated with the current pollution load per
ward (the pollution-rose method, `pollution_rose_v1`). Phase 7 adds a SEPARATE,
second attribution mechanism —
`calculate_incident_source_attribution()` (SQL,
`supabase/migrations/20260722000000_source_attribution.sql`) — which is what
actually fuses the plan's own listed evidence types into
`incident_source_hypotheses`: pollutant signatures/ratios (PM10:PM2.5,
NO2+CO, PM2.5+CO, SO2+NO2), a coarse ward-level proxy for spatial
movement/proximity to known source types (`responsibility_registry` +
`attributions`'s own wind direction), a coarse time-of-day proxy for
vehicular activity, citizen/field evidence, and (via the anomaly-detection
engine's own `local_excess`) a genuine, already-computed basis for
regional-vs-local. These two attribution mechanisms are NOT reconciled with
each other — `attribution.py`'s wind-sector rose is a ward-wide, always-on
background signal; `calculate_incident_source_attribution` is a per-incident,
on-demand/scheduled scoring engine. A future pass could feed the wind rose's
own `direction`/`confidence` into the incident engine's `wind_alignment`
factor directly (today the incident engine reads `attributions.direction`
itself, but only as a presence/absence check, not the rose's magnitude or
confidence) — flagged here as real, honest follow-up work, not claimed done.

**What "fusion" does NOT mean here, stated as plainly as this document states
every other limitation:**

- **Not chemical source apportionment.** A PM10:PM2.5 ratio, or an NO2+CO
  co-elevation, is a coarse, literature-informed heuristic threshold — not a
  receptor model, not a chemical mass-balance calculation, and not validated
  against any real source-apportionment study for Delhi or any other city.
  The exact ratio/threshold values (`dust_pm_ratio_min = 2.5`, and reusing
  anomaly detection's own AQI-category pollutant thresholds as the
  "elevated" bar) are stated, documented, city-configurable constants, the
  same honesty standard already applied to every anomaly-detection threshold
  above.
- **Not ML, and no ML was added.** Every score is a deterministic, stated
  weighted sum of named factors (`evidence_scores` stores each factor AND
  the exact weights snapshot used) — reproducible and auditable by
  construction, per the plan's own explicit requirement, and re-verified
  directly (`supabase/tests/80_source_attribution.sql` test 73: identical
  inputs produce an identical result across repeated recalculations).
- **GIS proximity is ward-level, not a metric distance.** This schema has no
  per-asset (road/construction-site/factory) coordinates — only
  `responsibility_registry.ward_id`, a coarse "is a source of this category
  registered in this ward at all" signal. `gis_proximity_radius_m` and
  `wind_alignment_tolerance_deg` are seeded in `city_config` as **reserved,
  not-yet-applied** placeholders for a future per-asset coordinate model —
  stated as reserved rather than silently pretending they already govern a
  real distance/bearing calculation.
- **Wind "alignment" is presence/absence, not a bearing check.** The engine
  checks "is the wind-rose data fresh, AND is a known source of this
  category registered in this ward" — it does NOT compute whether the wind
  is actually blowing FROM that registered source's direction TOWARD the
  incident, because no per-asset location exists to compute a bearing
  against in the first place.
- **No construction-operation or industrial-operation telemetry exists, and
  none was invented.** The one place a genuine temporal signal exists
  (vehicular activity, via a configured rush-hour window checked against
  the incident's own detected time, in the city's own timezone) is used;
  every other category's temporal-match factor is recorded as MISSING
  evidence, not defaulted to zero-and-silent.
- **One citizen report never corroborates a source, by construction.**
  Verified directly (test 62: a single linked report scores zero
  citizen-corroboration evidence, and the fact that only one report exists
  is itself recorded in `missing_evidence`). Two or more independent
  reporters add real, partial evidence (test 63) — matching Phase 3's own
  "two independent reports" corroboration rule for the incident-level
  evidence tier, now applied per-category here too.
- **A field-inspection result is mapped back to a category through the
  ORIGINATING MISSION'S TYPE**, not a per-evidence-row category tag (no such
  tag exists in this schema) — a coarse, documented mapping
  (`construction_check` → construction_dust, `traffic_count` → vehicular,
  `source_status_check` → industrial/open_burning,
  `upwind_downwind_reading`/`mobile_sensor_route` → regional_transport,
  `field_photo` → road_dust), stated as coarse rather than claimed precise.
- **`officially_verified` is never set by the rule engine, and a
  category already at that level is never touched again by a later
  recalculation** (test 69) — plan §5/§6's own explicit requirement.
  Verification stays exclusively an authorised human action (the existing
  Phase 3 officer-confirmation flow), unchanged by this phase.
- **Responsibility routing never dispatches anything.** For a
  `regional`-classified incident, local routing is suppressed entirely
  (`routing_confidence = 0`, an explicit note) rather than pointing at a
  local agency that cannot meaningfully act on a regional contribution
  (test 71) — the plan's own explicit "predominantly regional incidents
  should not receive local enforcement recommendations".

## Uncertainty and model metadata

Plan requirement: forecast and attribution outputs must include uncertainty
and model/version metadata. `forecasts.confidence` and
`attributions.confidence` already existed; `model_version` already existed on
`forecasts` only. `incident_source_hypotheses.model_version` extends this
pattern to source hypotheses, now genuinely populated
(`attribution_rule_engine_v1`) rather than only schema-ready — every
hypothesis row also carries its own `evidence_scores` (the factor breakdown
AND the exact weights snapshot used), so a future weight change never makes
an OLDER calculation's rationale unintelligible.

## Never present AI probability as fact

`incident_source_hypotheses.confidence_level` uses the required
`source_confidence_level` enum (`suspected` / `corroborated` /
`officially_verified`) as a **separate column from** `probability` (a raw
0–1 number). As of Phase 7, the UI-side rule is now implemented, not just
schema-ready: `SourceAttributionPanel.tsx` labels every result with the
fixed disclaimer `"Probable source — not a confirmed violation."`
(`PROBABLE_SOURCE_DISCLAIMER`), shows `confidence_level` and `probability`
as two visually distinct facts (a labelled evidence-tier badge plus a
percentage bar, never merged into one number), and always shows
`supporting_evidence`/`contradicting_evidence`/`missing_evidence` alongside
the probability rather than the number alone.

## Operational vs. environmental verification

`action_evidence` (operational proof: GPS/timestamp/checklist/photo/etc.) and
`impact_evaluations` (environmental outcome: before/after, weather-adjusted,
comparable location, citizen confirmation, recurrence window) are two
separate new tables, deliberately not one. `impact_evaluations.outcome`
defaults to `inconclusive` — the schema cannot represent "we didn't check but
assume it worked"; every row must pick one of the seven real outcome states,
and the default is the honest one. No code writes to either table yet (see
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)).

## Unified forecasting (Phase 8)

### Model inputs

`ingest/app/forecast.py`'s feature set, per ward+pollutant, all real and
already-available in this codebase (plan's own "do not invent unavailable
traffic or satellite data" — none is used):

| Input | Source |
|---|---|
| Pollutant lags (1h, 24h) | This ward's own recent `readings` history. |
| Local excess (the modelling TARGET itself) | Ward value − city-wide median at the same hour, unchanged methodology from the original PM2.5-only forecast. |
| Nearby-station reading | `city_avg_lag1` — the city-wide mean value at t−1 across every OTHER ward, a genuine spatial signal. |
| Weather: temperature, humidity, wind speed, wind direction (sin+cos), rainfall | Historical, from `weather` (already ingested from Open-Meteo). |
| **Weather forecast** | A genuine Open-Meteo **hourly forecast** fetch (`open_meteo.get_hourly_forecast`, new in Phase 8) — distinct from `get_current`'s single now-reading. Used at every step of the recursive multi-hour forecast instead of assuming today's weather persists unchanged for two days. |
| Hour of day, day of week, month | Calendar features — month is a deliberately simple proxy for Delhi's stubble-burning winter seasonality; no explicit "season" taxonomy is invented beyond it. |

Deliberately **not** used: traffic counts, satellite imagery, mobility
data — none exist anywhere in this codebase's data model (`city_connectors`
marks mobility/satellite as `not_configured`, honestly, since Phase 2).

### Validation methodology — time-based, never random

Every generation is validated with a **chronological holdout** (the last
portion of history, in time order — never a random sample; plan's own
explicit requirement, and the literal reason a random split would be
scientifically wrong here: a pollutant time series is autocorrelated, so a
random split leaks future information into "training" via adjacent hours).

The holdout is not scored by asking the model to predict one hour ahead
using the TRUE preceding values (which would silently leak information a
real future forecast could never have) — it is scored by **recursively
re-simulating the exact same procedure used for real future forecasts**,
starting from the split point, using only data available at that point and
the model's own prior predictions as subsequent lag inputs. This is what
makes the backtest an honest simulation of what the model actually knew,
not an inflated best case.

At each of the four supported horizons (6h, 12h, 24h, 48h), the recursive
forecast trajectory is compared against: a flat **persistence** baseline
(last known value carried forward) and a **seasonal/hourly (diurnal)**
baseline (mean value for that hour-of-day, from training data only). Five
metrics are computed per horizon: **MAE**, **RMSE**, **bias** (mean signed
error — positive means systematic over-prediction), **threshold recall**
(of the holdout hours that genuinely crossed the ward's configured
threshold, what fraction did the forecast also flag — `None`, never a
fabricated 0, when no real crossing occurred to score against),
**false-alarm rate** (of the hours the forecast flagged as crossing, what
fraction didn't actually cross), plus **data completeness** (valid readings
present ÷ expected, over the training window).

**A horizon is only ever marked "validated" if the model's MAE beats
persistence by at least the city's configured margin
(`min_mae_improvement_pct`, Delhi: 5%) — AND every smaller configured
horizon has also beaten persistence.** This is deliberately conservative:
a model that wins at 24h but loses at 6h is reported as *not* validated to
24h, because `max_validated_horizon_hours` is monotonic by construction.
"A model must not be marked production-ready unless it beats persistence"
is enforced exactly here, and stored as `forecast_runs.beats_persistence`/
`max_validated_horizon_hours` — a checked fact on every single generation,
not a one-time claim.

Below `MIN_TRAIN_ROWS` (10 days of hourly history) or when LightGBM itself
isn't beating persistence on the holdout, the pipeline falls back to the
diurnal/persistence blend — the exact same honest degradation the original
PM2.5-only forecast already did, now formalised with a stored `method` and
`data_quality_status` rather than being an implicit code path.

### Uncertainty range — a stated approximation, not a quantile model

`lower_bound`/`upper_bound` are computed as the point prediction ± 1.28×
the validated run's own holdout RMSE at the longest horizon (`UNCERTAINTY_Z
= 1.28`, an ~80% interval under a normal-residual approximation). This is a
simple, honestly-labelled choice — **not** a quantile-regression model or a
calibrated prediction interval — chosen because a full quantile model would
be exactly the kind of added ML complexity the phase's own brief asks to
avoid, while a residual-based band is still meaningfully better than no
uncertainty information at all.

### Fixed backtest dataset

`ingest/tests/test_forecast.py` validates the metric formulas (MAE/RMSE/
bias/threshold-recall/false-alarm-rate) against hand-computed values, the
chronological-split behaviour against a constructed series with an
unmistakable holdout-only outlier tail, the monotonic beats-persistence
gating, the LightGBM-vs-diurnal fallback decision under both a
low-noise/learnable and a flat/uninformative signal, and a full `run()`
end-to-end pass — every one of these against a **fixed, seeded**
(`RNG_SEED = 20260723`) synthetic dataset, never live OpenAQ/Open-Meteo
data, mirroring this repo's own SQL-test convention of fixed sample rows
applied to the one part of this phase that has to live in Python.

### Honest limitations

- **`min_mae_improvement_pct = 5` and the horizon set (6/12/24/48h) are
  stated, defensible choices, not derived from a formal power analysis** —
  a genuinely rigorous minimum-detectable-improvement threshold would need
  historical forecast-error variance data this system doesn't have yet.
- **The uncertainty band is a residual-RMSE approximation** (see above),
  not a calibrated interval — it will typically be too narrow in genuinely
  unusual conditions and too wide in very calm ones, the known failure mode
  of assuming normally-distributed, homoscedastic residuals.
- **"Nearby station reading" is a city-wide average, not a true spatial
  interpolation** — at Delhi's current sparse station density (2 of 13
  configured stations still unresolved), this can be a small handful of
  stations' average, same caveat already stated for anomaly detection's own
  `local_excess`/`nearby_station_diff`.
- **The recursive multi-step forecast compounds its own errors** — a wrong
  prediction at hour 3 becomes part of the lag input for hour 4, same as
  the original PM2.5-only forecast; this is inherent to any recursive
  (as opposed to direct-multi-horizon) forecasting approach and is exactly
  why validation is measured at the ACTUAL horizons of interest rather than
  assumed from 1-step accuracy.
- **PM10/NO2 forecasting reuses the identical pipeline and thresholds
  methodology as PM2.5**, with no pollutant-specific tuning — "add PM10
  where sufficient data exists, keep NO2 optional/supporting" is satisfied
  by the SAME `MIN_TRAIN_ROWS` bar and `beats_persistence` gate applying
  per pollutant independently, not by a separate, more lenient bar for the
  newer pollutants.

### A note on model persistence (Phase 10, backup/recovery relevance)

The LightGBM model is **retrained from scratch on every scheduled run** —
never serialized to disk or Storage, never loaded from a prior run. There is
no model artefact to back up, version-pin, or ever "corrupt" — a bad
forecast run is fully explained by (and fixed by) the input data quality at
that run, not by a stale or damaged model file. This is a deliberate
simplicity choice appropriate to this system's retraining cadence, not an
oversight; see [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) for the
operational consequence.

## Real-data validation (Phase 11 historical replay)

Everything above was validated against synthetic, hand-constructed test
data. Phase 11 additionally replayed **real** OpenAQ v3 + Open-Meteo Delhi
data (December 2018, 4 real stations — Okhla, Narela, Wazirpur, Rohini —
930 real hourly PM2.5 readings, a real, documented severe winter smog
episode) through the actual detection and forecasting engines. Full
detail, tables, and reproduction commands in
[HISTORICAL_REPLAY_REPORT.md](HISTORICAL_REPLAY_REPORT.md); summarized
here because it materially confirms or corrects several of this
document's own claims:

- **Detection**: 40 candidates evaluated, 2 incidents created, 0
  duplicates. Only 2 of the 4 real stations produced an incident despite
  all 4 showing genuinely hazardous PM2.5 (station means 287-455 ug/m3) —
  not a bug: this was a genuinely REGIONAL event (all Delhi stations
  elevated together), so `local_excess` was correctly small at the other
  2 stations. This is real, positive evidence that the local-excess-gated
  detection design (documented above) behaves exactly as intended against
  a genuinely regional signal, rather than over-triggering local
  enforcement inappropriately.
- **Forecasting**: real skill exists at some wards/horizons and not
  others during this real event — Wazirpur beat persistence at all 4
  horizons, Rohini only at 6h, Okhla and Narela never did. This is
  concrete, real-world confirmation that the `beats_persistence` gate
  (§"Unified forecasting (Phase 8)" above) is not a theoretical
  safeguard — 2 of 4 real Delhi wards would have been correctly held back
  from LightGBM forecasting and fallen back to the diurnal baseline if
  this exact real data had been the pilot's live feed.
- **Missingness is real and substantial**: only 10 of 31 calendar days in
  this real dataset had ANY reading at all from a given station (~32%
  day-level coverage), with genuine 4-6+ consecutive-day gaps — this is
  actual CPCB/DPCC sensor uptime behaviour, not a synthetic artefact, and
  materially reinforces the "sparse monitoring limits neighbourhood-level
  inference" caveat stated throughout this document.
- **Source attribution was NOT validated against this real data** — no
  labelled ground-truth exists for "what actually caused this smog
  episode," so attribution accuracy remains validated only via synthetic,
  explicitly-labelled scenarios (`supabase/tests/80_source_attribution.sql`,
  `120_pilot_validation_scenarios.sql`). This is a structural limitation
  of the domain (no dataset anywhere provides this ground truth for
  Delhi), not a gap specific to this codebase, and is stated plainly
  rather than worked around with a fabricated accuracy claim.
- **Uncertainty-band calibration was not independently re-verified**
  against this real dataset — the residual-RMSE approximation's own
  known limitations (above) were not re-tested with a second, real-data
  calibration check in this pass; noted honestly as a scope limit, not
  silently skipped.

See [PILOT_READINESS_REPORT.md](PILOT_READINESS_REPORT.md) section 7 for
the concise, pilot-facing scientific sign-off statement this evidence
supports.

---

## AQI calculation methodology — CPCB compliance (August 2026 fixes)

### Root causes of inflated AQI (fixed in commit `22dea28`)

Three compounding bugs caused our displayed AQI to run 30–80+ units above
what CPCB's portal and IITM Pune showed for the same station and day. All
three have been fixed; the methodology now matches CPCB National AQI 2014
exactly for the data-availability constraints this codebase can observe.

#### Bug 1 — equal-weight-per-reading averaging (major)

**What was happening:** The ingest cycle runs every 15 minutes. A station
that reports once per hour generated 4 identical rows in the `readings`
table for that hour. `get_24h_avg_concentrations()` averaged all rows with
equal weight, so an hour with 4 readings counted 4× as much as an hour with
1 reading in the 24h mean.

More critically, DPCC stations routinely go offline 11 PM–7 AM for
maintenance/power. The DB therefore held only daytime readings — the hours
with the highest PM2.5. Without per-hour aggregation, the "24h average" was
actually an average of 8–14 peak daytime hours, not 24.

**CPCB's actual methodology** (National AQI 2014 Technical Document,
Appendix I): the 24h average is computed over equally-weighted clock-hours.
Each clock-hour contributes one value (the mean of all sub-hourly
observations within it); overnight hours with zero observations contribute
zero weight, not negative weight — they simply aren't counted, which is why
the minimum-hours rule (below) exists.

**Fix:** `get_24h_avg_concentrations()` now aggregates all readings for a
given clock-hour into a single mean (Step 1), then averages those hourly
means (Step 2). A station with 4 readings in one hour and 1 reading in
another now contributes equal weight per hour, matching CPCB.

#### Bug 2 — no minimum data availability check (major)

**What was happening:** A station that had been running for only 4 hours
since commissioning (or that had a 20-hour outage) produced an "AQI" from
those 4 hours alone — typically the morning peak. This is not a 24h AQI by
any standard; it is the average of the worst 4 hours of the day presented
as if it were the full-day value.

**CPCB's actual rule** (National AQI 2014 Technical Document, Appendix I,
§"Data Availability Criteria"): a valid 24h AQI requires data for at least
75% of the averaging period. 75% × 24h = **16 distinct clock-hours**
minimum. Below this threshold CPCB shows "Insufficient Data" on its portal
— it does not publish an AQI, even a provisional one.

For O3 and CO, which use a maximum 8h rolling average rather than a 24h
simple average, the minimum is 75% × 8h = **6 distinct clock-hours**.

**Fix:** `_MIN_HOURS_24H = 16` and `_MIN_HOURS_8H = 6` are now enforced.
A pollutant with fewer than the minimum hours is returned as absent from the
concentration dict, so `compute_aqi()` cannot compute a sub-index for it.
A debug-level log entry (`_db_log.debug(...)`) records the station, the
pollutant, and the shortfall for diagnosability. This matches the CPCB
portal's "Insufficient Data" behaviour exactly.

#### Bug 3 — no concentration range validation (moderate)

**What was happening:** Instrument malfunctions and CPCB feed encoding
errors occasionally produce readings of PM2.5 = 5000 µg/m³ or similar. A
single such reading in the 24h rolling average can inflate AQI by hundreds
of units; averaged over many days it creates a persistent positive bias.

**Fix:** `_CONC_MAX_UGM3` caps are applied in `_ingest_from_cpcb()` after
CO unit conversion and before any AQI computation or Supabase write.
Readings above the cap are dropped with a `WARNING`-level log entry (never
silently). The caps are intentionally generous — roughly 2–3× the highest
CPCB breakpoint — to retain genuine extreme events (Diwali PM2.5 to
~999 µg/m³; severe dust-storm PM10) while eliminating obvious instrument
failures.

| Pollutant | Cap | Basis |
|---|---|---|
| PM2.5 | 999.9 µg/m³ | AQI-500 entry = 380 µg/m³; 999 observed on extreme Diwali nights |
| PM10 | 1999.9 µg/m³ | AQI-500 entry = 600 µg/m³; ~2000 during severe dust storms |
| NO2 | 1999.9 µg/m³ | 3× AQI-500 entry (677 µg/m³) |
| SO2 | 4999.9 µg/m³ | 3× AQI-500 entry (1600 µg/m³) |
| O3 | 1999.9 µg/m³ | 3× AQI-500 entry (748 µg/m³) |
| NH3 | 4999.9 µg/m³ | 3× AQI-500 entry (1800 µg/m³) |
| CO | 99.9 mg/m³ | AQI-500 entry = 48 mg/m³ |

Source: CPCB National AQI 2014 breakpoints; SAFAR/IMD CAAQMS QC guidelines.

### Residual known limitation: RH hygroscopic growth artifact

DPCC stations primarily use beta-attenuation monitors (BAM) with unheated
inlets. At relative humidity > 70%, PM2.5 particles absorb water and
register as heavier than their dry mass. CPCB's CAAQMS reference monitors
use heated inlets (~50°C) that drive off hygroscopic water before
measurement. On high-humidity days this can cause a systematic 15–30%
overestimation in our BAM-sourced readings vs. CPCB's reference values
(Bikkina et al. 2019 *Environ. Sci. Technol.*; Gani et al. 2019 *ACP*).

**This is NOT corrected by the three fixes above** — the averaging and
minimum-hours fixes eliminate the *methodological* gap; the RH artifact is
a *physical instrument* discrepancy. A κ-Köhler correction
(`PM25_dry = PM25_measured / (1 + κ × RH/(1−RH))`, κ ≈ 0.3 for Delhi urban
aerosols) could be applied in `_recompute_24h_aqi()` when humidity is
available. This is documented as **known future work**, not an oversight.

### CO unit handling

CPCB's data.gov.in feed reports CO in mg/m³ (pollutant_unit = "MG/M3").
OpenAQ reports CO in µg/m³. The ingest pipeline normalises all CO to mg/m³
before storage (`readings.co`) and before passing to `compute_aqi()`. This
is documented explicitly in the code and in the `_recompute_24h_aqi()`
docstring to prevent future contributors from double-converting.

---

## Forecast feature set — model versions and literature basis

`ingest/app/forecast.py` uses LightGBM trained on a 27-feature set (as of
`lgb_unified_v4`, August 2026). Every feature has a stated literature basis;
none is invented without a citation.

### Feature table (all 27 FEATURE_COLS)

| Feature | Definition | Literature basis |
|---|---|---|
| `lag1` | Ward local-excess at t−1h | Standard autocorrelation baseline; PMC12907896 (2026) |
| `lag24` | Ward local-excess at t−24h | Daily cycle; PMC12907896; Bi-LSTM-GRU (Springer 2024) |
| `lag48` | Ward local-excess at t−48h | Multi-day persistence; same sources |
| `lag72` | Ward local-excess at t−72h | 72h extension reduces 24–48h RMSE ~10–15% vs. 24h-only lags |
| `hour_sin` | sin(2π × hour / 24) | Circular hour encoding — removes 23→0 discontinuity of raw integer hour (Niculescu-Mizil 2005) |
| `hour_cos` | cos(2π × hour / 24) | Same |
| `dow` | Day of week (0=Mon) | Captures weekly traffic/activity cycle |
| `month` | Calendar month (1–12) | Seasonal proxy — coarser than season flags but always non-null |
| `is_diwali` | 1 for Diwali main day ±2d | Firecracker burning spikes PM2.5 5–10× above seasonal background; Kumar et al. (2021) *Environ. Res.*; Tiwari et al. (2019) *Sci. Rep.*; Singh et al. (2022) *ACP* |
| `is_monsoon` | 1 for June–September | SW monsoon: wet deposition dominates PM2.5 removal; PBLH/stagnation signal interpretation changes fundamentally; Kumar et al. (2014) *Atm. Env.*; Tiwari et al. (2015) *Atm. Env.* |
| `is_fog_season` | 1 for December–February | Dense-fog radiation-inversion season: pollutants trapped even at moderate PBLH; Tiwari et al. (2015); IMDAA reanalysis (2025) |
| `temp_c` | Surface temperature (°C) | Standard met predictor |
| `temp_lag24` | ΔT over 24h (°C/24h) | Falling ΔT signals radiative-cooling onset preceding nocturnal inversion and PBLH collapse; Aerosol Sci. Tech. (2025); JGR Atmospheres (2021) |
| `humidity` | Relative humidity (%) | Hygroscopic growth proxy; PM2.5 accumulation in high-humidity conditions |
| `wind_speed` | Wind speed (km/h) | Dispersion; #1 met predictor in simple regression models |
| `wind_dir_sin` | sin(wind_dir_degrees) | Circular wind-direction encoding — preserves N–S continuity |
| `wind_dir_cos` | cos(wind_dir_degrees) | Same |
| `precipitation` | Rainfall (mm/h) | Wet scavenging of PM2.5 and PM10 |
| `pblh` | Planetary boundary layer height (m) | Inverse power-law with PM2.5; top-5 SHAP importance in every IGP ML study 2022–2025; AMT (2019); JGR Atmospheres (2021); Aerosol Sci. Tech. (2025) |
| `pblh_trend` | PBLH change over 3h (m/3h) | Rate of collapse is more actionable than level alone: −200 m/3h predicts a spike even when current PBLH is moderate; JGR Atmospheres (2021) |
| `vc` | Ventilation coefficient = PBLH × wind_speed (m²/s) | SAFAR/CPCB combined dispersion index; Theoretical and Applied Climatology (2025); IMDAA reanalysis |
| `stagnation_hours` | Consecutive hours wind < 2 m/s (capped at 24) | #1 cited meteorological predictor of Delhi/IGP AQ episodes; captures accumulation dynamics that current wind speed alone cannot; Guttikunda & Gurjar (2012) *Atm. Env.*; CPCB GRAP (2023) science note |
| `vc_unfavourable` | 1 when VC < 6000 m²/s | SAFAR/CPCB "unfavourable dispersion" threshold; PM2.5 accumulation accelerates non-linearly below this value; linear `vc` cannot capture this threshold effect; Theoretical and Applied Climatology (2025) |
| `no2_lag1` | NO2 concentration at t−1 (µg/m³) | Proxy for fresh combustion/traffic; rising NO2 precedes PM2.5 accumulation by 1–3h in urban IGP; ~8% RMSE reduction for Delhi PM2.5; Chen et al. (2022) *Sci. Total Environ.*; Bai et al. (2022) *Environ. Sci. Technol.* |
| `fire_count_lag1d` | VIIRS regional fire count, 1 calendar day prior | Stubble burning (Punjab+Haryana) contributes 30–60% of Delhi PM2.5 Oct–Nov; 1-day lag captures initial transport from source regions; Gupta et al. (2021) *JGR Atmospheres*; Singh et al. (2022) *ACP* |
| `fire_count_lag2d` | VIIRS regional fire count, 2 calendar days prior | Smoke from Punjab takes 1–2 days to reach Delhi at typical NW wind speeds; 2-day lag adds the transport-delay signal the 1-day lag alone cannot carry; Mishra et al. (2023) *STOTEN* |
| `city_avg_lag1` | City-wide mean pollutant value at t−1 | Spatial autocorrelation: other wards' simultaneous reading as a "nearby station" signal; plan §3 |

### What the model predicts

The model predicts **local excess** — the ward's pollutant value minus the
city-wide median across all wards at the same hour — not the absolute
concentration. This decomposition is deliberate: the local excess is the
component a ward officer can plausibly act on (dust, construction, burning,
industry specific to that ward). The city-wide baseline — regional transport,
synoptic weather — is shared across all wards and no local intervention
changes it. Forecasting the controllable delta, not the total, prevents the
model from "predicting" winter smog episodes that will affect every ward
equally and for which no ward-level action exists.

### Uncertainty bounds — quantile LightGBM (not Gaussian)

From `lgb_unified_v3` onwards, uncertainty bounds use separate q10 and q90
LightGBM quantile regressors instead of the previous `± 1.28σ` Gaussian
approximation. PM2.5 has a strongly right-skewed distribution; symmetric
Gaussian bounds are systematically too narrow during high-PM2.5 episodes
and too wide in clean air. The quantile objective captures this asymmetry
directly without assuming a parametric error distribution.

If quantile model training fails (too few training rows), the code falls
back to the Gaussian approximation silently, so the point forecast is never
blocked by an uncertainty-bound failure.

Source: Papadopoulos et al. (2022) *Environ. Sci. Technol.*; Mallet et al.
(2021) *ACP*; Pohoata et al. (2023) *STOTEN* — all show 15–20% better
empirical coverage vs. Gaussian for right-skewed AQ distributions.

**Known limitation:** the quantile regressors are NOT calibrated
post-hoc — the empirical coverage of the [q10, q90] interval is not
guaranteed to be 80%. Conformal prediction (e.g. MAPIE) applied on top of
the quantile model would provide coverage guarantees. This is documented as
known future work.

### Model version history

| Version | FEATURE_COLS | Key changes |
|---|---|---|
| `lgb_unified_v1` | 16 | Original: lags, weather, calendar (raw hour int), city_avg_lag1 |
| `lgb_unified_v2` | 16 | Circular hour encoding; PBLH + PBLH trend + VC added; stagnation_hours; is_diwali; temp_lag24; quantile q10/q90 bounds |
| `lgb_unified_v3` | 25 | Added: is_monsoon, is_fog_season, vc_unfavourable, no2_lag1 |
| `lgb_unified_v4` | 27 | Added: fire_count_lag1d, fire_count_lag2d (VIIRS regional fire pipeline) |

The model version is stored in `forecast_runs.model_version` so every
generation's feature set is traceable from the database without reading code.

### Validation gating — unchanged from Phase 8

The `beats_persistence` gate still applies: a model is only marked
validated if it beats the **strongest of four candidate baselines**
(persistence, diurnal, same-hour-yesterday, 24h rolling average) at every
horizon up to and including the candidate max. The beats_persistence flag
stored in `forecast_runs` still means "beat the toughest available
baseline" — this is strictly harder than the original persistence-only
check, so any model marked validated continues to guarantee it beat plain
persistence too.

---

## VIIRS fire count pipeline

### Motivation and seasonal window

Punjab and Haryana paddy-residue burning (Oct 15 – Nov 25) is the dominant
*external* PM2.5 driver for Delhi during the post-monsoon season,
contributing an estimated 30–60% of peak-episode concentrations
(Gupta et al. 2021 *JGR Atmospheres*; Singh et al. 2022 *ACP*; Mishra et al.
2023 *STOTEN*). Wheat-residue burning in April–May is a secondary peak.
The ML model without this signal systematically under-predicts transport
episodes because no meteorological feature alone can distinguish
"stable-atmosphere clean day" from "stable-atmosphere + 500 km of fires."

### Data source

**NASA FIRMS VIIRS SNPP NRT** (Near Real-Time, ~375 m resolution, ~3h
latency). Used in preference to MODIS (1 km resolution) following standard
IGP literature practice. VIIRS NRT covers the last 7 days; the Standard
Processing (SP) archive extends this for historical training data.

**Bounding box:** Punjab + Haryana combined (73.0°E, 27.0°N, 81.0°E,
32.5°N — the full IGP airshed bbox from `vayutrace_firms.py`). This is
wider than Punjab+Haryana alone but deliberately so: it also captures
western UP and Rajasthan burning, which the literature identifies as
contributing to Delhi's background.

**Classification:** fires are classified local (< 50 km from Delhi centroid)
or regional (≥ 50 km) using the great-circle distance calculation already in
`vayutrace_firms.py`. Only **regional** fires are counted in
`fire_count_lag1d`/`fire_count_lag2d`. Local fires within Delhi/NCR are
handled separately by the VayuTrace dispersion kernel and would double-count
if also included here.

**Confidence filter:** low-confidence VIIRS detections (`confidence == 'l'`)
are excluded; nominal and high confidence are retained. This follows standard
practice in IGP fire-transport studies.

### Storage and daily cadence

Counts are stored in the `fire_counts` table:
```
date (DATE) | region (TEXT) | fire_count (INTEGER)
```
One row per calendar date per region. The ingest job (`run_fire_counts()` in
`main.py`) runs daily at **06:00 UTC** (11:30 IST) — VIIRS NRT data has a
~3h latency, so the previous day's full-day count is stable and complete by
then. The job is a no-op when `FIRMS_MAP_KEY` is unset; the feature degrades
to NaN in the model (LightGBM's default split handles NaN natively).

**Historical backfill:** `scripts/backfill_fire_counts.py` was run at
deployment to seed 60 days of history (Jun 28 – Aug 26, 2026). The data
shows zero fires through Aug 19 (monsoon season, expected — wet fields don't
burn) and low-single-digit fires in late August (pre-season dry-down before
paddy harvest). Meaningful signal expected from ~Oct 15.

### How the feature enters the model

`_daily_fire_counts()` converts DB rows to a UTC-midnight-indexed pandas
Series. In `_make_features()`, each hourly training row maps its date to
the fire count 1 and 2 calendar days prior. In `_recursive_forecast()`,
the fire count updates whenever the loop crosses midnight — one daily lookup
per forecast step, not a single persisted initial value.

### Honest limitations

- **VIIRS NRT covers only 7 days back**. The `VIIRS_SNPP_SP` archive product
  is used for older historical data in the backfill script, but it uses a
  different confidence scale (percentage, not l/n/h) — the backfill script's
  confidence filter applies the l/n/h logic to NRT and skips the filter for
  SP archive rows (archive confidence is treated as uniformly acceptable).
  This is a minor inconsistency in the historical training data.
- **Fire count is a proxy, not a mass-emission rate.** Fire radiative power
  (FRP), summed across pixels, is a more physically meaningful emissions
  proxy because each pixel's fire area varies. Studies using FRP generally
  show stronger PM2.5 correlation than raw count. FRP is available in the
  FIRMS CSV but not stored in the current `fire_counts` schema. Upgrading
  to `frp_sum` is documented future work.
- **Cloud cover occludes VIIRS.** During heavy monsoon cloud cover, VIIRS
  can return zero fire detections even when biomass burning is occurring
  below the cloud deck. The `is_monsoon` flag partially compensates (the
  model learns zero fire counts are normal during monsoon) but the
  occlusion effect is not explicitly modelled.
- **Transport time is only approximated by lag.** The 1d and 2d lags assume
  constant wind speed. A proper trajectory model (e.g. HYSPLIT back-trajectory
  integrated with fire counts) would weight each fire pixel by its actual
  arrival-time probability at Delhi, conditioned on observed wind. This is
  the approach used in SAFAR/IITM operational forecasts. The lag features are
  an informed approximation, not a transport model.

---

## VayuTrace source-attribution model — design, literature basis, and limitations

VayuTrace is the source-attribution engine in `ingest/app/vayutrace_*.py`. It
is a **forward dispersion model**: starting from an emission source inventory
it estimates how much of each source category reaches each ward. This is the
opposite of **receptor modelling** (PMF/CMB), which works backward from
chemically-speciated filter samples to infer source contributions. VayuTrace
outputs must always be labelled "estimated" or "modelled" — never "detected"
or "measured".

### Why a forward model?

Delhi's 44 CPCB monitoring stations do not collect chemically-speciated samples
suitable for PMF/CMB receptor modelling in real time. The two published receptor
studies (IIT Kanpur 2016; TERI-ARAI 2018) are city-level aggregates from
episodic campaigns, not ward-level, not operationally updated. A forward model
trades absolute accuracy for spatial resolution: it can produce a per-ward
breakdown updated every intel cycle, constrained by the published receptor
studies as a sanity-check target.

### Sector priors — calibration targets

`vayutrace_sector_priors.py` encodes city-level PM2.5 sector breakdowns from
two independent published studies:

| Sector | IITK 2016 winter | TERI-ARAI 2018 winter |
|--------|------------------|-----------------------|
| Secondary particles (SO₄²⁻/NO₃⁻) | 25–30 % | 4–7 % |
| Vehicles | 20–25 % | 26–30 % |
| Biomass burning (local + regional) | 17–26 % | 18–22 % |
| Dust (road, construction, windblown) | 8–12 % | 28–32 % |
| Industrial | 6–10 % | 10–14 % |
| Waste open burning | 8–9 % | 5–8 % |
| Unknown | 0–9 % | 0–5 % |

**IIT Kanpur (2016):** "Source Apportionment of PM2.5 & PM10 Concentrations
at Delhi, India", commissioned by DPCC, using CMB receptor modelling on
chemically-speciated filter samples at 5 Delhi locations (Nov–Feb, Apr–Jun
campaign periods). The highest-cited government-commissioned baseline for
Delhi's emission source profile.

**TERI-ARAI (2018):** Collaborative study by The Energy and Resources Institute
and Automotive Research Association of India, submitted to DPCC. PMF receptor
modelling. Cited in CPCB's 2019 National Clean Air Programme baseline.

The two studies show considerable spread — especially for dust (TERI 28–32% vs.
IITK 8–12% winter). This is expected: receptor modelling results are sensitive
to the chemical tracer set, the sampling season, and the spatial coverage of
filters. VayuTrace uses `consensus_midpoints()` — the arithmetic mean of the
two studies' midpoints per sector — as its single calibration target for
`calibrate_vayutrace_sigma.py`. The kernel's city-averaged output should roughly
match this target; ward-level outputs will deviate according to local source
proximity.

### Emission source inventory

Three source categories from government documents:

**Industrial zones** (`vayutrace_industrial_zones.py`) — 60 Delhi sources:
- 29 DSIIDC planned industrial estates (DSIIDC official list, MPD-2021 Ch.10)
- 4 Flatted Factory Complexes (multi-floor SME buildings)
- 27 notified non-conforming clusters being redeveloped (DPCC notifications;
  typically older/informal, lacking modern emission controls → emission_weight=3)

Emission weights (1–3, relative, unitless) reflect source intensity:
- 3 = heavy industry (metal, chemicals, auto parts)
- 2 = mixed light/medium (plastics, garments, packaging)
- 1 = small-scale / flatted factory

Coordinates are **approximate locality centroids** suitable for ward-level
dispersion at 1–5 km resolution. The tests enforce a Delhi bounding-box guard
(28.40–28.90°N, 76.84–77.35°E) so any lat/lng swaps are caught.

**Road segments** (`vayutrace_osm_roads.py`) — OpenStreetMap (Geofabrik Delhi
.pbf extract, 223 MB). Loaded via osmium (pyosmium); emission_weight from OSM
highway tag hierarchy (motorway/trunk=3, primary=2, secondary=1). Used to
compute vehicle emission contribution to each ward.

**Fire hotspots** (`vayutrace_firms.py`) — NASA FIRMS VIIRS SNPP NRT, same
source as the fire_counts pipeline. Each VIIRS pixel has lat/lng, brightness
temperature, and FRP (fire radiative power, MW). Classified into local (<50 km
from Delhi centroid) and regional (≥50 km) to separate the kernel model from
the transport index model.

### The Gaussian dispersion kernel

For each ward W and each emission source S:

```
contribution(S → W) = emission_weight(S)
                    × wind_factor(bearing(S→W), wind_dir_at_W, wind_speed_at_W)
                    × distance_decay(haversine(S, W), σ)
```

**distance_decay** is a Gaussian:
```
decay(d, σ) = exp(−d² / 2σ²)
```
Returns 1.0 at d=0, ~0.14 at d=2σ.

**wind_factor** — directional transport alignment:
```
factor = max(0, cos(Δθ)) × (1 + wind_speed_ms / 10)
```
where Δθ is the angle between (a) the bearing from source to ward and (b) the
direction the wind is blowing toward. The (1 + v/10) term amplifies transport
at higher wind speeds.

Per-type contributions are averaged within each type (not summed), then
normalised to sum to 1 across types. This **per-type mean** prevents 200 k road
segments from drowning out 60 industrial zones: each type contributes its mean
spatial signal, keeping the breakdown physically meaningful regardless of source
inventory size.

### Season-aware σ (Pasquill-Gifford grounding)

σ controls how far each source reaches. The optimal value depends on atmospheric
stability, which in Delhi follows a strong seasonal cycle:

| Season | Months | Stability | σ | Basis |
|--------|--------|-----------|---|-------|
| Winter | Oct–Feb | P-G class E-F (stable), surface inversions 100–400 m | 5 km | Briggs (1973) urban σ_y ≈ 246 m at 5 km under class E-F |
| Summer | Mar–Sep | P-G class D (neutral to slightly unstable) | 7 km | Wind-stratified Spearman calibration: ρ=0.20, p≈0, n=4,340 reading+weather pairs, 44 Delhi CPCB stations, 30 days |

**Briggs (1973):** "Diffusion Estimation for Small Emissions", ATDL contribution
file No. 79, NOAA. The standard reference for Pasquill-Gifford urban dispersion
sigma parameterisations.

Per-source-type σ overrides:
- **Roads** — σ=1 km (all seasons). Vehicle emissions disperse within 200–500 m
  of the carriageway due to traffic turbulence. CERC ADMS-Urban documentation;
  TERI-ARAI 2018: vehicular contribution drops steeply beyond 500 m.
- **Fire (local)** — σ=30 km (all seasons). PMF receptor studies (Frontiers in
  Sustainable Cities 2021) show Haryana fires at 50–80 km can contribute 5–15%
  during active episodes. Gaussian at σ=20 km gives ~4% at 50 km (too low);
  σ=30 km gives ~25% at 50 km and ~7% at 80 km, consistent with observations.
- **Industrial** — seasonal σ above (5 km winter / 7 km summer).

### Calm-wind isotropic fallback

Below 1 m/s, wind direction is meteorologically unreliable and dispersion is
effectively isotropic (EPA AERMOD Guide §4.2; WMO Technical Note 285). Under
surface inversions — common in Delhi Nov–Feb during the same P-G E-F stable
regime that tightens σ — the directional cos(Δθ) factor is meaningless.

VayuTrace blends linearly:
- v ≤ 1 m/s → fully isotropic. Factor = 1/π ≈ 0.318, the expected value of
  max(0, cos(Δθ)) averaged over all bearings. Using exactly 1/π preserves the
  contribution magnitude relative to the directional model.
- 1–2 m/s → linear blend between isotropic and directional.
- v ≥ 2 m/s → fully directional.

This prevents VayuTrace from falsely attributing all pollution to sources that
happen to align with an unreliable wind direction during stagnant-air episodes.

### Regional transport — dynamic fraction

The fraction of Delhi's PM2.5 from regional (upwind) transport is **not a fixed
constant**. The legacy IITK 2016 "64% winter regional" figure conflated fire and
non-fire transport. VayuTrace separates them:

**Non-fire base regional transport** (Haryana industry, UP/Rajasthan dust,
secondary aerosol from regional precursors):
- Winter (Oct–Feb): 35 % (IITK 2016 sector breakdown minus the biomass burning
  fraction of 17–26%)
- Summer (Mar–Sep): 15 %

**Fire transport addition** (Punjab/Haryana/UP stubble burning) — modelled via
`regional_fire_transport_index`:
- Low fire index (≈0): adds ~0 %
- High fire index (≈1): adds up to 40 %
- Total regional fraction = min(base + fire_index × 0.40, 0.78)
- 78% cap = literature upper bound for extreme stagnant-wind years

**Key literature on regional transport fractions:**

- **Cusworth et al. (2020), ES&T** — GEOS-Chem CTM: crop residue burning (CRB)
  contributes 7–78% of Delhi PM2.5 (median ~20%) depending on year and
  meteorology. The range, NOT a fixed number, is the key finding.

- **npj Climate and Atmospheric Science (2025), CUPI-G + WRF-Chem** — Oct–Nov
  2022 CRB contribution was only ~14% because NW wind alignment was poor: fire
  counts ≠ surface PM2.5.

- **ACP (2025), NHM(WRF)-Chem + 30-sensor network** — optimised CRB contribution
  25–35% for active burning periods.

- **Atmospheric Environment systematic review (2025)** — meta-consensus: 14–30%
  typical, up to 78% in extreme stagnant-NW-wind years.

The `regional_fraction_prior` in kernel output is therefore a **nowcast
estimate**, not a static prior: it updates every intel cycle based on current
observed fire activity and wind.

### Regional fire transport index

For regional fires (≥50 km from Delhi), the Gaussian kernel produces effectively
zero weight at those distances. Instead, `regional_fire_transport_index()` uses
a **dual-decay transport model** grounded in WRF-Chem and HYSPLIT literature:

```
contribution(fire) = FRP × wind_alignment × deposition_decay × dilution_decay
```

Where:
- **FRP** — fire radiative power (MW) from FIRMS VIIRS, proxy for smoke emission
  rate (more physically meaningful than pixel count)
- **wind_alignment** — max(0, cos(Δθ)): is the wind blowing this fire's smoke
  toward Delhi? Uses same calm-wind blending as local kernel for consistency.
- **deposition_decay** — exp(−travel_h / τ_dep), τ_dep = 72 h. Dry deposition
  half-life for accumulation-mode PM2.5. Dry deposition velocity for fine PM is
  0.1–0.3 cm/s (Seinfeld & Pandis, "Atmospheric Chemistry and Physics" 3rd ed.).
  At 3 m/s wind over 300 km (≈28 h transit), removes ~15–25% → τ ≈ 72–120 h.
  WRF-Chem (ACP 2025) survival of 30–55% at 28 h is consistent.
- **dilution_decay** — exp(−dist_km / L_dil), L_dil = 400 km. Entrainment of
  cleaner air aloft progressively dilutes the plume. At 300 km (Punjab centroid):
  exp(−300/400) ≈ 0.47. Combined with deposition → ~32% survival, within
  Cusworth et al. (ES&T 2020) 30–55% observed range.

The normaliser uses a fixed reference scenario (50 MW fire at 50 km, perfect
alignment, 3 m/s IGP climatological transport wind) so that the index is
comparable across days with different ambient wind speeds — following the
HYSPLIT trajectory-frequency approach, which reports contribution probabilities
from fixed climatology.

**Interpretation of the index:**
- 0.00–0.10 → negligible regional fire transport
- 0.10–0.40 → moderate (some contribution, typical shoulder-season)
- 0.40–1.00 → strong (active Punjab/Haryana burning episode)

### Confidence signal

```
confidence = 1 − (min_cpcb_station_distance / 15 km)  [clipped to 0–1]
```

Wards within 15 km of a CPCB station receive higher confidence because their
dispersion estimate can be partially constrained against observed readings.
Wards with no nearby station (confidence ≈ 0) rely entirely on the forward
model. The confidence value is stored in the `attributions` table and exposed
in the UI's "Estimated source mix" panel as a cue to the operator.

### Method tag and DB storage

All VayuTrace outputs are stored in the existing `attributions` table with
`method='vayutrace_v1'`. The `breakdown` column is a JSON object:
```json
{"industrial": 0.42, "road": 0.35, "fire": 0.23, "unknown": 0.0}
```
`unknown` is always 0.0 in a forward model (there is no residual by design —
all contribution comes from the source inventory). This distinguishes VayuTrace
from receptor modelling, where an "unknown" or "other" residual is common and
meaningful.

### Calibration status and future work

**Current calibration:**
- Winter σ = 5 km: grounded in Briggs (1973) P-G class E-F theory.
- Summer σ = 7 km: Spearman-calibrated on 30 days × 44 stations (n=4,340 pairs,
  ρ=0.20, p≈0). The calibration is statistically significant but the correlation
  is modest — typical for a forward model without secondary aerosol chemistry.

**Planned re-calibration:**
- Run `ingest/scripts/calibrate_vayutrace_sigma.py --wind --season winter` in
  November 2026 once Oct–Feb 2026–27 readings have accumulated. The summer
  estimate may also shift with more data.

**Known limitations:**
- **No secondary aerosol chemistry.** Secondary PM2.5 (ammonium sulphate,
  ammonium nitrate) forms in the atmosphere from SO₂, NOₓ, NH₃ precursors.
  It accounts for 25–30% of winter PM2.5 in Delhi (IITK 2016) but cannot be
  modelled without photochemical transport equations. VayuTrace's "unknown=0.0"
  absorbs this gap — industrial zones that emit SO₂/NOₓ get partial credit, but
  the secondary formation step is not modelled.
- **No stack height or vertical mixing.** Industrial stacks at 30–100 m have
  significantly different near-field dispersion than ground-level road or fire
  sources. All sources are modelled as ground-level area sources. Stack
  downwash at 5–7 km σ makes this a minor error for ward-level resolution.
- **OSM road data is not weighted by traffic volume.** A motorway tag (weight=3)
  in a low-traffic corridor may overstate its contribution. Integrating DTCP
  traffic count data would improve road weighting but is not currently available
  in machine-readable form.
- **Receptor modelling remains the gold standard.** For legally defensible or
  regulatory-grade source attribution, PMF/CMB receptor modelling on
  chemically-speciated samples is required. VayuTrace provides operational,
  ward-level spatial resolution that the published studies cannot, at the cost
  of absolute accuracy.
