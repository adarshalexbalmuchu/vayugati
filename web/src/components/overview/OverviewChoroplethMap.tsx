import type { FeatureCollection, Feature, Polygon, MultiPolygon, Point } from 'geojson'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Maximize2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import CityKpiRow from './CityKpiRow'
import { GlassSurface } from '../GlassSurface'
import { FALLBACK_STYLE, isBasemapAvailable, resolveStyleUrl } from '../../lib/basemaps'
import { fetchAllWardBoundaries, type LatestReadingReconciliation, type WardSummary } from '../../lib/data'
import { formatWardName } from '../../lib/format'
import { HOTSPOT_READING_STALE_MINUTES } from '../../lib/overviewRules'

/** Hover badge text: the ward name, plus the reading's age when it's stale.
 *  (MapLibre hands feature properties back as plain JSON, hence the loose type.) */
function hoverLabel(props: Record<string, unknown> | null | undefined): string | null {
  const name = (props?.name as string | undefined) ?? null
  if (!name) return null
  return props?.stale && props?.ageLabel ? `${name} · ${props.ageLabel as string}` : name
}

function readingAge(ts: string | null | undefined): { stale: boolean; ageLabel: string | null } {
  if (!ts) return { stale: false, ageLabel: null }
  const minutes = (Date.now() - new Date(ts).getTime()) / 60000
  if (!Number.isFinite(minutes) || minutes <= HOTSPOT_READING_STALE_MINUTES) return { stale: false, ageLabel: null }
  const h = Math.round(minutes / 60)
  return { stale: true, ageLabel: h >= 48 ? `last reading ${Math.round(h / 24)}d ago` : `last reading ${h}h ago` }
}

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

type WardFeatureProps = {
  id: number
  name: string
  aqi: number | null
  isMonitored: boolean
  /** Reading older than HOTSPOT_READING_STALE_MINUTES: drawn faded, and the
   *  hover badge says how old it is, so a last-known value shown during an
   *  upstream outage is never mistaken for a current one. */
  stale: boolean
  ageLabel: string | null
}
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

/** Bounding-box centre of a polygon/multipolygon — good enough for a flyTo
 *  target (doesn't need to be a true area centroid). Only 13 of ~250 wards
 *  have a real captured lat/lng point (see WardBoundary's own doc comment in
 *  lib/data.ts); this is the honest fallback for the rest, computed from
 *  geometry that's already fetched and rendered rather than fabricating a
 *  coordinate or silently doing nothing on click. */
function boundingBoxCenter(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): [number, number] | null {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity
  const rings = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  for (const polygon of rings) {
    for (const ring of polygon) {
      for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng
        if (lng > maxLng) maxLng = lng
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
      }
    }
  }
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return null
  return [(minLng + maxLng) / 2, (minLat + maxLat) / 2]
}

export default function OverviewChoroplethMap({
  wards,
  selectedWardId,
  onSelectWard,
  latestReadingsByWard,
  reviewCount,
  openReportCount,
  coverage,
  latestReadingAgeMinutes,
  onWardsFlaggedClick,
}: {
  wards: WardSummary[]
  selectedWardId: number | null
  onSelectWard: (wardId: number | null) => void
  latestReadingsByWard?: Map<number, LatestReadingReconciliation>
  /** The 4 city KPIs, rendered as a glass bar over the bottom of the map
   *  (Sept 2026 — moved off the page header). Same props CityKpiRow has
   *  always taken; passed straight through from HotspotsRiskTable. */
  reviewCount: number
  openReportCount: number
  coverage: { fresh: number; total: number } | null
  latestReadingAgeMinutes?: number | null
  onWardsFlaggedClick?: () => void
}) {
  const navigate = useNavigate()
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
  // Same pattern for boundaries — needed by the flyTo fallback below (most
  // wards have no wards.lat/lng; see boundariesForFlyRef's use site).
  const boundariesForFlyRef = useRef(boundaries)
  useEffect(() => { boundariesForFlyRef.current = boundaries }, [boundaries])

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
          // Bug fix (Sept 2026): `ward != null` used to BE the monitored
          // signal, back when fetchAllWardsAqi() only returned monitored
          // wards (so mere presence in `wards` meant monitored). That
          // function now returns every ward (so VayuTrace attribution -
          // which needs no station - is reachable everywhere); presence
          // alone no longer implies monitored, so this must check the
          // explicit isMonitored field instead.
          return {
            type: 'Feature',
            id: b.id,
            properties: {
              id: b.id, name: formatWardName(b.name), aqi, isMonitored: ward?.isMonitored ?? false,
              ...(aqi != null ? readingAge(ward?.ts) : { stale: false, ageLabel: null }),
            },
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
    // Bug fix (Sept 2026): `wards` used to contain ONLY monitored wards, so
    // `w.lat != null && w.lng != null` (a real captured point) was itself
    // sufficient to imply monitored — hardcoding isMonitored: true below
    // was safe. Now that fetchAllWardsAqi() returns every ward, that's no
    // longer true (confirmed live: Mayapuri, id 12, has a real point but
    // is NOT monitored) — filter on the explicit isMonitored field too, or
    // this circle layer would wrongly render an unmonitored ward as if it
    // had a live reading.
    features: !boundariesLoaded ? [] : wards
      .filter(w => w.isMonitored && w.lat != null && w.lng != null && !boundaryWardIds.has(w.id))
      .map((w): Feature<Point, WardFeatureProps> => {
        const preferred = latestReadingsByWard?.get(w.id)
        const aqi =
          preferred?.sourceUsed === 'cpcb' && preferred.cpcbAqi != null
            ? preferred.cpcbAqi
            : (w.aqi ?? preferred?.openaqAqi ?? null)
        return {
          type: 'Feature',
          id: w.id,
          properties: {
            id: w.id, name: formatWardName(w.name), aqi, isMonitored: true,
            ...(aqi != null ? readingAge(w.ts) : { stale: false, ageLabel: null }),
          },
          geometry: { type: 'Point', coordinates: [w.lng!, w.lat!] },
        }
      }),
  }), [wards, latestReadingsByWard, boundaryWardIds, boundariesLoaded])


  // Mount the map once.
  useEffect(() => {
    if (!containerRef.current) return

    // Same "Terrain" MapTiler style the dedicated Map page offers when a key
    // is configured — noticeably crisper than the keyless raster fallback.
    // Falls back to the keyless Esri tiles with no config needed.
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: isBasemapAvailable('terrain') ? resolveStyleUrl('terrain') : FALLBACK_STYLE,
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
            ['all', ['boolean', ['get', 'isMonitored'], false], ['boolean', ['get', 'stale'], false]], 0.35,
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
            ['boolean', ['get', 'stale'], false], 0.45,
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
        setHoveredNameRef.current(hoverLabel(feat?.properties))
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
        setHoveredNameRef.current(hoverLabel(feat.properties))
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

  // Previously: fit map to monitored wards' bounding box once on first
  // load. Removed (Sept 2026, direct request) — that fit zoomed in tighter
  // (up to zoom 11) than DELHI_ZOOM's own 9.6, so the page always opened
  // cropped to just the monitored-ward cluster instead of showing the full
  // NCR context (Bahadurgarh–Ghaziabad–Noida–Gurugram–Faridabad) the fixed
  // center/zoom below is tuned for. The map now simply opens at
  // DELHI_CENTER/DELHI_ZOOM and stays there — a viewer can always zoom in
  // themselves if they want a tighter view.

  // Fly to selected ward on selection change. Prefers the ward's own
  // captured lat/lng when it has one; falls back to its boundary polygon's
  // bounding-box centre otherwise — only 13 of ~250 wards have a real point,
  // so without this fallback flyTo silently did nothing for the other ~237
  // (the bug reported Sept 2026: "works but only for a few").
  useEffect(() => {
    const map = mapRef.current
    if (!map || selectedWardId === null) return
    const ward = wardsForFlyRef.current.find(w => w.id === selectedWardId)
    const boundary = boundariesForFlyRef.current.find(b => b.id === selectedWardId)
    const center: [number, number] | null =
      ward?.lng != null && ward?.lat != null
        ? [ward.lng, ward.lat]
        : boundary
        ? boundingBoxCenter(boundary.geometry)
        : null
    if (!center) return

    const doFly = () => {
      map.flyTo({ center, zoom: Math.max(map.getZoom(), 11.5), duration: 500 })
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
        <div className="pointer-events-none absolute left-2 top-2 z-20 max-w-[260px] truncate rounded-md border border-slate-200/80 bg-white/90 px-2 py-1 text-xs font-semibold text-slate-800 shadow-sm backdrop-blur-sm">
          {hoveredName}
        </div>
      )}

      {/* Ward summary card removed (Sept 2026, 3rd pass) — its AQI number,
          NAQI label, and ward name were the exact same three facts already
          shown as the left list's top row and the right detail panel's own
          hero, per direct feedback that it was "repetitive, everything" on
          top of those two. The default-worst-ward click-to-select shortcut
          this card also provided is not lost: the worst ward is already the
          left list's top row (also clickable) whenever nothing is selected. */}

      {/* Open full Map page (Sept 2026) — top-right, above the AQI legend.
          This Overview map is a compact preview (no time-mode scrubber, no
          GeoAI, no source-attribution tools); clicking here takes a viewer
          who wants the full toolset straight to /map instead of leaving them
          to find it via the side nav. */}
      <button
        type="button"
        onClick={() => navigate('/map')}
        title="Open full map"
        aria-label="Open full map"
        className="focus-ring absolute right-2 top-2 z-10 rounded-lg border border-slate-200/80 bg-white/90 p-1.5 text-slate-500 shadow-sm backdrop-blur-sm transition hover:bg-white hover:text-accent-600"
      >
        <Maximize2 className="h-3.5 w-3.5" aria-hidden />
      </button>

      {/* Compact AQI legend — sits below the fullscreen button, top-right,
          clear of the hovered-ward badge (top-left) and the zoom controls
          (bottom-right). Same real liquid-glass <GlassSurface> as the KPI
          bar below and the Map page toolbar (Sept 2026), replacing the
          earlier flat bg-white/90 + backdrop-blur-sm approximation. */}
      <div className="absolute right-2 top-10 z-10">
        <GlassSurface radiusClassName="rounded-lg" className="px-2 py-1.5">
          <p className="mb-1 text-[8px] font-bold uppercase tracking-widest text-slate-500">AQI</p>
          <div className="space-y-[3px]">
            {LEGEND_ITEMS.map((l) => (
              <div key={l.label} className="flex items-center gap-1.5">
                <span
                  className="h-2.5 w-3 flex-shrink-0 rounded-[2px]"
                  style={{ backgroundColor: l.color }}
                />
                <span className="text-[9px] font-medium text-slate-700">{l.label}</span>
              </div>
            ))}
          </div>
          {/* Only shown when it applies: explains the faded fill a last-known
              reading gets during an upstream outage (see readingAge above). */}
          {geojson.features.some((f) => f.properties.stale) && (
            <div className="mt-1.5 flex items-center gap-1.5 border-t border-slate-200/70 pt-1.5">
              <span className="h-2.5 w-3 flex-shrink-0 rounded-[2px] bg-[#fff833] opacity-40" />
              <span className="text-[9px] font-medium text-slate-500">Faded: reading &gt;3h old</span>
            </div>
          )}
        </GlassSurface>
      </div>

      {/* City KPI bar — real Apple-style "liquid glass" (Sept 2026, 2nd
          pass): the first pass here was a flat translucent+blur
          approximation, same as the Map page toolbar's own first pass,
          which was rejected there as not the actual effect — swapped to
          the same <GlassSurface> (SVG turbulence/displacement filter that
          actually warps the map behind it) used there now, for
          consistency. pr-14-equivalent spacing (right-14 below) still
          clears MapLibre's own zoom control, bottom-right in this corner.
          CityKpiRow's compact variant text colours are unchanged — dark
          text reads correctly here since this map (unlike the Map page's
          default dark basemap) uses the light 'terrain' style. */}
      <div className="absolute bottom-2 left-2 right-14 z-10">
        <GlassSurface radiusClassName="rounded-xl" className="flex items-stretch justify-between gap-1 px-1 py-1">
          <CityKpiRow
            reviewCount={reviewCount}
            openReportCount={openReportCount}
            coverage={coverage}
            latestReadingAgeMinutes={latestReadingAgeMinutes}
            onWardsFlaggedClick={onWardsFlaggedClick}
            compact
          />
        </GlassSurface>
      </div>
    </div>
  )
}
