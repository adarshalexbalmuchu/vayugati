import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import type { Feature, FeatureCollection, Geometry, Polygon, Position } from 'geojson'
import { maptilerKey } from '../../lib/basemaps'
import { elevationAt } from '../../lib/elevation'

/**
 * Static context layers for a city pack. For Dhanbad–Jharia the pack covers
 * the whole state: Jharkhand's outline, its 24 districts, mining and quarry
 * areas, industrial land,
 * checked power plants and large works, main roads, satellite heat
 * detections, and the West Bengal reference stations.
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

export type CityContextLayerKey = 'districts' | 'mines' | 'industry' | 'roads' | 'fires'
export type CityContextVisibility = Record<CityContextLayerKey, boolean>

export const ALL_CONTEXT_VISIBLE: CityContextVisibility = {
  districts: true,
  mines: true,
  industry: true,
  roads: true,
  fires: true,
}

interface ContextPack {
  base: string
  /** Label of the wider view, for the zoom control. */
  regionLabel: string
  /** [W, S, E, N] of the wider view (the state outline's extent). */
  regionBounds: [number, number, number, number]
}

/** City codes with a context pack, and where its files are served from. */
export const CONTEXT_PACKS: Record<string, ContextPack> = {
  dhanbad: { base: '/city-packs/jharkhand', regionLabel: 'Jharkhand', regionBounds: [83.33, 21.97, 87.98, 25.34] },
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
} as const

type PackData = Record<keyof typeof FILES, FeatureCollection>

const cache = new Map<string, Promise<PackData>>()

function loadPack(base: string): Promise<PackData> {
  let p = cache.get(base)
  if (!p) {
    p = Promise.all(
      Object.entries(FILES).map(async ([k, file]) => {
        const res = await fetch(`${base}/${file}`)
        if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
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
} as const

/** Layer ids per toggle. The state outline goes with the districts toggle. */
const LAYERS: Record<CityContextLayerKey, string[]> = {
  districts: ['ctx-districts-fill', 'ctx-districts-line', 'ctx-state-line'],
  roads: ['ctx-roads-line'],
  industry: ['ctx-industry-fill', 'ctx-plants'],
  mines: ['ctx-mines-fill', 'ctx-mines-line'],
  fires: ['ctx-fires'],
}

/** Topmost first: a click shows the popup of the highest feature under it. */
const CLICKABLE = ['ctx-plants', 'ctx-fires', 'ctx-mines-fill', 'ctx-industry-fill', 'ctx-districts-fill']

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

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] }

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
}

function addAll(map: maplibregl.Map, data: PackData, visible: CityContextVisibility) {
  if (map.getSource(SRC.sources)) return
  for (const [k, id] of Object.entries(SRC)) {
    map.addSource(id, { type: 'geojson', data: data[k as keyof PackData] })
  }
  const vis = (key: CityContextLayerKey) => (visible[key] ? 'visible' : 'none') as 'visible' | 'none'
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

function removeAll(map: maplibregl.Map) {
  for (const id of [DISTRICT_SELECTED, MASK_STATE, MASK_DISTRICT]) if (map.getLayer(id)) map.removeLayer(id)
  for (const ids of Object.values(LAYERS)) for (const id of ids) if (map.getLayer(id)) map.removeLayer(id)
  for (const id of [...Object.values(SRC), MASK_STATE, MASK_DISTRICT]) if (map.getSource(id)) map.removeSource(id)
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
    line('Outline: geoBoundaries (approximate, not Survey of India).')
  } else if (layerId === 'ctx-fires') {
    line('Satellite heat detection (NASA FIRMS, VIIRS)', true)
    line(`${props.date ?? ''} · ${props.daynight === 'N' ? 'night' : 'day'} · fire radiative power ${props.frp ?? '—'} MW`)
    line('A 375 m pixel that was unusually hot when the satellite passed. It can be a coal fire at the surface, industrial heat, or crop or forest burning. It is not a measured fire area.')
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

/** district_profiles.json, built by ingest/scripts/jharkhand/district_profiles.py. */
interface DistrictProfile {
  area_km2: number | null
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
    private cityLabel: string,
    private cityCenter: [number, number],
    private cityZoom: number,
  ) {}

  private button(label: string, onClick: () => void, parent: HTMLElement) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.className = 'rounded-md border border-slate-200 px-2 py-1 font-medium hover:bg-slate-100'
    b.addEventListener('click', onClick)
    parent.appendChild(b)
    return b
  }

  onAdd(map: maplibregl.Map) {
    this.map = map
    const el = document.createElement('div')
    el.className = 'maplibregl-ctrl w-[280px] rounded-lg border border-slate-200/80 bg-white/95 p-1.5 text-xs text-slate-700 shadow-sm backdrop-blur-sm'
    const row = document.createElement('div')
    row.className = 'flex items-center gap-1'
    this.button(this.pack.regionLabel, () => this.selectDistrict(null), row)
    this.button(this.cityLabel, () => {
      this.selectDistrict(null, false)
      map.flyTo({ center: this.cityCenter, zoom: this.cityZoom, pitch: 0, bearing: 0, duration: 900 })
    }, row)
    el.appendChild(row)

    const pick = document.createElement('label')
    pick.className = 'mt-1.5 flex items-center gap-1.5'
    const pickText = document.createElement('span')
    pickText.className = 'font-semibold'
    pickText.textContent = 'District in 3D'
    const select = document.createElement('select')
    select.className = 'min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs'
    select.addEventListener('change', () => this.selectDistrict(select.value || null))
    pick.append(pickText, select)
    el.appendChild(pick)
    this.select = select
    this.fillSelect()

    const profile = document.createElement('div')
    profile.className = 'mt-1.5 max-h-[46vh] overflow-y-auto border-t border-slate-200 pt-1.5'
    profile.style.display = 'none'
    el.appendChild(profile)
    this.profileBox = profile
    loadProfiles(this.pack.base).then((d) => {
      this.profiles = d
      this.renderProfile()
    })

    const panel = document.createElement('div')
    panel.className = 'mt-1.5 space-y-1 border-t border-slate-200 pt-1.5'
    panel.style.display = 'none'
    const hRow = document.createElement('label')
    hRow.className = 'flex items-center gap-1.5'
    const hText = document.createElement('span')
    hText.className = 'w-[78px] shrink-0 font-semibold'
    hText.textContent = `Heights ×${this.exaggeration}`
    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = '1'
    slider.max = '6'
    slider.step = '0.5'
    slider.value = String(this.exaggeration)
    slider.className = 'min-w-0 flex-1 accent-sky-600'
    slider.setAttribute('aria-label', 'Height exaggeration')
    slider.addEventListener('input', () => {
      this.exaggeration = Number(slider.value)
      hText.textContent = `Heights ×${this.exaggeration}`
      const t = map.getTerrain()
      if (this.on3D && t) map.setTerrain({ ...t, exaggeration: this.exaggeration })
    })
    hRow.append(hText, slider)
    panel.appendChild(hRow)
    const satRow = document.createElement('label')
    satRow.className = 'flex items-center gap-1.5'
    const sat = document.createElement('input')
    sat.type = 'checkbox'
    sat.checked = this.satellite
    sat.className = 'accent-sky-600'
    sat.addEventListener('change', () => {
      this.satellite = sat.checked
      if (map.getLayer(SAT_LAYER)) map.setLayoutProperty(SAT_LAYER, 'visibility', this.satellite ? 'visible' : 'none')
      if (map.getLayer(HILLSHADE_LAYER)) map.setPaintProperty(HILLSHADE_LAYER, 'hillshade-exaggeration', this.satellite ? 0.4 : 0.85)
      if (map.getLayer(CONTOUR_LINE)) map.setPaintProperty(CONTOUR_LINE, 'line-color', this.satellite ? '#FFF4DC' : '#6B4F2E')
    })
    const satText = document.createElement('span')
    satText.textContent = 'Satellite imagery (off: shaded relief only)'
    satRow.append(sat, satText)
    panel.appendChild(satRow)
    const note = document.createElement('p')
    note.className = 'text-[10px] leading-snug text-slate-500'
    note.textContent = 'Contour lines every 10 to 100 m, with heights. Click the ground for its elevation. Drag with the right mouse button (or Ctrl + drag) to tilt and turn; the compass resets north.'
    panel.appendChild(note)
    el.appendChild(panel)
    this.panel3D = panel

    const fireRow = document.createElement('div')
    fireRow.className = 'mt-1.5 flex items-center gap-1 border-t border-slate-200 pt-1.5'
    fireRow.style.display = 'none'
    const title = document.createElement('span')
    title.className = 'font-semibold'
    title.textContent = 'Heat detections'
    fireRow.appendChild(title)
    this.playBtn = this.button('▶', () => this.togglePlay(), fireRow)
    this.playBtn.setAttribute('aria-label', 'Play heat detections day by day')
    this.button('All', () => { this.stopPlay(); this.setFireDay(null) }, fireRow)
    const label = document.createElement('span')
    label.className = 'ml-auto tabular-nums text-slate-600'
    fireRow.appendChild(label)
    this.fireLabel = label
    el.appendChild(fireRow)
    this.fireRow = fireRow

    map.on('styledata', this.reapply)
    map.on('style.load', this.onStyleLoad)
    this.el = el
    return el
  }

  onRemove() {
    this.stopPlay()
    this.map?.off('styledata', this.reapply)
    this.map?.off('style.load', this.onStyleLoad)
    if (this.on3D) this.leave3D()
    this.el?.remove()
    this.el = null
    this.map = null
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
      const [w, s, e, n] = bboxOf(f.geometry)
      map.fitBounds([[w, s], [e, n]], { padding: 30, pitch: 65, bearing: -25, maxZoom: 11.5, duration: 1600 })
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
    if (!name) {
      box.style.display = 'none'
      box.replaceChildren()
      return
    }
    box.style.display = ''
    box.replaceChildren()
    const doc = this.profiles
    const p = doc?.districts[name]
    const src = doc?.sources ?? {}
    const h = document.createElement('p')
    h.className = 'mb-1 text-[13px] font-semibold text-slate-900'
    h.textContent = `${name} district`
    box.appendChild(h)
    if (!p) {
      const m = document.createElement('p')
      m.className = 'text-slate-500'
      m.textContent = doc ? 'No profile for this district.' : 'Loading…'
      box.appendChild(m)
      return
    }
    const dl = document.createElement('dl')
    dl.className = 'space-y-1.5'
    const row = (label: string, value: string, source?: string, detail?: string) => {
      const wrap = document.createElement('div')
      const top = document.createElement('div')
      top.className = 'flex items-baseline justify-between gap-2'
      const dt = document.createElement('dt')
      dt.className = 'text-slate-500'
      dt.textContent = label
      const dd = document.createElement('dd')
      dd.className = `text-right font-semibold tabular-nums ${value === NA ? 'text-slate-400' : 'text-slate-900'}`
      dd.textContent = value
      top.append(dt, dd)
      wrap.appendChild(top)
      if (detail) {
        const d = document.createElement('p')
        d.className = 'text-right text-[10px] text-slate-600'
        d.textContent = detail
        wrap.appendChild(d)
      }
      if (source) {
        const sp = document.createElement('p')
        sp.className = 'text-[9.5px] leading-snug text-slate-400'
        sp.textContent = source
        wrap.appendChild(sp)
      }
      dl.appendChild(wrap)
    }
    const num = (v: number | null, unit = '') => (v == null ? NA : `${nf.format(v)}${unit}`)
    const dates = doc?.heat_detection_dates ?? []
    const span = dates.length ? `${fmtDay(dates[0])}–${fmtDay(dates[dates.length - 1])} ${dates[0].slice(0, 4)}` : ''
    row('Area', num(p.area_km2, ' km²'), 'Survey of India, in FSI ISFR 2023')
    row('Population (2011)', num(p.population_2011), 'Census of India 2011, Table A-02')
    row(
      'Forest cover',
      p.forest_km2 == null ? NA : `${nf1.format(p.forest_km2)} km² (${p.forest_pct}%)`,
      'Forest Survey of India, ISFR 2023',
      p.forest_km2 == null ? undefined
        : `very dense ${nf1.format(p.forest_very_dense_km2 ?? 0)} · moderately dense ${nf1.format(p.forest_moderately_dense_km2 ?? 0)} · open ${nf1.format(p.forest_open_km2 ?? 0)} km²`,
    )
    row('Highest point', num(p.elevation_max_m, ' m'), 'Copernicus DEM (ESA), 90 m grid; computed by Vayu Gati')
    row('Typical ground height', num(p.elevation_median_m, ' m'), 'Median of the same elevation grid over the district')
    row(`Heat detections${span ? ` (${span})` : ''}`, num(p.heat_detections), 'NASA FIRMS (VIIRS satellites)')
    const sites = [...p.power_plants, ...p.large_works]
    row(
      'Power plants and large works',
      sites.length ? String(sites.length) : 'None checked',
      'Names and operators checked by Vayu Gati, Nov 2026',
      sites.length ? sites.map((x) => x.name).join(' · ') : undefined,
    )
    row(
      'Public air monitors',
      p.monitors_continuous_in_feed == null ? NA
        : `${p.monitors_continuous_in_feed} continuous · ${p.monitors_manual_namp ?? NA} manual`,
      'CPCB feed (5 Nov 2026) and NAMP list (19 Nov 2024)',
      p.monitors_planned_jspcb ? `${p.monitors_planned_jspcb} continuous planned (JSPCB tender, Dec 2025)` : undefined,
    )
    row('Mining area', p.mining_area_km2 == null ? NA : num(p.mining_area_km2, ' km²'), src.mining_area_km2 ?? 'No official district figure found')
    box.appendChild(dl)
    const foot = document.createElement('p')
    foot.className = 'mt-1.5 text-[9.5px] leading-snug text-slate-400'
    foot.textContent = 'NA: no verified government figure. District outline: geoBoundaries (approximate, not Survey of India).'
    box.appendChild(foot)
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
  }

  private apply3D() {
    const map = this.map
    if (!alive(map) || !map.isStyleLoaded()) return
    const below = map.getLayer('ctx-districts-fill') ? 'ctx-districts-fill' : undefined
    const key = maptilerKey()
    if (key && !map.getSource(SAT_SOURCE)) {
      map.addSource(SAT_SOURCE, { type: 'raster', url: `https://api.maptiler.com/tiles/satellite-v2/tiles.json?key=${key}`, tileSize: 512 })
    }
    if (key && !map.getLayer(SAT_LAYER)) {
      map.addLayer({
        id: SAT_LAYER,
        type: 'raster',
        source: SAT_SOURCE,
        layout: { visibility: this.satellite ? 'visible' : 'none' },
        paint: { 'raster-saturation': -0.1, 'raster-contrast': 0.08 },
      }, below)
    }
    if (!map.getSource(HILLSHADE_SOURCE)) map.addSource(HILLSHADE_SOURCE, demSourceSpec())
    if (!map.getLayer(HILLSHADE_LAYER)) {
      map.addLayer(
        {
          id: HILLSHADE_LAYER,
          type: 'hillshade',
          source: HILLSHADE_SOURCE,
          paint: {
            'hillshade-exaggeration': key && this.satellite ? 0.4 : 0.85,
            'hillshade-illumination-direction': 315,
            'hillshade-shadow-color': '#2B2218',
            'hillshade-highlight-color': '#FFFFFF',
            'hillshade-accent-color': '#5C4B3A',
          },
        },
        below,
      )
    }
    if (key && !map.getSource(CONTOUR_SOURCE)) {
      map.addSource(CONTOUR_SOURCE, { type: 'vector', url: `https://api.maptiler.com/tiles/contours-v2/tiles.json?key=${key}` })
    }
    if (key && !map.getLayer(CONTOUR_LINE)) {
      // nth_line marks index lines (every 2nd, 5th or 10th); thin lines fade in as you zoom.
      const nth = ['coalesce', ['get', 'nth_line'], 1]
      map.addLayer({
        id: CONTOUR_LINE,
        type: 'line',
        source: CONTOUR_SOURCE,
        'source-layer': 'contour',
        paint: {
          'line-color': this.satellite ? '#FFF4DC' : '#6B4F2E',
          'line-opacity': ['interpolate', ['linear'], ['zoom'],
            9, ['match', nth, 10, 0.85, 5, 0.6, 0],
            11, ['match', nth, 10, 0.9, 5, 0.75, 0.35],
            13, ['match', nth, 10, 0.9, 5, 0.8, 0.55]] as unknown as maplibregl.ExpressionSpecification,
          'line-width': ['match', nth, 10, 1.3, 5, 0.9, 0.5] as unknown as maplibregl.ExpressionSpecification,
        },
      }, below)
    }
    const font = this.labelFont()
    if (key && font && !map.getLayer(CONTOUR_LABEL)) {
      map.addLayer({
        id: CONTOUR_LABEL,
        type: 'symbol',
        source: CONTOUR_SOURCE,
        'source-layer': 'contour',
        filter: ['in', ['get', 'nth_line'], ['literal', [5, 10]]],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['concat', ['to-string', ['get', 'height']], ' m'],
          'text-font': font,
          'text-size': 10,
          'symbol-spacing': 350,
        },
        paint: { 'text-color': '#3A2A1A', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.4 },
      })
    }
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

  /** A font the current style's glyph server has (taken from one of its own
   *  label layers); null if the style has no glyphs, then no contour labels. */
  private labelFont(): string[] | null {
    const style = this.map?.getStyle()
    if (!style?.glyphs) return null
    for (const l of style.layers ?? []) {
      const f = (l as { layout?: Record<string, unknown> }).layout?.['text-font']
      if (Array.isArray(f) && f.every((x) => typeof x === 'string')) return f as string[]
    }
    return null
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
        for (const id of [CONTOUR_LABEL, CONTOUR_LINE, SAT_LAYER, HILLSHADE_LAYER]) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of [CONTOUR_SOURCE, SAT_SOURCE, HILLSHADE_SOURCE]) if (map.getSource(id)) map.removeSource(id)
        if (!map.getTerrain() && map.getSource(DEM_SOURCE)) map.removeSource(DEM_SOURCE)
      } catch {
        // map is being removed
      }
    }
    if (map.isMoving()) map.once('idle', () => requestAnimationFrame(done))
    else done()
    if (this.panel3D) this.panel3D.style.display = 'none'
  }
}

export default function CityContextLayers({
  map,
  cityCode,
  visible,
  showViewControl = false,
  cityLabel = '',
  cityCenter,
  cityZoom = 10,
}: {
  map: maplibregl.Map | null
  cityCode: string | null
  visible: CityContextVisibility
  /** Add the Jharkhand / city buttons, the district 3D picker and the heat-detection player. */
  showViewControl?: boolean
  cityLabel?: string
  cityCenter?: [number, number]
  cityZoom?: number
}) {
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const pack = cityCode ? CONTEXT_PACKS[cityCode] : undefined
  const controlRef = useRef<ViewControl | null>(null)

  useEffect(() => {
    if (!alive(map) || !pack) return
    let cancelled = false
    let data: PackData | null = null
    const ensure = () => {
      if (!cancelled && data && alive(map) && map.isStyleLoaded()) addAll(map, data, visibleRef.current)
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
    loadPack(pack.base)
      .then((d) => {
        data = d
        if (map.isStyleLoaded()) ensure()
        else map.once('idle', ensure)
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
    map.on('click', onClick)
    map.on('mousemove', onMove)
    return () => {
      cancelled = true
      map.off('style.load', ensure)
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
    if (!alive(map) || !pack || !showViewControl || !cityCenter) return
    const ctrl = new ViewControl(pack, cityLabel, cityCenter, cityZoom)
    map.addControl(ctrl, 'top-left')
    // Compass and tilt indicator: drag to tilt/turn, click to reset north.
    const nav = new maplibregl.NavigationControl({ showZoom: false, showCompass: true, visualizePitch: true })
    map.addControl(nav, 'bottom-right')
    controlRef.current = ctrl
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
    // cityCenter is an array; key on its values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, pack, showViewControl, cityLabel, cityCenter?.[0], cityCenter?.[1], cityZoom])

  useEffect(() => {
    if (!alive(map) || !pack) return
    for (const [key, ids] of Object.entries(LAYERS)) {
      for (const id of ids) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible[key as CityContextLayerKey] ? 'visible' : 'none')
      }
    }
  }, [map, pack, visible])

  return null
}
