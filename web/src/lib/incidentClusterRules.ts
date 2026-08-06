/**
 * Pure rules for the incident cluster and overlap-handling layer (Phase 1G).
 * No I/O — all inputs come from data already fetched by MapPage.tsx.
 * Mirrors the pattern of dataQualityRules.ts / mapRules.ts.
 */
import { ESCALATION_SLA_HOURS, SEVERITY_RANK, type Severity } from './incidentRules'
import type { Incident } from './incidents'
import type { SourceCategory } from './incidentRules'

// ── Constants ────────────────────────────────────────────────────────────────

/** MapLibre cluster: max zoom at which incidents are still merged.
 *  Above this zoom every incident renders individually.
 *  At this zoom, identical-coordinate incidents need spiderfy. */
export const INCIDENT_CLUSTER_MAX_ZOOM = 14

/** Pixel radius used for MapLibre GeoJSON cluster source. */
export const INCIDENT_CLUSTER_RADIUS = 50

/** Number of pixels each spiderfy arm extends from the stack centre. */
export const SPIDERFY_LEG_PX = 28

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClusterBreakdown {
  severe: number
  high: number
  moderate: number
  low: number
}

export interface ClusterPanelData {
  count: number
  highestSeverity: Severity | null
  breakdown: ClusterBreakdown
  /** Leading source categories across cluster members (deduped). */
  categories: SourceCategory[]
  /** Ward names represented in this cluster (deduped). */
  wardNames: string[]
  /** Age of the oldest open incident in minutes. */
  oldestOpenMinutes: number | null
  /** Incidents that have exceeded the 24-h escalation SLA. */
  overdueCount: number
  assignedCount: number
  unassignedCount: number
}

// ── Aggregation helpers ──────────────────────────────────────────────────────

/** Return the highest severity found, or null when all incidents lack one. */
export function highestSeverity(incidents: Pick<Incident, 'severity'>[]): Severity | null {
  let best: Severity | null = null
  let bestRank = -1
  for (const i of incidents) {
    const s = i.severity as Severity | null
    if (s == null) continue
    const r = SEVERITY_RANK[s] ?? -1
    if (r > bestRank) { bestRank = r; best = s }
  }
  return best
}

/** Count incidents per severity band. Null severity is counted as low. */
export function clusterBreakdown(incidents: Pick<Incident, 'severity'>[]): ClusterBreakdown {
  const out: ClusterBreakdown = { severe: 0, high: 0, moderate: 0, low: 0 }
  for (const i of incidents) {
    const s = i.severity as Severity | null
    if (s === 'severe') out.severe++
    else if (s === 'high') out.high++
    else if (s === 'moderate') out.moderate++
    else out.low++
  }
  return out
}

export function incidentAgeMinutes(createdAt: string, now = Date.now()): number {
  return (now - new Date(createdAt).getTime()) / 60_000
}

export function isIncidentOverdue(incident: Pick<Incident, 'created_at'>, now = Date.now()): boolean {
  return incidentAgeMinutes(incident.created_at, now) > ESCALATION_SLA_HOURS * 60
}

/** Full cluster panel data derived from a set of incidents.
 *  `leadingSourceById` comes from the MapPage's leading-source fetch — pass an
 *  empty Map when it hasn't resolved yet. `now` is injectable for tests. */
export function buildClusterPanelData(
  incidents: Incident[],
  leadingSourceById: Map<number, SourceCategory>,
  now = Date.now(),
): ClusterPanelData {
  const breakdown = clusterBreakdown(incidents)
  const hs = highestSeverity(incidents)

  const catSet = new Set<SourceCategory>()
  for (const i of incidents) {
    const cat = leadingSourceById.get(i.id)
    if (cat) catSet.add(cat)
  }

  const wardSet = new Set<string>()
  for (const i of incidents) {
    if (i.ward_name) wardSet.add(i.ward_name)
  }

  let oldestOpenMinutes: number | null = null
  let overdueCount = 0
  let assignedCount = 0
  let unassignedCount = 0

  for (const i of incidents) {
    const ageMin = incidentAgeMinutes(i.created_at, now)
    if (oldestOpenMinutes === null || ageMin > oldestOpenMinutes) oldestOpenMinutes = ageMin
    if (isIncidentOverdue(i, now)) overdueCount++
    if (i.assigned_authority) assignedCount++
    else unassignedCount++
  }

  return {
    count: incidents.length,
    highestSeverity: hs,
    breakdown,
    categories: [...catSet],
    wardNames: [...wardSet],
    oldestOpenMinutes,
    overdueCount,
    assignedCount,
    unassignedCount,
  }
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function fmtClusterAge(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / (24 * 60))}d`
}

/** HTML string for the cluster hover tooltip (rendered inside a MapLibre popup). */
export function clusterTooltipHtml(props: {
  point_count: number
  count_severe: number
  count_high: number
  count_moderate: number
  count_low: number
  max_age_minutes: number
}): string {
  const parts: string[] = []
  if (props.count_severe > 0) parts.push(`${props.count_severe} severe`)
  if (props.count_high > 0) parts.push(`${props.count_high} high`)
  if (props.count_moderate > 0) parts.push(`${props.count_moderate} moderate`)
  if (props.count_low > 0) parts.push(`${props.count_low} low`)
  const breakdown = parts.join(' · ')
  const age = fmtClusterAge(props.max_age_minutes)
  return (
    `<div style="font-size:13px;font-weight:600">${props.point_count} active incidents</div>` +
    (breakdown ? `<div style="font-size:12px;color:#555">${breakdown}</div>` : '') +
    `<div style="font-size:11px;color:#9ca3af">Oldest open: ${age}</div>`
  )
}

// ── Identical-coordinate detection ───────────────────────────────────────────

/** True when all points in a cluster share the same location within ε degrees.
 *  Used to decide whether a cluster click should zoom-in or spiderfy. */
export function areIdenticalCoords(
  coords: Array<[number, number]>,
  epsilon = 1e-6,
): boolean {
  if (coords.length <= 1) return true
  const [refLng, refLat] = coords[0]
  return coords.every(([lng, lat]) =>
    Math.abs(lng - refLng) < epsilon && Math.abs(lat - refLat) < epsilon,
  )
}

// ── Spiderfy geometry ────────────────────────────────────────────────────────

export interface SpiderfyLeg {
  incidentId: number
  /** Pixel offset from the stack centre [dx, dy]. */
  pixelOffset: [number, number]
}

/** Compute radial pixel offsets for N overlapping incidents.
 *  Returns legs in the same order as `incidentIds`. */
export function spiderfyLegs(incidentIds: number[], legPx = SPIDERFY_LEG_PX): SpiderfyLeg[] {
  const n = incidentIds.length
  const angleStep = (2 * Math.PI) / n
  // Start from the top (−π/2) and go clockwise so the first item is at 12 o'clock.
  const startAngle = -Math.PI / 2
  return incidentIds.map((id, i) => {
    const angle = startAngle + i * angleStep
    return {
      incidentId: id,
      pixelOffset: [Math.round(legPx * Math.cos(angle)), Math.round(legPx * Math.sin(angle))],
    }
  })
}
