import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import type { Feature, FeatureCollection, Geometry, Polygon, Position } from 'geojson'
import { maptilerKey } from '../../lib/basemaps'
import { elevationAt } from '../../lib/elevation'
import { setSelectedDistrict } from '../../lib/jhSelection'

/**
 * Static context layers for a city pack. For Jharkhand the pack covers the
 * whole state, every district: outlines; ESA land cover; NASA night lights;
 * satellite imagery and relief; protected areas, rivers, basins, canals, dams
 * and ground water (India-WRIS); Census 2011 towns and villages; blocks and
 * assembly constituencies; railways, roads, power lines; coal mines and
 * plants (Global Energy Monitor), checked power plants, satellite heat
 * detections; peaks, waterfalls, earthquake zones and aquifers. The list and
 * its notes live in lib/contextLayers.ts.
 *
 * The files are built by ingest/scripts/jharkhand/build_layers.py into
 * data/jharkhand/processed/ and copied to web/public/city-packs/<pack>/.
 * Context only: these are mapped features, not measurements.
 *
 * Renders nothing itself; it adds MapLibre sources and layers to `map` (and,
 * with `showViewControl`, a Jharkhand / city zoom control), and re-adds them
 * after every setStyle() (which wipes custom layers).
 */

import { CONTEXT_GROUPS, CONTEXT_LAYER_DEFS, CONTEXT_LEGEND, CONTEXT_SWATCH, DEFAULT_CONTEXT_VISIBLE, DISTRICT_PROFILE_SOURCES, activeSources, normalizeBaseImages } from '../../lib/contextLayers'
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
  protected: 'protected.geojson',
  places: 'places.geojson',
  landmarks: 'landmarks.geojson',
  transport: 'transport.geojson',
  power: 'power.geojson',
  majorrivers: 'majorrivers.geojson',
  basins: 'basins.geojson',
  dams: 'dams.geojson',
  blocks: 'blocks.geojson',
  assembly: 'assembly.geojson',
  monitors: 'monitors.geojson',
  canals: 'canals.geojson',
  seismic: 'seismic.geojson',
  aquifers: 'aquifers.geojson',
  coalmines: 'coalmines.geojson',
  coalboundaries: 'coalboundaries.geojson',
  coalplants: 'coalplants.geojson',
} as const
/** Files the code itself needs (the state mask, district lookup and heat-detection dates). Everything else is given to
 *  MapLibre as a URL, so each layer loads on its own: one slow or missing file cannot hold up the rest. */
const NEEDED = ['state', 'districts', 'fires', 'basins'] as const

interface LandcoverMeta {
  coordinates: [[number, number], [number, number], [number, number], [number, number]]
  classes: { value: number; label: string; color: string }[]
  source: string
}

type PackData = Record<(typeof NEEDED)[number], FeatureCollection>

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
      NEEDED.map(async (k) => {
        const res = await fetch(`${base}/${FILES[k]}`)
        if (!res.ok) throw new Error(`${FILES[k]}: HTTP ${res.status}`)
        return [k, (await res.json()) as FeatureCollection] as const
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
  protected: 'ctx-protected',
  places: 'ctx-places',
  landmarks: 'ctx-landmarks',
  transport: 'ctx-transport',
  power: 'ctx-power',
  majorrivers: 'ctx-majorrivers',
  basins: 'ctx-basins',
  dams: 'ctx-dams',
  blocks: 'ctx-blocks',
  assembly: 'ctx-assembly',
  monitors: 'ctx-monitors',
  canals: 'ctx-canals',
  seismic: 'ctx-seismic',
  aquifers: 'ctx-aquifers',
  coalmines: 'ctx-coalmines',
  coalboundaries: 'ctx-coalboundaries',
  coalplants: 'ctx-coalplants',
} as const

/** Which layer toggles a source feeds (for the loading / failed note next to a checkbox). */
const SRC_KEYS: Record<string, CityContextLayerKey[]> = {
  'ctx-sources': ['industry'], 'ctx-roads': ['roads'], 'ctx-fires': ['fires'], 'ctx-railways': ['railways'],
  'ctx-transport': ['railways'], 'ctx-rivers': ['water'], 'ctx-water': ['water'], 
  'ctx-protected': ['protected'], 'ctx-places': ['places'],
  'ctx-landmarks': ['landmarks'], 'ctx-power': ['power'],
  'ctx-majorrivers': ['majorrivers'], 'ctx-basins': ['basins'], 'ctx-dams': ['dams'],
  'ctx-blocks': ['blocks', 'groundwater'], 'ctx-assembly': ['constituencies'], 'ctx-monitors': ['monitors'], 'ctx-canals': ['canals'],
  'ctx-seismic': ['seismic'], 'ctx-aquifers': ['aquifers'],
  'ctx-coalmines': ['coalmines'], 'ctx-coalboundaries': ['coalmines'], 'ctx-coalplants': ['coalplants'],
}

/** Layer ids per toggle. The state outline goes with the districts toggle. */
const LAYERS: Record<CityContextLayerKey, string[]> = {
  districts: ['ctx-districts-fill', 'ctx-districts-line', 'ctx-state-line'],
  landcover: ['ctx-landcover'],
  nightlights: ['ctx-nightlights'],
  satellite: [], // added and removed on demand (see ensureSatellite)
  relief: [], // added and removed on demand (see ensureRelief)
  protected: ['ctx-protected-fill', 'ctx-protected-line'],
  water: ['ctx-water-fill', 'ctx-rivers-line'],
  majorrivers: ['ctx-majorrivers-line', 'ctx-majorrivers-label'],
  basins: ['ctx-basins-line', 'ctx-basins-label'],
  dams: ['ctx-dams', 'ctx-dams-label'],
  canals: ['ctx-canals-line'],
  coalmines: ['ctx-coalmines', 'ctx-coalmines-label', 'ctx-coalboundaries-fill', 'ctx-coalboundaries-line'],
  coalplants: ['ctx-coalplants', 'ctx-coalplants-label'],
  seismic: ['ctx-seismic-fill'],
  aquifers: ['ctx-aquifers-fill'],
  groundwater: ['ctx-groundwater-fill'],
  monitors: ['ctx-monitors'],
  blocks: ['ctx-blocks-fill', 'ctx-blocks-line', 'ctx-blocks-label'],
  constituencies: ['ctx-assembly-line', 'ctx-assembly-label'],
  places: ['ctx-places-town', 'ctx-places-village', 'ctx-places-label-town', 'ctx-places-label-town2', 'ctx-places-label-town3', 'ctx-places-label-village'],
  railways: ['ctx-railways-main', 'ctx-railways-siding', 'ctx-transport'],
  roads: ['ctx-roads-line'],
  power: ['ctx-power-line', 'ctx-power-sub'],
  industry: ['ctx-plants'],
  fires: ['ctx-fires'],
  landmarks: ['ctx-landmarks', 'ctx-landmarks-label'],
}

/** Topmost first: a click shows the popup of the highest feature under it. */
const CLICKABLE = ['ctx-coalplants', 'ctx-coalmines', 'ctx-plants', 'ctx-dams', 'ctx-monitors', 'ctx-fires', 'ctx-landmarks', 'ctx-transport',
  'ctx-power-sub', 'ctx-places-town', 'ctx-places-village', 'ctx-coalboundaries-fill', 'ctx-railways-main',
  'ctx-railways-siding', 'ctx-majorrivers-line', 'ctx-canals-line', 'ctx-rivers-line', 'ctx-water-fill', 'ctx-protected-fill',   'ctx-groundwater-fill', 'ctx-blocks-fill', 'ctx-aquifers-fill', 'ctx-seismic-fill', 'ctx-districts-fill']

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
    const needed = (NEEDED as readonly string[]).includes(k)
    map.addSource(id, { type: 'geojson', data: needed ? data[k as keyof PackData] : `${base}/${FILES[k as keyof typeof FILES]}` })
  }
  const vis = (key: CityContextLayerKey) => (visible[key] ? 'visible' : 'none') as 'visible' | 'none'
  syncBasemap(map, visible)
  const font = labelFont(map)
  // Rasters first (bottom): land cover, night lights.
  if (landcover) {
    map.addSource('ctx-landcover', { type: 'image', url: `${base}/landcover_2021.png`, coordinates: landcover.coordinates })
    map.addLayer({ id: 'ctx-landcover', type: 'raster', source: 'ctx-landcover', layout: { visibility: vis('landcover') },
      paint: { 'raster-opacity': 0.5, 'raster-resampling': 'nearest' } })
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
  map.addLayer({ id: 'ctx-protected-fill', type: 'fill', source: SRC.protected, layout: { visibility: vis('protected') },
    paint: { 'fill-color': '#1B5E20', 'fill-opacity': 0.12 } })
  map.addLayer({ id: 'ctx-protected-line', type: 'line', source: SRC.protected, layout: { visibility: vis('protected') },
    paint: { 'line-color': '#1B5E20', 'line-width': 1.4, 'line-dasharray': [3, 2] } })
  map.addLayer({ id: 'ctx-coalboundaries-fill', type: 'fill', source: SRC.coalboundaries, layout: { visibility: vis('coalmines') },
    paint: { 'fill-color': '#212121', 'fill-opacity': 0.22 } })
  map.addLayer({ id: 'ctx-coalboundaries-line', type: 'line', source: SRC.coalboundaries, layout: { visibility: vis('coalmines') },
    paint: { 'line-color': '#212121', 'line-width': 1.2 } })
  map.addLayer({ id: 'ctx-seismic-fill', type: 'fill', source: SRC.seismic, layout: { visibility: vis('seismic') },
    paint: { 'fill-color': ['match', ['get', 'zone'], 'II', '#FFE9A8', 'III', '#F9C46B', 'IV', '#F08A4B', 'V', '#D9534F', '#DDDDDD'], 'fill-opacity': 0.5 } })
  map.addLayer({ id: 'ctx-aquifers-fill', type: 'fill', source: SRC.aquifers, layout: { visibility: vis('aquifers') },
    paint: { 'fill-color': ['match', ['get', 'aquifer'], 'Sandstone', '#E8B77A', 'Alluvium', '#F2E08A', 'Gneiss', '#9CC5A1',
      'Basement Gneissic Complex', '#9CC5A1', 'Schist', '#7FB69E', 'Basalt', '#6C7A89', 'Limestone', '#8EC9E8', 'Laterite', '#D98C5F',
      '#B8A9C9'], 'fill-opacity': 0.55 } })
  map.addLayer({ id: 'ctx-groundwater-fill', type: 'fill', source: SRC.blocks, layout: { visibility: vis('groundwater') },
    paint: { 'fill-color': ['match', ['get', 'gw_class'], 'Safe', '#7CC576', 'Semi-Critical', '#F2D45C', 'Critical', '#F29B4B',
      'Over Exploited', '#D9534F', '#BDBDBD'], 'fill-opacity': 0.55 } })
  map.addLayer({ id: 'ctx-blocks-fill', type: 'fill', source: SRC.blocks, layout: { visibility: vis('blocks') },
    paint: { 'fill-color': '#000000', 'fill-opacity': 0 } })
  map.addLayer({ id: 'ctx-water-fill', type: 'fill', source: SRC.water, layout: { visibility: vis('water') },
    paint: { 'fill-color': '#3B82C4', 'fill-opacity': 0.75 } })
  map.addLayer({ id: 'ctx-basins-line', type: 'line', source: SRC.basins, layout: { visibility: vis('basins') },
    paint: { 'line-color': '#5B7FA6', 'line-width': 1.1, 'line-opacity': 0.85, 'line-dasharray': [4, 3] } })
  map.addLayer({ id: 'ctx-rivers-line', type: 'line', source: SRC.rivers, layout: { visibility: vis('water') },
    paint: { 'line-color': '#3B82C4', 'line-width': ['interpolate', ['linear'], ['zoom'], 6,
      ['match', ['get', 'kind'], 'river', 0.8, 0.4], 11, ['match', ['get', 'kind'], 'river', 2.4, 1.2]] } })
  map.addLayer({ id: 'ctx-blocks-line', type: 'line', source: SRC.blocks, minzoom: 6.5, layout: { visibility: vis('blocks') },
    paint: { 'line-color': '#7A7A7A', 'line-width': 0.9, 'line-dasharray': [3, 2] } })
  map.addLayer({ id: 'ctx-assembly-line', type: 'line', source: SRC.assembly, minzoom: 6.5, layout: { visibility: vis('constituencies') },
    paint: { 'line-color': '#7E57C2', 'line-width': 1.1, 'line-dasharray': [5, 3] } })
  map.addLayer({ id: 'ctx-canals-line', type: 'line', source: SRC.canals, minzoom: 7, layout: { visibility: vis('canals') },
    paint: { 'line-color': '#4FA3D9', 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.7, 12, 2] } })
  map.addLayer({ id: 'ctx-majorrivers-line', type: 'line', source: SRC.majorrivers, layout: { visibility: vis('majorrivers'), 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#1D6FB8', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 11, 3.2] } })
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
  map.addLayer({ id: 'ctx-power-sub', type: 'circle', source: SRC.power, filter: ['==', ['get', 'kind'], 'substation'],
    minzoom: 8, layout: { visibility: vis('power') },
    paint: { 'circle-radius': 3.5, 'circle-color': '#8E44AD', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } })
  map.addLayer({ id: 'ctx-places-village', type: 'circle', source: SRC.places, filter: ['==', ['get', 'kind'], 'village'],
    minzoom: 10, layout: { visibility: vis('places') },
    paint: { 'circle-radius': 2.2, 'circle-color': '#5B4A3A', 'circle-opacity': 0.8 } })
  map.addLayer({ id: 'ctx-places-town', type: 'circle', source: SRC.places, filter: ['in', ['get', 'kind'], ['literal', ['city', 'town']]],
    layout: { visibility: vis('places') },
    // 229 towns would pile up in the coalfield at state zoom: the larger ones first, smaller ones as you zoom in.
    paint: { 'circle-radius': ['step', ['zoom'],
      ['case', ['>=', ['coalesce', ['get', 'pop'], 0], 100000], 4.5, 0],
      8, ['case', ['>=', ['coalesce', ['get', 'pop'], 0], 30000], 4, 0],
      9.5, ['match', ['get', 'kind'], 'city', 5, 3.5]],
      'circle-color': '#FFFFFF', 'circle-stroke-color': '#2E2219',
      'circle-stroke-width': ['step', ['zoom'], ['case', ['>=', ['coalesce', ['get', 'pop'], 0], 100000], 1.5, 0],
        8, ['case', ['>=', ['coalesce', ['get', 'pop'], 0], 30000], 1.5, 0], 9.5, 1.5] } })
  map.addLayer({ id: 'ctx-transport', type: 'circle', source: SRC.transport, minzoom: 8, layout: { visibility: vis('railways') },
    paint: { 'circle-radius': ['match', ['get', 'kind'], 'airport', 5, 3], 'circle-color': ['match', ['get', 'kind'], 'airport', '#00796B', '#2B2B2B'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } })
  map.addLayer({ id: 'ctx-landmarks', type: 'circle', source: SRC.landmarks, minzoom: 7, layout: { visibility: vis('landmarks') },
    paint: { 'circle-radius': 4, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1,
      'circle-color': ['match', ['get', 'kind'], 'peak', '#6D4C41', 'waterfall', '#0288D1', '#455A64'] } })
  map.addLayer({ id: 'ctx-coalmines', type: 'circle', source: SRC.coalmines, layout: { visibility: vis('coalmines') },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['coalesce', ['get', 'capacity_mtpa'], 0.5], 0, 3.5, 5, 6, 25, 10],
      'circle-color': ['match', ['get', 'status'], 'Operating', '#212121', 'Proposed', '#F9A825', 'Closed', '#C62828', '#8E8E8E'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2 } })
  map.addLayer({ id: 'ctx-coalplants', type: 'circle', source: SRC.coalplants, layout: { visibility: vis('coalplants') },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['coalesce', ['get', 'total_mw'], 100], 0, 5, 500, 7.5, 2000, 11],
      'circle-color': '#B23A48', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } })
  map.addLayer({ id: 'ctx-monitors', type: 'circle', source: SRC.monitors, minzoom: 7, layout: { visibility: vis('monitors') },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 12, 5],
      'circle-color': ['match', ['get', 'kind'], 'groundwater_level', '#00796B', 'water_quality', '#C2185B', 'rainfall', '#0277BD', '#283593'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 0.9 } })
  map.addLayer({ id: 'ctx-dams', type: 'circle', source: SRC.dams, layout: { visibility: vis('dams') },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.5, 11, 6.5], 'circle-color': '#0B3C7D',
      'circle-stroke-color': '#fff', 'circle-stroke-width': 1.3 } })
  if (font) {
    map.addLayer({ id: 'ctx-coalplants-label', type: 'symbol', source: SRC.coalplants, minzoom: 8,
      layout: { visibility: vis('coalplants'), 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 10.5, 'text-offset': [0, 1.2],
        'text-anchor': 'top', 'text-optional': true, 'text-max-width': 9 },
      paint: { 'text-color': '#7A2430', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.3 } })
    map.addLayer({ id: 'ctx-coalmines-label', type: 'symbol', source: SRC.coalmines, minzoom: 9,
      layout: { visibility: vis('coalmines'), 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 10, 'text-offset': [0, 1],
        'text-anchor': 'top', 'text-optional': true, 'text-max-width': 9 },
      paint: { 'text-color': '#212121', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.3 } })
    map.addLayer({ id: 'ctx-blocks-label', type: 'symbol', source: SRC.blocks, minzoom: 8.5,
      layout: { visibility: vis('blocks'), 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 10, 'text-max-width': 7, 'text-optional': true },
      paint: { 'text-color': '#4A4A4A', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.2 } })
    map.addLayer({ id: 'ctx-assembly-label', type: 'symbol', source: SRC.assembly, minzoom: 8,
      layout: { visibility: vis('constituencies'), 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 10, 'text-max-width': 7, 'text-optional': true },
      paint: { 'text-color': '#5E3FA0', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.2 } })
    map.addLayer({ id: 'ctx-basins-label', type: 'symbol', source: SRC.basins, minzoom: 6,
      filter: ['!=', ['get', 'sub_basin'], ''], layout: { visibility: vis('basins'),
        'text-field': ['get', 'sub_basin'], 'text-font': font, 'text-size': 10, 'text-max-width': 8, 'text-optional': true },
      paint: { 'text-color': '#3F5F86', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.2, 'text-opacity': 0.9 } })
    map.addLayer({ id: 'ctx-majorrivers-label', type: 'symbol', source: SRC.majorrivers, minzoom: 7,
      layout: { visibility: vis('majorrivers'), 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': font,
        'text-size': 11, 'text-letter-spacing': 0.08, 'text-optional': true },
      paint: { 'text-color': '#154F85', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.4 } })
    map.addLayer({ id: 'ctx-dams-label', type: 'symbol', source: SRC.dams, minzoom: 8,
      filter: ['!=', ['get', 'name'], ''], layout: { visibility: vis('dams'), 'text-field': ['get', 'name'], 'text-font': font,
        'text-size': 10, 'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#0B3C7D', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.2 } })
    // Town names in three tiers, matching the dots: the bigger town keeps its name when names collide.
    const townKinds: maplibregl.ExpressionSpecification = ['in', ['get', 'kind'], ['literal', ['city', 'town']]]
    const popOf: maplibregl.ExpressionSpecification = ['coalesce', ['get', 'pop'], 0]
    const townLabel = (id: string, minzoom: number, extra: maplibregl.ExpressionSpecification[]) => map.addLayer({ id, type: 'symbol', source: SRC.places,
      filter: ['all', townKinds, ...extra], minzoom, layout: { visibility: vis('places'),
        'text-field': ['get', 'name'], 'text-font': font, 'text-size': ['match', ['get', 'kind'], 'city', 13, 11],
        'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-optional': true, 'symbol-sort-key': ['-', 0, popOf] },
      paint: { 'text-color': '#2E2219', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.5 } })
    townLabel('ctx-places-label-town', 6.5, [['>=', popOf, 100000]])
    townLabel('ctx-places-label-town2', 8, [['<', popOf, 100000], ['>=', popOf, 30000]])
    townLabel('ctx-places-label-town3', 9.5, [['<', popOf, 30000]])
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
  map.addLayer({ id: MASK_DISTRICT, type: 'fill', source: MASK_DISTRICT, paint: { 'fill-color': MASK_COLOR, 'fill-opacity': 0.5 } })
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

/** The basemap draws things we also draw from our own data: administrative lines (in places they disagree with ours,
 *  e.g. OSM's Kodarma is 35% too small), town names, roads, rivers, parks, forest shading. Two copies of one thing,
 *  slightly apart, read as an error and clutter the points on top. So a basemap feature class is hidden while the same
 *  class is shown from our data, and comes back when ours is switched off. A few classes (shops, trails, ...) have no
 *  use here and are always hidden. Keyed by the source layer of the OpenMapTiles schema that the basemap styles use. */
type BasemapRule = { when: (v: CityContextVisibility) => boolean; id?: RegExp }
const BASEMAP_RULES: Record<string, BasemapRule[]> = {
  boundary: [{ when: (v) => v.districts }],
  place: [{ when: (v) => v.places }],
  transportation: [{ when: (v) => v.railways, id: /rail/i }, { when: (v) => v.roads, id: /^(?!.*rail)/i }],
  transportation_name: [{ when: (v) => v.roads }],
  aeroway: [{ when: (v) => v.railways }],
  aerodrome_label: [{ when: (v) => v.railways }],
  waterway: [{ when: (v) => v.water }],
  water: [{ when: (v) => v.water }],
  water_name: [{ when: (v) => v.water }],
  park: [{ when: (v) => v.protected }],
  landcover: [{ when: (v) => v.landcover || v.satellite }],
  globallandcover: [{ when: (v) => v.landcover || v.satellite }],
  mountain_peak: [{ when: (v) => v.landmarks }],
  contour: [{ when: (v) => v.relief }],
  hillshade: [{ when: (v) => v.relief }],
  poi: [{ when: () => true }],
  outdoor_poi: [{ when: () => true }],
  trail: [{ when: () => true }],
}
const hiddenBasemap = new WeakMap<maplibregl.Map, Set<string>>()
function syncBasemap(map: maplibregl.Map, v: CityContextVisibility) {
  const mine = hiddenBasemap.get(map) ?? new Set<string>()
  for (const l of map.getStyle()?.layers ?? []) {
    if (l.id.startsWith('ctx-')) continue
    const rules = BASEMAP_RULES[(l as { 'source-layer'?: string })['source-layer'] ?? l.type]
    if (!rules) continue
    const hide = rules.some((r) => r.when(v) && (!r.id || r.id.test(l.id)))
    const shown = map.getLayoutProperty(l.id, 'visibility') !== 'none'
    if (hide && shown) {
      map.setLayoutProperty(l.id, 'visibility', 'none')
      mine.add(l.id)
    } else if (!hide && !shown && mine.has(l.id)) {
      map.setLayoutProperty(l.id, 'visibility', 'visible')
      mine.delete(l.id)
    }
  }
  hiddenBasemap.set(map, mine)
}
function restoreBasemap(map: maplibregl.Map) {
  for (const id of hiddenBasemap.get(map) ?? []) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible')
  hiddenBasemap.delete(map)
}

function removeAll(map: maplibregl.Map) {
  restoreBasemap(map)
  for (const id of [DISTRICT_SELECTED, MASK_STATE, MASK_DISTRICT]) if (map.getLayer(id)) map.removeLayer(id)
  for (const ids of Object.values(LAYERS)) for (const id of ids) if (map.getLayer(id)) map.removeLayer(id)
  for (const id of [...Object.values(SRC), MASK_STATE, MASK_DISTRICT, 'ctx-landcover', 'ctx-nightlights']) if (map.getSource(id)) map.removeSource(id)
  removeSatellite(map)
  removeRelief(map)
}

/** The app's "liquid glass" (same recipe as components/GlassSurface.tsx), for panels built as plain DOM: a blur (with the SVG
 *  distortion filter when `distort`), a white tint, and an inset highlight, stacked behind the content. The shell must be
 *  positioned (absolute or relative). Big scrolling panels use a plain blur (the filter is costly while content scrolls). */
function glassify(shell: HTMLElement, { tint = 0.5, distort = false }: { tint?: number; distort?: boolean } = {}) {
  if (distort && !document.getElementById('glass-distortion')) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('style', 'display:none')
    svg.setAttribute('aria-hidden', 'true')
    svg.innerHTML = '<filter id="glass-distortion" x="0%" y="0%" width="100%" height="100%" filterUnits="objectBoundingBox"><feTurbulence type="fractalNoise" baseFrequency="0.001 0.005" numOctaves="1" seed="17" result="turbulence"/><feComponentTransfer in="turbulence" result="mapped"><feFuncR type="gamma" amplitude="1" exponent="10" offset="0.5"/><feFuncG type="gamma" amplitude="0" exponent="1" offset="0"/><feFuncB type="gamma" amplitude="0" exponent="1" offset="0.5"/></feComponentTransfer><feGaussianBlur in="turbulence" stdDeviation="3" result="softMap"/><feDisplacementMap in="SourceGraphic" in2="softMap" scale="200" xChannelSelector="R" yChannelSelector="G"/></filter>'
    document.body.appendChild(svg)
  }
  shell.classList.add('isolate')
  shell.style.boxShadow = '0 6px 6px rgba(0,0,0,0.2), 0 0 20px rgba(0,0,0,0.1)'
  const layer = (z: number, style: Partial<CSSStyleDeclaration>) => {
    const d = document.createElement('div')
    d.className = 'pointer-events-none absolute inset-0 rounded-lg'
    d.style.zIndex = String(z)
    Object.assign(d.style, style)
    return d
  }
  const filter = distort ? 'blur(3px) url(#glass-distortion)' : 'blur(16px) saturate(1.5)'
  shell.prepend(
    layer(-3, { backdropFilter: filter, webkitBackdropFilter: filter } as Partial<CSSStyleDeclaration>),
    layer(-2, { background: `rgba(255,255,255,${tint})` }),
    layer(-1, { boxShadow: 'inset 2px 2px 1px 0 rgba(255,255,255,0.5), inset -1px -1px 1px 1px rgba(255,255,255,0.5)' }),
  )
}

/** Which district a point is in (ray casting over the district outlines). */
function districtAt(fc: FeatureCollection | undefined, lng: number, lat: number): string | null {
  const p = polygonAt(fc, lng, lat)
  return p ? String(p.name ?? '') : null
}

/** The river basin and sub-basin at a point, as one line ("Damodar sub-basin, Ganga basin"). */
function basinAt(fc: FeatureCollection | undefined, lng: number, lat: number): string | null {
  const p = polygonAt(fc, lng, lat)
  if (!p) return null
  return [p.sub_basin ? `${p.sub_basin} sub-basin` : '', p.basin ? `${p.basin} basin` : ''].filter(Boolean).join(', ') || null
}

/** Properties of the first polygon of a collection that contains the point (ray casting). */
function polygonAt(fc: FeatureCollection | undefined, lng: number, lat: number): Record<string, unknown> | null {
  if (!fc) return null
  const inRing = (ring: number[][]) => {
    let inside = false
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xi, yi] = ring[a]
      const [xj, yj] = ring[b]
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
  const inPoly = (poly: number[][][]) => inRing(poly[0]) && !poly.slice(1).some(inRing)
  for (const f of fc.features) {
    const g = f.geometry
    const hit = g.type === 'Polygon' ? inPoly(g.coordinates) : g.type === 'MultiPolygon' ? g.coordinates.some(inPoly) : false
    if (hit) return f.properties ?? {}
  }
  return null
}

interface VillageDetails {
  fields: string[]
  water_sources: string[]
  villages: Record<string, (string | number | null)[]>
}
const villageDetailsCache = new Map<string, Promise<VillageDetails | null>>()
/** The Census village directory details (land use, water sources, ...), fetched once, the first time a village is clicked. */
function loadVillageDetails(base: string): Promise<VillageDetails | null> {
  let p = villageDetailsCache.get(base)
  if (!p) {
    p = fetch(`${base}/village_details.json`)
      .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? (r.json() as Promise<VillageDetails>) : null))
      .catch(() => null)
    villageDetailsCache.set(base, p)
  }
  return p
}

/** Fill the village popup's details section when the file is in. */
function attachVillageDetails(node: HTMLElement, base: string) {
  const slot = node.querySelector<HTMLElement>('[data-village-details]')
  const code = slot?.dataset.villageDetails
  if (!slot || !code) return
  loadVillageDetails(base).then((d) => {
    const row = d?.villages[code]
    if (!d || !row) return
    const v = (name: string) => row[d.fields.indexOf(name)]
    const n = (x: unknown, dp = 0) => (x == null || x === '' ? null : Number(x).toLocaleString('en-IN', { maximumFractionDigits: dp }))
    const line = (k: string, val: string) => {
      const r = document.createElement('div')
      r.className = 'flex items-baseline justify-between gap-3'
      const a = document.createElement('span')
      a.className = 'text-slate-500'
      a.textContent = k
      const b = document.createElement('span')
      b.className = 'text-right font-medium text-slate-900'
      b.textContent = val
      r.append(a, b)
      return r
    }
    const head = (t: string) => {
      const h = document.createElement('p')
      h.className = 'mt-2 border-t border-slate-200/80 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-400'
      h.textContent = t
      return h
    }
    const box = document.createElement('div')
    box.className = 'space-y-0.5'
    if (v('gram_panchayat')) box.appendChild(line('Gram panchayat', String(v('gram_panchayat'))))
    if (v('nearest_town')) box.appendChild(line('Nearest town', `${v('nearest_town')}${n(v('nearest_town_km')) ? `, ${n(v('nearest_town_km'))} km` : ''}`))
    if (n(v('male')) && n(v('female'))) box.appendChild(line('Men / women', `${n(v('male'))} / ${n(v('female'))}`))
    const land: [string, string][] = [['Net area sown', 'net_sown_ha'], ['Forest', 'forest_ha'], ['Irrigated', 'irrigated_ha'],
      ['Fallow (current)', 'fallow_current_ha'], ['Fallow (other)', 'fallow_other_ha'], ['Culturable waste', 'culturable_waste_ha'],
      ['Non-agricultural use', 'non_agricultural_ha'], ['Barren, uncultivable', 'barren_ha']]
    const used = land.filter(([, f]) => Number(v(f)) > 0)
    box.appendChild(head('Land use, hectares (Census 2011)'))
    if (used.length) for (const [k, f] of used) box.appendChild(line(k, n(v(f)) ?? ''))
    else box.appendChild(line('Recorded', 'none'))
    const mask = Number(v('water_sources_mask'))
    box.appendChild(head('Drinking water sources in the village'))
    if (mask < 0) box.appendChild(line('Recorded', 'no'))
    else {
      const have = d.water_sources.filter((_, i) => (mask >> i) & 1)
      const t = document.createElement('p')
      t.className = 'text-slate-900'
      t.textContent = have.length ? have.join(', ') : 'None of the listed sources'
      box.appendChild(t)
    }
    slot.appendChild(box)
  })
}

const OSM_SOURCE = 'OpenStreetMap, mapped by volunteers (3 Nov 2026). May be incomplete or out of date.'

/** A map popup in the platform's design: type label, name in the serif face, a few rows, source in the footer. */
function popupNode(props: Record<string, unknown>, layerId: string, district: string | null, basin: string | null = null): HTMLElement {
  const el = document.createElement('div')
  el.className = 'min-w-[180px] max-w-[250px] py-2.5 pl-3 pr-3 text-xs text-slate-700'
  let eyebrow = ''
  let title = ''
  const rows: [string, string][] = []
  let note = ''
  let source = ''
  const kind = KIND_LABEL[String(props.kind)] ?? ''
  if (layerId === 'ctx-fires') {
    eyebrow = 'Satellite heat detection'
    title = String(props.date ?? 'Heat spot')
    rows.push(['Time', props.daynight === 'N' ? 'Night pass' : 'Day pass'], ['Fire radiative power', `${props.frp ?? '—'} MW`])
    if (district) rows.push(['District', district])
    note = 'A 375 m pixel that was unusually hot: a coal fire, industrial heat, or crop or forest burning. Not a measured fire area.'
    source = 'NASA FIRMS (VIIRS), dates in UTC'
  } else if (layerId === 'ctx-dams') {
    eyebrow = 'Large dam'
    title = String(props.name || 'Large dam')
    if (props.river) rows.push(['River', String(props.river)])
    if (district) rows.push(['District', district])
    if (props.height_m != null && props.height_m !== '') rows.push(['Height', `${props.height_m} m`])
    if (props.storage_mcm != null && props.storage_mcm !== '') rows.push(['Reservoir capacity', `${props.storage_mcm} million m³`])
    if (props.year) rows.push(['Completed', String(props.year)])
    if (props.purpose) rows.push(['Purpose', String(props.purpose)])
    if (props.owner) rows.push(['Managed by', String(props.owner)])
    note = 'Large dams only; smaller dams are not in the register.'
    source = `National Register of Large Dams (Central Water Commission), via India-WRIS${props.nrld ? `; register no. ${props.nrld}` : ''}.`
  } else if (layerId === 'ctx-places-village' || layerId === 'ctx-places-town') {
    const fmt = (v: unknown, d = 0) => (v == null || v === '' ? null : Number(v).toLocaleString('en-IN', { maximumFractionDigits: d }))
    const isVillage = props.kind === 'village'
    eyebrow = isVillage ? 'Village' : `${props.kind === 'city' ? 'City' : 'Town'}${props.status ? ` · ${props.status}` : ''}`
    title = String(props.name || eyebrow)
    const pop = fmt(props.pop)
    if (pop) rows.push(['Population (2011)', pop])
    if (!isVillage && props.pop2001) rows.push(['Population (2001)', fmt(props.pop2001) ?? ''])
    if (fmt(props.hh)) rows.push(['Households', fmt(props.hh) ?? ''])
    if (fmt(props.km2, 2)) rows.push(['Area', `${fmt(props.km2, 2)} km²`])
    if (!isVillage && fmt(props.density)) rows.push(['Density', `${fmt(props.density)} per km²`])
    if (!isVillage && fmt(props.sex_ratio)) rows.push(['Sex ratio', `${fmt(props.sex_ratio)} females per 1,000 males`])
    if (isVillage && props.block) rows.push(['Block', String(props.block)])
    if (district) rows.push(['District', district])
    source = `Census of India 2011 (${isVillage ? 'village' : 'town'} directory), via India-WRIS. Point is approximate.`
  } else if (layerId === 'ctx-blocks-fill' || layerId === 'ctx-groundwater-fill') {
    eyebrow = 'Block (CD block)'
    title = String(props.name || 'Block')
    if (props.district) rows.push(['District', String(props.district)])
    if (props.gw_class) {
      rows.push(['Ground water', String(props.gw_class).replace('Over Exploited', 'Over-exploited')])
      if (props.gw_stage_pct != null && props.gw_stage_pct !== '') rows.push(['Drawn each year', `${Number(props.gw_stage_pct).toFixed(1)}% of what is replenished`])
      if (props.gw_net_ham != null && props.gw_net_ham !== '') rows.push(['Net available', `${Number(props.gw_net_ham).toLocaleString('en-IN')} ham`])
      if (props.gw_draft_ham != null && props.gw_draft_ham !== '') rows.push(['Drawn', `${Number(props.gw_draft_ham).toLocaleString('en-IN')} ham`])
      note = 'ham = hectare-metre (10,000 m³). Block status is the 2020 assessment; it can differ from local conditions.'
    } else {
      note = 'No ground water assessment is listed for this block.'
    }
    source = 'Block boundary: India-WRIS. Ground water: Central Ground Water Board, Dynamic Ground Water Resources 2020, via India-WRIS.'
  } else if (layerId === 'ctx-coalmines') {
    const mt = (v: unknown) => (v == null || v === '' ? null : `${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 })} million tonnes`)
    eyebrow = `Coal mine · ${props.status ?? ''}${props.status_detail && props.status === 'Closed' ? ` (${props.status_detail})` : ''}`
    title = String(props.name || 'Coal mine')
    rows.push(['Owner', props.owner ? String(props.owner) : 'not listed'])
    if (mt(props.capacity_mtpa)) rows.push(['Capacity', `${mt(props.capacity_mtpa)} a year`])
    if (mt(props.output_mt)) rows.push(['Output', `${mt(props.output_mt)}${props.output_year ? ` (${props.output_year})` : ''}`])
    const how = [props.mine_type, props.method].filter(Boolean).join(', ')
    if (how) rows.push(['Mine type', how])
    if (props.coalfield) rows.push(['Coalfield', String(props.coalfield)])
    if (props.coal_type) rows.push(['Coal', `${props.coal_type}${props.grade ? `, ${String(props.grade).toLowerCase()}` : ''}`])
    if (props.opened) rows.push(['Opened', String(props.opened)])
    if (props.workforce) rows.push(['Workforce', Number(props.workforce).toLocaleString('en-IN')])
    if (props.expansion_mtpa) rows.push(['Expansion', `to ${mt(props.expansion_mtpa)} a year${props.expansion_status ? ` (${String(props.expansion_status).toLowerCase()})` : ''}`])
    if (district) rows.push(['District', district])
    note = `Location rated ${String(props.accuracy ?? 'unknown').toLowerCase()} by Global Energy Monitor. Mines of 1 million tonnes a year or more, and some smaller ones; not a complete list.`
    source = `Global Energy Monitor, Global Coal Mine Tracker, August 2026 release (CC BY 4.0); mine ${props.id ?? ''}.`
  } else if (layerId === 'ctx-coalplants') {
    const mw = (v: unknown) => (v == null || v === '' ? null : `${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 1 })} MW`)
    eyebrow = `Coal power plant · ${String(props.status ?? '').replace(/^./, (c) => c.toUpperCase())}`
    title = String(props.name || 'Coal power plant')
    rows.push(['Owner', props.owner ? String(props.owner) : 'not listed'])
    if (mw(props.operating_mw)) rows.push(['Operating capacity', mw(props.operating_mw) ?? ''])
    if (mw(props.total_mw) && props.total_mw !== props.operating_mw) rows.push(['All units listed', mw(props.total_mw) ?? ''])
    if (props.technology) rows.push(['Technology', String(props.technology)])
    if (props.captive) rows.push(['Captive use', String(props.captive)])
    if (district) rows.push(['District', district])
    note = String(props.units ?? '')
    source = `Global Energy Monitor, Global Coal Plant Tracker, July 2026 release (CC BY 4.0); plant ${props.id ?? ''}.`
  } else if (layerId === 'ctx-coalboundaries-fill') {
    eyebrow = 'Coal mine boundary'
    title = String(props.name || 'Coal mine')
    if (props.kind) rows.push(['Mining', String(props.kind)])
    if (props.dated) rows.push(['Source dated', String(props.dated)])
    if (district) rows.push(['District', district])
    note = props.note ? String(props.note) : 'Outline as compiled by Global Energy Monitor.'
    source = 'Global Energy Monitor, Coal Mine Boundaries and Methane Sources v1.0.2 (CC BY 4.0).'
  } else if (layerId === 'ctx-seismic-fill') {
    eyebrow = 'Earthquake zone'
    title = `Zone ${props.zone}`
    if (props.intensity) rows.push(['Intensity', String(props.intensity)])
    note = 'Zones run from II (lowest) to V (highest). A regional zoning, not a local hazard assessment.'
    source = 'Seismic zones of India, via India-WRIS.'
  } else if (layerId === 'ctx-aquifers-fill') {
    eyebrow = 'Major aquifer'
    title = String(props.aquifer || 'Aquifer')
    if (props.detail && props.detail !== props.aquifer) rows.push(['Type', String(props.detail)])
    note = 'The main aquifer rock type of the area: a generalised map, not a well-level survey.'
    source = 'Central Ground Water Board aquifer map, via India-WRIS.'
  } else if (layerId === 'ctx-monitors') {
    const label: Record<string, string> = { groundwater_level: 'Ground water level station', water_quality: 'Water quality station', rainfall: 'Rainfall station', reservoir: 'Reservoir station' }
    eyebrow = label[String(props.kind)] ?? 'Monitoring station'
    title = String(props.name || props.code || 'Station')
    if (props.agency) rows.push(['Agency', String(props.agency)])
    if (props.medium) rows.push(['Water', String(props.medium)])
    if (props.block) rows.push(['Block', String(props.block)])
    if (district) rows.push(['District', district])
    note = 'A listed monitoring site. Readings are published on India-WRIS.'
    source = 'India-WRIS water information system (agency as listed).'
  } else if (layerId === 'ctx-canals-line') {
    eyebrow = String(props.kind || 'Canal')
    title = String(props.name || 'Canal')
    if (props.project) rows.push(['Project', String(props.project)])
    if (district) rows.push(['District', district])
    source = 'India-WRIS (Central Water Commission), water-resource project canals.'
  } else if (layerId === 'ctx-majorrivers-line') {
    eyebrow = 'Major river'
    title = String(props.name || 'River')
    if (props.basin) rows.push(['River basin', `${props.basin}`])
    if (props.sub_basin) rows.push(['Sub-basin', String(props.sub_basin)])
    source = 'India-WRIS (Central Water Commission, Ministry of Jal Shakti).'
  } else if (layerId === 'ctx-protected-fill' && props.category) {
    eyebrow = `${props.category}${props.tiger_reserve === true || props.tiger_reserve === 'true' ? ' · Tiger reserve' : ''}`
    title = String(props.name)
    if (props.year) rows.push(['Notified', String(props.year)])
    if (props.notified_km2 != null && props.notified_km2 !== '') rows.push(['Notified area', `${Number(props.notified_km2).toLocaleString('en-IN')} km²`])
    if (district) rows.push(['District', district])
    note = 'The outline is approximate and can cover more or less than the notified area.'
    source = 'India-WRIS (Central Water Commission): list of wildlife sanctuaries and national parks.'
  } else if (props.checked) {
    eyebrow = kind || 'Checked site'
    title = String(props.name)
    if (props.operator) rows.push(['Operator', String(props.operator)])
    if (props.capacity_mw) rows.push(['Capacity', `${Number(props.capacity_mw).toLocaleString('en-IN')} MW`])
    if (district) rows.push(['District', district])
    source = 'Location: OpenStreetMap. Name and operator checked by Vayu Gati, Nov 2026.'
    if (props.capacity_mw) source += ' Capacity: Central Electricity Authority list, via the WRI Global Power Plant Database (2021 release; data about 2019-20), so it can lag units added or retired since.'
  } else {
    eyebrow = kind || 'Mapped feature'
    title = String(props.name || kind || 'Mapped feature')
    if (props.name === undefined || props.name === '') rows.push(['Name', 'not mapped'])
    if (props.kind === 'peak' && props.ele) rows.push(['Height as mapped', `${props.ele} m`])
    if (props.kind === 'line' && props.voltage) rows.push(['Voltage as mapped', `${props.voltage} V`])
    if (district) rows.push(['District', district])
    if (basin && (layerId === 'ctx-rivers-line' || layerId === 'ctx-water-fill')) rows.push(['River basin', basin])
    const polygonLayers = ['ctx-protected-fill', 'ctx-water-fill']
    if (polygonLayers.includes(layerId)) note = 'Outline as drawn by volunteers; approximate.'
    source = OSM_SOURCE
  }
  const e = document.createElement('p')
  e.className = 'pr-5 text-[10px] font-medium uppercase tracking-wider text-slate-400'
  e.textContent = eyebrow
  const t = document.createElement('p')
  t.className = 'mt-0.5 pr-5 text-sm font-semibold leading-snug text-slate-900'
  t.textContent = title
  el.append(e, t)
  if (rows.length) {
    const dl = document.createElement('dl')
    dl.className = 'mt-1.5 space-y-0.5'
    for (const [k, v] of rows) {
      const r = document.createElement('div')
      r.className = 'flex items-baseline justify-between gap-3'
      const dt = document.createElement('dt')
      dt.className = 'text-slate-500'
      dt.textContent = k
      const dd = document.createElement('dd')
      dd.className = 'text-right font-medium text-slate-900'
      dd.textContent = v
      r.append(dt, dd)
      dl.appendChild(r)
    }
    el.appendChild(dl)
  }
  if (layerId === 'ctx-places-village') {
    const slot = document.createElement('div')
    slot.dataset.villageDetails = String(props.code ?? '')
    el.appendChild(slot)
  }
  if (note) {
    const n = document.createElement('p')
    n.className = 'mt-1.5 whitespace-pre-line text-[11px] leading-snug text-slate-500'
    n.textContent = note
    el.appendChild(n)
  }
  const f = document.createElement('p')
  f.className = 'mt-2 border-t border-slate-200/80 pt-1.5 text-[10px] leading-snug text-slate-400'
  f.textContent = source
  el.appendChild(f)
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
function applyOnDemand(map: maplibregl.Map, visible: CityContextVisibility) {
  if (!alive(map)) return
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
    map.addSource(SAT_SOURCE, { type: 'raster', url: `https://api.maptiler.com/tiles/satellite-v2/tiles.json?key=${key}`,
      // The tiles are 512 px. Declaring 256 makes the map fetch one zoom level deeper, so each tile pixel lands on one
      // screen pixel on a sharp (retina) display instead of being stretched two-fold.
      tileSize: 256 })
  }
  if (!map.getLayer(SAT_LAYER)) {
    map.addLayer({ id: SAT_LAYER, type: 'raster', source: SAT_SOURCE,
      paint: { 'raster-saturation': 0.1, 'raster-contrast': 0.12 } }, anchorBelow(map, 'ctx-protected-fill'))
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
      'hillshade-highlight-color': '#FFFFFF', 'hillshade-accent-color': '#5C4B3A' } }, anchorBelow(map, 'ctx-protected-fill'))
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
  power_plants: { name: string; operator: string }[]
  large_works: { name: string; operator: string }[]
  monitors_continuous_in_feed: number | null
  monitors_manual_namp: number | null
  monitors_planned_jspcb: number | null
  groundwater?: { stage_pct: number | null; net_ham: number | null; draft_ham: number | null; blocks: Record<string, number> } | null
  mining_area_km2: number | null
  landcover_pct?: Record<string, number> | null
  climate?: {
    rain_annual_mm: number
    rain_monsoon_pct: number | null
    rain_monthly_mm: number[]
    wind_mean_ms: Record<string, number | null>
    wind_from: Record<string, string | null>
    rose_all_pct: number[]
    rose_winter_pct: number[]
  } | null
}
interface ProfilesDoc {
  sources: Record<string, string>
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

/** A small chevron (points down; add `group-open:rotate-180` or rotate it yourself for the open state). */
function chevronIcon(cls: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 12 12')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', cls)
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', 'M2.5 4.5 6 8l3.5-3.5')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.6')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(path)
  return svg
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
  private dock: HTMLDivElement | null = null
  private dockTabs: HTMLDivElement | null = null
  private dockBtns: Partial<Record<'district' | 'ask', HTMLButtonElement>> = {}
  private dockTab: 'district' | 'ask' = 'district'
  private chatOpen = false
  /** Where the chat panel renders (React portal). */
  chatSlot: HTMLDivElement | null = null
  private toolbar: HTMLDivElement | null = null
  private tab: 'overview' | 'nature' | 'sources' = 'overview'
  private lcLegend: HTMLDivElement | null = null
  private lcMeta: LandcoverMeta | null = null
  private profiles: ProfilesDoc | null = null
  private exaggeration = EXAGGERATION_3D
  /** Whether the district view shows satellite imagery (remembered between districts). */
  private satellite = true
  private satBox: HTMLInputElement | null = null
  /** What entering 3D changed in the layer switches, to put back on leaving. */
  private from3D: { applied: Partial<CityContextVisibility>; before: Partial<CityContextVisibility> } | null = null

  constructor(
    private pack: ContextPack,
    /** The layer toggles, so leaving 3D keeps satellite/relief the viewer switched on. */
    private wanted: () => CityContextVisibility,
    /** Change layers from the control's own checkboxes. */
    private onChange: (patch: Partial<CityContextVisibility>) => void,
  ) {}

  private layerInputs: Partial<Record<CityContextLayerKey, HTMLInputElement>> = {}
  private layerNotes: Partial<Record<CityContextLayerKey, HTMLSpanElement>> = {}
  private srcState = new Map<string, 'loading' | 'ok' | 'failed'>()
  private layerCount: HTMLSpanElement | null = null
  private toggleCount: HTMLSpanElement | null = null
  private groupUi: { keys: CityContextLayerKey[]; count: HTMLSpanElement; dots: HTMLSpanElement }[] = []
  private layersDetails: HTMLDetailsElement | null = null
  private legendList: HTMLDivElement | null = null
  private legendWrap: HTMLDetailsElement | null = null
  private sourceBar: HTMLDivElement | null = null
  private sourceList: HTMLSpanElement | null = null
  private onCredits: (() => void) | null = null
  private barObserver: ResizeObserver | null = null
  private resultsWrap: HTMLDetailsElement | null = null
  /** Where the assistant's answers (rankings, facts, overview) render, in the left card under the layers. */
  resultsSlot: HTMLDivElement | null = null

  /** Record a source's loading state and update the note next to the layers it feeds. */
  setSourceState(sourceId: string, state: 'loading' | 'ok' | 'failed') {
    this.srcState.set(sourceId, state)
    for (const key of SRC_KEYS[sourceId] ?? []) this.updateNote(key)
  }

  private updateNote(key: CityContextLayerKey) {
    const note = this.layerNotes[key]
    if (!note) return
    const ids = Object.entries(SRC_KEYS).filter(([, ks]) => ks.includes(key)).map(([id]) => id)
    const states = ids.map((id) => this.srcState.get(id))
    const on = this.wanted()[key]
    if (states.includes('failed')) {
      note.textContent = 'could not load'
      note.className = 'shrink-0 text-[10px] font-semibold text-red-700'
    } else if (on && states.some((x) => x !== 'ok')) {
      note.textContent = 'loading…'
      note.className = 'shrink-0 text-[10px] text-slate-400'
    } else note.textContent = ''
  }

  /** Sync the checkboxes with the current visibility. */
  setVisible(v: CityContextVisibility) {
    for (const [k, input] of Object.entries(this.layerInputs)) input.checked = v[k as CityContextLayerKey]
    if (this.satBox) this.satBox.checked = v.satellite
    if (this.on3D) this.satellite = v.satellite
    this.renderLegend(v)
    this.renderSources(v)
    for (const k of Object.keys(this.layerNotes)) this.updateNote(k as CityContextLayerKey)
    const nOn = Object.values(v).filter(Boolean).length
    if (this.layerCount) this.layerCount.textContent = `${nOn} of ${CONTEXT_LAYER_DEFS.length} on`
    if (this.toggleCount) this.toggleCount.textContent = String(nOn)
    // Each group's header shows what is on inside it (colour chips and a count), so a closed group still tells you.
    for (const g of this.groupUi) {
      const on = g.keys.filter((k) => v[k])
      g.count.textContent = on.length ? `${on.length}/${g.keys.length}` : ''
      g.dots.replaceChildren(...on.slice(0, 6).map((k) => {
        const d = document.createElement('span')
        d.className = 'inline-block h-2 w-2 rounded-sm border border-slate-300'
        d.style.background = CONTEXT_SWATCH[k]
        return d
      }))
    }
  }

  /** The layer control: themed groups that open one by one (closed ones still show what is on), with defaults / all off. */
  private buildLayerControl(): HTMLElement {
    const wrap = document.createElement('details')
    wrap.open = true
    wrap.setAttribute('data-layers', '1')
    this.layersDetails = wrap
    wrap.className = 'rounded-lg border border-slate-200 bg-white'
    const sum = document.createElement('summary')
    sum.className = 'flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-1.5'
    const st = document.createElement('span')
    st.className = 'text-[10px] font-semibold uppercase tracking-widest text-slate-500'
    st.textContent = 'Map layers'
    const count = document.createElement('span')
    count.className = 'text-[11px] font-semibold tabular-nums text-slate-700'
    this.layerCount = count
    sum.append(st, count)
    wrap.appendChild(sum)
    const inner = document.createElement('div')
    inner.className = 'border-t border-slate-200'
    const quick = document.createElement('div')
    quick.className = 'flex items-center justify-end gap-3 px-2.5 py-1 text-[11px]'
    const qbtn = (label: string, patch: () => Partial<CityContextVisibility>) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.className = 'focus-ring rounded font-medium text-accent-600 hover:underline'
      b.addEventListener('click', () => this.onChange(patch()))
      quick.appendChild(b)
    }
    const all = (on: boolean) => Object.fromEntries(CONTEXT_LAYER_DEFS.map((d) => [d.key, on])) as CityContextVisibility
    qbtn('Defaults', () => ({ ...DEFAULT_CONTEXT_VISIBLE }))
    qbtn('All off', () => all(false))
    inner.appendChild(quick)
    this.groupUi = []
    const defs = new Map(CONTEXT_LAYER_DEFS.map((d) => [d.key as CityContextLayerKey, d]))
    for (const g of CONTEXT_GROUPS) {
      const sec = document.createElement('details')
      sec.className = 'group border-t border-slate-100'
      const gs = document.createElement('summary')
      gs.className = 'flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 hover:bg-slate-50'
      const chev = document.createElement('span')
      chev.className = 'text-[9px] text-slate-400 transition-transform group-open:rotate-90'
      chev.textContent = '▶'
      const gl = document.createElement('span')
      gl.className = 'text-xs font-semibold text-slate-800'
      gl.textContent = g.label
      const dots = document.createElement('span')
      dots.className = 'ml-auto flex items-center gap-0.5'
      const gcount = document.createElement('span')
      gcount.className = 'w-7 text-right text-[10px] tabular-nums text-slate-500'
      gs.append(chev, gl, dots, gcount)
      sec.appendChild(gs)
      this.groupUi.push({ keys: [...g.keys], count: gcount, dots })
      const list = document.createElement('div')
      list.className = 'px-1.5 pb-1.5'
      for (const key of g.keys) {
        const d = defs.get(key)!
        const row = document.createElement('label')
        row.className = 'flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-[3px] hover:bg-slate-50'
        row.title = d.note
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.className = 'h-3.5 w-3.5 shrink-0 accent-accent-500'
        input.addEventListener('change', () => this.onChange({ [key]: input.checked }))
        this.layerInputs[key] = input
        const sw = document.createElement('span')
        sw.className = 'h-2.5 w-2.5 shrink-0 rounded-sm border border-slate-300'
        sw.style.background = CONTEXT_SWATCH[key]
        const tx = document.createElement('span')
        tx.className = 'min-w-0 flex-1 text-[12px] leading-tight text-slate-900'
        tx.textContent = d.label
        const note = document.createElement('span')
        note.className = 'shrink-0 text-[10px]'
        this.layerNotes[key] = note
        row.append(input, sw, tx, note)
        list.appendChild(row)
      }
      sec.appendChild(list)
      inner.appendChild(sec)
    }
    wrap.appendChild(inner)
    this.setVisible(this.wanted())
    return wrap
  }

  onAdd(map: maplibregl.Map) {
    this.map = map
    // One column: the layers card, with the legend box under it.
    const root = document.createElement('div')
    root.className = 'maplibregl-ctrl flex w-[min(320px,calc(100vw-32px))] flex-col gap-2 text-xs text-slate-700'
    const el = document.createElement('div')
    el.className = 'relative w-full overflow-hidden rounded-lg'
    root.appendChild(el)

    // Header: title and collapse toggle (collapsed on small screens, where the card would cover the map).
    const head = document.createElement('div')
    head.className = 'flex items-center gap-2 px-2.5 py-2'
    // The district picker is the card's heading: it reads "Whole Jharkhand" or the district's name, and opens the list.
    const select = document.createElement('select')
    // The ring shows for the keyboard only, not after a mouse click.
    select.className = 'h-7 min-w-0 flex-1 cursor-pointer rounded-md border border-slate-300 bg-white px-2 text-sm font-semibold text-slate-900 outline-none hover:bg-slate-50 focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-500/30'
    select.title = 'Go to a district (opens in 3D)'
    select.setAttribute('aria-label', 'Go to a district (opens in 3D)')
    select.addEventListener('change', () => this.selectDistrict(select.value || null))
    this.select = select
    this.fillSelect()
    const toggle = document.createElement('button')
    toggle.type = 'button'
    // The button says what it opens: a layers symbol and how many layers are on, then the arrow.
    toggle.className = 'focus-ring flex h-7 shrink-0 items-center gap-1 rounded-md border border-slate-300 px-1.5 text-slate-600 hover:bg-slate-50'
    const NS = 'http://www.w3.org/2000/svg'
    const layersIcon = document.createElementNS(NS, 'svg')
    layersIcon.setAttribute('viewBox', '0 0 24 24')
    layersIcon.setAttribute('aria-hidden', 'true')
    layersIcon.setAttribute('class', 'h-3.5 w-3.5 shrink-0')
    for (const d of ['M13 13.74a2 2 0 0 1-2 0L2.5 8.87a1 1 0 0 1 0-1.74L11 2.26a2 2 0 0 1 2 0l8.5 4.87a1 1 0 0 1 0 1.74z',
      'm20 14.285 1.5.845a1 1 0 0 1 0 1.74L13 21.74a2 2 0 0 1-2 0l-8.5-4.87a1 1 0 0 1 0-1.74l1.5-.845']) {
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', d)
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '2')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      layersIcon.appendChild(path)
    }
    const toggleCount = document.createElement('span')
    toggleCount.className = 'min-w-[1ch] text-[11px] font-semibold tabular-nums text-slate-700'
    this.toggleCount = toggleCount
    const toggleIcon = chevronIcon('h-3.5 w-3.5 transition-transform')
    toggle.append(layersIcon, toggleCount, toggleIcon)
    const body = document.createElement('div')
    body.className = 'max-h-[max(14rem,calc(100svh-24rem))] space-y-2 overflow-y-auto border-t border-slate-200 px-2.5 py-2.5'
    const setOpen = (open: boolean) => {
      body.style.display = open ? '' : 'none'
      // The arrow points up while the card is open (click to close) and down while it is closed (click to open).
      toggleIcon.style.transform = open ? 'rotate(180deg)' : ''
      toggle.title = open ? 'Close the layers panel' : 'Open the layers panel'
      toggle.setAttribute('aria-label', toggle.title)
      toggle.setAttribute('aria-expanded', String(open))
    }
    toggle.addEventListener('click', () => setOpen(body.style.display === 'none'))
    head.append(select, toggle)
    el.append(head, body)
    setOpen(typeof window === 'undefined' || window.innerWidth >= 640)

    body.appendChild(this.buildLayerControl())

    // Assistant answers: a drop-down section under the layers. The layers fold away when an answer arrives.
    const rw = document.createElement('details')
    rw.open = true
    rw.className = 'rounded-lg border border-slate-200 bg-white'
    rw.style.display = 'none'
    const rsum = document.createElement('summary')
    rsum.className = 'flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2'
    const rst = document.createElement('span')
    rst.className = 'text-[10px] font-semibold uppercase tracking-widest text-slate-500'
    rst.textContent = 'Answers from the assistant'
    rsum.appendChild(rst)
    const rslot = document.createElement('div')
    rslot.className = 'border-t border-slate-200 p-2.5'
    rw.append(rsum, rslot)
    body.appendChild(rw)
    this.resultsWrap = rw
    this.resultsSlot = rslot

    // One dock for the district profile and the chat (tabs), so they never overlap. A bottom sheet on phones.
    const dock = document.createElement('div')
    dock.className = 'absolute bottom-[calc(var(--src-bar-h,0px)+7.5rem)] left-2 right-2 z-10 flex max-h-[60svh] flex-col overflow-hidden rounded-lg text-xs text-slate-700 md:bottom-auto md:left-auto md:right-16 md:top-3 md:max-h-[calc(100%-7.5rem)] md:w-[320px]'
    dock.style.display = 'none'
    const dockTabs = document.createElement('div')
    dockTabs.className = 'flex gap-1 border-b border-slate-200 bg-slate-50/60 p-1.5'
    dockTabs.style.display = 'none'
    for (const k of ['district', 'ask'] as const) {
      const b = document.createElement('button')
      b.type = 'button'
      b.addEventListener('click', () => { this.dockTab = k; this.syncDock() })
      dockTabs.appendChild(b)
      this.dockBtns[k] = b
    }
    const profile = document.createElement('div')
    profile.className = 'min-h-0 flex-1 overflow-y-auto p-2.5'
    const chatSlot = document.createElement('div')
    chatSlot.className = 'min-h-0 flex-1'
    dock.append(dockTabs, profile, chatSlot)
    map.getContainer().appendChild(dock)
    glassify(dock, { tint: 0.78 })
    this.dock = dock
    this.dockTabs = dockTabs
    this.profileBox = profile
    this.chatSlot = chatSlot
    // Bottom toolbar: the 3D controls (height scale, satellite).
    const toolbar = document.createElement('div')
    toolbar.className = 'absolute bottom-8 left-2 right-16 z-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 rounded-lg px-3 py-2 text-xs text-slate-700 md:left-1/2 md:right-auto md:-translate-x-1/2'
    toolbar.style.display = 'none'
    map.getContainer().appendChild(toolbar)
    glassify(toolbar, { tint: 0.78, distort: true })
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
    ph.className = 'text-[10px] font-semibold uppercase tracking-widest text-slate-500'
    ph.textContent = '3D'
    const hRow = document.createElement('label')
    hRow.className = 'flex items-center gap-2'
    const hText = document.createElement('span')
    hText.className = 'w-[72px] shrink-0 font-semibold tabular-nums text-slate-900'
    hText.textContent = `Heights ×${this.exaggeration}`
    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = '1'
    slider.max = '6'
    slider.step = '0.5'
    slider.value = String(this.exaggeration)
    slider.className = 'w-28 accent-accent-500'
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
    satText.className = 'font-medium text-slate-700'
    satText.textContent = 'Satellite imagery'
    const sat = document.createElement('input')
    sat.type = 'checkbox'
    sat.checked = this.satellite
    sat.className = 'h-4 w-4 accent-accent-500'
    // The same switch as "Satellite imagery" in the layer card: one state, shown in both places.
    sat.addEventListener('change', () => this.onChange({ satellite: sat.checked }))
    this.satBox = sat
    satRow.append(satText, sat)
    panel.append(ph, hRow, satRow)
    toolbar.appendChild(panel)
    this.panel3D = panel

    // Legend: what the symbols of the layers that are on mean (the land-cover key appears here too)
    const legend = document.createElement('details')
    legend.open = true
    // Its own box under the layers card, in the same column (the card is compact, so there is room).
    legend.className = 'group relative w-full rounded-lg px-2.5 py-1.5 text-slate-700'
    this.legendWrap = legend
    const lsum = document.createElement('summary')
    lsum.className = 'flex cursor-pointer list-none items-center justify-between gap-3'
    const lst = document.createElement('span')
    lst.className = 'text-[9px] font-bold uppercase tracking-widest text-slate-700'
    lst.textContent = 'Legend'
    // An arrow on the right shows that the box opens and closes with a click: it points down when closed, up when open.
    const lchev = chevronIcon('h-3 w-3 shrink-0 text-slate-500 transition-transform group-open:rotate-180')
    lsum.title = 'Click to open or close the legend'
    lsum.append(lst, lchev)
    const lbody = document.createElement('div')
    lbody.className = 'mt-1 max-h-[min(32svh,17rem)] space-y-1.5 overflow-y-auto'
    this.legendList = document.createElement('div')
    this.legendList.className = 'space-y-[3px]'
    const lc = document.createElement('div')
    lc.style.display = 'none'
    lbody.append(this.legendList, lc)
    legend.append(lsum, lbody)
    root.appendChild(legend)
    glassify(legend, { tint: 0.8 })
    this.lcLegend = lc
    // Sources strip along the bottom edge: one line, the sources of the layers that are on. The map's own controls
    // and the floating buttons sit above it.
    const bar = document.createElement('div')
    bar.className = 'absolute inset-x-0 bottom-0 z-10 flex items-start gap-2 border-t border-slate-200/70 bg-white/85 px-2.5 py-[3px] text-[10px] leading-[14px] text-slate-600 backdrop-blur-sm'
    const bl = document.createElement('span')
    bl.className = 'shrink-0 text-[9px] font-bold uppercase tracking-widest text-slate-500'
    bl.textContent = 'Sources'
    const list = document.createElement('span')
    list.className = 'min-w-0 flex-1'
    bar.append(bl, list)
    map.getContainer().appendChild(bar)
    this.sourceBar = bar
    this.sourceList = list
    // The strip wraps to a second line on narrow screens, so the controls and buttons above it follow its height.
    this.barObserver = new ResizeObserver(() => {
      const h = bar.offsetHeight
      const c = map.getContainer()
      c.style.setProperty('--src-bar-h', `${h}px`)
      for (const q of ['.maplibregl-ctrl-bottom-right', '.maplibregl-ctrl-bottom-left']) {
        const n = c.querySelector<HTMLElement>(q)
        if (n) n.style.bottom = `${h}px`
      }
      toolbar.style.bottom = `${h + 8}px`
    })
    this.barObserver.observe(bar)
    this.renderSources(this.wanted())
    // Tile sources report their credit when they load, and a basemap switch changes it.
    let credTimer = 0
    this.onCredits = () => { window.clearTimeout(credTimer); credTimer = window.setTimeout(() => this.renderSources(this.wanted()), 400) }
    map.on('sourcedata', this.onCredits)
    this.renderLegend(this.wanted())
    loadLandcover(this.pack.base).then((m) => {
      this.lcMeta = m
      this.refreshLegend()
    })

    map.on('styledata', this.reapply)
    map.on('style.load', this.onStyleLoad)
    glassify(el, { tint: 0.78 })
    this.el = root
    return root
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

  /** Show the answers section (and fold the layers away), or hide it (and reopen the layers). */
  showResults(show: boolean) {
    if (!this.resultsWrap) return
    this.resultsWrap.style.display = show ? '' : 'none'
    if (show) {
      this.resultsWrap.open = true
      if (this.layersDetails) this.layersDetails.open = false
    } else if (this.layersDetails) this.layersDetails.open = true
  }

  /** Open or close the chat in the dock. */
  setChatOpen(open: boolean) {
    this.chatOpen = open
    if (open && this.selected) this.dockTab = 'ask'
    this.syncDock()
  }

  /** The dock shows the district profile and/or the chat; tabs appear only when both exist. */
  private syncDock() {
    const dock = this.dock
    if (!dock) return
    const hasD = !!this.selected
    const hasC = this.chatOpen
    dock.style.display = hasD || hasC ? '' : 'none'
    const tab: 'district' | 'ask' = !hasD ? 'ask' : !hasC ? 'district' : this.dockTab
    if (this.profileBox) this.profileBox.style.display = hasD && tab === 'district' ? '' : 'none'
    if (this.chatSlot) this.chatSlot.style.display = hasC && tab === 'ask' ? '' : 'none'
    if (this.dockTabs) this.dockTabs.style.display = hasD && hasC ? '' : 'none'
    const labels = { district: this.selected ?? 'District', ask: 'Ask the map' }
    for (const k of ['district', 'ask'] as const) {
      const b = this.dockBtns[k]
      if (!b) continue
      b.textContent = labels[k]
      b.className = `min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-xs font-semibold transition ${tab === k ? 'bg-accent-500 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50'}`
    }
  }

  /** Show the bottom toolbar only while it has something to show. */
  private syncToolbar() {
    const t = this.toolbar
    if (!t) return
    const any = [this.panel3D].some((n) => n && n.style.display !== 'none')
    t.style.display = any ? '' : 'none'
  }

  onRemove() {
    setSelectedDistrict(null)
    this.dock?.remove()
    this.toolbar?.remove()
    this.sourceBar?.remove()
    this.barObserver?.disconnect()
    this.map?.getContainer().style.removeProperty('--src-bar-h')
    if (this.onCredits) this.map?.off('sourcedata', this.onCredits)
    for (const c of ['.maplibregl-ctrl-bottom-right', '.maplibregl-ctrl-bottom-left']) {
      const n = this.map?.getContainer().querySelector<HTMLElement>(c)
      if (n) n.style.bottom = ''
    }
    this.map?.off('styledata', this.reapply)
    this.map?.off('style.load', this.onStyleLoad)
    if (this.on3D) this.leave3D()
    this.el?.remove()
    this.el = null
    this.map = null
  }

  /** The legend: one line per symbol of each layer that is on, grouped by layer. */
  private renderLegend(v: CityContextVisibility) {
    const box = this.legendList
    if (!box) return
    box.replaceChildren()
    let any = false
    for (const def of CONTEXT_LAYER_DEFS) {
      if (!v[def.key as CityContextLayerKey]) continue
      const symbols = CONTEXT_LEGEND[def.key as CityContextLayerKey]
      if (!symbols.length) continue
      any = true
      for (const s of symbols) {
        const row = document.createElement('div')
        row.className = 'flex items-center gap-1.5 text-[9px] font-medium text-slate-700'
        const sw = document.createElement('span')
        sw.className = 'flex h-2.5 w-4 shrink-0 items-center justify-center'
        const mark = document.createElement('span')
        if (s.shape === 'area') {
          mark.className = 'block h-2.5 w-3 rounded-[2px] opacity-85'
          mark.style.background = s.color
        } else if (s.shape === 'line') {
          mark.className = 'block h-[2px] w-4 rounded-full'
          mark.style.background = s.color
        } else if (s.shape === 'dash') {
          mark.className = 'block h-0 w-4 border-t-2 border-dashed'
          mark.style.borderColor = s.color
        } else if (s.shape === 'ring') {
          mark.className = 'block h-2 w-2 rounded-full border-[1.5px] bg-white'
          mark.style.borderColor = s.color
        } else if (s.shape === 'ramp') {
          mark.className = 'block h-2 w-4 rounded-[2px]'
          mark.style.background = s.color
        } else {
          mark.className = 'block h-2 w-2 rounded-full'
          mark.style.background = s.color
        }
        sw.appendChild(mark)
        const tx = document.createElement('span')
        tx.textContent = s.label
        row.append(sw, tx)
        box.appendChild(row)
      }
    }
    // nothing to explain: hide the box
    if (this.legendWrap) this.legendWrap.style.display = any || v.landcover ? '' : 'none'
  }

  /** The credits the map's own tile sources ask for (basemap, satellite, night lights, terrain), read from the sources of
   *  the layers that are drawn, as MapLibre's attribution control does. Falls back to the known basemap credit until the
   *  tile sources have loaded. */
  private mapCredits(): string[] {
    const map = this.map
    const out = new Set<string>()
    if (alive(map)) {
      for (const l of map.getStyle()?.layers ?? []) {
        const src = (l as { source?: string }).source
        if (!src || (l.layout as { visibility?: string } | undefined)?.visibility === 'none') continue
        const a = (map.getSource(src) as { attribution?: string } | undefined)?.attribution
        if (a) {
          // The credit is HTML (links, &copy;): keep the text only.
          out.add((new DOMParser().parseFromString(a, 'text/html').body.textContent ?? '').replace(/\s+/g, ' ').trim())
        }
      }
    }
    if (!out.size) out.add(maptilerKey() ? '© MapTiler © OpenStreetMap contributors' : '© Esri, HERE, Garmin, © OpenStreetMap contributors')
    return [...out]
  }

  /** The sources strip: the map's own credits, then who the data of each layer that is on comes from. */
  private renderSources(v: CityContextVisibility) {
    const list = this.sourceList
    if (!list) return
    const credits = this.mapCredits()
    const have = credits.join(' ').toLowerCase()
    const names = [...activeSources(v), ...(this.selected ? DISTRICT_PROFILE_SOURCES : [])]
      // a source already named in a map credit (e.g. © MapTiler, OpenStreetMap contributors) is not repeated
      .filter((n, i, all) => all.indexOf(n) === i && !have.includes(n.replace(/^© /, '').replace(/ \(.*\)$/, '').toLowerCase()))
    // The header's temperature and humidity (state and districts) come from Open-Meteo.
    const all = [...credits, 'MapLibre', ...names, 'Header weather: Open-Meteo.com (CC BY 4.0)']
    list.textContent = all.join('  ·  ')
    list.title = all.join(', ')
  }

  /** Land-cover colour key, shown while that layer is on. */
  refreshLegend() {
    const box = this.lcLegend
    if (!box) return
    const on = this.wanted().landcover && this.lcMeta != null
    box.style.display = on ? '' : 'none'
    box.className = 'border-t border-slate-200 pt-1.5'
    if (!on || box.childElementCount) return
    const t = document.createElement('p')
    t.className = 'mb-1 text-[8px] font-bold uppercase tracking-widest text-slate-500'
    t.textContent = 'Land cover (ESA, 2021)'
    box.appendChild(t)
    const grid = document.createElement('div')
    grid.className = 'grid grid-cols-1 gap-y-[3px]'
    for (const c of this.lcMeta!.classes) {
      const r = document.createElement('div')
      r.className = 'flex items-center gap-1.5 text-[9px] font-medium text-slate-700'
      const sw = document.createElement('span')
      sw.className = 'inline-block h-2.5 w-3 shrink-0 rounded-[2px]'
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

  get selectedName(): string | null {
    return this.selected
  }

  /** Called once the pack is loaded. */
  setPackData(data: PackData) {
    this.districts = [...data.districts.features].sort((a, b) =>
      String(a.properties?.name).localeCompare(String(b.properties?.name)))
    this.fillSelect()
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
  selectDistrict(name: string | null, fly = true, fromChat = false) {
    const map = this.map
    if (!alive(map)) return
    const f = name ? this.districts.find((d) => d.properties?.name === name) : undefined
    this.selected = f ? name : null
    setSelectedDistrict(this.selected)
    if (this.select) this.select.value = this.selected ?? ''
    // Picking a district shows its profile; the chat keeps its tab when it was the chat that moved the map.
    if (this.selected) this.dockTab = fromChat && this.chatOpen ? 'ask' : 'district'
    this.applySelection()
    this.renderProfile()
    this.renderSources(this.wanted())
    this.syncDock()
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
    if (!name) return
    const doc = this.profiles
    const p = doc?.districts[name]
    const el = (tag: string, cls: string, text?: string) => {
      const n = document.createElement(tag)
      n.className = cls
      if (text != null) n.textContent = text
      return n
    }
    const label = (t: string) => el('p', 'mb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500', t)

    const top = el('div', 'mb-2 flex items-center justify-between gap-2')
    const tt = el('div', 'min-w-0')
    tt.append(el('p', 'truncate text-base font-bold leading-tight text-slate-900', name))
    tt.firstElementChild?.setAttribute('title', `${name} district profile`)
    const back = el('button', 'focus-ring shrink-0 rounded-md border border-slate-300 px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50', 'Whole state')
    ;(back as HTMLButtonElement).type = 'button'
    back.addEventListener('click', () => this.selectDistrict(null))
    top.append(tt, back)
    box.appendChild(top)
    if (!p) {
      box.appendChild(el('p', 'text-slate-500', doc ? 'No profile for this district.' : 'Loading…'))
      return
    }
    const num = (v: number | null | undefined, unit = '') => (v == null ? NA : `${nf.format(v)}${unit}`)

    // Tabs: Overview | Nature | Sources
    const tabs = el('div', 'mb-2 flex gap-0.5 rounded-md bg-slate-100 p-0.5')
    const panes = { overview: el('div', ''), nature: el('div', 'space-y-2.5'), sources: el('div', '') }
    const tabButtons: Partial<Record<'overview' | 'nature' | 'sources', HTMLButtonElement>> = {}
    const paint = () => {
      for (const k of ['overview', 'nature', 'sources'] as const) {
        tabButtons[k]!.className = `flex-1 rounded px-2 py-1 text-[11px] font-semibold transition ${this.tab === k ? 'bg-accent-500 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50'}`
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
    const grid = el('div', 'grid grid-cols-2 gap-1')
    const tile = (k: string, v: string, sub?: string) => {
      const t = el('div', 'rounded-md bg-slate-50 px-2 py-1')
      t.append(el('p', 'text-[10px] font-medium uppercase tracking-wide text-slate-500', k),
        el('p', `text-[15px] font-bold tabular-nums leading-tight ${v === NA ? 'text-slate-300' : 'text-slate-900'}`, v))
      if (sub) t.appendChild(el('p', 'text-[10px] leading-tight text-slate-500', sub))
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
      const b = el('div', 'flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100')
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
        const r = el('span', 'flex items-center gap-1 text-[10px] text-slate-600')
        const sw = el('span', 'inline-block h-2 w-2 rounded-sm')
        sw.style.background = q.color
        r.append(sw, document.createTextNode(`${q.label} ${nf1.format(q.pct)}%`))
        lg.appendChild(r)
      }
      wrap.append(b, lg)
      return wrap
    }

    // Forest, by density (share of district area)
    const fsec = el('div', '')
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
    } else fsec.appendChild(el('p', 'text-slate-300', NA))
    panes.nature.appendChild(fsec)

    // Land cover (satellite)
    const lsec = el('div', '')
    lsec.appendChild(label('Land cover (ESA, 2021)'))
    const lc = p.landcover_pct
    if (lc) {
      lsec.appendChild(bar(Object.entries(lc).map(([k, v]) => ({ label: k, pct: v, color: LC_COLORS[k] ?? '#999' }))))
    } else lsec.appendChild(el('p', 'text-slate-300', NA))
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
      const lg = el('div', 'flex justify-between text-[10px] text-slate-600')
      lg.append(el('span', '', '0 m'), el('span', 'font-semibold text-sky-700', `typical ${nf.format(p.elevation_median_m)} m`),
        el('span', 'font-semibold text-orange-800', `highest ${nf.format(p.elevation_max_m)} m`), el('span', '', '1,400 m'))
      rsec.appendChild(lg)
    } else rsec.appendChild(el('p', 'text-slate-300', NA))
    panes.nature.appendChild(rsec)

    // Rain and wind (ERA5)
    const c = p.climate
    const csec = el('div', '')
    csec.appendChild(label('Rain and wind (ERA5, 2015–2024)'))
    if (c) {
      const stats = el('div', 'grid grid-cols-2 gap-1')
      const stat = (k: string, v: string) => {
        const t = el('div', 'rounded-md bg-slate-50 px-2 py-1')
        t.append(el('p', 'text-[10px] text-slate-500', k), el('p', 'text-[15px] font-bold leading-tight text-slate-900', v))
        stats.appendChild(t)
      }
      stat('Rain per year', `${nf.format(c.rain_annual_mm)} mm`)
      stat('Falls in the monsoon', c.rain_monsoon_pct == null ? NA : `${nf1.format(c.rain_monsoon_pct)}%`)
      csec.appendChild(stats)
      // monthly rain bars
      const months = 'JFMAMJJASOND'
      const maxm = Math.max(...c.rain_monthly_mm, 1)
      const bars = el('div', 'mt-1.5 flex h-10 items-end gap-1')
      c.rain_monthly_mm.forEach((v, i) => {
        const col = el('div', 'flex h-full flex-1 flex-col items-center justify-end')
        const bar = el('div', 'w-full rounded-sm bg-sky-400')
        bar.style.height = `${Math.max(2, (v / maxm) * 100)}%`
        bar.title = `${months[i]}: ${nf.format(Math.round(v))} mm`
        col.append(bar, el('span', 'mt-0.5 text-[9px] text-slate-400', months[i]))
        bars.appendChild(col)
      })
      csec.appendChild(bars)
      csec.appendChild(el('p', 'text-[10px] text-slate-400', 'Average rain by month'))
      // wind rose (winter), 8 sectors, bar length = share of hours
      const rose = c.rose_winter_pct
      const mx = Math.max(...rose, 1)
      const NS = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(NS, 'svg')
      svg.setAttribute('viewBox', '-60 -60 120 120')
      svg.setAttribute('class', 'h-20 w-20 shrink-0')
      const ring = document.createElementNS(NS, 'circle')
      ring.setAttribute('r', '46')
      ring.setAttribute('fill', 'none')
      ring.setAttribute('stroke', '#E2E8F0')
      svg.appendChild(ring)
      const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
      rose.forEach((v, i) => {
        const a0 = ((i * 45 - 18) * Math.PI) / 180
        const a1 = ((i * 45 + 18) * Math.PI) / 180
        const r = 6 + (v / mx) * 40
        const pt = (a: number, rr: number) => `${(rr * Math.sin(a)).toFixed(1)},${(-rr * Math.cos(a)).toFixed(1)}`
        const path = document.createElementNS(NS, 'path')
        path.setAttribute('d', `M0,0 L${pt(a0, r)} L${pt(a1, r)} Z`)
        path.setAttribute('fill', '#0F6CBD')
        path.setAttribute('fill-opacity', '0.85')
        const t = document.createElementNS(NS, 'title')
        t.textContent = `Wind from ${dirs[i]}: ${v}% of winter hours`
        path.appendChild(t)
        svg.appendChild(path)
        const lab = document.createElementNS(NS, 'text')
        const la = (i * 45 * Math.PI) / 180
        lab.setAttribute('x', (54 * Math.sin(la)).toFixed(1))
        lab.setAttribute('y', (-54 * Math.cos(la) + 2.5).toFixed(1))
        lab.setAttribute('text-anchor', 'middle')
        lab.setAttribute('font-size', '7')
        lab.setAttribute('fill', '#64748B')
        lab.textContent = dirs[i]
        svg.appendChild(lab)
      })
      const roseBox = el('div', 'mt-1.5 flex items-center gap-2 rounded-md bg-slate-50 p-1.5')
      roseBox.appendChild(svg as unknown as HTMLElement)
      const rt = el('div', 'min-w-0 text-slate-600')
      rt.append(
        el('p', 'font-semibold text-slate-900', `Winter wind mostly from the ${c.wind_from.winter ?? '—'}`),
        el('p', 'text-[11px]', `Average ${c.wind_mean_ms.winter == null ? NA : nf1.format(c.wind_mean_ms.winter)} m/s, December to February. Bars: how often the wind blows from each direction.`),
      )
      roseBox.appendChild(rt)
      csec.appendChild(roseBox)
      csec.appendChild(el('p', 'mt-1 text-[10px] leading-snug text-slate-400', 'ERA5 is a weather-model reanalysis on a grid of about 30 km: the climate of the area, not a measurement in one town.'))
    } else csec.appendChild(el('p', 'text-slate-300', NA))
    panes.nature.appendChild(csec)

    // Ground water (CGWB 2020)
    const gw = p.groundwater
    const gsec = el('div', '')
    gsec.appendChild(label('Ground water (CGWB 2020)'))
    if (gw && gw.stage_pct != null) {
      const stats = el('div', 'grid grid-cols-2 gap-1')
      const stat = (k: string, v: string) => {
        const t = el('div', 'rounded-md bg-slate-50 px-2 py-1')
        t.append(el('p', 'text-[10px] text-slate-500', k), el('p', 'text-[15px] font-bold leading-tight text-slate-900', v))
        stats.appendChild(t)
      }
      stat('Drawn each year', `${nf1.format(gw.stage_pct)}%`)
      const total = Object.values(gw.blocks).reduce((a, b) => a + b, 0)
      stat('Blocks rated safe', total ? `${gw.blocks.Safe ?? 0} of ${total}` : NA)
      gsec.appendChild(stats)
      gsec.appendChild(el('p', 'mt-1 text-[10px] leading-snug text-slate-500',
        'Share of the yearly replenishable ground water that is drawn. Under 70% is rated safe; over 100% is over-exploited. Turn on "Ground water by block" to see each block.'))
    } else gsec.appendChild(el('p', 'text-slate-300', NA))
    panes.nature.appendChild(gsec)

    // In the district
    const rows = el('div', 'mt-1 divide-y divide-slate-100 rounded-md bg-slate-50')
    const row = (k: string, v: string, sub?: string) => {
      const r = el('div', 'px-2 py-1')
      const line = el('div', 'flex items-baseline justify-between gap-2')
      line.append(el('span', 'text-[12px] text-slate-600', k), el('span', `text-right text-[12px] font-semibold tabular-nums ${v === NA ? 'text-slate-300' : 'text-slate-900'}`, v))
      r.appendChild(line)
      if (sub) r.appendChild(el('p', 'mt-0.5 text-right text-[10px] leading-snug text-slate-500', sub))
      rows.appendChild(r)
    }
    const sites = [...p.power_plants, ...p.large_works]
    row('Power plants and works', sites.length ? String(sites.length) : 'None checked', sites.map((x) => x.name).join(' · ') || undefined)
    row('Public air monitors', p.monitors_continuous_in_feed == null ? NA : `${p.monitors_continuous_in_feed} continuous · ${p.monitors_manual_namp ?? NA} manual`,
      p.monitors_planned_jspcb ? `${p.monitors_planned_jspcb} continuous planned (JSPCB tender, Dec 2025)` : undefined)
    panes.overview.appendChild(rows)


    // Sources, folded away
    const src = doc?.sources ?? {}
    const det = el('div', '')
    det.appendChild(label('Where each figure comes from'))
    const ul = el('ul', 'space-y-2 text-[11px] leading-snug text-slate-500')
    for (const [k, lab] of [['area_km2', 'Area'], ['population_2011', 'Population'], ['forest', 'Forest'], ['elevation', 'Elevation'],
      ['landcover', 'Land cover'], ['power_plants', 'Plants and works'],
      ['monitors', 'Monitors'], ['climate', 'Rain and wind'], ['groundwater', 'Ground water'], ['outline', 'Outline']] as const) {
      if (src[k]) {
        const li = el('li', '')
        li.append(el('span', 'font-semibold text-slate-600', `${lab}: `), document.createTextNode(src[k]))
        ul.appendChild(li)
      }
    }
    if (p.area_note) {
      const li = el('li', '')
      li.append(el('span', 'font-semibold text-slate-600', 'Area: '), document.createTextNode(p.area_note))
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
      ? { top: 40, bottom: 110, left: 360, right: 360 } // left: layers card; right: docked profile panel + map buttons
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
  }

  /** Re-apply the district selection after our
   *  layers are re-created (style reloads). */
  private reapply = () => {
    const map = this.map
    if (!alive(map)) return
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
    // The district view shows satellite imagery and relief: switch them on in the layer card too, so the card tells
    // the truth, and remember what to put back on leaving.
    const w = this.wanted()
    const applied = normalizeBaseImages({ relief: true, satellite: this.satellite }, w)
    const before: Partial<CityContextVisibility> = {}
    for (const k of Object.keys(applied) as CityContextLayerKey[]) before[k] = w[k]
    this.from3D = { applied, before }
    this.onChange(applied)
    this.apply3D()
    if (this.panel3D) this.panel3D.style.display = ''
    this.syncToolbar()
  }

  private apply3D() {
    const map = this.map
    if (!alive(map)) return
    applyOnDemand(map, { ...this.wanted(), relief: true })
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
    // Put back the layers entering 3D switched, unless the viewer has since changed them.
    const f = this.from3D
    this.from3D = null
    if (f) {
      const now = this.wanted()
      const back: Partial<CityContextVisibility> = {}
      for (const k of Object.keys(f.applied) as CityContextLayerKey[]) if (now[k] === f.applied[k] && f.before[k] !== f.applied[k]) back[k] = f.before[k]
      if (Object.keys(back).length) this.onChange(back)
    }
    const prev = this.prevTerrain
    const done = () => {
      try {
        map.setTerrain(prev && map.getSource(prev.source) ? prev : null)
        if (this.prevSky) map.setSky(this.prevSky)
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
  /** Add the layers card, the district picker (3D view and profile) and the legend. */
  showViewControl?: boolean
}) {
  const [local, setLocal] = useState<CityContextVisibility>(visibleProp)
  const visible = onVisibleChange ? visibleProp : local
  const change = (raw: Partial<CityContextVisibility>) => {
    // Satellite, land cover and night lights cover each other: switching one on switches the others off.
    const patch = normalizeBaseImages(raw, visibleRef.current)
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
        applyOnDemand(map, visibleRef.current)
        controlRef.current?.afterLayersAdded()
      } catch {
        try { removeAll(map) } catch { /* partial add: start clean next time */ }
        map.once('idle', ensure)
      }
    }
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '260px', className: 'ctx-popup', focusAfterOpen: false })
    const clickable = () =>
      CLICKABLE.filter((id) => map.getLayer(id) && (id !== 'ctx-districts-fill' || map.getZoom() < DISTRICT_CLICK_MAX_ZOOM))
    const showElevation = (e: maplibregl.MapMouseEvent, extra?: HTMLElement) => {
      const el = extra ?? document.createElement('div')
      if (!extra) el.className = 'min-w-[150px] py-2 pl-3 pr-8 text-xs text-slate-700'
      const row = document.createElement('div')
      row.className = `${extra ? 'mt-2 border-t border-slate-200/80 pt-2' : ''} flex items-baseline justify-between gap-4`
      const lab = document.createElement('span')
      lab.className = 'text-[11px] text-slate-500'
      lab.textContent = 'Ground elevation'
      const val = document.createElement('span')
      val.className = 'text-base font-semibold tabular-nums leading-none text-slate-900'
      val.textContent = '…'
      row.append(lab, val)
      el.appendChild(row)
      if (!extra) {
        const src = document.createElement('p')
        src.className = 'mt-1 text-[10px] leading-none text-slate-400'
        src.textContent = 'MapTiler terrain, about 30 m grid'
        el.appendChild(src)
      }
      popup.setLngLat(e.lngLat).setDOMContent(el).addTo(map)
      elevationAt(e.lngLat.lng, e.lngLat.lat).then((h) => {
        val.textContent = h == null ? 'Not available' : `${h.toLocaleString('en-IN')} m`
      })
    }
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const layers = clickable()
      const hits = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : []
      const in3D = controlRef.current?.is3D === true
      // queryRenderedFeatures returns topmost first. The district shading is drawn above the thematic areas and lines
      // (blocks, ground water, aquifers, protected areas, rivers), so it would swallow their clicks: it only wins when
      // nothing else is under the pointer.
      const f = hits.find((h) => h.layer.id !== 'ctx-districts-fill') ?? hits[0]
      if (!f || (in3D && f.layer.id === 'ctx-districts-fill')) {
        if (in3D) showElevation(e)
        return
      }
      if (f.layer.id === 'ctx-districts-fill' && controlRef.current) {
        controlRef.current.selectDistrict(String(f.properties?.name))
        return
      }
      const node = popupNode(f.properties ?? {}, f.layer.id, districtAt(data?.districts, e.lngLat.lng, e.lngLat.lat), basinAt(data?.basins, e.lngLat.lng, e.lngLat.lat))
      if (f.layer.id === 'ctx-places-village') attachVillageDetails(node, pack.base)
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
    // Per-layer loading state, shown next to each checkbox.
    const onSourceData = (e: maplibregl.MapSourceDataEvent) => {
      if (e.sourceId && SRC_KEYS[e.sourceId] && e.sourceDataType !== 'metadata' && map.isSourceLoaded(e.sourceId)) {
        controlRef.current?.setSourceState(e.sourceId, 'ok')
      }
    }
    const onMapError = (e: { sourceId?: string; error?: Error }) => {
      if (e.sourceId && SRC_KEYS[e.sourceId]) {
        console.warn('[CityContextLayers] could not load', e.sourceId, e.error?.message)
        controlRef.current?.setSourceState(e.sourceId, 'failed')
      }
    }
    map.on('sourcedata', onSourceData)
    map.on('error', onMapError)
    map.on('style.load', ensure)
    map.on('styledata', ensure)
    map.on('click', onClick)
    map.on('mousemove', onMove)
    return () => {
      cancelled = true
      map.off('style.load', ensure)
      map.off('styledata', ensure)
      map.off('sourcedata', onSourceData)
      map.off('error', onMapError)
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
    setChatSlot(ctrl.chatSlot)
    setResultsSlot(ctrl.resultsSlot)
    if (map.getSource(SRC.sources)) ctrl.afterLayersAdded()
    loadPack(pack.base)
      .then((d) => ctrl.setPackData(d))
      .catch(() => {})
    return () => {
      controlRef.current = null
      setChatSlot(null)
      setResultsSlot(null)
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
      applyOnDemand(map, visible)
      // Basemap features are hidden only while ours of the same kind are shown.
      syncBasemap(map, visible)
    }
    controlRef.current?.refreshLegend()
    controlRef.current?.setVisible(visible)
  }, [map, pack, visible])

  // The "Ask the map" assistant (React, portalled into the map container). Actions run through the same
  // controls the viewer uses: the layer switches and the district picker.
  const [chatOpen, setChatOpen] = useState(false)
  const [chatSlot, setChatSlot] = useState<HTMLElement | null>(null)
  const [resultsSlot, setResultsSlot] = useState<HTMLElement | null>(null)
  useEffect(() => { controlRef.current?.setChatOpen(chatOpen) }, [chatOpen])
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
      slot={chatSlot}
      resultsSlot={resultsSlot}
      open={chatOpen}
      onOpenChange={setChatOpen}
      layers={CONTEXT_LAYER_DEFS.map((d) => ({ key: d.key, label: d.label, note: d.note }))}
      profiles={factsDoc}
      handlers={{
        setLayers: (patch) => changeRef.current(patch as Partial<CityContextVisibility>),
        goDistrict: (name) => controlRef.current?.selectDistrict(name, true, true),
        goPlace: (lng, lat, _name, zoom = 11.5) => {
          controlRef.current?.selectDistrict(null, false)
          map.flyTo({ center: [lng, lat], zoom, pitch: 0, bearing: 0, duration: 1400 })
        },
        getState: () => ({
          layers_on: Object.entries(visibleRef.current).filter(([, on]) => on).map(([k]) => k),
          district: controlRef.current?.selectedName ?? null,
          zoom: map.getZoom(),
          view3d: controlRef.current?.is3D === true,
        }),
        onResults: (has) => controlRef.current?.showResults(has),
        zoom: (direction) => (direction === 'in' ? map.zoomIn({ duration: 600 }) : map.zoomOut({ duration: 600 })),
      }}
    />
  )
}
