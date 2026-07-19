# Vayu Gati — Implementation Status

Last updated: 2026-07-25 (Phase 11 — Delhi pilot validation, historical
replay, end-to-end scenario testing and pilot readiness sign-off).

This is the living status document required by the migration brief. It is
the single place to check "what actually works right now" before trusting
any other doc's forward-looking language.

**A note on phase numbers**: [VAYU_GATI_MIGRATION_AUDIT.md](VAYU_GATI_MIGRATION_AUDIT.md)
§10 laid out a six-phase roadmap where "scientific adapters" was Phase 4 and
"verified mitigation" was Phase 6. The phases actually delivered are numbered
by the work session that requested them, which compressed that roadmap
differently — this document's "Phase 4" is intervention + impact evaluation
(closer to the audit's Phase 5/6 content), and "Phase 5" here is intervention
*playbooks* (plan §13), not the audit's Phase 4 (pollutant data-quality
metadata, connector interfaces), which remains undone and is still accurately
described as future work wherever [ARCHITECTURE.md](ARCHITECTURE.md) mentions
it. Flagged here once, plainly, rather than silently leaving two documents
disagree about what a given "Phase N" means.

## Completed in earlier passes

### Phase 0 — Audit
- [docs/VAYU_GATI_MIGRATION_AUDIT.md](VAYU_GATI_MIGRATION_AUDIT.md): full
  stack/route/DB/RLS/integration/workflow/component/debt/gap audit + phased
  plan + rollback strategy.

### Phase 1 — Professional application shell
- Design tokens (`web/src/design/tokens.ts`, `web/tailwind.config.js`), the
  shared role-aware `AppShell` (top bar + icon rail), and shared state
  primitives (`ErrorState`, `StaleBadge`, `PartialDataBadge`,
  `UnavailableBadge`, `OfflineBanner`) in `web/src/components/ui.tsx`.

### Phase 2 — Incident-centred schema (safest slice)
- `supabase/migrations/20260717000000_incidents_core.sql`: the additive
  incident schema (11 tables, 6 enums, nullable link columns), full RLS,
  Delhi seeded as the first City Pack. Schema only — nothing read or wrote
  it from the app.

### Phase 3 — Incident workflow vertical slice
A citizen report becomes (or joins) an incident, which command can work, an
officer can gather evidence for, and the citizen can follow, with the
evidence-level rules (suspected/corroborated/officially_verified) enforced in
the database. Full detail in git history / the Phase 3 pass of this document;
summarized here as background for Phase 4:
- `supabase/migrations/20260717010000_incident_workflow.sql`: workflow
  columns, `link_report_to_incident()` (the transparent match-or-create rule,
  atomic under a ward advisory lock), `list_assignable_officers()`,
  `list_my_citizen_missions()` / `submit_citizen_verification()`, and the
  `enforce_incident_action_rules` trigger.
- `web/src/lib/incidents.ts` / `incidentRules.ts` / `useAsync.ts`: the typed
  data layer, pure rule functions, and shared loading/stale/error state hook.
- Command `/incidents`, field `/missions`, and citizen incident-linkage +
  safe verification surfaces.
- Two RLS bugs found by executing the policies as `authenticated` (not by
  reading them): a citizen's own `UPDATE reports.incident_id` silently
  affected 0 rows, and a citizen assignee could read `evidence_missions
  .rationale` (an internal note) even though no screen displayed it. Both
  fixed — see [DATA_MODEL.md](DATA_MODEL.md) Phase 3 section.

### Phase 4 — Intervention and verified mitigation

The vertical slice: **an incident-linked intervention now runs end to end from
creation → approval → field completion → a transparent before/after impact
evaluation → command reopen/close — with "action completed" and "pollution
reduced" kept structurally distinct throughout, enforced by the database, not
just the UI.**

### Schema (additive) — `20260718000000_intervention_and_impact.sql`
- **New enum** `action_workflow_status` (11 states: 7 operational
  `drafted…verification_pending`, 4 outcome `effective…inconclusive`, plus
  `reopened`) on a **new** column `actions.workflow_status`. The pre-existing
  `actions.status` (`report_status` enum, read by the legacy non-incident
  action queue in `FieldView`) is untouched — this is a genuinely new column,
  not a repurposed one.
- New columns: `actions.recommended_action/responsible_agency/deadline/
  expected_verification_hours/accepted_at/started_at/completed_at/
  source_confirmed/not_completed_reason`; `impact_evaluations
  .observation_window_hours/station_label/data_completeness/pct_change/
  method_limitation`.
- **`enforce_incident_action_rules`** (replaces the Phase 3 function):
  creation gate now applies only at creation (a later evidence-level
  downgrade can't retroactively block a routine update); **new** — refuses to
  write an *outcome* state onto an action unless an `impact_evaluations` row
  already exists for it.
- **`enforce_incident_closure_rules`** (new trigger, on `incidents`): refuses
  to close an incident that has a `completed`/`verification_pending` action
  with no impact evaluation. The literal database enforcement of "must not
  close merely because an action photo was uploaded."
- **`record_impact_evaluation()`**: the transparent before/after method.
  Outcome is computed **server-side** from the readings — there is no
  parameter a client can set to claim "effective". Missing readings or
  completeness below 50% always yields `inconclusive`. RLS restricts the
  write to commander/admin (verified: a field officer's own call is
  rejected). Moves the incident to `verifying`, never auto-closes.
- **`submit_citizen_action_verification()`**: records a citizen's confirmation
  as supporting `incident_evidence` only; structurally cannot set an outcome
  or touch `source_confidence` (verified: recording an evaluation, then a
  citizen answer, then re-reading the evaluation shows it unchanged).

### Typed data layer
- `web/src/lib/incidents.ts` gained: `listInterventions` /
  `listInterventionsForOfficer`, `createIntervention`, `approveIntervention`,
  `assignIntervention`, `advanceIntervention`, `submitFieldCompletion`,
  `recordImpactEvaluation`, `listImpactEvaluations`, `reopenIncident`,
  `closeIncident`, `submitCitizenActionVerification`. `IncidentDetail` now
  also carries `interventions` and `impactEvaluations`.
- `web/src/lib/incidentRules.ts` gained the operational/outcome status split
  (`OPERATIONAL_STATUSES`/`OUTCOME_STATUSES`, mutually exclusive by
  construction and unit-tested to stay that way), `nextOperationalStatus`
  (the one legal next step — a client-side discipline, not a DB constraint,
  see Limitations), `previewImpactOutcome` (kept in lockstep with the SQL
  rule so the command form can preview before submitting), and
  `citizenActionVerificationSafety` (reuses the Phase 3 safety gate exactly).
- `database.types.ts` regenerated from the verified schema (all four
  migrations applied to a disposable Postgres, test helpers absent from the
  generation source).

### Surfaces
- **Command** `/incidents`: new `InterventionPanel` between the incident
  header and the source-evidence panel — create (gated by evidence level,
  same as Phase 3's routing gate), approve, assign, advance one step at a
  time, record a before/after impact evaluation with a live preview, see
  every recorded impact result and every citizen action-verification answer.
  Incident header gained Reopen (shown once closed) alongside Close.
- **Field** `/missions`: new "Interventions assigned to me" card, separate
  from the evidence-mission card (a distinct task type). Completion form:
  start/completion time capture, source-confirmed toggle, action-performed
  text, the existing per-source checklist, **multiple** geotagged photos, and
  a required reason when the action could not be completed. Never offers an
  outcome — only operational states.
- **Citizen** `/citizen`: `CitizenActionVerificationCard` under each linked
  incident, shown only once the public status suggests an action exists and
  gated by the same safety rule Phase 3 built (never asks when closed or when
  air is currently severe). Five answers (completed/partial/not completed/
  problem remains/problem returned), recorded as supporting evidence only.

### Phase 5 — Intervention playbooks

The vertical slice: **free-text intervention creation is replaced by
structured, source-specific playbooks — ranked and eligibility-filtered
against the incident's evidence level, source, city and local/regional
classification by a transparent, no-ML rule — while every existing
approval/evidence-level/human-approver gate from Phase 3/4 keeps applying
unchanged, plus one new database rule that closes a real gap: a playbook
cannot be used below the evidence tier it claims to need.**

### Schema (additive) — `20260719000000_intervention_playbooks.sql`
- Reuses the **existing** `intervention_playbooks` table (Phase 2 schema,
  never before populated or read) rather than a parallel table. New columns:
  `action_type` (NOT NULL, CHECK-constrained), `responsible_agency_type`,
  `instructions`, `estimated_cost_min`/`estimated_cost_max` (a cost *range*;
  the old singular `estimated_cost` is left in place, unpopulated),
  `expected_time_to_effect_hours`, `verification_window_hours`,
  `recommended_pollutants`, `for_regional` (+ a CHECK pairing it with
  `source_category is null`), `version`, and `slug` (nullable UNIQUE — the
  natural key that makes the seed inserts idempotent).
- New columns on `actions`: `playbook_id`, `playbook_version` (a snapshot),
  `playbook_notes_override` (the commander's *only* editable field when using
  a playbook), `checklist_snapshot` (a snapshot of the playbook's checklist,
  verified stable under a live playbook edit — test 22d).
- **`enforce_incident_action_rules`** (replaces the Phase 4 function again):
  adds one check — an action referencing a `playbook_id` must have an
  incident whose `source_confidence` meets or exceeds that playbook's
  `min_evidence_level`. Verified isolated from the pre-existing
  enforcement-type gate (test 21d: a *non*-enforcement action type from an
  over-tiered playbook is still refused) and verified NOT to weaken that
  gate (test 21e/21f: the enforcement-tier seeded playbook still needs a
  named approver regardless of playbook use).
- Seeded 6 Delhi playbooks (road dust, construction dust, open burning,
  vehicular, industrial — the one enforcement-tier example, and a regional
  advisory-only protocol), city-scoped via `city_config`, not hardcoded into
  any code path.
- No new SQL function: listing/ranking is read-only and lives entirely in
  TypeScript (see below) — the DB gained one trigger check, nothing else.

### Typed data layer
- `web/src/lib/incidentRules.ts` gained: `CONFIDENCE_RANK`/`meetsEvidenceLevel`
  (ordinal comparison mirroring the Postgres enum's own declaration order),
  `isPlaybookEligible`, `scorePlaybook`/`rankPlaybooks` (5 weighted, documented
  factors — source match, evidence-level fit, urgency-vs-timing, cost,
  resource availability; **affected population is accepted but never
  scored** — no exposure/population data exists in this codebase, and
  inventing a number would violate the "do not fake integrations" rule),
  `tallyPlaybookUsage` (read-only usage-metric aggregation), and
  `parseChecklistSnapshot` (validates a jsonb checklist snapshot, failing
  safe to the hardcoded per-category checklist on any malformed shape).
- `web/src/lib/incidents.ts` gained: `listPlaybooksForCity`, `getPlaybook`,
  `buildPlaybookRankingContext`, `createInterventionFromPlaybook`,
  `fetchPlaybookUsageWorkflowStatuses`/`fetchPlaybookUsageBatch` (the latter
  batched — one query for a whole ranked list, not one per row).
- `database.types.ts` regenerated from the verified schema (all four
  migrations applied to a disposable Postgres; a stray `Connecting to ...`
  line that leaked from the CLI's stderr into an earlier capture was caught
  and removed before installing the file — verified byte-identical to a
  clean stdout-only regeneration afterward).

### Surfaces
- **Command** `/incidents`: the Intervention panel's "+ New intervention"
  now opens `PlaybookPickerDialog` first — a ranked list with plain-language
  reasons, cost range, deploy/effect time, verification method, evidence
  basis, known limitations, and usage history per candidate, one "Operational
  notes" field to edit, and a "Use a custom intervention instead" link that
  falls through to the unchanged Phase 4 free-text dialog. `InterventionCard`
  now shows which playbook (and version) an intervention came from.
- **Field** `/missions`: the completion form now prefers `checklist_snapshot`
  over the hardcoded per-category checklist when an intervention came from a
  playbook, and shows the playbook's `required_proof`/`verification_method`
  as hints plus any commander note.
- **Citizen**: unchanged — citizens have zero RLS read on
  `intervention_playbooks` (verified for the first time this pass, tests
  24–25), so nothing playbook-related is exposed to them, directly or
  indirectly.

### Phase 5.1 — Citizen recurrence reporting and custom-intervention hardening

The vertical slice: **a citizen linked to a closed incident can report that
the problem returned — without ever automatically reopening the incident or
creating an enforcement task — and command reviews every such report through
a dedicated queue with a transparent (never automated) reopen-vs-new-incident
recommendation. Alongside it, the custom (no-playbook) intervention fallback
is hardened to close a real, verified gap: it can no longer bypass the
commander-only/evidence-level/named-approver rules a playbook-based
intervention already had to follow.**

### Schema (additive) — `20260720000000_recurrence_and_custom_hardening.sql`
- **New table** `incident_recurrence_reports`: `incident_id`, `reporter_id`,
  `recurrence_type` (CHECK: returned/partially_returned/action_temporary/
  unable_to_confirm), `note`/`lat`/`lng`/`photo_url`, `review_status` (CHECK:
  pending/more_evidence_requested/confirmed/dismissed), `public_response` (the
  only text a citizen ever sees), `reviewed_by`/`reviewed_at`,
  `resulting_incident_id`.
- **New column** `incidents.recurrence_of_incident_id` (self-referencing,
  nullable) — paired with the report's own `resulting_incident_id` for
  two-directional traceability of a "new linked incident" disposition.
- **Widened** `incident_evidence.evidence_type` CHECK to add
  `recurrence_report`, so a "merge into a nearby open incident" decision can
  attach the citizen's evidence to the target incident.
- **`submit_incident_recurrence_report()`** (security definer): closed-only,
  ownership-checked via `reports.reporter_id`, idempotent on a pending
  duplicate. Deliberately never touches `incidents` or `actions` — the
  guarantee that a citizen's report can never auto-reopen anything or create
  an enforcement task is structural (no code path exists), not a checked rule.
- **`list_my_recurrence_reports()`** (security definer): the citizen's entire
  read path, computing `outcome_kind` (`reopened`/`new_incident`/null)
  server-side rather than exposing the raw `resulting_incident_id`.
- **`enforce_incident_action_rules`** (replaces the Phase 5 function again):
  creating ANY incident-linked action (playbook-based or custom) now requires
  commander/admin — the **real, verified gap** this closes: the baseline
  `actions_write` policy in `schema.sql` otherwise let a field_officer INSERT
  an incident-linked action directly in their own ward, with no distinction
  from the command-only UI path (found by reading `schema.sql`, not assumed;
  closed and confirmed by test 34a). Also new: a custom (no-playbook) action
  must carry a non-empty `custom_reason`; an incident classified `regional`
  only accepts `advisory_monitoring` as an incident-linked type, custom or
  not; once `approved_by` is set, the descriptive fields become immutable.
- **New column** `actions.custom_reason` (nullable at the column level; the
  trigger is what makes it mandatory exactly where it needs to be).
- **New, separate `AFTER INSERT` trigger** `log_action_creation_event`:
  writes the intervention-creation event directly from SQL — guaranteed, not
  best-effort — replacing the client-side `addIncidentEvent` call
  `createIntervention`/`createInterventionFromPlaybook` previously made after
  the insert (removed from `incidents.ts` in this pass to avoid a duplicate
  event per creation).

### Typed data layer
- `web/src/lib/incidentRules.ts` gained: recurrence types/labels
  (`RECURRENCE_TYPES`, `RECURRENCE_REVIEW_STATUSES`,
  `citizenRecurrenceStatusLabel`), `recommendRecurrenceDecision` (pure,
  three documented thresholds — 168h "soon after closure", 720h "substantial
  gap", 300m "same location" — reopen/new_incident/uncertain plus
  plain-language reasons, never applied automatically), and the custom-
  hardening mirrors `isCustomActionTypeAllowedForClassification`/
  `customActionClassificationBlockedReason`/`isActionLockedByApproval`. The
  `QueueKey`/`QueueIncident`/`inQueue` set gained a `'recurrence'` queue tab.
- `web/src/lib/incidents.ts` gained: `submitIncidentRecurrenceReport`,
  `fetchMyRecurrenceReports`, `listRecurrenceReportsForIncident`,
  `fetchPendingRecurrenceCounts` (batched, mirroring
  `fetchPlaybookUsageBatch`), and six command review functions
  (`dismissRecurrenceReport`, `requestMoreEvidenceForRecurrence`,
  `confirmRecurrenceReport`, `reopenIncidentFromRecurrence`,
  `createLinkedIncidentFromRecurrence`, `mergeRecurrenceIntoIncident`).
  `IncidentDetail` gained `recurrenceReports`. `createIntervention` gained a
  required `customReason` param; `createIncident` gained an optional
  `recurrenceOfIncidentId` param.
- `database.types.ts` regenerated from the verified schema (all five
  migrations applied to a disposable Postgres, test helpers absent from the
  generation source) — confirmed no stray CLI stderr line leaked into the
  installed file.

### Surfaces
- **Command** `/incidents`: a new **Recurrence** queue tab (closed incidents
  with a pending recurrence report) and a **Recurrence reports** panel in the
  incident workspace — closure date, previous intervention, previous impact
  result, time-since-closure, each report's evidence and
  `recommendRecurrenceDecision` recommendation, and six review actions
  (dismiss / request more evidence / confirm / reopen / create new linked
  incident / merge with nearby open incident). The intervention creation form
  now requires "Why no playbook was suitable"; `InterventionCard` labels
  every custom (no-playbook) intervention distinctly from a playbook-based one.
- **Field** `/missions`: the same **Custom intervention** label next to any
  assigned action with no `playbook_id`.
- **Citizen** `/citizen`: a new `CitizenRecurrenceCard`, shown only for a
  closed linked incident — final outcome (from `impact_evaluations.outcome`,
  already RLS-readable since Phase 4), previous action status (derived from
  the public timeline only), a 4-option recurrence report form
  (type/note/location/photo, all but type optional), and the citizen-safe
  status afterward via `citizenRecurrenceStatusLabel`.

### Phase 6 — Automated pollution anomaly detection and predicted incidents

The vertical slice: **automated, rule-based (no ML) pollution anomaly
detection from monitoring data, creating or updating predicted/detected
incidents — the first code in this repo that ever creates an `incidents`
row from `readings` alone. Never fires from one isolated reading. Every
threshold, window, radius and horizon is city-configurable, seeded for
Delhi with a documented scientific basis. Deduplication and incident
create-or-update are one atomic, server-side transaction. Predicted
incidents never create enforcement tasks.**

### Schema (additive) — `20260721000000_anomaly_detection.sql`
- **New enum** `incident_detection_stage` (`predicted`/`detected`/
  `confirmed`) on **new column** `incidents.detection_stage` — orthogonal to
  `status` (workflow) and `source_confidence` (source evidence); null for
  every citizen-reported or manually-created incident.
- **New column** `incidents.merged_into_incident_id` — command's "merge
  with an existing incident" action, mirroring Phase 5.1's
  `recurrence_of_incident_id`/`resulting_incident_id` pairing.
- **New column** `stations.sensor_type` (NOT NULL, default `'regulatory'` —
  matches every currently-seeded Delhi station's real type, not a guess).
- **New table** `anomaly_candidates` — the rule engine's structured output:
  every input/baseline value, `triggered_rules`, `confidence`,
  `detected_at`, and a full data-quality summary (freshness, completeness,
  sensor quality, suppression + reason). The insert-only row itself IS the
  "anomaly candidate created"/"suppressed" audit event — no incident
  necessarily exists yet at candidate-creation time.
- **`evaluate_station_pollutant_anomaly(station_id, pollutant)`**: the rule
  engine for one station+pollutant — signals, data-quality gate,
  detected/predicted classification, confidence scoring, and (inside the
  SAME atomic function) deduplication + create-or-update, using the exact
  same ward-scoped advisory-lock namespace `link_report_to_incident`
  already uses so the two detection paths cannot race each other.
  Commander/admin only when called with an authenticated session; an
  unauthenticated caller (the ingest service's service_role connection) is
  allowed through, since that already bypasses RLS regardless.
- **`run_anomaly_detection(city_code)`**: the bulk driver — every active
  station × that city's own `city_config.pollutant_priority` list.

### Typed data layer
- `web/src/lib/incidentRules.ts` gained: `POLLUTANTS`/`POLLUTANT_LABEL` (all
  six), `DetectionStage`/`DETECTION_STAGE_LABEL`, `describeTriggeredRule`,
  `sensorQualityCaveat`, `describeAnomalyDetectionRule` — display-only; the
  rule engine itself lives entirely in SQL. `isPredicted()` now prefers
  `incidents.detection_stage` over the old `detection_method` string-prefix
  heuristic (kept as a harmless fallback — no code ever actually produced a
  `'forecast*'` detection_method).
- `web/src/lib/incidents.ts` gained: `listAnomalyCandidatesForIncident`,
  `listStationsForWard`, `runAnomalyDetectionNow`, and four command review
  functions (`confirmPredictedIncident`, `continueMonitoringPredictedIncident`,
  `dismissPredictedIncident`, `mergePredictedIncident`). `IncidentDetail`
  gained `anomalyCandidates`.
- `database.types.ts` regenerated from the verified schema (all six
  migrations applied to a disposable Postgres, test helpers absent from the
  generation source; confirmed no stray CLI stderr line leaked in).
- `ingest/app/anomaly_detection.py` (new, thin): calls `run_anomaly_detection()`
  via the service_role RPC client on the existing APScheduler cron, after
  forecast+attribution. Contains no rule logic of its own — mirrors how
  `classify.py` calls out to Claude rather than reimplementing anything.

### Surfaces
- **Command** `/incidents`: the **Predicted** queue tab (existed since
  Phase 3, always empty until now) populates automatically. New
  `PredictedIncidentPanel` in the incident workspace, shown only when
  `detection_stage` is set: location, pollutant, current concentration,
  local excess, rate of increase, expected threshold-crossing time, data
  confidence, every triggered rule in plain language, nearby monitoring
  stations, and four review actions (continue monitoring / promote to
  active / dismiss as data anomaly / merge with existing incident).
  "Request evidence" reuses the existing header button unchanged.
- **Field**: no change — a Phase-6 incident reaches the field exactly like
  any other incident, once command creates an intervention for it.
- **Citizen**: no new code — the existing Phase 3 `evidence_missions`
  `citizen_verification` mechanism already satisfies "generate a safe
  citizen verification request" for a predicted incident with zero
  special-casing, and already excludes internal source/enforcement detail.

### Phase 7 — Transparent, rule-based probable-source attribution

The vertical slice: **for every open incident, a transparent, rule-based
(no ML) attribution engine scores each configured source category against
only the evidence that genuinely exists in this repository — pollutant
readings and the PM10:PM2.5 ratio, wind direction, `responsibility_registry`
known-source locations, linked citizen reports, field-inspection outcomes,
and the anomaly-detection engine's own regional-pattern signal — stores a
fully-auditable evidence breakdown per hypothesis, generates a next-best-
evidence recommendation when the result is ambiguous or low-confidence,
recommends (never dispatches) a responsible authority for the top LOCAL
hypothesis, and updates the incident's local-vs-regional classification —
all without ever overwriting an authorised human's verified finding or
confirmed classification.**

### Schema (additive) — `20260722000000_source_attribution.sql`
- **Three new `source_category` enum labels** (`regional_transport`,
  `mixed`, `unresolved`), appended via `ALTER TYPE ... ADD VALUE IF NOT
  EXISTS` rather than a second, parallel category enum — the existing 7
  labels (`vehicular`, `industrial` included) are unchanged, so
  `classify.py` and the Phase 5 playbook seed are untouched. A
  `city_config.config -> 'attribution' -> 'category_labels'` alias map lets
  the UI show the plan's own literal wording (`traffic_emissions`,
  `industrial_combustion`) without renaming the underlying enum — see
  [DATA_MODEL.md](DATA_MODEL.md) for the full rationale.
- New columns on `incident_source_hypotheses`: `evidence_scores` (the full,
  named-factor breakdown — pollutant signature, wind alignment, GIS
  proximity, temporal match, citizen corroboration, field verification,
  regional pattern, contradiction penalty, data-quality penalty, plus the
  weights snapshot actually used), `supporting_evidence`/
  `contradicting_evidence`/`missing_evidence` (plain-language arrays),
  `data_quality_note`, `is_current` (the versioned-history flag — older
  calculations are never deleted, only superseded), `review_status`/
  `reviewed_by`/`reviewed_at`/`review_note` (a command reviewer's own
  disposition on one hypothesis).
- **New partial unique index** `incident_hypotheses_current_uq` on
  `(incident_id, source_category) where is_current` — the structural
  guarantee against duplicate hypotheses, backfilled safely before creation
  so a pre-existing duplicate (e.g. from the dead, never-wired
  `upsertSourceHypothesis` client helper) cannot break the migration.
- New columns on `incidents`: `classification_source` (`'model'`/`'human'`),
  `classification_set_by`, `classification_note`, `classification_updated_at`
  — the provenance `classification` itself always lacked; a `null` or
  `'model'` source may still be recalculated, `'human'` never is.
- **`calculate_incident_source_attribution(p_incident_id, p_force)`**: the
  rule engine for ONE incident. Reuses `evaluate_station_pollutant_anomaly`'s
  own pollutant thresholds (`city_config.config -> 'anomaly_detection' ->
  'pollutant_thresholds'`) as the "elevated" reference point rather than a
  second, inconsistent table. Combustion signatures (vehicular/open_burning/
  industrial) require BOTH their defining pollutants present and elevated
  TOGETHER — a single elevated pollutant (e.g. PM2.5 alone from a regional
  event) is never credited as a combustion signature. Citizen corroboration
  needs 2+ distinct reporters before it counts at all. Never sets
  `officially_verified`, and skips any category whose current row already
  is — the literal mechanism behind "never overwrite a verified finding".
  When the top two hypotheses are too close, or the leader is below the
  confidence threshold, inserts BOTH a `mixed` hypothesis row AND a proposed
  `evidence_missions` recommendation — routed to a citizen-safe question
  only when the leading candidate is not in the same hazardous set
  (`open_burning`/`industrial`) `HAZARDOUS_FOR_CITIZENS` already uses, never
  auto-assigned (command dispatches it via the existing "Request evidence"
  button, unchanged from Phase 6's own precedent). Updates
  `incidents.classification` only when `classification_source` is null or
  `'model'`.
- **`run_incident_source_attribution(p_city_code, p_force)`**: the batch
  driver — every open (`status <> 'closed'`) incident in a city (or every
  active city), skipping one recalculated within its own configured
  interval unless forced.
- **`get_incident_responsible_authority(p_incident_id)`**: read-only,
  plain SQL (not security-definer) — relies entirely on the caller's own RLS
  on `incident_source_hypotheses`/`responsibility_registry`, so a citizen
  gets zero rows for the same structural reason they get zero rows querying
  those tables directly. Suppresses routing (`routing_confidence = 0`) with
  an explicit note for a `regional`-classified incident. Never dispatches
  anything.
- Seeded Delhi's full attribution configuration (weights, thresholds,
  ambiguity gap, citizen-report minimums, regional-pattern rules,
  recalculation interval) plus four illustrative, city-wide (not
  ward-specific — no real per-asset location data exists in this repo)
  `responsibility_registry` rows (road_dust/construction_dust/vehicular/
  industrial → generic agency-type labels matching the Phase 5 playbook
  seed's own `responsible_agency_type` wording). `open_burning` is
  deliberately left unseeded so "unresolved jurisdiction" has a genuine,
  non-contrived Delhi demonstration case.

### Typed data layer
- `web/src/lib/incidentRules.ts` gained: `SOURCE_CATEGORY_LABEL`/
  `sourceCategoryLabel` (the display-alias map, mirroring the SQL seed's
  default exactly), `META_SOURCE_CATEGORIES`/`isMetaSourceCategory`,
  `HYPOTHESIS_REVIEW_STATUS_LABEL`, `CLASSIFICATION_LABEL`/
  `classificationLabel` (the plan's own local_actionable/mixed/
  predominantly_regional/unresolved wording, aliased onto the unchanged
  `local`/`mixed`/`regional`/`uncertain` enum), `isHumanConfirmedClassification`,
  `PROBABLE_SOURCE_DISCLAIMER`, and `needsMoreAttributionEvidence` — all
  display-only; the actual scoring/ambiguity decision lives entirely in SQL.
- `web/src/lib/incidents.ts` gained: `listCurrentSourceHypotheses`,
  `getIncidentResponsibleAuthority`, `recalculateSourceAttribution`,
  `runIncidentSourceAttribution`, `reviewSourceHypothesis` (confirm as
  corroborated / mark unresolved / reject with a mandatory reason — a
  guided path onto a capability RLS already grants commander/admin
  directly, same pattern as `updateSourceConfidence`). `IncidentDetail`
  gained `responsibleAuthority`.
- `web/src/lib/database.types.ts` hand-updated (no live Supabase project to
  regenerate against in this environment): the three new enum labels, the
  new `incident_source_hypotheses`/`incidents` columns, and the three new
  RPC signatures — verified against `npx tsc -b --force` and a full
  production build, not just visually.

### Surfaces
- **Command** `/incidents`: new `SourceAttributionPanel.tsx`, placed above
  the evidence workspace — ranked hypotheses with probability bars,
  confidence level, supporting/contradictory/missing evidence, the fixed
  "Probable source — not a confirmed violation." disclaimer, local/regional
  classification (with a "(human-confirmed)" tag when applicable), probable
  responsible authority with routing confidence (or "Not applicable —
  regional" / "Unresolved jurisdiction"), last-calculation time, a
  data-quality warning when present, the recommended next evidence mission
  (pointing at the existing "Request evidence" header button, unchanged
  from Phase 6's own precedent — not a second button), and four per-
  hypothesis review actions (confirm as corroborated / mark unresolved /
  reject with reason / — plus a panel-level "Request recalculation").
  `IncidentEvidencePanel`'s old, simpler "Probable source" section is
  removed (fully superseded, not duplicated).
- **Field**: no new surface — a field officer already sees whichever
  evidence mission is dispatched to them (citizen-safe or otherwise)
  through the existing Phase 3 mission flow; the recommended-mission
  category is just a `mission_type`/`rationale` like any other.
- **Citizen**: no new surface, deliberately — when the engine's
  recommendation is citizen-safe, it is one of the three exact questions
  plan §11 lists ("Is heavy road dust visible…", "Is loose construction
  material left uncovered…", "Is visible smoke present…"), delivered
  through the existing Phase 3 `citizen_verification` mission and its
  existing safety gate (`HAZARDOUS_FOR_CITIZENS`) unchanged. Citizens have
  zero RLS read on `incident_source_hypotheses`/`responsibility_registry`
  either directly or via `get_incident_responsible_authority` (verified,
  test 72) — no named facility, agency note, or unverified accusation is
  ever reachable.

### Rules, and where they live
Every scoring weight, threshold, the ambiguity gap, the never-overwrite-
verified guard, and the classification-update rule live in
`calculate_incident_source_attribution` (SQL) — the same reason
`evaluate_station_pollutant_anomaly` does. `incidentRules.ts` carries only
display labels and one pure ambiguity-explanation helper
(`needsMoreAttributionEvidence`), unit-tested (9 new tests) exactly like
Phase 6's `describeAnomalyDetectionRule` pattern.

### Phase 8 — Unified forecasting and scientific validation

The vertical slice: **one trusted, validated, multi-pollutant (PM2.5 core,
PM10 once a ward has enough history, NO2 optional/supporting) forecasting
pipeline, time-based-validated against a persistence AND a seasonal/hourly
baseline at four horizons (6/12/24/48h), with every result — prediction,
uncertainty range, method, training period, validation metrics, data-quality
status — stored and shown, connected to anomaly detection so a "predicted"
incident uses the validated forecast when available and explicitly, never
silently, falls back to Phase 6's own raw-reading trend projection when it
isn't.**

### Schema (additive) — `20260723000000_unified_forecasting.sql`
- **New table** `forecast_runs`: the validation record for one ward +
  pollutant + generation — `method` (`lightgbm`/`diurnal_persistence`,
  decided only AFTER the model-vs-persistence comparison), `model_version`,
  `training_period_start`/`training_period_end`, `training_rows`,
  `data_completeness`, `data_quality_status`, `validation_metrics` (jsonb,
  per-horizon MAE/RMSE/bias/threshold-recall/false-alarm-rate),
  `max_validated_horizon_hours`, `beats_persistence`. RLS: any authenticated
  user may read (transparency data, same posture as the pre-existing
  `forecasts_read`); no write policy — only the ingest service writes here,
  exactly like `forecasts`/`readings`/`weather` already work (test 76c: even
  a commander cannot insert directly).
- New columns on `forecasts`: `pollutant` (NOT NULL, default `'pm25'` —
  backfills every existing row correctly), `predicted_value`/`lower_bound`/
  `upper_bound` (generic, any pollutant), `forecast_run_id`. The legacy
  `pm25_pred` column is untouched and still populated for every pm25 row —
  `fetchForecast`/`fetchAllForecasts`/`ForecastChart.tsx` keep working
  byte-for-byte, with one required addition: both functions now explicitly
  filter `pollutant = 'pm25'`, since the table can now also hold pm10/no2
  rows for the same ward.
- New column on `anomaly_candidates`: `prediction_method`
  (`validated_forecast`/`trend_persistence`) — "clearly record which method
  created the prediction... never silently mix forecast methods" as a
  queryable column, set only for a `'predicted'`-stage candidate.
- **`evaluate_station_pollutant_anomaly`** (Phase 6, `create or replace`d a
  second time): the 'predicted' branch now looks up a validated, fresh
  `forecast_runs` row for the ward+pollutant FIRST. If its own forecast
  curve crosses the configured threshold within its validated horizon, THAT
  drives the predicted incident (`prediction_method = 'validated_forecast'`)
  and the raw-reading trend is never consulted (test 78). If a validated
  forecast exists but never crosses, there is NO predicted stage at all —
  deliberately not a fallback to trend, even when the trend alone would
  have projected a crossing (test 81). Only when no validated forecast
  exists (or it's unvalidated, test 80, or stale — more than 2× the
  configured retraining cadence old, test 84) does the original Phase 6
  linear trend-projection run, labelled `prediction_method =
  'trend_persistence'` (test 79). 'detected' stage (already crossing,
  sensor-driven) is completely unchanged. Forecast-driven predicted
  incidents still cannot create enforcement actions (test 82) and
  deduplicate identically to Phase 6 (test 83).
- Seeded Delhi's forecasting configuration (`enabled_pollutants`,
  `horizons_hours`, `min_mae_improvement_pct`, `confidence_threshold`,
  `fallback_method`, `retraining_frequency_hours`).

### Model + validation (Python — the one part of this phase that can't live in SQL)
- `ingest/app/forecast.py` rewritten: unified across pm25/pm10/no2 (one
  shared pipeline, not three copies), weather features extended with a
  genuine Open-Meteo **hourly forecast** fetch (`open_meteo
  .get_hourly_forecast`, new) used at every step of the recursive multi-hour
  forecast instead of assuming today's weather persists, plus a spatial
  "nearby stations" feature (city-wide average at t−1) and a `month`
  calendar feature. Time-based holdout validation recursively re-simulates
  the real forecasting procedure from the split point (never leaking true
  intervening values), scored against persistence AND the diurnal baseline
  at each of 6/12/24/48h with MAE/RMSE/bias/threshold-recall/false-alarm-
  rate. A horizon is marked validated only if the model beats persistence
  there AND at every smaller horizon (monotonic, conservative).
- `ingest/app/db.py`: `replace_forecasts` is now pollutant-scoped (an
  unscoped delete would have wiped out every OTHER pollutant's current
  forecast for a ward); new `insert_forecast_run`, `get_wards_with_city`,
  `get_active_cities`; `get_readings_history` gained `no2` (additive to the
  returned dict — the existing `attribution.py` caller only reads `pm25`,
  unaffected).
- **New: `ingest/tests/test_forecast.py`** (and `ingest/pytest.ini`) — the
  first Python test suite in this repo. 15 tests against a fixed, seeded
  synthetic dataset (`RNG_SEED = 20260723`, never live data): metric
  formulas hand-verified, the chronological-split behaviour proven with a
  constructed holdout-only outlier tail, monotonic beats-persistence gating,
  the LightGBM-vs-diurnal fallback decision under both a learnable and an
  uninformative signal, insufficient-data handling, and a full `run()`
  end-to-end pass with `db`/`open_meteo` fully mocked (no network, no
  Supabase).

### Typed data layer
- `web/src/lib/incidentRules.ts` gained: `FORECAST_HORIZONS_HOURS`,
  `ForecastMethod`/`FORECAST_METHOD_LABEL`,
  `ForecastDataQualityStatus`/`FORECAST_DATA_QUALITY_LABEL`,
  `PredictionMethod`/`PREDICTION_METHOD_LABEL`, `FORECAST_DISCLAIMER` (the
  fixed "Forecast — not a guaranteed outcome." string), `isHorizonValidated`,
  `forecastFallbackStatus` — display-only, unit-tested (9 new tests); the
  model itself lives entirely in Python.
- `web/src/lib/incidents.ts` gained: `ForecastCurvePoint`,
  `fetchForecastCurve` (multi-pollutant), `fetchLatestForecastRun`.
- `web/src/lib/data.ts`: `fetchForecast`/`fetchAllForecasts` now explicitly
  filter `pollutant = 'pm25'` (required correctness fix now that `forecasts`
  holds more than one pollutant per ward — see Schema above).
- `database.types.ts` regenerated from the verified schema (all eight
  migrations applied to a disposable Postgres, test helpers absent from the
  generation source) — this is the first Phase-7-and-8-aware regeneration
  actually run against a live disposable Postgres in this environment
  (Phase 7's own pass had no Docker access and hand-updated the file
  instead; that limitation is now resolved for both phases' types at once).

### Surfaces
- **Command** `/incidents`: `PredictedIncidentPanel.tsx` gains a **Forecast**
  sub-section (shown whenever a `forecast_runs` row exists for the
  incident's ward+pollutant) — the forecast curve with an uncertainty band
  (inline SVG, no chart library, mirroring `ForecastChart.tsx`'s own
  approach), method used, fallback status in plain language, model accuracy
  by horizon (MAE vs. persistence, greyed out beyond the validated horizon),
  a data-quality warning when not `ok`, and the fixed disclaimer. The
  existing "Prediction method" field is now meaningfully populated.
- **Field**: no change.
- **Citizen**: no change, deliberately — `ForecastChart.tsx` keeps showing
  exactly the same PM2.5 curve it always has.

### Rules, and where they live
The forecasting model (training, time-based validation, every metric) lives
entirely in `ingest/app/forecast.py` — Postgres cannot train a model, and
re-deriving validation client-side would be exactly the kind of
"second, potentially-inconsistent" computation this codebase avoids
everywhere else. The CONNECTION to anomaly detection — forecast-vs-trend
fallback — lives in `evaluate_station_pollutant_anomaly` (SQL, extended, not
duplicated). See [DATA_MODEL.md](DATA_MODEL.md) for the full mechanism and
[DATA_QUALITY_AND_SCIENCE.md](DATA_QUALITY_AND_SCIENCE.md) for the
validation methodology, model inputs, and honest limitations.

### Phase 9 — Authority routing and operational dispatch

The vertical slice: **turning an approved intervention into a correctly
routed, trackable, escalatable operational task** — routing resolution
against a richer `responsibility_registry`, a 15-state dispatch lifecycle
enforced server-side, controlled (approval-gated) dispatch, a
provider-agnostic notification queue with an honest email/dev-mock adapter,
a configurable SLA engine, automatic escalation, and command/field/citizen
surfaces, all additive on top of Phase 4's own operational workflow.

### Schema (additive) — `20260724000000_authority_routing_and_dispatch.sql`
- **New enums**: `task_dispatch_status` (15 values), `routing_confidence_level`
  (`confirmed`/`probable`/`disputed`/`unresolved`), `notification_channel`
  (`in_app`/`email`/`sms`/`whatsapp`), `notification_status`.
- **`responsibility_registry` additive columns**: `team_name`,
  `backup_agency`/`backup_team`/`backup_officer`, `zone_description`,
  `contact_channel`, `supported_intervention_types`, `working_hours`,
  `escalation_hierarchy`, `is_active`, `mapping_confidence`, `mapping_source`.
- **New table** `task_dispatches`: the operational envelope around an
  `actions` row — routing, lifecycle status, approval, five SLA due
  timestamps, escalation, rejection/reroute/cancellation/dispute-resolution
  reasons, resource availability. Versioned (`is_current` + a partial
  unique index on `action_id where is_current` — the structural
  duplicate-dispatch guard).
- **New table** `sla_rules`: configurable by city/severity/source
  category/evidence level/action type/agency, most-specific-match-wins via
  a `priority` column, a `slug` natural key for idempotent seeding.
- **New table** `notifications`: a provider-agnostic delivery queue —
  recipient, channel, template, message body, status, timestamps, failure
  reason, retry count.
- **New functions**: `_resolve_task_routing`/`preview_task_routing` (routing
  resolution), `dispatch_intervention_task` (idempotent create-or-update
  dispatch, commander/admin only), `transition_task_dispatch` (the ONLY
  status-change path, an explicit from→to table enforced server-side),
  `escalate_stale_task_dispatches` (the SLA/escalation batch driver),
  `report_resource_unavailable`/`request_task_reroute` (field-only),
  `resolve_jurisdiction_dispute` (command-only, requires a reason).
- **RLS**: no authenticated write policy on `task_dispatches`/`notifications`
  at all — every write goes through a SECURITY DEFINER function above;
  verified by test 98c actually attempting a direct `UPDATE` as a logged-in
  commander and confirming it affects 0 rows. Citizens have zero read on
  either table (test 98a). `sla_rules` is broadly readable (transparency),
  commander/admin-writable.
- **Delhi seed**: three SLA rules (severe-severity fast lane, penalty-type
  fast lane, a 2/4/8/24/72-hour default) plus
  `city_config.config -> 'dispatch' -> 'requires_approval_types'`.

### Python (`ingest/app/`)
- **`notifications.py`** (new): `InAppAdapter` (no-op — the RLS-scoped row
  itself is the delivery), `MockEmailAdapter` (development-safe, logs
  "would send", records an honest "no provider configured" failure),
  `SmtpEmailAdapter` (real SMTP when `SMTP_HOST` is set), `UnconfiguredAdapter`
  (sms/whatsapp — an adapter INTERFACE exists per plan §6's "WhatsApp-ready"
  requirement, but never claims a delivery it didn't make). `run()` drains
  every `pending` notification once, with a bounded retry budget
  (`MAX_RETRIES = 3`) before marking a channel `failed`.
- **`dispatch.py`** (new): a thin wrapper calling
  `escalate_stale_task_dispatches`, mirroring `anomaly_detection.py`'s own
  shape exactly.
- **`main.py`**: a new `run_ops()` (notifications + escalation) on a
  5-minute `interval` schedule, separate from the hourly `run_intel` cron —
  an SLA clock can't wait an hour. New `/ops` trigger endpoint and
  `last_ops` in `/health`.
- **`db.py`**: `get_pending_notifications`/`mark_notification_sent`/
  `mark_notification_retry_or_failed` — thin wrappers so `notifications.py`
  stays fully unit-testable via `monkeypatch`, matching `forecast.py`'s own
  db-wrapper convention.

### Typed data layer
- **`incidentRules.ts`**: `TaskDispatchStatus`/`RoutingConfidenceLevel`/
  `NotificationChannel`/`NotificationStatus` enum aliases,
  `TASK_DISPATCH_TRANSITIONS` (mirrors the SQL transition table, for
  greying out illegal UI actions only — the DB remains the authority),
  `canTransitionTaskDispatch`, `taskDispatchRequiresReason`,
  `TASK_DISPATCH_STATUS_LABEL`, `publicTaskStatusLabel` (the plan §12
  citizen-safe label — collapses every internal-only state to one honest
  line), `ROUTING_CONFIDENCE_LABEL`, `routingBlocksAutoDispatch`,
  `NOTIFICATION_CHANNEL_LABEL`/`NOTIFICATION_STATUS_LABEL`,
  `DISPATCH_APPROVAL_REQUIRED_TYPES`/`dispatchRequiresApprovalByDefault`,
  `SLA_CHECKPOINT_LABEL`, `minutesUntil`/`slaCountdownLabel`. 21 new unit
  tests (137 total, up from 116).
- **`incidents.ts`**: `TaskDispatchRow`/`SlaRuleRow`/`NotificationRow`/
  `ResponsibilityRegistryRow` types; `previewTaskRouting`,
  `dispatchInterventionTask`, `transitionTaskDispatch`,
  `reportTaskResourceUnavailable`, `requestTaskReroute`,
  `resolveJurisdictionDispute`, `escalateStaleTaskDispatchesNow`,
  `getTaskDispatchForAction`, `listTaskDispatchesForIncident`,
  `listMyTaskDispatches`, `listNotificationsForDispatch`,
  `listResponsibilityRegistryForCity`.

### Surfaces
- **Command** `/incidents`: new `TaskDispatchPanel.tsx` — routed authority,
  routing confidence badge, assigned officer/team, lifecycle status, SLA
  countdown, escalation level, delivery status per channel (on demand),
  rejection/reroute/escalation reason. Actions: preview & dispatch, approve
  & dispatch, resolve jurisdiction dispute (picks from the active registry,
  requires a reason), escalate, cancel, and a manual "check for overdue
  tasks" trigger.
- **Field** `/missions`: new `FieldTaskDispatchCard.tsx`, separate from the
  existing intervention card — acknowledge, accept, reject (with reason),
  start work (also marks arrival — see the "no separate arrival status"
  note below), report resource unavailable, request reroute.
- **Citizen**: no new component. `dispatch_intervention_task`/
  `transition_task_dispatch` write the same `incident_events.is_public`
  rows every earlier phase already renders through the existing
  `IncidentTimeline.tsx` (which gained a handful of new event-type labels
  for readability) — a citizen sees dispatch progress with zero new query,
  RPC, or RLS surface, and internal routing/officer/rejection/dispute
  detail stays server-side.

### Rules, and where they live
Every routing/lifecycle/approval/SLA/escalation rule lives in
`supabase/migrations/20260724000000_authority_routing_and_dispatch.sql` —
the SECURITY DEFINER functions are the ONLY write path (no authenticated
RLS write policy exists on `task_dispatches`/`notifications` at all).
`incidentRules.ts` carries only display labels and pure UI helpers that
mirror the SQL's own transition table, exactly the discipline every earlier
phase follows. See [DATA_MODEL.md](DATA_MODEL.md) for the full mechanism
and [ROLE_WORKFLOWS.md](ROLE_WORKFLOWS.md) for the per-role walkthrough.

One deliberate scope simplification: **arrival has no dedicated lifecycle
status** — the 15 states are exactly what plan §4 lists, so "mark arrival"
(plan §11) is modelled as `arrived_at` being set the first time a dispatch
reaches `in_progress`, rather than inventing a 16th status. Documented, not
hidden.

## Completed in this pass — Phase 10

The vertical slice: **move from locally-verified code to a safely
deployable pilot posture** — a preflight audit of the actual hosted
project's state, two real RPC correctness bugs found and fixed, one
storage evidence-tamper gap closed, job-reliability/system-health/feature-
flag infrastructure, CI/CD, six new operational docs, and a frontend
hardening pass. **Hosted deployment itself was not performed** — no
Supabase CLI access token was available in this environment; every hosted-
facing script/doc is prepared and verified against the mechanics involved,
not against the real hosted project.

### Preflight findings (before any change was made)

- A hosted Supabase project exists (project ref `xpinidergyqkunoiukal`,
  reachable via the service_role key already in `ingest/.env`) but is stuck
  on the **base Phase 0/1 schema only** — `wards`/`stations`/`profiles`/
  `readings`/`forecasts`/`reports`/`actions`/`weather` — with real
  accumulated data (13 wards, 11 stations, 25 readings, 432 forecasts, 1
  profile). **None of the Phase 2-9 migrations have ever reached it.**
  Verified via a new read-only script, `supabase/scripts/
  check_hosted_drift.py` (checks one marker table/column/bucket per
  migration through the PostgREST API — needs no CLI link).
- The Supabase CLI itself is **not linked** (no `SUPABASE_ACCESS_TOKEN`) —
  `supabase db push`/`migration list`/`gen types --linked` are all
  unavailable from this environment, even though the service_role key gives
  read access for inspection. This is a materially different situation
  from "no hosted project exists at all" and is documented precisely as
  such in [DEPLOYMENT.md](DEPLOYMENT.md).
- **`web/.env.example` was committed with a real anon key and project
  URL**, not placeholders — fixed this pass (see [SECURITY.md](SECURITY.md)
  for the full writeup, including why git history was not rewritten
  unilaterally).
- A stray, empty `web/supabase/` directory (an accidental `supabase init`
  scaffold, never committed) was removed.
- No `.github/workflows` existed at all — confirmed, not assumed.

### Schema (additive) — `20260725000000_production_hardening.sql`

- **Two real RPC bugs fixed**: `dispatch_intervention_task` was not
  replay-safe (a repeat call on an already-progressed dispatch could
  regress its status and duplicate a notification); `completed ->
  escalated` was declared illegal in `transition_task_dispatch` despite
  `escalate_stale_task_dispatches` performing exactly that transition
  directly. Full writeup in [SECURITY.md](SECURITY.md).
- **Per-city failure isolation** added to `run_anomaly_detection`,
  `run_incident_source_attribution`, `escalate_stale_task_dispatches` — a
  per-iteration `begin...exception...end` so one station's/incident's
  unhandled exception no longer aborts an entire multi-city batch.
- **Storage tamper fix**: removed `report_photos_update`/
  `report_photos_delete` — evidence photos are now append-only, matching
  every DB-level evidence table.
- **New table** `job_runs` — one row per scheduled-job attempt, a partial
  unique index (`job_name, city_code where status='running'`) as the
  actual structural overlap guard, `start_job_run`/`complete_job_run`/
  `fail_job_run` functions (service_role only, no authenticated write).
- **New function** `system_health_summary()` — read-only rollup per
  job+city with an `is_stale` flag, commander/admin only.
- **New function** `city_feature_enabled(city_id, flag, default)` +
  `city_config.config -> 'feature_flags'` — nine pilot-disableable flags,
  wired into `dispatch_intervention_task` (raises when disabled),
  `escalate_stale_task_dispatches`, `run_anomaly_detection`,
  `run_incident_source_attribution`, `submit_citizen_verification`, and
  (Python-side) `forecast.py`/`notifications.py`.
- **New column** `stations.is_active` + a new `set_station_active(...)`
  function (station has no authenticated write policy at all, so a
  narrow function is the write path, not a new RLS policy).
- **Input validation**: bounded-length `CHECK` constraints (via `not
  valid` + `validate constraint`, non-blocking) on every `task_dispatches`
  reason/note column and `incident_recurrence_reports.note`.
- **RLS/SECURITY DEFINER audit**: a systematic review (manual + a new
  automated `pg_proc` introspection test) found zero unprotected
  `SECURITY DEFINER` functions and zero direct-table-write bypasses. Full
  writeup in [SECURITY.md](SECURITY.md).

### Python (`ingest/app/`)

- **`logging_utils.py`** (new): `log_event(...)` (structured JSON to
  stdout) + `run_tracked(job_name, fn, city_code)` — a function wrapper
  (not a context manager — a `with` block's body always executes
  regardless of what's yielded, which cannot express "skip this job, the
  lock is held") wrapping every scheduled job with `job_runs` tracking,
  timing, and logging. Never re-raises: one job failing must not abort
  others in the same caller's sequence.
- **`health_checks.py`** (new): `compute_health()` — database
  connectivity, reading freshness (stale after 3h), and the same
  `system_health_summary()` rollup, aggregated into `ok`/`degraded`/`down`.
- **`main.py`**: every scheduled job (`ingest`, `forecast`,
  `anomaly_detection`, `attribution`/source-attribution, `notifications`,
  `escalation`) now runs through `run_tracked(...)`; `/health` returns the
  full `compute_health()` result, not just a bare `{"ok": true}`.
- **`config.py`**: new `ENVIRONMENT` (local/test/staging/production) —
  display/log metadata only, never selects which Supabase project is used.

### Typed data layer + new pages (web)

- **`lib/env.ts`** (new): `ENVIRONMENT`/`IS_PRODUCTION`/`BUILD_INFO` (git
  SHA + build time, injected by `vite.config.ts`'s `define`).
- **`lib/errors.ts`** (new): `citizenSafeErrorMessage(e, fallback)` —
  every citizen-facing component now shows a fixed, friendly message on
  failure instead of a raw database error string (still logged to the
  console in dev).
- **`lib/ops.ts`** (new): system health + pilot admin data layer —
  `fetchSystemHealth`, feature-flag read/write, station/registry/SLA-rule/
  playbook activation.
- **`components/ErrorBoundary.tsx`** (new): a top-level React error
  boundary — previously a render-time exception anywhere crashed to a
  blank white page; now shows a plain recovery screen with the build id.
- **`pages/OpsView.tsx`** (new): the `/ops` route (Settings in the icon
  rail, commander/admin only) — System Health table + feature-flag toggles
  + station/registry/SLA-rule/playbook activation lists. Deliberately
  narrow, not a general admin panel.
- **Non-production banner**: a visible amber banner whenever
  `VITE_ENVIRONMENT !== 'production'`, so a pilot tester can never mistake
  staging for the real deployment.

### CI/CD (new)

- **`.github/workflows/ci.yml`**: five jobs — secret scan + dependency
  audit, web (tsc/vitest/build), python (compile/pytest), database (full
  local RLS suite + idempotency + generated-types-drift check), and an
  informational-only hosted-drift check (only runs on `main`, only if
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` repo secrets are set, never
  blocks). **No migration is ever applied to any hosted project from
  CI** — deployment requires an explicit human running `make db-push` with
  their own credentials.
- **`scripts/check_secrets.py`** (new): a dependency-free scan for tracked
  `.env`-shaped files, real-looking values in `.env.example` files, and
  hardcoded JWT/API-key-shaped strings in tracked source. Wired into CI.
- **`supabase/scripts/check_hosted_drift.py`** (new) and **`supabase/
  scripts/hosted_smoke_test.py`** (new) — see "Preflight findings" above
  and [DEPLOYMENT.md](DEPLOYMENT.md). The smoke test creates and deletes
  its own uniquely-tagged fixtures and refuses to run at all against a
  hosted project missing required tables — verified this pass by actually
  running it against the real (currently unmigrated) hosted project and
  confirming it refuses cleanly rather than partially failing.

### Documentation (new)

`docs/DEPLOYMENT.md`, `docs/ENVIRONMENT_VARIABLES.md`, `docs/SECURITY.md`,
`docs/MONITORING.md`, `docs/BACKUP_AND_RECOVERY.md`,
`docs/PILOT_RUNBOOK.md` — all new this phase.

### Rules, and where they live

Job reliability and system health live entirely in SQL (`job_runs`'
structural unique-index guard, `system_health_summary()`) — Python's
`run_tracked(...)` is a thin, tested wrapper around calling these, not a
second implementation of the locking logic. Feature-flag reads
(`city_feature_enabled`) live in SQL for the engines that are themselves
SQL functions, and are checked directly in Python for the two engines that
are themselves Python (`forecast.py`, `notifications.py`) — never two
inconsistent copies of "is flag X on for city Y."

## Completed in this pass — Phase 11

The vertical slice: **prove the whole system against real historical Delhi
data and deterministic end-to-end scenarios, then produce an evidence-based
pilot-readiness sign-off** — not further feature work. Real OpenAQ/
Open-Meteo Delhi data was replayed through the actual detection and
forecasting engines; 10 end-to-end lifecycle scenarios (A-J) and 4
additional synthetic attribution scenarios were built and debugged to
passing; 13 named failure modes were drilled; a real EXPLAIN-ANALYZE-driven
performance fix was applied; a real Delhi operational-data audit was
produced (most notably: **zero `field_officer` accounts exist**); and the
final decision — **CONDITIONALLY PILOT READY** (hosted deployment still
blocked; PILOT READY cannot be used until it isn't) — was documented in the
new [PILOT_READINESS_REPORT.md](PILOT_READINESS_REPORT.md).

### New: historical replay framework (`ingest/scripts/`)

- **`historical_replay.py`** and **`forecast_replay.py`** (new): drive real
  OpenAQ v3 + Open-Meteo historical data (Dec 2018, 4 real Delhi stations,
  930 readings, a real severe winter smog episode) through the actual
  `run_anomaly_detection`/`run_incident_source_attribution` SQL functions
  and the actual `forecast.py` validation logic, against an isolated
  `city_code = 'replay_dec2018'` city (`config->'is_replay' = true`),
  fully resettable, never touching any real or pilot data. Full results in
  [HISTORICAL_REPLAY_REPORT.md](HISTORICAL_REPLAY_REPORT.md).
- **New fixtures**: `ingest/tests/fixtures/delhi_historical_openaq_dec2018.json`,
  `delhi_historical_weather_dec2018.json` — real, not synthetic, data.
- A documented **simulation accommodation** (disclosed, not hidden):
  `data_freshness_max_minutes` set to a very large number for the replay
  city only, since 2018 data is genuinely old relative to actual wall-clock
  `now()` — never applied to a real pilot city.

### New: end-to-end and attribution scenarios (`supabase/tests/`)

- **`120_pilot_validation_scenarios.sql`** (new, 4 tests): synthetic
  source-attribution scenarios not already covered by Phase 7's own suite
  (open_burning, industrial, genuinely mixed/ambiguous evidence,
  unresolved-registry-mapping degrading honestly rather than guessing).
- **`130_end_to_end_scenarios.sql`** (new, ~520 lines, scenarios A-J, 24
  assertions): full incident-lifecycle chains covering citizen-originated,
  sensor-detected, forecast-predicted, regional, unresolved-jurisdiction,
  failed-response/escalation, ineffective-action, recurrence, poor-data-
  quality, and duplicate/retry-safety scenarios. 3 real bugs found and
  fixed while constructing these (see
  [END_TO_END_TEST_REPORT.md](END_TO_END_TEST_REPORT.md)): `link_report_
  to_incident` requires a real authenticated caller; a forecast-driven
  predicted incident still needs the same data-completeness gate as a
  raw-reading detection; `submit_incident_recurrence_report` requires the
  citizen's own linking `reports` row, not just any citizen account.

### New: one real, justified performance fix

- **`20260726000000_pilot_validation_performance.sql`** (new migration):
  `readings(ts desc)` index, added after `EXPLAIN (ANALYZE, BUFFERS)` at
  realistic Delhi pilot scale (~24k readings) showed the `/health`
  freshness check doing a 5.6ms sequential scan; confirmed fixed to 0.1ms
  index-only scan. No other query showed a seq scan at this volume, so no
  other index was added speculatively. See
  [PILOT_READINESS_REPORT.md](PILOT_READINESS_REPORT.md) section 6.

### Real findings from this phase (not assumed, measured)

- **A real drift-check manifest gap**: `check_hosted_drift.py`'s own
  migration list never had Phase 10's `20260725000000_production_
  hardening.sql` added — fixed.
- **A real, empirically-tested migration-interruption recovery**: applying
  only the first half of a migration file, then re-applying the full file,
  proved every already-applied object is safely skipped and the remainder
  completes with zero manual intervention — genuine evidence for
  [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)'s recovery procedure,
  not just an assumption.
- **A real Delhi operational-data gap**: 11 of 13 stations resolved, 0 of 4
  `responsibility_registry` rows verified or contact-complete, and **zero
  `field_officer` accounts exist anywhere in this project's data** — the
  single most concrete "not yet operationally ready" finding this phase
  produced. Full detail and an import template in
  [DELHI_DATA_GAP_REPORT.md](DELHI_DATA_GAP_REPORT.md) and
  `supabase/RESPONSIBILITY_REGISTRY_IMPORT_TEMPLATE.csv`.
- **Resolved as of this phase: hosted deployment is complete.** The
  project owner ran `supabase db push` from their own machine. The first
  attempt found a genuine bug — `20260722000000_source_attribution.sql`
  added and used a new enum value in the same transaction, which `psql -f`
  (this repo's local test harness) tolerates via per-statement auto-commit
  but `supabase db push`'s per-file transaction does not. That migration's
  transaction rolled back cleanly (zero data loss). Fixed by splitting the
  enum additions into their own, earlier migration
  (`20260721500000_source_attribution_enum.sql`); the re-run completed
  all 12 migrations successfully, confirmed via `check_hosted_drift.py
  --strict` (zero drift). A row-count comparison across every preserved
  table (13 wards, 11 stations, 25 readings, 432 forecasts, 1 profile, 0
  reports, 0 actions, 39 weather rows) confirmed **zero change**. The
  hosted smoke test then found and fixed two further real bugs in the
  smoke test script itself (missing citizen impersonation for
  `submit_incident_recurrence_report`, and a cleanup-ordering FK bug that
  had left orphaned test fixtures on hosted — since manually removed) and
  passed 13/13 checks clean on re-run. See
  [DEPLOYMENT.md](DEPLOYMENT.md)'s "Known hosted-push issue" section and
  [PILOT_READINESS_REPORT.md](PILOT_READINESS_REPORT.md) section 10a.
  `database.types.ts` was first regenerated from the real hosted project
  (via the project owner's linked CLI) and verified byte-equivalent in
  every real domain object to the local-Postgres approximation — but this
  broke CI's own type-drift check, which specifically regenerates from
  the disposable local Postgres and diffs against the committed file (by
  this file's own documented convention, so hosted's extra
  `graphql_public`/`PostgrestVersion` metadata reads as drift). Reverted
  to generating from local Postgres, matching CI exactly; `tsc --noEmit`
  and `npm run build` both still pass clean.
- **A real CI failure, found only because CI does a genuinely fresh
  install**: `ingest/requirements.txt` had four invalid pip version
  specifiers (`anthropic>=0.40.*`, `pandas>=2.*`, `lightgbm>=4.*`,
  `pytest>=8.*` — mixing `>=` with a `.*` wildcard, which pip rejects
  outright). This had been silently masked all session because every
  local pytest run reused an already-installed `.venv`, never a true
  `pip install -r requirements.txt` from scratch. Fixed by dropping the
  invalid `.*` suffixes; verified against a genuinely fresh virtualenv
  this time (not the pre-existing one) — clean install, 37/37 tests pass.
- **Critical finding, found and fixed live against the real hosted
  project after manually testing the deployed Vercel frontend**: any
  self-registered citizen could elevate their own `role` to `admin` (or
  set `ward_id` to anything) via a direct REST API call —
  `profiles_self_update`/`profiles_insert_self` had restricted which row
  a self-scoped write could touch since Phase 0/1, but never which
  columns. Proven exploitable against real hosted data with a disposable
  test account, then fixed with a new migration
  (`20260727000000_profile_role_immutability.sql`), applied to hosted,
  and re-verified live with the same technique — now correctly rejected.
  9 new SQL tests cover it. Full detail in
  [SECURITY.md](SECURITY.md)'s Phase 11 section.

### Documentation (new this phase)

`docs/PILOT_READINESS_REPORT.md`, `docs/HISTORICAL_REPLAY_REPORT.md`,
`docs/END_TO_END_TEST_REPORT.md`, `docs/DELHI_DATA_GAP_REPORT.md`,
`docs/OPERATOR_ACCEPTANCE_CHECKLIST.md`,
`supabase/RESPONSIBILITY_REGISTRY_IMPORT_TEMPLATE.csv` — all new.
Existing docs ([ARCHITECTURE.md](ARCHITECTURE.md),
[DATA_MODEL.md](DATA_MODEL.md),
[DATA_QUALITY_AND_SCIENCE.md](DATA_QUALITY_AND_SCIENCE.md),
[ROLE_WORKFLOWS.md](ROLE_WORKFLOWS.md), this document,
[DEPLOYMENT.md](DEPLOYMENT.md), [SECURITY.md](SECURITY.md),
[MONITORING.md](MONITORING.md),
[BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md),
[PILOT_RUNBOOK.md](PILOT_RUNBOOK.md)) all updated with Phase 11 findings.

## Checks run

| Check | Result |
|---|---|
| `npm run build` (`tsc -b && vite build`) | ✅ Passes — no type errors, production bundle builds |
| `npx tsc --noEmit` against the regenerated, Phase-11-aware types | ✅ Passes |
| `npm test` (vitest) — `incidentRules.test.ts` | ✅ 138/138 pass (unchanged this phase — no new pure-TS rule logic was added) |
| `./supabase/tests/run.sh` — all twelve migrations + all thirteen test files on a disposable Postgres | ✅ All pass (195+ assertions, plus 4 + 24 new from `120_pilot_validation_scenarios.sql`/`130_end_to_end_scenarios.sql`) |
| All twelve migrations applied together, three more times after the initial apply | ✅ Idempotent |
| Generated-types drift check (`supabase gen types` vs. committed `database.types.ts`) | ✅ No drift after regeneration for the new index migration (also wired into CI) |
| Migration applied to the real **hosted** Supabase project | ✅ **Complete** — all 12 migrations applied, after finding and fixing a real migration-ordering bug (see [DEPLOYMENT.md](DEPLOYMENT.md)) |
| Hosted drift check (`check_hosted_drift.py --strict`) | ✅ Zero drift — all 12 migration markers present, real accumulated data untouched (row-count verified) |
| Hosted smoke test (`hosted_smoke_test.py`) | ✅ 13/13 checks pass — after finding and fixing two real bugs in the script itself (citizen impersonation, cleanup ordering); zero orphaned fixtures left behind |
| Hosted smoke test (`supabase/scripts/hosted_smoke_test.py`) | ⚠️ Correctly refuses to run — re-confirmed this phase |
| Secret scan (`scripts/check_secrets.py`) | ✅ Passes |
| Historical replay (`historical_replay.py --reset`, `forecast_replay.py`) | ✅ Runs cleanly against real OpenAQ/Open-Meteo data; results in [HISTORICAL_REPLAY_REPORT.md](HISTORICAL_REPLAY_REPORT.md) |
| `ingest/` Python — `python3 -m py_compile` on every module | ✅ Passes |
| `ingest/` Python — `pytest` | ✅ 37/37 pass (unchanged this phase — the replay scripts call existing, already-tested `forecast.py` functions directly rather than adding new pytest coverage) |

### What the Phase 8 database tests actually prove
`supabase/tests/90_unified_forecasting.sql` — 9 tests, 13 assertions, same
per-scenario city-isolation discipline as Phase 6/7's own files: any
authenticated user (citizen included) can read `forecast_runs`/`forecasts`
(transparency data) but NO authenticated role — commander included — can
write to `forecast_runs` directly, only the (RLS-bypassing) ingest service
can · pm25 and pm10 forecast rows coexist for the same ward without
cross-contaminating each other's queries · a validated forecast that
crosses the configured threshold drives a predicted incident labelled
`prediction_method = 'validated_forecast'` · with no forecast at all, the
engine falls back to the raw-reading trend (`trend_persistence`) · an
UNVALIDATED forecast (exists, but failed `beats_persistence`) is never
used, exactly like no forecast at all · a validated forecast whose curve
never crosses produces NO predicted stage — proven against a station whose
raw readings WERE trending upward, showing the validated "no" is trusted
over the trend's "yes", not silently overridden · a forecast older than
2× the configured retraining cadence is treated as unavailable · a
forecast-driven predicted incident still cannot create an enforcement
action (the same suspected-source gate applies regardless of which method
created it) · duplicate predicted incidents are still not created across
repeated validated-forecast firings.

### What the ingest/tests/test_forecast.py suite actually proves
15 tests against `RNG_SEED = 20260723` (fixed, never live data): MAE/RMSE/
bias/threshold-recall/false-alarm-rate formulas match hand-computed values
exactly · persistence and diurnal baseline construction are correct ·
`_validate`'s holdout is provably chronological, not random — a
constructed series with an outlier tail placed exactly at the computed
split boundary shows the training-only diurnal average is never polluted
by holdout-only values · `beats_persistence`/`max_validated_horizon_hours`
are monotonic across horizons · a flat, uninformative series honestly
reports `beats_persistence = False` (persistence trivially wins) rather
than a fabricated pass · a strong, learnable diurnal+weekly signal with low
noise lets the model genuinely beat persistence when the signal supports it
· `run()` end-to-end (with `db`/`open_meteo` fully mocked) produces exactly
48 hourly rows per ward with method attribution and the legacy `pm25_pred`
column populated, and skips a ward with no readings without crashing.

### What the Phase 9 database tests actually prove
`supabase/tests/100_authority_routing_and_dispatch.sql` — 14 test blocks,
24 assertions, each scenario in its own isolated `city_config` row (sharing
one city's `responsibility_registry` rows across scenarios is exactly what
would make an earlier scenario's registry row silently outrank a later
one — a real production behaviour that would otherwise look like flaky
test order-dependence): a specific, active registry match routes with
`confirmed` confidence and reaches `sent`, with routing evidence recorded ·
no registry match produces `unresolved` routing that stays `drafted` and
sends zero notifications — "must not silently dispatch" is structural, not
a check that could be skipped · a disputed match holds at
`awaiting_approval` for command review and `resolve_jurisdiction_dispute`
correctly reassigns it with a required, recorded reason · an illegal
lifecycle jump (`sent → completed`) is rejected server-side, a legal chain
applies and keeps `actions.workflow_status` in sync for the states the two
concepts share, and `rejected`/`rerouted`/`cancelled` are refused without a
reason · three repeated `dispatch_intervention_task` calls for the same
action produce exactly ONE `task_dispatches` row, not three · an
approval-gated action (equipment deployment, not already forced through
Phase 4's own enforcement-type trigger) is held at `awaiting_approval` and
never sent until approved · SLA due timestamps come from the
highest-priority MATCHING rule, not a default one sitting alongside it · a
dispatch past its SLA auto-escalates to `overdue`, and — the one genuinely
new escalation trigger this phase adds beyond a plain SLA timer — a task
marked `completed` with zero attached `action_evidence` and no `proof_url`
escalates IMMEDIATELY, not on the next SLA tick · every routing/dispatch/
acknowledgement/rejection step writes an immutable `incident_events` row ·
citizens read zero rows of `task_dispatches`/`notifications` and cannot
call `dispatch_intervention_task` at all · a field officer sees only tasks
assigned to them or in their own ward, never an unrelated officer's task in
a different ward · **no authenticated role, including a commander, can
write `task_dispatches` directly** — an actual `UPDATE` attempted as a
logged-in commander session affects 0 rows, proving the SECURITY DEFINER
functions are the only real write path, not just the intended one · a
field officer can report resource unavailability (never fabricated) and
request a reroute, but only command can make a reroute actually happen ·
notifications are queued per-channel (in-app + email when the recipient
has an address on file) with a schema that supports a genuine retry cycle.

### What the ingest/tests/test_notifications.py + test_dispatch.py suites actually prove
22 tests, all against fully mocked `db`/SMTP (no live network): the in-app
adapter always reports delivered (queuing IS delivering — no transport
needed) · the mock email adapter NEVER claims a real delivery, always
records "no email provider configured" · the unconfigured sms/whatsapp
adapters are honest failures naming exactly which channel and why · adapter
selection correctly falls back to the mock when `SMTP_HOST` is unset and
uses real SMTP when it's set · a genuinely unreachable SMTP server (port 1,
localhost) is caught cleanly into a `DeliveryResult`, never raises out of
`send()` and crashes the poller · a missing recipient address is refused
before attempting a send · `run()` marks a successful in-app send as `sent`
and calls the failure path zero times for it · a failing email retries with
an incrementing `retry_count`, staying `pending` (non-terminal) until the
retry budget (`MAX_RETRIES = 3`) is exhausted, at which point it's marked
`failed` (terminal) · the escalation-driver wrapper (`dispatch.py`) calls
the correct RPC name and parameters and summarises zero-vs-nonzero results
correctly.

### What the Phase 10 database tests actually prove
`supabase/tests/110_production_hardening.sql` — 10 test blocks, 18
assertions: a repeat `dispatch_intervention_task` call on an action already
`in_progress` neither regresses its status back to `sent` nor overwrites
`sent_at` nor sends an additional notification (the exact replay bug found
and fixed) · `completed -> escalated` is now accepted by
`transition_task_dispatch` (previously it would have rejected the same
transition its own batch driver performs) · a reason longer than 2000
characters is refused · `report-photos`' `update`/`delete` storage policies
are confirmed gone by directly querying `pg_policies` · `job_runs`'
partial unique index genuinely refuses a second concurrent "running" row
for the same job+city (`start_job_run` returns `null`, proven by actually
calling it twice) and allows a new run once the first completes ·
citizens/officers cannot read `job_runs` directly while `system_health_
summary()` gives a commander a working, non-empty rollup · disabling
`operational_dispatch` for a city makes `dispatch_intervention_task`
actually raise (not just silently skip), and re-enabling it lets dispatch
proceed again · a city with no `feature_flags` key at all still defaults to
enabled (never silently off for an unconfigured city) · **an automated
introspection check** (not a hardcoded function-name list) confirms every
`SECURITY DEFINER` function in the schema pins `search_path` — this will
catch a future migration that adds an unprotected one automatically · a
deliberately corrupted second city's `anomaly_detection` config (a
non-numeric threshold that throws inside `evaluate_station_pollutant_
anomaly`) does not prevent a healthy city's station from still producing a
result in the same unscoped `run_anomaly_detection()` call — proving the
per-iteration isolation fix actually isolates failures, not just in theory.

### What the ingest/tests/test_logging_utils.py + test_health_checks.py suites actually prove
10 tests, fully mocked `db.client()` (no live network): `run_tracked`
calls `fn()` and marks the job_runs row completed on success · on lock
contention (`start_job_run` returns `None`), `fn` is **never called at
all** — proving the function-wrapper design (not a context manager, which
cannot skip its own body) actually skips the job, not just logs a warning
around it still running · a failing `fn` is caught, recorded via
`fail_job_run`, and never re-raised to the caller · if `start_job_run`
itself throws (a transient DB blip), the job still runs anyway rather than
being silently lost · `compute_health()` reports `ok` when database/
freshness/jobs are all healthy, `degraded` when readings are stale OR any
job is stale (even with fresh readings), `down` only when the database
itself is unreachable, and `no_data` (not a false "stale") when there are
simply no readings yet.

### What the Phase 6 database tests actually prove
`supabase/tests/70_anomaly_detection.sql`, run as `authenticated` (fixtures
seeded as superuser; every RLS/authorization assertion executed as the real
role, a superuser would make that half pass vacuously) — 16 tests, 30
assertions, each scenario in its own fully-isolated `city_config` row (the
rule engine's local-excess computation is genuinely city-wide, so sharing
one city across scenarios produced flaky, order-dependent results during
manual verification — documented in the test file's own header): a single
isolated high reading with no persistence produces a stored candidate but
**no incident** · persistent readings with a meaningful local excess create
a correctly-labelled `detected` incident · a second firing in the same ward
**updates** the same incident rather than duplicating it · stale data is
suppressed regardless of how extreme the value looks · incomplete data is
suppressed · a regulatory sensor yields strictly higher confidence than an
indicative one on identical readings · a non-crossing but trending reading
produces a `predicted` incident with a projected crossing time · a city's
own configured threshold (not Delhi's default) is what actually gets used ·
the detection engine itself never creates an `actions` row, and the
resulting incident's own `suspected` evidence level still blocks enforcement
via the pre-existing Phase 3 gate · `local_excess` is verified arithmetically
(current − baseline) · citizens have **zero** read on `anomaly_candidates`,
a field officer sees only their own ward's, a commander sees all · only a
commander/admin (or an unauthenticated service-role-style caller) may run
detection at all · command can promote a predicted incident to confirmed and
dismiss one as a data anomaly, both auditable · `run_anomaly_detection`
evaluates exactly stations × that city's own `pollutant_priority` list · a
merge is traceable in both directions.

### What the Phase 5.1 database tests actually prove
`supabase/tests/60_recurrence_and_custom_hardening.sql`, run as
`authenticated`: a citizen linked to a closed incident can submit a
recurrence report · the same incident cannot be reported on while open · a
citizen with no linked report is refused even on a closed incident · the
report never auto-reopens the incident and never creates an `actions` row ·
a public `recurrence_submitted` event lands on the original incident ·
citizens have **zero** direct read on `incident_recurrence_reports` (RPC
only) · a duplicate submission while a report is pending is idempotent (same
id, one row) · a citizen's own attempted UPDATE affects **0 rows** (RLS,
silent) · command can dismiss / request more evidence / confirm · a standalone
confirm does not itself reopen the incident · command can reopen the original
incident from a report, and the citizen then sees `outcome_kind = reopened` ·
command can create a new linked incident, with traceability verified in
**both** directions (`recurrence_of_incident_id` and `resulting_incident_id`)
· command can merge a report into an already-open nearby incident, attaching
its evidence via the widened `evidence_type` · a field officer in a different
ward cannot read another ward's recurrence reports, same-ward can · a field
officer can no longer create an incident-linked action directly (the real,
verified `actions_write` gap, closed) · a commander can, with a reason · a
custom action with no reason (or a whitespace-only one) is refused · a custom
action still cannot bypass the suspected-incident gate or the
officially-verified+approver enforcement gate · a custom fallback still needs
a named approver for enforcement · a regional incident refuses a local custom
action type but accepts `advisory_monitoring` · once approved, an action's
descriptive fields are immutable but operational fields (e.g. `deadline`)
remain editable · both a custom and a playbook-based action get their
creation event written automatically, with no client-side call.

**A consequence of the hardening, not a bug**: making `custom_reason`
mandatory for every custom incident-linked action broke several *pre-existing*
Phase 3/4 test fixtures (`20_evidence_and_privacy.sql` tests 8b/8e,
`40_intervention_and_impact.sql` tests 12b/15) that inserted such actions with
no reason. Fixed by adding a `custom_reason` value to those specific inserts
— the fixtures' own assertions (evidence-level gate, closure guard) are
unchanged; only the previously-implicit "no reason needed" assumption they
never tested for was updated to match the new, intentionally stricter rule.

### What the Phase 5 database tests actually prove
`supabase/tests/50_intervention_playbooks.sql`, run as `authenticated`: all 6
seeded Delhi playbooks present and correctly tiered · a playbook-based action
is refused on a suspected incident (pre-existing gate) · succeeds once
corroborated · the enforcement-tier playbook is refused on a merely
corroborated incident · **a non-enforcement action type from an artificially
over-tiered playbook is refused below its own required evidence level** (the
new check, isolated from the enforcement-type gate) · the enforcement-tier
playbook still needs a named approver even once officially verified (the old
gate, unweakened by playbook use) · `playbook_id`/`playbook_version` are
stored correctly on the created action · `checklist_snapshot` matches the
playbook's checklist at creation time and **stays stable after the live
playbook is edited** · a recorded impact outcome is queryable by
`playbook_id` (the exact query the usage-metrics UI runs) · citizens have
**zero** read and **zero** write on `intervention_playbooks` · field officers
and commanders can read the seeded playbooks (unchanged Phase 2 policy,
exercised for the first time).

### What the Phase 4 database tests actually prove
`supabase/tests/40_intervention_and_impact.sql`, run as `authenticated` (a
superuser bypasses RLS and would make the suite pass vacuously):
intervention creation refused on a suspected incident · allowed once
corroborated · enforcement still needs an officially-verified source ·
an action can be walked drafted→…→completed but carries **no outcome** at
`completed` · writing an outcome state directly, with no impact evaluation,
is **refused** · a field officer cannot record an impact evaluation (RLS) ·
a missing "after" reading yields `inconclusive` · completeness below 50%
yields `inconclusive` even with an apparently large drop · a real ≥40% drop
with good data yields `effective` · a rise in the pollutant is **never**
labelled effective · the incident moves to `verifying`, never auto-closes ·
closing an incident with a completed-but-unevaluated action is **refused** ·
closing is allowed once every completed action has *an* evaluation (even an
inconclusive one) · a closed incident can be reopened, and the reopen is
recorded in the timeline · a citizen not linked to the incident cannot submit
an action verification · a linked citizen can · the citizen's answer does
**not** change the previously recorded impact outcome · a citizen has zero
read on `actions` and `action_evidence` (no enforcement/agency detail
exposed) · a citizen **can** read `impact_evaluations` (intentional — see
below) · a field officer can record and read their own `action_evidence`.

### One thing the tests confirmed was correct, not a gap
Citizens can read `impact_evaluations` in full. This was already the Phase 2
RLS policy, unchanged by Phase 4, and is **intentional**: an environmental
outcome (effective/ineffective/inconclusive) is exactly what plan §11/§15
wants a citizen able to track — "verify whether the intervention worked." It
carries no responsible-agency name, approver, or enforcement rationale; those
live exclusively on `actions`, which citizens cannot read at all. The test
(18c) is written to assert this is expected, not to flag it as a leak.

## Known limitations

1. **The migrations are not applied to the hosted Supabase project.**
   Everything above was verified against a disposable local Postgres built
   from `schema.sql` + `migrations/`. Confirmed this pass via a read-only
   check (`supabase/scripts/check_hosted_drift.py`) that the one known
   hosted project is stuck on the base Phase 0/1 schema, with real
   accumulated data (13 wards, 11 stations, 25 readings, 432 forecasts, 1
   profile) — not a disposable test database. Applying to hosted needs the
   project owner's own `supabase login` → `make link && make db-push`. **Do
   not read the green checks above as "the hosted database is ready."** See
   [DEPLOYMENT.md](DEPLOYMENT.md).
2. **`database.types.ts` was generated locally (this pass: verified against
   a real disposable Postgres via Docker, rebuilt from every migration
   through Phase 10), not from the linked hosted project** (no hosted
   credentials in this environment). Should regenerate byte-identical via
   `make gen-types` *if* hosted only ever changed through `migrations/`. A
   generated-types-drift check is now wired into CI so this can never
   silently go stale again on `main`.
3. **The operational lifecycle order (`drafted → … → verification_pending`)
   is a client-side discipline, not a database constraint.** Unlike the
   suspected/corroborated/verified gate or the "no outcome without an
   evaluation" rule — both enforced in the trigger — nothing in the database
   stops a direct `UPDATE actions SET workflow_status = 'in_progress'` on a
   still-`drafted` row from skipping `awaiting_approval`/`assigned`/
   `accepted`. `nextOperationalStatus()` in `incidentRules.ts` is what keeps
   the UI honest; a determined or buggy client could still skip a step. Worth
   promoting to a DB constraint if a second UI ever writes this column.
4. **`submitFieldCompletion` and `recordImpactEvaluation` are not
   transactions** — supabase-js has no client-side transaction. A failure
   partway (e.g. photo upload succeeds, the `actions` update fails) can leave
   partial state. Both fail in the safer direction (the write most likely to
   fail is the one gated by the DB trigger, which either fully applies or
   fully rejects) and are recoverable by re-running from the command
   workspace, but true atomicity would need one more RPC each — noted as
   follow-up rather than silently assumed solved.
5. **`createLinkedIncidentFromRecurrence` and `mergeRecurrenceIntoIncident`
   (Phase 5.1) are not transactions** — same supabase-js limitation as items 4
   and 9: the new-incident-or-evidence insert and the recurrence-report update
   are two separate calls. A failure between them leaves the new
   incident/evidence written but the report still `pending` — recoverable by
   retrying the disposition from the Recurrence panel, not silently lost.
6. **No weather adjustment, comparable-location control, or causal claim** —
   deliberately out of scope for this phase per the brief. Every
   `impact_evaluations` row carries a fixed `method_limitation` string saying
   so, so the limitation travels with the data rather than living only in a
   doc a UI could silently drop.
7. **`data_completeness` is operator-entered, not computed** from actual
   reading counts against the observation window — there is no per-reading
   completeness pipeline yet (see [DATA_QUALITY_AND_SCIENCE.md](DATA_QUALITY_AND_SCIENCE.md)).
   The command form is explicit that this is a manual estimate, not a metric.
8. **No UI to create or edit a playbook.** The Phase 5 picker only *selects*
   from existing `intervention_playbooks` rows — adding a new one or editing
   an existing template (as opposed to a per-incident operational-notes
   addendum, which the picker does support) is still direct SQL. Matches the
   unchanged Phase 2 RLS (commander/admin write), just no in-app form yet.
9. **`createInterventionFromPlaybook` is not a transaction** — same
   supabase-js limitation as item 4 above (fetch the playbook, then insert);
   a failure between the two leaves nothing written (fails closed, not
   partially), recoverable by retrying from the picker.
10. **Playbook usage-metric queries are RLS-scoped like every other `actions`
    query** — a field officer sees only their own ward's usage of a playbook,
    commander/admin see all of it. Inherited from the existing ward-scoping
    pattern (`listInterventionsForOfficer`), not a new gap introduced here.
11. **Carried over from Phase 3/4/5, still true**: the Phase 3 incident-level
    `Escalated` queue is still a bare age-over-hours rule, unrelated to
    Phase 9's own real, configurable-by-rule SLA/escalation engine on
    `task_dispatches` — the two are genuinely separate mechanisms at
    different granularity (one incident-level flag vs. per-checkpoint SLA
    timers on each dispatched task) and were not unified this pass; no
    offline field drafts; role/ward assignment is manual SQL; no ESLint/CI;
    `R.K. Puram` and `Mayapuri`'s OpenAQ ids are still `null` (2 of 13
    configured Delhi stations never ingest, and so never feed detection
    either); no in-app playbook editor (item 8). The `Predicted` queue
    itself is no longer always-empty as of Phase 6 — see items 14-16 below
    for what IS and is not real about that.
12. **"Merge with an already-open nearby incident" needs the commander to
    already know the target incident's id** — there is no map-based "nearby
    open incidents" picker yet. The command UI asks for the id directly
    (`window.prompt`, matching this workspace's existing pattern for other
    single-field asks like "route to authority"); a proper picker is future
    UI work, not a data-model gap — `haversineMeters` already exists and
    could rank candidates once wired up.
13. **The reopen-vs-new-incident recommendation reads only the incident's own
    fields and the report just submitted** — it does not look at *other*
    pending recurrence reports on the same incident, or at nearby incidents,
    when scoring "same location". Command sees every report individually in
    the Recurrence panel and can always override the recommendation; nothing
    about the six review actions depends on the recommendation being complete.
14. **Anomaly-detection thresholds are AQI-category boundaries, not
    validated health-effect or intervention-efficacy thresholds** — pm25/pm10
    are taken directly from this repo's own `ingest/app/aqi.py` breakpoint
    table; no2/so2/co/o3 are rougher, explicitly-flagged approximations that
    need a domain-expert review before any production/enforcement reliance.
    Full basis and honest caveats in
    [DATA_QUALITY_AND_SCIENCE.md](DATA_QUALITY_AND_SCIENCE.md).
15. **Resolved as of Phase 8** (kept here, marked resolved, rather than
    silently deleted, so the historical record stays intact): the "predicted"
    stage used to be ONLY a raw-reading linear trend projection, unrelated to
    the LightGBM forecast. As of Phase 8, a validated forecast is used first
    when one exists (`evaluate_station_pollutant_anomaly`), with the trend
    projection now an explicit, labelled fallback (`prediction_method`) for
    when no validated forecast is available — see the Phase 8 section above
    and [DATA_QUALITY_AND_SCIENCE.md](DATA_QUALITY_AND_SCIENCE.md) for the
    validation methodology and its own honest limitations (items 19-22
    below).
16. **Detection quality is bounded by real station coverage**: with as few
    as 1-2 stations reporting at once in a sparse city, `local_excess`'s
    city-wide baseline and `nearby_station_diff` can be a single station's
    value, not a meaningful aggregate. Never fabricated (both are `null`,
    not zero, when no other station is reporting), but not statistically
    robust at Delhi's current 11-of-13-resolved station density either.
17. **`evaluate_station_pollutant_anomaly` / the merge and dismiss review
    actions are not transactions** — same supabase-js/multi-statement
    limitation as items 4/5/9. The rule engine's OWN create-or-update step
    (deduplication + incident write) IS atomic (a single SQL function, per
    plan's own explicit requirement) — only the client-side review actions
    (`mergePredictedIncident`'s evidence-insert-then-incident-update) are
    not, and fail in the recoverable direction (retry from the panel).
18. **Resolved as of Phase 7** (this item was left stale, still describing
    the pre-Phase-7 gap, in the pass that actually closed it — fixed here):
    `calculate_incident_source_attribution` now runs for every open
    incident, auto-detected or citizen-reported alike, and populates
    `incident_source_hypotheses` with a full evidence breakdown. See the
    Phase 7 section above.
19. **The forecast uncertainty range is a residual-RMSE normal
    approximation (`predicted ± 1.28×RMSE`), not a calibrated quantile-
    regression interval.** A stated, simple, honestly-labelled choice — a
    real quantile model would be exactly the kind of added ML complexity
    this phase's own brief asks to avoid. It will typically run too narrow
    in genuinely unusual conditions and too wide in calm ones (the standard
    failure mode of assuming normal, homoscedastic residuals).
20. **`min_mae_improvement_pct` (5%) and the four supported horizons
    (6/12/24/48h) are stated, defensible choices, not derived from a formal
    minimum-detectable-effect power analysis** — that would need historical
    forecast-error variance data this system doesn't have yet.
21. **PM10/NO2 forecasting reuses the identical pipeline, feature set, and
    validation bar as PM2.5, with no pollutant-specific tuning** — "add
    PM10 where sufficient data exists, keep NO2 optional/supporting" is
    satisfied by the SAME `MIN_TRAIN_ROWS`/`beats_persistence` gate applying
    per pollutant independently (a pollutant with too little history simply
    falls back to the diurnal baseline on its own), not by a separately
    calibrated model per pollutant.
22. **The recursive multi-step forecast compounds its own prediction
    errors** — a wrong value at hour 3 becomes part of the lag input for
    hour 4, inherent to any recursive (as opposed to direct-multi-horizon)
    forecaster. This is exactly why validation is measured at the actual
    checkpoint horizons via full re-simulation, not assumed from 1-step
    accuracy — see [DATA_QUALITY_AND_SCIENCE.md](DATA_QUALITY_AND_SCIENCE.md).
23. **`forecast_runs`/`forecasts` have no authenticated write policy at
    all** (verified, test 76c) — only the ingest service's service_role
    connection writes them, exactly like `readings`/`weather` already work.
    A local dev environment that wants to see real (not just seeded-by-hand)
    forecast data therefore needs the ingest service actually running
    against the same database, not just the web app.
24. **No credentialed SMS/WhatsApp provider.** `ingest/app/notifications.py`
    implements the adapter INTERFACE for both (plan §6's own "WhatsApp-ready
    adapter interface" requirement), but every send always returns an
    honest "no provider configured" failure — this environment has no SMS/
    WhatsApp credentials, and wiring a real provider is future work, not
    something this pass could verify without them.
25. **Email delivery is untested against a real SMTP server** — only the
    mock adapter (no `SMTP_HOST`) and a deliberately-unreachable-server
    failure path (proving `send()` fails cleanly rather than crashing the
    poller) were exercised. `SmtpEmailAdapter`'s happy path is implemented
    per the standard library `smtplib` contract but not verified against a
    live mailbox in this pass.
26. **Arrival has no dedicated lifecycle status** — plan §4's 15 states are
    exactly what the enum implements; "mark arrival" (plan §11) is modelled
    as `arrived_at` being set the first time a dispatch reaches
    `in_progress`, not as a distinct, separately-trackable event. A real
    gap between "accepted" and "arrived" (e.g. long travel time) is
    therefore not independently visible on the SLA countdown.
27. **Resource availability defaults to `unknown` and stays there until an
    officer explicitly reports otherwise** — there is no shift roster,
    equipment inventory, or workload system to check against (plan §9's own
    explicit "if resource data is missing, do not invent availability, show
    'availability unknown'" requirement, honoured literally, not worked
    around).
28. **`dispatch_intervention_task`/`transition_task_dispatch`/etc. are not
    called automatically from `approveIntervention`/`assignIntervention`**
    (the existing Phase 3/4 functions) — a commander must separately open
    the Operations panel and click dispatch. The two systems are wired
    together by reading the same `actions` row, not by one calling the
    other, so an approved intervention does not auto-dispatch itself yet.
    A deliberate decision this pass (avoiding a bigger, riskier change to
    already-tested Phase 3/4 write paths), not an oversight — worth
    revisiting once Phase 9's own paths have real production mileage.
29. **No city-level RLS scoping for command roles** — `profiles` has no
    `city_id`; a commander/admin has implicit access to every city's data.
    Fine while Delhi is the only configured city (every phase since Phase
    6 has declared multi-city out of scope); a real gap to close with its
    own dedicated schema work before a second city's real data ever shares
    this project. See [SECURITY.md](SECURITY.md).
30. **No real alert delivery is configured** — structured logs, `job_runs`,
    `system_health_summary()`, and `/health` all exist and are correct, but
    nothing pages anyone. Wiring a real provider (Slack webhook, email,
    PagerDuty) needs credentials this environment doesn't have. See
    [MONITORING.md](MONITORING.md)'s explicit table of what's visible today
    vs. what would need a real integration.
31. **No backup has been verified for the actual hosted project** — this
    phase documents what to check (plan tier, PITR availability) and a
    recovery runbook for several failure scenarios, but did not (could not,
    from this environment) confirm an actual working backup exists. See
    [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md).
32. **CORS on the ingest service is still `allow_origins=["*"]`** — flagged
    in-code since Phase 0, still not tightened to the real deployed
    frontend domain, since no real deployed domain exists yet to tighten it
    to. A concrete pre-production action item (see
    [PILOT_RUNBOOK.md](PILOT_RUNBOOK.md)).
33. **The incident queue's flat `.limit(200)` has no pagination UI** — a
    pre-existing bound (not new this phase), unlikely to be hit at current
    single-city pilot scale, but genuinely means the 201st incident would
    silently stop appearing rather than being reachable via a "next page."
    Noted during this phase's performance review, not fixed — building real
    pagination is a UI feature, not a hardening fix.
34. **Zero `field_officer` accounts exist anywhere in this project's data**
    (found this phase) — a dispatch can be created and correctly routed,
    but there is no real person to acknowledge, accept, or complete it.
    The single most concrete pilot-blocking finding in
    [DELHI_DATA_GAP_REPORT.md](DELHI_DATA_GAP_REPORT.md).
35. **`responsibility_registry` has zero verified, ward-specific rows for
    Delhi** — all 4 existing rows are city-wide and `mapping_confidence =
    'estimated'`. Routing will resolve `probable`, not `confirmed`, until
    real data is imported via `supabase/RESPONSIBILITY_REGISTRY_IMPORT_
    TEMPLATE.csv`'s validated process.
36. **Source-attribution accuracy has no real-world validation** — a
    structural limitation of the domain, not a gap in this codebase: no
    labelled ground-truth dataset exists anywhere for "what actually
    caused this smog episode," so the 14 SQL attribution scenarios prove
    the MECHANISM is sound, never that it is accurate against reality. See
    [HISTORICAL_REPLAY_REPORT.md](HISTORICAL_REPLAY_REPORT.md) section 1.
37. **No manual "retry this failed job now" UI action** — recovery today
    means waiting for the next scheduled tick or restarting the ingest
    process. Found while walking the actual runbook sequence this phase;
    see [OPERATOR_ACCEPTANCE_CHECKLIST.md](OPERATOR_ACCEPTANCE_CHECKLIST.md).
38. **No real human operator has used `PILOT_RUNBOOK.md` yet** — this
    phase's own acceptance checklist is a structural/mechanism check
    (every step is backed by real, tested code), not proof that a trained
    human has clicked through the actual UI end to end.

## Required credentials / data for next steps

- **Supabase access token** (project owner) → `make link && make db-push` to
  apply all ten incident/intervention/playbook/recurrence/anomaly-
  detection/attribution/forecasting/dispatch/hardening migrations to
  hosted, then `make gen-types` to confirm `database.types.ts` matches.
  Nothing in this pass used that token. See [DEPLOYMENT.md](DEPLOYMENT.md)
  for the full sequence.
- **At least one `field_officer` profile with a `ward_id`** — unchanged
  requirement from Phase 3, needed to assign interventions/missions and now
  also to route Phase 9 dispatches to a real `primary_officer`.
- **`ingest/`'s existing service_role env vars** (`SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`) — already required since Phase 1;
  `notifications.py`/`dispatch.py` use the same connection, no new
  credential for that part.
- **Optional: `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`/
  `SMTP_FROM`** (new, `ingest/.env.example`) — without these,
  `notifications.py` uses the development-safe mock email adapter and
  every email notification is honestly recorded as "no provider
  configured," never claimed as delivered. No SMS/WhatsApp credential
  exists to request yet — that provider integration is still future work
  (limitation 24).
- A domain expert to review the NO2/SO2/CO/O3 threshold approximations
  before they're relied on for anything beyond internal testing (limitation
  14) — PM2.5/PM10 are already grounded in this repo's own AQI table and
  need no such review. The same caveat now also applies to
  `min_mae_improvement_pct`/the forecast horizon set (limitation 20).
- **At least 10 days of hourly `readings` history per ward+pollutant**
  before the LightGBM path in `forecast.py` is even attempted
  (`MIN_TRAIN_ROWS`) — below that, the pipeline correctly and honestly uses
  the diurnal/persistence fallback rather than training on too little data;
  this is real cadence a live deployment needs to accumulate, not something
  this pass can shortcut.
- **A city ops lead to populate `responsibility_registry` with real
  team names, backup agencies, contact channels, working hours, and an
  escalation hierarchy** — the Delhi seed carried over from Phase 7 has
  only `regulating_authority`/`division_zone` filled in; every Phase 9
  column added this pass (`team_name`, `contact_channel`, `working_hours`,
  `escalation_hierarchy`, ...) is real schema with no real Delhi data in it
  yet, so `routing_confidence` will read `probable` (city-wide match, not
  `verified`) rather than `confirmed` until someone fills those rows in.
- **A Supabase personal access token** (distinct from the service_role key)
  to actually run `make link && make db-push` — see item 1 above and
  [DEPLOYMENT.md](DEPLOYMENT.md).
- **Vercel and Render account access** to actually deploy the frontend and
  ingest service — configs are ready (`web/vercel.json`,
  `ingest/render.yaml`), no account credentials exist in this environment.
- **Optional GitHub repo secrets** `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
  to enable the informational (never-blocking) hosted-drift CI job.

## Exact next vertical slice

**Close the conditions listed in [PILOT_READINESS_REPORT.md](PILOT_READINESS_REPORT.md)
section 14** — this is not a new feature phase, it is the small, concrete,
already-enumerated list standing between **CONDITIONALLY PILOT READY** and
**PILOT READY**:

1. Obtain a Supabase personal access token and actually apply all 11
   migrations to the hosted project (`make link && make db-push`).
2. Verify hosted data preservation (row counts/identifiers for the 13
   wards, 11 stations, 25 readings, 432 forecasts, 1 profile already
   there stay unchanged).
3. Run the hosted smoke test successfully against the migrated project.
4. Import real, verified `responsibility_registry` data for at least the
   pilot wards, using `supabase/RESPONSIBILITY_REGISTRY_IMPORT_TEMPLATE.csv`.
5. Create real field-officer accounts for at least the pilot wards (zero
   exist today — limitation 34).
6. Set `operational_dispatch` to command-review-only until condition 4 is
   substantially complete.
7. Have a real human pilot operator walk `PILOT_RUNBOOK.md` end to end,
   closing the "not yet human-trained" gap
   [OPERATOR_ACCEPTANCE_CHECKLIST.md](OPERATOR_ACCEPTANCE_CHECKLIST.md)
   documents.

**A smaller, independent alternative** if hosted deployment needs more
lead time first: **a minimal in-app playbook editor** (command/admin
only, matching the existing RLS) — a form over `intervention_playbooks`'
own fields, so adding or retiring a playbook stops requiring direct SQL
access. Also still available: closing the city-level RLS scoping gap
(limitation 29) before a second city is ever configured.

Deliberately **not** in either: a real SMS/WhatsApp provider integration
without the user supplying credentials first, route optimisation or live
GPS tracking, automated penalties, ML-based routing/escalation
prediction, a citywide redesign, or multi-city deployment — all
explicitly out of scope per the brief.
