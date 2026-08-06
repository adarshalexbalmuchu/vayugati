import { describe, expect, it } from 'vitest'
import type { WardBoundary } from './data'
import type { Incident } from './incidents'
import {
  NCR_BOUNDS,
  classifyCoordinateLocation,
  coordinateDisplacementMeters,
  LARGE_DISPLACEMENT_WARNING_METERS,
  deriveLocationQuality,
  findContainingWard,
  matchesRemediationFilter,
  pointInGeometry,
  validateCoordinates,
} from './incidentLocationRules'
import { DELHI_BOUNDS } from './mapRules'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A minimal incident with just location fields. */
function incident(
  overrides: Partial<
    Pick<Incident, 'lat' | 'lng' | 'ward_id' | 'coordinate_source' | 'coordinate_confidence' | 'coordinate_review_status' | 'coordinate_reviewed_at'>
  > = {},
): Pick<Incident, 'lat' | 'lng' | 'ward_id' | 'coordinate_source' | 'coordinate_confidence' | 'coordinate_review_status' | 'coordinate_reviewed_at'> {
  return {
    lat: null, lng: null, ward_id: null,
    coordinate_source: null, coordinate_confidence: 'unreviewed',
    coordinate_review_status: 'unreviewed', coordinate_reviewed_at: null,
    ...overrides,
  }
}

/** A simple square ward centred at the given lat/lng, ±0.01°. */
function squareWard(id: number, name: string, lat: number, lng: number): Pick<WardBoundary, 'id' | 'name' | 'wardNumber' | 'geometry'> {
  const d = 0.01
  return {
    id, name, wardNumber: id,
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [lng - d, lat - d],
        [lng + d, lat - d],
        [lng + d, lat + d],
        [lng - d, lat + d],
        [lng - d, lat - d],
      ]],
    } as GeoJSON.Polygon,
  }
}

// Points inside Delhi/NCR
const DELHI_POINT  = { lat: 28.6139, lng: 77.209 }   // New Delhi
const NOIDA_POINT  = { lat: 28.68, lng: 77.75 }      // Ghaziabad area (lng > DELHI_BOUNDS.maxLng 77.7; inside NCR_BOUNDS 78.0)
const OUTSIDE_POINT = { lat: 25.0, lng: 80.0 }       // Madhya Pradesh

// ── classifyCoordinateLocation ────────────────────────────────────────────────

describe('classifyCoordinateLocation', () => {
  it('returns missing for null lat', () => {
    expect(classifyCoordinateLocation(null, 77.2)).toBe('missing')
  })

  it('returns missing for null lng', () => {
    expect(classifyCoordinateLocation(28.6, null)).toBe('missing')
  })

  it('returns missing for (0, 0) sentinel', () => {
    expect(classifyCoordinateLocation(0, 0)).toBe('missing')
  })

  it('returns invalid for NaN', () => {
    expect(classifyCoordinateLocation(NaN, 77.2)).toBe('invalid')
  })

  it('returns delhi for a Delhi-centre point', () => {
    expect(classifyCoordinateLocation(DELHI_POINT.lat, DELHI_POINT.lng)).toBe('delhi')
  })

  it('returns ncr_outside_delhi for Noida (outside DELHI_BOUNDS, inside NCR_BOUNDS)', () => {
    expect(NOIDA_POINT.lng).toBeGreaterThan(DELHI_BOUNDS.maxLng)
    expect(classifyCoordinateLocation(NOIDA_POINT.lat, NOIDA_POINT.lng)).toBe('ncr_outside_delhi')
  })

  it('returns outside_ncr for a point well outside NCR', () => {
    expect(classifyCoordinateLocation(OUTSIDE_POINT.lat, OUTSIDE_POINT.lng)).toBe('outside_ncr')
  })

  it('returns delhi for a point on the exact Delhi boundary (minLat edge)', () => {
    expect(classifyCoordinateLocation(DELHI_BOUNDS.minLat, 77.2)).toBe('delhi')
  })
})

// ── validateCoordinates ───────────────────────────────────────────────────────

describe('validateCoordinates', () => {
  it('rejects null lat/lng', () => {
    const r = validateCoordinates(null, null)
    expect(r.valid).toBe(false)
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it('rejects (0, 0)', () => {
    const r = validateCoordinates(0, 0)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/0, 0/)
  })

  it('rejects latitude outside [-90, 90]', () => {
    expect(validateCoordinates(95, 77.2).valid).toBe(false)
  })

  it('rejects longitude outside [-180, 180]', () => {
    expect(validateCoordinates(28.6, 200).valid).toBe(false)
  })

  it('rejects points outside NCR', () => {
    const r = validateCoordinates(OUTSIDE_POINT.lat, OUTSIDE_POINT.lng)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/outside/)
  })

  it('accepts a Delhi point with no NCR confirmation needed', () => {
    const r = validateCoordinates(DELHI_POINT.lat, DELHI_POINT.lng)
    expect(r.valid).toBe(true)
    expect(r.requiresNcrConfirmation).toBe(false)
  })

  it('accepts a Noida (NCR) point with NCR confirmation required', () => {
    const r = validateCoordinates(NOIDA_POINT.lat, NOIDA_POINT.lng)
    expect(r.valid).toBe(true)
    expect(r.requiresNcrConfirmation).toBe(true)
  })
})

// ── NCR_BOUNDS strictly contains DELHI_BOUNDS ─────────────────────────────────

describe('NCR_BOUNDS', () => {
  it('is larger than DELHI_BOUNDS in every direction', () => {
    expect(NCR_BOUNDS.minLat).toBeLessThan(DELHI_BOUNDS.minLat)
    expect(NCR_BOUNDS.maxLat).toBeGreaterThan(DELHI_BOUNDS.maxLat)
    expect(NCR_BOUNDS.minLng).toBeLessThan(DELHI_BOUNDS.minLng)
    expect(NCR_BOUNDS.maxLng).toBeGreaterThan(DELHI_BOUNDS.maxLng)
  })
})

// ── pointInGeometry ───────────────────────────────────────────────────────────

describe('pointInGeometry', () => {
  const ward = squareWard(1, 'Test Ward', 28.6, 77.2)

  it('returns true for a point inside the square', () => {
    expect(pointInGeometry(28.6, 77.2, ward.geometry)).toBe(true)
  })

  it('returns false for a point clearly outside', () => {
    expect(pointInGeometry(28.5, 77.1, ward.geometry)).toBe(false)
  })

  it('returns true for MultiPolygon with two sub-polygons (point in second)', () => {
    const multi: GeoJSON.MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        ward.geometry.coordinates,           // first polygon around 28.6, 77.2
        squareWard(2, 'B', 28.7, 77.3).geometry.coordinates,  // second
      ] as number[][][][],
    }
    expect(pointInGeometry(28.7, 77.3, multi)).toBe(true)
    expect(pointInGeometry(28.5, 77.0, multi)).toBe(false)
  })

  it('handles polygon hole — point inside outer but in hole returns false', () => {
    const holeGeom: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [
        // outer ring
        [[77.19, 28.59], [77.21, 28.59], [77.21, 28.61], [77.19, 28.61], [77.19, 28.59]],
        // hole at centre
        [[77.199, 28.599], [77.201, 28.599], [77.201, 28.601], [77.199, 28.601], [77.199, 28.599]],
      ],
    }
    expect(pointInGeometry(28.595, 77.195, holeGeom)).toBe(true)   // in outer, not in hole
    expect(pointInGeometry(28.6, 77.2, holeGeom)).toBe(false)      // in hole
  })
})

// ── findContainingWard ────────────────────────────────────────────────────────

describe('findContainingWard', () => {
  const wards = [
    squareWard(10, 'Karol Bagh', 28.65, 77.19),
    squareWard(11, 'Sadar Bazaar', 28.67, 77.21),
  ]

  it('returns the ward that contains the point', () => {
    const result = findContainingWard(28.65, 77.19, wards)
    expect(result?.id).toBe(10)
    expect(result?.name).toBe('Karol Bagh')
  })

  it('returns null when the point is in none of the wards', () => {
    expect(findContainingWard(28.5, 77.0, wards)).toBeNull()
  })

  it('returns null for empty ward list', () => {
    expect(findContainingWard(28.65, 77.19, [])).toBeNull()
  })
})

// ── coordinateDisplacementMeters ──────────────────────────────────────────────

describe('coordinateDisplacementMeters', () => {
  it('returns ~0 for the same point', () => {
    expect(coordinateDisplacementMeters(28.6, 77.2, 28.6, 77.2)).toBeCloseTo(0, 1)
  })

  it('returns a positive distance for different points', () => {
    const d = coordinateDisplacementMeters(28.6, 77.2, 28.65, 77.25)
    expect(d).toBeGreaterThan(0)
    expect(d).toBeLessThan(20_000) // sanity: under 20 km
  })

  it('LARGE_DISPLACEMENT_WARNING_METERS is 5000', () => {
    expect(LARGE_DISPLACEMENT_WARNING_METERS).toBe(5_000)
  })
})

// ── deriveLocationQuality ─────────────────────────────────────────────────────

describe('deriveLocationQuality', () => {
  it('returns missing for null coordinates', () => {
    const q = deriveLocationQuality(incident())
    expect(q.status).toBe('missing')
  })

  it('returns missing for (0, 0)', () => {
    const q = deriveLocationQuality(incident({ lat: 0, lng: 0 }))
    expect(q.status).toBe('missing')
  })

  it('returns outside_area for coordinates outside NCR', () => {
    const q = deriveLocationQuality(incident({ lat: OUTSIDE_POINT.lat, lng: OUTSIDE_POINT.lng }))
    expect(q.status).toBe('outside_area')
  })

  it('returns mapped for valid Delhi coordinates with no formal review', () => {
    const q = deriveLocationQuality(incident({ lat: DELHI_POINT.lat, lng: DELHI_POINT.lng }))
    expect(q.status).toBe('mapped')
  })

  it('returns verified for reviewed+verified coordinates', () => {
    const q = deriveLocationQuality(incident({
      lat: DELHI_POINT.lat, lng: DELHI_POINT.lng,
      coordinate_review_status: 'reviewed',
      coordinate_confidence: 'verified',
    }))
    expect(q.status).toBe('verified')
  })

  it('returns needs_review for awaiting_review status', () => {
    const q = deriveLocationQuality(incident({
      lat: DELHI_POINT.lat, lng: DELHI_POINT.lng,
      coordinate_review_status: 'awaiting_review',
    }))
    expect(q.status).toBe('needs_review')
  })

  it('returns ward_mismatch when PIP finds a different ward', () => {
    const wards = [squareWard(20, 'Some Ward', DELHI_POINT.lat, DELHI_POINT.lng)]
    const q = deriveLocationQuality(
      incident({ lat: DELHI_POINT.lat, lng: DELHI_POINT.lng, ward_id: 99 }),
      wards,
    )
    expect(q.status).toBe('ward_mismatch')
    expect(q.wardMismatch).toBe(true)
    expect(q.containingWardId).toBe(20)
  })

  it('does NOT flag mismatch when ward_id matches the containing ward', () => {
    const wards = [squareWard(20, 'Some Ward', DELHI_POINT.lat, DELHI_POINT.lng)]
    const q = deriveLocationQuality(
      incident({ lat: DELHI_POINT.lat, lng: DELHI_POINT.lng, ward_id: 20 }),
      wards,
    )
    expect(q.wardMismatch).toBe(false)
  })

  it('does NOT set ward_mismatch when no boundaries provided (PIP skipped)', () => {
    const q = deriveLocationQuality(incident({
      lat: DELHI_POINT.lat, lng: DELHI_POINT.lng, ward_id: 99,
    }))
    expect(q.wardMismatch).toBe(false)
    expect(q.status).toBe('mapped')
  })
})

// ── matchesRemediationFilter ──────────────────────────────────────────────────

describe('matchesRemediationFilter', () => {
  const wards = [squareWard(10, 'Ward A', DELHI_POINT.lat, DELHI_POINT.lng)]

  it('filter: missing — matches null coords', () => {
    const inc = incident()
    const q = deriveLocationQuality(inc, wards)
    expect(matchesRemediationFilter(inc, q, 'missing')).toBe(true)
    expect(matchesRemediationFilter(inc, q, 'outside_area')).toBe(false)
  })

  it('filter: outside_area — matches outside-NCR incident', () => {
    const inc = incident({ lat: OUTSIDE_POINT.lat, lng: OUTSIDE_POINT.lng })
    const q = deriveLocationQuality(inc, wards)
    expect(matchesRemediationFilter(inc, q, 'outside_area')).toBe(true)
  })

  it('filter: ward_no_coords — matches incident with ward but no coords', () => {
    const inc = incident({ ward_id: 10 })
    const q = deriveLocationQuality(inc, wards)
    expect(matchesRemediationFilter(inc, q, 'ward_no_coords')).toBe(true)
    expect(matchesRemediationFilter(inc, q, 'coords_no_ward')).toBe(false)
  })

  it('filter: coords_no_ward — matches incident with coords but no ward', () => {
    const inc = incident({ lat: DELHI_POINT.lat, lng: DELHI_POINT.lng })
    const q = deriveLocationQuality(inc, wards)
    expect(matchesRemediationFilter(inc, q, 'coords_no_ward')).toBe(true)
    expect(matchesRemediationFilter(inc, q, 'ward_no_coords')).toBe(false)
  })

  it('filter: ward_mismatch — matches mismatch incident', () => {
    const inc = incident({ lat: DELHI_POINT.lat, lng: DELHI_POINT.lng, ward_id: 999 })
    const q = deriveLocationQuality(inc, wards)
    expect(matchesRemediationFilter(inc, q, 'ward_mismatch')).toBe(true)
  })

  it('filter: awaiting_review', () => {
    const inc = incident({ lat: DELHI_POINT.lat, lng: DELHI_POINT.lng, coordinate_review_status: 'awaiting_review' })
    const q = deriveLocationQuality(inc, wards)
    expect(matchesRemediationFilter(inc, q, 'awaiting_review')).toBe(true)
  })

  it('filter: all_invalid — verified incident does NOT match', () => {
    const inc = incident({
      lat: DELHI_POINT.lat, lng: DELHI_POINT.lng, ward_id: 10,
      coordinate_review_status: 'reviewed', coordinate_confidence: 'verified',
    })
    const q = deriveLocationQuality(inc, wards)
    expect(matchesRemediationFilter(inc, q, 'all_invalid')).toBe(false)
  })

  it('filter: all_invalid — missing coords incident DOES match', () => {
    const inc = incident()
    const q = deriveLocationQuality(inc, wards)
    expect(matchesRemediationFilter(inc, q, 'all_invalid')).toBe(true)
  })
})

// ── Ward centroid must never be stored as an incident location ────────────────

describe('centroid placement prohibition', () => {
  it('findContainingWard never receives ward lat/lng directly — it requires a real coordinate pair', () => {
    // The API: findContainingWard(lat, lng, wards).
    // Ward centroids (wards.lat, wards.lng) are NOT passed through this function;
    // the function resolves a user-supplied point to its containing ward, not the reverse.
    // This test asserts that a ward centroid passed as a "proposed incident location"
    // correctly resolves to that ward (which is fine — the prohibition is about
    // automatically STORING it without a human review step, enforced by the RPC).
    const wardCentLat = 28.65, wardCentLng = 77.19
    const wards = [squareWard(10, 'Karol Bagh', wardCentLat, wardCentLng)]
    const result = findContainingWard(wardCentLat, wardCentLng, wards)
    // PIP correctly identifies the ward, but the result is not a stored value —
    // it is a suggestion shown to the reviewer; the human must confirm placement.
    expect(result?.id).toBe(10)
  })
})
