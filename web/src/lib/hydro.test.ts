import { describe, expect, it } from 'vitest'
import { accKm2, cellOf, followDownstream, lngLatOf, snapToStream, upstreamOf, type HydroGrid } from './hydro'

/** A 5 x 5 valley: columns 0-1 flow east, columns 3-4 flow west, column 2 flows south and ends at the bottom. */
function valley(exit: 'sink' | 'edge'): HydroGrid {
  const dir = new Uint8Array(25)
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) dir[r * 5 + c] = c < 2 ? 1 : c > 2 ? 5 : 3
  if (exit === 'sink') dir[4 * 5 + 2] = 0
  const acc = new Uint8Array(25)
  acc[2 * 5 + 2] = 40
  acc[3 * 5 + 2] = 60
  return { meta: { west: 85, north: 24, cellDeg: 0.01, ncol: 5, nrow: 5, snapKm2: 1, source: 'test' }, dir, acc }
}

describe('cell lookup', () => {
  it('maps a point to its cell and back', () => {
    const g = valley('sink')
    const cell = cellOf(g, 85.025, 23.975)
    expect(cell).toEqual({ r: 2, c: 2 })
    const [lng, lat] = lngLatOf(g, 2, 2)
    expect(lng).toBeCloseTo(85.025)
    expect(lat).toBeCloseTo(23.975)
    expect(cellOf(g, 84.9, 23.9)).toBeNull()
  })
})

describe('followDownstream', () => {
  it('runs along the valley to its end', () => {
    const d = followDownstream(valley('sink'), 0, 0)
    expect(d.cells.map((x) => [x.r, x.c])).toEqual([[0, 0], [0, 1], [0, 2], [1, 2], [2, 2], [3, 2], [4, 2]])
    expect(d.end).toBe('sink')
    expect(d.lengthKm).toBeGreaterThan(5)
  })

  it('says when the water leaves the grid', () => {
    expect(followDownstream(valley('edge'), 0, 4).end).toBe('edge')
  })
})

describe('upstreamOf', () => {
  it('collects every cell that drains through the point', () => {
    const u = upstreamOf(valley('sink'), 4, 2)
    expect(u.cells).toBe(25)
    expect(u.touchesEdge).toBe(true)
    expect(u.areaKm2).toBeGreaterThan(20)
  })

  it('collects only the cells above a point on the stream', () => {
    const u = upstreamOf(valley('sink'), 2, 2)
    expect(u.cells).toBe(15)
    expect(u.bounds.r1).toBe(2)
  })

  it('a hilltop cell has only itself upstream', () => {
    expect(upstreamOf(valley('sink'), 0, 0).cells).toBe(1)
  })
})

describe('snapToStream', () => {
  it('moves a click onto the nearby cell with the largest drainage', () => {
    const s = snapToStream(valley('sink'), 3, 0, 3)
    expect(s).toEqual({ r: 3, c: 2, snapped: true })
  })

  it('leaves a click alone when no stream is near', () => {
    const g = valley('sink')
    g.acc.fill(0)
    expect(snapToStream(g, 3, 0, 3).snapped).toBe(false)
  })
})

describe('accKm2', () => {
  it('decodes the stored byte', () => {
    const g = valley('sink')
    expect(accKm2(g, 0, 0)).toBe(0)
    expect(accKm2(g, 3, 2)).toBeGreaterThan(accKm2(g, 2, 2))
  })
})
