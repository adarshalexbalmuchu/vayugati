/**
 * Weather now for Jharkhand: one value per district (at the district's centre) and one for the whole state (the median of
 * the 24 districts). From Open-Meteo (open-meteo.com, CC BY 4.0), a weather-model value for the grid cell, fetched in a
 * single request for all 24 districts. A model value, not a thermometer reading; the header says so.
 */
import type { Geometry, Position } from 'geojson'

export const JH_BASE = '/city-packs/jharkhand'

export interface DistrictWeather {
  name: string
  tempC: number | null
  humidity: number | null
}

export interface JhWeather {
  /** Time of the readings (Open-Meteo, India time), as given. */
  asOf: string
  districts: DistrictWeather[]
}

export interface WeatherView {
  /** "Jharkhand" or the district's name. */
  label: string
  tempC: number | null
  humidity: number | null
  /** How many districts the figure is the median of (0 for a single district). */
  medianOf: number
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Area-weighted centroid of the largest part of a polygon (planar maths: fine at district size). */
export function districtCentroid(g: Geometry): { lat: number; lng: number } | null {
  const rings: Position[][] =
    g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : []
  let best: { a: number; cx: number; cy: number } | null = null
  for (const r of rings) {
    let a = 0, cx = 0, cy = 0
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]
      a += f
      cx += (r[j][0] + r[i][0]) * f
      cy += (r[j][1] + r[i][1]) * f
    }
    a /= 2
    if (!a) continue
    const c = { a: Math.abs(a), cx: cx / (6 * a), cy: cy / (6 * a) }
    if (!best || c.a > best.a) best = c
  }
  return best ? { lng: best.cx, lat: best.cy } : null
}

/** The figure to show: one district's, or the median over all districts when none is picked. */
export function weatherView(w: JhWeather, district: string | null): WeatherView | null {
  if (district) {
    const d = w.districts.find((x) => x.name === district)
    return d ? { label: d.name, tempC: d.tempC, humidity: d.humidity, medianOf: 0 } : null
  }
  const t = w.districts.map((d) => d.tempC).filter((v): v is number => v != null)
  const h = w.districts.map((d) => d.humidity).filter((v): v is number => v != null)
  if (!t.length && !h.length) return null
  return { label: 'Jharkhand', tempC: median(t), humidity: median(h), medianOf: Math.max(t.length, h.length) }
}

interface OpenMeteoCurrent { time?: string; temperature_2m?: number | null; relative_humidity_2m?: number | null }

const TTL_MS = 10 * 60_000
let cached: { at: number; p: Promise<JhWeather> } | null = null

/** All 24 districts in one request; reused for 10 minutes. */
export function fetchJhWeather(): Promise<JhWeather> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.p
  const p = (async () => {
    const res = await fetch(`${JH_BASE}/districts.geojson`)
    if (!res.ok) throw new Error(`districts: HTTP ${res.status}`)
    const fc = (await res.json()) as { features: { properties: { name?: string } | null; geometry: Geometry }[] }
    const pts = fc.features
      .map((f) => ({ name: String(f.properties?.name ?? ''), c: districtCentroid(f.geometry) }))
      .filter((x): x is { name: string; c: { lat: number; lng: number } } => x.name !== '' && x.c != null)
    const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
      latitude: pts.map((x) => x.c.lat.toFixed(3)).join(','),
      longitude: pts.map((x) => x.c.lng.toFixed(3)).join(','),
      current: 'temperature_2m,relative_humidity_2m',
      timezone: 'Asia/Kolkata',
    })
    const r = await fetch(url)
    if (!r.ok) throw new Error(`open-meteo: HTTP ${r.status}`)
    const body = (await r.json()) as { current?: OpenMeteoCurrent }[] | { current?: OpenMeteoCurrent }
    const arr = Array.isArray(body) ? body : [body]
    const districts = pts.map((x, i) => ({
      name: x.name,
      tempC: arr[i]?.current?.temperature_2m ?? null,
      humidity: arr[i]?.current?.relative_humidity_2m ?? null,
    }))
    return { asOf: arr.find((a) => a.current?.time)?.current?.time ?? '', districts }
  })()
  cached = { at: Date.now(), p }
  p.catch(() => { if (cached?.p === p) cached = null })
  return p
}
