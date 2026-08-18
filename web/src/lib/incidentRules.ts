/**
 * Incident workflow rules — pure functions, no I/O.
 *
 * Everything here is a *stated rule*, not a model. Phase 3 is deliberately
 * rule-based (no ML): every threshold in this file is a number a city can point
 * at, argue with and change. Keeping the rules pure also means they are unit
 * tested directly (see incidentRules.test.ts) rather than only through the UI.
 *
 * Where a rule is also enforced in the database, that is called out — the DB is
 * the authority (it holds regardless of which client writes), and these
 * functions exist so the UI can explain and pre-empt the rule rather than
 * letting the user hit a raw Postgres error.
 */
import type { Database } from './database.types'

export type SourceConfidence = Database['public']['Enums']['source_confidence_level']
export type IncidentStatus = Database['public']['Enums']['incident_status']
export type SourceCategory = Database['public']['Enums']['source_category']
export type IncidentClassification = Database['public']['Enums']['incident_classification']
export type DetectionStage = Database['public']['Enums']['incident_detection_stage']
export type Severity = 'low' | 'moderate' | 'high' | 'severe'

/** The six pollutants the data model supports (plan §1). */
export const POLLUTANTS = ['pm25', 'pm10', 'no2', 'so2', 'co', 'o3'] as const
export type Pollutant = (typeof POLLUTANTS)[number]

export const POLLUTANT_LABEL: Record<Pollutant, string> = {
  pm25: 'PM2.5',
  pm10: 'PM10',
  no2: 'NO₂',
  so2: 'SO₂',
  co: 'CO',
  o3: 'O₃',
}

/**
 * Ordinal rank for source_confidence_level, mirroring the Postgres enum's
 * declaration order (`suspected` < `corroborated` < `officially_verified`),
 * which is what `enforce_incident_action_rules` compares directly in SQL.
 * Kept here as an explicit table — rather than relying on array position at
 * every call site — so "does A meet-or-exceed B" reads the same way in both
 * places and is trivially unit-testable.
 */
export const CONFIDENCE_RANK: Record<SourceConfidence, number> = {
  suspected: 0,
  corroborated: 1,
  officially_verified: 2,
}

export function meetsEvidenceLevel(actual: SourceConfidence, required: SourceConfidence): boolean {
  return CONFIDENCE_RANK[actual] >= CONFIDENCE_RANK[required]
}

// ── report → incident matching rule ──────────────────────────────────────────

/**
 * The matching rule's parameters. The rule ITSELF lives in the
 * `link_report_to_incident` SQL function (it has to: matching must be atomic
 * with the insert to actually prevent duplicates under concurrency).
 *
 * These constants are passed explicitly to the RPC on every call, so the values
 * the UI explains to the operator and the values the database applies cannot
 * drift apart. The SQL defaults are a fallback for non-UI callers.
 */
export const MATCHING_RULE = {
  recencyHours: 12,
  radiusM: 750,
} as const

/** How the matching rule reads in plain language, for the incident detail panel. */
export function describeMatchingRule(): string {
  return (
    `A new report joins an open incident in the same ward when it arrives within ` +
    `${MATCHING_RULE.recencyHours}h of detection, names the same source category, and ` +
    `(when both have GPS) sits within ${MATCHING_RULE.radiusM}m. Otherwise a new incident is opened.`
  )
}

/**
 * Great-circle distance in metres. Used for display ("420m from the incident
 * centre"); the matching decision itself is made in SQL.
 */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// ── severity ─────────────────────────────────────────────────────────────────

/**
 * Severity from forecast local excess (µg/m³ of PM2.5 above the city baseline)
 * — "the part the city can actually act on". Mirrors the same thresholds the
 * SQL uses when it snapshots severity at detection.
 *
 * Returns null when there is no forecast: an unknown severity is shown as
 * "unavailable", never defaulted to 'low'.
 */
export function severityFromLocalExcess(excess: number | null | undefined): Severity | null {
  if (excess == null || Number.isNaN(excess)) return null
  if (excess >= 100) return 'severe'
  if (excess >= 50) return 'high'
  if (excess >= 20) return 'moderate'
  return 'low'
}

/** CPCB AQI band name for a raw AQI number - the same breakpoints the
 *  Overview map's choropleth colors by (0/50/100/200/300/400), as plain
 *  text rather than a color. Lets a reading stand on its own ("387 · Very
 *  Poor") instead of needing a second, separately-derived severity badge
 *  next to it for the same "how bad is this" question. */
export function aqiBandLabel(aqi: number): string {
  if (aqi >= 400) return 'Severe'
  if (aqi >= 300) return 'Very Poor'
  if (aqi >= 200) return 'Poor'
  if (aqi >= 100) return 'Moderate'
  if (aqi >= 50) return 'Satisfactory'
  return 'Good'
}

export const SEVERITY_RANK: Record<Severity, number> = {
  severe: 3,
  high: 2,
  moderate: 1,
  low: 0,
}

// ── evidence levels and task rules (plan §9) ─────────────────────────────────

export type TaskKind = 'evidence' | 'inspection' | 'preventive' | 'enforcement'

/** Enforcement action types. Mirrors the DB trigger's list exactly. */
export const ENFORCEMENT_TYPES = ['penalty', 'stop_work', 'closure', 'restriction', 'prosecution'] as const
export type EnforcementType = (typeof ENFORCEMENT_TYPES)[number]

export function isEnforcementType(type: string): type is EnforcementType {
  return (ENFORCEMENT_TYPES as readonly string[]).includes(type)
}

/**
 * Which task kinds an incident's evidence level permits.
 *
 *   suspected           → evidence collection only
 *   corroborated        → + inspection / preventive action
 *   officially_verified → + enforcement (which still needs a human approver)
 *
 * Also enforced by the `enforce_incident_action_rules` DB trigger.
 */
export function allowedTaskKinds(level: SourceConfidence): TaskKind[] {
  switch (level) {
    case 'suspected':
      return ['evidence']
    case 'corroborated':
      return ['evidence', 'inspection', 'preventive']
    case 'officially_verified':
      return ['evidence', 'inspection', 'preventive', 'enforcement']
  }
}

export function canCreateTask(level: SourceConfidence, kind: TaskKind): boolean {
  return allowedTaskKinds(level).includes(kind)
}

/**
 * Why a task kind is blocked, for the UI to show instead of a disabled button
 * with no explanation. Returns null when the task is allowed.
 */
export function taskBlockedReason(level: SourceConfidence, kind: TaskKind): string | null {
  if (canCreateTask(level, kind)) return null
  if (level === 'suspected') {
    return 'This source is only suspected. Collect evidence first - action tasks need a corroborated source.'
  }
  return 'Enforcement needs an officially verified source, confirmed by an authorised officer or official record.'
}

/**
 * Enforcement ALWAYS needs a named human approver, even when the source is
 * officially verified. There is no automation path to a penalty (plan §14).
 */
export function requiresHumanApproval(actionType: string): boolean {
  return isEnforcementType(actionType)
}

export const CONFIDENCE_LABEL: Record<SourceConfidence, string> = {
  suspected: 'Suspected',
  corroborated: 'Corroborated',
  officially_verified: 'Officially verified',
}

/** Evidence-level upgrade rule, mirrored from SQL, for explaining the timeline. */
export const CORROBORATION_RULE =
  'Two or more reports from different people naming the same source category. Reports from one person are not independent corroboration.'

// ── command queue filters ────────────────────────────────────────────────────

export type QueueKey = 'active' | 'predicted' | 'verification' | 'assigned' | 'escalated' | 'recurrence' | 'closed'

export const QUEUE_LABELS: Record<QueueKey, string> = {
  active: 'All Open',
  predicted: 'Predicted',
  verification: 'Awaiting Verification',
  assigned: 'Assigned',
  escalated: 'Needs Attention',
  recurrence: 'Recurrence',
  closed: 'Closed',
}

/**
 * Interim SLA used to derive the Escalated queue. Real SLA/escalation tracking
 * (per-authority clocks, reminders, escalation chains) is Phase 5 work and has
 * no schema yet — this age-based rule is an honest stand-in, not a claim that
 * SLA tracking exists. It is stated in the UI wherever it is used.
 */
export const ESCALATION_SLA_HOURS = 24

export type CurrentReading =
  | { kind: 'live'; aqi: number }
  | { kind: 'forecast'; excess: number }
  | { kind: 'unavailable' }

/**
 * The incidents table has no live AQI/PM2.5 field of its own — only
 * `local_excess`, a forecast-derived figure. Prefer the ward's real live
 * reading (from fetchAllWardsAqi, joined by ward_id) when one exists;
 * fall back to the incident's own forecast excess rather than inventing a
 * number. Never silently blank when either real value exists.
 */
export function currentReading(wardAqi: number | null, localExcess: number | null): CurrentReading {
  if (wardAqi != null) return { kind: 'live', aqi: wardAqi }
  if (localExcess != null) return { kind: 'forecast', excess: localExcess }
  return { kind: 'unavailable' }
}

export interface QueueIncident {
  status: IncidentStatus
  detection_method: string
  detected_at: string
  assigned_authority: string | null
  /**
   * Count of PENDING recurrence reports on this (necessarily closed) incident.
   * Optional/undefined when not fetched — a queue built without this data
   * simply never shows anything in the 'recurrence' tab, rather than crashing
   * or silently misclassifying (see `inQueue`'s 'recurrence' case).
   */
  pending_recurrence_count?: number
  /**
   * Set only for an incident that originated from automated anomaly
   * detection (Phase 6) — null for a citizen-reported or manually-created
   * incident. Drives the 'predicted' queue tab (see `isPredicted`).
   */
  detection_stage?: DetectionStage | null
}

const OPEN_STATUSES: IncidentStatus[] = [
  'detected',
  'under_review',
  'evidence_gathering',
  'routed',
  'action_approved',
  'action_dispatched',
  'in_progress',
  'verifying',
]

const DISPATCHED_STATUSES: IncidentStatus[] = ['action_dispatched', 'in_progress', 'verifying']

export function isOpen(i: QueueIncident): boolean {
  return OPEN_STATUSES.includes(i.status)
}

/**
 * A predicted incident is one the automated anomaly-detection rule engine
 * (Phase 6) flagged as TRENDING toward a threshold crossing, not yet actually
 * crossing it — `incidents.detection_stage = 'predicted'`, set only by
 * `evaluate_station_pollutant_anomaly` in SQL, never by this function. Falls
 * back to the pre-Phase-6 `detection_method` prefix heuristic for any row
 * that predates the `detection_stage` column (none exist in practice — no
 * code ever wrote a `'forecast*'` detection_method — but the fallback costs
 * nothing and keeps this function correct for an unmigrated read).
 */
export function isPredicted(i: QueueIncident): boolean {
  if (i.detection_stage != null) return i.detection_stage === 'predicted'
  return i.detection_method.startsWith('forecast')
}

/** Open past the SLA without anything having been dispatched. */
export function isEscalated(i: QueueIncident, now: number = Date.now()): boolean {
  if (!isOpen(i)) return false
  if (DISPATCHED_STATUSES.includes(i.status)) return false
  const ageHours = (now - new Date(i.detected_at).getTime()) / 3_600_000
  return ageHours > ESCALATION_SLA_HOURS
}

export interface NextActionInput {
  status: IncidentStatus
  source_confidence: SourceConfidence
  assigned_authority: string | null
}

/**
 * One short, imperative label for "what does this incident need next" -
 * replaces the old per-row severity + escalation badge pair, which lost all
 * discriminatory value once the escalation rule (see isEscalated above)
 * started matching nearly every open incident. Shared by the list row and
 * the detail header's "recommended next action" so the two never disagree
 * about what a given incident needs. Null only for a closed incident.
 */
export function nextActionLabel(i: NextActionInput): string | null {
  if (i.status === 'closed') return null
  if (i.status === 'verifying') return 'Awaiting verification'
  if (DISPATCHED_STATUSES.includes(i.status)) return 'In progress'
  if (i.status === 'routed' || i.status === 'action_approved' || i.assigned_authority != null) return 'Awaiting dispatch'
  if (i.source_confidence === 'suspected') return 'Needs evidence'
  return 'Ready to route'
}

export function inQueue(i: QueueIncident, queue: QueueKey, now: number = Date.now()): boolean {
  switch (queue) {
    case 'active':
      return isOpen(i)
    case 'predicted':
      return isOpen(i) && isPredicted(i)
    case 'verification':
      return i.status === 'evidence_gathering' || i.status === 'verifying'
    case 'assigned':
      return isOpen(i) && (i.assigned_authority != null || DISPATCHED_STATUSES.includes(i.status) || i.status === 'routed')
    case 'escalated':
      return isEscalated(i, now)
    case 'recurrence':
      return i.status === 'closed' && (i.pending_recurrence_count ?? 0) > 0
    case 'closed':
      return i.status === 'closed'
  }
}

// ── citizen verification safety (plan §11) ───────────────────────────────────

/**
 * Source categories a citizen must never be asked to go and inspect. Fires and
 * industrial emissions carry a real physical hazard, and asking an untrained
 * member of the public to approach one to take a photo is not an acceptable way
 * to collect evidence — that is a field officer's job.
 */
export const HAZARDOUS_FOR_CITIZENS: SourceCategory[] = ['open_burning', 'industrial']

export interface CitizenVerificationContext {
  missionType: string
  missionStatus: string
  incidentStatus: IncidentStatus
  leadingCategory: SourceCategory | null
  severity: Severity | null
}

export interface SafetyDecision {
  safe: boolean
  /** Shown to the citizen when unsafe/irrelevant, so the refusal is explained. */
  reason: string | null
}

/**
 * Whether a citizen may be asked to complete a verification mission.
 * "Safe AND relevant": every condition below must hold.
 */
export function citizenVerificationSafety(ctx: CitizenVerificationContext): SafetyDecision {
  if (ctx.missionType !== 'citizen_verification') {
    return { safe: false, reason: 'This task needs a trained field officer.' }
  }
  if (ctx.missionStatus === 'completed' || ctx.missionStatus === 'cancelled') {
    return { safe: false, reason: 'This request is already closed.' }
  }
  if (ctx.incidentStatus === 'closed') {
    return { safe: false, reason: 'This incident is closed - no verification is needed.' }
  }
  if (ctx.leadingCategory && HAZARDOUS_FOR_CITIZENS.includes(ctx.leadingCategory)) {
    return {
      safe: false,
      reason: 'For your safety we do not ask the public to approach fires or industrial sites. An officer will verify this.',
    }
  }
  if (ctx.severity === 'severe') {
    return {
      safe: false,
      reason: 'Air quality here is severe right now. Please stay indoors - we will not ask you to go outside to check.',
    }
  }
  return { safe: true, reason: null }
}

// ── field checklists (plan §13: short, per-source) ───────────────────────────

export interface ChecklistItem {
  id: string
  label: string
  type: 'boolean' | 'text'
}

/**
 * Short, source-specific field checklists. Deliberately few items each: the
 * field app is used one-handed, outdoors, in bad air.
 *
 * These are hardcoded for the Delhi City Pack. Making them configurable per city
 * is what `intervention_playbooks.checklist` (already in the schema) is for;
 * wiring the field app to read them from there is Phase 4 work, so this constant
 * is the honest interim and is the single place to change.
 */
export const FIELD_CHECKLISTS: Record<SourceCategory, ChecklistItem[]> = {
  construction_dust: [
    { id: 'active', label: 'Construction work active right now?', type: 'boolean' },
    { id: 'barriers', label: 'Dust barriers / green netting in place?', type: 'boolean' },
    { id: 'sprinkling', label: 'Water sprinkling in use?', type: 'boolean' },
    { id: 'uncovered', label: 'Uncovered material or debris on site?', type: 'boolean' },
    { id: 'notes', label: 'Anything else worth recording?', type: 'text' },
  ],
  road_dust: [
    { id: 'unpaved', label: 'Unpaved or broken shoulder?', type: 'boolean' },
    { id: 'sweeping', label: 'Mechanical sweeping evident?', type: 'boolean' },
    { id: 'spill', label: 'Material spill on the carriageway?', type: 'boolean' },
    { id: 'notes', label: 'Anything else worth recording?', type: 'text' },
  ],
  open_burning: [
    { id: 'active', label: 'Fire still burning?', type: 'boolean' },
    { id: 'material', label: 'What is burning?', type: 'text' },
    { id: 'extinguished', label: 'Extinguished during this visit?', type: 'boolean' },
    { id: 'party', label: 'Responsible party identified?', type: 'boolean' },
  ],
  industrial: [
    { id: 'operating', label: 'Unit operating?', type: 'boolean' },
    { id: 'stack', label: 'Visible stack emission?', type: 'boolean' },
    { id: 'apc', label: 'Pollution-control equipment running?', type: 'boolean' },
    { id: 'consent', label: 'Valid consent displayed?', type: 'boolean' },
    { id: 'notes', label: 'Anything else worth recording?', type: 'text' },
  ],
  vehicular: [
    { id: 'congestion', label: 'Standing/idling queue present?', type: 'boolean' },
    { id: 'smoke', label: 'Visibly smoking vehicles?', type: 'boolean' },
    { id: 'notes', label: 'Anything else worth recording?', type: 'text' },
  ],
  waste: [
    { id: 'dumping', label: 'Active dumping?', type: 'boolean' },
    { id: 'burning', label: 'Waste being burnt?', type: 'boolean' },
    { id: 'overflow', label: 'Bins overflowing?', type: 'boolean' },
    { id: 'notes', label: 'Anything else worth recording?', type: 'text' },
  ],
  other: [
    { id: 'found', label: 'Source located?', type: 'boolean' },
    { id: 'notes', label: 'Describe what you found', type: 'text' },
  ],
  // These three are Phase 7 meta-categories (regional pattern / ambiguous /
  // insufficient evidence), not a specific physical source to inspect — there
  // is nothing source-specific to check on site, so each gets a minimal,
  // generic checklist rather than an invented one.
  regional_transport: [
    { id: 'notes', label: 'Anything locally distinctive worth recording?', type: 'text' },
  ],
  mixed: [
    { id: 'notes', label: 'Which of the leading candidate sources did you actually observe?', type: 'text' },
  ],
  unresolved: [
    { id: 'notes', label: 'What, if anything, did you observe at the location?', type: 'text' },
  ],
}

export function checklistFor(category: SourceCategory | null): ChecklistItem[] {
  return FIELD_CHECKLISTS[category ?? 'other'] ?? FIELD_CHECKLISTS.other
}

/**
 * Validate and narrow a jsonb `actions.checklist_snapshot` (Phase 5) into
 * `ChecklistItem[]`. jsonb has no static type, and this snapshot should only
 * ever contain what `createInterventionFromPlaybook` wrote from a real
 * playbook's `checklist` column — but a bad row must fail safe, not crash a
 * render, so any unexpected shape returns null and the caller falls back to
 * `checklistFor`'s hardcoded, known-good checklist.
 */
export function parseChecklistSnapshot(json: unknown): ChecklistItem[] | null {
  if (!Array.isArray(json) || json.length === 0) return null
  const items: ChecklistItem[] = []
  for (const raw of json) {
    if (
      raw != null &&
      typeof raw === 'object' &&
      typeof (raw as Record<string, unknown>).id === 'string' &&
      typeof (raw as Record<string, unknown>).label === 'string' &&
      ((raw as Record<string, unknown>).type === 'boolean' || (raw as Record<string, unknown>).type === 'text')
    ) {
      items.push(raw as ChecklistItem)
    } else {
      return null // any malformed item -> distrust the whole snapshot
    }
  }
  return items
}

// ── field outcome ────────────────────────────────────────────────────────────

export type MissionOutcome = 'confirmed' | 'rejected' | 'unresolved'

export const OUTCOME_LABELS: Record<MissionOutcome, string> = {
  confirmed: 'Source confirmed',
  rejected: 'Source not present',
  unresolved: 'Could not determine',
}

/**
 * What a field officer's outcome does to the incident's evidence level.
 *
 * A field officer is an authorised officer, so their confirmation is what plan
 * §9 calls official verification. "rejected" does NOT close the incident — the
 * pollution may be real with a different source — it disproves the *hypothesis*,
 * which sends the incident back for review. "unresolved" changes nothing: an
 * inconclusive visit is not evidence either way.
 */
export function evidenceLevelAfterFieldOutcome(
  current: SourceConfidence,
  outcome: MissionOutcome,
): SourceConfidence {
  if (outcome === 'confirmed') return 'officially_verified'
  if (outcome === 'rejected') return 'suspected'
  return current
}

export function incidentStatusAfterFieldOutcome(
  current: IncidentStatus,
  outcome: MissionOutcome,
): IncidentStatus {
  if (current === 'closed') return current
  if (outcome === 'confirmed') return 'routed'
  if (outcome === 'rejected') return 'under_review'
  return current
}

// ── intervention lifecycle (Phase 4) ─────────────────────────────────────────
//
// `actions.status` (the pre-existing `report_status` enum) is left completely
// alone — it is what the legacy report-scoped action queue in FieldView still
// reads, and repurposing it would be the exact kind of breaking change the
// migration rules forbid. The intervention lifecycle lives in the NEW
// `actions.workflow_status` column instead, typed here from the generated enum.

export type ActionWorkflowStatus = Database['public']['Enums']['action_workflow_status']

/** Operational states: what the team is doing. Distinct from outcome states,
 *  which describe whether pollution actually changed — never the same thing. */
export const OPERATIONAL_STATUSES: ActionWorkflowStatus[] = [
  'drafted',
  'awaiting_approval',
  'assigned',
  'accepted',
  'in_progress',
  'completed',
  'verification_pending',
]

/** Outcome states: derived ONLY by `record_impact_evaluation` in the database,
 *  never assignable directly by client code — the DB trigger enforces this
 *  (an outcome state is refused unless an impact_evaluations row exists). */
export const OUTCOME_STATUSES: ActionWorkflowStatus[] = [
  'effective',
  'partly_effective',
  'ineffective',
  'inconclusive',
]

export function isOperationalStatus(s: ActionWorkflowStatus): boolean {
  return OPERATIONAL_STATUSES.includes(s)
}

export function isOutcomeStatus(s: ActionWorkflowStatus): boolean {
  return OUTCOME_STATUSES.includes(s)
}

export const WORKFLOW_STATUS_LABEL: Record<ActionWorkflowStatus, string> = {
  drafted: 'Drafted',
  awaiting_approval: 'Awaiting approval',
  assigned: 'Assigned',
  accepted: 'Accepted',
  in_progress: 'In progress',
  completed: 'Completed',
  verification_pending: 'Verification pending',
  effective: 'Effective',
  partly_effective: 'Partly effective',
  ineffective: 'Ineffective',
  inconclusive: 'Inconclusive',
  reopened: 'Reopened',
}

/**
 * The one legal next operational step from each operational status — a strict
 * linear path, deliberately. Mirrors nothing in the DB (the DB does not
 * constrain the *order* of workflow_status writes, only whether a write may be
 * an OUTCOME state), so this is the client-side discipline that keeps the
 * command/field UI from offering an out-of-order transition; skipping states by
 * writing to Supabase directly is still technically possible and is a known
 * limitation, documented in IMPLEMENTATION_STATUS.md.
 */
const NEXT_OPERATIONAL: Partial<Record<ActionWorkflowStatus, ActionWorkflowStatus>> = {
  drafted: 'awaiting_approval',
  awaiting_approval: 'assigned',
  assigned: 'accepted',
  accepted: 'in_progress',
  in_progress: 'completed',
  completed: 'verification_pending',
}

export function nextOperationalStatus(current: ActionWorkflowStatus): ActionWorkflowStatus | null {
  return NEXT_OPERATIONAL[current] ?? null
}

/**
 * Whether an intervention needs an approval step before it can be assigned.
 * Mirrors the DB rule (enforcement always needs approval); non-enforcement
 * corroborated-level actions may skip straight to 'assigned' — approval is
 * required, not merely available, only where plan §14 requires it.
 */
export function interventionRequiresApproval(actionType: string): boolean {
  return requiresHumanApproval(actionType)
}

/**
 * A short, source-aware label for the recommended action, so the command
 * workspace can pre-fill something concrete instead of a blank field. Purely a
 * suggestion — the operator can always type something else — kept here rather
 * than invented per-component so it stays one source of truth.
 */
export const RECOMMENDED_ACTION_SUGGESTIONS: Record<SourceCategory, string> = {
  construction_dust: 'Site inspection + dust-control notice (barriers, water sprinkling)',
  road_dust: 'Mechanical sweeping + water sprinkling of the affected stretch',
  open_burning: 'Extinguish and issue a notice to the identified party',
  industrial: 'Inspection of pollution-control equipment and consent status',
  vehicular: 'Traffic-point enforcement at the congestion window',
  waste: 'Clear the dump site and increase collection frequency',
  other: 'Field inspection to establish the appropriate action',
  // Phase 7 meta-categories: none of these name a specific local source, so
  // none suggests a local enforcement/inspection action.
  regional_transport: 'No local enforcement action - issue a public advisory and continue monitoring (regional contribution).',
  mixed: 'Confirm which of the leading candidate sources is actually present before recommending a single action.',
  unresolved: 'Gather more evidence before recommending an action - no source is confidently identified yet.',
}

// ── impact evaluation: before/after (Phase 4, plan §15/§16) ─────────────────

export type ImpactOutcome = 'effective' | 'partly_effective' | 'ineffective' | 'inconclusive'

export const IMPACT_OUTCOME_LABEL: Record<ImpactOutcome, string> = {
  effective: 'Effective',
  partly_effective: 'Partly effective',
  ineffective: 'Ineffective',
  inconclusive: 'Inconclusive',
}

/** The full real `incident_outcome` DB enum (7 values) - wider than
 *  ImpactOutcome, which only covers the 4 outcomes previewImpactOutcome can
 *  predict client-side before submission. impact_evaluations.outcome can
 *  also be source_disproved/completed_no_change/recurred, set through other
 *  paths (citizen recurrence reports, source-verification flow) that never
 *  go through the preview function - anywhere displaying a real stored
 *  outcome value needs this map, not the narrower one. */
export const INCIDENT_OUTCOME_LABEL: Record<Database['public']['Enums']['incident_outcome'], string> = {
  effective: 'Effective',
  partly_effective: 'Partly effective',
  ineffective: 'Ineffective',
  inconclusive: 'Inconclusive',
  source_disproved: 'Source disproved',
  completed_no_change: 'Completed, no change',
  recurred: 'Recurred',
}

/** Minimum data completeness (0–1) below which a result is inconclusive
 *  regardless of the apparent change. Mirrors `record_impact_evaluation` in SQL. */
export const MIN_COMPLETENESS_FOR_RESULT = 0.5
/** Reduction thresholds, mirrored from SQL, for pre-flight display only — the
 *  DB computes the real outcome; this lets the UI preview it before submitting. */
export const EFFECTIVE_REDUCTION = 0.4
export const PARTLY_EFFECTIVE_REDUCTION = 0.15

export const BEFORE_AFTER_LIMITATION =
  'Before/after comparison only. Not weather-adjusted and not causal proof - concurrent weather and citywide changes are not controlled for.'

/**
 * Preview of what `record_impact_evaluation` will compute, so the command
 * workspace can show the operator the outcome before they submit rather than
 * only after. The database's computation is authoritative; this function must
 * be kept in lockstep with it (see the SQL comment on record_impact_evaluation)
 * and is unit-tested against the same cases the SQL tests exercise.
 */
export function previewImpactOutcome(params: {
  before: number | null
  after: number | null
  completeness: number | null
}): { outcome: ImpactOutcome; pctChange: number | null } {
  const { before, after, completeness } = params
  if (before == null || after == null || before <= 0 || (completeness ?? 0) < MIN_COMPLETENESS_FOR_RESULT) {
    return { outcome: 'inconclusive', pctChange: null }
  }
  const pctChange = ((after - before) / before) * 100
  const reduction = (before - after) / before
  if (reduction >= EFFECTIVE_REDUCTION) return { outcome: 'effective', pctChange }
  if (reduction >= PARTLY_EFFECTIVE_REDUCTION) return { outcome: 'partly_effective', pctChange }
  return { outcome: 'ineffective', pctChange }
}

// ── citizen action verification (plan §11, §15) ──────────────────────────────

export type CitizenActionAnswer = 'completed' | 'partial' | 'not_completed' | 'problem_remains' | 'problem_returned'

export const CITIZEN_ACTION_ANSWER_LABEL: Record<CitizenActionAnswer, string> = {
  completed: 'Yes, the action was visibly completed',
  partial: 'Partly done',
  not_completed: 'No action has happened yet',
  problem_remains: 'The problem is still there',
  problem_returned: 'It was fixed, but has come back',
}

/**
 * Whether an incident showing an action outcome is worth asking the citizen
 * about at all — reuses the exact same safety gate as evidence-mission
 * verification (plan §11: "safe and relevant"). An action-verification prompt
 * is never shown for a closed incident (nothing left to confirm) or when the
 * air is currently severe (stay indoors takes priority over confirming a fix).
 */
export function citizenActionVerificationSafety(ctx: {
  incidentStatus: IncidentStatus
  leadingCategory: SourceCategory | null
  severity: Severity | null
}): SafetyDecision {
  return citizenVerificationSafety({
    missionType: 'citizen_verification',
    missionStatus: 'dispatched',
    incidentStatus: ctx.incidentStatus,
    leadingCategory: ctx.leadingCategory,
    severity: ctx.severity,
  })
}

// ── intervention playbooks (Phase 5) ─────────────────────────────────────────
//
// Structured, source-specific intervention templates, replacing free-text
// intervention creation. Everything here is transparent and rule-based — no
// ML, per the brief — so every score is a documented constant a city can
// point at and argue with, exactly like the rest of this file.
//
// `PlaybookLike` is deliberately a narrow, snake_case shape (matching
// `QueueIncident` above) rather than the full generated
// `intervention_playbooks` Row type: a real Supabase row satisfies it
// structurally with no mapping, but these functions stay decoupled from the
// exact DB shape and are trivial to unit test with plain object literals.

export interface PlaybookLike {
  id: number
  slug: string | null
  city_id: number | null
  source_category: SourceCategory | null
  min_evidence_level: SourceConfidence
  action_type: string
  for_regional: boolean
  is_active: boolean
  title: string
  estimated_minutes: number | null
  estimated_cost_min: number | null
  estimated_cost_max: number | null
  expected_time_to_effect_hours: number | null
  verification_window_hours: number | null
}

/** The controlled vocabulary for `intervention_playbooks.action_type` /
 *  `actions.type` when created from a playbook — mirrors the DB CHECK
 *  constraint exactly (`intervention_playbooks_action_type_check`). */
export const PLAYBOOK_ACTION_TYPES = [
  'inspect', 'sprinkle', 'notice', 'vacuum_sweeping', 'extinguish_removal',
  'traffic_management', 'advisory_monitoring',
  'penalty', 'stop_work', 'closure', 'restriction', 'prosecution', 'other',
] as const
export type PlaybookActionType = (typeof PLAYBOOK_ACTION_TYPES)[number]

export const PLAYBOOK_ACTION_TYPE_LABEL: Record<PlaybookActionType, string> = {
  inspect: 'Inspection',
  sprinkle: 'Preventive - water sprinkling',
  notice: 'Preventive - notice',
  vacuum_sweeping: 'Preventive - mechanical/vacuum sweeping',
  extinguish_removal: 'Extinguish and remove',
  traffic_management: 'Traffic-point management',
  advisory_monitoring: 'Advisory and monitoring',
  penalty: 'Enforcement - penalty',
  stop_work: 'Enforcement - stop-work order',
  closure: 'Enforcement - closure',
  restriction: 'Enforcement - restriction',
  prosecution: 'Enforcement - prosecution',
  other: 'Other',
}

/**
 * Eligibility (plan's rule 5): only playbooks that match the incident's city,
 * evidence level, source, and local-vs-regional classification are ever
 * offered. Every condition here is a hard filter, not a scoring input — an
 * ineligible playbook must never appear even ranked last.
 *
 *   suspected            -> no playbook is eligible at all, by construction:
 *                           every seeded LOCAL playbook requires at least
 *                           'corroborated' (see the migration's seed data),
 *                           so an incident stuck at 'suspected' correctly
 *                           sees an empty list and the UI directs the
 *                           commander to evidence_missions instead — the
 *                           existing Phase 3/4 "collect evidence first" flow,
 *                           not a duplicate mechanism.
 *   corroborated         -> preventive/inspection-tier playbooks become
 *                           eligible (their min_evidence_level <= corroborated)
 *   officially_verified  -> enforcement-tier playbooks BECOME eligible too
 *                           ("may appear" — not the only option; lower-tier
 *                           playbooks remain eligible alongside them)
 *   classification = 'regional' -> ONLY for_regional playbooks are eligible;
 *                           every local playbook is excluded, which is the
 *                           literal encoding of "do not recommend ineffective
 *                           local action" for pollution that is not locally
 *                           controllable.
 *
 * Mirrored in the database: the `enforce_incident_action_rules` trigger
 * refuses an action referencing a playbook whose min_evidence_level is not
 * met — this function is what lets the UI explain that before the commander
 * even tries, exactly like `taskBlockedReason` does for free-text actions.
 */
export function isPlaybookEligible(
  p: PlaybookLike,
  ctx: {
    cityId: number | null
    leadingCategory: SourceCategory | null
    sourceConfidence: SourceConfidence
    classification: IncidentClassification | null
  },
): boolean {
  if (!p.is_active) return false
  // A city-specific playbook never crosses into another city; a null
  // city_id is a national default, eligible everywhere (plan's "allow ...
  // national default playbooks").
  if (p.city_id != null && p.city_id !== ctx.cityId) return false
  const isRegionalIncident = ctx.classification === 'regional'
  if (p.for_regional !== isRegionalIncident) return false
  if (!meetsEvidenceLevel(ctx.sourceConfidence, p.min_evidence_level)) return false
  if (!p.for_regional && p.source_category != null && p.source_category !== ctx.leadingCategory) return false
  return true
}

export interface PlaybookRankingContext {
  cityId: number | null
  leadingCategory: SourceCategory | null
  sourceConfidence: SourceConfidence
  classification: IncidentClassification | null
  severity: Severity | null
  /** Field officers currently covering the incident's ward. Pass null/undefined
   *  when this hasn't been fetched — "resource availability WHEN KNOWN" means
   *  unknown must never be scored as if unavailable. */
  assignableOfficerCount?: number | null
  /**
   * Never populated today: no population/exposure/vulnerability layer exists
   * in this codebase (see docs/DATA_QUALITY_AND_SCIENCE.md — plan §7 lists it
   * as a required input, not yet built). This parameter exists so the scoring
   * function has somewhere correct to read from once that data exists; it is
   * never given a value in this phase, and contributes nothing to the score
   * either way — inventing a number here would be exactly the kind of faked
   * integration this codebase's own rules forbid.
   */
  affectedPopulation?: number | null
}

export interface PlaybookScore {
  playbook: PlaybookLike
  score: number
  /** Plain-language reasons, generated from the same signals as the score —
   *  "show why each playbook is recommended", never a black box. */
  reasons: string[]
}

/**
 * Ranking weights. Each is a documented, arguable constant — a city can point
 * at any one of these and ask "why 40 and not 30", which is the entire point
 * of a rule-based (not ML) ranking.
 */
export const PLAYBOOK_RANK_WEIGHTS = {
  sourceMatch: 40,
  evidenceMatch: 20,
  urgencyTiming: 15,
  cost: 15,
  resource: 10,
} as const

/** Reference cost ceiling (INR) used only to normalise the cost score onto a
 *  0..1 scale — not a budget cap, just a documented denominator so "cheaper
 *  scores higher" has a concrete, stated reference point. */
export const PLAYBOOK_COST_CEILING = 200_000

/** The time scale (hours) beyond which "how fast can this deploy and take
 *  effect" stops mattering to the urgency score — capped, not unbounded. */
export const PLAYBOOK_TIME_CEILING_HOURS = 72

function averagePlaybookCost(p: PlaybookLike): number | null {
  if (p.estimated_cost_min != null && p.estimated_cost_max != null) {
    return (p.estimated_cost_min + p.estimated_cost_max) / 2
  }
  return p.estimated_cost_min ?? p.estimated_cost_max ?? null
}

function playbookTotalTimeHours(p: PlaybookLike): number {
  return (p.estimated_minutes ?? 0) / 60 + (p.expected_time_to_effect_hours ?? 0)
}

/**
 * Score one already-eligible playbook. Five stated factors (source match,
 * evidence-level fit, urgency-vs-timing, cost, resource availability) —
 * exactly the factors the brief lists, minus "affected population", which is
 * deliberately unscored (see `affectedPopulation` above). No ML: every term
 * is a plain arithmetic combination of the constants above and the incident's
 * own fields.
 */
export function scorePlaybook(p: PlaybookLike, ctx: PlaybookRankingContext): PlaybookScore {
  const reasons: string[] = []
  let score = 0

  // 1. source match — exact category match scores full; a regional/general
  // playbook (source_category null) scores half, since it is never competing
  // against a same-category alternative (regional eligibility already
  // excludes every local playbook for this incident).
  if (p.source_category != null && p.source_category === ctx.leadingCategory) {
    score += PLAYBOOK_RANK_WEIGHTS.sourceMatch
    reasons.push(`Matches the leading suspected source (${p.source_category.replace(/_/g, ' ')}).`)
  } else if (p.for_regional) {
    score += PLAYBOOK_RANK_WEIGHTS.sourceMatch * 0.5
    reasons.push('Applies regardless of source - this incident is classified as regional pollution.')
  }

  // 2. evidence-level fit — prefer the playbook whose tier the evidence
  // actually reaches exactly (the most decisive action the evidence supports)
  // over one that only needed a lower tier and is available "for free".
  if (p.min_evidence_level === ctx.sourceConfidence) {
    score += PLAYBOOK_RANK_WEIGHTS.evidenceMatch
    reasons.push(`Matches the incident's current evidence level exactly (${CONFIDENCE_LABEL[ctx.sourceConfidence].toLowerCase()}).`)
  } else {
    score += PLAYBOOK_RANK_WEIGHTS.evidenceMatch * 0.6
  }

  // 3. urgency vs. timing — speed only matters to the score when severity is
  // actually elevated; a low/unknown-severity incident gets no timing bonus
  // either way, so a slow-but-cheap playbook is not penalised for no reason.
  const severityWeight = ctx.severity === 'severe' ? 3 : ctx.severity === 'high' ? 2 : ctx.severity === 'moderate' ? 1 : 0
  if (severityWeight > 0) {
    const hours = playbookTotalTimeHours(p)
    const normalizedTime = Math.min(1, hours / PLAYBOOK_TIME_CEILING_HOURS)
    score += PLAYBOOK_RANK_WEIGHTS.urgencyTiming * (severityWeight / 3) * (1 - normalizedTime)
    if (hours <= 6) reasons.push('Fast to deploy and take effect, which matters given the current severity.')
  }

  // 4. cost — cheaper scores higher. Unknown cost (neither min nor max set)
  // is scored NEUTRAL (0.5), never penalised as if it were expensive.
  const cost = averagePlaybookCost(p)
  const costScore = cost == null ? 0.5 : 1 - Math.min(1, cost / PLAYBOOK_COST_CEILING)
  score += PLAYBOOK_RANK_WEIGHTS.cost * costScore
  if (cost != null && cost <= 5_000) reasons.push('Low estimated cost relative to typical alternatives.')

  // 5. resource availability, WHEN KNOWN. Absent (undefined/null) contributes
  // nothing — never treated as "definitely unavailable".
  if (ctx.assignableOfficerCount != null) {
    score += PLAYBOOK_RANK_WEIGHTS.resource * (ctx.assignableOfficerCount > 0 ? 1 : 0)
    reasons.push(
      ctx.assignableOfficerCount > 0
        ? 'A field officer currently covers this ward.'
        : 'No field officer currently covers this ward - dispatch may be delayed.',
    )
  }

  // affectedPopulation is read but never scored — see the field's own comment
  // on PlaybookRankingContext for why.
  void ctx.affectedPopulation

  if (reasons.length === 0) reasons.push('Eligible for this incident\'s current evidence level and source.')

  return { playbook: p, score, reasons }
}

/**
 * Filter to eligible playbooks, score each, and sort best-first. A stable
 * tiebreak on `id` keeps the order deterministic when two playbooks score
 * identically (no ML, no randomness — the same inputs always produce the
 * same order).
 */
export function rankPlaybooks(playbooks: PlaybookLike[], ctx: PlaybookRankingContext): PlaybookScore[] {
  return playbooks
    .filter((p) => isPlaybookEligible(p, ctx))
    .map((p) => scorePlaybook(p, ctx))
    .sort((a, b) => b.score - a.score || a.playbook.id - b.playbook.id)
}

export function playbookRequiresApproval(p: PlaybookLike): boolean {
  return requiresHumanApproval(p.action_type)
}

// ── playbook usage / learning loop (Phase 5) ─────────────────────────────────

export interface PlaybookUsageStats {
  timesUsed: number
  effective: number
  partlyEffective: number
  ineffective: number
  inconclusive: number
  /** Used, but not yet evaluated - still mid-lifecycle, not a fifth outcome. */
  pending: number
}

/**
 * Tally usage history from the `workflow_status` of every action that
 * references a given playbook. Read-only aggregation — this NEVER writes
 * anything back to `intervention_playbooks`. "Do not automatically rewrite
 * playbook estimates" is satisfied by this function's own shape: it has no
 * write path, only a return value the UI displays.
 */
export function tallyPlaybookUsage(workflowStatuses: ActionWorkflowStatus[]): PlaybookUsageStats {
  const stats: PlaybookUsageStats = {
    timesUsed: workflowStatuses.length,
    effective: 0,
    partlyEffective: 0,
    ineffective: 0,
    inconclusive: 0,
    pending: 0,
  }
  for (const s of workflowStatuses) {
    if (s === 'effective') stats.effective++
    else if (s === 'partly_effective') stats.partlyEffective++
    else if (s === 'ineffective') stats.ineffective++
    else if (s === 'inconclusive') stats.inconclusive++
    else stats.pending++
  }
  return stats
}

// ── citizen recurrence reporting (Phase 5.1) ─────────────────────────────────
//
// A citizen linked to a CLOSED incident may report that the problem returned.
// The rule that decides "reopen the original incident" vs. "create a new
// linked incident" is transparent and stated, exactly like every other rule in
// this file — and it is ONLY EVER a recommendation. The actual decision is a
// database-enforced command-only action (see incidents.ts); nothing here can
// reopen anything or create anything by itself.

export const RECURRENCE_TYPES = ['returned', 'partially_returned', 'action_temporary', 'unable_to_confirm'] as const
export type RecurrenceType = (typeof RECURRENCE_TYPES)[number]

export const RECURRENCE_TYPE_LABEL: Record<RecurrenceType, string> = {
  returned: 'The problem has returned',
  partially_returned: 'The problem partially returned',
  action_temporary: 'The action was only temporary',
  unable_to_confirm: 'Unable to confirm',
}

export const RECURRENCE_REVIEW_STATUSES = ['pending', 'more_evidence_requested', 'confirmed', 'dismissed'] as const
export type RecurrenceReviewStatus = (typeof RECURRENCE_REVIEW_STATUSES)[number]

export const RECURRENCE_REVIEW_STATUS_LABEL: Record<RecurrenceReviewStatus, string> = {
  pending: 'Under review',
  more_evidence_requested: 'More evidence requested',
  confirmed: 'Confirmed recurrence',
  dismissed: 'Dismissed',
}

/** What `list_my_recurrence_reports` computes server-side once a report is
 *  confirmed — see that function's own comment for why this is a derived word
 *  rather than the raw `resulting_incident_id`. */
export type RecurrenceOutcomeKind = 'reopened' | 'new_incident' | null

/**
 * Full citizen-facing status, combining review_status + outcome_kind into the
 * exact set of states plan requirement 7 lists ("recurrence report submitted,
 * under review, more evidence requested, confirmed recurrence, linked to
 * reopened or new incident, dismissed with a public-safe reason").
 */
export function citizenRecurrenceStatusLabel(reviewStatus: RecurrenceReviewStatus, outcomeKind: RecurrenceOutcomeKind): string {
  if (outcomeKind === 'reopened') return 'Confirmed - the original incident has been reopened'
  if (outcomeKind === 'new_incident') return 'Confirmed - linked to a new incident our team is tracking'
  return RECURRENCE_REVIEW_STATUS_LABEL[reviewStatus]
}

// ---- reopen vs. new-linked-incident recommendation ----

/** Stated thresholds - documented, arguable constants, not a model. */
export const RECURRENCE_SOON_AFTER_CLOSURE_HOURS = 168 // 7 days: "returned soon after closure"
export const RECURRENCE_SUBSTANTIAL_GAP_HOURS = 720 // 30 days: "a substantial time gap"
export const RECURRENCE_SAME_LOCATION_RADIUS_M = 300 // materially the same site, not just the same ward

export type RecurrenceDecisionRecommendation = 'reopen' | 'new_incident' | 'uncertain'

export interface RecurrenceDecisionContext {
  closedAt: string | null
  reportCreatedAt: string
  /** Most recent impact_evaluations.outcome for the ORIGINAL incident, if any. */
  lastImpactOutcome: ImpactOutcome | null
  recurrenceType: RecurrenceType
  incidentLat: number | null
  incidentLng: number | null
  reportLat: number | null
  reportLng: number | null
}

export interface RecurrenceDecision {
  recommendation: RecurrenceDecisionRecommendation
  /** Plain-language reasons, generated from the same signals as the
   *  recommendation — shown to command alongside the manual decision buttons,
   *  never applied automatically. */
  reasons: string[]
}

/**
 * Recommend reopen vs. new linked incident from the plan's own stated rules:
 *
 *   reopen when: the same source/location returned SOON after closure, the
 *   previous intervention's effect looks temporary, and the location is
 *   materially unchanged.
 *
 *   new incident when: a SUBSTANTIAL time gap has passed, or the location has
 *   materially changed (a different, more decisive signal than "soon/gap" when
 *   both are available).
 *
 * Never used to act automatically — `incidents.ts`'s reopen/create-linked
 * functions are separate, explicit, command-only calls. This function only
 * ever returns a recommendation and its reasons, for the UI to show alongside
 * manual decision buttons — "do not automate this final decision" (plan §5).
 */
export function recommendRecurrenceDecision(ctx: RecurrenceDecisionContext): RecurrenceDecision {
  if (!ctx.closedAt) {
    return { recommendation: 'uncertain', reasons: ['This incident has no recorded closure date.'] }
  }

  const hoursSinceClosure = (new Date(ctx.reportCreatedAt).getTime() - new Date(ctx.closedAt).getTime()) / 3_600_000
  const hasCoords = ctx.incidentLat != null && ctx.incidentLng != null && ctx.reportLat != null && ctx.reportLng != null
  const distance = hasCoords
    ? haversineMeters({ lat: ctx.incidentLat!, lng: ctx.incidentLng! }, { lat: ctx.reportLat!, lng: ctx.reportLng! })
    : null
  // "The previous intervention's effect was temporary" — the recurrence_type
  // itself is the plan's own literal signal for this; a partly-effective past
  // outcome is corroborating, not required.
  const wasTemporary = ctx.recurrenceType === 'action_temporary' || ctx.lastImpactOutcome === 'partly_effective'

  const reasons: string[] = []
  let reopenScore = 0
  let newIncidentScore = 0

  if (hoursSinceClosure <= RECURRENCE_SOON_AFTER_CLOSURE_HOURS) {
    reopenScore++
    reasons.push(
      `Reported ${Math.max(0, Math.round(hoursSinceClosure))}h after closure - within the ${RECURRENCE_SOON_AFTER_CLOSURE_HOURS}h "soon after closure" window.`,
    )
  }
  if (hoursSinceClosure >= RECURRENCE_SUBSTANTIAL_GAP_HOURS) {
    newIncidentScore++
    reasons.push(`Reported ${Math.round(hoursSinceClosure / 24)} days after closure - a substantial time gap.`)
  }
  if (wasTemporary) {
    reopenScore++
    reasons.push("The previous intervention's effect looks temporary rather than this being a new source.")
  }
  if (distance != null && distance <= RECURRENCE_SAME_LOCATION_RADIUS_M) {
    reopenScore++
    reasons.push(`Reported ${Math.round(distance)}m from the original incident - materially the same location.`)
  }
  if (distance != null && distance > RECURRENCE_SAME_LOCATION_RADIUS_M) {
    newIncidentScore++
    reasons.push(`Reported ${Math.round(distance)}m from the original incident - the location has materially changed.`)
  }

  if (reasons.length === 0) {
    reasons.push('Not enough information to recommend confidently - review the evidence directly.')
  }

  if (reopenScore > newIncidentScore) return { recommendation: 'reopen', reasons }
  if (newIncidentScore > reopenScore) return { recommendation: 'new_incident', reasons }
  return { recommendation: 'uncertain', reasons }
}

// ── custom intervention hardening (Phase 5.1) ────────────────────────────────

/**
 * Whether a custom (no-playbook) intervention type is permitted on an incident
 * classified 'regional' — mirrors the DB trigger's rule exactly: only the
 * advisory/monitoring type is allowed, the same "do not allow ineffective
 * local action against a non-local source" rule Phase 5's playbook
 * eligibility already applied client-side, now also enforced for the custom
 * fallback (both client- and server-side).
 */
export function isCustomActionTypeAllowedForClassification(
  actionType: string,
  classification: IncidentClassification | null,
): boolean {
  if (classification !== 'regional') return true
  return actionType === 'advisory_monitoring'
}

/** Why a custom action type is blocked for this incident's classification, or
 *  null when it is allowed — mirrors `taskBlockedReason`'s explanatory role. */
export function customActionClassificationBlockedReason(
  actionType: string,
  classification: IncidentClassification | null,
): string | null {
  if (isCustomActionTypeAllowedForClassification(actionType, classification)) return null
  return 'This incident is classified regional: local action types are not appropriate here. Only an advisory/monitoring action is permitted.'
}

/**
 * An action's descriptive fields become immutable once approved — mirrors the
 * DB trigger exactly (no silent edits after approval, playbook-based or
 * custom). Used by the UI to disable editing controls rather than only
 * surfacing a raw Postgres error after the fact.
 */
export function isActionLockedByApproval(approvedBy: string | null): boolean {
  return approvedBy != null
}

// ── automated anomaly detection (Phase 6) ────────────────────────────────────
//
// The rule engine itself — thresholds, persistence, local excess, dedup —
// lives ENTIRELY in `evaluate_station_pollutant_anomaly` /
// `run_anomaly_detection` (SQL), for the same reason `link_report_to_incident`
// does: it needs to be atomic with the incident create/update, and it reads a
// city-configurable threshold table this file has no business duplicating.
// What lives here is display-only: labels and plain-language explanation for
// values the database already computed and stored on `anomaly_candidates`.

export const DETECTION_STAGE_LABEL: Record<DetectionStage, string> = {
  predicted: 'Predicted',
  detected: 'Detected',
  confirmed: 'Confirmed',
}

/** Plain-language description of the rule engine, for the predicted-incident
 *  detail panel — mirrors `describeMatchingRule`'s role for report matching. */
export function describeAnomalyDetectionRule(): string {
  return (
    'A monitoring station reaches "detected" when its concentration exceeds the city-configured ' +
    'threshold, that persists across at least two valid recent readings, and the excess above the ' +
    "city's own background level is meaningful - never from one reading alone. " +
    '"Predicted" means it has not crossed yet, but a simple trend projection (not a model) shows it ' +
    'is on track to cross within the configured prediction horizon.'
  )
}

/** A candidate's raw `triggered_rules` values, in plain language, for the
 *  command review panel — mirrors each SQL-side check by name. */
export const TRIGGERED_RULE_LABEL: Record<string, string> = {
  concentration_threshold: 'Concentration exceeds the configured threshold',
  persistence: 'Persists across at least two valid readings',
  local_excess: 'Meaningfully above the background level',
  trend_projection: 'Trending toward the threshold within the prediction horizon',
}

export function describeTriggeredRule(rule: string): string {
  return TRIGGERED_RULE_LABEL[rule] ?? rule.replace(/_/g, ' ')
}

/** Sensor type → the plain-language caveat shown alongside a non-regulatory
 *  reading, since plan §3 requires distinguishing regulatory from indicative
 *  sensors wherever their data is shown, not just in the detection math. */
export function sensorQualityCaveat(sensorType: string | null): string | null {
  if (sensorType === 'regulatory' || sensorType == null) return null
  if (sensorType === 'indicative') return 'Indicative sensor - lower confidence than a regulatory monitor.'
  if (sensorType === 'low_cost') return 'Low-cost sensor - lower confidence than a regulatory monitor.'
  return 'Sensor type unknown - treated with reduced confidence.'
}

// ── probable-source attribution (Phase 7) ────────────────────────────────────
//
// The scoring engine itself — evidence weights, thresholds, the ambiguity
// gap, the never-overwrite-verified rule — lives ENTIRELY in
// `calculate_incident_source_attribution` / `run_incident_source_attribution`
// (SQL), for the same reason every other atomic rule in this codebase does:
// it must be reproducible/auditable from one place, and it reads a
// city-configurable weight table this file has no business duplicating. What
// lives here is display-only.

/**
 * Default display labels for `source_category`, mirroring
 * `city_config.config -> 'attribution' -> 'category_labels'`'s DEFAULT
 * mapping exactly (seeded identically for Delhi). The underlying enum keeps
 * its original values (`vehicular`, `industrial`) so classify.py and the
 * Phase 5 playbook seed are untouched — this is purely the label a city may
 * override without a code change, with this constant as the same honest
 * fallback used everywhere else in this codebase (e.g. `POLLUTANT_LABEL`).
 */
export const SOURCE_CATEGORY_LABEL: Record<SourceCategory, string> = {
  road_dust: 'Road dust',
  construction_dust: 'Construction dust',
  vehicular: 'Traffic emissions',
  open_burning: 'Open burning',
  industrial: 'Industrial combustion',
  waste: 'Waste',
  other: 'Other',
  regional_transport: 'Regional transport',
  mixed: 'Mixed / multiple sources',
  unresolved: 'Unresolved',
}

export function sourceCategoryLabel(category: SourceCategory | null): string {
  if (category == null) return 'Unknown'
  return SOURCE_CATEGORY_LABEL[category] ?? category.replace(/_/g, ' ')
}

/**
 * The three source_category values that are NOT a specific physical source —
 * they describe the SHAPE of the evidence itself. Local responsibility
 * routing, field checklists tied to a named source, and "this is the
 * suspected asset" framing never apply to these (plan §7/§9).
 */
export const META_SOURCE_CATEGORIES: SourceCategory[] = ['regional_transport', 'mixed', 'unresolved']

export function isMetaSourceCategory(category: SourceCategory | null): boolean {
  return category != null && META_SOURCE_CATEGORIES.includes(category)
}

export type HypothesisReviewStatus = 'pending' | 'confirmed_corroborated' | 'marked_unresolved' | 'rejected'

export const HYPOTHESIS_REVIEW_STATUS_LABEL: Record<HypothesisReviewStatus, string> = {
  pending: 'Pending review',
  confirmed_corroborated: 'Confirmed as corroborated',
  marked_unresolved: 'Marked unresolved',
  rejected: 'Rejected',
}

/**
 * Plain-language local-vs-regional classification label (plan §7's own
 * wording), shown alongside the unchanged underlying
 * `incident_classification` enum value (`local`/`mixed`/`regional`/
 * `uncertain`) rather than renaming it — the same alias-not-rename approach
 * `SOURCE_CATEGORY_LABEL` takes.
 */
export const CLASSIFICATION_LABEL: Record<IncidentClassification, string> = {
  local: 'Local - actionable',
  mixed: 'Mixed',
  regional: 'Predominantly regional',
  uncertain: 'Unresolved',
}

export function classificationLabel(c: IncidentClassification | null): string {
  return c == null ? 'Not yet classified' : CLASSIFICATION_LABEL[c]
}

/**
 * Whether a classification was set by the model (and so may still be
 * recalculated/overwritten by a later run) or confirmed by a human (and so
 * never silently overwritten again) — mirrors
 * `calculate_incident_source_attribution`'s own check exactly.
 */
export function isHumanConfirmedClassification(classificationSource: string | null): boolean {
  return classificationSource === 'human'
}

/** The fixed disclaimer every source-attribution surface must show (plan §10). */
export const PROBABLE_SOURCE_DISCLAIMER = 'Probable source - not a confirmed violation.'

/**
 * Whether the top-ranked hypothesis is ambiguous or low-confidence enough
 * that a "recommended next evidence mission" should be expected — mirrors
 * the SQL engine's own `v_ambiguous`/`confidence_threshold` check, so the UI
 * can explain WHY a recommendation appears (or doesn't) without re-deriving
 * the actual decision, which stays server-side.
 */
export function needsMoreAttributionEvidence(
  topProbability: number | null,
  secondProbability: number | null,
  confidenceThreshold = 0.45,
  ambiguityGap = 0.12,
): boolean {
  if (topProbability == null) return true
  if (topProbability < confidenceThreshold) return true
  if (secondProbability != null && topProbability - secondProbability < ambiguityGap) return true
  return false
}

// ── unified forecasting (Phase 8) ────────────────────────────────────────────
//
// The forecasting/validation logic itself (LightGBM training, the time-based
// holdout, MAE/RMSE/bias/threshold-recall/false-alarm computation, the
// beats-persistence gate) lives entirely in `ingest/app/forecast.py` — it
// cannot live in SQL (Postgres cannot train a model) or in this file (no I/O,
// and re-deriving a model's own validation here would be exactly the kind of
// "second, potentially-inconsistent" computation this codebase avoids
// everywhere else). What lives here is display-only: labels for values
// `forecast_runs`/`forecasts` already computed and stored.

export const FORECAST_HORIZONS_HOURS = [6, 12, 24, 48] as const
export type ForecastHorizonHours = (typeof FORECAST_HORIZONS_HOURS)[number]

export type ForecastMethod = 'lightgbm' | 'diurnal_persistence'
export const FORECAST_METHOD_LABEL: Record<ForecastMethod, string> = {
  lightgbm: 'Machine-learning model (LightGBM)',
  diurnal_persistence: 'Seasonal/hourly baseline (fallback)',
}

export type ForecastDataQualityStatus = 'ok' | 'insufficient_data' | 'stale_inputs'
export const FORECAST_DATA_QUALITY_LABEL: Record<ForecastDataQualityStatus, string> = {
  ok: 'Data quality OK',
  insufficient_data: 'Not enough history yet to validate a model',
  stale_inputs: 'Recent readings are too sparse to trust fully',
}

/**
 * Which signal actually produced a predicted-incident candidate (plan §6:
 * "clearly record which method created the prediction... never silently mix
 * forecast methods") — set once, server-side, by
 * `evaluate_station_pollutant_anomaly`; this is the exhaustive label map for
 * that column, not a second decision.
 */
export type PredictionMethod = 'validated_forecast' | 'trend_persistence'
export const PREDICTION_METHOD_LABEL: Record<PredictionMethod, string> = {
  validated_forecast: 'Validated forecast model',
  trend_persistence: 'Raw-reading trend (fallback - no validated forecast was available)',
}

/** The fixed, literal disclaimer plan §8 requires next to any forecast curve. */
export const FORECAST_DISCLAIMER = 'Forecast - not a guaranteed outcome.'

/**
 * Whether a specific horizon checkpoint falls within what the model was
 * actually validated to — mirrors the SQL trigger's own
 * `max_validated_horizon_hours` bound exactly, so the UI can grey out or
 * caveat a horizon the stored run itself never claimed to be good at.
 */
export function isHorizonValidated(maxValidatedHorizonHours: number | null, horizonHours: number): boolean {
  return maxValidatedHorizonHours != null && horizonHours <= maxValidatedHorizonHours
}

/** Plain-language fallback-status line for the forecast panel. */
export function forecastFallbackStatus(method: ForecastMethod, beatsPersistence: boolean): string {
  if (method === 'lightgbm' && beatsPersistence) return 'Using the validated machine-learning model.'
  if (method === 'diurnal_persistence' && !beatsPersistence) {
    return "Falling back to the seasonal/hourly baseline - the model hasn't beaten simple persistence yet."
  }
  return 'Using the seasonal/hourly baseline.'
}

// ── authority routing and operational dispatch (Phase 9) ────────────────────
//
// The routing decision, the lifecycle state machine, approval gating, SLA
// computation, and escalation all live in Postgres
// (supabase/migrations/20260724000000_authority_routing_and_dispatch.sql) —
// `dispatch_intervention_task` / `transition_task_dispatch` /
// `escalate_stale_task_dispatches` are the only place those rules are
// evaluated, for the same reproducibility reason every other atomic rule in
// this codebase stays server-side. What lives here is display-only: labels,
// and small pure helpers that explain a value the DB already computed
// without re-deriving the decision itself.

export type TaskDispatchStatus = Database['public']['Enums']['task_dispatch_status']
export type RoutingConfidenceLevel = Database['public']['Enums']['routing_confidence_level']
export type NotificationChannel = Database['public']['Enums']['notification_channel']
export type NotificationStatus = Database['public']['Enums']['notification_status']

/** Mirrors transition_task_dispatch's own server-side transition table
 * exactly — used here ONLY to grey out an illegal action in the UI before
 * the user tries it; the database remains the actual authority. */
export const TASK_DISPATCH_TRANSITIONS: Record<TaskDispatchStatus, TaskDispatchStatus[]> = {
  drafted: ['awaiting_approval', 'routed', 'cancelled'],
  awaiting_approval: ['approved', 'rejected', 'cancelled'],
  approved: ['routed', 'cancelled'],
  routed: ['sent', 'rerouted', 'cancelled'],
  sent: ['acknowledged', 'rerouted', 'cancelled', 'overdue'],
  acknowledged: ['accepted', 'rejected', 'rerouted', 'overdue'],
  accepted: ['in_progress', 'rejected', 'overdue', 'escalated'],
  in_progress: ['completed', 'escalated', 'overdue'],
  completed: ['verification_pending', 'escalated'],
  verification_pending: ['escalated'],
  overdue: ['acknowledged', 'accepted', 'in_progress', 'escalated', 'cancelled'],
  escalated: ['rerouted', 'cancelled', 'approved', 'acknowledged', 'accepted'],
  rejected: ['rerouted', 'cancelled'],
  rerouted: ['drafted'],
  cancelled: [],
}

export function canTransitionTaskDispatch(from: TaskDispatchStatus, to: TaskDispatchStatus): boolean {
  return TASK_DISPATCH_TRANSITIONS[from].includes(to)
}

/** Statuses that require a non-empty reason - mirrors the DB's own check. */
export const TASK_DISPATCH_REASON_REQUIRED: TaskDispatchStatus[] = ['rejected', 'rerouted', 'cancelled']

export function taskDispatchRequiresReason(to: TaskDispatchStatus): boolean {
  return TASK_DISPATCH_REASON_REQUIRED.includes(to)
}

export const TASK_DISPATCH_STATUS_LABEL: Record<TaskDispatchStatus, string> = {
  drafted: 'Drafted',
  awaiting_approval: 'Awaiting approval',
  approved: 'Approved',
  routed: 'Routed',
  sent: 'Sent',
  acknowledged: 'Acknowledged',
  accepted: 'Accepted',
  in_progress: 'In progress',
  completed: 'Completed',
  verification_pending: 'Verification pending',
  overdue: 'Overdue',
  escalated: 'Escalated',
  rejected: 'Rejected',
  rerouted: 'Rerouted',
  cancelled: 'Cancelled',
}

/** Public-safe subset of TASK_DISPATCH_STATUS_LABEL (plan §12): citizens may
 * see that a task is progressing, never internal-only states like a
 * disputed jurisdiction, rejection, or reroute in flight. Anything not
 * listed here should render as the nearest safe umbrella label by the
 * caller (see publicTaskStatusLabel below) rather than being added silently. */
export const PUBLIC_TASK_STATUS_LABEL: Partial<Record<TaskDispatchStatus, string>> = {
  routed: 'Authority responding',
  sent: 'Authority responding',
  acknowledged: 'Authority responding',
  accepted: 'Action assigned',
  in_progress: 'Action in progress',
  completed: 'Action completed',
  verification_pending: 'Impact under review',
}

/**
 * Plain-language, citizen-safe status line (plan §12: "action assigned,
 * authority responding, action in progress, action completed, impact under
 * review, outcome available"). Every internal-only state (drafted,
 * awaiting_approval, approved, overdue, escalated, rejected, rerouted,
 * cancelled) collapses to a single honest "being coordinated" line rather
 * than exposing routing disputes, rejections, or reroutes to a citizen.
 */
export function publicTaskStatusLabel(status: TaskDispatchStatus | null): string {
  if (status == null) return 'Not yet assigned'
  return PUBLIC_TASK_STATUS_LABEL[status] ?? 'Being coordinated by the responsible authority'
}

export const ROUTING_CONFIDENCE_LABEL: Record<RoutingConfidenceLevel, string> = {
  confirmed: 'Confirmed jurisdiction',
  probable: 'Probable jurisdiction',
  disputed: 'Disputed jurisdiction',
  unresolved: 'Unresolved - no matching responsible unit found',
}

/** Whether a routing result may proceed toward dispatch on its own, or must
 * wait for a human (plan §3: unresolved never silently dispatches, disputed
 * goes to command review). Display-only — the DB enforces this for real via
 * dispatch_intervention_task's own status decision. */
export function routingBlocksAutoDispatch(confidence: RoutingConfidenceLevel): boolean {
  return confidence === 'unresolved' || confidence === 'disputed'
}

export const NOTIFICATION_CHANNEL_LABEL: Record<NotificationChannel, string> = {
  in_app: 'In-app',
  email: 'Email',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
}

export const NOTIFICATION_STATUS_LABEL: Record<NotificationStatus, string> = {
  pending: 'Queued',
  sent: 'Sent',
  delivered: 'Delivered',
  failed: 'Failed',
  acknowledged: 'Acknowledged',
}

/**
 * Action types that require authorised human approval before dispatch (plan
 * §5). Mirrors the DB's default `city_config.config -> 'dispatch' ->
 * 'requires_approval_types'` seed exactly — a city may override the DB-side
 * list without a code change, so treat this as the documented default a
 * city started from, not a second source of truth the UI enforces alone.
 */
export const DISPATCH_APPROVAL_REQUIRED_TYPES = [...ENFORCEMENT_TYPES, 'sprinkle'] as const

export function dispatchRequiresApprovalByDefault(actionType: string): boolean {
  return (DISPATCH_APPROVAL_REQUIRED_TYPES as readonly string[]).includes(actionType)
}

/** SLA checkpoint labels, in the order a task normally passes through them
 * (plan §7: "time to acknowledgement, time to acceptance, time to arrival,
 * time to completion, time to verified mitigation"). */
export const SLA_CHECKPOINT_LABEL = {
  ack: 'Acknowledgement',
  accept: 'Acceptance',
  arrival: 'Arrival',
  completion: 'Completion',
  verification: 'Verified mitigation',
} as const
export type SlaCheckpoint = keyof typeof SLA_CHECKPOINT_LABEL

/**
 * Minutes remaining until an SLA deadline (negative once overdue) — a pure
 * display helper; the DB's own escalate_stale_task_dispatches is the actual
 * authority on what counts as overdue.
 */
export function minutesUntil(dueAt: string | null, now: Date = new Date()): number | null {
  if (dueAt == null) return null
  return Math.round((new Date(dueAt).getTime() - now.getTime()) / 60000)
}

/** Plain-language SLA countdown line for the Operations panel. */
export function slaCountdownLabel(dueAt: string | null, now: Date = new Date()): string {
  const mins = minutesUntil(dueAt, now)
  if (mins == null) return 'No SLA set'
  if (mins < 0) return `Overdue by ${formatMinutes(-mins)}`
  return `Due in ${formatMinutes(mins)}`
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const rem = mins % 60
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`
}

// ── launch-hardening pass (Overview/Incidents clarity, no new data source) ──
//
// Every function below reads only fields already fetched by getIncidentDetail
// / IncidentDetailPanel's existing props - none of them add a query. Each one
// exists because two components independently displayed the same underlying
// fact with different fallback logic (or, for the mission-rationale/data-
// quality-note helpers, because a stored string has a known SQL-side
// formatting quirk that can't be fixed without a migration this pass forbids
// - see the doc comment on each for the specific root cause).

/**
 * Single source of truth for "which pollutant is this incident about" -
 * IncidentStatusHeader and PredictedIncidentPanel each used to resolve this
 * independently (`incident.primary_pollutant` with different/no fallback),
 * which could show two different pollutants for the same incident when
 * `primary_pollutant` was unset. Both now call this.
 */
export function resolveIncidentPollutant(
  primaryPollutant: string | null,
  detectionPollutant: string | null,
): Pollutant | null {
  const resolved = primaryPollutant ?? detectionPollutant
  return resolved != null && (POLLUTANTS as readonly string[]).includes(resolved) ? (resolved as Pollutant) : null
}

/**
 * `evidence_missions.rationale` for an automated attribution recommendation
 * is generated by `calculate_incident_source_attribution` (SQL) as
 * `'Automated attribution: ' || v_rationale`, where `v_rationale` itself
 * already starts with `'Automated attribution: '` — a double-prefix bug in
 * that function. Fixing the function needs a migration, out of scope this
 * pass; this strips however many copies of the prefix a given row actually
 * has (1, from before the bug; 2, from the bug; or 0, for a manually created
 * mission with no prefix at all) so the UI never shows the duplicate.
 */
const AUTOMATED_ATTRIBUTION_PREFIX_RE = /^(automated attribution:\s*)+/i

export function missionRationaleIsAutomated(rationale: string | null): boolean {
  return rationale != null && /^automated attribution:/i.test(rationale)
}

export function cleanMissionRationale(rationale: string | null): string | null {
  if (!rationale) return null
  const cleaned = rationale.replace(AUTOMATED_ATTRIBUTION_PREFIX_RE, '').trim()
  return cleaned || null
}

/**
 * Groups evidence missions with an identical (mission_type, status,
 * rationale) into one entry with a count, rather than showing N visually
 * identical rows — the source-attribution recalculation trigger can propose
 * the same "citizen verification" mission again on every recalculation
 * without checking whether an equivalent one is already pending (a real
 * backend behaviour, not something this display-only pass changes).
 * Order-preserving: each group appears at the position of its first member.
 */
export function groupDuplicateMissions<T extends { mission_type: string; status: string; rationale: string | null }>(
  missions: T[],
): { mission: T; count: number }[] {
  const out: { mission: T; count: number }[] = []
  const indexByKey = new Map<string, number>()
  for (const m of missions) {
    const key = `${m.mission_type}:${m.status}:${m.rationale ?? ''}`
    const idx = indexByKey.get(key)
    if (idx != null) {
      out[idx].count++
      continue
    }
    indexByKey.set(key, out.length)
    out.push({ mission: m, count: 1 })
  }
  return out
}

/** Why the Dispatch tab has nothing to show yet - the two real, already-
 *  loaded facts that block an intervention from existing at all (source
 *  confidence too low to permit an action task; no responsible authority
 *  resolved to route it to). Distinct from "an intervention exists but
 *  hasn't been dispatched" (TaskDispatchPanel's own DispatchRow empty
 *  states already cover that case - this is for interventions.length===0). */
export function dispatchEmptyStateMessage(sourceConfidence: SourceConfidence, hasResponsibleAuthority: boolean): string {
  if (sourceConfidence === 'suspected') {
    return 'No dispatch created yet. This incident cannot be routed until the source is corroborated - a suspected-only source can request evidence, but not an action task to dispatch.'
  }
  if (!hasResponsibleAuthority) {
    return 'No dispatch created yet. No responsible authority has been resolved for this incident yet, so there is nothing to route.'
  }
  return 'No dispatch created yet. Create an intervention on the Intervention tab first, or request more evidence to strengthen the source before dispatching.'
}

/**
 * `incident_source_hypotheses.data_quality_note` is generated by the same
 * SQL function as a fixed-shape sentence using Postgres's `format('%s',
 * boolean)`, which renders true/false as literal `t`/`f` - e.g. "monitoring
 * readings t, wind direction f, ...". Fixing the function needs a migration
 * (out of scope); this parses that fixed shape into readable available/
 * missing lists, and returns null (caller falls back to the raw note) if the
 * shape ever changes - never hides information, just improves the common case.
 */
const DATA_QUALITY_NOTE_RE =
  /^Evidence availability for this calculation: monitoring readings (t|f), wind direction (t|f), responsibility registry (t|f), citizen evidence (t|f), field evidence (t|f) \(\d of 5 evidence types available\)\.$/

const DATA_QUALITY_SIGNAL_LABELS = [
  'monitoring readings',
  'wind direction',
  'responsibility registry',
  'citizen evidence',
  'field evidence',
] as const

export interface ParsedDataQualityNote {
  available: string[]
  missing: string[]
}

export function parseDataQualityNote(note: string | null): ParsedDataQualityNote | null {
  if (!note) return null
  const m = note.match(DATA_QUALITY_NOTE_RE)
  if (!m) return null
  const available: string[] = []
  const missing: string[] = []
  for (let i = 0; i < DATA_QUALITY_SIGNAL_LABELS.length; i++) {
    ;(m[i + 1] === 't' ? available : missing).push(DATA_QUALITY_SIGNAL_LABELS[i])
  }
  return { available, missing }
}

/** The two auto-generated event types confirmed to repeat with identical,
 *  low-information notes: one per source-attribution recalculation
 *  (calculate_incident_source_attribution, SQL) and one per "Continue
 *  monitoring" click (continueMonitoringPredictedIncident, incidents.ts,
 *  event_type 'predicted_incident_reviewed', always the same note text) -
 *  both can dominate a busy incident's timeline with repeats. Deliberately a
 *  narrow, named list rather than "collapse any repeated type": collapsing
 *  an event type we haven't confirmed is safe to merge risks hiding a
 *  meaningful distinct entry. */
export const COLLAPSIBLE_TIMELINE_EVENT_TYPES = ['attribution_recalculated', 'predicted_incident_reviewed'] as const

export interface CollapsedTimelineEntry<T> {
  representative: T
  count: number
}

/** Collapses every occurrence of a COLLAPSIBLE_TIMELINE_EVENT_TYPES type into
 *  one entry (at the position of its FIRST occurrence, so the rest of the
 *  timeline's order is untouched), showing the most recent occurrence's data
 *  with a running count. Every other event type passes through unchanged,
 *  one entry each, in original order. */
export function collapseRepeatedTimelineEvents<T extends { event_type: string }>(events: T[]): CollapsedTimelineEntry<T>[] {
  const collapsible: readonly string[] = COLLAPSIBLE_TIMELINE_EVENT_TYPES
  const out: CollapsedTimelineEntry<T>[] = []
  const groupIndex = new Map<string, number>()
  for (const e of events) {
    if (collapsible.includes(e.event_type)) {
      const idx = groupIndex.get(e.event_type)
      if (idx != null) {
        out[idx] = { representative: e, count: out[idx].count + 1 }
        continue
      }
      groupIndex.set(e.event_type, out.length)
    }
    out.push({ representative: e, count: 1 })
  }
  return out
}

