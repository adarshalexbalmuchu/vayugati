import type { FeatureCollection, Feature, Polygon, MultiPolygon, Point } from 'geojson'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FALLBACK_STYLE } from '../../lib/basemaps'
import { fetchAllWardBoundaries, type LatestReadingReconciliation, type WardSummary } from '../../lib/data'
import { formatWardName } from '../../lib/format'

const DELHI_CENTER: [number, number] = [77.209, 28.6139]
const DELHI_ZOOM = 9.6

// Boundary polygon layer (~265 wards). Monitored wards (those with an
// active station) with a linked boundary render as a solid AQI-colored
// choropleth fill; the rest stay a subdued grey for geographic context.
const SRC    = 'ov-wards'
const FILL   = 'ov-ward-fill'
const LINE   = 'ov-ward-line'

// Circle marker layer — fallback for any monitored ward that has no
// linked boundary polygon yet, using its lat/lng centroid instead.
const CSRC   = 'ov-ward-centers'
const CIRCLE = 'ov-ward-circle'

type WardFeatureProps = { id: number; name: string; aqi: number | null; isMonitored: boolean }
type WardGeoJSON = FeatureCollection<Polygon | MultiPolygon, WardFeatureProps>
type CenterGeoJSON = FeatureCollection<Point, WardFeatureProps>

const AQI_COLOR_EXPR: maplibregl.ExpressionSpecification = [
  'step',
  ['coalesce', ['get', 'aqi'], -1],
  '#94a3b8',          // no data → slate-400
  0,   '#55a84f',
  50,  '#a3c853',
  100, '#fff833',
  200, '#f29c2b',
  300, '#e93f33',
  400, '#af2d24',
]

const LEGEND_ITEMS = [
  { label: 'Good',         color: '#55a84f' },
  { label: 'Satisfactory', color: '#a3c853' },
  { label: 'Moderate',     color: '#fff833' },
  { label: 'Poor',         color: '#f29c2b' },
  { label: 'Very Poor',    color: '#e93f33' },
  { label: 'Severe',       color: '#af2d24' },
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

  // Ward boundaries fetched once — static geometry. `boundariesLoaded` guards
  // the circle fallback below: until this fetch resolves we don't yet know
  // which monitored wards truly lack a polygon, so showing circles early
  // would flash a dot for every monitored ward and then yank most of them
  // away the instant boundaries arrive.
  const [boundaries, setBoundaries] = useState<Awaited<ReturnType<typeof fetchAllWardBoundaries>>>([])
  const [boundariesLoaded, setBoundariesLoaded] = useState(false)
  useEffect(() => {
    fetchAllWardBoundaries().then((b) => {
      setBoundaries(b)
      setBoundariesLoaded(true)
    })
  }, [])

  const [hoveredName, setHoveredName] = useState<string | null>(null)
  const setHoveredNameRef = useRef(setHoveredName)

  // Stable ward ref for flyTo — avoids re-triggering selection effect on every poll.
  const wardsForFlyRef = useRef(wards)
  useEffect(() => { wardsForFlyRef.current = wards }, [wards])

  // Polygon GeoJSON — real ward boundaries, colored by AQI where monitored.
  // `wards` (the fetchAllWardsAqi() result) now covers every ward with an
  // active station, not just the 13 original is_hotspot=true seed wards —
  // most of those 26 extra wards already had real MCD/NDMC boundary
  // geometry from the Phase 2 import. The 13 seed wards didn't, so they
  // instead borrow the MCD polygon containing their station (see
  // scripts/link-hotspot-ward-boundaries.ts). Either way, a monitored
  // ward's donor MCD polygon (if any) is dropped from this layer so the
  // two don't overlap. A monitored ward with no boundary at all yet falls
  // back to the circle layer below.
  const geojson = useMemo<WardGeoJSON>(() => {
    const wardMap = new Map(wards.map(w => [w.id, w]))
    const claimedDonorNumbers = new Set(
      boundaries.filter(b => b.donorWardNumber != null).map(b => b.donorWardNumber),
    )
    return {
      type: 'FeatureCollection',
      features: boundaries
        .filter(b => b.wardNumber == null || !claimedDonorNumbers.has(b.wardNumber))
        .map((b): Feature<Polygon | MultiPolygon, WardFeatureProps> => {
          const ward = wardMap.get(b.id)
          const preferred = latestReadingsByWard?.get(b.id)
          const aqi =
            preferred?.sourceUsed === 'cpcb' && preferred.cpcbAqi != null
              ? preferred.cpcbAqi
              : (ward?.aqi ?? preferred?.openaqAqi ?? null)
          return {
            type: 'Feature',
            id: b.id,
            properties: { id: b.id, name: formatWardName(b.name), aqi, isMonitored: ward != null },
            geometry: b.geometry,
          }
        }),
    }
  }, [boundaries, wards, latestReadingsByWard])

  // Circle GeoJSON — fallback for monitored wards that have no linked
  // boundary yet (lat/lng centroid, colored by AQI). Empty until
  // boundariesLoaded so we never flash a dot for a ward that's about to
  // get a real polygon.
  const boundaryWardIds = useMemo(() => new Set(boundaries.map(b => b.id)), [boundaries])
  const centersGeoJSON = useMemo<CenterGeoJSON>(() => ({
    type: 'FeatureCollection',
    features: !boundariesLoaded ? [] : wards
      .filter(w => w.lat != null && w.lng != null && !boundaryWardIds.has(w.id))
      .map((w): Feature<Point, WardFeatureProps> => {
        const preferred = latestReadingsByWard?.get(w.id)
        const aqi =
          preferred?.sourceUsed === 'cpcb' && preferred.cpcbAqi != null
            ? preferred.cpcbAqi
            : (w.aqi ?? preferred?.openaqAqi ?? null)
        return {
          type: 'Feature',
          id: w.id,
          properties: { id: w.id, name: formatWardName(w.name), aqi, isMonitored: true },
          geometry: { type: 'Point', coordinates: [w.lng!, w.lat!] },
        }
      }),
  }), [wards, latestReadingsByWard, boundaryWardIds, boundariesLoaded])

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

      // ── Polygon choropleth layer (colored by AQI for monitored wards,
      //    subdued grey context fill for the rest) ──────────────────────────
      map.addSource(SRC, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] } as WardGeoJSON,
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
            ['boolean', ['feature-state', 'selected'], false], 0.92,
            ['boolean', ['feature-state', 'hover'], false], 0.85,
            ['boolean', ['get', 'isMonitored'], false], 0.75,
            0.22,
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
            ['boolean', ['feature-state', 'hover'], false], '#334155',
            'rgba(148,163,184,0.6)',
          ] as maplibregl.ExpressionSpecification,
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'selected'], false], 3,
            ['boolean', ['feature-state', 'hover'], false], 1.5,
            0.5,
          ] as maplibregl.ExpressionSpecification,
        },
      })

      // ── Circle marker layer (monitored wards, AQI-colored) ─────────────────
      map.addSource(CSRC, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] } as CenterGeoJSON,
        promoteId: 'id',
      })
      map.addLayer({
        id: CIRCLE,
        type: 'circle',
        source: CSRC,
        paint: {
          'circle-color': AQI_COLOR_EXPR,
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            9, 11,
            11, 16,
            13, 22,
          ] as maplibregl.ExpressionSpecification,
          'circle-stroke-color': [
            'case',
            ['boolean', ['feature-state', 'selected'], false], '#1d4ed8',
            'white',
          ] as maplibregl.ExpressionSpecification,
          'circle-stroke-width': [
            'case',
            ['boolean', ['feature-state', 'selected'], false], 3,
            1.5,
          ] as maplibregl.ExpressionSpecification,
          'circle-opacity': [
            'case',
            ['boolean', ['feature-state', 'selected'], false], 1,
            ['boolean', ['feature-state', 'hover'], false], 0.95,
            0.88,
          ] as maplibregl.ExpressionSpecification,
        },
      })
    }

    if (map.isStyleLoaded()) addLayers()
    else map.once('style.load', addLayers)
    map.on('style.load', addLayers)

    // Timestamp used to prevent FILL click firing right after a CIRCLE click.
    let lastCircleClickTs = 0

    // Circle layer: primary click target for monitored wards.
    map.on('click', CIRCLE, (e) => {
      const id = e.features?.[0]?.properties?.id as number | undefined
      if (id != null) {
        lastCircleClickTs = Date.now()
        onSelectRef.current(id === selectedRef.current ? null : id)
      }
    })

    // Fill layer: primary click target for monitored wards that have a
    // linked boundary. Plain MCD context wards aren't selectable. Skip if
    // a circle click was just handled (same point).
    map.on('click', FILL, (e) => {
      if (Date.now() - lastCircleClickTs < 120) return
      const feat = e.features?.[0]
      if (!feat?.properties?.isMonitored) return
      const id = feat.properties?.id as number | undefined
      if (id != null) {
        onSelectRef.current(id === selectedRef.current ? null : id)
      }
    })

    // Circle hover.
    let hoveredCircleId: number | null = null
    map.on('mousemove', CIRCLE, (e) => {
      const feat = e.features?.[0]
      const id = feat?.properties?.id as number | undefined
      map.getCanvas().style.cursor = 'pointer'
      if (hoveredCircleId !== null && hoveredCircleId !== id) {
        if (map.getSource(CSRC)) map.setFeatureState({ source: CSRC, id: hoveredCircleId }, { hover: false })
      }
      if (id != null) {
        hoveredCircleId = id
        if (map.getSource(CSRC)) map.setFeatureState({ source: CSRC, id }, { hover: true })
        setHoveredNameRef.current(feat?.properties?.name as string ?? null)
      }
    })
    map.on('mouseleave', CIRCLE, () => {
      map.getCanvas().style.cursor = ''
      if (hoveredCircleId !== null && map.getSource(CSRC)) {
        map.setFeatureState({ source: CSRC, id: hoveredCircleId }, { hover: false })
        hoveredCircleId = null
      }
      setHoveredNameRef.current(null)
    })

    // Fill hover — only monitored (isMonitored) polygons are interactive;
    // the plain MCD context wards stay inert.
    let hoveredFillId: number | null = null
    map.on('mousemove', FILL, (e) => {
      const feat = e.features?.[0]
      if (!feat?.properties?.isMonitored) {
        if (hoveredFillId !== null && map.getSource(SRC)) {
          map.setFeatureState({ source: SRC, id: hoveredFillId }, { hover: false })
        }
        hoveredFillId = null
        map.getCanvas().style.cursor = ''
        setHoveredNameRef.current(null)
        return
      }
      const id = feat.properties?.id as number | undefined
      map.getCanvas().style.cursor = 'pointer'
      if (hoveredFillId !== null && hoveredFillId !== id) {
        if (map.getSource(SRC)) map.setFeatureState({ source: SRC, id: hoveredFillId }, { hover: false })
      }
      if (id != null) {
        hoveredFillId = id
        if (map.getSource(SRC)) map.setFeatureState({ source: SRC, id }, { hover: true })
        setHoveredNameRef.current(feat.properties?.name as string ?? null)
      }
    })
    map.on('mouseleave', FILL, () => {
      map.getCanvas().style.cursor = ''
      if (hoveredFillId !== null && map.getSource(SRC)) {
        map.setFeatureState({ source: SRC, id: hoveredFillId }, { hover: false })
        hoveredFillId = null
      }
      setHoveredNameRef.current(null)
    })

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
      map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 48, maxZoom: 11, duration: 800 })
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

  // Push updated polygon GeoJSON.
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

  // Push updated circle GeoJSON.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      const src = map.getSource(CSRC) as maplibregl.GeoJSONSource | undefined
      if (src) src.setData(centersGeoJSON)
    }
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [centersGeoJSON])

  // Sync selected feature state on both sources.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      const prev = prevSelectedRef.current
      if (map.getSource(CSRC)) {
        if (prev !== null) map.setFeatureState({ source: CSRC, id: prev }, { selected: false })
        if (selectedWardId !== null) map.setFeatureState({ source: CSRC, id: selectedWardId }, { selected: true })
      }
      if (map.getSource(SRC)) {
        if (prev !== null) map.setFeatureState({ source: SRC, id: prev }, { selected: false })
        if (selectedWardId !== null) map.setFeatureState({ source: SRC, id: selectedWardId }, { selected: true })
      }
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
