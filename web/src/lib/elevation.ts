import { maptilerKey } from './basemaps'

/**
 * Surface elevation at a point (a surface model: it includes tree tops, so it can read a few metres high under forest), read from the same MapTiler Terrain RGB v2
 * tiles the 3D terrain is drawn from (a global 30 m-class model). Tiles are
 * 512 px, Mapbox terrain-RGB encoding: height = -10000 + (R*65536 + G*256 + B) * 0.1 m.
 * Checked 5 Nov 2026 at Parasnath: the decoded summit area reads about
 * 1,310–1,380 m against a published height of about 1,350 m.
 */

const Z = 12 // about 20 m per pixel at Jharkhand's latitude with 512 px tiles
const SIZE = 512
const tiles = new Map<string, Promise<ImageData | null>>()

function loadTile(x: number, y: number, key: string): Promise<ImageData | null> {
  const id = `${x}/${y}`
  let p = tiles.get(id)
  if (!p) {
    p = new Promise<ImageData | null>((resolve) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        try {
          const c = document.createElement('canvas')
          c.width = SIZE
          c.height = SIZE
          const ctx = c.getContext('2d', { willReadFrequently: true })
          if (!ctx) return resolve(null)
          ctx.drawImage(img, 0, 0, SIZE, SIZE)
          resolve(ctx.getImageData(0, 0, SIZE, SIZE))
        } catch {
          resolve(null)
        }
      }
      img.onerror = () => resolve(null)
      img.src = `https://api.maptiler.com/tiles/terrain-rgb-v2/${Z}/${x}/${y}?key=${key}`
    })
    tiles.set(id, p)
    p.then((d) => { if (!d) tiles.delete(id) })
  }
  return p
}

/** Metres above sea level, rounded; null without a MapTiler key or on error. */
export async function elevationAt(lng: number, lat: number): Promise<number | null> {
  const key = maptilerKey()
  if (!key) return null
  const n = 2 ** Z
  const fx = ((lng + 180) / 360) * n
  const rad = (lat * Math.PI) / 180
  const fy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n
  const tx = Math.floor(fx)
  const ty = Math.floor(fy)
  const data = await loadTile(tx, ty, key)
  if (!data) return null
  const px = Math.min(SIZE - 1, Math.floor((fx - tx) * SIZE))
  const py = Math.min(SIZE - 1, Math.floor((fy - ty) * SIZE))
  const i = (py * SIZE + px) * 4
  const h = -10000 + (data.data[i] * 65536 + data.data[i + 1] * 256 + data.data[i + 2]) * 0.1
  return Number.isFinite(h) ? Math.round(h) : null
}
