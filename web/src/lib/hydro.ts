/**
 * Follow water over Jharkhand: from any point, where its water comes from (the upstream catchment) and where it goes (the
 * downstream path). Pure functions over a grid of D8 flow directions; the grid is built offline from FABDEM bare-earth
 * elevation by ingest/scripts/jharkhand/hydrology.py (see docs/JHARKHAND_3D_PLAN.md for the method and the check against
 * India-WRIS). A terrain-based estimate: it does not know dams, canals, pumping or drains, and drainage that comes from
 * outside the grid is cut at its edge.
 */

export interface HydroMeta {
  west: number
  north: number
  cellDeg: number
  ncol: number
  nrow: number
  snapKm2: number
  source: string
}

export interface HydroGrid {
  meta: HydroMeta
  /** 1 E, 2 SE, 3 S, 4 SW, 5 W, 6 NW, 7 N, 8 NE; 0 no outflow. Row 0 is the north edge. */
  dir: Uint8Array
  /** log2-scaled drainage cells * 10 for cells draining at least snapKm2; 0 elsewhere. */
  acc: Uint8Array
}

// direction index -> [row step, column step]; row grows southwards
const DR = [0, 0, 1, 1, 1, 0, -1, -1, -1]
const DC = [0, 1, 1, 0, -1, -1, -1, 0, 1]
// the direction a neighbour must flow in to drain into us, for each neighbour offset (we look at it from the neighbour)
const OPPOSITE = [0, 5, 6, 7, 8, 1, 2, 3, 4]

const KM_PER_DEG = 111.32

export function cellOf(g: HydroGrid, lng: number, lat: number): { r: number; c: number } | null {
  const c = Math.floor((lng - g.meta.west) / g.meta.cellDeg)
  const r = Math.floor((g.meta.north - lat) / g.meta.cellDeg)
  return r >= 0 && r < g.meta.nrow && c >= 0 && c < g.meta.ncol ? { r, c } : null
}

export function lngLatOf(g: HydroGrid, r: number, c: number): [number, number] {
  return [g.meta.west + (c + 0.5) * g.meta.cellDeg, g.meta.north - (r + 0.5) * g.meta.cellDeg]
}

/** Area of one cell in km2 at row r. */
export function cellAreaKm2(g: HydroGrid, r: number): number {
  const lat = g.meta.north - (r + 0.5) * g.meta.cellDeg
  return g.meta.cellDeg * 110.54 * (g.meta.cellDeg * KM_PER_DEG * Math.cos((lat * Math.PI) / 180))
}

/** Drainage area (km2) of a cell from its stored byte, or 0 when it is below the stored threshold. */
export function accKm2(g: HydroGrid, r: number, c: number): number {
  const b = g.acc[r * g.meta.ncol + c]
  return b === 0 ? 0 : 2 ** (b / 10) * cellAreaKm2(g, r)
}

/** Move a click onto the stream next to it (the cell with the largest drainage within `radius` cells), if there is one. */
export function snapToStream(g: HydroGrid, r: number, c: number, radius = 6): { r: number; c: number; snapped: boolean } {
  let best = g.acc[r * g.meta.ncol + c]
  let br = r
  let bc = c
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      const rr = r + dr
      const cc = c + dc
      if (rr < 0 || rr >= g.meta.nrow || cc < 0 || cc >= g.meta.ncol || dr * dr + dc * dc > radius * radius) continue
      const v = g.acc[rr * g.meta.ncol + cc]
      if (v > best) {
        best = v
        br = rr
        bc = cc
      }
    }
  }
  return { r: br, c: bc, snapped: br !== r || bc !== c }
}

export interface Downstream {
  /** Cells from the start to where the water leaves the grid, stops, or `maxSteps`. */
  cells: { r: number; c: number }[]
  lengthKm: number
  /** Why it ended: the grid edge, no outflow (a sink or flat), or the step limit. */
  end: 'edge' | 'sink' | 'limit'
}

export function followDownstream(g: HydroGrid, r: number, c: number, maxSteps = 200000): Downstream {
  const cells: { r: number; c: number }[] = [{ r, c }]
  let lengthKm = 0
  let end: Downstream['end'] = 'limit'
  const seen = new Set<number>([r * g.meta.ncol + c])
  for (let i = 0; i < maxSteps; i++) {
    const d = g.dir[r * g.meta.ncol + c]
    if (d === 0) {
      end = 'sink'
      break
    }
    const nr = r + DR[d]
    const nc = c + DC[d]
    if (nr < 0 || nr >= g.meta.nrow || nc < 0 || nc >= g.meta.ncol) {
      end = 'edge'
      break
    }
    const key = nr * g.meta.ncol + nc
    if (seen.has(key)) {
      end = 'sink' // a loop: should not happen after depression filling
      break
    }
    seen.add(key)
    const lat = g.meta.north - (r + 0.5) * g.meta.cellDeg
    const dy = DR[d] * g.meta.cellDeg * 110.54
    const dx = DC[d] * g.meta.cellDeg * KM_PER_DEG * Math.cos((lat * Math.PI) / 180)
    lengthKm += Math.hypot(dx, dy)
    r = nr
    c = nc
    cells.push({ r, c })
  }
  return { cells, lengthKm, end }
}

export interface Upstream {
  /** 1 for every cell that drains through the start cell, inside the box `bounds` (rows r0..r1, columns c0..c1). */
  mask: Uint8Array
  bounds: { r0: number; r1: number; c0: number; c1: number }
  cells: number
  areaKm2: number
  /** True when the catchment reaches the edge of the grid: the real catchment is larger than counted. */
  touchesEdge: boolean
  /** True when the step limit stopped the search. */
  truncated: boolean
}

/** Every cell whose water passes through (r, c): walk uphill over the neighbours that flow into the cell. */
export function upstreamOf(g: HydroGrid, r: number, c: number, maxCells = 15_000_000): Upstream {
  const { nrow, ncol } = g.meta
  const visited = new Uint8Array(nrow * ncol)
  let stack = new Uint32Array(1 << 16)
  let top = 0
  const push = (idx: number) => {
    if (top === stack.length) {
      const bigger = new Uint32Array(stack.length * 2)
      bigger.set(stack)
      stack = bigger
    }
    stack[top++] = idx
  }
  const start = r * ncol + c
  visited[start] = 1
  push(start)
  let cells = 0
  let area = 0
  let touchesEdge = false
  let r0 = r, r1 = r, c0 = c, c1 = c
  const rowArea = new Float64Array(nrow)
  for (let i = 0; i < nrow; i++) rowArea[i] = cellAreaKm2(g, i)
  while (top > 0 && cells < maxCells) {
    const idx = stack[--top]
    const cr = (idx / ncol) | 0
    const cc = idx - cr * ncol
    cells++
    area += rowArea[cr]
    if (cr < r0) r0 = cr
    if (cr > r1) r1 = cr
    if (cc < c0) c0 = cc
    if (cc > c1) c1 = cc
    if (cr === 0 || cc === 0 || cr === nrow - 1 || cc === ncol - 1) touchesEdge = true
    for (let d = 1; d <= 8; d++) {
      const nr = cr + DR[d]
      const nc = cc + DC[d]
      if (nr < 0 || nr >= nrow || nc < 0 || nc >= ncol) continue
      const nidx = nr * ncol + nc
      // the neighbour at offset d drains into us if it flows the opposite way
      if (visited[nidx] === 0 && g.dir[nidx] === OPPOSITE[d]) {
        visited[nidx] = 1
        push(nidx)
      }
    }
  }
  const w = c1 - c0 + 1
  const h = r1 - r0 + 1
  const mask = new Uint8Array(w * h)
  for (let rr = r0; rr <= r1; rr++) {
    const rowBase = rr * ncol
    for (let cc = c0; cc <= c1; cc++) if (visited[rowBase + cc]) mask[(rr - r0) * w + (cc - c0)] = 1
  }
  return { mask, bounds: { r0, r1, c0, c1 }, cells, areaKm2: area, touchesEdge, truncated: top > 0 }
}

// ---- loading -------------------------------------------------------------------------------------------------------

/** Our files are gzip bytes in a plain .bin file. If a server or a dev proxy already decoded one, it is used as it is. */
async function gunzip(res: Response): Promise<Uint8Array> {
  if (!res.ok) throw new Error(`${res.url}: HTTP ${res.status}`)
  const raw = new Uint8Array(await res.arrayBuffer())
  if (!(raw[0] === 0x1f && raw[1] === 0x8b)) return raw
  const out = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
  return new Uint8Array(out)
}

const gridCache = new Map<string, Promise<HydroGrid>>()

/** Fetch the flow grid (about 10 MB, once per session). */
export function loadHydro(base: string): Promise<HydroGrid> {
  let p = gridCache.get(base)
  if (!p) {
    p = (async () => {
      const [meta, dir, acc] = await Promise.all([
        fetch(`${base}/water/hydro.json`).then((r) => {
          if (!r.ok) throw new Error(`hydro.json: HTTP ${r.status}`)
          return r.json() as Promise<HydroMeta>
        }),
        fetch(`${base}/water/flowdir.bin`).then(gunzip),
        fetch(`${base}/water/flowacc.bin`).then(gunzip),
      ])
      if (dir.length !== meta.nrow * meta.ncol || acc.length !== dir.length) throw new Error('hydro grid size does not match its description')
      return { meta, dir, acc }
    })()
    p.catch(() => gridCache.delete(base))
    gridCache.set(base, p)
  }
  return p
}
