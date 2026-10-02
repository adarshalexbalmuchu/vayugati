import { describe, expect, it } from 'vitest'
import { summarizeCityWeather } from './weatherRules'

describe('summarizeCityWeather', () => {
  it('uses each ward’s latest reading, then the median across wards', () => {
    const out = summarizeCityWeather([
      { ward_id: 1, ts: '2026-09-27T13:00:00Z', temp_c: 10, humidity: 10 },
      { ward_id: 1, ts: '2026-09-27T14:00:00Z', temp_c: 24, humidity: 80 },
      { ward_id: 2, ts: '2026-09-27T13:00:00Z', temp_c: 26, humidity: 70 },
      { ward_id: 3, ts: '2026-09-27T14:00:00Z', temp_c: 23, humidity: 90 },
    ])
    expect(out).toEqual({ tempC: 24, humidity: 80, ts: '2026-09-27T14:00:00Z', wards: 3 })
  })

  it('ignores missing values and returns null when there is nothing', () => {
    expect(summarizeCityWeather([])).toBeNull()
    expect(summarizeCityWeather([{ ward_id: 1, ts: '2026-09-27T14:00:00Z', temp_c: null, humidity: null }])).toBeNull()
    const out = summarizeCityWeather([
      { ward_id: 1, ts: '2026-09-27T14:00:00Z', temp_c: 20, humidity: null },
      { ward_id: 2, ts: '2026-09-27T14:00:00Z', temp_c: 22, humidity: 60 },
    ])
    expect(out?.tempC).toBe(21)
    expect(out?.humidity).toBe(60)
  })
})
