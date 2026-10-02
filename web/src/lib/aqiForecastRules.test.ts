import { describe, expect, it } from 'vitest'
import type { AqiForecastPoint } from './data'
import { aqiOutlook } from './aqiForecastRules'

const NOW = Date.parse('2026-11-10T06:00:00Z')
const origin = NOW - 2 * 3_600_000 // the forecast was made from a reading 2 h old

function pt(lead: number, aqi = 200): AqiForecastPoint {
  return {
    wardId: 1, leadHours: lead, originTs: new Date(origin).toISOString(),
    targetTs: new Date(origin + lead * 3_600_000).toISOString(), aqi, aqiLow: aqi - 30, aqiHigh: aqi + 40,
    dominantPollutant: 'pm25', generatedAt: new Date(NOW).toISOString(),
  }
}

describe('aqiOutlook', () => {
  const all = Array.from({ length: 48 }, (_, i) => pt(i + 1, 150 + i))

  it('picks the lead whose target is nearest now + h, not lead = h', () => {
    const o = aqiOutlook(all, [6, 24], NOW)
    expect(o.map((x) => x.point.leadHours)).toEqual([8, 26])
    expect(o.map((x) => x.hours)).toEqual([6, 24])
  })

  it('skips hours with no validated lead within 3 h', () => {
    const published = all.filter((p) => p.leadHours <= 12)
    // now + 12 h would be lead 14 (not published); lead 12 is 10 h ahead and labelled so
    expect(aqiOutlook(published, [3, 6, 12], NOW).map((x) => x.hours)).toEqual([3, 6, 10])
    expect(aqiOutlook(all.filter((p) => p.leadHours <= 6), [3, 6, 12], NOW).map((x) => x.hours)).toEqual([3, 4])
  })

  it('never shows the same point twice', () => {
    const o = aqiOutlook([pt(8)], [6, 7], NOW)
    expect(o).toHaveLength(1)
  })

  it('is empty without points', () => {
    expect(aqiOutlook([], [6], NOW)).toEqual([])
  })
})
