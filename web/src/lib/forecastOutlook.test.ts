import { describe, expect, it } from 'vitest'
import type { ForecastPoint } from './data'
import { chanceLabel, forecastOutlook } from './forecastOutlook'

const now = new Date('2026-10-02T00:00:00Z')
function pt(hoursAhead: number, prob: number | null, severe: 'elevated' | null = null): ForecastPoint {
  return {
    horizon_ts: new Date(now.getTime() + hoursAhead * 3600_000).toISOString(),
    exceedProb: prob, exceedThreshold: prob == null ? null : 90, severeRisk: severe,
  } as unknown as ForecastPoint
}

describe('forecastOutlook', () => {
  it('takes the highest chance inside the window and ignores hours outside it', () => {
    const o = forecastOutlook([pt(-1, 0.99), pt(3, 0.4), pt(10, 0.72), pt(30, 0.95)], 24, now)
    expect(o.maxProb).toBe(0.72)
    expect(o.threshold).toBe(90)
    expect(o.maxProbTs).toBe(pt(10, 0).horizon_ts)
  })

  it('reports the first severe-risk hour, and nulls when nothing is published', () => {
    const o = forecastOutlook([pt(5, null), pt(8, null, 'elevated'), pt(6, null, 'elevated')], 24, now)
    expect(o.maxProb).toBeNull()
    expect(o.severeFromTs).toBe(pt(6, null).horizon_ts)
    expect(forecastOutlook([], 24, now)).toEqual({ maxProb: null, maxProbTs: null, threshold: null, severeFromTs: null })
  })
})

describe('chanceLabel', () => {
  it('rounds to 5% and never claims certainty', () => {
    expect(chanceLabel(0.72)).toBe('70%')
    expect(chanceLabel(0.999)).toBe('95%')
    expect(chanceLabel(0.001)).toBe('5%')
  })
})
