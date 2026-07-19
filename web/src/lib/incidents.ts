/**
 * Incident data layer.
 *
 * Sibling to data.ts, same rule: this is the only place that knows incident
 * table/column names — components never query Supabase directly. It is a
 * separate module purely because data.ts is already long and these functions
 * form one coherent domain; the convention (no ad-hoc queries in components) is
 * unchanged. Workflow *rules* live in incidentRules.ts so they stay pure and
 * testable; this file is I/O only.
 *
 * Error handling: every function throws on failure rather than returning null,
 * so a failed load can never be mistaken for "no data" by a caller. The one
 * exception is `getIncidentDetail`, which reports per-section failure through
 * `unavailable` — a partial incident is still worth showing, but the UI must
 * say which parts are missing rather than rendering an empty list.
 */
import type { Database } from './database.types'
import { MATCHING_RULE, sourceCategoryLabel } from './incidentRules'
import type {
  ActionWorkflowStatus,
  CitizenActionAnswer,
  IncidentClassification,
  IncidentStatus,
  MissionOutcome,
  PlaybookRankingContext,
  RecurrenceOutcomeKind,
  RecurrenceReviewStatus,
  RecurrenceType,
  RoutingConfidenceLevel,
  SourceCategory,
  SourceConfidence,
  TaskDispatchStatus,
} from './incidentRules'
import { supabase } from './supabase'

type Row<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row']

export type IncidentRow = Row<'incidents'>
export type IncidentEvidenceRow = Row<'incident_evidence'>
export type SourceHypothesisRow = Row<'incident_source_hypotheses'>
export type EvidenceMissionRow = Row<'evidence_missions'>
export type IncidentEventRow = Row<'incident_events'>
export type ActionRow = Row<'actions'>
export type ActionEvidenceRow = Row<'action_evidence'>
export type ImpactEvaluationRow = Row<'impact_evaluations'>
export type PlaybookRow = Row<'intervention_playbooks'>
export type IncidentRecurrenceReportRow = Row<'incident_recurrence_reports'>
export type AnomalyCandidateRow = Row<'anomaly_candidates'>
export type StationRow = Row<'stations'>
export type ForecastRunRow = Row<'forecast_runs'>
export type TaskDispatchRow = Row<'task_dispatches'>
export type SlaRuleRow = Row<'sla_rules'>
export type NotificationRow = Row<'notifications'>
export type ResponsibilityRegistryRow = Row<'responsibility_registry'>

export interface Incident extends IncidentRow {
  ward_name: string | null
}

/** A citizen report linked to an incident. */
export interface LinkedReport {
  id: number
  description: string | null
  ai_category: SourceCategory | null
  photo_url: string | null
  status: string
  created_at: string
  lat: number | null
  lng: number | null
  reporter_id: string | null
}

const INCIDENT_SELECT = '*, wards(name)'

function shapeIncident(row: IncidentRow & { wards?: { name: string } | { name: string }[] | null }): Incident {
  const ward = row.wards
  const { wards: _ward, ...rest } = row
  return {
    ...rest,
    ward_name: Array.isArray(ward) ? (ward[0]?.name ?? null) : (ward?.name ?? null),
  }
}

function fail(context: string, error: { message: string }): never {
  throw new Error(`${context}: ${error.message}`)
}

// ── list ─────────────────────────────────────────────────────────────────────

export interface ListIncidentsOptions {
  /** Ward scope. Field officers are ward-scoped by RLS anyway; this is for UI filters. */
  wardId?: number
  status?: IncidentStatus[]
  limit?: number
  /** Excludes `status='closed'` — used for the "open" queues (active/predicted/
   *  verification/assigned/escalated), which are loaded in full (see
   *  listClosedIncidents/listRecurrenceQueueIncidents below for the paginated,
   *  unboundedly-growing closed set). */
  excludeClosed?: boolean
}

/**
 * List incidents, newest first. Returns [] for "none match" — callers must
 * distinguish that from a thrown error (which means the load failed).
 */
export async function listIncidents(opts: ListIncidentsOptions = {}): Promise<Incident[]> {
  let q = supabase.from('incidents').select(INCIDENT_SELECT).order('detected_at', { ascending: false })
  if (opts.wardId != null) q = q.eq('ward_id', opts.wardId)
  if (opts.status?.length) q = q.in('status', opts.status)
  if (opts.excludeClosed) q = q.neq('status', 'closed')
  q = q.limit(opts.limit ?? 200)

  const { data, error } = await q
  if (error) fail('Could not load incidents', error)
  return (data ?? []).map((r) => shapeIncident(r as never))
}

export interface IncidentsPage {
  rows: Incident[]
  totalCount: number
  hasMore: boolean
}

/**
 * The `closed` queue, paginated — unlike the open queues, closed incidents
 * are a historical record that grows unboundedly, so this is the one queue
 * safe (and necessary) to page rather than load in full. Offset-based
 * (`.range()`), not keyset: at this dataset's real size (~5k incidents at
 * the project's own forward-looking target), OFFSET scan cost isn't a real
 * problem, and a keyset cursor over `detected_at` (non-unique) would need a
 * composite (detected_at, id) cursor for no real benefit yet — revisit if
 * volume ever grows past the point that trade-off flips.
 */
export async function listClosedIncidents(opts: { wardId?: number; offset: number; pageSize?: number }): Promise<IncidentsPage> {
  const pageSize = opts.pageSize ?? 50
  let q = supabase
    .from('incidents')
    .select(INCIDENT_SELECT, { count: 'exact' })
    .eq('status', 'closed')
    .order('detected_at', { ascending: false })
    .range(opts.offset, opts.offset + pageSize - 1)
  if (opts.wardId != null) q = q.eq('ward_id', opts.wardId)

  const { data, error, count } = await q
  if (error) fail('Could not load closed incidents', error)
  const rows = (data ?? []).map((r) => shapeIncident(r as never))
  const totalCount = count ?? rows.length
  return { rows, totalCount, hasMore: opts.offset + rows.length < totalCount }
}

/**
 * The `recurrence` queue (closed incidents with at least one pending citizen
 * recurrence report), paginated independently of listClosedIncidents rather
 * than derived from whatever page of `closed` happens to be loaded — a
 * closed-queue "load more" must never silently make this queue's count or
 * contents wrong. Uses a PostgREST inner-join embed + filter on the embedded
 * table rather than a new SQL function: RLS already scopes
 * incident_recurrence_reports the same way it scopes the parent incident, so
 * this needs no new grant/policy.
 */
export async function listRecurrenceQueueIncidents(opts: {
  wardId?: number
  offset: number
  pageSize?: number
}): Promise<IncidentsPage> {
  const pageSize = opts.pageSize ?? 50
  let q = supabase
    .from('incidents')
    .select(`${INCIDENT_SELECT}, incident_recurrence_reports!inner(review_status)`, { count: 'exact' })
    .eq('status', 'closed')
    .eq('incident_recurrence_reports.review_status', 'pending')
    .order('detected_at', { ascending: false })
    .range(opts.offset, opts.offset + pageSize - 1)
  if (opts.wardId != null) q = q.eq('ward_id', opts.wardId)

  const { data, error, count } = await q
  if (error) fail('Could not load the recurrence queue', error)
  const rows = (data ?? []).map((r) => shapeIncident(r as never))
  const totalCount = count ?? rows.length
  return { rows, totalCount, hasMore: opts.offset + rows.length < totalCount }
}

// ── read one ─────────────────────────────────────────────────────────────────

export async function getIncident(id: number): Promise<Incident | null> {
  const { data, error } = await supabase.from('incidents').select(INCIDENT_SELECT).eq('id', id).maybeSingle()
  if (error) fail('Could not load incident', error)
  return data ? shapeIncident(data as never) : null
}

/** Monitoring evidence for the incident's ward, when a station reports there. */
export interface SensorEvidence {
  pm25: number | null
  pm10: number | null
  aqi: number | null
  ts: string | null
}

/** An intervention (`actions` row, incident-linked) plus its operational proof. */
export interface InterventionWithEvidence {
  action: ActionRow
  evidence: ActionEvidenceRow[]
}

export interface IncidentDetail {
  incident: Incident
  reports: LinkedReport[]
  evidence: IncidentEvidenceRow[]
  hypotheses: SourceHypothesisRow[]
  missions: EvidenceMissionRow[]
  events: IncidentEventRow[]
  sensor: SensorEvidence | null
  /**
   * Interventions (Phase 4). A citizen has zero RLS-visible rows on `actions`
   * (verified) — RLS filters to an empty result set rather than raising, so
   * this naturally resolves `[]` for that role without a thrown error, and no
   * special-casing is needed here to keep it out of `unavailable`.
   */
  interventions: InterventionWithEvidence[]
  impactEvaluations: ImpactEvaluationRow[]
  /**
   * Recurrence reports (Phase 5.1). Citizens have no RLS read on this table
   * (they go through `list_my_recurrence_reports` instead) — for that role
   * this naturally settles to `[]` rather than raising, same as
   * `interventions` above.
   */
  recurrenceReports: IncidentRecurrenceReportRow[]
  /**
   * Anomaly-detection candidates (Phase 6) — only ever non-empty for an
   * incident that originated from automated detection
   * (`incident.detection_stage` set). Citizens have no RLS read on this
   * table (internal detection detail) — settles to `[]` for that role, same
   * pattern as `interventions`/`recurrenceReports` above.
   */
  anomalyCandidates: AnomalyCandidateRow[]
  /**
   * Probable-source responsibility routing (Phase 7) — the top LOCAL
   * hypothesis's registry match, or null when there is no current local
   * hypothesis to route at all (e.g. still `unresolved`). Citizens have no
   * RLS read on the underlying tables this reads (internal detail), so it
   * naturally settles to `null` for that role, same pattern as
   * `interventions`/`anomalyCandidates` above.
   */
  responsibleAuthority: ResponsibleAuthority | null
  /**
   * Sections that failed to load. The workspace renders an explicit
   * "unavailable" state for these instead of an empty list — an evidence panel
   * that silently shows nothing because the query failed is worse than one that
   * says it couldn't load.
   */
  unavailable: string[]
}

/**
 * Load an incident and everything hanging off it. Sub-queries are settled
 * independently: one failing section (e.g. hypotheses, which citizens cannot
 * read at all) must not blank the whole workspace.
 */
export async function getIncidentDetail(id: number): Promise<IncidentDetail | null> {
  const incident = await getIncident(id)
  if (!incident) return null

  const [
    reports,
    evidence,
    hypotheses,
    missions,
    events,
    sensor,
    interventions,
    impactEvaluations,
    recurrenceReports,
    anomalyCandidates,
    responsibleAuthority,
  ] = await Promise.allSettled([
    listLinkedReports(id),
    listIncidentEvidence(id),
    listSourceHypotheses(id),
    listEvidenceMissions({ incidentId: id }),
    listIncidentEvents(id),
    fetchSensorEvidence(incident.ward_id),
    listInterventions(id),
    listImpactEvaluations(id),
    listRecurrenceReportsForIncident(id),
    listAnomalyCandidatesForIncident(id),
    getIncidentResponsibleAuthority(id),
  ])

  const unavailable: string[] = []
  const take = <T>(r: PromiseSettledResult<T>, label: string, empty: T): T => {
    if (r.status === 'fulfilled') return r.value
    unavailable.push(label)
    return empty
  }

  return {
    incident,
    reports: take(reports, 'Linked reports', []),
    evidence: take(evidence, 'Evidence', []),
    hypotheses: take(hypotheses, 'Source hypotheses', []),
    missions: take(missions, 'Evidence missions', []),
    events: take(events, 'Timeline', []),
    sensor: take(sensor, 'Monitoring data', null),
    interventions: take(interventions, 'Interventions', []),
    impactEvaluations: take(impactEvaluations, 'Impact evaluations', []),
    recurrenceReports: take(recurrenceReports, 'Recurrence reports', []),
    anomalyCandidates: take(anomalyCandidates, 'Anomaly candidates', []),
    responsibleAuthority: take(responsibleAuthority, 'Responsibility routing', null),
    unavailable,
  }
}

export async function listLinkedReports(incidentId: number): Promise<LinkedReport[]> {
  const { data, error } = await supabase
    .from('reports')
    .select('id, description, ai_category, photo_url, status, created_at, lat, lng, reporter_id')
    .eq('incident_id', incidentId)
    .order('created_at', { ascending: false })
  if (error) fail('Could not load linked reports', error)
  return (data ?? []) as LinkedReport[]
}

export async function listIncidentEvidence(incidentId: number): Promise<IncidentEvidenceRow[]> {
  const { data, error } = await supabase
    .from('incident_evidence')
    .select('*')
    .eq('incident_id', incidentId)
    .order('collected_at', { ascending: false })
  if (error) fail('Could not load evidence', error)
  return data ?? []
}

export async function listSourceHypotheses(incidentId: number): Promise<SourceHypothesisRow[]> {
  const { data, error } = await supabase
    .from('incident_source_hypotheses')
    .select('*')
    .eq('incident_id', incidentId)
    .order('probability', { ascending: false })
  if (error) fail('Could not load source hypotheses', error)
  return data ?? []
}

export async function listIncidentEvents(incidentId: number): Promise<IncidentEventRow[]> {
  const { data, error } = await supabase
    .from('incident_events')
    .select('*')
    .eq('incident_id', incidentId)
    .order('ts', { ascending: true })
  if (error) fail('Could not load the incident timeline', error)
  return data ?? []
}

/**
 * Latest reading for the incident's ward. Monitoring evidence is best-effort:
 * not every ward has a live station (R.K. Puram's OpenAQ id is still unresolved
 * in ingest/stations.yaml), so null here means "no sensor covers this ward",
 * which the UI states explicitly rather than showing a dash.
 */
export async function fetchSensorEvidence(wardId: number | null): Promise<SensorEvidence | null> {
  if (wardId == null) return null
  const { data: stations, error: stationErr } = await supabase.from('stations').select('id').eq('ward_id', wardId)
  if (stationErr) fail('Could not load monitoring stations', stationErr)
  const ids = (stations ?? []).map((s) => s.id)
  if (!ids.length) return null

  const { data, error } = await supabase
    .from('readings')
    .select('pm25, pm10, aqi, ts')
    .in('station_id', ids)
    .order('ts', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) fail('Could not load monitoring data', error)
  return data ?? null
}

// ── create / update ──────────────────────────────────────────────────────────

export interface CreateIncidentParams {
  wardId: number
  /** Never optional by design: an incident must always say how it was detected. */
  detectionMethod: string
  summary: string
  lat?: number | null
  lng?: number | null
  primaryPollutant?: string | null
  localExcess?: number | null
  severity?: string | null
  createdBy: string
  /**
   * Set when this incident is being created as a "new linked incident" from a
   * citizen recurrence report (Phase 5.1) — traceability back to the incident
   * it recurred from. Paired with the report's own `resulting_incident_id`
   * (set separately, by `createLinkedIncidentFromRecurrence`).
   */
  recurrenceOfIncidentId?: number | null
}

export async function createIncident(p: CreateIncidentParams): Promise<number> {
  const { data: ward } = await supabase.from('wards').select('city_id').eq('id', p.wardId).maybeSingle()

  const { data, error } = await supabase
    .from('incidents')
    .insert({
      ward_id: p.wardId,
      city_id: ward?.city_id ?? null,
      detection_method: p.detectionMethod,
      summary: p.summary,
      lat: p.lat ?? null,
      lng: p.lng ?? null,
      primary_pollutant: p.primaryPollutant ?? 'pm25',
      local_excess: p.localExcess ?? null,
      severity: p.severity ?? null,
      created_by: p.createdBy,
      recurrence_of_incident_id: p.recurrenceOfIncidentId ?? null,
    })
    .select('id')
    .single()
  if (error) fail('Could not create the incident', error)

  await addIncidentEvent({
    incidentId: data.id,
    eventType: 'created',
    actorId: p.createdBy,
    note: 'Incident opened manually from the command workspace.',
    isPublic: true,
    payload: { detection_method: p.detectionMethod },
  })
  return data.id
}

export async function updateIncidentStatus(
  incidentId: number,
  status: IncidentStatus,
  actorId: string,
  note?: string,
): Promise<void> {
  const patch: Database['public']['Tables']['incidents']['Update'] = {
    status,
    updated_at: new Date().toISOString(),
  }
  if (status === 'closed') patch.closed_at = new Date().toISOString()

  const { error } = await supabase.from('incidents').update(patch).eq('id', incidentId)
  if (error) fail('Could not update the incident status', error)

  await addIncidentEvent({
    incidentId,
    eventType: status === 'closed' ? 'closed' : 'status_changed',
    actorId,
    note: note ?? `Status changed to ${status.replace(/_/g, ' ')}.`,
    // Status movement is exactly what a citizen is entitled to see.
    isPublic: true,
    payload: { status },
  })
}

export async function updateIncidentAssignment(
  incidentId: number,
  authority: string,
  actorId: string,
): Promise<void> {
  const { error } = await supabase
    .from('incidents')
    .update({ assigned_authority: authority, status: 'routed', updated_at: new Date().toISOString() })
    .eq('id', incidentId)
  if (error) fail('Could not assign the incident', error)

  await addIncidentEvent({
    incidentId,
    eventType: 'routed',
    actorId,
    // Citizens are told *that* it was routed to a named authority (plan §11:
    // "track which authority received the incident") but never the internal
    // enforcement reasoning, which stays in private events.
    note: `Referred to ${authority}.`,
    isPublic: true,
    payload: { assigned_authority: authority },
  })
}

/** Set the incident's evidence level, recording who decided and why. */
export async function updateSourceConfidence(
  incidentId: number,
  level: SourceConfidence,
  actorId: string,
  note: string,
): Promise<void> {
  const { error } = await supabase
    .from('incidents')
    .update({ source_confidence: level, updated_at: new Date().toISOString() })
    .eq('id', incidentId)
  if (error) fail('Could not update the evidence level', error)

  await addIncidentEvent({
    incidentId,
    eventType: 'hypothesis_updated',
    actorId,
    note,
    isPublic: true,
    payload: { source_confidence: level },
  })
}

// ── link a report to an incident ─────────────────────────────────────────────

/**
 * Run the match-or-create rule for a report.
 *
 * This is an RPC, not a client-side insert, for two reasons that are both load
 * bearing:
 *   1. RLS — a citizen may not insert `incidents` nor update `reports.incident_id`
 *      (the UPDATE silently affects 0 rows). Verified against the real policies.
 *   2. Duplicates — matching and inserting must happen in one transaction under
 *      a ward lock, or two simultaneous reports about one event each create an
 *      incident. A read-then-write from the browser cannot provide that.
 *
 * The rule's parameters are passed explicitly (rather than relying on the SQL
 * defaults) so the values the UI explains and the values the DB applies are the
 * same constants. Returns the incident id.
 */
export async function linkReportToIncident(reportId: number): Promise<number> {
  const { data, error } = await supabase.rpc('link_report_to_incident', {
    p_report_id: reportId,
    p_recency_hours: MATCHING_RULE.recencyHours,
    p_radius_m: MATCHING_RULE.radiusM,
  })
  if (error) fail('Could not link this report to an incident', error)
  return data as number
}

/** The incident a report ended up on, for the citizen's own report list. */
export async function fetchIncidentForReport(reportId: number): Promise<Incident | null> {
  const { data, error } = await supabase.from('reports').select('incident_id').eq('id', reportId).maybeSingle()
  if (error) fail('Could not load the linked incident', error)
  if (!data?.incident_id) return null
  return getIncident(data.incident_id)
}

// ── evidence ─────────────────────────────────────────────────────────────────

export interface AddEvidenceParams {
  incidentId: number
  evidenceType: Database['public']['Tables']['incident_evidence']['Insert']['evidence_type']
  /** true = supports the leading hypothesis, false = contradicts it. Never inferred. */
  supports: boolean | null
  confidence?: number | null
  reportId?: number | null
  payload?: Record<string, unknown>
  collectedBy: string
}

export async function addIncidentEvidence(p: AddEvidenceParams): Promise<number> {
  const { data, error } = await supabase
    .from('incident_evidence')
    .insert({
      incident_id: p.incidentId,
      evidence_type: p.evidenceType,
      supports: p.supports,
      confidence: p.confidence ?? null,
      report_id: p.reportId ?? null,
      payload: (p.payload ?? {}) as never,
      collected_by: p.collectedBy,
    })
    .select('id')
    .single()
  if (error) fail('Could not add evidence', error)

  await addIncidentEvent({
    incidentId: p.incidentId,
    eventType: 'evidence_added',
    actorId: p.collectedBy,
    note: p.supports === false ? 'Contradictory evidence recorded.' : 'Supporting evidence recorded.',
    isPublic: false,
    payload: { evidence_type: p.evidenceType },
  })
  return data.id
}

// ── source hypotheses ────────────────────────────────────────────────────────

export interface UpsertHypothesisParams {
  incidentId: number
  sourceCategory: SourceCategory
  probability: number
  confidenceLevel: SourceConfidence
  rationale: string
  contradictedBy?: string | null
  /** Names the rule/model that produced this. Manual entries say so. */
  modelVersion: string
  actorId: string
}

/**
 * Add or update a source hypothesis.
 *
 * There is no unique constraint on (incident_id, source_category, model_version)
 * in the Phase 2 schema, so this does a read-then-write rather than a real
 * upsert. That is fine for the command workspace (a human editing one incident)
 * but would race if a background job ever wrote hypotheses concurrently —
 * flagged in IMPLEMENTATION_STATUS.md rather than papered over.
 */
export async function upsertSourceHypothesis(p: UpsertHypothesisParams): Promise<void> {
  if (p.probability < 0 || p.probability > 1) {
    throw new Error('Probability must be between 0 and 1.')
  }

  const { data: existing, error: readErr } = await supabase
    .from('incident_source_hypotheses')
    .select('id')
    .eq('incident_id', p.incidentId)
    .eq('source_category', p.sourceCategory)
    .eq('model_version', p.modelVersion)
    .maybeSingle()
  if (readErr) fail('Could not read existing hypotheses', readErr)

  const values = {
    incident_id: p.incidentId,
    source_category: p.sourceCategory,
    probability: p.probability,
    confidence_level: p.confidenceLevel,
    rationale: p.rationale,
    contradicted_by: p.contradictedBy ?? null,
    model_version: p.modelVersion,
    computed_at: new Date().toISOString(),
  }

  const { error } = existing
    ? await supabase.from('incident_source_hypotheses').update(values).eq('id', existing.id)
    : await supabase.from('incident_source_hypotheses').insert(values)
  if (error) fail('Could not save the source hypothesis', error)

  await addIncidentEvent({
    incidentId: p.incidentId,
    eventType: 'hypothesis_updated',
    actorId: p.actorId,
    note: `${p.sourceCategory.replace(/_/g, ' ')} assessed at ${Math.round(p.probability * 100)}% (${p.confidenceLevel}).`,
    isPublic: false,
    payload: { source_category: p.sourceCategory, probability: p.probability },
  })
}

// ── evidence missions ────────────────────────────────────────────────────────

export interface CreateMissionParams {
  incidentId: number
  missionType: Database['public']['Tables']['evidence_missions']['Insert']['mission_type']
  assignedTo?: string | null
  /** Why this evidence is needed - required by plan §10, so required here. */
  rationale: string
  /** Citizen-facing wording. Kept separate from `rationale`, which may be internal. */
  publicPrompt?: string | null
  expectedConfidenceGain?: number | null
  actorId: string
}

export async function createEvidenceMission(p: CreateMissionParams): Promise<number> {
  if (!p.rationale.trim()) {
    throw new Error('A mission must record why the evidence is needed.')
  }

  const { data, error } = await supabase
    .from('evidence_missions')
    .insert({
      incident_id: p.incidentId,
      mission_type: p.missionType,
      assigned_to: p.assignedTo ?? null,
      rationale: p.rationale,
      public_prompt: p.publicPrompt ?? null,
      expected_confidence_gain: p.expectedConfidenceGain ?? null,
      status: p.assignedTo ? 'dispatched' : 'proposed',
      dispatched_at: p.assignedTo ? new Date().toISOString() : null,
    })
    .select('id')
    .single()
  if (error) fail('Could not create the evidence mission', error)

  await addIncidentEvent({
    incidentId: p.incidentId,
    eventType: 'mission_dispatched',
    actorId: p.actorId,
    note: `Evidence mission created: ${p.missionType.replace(/_/g, ' ')}.`,
    isPublic: false,
    payload: { mission_type: p.missionType },
  })

  // Move the incident into evidence gathering, but never override a further-along
  // status (an incident already dispatched shouldn't fall back).
  const { data: inc } = await supabase.from('incidents').select('status').eq('id', p.incidentId).maybeSingle()
  if (inc && (inc.status === 'detected' || inc.status === 'under_review')) {
    await supabase
      .from('incidents')
      .update({ status: 'evidence_gathering', updated_at: new Date().toISOString() })
      .eq('id', p.incidentId)
  }
  return data.id
}

export interface AssignableOfficer {
  id: string
  full_name: string | null
  ward_id: number | null
}

/**
 * Field officers a commander may assign a mission to.
 *
 * Goes through an RPC because the baseline `profiles` policy lets a user read
 * only their own row — a commander querying `profiles` directly gets zero rows
 * (verified), which would silently produce an empty officer list rather than an
 * error. The function returns only id/name/ward, never contact details.
 */
export async function listAssignableOfficers(wardId?: number | null): Promise<AssignableOfficer[]> {
  const { data, error } = await supabase.rpc('list_assignable_officers', {
    p_ward_id: wardId ?? undefined,
  })
  if (error) fail('Could not load field officers', error)
  return (data ?? []) as AssignableOfficer[]
}

export interface ListMissionsOptions {
  incidentId?: number
  assignedTo?: string
  status?: Database['public']['Enums']['mission_status'][]
}

export async function listEvidenceMissions(opts: ListMissionsOptions = {}): Promise<EvidenceMissionRow[]> {
  let q = supabase.from('evidence_missions').select('*').order('created_at', { ascending: false })
  if (opts.incidentId != null) q = q.eq('incident_id', opts.incidentId)
  if (opts.assignedTo) q = q.eq('assigned_to', opts.assignedTo)
  if (opts.status?.length) q = q.in('status', opts.status)

  const { data, error } = await q
  if (error) fail('Could not load evidence missions', error)
  return data ?? []
}

/** A mission plus the incident context an officer needs to actually work it. */
export interface MissionWithIncident {
  mission: EvidenceMissionRow
  incident: Incident | null
  leadingCategory: SourceCategory | null
}

export async function listMissionsForUser(userId: string): Promise<MissionWithIncident[]> {
  const missions = await listEvidenceMissions({ assignedTo: userId })
  if (!missions.length) return []

  const incidentIds = [...new Set(missions.map((m) => m.incident_id))]
  const { data: incidents, error } = await supabase.from('incidents').select(INCIDENT_SELECT).in('id', incidentIds)
  if (error) fail('Could not load the incidents for your missions', error)

  const byId = new Map<number, Incident>()
  for (const row of incidents ?? []) {
    const shaped = shapeIncident(row as never)
    byId.set(shaped.id, shaped)
  }

  // Leading hypothesis drives the checklist. Citizens can't read hypotheses at
  // all (RLS), so this must degrade to a generic checklist rather than throw.
  let leading = new Map<number, SourceCategory>()
  try {
    const { data: hyps } = await supabase
      .from('incident_source_hypotheses')
      .select('incident_id, source_category, probability')
      .in('incident_id', incidentIds)
      .order('probability', { ascending: false })
    for (const h of hyps ?? []) {
      if (h.source_category && !leading.has(h.incident_id)) leading.set(h.incident_id, h.source_category)
    }
  } catch {
    leading = new Map()
  }

  return missions.map((m) => ({
    mission: m,
    incident: byId.get(m.incident_id) ?? null,
    leadingCategory: leading.get(m.incident_id) ?? null,
  }))
}

export interface SubmitMissionParams {
  missionId: number
  incidentId: number
  outcome: MissionOutcome
  checklistResponse: Record<string, unknown>
  proofPhotoUrl?: string | null
  lat?: number | null
  lng?: number | null
  notes?: string | null
  actorId: string
  /** Field officers officially verify; citizens only contribute supporting evidence. */
  isAuthorisedOfficer: boolean
}

/**
 * Submit a completed mission: record the result, file it as incident evidence,
 * and move the incident's evidence level per the field-outcome rule.
 *
 * Not a transaction — supabase-js has no client-side transaction, so a failure
 * partway leaves the mission completed but the incident level unmoved. That is
 * the safe direction to fail (evidence is recorded; the privileged state change
 * is what's skipped) and is recoverable by re-running from the command
 * workspace. Making this atomic means a second RPC, noted as follow-up work.
 */
export async function submitMissionResult(p: SubmitMissionParams): Promise<void> {
  const { error } = await supabase
    .from('evidence_missions')
    .update({
      status: 'completed',
      outcome: p.outcome,
      checklist_response: p.checklistResponse as never,
      proof_photo_url: p.proofPhotoUrl ?? null,
      lat: p.lat ?? null,
      lng: p.lng ?? null,
      notes: p.notes ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', p.missionId)
  if (error) fail('Could not submit the mission result', error)

  await addIncidentEvidence({
    incidentId: p.incidentId,
    evidenceType: p.proofPhotoUrl ? 'photo' : 'field_inspection',
    // "unresolved" is neither support nor contradiction — null, not false.
    supports: p.outcome === 'confirmed' ? true : p.outcome === 'rejected' ? false : null,
    reportId: null,
    payload: {
      outcome: p.outcome,
      checklist: p.checklistResponse,
      photo_url: p.proofPhotoUrl ?? null,
      lat: p.lat ?? null,
      lng: p.lng ?? null,
      mission_id: p.missionId,
      authorised_officer: p.isAuthorisedOfficer,
    },
    collectedBy: p.actorId,
  })

  await addIncidentEvent({
    incidentId: p.incidentId,
    eventType: 'evidence_added',
    actorId: p.actorId,
    note:
      p.outcome === 'confirmed'
        ? 'A field visit confirmed the suspected source.'
        : p.outcome === 'rejected'
          ? 'A field visit did not find the suspected source.'
          : 'A field visit could not determine the source.',
    isPublic: true,
    payload: { outcome: p.outcome },
  })
}

// ── timeline ─────────────────────────────────────────────────────────────────

export interface AddEventParams {
  incidentId: number
  eventType: string
  actorId: string | null
  note: string
  /**
   * Whether a citizen who reported this incident may see the event. Defaults to
   * false at the DB level, so anything not explicitly public stays internal.
   */
  isPublic: boolean
  payload?: Record<string, unknown>
}

export async function addIncidentEvent(p: AddEventParams): Promise<void> {
  const { error } = await supabase.from('incident_events').insert({
    incident_id: p.incidentId,
    event_type: p.eventType,
    actor_id: p.actorId,
    note: p.note,
    is_public: p.isPublic,
    payload: (p.payload ?? {}) as never,
  })
  // An audit row failing to write must not roll back the user's actual action,
  // but it must not be silent either.
  if (error) console.error(`Failed to record incident event (${p.eventType}):`, error.message)
}

// ── citizen-facing ───────────────────────────────────────────────────────────

export interface CitizenIncidentView {
  id: number
  status: IncidentStatus
  ward_name: string | null
  summary: string | null
  detected_at: string
  closed_at: string | null
  assigned_authority: string | null
  /** A plain column on `incidents`, safe for a citizen to see (used only to
   *  apply the "stay indoors when severe" rule client-side — see incidentRules
   *  citizenVerificationSafety). Not source confidence, not evidence detail. */
  severity: string | null
  /**
   * The most recent impact_evaluations.outcome, if any (Phase 5.1, "final
   * outcome" for a closed incident). RLS on `impact_evaluations` already
   * grants a linked citizen full read (Phase 4, intentional — see that
   * migration's own comment) — this selects only the `outcome` column itself,
   * never `notes`/`method_limitation`/`weather_adjustment`, which may carry
   * internal reasoning.
   */
  last_outcome: Database['public']['Enums']['incident_outcome'] | null
  /** Public events only. RLS enforces this; we do not rely on filtering here. */
  timeline: IncidentEventRow[]
}

/**
 * The citizen's view of an incident their report is attached to.
 *
 * Safety note: this deliberately does NOT select source hypotheses, evidence
 * confidence, internal notes or enforcement actions. Those are blocked by RLS
 * too — this is defence in depth, not the only guard.
 */
export async function fetchCitizenIncidentView(incidentId: number): Promise<CitizenIncidentView | null> {
  const incident = await getIncident(incidentId)
  if (!incident) return null

  let timeline: IncidentEventRow[] = []
  try {
    timeline = await listIncidentEvents(incidentId)
  } catch {
    timeline = []
  }

  let lastOutcome: Database['public']['Enums']['incident_outcome'] | null = null
  try {
    const { data } = await supabase
      .from('impact_evaluations')
      .select('outcome')
      .eq('incident_id', incidentId)
      .order('evaluated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    lastOutcome = data?.outcome ?? null
  } catch {
    lastOutcome = null
  }

  return {
    id: incident.id,
    status: incident.status,
    ward_name: incident.ward_name,
    summary: incident.summary,
    detected_at: incident.detected_at,
    closed_at: incident.closed_at,
    assigned_authority: incident.assigned_authority,
    severity: incident.severity,
    last_outcome: lastOutcome,
    timeline: timeline.filter((e) => e.is_public),
  }
}

/**
 * A verification request as a citizen is allowed to see it.
 *
 * Note what is absent: `rationale` (the internal note, which may name the
 * responsible authority or enforcement intent), the assignee, and the expected
 * confidence gain. `leading_category` and `severity` are present only because
 * the client-side safety rule needs them, and both are things we would tell the
 * public anyway.
 */
export interface CitizenMission {
  mission_id: number
  incident_id: number
  mission_type: string
  status: Database['public']['Enums']['mission_status']
  public_prompt: string | null
  outcome: string | null
  incident_status: IncidentStatus
  ward_name: string | null
  leading_category: SourceCategory | null
  severity: string | null
}

/**
 * Verification requests waiting on this citizen.
 *
 * Goes through an RPC rather than reading `evidence_missions`: citizens have no
 * direct read on that table precisely so `rationale` cannot be fetched from the
 * API. Filtering in the client would not have been a control — the row would
 * still cross the wire.
 */
export async function fetchCitizenMissions(): Promise<CitizenMission[]> {
  const { data, error } = await supabase.rpc('list_my_citizen_missions')
  if (error) fail('Could not load verification requests', error)
  return (data ?? []) as CitizenMission[]
}

/**
 * Record a citizen's answer to a verification request.
 *
 * Server-side by design: the function checks that the request is actually
 * addressed to this citizen, and it deliberately never touches the incident's
 * source confidence. A citizen's answer is supporting evidence; it cannot
 * establish a source or a violation on its own (plan §11).
 */
export async function submitCitizenVerification(missionId: number, outcome: MissionOutcome): Promise<void> {
  const { error } = await supabase.rpc('submit_citizen_verification', {
    p_mission_id: missionId,
    p_outcome: outcome,
  })
  if (error) fail('Could not send your answer', error)
}

// ── interventions (Phase 4) ──────────────────────────────────────────────────
//
// `actions` predates the incident model (it is also the legacy report-scoped
// task queue FieldView already reads) — these functions only ever touch
// incident-linked rows (`incident_id` set), which is what the DB trigger keys
// on to apply the Phase 4 rules. The legacy, non-incident action flow is
// untouched by everything below.

export async function listInterventions(incidentId: number): Promise<InterventionWithEvidence[]> {
  const { data: actions, error } = await supabase
    .from('actions')
    .select('*')
    .eq('incident_id', incidentId)
    .order('created_at', { ascending: true })
  if (error) fail('Could not load interventions', error)
  if (!actions?.length) return []

  const ids = actions.map((a) => a.id)
  const { data: evid, error: evidErr } = await supabase
    .from('action_evidence')
    .select('*')
    .in('action_id', ids)
    .order('captured_at', { ascending: true })
  if (evidErr) fail('Could not load operational evidence', evidErr)

  const byAction = new Map<number, ActionEvidenceRow[]>()
  for (const e of evid ?? []) {
    const list = byAction.get(e.action_id) ?? []
    list.push(e)
    byAction.set(e.action_id, list)
  }

  return actions.map((action) => ({ action, evidence: byAction.get(action.id) ?? [] }))
}

/** An intervention plus enough incident context for the field officer to work it. */
export interface InterventionWithIncident {
  action: ActionRow
  incident: Incident | null
  leadingCategory: SourceCategory | null
}

/**
 * Interventions assigned to this officer specifically — a focused personal
 * queue, mirroring `listMissionsForUser`. RLS also lets a field officer read
 * every action in their own ward regardless of assignee (unchanged, pre-Phase-4
 * policy), so this is a UI-level narrowing for a personal work list, not an
 * access boundary — the boundary is already enforced by the database.
 */
export async function listInterventionsForOfficer(userId: string): Promise<InterventionWithIncident[]> {
  const { data: actions, error } = await supabase
    .from('actions')
    .select('*')
    .eq('assigned_to', userId)
    .not('incident_id', 'is', null)
    .order('created_at', { ascending: false })
  if (error) fail('Could not load your interventions', error)
  if (!actions?.length) return []

  const incidentIds = [...new Set(actions.map((a) => a.incident_id).filter((id): id is number => id != null))]
  const { data: incidents, error: incErr } = await supabase.from('incidents').select(INCIDENT_SELECT).in('id', incidentIds)
  if (incErr) fail('Could not load the incidents for your interventions', incErr)

  const byId = new Map<number, Incident>()
  for (const row of incidents ?? []) {
    const shaped = shapeIncident(row as never)
    byId.set(shaped.id, shaped)
  }

  const { data: hyps } = await supabase
    .from('incident_source_hypotheses')
    .select('incident_id, source_category, probability')
    .in('incident_id', incidentIds)
    .order('probability', { ascending: false })
  const leading = new Map<number, SourceCategory>()
  for (const h of hyps ?? []) {
    if (h.source_category && !leading.has(h.incident_id)) leading.set(h.incident_id, h.source_category)
  }

  return actions.map((action) => ({
    action,
    incident: action.incident_id != null ? (byId.get(action.incident_id) ?? null) : null,
    leadingCategory: action.incident_id != null ? (leading.get(action.incident_id) ?? null) : null,
  }))
}

export interface CreateInterventionParams {
  incidentId: number
  wardId: number
  /** Enforcement types ('penalty' etc.) are gated in the DB: verified source + approver required. */
  type: string
  recommendedAction: string
  responsibleAgency: string
  /**
   * Why no playbook was suitable (Phase 5.1). This function only ever creates
   * a CUSTOM (no-playbook) intervention — playbook-based creation goes through
   * `createInterventionFromPlaybook` — and the DB trigger now refuses any
   * custom incident-linked action without a non-empty reason, so this is
   * required here too, not merely validated for UX.
   */
  customReason: string
  deadline?: string | null
  expectedVerificationHours?: number | null
  assignedTo?: string | null
}

/**
 * Create a CUSTOM incident-linked intervention (no playbook).
 *
 * The evidence-level gate (suspected → refused; enforcement → verified source +
 * named approver), the commander-only creation gate, the mandatory
 * `custom_reason`, and the regional-classification compatibility check (Phase
 * 5.1) are all enforced by the `enforce_incident_action_rules` trigger — this
 * function does not duplicate those checks client-side (beyond the same
 * non-empty validation the trigger itself performs, for a fast UI error), so a
 * Postgres error is the source of truth and the caller must surface
 * `error.message` rather than assume success. `workflow_status` defaults to
 * 'drafted' unless an assignee is given, in which case it starts at 'assigned'
 * (skipping the approval step is correct for non-enforcement actions, which
 * plan §14 does not require command approval for beyond the evidence-level
 * gate itself).
 *
 * The creation event (labelled distinctly as "custom intervention created",
 * naming the reason) is now written by the `log_action_creation_event` DB
 * trigger — guaranteed, not best-effort — so this function does not write one
 * itself.
 */
export async function createIntervention(p: CreateInterventionParams): Promise<number> {
  if (!p.recommendedAction.trim()) throw new Error('Describe the recommended action.')
  if (!p.responsibleAgency.trim()) throw new Error('Name the responsible authority.')
  if (!p.customReason.trim()) throw new Error('Explain why no playbook was suitable.')

  const { data, error } = await supabase
    .from('actions')
    .insert({
      incident_id: p.incidentId,
      ward_id: p.wardId,
      type: p.type,
      recommended_action: p.recommendedAction,
      responsible_agency: p.responsibleAgency,
      custom_reason: p.customReason,
      deadline: p.deadline ?? null,
      expected_verification_hours: p.expectedVerificationHours ?? null,
      assigned_to: p.assignedTo ?? null,
      workflow_status: p.assignedTo ? 'assigned' : 'drafted',
    })
    .select('id')
    .single()
  if (error) fail('Could not create the intervention', error)
  return data.id
}

// ── intervention playbooks (Phase 5) ─────────────────────────────────────────
//
// Structured, source-specific templates that replace free-text intervention
// creation as the primary path. `createIntervention` above is kept unchanged
// as the "custom, no playbook" fallback — for a source category or city with
// no matching playbook yet, or a genuinely novel situation — so a commander
// is never blocked from acting just because no template exists.

/**
 * Active playbooks a client may see, scoped to a city (or the national
 * defaults, `city_id is null`). Eligibility/ranking against a *specific*
 * incident is done client-side by `rankPlaybooks` in incidentRules.ts — this
 * function only fetches the raw candidate set; RLS (field_officer/commander/
 * admin, verified in supabase/tests) is what actually keeps citizens out.
 */
export async function listPlaybooksForCity(cityId: number | null): Promise<PlaybookRow[]> {
  let q = supabase.from('intervention_playbooks').select('*').eq('is_active', true)
  q = cityId == null ? q.is('city_id', null) : q.or(`city_id.eq.${cityId},city_id.is.null`)
  const { data, error } = await q.order('title')
  if (error) fail('Could not load intervention playbooks', error)
  return data ?? []
}

export async function getPlaybook(id: number): Promise<PlaybookRow | null> {
  const { data, error } = await supabase.from('intervention_playbooks').select('*').eq('id', id).maybeSingle()
  if (error) fail('Could not load the playbook', error)
  return data ?? null
}

/** Everything `rankPlaybooks` needs about an incident, gathered from data the
 *  command workspace has already loaded (no extra fetch beyond officer count). */
export function buildPlaybookRankingContext(
  incident: Pick<Incident, 'city_id' | 'source_confidence' | 'classification' | 'severity'>,
  leadingCategory: SourceCategory | null,
  assignableOfficerCount?: number | null,
): PlaybookRankingContext {
  return {
    cityId: incident.city_id,
    leadingCategory,
    sourceConfidence: incident.source_confidence,
    classification: incident.classification as IncidentClassification | null,
    severity: (incident.severity ?? null) as PlaybookRankingContext['severity'],
    assignableOfficerCount,
  }
}

export interface CreateInterventionFromPlaybookParams {
  incidentId: number
  wardId: number
  playbookId: number
  /** The commander's limited, per-incident addendum — the ONLY field this
   *  function lets a caller edit beyond scheduling/assignment. It is stored
   *  separately from the playbook's own `instructions`/`checklist` (which are
   *  snapshotted, not mutated), so an edit here can never touch
   *  `min_evidence_level` or any other gate — see the migration's comment on
   *  `enforce_incident_action_rules` for why that matters. */
  notesOverride?: string | null
  /** Defaults to the playbook's `responsible_agency_type` when omitted. */
  responsibleAgencyOverride?: string | null
  /** Defaults to the playbook's `verification_window_hours` when omitted. */
  expectedVerificationHoursOverride?: number | null
  deadline?: string | null
  assignedTo?: string | null
}

/**
 * Create an incident-linked intervention FROM a playbook: prefills action
 * type, recommended action (the playbook's instructions), responsible agency
 * type, verification timing, and — critically — a SNAPSHOT of the playbook's
 * checklist and version, so the field officer's checklist and the historical
 * record both stay stable even if the master playbook template is edited
 * later (see the migration's comment on `checklist_snapshot`/`playbook_version`).
 *
 * The evidence-level gates (suspected → refused; enforcement → verified
 * source + approver; AND the Phase 5 addition — the incident must meet the
 * playbook's own min_evidence_level) are enforced by
 * `enforce_incident_action_rules` in the database, not duplicated here — a
 * Postgres error is the source of truth, exactly like `createIntervention`.
 *
 * The creation event is written by the `log_action_creation_event` DB trigger
 * (Phase 5.1) — guaranteed, not best-effort — so this function does not write
 * one itself.
 */
export async function createInterventionFromPlaybook(p: CreateInterventionFromPlaybookParams): Promise<number> {
  const playbook = await getPlaybook(p.playbookId)
  if (!playbook) throw new Error('This playbook is no longer available.')

  const { data, error } = await supabase
    .from('actions')
    .insert({
      incident_id: p.incidentId,
      ward_id: p.wardId,
      type: playbook.action_type,
      recommended_action: playbook.instructions ?? playbook.title,
      responsible_agency: p.responsibleAgencyOverride ?? playbook.responsible_agency_type ?? 'Not specified',
      deadline: p.deadline ?? null,
      expected_verification_hours: p.expectedVerificationHoursOverride ?? playbook.verification_window_hours ?? null,
      assigned_to: p.assignedTo ?? null,
      workflow_status: p.assignedTo ? 'assigned' : 'drafted',
      playbook_id: playbook.id,
      playbook_version: playbook.version,
      playbook_notes_override: p.notesOverride?.trim() || null,
      checklist_snapshot: playbook.checklist,
    })
    .select('id')
    .single()
  if (error) fail('Could not create the intervention from this playbook', error)
  return data.id
}

/**
 * Historical usage of a playbook, tallied from the `workflow_status` of every
 * action that references it. Read-only — see `tallyPlaybookUsage`'s own
 * comment on why this never writes anything back to the playbook (plan's "do
 * not automatically rewrite playbook estimates").
 *
 * RLS-scoped like every other `actions` query: a field officer only sees
 * their own ward's usage of this playbook, commander/admin see all of it.
 * This is a UI-level convenience, not a hidden limitation — the same
 * ward-scoping already applies to `listInterventionsForOfficer`.
 */
export async function fetchPlaybookUsageWorkflowStatuses(playbookId: number): Promise<ActionWorkflowStatus[]> {
  const { data, error } = await supabase.from('actions').select('workflow_status').eq('playbook_id', playbookId)
  if (error) fail('Could not load playbook usage history', error)
  return (data ?? []).map((r) => r.workflow_status)
}

/**
 * The same usage history for several playbooks at once — one query instead of
 * one per row — for rendering "times used" alongside each candidate in a
 * ranked list, which is exactly where an N+1 query pattern would otherwise
 * creep in.
 */
export async function fetchPlaybookUsageBatch(playbookIds: number[]): Promise<Map<number, ActionWorkflowStatus[]>> {
  const byPlaybook = new Map<number, ActionWorkflowStatus[]>()
  if (!playbookIds.length) return byPlaybook
  const { data, error } = await supabase.from('actions').select('playbook_id, workflow_status').in('playbook_id', playbookIds)
  if (error) fail('Could not load playbook usage history', error)
  for (const row of data ?? []) {
    if (row.playbook_id == null) continue
    const list = byPlaybook.get(row.playbook_id) ?? []
    list.push(row.workflow_status)
    byPlaybook.set(row.playbook_id, list)
  }
  return byPlaybook
}

/**
 * Record command approval on an enforcement-sensitive intervention. Separate
 * from creation because approval is a distinct, auditable human decision
 * (plan §14) — folding it into the insert would make "who approved this and
 * when" indistinguishable from "who drafted this and when".
 */
export async function approveIntervention(
  actionId: number,
  incidentId: number,
  approverId: string,
  approvalLevel: Database['public']['Enums']['approval_level'],
): Promise<void> {
  const { error } = await supabase
    .from('actions')
    .update({
      approved_by: approverId,
      approved_at: new Date().toISOString(),
      approval_level: approvalLevel,
      workflow_status: 'awaiting_approval',
    })
    .eq('id', actionId)
  if (error) fail('Could not record approval', error)

  await addIncidentEvent({
    incidentId,
    eventType: 'action_approved',
    actorId: approverId,
    note: `Intervention approved (${approvalLevel.replace(/_/g, ' ')}).`,
    isPublic: true,
    payload: { action_id: actionId, approval_level: approvalLevel },
  })
}

/**
 * Assign a drafted/approved intervention to a field officer, moving it into
 * the operational lifecycle. Uses the same `list_assignable_officers` pool as
 * evidence missions (Phase 3) — a commander can only assign to officers
 * actually covering the ward.
 */
export async function assignIntervention(
  actionId: number,
  incidentId: number,
  assigneeId: string,
  actorId: string,
): Promise<void> {
  const { error } = await supabase
    .from('actions')
    .update({ assigned_to: assigneeId, workflow_status: 'assigned' })
    .eq('id', actionId)
  if (error) fail('Could not assign the intervention', error)

  await addIncidentEvent({
    incidentId,
    eventType: 'action_dispatched',
    actorId,
    note: 'Intervention assigned to a field officer.',
    isPublic: true,
    payload: { action_id: actionId },
  })
}

/**
 * Advance an intervention one step along its operational lifecycle
 * (accepted → in_progress → …). Only ever moves to an OPERATIONAL status — an
 * outcome status can only be reached via `recordImpactEvaluation`, which the DB
 * trigger enforces regardless of what this function does, but this function
 * additionally never offers the option, so the UI cannot even construct the
 * illegal call.
 */
export async function advanceIntervention(
  actionId: number,
  incidentId: number,
  next: ActionWorkflowStatus,
  actorId: string,
  timestampField?: 'accepted_at' | 'started_at' | 'completed_at',
): Promise<void> {
  const patch: Database['public']['Tables']['actions']['Update'] = { workflow_status: next }
  if (timestampField) patch[timestampField] = new Date().toISOString()

  const { error } = await supabase.from('actions').update(patch).eq('id', actionId)
  if (error) fail('Could not update the intervention', error)

  await addIncidentEvent({
    incidentId,
    eventType: next === 'completed' ? 'action_completed' : 'status_changed',
    actorId,
    note: `Intervention status: ${next.replace(/_/g, ' ')}.`,
    isPublic: next === 'completed',
    payload: { action_id: actionId, workflow_status: next },
  })
}

export interface FieldCompletionParams {
  actionId: number
  incidentId: number
  actorId: string
  sourceConfirmed: boolean | null
  actionPerformed: string
  startedAt: string | null
  completedAt: string | null
  photoUrls: string[]
  /** { [checklistItemId]: answer } - short, source-specific, mirrors evidence-mission checklists. */
  checklistResponse: Record<string, unknown>
  lat: number | null
  lng: number | null
  /** Required when the action could not be completed at all. */
  notCompletedReason?: string | null
}

/**
 * Submit a field officer's operational completion (or non-completion) of an
 * intervention. Writes one `action_evidence` row per proof item (GPS,
 * checklist, each photo) rather than a single blob, so each is independently
 * queryable/auditable, matching the shape `action_evidence.evidence_type`
 * already defines.
 *
 * Deliberately does NOT set an outcome or touch impact_evaluations — that is
 * the command workspace's job via `recordImpactEvaluation`, after a real
 * before/after reading exists. Completing the field form only ever reaches
 * 'completed' or 'verification_pending' (still operational), never an outcome
 * state — enforced by the DB trigger regardless, but this function does not
 * even attempt it.
 */
export async function submitFieldCompletion(p: FieldCompletionParams): Promise<void> {
  const wasCompleted = !p.notCompletedReason
  if (!wasCompleted && !p.notCompletedReason?.trim()) {
    throw new Error('Record why the action could not be completed.')
  }

  const patch: Database['public']['Tables']['actions']['Update'] = {
    workflow_status: wasCompleted ? 'completed' : 'in_progress',
    source_confirmed: p.sourceConfirmed,
    started_at: p.startedAt,
    completed_at: wasCompleted ? p.completedAt : null,
    not_completed_reason: p.notCompletedReason ?? null,
  }
  const { error } = await supabase.from('actions').update(patch).eq('id', p.actionId)
  if (error) fail('Could not submit the field completion', error)

  // payload is jsonb (generated type: Json); `as never` matches the cast this
  // file already uses for every other jsonb insert (see addIncidentEvidence).
  const evidenceRows: Database['public']['Tables']['action_evidence']['Insert'][] = []
  if (p.lat != null && p.lng != null) {
    evidenceRows.push({
      action_id: p.actionId,
      evidence_type: 'gps',
      payload: { lat: p.lat, lng: p.lng } as never,
      captured_by: p.actorId,
    })
  }
  evidenceRows.push({
    action_id: p.actionId,
    evidence_type: 'checklist',
    payload: {
      checklist: p.checklistResponse,
      action_performed: p.actionPerformed,
      source_confirmed: p.sourceConfirmed,
    } as never,
    captured_by: p.actorId,
  })
  for (const url of p.photoUrls) {
    evidenceRows.push({
      action_id: p.actionId,
      evidence_type: 'photo',
      photo_url: url,
      payload: { lat: p.lat, lng: p.lng } as never,
      captured_by: p.actorId,
    })
  }
  if (p.startedAt && p.completedAt) {
    evidenceRows.push({
      action_id: p.actionId,
      evidence_type: 'timestamp',
      payload: { started_at: p.startedAt, completed_at: p.completedAt } as never,
      captured_by: p.actorId,
    })
  }
  if (!wasCompleted) {
    evidenceRows.push({
      action_id: p.actionId,
      evidence_type: 'other',
      payload: { not_completed_reason: p.notCompletedReason } as never,
      captured_by: p.actorId,
    })
  }

  const { error: evidErr } = await supabase.from('action_evidence').insert(evidenceRows)
  if (evidErr) fail('Field completion saved, but the evidence record failed', evidErr)

  await addIncidentEvent({
    incidentId: p.incidentId,
    eventType: wasCompleted ? 'action_completed' : 'status_changed',
    actorId: p.actorId,
    note: wasCompleted
      ? 'Field officer recorded the intervention as completed. Pollution impact has not been verified yet.'
      : `Field officer could not complete the intervention: ${p.notCompletedReason}`,
    isPublic: true,
    payload: { action_id: p.actionId, source_confirmed: p.sourceConfirmed, completed: wasCompleted },
  })
}

// ── impact evaluation (Phase 4) ──────────────────────────────────────────────

export interface RecordImpactEvaluationParams {
  incidentId: number
  actionId: number | null
  before: number | null
  after: number | null
  observationWindowHours: number
  stationLabel: string
  /** 0–1. Below 0.5 the outcome is inconclusive regardless of the readings - see incidentRules.MIN_COMPLETENESS_FOR_RESULT. */
  dataCompleteness: number
  notes?: string | null
}

/**
 * Record a before/after impact evaluation.
 *
 * Goes through the `record_impact_evaluation` RPC rather than a client-side
 * insert so the OUTCOME IS COMPUTED SERVER-SIDE from the readings — a client
 * cannot claim "effective" when the numbers do not support it. RLS also
 * restricts the write to commander/admin (verified: a field officer's own call
 * is rejected), which is correct — impact evaluation is a command decision, not
 * an operational one.
 */
export async function recordImpactEvaluation(p: RecordImpactEvaluationParams): Promise<ImpactOutcomeResult> {
  // The generated Args type declares p_action_id/p_before/p_after as plain
  // `number` and p_notes as `string | undefined` — Postgres's own type system
  // doesn't encode per-argument nullability, so gen-types can't infer it. The
  // SQL function genuinely accepts and checks `IS NULL` on p_before/p_after
  // (that's the whole point of the "missing reading -> inconclusive" rule), so
  // this cast reflects the real, tested contract rather than working around it.
  const { data, error } = await supabase.rpc('record_impact_evaluation', {
    p_incident_id: p.incidentId,
    p_action_id: p.actionId,
    p_before: p.before,
    p_after: p.after,
    p_window_hours: p.observationWindowHours,
    p_station: p.stationLabel,
    p_completeness: p.dataCompleteness,
    p_notes: p.notes ?? null,
  } as never)
  if (error) fail('Could not record the impact evaluation', error)
  return data as ImpactOutcomeResult
}

export type ImpactOutcomeResult = 'effective' | 'partly_effective' | 'ineffective' | 'inconclusive'

export async function listImpactEvaluations(incidentId: number): Promise<ImpactEvaluationRow[]> {
  const { data, error } = await supabase
    .from('impact_evaluations')
    .select('*')
    .eq('incident_id', incidentId)
    .order('evaluated_at', { ascending: false })
  if (error) fail('Could not load impact evaluations', error)
  return data ?? []
}

/**
 * Reopen a closed incident after recurrence. `workflow_status: 'reopened'` is
 * NOT in the outcome-state list the DB trigger gates, so this is a plain
 * update — deliberately: reopening is an operational fact ("this recurred"),
 * not itself a new measured outcome (a fresh impact evaluation, recorded
 * separately, is what would establish that).
 */
export async function reopenIncident(incidentId: number, actionId: number | null, actorId: string, note: string): Promise<void> {
  const { error } = await supabase
    .from('incidents')
    .update({ status: 'evidence_gathering', closed_at: null, updated_at: new Date().toISOString() })
    .eq('id', incidentId)
  if (error) fail('Could not reopen the incident', error)

  if (actionId != null) {
    await supabase.from('actions').update({ workflow_status: 'reopened' }).eq('id', actionId)
  }

  await addIncidentEvent({
    incidentId,
    eventType: 'status_changed',
    actorId,
    note: note || 'Problem recurred; incident reopened.',
    isPublic: true,
    payload: { reopened: true, action_id: actionId },
  })
}

/**
 * Close an incident. The DB's closure-guard trigger is the real gate (an
 * incident with a completed/verification_pending action and no impact
 * evaluation is refused) — this function does not pre-check that client-side,
 * so a Postgres error is authoritative and must be surfaced, not swallowed.
 */
export async function closeIncident(incidentId: number, actorId: string, note?: string): Promise<void> {
  await updateIncidentStatus(incidentId, 'closed', actorId, note)
}

// ── citizen action verification (Phase 4) ────────────────────────────────────

/**
 * Record a citizen's confirmation of the action outcome.
 *
 * Goes through `submit_citizen_action_verification`, which checks the caller
 * actually has a report linked to this incident (verified: an unlinked citizen
 * is refused) and records the answer as supporting evidence ONLY — it never
 * sets `impact_evaluations.outcome` or `incidents.source_confidence`. A
 * citizen's confirmation supports the result; it does not establish it
 * (plan §11, §15 — the same rule Phase 3 applied to source verification).
 */
export async function submitCitizenActionVerification(incidentId: number, answer: CitizenActionAnswer): Promise<void> {
  const { error } = await supabase.rpc('submit_citizen_action_verification', {
    p_incident_id: incidentId,
    p_answer: answer,
  })
  if (error) fail('Could not send your answer', error)
}

// ── citizen recurrence reporting (Phase 5.1) ─────────────────────────────────
//
// A citizen linked to a CLOSED incident may report that the problem returned.
// The submit/list functions below go through security-definer RPCs for the
// same reason `submit_citizen_action_verification`/`list_my_citizen_missions`
// do: the ownership check spans `reports` and `incident_recurrence_reports`,
// which a plain RLS policy on the latter cannot express for an INSERT before
// the row exists. Everything below this comment and above the command review
// functions is the citizen's ENTIRE read/write surface for recurrence — no
// function here can reopen an incident or create an enforcement task; those
// are separate, explicit, command-only functions further down.

export interface SubmitRecurrenceReportParams {
  incidentId: number
  recurrenceType: RecurrenceType
  note?: string | null
  lat?: number | null
  lng?: number | null
  photoUrl?: string | null
}

/**
 * Submit (or, if one is already pending from this reporter on this incident,
 * silently return) a recurrence report. Returns the report id.
 */
export async function submitIncidentRecurrenceReport(p: SubmitRecurrenceReportParams): Promise<number> {
  const { data, error } = await supabase.rpc('submit_incident_recurrence_report', {
    p_incident_id: p.incidentId,
    p_recurrence_type: p.recurrenceType,
    p_note: p.note ?? undefined,
    p_lat: p.lat ?? undefined,
    p_lng: p.lng ?? undefined,
    p_photo_url: p.photoUrl ?? undefined,
  })
  if (error) fail('Could not send your recurrence report', error)
  return data as number
}

/** A citizen's own recurrence report, exactly as `list_my_recurrence_reports` returns it. */
export interface CitizenRecurrenceReport {
  report_id: number
  recurrence_type: RecurrenceType
  created_at: string
  review_status: RecurrenceReviewStatus
  public_response: string | null
  outcome_kind: RecurrenceOutcomeKind
}

/** This citizen's own recurrence reports on one incident, newest first. */
export async function fetchMyRecurrenceReports(incidentId: number): Promise<CitizenRecurrenceReport[]> {
  const { data, error } = await supabase.rpc('list_my_recurrence_reports', { p_incident_id: incidentId })
  if (error) fail('Could not load your recurrence reports', error)
  return (data ?? []) as CitizenRecurrenceReport[]
}

// ── command recurrence review (Phase 5.1) ────────────────────────────────────

/**
 * All recurrence reports on one incident, newest first — for the command
 * detail workspace. RLS-gated (commander/admin see all; a field officer sees
 * only their own ward's, via the parent incident); citizens have no direct
 * read here at all (see `fetchMyRecurrenceReports` above).
 */
export async function listRecurrenceReportsForIncident(incidentId: number): Promise<IncidentRecurrenceReportRow[]> {
  const { data, error } = await supabase
    .from('incident_recurrence_reports')
    .select('*')
    .eq('incident_id', incidentId)
    .order('created_at', { ascending: false })
  if (error) fail('Could not load recurrence reports', error)
  return data ?? []
}

/**
 * Pending recurrence report counts for several (closed) incidents at once —
 * one query instead of one per row, mirroring `fetchPlaybookUsageBatch` — for
 * populating `QueueIncident.pending_recurrence_count` in the incident list
 * that feeds the 'recurrence' queue tab.
 */
export async function fetchPendingRecurrenceCounts(incidentIds: number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>()
  if (!incidentIds.length) return counts
  const { data, error } = await supabase
    .from('incident_recurrence_reports')
    .select('incident_id')
    .in('incident_id', incidentIds)
    .eq('review_status', 'pending')
  if (error) fail('Could not load recurrence counts', error)
  for (const row of data ?? []) {
    counts.set(row.incident_id, (counts.get(row.incident_id) ?? 0) + 1)
  }
  return counts
}

async function reviewRecurrenceReport(
  reportId: number,
  incidentId: number,
  reviewStatus: RecurrenceReviewStatus,
  publicResponse: string,
  actorId: string,
  eventType: string,
  extra?: Database['public']['Tables']['incident_recurrence_reports']['Update'],
): Promise<void> {
  const { error } = await supabase
    .from('incident_recurrence_reports')
    .update({
      review_status: reviewStatus,
      public_response: publicResponse,
      reviewed_by: actorId,
      reviewed_at: new Date().toISOString(),
      ...extra,
    })
    .eq('id', reportId)
  if (error) fail('Could not save the recurrence review decision', error)

  await addIncidentEvent({
    incidentId,
    eventType,
    actorId,
    note: publicResponse,
    isPublic: true,
    payload: { recurrence_report_id: reportId, review_status: reviewStatus },
  })
}

/** Dismiss a recurrence report as unverified. `publicResponse` must be a public-safe reason. */
export async function dismissRecurrenceReport(
  reportId: number,
  incidentId: number,
  publicResponse: string,
  actorId: string,
): Promise<void> {
  await reviewRecurrenceReport(reportId, incidentId, 'dismissed', publicResponse, actorId, 'recurrence_dismissed')
}

/** Ask the citizen for more evidence before a decision is made. */
export async function requestMoreEvidenceForRecurrence(
  reportId: number,
  incidentId: number,
  publicResponse: string,
  actorId: string,
): Promise<void> {
  await reviewRecurrenceReport(
    reportId,
    incidentId,
    'more_evidence_requested',
    publicResponse,
    actorId,
    'recurrence_more_evidence_requested',
  )
}

/**
 * Confirm the recurrence is real, without (yet) choosing reopen / new incident
 * / merge — the standalone "we agree this happened" step. Use
 * `reopenIncidentFromRecurrence`, `createLinkedIncidentFromRecurrence`, or
 * `mergeRecurrenceIntoIncident` for the follow-on disposition.
 */
export async function confirmRecurrenceReport(
  reportId: number,
  incidentId: number,
  publicResponse: string,
  actorId: string,
): Promise<void> {
  await reviewRecurrenceReport(reportId, incidentId, 'confirmed', publicResponse, actorId, 'recurrence_confirmed')
}

/**
 * Confirm the recurrence AND reopen the original incident. Reuses
 * `reopenIncident` (unchanged) for the incident-side effect, then marks the
 * report confirmed — a citizen checking `fetchMyRecurrenceReports` afterward
 * sees `outcome_kind: 'reopened'` because the incident's own status has moved
 * off 'closed' (see `list_my_recurrence_reports`'s own comment).
 */
export async function reopenIncidentFromRecurrence(
  reportId: number,
  incidentId: number,
  actorId: string,
  publicResponse: string,
): Promise<void> {
  await reopenIncident(incidentId, null, actorId, publicResponse)
  await reviewRecurrenceReport(reportId, incidentId, 'confirmed', publicResponse, actorId, 'recurrence_reopened_incident')
}

/**
 * Confirm the recurrence and create a NEW incident linked back to the
 * original — for a substantial time gap, a different-looking source, or a
 * materially changed location (plan §5). Sets both traceability columns:
 * the new incident's `recurrence_of_incident_id` (via `createIncident`) and
 * this report's own `resulting_incident_id`.
 */
export async function createLinkedIncidentFromRecurrence(
  reportId: number,
  originalIncidentId: number,
  wardId: number,
  actorId: string,
  summary: string,
): Promise<number> {
  const newIncidentId = await createIncident({
    wardId,
    detectionMethod: 'citizen_recurrence_report',
    summary,
    createdBy: actorId,
    recurrenceOfIncidentId: originalIncidentId,
  })

  const publicResponse = 'Confirmed - a new incident has been opened to track this.'
  await reviewRecurrenceReport(
    reportId,
    originalIncidentId,
    'confirmed',
    publicResponse,
    actorId,
    'recurrence_new_incident_created',
    { resulting_incident_id: newIncidentId },
  )
  return newIncidentId
}

/**
 * Confirm the recurrence and merge it into an already-open NEARBY incident,
 * rather than reopening the original or creating a new one. Attaches the
 * report's own evidence (note/photo/location) to the target incident as a
 * `recurrence_report`-typed evidence row, so the target incident's evidence
 * panel shows why it grew — the new evidence_type value this migration adds.
 */
export async function mergeRecurrenceIntoIncident(
  reportId: number,
  originalIncidentId: number,
  targetIncidentId: number,
  reportNote: string | null,
  reportPhotoUrl: string | null,
  reportLat: number | null,
  reportLng: number | null,
  actorId: string,
): Promise<void> {
  await addIncidentEvidence({
    incidentId: targetIncidentId,
    evidenceType: 'recurrence_report',
    supports: true,
    reportId: null,
    payload: { note: reportNote, photo_url: reportPhotoUrl, lat: reportLat, lng: reportLng, source_report_id: reportId },
    collectedBy: actorId,
  })

  const publicResponse = 'Confirmed - linked to an incident already being tracked nearby.'
  await reviewRecurrenceReport(
    reportId,
    originalIncidentId,
    'confirmed',
    publicResponse,
    actorId,
    'recurrence_merged',
    { resulting_incident_id: targetIncidentId },
  )
}

// ── automated anomaly detection (Phase 6) ────────────────────────────────────
//
// The rule engine itself (thresholds, persistence, local excess, dedup, the
// data-quality gate) lives entirely in `evaluate_station_pollutant_anomaly` /
// `run_anomaly_detection` (SQL) — this section is I/O only: reading what the
// engine already computed and stored, plus the command review actions on a
// predicted/detected incident. "Request evidence" is deliberately NOT
// duplicated here — it reuses the existing `createEvidenceMission` above
// unchanged; a predicted incident is just an incident, and every Phase 3
// evidence-mission (including the citizen-safe `citizen_verification` type)
// already works on it with zero special-casing.

/** All anomaly candidates linked to one incident, newest first — the
 *  detection history for the command review panel. */
export async function listAnomalyCandidatesForIncident(incidentId: number): Promise<AnomalyCandidateRow[]> {
  const { data, error } = await supabase
    .from('anomaly_candidates')
    .select('*')
    .eq('incident_id', incidentId)
    .order('detected_at', { ascending: false })
  if (error) fail('Could not load anomaly candidates', error)
  return data ?? []
}

/** Every monitoring station in a ward — for the "nearby monitoring stations"
 *  display (plan §7). RLS-open (`stations_read`: any authenticated), same as
 *  every other reference-data table this app already reads broadly. */
export async function listStationsForWard(wardId: number): Promise<StationRow[]> {
  const { data, error } = await supabase.from('stations').select('*').eq('ward_id', wardId)
  if (error) fail('Could not load monitoring stations', error)
  return data ?? []
}

/**
 * Manually trigger a detection pass — the same `run_anomaly_detection` RPC
 * the ingest cron calls on schedule. Commander/admin only (enforced in SQL);
 * exists so a command session can run detection on demand rather than only
 * waiting for the next cron tick (useful for verification, not required for
 * the automated path to work).
 */
export async function runAnomalyDetectionNow(cityCode?: string): Promise<number> {
  const { data, error } = await supabase.rpc('run_anomaly_detection', { p_city_code: cityCode ?? undefined })
  if (error) fail('Could not run anomaly detection', error)
  return (data ?? []).length
}

/**
 * Command confirms a predicted/detected incident as a real, actionable
 * pollution event ("promote to active incident", plan §7). A plain metadata
 * transition — `detection_stage` moving to 'confirmed' — not a workflow
 * change; the incident is already fully workable at any detection_stage.
 * Never creates an enforcement task by itself (plan's own explicit rule):
 * this function does not touch `actions` at all.
 */
export async function confirmPredictedIncident(incidentId: number, actorId: string): Promise<void> {
  const { error } = await supabase
    .from('incidents')
    .update({ detection_stage: 'confirmed', updated_at: new Date().toISOString() })
    .eq('id', incidentId)
  if (error) fail('Could not confirm this incident', error)

  await addIncidentEvent({
    incidentId,
    eventType: 'promoted_to_active',
    actorId,
    note: 'Confirmed by command as a genuine pollution event.',
    isPublic: true,
    payload: { detection_stage: 'confirmed' },
  })
}

/**
 * "Continue monitoring" — logs the reviewer's decision to defer without
 * changing anything. The detection engine will keep re-evaluating this
 * ward/pollutant on its own schedule regardless; this is purely an audit
 * record that a human looked at it and chose to wait.
 */
export async function continueMonitoringPredictedIncident(
  incidentId: number,
  actorId: string,
  note?: string,
): Promise<void> {
  await addIncidentEvent({
    incidentId,
    eventType: 'predicted_incident_reviewed',
    actorId,
    note: note?.trim() || 'Reviewed - continuing to monitor before deciding.',
    isPublic: false,
    payload: { decision: 'continue_monitoring' },
  })
}

/**
 * Dismiss a predicted/detected incident as a data anomaly (sensor fault,
 * transient spike) rather than a real pollution event. Closes the incident;
 * `reason` is shown to command and kept free of internal signal detail by
 * the caller (no sensor ids, thresholds, or confidence scores), matching
 * the public-safe-reason convention used for recurrence dismissal.
 */
export async function dismissPredictedIncident(incidentId: number, actorId: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from('incidents')
    .update({ status: 'closed', closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', incidentId)
  if (error) fail('Could not dismiss this incident', error)

  await addIncidentEvent({
    incidentId,
    eventType: 'predicted_incident_dismissed',
    actorId,
    note: reason.trim() || 'Reviewed and closed: determined to be a data anomaly, not a confirmed pollution event.',
    isPublic: true,
    payload: { decision: 'dismissed' },
  })
}

/**
 * Merge a predicted/detected incident into an already-open nearby incident
 * (plan §7) — mirrors `mergeRecurrenceIntoIncident`'s shape exactly: attach
 * this incident's own anomaly evidence to the target, close this one, and
 * record the traceability link both ways (`merged_into_incident_id` here;
 * the target simply gains a corroborating `incident_evidence` row).
 */
export async function mergePredictedIncident(
  sourceIncidentId: number,
  targetIncidentId: number,
  actorId: string,
): Promise<void> {
  const candidates = await listAnomalyCandidatesForIncident(sourceIncidentId)
  const latest = candidates[0]

  await addIncidentEvidence({
    incidentId: targetIncidentId,
    evidenceType: 'sensor',
    supports: true,
    payload: {
      source_incident_id: sourceIncidentId,
      pollutant: latest?.pollutant ?? null,
      concentration: latest?.current_concentration ?? null,
    },
    collectedBy: actorId,
  })

  const { error } = await supabase
    .from('incidents')
    .update({
      status: 'closed',
      closed_at: new Date().toISOString(),
      merged_into_incident_id: targetIncidentId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sourceIncidentId)
  if (error) fail('Could not merge this incident', error)

  await addIncidentEvent({
    incidentId: sourceIncidentId,
    eventType: 'predicted_incident_merged',
    actorId,
    note: `Merged into incident #${targetIncidentId}.`,
    isPublic: true,
    payload: { merged_into_incident_id: targetIncidentId },
  })
  await addIncidentEvent({
    incidentId: targetIncidentId,
    eventType: 'evidence_added',
    actorId,
    note: `Monitoring data from incident #${sourceIncidentId} merged into this incident.`,
    isPublic: true,
    payload: { source_incident_id: sourceIncidentId },
  })
}

// ── probable-source attribution (Phase 7) ────────────────────────────────────
//
// The scoring engine itself lives entirely in
// `calculate_incident_source_attribution` / `run_incident_source_attribution`
// (SQL) — this file only calls it and reads/reviews its output, exactly like
// `evaluate_station_pollutant_anomaly` in Phase 6.

export interface ResponsibleAuthority {
  source_category: SourceCategory
  owner_name: string | null
  regulating_authority: string | null
  asset_description: string | null
  escalation_contact: string | null
  is_disputed: boolean | null
  match_basis: string
  routing_confidence: number
  note: string | null
}

/**
 * The current source-hypothesis set for one incident (`is_current = true`
 * only) — the versioned calculation HISTORY (older, superseded rows) is kept
 * in the same table for audit purposes but is not shown by default; this is
 * what every command-facing surface should read.
 */
export async function listCurrentSourceHypotheses(incidentId: number): Promise<SourceHypothesisRow[]> {
  const { data, error } = await supabase
    .from('incident_source_hypotheses')
    .select('*')
    .eq('incident_id', incidentId)
    .eq('is_current', true)
    .order('probability', { ascending: false })
  if (error) fail('Could not load source hypotheses', error)
  return data ?? []
}

/**
 * Probable responsible authority for the incident's top LOCAL hypothesis
 * (plan §9). Never dispatches anything — read-only. Relies entirely on the
 * caller's own RLS (the RPC is not security-definer): a citizen calling this
 * gets zero rows, the same as querying `incident_source_hypotheses` or
 * `responsibility_registry` directly.
 */
export async function getIncidentResponsibleAuthority(incidentId: number): Promise<ResponsibleAuthority | null> {
  const { data, error } = await supabase.rpc('get_incident_responsible_authority', { p_incident_id: incidentId })
  if (error) fail('Could not load responsibility routing', error)
  return (data?.[0] as ResponsibleAuthority | undefined) ?? null
}

/**
 * Recalculate source attribution for one incident right now. `force` bypasses
 * the city's configured recalculation interval (used by the command "request
 * recalculation" action) — without it, a repeat call within that interval is
 * a safe no-op (the RPC itself decides, not this wrapper).
 */
export async function recalculateSourceAttribution(incidentId: number, force = true): Promise<void> {
  const { error } = await supabase.rpc('calculate_incident_source_attribution', {
    p_incident_id: incidentId,
    p_force: force,
  })
  if (error) fail('Could not recalculate source attribution', error)
}

/** Batch recalculation for every open incident in a city (or every active
 *  city when omitted) — the same RPC the ingest cron calls on schedule. */
export async function runIncidentSourceAttribution(cityCode?: string, force = false): Promise<number> {
  const { data, error } = await supabase.rpc('run_incident_source_attribution', {
    p_city_code: cityCode,
    p_force: force,
  })
  if (error) fail('Could not run source attribution', error)
  return (data ?? []).length
}

export type HypothesisReviewAction = 'confirmed_corroborated' | 'marked_unresolved' | 'rejected'

/**
 * A command reviewer's own disposition on ONE hypothesis (plan §10: "confirm
 * as corroborated / mark unresolved / reject a hypothesis with reason").
 * RLS already restricts this write to commander/admin — this is a guided
 * path onto a capability RLS already grants them directly, same as every
 * other command-only update in this file (e.g. `updateSourceConfidence`).
 *
 * `confirmed_corroborated` also raises the hypothesis's own
 * `confidence_level` from `suspected` to `corroborated` — but ONLY in that
 * direction, and never touches an `officially_verified` row (that can only
 * come from an authorised field confirmation, unchanged from Phase 3).
 */
export async function reviewSourceHypothesis(
  hypothesisId: number,
  action: HypothesisReviewAction,
  actorId: string,
  note?: string | null,
): Promise<void> {
  if (action === 'rejected' && !note?.trim()) {
    throw new Error('Rejecting a hypothesis requires a reason.')
  }

  const { data: existing, error: readErr } = await supabase
    .from('incident_source_hypotheses')
    .select('incident_id, source_category, confidence_level')
    .eq('id', hypothesisId)
    .maybeSingle()
  if (readErr) fail('Could not load this hypothesis', readErr)
  if (!existing) throw new Error('This hypothesis no longer exists.')

  const values: Database['public']['Tables']['incident_source_hypotheses']['Update'] = {
    review_status: action,
    reviewed_by: actorId,
    reviewed_at: new Date().toISOString(),
    review_note: note ?? null,
  }
  if (action === 'confirmed_corroborated' && existing.confidence_level === 'suspected') {
    values.confidence_level = 'corroborated'
  }

  const { error } = await supabase.from('incident_source_hypotheses').update(values).eq('id', hypothesisId)
  if (error) fail('Could not record this review', error)

  await addIncidentEvent({
    incidentId: existing.incident_id,
    eventType: 'hypothesis_updated',
    actorId,
    note: `${sourceCategoryLabel(existing.source_category)} hypothesis ${HYPOTHESIS_REVIEW_ACTION_NOTE[action]}${note ? `: ${note}` : '.'}`,
    isPublic: false,
    payload: { hypothesis_id: hypothesisId, review_status: action },
  })
}

const HYPOTHESIS_REVIEW_ACTION_NOTE: Record<HypothesisReviewAction, string> = {
  confirmed_corroborated: 'confirmed as corroborated by command',
  marked_unresolved: 'marked unresolved by command',
  rejected: 'rejected by command',
}

// ── unified forecasting (Phase 8) ────────────────────────────────────────────
//
// Read-only from the web app's side: every forecast is produced and
// validated entirely by `ingest/app/forecast.py`, which writes one
// `forecast_runs` row (the validation record) plus up to 48 `forecasts`
// rows (the curve itself) per ward+pollutant generation. Nothing here
// computes or re-derives a prediction — see incidentRules.ts's own note on
// why that logic can't and shouldn't live in this file either.

/** One point on a multi-pollutant forecast curve — the generic counterpart
 *  to `data.ts`'s pm25-only `ForecastPoint`, carrying the Phase 8 columns
 *  (`predicted_value`/uncertainty bounds/run linkage) that apply to any of
 *  the six pollutants, not just pm25. */
export interface ForecastCurvePoint {
  horizon_ts: string
  predicted_value: number | null
  lower_bound: number | null
  upper_bound: number | null
  baseline_pred: number | null
  local_excess: number | null
  confidence: number | null
  model_version: string | null
  forecast_run_id: number | null
}

/** The current (most recent) forecast curve for one ward+pollutant, in
 *  horizon order — the "forecast curve" plan §8 asks the UI to show. */
export async function fetchForecastCurve(wardId: number, pollutant: string): Promise<ForecastCurvePoint[]> {
  const { data, error } = await supabase
    .from('forecasts')
    .select('horizon_ts, predicted_value, lower_bound, upper_bound, baseline_pred, local_excess, confidence, model_version, forecast_run_id')
    .eq('ward_id', wardId)
    .eq('pollutant', pollutant)
    .order('horizon_ts')
    .limit(48)
  if (error) fail('Could not load the forecast curve', error)
  return data ?? []
}

/** The most recent validation record for one ward+pollutant — model
 *  accuracy, training period, data-quality status, per-horizon metrics
 *  (plan §5/§8). Read directly rather than via a batched-by-incident path:
 *  a forecast run belongs to a ward+pollutant, not to any one incident. */
export async function fetchLatestForecastRun(wardId: number, pollutant: string): Promise<ForecastRunRow | null> {
  const { data, error } = await supabase
    .from('forecast_runs')
    .select('*')
    .eq('ward_id', wardId)
    .eq('pollutant', pollutant)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) fail('Could not load the forecast validation record', error)
  return data ?? null
}

// ── authority routing and operational dispatch (Phase 9) ────────────────────
//
// Every write here calls a SECURITY DEFINER Postgres function
// (dispatch_intervention_task / transition_task_dispatch / ...) — there is no
// authenticated write policy on task_dispatches/notifications at all, so a
// direct .from('task_dispatches').update(...) would silently affect 0 rows.
// See supabase/migrations/20260724000000_authority_routing_and_dispatch.sql.

export interface TaskRoutingPreview {
  registry_id: number | null
  routing_confidence: RoutingConfidenceLevel
  routing_evidence: Record<string, unknown> | null
  physical_location: string | null
  asset_description: string | null
  responsible_agency: string | null
  division_zone: string | null
  primary_officer: string | null
  primary_team: string | null
  backup_agency: string | null
  backup_team: string | null
}

/** Read-only routing preview BEFORE committing to a dispatch (plan §10's
 *  command review flow) — calls the same matching logic dispatch_intervention_task
 *  itself uses, so the preview a commander sees is never a different answer. */
export async function previewTaskRouting(actionId: number): Promise<TaskRoutingPreview | null> {
  const { data, error } = await supabase.rpc('preview_task_routing', { p_action_id: actionId })
  if (error) fail('Could not preview routing', error)
  return (data?.[0] as TaskRoutingPreview | undefined) ?? null
}

/** Create or update the current dispatch for an approved intervention (plan
 *  §1/§5). Idempotent — calling this again for the same action re-resolves
 *  routing/approval rather than creating a duplicate row. */
export async function dispatchInterventionTask(actionId: number, actorId: string): Promise<number> {
  const { data, error } = await supabase.rpc('dispatch_intervention_task', {
    p_action_id: actionId,
    p_actor_id: actorId,
  })
  if (error) fail('Could not dispatch this intervention', error)
  return data as number
}

/** Move a task through its lifecycle (plan §4). The DB enforces the valid
 *  transition table and mandatory-reason rule server-side —
 *  `canTransitionTaskDispatch`/`taskDispatchRequiresReason` in incidentRules.ts
 *  exist only to grey out an illegal action in the UI before the user tries it. */
export async function transitionTaskDispatch(
  dispatchId: number,
  newStatus: TaskDispatchStatus,
  actorId: string,
  reason?: string,
): Promise<void> {
  const { error } = await supabase.rpc('transition_task_dispatch', {
    p_dispatch_id: dispatchId,
    p_new_status: newStatus,
    p_actor_id: actorId,
    p_reason: reason,
  })
  if (error) fail('Could not update this task', error)
}

/** Field officer reports equipment/team/officer unavailability (plan §9) —
 *  never invents availability, only records what was actually reported. */
export async function reportTaskResourceUnavailable(dispatchId: number, actorId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('report_resource_unavailable', {
    p_dispatch_id: dispatchId,
    p_actor_id: actorId,
    p_note: note,
  })
  if (error) fail('Could not report resource unavailability', error)
}

/** Field officer REQUESTS a reroute (plan §11) — command still decides;
 *  this flags the request for review rather than changing status directly. */
export async function requestTaskReroute(dispatchId: number, actorId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('request_task_reroute', {
    p_dispatch_id: dispatchId,
    p_actor_id: actorId,
    p_reason: reason,
  })
  if (error) fail('Could not request a reroute', error)
}

/** Command resolves a disputed-jurisdiction case by picking a registry row
 *  and recording why (plan §10). */
export async function resolveJurisdictionDispute(
  dispatchId: number,
  actorId: string,
  registryId: number,
  note: string,
): Promise<void> {
  const { error } = await supabase.rpc('resolve_jurisdiction_dispute', {
    p_dispatch_id: dispatchId,
    p_actor_id: actorId,
    p_registry_id: registryId,
    p_note: note,
  })
  if (error) fail('Could not resolve the jurisdiction dispute', error)
}

/** Manually run the SLA/escalation batch driver — the same
 *  `escalate_stale_task_dispatches` RPC the ingest cron calls on a 5-minute
 *  schedule (ingest/app/dispatch.py). Exists so command can escalate on
 *  demand rather than only waiting for the next tick. */
export async function escalateStaleTaskDispatchesNow(cityCode?: string): Promise<number> {
  const { data, error } = await supabase.rpc('escalate_stale_task_dispatches', { p_city_code: cityCode ?? undefined })
  if (error) fail('Could not run escalation', error)
  return (data ?? []).length
}

/** The current dispatch for one action, if any — the Operations panel's
 *  per-action detail view. */
export async function getTaskDispatchForAction(actionId: number): Promise<TaskDispatchRow | null> {
  const { data, error } = await supabase
    .from('task_dispatches')
    .select('*')
    .eq('action_id', actionId)
    .eq('is_current', true)
    .maybeSingle()
  if (error) fail('Could not load the task dispatch', error)
  return data ?? null
}

/** Every current dispatch tied to an incident — the Operations panel's
 *  incident-level view (an incident can have several actions, each with its
 *  own dispatch). */
export async function listTaskDispatchesForIncident(incidentId: number): Promise<TaskDispatchRow[]> {
  const { data, error } = await supabase
    .from('task_dispatches')
    .select('*')
    .eq('incident_id', incidentId)
    .eq('is_current', true)
    .order('created_at', { ascending: false })
  if (error) fail('Could not load task dispatches', error)
  return data ?? []
}

/** Every current dispatch assigned to the calling field officer (plan §11) —
 *  RLS scopes this to `primary_officer = auth.uid()` OR the officer's own
 *  ward, so this is safe to call with no server-side filter beyond status. */
export async function listMyTaskDispatches(): Promise<TaskDispatchRow[]> {
  const { data, error } = await supabase
    .from('task_dispatches')
    .select('*')
    .eq('is_current', true)
    .not('status', 'in', '(completed,verification_pending,cancelled,rejected)')
    .order('sla_ack_due_at', { ascending: true, nullsFirst: false })
    .limit(100) // one officer's active work — a bound, not an expected ceiling
  if (error) fail('Could not load your tasks', error)
  return data ?? []
}

export interface ActiveTaskDispatch extends TaskDispatchRow {
  incident_summary: string | null
  ward_name: string | null
}

const ACTIVE_DISPATCH_SELECT = '*, incidents(summary, wards(name))'

function shapeActiveDispatch(
  row: TaskDispatchRow & { incidents?: { summary: string | null; wards?: { name: string } | { name: string }[] | null } | null },
): ActiveTaskDispatch {
  const incident = row.incidents
  const ward = incident?.wards
  const { incidents: _incidents, ...rest } = row
  return {
    ...rest,
    incident_summary: incident?.summary ?? null,
    ward_name: Array.isArray(ward) ? (ward[0]?.name ?? null) : (ward?.name ?? null),
  }
}

/** Every current, still-open dispatch city-wide — the commander's view across
 *  every ward, distinct from listMyTaskDispatches (one officer's own queue,
 *  no incident/ward join since that page never needed it). RLS already
 *  returns every row unconditionally for commander/admin (task_dispatches_read),
 *  so this needs no server-side ward filter. */
export interface ActiveTaskDispatchesPage {
  rows: ActiveTaskDispatch[]
  totalCount: number
  hasMore: boolean
}

/** Offset-based, same trade-off/reasoning as listClosedIncidents above.
 *  Note: the status/ward filter options TasksView.tsx builds from this
 *  page's rows only reflect what's currently loaded — a status/ward that
 *  only exists on a later page won't yet appear as a filter option. */
export async function listActiveTaskDispatches(opts: { offset: number; pageSize?: number }): Promise<ActiveTaskDispatchesPage> {
  const pageSize = opts.pageSize ?? 100
  const { data, error, count } = await supabase
    .from('task_dispatches')
    .select(ACTIVE_DISPATCH_SELECT, { count: 'exact' })
    .eq('is_current', true)
    .not('status', 'in', '(completed,verification_pending,cancelled,rejected)')
    .order('sla_ack_due_at', { ascending: true, nullsFirst: false })
    .range(opts.offset, opts.offset + pageSize - 1)
  if (error) fail('Could not load active dispatches', error)
  const rows = (data ?? []).map((r) => shapeActiveDispatch(r as never))
  const totalCount = count ?? rows.length
  return { rows, totalCount, hasMore: opts.offset + rows.length < totalCount }
}

/** Notifications queued/sent for one dispatch — the Operations panel's
 *  delivery-status detail (plan §10: "delivery status, acknowledgement status"). */
export async function listNotificationsForDispatch(dispatchId: number): Promise<NotificationRow[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('task_dispatch_id', dispatchId)
    .order('created_at', { ascending: false })
  if (error) fail('Could not load notifications', error)
  return data ?? []
}

/** Active responsibility_registry rows for a city — used to populate the
 *  "select backup agency" / dispute-resolution pickers in the Operations
 *  panel (plan §10). */
export async function listResponsibilityRegistryForCity(cityId: number): Promise<ResponsibilityRegistryRow[]> {
  const { data, error } = await supabase
    .from('responsibility_registry')
    .select('*')
    .eq('city_id', cityId)
    .eq('is_active', true)
    .order('regulating_authority')
  if (error) fail('Could not load the responsibility registry', error)
  return data ?? []
}
