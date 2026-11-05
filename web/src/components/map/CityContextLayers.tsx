import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'

/**
 * Static context layers for a city pack. For Dhanbad–Jharia the pack covers
 * the whole state: Jharkhand's outline, its 24 districts shaded by the
 * government monitoring each has, mining and quarry areas, industrial land,
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

export type CityContextLayerKey = 'districts' | 'mines' | 'industry' | 'roads' | 'fires' | 'reference'
export type CityContextVisibility = Record<CityContextLayerKey, boolean>

export const ALL_CONTEXT_VISIBLE: CityContextVisibility = {
  districts: true,
  mines: true,
  industry: true,
  roads: true,
  fires: true,
  reference: true,
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
  reference: ['ctx-reference'],
}

/** Topmost first: a click shows the popup of the highest feature under it. */
const CLICKABLE = ['ctx-reference', 'ctx-plants', 'ctx-fires', 'ctx-mines-fill', 'ctx-industry-fill', 'ctx-districts-fill']

/** District shading is only clickable zoomed out, so it never competes with
 *  ward cells and mapped features in the city view. */
const DISTRICT_CLICK_MAX_ZOOM = 9

const KIND_LABEL: Record<string, string> = {
  mine: 'Mining or quarry area',
  industrial: 'Industrial land',
  power_plant: 'Power plant',
  works: 'Large works',
}

/** District monitoring classes, best first. Shared with the legend. */
export const DISTRICT_CLASSES = [
  { key: 'continuous', color: '#1F6F8B', label: 'Continuous station in the CPCB feed' },
  { key: 'manual', color: '#7FB3C8', label: 'Manual stations only' },
  { key: 'planned', color: '#D5E5EC', label: 'Continuous stations planned only' },
  { key: 'none', color: '#F3D9CF', label: 'None in CPCB’s lists or the JSPCB tender' },
] as const

const districtClassExpr: maplibregl.ExpressionSpecification = [
  'case',
  ['>', ['get', 'continuous_in_feed'], 0], 'continuous',
  ['>', ['get', 'manual_namp'], 0], 'manual',
  ['>', ['get', 'planned_caaqms'], 0], 'planned',
  'none',
]

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
    paint: {
      'fill-color': ['match', districtClassExpr, ...DISTRICT_CLASSES.flatMap((c) => [c.key, c.color]), '#ccc'] as unknown as maplibregl.ExpressionSpecification,
      // Strong at state zoom, fading out in the city view so ward cells stay readable.
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 9, 0.3, 10.5, 0],
    },
  })
  map.addLayer({
    id: 'ctx-districts-line',
    type: 'line',
    source: SRC.districts,
    layout: { visibility: vis('districts') },
    paint: { 'line-color': '#5B4A3A', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 10, 1.4], 'line-opacity': 0.8 },
  })
  map.addLayer({
    id: 'ctx-state-line',
    type: 'line',
    source: SRC.state,
    layout: { visibility: vis('districts') },
    paint: { 'line-color': '#2E2219', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.6, 10, 2.6] },
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
  map.addLayer({
    id: 'ctx-reference',
    type: 'circle',
    source: SRC.stations,
    filter: ['==', ['get', 'role'], 'reference_candidate'],
    layout: { visibility: vis('reference') },
    paint: { 'circle-radius': 6, 'circle-color': '#2B88D8', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  })
}

function removeAll(map: maplibregl.Map) {
  for (const ids of Object.values(LAYERS)) for (const id of ids) if (map.getLayer(id)) map.removeLayer(id)
  for (const id of Object.values(SRC)) if (map.getSource(id)) map.removeSource(id)
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
    const cont = Number(props.continuous_in_feed ?? 0)
    const manual = Number(props.manual_namp ?? 0)
    const planned = Number(props.planned_caaqms ?? 0)
    line(`${props.name} district`, true)
    line(`Continuous stations reporting in the CPCB feed (5 Nov 2026): ${cont}`)
    line(`Manual stations, CPCB NAMP list (19 Nov 2024): ${manual}`)
    line(`Continuous stations planned, JSPCB tender (6 Dec 2025): ${planned}`)
    if (cont === 0 && manual === 0 && planned === 0) line('No station in CPCB’s public lists and none in the JSPCB tender. Monitors run by industries are not counted.')
    else if (cont === 0) line('No continuous (hourly) station reporting publicly.')
    line('District outline: geoBoundaries (approximate, not Survey of India).')
  } else if (layerId === 'ctx-fires') {
    line('Satellite heat detection (NASA FIRMS, VIIRS)', true)
    line(`${props.date ?? ''} · ${props.daynight === 'N' ? 'night' : 'day'} · fire radiative power ${props.frp ?? '—'} MW`)
    line('A 375 m pixel that was unusually hot when the satellite passed. It can be a coal fire at the surface, industrial heat, or crop or forest burning. It is not a measured fire area.')
  } else if (layerId === 'ctx-reference') {
    line(String(props.name ?? 'Reference station'), true)
    line('Government continuous monitoring station run by the West Bengal Pollution Control Board; data published through CPCB.')
    line('Outside Jharkhand. Vayu Gati may use it as a reference for checking its own sensors.')
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

/** Jharkhand / city zoom buttons plus the district legend. Plain DOM so it
 *  can live inside MapLibre's control corners. */
class ViewControl implements maplibregl.IControl {
  private el: HTMLDivElement | null = null
  private legend: HTMLDivElement | null = null
  constructor(
    private pack: ContextPack,
    private cityLabel: string,
    private cityCenter: [number, number],
    private cityZoom: number,
  ) {}

  onAdd(map: maplibregl.Map) {
    const el = document.createElement('div')
    el.className = 'maplibregl-ctrl rounded-lg border border-slate-200/80 bg-white/95 p-1.5 text-xs text-slate-700 shadow-sm backdrop-blur-sm'
    const row = document.createElement('div')
    row.className = 'flex gap-1'
    const btn = (label: string, onClick: () => void) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.className = 'rounded-md border border-slate-200 px-2 py-1 font-medium hover:bg-slate-100'
      b.addEventListener('click', onClick)
      row.appendChild(b)
    }
    btn(this.pack.regionLabel, () => {
      const [w, s, e, n] = this.pack.regionBounds
      map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 800 })
    })
    btn(this.cityLabel, () => map.flyTo({ center: this.cityCenter, zoom: this.cityZoom, duration: 800 }))
    el.appendChild(row)

    const legend = document.createElement('div')
    legend.className = 'mt-1.5 space-y-0.5 border-t border-slate-200 pt-1.5'
    const title = document.createElement('p')
    title.className = 'font-semibold'
    title.textContent = 'Districts: public air monitoring'
    legend.appendChild(title)
    for (const c of DISTRICT_CLASSES) {
      const r = document.createElement('div')
      r.className = 'flex items-center gap-1.5'
      const sw = document.createElement('span')
      sw.className = 'inline-block h-2.5 w-3.5 rounded-sm border border-slate-400/60'
      sw.style.background = c.color
      const t = document.createElement('span')
      t.textContent = c.label
      r.append(sw, t)
      legend.appendChild(r)
    }
    const note = document.createElement('p')
    note.className = 'text-[10px] text-slate-500'
    note.textContent = 'Click a district for its counts.'
    legend.appendChild(note)
    el.appendChild(legend)
    this.legend = legend
    this.el = el
    return el
  }

  setLegendVisible(v: boolean) {
    if (this.legend) this.legend.style.display = v ? '' : 'none'
  }

  onRemove() {
    this.el?.remove()
    this.el = null
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
  /** Add the Jharkhand / city zoom buttons and the district legend. */
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
    if (!map || !pack) return
    let cancelled = false
    let data: PackData | null = null
    const ensure = () => {
      if (!cancelled && data && map.isStyleLoaded()) addAll(map, data, visibleRef.current)
    }
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
    const clickable = () =>
      CLICKABLE.filter((id) => map.getLayer(id) && (id !== 'ctx-districts-fill' || map.getZoom() < DISTRICT_CLICK_MAX_ZOOM))
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const layers = clickable()
      if (!layers.length) return
      const hits = map.queryRenderedFeatures(e.point, { layers })
      if (!hits.length) return
      // queryRenderedFeatures returns topmost first.
      const f = hits[0]
      popup.setLngLat(e.lngLat).setDOMContent(popupNode(f.properties ?? {}, f.layer.id)).addTo(map)
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
        removeAll(map)
      } catch {
        // the map may already be removed on unmount
      }
    }
  }, [map, pack])

  useEffect(() => {
    if (!map || !pack || !showViewControl || !cityCenter) return
    const ctrl = new ViewControl(pack, cityLabel, cityCenter, cityZoom)
    map.addControl(ctrl, 'top-left')
    controlRef.current = ctrl
    ctrl.setLegendVisible(visibleRef.current.districts)
    return () => {
      controlRef.current = null
      try {
        map.removeControl(ctrl)
      } catch {
        // map already removed
      }
    }
    // cityCenter is an array; key on its values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, pack, showViewControl, cityLabel, cityCenter?.[0], cityCenter?.[1], cityZoom])

  useEffect(() => {
    if (!map || !pack) return
    for (const [key, ids] of Object.entries(LAYERS)) {
      for (const id of ids) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible[key as CityContextLayerKey] ? 'visible' : 'none')
      }
    }
    controlRef.current?.setLegendVisible(visible.districts)
  }, [map, pack, visible])

  return null
}
