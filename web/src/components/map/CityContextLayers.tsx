import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'

/**
 * Static context layers for a city pack: mines, industry, power plants, major
 * roads, fire hotspots and reference stations outside the city. No block
 * boundaries: no official block boundaries are published for download, and
 * the open ones are Census-era blocks that no longer match the district.
 * The files are built by ingest/scripts/jharkhand/build_layers.py into
 * data/jharkhand/processed/ and copied to web/public/city-packs/<code>/.
 * Context only: these are mapped features, not measurements.
 *
 * Renders nothing itself; it adds MapLibre sources and layers to `map`, and
 * re-adds them after every setStyle() (which wipes custom layers).
 */

export type CityContextLayerKey = 'mines' | 'industry' | 'roads' | 'fires' | 'reference'
export type CityContextVisibility = Record<CityContextLayerKey, boolean>

export const ALL_CONTEXT_VISIBLE: CityContextVisibility = {
  mines: true,
  industry: true,
  roads: true,
  fires: true,
  reference: true,
}

/** City codes with a context pack, and where its files are served from. */
export const CONTEXT_PACKS: Record<string, string> = {
  dhanbad: '/city-packs/dhanbad',
}

export function hasContextPack(cityCode: string | null | undefined): boolean {
  return cityCode != null && cityCode in CONTEXT_PACKS
}

const FILES = {
  sources: 'sources_osm.geojson',
  roads: 'roads_major.geojson',
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
  sources: 'ctx-sources',
  roads: 'ctx-roads',
  fires: 'ctx-fires',
  stations: 'ctx-stations',
} as const

/** Layer ids per toggle, bottom to top. */
const LAYERS: Record<CityContextLayerKey, string[]> = {
  roads: ['ctx-roads-line'],
  industry: ['ctx-industry-fill', 'ctx-plants'],
  mines: ['ctx-mines-fill', 'ctx-mines-line'],
  fires: ['ctx-fires'],
  reference: ['ctx-reference'],
}

const CLICKABLE = ['ctx-mines-fill', 'ctx-industry-fill', 'ctx-plants', 'ctx-fires', 'ctx-reference']

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
    id: 'ctx-roads-line',
    type: 'line',
    source: SRC.roads,
    layout: { visibility: vis('roads') },
    paint: {
      'line-color': '#C0392B',
      'line-opacity': 0.75,
      'line-width': ['match', ['get', 'highway'], ['motorway', 'trunk'], 2.2, 'primary', 1.6, 1],
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
    paint: { 'circle-radius': 6, 'circle-color': '#FFBF00', 'circle-stroke-color': '#333', 'circle-stroke-width': 1.5 },
  })
  map.addLayer({
    id: 'ctx-fires',
    type: 'circle',
    source: SRC.fires,
    layout: { visibility: vis('fires') },
    paint: { 'circle-radius': 3.5, 'circle-color': '#E4572E', 'circle-opacity': 0.85 },
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
  el.className = 'text-xs leading-snug'
  const line = (text: string, bold = false) => {
    const p = document.createElement('p')
    p.textContent = text
    if (bold) p.className = 'font-semibold'
    el.appendChild(p)
  }
  if (layerId === 'ctx-fires') {
    line('Satellite heat detection (NASA FIRMS, VIIRS)', true)
    line(`${props.date ?? ''} · ${props.daynight === 'N' ? 'night' : 'day'} · fire radiative power ${props.frp ?? '—'} MW`)
    line('A 375 m pixel that was unusually hot when the satellite passed. In the coalfield it can be a coal fire at the surface, industrial heat or open burning. It is not a measured fire area.')
  } else if (layerId === 'ctx-reference') {
    line(String(props.name ?? 'Reference station'), true)
    line('Government continuous monitoring station run by the West Bengal Pollution Control Board; data published through CPCB.')
    line('Outside Dhanbad district. Vayu Gati may use it as a reference for checking its own sensors.')
  } else if (props.checked) {
    line(String(props.name), true)
    line(KIND_LABEL[String(props.kind)] ?? '')
    if (props.operator) line(`Operator: ${props.operator}`)
    line('Location: OpenStreetMap. Name and operator checked against the operator’s own publications.')
  } else {
    line(String(props.name || KIND_LABEL[String(props.kind)] || 'Mapped feature'), true)
    if (props.name) line(KIND_LABEL[String(props.kind)] ?? '')
    line('Source: OpenStreetMap, mapped by volunteers. Not an official lease or land-use boundary, and some areas are missing.')
  }
  return el
}

export default function CityContextLayers({
  map,
  cityCode,
  visible,
}: {
  map: maplibregl.Map | null
  cityCode: string | null
  visible: CityContextVisibility
}) {
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const base = cityCode ? CONTEXT_PACKS[cityCode] : undefined

  useEffect(() => {
    if (!map || !base) return
    let cancelled = false
    let data: PackData | null = null
    const ensure = () => {
      if (!cancelled && data && map.isStyleLoaded()) addAll(map, data, visibleRef.current)
    }
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '260px' })
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return
      popup.setLngLat(e.lngLat).setDOMContent(popupNode(f.properties ?? {}, f.layer.id)).addTo(map)
    }
    const enter = () => { map.getCanvas().style.cursor = 'pointer' }
    const leave = () => { map.getCanvas().style.cursor = '' }
    loadPack(base)
      .then((d) => {
        data = d
        if (map.isStyleLoaded()) ensure()
        else map.once('idle', ensure)
      })
      .catch((err) => console.warn('[CityContextLayers]', err))
    map.on('style.load', ensure)
    for (const id of CLICKABLE) {
      map.on('click', id, onClick)
      map.on('mouseenter', id, enter)
      map.on('mouseleave', id, leave)
    }
    return () => {
      cancelled = true
      map.off('style.load', ensure)
      for (const id of CLICKABLE) {
        map.off('click', id, onClick)
        map.off('mouseenter', id, enter)
        map.off('mouseleave', id, leave)
      }
      popup.remove()
      try {
        removeAll(map)
      } catch {
        // the map may already be removed on unmount
      }
    }
  }, [map, base])

  useEffect(() => {
    if (!map || !base) return
    for (const [key, ids] of Object.entries(LAYERS)) {
      for (const id of ids) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible[key as CityContextLayerKey] ? 'visible' : 'none')
      }
    }
  }, [map, base, visible])

  return null
}
