import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import type { Feature, FeatureCollection, Geometry, Polygon, Position } from 'geojson'
import { maptilerKey } from '../../lib/basemaps'
import { elevationAt } from '../../lib/elevation'

/**
 * Static context layers for a city pack. For Jharkhand the pack covers the
 * whole state, every district: outlines; ESA land cover; NASA night lights;
 * satellite imagery and relief; forests, protected areas, rivers and water;
 * towns, villages, built-up areas, schools and hospitals; railways, roads,
 * power lines; mines, industry, checked power plants, brick kilns; satellite
 * heat detections; peaks, waterfalls and dams. The list and its notes live
 * in lib/contextLayers.ts.
 *
 * No block boundaries: no official block boundaries are published for
 * download, and the open ones are Census-era blocks that no longer match the
 * district. The files are built by ingest/scripts/jharkhand/build_layers.py
 * into data/jharkhand/processed/ and copied to web/public/city-packs/<pack>/.
 * Context only: these are mapped features, not measurements.
 *
 * Renders nothing itself; it adds MapLibre sources and layers to `map` (and,
 * with `showViewControl`, a Jharkhand / city zoom control), and re-adds them
 * after every setStyle() (which wipes custom layers).
 */

import { CONTEXT_GROUPS, CONTEXT_LAYER_DEFS, CONTEXT_SWATCH, DEFAULT_CONTEXT_VISIBLE } from '../../lib/contextLayers'
import type { CityContextLayerKey, CityContextVisibility } from '../../lib/contextLayers'
import { useState } from 'react'
import MapAssistant from './MapAssistant'
import type { ProfilesDoc as FactsDoc } from '../../lib/jhFacts'

interface ContextPack {
  base: string
  /** Label of the wider view, for the zoom control. */
  regionLabel: string
  /** [W, S, E, N] of the wider view (the state outline's extent). */
  regionBounds: [number, number, number, number]
}

/** City codes with a context pack, and where its files are served from. */
export const CONTEXT_PACKS: Record<string, ContextPack> = {
  dhanbad: {
    base: '/city-packs/jharkhand',
    regionLabel: 'Jharkhand',
    regionBounds: [83.33, 21.97, 87.98, 25.35],
  },
}

export function hasContextPack(cityCode: string | null | undefined): boolean {
  return cityCode != null && cityCode in CONTEXT_PACKS
}

const FILES = {
  state: 'state.geojson',
  districts: 'districts.geojson',
  sources: 'sources.geojson',
  roads: 'roads.geojson',
  fires: 'fires_firms_5d.geojson',
  stations: 'stations.geojson',
  railways: 'railways.geojson',
  rivers: 'rivers.geojson',
  water: 'water.geojson',
  forest: 'forest.geojson',
  protected: 'protected.geojson',
  places: 'places.geojson',
  facilities: 'facilities.geojson',
  landmarks: 'landmarks.geojson',
  transport: 'transport.geojson',
  power: 'power.geojson',
  kilns: 'kilns.geojson',
  builtup: 'builtup.geojson',
  towngrid: 'town_grids.geojson',
} as const
/** Files the map can do without (an older pack): they load as empty. */
const OPTIONAL = new Set(['railways', 'rivers', 'water', 'forest', 'protected', 'places', 'facilities', 'landmarks',
  'transport', 'power', 'kilns', 'builtup', 'towngrid'])

interface LandcoverMeta {
  coordinates: [[number, number], [number, number], [number, number], [number, number]]
  classes: { value: number; label: string; color: string }[]
  source: string
}

type PackData = Record<keyof typeof FILES, FeatureCollection>

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] }

const cache = new Map<string, Promise<PackData>>()

const landcoverCache = new Map<string, Promise<LandcoverMeta | null>>()
function loadLandcover(base: string): Promise<LandcoverMeta | null> {
  let p = landcoverCache.get(base)
  if (!p) {
    p = fetch(`${base}/landcover_2021.json`)
      .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? (r.json() as Promise<LandcoverMeta>) : null))
      .catch(() => null)
    landcoverCache.set(base, p)
  }
  return p
}

function loadPack(base: string): Promise<PackData> {
  let p = cache.get(base)
  if (!p) {
    p = Promise.all(
      Object.entries(FILES).map(async ([k, file]) => {
        const res = await fetch(`${base}/${file}`).catch(() => null)
        const ok = res?.ok && (res.headers.get('content-type') ?? '').includes('json')
        if (!ok) {
          if (OPTIONAL.has(k)) return [k, EMPTY_FC] as const
          throw new Error(`${file}: HTTP ${res?.status ?? 'network error'}`)
        }
        return [k, (await res!.json()) as FeatureCollection] as const
      }),
    ).then((entries) => Object.fromEntries(entries) as PackData)
    p.catch(() => cache.delete(base))
    cache.set(base, p)
  }
  return p
}

const SRC = {
  state: 'ctx-state',
  districts: 'ctx-districts',
  sources: 'ctx-sources',
  roads: 'ctx-roads',
  fires: 'ctx-fires',
  stations: 'ctx-stations',
  railways: 'ctx-railways',
  rivers: 'ctx-rivers',
  water: 'ctx-water',
  forest: 'ctx-forest',
  protected: 'ctx-protected',
  places: 'ctx-places',
  facilities: 'ctx-facilities',
  landmarks: 'ctx-landmarks',
  transport: 'ctx-transport',
  power: 'ctx-power',
  kilns: 'ctx-kilns',
  builtup: 'ctx-builtup',
  towngrid: 'ctx-towngrid',
} as const

/** Layer ids per toggle. The state outline goes with the districts toggle. */
const LAYERS: Record<CityContextLayerKey, string[]> = {
  districts: ['ctx-districts-fill', 'ctx-districts-line', 'ctx-state-line'],
  landcover: ['ctx-landcover'],
  nightlights: ['ctx-nightlights'],
  satellite: [], // added and removed on demand (see ensureSatellite)
  relief: [], // added and removed on demand (see ensureRelief)
  forest: ['ctx-forest-fill'],
  protected: ['ctx-protected-fill', 'ctx-protected-line'],
  water: ['ctx-water-fill', 'ctx-rivers-line'],
  places: ['ctx-places-town', 'ctx-places-village', 'ctx-places-label-town', 'ctx-places-label-village'],
  builtup: ['ctx-builtup-fill'],
  towngrid: ['ctx-towngrid-fill', 'ctx-towngrid-line'],
  facilities: ['ctx-facilities'],
  railways: ['ctx-railways-main', 'ctx-railways-siding', 'ctx-transport'],
  roads: ['ctx-roads-line'],
  power: ['ctx-power-line', 'ctx-power-sub'],
  industry: ['ctx-industry-fill', 'ctx-plants'],
  mines: ['ctx-mines-fill', 'ctx-mines-line'],
  kilns: ['ctx-kilns'],
  fires: ['ctx-fires'],
  landmarks: ['ctx-landmarks', 'ctx-landmarks-label'],
}

/** Topmost first: a click shows the popup of the highest feature under it. */
const CLICKABLE = ['ctx-plants', 'ctx-fires', 'ctx-kilns', 'ctx-landmarks', 'ctx-transport', 'ctx-facilities',
  'ctx-power-sub', 'ctx-places-town', 'ctx-places-village', 'ctx-mines-fill', 'ctx-industry-fill', 'ctx-railways-main',
  'ctx-railways-siding', 'ctx-rivers-line', 'ctx-water-fill', 'ctx-protected-fill', 'ctx-forest-fill', 'ctx-builtup-fill',
  'ctx-towngrid-fill', 'ctx-districts-fill']

/** District shading is only clickable zoomed out, so it never competes with
 *  ward cells and mapped features in the city view. */
const DISTRICT_CLICK_MAX_ZOOM = 9

/** Layers that are not tied to a toggle: the masks and the selected-district outline. */
const MASK_STATE = 'ctx-mask-state'
const MASK_DISTRICT = 'ctx-mask-district'
const DISTRICT_SELECTED = 'ctx-district-selected'
const MASK_COLOR = '#EFECE6'

const WORLD_RING: Position[] = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]

function ringArea(r: Position[]): number {
  let a = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1])
  return a / 2
}

/** The world with `g` cut out, so everything outside `g` can be covered. */
function maskOutside(g: Geometry): Feature<Polygon> {
  const outers: Position[][] =
    g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : []
  // Holes wind opposite to the outer ring (WORLD_RING is counter-clockwise).
  const holes = outers.map((r) => (ringArea(r) > 0 ? r : [...r].reverse()))
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [WORLD_RING, ...holes] } }
}

/** False once map.remove() has run (MapLibre then drops its style, and
 *  getLayer/setFilter throw). React can still hold the old instance for a
 *  render, e.g. on a hot reload or when the page unmounts. */
function alive(map: maplibregl.Map | null | undefined): map is maplibregl.Map {
  return map != null && (map as unknown as { style?: unknown }).style != null
}

function bboxOf(g: Geometry): [number, number, number, number] {
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
  return [w, s, e, n]
}

const KIND_LABEL: Record<string, string> = {
  mine: 'Mining or quarry area',
  industrial: 'Industrial land',
  power_plant: 'Power plant',
  works: 'Large works',
  city: 'City',
  town: 'Town',
  village: 'Village',
  school: 'School',
  college: 'College',
  university: 'University',
  hospital: 'Hospital',
  clinic: 'Clinic',
  peak: 'Hill peak',
  waterfall: 'Waterfall',
  dam: 'Dam',
  rail_station: 'Railway station',
  airport: 'Airport or airstrip',
  substation: 'Electricity substation',
  line: 'Power line',
  brick_kiln: 'Brick kiln',
  built_up: 'Built-up area',
  forest: 'Forest or woodland',
  protected: 'Protected area',
  water: 'Water body',
  river: 'River',
  canal: 'Canal',
  main: 'Railway line',
  siding: 'Railway siding or yard',
}

/** A font the current style's glyph server has (taken from one of its own
 *  label layers); null if the style has no glyphs, then no labels. */
function labelFont(map: maplibregl.Map): string[] | null {
  const style = map.getStyle()
  if (!style?.glyphs) return null
  for (const l of style.layers ?? []) {
    const f = (l as { layout?: Record<string, unknown> }).layout?.['text-font']
    if (Array.isArray(f) && f.every((x) => typeof x === 'string')) return f as string[]
  }
  return null
}

function addAll(map: maplibregl.Map, data: PackData, visible: CityContextVisibility, landcover: LandcoverMeta | null, base: string) {
  if (map.getSource(SRC.sources)) return
  for (const [k, id] of Object.entries(SRC)) {
    map.addSource(id, { type: 'geojson', data: data[k as keyof PackData] })
  }
  const vis = (key: CityContextLayerKey) => (visible[key] ? 'visible' : 'none') as 'visible' | 'none'
  if (visible.districts) hideBasemapBoundaries(map)
  const font = labelFont(map)
  // Rasters first (bottom): land cover, night lights.
  if (landcover) {
    map.addSource('ctx-landcover', { type: 'image', url: `${base}/landcover_2021.png`, coordinates: landcover.coordinates })
    map.addLayer({ id: 'ctx-landcover', type: 'raster', source: 'ctx-landcover', layout: { visibility: vis('landcover') },
      paint: { 'raster-opacity': 0.8, 'raster-resampling': 'nearest' } })
  }
  map.addSource('ctx-nightlights', {
    type: 'raster',
    tiles: ['https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'],
    tileSize: 256,
    maxzoom: 8,
    attribution: 'Night lights: NASA Black Marble 2016 (NASA GIBS)',
  })
  map.addLayer({ id: 'ctx-nightlights', type: 'raster', source: 'ctx-nightlights', layout: { visibility: vis('nightlights') },
    paint: { 'raster-opacity': 0.85 } })
  // Areas
  map.addLayer({ id: 'ctx-forest-fill', type: 'fill', source: SRC.forest, layout: { visibility: vis('forest') },
    paint: { 'fill-color': '#2F7D3A', 'fill-opacity': 0.35 } })
  map.addLayer({ id: 'ctx-protected-fill', type: 'fill', source: SRC.protected, layout: { visibility: vis('protected') },
    paint: { 'fill-color': '#1B5E20', 'fill-opacity': 0.12 } })
  map.addLayer({ id: 'ctx-protected-line', type: 'line', source: SRC.protected, layout: { visibility: vis('protected') },
    paint: { 'line-color': '#1B5E20', 'line-width': 1.4, 'line-dasharray': [3, 2] } })
  map.addLayer({ id: 'ctx-towngrid-fill', type: 'fill', source: SRC.towngrid, layout: { visibility: vis('towngrid') },
    paint: { 'fill-color': '#1F6F8B', 'fill-opacity': 0.08 } })
  map.addLayer({ id: 'ctx-towngrid-line', type: 'line', source: SRC.towngrid, layout: { visibility: vis('towngrid') },
    paint: { 'line-color': '#1F6F8B', 'line-width': 1, 'line-dasharray': [2, 1.5] } })
  map.addLayer({ id: 'ctx-builtup-fill', type: 'fill', source: SRC.builtup, layout: { visibility: vis('builtup') },
    paint: { 'fill-color': '#C8663E', 'fill-opacity': 0.35 } })
  map.addLayer({ id: 'ctx-water-fill', type: 'fill', source: SRC.water, layout: { visibility: vis('water') },
    paint: { 'fill-color': '#3B82C4', 'fill-opacity': 0.75 } })
  map.addLayer({ id: 'ctx-rivers-line', type: 'line', source: SRC.rivers, layout: { visibility: vis('water') },
    paint: { 'line-color': '#3B82C4', 'line-width': ['interpolate', ['linear'], ['zoom'], 6,
      ['match', ['get', 'kind'], 'river', 0.8, 0.4], 11, ['match', ['get', 'kind'], 'river', 2.4, 1.2]] } })
  map.addLayer({
    id: 'ctx-districts-fill',
    type: 'fill',
    source: SRC.districts,
    layout: { visibility: vis('districts') },
    // Near-transparent: the fill is only there so a district can be clicked.
    paint: { 'fill-color': '#FFFFFF', 'fill-opacity': 0.01 },
  })
  map.addLayer({
    id: 'ctx-districts-line',
    type: 'line',
    source: SRC.districts,
    layout: { visibility: vis('districts') },
    paint: { 'line-color': '#5B4A3A', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 10, 1.4], 'line-opacity': 0.8 },
  })
  map.addLayer({
    id: 'ctx-roads-line',
    type: 'line',
    source: SRC.roads,
    minzoom: 7,
    layout: { visibility: vis('roads') },
    paint: {
      'line-color': '#C0392B',
      'line-opacity': 0.75,
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        7, ['match', ['get', 'highway'], ['motorway', 'trunk'], 1.2, 'primary', 0.7, 0.3],
        11, ['match', ['get', 'highway'], ['motorway', 'trunk'], 2.4, 'primary', 1.6, 1],
      ],
    },
  })
  map.addLayer({ id: 'ctx-railways-siding', type: 'line', source: SRC.railways, filter: ['==', ['get', 'kind'], 'siding'],
    minzoom: 9, layout: { visibility: vis('railways') }, paint: { 'line-color': '#7A4E2D', 'line-width': 1.1 } })
  map.addLayer({ id: 'ctx-railways-main', type: 'line', source: SRC.railways, filter: ['!=', ['get', 'kind'], 'siding'],
    layout: { visibility: vis('railways') },
    paint: { 'line-color': '#2B2B2B', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1, 11, 2.4] } })
  map.addLayer({ id: 'ctx-power-line', type: 'line', source: SRC.power, filter: ['==', ['get', 'kind'], 'line'],
    layout: { visibility: vis('power') }, paint: { 'line-color': '#8E44AD', 'line-width': 1, 'line-opacity': 0.8 } })
  map.addLayer({
    id: 'ctx-industry-fill',
    type: 'fill',
    source: SRC.sources,
    filter: ['==', ['get', 'kind'], 'industrial'],
    layout: { visibility: vis('industry') },
    paint: { 'fill-color': '#9B6BD1', 'fill-opacity': 0.55 },
  })
  map.addLayer({
    id: 'ctx-mines-fill',
    type: 'fill',
    source: SRC.sources,
    filter: ['==', ['get', 'kind'], 'mine'],
    layout: { visibility: vis('mines') },
    paint: { 'fill-color': '#3D3D3D', 'fill-opacity': 0.7 },
  })
  map.addLayer({
    id: 'ctx-mines-line',
    type: 'line',
    source: SRC.sources,
    filter: ['==', ['get', 'kind'], 'mine'],
    layout: { visibility: vis('mines') },
    paint: { 'line-color': '#1F1F1F', 'line-width': 0.6 },
  })
  map.addLayer({ id: 'ctx-power-sub', type: 'circle', source: SRC.power, filter: ['==', ['get', 'kind'], 'substation'],
    minzoom: 8, layout: { visibility: vis('power') },
    paint: { 'circle-radius': 3.5, 'circle-color': '#8E44AD', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } })
  map.addLayer({ id: 'ctx-facilities', type: 'circle', source: SRC.facilities, minzoom: 10, layout: { visibility: vis('facilities') },
    paint: { 'circle-radius': 3.5, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1,
      'circle-color': ['match', ['get', 'kind'], ['hospital', 'clinic'], '#D62D20', '#1E88E5'] } })
  map.addLayer({ id: 'ctx-places-village', type: 'circle', source: SRC.places, filter: ['==', ['get', 'kind'], 'village'],
    minzoom: 10, layout: { visibility: vis('places') },
    paint: { 'circle-radius': 2.2, 'circle-color': '#5B4A3A', 'circle-opacity': 0.8 } })
  map.addLayer({ id: 'ctx-places-town', type: 'circle', source: SRC.places, filter: ['in', ['get', 'kind'], ['literal', ['city', 'town']]],
    layout: { visibility: vis('places') },
    paint: { 'circle-radius': ['match', ['get', 'kind'], 'city', 5, 3.5], 'circle-color': '#FFFFFF',
      'circle-stroke-color': '#2E2219', 'circle-stroke-width': 1.5 } })
  map.addLayer({ id: 'ctx-transport', type: 'circle', source: SRC.transport, minzoom: 8, layout: { visibility: vis('railways') },
    paint: { 'circle-radius': ['match', ['get', 'kind'], 'airport', 5, 3], 'circle-color': ['match', ['get', 'kind'], 'airport', '#00796B', '#2B2B2B'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } })
  map.addLayer({ id: 'ctx-kilns', type: 'circle', source: SRC.kilns, layout: { visibility: vis('kilns') },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 2, 11, 4.5], 'circle-color': '#A0522D',
      'circle-stroke-color': '#fff', 'circle-stroke-width': 0.8 } })
  map.addLayer({ id: 'ctx-landmarks', type: 'circle', source: SRC.landmarks, minzoom: 7, layout: { visibility: vis('landmarks') },
    paint: { 'circle-radius': 4, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1,
      'circle-color': ['match', ['get', 'kind'], 'peak', '#6D4C41', 'waterfall', '#0288D1', '#455A64'] } })
  if (font) {
    map.addLayer({ id: 'ctx-places-label-town', type: 'symbol', source: SRC.places,
      filter: ['in', ['get', 'kind'], ['literal', ['city', 'town']]], minzoom: 6.5, layout: { visibility: vis('places'),
        'text-field': ['get', 'name'], 'text-font': font, 'text-size': ['match', ['get', 'kind'], 'city', 13, 11],
        'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#2E2219', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.5 } })
    map.addLayer({ id: 'ctx-places-label-village', type: 'symbol', source: SRC.places, filter: ['==', ['get', 'kind'], 'village'],
      minzoom: 11.5, layout: { visibility: vis('places'), 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 10,
        'text-offset': [0, 0.7], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#4A3B2E', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.2 } })
    map.addLayer({ id: 'ctx-landmarks-label', type: 'symbol', source: SRC.landmarks, minzoom: 9,
      filter: ['!=', ['get', 'name'], ''], layout: { visibility: vis('landmarks'),
        'text-field': ['case', ['all', ['==', ['get', 'kind'], 'peak'], ['!=', ['get', 'ele'], '']],
          ['concat', ['get', 'name'], ' (', ['get', 'ele'], ' m)'], ['get', 'name']],
        'text-font': font, 'text-size': 10, 'text-offset': [0, 0.8], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#3E2723', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.2 } })
  }
  map.addLayer({
    id: 'ctx-plants',
    type: 'circle',
    source: SRC.sources,
    filter: ['in', ['get', 'kind'], ['literal', ['power_plant', 'works']]],
    layout: { visibility: vis('industry') },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.5, 10, 6],
      'circle-color': '#FFBF00',
      'circle-stroke-color': '#333',
      'circle-stroke-width': 1.5,
    },
  })
  map.addLayer({
    id: 'ctx-fires',
    type: 'circle',
    source: SRC.fires,
    layout: { visibility: vis('fires') },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 2, 10, 3.5], 'circle-color': '#E4572E', 'circle-opacity': 0.85 },
  })
  // Everything outside the selected district is dimmed, and everything
  // outside Jharkhand is covered: the platform shows Jharkhand only.
  map.addSource(MASK_DISTRICT, { type: 'geojson', data: EMPTY_FC })
  map.addLayer({ id: MASK_DISTRICT, type: 'fill', source: MASK_DISTRICT, paint: { 'fill-color': MASK_COLOR, 'fill-opacity': 0.72 } })
  const stateGeom = data.state.features[0]?.geometry
  map.addSource(MASK_STATE, { type: 'geojson', data: stateGeom ? maskOutside(stateGeom) : EMPTY_FC })
  map.addLayer({ id: MASK_STATE, type: 'fill', source: MASK_STATE, paint: { 'fill-color': MASK_COLOR, 'fill-opacity': 1 } })
  map.addLayer({
    id: 'ctx-state-line',
    type: 'line',
    source: SRC.state,
    layout: { visibility: vis('districts') },
    paint: { 'line-color': '#2E2219', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.6, 10, 2.6] },
  })
  map.addLayer({
    id: DISTRICT_SELECTED,
    type: 'line',
    source: SRC.districts,
    filter: ['==', ['get', 'name'], ''],
    paint: { 'line-color': '#B5542E', 'line-width': 3 },
  })
}

/** The basemap draws its own administrative lines (from OpenStreetMap), and
 *  in places they disagree with ours (OSM's Kodarma is 35% too small). Two sets
 *  of borders on one map reads as an error, so the basemap's are hidden while
 *  our outlines are shown, and restored afterwards. */
const hiddenBasemapBoundaries = new WeakMap<maplibregl.Map, string[]>()
function hideBasemapBoundaries(map: maplibregl.Map) {
  const hidden: string[] = []
  for (const l of map.getStyle()?.layers ?? []) {
    if (l.id.startsWith('ctx-') || (l as { 'source-layer'?: string })['source-layer'] !== 'boundary') continue
    if (map.getLayoutProperty(l.id, 'visibility') === 'none') continue
    map.setLayoutProperty(l.id, 'visibility', 'none')
    hidden.push(l.id)
  }
  hiddenBasemapBoundaries.set(map, hidden)
}
function restoreBasemapBoundaries(map: maplibregl.Map) {
  for (const id of hiddenBasemapBoundaries.get(map) ?? []) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible')
  hiddenBasemapBoundaries.delete(map)
}

function removeAll(map: maplibregl.Map) {
  restoreBasemapBoundaries(map)
  for (const id of [DISTRICT_SELECTED, MASK_STATE, MASK_DISTRICT]) if (map.getLayer(id)) map.removeLayer(id)
  for (const ids of Object.values(LAYERS)) for (const id of ids) if (map.getLayer(id)) map.removeLayer(id)
  for (const id of [...Object.values(SRC), MASK_STATE, MASK_DISTRICT, 'ctx-landcover', 'ctx-nightlights']) if (map.getSource(id)) map.removeSource(id)
  removeSatellite(map)
  removeRelief(map)
}

function popupNode(props: Record<string, unknown>, layerId: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'text-xs leading-snug space-y-1'
  const line = (text: string, bold = false) => {
    const p = document.createElement('p')
    p.textContent = text
    if (bold) p.className = 'font-semibold'
    el.appendChild(p)
  }
  if (layerId === 'ctx-districts-fill') {
    line(`${props.name} district`, true)
    line('Outline: open data (Datameet / Census 2011, OpenStreetMap, geoBoundaries), not Survey of India’s own file.')
  } else if (layerId === 'ctx-towngrid-fill') {
    line(`${props.town} grid cell ${props.id}`, true)
    line(`${props.district} district · ${props.area_km2} km² · ${props.builtup_pct}% built-up (ESA WorldCover 2021)`)
    line('A 3 km working grid by Vayu Gati. Not a ward or municipal boundary.')
  } else if (layerId === 'ctx-fires') {
    line('Satellite heat detection (NASA FIRMS, VIIRS)', true)
    line(`${props.date ?? ''} · ${props.daynight === 'N' ? 'night' : 'day'} · fire radiative power ${props.frp ?? '—'} MW`)
    line('A 375 m pixel that was unusually hot when the satellite passed. It can be a coal fire at the surface, industrial heat, or crop or forest burning. It is not a measured fire area.')
  } else if (['ctx-places-town', 'ctx-places-village', 'ctx-facilities', 'ctx-landmarks', 'ctx-transport', 'ctx-power-sub',
    'ctx-kilns', 'ctx-railways-main', 'ctx-railways-siding', 'ctx-rivers-line', 'ctx-water-fill', 'ctx-protected-fill',
    'ctx-forest-fill', 'ctx-builtup-fill'].includes(layerId)) {
    const kind = KIND_LABEL[String(props.kind)] ?? ''
    line(String(props.name || kind || 'Mapped feature'), true)
    if (props.name && kind) line(kind)
    if (props.kind === 'peak' && props.ele) line(`Height as mapped: ${props.ele} m`)
    if (props.kind === 'line' && props.voltage) line(`Voltage as mapped: ${props.voltage} V`)
    line('Source: OpenStreetMap, mapped by volunteers (3 Nov 2026). May be incomplete or out of date.')
  } else if (props.checked) {
    line(String(props.name), true)
    line(KIND_LABEL[String(props.kind)] ?? '')
    if (props.operator) line(`Operator: ${props.operator}`)
    line('Location: OpenStreetMap. Name and operator checked by Vayu Gati, Nov 2026.')
  } else {
    line(String(props.name || KIND_LABEL[String(props.kind)] || 'Mapped feature'), true)
    if (props.name) line(KIND_LABEL[String(props.kind)] ?? '')
    line('Source: OpenStreetMap, mapped by volunteers. Not an official lease or land-use boundary, and some areas are missing.')
  }
  return el
}

/** Default height exaggeration in the district 3D view. Jharkhand's relief
 *  (about 100 to 1,350 m) reads as flat at true scale over a whole district;
 *  the control shows the factor and lets the viewer change it (1x to 6x). */
const EXAGGERATION_3D = 3
const CONTOUR_SOURCE = 'ctx-contours'
const CONTOUR_LINE = 'ctx-contours-line'
const CONTOUR_LABEL = 'ctx-contours-label'
/** MapView's own terrain source on /map (MapTiler); reused when present. */
const MAPVIEW_DEM_SOURCE = 'maptiler-terrain-dem'
const DEM_SOURCE = 'ctx-dem'
const HILLSHADE_SOURCE = 'ctx-hillshade-dem'
const HILLSHADE_LAYER = 'ctx-hillshade'
const SAT_SOURCE = 'ctx-satellite'
const SAT_LAYER = 'ctx-satellite'

function demSourceSpec(): maplibregl.RasterDEMSourceSpecification {
  const key = maptilerKey()
  if (key) {
    // MapTiler Terrain RGB v2: a global 30 m-class elevation model.
    return { type: 'raster-dem', url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${key}`, tileSize: 512, maxzoom: 14 }
  }
  // Keyless fallback: AWS Open Data Terrain Tiles (SRTM and other public DEMs).
  return {
    type: 'raster-dem',
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 14,
    attribution: 'Elevation: AWS Terrain Tiles (SRTM and others)',
  }
}

const SKY: maplibregl.SkySpecification = {
  'sky-color': '#9CC3E4',
  'horizon-color': '#E9EEF2',
  'fog-color': '#EFECE6',
  'sky-horizon-blend': 0.5,
  'horizon-fog-blend': 0.6,
  'fog-ground-blend': 0.2,
}

/** Satellite imagery and relief are added only while switched on (or while a
 *  district is in 3D, which manages them itself). */
function applyOnDemand(map: maplibregl.Map, visible: CityContextVisibility, in3D: boolean) {
  if (in3D || !alive(map)) return
  if (visible.satellite) ensureSatellite(map, true)
  else removeSatellite(map)
  if (visible.relief) ensureRelief(map, !visible.satellite, visible.satellite)
  else removeRelief(map)
}

/** Satellite imagery under the vector layers. */
function ensureSatellite(map: maplibregl.Map, visible = true) {
  const key = maptilerKey()
  if (!key || !alive(map)) return
  if (!map.getSource(SAT_SOURCE)) {
    map.addSource(SAT_SOURCE, { type: 'raster', url: `https://api.maptiler.com/tiles/satellite-v2/tiles.json?key=${key}`, tileSize: 512 })
  }
  if (!map.getLayer(SAT_LAYER)) {
    map.addLayer({ id: SAT_LAYER, type: 'raster', source: SAT_SOURCE,
      paint: { 'raster-saturation': -0.1, 'raster-contrast': 0.08 } }, anchorBelow(map, 'ctx-forest-fill'))
  }
  map.setLayoutProperty(SAT_LAYER, 'visibility', visible ? 'visible' : 'none')
}

function removeSatellite(map: maplibregl.Map) {
  if (map.getLayer(SAT_LAYER)) map.removeLayer(SAT_LAYER)
  if (map.getSource(SAT_SOURCE)) map.removeSource(SAT_SOURCE)
}

/** Hill shading plus contour lines (with height labels where the style has glyphs). */
function ensureRelief(map: maplibregl.Map, strong: boolean, onSatellite: boolean) {
  if (!alive(map)) return
  const key = maptilerKey()
  if (!map.getSource(HILLSHADE_SOURCE)) map.addSource(HILLSHADE_SOURCE, demSourceSpec())
  if (!map.getLayer(HILLSHADE_LAYER)) {
    map.addLayer({ id: HILLSHADE_LAYER, type: 'hillshade', source: HILLSHADE_SOURCE, paint: {
      'hillshade-illumination-direction': 315, 'hillshade-shadow-color': '#2B2218',
      'hillshade-highlight-color': '#FFFFFF', 'hillshade-accent-color': '#5C4B3A' } }, anchorBelow(map, 'ctx-forest-fill'))
  }
  map.setPaintProperty(HILLSHADE_LAYER, 'hillshade-exaggeration', strong ? 0.85 : 0.4)
  if (key && !map.getSource(CONTOUR_SOURCE)) {
    map.addSource(CONTOUR_SOURCE, { type: 'vector', url: `https://api.maptiler.com/tiles/contours-v2/tiles.json?key=${key}` })
  }
  if (key && !map.getLayer(CONTOUR_LINE)) {
    // nth_line marks index lines (every 2nd, 5th or 10th); thin lines fade in as you zoom.
    const nth = ['coalesce', ['get', 'nth_line'], 1]
    map.addLayer({ id: CONTOUR_LINE, type: 'line', source: CONTOUR_SOURCE, 'source-layer': 'contour', paint: {
      'line-opacity': ['interpolate', ['linear'], ['zoom'],
        9, ['match', nth, 10, 0.85, 5, 0.6, 0],
        11, ['match', nth, 10, 0.9, 5, 0.75, 0.35],
        13, ['match', nth, 10, 0.9, 5, 0.8, 0.55]] as unknown as maplibregl.ExpressionSpecification,
      'line-width': ['match', nth, 10, 1.3, 5, 0.9, 0.5] as unknown as maplibregl.ExpressionSpecification,
    } }, anchorBelow(map, 'ctx-districts-fill'))
  }
  if (map.getLayer(CONTOUR_LINE)) map.setPaintProperty(CONTOUR_LINE, 'line-color', onSatellite ? '#FFF4DC' : '#6B4F2E')
  const font = labelFont(map)
  if (key && font && !map.getLayer(CONTOUR_LABEL)) {
    map.addLayer({ id: CONTOUR_LABEL, type: 'symbol', source: CONTOUR_SOURCE, 'source-layer': 'contour',
      filter: ['in', ['get', 'nth_line'], ['literal', [5, 10]]],
      layout: { 'symbol-placement': 'line', 'text-field': ['concat', ['to-string', ['get', 'height']], ' m'],
        'text-font': font, 'text-size': 10, 'symbol-spacing': 350 },
      paint: { 'text-color': '#3A2A1A', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.4 } })
  }
}

function removeRelief(map: maplibregl.Map) {
  for (const id of [CONTOUR_LABEL, CONTOUR_LINE, HILLSHADE_LAYER]) if (map.getLayer(id)) map.removeLayer(id)
  for (const id of [CONTOUR_SOURCE, HILLSHADE_SOURCE]) if (map.getSource(id)) map.removeSource(id)
}

function anchorBelow(map: maplibregl.Map, id: string): string | undefined {
  return map.getLayer(id) ? id : map.getLayer('ctx-districts-fill') ? 'ctx-districts-fill' : undefined
}

/** district_profiles.json, built by ingest/scripts/jharkhand/district_profiles.py. */
interface DistrictProfile {
  area_km2: number | null
  area_isfr_km2?: number | null
  area_note?: string | null
  population_2011: number | null
  forest_km2: number | null
  forest_pct: number | null
  forest_very_dense_km2: number | null
  forest_moderately_dense_km2: number | null
  forest_open_km2: number | null
  elevation_median_m: number | null
  elevation_max_m: number | null
  heat_detections: number | null
  power_plants: { name: string; operator: string }[]
  large_works: { name: string; operator: string }[]
  monitors_continuous_in_feed: number | null
  monitors_manual_namp: number | null
  monitors_planned_jspcb: number | null
  mining_area_km2: number | null
  landcover_pct?: Record<string, number> | null
}
interface ProfilesDoc {
  sources: Record<string, string>
  heat_detection_dates: string[]
  districts: Record<string, DistrictProfile>
}

const profilesCache = new Map<string, Promise<ProfilesDoc | null>>()
function loadProfiles(base: string): Promise<ProfilesDoc | null> {
  let p = profilesCache.get(base)
  if (!p) {
    p = fetch(`${base}/district_profiles.json`)
      .then((r) => (r.ok ? (r.json() as Promise<ProfilesDoc>) : null))
      .catch(() => null)
    profilesCache.set(base, p)
  }
  return p
}

const LC_COLORS: Record<string, string> = {
  'Tree cover': '#006400', Shrubland: '#FFBB22', Grassland: '#FFFF4C', Cropland: '#F096FF', 'Built-up': '#FA0000',
  'Bare / sparse vegetation': '#B4B4B4', 'Permanent water': '#0064C8', 'Herbaceous wetland': '#0096A0',
}
const nf = new Intl.NumberFormat('en-IN')
const nf1 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 })
const NA = 'NA'

function fmtDay(d: string): string {
  const [, m, day] = d.split('-').map(Number)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${day} ${months[m - 1]}`
}

/** Jharkhand / city buttons, a district picker that shows the chosen
 *  district in 3D (terrain, relief shading and satellite imagery, the rest
 *  of the state dimmed), and a day-by-day player for the satellite heat
 *  detections. Plain DOM so it can live inside MapLibre's control corners. */
class ViewControl implements maplibregl.IControl {
  private el: HTMLDivElement | null = null
  private map: maplibregl.Map | null = null
  private districts: Feature[] = []
  private selected: string | null = null
  private select: HTMLSelectElement | null = null
  private on3D = false
  private prevTerrain: maplibregl.TerrainSpecification | null = null
  private prevSky: maplibregl.SkySpecification | undefined = undefined
  private panel3D: HTMLDivElement | null = null
  private profileBox: HTMLDivElement | null = null
  private toolbar: HTMLDivElement | null = null
  private tab: 'overview' | 'nature' | 'sources' = 'overview'
  private lcLegend: HTMLDivElement | null = null
  private lcMeta: LandcoverMeta | null = null
  private profiles: ProfilesDoc | null = null
  private exaggeration = EXAGGERATION_3D
  private satellite = true
  private fireDates: string[] = []
  private fireDay: string | null = null // null = all days
  private fireRow: HTMLDivElement | null = null
  private fireLabel: HTMLSpanElement | null = null
  private playBtn: HTMLButtonElement | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private pack: ContextPack,
    /** The layer toggles, so leaving 3D keeps satellite/relief the viewer switched on. */
    private wanted: () => CityContextVisibility,
    /** Change layers from the control's own checkboxes. */
    private onChange: (patch: Partial<CityContextVisibility>) => void,
  ) {}

  private layerInputs: Partial<Record<CityContextLayerKey, HTMLInputElement>> = {}
  private layerCount: HTMLSpanElement | null = null

  /** Sync the checkboxes with the current visibility. */
  setVisible(v: CityContextVisibility) {
    for (const [k, input] of Object.entries(this.layerInputs)) input.checked = v[k as CityContextLayerKey]
    if (this.layerCount) this.layerCount.textContent = `${Object.values(v).filter(Boolean).length} of ${CONTEXT_LAYER_DEFS.length} on`
  }

  /** The layer control: themed groups of checkboxes, with all / none / defaults. */
  private buildLayerControl(): HTMLElement {
    const wrap = document.createElement('details')
    wrap.open = true
    wrap.className = 'rounded-xl border border-ink-900/10 bg-white'
    const sum = document.createElement('summary')
    sum.className = 'flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2'
    const st = document.createElement('span')
    st.className = 'text-[10px] font-semibold uppercase tracking-widest text-ink-500'
    st.textContent = 'Map layers'
    const count = document.createElement('span')
    count.className = 'text-[11px] font-semibold tabular-nums text-ink-800'
    this.layerCount = count
    sum.append(st, count)
    wrap.appendChild(sum)
    const inner = document.createElement('div')
    inner.className = 'space-y-2.5 border-t border-ink-900/10 px-2.5 py-2.5'
    const quick = document.createElement('div')
    quick.className = 'flex gap-1'
    const qbtn = (label: string, patch: () => Partial<CityContextVisibility>) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.className = 'focus-ring flex-1 rounded-md border border-ink-900/15 px-2 py-1 text-[11px] font-medium text-ink-800 hover:bg-cream'
      b.addEventListener('click', () => this.onChange(patch()))
      quick.appendChild(b)
    }
    const all = (on: boolean) => Object.fromEntries(CONTEXT_LAYER_DEFS.map((d) => [d.key, on])) as CityContextVisibility
    qbtn('Defaults', () => ({ ...DEFAULT_CONTEXT_VISIBLE }))
    qbtn('All on', () => all(true))
    qbtn('All off', () => all(false))
    inner.appendChild(quick)
    const defs = new Map(CONTEXT_LAYER_DEFS.map((d) => [d.key as CityContextLayerKey, d]))
    for (const g of CONTEXT_GROUPS) {
      const sec = document.createElement('div')
      const gl = document.createElement('p')
      gl.className = 'mb-1 text-[10px] font-semibold uppercase tracking-widest text-ink-500'
      gl.textContent = g.label
      sec.appendChild(gl)
      for (const key of g.keys) {
        const d = defs.get(key)!
        const row = document.createElement('label')
        row.className = 'flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-cream'
        row.title = d.note
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.className = 'h-3.5 w-3.5 shrink-0 accent-ink-700'
        input.addEventListener('change', () => this.onChange({ [key]: input.checked }))
        this.layerInputs[key] = input
        const sw = document.createElement('span')
        sw.className = 'h-2.5 w-2.5 shrink-0 rounded-sm border border-ink-900/20'
        sw.style.background = CONTEXT_SWATCH[key]
        const tx = document.createElement('span')
        tx.className = 'min-w-0 flex-1 text-xs text-ink-900'
        tx.textContent = d.label
        row.append(input, sw, tx)
        sec.appendChild(row)
      }
      inner.appendChild(sec)
    }
    wrap.appendChild(inner)
    this.setVisible(this.wanted())
    return wrap
  }

  private button(label: string, onClick: () => void, parent: HTMLElement) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.className = 'rounded-md bg-ink-900 px-2.5 py-1.5 font-medium text-cream hover:bg-ink-700'
    b.addEventListener('click', onClick)
    parent.appendChild(b)
    return b
  }

  onAdd(map: maplibregl.Map) {
    this.map = map
    const el = document.createElement('div')
    el.className = 'maplibregl-ctrl w-[min(320px,calc(100vw-32px))] overflow-hidden rounded-xl bg-cream/95 font-site text-xs text-ink-800 shadow-card ring-1 ring-ink-900/10 backdrop-blur-sm'

    // Header: title and collapse toggle (collapsed on small screens, where the card would cover the map).
    const head = document.createElement('div')
    head.className = 'flex items-center justify-between gap-2 px-3 py-2'
    const title = document.createElement('div')
    const t1 = document.createElement('p')
    t1.className = 'text-[10px] font-semibold uppercase tracking-widest text-ink-500'
    t1.textContent = 'Geospatial platform'
    const t2 = document.createElement('p')
    t2.className = 'font-display text-2xl leading-none text-ink-900'
    t2.textContent = this.pack.regionLabel
    title.append(t1, t2)
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'focus-ring rounded-md border border-ink-900/20 px-2.5 py-1 text-[11px] font-medium text-ink-800 hover:bg-white'
    const body = document.createElement('div')
    body.className = 'max-h-[calc(100svh-210px)] space-y-3 overflow-y-auto border-t border-ink-900/10 px-3 py-3'
    const setOpen = (open: boolean) => {
      body.style.display = open ? '' : 'none'
      toggle.textContent = open ? 'Hide' : 'Show'
      toggle.setAttribute('aria-expanded', String(open))
    }
    toggle.addEventListener('click', () => setOpen(body.style.display === 'none'))
    head.append(title, toggle)
    el.append(head, body)
    setOpen(typeof window === 'undefined' || window.innerWidth >= 640)

    // District picker
    const pick = document.createElement('label')
    pick.className = 'block'
    const pickText = document.createElement('span')
    pickText.className = 'mb-1 block text-[10px] font-semibold uppercase tracking-widest text-ink-500'
    pickText.textContent = 'Go to district (opens in 3D)'
    const select = document.createElement('select')
    select.className = 'focus-ring w-full rounded-lg border border-ink-900/10 bg-white px-2.5 py-2 text-sm font-medium text-ink-900'
    select.addEventListener('change', () => this.selectDistrict(select.value || null))
    pick.append(pickText, select)
    body.appendChild(pick)
    this.select = select
    this.fillSelect()

    body.appendChild(this.buildLayerControl())

    // District profile
    // The profile is its own docked panel (a bottom sheet on phones), not part of this card.
    const profile = document.createElement('div')
    profile.className = 'absolute bottom-24 left-2 right-2 z-10 max-h-[52svh] overflow-y-auto rounded-xl bg-cream/95 p-3 font-site text-xs text-ink-800 shadow-card ring-1 ring-ink-900/10 backdrop-blur-sm md:bottom-auto md:left-auto md:right-16 md:top-3 md:max-h-[calc(100%-7.5rem)] md:w-[340px]'
    profile.style.display = 'none'
    map.getContainer().appendChild(profile)
    this.profileBox = profile
    // Bottom toolbar: 3D controls and the heat-detection player.
    const toolbar = document.createElement('div')
    toolbar.className = 'absolute bottom-3 left-2 right-16 z-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 rounded-xl bg-cream/95 px-3 py-2 font-site text-xs text-ink-800 shadow-card ring-1 ring-ink-900/10 backdrop-blur-sm md:left-1/2 md:right-auto md:-translate-x-1/2'
    toolbar.style.display = 'none'
    map.getContainer().appendChild(toolbar)
    this.toolbar = toolbar
    loadProfiles(this.pack.base).then((d) => {
      this.profiles = d
      this.renderProfile()
    })

    // 3D view controls (only with a district open)
    const panel = document.createElement('div')
    panel.className = 'flex flex-wrap items-center gap-x-4 gap-y-1'
    panel.style.display = 'none'
    panel.title = 'Contours every 10–100 m with heights. Click the ground for its elevation. Right-drag or Ctrl-drag to tilt and turn.'
    const ph = document.createElement('p')
    ph.className = 'text-[10px] font-semibold uppercase tracking-widest text-ink-500'
    ph.textContent = '3D'
    const hRow = document.createElement('label')
    hRow.className = 'flex items-center gap-2'
    const hText = document.createElement('span')
    hText.className = 'w-[72px] shrink-0 font-semibold tabular-nums text-ink-900'
    hText.textContent = `Heights ×${this.exaggeration}`
    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = '1'
    slider.max = '6'
    slider.step = '0.5'
    slider.value = String(this.exaggeration)
    slider.className = 'w-28 accent-ink-700'
    slider.setAttribute('aria-label', 'Height exaggeration')
    slider.addEventListener('input', () => {
      this.exaggeration = Number(slider.value)
      hText.textContent = `Heights ×${this.exaggeration}`
      const t = map.getTerrain()
      if (this.on3D && t) map.setTerrain({ ...t, exaggeration: this.exaggeration })
    })
    hRow.append(hText, slider)
    const satRow = document.createElement('label')
    satRow.className = 'flex cursor-pointer items-center gap-2'
    const satText = document.createElement('span')
    satText.className = 'font-medium text-ink-800'
    satText.textContent = 'Satellite imagery'
    const sat = document.createElement('input')
    sat.type = 'checkbox'
    sat.checked = this.satellite
    sat.className = 'h-4 w-4 accent-ink-700'
    sat.addEventListener('change', () => {
      this.satellite = sat.checked
      ensureSatellite(map, this.satellite)
      ensureRelief(map, !this.satellite, this.satellite)
    })
    satRow.append(satText, sat)
    panel.append(ph, hRow, satRow)
    toolbar.appendChild(panel)
    this.panel3D = panel

    // Land-cover key (while that layer is on)
    const lc = document.createElement('div')
    lc.style.display = 'none'
    body.appendChild(lc)
    this.lcLegend = lc
    loadLandcover(this.pack.base).then((m) => {
      this.lcMeta = m
      this.refreshLegend()
    })

    // Heat detections over time
    const fireRow = document.createElement('div')
    fireRow.className = 'flex items-center gap-2'
    fireRow.style.display = 'none'
    const ft = document.createElement('div')
    ft.className = 'min-w-0 flex-1'
    const ft1 = document.createElement('p')
    ft1.className = 'text-[10px] font-semibold uppercase tracking-widest text-ink-500'
    ft1.textContent = 'Heat detections'
    const label = document.createElement('p')
    label.className = 'text-xs font-semibold tabular-nums text-ink-900'
    this.fireLabel = label
    ft.append(ft1, label)
    this.playBtn = this.button('▶', () => this.togglePlay(), fireRow)
    this.playBtn.setAttribute('aria-label', 'Play heat detections day by day')
    const all = this.button('All', () => { this.stopPlay(); this.setFireDay(null) }, fireRow)
    fireRow.insertBefore(ft, this.playBtn)
    void all
    toolbar.appendChild(fireRow)
    this.fireRow = fireRow

    map.on('styledata', this.reapply)
    map.on('style.load', this.onStyleLoad)
    this.el = el
    return el
  }

  private opened = false
  /** Called once our layers are in: open on the whole state, once. */
  afterLayersAdded() {
    const map = this.map
    if (this.opened || !alive(map) || this.selected) return
    this.opened = true
    map.resize()
    const [w, s, e, n] = this.pack.regionBounds
    map.fitBounds([[w, s], [e, n]], { padding: 30, duration: 0, pitch: 0, bearing: 0, maxZoom: 8 })
  }

  /** Show the bottom toolbar only while it has something to show. */
  private syncToolbar() {
    const t = this.toolbar
    if (!t) return
    const any = [this.panel3D, this.fireRow].some((n) => n && n.style.display !== 'none')
    t.style.display = any ? '' : 'none'
  }

  onRemove() {
    this.profileBox?.remove()
    this.toolbar?.remove()
    this.stopPlay()
    this.map?.off('styledata', this.reapply)
    this.map?.off('style.load', this.onStyleLoad)
    if (this.on3D) this.leave3D()
    this.el?.remove()
    this.el = null
    this.map = null
  }

  /** Land-cover colour key, shown while that layer is on. */
  refreshLegend() {
    const box = this.lcLegend
    if (!box) return
    const on = this.wanted().landcover && this.lcMeta != null
    box.style.display = on ? '' : 'none'
    box.className = 'rounded-xl bg-cream p-2.5'
    if (!on || box.childElementCount) return
    const t = document.createElement('p')
    t.className = 'mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-ink-500'
    t.textContent = 'Land cover key (ESA, 2021)'
    box.appendChild(t)
    const grid = document.createElement('div')
    grid.className = 'grid grid-cols-2 gap-x-2 gap-y-0.5'
    for (const c of this.lcMeta!.classes) {
      const r = document.createElement('div')
      r.className = 'flex items-center gap-1 text-[10px]'
      const sw = document.createElement('span')
      sw.className = 'inline-block h-2.5 w-3 shrink-0 rounded-sm'
      sw.style.background = c.color
      const tx = document.createElement('span')
      tx.textContent = c.label
      r.append(sw, tx)
      grid.appendChild(r)
    }
    box.appendChild(grid)
  }

  get is3D() {
    return this.on3D
  }

  /** Called once the pack is loaded. */
  setPackData(data: PackData) {
    this.districts = [...data.districts.features].sort((a, b) =>
      String(a.properties?.name).localeCompare(String(b.properties?.name)))
    this.fillSelect()
    this.fireDates = [...new Set(data.fires.features.map((f) => String(f.properties?.date ?? '')))].filter(Boolean).sort()
    if (this.fireRow) this.fireRow.style.display = this.fireDates.length > 1 ? '' : 'none'
    this.syncToolbar()
    this.updateFireLabel()
  }

  private fillSelect() {
    const sel = this.select
    if (!sel) return
    sel.replaceChildren()
    const all = document.createElement('option')
    all.value = ''
    all.textContent = `Whole ${this.pack.regionLabel}`
    sel.appendChild(all)
    for (const f of this.districts) {
      const o = document.createElement('option')
      o.value = String(f.properties?.name)
      o.textContent = String(f.properties?.name)
      sel.appendChild(o)
    }
    sel.value = this.selected ?? ''
  }

  /** Show one district in 3D (null: back to the flat state view). */
  selectDistrict(name: string | null, fly = true) {
    const map = this.map
    if (!alive(map)) return
    const f = name ? this.districts.find((d) => d.properties?.name === name) : undefined
    this.selected = f ? name : null
    if (this.select) this.select.value = this.selected ?? ''
    this.applySelection()
    this.renderProfile()
    if (f) {
      if (!this.on3D) this.enter3D()
      this.goToBounds(bboxOf(f.geometry))
    } else {
      if (this.on3D) this.leave3D()
      if (fly) {
        const [w, s, e, n] = this.pack.regionBounds
        map.fitBounds([[w, s], [e, n]], { padding: 30, pitch: 0, bearing: 0, duration: 1000 })
      }
    }
  }

  /** The selected district's facts, each with its source; NA where no
   *  verified government figure exists. */
  private renderProfile() {
    const box = this.profileBox
    if (!box) return
    const name = this.selected
    box.replaceChildren()
    if (!name) {
      box.style.display = 'none'
      return
    }
    box.style.display = ''
    const doc = this.profiles
    const p = doc?.districts[name]
    const el = (tag: string, cls: string, text?: string) => {
      const n = document.createElement(tag)
      n.className = cls
      if (text != null) n.textContent = text
      return n
    }
    const label = (t: string) => el('p', 'mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-ink-500', t)

    const top = el('div', '-mx-3 -mt-3 mb-3 flex items-start justify-between gap-2 rounded-t-xl bg-gradient-to-b from-sky-300 via-sky-200 to-sky-100 px-3 pb-3 pt-3')
    const tt = el('div', 'min-w-0')
    tt.append(el('p', 'text-[10px] font-semibold uppercase tracking-widest text-ink-700', 'District profile'),
      el('p', 'truncate font-display text-4xl leading-none text-ink-900', name))
    const back = el('button', 'focus-ring shrink-0 rounded-md bg-ink-900 px-2.5 py-1.5 text-[11px] font-medium text-cream hover:bg-ink-700', 'Whole state')
    ;(back as HTMLButtonElement).type = 'button'
    back.addEventListener('click', () => this.selectDistrict(null))
    top.append(tt, back)
    box.appendChild(top)
    if (!p) {
      box.appendChild(el('p', 'text-ink-600', doc ? 'No profile for this district.' : 'Loading…'))
      return
    }
    const num = (v: number | null | undefined, unit = '') => (v == null ? NA : `${nf.format(v)}${unit}`)

    // Tabs: Overview | Nature | Sources
    const tabs = el('div', 'mb-3 flex gap-1 rounded-xl bg-ink-100 p-1')
    const panes = { overview: el('div', ''), nature: el('div', 'space-y-3'), sources: el('div', '') }
    const tabButtons: Partial<Record<'overview' | 'nature' | 'sources', HTMLButtonElement>> = {}
    const paint = () => {
      for (const k of ['overview', 'nature', 'sources'] as const) {
        tabButtons[k]!.className = `flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition ${this.tab === k ? 'bg-ink-900 text-cream shadow-sm' : 'text-ink-700 hover:bg-white'}`
        panes[k].style.display = this.tab === k ? '' : 'none'
      }
    }
    ;(['overview', 'nature', 'sources'] as const).forEach((k) => {
      const b = el('button', '', k === 'overview' ? 'Overview' : k === 'nature' ? 'Nature' : 'Sources') as HTMLButtonElement
      b.type = 'button'
      // Switch in place: rebuilding the panel here reset its scroll to the top.
      b.addEventListener('click', () => { this.tab = k; paint() })
      tabButtons[k] = b
      tabs.appendChild(b)
    })
    paint()
    box.appendChild(tabs)
    box.append(panes.overview, panes.nature, panes.sources)

    // Key figures
    const grid = el('div', 'grid grid-cols-2 gap-1.5')
    const tile = (k: string, v: string, sub?: string) => {
      const t = el('div', 'rounded-xl border border-ink-900/10 bg-white px-2.5 py-2')
      t.append(el('p', 'mb-1 text-[10px] font-medium uppercase tracking-wider text-ink-500', k),
        el('p', `font-display text-3xl leading-none ${v === NA ? 'text-ink-300' : 'text-ink-900'}`, v))
      if (sub) t.appendChild(el('p', 'text-[10px] text-ink-600', sub))
      grid.appendChild(t)
    }
    tile('Area', num(p.area_km2, ' km²'), p.area_note ? 'sources differ, see Sources' : undefined)
    tile('Population (2011)', num(p.population_2011))
    tile('Forest cover', p.forest_pct == null ? NA : `${p.forest_pct}%`, p.forest_km2 == null ? undefined : `${nf.format(Math.round(p.forest_km2))} km²`)
    tile('Highest point', num(p.elevation_max_m, ' m'), p.elevation_median_m == null ? undefined : `typical ${nf.format(p.elevation_median_m)} m`)
    panes.overview.appendChild(grid)

    // Stacked bar helper
    const bar = (parts: { label: string; pct: number; color: string }[]) => {
      const wrap = el('div', 'space-y-1')
      const b = el('div', 'flex h-2.5 w-full overflow-hidden rounded-full bg-ink-100')
      for (const q of parts) {
        if (q.pct <= 0) continue
        const seg = el('div', '')
        seg.style.width = `${q.pct}%`
        seg.style.background = q.color
        seg.title = `${q.label} ${q.pct}%`
        b.appendChild(seg)
      }
      const lg = el('div', 'flex flex-wrap gap-x-2.5 gap-y-0.5')
      for (const q of parts) {
        if (q.pct < 0.5) continue
        const r = el('span', 'flex items-center gap-1 text-[10px] text-ink-700')
        const sw = el('span', 'inline-block h-2 w-2 rounded-sm')
        sw.style.background = q.color
        r.append(sw, document.createTextNode(`${q.label} ${nf1.format(q.pct)}%`))
        lg.appendChild(r)
      }
      wrap.append(b, lg)
      return wrap
    }

    // Forest, by density (share of district area)
    const fsec = el('div', 'mt-3')
    fsec.appendChild(label('Forest by density (ISFR 2023)'))
    if ((p.area_isfr_km2 ?? p.area_km2) && p.forest_km2 != null) {
      const a = (p.area_isfr_km2 ?? p.area_km2) as number  // forest shares are ISFR's own, against ISFR's area
      const share = (v: number | null) => Math.round(((v ?? 0) / a) * 1000) / 10
      const vd = share(p.forest_very_dense_km2), md = share(p.forest_moderately_dense_km2), op = share(p.forest_open_km2)
      fsec.appendChild(bar([
        { label: 'Very dense', pct: vd, color: '#14532D' },
        { label: 'Moderately dense', pct: md, color: '#2F7D3A' },
        { label: 'Open', pct: op, color: '#86C28B' },
        { label: 'Not forest', pct: Math.max(0, Math.round((100 - vd - md - op) * 10) / 10), color: '#E5E7EB' },
      ]))
    } else fsec.appendChild(el('p', 'text-ink-300', NA))
    panes.nature.appendChild(fsec)

    // Land cover (satellite)
    const lsec = el('div', 'mt-3')
    lsec.appendChild(label('Land cover (ESA, 2021)'))
    const lc = p.landcover_pct
    if (lc) {
      lsec.appendChild(bar(Object.entries(lc).map(([k, v]) => ({ label: k, pct: v, color: LC_COLORS[k] ?? '#999' }))))
    } else lsec.appendChild(el('p', 'text-ink-300', NA))
    panes.nature.appendChild(lsec)

    // Relief: typical and highest ground height against the state's range (about 0 to 1,400 m)
    const rsec = el('div', '')
    rsec.appendChild(label('Relief (Copernicus DEM)'))
    if (p.elevation_median_m != null && p.elevation_max_m != null) {
      const track = el('div', 'relative h-6')
      track.appendChild(el('div', 'absolute left-0 right-0 top-2.5 h-1 rounded-full bg-gradient-to-r from-emerald-200 via-amber-200 to-stone-400'))
      const mark = (m: number, text: string, color: string) => {
        const d = el('div', 'absolute top-0 -translate-x-1/2')
        d.style.left = `${Math.min(100, Math.max(0, (m / 1400) * 100))}%`
        const dot = el('div', 'mt-1.5 h-3 w-3 rounded-full border-2 border-white shadow')
        dot.style.background = color
        dot.title = text
        d.appendChild(dot)
        track.appendChild(d)
      }
      mark(p.elevation_median_m, `Typical ${nf.format(p.elevation_median_m)} m`, '#0369A1')
      mark(p.elevation_max_m, `Highest ${nf.format(p.elevation_max_m)} m`, '#B5542E')
      rsec.appendChild(track)
      const lg = el('div', 'flex justify-between text-[10px] text-ink-700')
      lg.append(el('span', '', '0 m'), el('span', 'font-semibold text-sky-700', `typical ${nf.format(p.elevation_median_m)} m`),
        el('span', 'font-semibold text-orange-800', `highest ${nf.format(p.elevation_max_m)} m`), el('span', '', '1,400 m'))
      rsec.appendChild(lg)
    } else rsec.appendChild(el('p', 'text-ink-300', NA))
    panes.nature.appendChild(rsec)

    // In the district
    const rows = el('div', 'mt-3 divide-y divide-ink-900/10 rounded-xl border border-ink-900/10 bg-white')
    const dates = doc?.heat_detection_dates ?? []
    const span = dates.length ? `${fmtDay(dates[0])}–${fmtDay(dates[dates.length - 1])}` : ''
    const row = (k: string, v: string, sub?: string) => {
      const r = el('div', 'px-2.5 py-1.5')
      const line = el('div', 'flex items-baseline justify-between gap-2')
      line.append(el('span', 'text-ink-600', k), el('span', `text-right font-semibold tabular-nums ${v === NA ? 'text-ink-300' : 'text-ink-900'}`, v))
      r.appendChild(line)
      if (sub) r.appendChild(el('p', 'mt-0.5 text-right text-[10px] leading-snug text-ink-600', sub))
      rows.appendChild(r)
    }
    row(`Heat detections${span ? ` (${span})` : ''}`, num(p.heat_detections))
    const sites = [...p.power_plants, ...p.large_works]
    row('Power plants and works', sites.length ? String(sites.length) : 'None checked', sites.map((x) => x.name).join(' · ') || undefined)
    row('Public air monitors', p.monitors_continuous_in_feed == null ? NA : `${p.monitors_continuous_in_feed} continuous · ${p.monitors_manual_namp ?? NA} manual`,
      p.monitors_planned_jspcb ? `${p.monitors_planned_jspcb} continuous planned (JSPCB tender, Dec 2025)` : undefined)
    row('Mining area', p.mining_area_km2 == null ? NA : num(p.mining_area_km2, ' km²'), p.mining_area_km2 == null ? 'No official district figure' : undefined)
    panes.overview.appendChild(rows)

    // Sources, folded away
    const src = doc?.sources ?? {}
    const det = el('div', '')
    det.appendChild(label('Where each figure comes from'))
    const ul = el('ul', 'space-y-2 text-[11px] leading-snug text-ink-600')
    for (const [k, lab] of [['area_km2', 'Area'], ['population_2011', 'Population'], ['forest', 'Forest'], ['elevation', 'Elevation'],
      ['landcover', 'Land cover'], ['heat_detections', 'Heat detections'], ['power_plants', 'Plants and works'],
      ['monitors', 'Monitors'], ['outline', 'Outline']] as const) {
      if (src[k]) {
        const li = el('li', '')
        li.append(el('span', 'font-semibold text-ink-700', `${lab}: `), document.createTextNode(src[k]))
        ul.appendChild(li)
      }
    }
    if (p.area_note) {
      const li = el('li', '')
      li.append(el('span', 'font-semibold text-ink-700', 'Area: '), document.createTextNode(p.area_note))
      ul.insertBefore(li, ul.firstChild)
    }
    ul.appendChild(el('li', '', 'NA: no verified government figure found.'))
    det.appendChild(ul)
    panes.sources.appendChild(det)
  }

  /** Fly to a district in 3D, fitted into the area the panels leave free, and
   *  check on arrival that the camera really is over it (anything else that
   *  moves the camera mid-flight would otherwise leave the view elsewhere). */
  private goToBounds([w, s, e, n]: [number, number, number, number]) {
    const map = this.map
    if (!alive(map)) return
    const c = map.getContainer()
    const wide = c.clientWidth >= 768
    const padding = wide
      ? { top: 40, bottom: 110, left: 40, right: 400 } // right: docked profile panel + map buttons
      : { top: 60, bottom: Math.round(c.clientHeight * 0.55) + 20, left: 30, right: 30 } // bottom sheet
    const opts = { padding, pitch: 62, bearing: -25, maxZoom: 11.5 }
    const bounds: maplibregl.LngLatBoundsLike = [[w, s], [e, n]]
    map.fitBounds(bounds, { ...opts, duration: 1600 })
    map.once('moveend', () => {
      if (!alive(this.map) || !this.selected) return
      const ctr = this.map.getCenter()
      const mx = (e - w) * 0.35, my = (n - s) * 0.35
      const over = ctr.lng > w - mx && ctr.lng < e + mx && ctr.lat > s - my && ctr.lat < n + my
      if (!over) this.map.fitBounds(bounds, { ...opts, duration: 0 })
    })
  }

  /** Mask and outline for the selected district. */
  private applySelection() {
    const map = this.map
    if (!alive(map) || !map.getLayer(DISTRICT_SELECTED)) return
    const f = this.selected ? this.districts.find((d) => d.properties?.name === this.selected) : undefined
    map.setFilter(DISTRICT_SELECTED, ['==', ['get', 'name'], this.selected ?? ''])
    ;(map.getSource(MASK_DISTRICT) as maplibregl.GeoJSONSource | undefined)?.setData(f ? maskOutside(f.geometry) : EMPTY_FC)
    // Mapped areas go translucent over the imagery in 3D.
    for (const id of ['ctx-mines-fill', 'ctx-industry-fill']) {
      if (map.getLayer(id)) map.setPaintProperty(id, 'fill-opacity', f ? 0.25 : id === 'ctx-mines-fill' ? 0.7 : 0.55)
    }
  }

  private updateFireLabel() {
    if (!this.fireLabel) return
    const n = this.fireDates.length
    this.fireLabel.textContent = this.fireDay
      ? `${fmtDay(this.fireDay)} (UTC)`
      : n ? `${fmtDay(this.fireDates[0])}–${fmtDay(this.fireDates[n - 1])}` : ''
  }

  private setFireDay(day: string | null) {
    this.fireDay = day
    this.updateFireLabel()
    this.reapply()
  }

  private togglePlay() {
    if (this.timer) return this.stopPlay()
    if (!this.fireDates.length) return
    if (this.playBtn) this.playBtn.textContent = '❚❚'
    let i = this.fireDay ? this.fireDates.indexOf(this.fireDay) : -1
    const step = () => {
      i = (i + 1) % this.fireDates.length
      this.setFireDay(this.fireDates[i])
    }
    step()
    this.timer = setInterval(step, 1500)
  }

  private stopPlay() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.playBtn) this.playBtn.textContent = '▶'
  }

  /** Re-apply the fire-day filter and the district selection after our
   *  layers are re-created (style reloads). */
  private reapply = () => {
    const map = this.map
    if (!alive(map)) return
    if (map.getLayer('ctx-fires')) {
      const want: maplibregl.FilterSpecification | null = this.fireDay ? ['==', ['get', 'date'], this.fireDay] : null
      if (JSON.stringify(map.getFilter('ctx-fires') ?? null) !== JSON.stringify(want)) map.setFilter('ctx-fires', want)
    }
    if (map.getLayer(DISTRICT_SELECTED)) {
      const want = JSON.stringify(['==', ['get', 'name'], this.selected ?? ''])
      if (JSON.stringify(map.getFilter(DISTRICT_SELECTED)) !== want) this.applySelection()
    }
  }

  private onStyleLoad = () => {
    // A basemap switch wipes imagery and relief; put 3D back if it was on.
    if (this.on3D) this.apply3D()
  }

  private enter3D() {
    const map = this.map
    if (!map) return
    this.on3D = true
    this.prevTerrain = map.getTerrain()
    this.prevSky = map.getSky()
    this.apply3D()
    if (this.panel3D) this.panel3D.style.display = ''
    this.syncToolbar()
  }

  private apply3D() {
    const map = this.map
    if (!alive(map)) return
    ensureSatellite(map, this.satellite)
    ensureRelief(map, !this.satellite, this.satellite)
    const source = map.getSource(MAPVIEW_DEM_SOURCE) ? MAPVIEW_DEM_SOURCE : DEM_SOURCE
    if (source === DEM_SOURCE && !map.getSource(DEM_SOURCE)) map.addSource(DEM_SOURCE, demSourceSpec())
    try {
      map.setSky(SKY)
    } catch {
      // older styles without sky support
    }
    // setTerrain during an animation can crash MapLibre (maplibre-gl-js#6011,
    // see MapView.tsx): wait for idle, then one more frame.
    map.once('idle', () => requestAnimationFrame(() => {
      if (this.on3D && this.map) this.map.setTerrain({ source, exaggeration: this.exaggeration })
    }))
  }

  private leave3D() {
    const map = this.map
    if (!map) return
    this.on3D = false
    const prev = this.prevTerrain
    const done = () => {
      try {
        map.setTerrain(prev && map.getSource(prev.source) ? prev : null)
        if (this.prevSky) map.setSky(this.prevSky)
        const want = this.wanted()
        if (want.satellite) ensureSatellite(map, true)
        else removeSatellite(map)
        if (want.relief) ensureRelief(map, !want.satellite, want.satellite)
        else removeRelief(map)
        if (!map.getTerrain() && map.getSource(DEM_SOURCE)) map.removeSource(DEM_SOURCE)
      } catch {
        // map is being removed
      }
    }
    if (map.isMoving()) map.once('idle', () => requestAnimationFrame(done))
    else done()
    if (this.panel3D) this.panel3D.style.display = 'none'
    this.syncToolbar()
  }
}

export default function CityContextLayers({
  map,
  cityCode,
  visible: visibleProp,
  onVisibleChange,
  showViewControl = false,
}: {
  map: maplibregl.Map | null
  cityCode: string | null
  /** Which layers are on. Controlled by the page when `onVisibleChange` is given
   *  (the Map page's Layers menu); otherwise this is only the starting state and
   *  the on-map layer control keeps its own. */
  visible: CityContextVisibility
  onVisibleChange?: (patch: Partial<CityContextVisibility>) => void
  /** Add the Jharkhand / city buttons, the district 3D picker and the heat-detection player. */
  showViewControl?: boolean
}) {
  const [local, setLocal] = useState<CityContextVisibility>(visibleProp)
  const visible = onVisibleChange ? visibleProp : local
  const change = (patch: Partial<CityContextVisibility>) => {
    if (onVisibleChange) onVisibleChange(patch)
    else setLocal((v) => ({ ...v, ...patch }))
  }
  const changeRef = useRef(change)
  changeRef.current = change
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const pack = cityCode ? CONTEXT_PACKS[cityCode] : undefined
  const controlRef = useRef<ViewControl | null>(null)

  useEffect(() => {
    if (!alive(map) || !pack) return
    let cancelled = false
    let data: PackData | null = null
    let landcover: LandcoverMeta | null = null
    // A basemap switch rebuilds the style and wipes our layers. isStyleLoaded()
    // is false while the new basemap's tiles load, so do not wait for it:
    // try now, and retry on every idle until the layers are in.
    const ensure = () => {
      if (cancelled || !data || !alive(map) || map.getSource(SRC.sources)) return
      try {
        addAll(map, data, visibleRef.current, landcover, pack.base)
        applyOnDemand(map, visibleRef.current, controlRef.current?.is3D === true)
        controlRef.current?.afterLayersAdded()
      } catch {
        try { removeAll(map) } catch { /* partial add: start clean next time */ }
        map.once('idle', ensure)
      }
    }
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
    const clickable = () =>
      CLICKABLE.filter((id) => map.getLayer(id) && (id !== 'ctx-districts-fill' || map.getZoom() < DISTRICT_CLICK_MAX_ZOOM))
    const showElevation = (e: maplibregl.MapMouseEvent, extra?: HTMLElement) => {
      const el = extra ?? document.createElement('div')
      if (!extra) el.className = 'text-xs leading-snug space-y-1'
      const p = document.createElement('p')
      p.className = 'text-slate-500'
      p.textContent = 'Elevation: reading…'
      el.appendChild(p)
      popup.setLngLat(e.lngLat).setDOMContent(el).addTo(map)
      elevationAt(e.lngLat.lng, e.lngLat.lat).then((h) => {
        p.textContent = h == null
          ? 'Elevation not available.'
          : `Elevation about ${h.toLocaleString('en-IN')} m above sea level (MapTiler terrain model, about 30 m grid).`
      })
    }
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const layers = clickable()
      const hits = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : []
      const in3D = controlRef.current?.is3D === true
      if (!hits.length || (in3D && hits[0].layer.id === 'ctx-districts-fill')) {
        if (in3D) showElevation(e)
        return
      }
      // queryRenderedFeatures returns topmost first.
      const f = hits[0]
      if (f.layer.id === 'ctx-districts-fill' && controlRef.current) {
        controlRef.current.selectDistrict(String(f.properties?.name))
        return
      }
      const node = popupNode(f.properties ?? {}, f.layer.id)
      if (in3D) showElevation(e, node)
      else popup.setLngLat(e.lngLat).setDOMContent(node).addTo(map)
    }
    let hovering = false
    const onMove = (e: maplibregl.MapMouseEvent) => {
      const layers = clickable()
      const hit = layers.length > 0 && map.queryRenderedFeatures(e.point, { layers }).length > 0
      // Only touch the cursor when hovering our features, so other layers' cursors are left alone.
      if (hit) map.getCanvas().style.cursor = 'pointer'
      else if (map.getCanvas().style.cursor === 'pointer' && hovering) map.getCanvas().style.cursor = ''
      hovering = hit
    }
    Promise.all([loadPack(pack.base), loadLandcover(pack.base)])
      .then(([d, lc]) => {
        data = d
        landcover = lc
        ensure()
      })
      .catch((err) => console.warn('[CityContextLayers]', err))
    // Free movement for the 3D views: rotate, tilt up to 80°, keyboard.
    const prevMaxPitch = map.getMaxPitch()
    const prevRotate = map.dragRotate.isEnabled()
    map.setMaxPitch(80)
    map.dragRotate.enable()
    map.touchZoomRotate.enableRotation()
    map.touchPitch.enable()
    map.keyboard.enable()
    map.on('style.load', ensure)
    map.on('styledata', ensure)
    map.on('click', onClick)
    map.on('mousemove', onMove)
    return () => {
      cancelled = true
      map.off('style.load', ensure)
      map.off('styledata', ensure)
      map.off('click', onClick)
      map.off('mousemove', onMove)
      popup.remove()
      try {
        map.setMaxPitch(prevMaxPitch)
        if (!prevRotate) map.dragRotate.disable()
        removeAll(map)
      } catch {
        // the map may already be removed on unmount
      }
    }
  }, [map, pack])

  useEffect(() => {
    if (!alive(map) || !pack || !showViewControl) return
    const ctrl = new ViewControl(pack, () => visibleRef.current, (patch) => changeRef.current(patch))
    map.addControl(ctrl, 'top-left')
    // Compass and tilt indicator: drag to tilt/turn, click to reset north.
    const nav = new maplibregl.NavigationControl({ showZoom: false, showCompass: true, visualizePitch: true })
    map.addControl(nav, 'bottom-right')
    controlRef.current = ctrl
    if (map.getSource(SRC.sources)) ctrl.afterLayersAdded()
    loadPack(pack.base)
      .then((d) => ctrl.setPackData(d))
      .catch(() => {})
    return () => {
      controlRef.current = null
      try {
        map.removeControl(nav)
        map.removeControl(ctrl)
      } catch {
        // map already removed
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, pack, showViewControl])

  useEffect(() => {
    if (!alive(map) || !pack) return
    for (const [key, ids] of Object.entries(LAYERS)) {
      for (const id of ids) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible[key as CityContextLayerKey] ? 'visible' : 'none')
      }
    }
    if (map.getSource(SRC.sources)) {
      applyOnDemand(map, visible, controlRef.current?.is3D === true)
      // Basemap borders are hidden only while ours are shown.
      if (visible.districts && !hiddenBasemapBoundaries.has(map)) hideBasemapBoundaries(map)
      else if (!visible.districts) restoreBasemapBoundaries(map)
    }
    controlRef.current?.refreshLegend()
    controlRef.current?.setVisible(visible)
  }, [map, pack, visible])

  // The "Ask the map" assistant (React, portalled into the map container). Actions run through the same
  // controls the viewer uses: the layer switches and the district picker.
  const [factsDoc, setFactsDoc] = useState<FactsDoc | null>(null)
  useEffect(() => {
    if (!pack || !showViewControl) return
    let live = true
    loadProfiles(pack.base).then((d) => { if (live) setFactsDoc(d as unknown as FactsDoc | null) })
    return () => { live = false }
  }, [pack, showViewControl])
  if (!alive(map) || !pack || !showViewControl) return null
  return (
    <MapAssistant
      container={map.getContainer()}
      layers={CONTEXT_LAYER_DEFS.map((d) => ({ key: d.key, label: d.label }))}
      profiles={factsDoc}
      handlers={{
        setLayers: (patch) => changeRef.current(patch as Partial<CityContextVisibility>),
        goDistrict: (name) => controlRef.current?.selectDistrict(name),
        goPlace: (lng, lat, _name, zoom = 11.5) => {
          controlRef.current?.selectDistrict(null, false)
          map.flyTo({ center: [lng, lat], zoom, pitch: 0, bearing: 0, duration: 1400 })
        },
        getFile: async (file) => (await loadPack(pack.base).catch(() => null))?.[file] ?? null,
      }}
    />
  )
}
