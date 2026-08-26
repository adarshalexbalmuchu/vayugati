import { describe, expect, it } from 'vitest'
import {
  changeMarkerBadge,
  classifyChangeDirection,
  forecastPollutantFor,
  isValidDelhiCoordinate,
  markerMeaningLabel,
  nearestForecastPoint,
  nearestStationTo,
  resolveWardReading,
  stationReadingValue,
  wardDataStatus,
} from './mapRules'
import type { ForecastPoint, StationMarker, WardForecastSummary } from './data'

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
    pollutant: 'pm25',
    points: [],
    peakPred: null,
    peakExcess: null,
    peakTs: null,
    hoursToSevere: null,
    hoursToVeryPoor: null,
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
      isProxy: false,
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

  it('prefers the universal predicted_value column over the legacy pm25_pred alias', () => {
    const f = forecast({
      points: [point({ horizon_ts: hoursFromNow(24), pm25_pred: 999, predicted_value: 150, local_excess: 10 })],
    })
    expect(resolveWardReading(ward, 'pm10', '24h', f).value).toBe(150)
  })

  it('flags AQI forecast mode as a proxy (real PM2.5 forecast, not a fabricated AQI forecast), and only that mode', () => {
    const f = forecast({ pollutant: 'pm25', points: [point({ horizon_ts: hoursFromNow(24), predicted_value: 150 })] })
    expect(resolveWardReading(ward, 'aqi', '24h', f).isProxy).toBe(true)
    expect(resolveWardReading(ward, 'aqi', '24h', f).unit).toMatch(/risk signal/i)
    expect(resolveWardReading(ward, 'pm25', '24h', f).isProxy).toBe(false)
    expect(resolveWardReading(ward, 'pm10', '24h', f).isProxy).toBe(false)
  })
})

describe('forecastPollutantFor', () => {
  it('maps aqi to pm25 (the only pollutant forecast.py never computes)', () => {
    expect(forecastPollutantFor('aqi')).toBe('pm25')
  })

  it('passes every other pollutant through unchanged - forecast.py forecasts all three', () => {
    expect(forecastPollutantFor('pm25')).toBe('pm25')
    expect(forecastPollutantFor('pm10')).toBe('pm10')
    expect(forecastPollutantFor('no2')).toBe('no2')
  })
})

describe('markerMeaningLabel', () => {
  it('states AQI plainly in "now" mode', () => {
    expect(markerMeaningLabel('aqi', 'now')).toMatch(/current station aqi/i)
  })

  it('states the concentration pollutant and unit in "now" mode', () => {
    expect(markerMeaningLabel('pm10', 'now')).toMatch(/pm10/i)
    expect(markerMeaningLabel('pm10', 'now')).toMatch(/µg\/m³/)
  })

  it('is honest about AQI having no real forecast - names the proxy pollutant and "risk signal"', () => {
    const line = markerMeaningLabel('aqi', '24h')
    expect(line).toMatch(/pm2\.5/i)
    expect(line).toMatch(/risk signal/i)
    expect(line).not.toMatch(/forecast aqi/i)
  })

  it('names the real forecast pollutant and horizon for a non-AQI selection', () => {
    const line = markerMeaningLabel('no2', '48h')
    expect(line).toMatch(/no₂|no2/i)
    expect(line).toMatch(/48h/)
  })
})

describe('nearestStationTo', () => {
  function station(overrides: Partial<StationMarker> = {}): StationMarker {
    return { id: 1, name: 'Test station', lat: 28.6139, lng: 77.209, aqi: null, pm25: null, pm10: null, no2: null, ...overrides }
  }

  it('returns null when the origin coordinate is missing', () => {
    expect(nearestStationTo(null, null, [station()])).toBeNull()
  })

  it('returns null when there are no valid-coordinate stations', () => {
    expect(nearestStationTo(28.6139, 77.209, [])).toBeNull()
    expect(nearestStationTo(28.6139, 77.209, [station({ lat: 0, lng: 0 })])).toBeNull()
  })

  it('picks the closest of several stations, with a real distance', () => {
    const near = station({ id: 1, lat: 28.62, lng: 77.21 })
    const far = station({ id: 2, lat: 28.9, lng: 77.6 })
    const result = nearestStationTo(28.6139, 77.209, [far, near])
    expect(result?.station.id).toBe(1)
    expect(result?.distanceMeters).toBeGreaterThan(0)
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

describe('stationReadingValue — historical reading compatibility', () => {
  // HistoricalStationReading has the same four fields; the accessor must work
  // without any cast so it can serve as the single metric accessor for both
  // live and historical paths.
  const historicalReading = { stationId: 1, ts: '2026-08-10T12:00:00Z', aqi: 250, pm25: 95, pm10: 140, no2: 38 }

  it('AQI selection reads historical AQI', () => {
    expect(stationReadingValue(historicalReading, 'aqi')).toBe(250)
  })

  it('PM₂.₅ selection reads historical PM₂.₅ — never falls back to AQI', () => {
    expect(stationReadingValue(historicalReading, 'pm25')).toBe(95)
    expect(stationReadingValue(historicalReading, 'pm25')).not.toBe(250)
  })

  it('PM₁₀ selection reads historical PM₁₀', () => {
    expect(stationReadingValue(historicalReading, 'pm10')).toBe(140)
  })

  it('NO₂ selection reads historical NO₂', () => {
    expect(stationReadingValue(historicalReading, 'no2')).toBe(38)
  })

  it('returns null when the selected metric is absent from the reading — produces no comparison', () => {
    const partial = { aqi: 200, pm25: null, pm10: null, no2: null }
    expect(stationReadingValue(partial, 'pm25')).toBeNull()
    expect(stationReadingValue(partial, 'pm10')).toBeNull()
    expect(stationReadingValue(partial, 'no2')).toBeNull()
    // AQI is still present and readable
    expect(stationReadingValue(partial, 'aqi')).toBe(200)
  })
})

describe('classifyChangeDirection — AQI vs concentration thresholds', () => {
  it('AQI: ±10 is stable', () => {
    expect(classifyChangeDirection(10, 'aqi')).toBe('stable')
    expect(classifyChangeDirection(-10, 'aqi')).toBe('stable')
    expect(classifyChangeDirection(0, 'aqi')).toBe('stable')
  })

  it('AQI: 11–30 worsening/improving, beyond 30 is strong', () => {
    expect(classifyChangeDirection(11, 'aqi')).toBe('worsening')
    expect(classifyChangeDirection(30, 'aqi')).toBe('worsening')
    expect(classifyChangeDirection(31, 'aqi')).toBe('strong_worsening')
    expect(classifyChangeDirection(-11, 'aqi')).toBe('improving')
    expect(classifyChangeDirection(-30, 'aqi')).toBe('improving')
    expect(classifyChangeDirection(-31, 'aqi')).toBe('strong_improving')
  })

  it('PM₂.₅: ±5 µg/m³ is stable, 6–15 moderate, beyond 15 is strong', () => {
    expect(classifyChangeDirection(5, 'pm25')).toBe('stable')
    expect(classifyChangeDirection(-5, 'pm25')).toBe('stable')
    expect(classifyChangeDirection(6, 'pm25')).toBe('worsening')
    expect(classifyChangeDirection(15, 'pm25')).toBe('worsening')
    expect(classifyChangeDirection(16, 'pm25')).toBe('strong_worsening')
    expect(classifyChangeDirection(-6, 'pm25')).toBe('improving')
    expect(classifyChangeDirection(-16, 'pm25')).toBe('strong_improving')
  })

  it('AQI and concentration thresholds differ — Δ=8 is stable in AQI but worsening in PM₂.₅', () => {
    expect(classifyChangeDirection(8, 'aqi')).toBe('stable')
    expect(classifyChangeDirection(8, 'pm25')).toBe('worsening')
  })

  it('PM₁₀ uses the same concentration thresholds as PM₂.₅', () => {
    expect(classifyChangeDirection(5, 'pm10')).toBe('stable')
    expect(classifyChangeDirection(6, 'pm10')).toBe('worsening')
    expect(classifyChangeDirection(16, 'pm10')).toBe('strong_worsening')
  })

  it('NO₂ uses the same concentration thresholds as PM₂.₅', () => {
    expect(classifyChangeDirection(5, 'no2')).toBe('stable')
    expect(classifyChangeDirection(6, 'no2')).toBe('worsening')
    expect(classifyChangeDirection(16, 'no2')).toBe('strong_worsening')
    expect(classifyChangeDirection(-16, 'no2')).toBe('strong_improving')
  })
})

describe('changeMarkerBadge', () => {
  it('returns — when either argument is null (missing comparison data)', () => {
    expect(changeMarkerBadge(null, null)).toBe('—')
    expect(changeMarkerBadge(42, null)).toBe('—')
    expect(changeMarkerBadge(null, 'worsening')).toBe('—')
  })

  it('shows directional arrow and signed rounded delta', () => {
    expect(changeMarkerBadge(42, 'strong_worsening')).toBe('↑↑+42')
    expect(changeMarkerBadge(18, 'worsening')).toBe('↑+18')
    expect(changeMarkerBadge(3, 'stable')).toBe('→+3')
    expect(changeMarkerBadge(0, 'stable')).toBe('→0')
    expect(changeMarkerBadge(-21, 'improving')).toBe('↓-21')
    expect(changeMarkerBadge(-48, 'strong_improving')).toBe('↓↓-48')
  })

  it('rounds fractional deltas', () => {
    expect(changeMarkerBadge(12.6, 'worsening')).toBe('↑+13')
    expect(changeMarkerBadge(-7.4, 'improving')).toBe('↓-7')
  })
})

describe('change mode summary — totals reconcile for each pollutant', () => {
  type ChangeRow = { direction: 'strong_worsening' | 'worsening' | 'stable' | 'improving' | 'strong_improving' | null; delta: number | null }

  function makeRows(items: Array<{ delta: number; pollutant: 'aqi' | 'pm25' | 'pm10' | 'no2' }>): ChangeRow[] {
    return items.map(({ delta, pollutant }) => ({
      delta,
      direction: classifyChangeDirection(delta, pollutant),
    }))
  }

  it('totals reconcile for AQI: worsened + stable + improved + missing = total stations', () => {
    const rows = makeRows([
      { delta: 5, pollutant: 'aqi' },   // stable (≤10)
      { delta: 15, pollutant: 'aqi' },  // worsening (11-30)
      { delta: -20, pollutant: 'aqi' }, // improving
      { delta: 35, pollutant: 'aqi' },  // strong_worsening (>30)
    ])
    const compared = rows.filter((r) => r.direction != null)
    const worsened = compared.filter((r) => r.direction === 'worsening' || r.direction === 'strong_worsening').length
    const stable = compared.filter((r) => r.direction === 'stable').length
    const improved = compared.filter((r) => r.direction === 'improving' || r.direction === 'strong_improving').length
    const missing = rows.filter((r) => r.direction == null).length
    expect(worsened + stable + improved + missing).toBe(rows.length)
    expect(worsened).toBe(2)
    expect(stable).toBe(1)
    expect(improved).toBe(1)
  })

  it('totals reconcile for PM₂.₅ with tighter thresholds', () => {
    const rows = makeRows([
      { delta: 4, pollutant: 'pm25' },   // stable (≤5)
      { delta: 8, pollutant: 'pm25' },   // worsening (6-15)
      { delta: -7, pollutant: 'pm25' },  // improving
      { delta: 20, pollutant: 'pm25' },  // strong_worsening (>15)
    ])
    const compared = rows.filter((r) => r.direction != null)
    const worsened = compared.filter((r) => r.direction === 'worsening' || r.direction === 'strong_worsening').length
    const stable = compared.filter((r) => r.direction === 'stable').length
    const improved = compared.filter((r) => r.direction === 'improving' || r.direction === 'strong_improving').length
    expect(worsened + stable + improved).toBe(compared.length)
    expect(worsened).toBe(2)
    expect(stable).toBe(1)
    expect(improved).toBe(1)
  })

  it('largest deterioration is identified by the selected metric delta, not AQI', () => {
    const pm25Rows: ChangeRow[] = [
      { delta: 12, direction: classifyChangeDirection(12, 'pm25') },  // worsening
      { delta: 20, direction: classifyChangeDirection(20, 'pm25') },  // strong_worsening
      { delta: -5, direction: classifyChangeDirection(-5, 'pm25') },  // stable
    ]
    const worsened = pm25Rows.filter((r) => r.direction === 'worsening' || r.direction === 'strong_worsening')
    const largest = worsened.reduce<ChangeRow | null>((best, r) => {
      if (!best || (r.delta ?? -Infinity) > (best.delta ?? -Infinity)) return r
      return best
    }, null)
    expect(largest?.delta).toBe(20)
    expect(largest?.direction).toBe('strong_worsening')
  })

  it('largest improvement is identified by the most negative delta in the selected metric', () => {
    const pm25Rows: ChangeRow[] = [
      { delta: -7, direction: classifyChangeDirection(-7, 'pm25') },   // improving
      { delta: -18, direction: classifyChangeDirection(-18, 'pm25') }, // strong_improving
    ]
    const improved = pm25Rows.filter((r) => r.direction === 'improving' || r.direction === 'strong_improving')
    const largest = improved.reduce<ChangeRow | null>((best, r) => {
      if (!best || (r.delta ?? Infinity) < (best.delta ?? Infinity)) return r
      return best
    }, null)
    expect(largest?.delta).toBe(-18)
    expect(largest?.direction).toBe('strong_improving')
  })
})

describe('isValidDelhiCoordinate', () => {
  it('accepts a real Delhi point', () => {
    expect(isValidDelhiCoordinate(28.6139, 77.209)).toBe(true)
  })

  it('accepts points near the Delhi/NCR edges (Gurugram, Noida)', () => {
    expect(isValidDelhiCoordinate(28.4595, 77.0266)).toBe(true) // Gurugram
    expect(isValidDelhiCoordinate(28.5355, 77.391)).toBe(true) // Noida
  })

  it('rejects null/undefined/NaN coordinates', () => {
    expect(isValidDelhiCoordinate(null, 77.209)).toBe(false)
    expect(isValidDelhiCoordinate(28.6139, null)).toBe(false)
    expect(isValidDelhiCoordinate(undefined, undefined)).toBe(false)
    expect(isValidDelhiCoordinate(NaN, 77.209)).toBe(false)
  })

  it('rejects a real but out-of-NCR Indian point', () => {
    expect(isValidDelhiCoordinate(19.076, 72.8777)).toBe(false) // Mumbai
    expect(isValidDelhiCoordinate(13.0827, 80.2707)).toBe(false) // Chennai
  })

  it('rejects a stray 0,0 coordinate', () => {
    expect(isValidDelhiCoordinate(0, 0)).toBe(false)
  })

  it('rejects points just outside the bounding box', () => {
    expect(isValidDelhiCoordinate(29.1, 77.209)).toBe(false)
    expect(isValidDelhiCoordinate(28.6139, 76.5)).toBe(false)
  })
})

describe('wardDataStatus', () => {
  it('is station_backed when a direct station exists, regardless of nearest-station availability', () => {
    expect(wardDataStatus(true, true)).toBe('station_backed')
    expect(wardDataStatus(true, false)).toBe('station_backed')
  })

  it('is nearest_station_proxy when there is no direct station but a nearest one is computable', () => {
    expect(wardDataStatus(false, true)).toBe('nearest_station_proxy')
  })

  it('is no_station_data when neither is available - never a 4th guessed state', () => {
    expect(wardDataStatus(false, false)).toBe('no_station_data')
  })
})
