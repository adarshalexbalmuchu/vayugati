import { describe, expect, it } from 'vitest'
import { nearestForecastPoint, resolveWardReading, stationReadingValue } from './mapRules'
import type { ForecastPoint, WardForecastSummary } from './data'

function point(overrides: Partial<ForecastPoint> = {}): ForecastPoint {
  return {
    horizon_ts: new Date().toISOString(),
    pm25_pred: null,
    baseline_pred: null,
    local_excess: null,
    confidence: null,
    model_version: null,
    ...overrides,
  }
}

function forecast(overrides: Partial<WardForecastSummary> = {}): WardForecastSummary {
  return {
    wardId: 1,
    points: [],
    peakPred: null,
    peakExcess: null,
    peakTs: null,
    hoursToSevere: null,
    ...overrides,
  }
}

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

describe('nearestForecastPoint', () => {
  it('returns null when there are no points', () => {
    expect(nearestForecastPoint(forecast(), 24)).toBeNull()
    expect(nearestForecastPoint(undefined, 24)).toBeNull()
  })

  it('picks the point closest to the requested horizon', () => {
    const p12 = point({ horizon_ts: hoursFromNow(12), pm25_pred: 50 })
    const p26 = point({ horizon_ts: hoursFromNow(26), pm25_pred: 90 })
    const p50 = point({ horizon_ts: hoursFromNow(50), pm25_pred: 120 })
    const f = forecast({ points: [p12, p26, p50] })
    expect(nearestForecastPoint(f, 24)).toBe(p26)
    expect(nearestForecastPoint(f, 48)).toBe(p50)
  })
})

describe('resolveWardReading', () => {
  const ward = { aqi: 180, pm25: 90, pm10: 140, no2: 30 }

  it('reads the live field straight through in "now" mode for each pollutant', () => {
    expect(resolveWardReading(ward, 'aqi', 'now', undefined)).toEqual({
      value: 180,
      unit: 'AQI',
      colorMode: 'aqi',
      aqiForColor: 180,
      status: null,
    })
    expect(resolveWardReading(ward, 'pm10', 'now', undefined).value).toBe(140)
    expect(resolveWardReading(ward, 'no2', 'now', undefined).value).toBe(30)
  })

  it('always colours by AQI in "now" mode regardless of the selected pollutant', () => {
    const result = resolveWardReading(ward, 'pm10', 'now', undefined)
    expect(result.colorMode).toBe('aqi')
    expect(result.aqiForColor).toBe(180)
  })

  it('switches to the nearest forecast point and status-tier colouring in forecast modes', () => {
    const f = forecast({
      points: [point({ horizon_ts: hoursFromNow(24), pm25_pred: 200, local_excess: 60 })],
      hoursToSevere: 20,
    })
    const result = resolveWardReading(ward, 'aqi', '24h', f)
    expect(result.value).toBe(200)
    expect(result.unit).toContain('forecast')
    expect(result.colorMode).toBe('status')
    expect(result.status).toBe('severe')
  })

  it('is unavailable in forecast mode when there is no forecast data', () => {
    const result = resolveWardReading(ward, 'aqi', '48h', undefined)
    expect(result.value).toBeNull()
    expect(result.status).toBe('no_data')
  })
})

describe('stationReadingValue', () => {
  const station = { aqi: 100, pm25: 40, pm10: 70, no2: 15 }

  it('picks the field matching the selected pollutant', () => {
    expect(stationReadingValue(station, 'aqi')).toBe(100)
    expect(stationReadingValue(station, 'pm25')).toBe(40)
    expect(stationReadingValue(station, 'pm10')).toBe(70)
    expect(stationReadingValue(station, 'no2')).toBe(15)
  })
})
