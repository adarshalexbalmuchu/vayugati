import type { FeatureCollection, Feature, Polygon, MultiPolygon } from 'geojson'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FALLBACK_STYLE } from '../../lib/basemaps'
import { fetchAllWardBoundaries, type LatestReadingReconciliation, type WardSummary } from '../../lib/data'

const DELHI_CENTER: [number, number] = [77.209, 28.6139]
const DELHI_ZOOM = 9.6
const SRC = 'ov-wards'
const FILL = 'ov-ward-fill'
const LINE = 'ov-ward-line'

type WardFeatureProps = { id: number; name: string; aqi: number | null }
type WardGeoJSON = FeatureCollection<Polygon | MultiPolygon, WardFeatureProps>

// CPCB AQI breakpoints — same scale used everywhere in this app.
const AQI_COLOR_EXPR: maplibregl.ExpressionSpecification = [
  'step',
  ['coalesce', ['get', 'aqi'], -1],
  '#cbd5e1',          // -1  → no data (slate-300)
  0,   '#55a84f',     //   0 → Good
  50,  '#a3c853',     //  51 → Satisfactory
  100, '#fff833',     // 101 → Moderate
  200, '#f29c2b',     // 201 → Poor
  300, '#e93f33',     // 301 → Very Poor
  400, '#af2d24',     // 401 → Severe
]

const LEGEND_ITEMS = [
  { label: 'Good',         color: '#55a84f' },
  { label: 'Satisfactory', color: '#a3c853' },
  { label: 'Moderate',     color: '#fff833' },
  { label: 'Poor',         color: '#f29c2b' },
  { label: 'Very Poor',    color: '#e93f33' },
  { label: 'Severe',       color: '#af2d24' },
  { label: 'No data',      color: '#cbd5e1' },
]

export default function OverviewChoroplethMap({
  wards,
  selectedWardId,
  onSelectWard,
  latestReadingsByWard,
}: {
  wards: WardSummary[]
  selectedWardId: number | null
  onSelectWard: (wardId: number | null) => void
  latestReadingsByWard?: Map<number, LatestReadingReconciliation>
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const mapReadyRef = useRef(false)
  const prevSelectedRef = useRef<number | null>(null)

  // Stable callback refs — avoid re-registering map listeners on every render.
  const onSelectRef = useRef(onSelectWard)
  const selectedRef = useRef(selectedWardId)
  useEffect(() => { onSelectRef.current = onSelectWard }, [onSelectWard])
  useEffect(() => { selectedRef.current = selectedWardId }, [selectedWardId])

  // Ward boundaries fetched once — static geometry (shape data doesn't change).
  const [boundaries, setBoundaries] = useState<Awaited<ReturnType<typeof fetchAllWardBoundaries>>>([])
  useEffect(() => { fetchAllWardBoundaries().then(setBoundaries) }, [])

  // Hovered ward label for the floating name badge.
  const [hoveredName, setHoveredName] = useState<string | null>(null)
  const setHoveredNameRef = useRef(setHoveredName)

  // Stable ward ref for flyTo — avoids re-registering selection effect on every poll.
  const wardsForFlyRef = useRef(wards)
  useEffect(() => { wardsForFlyRef.current = wards }, [wards])

  // Build GeoJSON: only monitored wards (those present in `wards` prop).
  // Hiding the ~250 unmonitored grey boundaries keeps the map focused.
  const geojson = useMemo<WardGeoJSON>(() => {
    const wardMap = new Map(wards.map(w => [w.id, w]))
    return {
      type: 'FeatureCollection',
      features: boundaries
        .filter(b => wardMap.has(b.id))
        .map((b): Feature<Polygon | MultiPolygon, WardFeatureProps> => {
          const ward = wardMap.get(b.id)
          const preferred = latestReadingsByWard?.get(b.id)
          const aqi =
            preferred?.sourceUsed === 'cpcb' && preferred.cpcbAqi != null
              ? preferred.cpcbAqi
              : (ward?.aqi ?? preferred?.openaqAqi ?? null)
          return {
            type: 'Feature',
            id: b.id,              // top-level id for MapLibre promoteId
            properties: { id: b.id, name: b.name, aqi },
            geometry: b.geometry,
          }
        }),
    }
  }, [boundaries, wards, latestReadingsByWard])

  // Mount the map once.
  useEffect(() => {
    if (!containerRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: FALLBACK_STYLE,
      center: DELHI_CENTER,
      zoom: DELHI_ZOOM,
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: false,
    })

    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      'bottom-right',
    )
    map.on('error', (e) => console.warn('[OverviewMap]', e.error ?? e))

    const addLayers = () => {
      if (map.getSource(SRC)) return
      map.addSource(SRC, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] } as WardGeoJSON,
        // promoteId:'id' → MapLibre uses properties.id as feature ID so
        // setFeatureState() keyed by ward.id resolves correctly.
        promoteId: 'id',
      })

      map.addLayer({
        id: FILL,
        type: 'fill',
        source: SRC,
        paint: {
          'fill-color': AQI_COLOR_EXPR,
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'selected'], false], 0.90,
            ['boolean', ['feature-state', 'hover'], false],   0.82,
            0.72,
          ] as maplibregl.ExpressionSpecification,
        },
      })

      map.addLayer({
        id: LINE,
        type: 'line',
        source: SRC,
        paint: {
          'line-color': [
            'case',
            ['boolean', ['feature-state', 'selected'], false], '#1d4ed8',
            ['boolean', ['feature-state', 'hover'], false],   '#3b82f6',
            'rgba(255,255,255,0.55)',
          ] as maplibregl.ExpressionSpecification,
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'selected'], false], 2.5,
            ['boolean', ['feature-state', 'hover'], false],   1.5,
            0.55,
          ] as maplibregl.ExpressionSpecification,
        },
      })
    }

    if (map.isStyleLoaded()) addLayers()
    else map.once('style.load', addLayers)
    map.on('style.load', addLayers)

    // Click: select ward (or deselect if already selected).
    map.on('click', FILL, (e) => {
      const id = e.features?.[0]?.properties?.id as number | undefined
      if (id != null) {
        onSelectRef.current(id === selectedRef.current ? null : id)
      }
    })

    // Hover: update feature state + name badge.
    let hoveredId: number | null = null
    const clearHover = () => {
      map.getCanvas().style.cursor = ''
      if (hoveredId !== null) {
        if (map.getSource(SRC)) map.setFeatureState({ source: SRC, id: hoveredId }, { hover: false })
        hoveredId = null
      }
      setHoveredNameRef.current(null)
    }

    map.on('mousemove', FILL, (e) => {
      const feat = e.features?.[0]
      const id = feat?.properties?.id as number | undefined
      map.getCanvas().style.cursor = 'pointer'
      if (hoveredId !== null && hoveredId !== id) {
        if (map.getSource(SRC)) map.setFeatureState({ source: SRC, id: hoveredId }, { hover: false })
      }
      if (id != null) {
        hoveredId = id
        if (map.getSource(SRC)) map.setFeatureState({ source: SRC, id }, { hover: true })
        setHoveredNameRef.current(feat?.properties?.name as string ?? null)
      }
    })
    map.on('mouseleave', FILL, clearHover)

    map.once('load', () => { mapReadyRef.current = true })
    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
      mapReadyRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fit map to monitored wards once when data first loads.
  const hasFittedRef = useRef(false)
  useEffect(() => {
    const map = mapRef.current
    if (!map || hasFittedRef.current || wards.length === 0) return

    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity
    for (const w of wards) {
      if (w.lng == null || w.lat == null) continue
      if (w.lng < minLng) minLng = w.lng
      if (w.lng > maxLng) maxLng = w.lng
      if (w.lat < minLat) minLat = w.lat
      if (w.lat > maxLat) maxLat = w.lat
    }
    if (!isFinite(minLng)) return

    const doFit = () => {
      map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 32, maxZoom: 12, duration: 800 })
      hasFittedRef.current = true
    }
    if (mapReadyRef.current) doFit()
    else map.once('load', doFit)
  }, [wards])

  // Fly to selected ward centroid on selection change.
  useEffect(() => {
    const map = mapRef.current
    if (!map || selectedWardId === null) return
    const ward = wardsForFlyRef.current.find(w => w.id === selectedWardId)
    if (!ward || ward.lng == null || ward.lat == null) return

    const doFly = () => {
      map.flyTo({ center: [ward.lng!, ward.lat!], zoom: Math.max(map.getZoom(), 11.5), duration: 500 })
    }
    if (mapReadyRef.current) doFly()
    else map.once('load', doFly)
  }, [selectedWardId])

  // Push updated GeoJSON into the source whenever ward AQI data changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined
      if (src) src.setData(geojson)
    }
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [geojson])

  // Sync selected-ward feature state.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      if (!map.getSource(SRC)) return
      const prev = prevSelectedRef.current
      if (prev !== null) map.setFeatureState({ source: SRC, id: prev }, { selected: false })
      if (selectedWardId !== null) map.setFeatureState({ source: SRC, id: selectedWardId }, { selected: true })
      prevSelectedRef.current = selectedWardId
    }
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [selectedWardId])

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />

      {/* Hovered ward name badge */}
      {hoveredName && (
        <div className="pointer-events-none absolute left-2 top-2 z-20 max-w-[160px] truncate rounded-md border border-slate-200/80 bg-white/90 px-2 py-1 text-xs font-semibold text-slate-800 shadow-sm backdrop-blur-sm">
          {hoveredName}
        </div>
      )}

      {/* Compact AQI legend — bottom-right, clear of zoom controls */}
      <div className="absolute bottom-10 right-14 z-10 rounded-lg border border-slate-200/80 bg-white/90 px-2 py-1.5 shadow-sm backdrop-blur-sm">
        <p className="mb-1 text-[8px] font-bold uppercase tracking-widest text-slate-400">AQI</p>
        <div className="space-y-[3px]">
          {LEGEND_ITEMS.map((l) => (
            <div key={l.label} className="flex items-center gap-1.5">
              <span
                className="h-2.5 w-3 flex-shrink-0 rounded-[2px]"
                style={{ backgroundColor: l.color }}
              />
              <span className="text-[9px] font-medium text-slate-600">{l.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
