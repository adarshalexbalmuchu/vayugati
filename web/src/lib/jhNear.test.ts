import { describe, expect, it } from 'vitest'
import type { FeatureCollection } from 'geojson'
import schools from '../../public/city-packs/jharkhand/facilities.geojson?raw'
import { anchor, haversineKm, near } from './jhNear'

describe('near (within a radius of a place)', () => {
  it('haversine: Ranchi to Jamshedpur is about 115 km', () => {
    const d = haversineKm(85.325, 23.37, 86.203, 22.802)
    expect(d).toBeGreaterThan(105)
    expect(d).toBeLessThan(125)
  })

  it('anchors a polygon at the middle of its bounding box', () => {
    expect(anchor({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 4], [0, 4], [0, 0]]] })).toEqual([1, 2])
  })

  it('counts only features of the wanted kind inside the radius, nearest first', () => {
    const fc: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { kind: 'school', name: 'A' }, geometry: { type: 'Point', coordinates: [85.33, 23.37] } },
        { type: 'Feature', properties: { kind: 'hospital', name: 'B' }, geometry: { type: 'Point', coordinates: [85.33, 23.37] } },
        { type: 'Feature', properties: { kind: 'school', name: 'Far' }, geometry: { type: 'Point', coordinates: [86.2, 22.8] } },
        { type: 'Feature', properties: { kind: 'college', name: 'C' }, geometry: { type: 'Point', coordinates: [85.35, 23.38] } },
      ],
    }
    const r = near(fc, 'schools', 85.325, 23.37, 10)
    expect(r.count).toBe(2)
    expect(r.nearest.map((h) => h.name)).toEqual(['A', 'C'])
    expect(r.nearest[0].km).toBeLessThan(r.nearest[1].km)
  })

  it('works on the real facilities file: schools near Ranchi', () => {
    const fc = JSON.parse(schools) as FeatureCollection
    const r = near(fc, 'schools', 85.325, 23.37, 10)
    expect(r.count).toBeGreaterThan(0)
    expect(r.nearest.every((h) => h.km <= 10)).toBe(true)
  })
})
