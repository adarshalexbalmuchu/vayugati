import { describe, expect, it } from 'vitest'
import {
  auditIncidentCoordinates,
  classifyWardCoverage,
  DELAYED_STALE_BOUNDARY_MINUTES,
  formatReadingAge,
  FRESH_THRESHOLD_MINUTES,
  NEARBY_COVERAGE_THRESHOLD_METERS,
  rollupStationQuality,
  stationFreshnessClass,
} from './dataQualityRules'
import type { StationMarker } from './data'
import type { StationHealthRow } from './ops'

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
