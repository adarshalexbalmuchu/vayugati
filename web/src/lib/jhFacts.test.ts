import { describe, expect, it } from 'vitest'
import raw from '../../public/city-packs/jharkhand/district_profiles.json?raw'
import { factsFor, formatValue, rankDistricts, type ProfilesDoc } from './jhFacts'

const doc = JSON.parse(raw) as ProfilesDoc

describe('Jharkhand assistant facts (read from the checked profiles)', () => {
  it('formats Indian digit grouping and NA', () => {
    expect(formatValue('population', 2914253)).toBe('29,14,253')
    expect(formatValue('forest_pct', 55.54)).toBe('55.5%')
    expect(formatValue('highest_point', null)).toBe('NA')
  })

  it('returns a row per field with its source', () => {
    const rows = factsFor(doc, 'Ranchi', ['population', 'highest_point'])!
    expect(rows.map((r) => r.label)).toEqual(['Population (2011)', 'Highest point'])
    expect(rows[0].value).toBe('29,14,253')
    expect(rows.every((r) => r.source.length > 5)).toBe(true)
  })

  it('unknown district gives null, never a guess', () => {
    expect(factsFor(doc, 'Gotham', ['area'])).toBeNull()
  })

  it('carries the area note where sources differ (Kodarma, Hazaribagh)', () => {
    expect(factsFor(doc, 'Kodarma', ['area'])![0].note).toMatch(/2,540/)
    expect(factsFor(doc, 'Ranchi', ['area'])![0].note).toBeUndefined()
  })

  it('ranks districts by the data, largest first', () => {
    const top = rankDistricts(doc, 'forest_km2', 'desc', 3)
    expect(top).toHaveLength(3)
    expect(top[0].district).toBe('Pashchimi Singhbhum') // ISFR 2023: 3,377.69 km2, the most
    expect(top[0].value).toBeGreaterThanOrEqual(top[1].value)
  })

  it('ranks ascending and bounds the limit', () => {
    const low = rankDistricts(doc, 'population', 'asc', 99)
    expect(low).toHaveLength(10)
    expect(low[0].district).toBe('Lohardaga') // Census 2011: 461,790, the fewest
  })

  it('leaves out districts with no value', () => {
    expect(rankDistricts(doc, 'monitors_continuous', 'desc', 10)[0].district).toBe('Dhanbad')
  })
})

describe('state overview', () => {
  it('sums to the official state totals', async () => {
    const { stateOverview } = await import('./jhFacts')
    const rows = Object.fromEntries(stateOverview(doc).map((r) => [r.label, r.value]))
    expect(rows['Districts']).toBe('24')
    expect(rows['Population (2011)']).toBe('3,29,88,134') // Census 2011 state total
    expect(rows['Area']).toBe('79,716 km²') // ISFR 2023 state total
    expect(rows['Forest cover']).toMatch(/^23,766 km² \(29\.8%/) // ISFR 2023: 23,765.78 km2, 29.81%
  })
})
