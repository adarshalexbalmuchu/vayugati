import type * as maplibregl from 'maplibre-gl'
import { cellOf, followDownstream, loadHydro, lngLatOf, snapToStream, upstreamOf } from '../../lib/hydro'

/**
 * "Follow water": click a point on the Jharkhand map; the map shows the area whose water reaches it (upstream catchment) and
 * the path the water takes from it until it leaves Jharkhand. A terrain-based estimate from the flow grid in
 * lib/hydro.ts. River names and basins come from India-WRIS (the authority); the computation only supplies the geometry.
 */

export interface WaterResult {
  lng: number
  lat: number
  /** The click was moved onto the stream next to it. */
  snapped: boolean
  /** Area upstream of the point, km2, inside the mapped box. */
  areaKm2: number
  /** The catchment reaches the edge of the grid: the real area is larger. */
  areaIsLowerBound: boolean
  /** Length of the drawn downstream path, km. */
  pathKm: number
  /** How the path ends: leaves Jharkhand, reaches a low point with no outflow, or runs out of the data. */
  end: 'leaves-state' | 'sink' | 'edge' | 'limit'
  /** India-WRIS major rivers the path runs along, in order. */
  rivers: string[]
  /** The India-WRIS major river nearest the point (within 400 m), if any. */
  nearRiver: string | null
  basin: string | null
  district: string | null
}

export interface WaterLookups {
  inState: (lng: number, lat: number) => boolean
  district: (lng: number, lat: number) => string | null
  basin: (lng: number, lat: number) => string | null
}

const CATCH = 'ctx-water-catch'
const PATH = 'ctx-water-path'
const POINT = 'ctx-water-point'
export const WATER_LAYER_IDS = [POINT, `${PATH}-line`, `${PATH}-casing`, CATCH]
export const WATER_SOURCE_IDS = [POINT, PATH, CATCH]

// ---- India-WRIS river names ------------------------------------------------------------------------------------------

interface Seg { x0: number; y0: number; x1: number; y1: number; name: string }
const riverCache = new Map<string, Promise<Seg[]>>()

function loadRivers(base: string): Promise<Seg[]> {
  let p = riverCache.get(base)
  if (!p) {
    p = fetch(`${base}/majorrivers.geojson`).then(async (r) => {
      if (!r.ok) return []
      const fc = (await r.json()) as { features: { properties: { name?: string }; geometry: { type: string; coordinates: number[][] | number[][][] } }[] }
      const segs: Seg[] = []
      for (const f of fc.features) {
        const name = String(f.properties?.name ?? '')
        const parts = (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]) as number[][][]
        for (const part of parts) for (let i = 0; i + 1 < part.length; i++) segs.push({ x0: part[i][0], y0: part[i][1], x1: part[i + 1][0], y1: part[i + 1][1], name })
      }
      return segs
    }).catch(() => [])
    riverCache.set(base, p)
  }
  return p
}

/** The nearest river within `maxM` metres, by planar distance to its segments (fine at this scale). */
export function nearestRiver(segs: Seg[], lng: number, lat: number, maxM: number): string | null {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180)
  const ky = 110540
  let best = maxM
  let name: string | null = null
  for (const s of segs) {
    const ax = (s.x0 - lng) * kx, ay = (s.y0 - lat) * ky
    const bx = (s.x1 - lng) * kx, by = (s.y1 - lat) * ky
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2))
    const d = Math.hypot(ax + t * dx, ay + t * dy)
    if (d < best) {
      best = d
      name = s.name
    }
  }
  return name
}

// ---- drawing ---------------------------------------------------------------------------------------------------------

export function clearWaterOverlay(map: maplibregl.Map): void {
  for (const id of WATER_LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id)
  for (const id of WATER_SOURCE_IDS) if (map.getSource(id)) map.removeSource(id)
}

function drawCatchment(map: maplibregl.Map, up: ReturnType<typeof upstreamOf>, west: number, north: number, cellDeg: number): void {
  const w = up.bounds.c1 - up.bounds.c0 + 1
  const h = up.bounds.r1 - up.bounds.r0 + 1
  // A very large catchment is drawn from every k-th cell, so the picture stays a few megapixels.
  const k = Math.max(1, Math.ceil(Math.sqrt((w * h) / 4_000_000)))
  const cw = Math.ceil(w / k), ch = Math.ceil(h / k)
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const img = ctx.createImageData(cw, ch)
  const at = (r: number, c: number) => (r < 0 || c < 0 || r >= ch || c >= cw ? 0 : up.mask[Math.min(h - 1, r * k) * w + Math.min(w - 1, c * k)])
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      if (!at(r, c)) continue
      const edge = !at(r - 1, c) || !at(r + 1, c) || !at(r, c - 1) || !at(r, c + 1)
      const i = (r * cw + c) * 4
      img.data[i] = 37
      img.data[i + 1] = 99
      img.data[i + 2] = 235
      img.data[i + 3] = edge ? 220 : 90
    }
  }
  ctx.putImageData(img, 0, 0)
  const wLng = west + up.bounds.c0 * cellDeg
  const eLng = wLng + w * cellDeg
  const nLat = north - up.bounds.r0 * cellDeg
  const sLat = nLat - h * cellDeg
  map.addSource(CATCH, { type: 'image', url: canvas.toDataURL('image/png'), coordinates: [[wLng, nLat], [eLng, nLat], [eLng, sLat], [wLng, sLat]] })
  map.addLayer({ id: CATCH, type: 'raster', source: CATCH, paint: { 'raster-opacity': 1, 'raster-resampling': 'nearest' } },
    map.getLayer('ctx-protected-fill') ? 'ctx-protected-fill' : undefined)
}

// ---- the tool --------------------------------------------------------------------------------------------------------

function kmBetween(a: [number, number], b: [number, number]): number {
  const kx = 111.32 * Math.cos(((a[1] + b[1]) / 2 * Math.PI) / 180)
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110.54)
}

export async function followWater(
  map: maplibregl.Map, base: string, lng: number, lat: number, look: WaterLookups,
): Promise<WaterResult | { error: string }> {
  const grid = await loadHydro(base)
  const cell = cellOf(grid, lng, lat)
  if (!cell) return { error: 'That point is outside the mapped area.' }
  const s = snapToStream(grid, cell.r, cell.c, 6)
  const up = upstreamOf(grid, s.r, s.c)
  const down = followDownstream(grid, s.r, s.c)
  const start = lngLatOf(grid, s.r, s.c)

  // Cut the path where it leaves Jharkhand.
  const coords: [number, number][] = []
  let leaves = false
  for (const c of down.cells) {
    const p = lngLatOf(grid, c.r, c.c)
    if (coords.length > 0 && !look.inState(p[0], p[1])) {
      leaves = true
      break
    }
    coords.push(p)
  }
  let pathKm = 0
  for (let i = 1; i < coords.length; i++) pathKm += kmBetween(coords[i - 1], coords[i])

  const segs = await loadRivers(base)
  const rivers: string[] = []
  for (let i = 0; i < coords.length; i += 6) {
    const n = nearestRiver(segs, coords[i][0], coords[i][1], 400)
    if (n && rivers[rivers.length - 1] !== n) rivers.push(n)
  }

  clearWaterOverlay(map)
  drawCatchment(map, up, grid.meta.west, grid.meta.north, grid.meta.cellDeg)
  const before = map.getLayer('ctx-mask-district') ? 'ctx-mask-district' : undefined
  map.addSource(PATH, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords.length > 1 ? coords : [start, start] } } })
  map.addLayer({ id: `${PATH}-casing`, type: 'line', source: PATH, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#FFFFFF', 'line-width': 6 } }, before)
  map.addLayer({ id: `${PATH}-line`, type: 'line', source: PATH, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0B3C7D', 'line-width': 3 } }, before)
  map.addSource(POINT, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: start } } })
  map.addLayer({ id: POINT, type: 'circle', source: POINT, paint: { 'circle-radius': 6, 'circle-color': '#FFFFFF', 'circle-stroke-color': '#0B3C7D', 'circle-stroke-width': 3 } }, before)

  return {
    lng: start[0], lat: start[1], snapped: s.snapped,
    areaKm2: up.areaKm2, areaIsLowerBound: up.touchesEdge || up.truncated,
    pathKm, end: leaves ? 'leaves-state' : down.end, rivers,
    nearRiver: nearestRiver(segs, start[0], start[1], 400),
    basin: look.basin(start[0], start[1]), district: look.district(start[0], start[1]),
  }
}
