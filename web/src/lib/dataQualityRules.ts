/**
 * Pure derivation rules for the Data Quality and Monitoring Coverage mode.
 * No I/O here — mirrors mapRules.ts's convention. Every input comes from
 * data already fetched by MapPage.tsx's existing queries.
 *
 * Ward coverage threshold (5 km) is a configurable operational proximity rule:
 * the maximum straight-line distance at which an active station is considered
 * to "support" a ward it does not lie inside. It can be changed by adjusting
 * NEARBY_COVERAGE_THRESHOLD_METERS. This constant is exported so callers can
 * display the basis rather than showing coverage class without disclosure.
 */
import type { StationMarker } from './data'
import type { Incident } from './incidents'
import type { StationHealthRow } from './ops'
import { isValidDelhiCoordinate, nearestStationTo } from './mapRules'
import { pointInGeometry } from './incidentLocationRules'

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
  nearby: 'Nearby station proximity',
  insufficient: 'Insufficient monitoring coverage',
  unavailable: 'Geometry unavailable',
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

// ── Geometry centroid derivation ──────────────────────────────────────────────

/** Signed-area centroid of a single GeoJSON ring ([lng, lat] pairs).
 *  Returns null for degenerate rings (zero area, fewer than 3 points). */
function ringSignedAreaCentroid(ring: number[][]): { lng: number; lat: number; area: number } | null {
  const n = ring.length
  if (n < 3) return null
  let cx = 0, cy = 0, area = 0
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
    area += cross
    cx += (ring[j][0] + ring[i][0]) * cross
    cy += (ring[j][1] + ring[i][1]) * cross
  }
  area /= 2
  if (area === 0) return null
  return { lng: cx / (6 * area), lat: cy / (6 * area), area: Math.abs(area) }
}

/** Derive a representative interior point from GeoJSON polygon or multipolygon
 *  geometry. The returned point is suitable as a proximity reference for the
 *  5 km ward coverage threshold.
 *
 *  For Polygon: signed-area (shoelace) centroid of the exterior ring. If the
 *  centroid falls outside the polygon (possible for highly concave shapes), the
 *  bounding-box centre is returned as a best-effort interior approximation.
 *
 *  For MultiPolygon: centroid of the sub-polygon with the largest area. Using
 *  the area-weighted mean would place the reference point in empty space between
 *  disconnected sub-polygons (e.g. exclave wards), making distances meaningless.
 *
 *  Returns null only for genuinely degenerate geometry. */
export function geometryCentroid(
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): { lat: number; lng: number } | null {
  if (geometry.type === 'Polygon') {
    const c = ringSignedAreaCentroid(geometry.coordinates[0] as number[][])
    if (!c) return null
    const result = { lat: c.lat, lng: c.lng }
    // Concave ward: shoelace centroid may fall outside the polygon. Bounding-box
    // centre is a more robust fallback for the 5 km proximity threshold.
    if (!pointInGeometry(result.lat, result.lng, geometry)) {
      const ring = geometry.coordinates[0] as number[][]
      if (ring.length < 2) return null
      const lats = ring.map((p) => p[1])
      const lngs = ring.map((p) => p[0])
      return {
        lat: (Math.min(...lats) + Math.max(...lats)) / 2,
        lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
      }
    }
    return result
  }
  // MultiPolygon: centroid of the sub-polygon with the largest area.
  let largest: { lat: number; lng: number } | null = null
  let largestArea = 0
  for (const poly of geometry.coordinates as number[][][][]) {
    const c = ringSignedAreaCentroid(poly[0] as number[][])
    if (!c) continue
    if (c.area > largestArea) {
      largestArea = c.area
      largest = { lat: c.lat, lng: c.lng }
    }
  }
  return largest
}

// ── Ward coverage classification ───────────────────────────────────────────────

/** Classify a ward's monitoring-coverage state.
 *
 *  Priority: geometry unavailable → direct → nearby → insufficient.
 *
 *  Reference point: uses the stored lat/lng centroid when valid; derives one
 *  from the ward geometry when the stored centroid is absent (the common case
 *  for the 250 Phase-2 municipal wards that were imported without a centroid
 *  column). Falls back to geometry unavailable only when no reference point
 *  can be derived at all.
 *
 *  Direct coverage: checks whether any active station lies physically inside
 *  the ward polygon (point-in-polygon). Falls back to ward_id match only when
 *  no geometry is available, which allows the existing tests (which don't
 *  supply geometry) to continue passing unchanged.
 *
 *  "Active" means StationHealthRow.is_active === true. An inactive station
 *  cannot supply data and must not count toward coverage. */
export function classifyWardCoverage(
  ward: { id: number; lat: number | null; lng: number | null; geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon | null },
  stationHealth: StationHealthRow[],
  stations: StationMarker[],
): WardCoverageDetail {
  // Resolve a reference point: stored centroid → derived from geometry → fail
  let refLat = ward.lat
  let refLng = ward.lng
  if (!isValidDelhiCoordinate(refLat, refLng) && ward.geometry) {
    const derived = geometryCentroid(ward.geometry)
    if (derived) {
      refLat = derived.lat
      refLng = derived.lng
    }
  }

  // Only active stations with valid Delhi coordinates count toward any coverage class.
  const activeHealth = stationHealth.filter((h) => h.is_active)
  const activeIds = new Set(activeHealth.map((h) => h.id))
  const activeStations = stations.filter((s) => activeIds.has(s.id) && isValidDelhiCoordinate(s.lat, s.lng))

  // Direct coverage: physical containment via point-in-polygon (when geometry
  // is available), ward_id match as a fallback for callers that supply no geometry.
  if (ward.geometry) {
    for (const s of activeStations) {
      if (pointInGeometry(s.lat!, s.lng!, ward.geometry)) {
        const h = activeHealth.find((ah) => ah.id === s.id)
        const name = h?.name ?? s.name
        if (import.meta.env.DEV) {
          console.debug(`[dataQuality] Ward ${ward.id} direct: station "${name}" inside polygon`)
        }
        return { class: 'direct', directStationName: name, nearestDistanceMeters: null, nearestStationName: name }
      }
    }
  } else {
    const directHealth = stationHealth.find((h) => h.is_active && h.ward_id === ward.id)
    if (directHealth) {
      return { class: 'direct', directStationName: directHealth.name, nearestDistanceMeters: null, nearestStationName: directHealth.name }
    }
  }

  // No valid reference point → cannot compute any distance-based class
  if (!isValidDelhiCoordinate(refLat, refLng)) {
    if (import.meta.env.DEV) {
      console.warn(`[dataQuality] Ward ${ward.id} unavailable: no valid reference point`, {
        storedLat: ward.lat, storedLng: ward.lng,
        hasGeometry: ward.geometry != null,
        geometryType: ward.geometry?.type,
      })
    }
    return { class: 'unavailable', directStationName: null, nearestDistanceMeters: null, nearestStationName: null }
  }

  // Nearby / insufficient: straight-line distance from ward reference point
  const nearest = nearestStationTo(refLat, refLng, activeStations)
  if (nearest && nearest.distanceMeters <= NEARBY_COVERAGE_THRESHOLD_METERS) {
    return { class: 'nearby', directStationName: null, nearestDistanceMeters: nearest.distanceMeters, nearestStationName: nearest.station.name }
  }
  return { class: 'insufficient', directStationName: null, nearestDistanceMeters: nearest?.distanceMeters ?? null, nearestStationName: nearest?.station.name ?? null }
}

// ── Incident coordinate audit ─────────────────────────────────────────────────

export interface IncidentCoordinateAudit {
  total: number
  /** Has a valid Delhi/NCR lat/lng. */
  spatiallyValid: number
  /** lat and lng are both null (or (0,0) sentinel). */
  missingCoordinates: number
  /** Has lat/lng values but they fall outside the Delhi/NCR bounding box. */
  outsideBounds: number
  /** ward_id is set but coordinates are missing or outside bounds. */
  withWardButNoCoords: number
  /** Valid Delhi coordinates but no ward_id assignment. */
  withCoordsButNoWard: number
  /** coordinate_review_status = 'awaiting_review' — placed but not yet validated. */
  awaitingReview: number
}

export function auditIncidentCoordinates(
  incidents: Pick<Incident, 'lat' | 'lng' | 'ward_id' | 'coordinate_review_status'>[],
): IncidentCoordinateAudit {
  let spatiallyValid = 0
  let missingCoordinates = 0
  let outsideBounds = 0
  let withWardButNoCoords = 0
  let withCoordsButNoWard = 0
  let awaitingReview = 0

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

    if (i.coordinate_review_status === 'awaiting_review') awaitingReview++
  }

  return {
    total: incidents.length,
    spatiallyValid, missingCoordinates, outsideBounds,
    withWardButNoCoords, withCoordsButNoWard, awaitingReview,
  }
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
