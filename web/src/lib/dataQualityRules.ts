/**
 * Pure derivation rules for the Data Quality and Monitoring Coverage mode.
 * No I/O here — mirrors mapRules.ts's convention. Every input comes from
 * data already fetched by MapPage.tsx's existing queries.
 *
 * Ward coverage threshold (5 km) follows WMO/CPCB guidance for urban
 * air-quality monitoring density in dense environments. It is the maximum
 * straight-line distance at which a station can reasonably be considered
 * "supporting" a ward it is not directly assigned to. This constant is
 * documented and exported — callers can display it honestly rather than
 * showing a coverage classification without disclosing the basis.
 */
import type { StationMarker } from './data'
import type { Incident } from './incidents'
import type { StationHealthRow } from './ops'
import { isValidDelhiCoordinate, nearestStationTo } from './mapRules'

// ── Freshness classification ──────────────────────────────────────────────────

/** Reading is "fresh" when ageMinutes < this value. Aligns with typical
 *  CPCB/OpenAQ ingestion cadence (15-60 min averaging window). */
export const FRESH_THRESHOLD_MINUTES = 60

/** Readings older than this are "stale". Kept in sync with
 *  STATION_STALE_MINUTES in ops.ts (same semantic, separate constant to
 *  avoid a direct cross-module import). */
export const DELAYED_STALE_BOUNDARY_MINUTES = 180

export type FreshnessClass = 'fresh' | 'delayed' | 'stale' | 'no_reading' | 'unavailable'

export const FRESHNESS_LABEL: Record<FreshnessClass, string> = {
  fresh: 'Fresh',
  delayed: 'Delayed',
  stale: 'Stale',
  no_reading: 'No recent reading',
  unavailable: 'Unavailable',
}

/** Semantic colour per freshness state — not AQI severity colours, a
 *  distinct data-quality palette used only in quality mode. */
export const FRESHNESS_HEX: Record<FreshnessClass, string> = {
  fresh: '#22c55e',    // green-500
  delayed: '#f59e0b',  // amber-400
  stale: '#ef4444',    // red-500
  no_reading: '#94a3b8', // slate-400
  unavailable: '#cbd5e1', // slate-300
}

/** Classify a station's freshness.
 *  Order of precedence: unavailable (inactive) → no_reading → fresh →
 *  delayed → stale. An inactive station is never "fresh" even if a reading
 *  timestamp exists — it is not being actively sampled. */
export function stationFreshnessClass(row: StationHealthRow): FreshnessClass {
  if (!row.is_active) return 'unavailable'
  const age = row.latest_reading_age_minutes
  if (age == null) return 'no_reading'
  if (age < FRESH_THRESHOLD_MINUTES) return 'fresh'
  if (age < DELAYED_STALE_BOUNDARY_MINUTES) return 'delayed'
  return 'stale'
}

/** Human-readable age string for compact display contexts. */
export function formatReadingAge(ageMinutes: number | null): string {
  if (ageMinutes == null) return 'no readings'
  if (ageMinutes < 60) return `${ageMinutes}m ago`
  if (ageMinutes < 1440) return `${Math.round(ageMinutes / 60)}h ago`
  return `${Math.round(ageMinutes / 1440)}d ago`
}

// ── Ward coverage classification ──────────────────────────────────────────────

/** Maximum straight-line distance at which a station is counted as "nearby
 *  support" for a ward it is not directly assigned to. 5 km is consistent
 *  with WMO/CPCB guidance for dense urban monitoring networks. Exported so
 *  every caller can display the basis rather than hiding it. */
export const NEARBY_COVERAGE_THRESHOLD_METERS = 5_000

export type WardCoverageClass = 'direct' | 'nearby' | 'insufficient' | 'unavailable'

export const WARD_COVERAGE_LABEL: Record<WardCoverageClass, string> = {
  direct: 'Direct station coverage',
  nearby: 'Nearby support only',
  insufficient: 'Insufficient monitoring coverage',
  unavailable: 'Geometry or centroid unavailable',
}

/** Semantic colours for ward coverage fill — separate from AQI palette. */
export const WARD_COVERAGE_HEX: Record<WardCoverageClass, string> = {
  direct: '#2563eb',   // blue-600
  nearby: '#60a5fa',   // blue-400
  insufficient: '#f97316', // orange-500
  unavailable: '#94a3b8',  // slate-400
}

export interface WardCoverageDetail {
  class: WardCoverageClass
  /** Name of the directly assigned active station (class === 'direct'). */
  directStationName: string | null
  /** Distance to nearest active valid station (class === 'nearby'/'insufficient'). */
  nearestDistanceMeters: number | null
  /** Name of nearest active station. */
  nearestStationName: string | null
}

/** Classify a ward's monitoring-coverage state.
 *
 *  Priority: unavailable → direct → nearby → insufficient.
 *
 *  "Active" means StationHealthRow.is_active === true. An inactive station
 *  cannot supply data and must not count as coverage — this is stricter than
 *  the existing wardDataStatus() in mapRules.ts, which only asks whether data
 *  exists, not whether the producing station is still operational. */
export function classifyWardCoverage(
  ward: { id: number; lat: number | null; lng: number | null },
  stationHealth: StationHealthRow[],
  stations: StationMarker[],
): WardCoverageDetail {
  if (!isValidDelhiCoordinate(ward.lat, ward.lng)) {
    return { class: 'unavailable', directStationName: null, nearestDistanceMeters: null, nearestStationName: null }
  }

  const directHealth = stationHealth.find((s) => s.is_active && s.ward_id === ward.id)
  if (directHealth) {
    return {
      class: 'direct',
      directStationName: directHealth.name,
      nearestDistanceMeters: null,
      nearestStationName: directHealth.name,
    }
  }

  // Only active stations count toward nearby/insufficient coverage.
  const activeIds = new Set(stationHealth.filter((h) => h.is_active).map((h) => h.id))
  const activeStations = stations.filter((s) => activeIds.has(s.id))
  const nearest = nearestStationTo(ward.lat, ward.lng, activeStations)

  if (nearest && nearest.distanceMeters <= NEARBY_COVERAGE_THRESHOLD_METERS) {
    return {
      class: 'nearby',
      directStationName: null,
      nearestDistanceMeters: nearest.distanceMeters,
      nearestStationName: nearest.station.name,
    }
  }

  return {
    class: 'insufficient',
    directStationName: null,
    nearestDistanceMeters: nearest?.distanceMeters ?? null,
    nearestStationName: nearest?.station.name ?? null,
  }
}

// ── Incident coordinate audit ─────────────────────────────────────────────────

export interface IncidentCoordinateAudit {
  total: number
  /** Has a valid Delhi/NCR lat/lng. */
  spatiallyValid: number
  /** lat and lng are both null. */
  missingCoordinates: number
  /** Has lat/lng values but they fall outside the Delhi/NCR bounding box. */
  outsideBounds: number
  /** ward_id is set but coordinates are missing or outside bounds. */
  withWardButNoCoords: number
  /** Valid Delhi coordinates but no ward_id assignment. */
  withCoordsButNoWard: number
}

export function auditIncidentCoordinates(
  incidents: Pick<Incident, 'lat' | 'lng' | 'ward_id'>[],
): IncidentCoordinateAudit {
  let spatiallyValid = 0
  let missingCoordinates = 0
  let outsideBounds = 0
  let withWardButNoCoords = 0
  let withCoordsButNoWard = 0

  for (const i of incidents) {
    const hasCoords = i.lat != null && i.lng != null
    const hasWard = i.ward_id != null
    const validDelhi = isValidDelhiCoordinate(i.lat, i.lng)

    if (validDelhi) {
      spatiallyValid++
      if (!hasWard) withCoordsButNoWard++
    } else if (!hasCoords) {
      missingCoordinates++
      if (hasWard) withWardButNoCoords++
    } else {
      // Has coordinates but outside Delhi/NCR bounds
      outsideBounds++
      if (hasWard) withWardButNoCoords++
    }
  }

  return { total: incidents.length, spatiallyValid, missingCoordinates, outsideBounds, withWardButNoCoords, withCoordsButNoWard }
}

// ── Station quality rollup ────────────────────────────────────────────────────

export interface StationQualityRollup {
  total: number
  fresh: number
  delayed: number
  stale: number
  noReading: number
  unavailable: number
  /** ISO timestamp of the oldest latest_reading_at among active stations — or
   *  null if no active station has ever received a reading. */
  oldestActiveReadingAt: string | null
  /** ISO timestamp of the most recent latest_reading_at among active stations. */
  latestActiveReadingAt: string | null
}

export function rollupStationQuality(rows: StationHealthRow[]): StationQualityRollup {
  let fresh = 0, delayed = 0, stale = 0, noReading = 0, unavailable = 0
  let oldest: string | null = null
  let latest: string | null = null

  for (const r of rows) {
    const cls = stationFreshnessClass(r)
    if (cls === 'fresh') fresh++
    else if (cls === 'delayed') delayed++
    else if (cls === 'stale') stale++
    else if (cls === 'no_reading') noReading++
    else unavailable++

    if (r.is_active && r.latest_reading_at) {
      if (!oldest || r.latest_reading_at < oldest) oldest = r.latest_reading_at
      if (!latest || r.latest_reading_at > latest) latest = r.latest_reading_at
    }
  }

  return { total: rows.length, fresh, delayed, stale, noReading, unavailable, oldestActiveReadingAt: oldest, latestActiveReadingAt: latest }
}
