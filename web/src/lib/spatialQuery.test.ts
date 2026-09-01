import { describe, expect, it } from 'vitest'
import { findWithinRadius, matchesThreshold, type RadiusQueryIncident, type RadiusQueryStation, type RadiusQueryWard } from './spatialQuery'

// Anand Vihar-ish center. ~0.01deg lat ≈ 1.1km, ~0.05deg ≈ 5.5km at this latitude.
const CENTER: [number, number] = [77.21, 28.62]

function ward(overrides: Partial<RadiusQueryWard> = {}): RadiusQueryWard {
  return { id: 1, name: 'Test Ward', lat: 28.62, lng: 77.21, ...overrides }
}

function station(overrides: Partial<RadiusQueryStation> = {}): RadiusQueryStation {
  return { id: 1, name: 'Test Station', lat: 28.62, lng: 77.21, ...overrides }
}

function incident(overrides: Partial<RadiusQueryIncident> = {}): RadiusQueryIncident {
  return { id: 1, lat: 28.62, lng: 77.21, summary: 'Test incident', ...overrides }
}

describe('findWithinRadius', () => {
  it('matches a station inside the radius and excludes one outside it', () => {
    const near = station({ id: 1, name: 'Near', lat: 28.63, lng: 77.21 }) // ~1.1km
    const far = station({ id: 2, name: 'Far', lat: 28.67, lng: 77.21 }) // ~5.5km
    const result = findWithinRadius(CENTER, 2, {
      wards: [],
      stations: [near, far],
      incidents: [],
      wardBoundaryByWardId: new Map(),
    })
    expect(result.stations.map((s) => s.id)).toEqual([1])
  })

  it('matches an incident purely by point distance', () => {
    const near = incident({ id: 1, lat: 28.625, lng: 77.21 })
    const far = incident({ id: 2, lat: 28.7, lng: 77.21 })
    const result = findWithinRadius(CENTER, 2, {
      wards: [],
      stations: [],
      incidents: [near, far],
      wardBoundaryByWardId: new Map(),
    })
    expect(result.incidents.map((i) => i.id)).toEqual([1])
  })

  it('falls back to centroid distance for a ward with no captured boundary', () => {
    const near = ward({ id: 1, lat: 28.625, lng: 77.21 })
    const far = ward({ id: 2, lat: 28.7, lng: 77.21 })
    const result = findWithinRadius(CENTER, 2, {
      wards: [near, far],
      stations: [],
      incidents: [],
      wardBoundaryByWardId: new Map(),
    })
    expect(result.wards.map((w) => w.id)).toEqual([1])
  })

  it('uses real polygon intersection for a ward whose boundary is captured, even if its centroid sits outside the radius', () => {
    // Ward centroid is ~5.5km away (outside a 2km radius), but its boundary
    // polygon stretches back to overlap the circle - true GIS "select by
    // location" should still match it, unlike a naive centroid-only check.
    const farCentroidWard = ward({ id: 1, lat: 28.67, lng: 77.21 })
    const boundary: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [77.205, 28.615],
          [77.215, 28.615],
          [77.215, 28.68],
          [77.205, 28.68],
          [77.205, 28.615],
        ],
      ],
    }
    const result = findWithinRadius(CENTER, 2, {
      wards: [farCentroidWard],
      stations: [],
      incidents: [],
      wardBoundaryByWardId: new Map([[1, boundary]]),
    })
    expect(result.wards.map((w) => w.id)).toEqual([1])
  })

  it('excludes a ward whose boundary genuinely does not reach the circle', () => {
    const distantWard = ward({ id: 1, lat: 29.0, lng: 77.21 })
    const boundary: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [77.2, 28.99],
          [77.22, 28.99],
          [77.22, 29.01],
          [77.2, 29.01],
          [77.2, 28.99],
        ],
      ],
    }
    const result = findWithinRadius(CENTER, 2, {
      wards: [distantWard],
      stations: [],
      incidents: [],
      wardBoundaryByWardId: new Map([[1, boundary]]),
    })
    expect(result.wards).toEqual([])
  })

  it('excludes points with missing coordinates rather than throwing', () => {
    const noCoords = station({ id: 1, lat: null as unknown as number, lng: null as unknown as number })
    const result = findWithinRadius(CENTER, 2, {
      wards: [],
      stations: [noCoords],
      incidents: [],
      wardBoundaryByWardId: new Map(),
    })
    expect(result.stations).toEqual([])
  })
})

describe('matchesThreshold', () => {
  it.each([
    ['>', 250, 200, true],
    ['>', 150, 200, false],
    ['>=', 200, 200, true],
    ['<', 150, 200, true],
    ['<', 250, 200, false],
    ['<=', 200, 200, true],
  ] as const)('%s %d vs %d -> %s', (op, value, threshold, expected) => {
    expect(matchesThreshold(value, op, threshold)).toBe(expected)
  })

  it('returns false for a null or undefined value', () => {
    expect(matchesThreshold(null, '>', 100)).toBe(false)
    expect(matchesThreshold(undefined, '>', 100)).toBe(false)
  })
})
