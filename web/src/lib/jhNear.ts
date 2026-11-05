/**
 * "What is within N km of this place?" for the Jharkhand assistant. Pure and deterministic: it counts and lists
 * features from the map's own data files, so the answer is exactly what the map shows. Source for every layer is
 * OpenStreetMap (3 Nov 2026) except heat detections (NASA FIRMS) and plants (names checked by Vayu Gati).
 */

import type { Feature, FeatureCollection, Geometry } from 'geojson'

export type NearWhat =
  | 'mines' | 'industrial' | 'plants' | 'kilns' | 'schools' | 'hospitals' | 'towns' | 'villages' | 'heat'
  | 'peaks' | 'rail_stations' | 'substations'

export interface NearSpec {
  /** Which pack file holds it (see FILES in CityContextLayers). */
  file: 'sources' | 'kilns' | 'facilities' | 'places' | 'fires' | 'landmarks' | 'transport' | 'power'
  match: (p: Record<string, unknown>) => boolean
  label: string
  source: string
}

const OSM = 'OpenStreetMap, mapped by volunteers (3 Nov 2026). Incomplete: what is mapped, not what exists.'

export const NEAR_SPECS: Record<NearWhat, NearSpec> = {
  mines: { file: 'sources', match: (p) => p.kind === 'mine', label: 'mapped mining and quarry areas', source: OSM },
  industrial: { file: 'sources', match: (p) => p.kind === 'industrial', label: 'mapped industrial areas', source: OSM },
  plants: { file: 'sources', match: (p) => p.kind === 'power_plant' || p.kind === 'works', label: 'power plants and large works (names and operators checked by Vayu Gati)', source: 'Locations: OpenStreetMap. Only checked sites are included, so others may be missing.' },
  kilns: { file: 'kilns', match: () => true, label: 'mapped brick kilns', source: OSM },
  schools: { file: 'facilities', match: (p) => ['school', 'college', 'university'].includes(String(p.kind)), label: 'mapped schools and colleges', source: OSM },
  hospitals: { file: 'facilities', match: (p) => ['hospital', 'clinic'].includes(String(p.kind)), label: 'mapped hospitals and clinics', source: OSM },
  towns: { file: 'places', match: (p) => p.kind === 'city' || p.kind === 'town', label: 'cities and towns', source: OSM },
  villages: { file: 'places', match: (p) => p.kind === 'village', label: 'mapped villages', source: OSM },
  heat: { file: 'fires', match: () => true, label: 'satellite heat detections (last 5 days in the map data)', source: 'NASA FIRMS (VIIRS). A hot 375 m pixel: a coal fire, industrial heat or open burning; not a measured fire area.' },
  peaks: { file: 'landmarks', match: (p) => p.kind === 'peak', label: 'mapped hill peaks', source: OSM },
  rail_stations: { file: 'transport', match: (p) => p.kind === 'rail_station', label: 'mapped railway stations', source: OSM },
  substations: { file: 'power', match: (p) => p.kind === 'substation', label: 'mapped electricity substations', source: OSM },
}

export function haversineKm(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const R = 6371.0088
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(lat2 - lat1)
  const dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** A representative point: the point itself, or the middle of a shape's bounding box. */
export function anchor(g: Geometry): [number, number] | null {
  if (g.type === 'Point') return [g.coordinates[0], g.coordinates[1]]
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      const [x, y] = c as number[]
      if (x < w) w = x
      if (x > e) e = x
      if (y < s) s = y
      if (y > n) n = y
    } else if (Array.isArray(c)) c.forEach(walk)
  }
  if ('coordinates' in g) walk(g.coordinates)
  return Number.isFinite(w) ? [(w + e) / 2, (s + n) / 2] : null
}

export interface NearHit { name: string; kind: string; km: number }
export interface NearResult { count: number; nearest: NearHit[]; spec: NearSpec }

export function near(fc: FeatureCollection, what: NearWhat, lng: number, lat: number, radiusKm: number, listMax = 5): NearResult {
  const spec = NEAR_SPECS[what]
  const hits: NearHit[] = []
  for (const f of fc.features as Feature[]) {
    const p = (f.properties ?? {}) as Record<string, unknown>
    if (!spec.match(p)) continue
    const a = anchor(f.geometry)
    if (!a) continue
    const km = haversineKm(lng, lat, a[0], a[1])
    if (km <= radiusKm) hits.push({ name: String(p.name ?? ''), kind: String(p.kind ?? ''), km })
  }
  hits.sort((x, y) => x.km - y.km)
  return { count: hits.length, nearest: hits.slice(0, listMax), spec }
}
