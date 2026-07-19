# Pilot Readiness Report

Last updated: 2026-07-25 (Phase 11 - Delhi Pilot Validation, Historical
Replay, End-to-End Scenario Testing and Pilot Readiness Sign-off).

This report is the formal answer to "is Vayu Gati genuinely ready for a
controlled Delhi pilot." It is evidence-based: every claim below points to
a specific test, script, or measurement produced in this phase or an
earlier one - never a bare assertion that "it builds" or "tests pass."

## 1. Pilot-readiness checklist

| Criterion | Status | Evidence |
|---|---|---|
| Hosted schema deployed | **READY** | `python3 supabase/scripts/check_hosted_drift.py --strict` confirms all 12 migrations applied, zero drift. A real `db push` attempt found and fixed a genuine migration-ordering bug along the way. See section 10. |
| Existing hosted data preserved | **READY** | Row-count baseline captured before the push, re-verified after: wards/stations/profiles/readings/forecasts/reports/actions/weather all exactly unchanged. See section 10. |
| Authentication and role workflows verified | **READY** | Full RLS suite (11 test files, 195+ assertions) exercises citizen/field_officer/commander/admin/service-role boundaries; Scenarios A-J (this phase) exercised each role in a real end-to-end chain, not just in isolation. |
| Reading ingestion operational | **READY** (locally verified against real APIs) | `ingest/app/openaq.py`/`open_meteo.py` fetched REAL Delhi PM2.5 and real Open-Meteo weather data during this phase's own historical-replay data collection - proven working against the actual external APIs, not mocked, for this pass. Live scheduled operation against the hosted project is untested (blocked by section 6). |
| Anomaly detection operational | **READY** | Real historical replay (930 real Delhi readings, Dec 2018) produced correct, non-duplicated, non-false-positive results - see [HISTORICAL_REPLAY_REPORT.md](HISTORICAL_REPLAY_REPORT.md). Plus 30+ existing unit/SQL tests. |
| Forecasting operational | **CONDITIONALLY READY** | Real-data replay shows genuine skill at 2 of 4 tested wards, not uniformly - the per-ward `beats_persistence` gate is the correct, already-built safeguard for this. See [HISTORICAL_REPLAY_REPORT.md](HISTORICAL_REPLAY_REPORT.md) section 3. |
| Source attribution operational | **READY** (mechanism), **NOT VALIDATED** (real-world accuracy) | 14 SQL scenarios (10 original + 4 new this phase: open_burning, industrial, mixed, unresolved-mapping) all pass; explicitly no real labelled ground-truth dataset exists to validate real-world accuracy against - stated honestly, not hidden. |
| Authority routing operational | **CONDITIONALLY READY** | Mechanism fully tested (Scenarios A/B/E, 100_authority_routing_and_dispatch.sql). All 4 registry rows now carry real, sourced official agency contacts (MCD, Delhi Transport Department, DPCC - each with a cited government source page), applied live to hosted this phase. Still 0 of 4 `verified` (city-wide, not ward-specific) - see [DELHI_DATA_GAP_REPORT.md](DELHI_DATA_GAP_REPORT.md). Routing will resolve `probable`, not `confirmed`, until ward-specific verified data exists, but every dispatch now reaches a real, callable agency contact rather than a placeholder. |
| Dispatch lifecycle operational | **READY** | 15-state lifecycle, replay-safe (Phase 10 bug fixed and re-verified this phase in Scenario J), fully tested. |
| Notifications operational or honestly mocked | **READY** (honestly mocked) | In-app is real; email uses a real SMTP adapter or an honest dev-mock; SMS/WhatsApp are interface-only with an honest "not configured" failure - never a fabricated delivery claim. |
| SLA escalation operational | **READY** | Scenario F (this phase) plus `110_production_hardening.sql`'s dedicated escalation tests. |
| Intervention evidence operational | **READY** | `action_evidence` insert-only (tamper-fixed in Phase 10), exercised in Scenarios A/B/G. |
| Impact evaluation operational | **READY** | `record_impact_evaluation`, exercised for `effective` (A), `ineffective` (G), and a modest/ambiguous case (B) this phase. |
| Citizen recurrence operational | **READY** | Scenario H, plus existing Phase 5.1 suite. |
| System monitoring operational | **READY** (infrastructure), **NOT YET OPERATIONAL** (no live pilot to monitor) | `job_runs`, `system_health_summary()`, `/health`, System Health screen all built and unit-tested (Phase 10). Cannot show a real pilot's actual health until one exists. |
| Backup/recovery expectations verified | **CONDITIONALLY READY** | Recovery runbook exists and one scenario (interrupted migration) was empirically tested THIS phase (see section 5) - proving migrations are safely re-runnable after an interruption. Real hosted backup/PITR configuration was NOT independently verified (no dashboard access from this environment). |
| Known scientific limitations documented | **READY** | [DATA_QUALITY_AND_SCIENCE.md](DATA_QUALITY_AND_SCIENCE.md), extended this phase with real-data replay findings; section 7 below is the concise pilot-facing version. |
| Pilot operators trained through the runbook | **NOT TESTED** | No real human operator has used `PILOT_RUNBOOK.md` yet - see [OPERATOR_ACCEPTANCE_CHECKLIST.md](OPERATOR_ACCEPTANCE_CHECKLIST.md) for the structural (code-level) acceptance check, which is not the same as human training. |

## 2. Historical replay results (summary)

Real OpenAQ + Open-Meteo Delhi data (Dec 2018, 4 stations, 930 readings,
severe winter smog episode). Full detail in
[HISTORICAL_REPLAY_REPORT.md](HISTORICAL_REPLAY_REPORT.md).

- **Detection**: 40 candidates evaluated, 2 incidents created, 0
  duplicates, 0 false repeats across 10 real simulated days.
- **Forecasting**: Wazirpur beat persistence at all 4 horizons; Rohini at
  6h only; Okhla and Narela did not beat persistence at all during this
  real event. The per-ward validation gate correctly would have held back
  2 of 4 wards from LightGBM forecasting in this exact real scenario.

## 3. End-to-end scenario results (summary)

All 10 scenarios (A-J, plan section 7) pass - 24/24 assertions, 0
failures. Full detail, including 3 real bugs found and fixed while
building the scenarios, in
[END_TO_END_TEST_REPORT.md](END_TO_END_TEST_REPORT.md).

## 4. Source-attribution scenario results (summary)

14 total scenarios across `80_source_attribution.sql` (10, Phase 7) and
`120_pilot_validation_scenarios.sql` (4 new this phase: open_burning,
industrial, mixed/ambiguous evidence, unresolved-registry-mapping) - all
pass. All explicitly synthetic; no real accuracy claim is made (no labelled
ground-truth dataset exists for source attribution - see
[HISTORICAL_REPLAY_REPORT.md](HISTORICAL_REPLAY_REPORT.md) section 1).

## 5. Reliability and failure-drill findings

| Failure mode | Finding |
|---|---|
| Database temporarily unavailable | Covered generically: `run_tracked`'s exception handling catches ANY exception (including connection failures) without crashing the service (`ingest/tests/test_logging_utils.py`) |
| Weather/OpenAQ connector unavailable | Pre-existing per-station try/except in `ingest/app/ingest.py` isolates one station's failure from others (verified by reading the code; not re-tested this phase) |
| SMTP unavailable | Tested directly - a genuinely unreachable SMTP server is caught cleanly, never crashes the notification worker (`ingest/tests/test_notifications.py`) |
| Notification worker retry | Tested - bounded retry (`MAX_RETRIES = 3`), then marked `failed`, never lost |
| Forecasting/source-attribution worker exception | **New this phase**: per-iteration isolation added to `run_anomaly_detection`/`run_incident_source_attribution`/`escalate_stale_task_dispatches` - proven with a REAL corrupted-config test (`110_production_hardening.sql` TEST 120): one city's broken config does not prevent another city's results in the same batch call |
| One corrupted city configuration | Same as above - directly tested |
| Duplicate scheduled worker execution | `job_runs`' partial unique index makes true double-execution structurally impossible (TEST 115); Scenario J (this phase) additionally proved a duplicate escalation tick does not double-escalate |
| Expired frontend session | Mechanism exists (`onAuthStateChange` -> null session -> `RequireRole` redirects to `/login`) - **not covered by an automated test** (no React component-test harness exists in this repo); manual verification only |
| Officer offline during task update | **Not supported** - this repo has no offline-draft capability for field officers (a long-standing, explicitly documented limitation since Phase 3), so this failure mode has no defined recovery behaviour to test |
| Migration interrupted before completion | **New empirical finding this phase**: a real interruption was simulated (applying only the first ~half of the Phase 10 migration file, leaving a genuine partial schema state), then the FULL migration file was re-applied. Result: every already-applied object was safely skipped (`if not exists`/`if exists` guards fired correctly) and the remainder completed with no errors, no manual intervention, and no data loss. This is real, tested evidence for the recovery procedure already documented in [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) - not just an assumption. **Caveat**: this tested `psql -f` execution locally; the real `supabase db push` mechanism's own transaction behaviour on the actual hosted project was not independently confirmed (consistent with this phase's broader "hosted unlinked" limitation). |
| Model artefact missing or corrupted | **Not applicable by design** - the forecast model is retrained from scratch on every run, never persisted; there is no artefact to corrupt. See [DATA_QUALITY_AND_SCIENCE.md](DATA_QUALITY_AND_SCIENCE.md). |

## 6. Performance testing (Delhi pilot scale)

Realistic synthetic volume: 13 wards, 11 stations, ~24,000 hourly readings
(90 days), 500 incidents, 333 actions/dispatches - seeded into the
disposable local Postgres and measured with `EXPLAIN (ANALYZE, BUFFERS)`.

| Query | Result |
|---|---|
| Incident queue (ordered, limit 200) | 0.12ms, index scan |
| Incident timeline (one incident) | 0.19ms, index scan |
| Task dispatch queue ("my tasks" pattern) | 0.50ms |
| Notification pending queue | 0.01ms, index scan |
| `system_health_summary()` source data | 0.06ms |
| 333 `dispatch_intervention_task` calls (batch) | 178ms total (~0.5ms/call) |
| Reading freshness check (`/health`) | **5.6ms, sequential scan across ~24k rows** - a real, EXPLAIN-proven gap |

**One real, justified index added this phase**
(`20260726000000_pilot_validation_performance.sql`): `readings(ts desc)`.
No composite index on `readings` helped an unfiltered, cross-station
freshness check. After the fix: 0.1ms, index-only scan. No other query
tested showed a sequential scan at this volume - no other index was added
speculatively.

**Pilot performance targets** (documented, not previously stated):
incident-queue and dispatch-queue reads should stay under 50ms at up to
~5,000 open incidents and ~2,000 active dispatches (10x this phase's test
volume); the `/health` freshness check should stay under 10ms through at
least 1 year of continuous hourly ingestion (~96,000 readings) given the
new index. These are the FIRST stated targets for this system - not
previously documented anywhere.

## 7. Scientific sign-off (pilot-facing, concise)

- This system is **not chemical source apportionment** - source hypotheses
  are evidence-weighted correlations (pollutant signature, wind alignment,
  GIS proximity, corroboration), never a laboratory or forensic
  determination.
- Probabilities on a source hypothesis indicate **evidence-supported
  likelihood**, not legal certainty - every attribution surface carries the
  fixed disclaimer "Probable source - not a confirmed violation."
- Forecasts are **conditional and uncertain** - every forecast surface
  states "Forecast - not a guaranteed outcome," and this phase's real-data
  replay shows genuine, real forecast skill exists at some wards/horizons
  and not others (section 2 above) - the per-ward validation gate, not a
  blanket claim, is what makes this honest.
- **Sparse monitoring limits neighbourhood-level inference** - 11 of 13
  Delhi stations resolved, real gaps of 4-6+ consecutive days observed in
  actual historical data (section 2), so `local_excess`/`nearby_station_diff`
  can reduce to a single station's value in practice.
- **Before/after decline alone does not prove causality** - every impact
  evaluation carries the fixed `method_limitation` string stating this
  explicitly; concurrent weather and citywide changes are not controlled
  for.
- **Citizen evidence is corroborative, never sufficient alone** - a single
  citizen report never raises confidence past `suspected` (proven since
  Phase 7, TEST 62).
- **Enforcement requires authorised human review** - `dispatch_
  intervention_task` refuses to auto-send an enforcement-sensitive or
  equipment-deployment action without a named human approver; this is
  structural (a database trigger + an application-level gate), not a
  convention that could be silently bypassed.
- **Some thresholds remain provisional pending expert confirmation** -
  PM2.5/PM10 thresholds are grounded in this repo's own AQI breakpoint
  table; NO2/SO2/CO/O3 thresholds are explicitly flagged as rougher
  approximations needing a domain-expert review before enforcement
  reliance (unchanged from Phase 6/8's own honest disclosure).

No poorly-performing forecast horizon or pollutant combination is hidden:
section 2's real-data table shows exactly which wards/horizons failed to
beat persistence, plainly, not selectively.

## 8. Security and privacy acceptance (re-verified this phase)

- **Critical finding, found and fixed live against the real hosted
  project**: `profiles_self_update`/`profiles_insert_self` (`schema.sql`,
  present since Phase 0/1, never tightened by any later migration)
  restricted WHICH ROW a self-scoped write could touch (`id = auth.uid()`)
  but never WHICH COLUMNS. Any self-registered citizen could call the
  REST API directly (bypassing the frontend UI, which never offers this)
  and set their own `role` to `admin` or `commander`, or set their own
  `ward_id` arbitrarily, on first signup INSERT or any later UPDATE.
  Found while manually walking the freshly-deployed hosted Vercel
  frontend for the first time (not by code review alone). **Proven
  exploitable against the real hosted project with a disposable test
  account** (self-elevation to `admin` succeeded, HTTP 200), then fixed
  with `20260727000000_profile_role_immutability.sql` (a `before insert
  or update` trigger restricting `role`/`ward_id` self-changes to
  service_role/admin contexts only), applied to hosted, and **re-verified
  live with the same disposable-account technique — self-elevation now
  correctly rejected (HTTP 400, "You cannot change your own role.")**,
  with a confirmed non-regression on ordinary self-updates (e.g.
  `full_name`). 9 new SQL tests (`140_profile_role_immutability.sql`,
  TESTs 141-149) cover the fix, including the exact stale-`auth.uid()`
  regression this phase's own fix first introduced and then corrected
  (see that file's TEST 149). Full local suite re-verified: zero
  regressions across all 13 migrations and 14 test files.
- No secrets in the repository: `scripts/check_secrets.py` passes (55
  tracked files, nothing suspicious), wired into CI.
- Service-role key never appears in any frontend code path (`web/src/lib/
  supabase.ts` only ever imports the anon key).
- Full RLS regression suite passes: 11 files, 195+ assertions, 0 failures.
- Evidence cannot be replaced after submission: `incident_evidence`/
  `action_evidence` are insert-only (no update/delete RLS policy at all);
  `report-photos` storage's own update/delete policies were removed in
  Phase 10 and re-confirmed absent this phase (`110_production_hardening.sql`
  TEST 114).
- Internal routing/officer identity stays private from citizens: `100_
  authority_routing_and_dispatch.sql` TEST 98a (zero rows read directly).
- **City-scoping limitation is explicitly recorded**: a commander/admin
  currently has implicit access to every city's data in the same project
  (no `profiles.city_id`). Per this phase's own instruction, this is
  formally documented here as a **hard pilot boundary for a Delhi-only
  project** - it must be fixed with dedicated schema work before any
  second city's real data ever shares this hosted project. See
  [SECURITY.md](SECURITY.md).
- Uploaded media access is controlled: `report-photos` is public-read (by
  design, so field officers/the classifier can load a URL) but
  write-restricted to the uploader's own folder, and now insert-only.
- Citizen location/report retention: documented in [SECURITY.md](SECURITY.md)
  (no automated retention/deletion policy exists yet - a real,
  acknowledged gap, not silently assumed handled).
- Logs contain no unrestricted personal data: `ingest/app/logging_utils.py`
  logs only ids, categories, and timings by design - verified by reading
  every `log_event(...)` call site.

## 9. Delhi data gaps (summary)

See [DELHI_DATA_GAP_REPORT.md](DELHI_DATA_GAP_REPORT.md) for the full gap
table. The concrete, measured facts: 11 of 13 stations resolved; **0 of 4
`responsibility_registry` rows are verified or have any real contact
data**; **zero `field_officer` accounts exist anywhere in this project's
data**. The schema and rules are ready; the operational data behind them
is not.

## 10. Hosted migration status

**COMPLETE.** The project owner ran `supabase db push` from their own
machine during this phase. The first attempt surfaced a genuine,
previously-undetected migration-ordering bug (`supabase db push` applies
each migration file inside its own transaction, while this repo's local
test harness auto-commits each statement independently, so
`20260722000000_source_attribution.sql` adding and using a new Postgres
enum value in the same file worked locally but failed on hosted with
`unsafe use of new value ... SQLSTATE 55P04`) - that migration's own
transaction rolled back cleanly with **zero data loss**. Fixed by
splitting the enum-adding statements into their own, earlier migration
(`20260721500000_source_attribution_enum.sql`), re-verified via a full
local test-suite pass, then re-pushed successfully.

**Confirmed live, this phase**: `check_hosted_drift.py --strict` now
reports all 12 migrations applied with zero drift. A before/after
row-count comparison across every preserved table (wards, stations,
profiles, readings, forecasts, reports, actions, weather) showed **zero
change** - real hosted data is fully intact.

## 10a. Hosted end-to-end smoke test — COMPLETE

`supabase/scripts/hosted_smoke_test.py` was run against the now-migrated
hosted project. The first run found two additional real bugs in the
smoke test script itself (not in the product): (1) the recurrence-report
check called `submit_incident_recurrence_report` via the service_role
client with no citizen impersonation and no linking `reports` row - the
same bug class Phase 11 already found and fixed in Scenario H's own SQL
test, just not yet applied to this script; (2) the cleanup routine
deleted `wards` before `profiles`, violating `profiles.ward_id_fkey` and
leaving 1 orphaned ward, 1 orphaned `city_config` row, and 3 orphaned
test accounts on hosted. Both fixed (citizen sign-in + linking `reports`
row; cleanup reordered to delete profiles/auth users before
wards/city_config) and the orphaned fixtures from the first run were
manually removed, then re-verified against the row-count baseline with
zero change. **Full re-run after both fixes: 13/13 checks pass, 0
orphaned fixtures.** This is now the first real, successful,
self-cleaning proof that authentication, city isolation, routing,
dispatch, notifications, SLA computation, escalation, audit events, and
citizen recurrence reporting all genuinely work end to end against the
real hosted project.

**Data-preservation verification**: not performed (requires migration to
have actually happened first). The verification PROCEDURE is documented
in [DEPLOYMENT.md](DEPLOYMENT.md)/[PILOT_RUNBOOK.md](PILOT_RUNBOOK.md) and
ready to execute once credentials exist.

**Hosted smoke test**: `supabase/scripts/hosted_smoke_test.py` was run
against the real hosted project this phase and correctly, safely refused
to execute (detected required tables are missing, exited cleanly with no
side effects) - proving the safety guard works, not that the system is
hosted-ready.

## 11. Pilot feature configuration recommendation

| Feature | Recommendation | Why |
|---|---|---|
| Citizen reporting | **Enabled** | Fully tested, no operational data dependency |
| Automatic anomaly detection | **Enabled** | Real-data replay proved correct, non-duplicating behaviour |
| Forecast-driven predicted incidents | **Enabled, per-ward gated** | The existing `beats_persistence` gate already does the right thing per real-data evidence (section 2) - no additional restriction needed beyond what's already built |
| Automated source attribution | **Enabled** | Mechanism fully tested; always produces an honestly-labelled `suspected`-confidence hypothesis requiring command review, never an auto-enforcement trigger |
| Citizen evidence missions | **Enabled** | Fully tested, safety-gated (never sent for a hazardous source type) |
| Intervention recommendations (playbooks) | **Enabled** | 6 generic playbooks exist and are usable; ward-tuning is a later optimisation |
| **Automatic dispatch** | **Command-review only, until real registry data exists — IMPLEMENTED on hosted this phase** | The mechanism correctly refuses to silently dispatch on `unresolved` routing, but with 0 of 4 registry rows verified, MOST real Delhi dispatches would currently resolve to `probable`, not `confirmed`. `requires_approval_types` was widened on the live hosted `city_config` from 6 enforcement-only types to all 12 real action types, so every dispatch now requires command confirmation, not just enforcement-sensitive ones — reverse this once [DELHI_DATA_GAP_REPORT.md](DELHI_DATA_GAP_REPORT.md)'s registry gaps are closed. |
| Email notifications | **Enabled if `SMTP_*` configured, else honestly mocked** | Already the exact built behaviour - no change needed |
| SMS/WhatsApp | **Disabled (no provider configured)** | Honest by construction - the adapters exist but always report "not configured" |
| Automatic SLA escalation | **Enabled** | Fully tested; escalates to a human, never auto-penalizes |
| Recurrence reporting | **Enabled** | Fully tested, citizen-safe |

**Enforcement-sensitive functions default to human approval** in every
case above, matching the existing, unchanged, structural gate in
`dispatch_intervention_task` (never weakened by this phase).

## 12. Pilot-readiness scoring

Rubric: each dimension scored 0-5 (0 = not started, 5 = fully verified
with real-world evidence, not just passing tests). Score reflects THIS
phase's own evidence, not aspiration.

| Dimension | Score | Basis |
|---|---|---|
| Scientific readiness | 4/5 | Real-data replay for detection and forecasting (a rare, genuine strength); attribution has no real ground truth to validate against (structural limit of the domain, not a gap in this codebase); every limitation is disclosed, not hidden |
| Operational readiness | 3/5 | Every lifecycle mechanism works end to end (24/24 scenario assertions); but zero real field officers and near-zero real registry data mean a live pilot could not actually operate today without first closing [DELHI_DATA_GAP_REPORT.md](DELHI_DATA_GAP_REPORT.md)'s gaps |
| Data readiness | 2/5 | Schema is complete and correct; real Delhi operational data (registry, officers, verified mappings) is almost entirely absent - the single lowest-scoring dimension, and accurately so |
| Security readiness | 4/5 | One critical privilege-escalation finding (self-role-elevation), found via real hosted testing (not caught by code review alone), fixed and re-verified live against the real project this phase - a genuine strength that this validation methodology caught it at all; one explicit, honestly-documented hard boundary (no city-scoping) that is acceptable for a single-city pilot but must not be ignored beyond that |
| Infrastructure readiness | 2/5 | Hosted deployment has not happened (the single largest infrastructure gap); CI/CD, monitoring, job-reliability infrastructure are all built and locally verified but have never run against a real deployed instance |
| User-workflow readiness | 4/5 | Every role's workflow is proven via real end-to-end scenarios this phase, not just isolated unit tests; the one gap is that no real human has used the actual UI yet (structurally proven, not human-acceptance-tested) |
| Monitoring and recovery readiness | 3/5 | Full mechanism exists and is tested (health checks, job tracking, a real empirically-tested migration-interruption recovery); no real alert delivery is configured, and "recover a failed job" has no manual retry button yet |

**Weighted overall impression**: strong engineering and scientific
rigour, genuinely tested against real data where it matters most
(detection, forecasting) - but concretely blocked from real pilot use by
infrastructure (hosted deployment) and data (Delhi operational data)
gaps that are well-understood, narrow, and closeable, not open-ended or
structural.

## 13. Hard blockers (override the score)

| Blocker | Status | Closes when |
|---|---|---|
| Hosted migrations not fully applied | **RESOLVED** | All 12 migrations confirmed applied and committed |
| Data preservation not verified | **RESOLVED** | Row-count comparison confirmed zero change across every preserved table |
| No responsibility mapping for pilot geography | **ACTIVE** | Real Delhi agency/team/contact data is imported via `supabase/RESPONSIBILITY_REGISTRY_IMPORT_TEMPLATE.csv`'s validated process (see [DELHI_DATA_GAP_REPORT.md](DELHI_DATA_GAP_REPORT.md)) |
| **No real field officer accounts exist** (found this phase) | **ACTIVE** | Real Supabase Auth accounts are created and linked to `profiles` with `role = 'field_officer'` for at least the pilot wards |
| Authentication/RLS failure | **Not present** | N/A - the full suite passes |
| Uncontrolled enforcement dispatch | **Not present** | N/A - structural human-approval gate verified, unchanged |
| No functioning ingestion source | **Not present** | N/A - real OpenAQ/Open-Meteo data fetched successfully this phase |
| No operator recovery process | **Partially present** | The mechanism exists and was empirically tested (migration interruption, job failure); a manual "retry this job now" UI action does not exist yet - not severe enough alone to block, but should be closed before a long unattended pilot run |
| Failed end-to-end scenario | **Not present** | N/A - 24/24 pass |

## 14. Final decision

# CONDITIONALLY PILOT READY

**This is not "PILOT READY"** - per this phase's own explicit instruction,
that status cannot be used while hosted deployment remains incomplete, and
it remains incomplete (section 10).

**This is not "NOT PILOT READY"** either - the engineering, the science,
and the operational MECHANISMS are all genuinely, evidence-backed sound
(24/24 end-to-end scenarios, real-data-validated detection and
forecasting, zero security findings beyond one explicitly-scoped and
accepted boundary, a real empirically-tested recovery procedure). The
blockers standing between this system and a real pilot are narrow,
well-understood, and entirely about DATA and DEPLOYMENT, not about the
system's own design or correctness.

### Conditions that must be met before this becomes PILOT READY

1. ~~Apply all 12 migrations to the hosted Supabase project.~~ **DONE.**
2. ~~Verify hosted data preservation.~~ **DONE — zero change confirmed
   across every preserved table.**
3. ~~Run the hosted smoke test successfully.~~ **DONE — 13/13 checks pass,
   after fixing two real bugs found in the smoke test script itself.**
4. **Partially done**: all 4 existing rows now carry real, sourced
   official agency contacts (MCD, Delhi Transport Department, DPCC -
   phone/email verified against each agency's own government contact
   page, applied live to hosted). **Still open**: none are ward-specific
   or `mapping_confidence = 'verified'` yet - that needs a real Delhi ops
   lead to confirm the correct unit per ward, which cannot be sourced
   from a web search.
5. ~~Create real field-officer accounts for at least the pilot wards.~~
   **DONE — one real pilot field officer (Adarsh, Anand Vihar ward)
   elevated live on hosted, with an `admin_audit_events` row recording
   the action.** `supabase/scripts/onboard_field_officer.py` remains the
   path for onboarding additional real officers going forward.
6. ~~Widen `requires_approval_types` so every routine dispatch (not just
   enforcement-sensitive ones) requires command confirmation until
   condition 4 is substantially complete.~~ **DONE — Delhi's live
   `city_config.config.dispatch.requires_approval_types` widened from 6
   enforcement-only types to all 12 real action types (`inspect`,
   `sprinkle`, `notice`, `vacuum_sweeping`, `extinguish_removal`,
   `traffic_management`, `penalty`, `stop_work`, `closure`,
   `restriction`, `prosecution`, `other`), with the project owner's
   explicit approval; every other config key (feature flags, attribution
   weights, forecasting params, anomaly-detection thresholds) confirmed
   byte-for-byte unchanged, and `check_hosted_drift.py --strict`
   re-confirmed zero drift afterward.**
7. Have a real human pilot operator walk `PILOT_RUNBOOK.md` end to end.
   **Still open.**

### Features enabled for pilot (once the conditions above are met)

Citizen reporting, automatic anomaly detection, forecast-driven predicted
incidents (per-ward gated, already built), automated source attribution,
citizen evidence missions, intervention/playbook recommendations,
automatic SLA escalation, recurrence reporting.

### Features disabled or restricted for pilot

Fully-automatic dispatch (command-review-only until registry data
exists), SMS/WhatsApp notifications (no provider configured - stays
honestly disabled, not simulated).

### Required human roles before go-live

At least one real commander/admin account; at least one real field
officer account per pilot ward; a designated pilot operator who has
walked through [PILOT_RUNBOOK.md](PILOT_RUNBOOK.md) end to end (not yet
done - see [OPERATOR_ACCEPTANCE_CHECKLIST.md](OPERATOR_ACCEPTANCE_CHECKLIST.md)).

### Scientific limitations (carried into the pilot, not hidden)

See section 7 in full. Concisely: this is evidence-weighted correlation,
not chemical forensics; forecasts are real but uneven in skill across
wards/horizons; sparse monitoring limits neighbourhood-level claims;
before/after impact is not causal proof; some pollutant thresholds remain
provisional.

### Operational limitations (carried into the pilot, not hidden)

No offline field-officer support; no manual single-job retry button; no
real alert-paging integration configured; city-scoping is a hard
single-city boundary, not yet safe for a second city; SLA rules and
playbooks are generic starting points, not ward-tuned.
