import { describe, expect, it } from 'vitest'
import { districtCentroid, weatherView, type JhWeather } from './jhWeather'

describe('districtCentroid', () => {
  it('finds the centre of a square', () => {
    const c = districtCentroid({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] })
    expect(c?.lng).toBeCloseTo(1)
    expect(c?.lat).toBeCloseTo(1)
  })

  it('uses the largest part of a multipolygon', () => {
    const c = districtCentroid({
      type: 'MultiPolygon',
      coordinates: [[[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]], [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]]],
    })
    expect(c?.lng).toBeCloseTo(2)
    expect(c?.lat).toBeCloseTo(2)
  })
})

describe('weatherView', () => {
  const w: JhWeather = {
    asOf: '2026-11-07T15:00',
    districts: [
      { name: 'A', tempC: 20, humidity: 40 },
      { name: 'B', tempC: 30, humidity: 60 },
      { name: 'C', tempC: 28, humidity: 50 },
      { name: 'D', tempC: null, humidity: null },
    ],
  }

  it('gives one district its own figure', () => {
    expect(weatherView(w, 'B')).toEqual({ label: 'B', tempC: 30, humidity: 60, medianOf: 0 })
  })

  it('gives the state the median of the districts that have a value', () => {
    expect(weatherView(w, null)).toEqual({ label: 'Jharkhand', tempC: 28, humidity: 50, medianOf: 3 })
  })

  it('has nothing for an unknown district', () => {
    expect(weatherView(w, 'Z')).toBeNull()
  })
})
