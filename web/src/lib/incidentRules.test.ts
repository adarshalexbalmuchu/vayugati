import { describe, expect, it } from 'vitest'
import {
  CORROBORATION_RULE,
  DETECTION_STAGE_LABEL,
  ESCALATION_SLA_HOURS,
  HAZARDOUS_FOR_CITIZENS,
  MIN_COMPLETENESS_FOR_RESULT,
  OPERATIONAL_STATUSES,
  OUTCOME_STATUSES,
  PLAYBOOK_COST_CEILING,
  POLLUTANT_LABEL,
  POLLUTANTS,
  RECURRENCE_SAME_LOCATION_RADIUS_M,
  RECURRENCE_SOON_AFTER_CLOSURE_HOURS,
  RECURRENCE_SUBSTANTIAL_GAP_HOURS,
  allowedTaskKinds,
  canCreateTask,
  checklistFor,
  citizenActionVerificationSafety,
  citizenRecurrenceStatusLabel,
  citizenVerificationSafety,
  currentReading,
  customActionClassificationBlockedReason,
  describeAnomalyDetectionRule,
  describeTriggeredRule,
  evidenceLevelAfterFieldOutcome,
  forecastFallbackStatus,
  FORECAST_DATA_QUALITY_LABEL,
  FORECAST_DISCLAIMER,
  FORECAST_HORIZONS_HOURS,
  FORECAST_METHOD_LABEL,
  haversineMeters,
  inQueue,
  incidentStatusAfterFieldOutcome,
  interventionRequiresApproval,
  isActionLockedByApproval,
  isCustomActionTypeAllowedForClassification,
  isEnforcementType,
  isEscalated,
  isHorizonValidated,
  isHumanConfirmedClassification,
  isMetaSourceCategory,
  isOpen,
  isOperationalStatus,
  isOutcomeStatus,
  isPlaybookEligible,
  isPredicted,
  meetsEvidenceLevel,
  needsMoreAttributionEvidence,
  nextOperationalStatus,
  parseChecklistSnapshot,
  playbookRequiresApproval,
  PREDICTION_METHOD_LABEL,
  previewImpactOutcome,
  rankPlaybooks,
  recommendRecurrenceDecision,
  requiresHumanApproval,
  scorePlaybook,
  sensorQualityCaveat,
  severityFromLocalExcess,
  sourceCategoryLabel,
  tallyPlaybookUsage,
  taskBlockedReason,
  type PlaybookLike,
  type PlaybookRankingContext,
  type QueueIncident,
  type RecurrenceDecisionContext,
  canTransitionTaskDispatch,
  DISPATCH_APPROVAL_REQUIRED_TYPES,
  dispatchRequiresApprovalByDefault,
  minutesUntil,
  NOTIFICATION_CHANNEL_LABEL,
  NOTIFICATION_STATUS_LABEL,
  publicTaskStatusLabel,
  ROUTING_CONFIDENCE_LABEL,
  routingBlocksAutoDispatch,
  slaCountdownLabel,
  SLA_CHECKPOINT_LABEL,
  TASK_DISPATCH_STATUS_LABEL,
  taskDispatchRequiresReason,
  cleanMissionRationale,
  collapseRepeatedTimelineEvents,
  dispatchEmptyStateMessage,
  groupDuplicateMissions,
  missionRationaleIsAutomated,
  parseDataQualityNote,
  resolveIncidentPollutant,
} from './incidentRules'

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

const incident = (over: Partial<QueueIncident> = {}): QueueIncident => ({
  status: 'detected',
  detection_method: 'citizen_report_cluster',
  detected_at: hoursAgo(1),
  assigned_authority: null,
  ...over,
})

describe('severityFromLocalExcess', () => {
  it('maps excess to the documented bands', () => {
    expect(severityFromLocalExcess(150)).toBe('severe')
    expect(severityFromLocalExcess(100)).toBe('severe')
    expect(severityFromLocalExcess(99)).toBe('high')
    expect(severityFromLocalExcess(50)).toBe('high')
    expect(severityFromLocalExcess(20)).toBe('moderate')
    expect(severityFromLocalExcess(19)).toBe('low')
    expect(severityFromLocalExcess(0)).toBe('low')
  })

  it('returns null for unknown excess rather than defaulting to low', () => {
    // Regression guard: an incident with no forecast must read "unavailable".
    // Defaulting to 'low' would silently understate a real incident.
    expect(severityFromLocalExcess(null)).toBeNull()
    expect(severityFromLocalExcess(undefined)).toBeNull()
    expect(severityFromLocalExcess(NaN)).toBeNull()
  })

  it('treats negative excess (cleaner than baseline) as low, not null', () => {
    expect(severityFromLocalExcess(-10)).toBe('low')
  })
})

describe('evidence-level task rules (plan §9)', () => {
  it('lets a suspected source create evidence tasks only', () => {
    expect(allowedTaskKinds('suspected')).toEqual(['evidence'])
    expect(canCreateTask('suspected', 'evidence')).toBe(true)
    expect(canCreateTask('suspected', 'inspection')).toBe(false)
    expect(canCreateTask('suspected', 'preventive')).toBe(false)
    expect(canCreateTask('suspected', 'enforcement')).toBe(false)
  })

  it('lets a corroborated source create inspection and preventive tasks but not enforcement', () => {
    expect(canCreateTask('corroborated', 'inspection')).toBe(true)
    expect(canCreateTask('corroborated', 'preventive')).toBe(true)
    expect(canCreateTask('corroborated', 'enforcement')).toBe(false)
  })

  it('lets an officially verified source reach enforcement', () => {
    expect(canCreateTask('officially_verified', 'enforcement')).toBe(true)
  })

  it('explains why a blocked task is blocked', () => {
    expect(taskBlockedReason('suspected', 'inspection')).toMatch(/collect evidence first/i)
    expect(taskBlockedReason('corroborated', 'enforcement')).toMatch(/officially verified/i)
    expect(taskBlockedReason('corroborated', 'inspection')).toBeNull()
  })

  it('always requires a human approver for every enforcement type', () => {
    // There must be no automation path to a penalty (plan §14).
    for (const t of ['penalty', 'stop_work', 'closure', 'restriction', 'prosecution']) {
      expect(isEnforcementType(t)).toBe(true)
      expect(requiresHumanApproval(t)).toBe(true)
    }
    expect(requiresHumanApproval('inspect')).toBe(false)
    expect(isEnforcementType('inspect')).toBe(false)
  })
})

describe('queue filters', () => {
  it('treats every non-closed status as open', () => {
    expect(isOpen(incident({ status: 'detected' }))).toBe(true)
    expect(isOpen(incident({ status: 'verifying' }))).toBe(true)
    expect(isOpen(incident({ status: 'closed' }))).toBe(false)
  })

  it('identifies predicted incidents from detection_method when detection_stage is absent (pre-Phase-6 fallback)', () => {
    expect(isPredicted(incident({ detection_method: 'forecast_local_excess' }))).toBe(true)
    expect(isPredicted(incident({ detection_method: 'citizen_report_cluster' }))).toBe(false)
  })

  it('prefers detection_stage over the detection_method heuristic once it is set (Phase 6)', () => {
    expect(isPredicted(incident({ detection_method: 'anomaly_trend_projection', detection_stage: 'predicted' }))).toBe(true)
    expect(isPredicted(incident({ detection_method: 'anomaly_persistence_threshold', detection_stage: 'detected' }))).toBe(false)
    expect(isPredicted(incident({ detection_method: 'anomaly_persistence_threshold', detection_stage: 'confirmed' }))).toBe(false)
    // even a detection_method that WOULD match the old heuristic is overridden
    // once detection_stage is explicitly set to something other than 'predicted'
    expect(isPredicted(incident({ detection_method: 'forecast_stale_leftover', detection_stage: 'detected' }))).toBe(false)
  })

  it('escalates an open incident older than the SLA with nothing dispatched', () => {
    expect(isEscalated(incident({ detected_at: hoursAgo(ESCALATION_SLA_HOURS + 1) }))).toBe(true)
    expect(isEscalated(incident({ detected_at: hoursAgo(ESCALATION_SLA_HOURS - 1) }))).toBe(false)
  })

  it('does not escalate an old incident that has been dispatched', () => {
    // Age alone is not a breach — work is underway.
    expect(
      isEscalated(incident({ detected_at: hoursAgo(100), status: 'action_dispatched' })),
    ).toBe(false)
    expect(isEscalated(incident({ detected_at: hoursAgo(100), status: 'in_progress' }))).toBe(false)
  })

  it('never escalates a closed incident however old', () => {
    expect(isEscalated(incident({ detected_at: hoursAgo(1000), status: 'closed' }))).toBe(false)
  })

  it('routes incidents to the expected queues', () => {
    expect(inQueue(incident(), 'active')).toBe(true)
    expect(inQueue(incident(), 'closed')).toBe(false)
    expect(inQueue(incident({ status: 'closed' }), 'closed')).toBe(true)
    expect(inQueue(incident({ status: 'evidence_gathering' }), 'verification')).toBe(true)
    expect(inQueue(incident({ status: 'verifying' }), 'verification')).toBe(true)
    expect(inQueue(incident({ assigned_authority: 'MCD' }), 'assigned')).toBe(true)
    expect(inQueue(incident({ status: 'routed' }), 'assigned')).toBe(true)
    expect(inQueue(incident(), 'assigned')).toBe(false)
  })

  it('keeps a closed incident out of the assigned queue even when it has an authority', () => {
    expect(inQueue(incident({ status: 'closed', assigned_authority: 'MCD' }), 'assigned')).toBe(false)
  })

  it('puts a closed incident in the recurrence queue only when it has pending recurrence reports', () => {
    expect(inQueue(incident({ status: 'closed', pending_recurrence_count: 1 }), 'recurrence')).toBe(true)
    expect(inQueue(incident({ status: 'closed', pending_recurrence_count: 0 }), 'recurrence')).toBe(false)
    expect(inQueue(incident({ status: 'closed' }), 'recurrence')).toBe(false)
    expect(inQueue(incident({ status: 'detected', pending_recurrence_count: 1 }), 'recurrence')).toBe(false)
  })
})

describe('currentReading', () => {
  it('prefers the ward live reading when one exists', () => {
    expect(currentReading(180, 40)).toEqual({ kind: 'live', aqi: 180 })
  })

  it('falls back to the forecast excess when there is no live ward reading', () => {
    expect(currentReading(null, 40)).toEqual({ kind: 'forecast', excess: 40 })
  })

  it('is unavailable when neither a live reading nor a forecast excess exists', () => {
    expect(currentReading(null, null)).toEqual({ kind: 'unavailable' })
  })

  it('treats a live reading of 0 as real, not missing', () => {
    expect(currentReading(0, 40)).toEqual({ kind: 'live', aqi: 0 })
  })
})

describe('citizen verification safety (plan §11)', () => {
  const base = {
    missionType: 'citizen_verification',
    missionStatus: 'dispatched',
    incidentStatus: 'evidence_gathering' as const,
    leadingCategory: 'road_dust' as const,
    severity: 'moderate' as const,
  }

  it('allows a safe, relevant request', () => {
    expect(citizenVerificationSafety(base)).toEqual({ safe: true, reason: null })
  })

  it('never asks a citizen to approach a fire or an industrial site', () => {
    for (const cat of HAZARDOUS_FOR_CITIZENS) {
      const d = citizenVerificationSafety({ ...base, leadingCategory: cat })
      expect(d.safe).toBe(false)
      expect(d.reason).toMatch(/safety/i)
    }
  })

  it('does not send a citizen outside when the air is severe', () => {
    const d = citizenVerificationSafety({ ...base, severity: 'severe' })
    expect(d.safe).toBe(false)
    expect(d.reason).toMatch(/indoors/i)
  })

  it('refuses tasks meant for a trained officer', () => {
    expect(citizenVerificationSafety({ ...base, missionType: 'field_photo' }).safe).toBe(false)
  })

  it('refuses when the incident or mission is already closed', () => {
    expect(citizenVerificationSafety({ ...base, incidentStatus: 'closed' }).safe).toBe(false)
    expect(citizenVerificationSafety({ ...base, missionStatus: 'completed' }).safe).toBe(false)
    expect(citizenVerificationSafety({ ...base, missionStatus: 'cancelled' }).safe).toBe(false)
  })

  it('allows an unclassified source (no category is not a hazard signal)', () => {
    expect(citizenVerificationSafety({ ...base, leadingCategory: null }).safe).toBe(true)
  })
})

describe('field outcome rules', () => {
  it('officially verifies a source when an authorised officer confirms it', () => {
    expect(evidenceLevelAfterFieldOutcome('suspected', 'confirmed')).toBe('officially_verified')
    expect(evidenceLevelAfterFieldOutcome('corroborated', 'confirmed')).toBe('officially_verified')
  })

  it('sends a rejected hypothesis back to suspected rather than closing it', () => {
    // The pollution may be real with a different cause — rejecting the
    // hypothesis must not be read as "nothing is wrong here".
    expect(evidenceLevelAfterFieldOutcome('corroborated', 'rejected')).toBe('suspected')
    expect(incidentStatusAfterFieldOutcome('evidence_gathering', 'rejected')).toBe('under_review')
  })

  it('changes nothing on an inconclusive visit', () => {
    expect(evidenceLevelAfterFieldOutcome('corroborated', 'unresolved')).toBe('corroborated')
    expect(incidentStatusAfterFieldOutcome('evidence_gathering', 'unresolved')).toBe('evidence_gathering')
  })

  it('never reopens a closed incident from a field outcome', () => {
    expect(incidentStatusAfterFieldOutcome('closed', 'confirmed')).toBe('closed')
    expect(incidentStatusAfterFieldOutcome('closed', 'rejected')).toBe('closed')
  })
})

describe('haversineMeters', () => {
  it('returns ~0 for the same point', () => {
    expect(haversineMeters({ lat: 28.85, lng: 77.09 }, { lat: 28.85, lng: 77.09 })).toBeCloseTo(0, 5)
  })

  it('matches a known short distance', () => {
    // 0.001 degrees of latitude is ~111.2m anywhere on Earth.
    const d = haversineMeters({ lat: 28.85, lng: 77.09 }, { lat: 28.851, lng: 77.09 })
    expect(d).toBeGreaterThan(105)
    expect(d).toBeLessThan(118)
  })

  it('is symmetric', () => {
    const a = { lat: 28.85, lng: 77.09 }
    const b = { lat: 28.87, lng: 77.11 }
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6)
  })
})

describe('field checklists', () => {
  it('gives every source category a short, non-empty checklist', () => {
    const cats = ['construction_dust', 'road_dust', 'open_burning', 'industrial', 'vehicular', 'waste', 'other'] as const
    for (const c of cats) {
      const items = checklistFor(c)
      expect(items.length).toBeGreaterThan(0)
      // "short" is the point — the field app is used one-handed outdoors.
      expect(items.length).toBeLessThanOrEqual(5)
      expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
    }
  })

  it('falls back to the generic checklist for an unclassified source', () => {
    expect(checklistFor(null)).toEqual(checklistFor('other'))
  })
})

describe('parseChecklistSnapshot', () => {
  it('accepts a well-formed checklist array', () => {
    const raw = [
      { id: 'a', label: 'Question A', type: 'boolean' },
      { id: 'b', label: 'Question B', type: 'text' },
    ]
    expect(parseChecklistSnapshot(raw)).toEqual(raw)
  })

  it('rejects non-array input', () => {
    expect(parseChecklistSnapshot(null)).toBeNull()
    expect(parseChecklistSnapshot(undefined)).toBeNull()
    expect(parseChecklistSnapshot('not an array')).toBeNull()
    expect(parseChecklistSnapshot({ id: 'a' })).toBeNull()
  })

  it('rejects an empty array (falls back rather than showing nothing)', () => {
    expect(parseChecklistSnapshot([])).toBeNull()
  })

  it('rejects the whole snapshot if any single item is malformed', () => {
    const raw = [
      { id: 'a', label: 'Fine', type: 'boolean' },
      { id: 'b', label: 'Bad type', type: 'number' },
    ]
    expect(parseChecklistSnapshot(raw)).toBeNull()
  })

  it('rejects items missing required fields', () => {
    expect(parseChecklistSnapshot([{ label: 'No id', type: 'boolean' }])).toBeNull()
    expect(parseChecklistSnapshot([{ id: 'a', type: 'boolean' }])).toBeNull()
  })
})

describe('documented rules', () => {
  it('states the corroboration rule in terms of independent reporters', () => {
    expect(CORROBORATION_RULE).toMatch(/different people/i)
  })
})

// ── Phase 4: intervention lifecycle ──────────────────────────────────────────

describe('operational vs outcome status split', () => {
  it('never overlaps operational and outcome statuses', () => {
    // The whole point of the split: "completed" must never itself be an
    // outcome. If these two lists ever share a member, the UI could no longer
    // tell "action done" from "pollution reduced" apart from the enum alone.
    const overlap = OPERATIONAL_STATUSES.filter((s) => (OUTCOME_STATUSES as string[]).includes(s))
    expect(overlap).toEqual([])
  })

  it('classifies each status correctly', () => {
    expect(isOperationalStatus('completed')).toBe(true)
    expect(isOutcomeStatus('completed')).toBe(false)
    expect(isOutcomeStatus('effective')).toBe(true)
    expect(isOperationalStatus('effective')).toBe(false)
    expect(isOperationalStatus('reopened')).toBe(false)
    expect(isOutcomeStatus('reopened')).toBe(false)
  })

  it('walks the operational lifecycle in one strict order', () => {
    expect(nextOperationalStatus('drafted')).toBe('awaiting_approval')
    expect(nextOperationalStatus('awaiting_approval')).toBe('assigned')
    expect(nextOperationalStatus('assigned')).toBe('accepted')
    expect(nextOperationalStatus('accepted')).toBe('in_progress')
    expect(nextOperationalStatus('in_progress')).toBe('completed')
    expect(nextOperationalStatus('completed')).toBe('verification_pending')
  })

  it('has no next operational step once verification is pending or an outcome is set', () => {
    // Nothing after verification_pending is "the next operational step" — from
    // there the path forward is an impact evaluation, not another workflow write.
    expect(nextOperationalStatus('verification_pending')).toBeNull()
    expect(nextOperationalStatus('effective')).toBeNull()
    expect(nextOperationalStatus('reopened')).toBeNull()
  })

  it('requires approval for the same action types the DB trigger gates', () => {
    expect(interventionRequiresApproval('penalty')).toBe(true)
    expect(interventionRequiresApproval('stop_work')).toBe(true)
    expect(interventionRequiresApproval('inspect')).toBe(false)
  })
})

describe('previewImpactOutcome (mirrors record_impact_evaluation in SQL)', () => {
  it('is inconclusive when either reading is missing', () => {
    expect(previewImpactOutcome({ before: null, after: 60, completeness: 1 }).outcome).toBe('inconclusive')
    expect(previewImpactOutcome({ before: 120, after: null, completeness: 1 }).outcome).toBe('inconclusive')
  })

  it('is inconclusive when the before value is zero or negative', () => {
    expect(previewImpactOutcome({ before: 0, after: 10, completeness: 1 }).outcome).toBe('inconclusive')
    expect(previewImpactOutcome({ before: -5, after: 10, completeness: 1 }).outcome).toBe('inconclusive')
  })

  it('is inconclusive below the completeness floor even with a large apparent drop', () => {
    // Regression guard for the exact failure mode the brief calls out: missing
    // data must never be read as "it worked".
    const r = previewImpactOutcome({ before: 120, after: 20, completeness: MIN_COMPLETENESS_FOR_RESULT - 0.01 })
    expect(r.outcome).toBe('inconclusive')
  })

  it('is effective at >=40% reduction with sufficient data', () => {
    const r = previewImpactOutcome({ before: 120, after: 60, completeness: 0.95 })
    expect(r.outcome).toBe('effective')
    expect(r.pctChange).toBeCloseTo(-50, 5)
  })

  it('is partly effective between 15% and 40% reduction', () => {
    expect(previewImpactOutcome({ before: 100, after: 80, completeness: 0.9 }).outcome).toBe('partly_effective')
  })

  it('is ineffective below 15% reduction', () => {
    expect(previewImpactOutcome({ before: 100, after: 95, completeness: 0.9 }).outcome).toBe('ineffective')
  })

  it('is ineffective, never effective, when the pollutant level rose', () => {
    const r = previewImpactOutcome({ before: 100, after: 130, completeness: 0.9 })
    expect(r.outcome).toBe('ineffective')
    expect(r.pctChange).toBeGreaterThan(0)
  })

  it('treats exactly the completeness floor as sufficient (boundary is inclusive)', () => {
    const r = previewImpactOutcome({ before: 100, after: 50, completeness: MIN_COMPLETENESS_FOR_RESULT })
    expect(r.outcome).not.toBe('inconclusive')
  })
})

describe('citizen action verification safety', () => {
  it('reuses the same safety gate as evidence-mission verification', () => {
    const ctx = { incidentStatus: 'verifying' as const, leadingCategory: 'road_dust' as const, severity: 'moderate' as const }
    expect(citizenActionVerificationSafety(ctx)).toEqual({ safe: true, reason: null })
  })

  it('refuses once the incident is closed', () => {
    const d = citizenActionVerificationSafety({
      incidentStatus: 'closed',
      leadingCategory: 'road_dust',
      severity: 'low',
    })
    expect(d.safe).toBe(false)
  })

  it('refuses when the air is currently severe', () => {
    const d = citizenActionVerificationSafety({
      incidentStatus: 'verifying',
      leadingCategory: 'road_dust',
      severity: 'severe',
    })
    expect(d.safe).toBe(false)
  })
})

// ── Phase 5: intervention playbooks ──────────────────────────────────────────

const playbook = (over: Partial<PlaybookLike> = {}): PlaybookLike => ({
  id: 1,
  slug: 'test-playbook',
  city_id: 1,
  source_category: 'road_dust',
  min_evidence_level: 'corroborated',
  action_type: 'vacuum_sweeping',
  for_regional: false,
  is_active: true,
  title: 'Test playbook',
  estimated_minutes: 180,
  estimated_cost_min: 8000,
  estimated_cost_max: 15000,
  expected_time_to_effect_hours: 2,
  verification_window_hours: 48,
  ...over,
})

const rankCtx = (over: Partial<PlaybookRankingContext> = {}): PlaybookRankingContext => ({
  cityId: 1,
  leadingCategory: 'road_dust',
  sourceConfidence: 'corroborated',
  classification: 'local',
  severity: 'moderate',
  ...over,
})

describe('meetsEvidenceLevel (ordinal comparison)', () => {
  it('mirrors the Postgres enum declaration order suspected < corroborated < officially_verified', () => {
    expect(meetsEvidenceLevel('suspected', 'suspected')).toBe(true)
    expect(meetsEvidenceLevel('suspected', 'corroborated')).toBe(false)
    expect(meetsEvidenceLevel('corroborated', 'suspected')).toBe(true)
    expect(meetsEvidenceLevel('corroborated', 'corroborated')).toBe(true)
    expect(meetsEvidenceLevel('corroborated', 'officially_verified')).toBe(false)
    expect(meetsEvidenceLevel('officially_verified', 'officially_verified')).toBe(true)
    expect(meetsEvidenceLevel('officially_verified', 'corroborated')).toBe(true)
  })
})

describe('isPlaybookEligible', () => {
  it('excludes every local playbook when the incident is only suspected', () => {
    // None of the seeded local playbooks require less than 'corroborated' —
    // this is the mechanism behind "suspected -> evidence-gathering only",
    // with no separate/duplicate evidence-gathering playbook type needed.
    const p = playbook({ min_evidence_level: 'corroborated' })
    expect(isPlaybookEligible(p, rankCtx({ sourceConfidence: 'suspected' }))).toBe(false)
  })

  it('includes a corroborated-tier playbook once the incident is corroborated', () => {
    const p = playbook({ min_evidence_level: 'corroborated' })
    expect(isPlaybookEligible(p, rankCtx({ sourceConfidence: 'corroborated' }))).toBe(true)
  })

  it('makes an enforcement-tier playbook eligible once officially verified, without excluding lower tiers', () => {
    const enforcement = playbook({ min_evidence_level: 'officially_verified', action_type: 'stop_work' })
    const preventive = playbook({ min_evidence_level: 'corroborated' })
    const ctx = rankCtx({ sourceConfidence: 'officially_verified' })
    expect(isPlaybookEligible(enforcement, ctx)).toBe(true)
    expect(isPlaybookEligible(preventive, ctx)).toBe(true) // "may appear" — not the only option
  })

  it('excludes an enforcement-tier playbook when only corroborated', () => {
    const enforcement = playbook({ min_evidence_level: 'officially_verified', action_type: 'stop_work' })
    expect(isPlaybookEligible(enforcement, rankCtx({ sourceConfidence: 'corroborated' }))).toBe(false)
  })

  it('shows only for_regional playbooks for a regional incident, and excludes local ones', () => {
    const local = playbook({ for_regional: false, source_category: 'road_dust', min_evidence_level: 'suspected' })
    const regional = playbook({ for_regional: true, source_category: null, min_evidence_level: 'suspected' })
    const ctx = rankCtx({ classification: 'regional' })
    expect(isPlaybookEligible(local, ctx)).toBe(false)
    expect(isPlaybookEligible(regional, ctx)).toBe(true)
  })

  it('never shows a regional-only playbook for a local incident', () => {
    const regional = playbook({ for_regional: true, source_category: null, min_evidence_level: 'suspected' })
    expect(isPlaybookEligible(regional, rankCtx({ classification: 'local' }))).toBe(false)
    expect(isPlaybookEligible(regional, rankCtx({ classification: null }))).toBe(false)
  })

  it('excludes a playbook whose source category does not match the leading hypothesis', () => {
    const p = playbook({ source_category: 'construction_dust' })
    expect(isPlaybookEligible(p, rankCtx({ leadingCategory: 'road_dust' }))).toBe(false)
  })

  it('excludes a specific-city playbook from a different city, but includes a national default', () => {
    const delhiOnly = playbook({ city_id: 1 })
    const nationalDefault = playbook({ city_id: null })
    const otherCityCtx = rankCtx({ cityId: 2 })
    expect(isPlaybookEligible(delhiOnly, otherCityCtx)).toBe(false)
    expect(isPlaybookEligible(nationalDefault, otherCityCtx)).toBe(true)
  })

  it('excludes an inactive playbook regardless of everything else matching', () => {
    const p = playbook({ is_active: false })
    expect(isPlaybookEligible(p, rankCtx())).toBe(false)
  })
})

describe('scorePlaybook', () => {
  it('scores an exact source + evidence match higher than a mismatch', () => {
    const matching = scorePlaybook(playbook(), rankCtx())
    const mismatchedEvidence = scorePlaybook(playbook({ min_evidence_level: 'officially_verified' }), rankCtx())
    expect(matching.score).toBeGreaterThan(mismatchedEvidence.score)
    expect(matching.reasons.some((r) => /matches the leading suspected source/i.test(r))).toBe(true)
  })

  it('only rewards fast deployment when severity is elevated', () => {
    const fast = playbook({ estimated_minutes: 30, expected_time_to_effect_hours: 1 })
    const slow = playbook({ estimated_minutes: 600, expected_time_to_effect_hours: 48 })
    const lowSeverity = rankCtx({ severity: 'low' })
    const severeSeverity = rankCtx({ severity: 'severe' })

    // at low severity, timing contributes nothing — fast and slow score the same on this factor
    const fastLow = scorePlaybook(fast, lowSeverity)
    const slowLow = scorePlaybook(slow, lowSeverity)
    expect(fastLow.score).toBeCloseTo(slowLow.score, 5)

    // at severe, the fast playbook must score strictly higher
    const fastSevere = scorePlaybook(fast, severeSeverity)
    const slowSevere = scorePlaybook(slow, severeSeverity)
    expect(fastSevere.score).toBeGreaterThan(slowSevere.score)
  })

  it('treats unknown cost as neutral, never as if it were expensive', () => {
    const unknownCost = scorePlaybook(playbook({ estimated_cost_min: null, estimated_cost_max: null }), rankCtx())
    const expensive = scorePlaybook(
      playbook({ estimated_cost_min: PLAYBOOK_COST_CEILING * 2, estimated_cost_max: PLAYBOOK_COST_CEILING * 2 }),
      rankCtx(),
    )
    expect(unknownCost.score).toBeGreaterThan(expensive.score)
  })

  it('does not score resource availability at all when unknown', () => {
    const withoutInfo = scorePlaybook(playbook(), rankCtx({ assignableOfficerCount: undefined }))
    const knownUnavailable = scorePlaybook(playbook(), rankCtx({ assignableOfficerCount: 0 }))
    // unknown must not be penalised the same as a KNOWN zero — it should score
    // at least as well as the known-unavailable case.
    expect(withoutInfo.score).toBeGreaterThanOrEqual(knownUnavailable.score)
  })

  it('never scores affectedPopulation - the parameter is accepted but inert', () => {
    const withPop = scorePlaybook(playbook(), rankCtx({ affectedPopulation: 50_000 }))
    const withoutPop = scorePlaybook(playbook(), rankCtx({ affectedPopulation: undefined }))
    expect(withPop.score).toBe(withoutPop.score)
  })

  it('always returns at least one human-readable reason', () => {
    const s = scorePlaybook(playbook({ source_category: null, for_regional: false }), rankCtx({ leadingCategory: null }))
    expect(s.reasons.length).toBeGreaterThan(0)
  })
})

describe('rankPlaybooks', () => {
  it('excludes ineligible playbooks entirely, even from the bottom of the list', () => {
    const eligible = playbook({ id: 1 })
    const ineligible = playbook({ id: 2, min_evidence_level: 'officially_verified', action_type: 'stop_work' })
    const ranked = rankPlaybooks([eligible, ineligible], rankCtx({ sourceConfidence: 'corroborated' }))
    expect(ranked.map((r) => r.playbook.id)).toEqual([1])
  })

  it('sorts best-first and breaks exact ties by id for determinism', () => {
    const a = playbook({ id: 5 })
    const b = playbook({ id: 2 })
    const ranked = rankPlaybooks([a, b], rankCtx())
    // identical inputs other than id -> identical score -> lower id first
    expect(ranked[0].playbook.id).toBe(2)
    expect(ranked[1].playbook.id).toBe(5)
  })
})

describe('playbookRequiresApproval', () => {
  it('requires approval for the same action types the DB trigger gates', () => {
    expect(playbookRequiresApproval(playbook({ action_type: 'stop_work' }))).toBe(true)
    expect(playbookRequiresApproval(playbook({ action_type: 'vacuum_sweeping' }))).toBe(false)
  })
})

describe('tallyPlaybookUsage', () => {
  it('buckets each workflow status correctly, including pending (used but not yet evaluated)', () => {
    const stats = tallyPlaybookUsage([
      'effective', 'effective', 'partly_effective', 'ineffective', 'inconclusive', 'completed', 'in_progress',
    ])
    expect(stats.timesUsed).toBe(7)
    expect(stats.effective).toBe(2)
    expect(stats.partlyEffective).toBe(1)
    expect(stats.ineffective).toBe(1)
    expect(stats.inconclusive).toBe(1)
    expect(stats.pending).toBe(2)
  })

  it('returns all zeros for a playbook that has never been used', () => {
    const stats = tallyPlaybookUsage([])
    expect(stats).toEqual({ timesUsed: 0, effective: 0, partlyEffective: 0, ineffective: 0, inconclusive: 0, pending: 0 })
  })
})

// ── Phase 5.1: citizen recurrence reporting ──────────────────────────────────

const hoursAgoISO = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

const recurrenceCtx = (over: Partial<RecurrenceDecisionContext> = {}): RecurrenceDecisionContext => ({
  closedAt: hoursAgoISO(48),
  reportCreatedAt: new Date().toISOString(),
  lastImpactOutcome: 'effective',
  recurrenceType: 'returned',
  incidentLat: 28.85,
  incidentLng: 77.09,
  reportLat: 28.85,
  reportLng: 77.09,
  ...over,
})

describe('citizenRecurrenceStatusLabel', () => {
  it('prioritises the computed outcome over the raw review_status', () => {
    expect(citizenRecurrenceStatusLabel('confirmed', 'reopened')).toMatch(/reopened/i)
    expect(citizenRecurrenceStatusLabel('confirmed', 'new_incident')).toMatch(/new incident/i)
  })

  it('falls back to the plain review_status label when there is no outcome yet', () => {
    expect(citizenRecurrenceStatusLabel('pending', null)).toMatch(/under review/i)
    expect(citizenRecurrenceStatusLabel('more_evidence_requested', null)).toMatch(/more evidence/i)
    expect(citizenRecurrenceStatusLabel('dismissed', null)).toMatch(/dismissed/i)
  })
})

describe('recommendRecurrenceDecision', () => {
  it('recommends uncertain when the incident has no recorded closure date', () => {
    const d = recommendRecurrenceDecision(recurrenceCtx({ closedAt: null }))
    expect(d.recommendation).toBe('uncertain')
  })

  it('recommends reopen when reported soon after closure, at the same location, with a temporary-effect signal', () => {
    const d = recommendRecurrenceDecision(
      recurrenceCtx({
        closedAt: hoursAgoISO(RECURRENCE_SOON_AFTER_CLOSURE_HOURS - 1),
        recurrenceType: 'action_temporary',
      }),
    )
    expect(d.recommendation).toBe('reopen')
    expect(d.reasons.length).toBeGreaterThan(0)
  })

  it('recommends a new incident after a substantial time gap', () => {
    // Coordinates nulled so the location signal cannot offset the gap signal —
    // isolating exactly the factor this test names, not a multi-signal blend.
    const d = recommendRecurrenceDecision(
      recurrenceCtx({
        closedAt: hoursAgoISO(RECURRENCE_SUBSTANTIAL_GAP_HOURS + 24),
        reportLat: null,
        reportLng: null,
      }),
    )
    expect(d.recommendation).toBe('new_incident')
  })

  it('recommends a new incident when the location has materially changed', () => {
    // closedAt sits BETWEEN the "soon" and "substantial gap" windows so neither
    // time-based signal fires — isolating the location signal specifically.
    // ~0.01 degrees of latitude is roughly 1.1km — well past the same-location radius.
    const d = recommendRecurrenceDecision(
      recurrenceCtx({
        closedAt: hoursAgoISO((RECURRENCE_SOON_AFTER_CLOSURE_HOURS + RECURRENCE_SUBSTANTIAL_GAP_HOURS) / 2),
        reportLat: 28.86,
      }),
    )
    expect(d.recommendation).toBe('new_incident')
  })

  it('lets a genuine tie between competing signals read as uncertain, not a coin flip', () => {
    // Substantial gap (-> new_incident) at the exact same location (-> reopen)
    // is a real conflict a human should look at, not something to guess on.
    const d = recommendRecurrenceDecision(
      recurrenceCtx({ closedAt: hoursAgoISO(RECURRENCE_SUBSTANTIAL_GAP_HOURS + 24) }),
    )
    expect(d.recommendation).toBe('uncertain')
  })

  it('treats a partly-effective prior outcome as corroborating "temporary", not on its own decisive', () => {
    const d = recommendRecurrenceDecision(
      recurrenceCtx({
        closedAt: hoursAgoISO(RECURRENCE_SOON_AFTER_CLOSURE_HOURS - 1),
        lastImpactOutcome: 'partly_effective',
        recurrenceType: 'unable_to_confirm',
      }),
    )
    expect(d.recommendation).toBe('reopen')
  })

  it('never fabricates a location signal when coordinates are missing on either side', () => {
    const d = recommendRecurrenceDecision(
      recurrenceCtx({ incidentLat: null, incidentLng: null, closedAt: hoursAgoISO(400) }),
    )
    // Neither "soon" (400h > 168h) nor "substantial gap" (400h < 720h) nor a
    // location signal fires — this must land on uncertain, not a fabricated pick.
    expect(d.recommendation).toBe('uncertain')
  })

  it('always returns at least one reason, even for uncertain', () => {
    const d = recommendRecurrenceDecision(recurrenceCtx({ closedAt: hoursAgoISO(400) }))
    expect(d.reasons.length).toBeGreaterThan(0)
  })

  it('uses the documented same-location radius consistently', () => {
    expect(RECURRENCE_SAME_LOCATION_RADIUS_M).toBeGreaterThan(0)
    expect(RECURRENCE_SUBSTANTIAL_GAP_HOURS).toBeGreaterThan(RECURRENCE_SOON_AFTER_CLOSURE_HOURS)
  })
})

// ── Phase 5.1: custom intervention hardening ─────────────────────────────────

describe('isCustomActionTypeAllowedForClassification', () => {
  it('allows any type when the incident is not classified regional', () => {
    expect(isCustomActionTypeAllowedForClassification('sprinkle', 'local')).toBe(true)
    expect(isCustomActionTypeAllowedForClassification('sprinkle', null)).toBe(true)
    expect(isCustomActionTypeAllowedForClassification('sprinkle', 'mixed')).toBe(true)
  })

  it('allows only advisory_monitoring when the incident is classified regional', () => {
    expect(isCustomActionTypeAllowedForClassification('advisory_monitoring', 'regional')).toBe(true)
    expect(isCustomActionTypeAllowedForClassification('sprinkle', 'regional')).toBe(false)
    expect(isCustomActionTypeAllowedForClassification('stop_work', 'regional')).toBe(false)
  })

  it('gives an explanatory reason exactly when blocked', () => {
    expect(customActionClassificationBlockedReason('sprinkle', 'regional')).toMatch(/regional/i)
    expect(customActionClassificationBlockedReason('advisory_monitoring', 'regional')).toBeNull()
    expect(customActionClassificationBlockedReason('sprinkle', 'local')).toBeNull()
  })
})

describe('isActionLockedByApproval', () => {
  it('locks once an approver is recorded, regardless of who', () => {
    expect(isActionLockedByApproval(null)).toBe(false)
    expect(isActionLockedByApproval('some-uuid')).toBe(true)
  })
})

// ── Phase 6: automated anomaly detection ─────────────────────────────────────

describe('POLLUTANTS / POLLUTANT_LABEL', () => {
  it('covers all six data-model pollutants, each with a label', () => {
    expect(POLLUTANTS).toEqual(['pm25', 'pm10', 'no2', 'so2', 'co', 'o3'])
    for (const p of POLLUTANTS) {
      expect(POLLUTANT_LABEL[p]).toBeTruthy()
    }
  })
})

describe('DETECTION_STAGE_LABEL', () => {
  it('labels every detection stage', () => {
    expect(DETECTION_STAGE_LABEL.predicted).toMatch(/predicted/i)
    expect(DETECTION_STAGE_LABEL.detected).toMatch(/detected/i)
    expect(DETECTION_STAGE_LABEL.confirmed).toMatch(/confirmed/i)
  })
})

describe('describeTriggeredRule', () => {
  it('gives a plain-language description for every rule the SQL engine can trigger', () => {
    expect(describeTriggeredRule('concentration_threshold')).toMatch(/threshold/i)
    expect(describeTriggeredRule('persistence')).toMatch(/persist/i)
    expect(describeTriggeredRule('local_excess')).toMatch(/background/i)
    expect(describeTriggeredRule('trend_projection')).toMatch(/trend|horizon/i)
  })

  it('falls back to a humanised version of an unrecognised rule name rather than throwing', () => {
    expect(describeTriggeredRule('some_new_rule')).toBe('some new rule')
  })
})

describe('sensorQualityCaveat', () => {
  it('shows no caveat for a regulatory sensor or an unknown/null sensor_type on a legacy row', () => {
    expect(sensorQualityCaveat('regulatory')).toBeNull()
    expect(sensorQualityCaveat(null)).toBeNull()
  })

  it('shows a distinct caveat for indicative and low-cost sensors', () => {
    expect(sensorQualityCaveat('indicative')).toMatch(/indicative/i)
    expect(sensorQualityCaveat('low_cost')).toMatch(/low-cost/i)
    expect(sensorQualityCaveat('indicative')).not.toBe(sensorQualityCaveat('low_cost'))
  })

  it('treats a genuinely unrecognised sensor_type value as reduced-confidence, not regulatory-grade', () => {
    expect(sensorQualityCaveat('unknown')).toMatch(/unknown/i)
  })
})

describe('describeAnomalyDetectionRule', () => {
  it('returns non-empty plain-language text mentioning persistence and never firing from one reading', () => {
    const text = describeAnomalyDetectionRule()
    expect(text.length).toBeGreaterThan(0)
    expect(text).toMatch(/persist/i)
    expect(text).toMatch(/one reading alone/i)
  })
})

// ── probable-source attribution (Phase 7) ────────────────────────────────────

describe('sourceCategoryLabel', () => {
  it('shows the plan\'s literal wording for the aliased categories without renaming the underlying enum', () => {
    expect(sourceCategoryLabel('vehicular')).toBe('Traffic emissions')
    expect(sourceCategoryLabel('industrial')).toBe('Industrial combustion')
  })

  it('has a distinct label for every one of the three new meta-categories', () => {
    const labels = ['regional_transport', 'mixed', 'unresolved'].map((c) => sourceCategoryLabel(c as never))
    expect(new Set(labels).size).toBe(3)
  })

  it('falls back to "Unknown" for null rather than throwing', () => {
    expect(sourceCategoryLabel(null)).toBe('Unknown')
  })
})

describe('isMetaSourceCategory', () => {
  it('is true only for the three evidence-shape categories, never for a specific physical source', () => {
    expect(isMetaSourceCategory('regional_transport')).toBe(true)
    expect(isMetaSourceCategory('mixed')).toBe(true)
    expect(isMetaSourceCategory('unresolved')).toBe(true)
    expect(isMetaSourceCategory('road_dust')).toBe(false)
    expect(isMetaSourceCategory('industrial')).toBe(false)
    expect(isMetaSourceCategory(null)).toBe(false)
  })
})

describe('isHumanConfirmedClassification', () => {
  it('is true only for an explicit human confirmation, never for a model-set or unset classification', () => {
    expect(isHumanConfirmedClassification('human')).toBe(true)
    expect(isHumanConfirmedClassification('model')).toBe(false)
    expect(isHumanConfirmedClassification(null)).toBe(false)
  })
})

describe('needsMoreAttributionEvidence', () => {
  it('is true when there is no top hypothesis at all (nothing to be confident about)', () => {
    expect(needsMoreAttributionEvidence(null, null)).toBe(true)
  })

  it('is true when the top probability is below the confidence threshold', () => {
    expect(needsMoreAttributionEvidence(0.3, null, 0.45)).toBe(true)
  })

  it('is true when the top two are too close together (ambiguous), even if the top clears the threshold', () => {
    expect(needsMoreAttributionEvidence(0.5, 0.45, 0.45, 0.12)).toBe(true)
  })

  it('is false for a clear, confident, unambiguous leader', () => {
    expect(needsMoreAttributionEvidence(0.7, 0.1, 0.45, 0.12)).toBe(false)
  })
})

// ── Phase 8: unified forecasting ─────────────────────────────────────────────

describe('FORECAST_HORIZONS_HOURS / FORECAST_METHOD_LABEL / FORECAST_DATA_QUALITY_LABEL / PREDICTION_METHOD_LABEL', () => {
  it('covers the four supported horizons in order', () => {
    expect(FORECAST_HORIZONS_HOURS).toEqual([6, 12, 24, 48])
  })

  it('labels every forecast method and data-quality status', () => {
    expect(FORECAST_METHOD_LABEL.lightgbm).toMatch(/lightgbm|machine.learning/i)
    expect(FORECAST_METHOD_LABEL.diurnal_persistence).toMatch(/seasonal|baseline|fallback/i)
    expect(FORECAST_DATA_QUALITY_LABEL.ok).toBeTruthy()
    expect(FORECAST_DATA_QUALITY_LABEL.insufficient_data).toMatch(/not enough|insufficient/i)
    expect(FORECAST_DATA_QUALITY_LABEL.stale_inputs).toMatch(/sparse|stale/i)
  })

  it('labels both prediction methods distinctly', () => {
    expect(PREDICTION_METHOD_LABEL.validated_forecast).not.toBe(PREDICTION_METHOD_LABEL.trend_persistence)
    expect(PREDICTION_METHOD_LABEL.trend_persistence).toMatch(/fallback/i)
  })

  it('states the fixed forecast disclaimer literally', () => {
    expect(FORECAST_DISCLAIMER).toBe('Forecast - not a guaranteed outcome.')
  })
})

describe('isHorizonValidated', () => {
  it('is false when nothing has been validated yet', () => {
    expect(isHorizonValidated(null, 6)).toBe(false)
  })

  it('is true only for horizons at or below the validated maximum', () => {
    expect(isHorizonValidated(24, 6)).toBe(true)
    expect(isHorizonValidated(24, 12)).toBe(true)
    expect(isHorizonValidated(24, 24)).toBe(true)
    expect(isHorizonValidated(24, 48)).toBe(false)
  })
})

describe('forecastFallbackStatus', () => {
  it('reports the validated model when lightgbm beat persistence', () => {
    expect(forecastFallbackStatus('lightgbm', true)).toMatch(/validated/i)
  })

  it('reports an explicit fallback when diurnal is used because the model has not beaten persistence', () => {
    expect(forecastFallbackStatus('diurnal_persistence', false)).toMatch(/fall(ing)? back/i)
  })

  it('never claims the model is validated when it is not the method in use', () => {
    const status = forecastFallbackStatus('diurnal_persistence', false)
    expect(status).not.toMatch(/validated machine/i)
  })
})

// ── Phase 9: authority routing and operational dispatch ─────────────────────

describe('canTransitionTaskDispatch', () => {
  it('allows the documented happy path end to end', () => {
    expect(canTransitionTaskDispatch('drafted', 'routed')).toBe(true)
    expect(canTransitionTaskDispatch('routed', 'sent')).toBe(true)
    expect(canTransitionTaskDispatch('sent', 'acknowledged')).toBe(true)
    expect(canTransitionTaskDispatch('acknowledged', 'accepted')).toBe(true)
    expect(canTransitionTaskDispatch('accepted', 'in_progress')).toBe(true)
    expect(canTransitionTaskDispatch('in_progress', 'completed')).toBe(true)
    expect(canTransitionTaskDispatch('completed', 'verification_pending')).toBe(true)
  })

  it('rejects illegal jumps that skip lifecycle stages', () => {
    expect(canTransitionTaskDispatch('sent', 'completed')).toBe(false)
    expect(canTransitionTaskDispatch('drafted', 'completed')).toBe(false)
  })

  it('treats cancelled as a true terminal state', () => {
    expect(canTransitionTaskDispatch('cancelled', 'drafted')).toBe(false)
    expect(canTransitionTaskDispatch('cancelled', 'routed')).toBe(false)
  })

  it('allows overdue and escalated to recover back into the active flow', () => {
    expect(canTransitionTaskDispatch('overdue', 'in_progress')).toBe(true)
    expect(canTransitionTaskDispatch('escalated', 'acknowledged')).toBe(true)
  })

  it('allows completed -> escalated (Phase 10: a completed task whose verification SLA lapses can still escalate)', () => {
    expect(canTransitionTaskDispatch('completed', 'escalated')).toBe(true)
  })
})

describe('taskDispatchRequiresReason', () => {
  it('requires a reason for rejection, reroute, and cancellation', () => {
    expect(taskDispatchRequiresReason('rejected')).toBe(true)
    expect(taskDispatchRequiresReason('rerouted')).toBe(true)
    expect(taskDispatchRequiresReason('cancelled')).toBe(true)
  })

  it('does not require a reason for ordinary forward progress', () => {
    expect(taskDispatchRequiresReason('acknowledged')).toBe(false)
    expect(taskDispatchRequiresReason('completed')).toBe(false)
  })
})

describe('TASK_DISPATCH_STATUS_LABEL', () => {
  it('labels every lifecycle status', () => {
    const statuses = [
      'drafted', 'awaiting_approval', 'approved', 'routed', 'sent', 'acknowledged',
      'accepted', 'in_progress', 'completed', 'verification_pending', 'overdue',
      'escalated', 'rejected', 'rerouted', 'cancelled',
    ] as const
    for (const s of statuses) expect(TASK_DISPATCH_STATUS_LABEL[s]).toBeTruthy()
  })
})

describe('publicTaskStatusLabel', () => {
  it('shows "not yet assigned" when there is no dispatch at all', () => {
    expect(publicTaskStatusLabel(null)).toMatch(/not yet assigned/i)
  })

  it('surfaces plan §12 public-safe states in plain language', () => {
    expect(publicTaskStatusLabel('accepted')).toMatch(/assigned/i)
    expect(publicTaskStatusLabel('sent')).toMatch(/responding/i)
    expect(publicTaskStatusLabel('in_progress')).toMatch(/in progress/i)
    expect(publicTaskStatusLabel('completed')).toMatch(/completed/i)
    expect(publicTaskStatusLabel('verification_pending')).toMatch(/under review/i)
  })

  it('never leaks an internal-only state (disputed routing, rejection, reroute) to a citizen label', () => {
    for (const s of ['drafted', 'awaiting_approval', 'approved', 'overdue', 'escalated', 'rejected', 'rerouted', 'cancelled'] as const) {
      const label = publicTaskStatusLabel(s)
      expect(label).not.toMatch(/reject|reroute|dispute|cancel|overdue|escalat/i)
    }
  })
})

describe('ROUTING_CONFIDENCE_LABEL / routingBlocksAutoDispatch', () => {
  it('labels every routing confidence tier', () => {
    expect(ROUTING_CONFIDENCE_LABEL.confirmed).toBeTruthy()
    expect(ROUTING_CONFIDENCE_LABEL.probable).toBeTruthy()
    expect(ROUTING_CONFIDENCE_LABEL.disputed).toBeTruthy()
    expect(ROUTING_CONFIDENCE_LABEL.unresolved).toMatch(/unresolved/i)
  })

  it('blocks auto-dispatch for unresolved and disputed routing only', () => {
    expect(routingBlocksAutoDispatch('unresolved')).toBe(true)
    expect(routingBlocksAutoDispatch('disputed')).toBe(true)
    expect(routingBlocksAutoDispatch('confirmed')).toBe(false)
    expect(routingBlocksAutoDispatch('probable')).toBe(false)
  })
})

describe('NOTIFICATION_CHANNEL_LABEL / NOTIFICATION_STATUS_LABEL', () => {
  it('labels every channel and delivery status', () => {
    expect(NOTIFICATION_CHANNEL_LABEL.in_app).toBeTruthy()
    expect(NOTIFICATION_CHANNEL_LABEL.email).toBeTruthy()
    expect(NOTIFICATION_CHANNEL_LABEL.sms).toBeTruthy()
    expect(NOTIFICATION_CHANNEL_LABEL.whatsapp).toBeTruthy()
    expect(NOTIFICATION_STATUS_LABEL.pending).toMatch(/queue/i)
    expect(NOTIFICATION_STATUS_LABEL.failed).toMatch(/fail/i)
  })
})

describe('DISPATCH_APPROVAL_REQUIRED_TYPES / dispatchRequiresApprovalByDefault', () => {
  it('includes every enforcement type plus equipment deployment (sprinkle)', () => {
    expect(DISPATCH_APPROVAL_REQUIRED_TYPES).toContain('penalty')
    expect(DISPATCH_APPROVAL_REQUIRED_TYPES).toContain('stop_work')
    expect(DISPATCH_APPROVAL_REQUIRED_TYPES).toContain('sprinkle')
  })

  it('does not require approval for routine inspection', () => {
    expect(dispatchRequiresApprovalByDefault('inspect')).toBe(false)
  })

  it('requires approval for enforcement-sensitive and equipment-deployment types', () => {
    expect(dispatchRequiresApprovalByDefault('penalty')).toBe(true)
    expect(dispatchRequiresApprovalByDefault('sprinkle')).toBe(true)
  })
})

describe('SLA_CHECKPOINT_LABEL', () => {
  it('labels every SLA checkpoint plan §7 asks to be tracked', () => {
    expect(SLA_CHECKPOINT_LABEL.ack).toMatch(/acknowledg/i)
    expect(SLA_CHECKPOINT_LABEL.accept).toMatch(/accept/i)
    expect(SLA_CHECKPOINT_LABEL.arrival).toMatch(/arriv/i)
    expect(SLA_CHECKPOINT_LABEL.completion).toMatch(/complet/i)
    expect(SLA_CHECKPOINT_LABEL.verification).toMatch(/verif/i)
  })
})

describe('minutesUntil / slaCountdownLabel', () => {
  const now = new Date('2026-07-18T12:00:00Z')

  it('returns null when there is no SLA deadline at all', () => {
    expect(minutesUntil(null, now)).toBeNull()
    expect(slaCountdownLabel(null, now)).toMatch(/no sla/i)
  })

  it('computes minutes remaining for a future deadline', () => {
    expect(minutesUntil('2026-07-18T13:30:00Z', now)).toBe(90)
    expect(slaCountdownLabel('2026-07-18T13:30:00Z', now)).toMatch(/due in 1h 30m/i)
  })

  it('computes a negative value and an "overdue by" label for a past deadline', () => {
    expect(minutesUntil('2026-07-18T11:00:00Z', now)).toBe(-60)
    expect(slaCountdownLabel('2026-07-18T11:00:00Z', now)).toMatch(/overdue by 1h/i)
  })

  it('formats sub-hour durations in minutes only', () => {
    expect(slaCountdownLabel('2026-07-18T12:45:00Z', now)).toMatch(/due in 45m/i)
  })
})

// ── launch-hardening pass (Overview/Incidents clarity) ──────────────────────

describe('resolveIncidentPollutant', () => {
  it('prefers primary_pollutant when set', () => {
    expect(resolveIncidentPollutant('pm10', 'pm25')).toBe('pm10')
  })

  it('falls back to the detection pollutant when primary is null', () => {
    expect(resolveIncidentPollutant(null, 'no2')).toBe('no2')
  })

  it('returns null when neither is set', () => {
    expect(resolveIncidentPollutant(null, null)).toBeNull()
  })

  it('returns null for an unrecognized pollutant string rather than passing it through', () => {
    expect(resolveIncidentPollutant('not_a_real_pollutant', null)).toBeNull()
  })
})

describe('missionRationaleIsAutomated / cleanMissionRationale', () => {
  it('detects a single-prefixed automated rationale', () => {
    const r = 'Automated attribution: leading hypothesis is road dust at 50% confidence.'
    expect(missionRationaleIsAutomated(r)).toBe(true)
    expect(cleanMissionRationale(r)).toBe('leading hypothesis is road dust at 50% confidence.')
  })

  it('strips a double-prefixed rationale (the known SQL double-prepend bug) down to one clean sentence', () => {
    const r = 'Automated attribution: Automated attribution: leading hypothesis is road dust at 50% confidence.'
    expect(cleanMissionRationale(r)).toBe('leading hypothesis is road dust at 50% confidence.')
  })

  it('leaves a manually created (non-automated) rationale untouched', () => {
    const r = 'Command requested a follow-up photo.'
    expect(missionRationaleIsAutomated(r)).toBe(false)
    expect(cleanMissionRationale(r)).toBe(r)
  })

  it('handles null without crashing', () => {
    expect(missionRationaleIsAutomated(null)).toBe(false)
    expect(cleanMissionRationale(null)).toBeNull()
  })
})

describe('groupDuplicateMissions', () => {
  it('groups missions with identical type+status+rationale and counts them', () => {
    const missions = [
      { id: 1, mission_type: 'citizen_verification', status: 'proposed', rationale: 'Same reason' },
      { id: 2, mission_type: 'citizen_verification', status: 'proposed', rationale: 'Same reason' },
      { id: 3, mission_type: 'field_photo', status: 'proposed', rationale: 'Different mission' },
    ]
    const grouped = groupDuplicateMissions(missions)
    expect(grouped).toHaveLength(2)
    expect(grouped[0]).toEqual({ mission: missions[0], count: 2 })
    expect(grouped[1]).toEqual({ mission: missions[2], count: 1 })
  })

  it('does not group missions with different rationale even if type+status match', () => {
    const missions = [
      { id: 1, mission_type: 'field_photo', status: 'proposed', rationale: 'Reason A' },
      { id: 2, mission_type: 'field_photo', status: 'proposed', rationale: 'Reason B' },
    ]
    expect(groupDuplicateMissions(missions)).toHaveLength(2)
  })

  it('handles an empty array', () => {
    expect(groupDuplicateMissions([])).toEqual([])
  })
})

describe('dispatchEmptyStateMessage', () => {
  it('names the source-corroboration blocker for a suspected-only source', () => {
    expect(dispatchEmptyStateMessage('suspected', true)).toMatch(/corroborated/i)
  })

  it('names the missing-authority blocker when confidence is sufficient but no authority resolved', () => {
    const msg = dispatchEmptyStateMessage('corroborated', false)
    expect(msg).toMatch(/no responsible authority/i)
  })

  it('gives a generic-but-honest message when neither blocker applies', () => {
    const msg = dispatchEmptyStateMessage('officially_verified', true)
    expect(msg).not.toMatch(/corroborated/i)
    expect(msg).not.toMatch(/no responsible authority/i)
    expect(msg).toMatch(/no dispatch created yet/i)
  })
})

describe('parseDataQualityNote', () => {
  it('parses the fixed-shape SQL sentence into available/missing lists', () => {
    const note =
      'Evidence availability for this calculation: monitoring readings t, wind direction t, responsibility registry t, citizen evidence f, field evidence f (3 of 5 evidence types available).'
    const parsed = parseDataQualityNote(note)
    expect(parsed).not.toBeNull()
    expect(parsed?.available).toEqual(['monitoring readings', 'wind direction', 'responsibility registry'])
    expect(parsed?.missing).toEqual(['citizen evidence', 'field evidence'])
  })

  it('never leaks a raw t/f shorthand into the parsed output', () => {
    const note =
      'Evidence availability for this calculation: monitoring readings f, wind direction f, responsibility registry f, citizen evidence f, field evidence f (0 of 5 evidence types available).'
    const parsed = parseDataQualityNote(note)
    const joined = JSON.stringify(parsed)
    expect(joined).not.toMatch(/[^a-z]t[^a-z]|[^a-z]f[^a-z]/)
  })

  it('returns null (caller falls back to raw text) for null input or an unrecognized shape', () => {
    expect(parseDataQualityNote(null)).toBeNull()
    expect(parseDataQualityNote('some unrelated free text note')).toBeNull()
  })
})

describe('collapseRepeatedTimelineEvents', () => {
  it('collapses repeated attribution_recalculated events into one entry with a count, at the first occurrence position', () => {
    const events = [
      { id: 1, event_type: 'created' },
      { id: 2, event_type: 'attribution_recalculated' },
      { id: 3, event_type: 'evidence_added' },
      { id: 4, event_type: 'attribution_recalculated' },
      { id: 5, event_type: 'attribution_recalculated' },
    ]
    const out = collapseRepeatedTimelineEvents(events)
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ representative: events[0], count: 1 })
    expect(out[1]).toEqual({ representative: events[4], count: 3 }) // latest occurrence, full count
    expect(out[2]).toEqual({ representative: events[2], count: 1 })
  })

  it('leaves every other event type completely untouched, one entry each', () => {
    const events = [
      { id: 1, event_type: 'created' },
      { id: 2, event_type: 'evidence_added' },
      { id: 3, event_type: 'hypothesis_updated' },
    ]
    expect(collapseRepeatedTimelineEvents(events)).toEqual(events.map((e) => ({ representative: e, count: 1 })))
  })

  it('handles an empty array', () => {
    expect(collapseRepeatedTimelineEvents([])).toEqual([])
  })

  it('collapses predicted_incident_reviewed independently from attribution_recalculated - two separate groups', () => {
    const events = [
      { id: 1, event_type: 'predicted_incident_reviewed' },
      { id: 2, event_type: 'attribution_recalculated' },
      { id: 3, event_type: 'predicted_incident_reviewed' },
      { id: 4, event_type: 'attribution_recalculated' },
    ]
    const out = collapseRepeatedTimelineEvents(events)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ representative: events[2], count: 2 })
    expect(out[1]).toEqual({ representative: events[3], count: 2 })
  })
})

