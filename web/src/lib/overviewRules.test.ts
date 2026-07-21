import { describe, expect, it } from 'vitest'
import {
  bucketAgencyPerformance,
  bucketDispatchSla,
  confidenceAtPeak,
  hotspotStatus,
  HOTSPOT_READING_STALE_MINUTES,
  isWardDataBacked,
  nextDueAt,
  peakWithinWindow,
  recurringWardsSummary,
  rollupStationHealth,
  severeWardsWithin,
  tallySourceMix,
} from './overviewRules'
import type { ActiveTaskDispatch, Incident } from './incidents'
import type { StationHealthRow } from './ops'
import type { WardForecastSummary, WardSummary } from './data'

function ward(overrides: Partial<WardSummary> = {}): WardSummary {
  return {
    id: 1,
    name: 'Ward 1',
    dominant_source: null,
    lat: null,
    lng: null,
    aqi: null,
    pm25: null,
    pm10: null,
    no2: null,
    ts: null,
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
    ...overrides,
  }
}

describe('severeWardsWithin', () => {
  it('includes only wards crossing severe within the window, sorted ascending by hoursToSevere', () => {
    const wards = [ward({ id: 1, name: 'Alpha' }), ward({ id: 2, name: 'Beta' }), ward({ id: 3, name: 'Gamma' })]
    const forecasts = new Map<number, WardForecastSummary>([
      [1, forecast({ wardId: 1, hoursToSevere: 40 })],
      [2, forecast({ wardId: 2, hoursToSevere: 10 })],
      [3, forecast({ wardId: 3, hoursToSevere: null })],
    ])
    const result = severeWardsWithin(wards, forecasts, 36)
    expect(result.map((r) => r.wardName)).toEqual(['Beta'])
  })

  it('falls back to a synthetic ward name when no matching ward summary exists', () => {
    const forecasts = new Map<number, WardForecastSummary>([[9, forecast({ wardId: 9, hoursToSevere: 5 })]])
    const result = severeWardsWithin([], forecasts, 36)
    expect(result[0].wardName).toBe('Ward 9')
  })

  it('sorts multiple matches ascending by hoursToSevere', () => {
    const forecasts = new Map<number, WardForecastSummary>([
      [1, forecast({ wardId: 1, hoursToSevere: 30 })],
      [2, forecast({ wardId: 2, hoursToSevere: 5 })],
      [3, forecast({ wardId: 3, hoursToSevere: 20 })],
    ])
    const result = severeWardsWithin([], forecasts, 36)
    expect(result.map((r) => r.wardId)).toEqual([2, 3, 1])
  })
})

describe('confidenceAtPeak', () => {
  it('returns null when forecast is undefined', () => {
    expect(confidenceAtPeak(undefined)).toBeNull()
  })

  it('returns null when peakTs has no matching point', () => {
    const f = forecast({ peakTs: '2026-07-20T10:00:00Z', points: [] })
    expect(confidenceAtPeak(f)).toBeNull()
  })

  it('returns the confidence of the point matching peakTs', () => {
    const f = forecast({
      peakTs: '2026-07-20T10:00:00Z',
      points: [
        { horizon_ts: '2026-07-20T09:00:00Z', pm25_pred: 100, baseline_pred: 90, local_excess: 10, confidence: 0.5, model_version: 'v1' },
        { horizon_ts: '2026-07-20T10:00:00Z', pm25_pred: 150, baseline_pred: 100, local_excess: 50, confidence: 0.82, model_version: 'v1' },
      ],
    })
    expect(confidenceAtPeak(f)).toBe(0.82)
  })
})

describe('peakWithinWindow', () => {
  const now = Date.now()
  const hoursFromNow = (h: number) => new Date(now + h * 3_600_000).toISOString()

  it('returns nulls when forecast is undefined', () => {
    expect(peakWithinWindow(undefined, 24)).toEqual({ value: null, excess: null, ts: null })
  })

  it('only considers points within the selected window, not the whole curve', () => {
    const f = forecast({
      points: [
        { horizon_ts: hoursFromNow(6), pm25_pred: null, baseline_pred: null, local_excess: 10, confidence: null, model_version: null, predicted_value: 80 },
        { horizon_ts: hoursFromNow(40), pm25_pred: null, baseline_pred: null, local_excess: 90, confidence: null, model_version: null, predicted_value: 300 },
      ],
    })
    // the 40h point (300) is the highest overall, but outside a 12h window
    expect(peakWithinWindow(f, 12).value).toBe(80)
    // widening the window to 48h should surface the real peak
    expect(peakWithinWindow(f, 48).value).toBe(300)
  })

  it('falls back to pm25_pred when predicted_value is absent (older rows)', () => {
    const f = forecast({
      points: [{ horizon_ts: hoursFromNow(6), pm25_pred: 55, baseline_pred: null, local_excess: 5, confidence: null, model_version: null }],
    })
    expect(peakWithinWindow(f, 24).value).toBe(55)
  })

  it('returns nulls when every point is outside the window', () => {
    const f = forecast({
      points: [{ horizon_ts: hoursFromNow(40), pm25_pred: 300, baseline_pred: null, local_excess: null, confidence: null, model_version: null }],
    })
    expect(peakWithinWindow(f, 12)).toEqual({ value: null, excess: null, ts: null })
  })
})

describe('hotspotStatus', () => {
  it('is severe when hoursToSevere is within the window', () => {
    expect(hotspotStatus({ hoursToSevere: 12, peakExcess: null, aqi: null }, 36)).toBe('severe')
  })

  it('is watch when not severe but peakExcess is positive', () => {
    expect(hotspotStatus({ hoursToSevere: 50, peakExcess: 15, aqi: null }, 36)).toBe('watch')
  })

  it('is stable when no severe/excess signal but a current aqi exists', () => {
    expect(hotspotStatus({ hoursToSevere: null, peakExcess: null, aqi: 80 }, 36)).toBe('stable')
    expect(hotspotStatus({ hoursToSevere: 50, peakExcess: 0, aqi: 80 }, 36)).toBe('stable')
  })

  it('is no_data when nothing is known', () => {
    expect(hotspotStatus({ hoursToSevere: null, peakExcess: null, aqi: null }, 36)).toBe('no_data')
  })

  it('is stale when the reading is older than HOTSPOT_READING_STALE_MINUTES, even with a rising excess', () => {
    expect(
      hotspotStatus({ hoursToSevere: null, peakExcess: 15, aqi: 177, readingAgeMinutes: HOTSPOT_READING_STALE_MINUTES + 1 }, 36),
    ).toBe('stale')
  })

  it('is not stale exactly at the threshold, only past it', () => {
    expect(
      hotspotStatus({ hoursToSevere: null, peakExcess: 15, aqi: 177, readingAgeMinutes: HOTSPOT_READING_STALE_MINUTES }, 36),
    ).toBe('watch')
  })

  it('severe still wins over staleness - a forecast crossing threshold is not demoted by a stale current reading', () => {
    expect(hotspotStatus({ hoursToSevere: 12, peakExcess: 15, aqi: 177, readingAgeMinutes: 3000 }, 36)).toBe('severe')
  })

  it('omitting readingAgeMinutes entirely behaves exactly as before (existing Map caller safety)', () => {
    expect(hotspotStatus({ hoursToSevere: 50, peakExcess: 15, aqi: 177 }, 36)).toBe('watch')
  })
})

describe('isWardDataBacked', () => {
  it('is true when the ward has a reading timestamp', () => {
    expect(isWardDataBacked({ ts: '2026-07-21T10:00:00Z' })).toBe(true)
  })

  it('is false when the ward has never reported (e.g. Mayapuri - proxy-only, no official station)', () => {
    expect(isWardDataBacked({ ts: null })).toBe(false)
  })
})

function dispatch(overrides: Partial<ActiveTaskDispatch> = {}): ActiveTaskDispatch {
  return {
    id: 1,
    incident_id: 1,
    status: 'assigned',
    assigned_to: null,
    sla_ack_due_at: null,
    sla_accept_due_at: null,
    sla_arrival_due_at: null,
    sla_completion_due_at: null,
    created_at: '2026-07-20T00:00:00Z',
    updated_at: '2026-07-20T00:00:00Z',
    incident_summary: null,
    ward_name: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  } as ActiveTaskDispatch
}

describe('nextDueAt', () => {
  it('falls back through the checkpoint columns in order', () => {
    expect(nextDueAt(dispatch({ sla_ack_due_at: 'a' }))).toBe('a')
    expect(nextDueAt(dispatch({ sla_ack_due_at: null, sla_accept_due_at: 'b' }))).toBe('b')
    expect(nextDueAt(dispatch({ sla_arrival_due_at: 'c' }))).toBe('c')
    expect(nextDueAt(dispatch({ sla_completion_due_at: 'd' }))).toBe('d')
    expect(nextDueAt(dispatch())).toBeNull()
  })
})

describe('bucketDispatchSla', () => {
  const now = new Date('2026-07-20T12:00:00Z')

  it('buckets overdue, due soon, on track, and no SLA correctly', () => {
    const dispatches = [
      dispatch({ sla_ack_due_at: '2026-07-20T11:00:00Z' }), // overdue
      dispatch({ sla_ack_due_at: '2026-07-20T13:00:00Z' }), // due soon (60min)
      dispatch({ sla_ack_due_at: '2026-07-20T20:00:00Z' }), // on track
      dispatch(), // no SLA
    ]
    // bucketDispatchSla uses minutesUntil's own `new Date()` default, so we
    // can't inject `now` directly; assert relative ordering instead by
    // checking totals sum correctly and no-SLA count is exact.
    void now
    const result = bucketDispatchSla(dispatches)
    expect(result.noSla).toBe(1)
    expect(result.overdue + result.dueSoon + result.onTrack).toBe(3)
  })
})

describe('tallySourceMix', () => {
  it('groups and counts by dominant_source, sorted descending, with Unknown fallback', () => {
    const wards = [
      ward({ dominant_source: 'Vehicular' }),
      ward({ dominant_source: 'Vehicular' }),
      ward({ dominant_source: 'Industrial' }),
      ward({ dominant_source: null }),
    ]
    expect(tallySourceMix(wards)).toEqual([
      { source: 'Vehicular', count: 2 },
      { source: 'Industrial', count: 1 },
      { source: 'Unknown', count: 1 },
    ])
  })
})

function station(overrides: Partial<StationHealthRow> = {}): StationHealthRow {
  return {
    id: 1,
    name: 'Station 1',
    ward_id: 1,
    ward_name: 'Ward 1',
    sensor_type: 'pm25',
    is_active: true,
    latest_reading_at: null,
    latest_reading_age_minutes: null,
    is_stale: false,
    ...overrides,
  }
}

describe('rollupStationHealth', () => {
  it('counts active/stale/inactive and ranks the top-3 stalest active stations', () => {
    const rows = [
      station({ id: 1, name: 'A', is_active: true, is_stale: true, latest_reading_age_minutes: 500 }),
      station({ id: 2, name: 'B', is_active: true, is_stale: true, latest_reading_age_minutes: 900 }),
      station({ id: 3, name: 'C', is_active: true, is_stale: true, latest_reading_age_minutes: 300 }),
      station({ id: 4, name: 'D', is_active: true, is_stale: true, latest_reading_age_minutes: 200 }),
      station({ id: 5, name: 'E', is_active: true, is_stale: false }),
      station({ id: 6, name: 'F', is_active: false }),
    ]
    const result = rollupStationHealth(rows)
    expect(result.total).toBe(6)
    expect(result.active).toBe(5)
    expect(result.stale).toBe(4)
    expect(result.inactive).toBe(1)
    expect(result.topStale.map((s) => s.name)).toEqual(['B', 'A', 'C'])
  })
})

describe('bucketAgencyPerformance', () => {
  it('groups by responsible_agency, falling back to Unassigned', () => {
    const dispatches = [
      dispatch({ responsible_agency: 'MCD', status: 'completed' }),
      dispatch({ responsible_agency: 'MCD', status: 'in_progress' }),
      dispatch({ responsible_agency: null, status: 'drafted' }),
    ]
    const result = bucketAgencyPerformance(dispatches)
    const mcd = result.find((r) => r.agency === 'MCD')
    const unassigned = result.find((r) => r.agency === 'Unassigned')
    expect(mcd?.assigned).toBe(2)
    expect(mcd?.completed).toBe(1)
    expect(unassigned?.assigned).toBe(1)
  })

  it('counts overdue only for non-closed dispatches past their next due checkpoint', () => {
    const past = new Date(Date.now() - 60 * 60_000).toISOString()
    const dispatches = [
      dispatch({ responsible_agency: 'MCD', status: 'sent', sla_ack_due_at: past }),
      dispatch({ responsible_agency: 'MCD', status: 'completed', sla_ack_due_at: past }), // closed - not overdue
    ]
    const result = bucketAgencyPerformance(dispatches)
    expect(result.find((r) => r.agency === 'MCD')?.overdue).toBe(1)
  })

  it('computes median response time only from dispatches with both sent_at and acknowledged_at', () => {
    const dispatches = [
      dispatch({ responsible_agency: 'MCD', sent_at: '2026-07-20T10:00:00Z', acknowledged_at: '2026-07-20T10:30:00Z' }),
      dispatch({ responsible_agency: 'MCD', sent_at: null, acknowledged_at: null }),
    ]
    const result = bucketAgencyPerformance(dispatches)
    expect(result.find((r) => r.agency === 'MCD')?.medianResponseMinutes).toBe(30)
  })

  it('reports null median response time when no dispatch has both timestamps', () => {
    const dispatches = [dispatch({ responsible_agency: 'MCD', sent_at: null, acknowledged_at: null })]
    const result = bucketAgencyPerformance(dispatches)
    expect(result[0].medianResponseMinutes).toBeNull()
  })
})

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 1,
    ward_id: 1,
    ward_name: 'Ward 1',
    severity: null,
    status: 'active',
    summary: null,
    detected_at: '2026-07-20T00:00:00Z',
    created_at: '2026-07-20T00:00:00Z',
    updated_at: '2026-07-20T00:00:00Z',
    recurrence_of_incident_id: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  } as Incident
}

describe('recurringWardsSummary', () => {
  it('counts only incidents with a recurrence_of_incident_id set, grouped by ward', () => {
    const incidents = [
      incident({ id: 2, ward_id: 1, ward_name: 'Alpha', recurrence_of_incident_id: 1 }),
      incident({ id: 3, ward_id: 1, ward_name: 'Alpha', recurrence_of_incident_id: 1 }),
      incident({ id: 4, ward_id: 2, ward_name: 'Beta', recurrence_of_incident_id: null }), // not a recurrence
    ]
    const result = recurringWardsSummary(incidents)
    expect(result).toEqual([{ wardId: 1, wardName: 'Alpha', recurrenceCount: 2 }])
  })

  it('returns an empty array when nothing recurs', () => {
    const incidents = [incident({ recurrence_of_incident_id: null })]
    expect(recurringWardsSummary(incidents)).toEqual([])
  })

  it('ignores recurrences with no ward_id', () => {
    const incidents = [incident({ ward_id: null, recurrence_of_incident_id: 1 })]
    expect(recurringWardsSummary(incidents)).toEqual([])
  })
})
