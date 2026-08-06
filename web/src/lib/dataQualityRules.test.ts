import { describe, expect, it } from 'vitest'
import {
  auditIncidentCoordinates,
  classifyWardCoverage,
  DELAYED_STALE_BOUNDARY_MINUTES,
  formatReadingAge,
  FRESH_THRESHOLD_MINUTES,
  geometryCentroid,
  NEARBY_COVERAGE_THRESHOLD_METERS,
  rollupStationQuality,
  stationFreshnessClass,
} from './dataQualityRules'
import type { StationMarker } from './data'
import type { StationHealthRow } from './ops'

// ── Geometry test helpers ────────────────────────────────────────────────────

/** Square ward polygon centered at (centerLat, centerLng). GeoJSON uses
 *  [lng, lat] coordinate order. halfDeg ≈ 0.02° ≈ ~2.2 km at Delhi latitude. */
function squarePolygon(centerLat: number, centerLng: number, halfDeg = 0.02): GeoJSON.Polygon {
  const n = centerLat + halfDeg, s = centerLat - halfDeg
  const e = centerLng + halfDeg, w = centerLng - halfDeg
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }
}

/** Square ward with a concentric square hole. Station at center is in the hole. */
function polygonWithHole(centerLat: number, centerLng: number, outerDeg = 0.02, holeDeg = 0.01): GeoJSON.Polygon {
  const on = centerLat + outerDeg, os = centerLat - outerDeg, oe = centerLng + outerDeg, ow = centerLng - outerDeg
  const hn = centerLat + holeDeg, hs = centerLat - holeDeg, he = centerLng + holeDeg, hw = centerLng - holeDeg
  return {
    type: 'Polygon',
    coordinates: [
      [[ow, os], [oe, os], [oe, on], [ow, on], [ow, os]],
      [[hw, hs], [he, hs], [he, hn], [hw, hn], [hw, hs]],
    ],
  }
}

/** MultiPolygon with two separate square sub-polygons (e.g. an exclave ward). */
function twoPartMultiPolygon(lat1: number, lng1: number, lat2: number, lng2: number, halfDeg = 0.02): GeoJSON.MultiPolygon {
  const ring = (lat: number, lng: number) => {
    const n = lat + halfDeg, s = lat - halfDeg, e = lng + halfDeg, w = lng - halfDeg
    return [[w, s], [e, s], [e, n], [w, n], [w, s]]
  }
  return { type: 'MultiPolygon', coordinates: [[ring(lat1, lng1)], [ring(lat2, lng2)]] }
}

function healthRow(overrides: Partial<StationHealthRow> = {}): StationHealthRow {
  return {
    id: 1,
    name: 'Test Station',
    ward_id: null,
    ward_name: null,
    sensor_type: 'dpcc',
    is_active: true,
    latest_reading_at: new Date().toISOString(),
    latest_reading_age_minutes: 30,
    is_stale: false,
    ...overrides,
  }
}

function station(overrides: Partial<StationMarker> = {}): StationMarker {
  return { id: 1, name: 'Test Station', lat: 28.6139, lng: 77.209, aqi: null, pm25: null, pm10: null, no2: null, ...overrides }
}

// ── stationFreshnessClass ────────────────────────────────────────────────────

describe('stationFreshnessClass', () => {
  it('is unavailable when the station is inactive, regardless of reading age', () => {
    expect(stationFreshnessClass(healthRow({ is_active: false, latest_reading_age_minutes: 10 }))).toBe('unavailable')
    expect(stationFreshnessClass(healthRow({ is_active: false, latest_reading_age_minutes: null }))).toBe('unavailable')
  })

  it('is no_reading when active but latest_reading_age_minutes is null', () => {
    expect(stationFreshnessClass(healthRow({ latest_reading_age_minutes: null }))).toBe('no_reading')
  })

  it('is fresh when age < FRESH_THRESHOLD_MINUTES', () => {
    expect(stationFreshnessClass(healthRow({ latest_reading_age_minutes: 0 }))).toBe('fresh')
    expect(stationFreshnessClass(healthRow({ latest_reading_age_minutes: FRESH_THRESHOLD_MINUTES - 1 }))).toBe('fresh')
  })

  it('is delayed at exactly FRESH_THRESHOLD_MINUTES', () => {
    expect(stationFreshnessClass(healthRow({ latest_reading_age_minutes: FRESH_THRESHOLD_MINUTES }))).toBe('delayed')
  })

  it('is delayed between FRESH_THRESHOLD_MINUTES and DELAYED_STALE_BOUNDARY_MINUTES', () => {
    expect(stationFreshnessClass(healthRow({ latest_reading_age_minutes: FRESH_THRESHOLD_MINUTES + 1 }))).toBe('delayed')
    expect(stationFreshnessClass(healthRow({ latest_reading_age_minutes: DELAYED_STALE_BOUNDARY_MINUTES - 1 }))).toBe('delayed')
  })

  it('is stale at exactly DELAYED_STALE_BOUNDARY_MINUTES', () => {
    expect(stationFreshnessClass(healthRow({ latest_reading_age_minutes: DELAYED_STALE_BOUNDARY_MINUTES }))).toBe('stale')
  })

  it('is stale beyond DELAYED_STALE_BOUNDARY_MINUTES', () => {
    expect(stationFreshnessClass(healthRow({ latest_reading_age_minutes: 500 }))).toBe('stale')
  })
})

// ── classifyWardCoverage ─────────────────────────────────────────────────────

describe('classifyWardCoverage', () => {
  const ward = { id: 1, lat: 28.6139, lng: 77.209 }

  it('is unavailable when the ward centroid is null', () => {
    expect(classifyWardCoverage({ id: 1, lat: null, lng: null }, [], [])).toMatchObject({ class: 'unavailable' })
  })

  it('is unavailable when the ward centroid is outside Delhi/NCR bounds', () => {
    expect(classifyWardCoverage({ id: 1, lat: 19.076, lng: 72.877 }, [], [])).toMatchObject({ class: 'unavailable' })
  })

  it('is direct when an active station is assigned to the ward (ward_id match)', () => {
    const h = healthRow({ id: 10, name: 'Anand Vihar', ward_id: 1, is_active: true })
    const s = station({ id: 10, lat: 28.62, lng: 77.21 })
    const result = classifyWardCoverage(ward, [h], [s])
    expect(result.class).toBe('direct')
    expect(result.directStationName).toBe('Anand Vihar')
  })

  it('does not count an inactive assigned station as direct coverage', () => {
    const h = healthRow({ id: 10, ward_id: 1, is_active: false })
    const s = station({ id: 10, lat: 28.62, lng: 77.21 })
    const result = classifyWardCoverage(ward, [h], [s])
    expect(result.class).not.toBe('direct')
  })

  it('is nearby when no assigned station but an active station is within NEARBY_COVERAGE_THRESHOLD_METERS', () => {
    // ~800m from ward centroid
    const h = healthRow({ id: 99, ward_id: 999, is_active: true })
    const s = station({ id: 99, lat: 28.617, lng: 77.216 })
    const result = classifyWardCoverage(ward, [h], [s])
    expect(result.class).toBe('nearby')
    expect(result.nearestDistanceMeters).toBeLessThan(NEARBY_COVERAGE_THRESHOLD_METERS)
    expect(result.nearestStationName).toBe('Test Station')
  })

  it('is insufficient when nearest active station is beyond threshold', () => {
    // ~45 km from ward centroid (Gurugram area)
    const h = healthRow({ id: 99, is_active: true })
    const s = station({ id: 99, lat: 28.46, lng: 77.03 })
    const result = classifyWardCoverage(ward, [h], [s])
    expect(result.class).toBe('insufficient')
    expect(result.nearestDistanceMeters).toBeGreaterThan(NEARBY_COVERAGE_THRESHOLD_METERS)
  })

  it('excludes inactive stations from nearby/insufficient calculation', () => {
    // A close but inactive station should not be counted as nearby
    const hClose = healthRow({ id: 10, ward_id: 999, is_active: false, latest_reading_age_minutes: 30 })
    const sClose = station({ id: 10, lat: 28.617, lng: 77.216 })
    const result = classifyWardCoverage(ward, [hClose], [sClose])
    // No active station within threshold → insufficient
    expect(result.class).toBe('insufficient')
  })

  // ── Geometry-based classification (PIP + centroid derivation) ──────────────

  it('is direct when an active station lies inside the ward polygon', () => {
    const geom = squarePolygon(28.62, 77.21)
    const h = healthRow({ id: 20, name: 'Inner Station', ward_id: 999, is_active: true })
    const s = station({ id: 20, lat: 28.62, lng: 77.21 })  // at polygon center
    const result = classifyWardCoverage({ id: 1, lat: null, lng: null, geometry: geom }, [h], [s])
    expect(result.class).toBe('direct')
    expect(result.directStationName).toBe('Inner Station')
  })

  it('is direct when station is inside one part of a MultiPolygon ward', () => {
    const geom = twoPartMultiPolygon(28.55, 77.15, 28.65, 77.21)
    const h = healthRow({ id: 30, is_active: true })
    const s = station({ id: 30, lat: 28.65, lng: 77.21 })  // inside second sub-polygon
    const result = classifyWardCoverage({ id: 1, lat: null, lng: null, geometry: geom }, [h], [s])
    expect(result.class).toBe('direct')
  })

  it('a station inside a hole is not counted as direct coverage', () => {
    const geom = polygonWithHole(28.62, 77.21, 0.02, 0.01)
    const h = healthRow({ id: 40, is_active: true })
    const s = station({ id: 40, lat: 28.62, lng: 77.21 })  // at center — inside the hole
    const result = classifyWardCoverage({ id: 1, lat: null, lng: null, geometry: geom }, [h], [s])
    // Station is in the excised hole, not in the ward territory
    expect(result.class).not.toBe('direct')
    // But it IS very close to the ward centroid → nearby
    expect(result.class).toBe('nearby')
  })

  it('derives centroid from geometry when stored lat/lng are null', () => {
    const geom = squarePolygon(28.62, 77.21)
    const h = healthRow({ id: 50, is_active: true })
    // Station is outside polygon (28.63 + 0.025 ≈ 28.655 which is outside 28.62±0.02)
    // but within 5 km of the derived centroid
    const s = station({ id: 50, lat: 28.625, lng: 77.235 })  // ~1.7 km away, outside polygon
    const result = classifyWardCoverage({ id: 1, lat: null, lng: null, geometry: geom }, [h], [s])
    // No stored centroid, but geometry provides one — should not be 'unavailable'
    expect(result.class).not.toBe('unavailable')
    expect(result.class).toBe('nearby')
  })

  it('is insufficient when nearest station is beyond 5 km of the ward reference point', () => {
    const geom = squarePolygon(28.62, 77.21)
    const h = healthRow({ id: 60, is_active: true })
    const s = station({ id: 60, lat: 28.67, lng: 77.21 })  // ~5.5 km north, outside polygon
    const result = classifyWardCoverage({ id: 1, lat: null, lng: null, geometry: geom }, [h], [s])
    expect(result.class).toBe('insufficient')
    expect(result.nearestDistanceMeters).toBeGreaterThan(NEARBY_COVERAGE_THRESHOLD_METERS)
  })

  it('is nearby for a station just within 5 km but outside the polygon', () => {
    const geom = squarePolygon(28.62, 77.21)
    const h = healthRow({ id: 70, is_active: true })
    const s = station({ id: 70, lat: 28.658, lng: 77.21 })  // ~4.2 km north, outside polygon
    const result = classifyWardCoverage({ id: 1, lat: null, lng: null, geometry: geom }, [h], [s])
    expect(result.class).toBe('nearby')
    expect(result.nearestDistanceMeters).toBeLessThan(NEARBY_COVERAGE_THRESHOLD_METERS)
  })

  it('returns unavailable for genuinely empty geometry (no ring coordinates)', () => {
    const geom: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[]] }
    const result = classifyWardCoverage({ id: 1, lat: null, lng: null, geometry: geom }, [], [])
    expect(result.class).toBe('unavailable')
  })
})

// ── geometryCentroid ─────────────────────────────────────────────────────────

describe('geometryCentroid', () => {
  it('returns centroid of a square Polygon at the geometric centre', () => {
    const geom = squarePolygon(28.62, 77.21)
    const c = geometryCentroid(geom)
    expect(c).not.toBeNull()
    expect(c!.lat).toBeCloseTo(28.62, 3)
    expect(c!.lng).toBeCloseTo(77.21, 3)
  })

  it('reads GeoJSON coordinates as [lng, lat] order — not [lat, lng]', () => {
    // If the order were swapped the result would be ~(77.21, 28.62) rather than ~(28.62, 77.21)
    const geom = squarePolygon(28.62, 77.21)
    const c = geometryCentroid(geom)!
    expect(c.lat).toBeCloseTo(28.62, 1)   // lat ≈ 28, not ≈ 77
    expect(c.lng).toBeCloseTo(77.21, 1)   // lng ≈ 77, not ≈ 28
  })

  it('returns centroid of the largest sub-polygon of a MultiPolygon (not the empty-space midpoint)', () => {
    const geom = twoPartMultiPolygon(28.55, 77.15, 28.65, 77.21)
    const c = geometryCentroid(geom)
    expect(c).not.toBeNull()
    // Area-weighted midpoint (28.60, 77.18) would fall between the two sub-polygons.
    // Instead we get the first (largest by first-wins for equal area) sub-polygon's centroid.
    expect(c!.lat).toBeCloseTo(28.55, 1)
    expect(c!.lng).toBeCloseTo(77.15, 1)
  })

  it('centroid of a square Polygon lies inside the polygon', () => {
    const geom = squarePolygon(28.62, 77.21)
    const c = geometryCentroid(geom)!
    // Import pointInGeometry indirectly by checking the output is within the known bounds
    const halfDeg = 0.02
    expect(c.lat).toBeGreaterThan(28.62 - halfDeg)
    expect(c.lat).toBeLessThan(28.62 + halfDeg)
    expect(c.lng).toBeGreaterThan(77.21 - halfDeg)
    expect(c.lng).toBeLessThan(77.21 + halfDeg)
  })

  it('returns null for a degenerate Polygon with an empty ring', () => {
    const geom: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[]] }
    expect(geometryCentroid(geom)).toBeNull()
  })

  it('returns null for a degenerate Polygon with fewer than 3 vertices', () => {
    const geom: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[77.21, 28.62]]] }
    expect(geometryCentroid(geom)).toBeNull()
  })
})

// ── auditIncidentCoordinates ─────────────────────────────────────────────────

describe('auditIncidentCoordinates', () => {
  it('returns all-zero audit for empty input', () => {
    const a = auditIncidentCoordinates([])
    expect(a.total).toBe(0)
    expect(a.spatiallyValid).toBe(0)
    expect(a.missingCoordinates).toBe(0)
  })

  it('counts spatially valid Delhi incidents correctly', () => {
    const incidents = [
      { lat: 28.6139, lng: 77.209, ward_id: 1, coordinate_review_status: null },
      { lat: 28.6, lng: 77.2, ward_id: null, coordinate_review_status: null },
    ]
    const a = auditIncidentCoordinates(incidents)
    expect(a.spatiallyValid).toBe(2)
    expect(a.withCoordsButNoWard).toBe(1)
  })

  it('counts missing-coordinate incidents and distinguishes ward presence', () => {
    const incidents = [
      { lat: null, lng: null, ward_id: 5, coordinate_review_status: null },   // missing coords, has ward
      { lat: null, lng: null, ward_id: null, coordinate_review_status: null }, // missing coords, no ward
    ]
    const a = auditIncidentCoordinates(incidents)
    expect(a.missingCoordinates).toBe(2)
    expect(a.withWardButNoCoords).toBe(1)
  })

  it('counts out-of-bounds coordinates separately from missing', () => {
    const incidents = [
      { lat: 19.076, lng: 72.877, ward_id: null, coordinate_review_status: null }, // Mumbai — outside bounds
    ]
    const a = auditIncidentCoordinates(incidents)
    expect(a.outsideBounds).toBe(1)
    expect(a.missingCoordinates).toBe(0)
    expect(a.spatiallyValid).toBe(0)
  })

  it('tallies a realistic mixed batch correctly', () => {
    const incidents = [
      { lat: 28.6139, lng: 77.209, ward_id: 1, coordinate_review_status: null }, // valid Delhi, has ward
      { lat: 28.6, lng: 77.2, ward_id: null, coordinate_review_status: null },   // valid Delhi, no ward
      { lat: null, lng: null, ward_id: 2, coordinate_review_status: null },       // missing, has ward
      { lat: null, lng: null, ward_id: null, coordinate_review_status: null },    // missing, no ward
      { lat: 19.076, lng: 72.877, ward_id: null, coordinate_review_status: null }, // outside bounds
    ]
    const a = auditIncidentCoordinates(incidents)
    expect(a.total).toBe(5)
    expect(a.spatiallyValid).toBe(2)
    expect(a.missingCoordinates).toBe(2)
    expect(a.outsideBounds).toBe(1)
    expect(a.withWardButNoCoords).toBe(1)
    expect(a.withCoordsButNoWard).toBe(1)
  })
})

// ── rollupStationQuality ─────────────────────────────────────────────────────

describe('rollupStationQuality', () => {
  it('tallies each freshness class correctly', () => {
    const rows = [
      healthRow({ latest_reading_age_minutes: 30, is_active: true }),   // fresh
      healthRow({ latest_reading_age_minutes: 90, is_active: true }),   // delayed
      healthRow({ latest_reading_age_minutes: 200, is_active: true }),  // stale
      healthRow({ latest_reading_age_minutes: null, is_active: true }), // no_reading
      healthRow({ latest_reading_age_minutes: 10, is_active: false }),  // unavailable
    ]
    const r = rollupStationQuality(rows)
    expect(r.total).toBe(5)
    expect(r.fresh).toBe(1)
    expect(r.delayed).toBe(1)
    expect(r.stale).toBe(1)
    expect(r.noReading).toBe(1)
    expect(r.unavailable).toBe(1)
  })

  it('tracks oldest and latest active reading timestamps', () => {
    const rows = [
      healthRow({ is_active: true, latest_reading_at: '2024-01-01T10:00:00Z', latest_reading_age_minutes: 30 }),
      healthRow({ is_active: true, latest_reading_at: '2024-01-01T12:00:00Z', latest_reading_age_minutes: 30 }),
      healthRow({ is_active: false, latest_reading_at: '2024-01-01T09:00:00Z', latest_reading_age_minutes: 30 }),
    ]
    const r = rollupStationQuality(rows)
    expect(r.oldestActiveReadingAt).toBe('2024-01-01T10:00:00Z')
    expect(r.latestActiveReadingAt).toBe('2024-01-01T12:00:00Z')
  })

  it('returns null timestamps when no active station has a reading', () => {
    const rows = [
      healthRow({ is_active: true, latest_reading_at: null, latest_reading_age_minutes: null }),
    ]
    const r = rollupStationQuality(rows)
    expect(r.oldestActiveReadingAt).toBeNull()
    expect(r.latestActiveReadingAt).toBeNull()
  })
})

// ── formatReadingAge ─────────────────────────────────────────────────────────

describe('formatReadingAge', () => {
  it('returns "no readings" for null', () => {
    expect(formatReadingAge(null)).toBe('no readings')
  })

  it('shows minutes for sub-60-minute readings', () => {
    expect(formatReadingAge(0)).toBe('0m ago')
    expect(formatReadingAge(45)).toBe('45m ago')
    expect(formatReadingAge(59)).toBe('59m ago')
  })

  it('shows rounded hours for 60+ minutes', () => {
    expect(formatReadingAge(60)).toBe('1h ago')
    expect(formatReadingAge(90)).toBe('2h ago')
    expect(formatReadingAge(180)).toBe('3h ago')
  })

  it('shows days for 24h+', () => {
    expect(formatReadingAge(1440)).toBe('1d ago')
    expect(formatReadingAge(2880)).toBe('2d ago')
  })
})
