import { describe, expect, it } from 'vitest'
import {
  areIdenticalCoords,
  buildClusterPanelData,
  clusterBreakdown,
  clusterTooltipHtml,
  fmtClusterAge,
  highestSeverity,
  spiderfyLegs,
} from './incidentClusterRules'
import type { Incident } from './incidents'
import type { SourceCategory } from './incidentRules'

// ── helpers ───────────────────────────────────────────────────────────────────

function inc(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 1,
    summary: 'Test incident',
    severity: 'moderate',
    status: 'detected',
    created_at: new Date(Date.now() - 60 * 60_000).toISOString(),  // 1h ago
    detected_at: new Date().toISOString(),
    detection_method: 'manual',
    updated_at: new Date().toISOString(),
    lat: 28.62,
    lng: 77.21,
    ward_id: 1,
    ward_name: 'Test Ward',
    assigned_authority: null,
    city_id: 1,
    classification: null,
    classification_note: null,
    classification_set_by: null,
    classification_source: null,
    classification_updated_at: null,
    closed_at: null,
    coordinate_confidence: null,
    coordinate_review_note: null,
    coordinate_review_reason: null,
    coordinate_review_status: null,
    coordinate_reviewed_at: null,
    coordinate_reviewed_by: null,
    coordinate_source: null,
    created_by: null,
    detection_stage: null,
    local_excess: null,
    merged_into_incident_id: null,
    primary_pollutant: null,
    recurrence_of_incident_id: null,
    source_confidence: 'suspected',
    ...overrides,
  } as Incident
}

// ── highestSeverity ───────────────────────────────────────────────────────────

describe('highestSeverity', () => {
  it('returns null for empty list', () => {
    expect(highestSeverity([])).toBeNull()
  })

  it('returns null when all severities are null', () => {
    expect(highestSeverity([inc({ severity: null }), inc({ severity: null })])).toBeNull()
  })

  it('picks the highest severity rank across mixed incidents', () => {
    const incidents = [inc({ severity: 'low' }), inc({ severity: 'severe' }), inc({ severity: 'moderate' })]
    expect(highestSeverity(incidents)).toBe('severe')
  })

  it('returns the sole severity when there is only one incident', () => {
    expect(highestSeverity([inc({ severity: 'high' })])).toBe('high')
  })

  it('ignores null severity entries when others are present', () => {
    expect(highestSeverity([inc({ severity: null }), inc({ severity: 'moderate' })])).toBe('moderate')
  })
})

// ── clusterBreakdown ──────────────────────────────────────────────────────────

describe('clusterBreakdown', () => {
  it('returns all zeros for an empty list', () => {
    expect(clusterBreakdown([])).toEqual({ severe: 0, high: 0, moderate: 0, low: 0 })
  })

  it('counts each band correctly', () => {
    const incidents = [
      inc({ severity: 'severe' }),
      inc({ severity: 'severe' }),
      inc({ severity: 'high' }),
      inc({ severity: 'moderate' }),
      inc({ severity: 'low' }),
      inc({ severity: null }),  // null counts as low
    ]
    expect(clusterBreakdown(incidents)).toEqual({ severe: 2, high: 1, moderate: 1, low: 2 })
  })

  it('counts null severity as low', () => {
    expect(clusterBreakdown([inc({ severity: null })])).toEqual({ severe: 0, high: 0, moderate: 0, low: 1 })
  })
})

// ── buildClusterPanelData ─────────────────────────────────────────────────────

describe('buildClusterPanelData', () => {
  const now = new Date('2026-08-06T12:00:00Z').getTime()
  const createdAt2hAgo = new Date(now - 2 * 3600_000).toISOString()
  const createdAt25hAgo = new Date(now - 25 * 3600_000).toISOString()  // overdue

  it('counts incidents and computes highest severity', () => {
    const incidents = [
      inc({ id: 1, severity: 'high', created_at: createdAt2hAgo, ward_name: 'Ward A' }),
      inc({ id: 2, severity: 'severe', created_at: createdAt2hAgo, ward_name: 'Ward B' }),
    ]
    const data = buildClusterPanelData(incidents, new Map(), now)
    expect(data.count).toBe(2)
    expect(data.highestSeverity).toBe('severe')
  })

  it('deduplicates ward names and source categories', () => {
    const incidents = [
      inc({ id: 1, ward_name: 'Rohini', created_at: createdAt2hAgo }),
      inc({ id: 2, ward_name: 'Rohini', created_at: createdAt2hAgo }),
      inc({ id: 3, ward_name: 'Dwarka', created_at: createdAt2hAgo }),
    ]
    const leadingSource = new Map<number, SourceCategory>([
      [1, 'vehicular'],
      [2, 'vehicular'],
      [3, 'construction_dust'],
    ])
    const data = buildClusterPanelData(incidents, leadingSource, now)
    expect(data.wardNames).toHaveLength(2)
    expect(data.categories).toHaveLength(2)
  })

  it('marks incidents beyond ESCALATION_SLA_HOURS as overdue', () => {
    const incidents = [
      inc({ id: 1, created_at: createdAt25hAgo }),  // overdue
      inc({ id: 2, created_at: createdAt2hAgo }),   // not overdue
    ]
    const data = buildClusterPanelData(incidents, new Map(), now)
    expect(data.overdueCount).toBe(1)
  })

  it('counts assigned and unassigned correctly', () => {
    const incidents = [
      inc({ id: 1, assigned_authority: 'DPCC', created_at: createdAt2hAgo }),
      inc({ id: 2, assigned_authority: null, created_at: createdAt2hAgo }),
      inc({ id: 3, assigned_authority: null, created_at: createdAt2hAgo }),
    ]
    const data = buildClusterPanelData(incidents, new Map(), now)
    expect(data.assignedCount).toBe(1)
    expect(data.unassignedCount).toBe(2)
  })

  it('oldest open minutes is the max age across all incidents', () => {
    const incidents = [
      inc({ id: 1, created_at: createdAt2hAgo }),
      inc({ id: 2, created_at: createdAt25hAgo }),
    ]
    const data = buildClusterPanelData(incidents, new Map(), now)
    expect(data.oldestOpenMinutes).toBeCloseTo(25 * 60, 0)
  })

  it('returns null oldestOpenMinutes for empty list', () => {
    const data = buildClusterPanelData([], new Map(), now)
    expect(data.oldestOpenMinutes).toBeNull()
    expect(data.count).toBe(0)
  })
})

// ── fmtClusterAge ─────────────────────────────────────────────────────────────

describe('fmtClusterAge', () => {
  it('returns minutes for < 1 hour', () => {
    expect(fmtClusterAge(45)).toBe('45m')
  })
  it('returns hours for 1 h to 24 h', () => {
    expect(fmtClusterAge(90)).toBe('2h')
  })
  it('returns days for >= 24 h', () => {
    expect(fmtClusterAge(48 * 60)).toBe('2d')
  })
})

// ── clusterTooltipHtml ────────────────────────────────────────────────────────

describe('clusterTooltipHtml', () => {
  it('includes the incident count', () => {
    const html = clusterTooltipHtml({ point_count: 7, count_severe: 1, count_high: 2, count_moderate: 3, count_low: 1, max_age_minutes: 120 })
    expect(html).toContain('7 active incidents')
  })

  it('includes severity breakdown', () => {
    const html = clusterTooltipHtml({ point_count: 3, count_severe: 0, count_high: 1, count_moderate: 2, count_low: 0, max_age_minutes: 60 })
    expect(html).toContain('1 high')
    expect(html).toContain('2 moderate')
    expect(html).not.toContain('severe')
  })

  it('includes oldest open age', () => {
    const html = clusterTooltipHtml({ point_count: 2, count_severe: 0, count_high: 0, count_moderate: 2, count_low: 0, max_age_minutes: 90 })
    expect(html).toContain('Oldest open: 2h')
  })

  it('omits zero-count severity bands', () => {
    const html = clusterTooltipHtml({ point_count: 1, count_severe: 0, count_high: 0, count_moderate: 0, count_low: 1, max_age_minutes: 30 })
    expect(html).not.toContain('high')
    expect(html).not.toContain('moderate')
  })
})

// ── areIdenticalCoords ────────────────────────────────────────────────────────

describe('areIdenticalCoords', () => {
  it('returns true for a single point', () => {
    expect(areIdenticalCoords([[77.21, 28.62]])).toBe(true)
  })

  it('returns true for an empty list', () => {
    expect(areIdenticalCoords([])).toBe(true)
  })

  it('returns true when all coords are identical', () => {
    expect(areIdenticalCoords([[77.21, 28.62], [77.21, 28.62], [77.21, 28.62]])).toBe(true)
  })

  it('returns false when coords differ by more than epsilon', () => {
    expect(areIdenticalCoords([[77.21, 28.62], [77.22, 28.63]])).toBe(false)
  })

  it('respects epsilon — tiny differences within epsilon are treated as identical', () => {
    expect(areIdenticalCoords([[77.21, 28.62], [77.21 + 1e-7, 28.62 + 1e-7]], 1e-6)).toBe(true)
  })
})

// ── spiderfyLegs ─────────────────────────────────────────────────────────────

describe('spiderfyLegs', () => {
  it('returns one leg per incident', () => {
    const legs = spiderfyLegs([10, 20, 30])
    expect(legs).toHaveLength(3)
    expect(legs.map((l) => l.incidentId)).toEqual([10, 20, 30])
  })

  it('distributes legs evenly around a circle', () => {
    const legs = spiderfyLegs([1, 2, 3, 4], 30)
    const angles = legs.map((l) => Math.atan2(l.pixelOffset[1], l.pixelOffset[0]))
    // Angle differences should all be approximately 90° (π/2)
    const diffs = angles.slice(1).map((a, i) => a - angles[i])
    for (const d of diffs) expect(Math.abs(d - Math.PI / 2)).toBeLessThan(0.01)
  })

  it('first leg is at the top (12 oclock = negative y offset)', () => {
    const legs = spiderfyLegs([99], 28)
    expect(legs[0].pixelOffset[0]).toBe(0)   // x ≈ 0
    expect(legs[0].pixelOffset[1]).toBe(-28)  // y is negative (up)
  })

  it('returns an empty array for empty input', () => {
    expect(spiderfyLegs([])).toHaveLength(0)
  })

  it('one incident gets the single top-centre position', () => {
    const legs = spiderfyLegs([42], 30)
    expect(legs[0].pixelOffset).toEqual([0, -30])
  })
})
