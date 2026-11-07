import { describe, expect, it } from 'vitest'
import type { FeatureCollection } from 'geojson'
import { buildColumns, circlePolygon, columnHeightM } from './columns'

describe('column heights', () => {
  it('are proportional to the published figure', () => {
    expect(columnHeightM('mines', { capacity_mtpa: 7 })).toBe(7000)
    expect(columnHeightM('plants', { operating_mw: 1600 })).toBe(12800)
    expect(columnHeightM('dams', { height_m: 30.18 })).toBe(4527)
  })

  it('are missing, not guessed, when the figure is missing or zero', () => {
    expect(columnHeightM('mines', { capacity_mtpa: null })).toBeNull()
    expect(columnHeightM('mines', {})).toBeNull()
    expect(columnHeightM('plants', { operating_mw: 0 })).toBeNull()
    expect(columnHeightM('dams', { height_m: '' })).toBeNull()
  })
})

describe('circlePolygon', () => {
  it('closes its ring and keeps the radius', () => {
    const r = circlePolygon(85, 23, 1000)
    expect(r[0]).toEqual(r[r.length - 1])
    const dLat = Math.abs(r[0][1] - 23) * 110540
    expect(dLat).toBeLessThan(1001)
  })
})

describe('buildColumns', () => {
  const pts: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: 'A', capacity_mtpa: 2 }, geometry: { type: 'Point', coordinates: [85, 23] } },
      { type: 'Feature', properties: { name: 'B', capacity_mtpa: null }, geometry: { type: 'Point', coordinates: [86, 24] } },
    ],
  }

  it('draws a wide and a narrow column for each feature that has a figure, and none for the rest', () => {
    const c = buildColumns('mines', pts)
    expect(c.features).toHaveLength(2)
    expect(c.features.map((f) => f.properties?.tier).sort()).toEqual(['far', 'near'])
    expect(c.features.every((f) => f.properties?.name === 'A' && f.properties?.h === 2000)).toBe(true)
  })
})
