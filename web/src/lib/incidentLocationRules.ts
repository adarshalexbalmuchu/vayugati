/**
 * Pure derivation rules for incident location quality and coordinate remediation.
 * No I/O — all inputs come from data already loaded by callers.
 *
 * Boundary definitions:
 *   DELHI_BOUNDS  — the existing box in mapRules.ts (76.7–77.7 lng, 28.2–29.0 lat),
 *                   used for map rendering gates.
 *   NCR_BOUNDS    — slightly larger box covering Gurugram, Noida, Faridabad, Ghaziabad.
 *                   A point inside NCR but outside Delhi is still an operationally
 *                   relevant location for this pilot; it is not rejected, but the UI
 *                   must state "Outside Delhi · inside NCR operating area" so a
 *                   reviewer makes an explicit, informed decision.
 *
 * Point-in-polygon algorithm: ray-casting (Jordan curve theorem). Handles both
 * GeoJSON Polygon and MultiPolygon. No external GIS library needed — ward
 * boundaries are already loaded as GeoJSON.Polygon | GeoJSON.MultiPolygon.
 */

import { haversineMeters } from './incidentRules'
import { isValidDelhiCoordinate } from './mapRules'
import type { WardBoundary } from './data'
import type { Incident } from './incidents'

// ── Operational boundary ──────────────────────────────────────────────────────

/** NCR operating area — covers Delhi + Gurugram/Noida/Faridabad/Ghaziabad.
 *  Broader than DELHI_BOUNDS; a point here is operationally relevant but
 *  must still be reviewed before acceptance. */
export const NCR_BOUNDS = { minLng: 76.5, maxLng: 78.0, minLat: 28.0, maxLat: 29.2 }

export function isWithinNcrBounds(lat: number, lng: number): boolean {
  return (
    lat >= NCR_BOUNDS.minLat && lat <= NCR_BOUNDS.maxLat &&
    lng >= NCR_BOUNDS.minLng && lng <= NCR_BOUNDS.maxLng
  )
}

// ── Coordinate location classification ───────────────────────────────────────

export type CoordinateLocation =
  | 'delhi'           // within DELHI_BOUNDS — plottable on the operational map
  | 'ncr_outside_delhi' // within NCR_BOUNDS but outside DELHI_BOUNDS
  | 'outside_ncr'     // completely outside the operating area
  | 'missing'         // null, NaN, or (0,0) sentinel
  | 'invalid'         // non-finite number

export function classifyCoordinateLocation(
  lat: number | null | undefined,
  lng: number | null | undefined,
): CoordinateLocation {
  if (lat == null || lng == null) return 'missing'
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'invalid'
  if (lat === 0 && lng === 0) return 'missing'  // (0,0) is a sentinel/default
  if (isValidDelhiCoordinate(lat, lng)) return 'delhi'
  if (isWithinNcrBounds(lat, lng)) return 'ncr_outside_delhi'
  return 'outside_ncr'
}

export function coordinateLocationLabel(loc: CoordinateLocation): string {
  switch (loc) {
    case 'delhi': return 'Within Delhi/NCR'
    case 'ncr_outside_delhi': return 'Outside Delhi · inside NCR operating area'
    case 'outside_ncr': return 'Outside the current operating area'
    case 'missing': return 'Coordinates missing'
    case 'invalid': return 'Invalid coordinate values'
  }
}

// ── Coordinate validation ─────────────────────────────────────────────────────

export interface CoordinateValidationResult {
  valid: boolean
  errors: string[]
  /** Whether the point is outside Delhi but within NCR — valid but needs confirmation. */
  requiresNcrConfirmation: boolean
}

export function validateCoordinates(
  lat: number | null | undefined,
  lng: number | null | undefined,
): CoordinateValidationResult {
  const errors: string[] = []

  if (lat == null || lng == null) {
    errors.push('Both latitude and longitude are required.')
    return { valid: false, errors, requiresNcrConfirmation: false }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    errors.push('Coordinates must be numeric.')
    return { valid: false, errors, requiresNcrConfirmation: false }
  }
  if (lat === 0 && lng === 0) {
    errors.push('(0, 0) is not a valid location.')
    return { valid: false, errors, requiresNcrConfirmation: false }
  }
  if (lat < -90 || lat > 90) errors.push(`Latitude ${lat.toFixed(5)} is outside the valid range −90 to 90.`)
  if (lng < -180 || lng > 180) errors.push(`Longitude ${lng.toFixed(5)} is outside the valid range −180 to 180.`)
  if (errors.length > 0) return { valid: false, errors, requiresNcrConfirmation: false }

  const loc = classifyCoordinateLocation(lat, lng)
  if (loc === 'outside_ncr') {
    errors.push(`Point (${lat.toFixed(5)}, ${lng.toFixed(5)}) is outside the current operating area.`)
    return { valid: false, errors, requiresNcrConfirmation: false }
  }

  return {
    valid: true,
    errors: [],
    requiresNcrConfirmation: loc === 'ncr_outside_delhi',
  }
}

/** Straight-line displacement between two coordinate pairs, in metres. */
export function coordinateDisplacementMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  return haversineMeters({ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 })
}

/** Threshold above which a move is flagged as "unusually large" for a warning. */
export const LARGE_DISPLACEMENT_WARNING_METERS = 5_000

// ── Point-in-polygon (ray casting) ───────────────────────────────────────────

function raycastInsideRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    // GeoJSON rings use [lng, lat] order
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

function pointInPolygonRings(lng: number, lat: number, rings: number[][][]): boolean {
  if (rings.length === 0) return false
  if (!raycastInsideRing(lng, lat, rings[0])) return false
  // Holes: a point inside a hole is outside the polygon
  for (let i = 1; i < rings.length; i++) {
    if (raycastInsideRing(lng, lat, rings[i])) return false
  }
  return true
}

export function pointInGeometry(
  lat: number,
  lng: number,
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): boolean {
  if (geometry.type === 'Polygon') {
    return pointInPolygonRings(lng, lat, geometry.coordinates as number[][][])
  }
  // MultiPolygon: point is inside if it falls inside ANY sub-polygon
  return (geometry.coordinates as number[][][][]).some((rings) =>
    pointInPolygonRings(lng, lat, rings as number[][][])
  )
}

/**
 * Returns the first ward whose boundary contains the point, or null.
 * Wards are checked in the order they appear in the array — if two boundaries
 * overlap (unlikely but possible at shared edges), the first match wins.
 */
export function findContainingWard(
  lat: number,
  lng: number,
  wards: Pick<WardBoundary, 'id' | 'name' | 'wardNumber' | 'geometry'>[],
): Pick<WardBoundary, 'id' | 'name' | 'wardNumber'> | null {
  for (const w of wards) {
    if (!w.geometry) continue
    if (pointInGeometry(lat, lng, w.geometry)) return { id: w.id, name: w.name, wardNumber: w.wardNumber }
  }
  return null
}

// ── Provenance / confidence types ─────────────────────────────────────────────

export type CoordinateSource =
  | 'device_captured'
  | 'citizen_submitted'
  | 'officer_captured'
  | 'manually_placed'
  | 'imported'
  | 'address_geocoded'
  | 'evidence_corrected'
  | 'unknown_legacy'
  | 'confirmed_existing'

export type CoordinateConfidence = 'unreviewed' | 'low' | 'medium' | 'verified'

export type CoordinateReviewStatus = 'unreviewed' | 'awaiting_review' | 'reviewed'

export type ReviewReason =
  | 'address_verified'
  | 'landmark_verified'
  | 'ward_officer_confirmation'
  | 'photo_or_evidence_verified'
  | 'reporter_confirmation'
  | 'existing_coordinates_corrected'
  | 'location_cleared'
  | 'location_confirmed'
  | 'other'

export const COORDINATE_SOURCE_LABEL: Record<CoordinateSource, string> = {
  device_captured: 'Device-captured (GPS)',
  citizen_submitted: 'Citizen-submitted coordinates',
  officer_captured: 'Officer-captured coordinates',
  manually_placed: 'Manually placed from description',
  imported: 'Imported from external system',
  address_geocoded: 'Address geocoded',
  evidence_corrected: 'Corrected from supporting evidence',
  unknown_legacy: 'Unknown legacy source',
  confirmed_existing: 'Existing coordinates confirmed',
}

export const COORDINATE_CONFIDENCE_LABEL: Record<CoordinateConfidence, string> = {
  unreviewed: 'Unreviewed',
  low: 'Low confidence',
  medium: 'Medium confidence',
  verified: 'Verified',
}

export const REVIEW_REASON_LABEL: Record<ReviewReason, string> = {
  address_verified: 'Address verified',
  landmark_verified: 'Landmark verified',
  ward_officer_confirmation: 'Ward officer confirmation',
  photo_or_evidence_verified: 'Photo or evidence verified',
  reporter_confirmation: 'Reporter confirmation',
  existing_coordinates_corrected: 'Existing coordinates corrected',
  location_cleared: 'Incorrect location cleared',
  location_confirmed: 'Existing location confirmed',
  other: 'Other (see note)',
}

// ── Location quality status (derived from incident fields) ────────────────────

/** The consolidated location quality status shown in panels and list badges. */
export type LocationQualityStatus =
  | 'verified'         // coordinate_review_status = 'reviewed' AND confidence = 'verified'
  | 'mapped'           // valid Delhi coordinates but not formally verified
  | 'needs_review'     // awaiting_review or low confidence
  | 'missing'          // no valid coordinates
  | 'outside_area'     // coordinates outside NCR operating area
  | 'ward_mismatch'    // valid coords but contained ward differs from assigned ward_id

export const LOCATION_QUALITY_LABEL: Record<LocationQualityStatus, string> = {
  verified: 'Verified',
  mapped: 'Mapped',
  needs_review: 'Needs review',
  missing: 'Missing',
  outside_area: 'Outside area',
  ward_mismatch: 'Ward mismatch',
}

export const LOCATION_QUALITY_HEX: Record<LocationQualityStatus, string> = {
  verified: '#22c55e',
  mapped: '#60a5fa',
  needs_review: '#f59e0b',
  missing: '#ef4444',
  outside_area: '#f97316',
  ward_mismatch: '#a855f7',
}

export interface LocationQualityDetail {
  status: LocationQualityStatus
  coordinateLocation: CoordinateLocation
  /** True when PIP puts the point in a different ward than incident.ward_id. */
  wardMismatch: boolean
  containingWardId: number | null
  containingWardName: string | null
  source: CoordinateSource | null
  confidence: CoordinateConfidence | null
  reviewStatus: CoordinateReviewStatus | null
  reviewedAt: string | null
}

/**
 * Derive the full location quality state for a single incident.
 *
 * `wardBoundaries` is optional: when omitted, ward mismatch detection is
 * skipped (status will never be 'ward_mismatch'). Pass the loaded boundaries
 * whenever PIP is available to get the complete picture.
 */
export function deriveLocationQuality(
  incident: Pick<
    Incident,
    'lat' | 'lng' | 'ward_id' |
    'coordinate_source' | 'coordinate_confidence' |
    'coordinate_review_status' | 'coordinate_reviewed_at'
  >,
  wardBoundaries?: Pick<WardBoundary, 'id' | 'name' | 'wardNumber' | 'geometry'>[],
): LocationQualityDetail {
  const source = (incident.coordinate_source ?? null) as CoordinateSource | null
  const confidence = (incident.coordinate_confidence ?? 'unreviewed') as CoordinateConfidence
  const reviewStatus = (incident.coordinate_review_status ?? 'unreviewed') as CoordinateReviewStatus

  const coordLoc = classifyCoordinateLocation(incident.lat, incident.lng)

  if (coordLoc === 'missing' || coordLoc === 'invalid') {
    return {
      status: 'missing', coordinateLocation: coordLoc,
      wardMismatch: false, containingWardId: null, containingWardName: null,
      source, confidence, reviewStatus, reviewedAt: incident.coordinate_reviewed_at ?? null,
    }
  }

  if (coordLoc === 'outside_ncr') {
    return {
      status: 'outside_area', coordinateLocation: coordLoc,
      wardMismatch: false, containingWardId: null, containingWardName: null,
      source, confidence, reviewStatus, reviewedAt: incident.coordinate_reviewed_at ?? null,
    }
  }

  // delhi or ncr_outside_delhi — run PIP if boundaries available
  let wardMismatch = false
  let containingWardId: number | null = null
  let containingWardName: string | null = null

  if (wardBoundaries && incident.lat != null && incident.lng != null) {
    const containing = findContainingWard(incident.lat, incident.lng, wardBoundaries)
    containingWardId = containing?.id ?? null
    containingWardName = containing?.name ?? null
    if (containing != null && incident.ward_id != null && containing.id !== incident.ward_id) {
      wardMismatch = true
    }
  }

  // Derive consolidated status
  let status: LocationQualityStatus
  if (wardMismatch) {
    status = 'ward_mismatch'
  } else if (reviewStatus === 'reviewed' && confidence === 'verified') {
    status = 'verified'
  } else if (reviewStatus === 'awaiting_review' || confidence === 'low') {
    status = 'needs_review'
  } else {
    status = 'mapped'
  }

  return {
    status, coordinateLocation: coordLoc,
    wardMismatch, containingWardId, containingWardName,
    source, confidence, reviewStatus,
    reviewedAt: incident.coordinate_reviewed_at ?? null,
  }
}

// ── Remediation category filter keys ─────────────────────────────────────────

/** URL filter keys used by /incidents/remediation?filter=X */
export type RemediationFilter =
  | 'missing'
  | 'outside_area'
  | 'ward_no_coords'
  | 'coords_no_ward'
  | 'ward_mismatch'
  | 'awaiting_review'
  | 'all_invalid'

export const REMEDIATION_FILTER_LABEL: Record<RemediationFilter, string> = {
  missing: 'Missing coordinates',
  outside_area: 'Outside operational bounds',
  ward_no_coords: 'Ward set but no coordinates',
  coords_no_ward: 'Coordinates but no ward',
  ward_mismatch: 'Ward–coordinate mismatch',
  awaiting_review: 'Awaiting review',
  all_invalid: 'All requiring attention',
}

/**
 * Returns true when an incident matches the given remediation filter.
 * Used client-side to filter the remediation queue without a round-trip.
 * `quality` should be pre-computed via `deriveLocationQuality`.
 */
export function matchesRemediationFilter(
  incident: Pick<Incident, 'lat' | 'lng' | 'ward_id' | 'coordinate_review_status'>,
  quality: LocationQualityDetail,
  filter: RemediationFilter,
): boolean {
  const hasValidCoords = quality.coordinateLocation === 'delhi' || quality.coordinateLocation === 'ncr_outside_delhi'
  const hasWard = incident.ward_id != null

  switch (filter) {
    case 'missing':
      return quality.coordinateLocation === 'missing' || quality.coordinateLocation === 'invalid'
    case 'outside_area':
      return quality.coordinateLocation === 'outside_ncr'
    case 'ward_no_coords':
      return hasWard && !hasValidCoords
    case 'coords_no_ward':
      return hasValidCoords && !hasWard
    case 'ward_mismatch':
      return quality.wardMismatch
    case 'awaiting_review':
      return (incident.coordinate_review_status ?? 'unreviewed') === 'awaiting_review'
    case 'all_invalid':
      return quality.status !== 'verified' && quality.status !== 'mapped'
  }
}
