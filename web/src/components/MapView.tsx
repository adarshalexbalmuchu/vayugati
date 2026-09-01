import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson'
import maplibregl, { type StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FALLBACK_STYLE, maptilerKey } from '../lib/basemaps'
import WindParticles from './WindParticles'
import {
  areIdenticalCoords,
  clusterTooltipHtml,
  INCIDENT_CLUSTER_MAX_ZOOM,
  INCIDENT_CLUSTER_RADIUS,
  spiderfyLegs,
} from '../lib/incidentClusterRules'
import { createMarkerElement, ensurePulseStyle, ensureSelectedMarkerStyle, type MapMarker } from '../lib/mapMarkers'

export type { MapMarker, MapMarkerKind } from '../lib/mapMarkers'

const DELHI_CENTER: [number, number] = [77.209, 28.6139]

export interface WardBoundaryFeatureProps {
  id: number
  name: string
  wardNumber: number | null
  jurisdictionType: 'mcd' | 'ndmc' | 'cantonment'
  /** AQI for 3D extrusion height/colour — null when the ward has no reading. */
  aqi: number | null
}

export interface WindArrowProps {
  ward_id: number
  wind_dir: number
  wind_speed: number
}

// ── Incident GL layer constants ──────────────────────────────────────────────
const INCIDENT_SOURCE_ID = 'incidents'
const INCIDENT_CLUSTER_LAYER = 'incidents-clusters'
const INCIDENT_CLUSTER_COUNT_LAYER = 'incidents-cluster-count'
const INCIDENT_POINT_HALO_LAYER = 'incidents-point-halo'
const INCIDENT_POINT_LAYER = 'incidents-points'

// Hex colors matching the existing SEVERITY_HEX palette (mapMarkers.ts)
const SEVERITY_SEVERE_HEX = '#ef4444'  // status.critical
const SEVERITY_HIGH_HEX = '#f59e0b'    // status.warning
const SEVERITY_MODERATE_HEX = '#fbbf24'
const SEVERITY_LOW_HEX = '#94a3b8'

function incidentCircleColor(orderProp: string): maplibregl.ExpressionSpecification {
  return ['case',
    ['>=', ['get', orderProp], 3], SEVERITY_SEVERE_HEX,
    ['>=', ['get', orderProp], 2], SEVERITY_HIGH_HEX,
    ['>=', ['get', orderProp], 1], SEVERITY_MODERATE_HEX,
    SEVERITY_LOW_HEX,
  ]
}

// ── Ward boundary GL layer constants ─────────────────────────────────────────
const BOUNDARY_SOURCE_ID = 'ward-boundaries'
const BOUNDARY_FILL_LAYER_ID = 'ward-boundaries-fill'
const BOUNDARY_LINE_LAYER_ID = 'ward-boundaries-line'
const BOUNDARY_EXTRUSION_LAYER_ID = 'ward-boundaries-extrusion'

// ── Wind arrow GL layer constants ─────────────────────────────────────────────
const WIND_SOURCE_ID = 'wind-arrows'
const WIND_LAYER_ID = 'wind-arrows-layer'
const WIND_IMAGE_ID = 'wind-arrow-img'

// ── City buildings + AQI heatmap constants ────────────────────────────────────
const BUILDINGS_LAYER_ID = 'city-buildings-3d'
const AQI_HEATMAP_SOURCE_ID = 'aqi-station-heatmap'
const AQI_HEATMAP_LAYER_ID = 'aqi-station-heatmap-layer'

// ── VoxCity-inspired environment layers ───────────────────────────────────────
const VEGETATION_LAYER_ID = 'osm-vegetation-3d'
const LANDCOVER_TREES_LAYER_ID = 'osm-landcover-trees'
const LANDUSE_LAYER_ID = 'osm-landuse-fill'
const WATER_LAYER_ID = 'osm-water-fill'
const TERRAIN_SOURCE_ID = 'maptiler-terrain-dem'
// AQI-elevation and building/vegetation extrusions render relative to this
// surface once active — real relief (subtly, the Delhi Ridge), not decoration.
const TERRAIN_EXAGGERATION = 1.3
const TOOL_SOURCE_ID = 'gis-tool-overlay'
const TOOL_LINE_LAYER_ID = 'gis-tool-line'
const TOOL_FILL_LAYER_ID = 'gis-tool-fill'
// Quieter defaults let markers remain the primary focal point at city zoom;
// hover/select progressively reveal the polygon for spatial orientation.
const FILL_OPACITY_DEFAULT = 0.015  // near-transparent at city zoom
const FILL_OPACITY_HOVER = 0.07
const FILL_OPACITY_SELECTED = 0.14
const LINE_WIDTH_HOVER = 1.5
const LINE_WIDTH_SELECTED = 2.5
const COLOR_DEFAULT = '#8da6c0'  // muted slate-blue (not interaction blue)
const COLOR_HOVER = '#3b82f6'    // blue-500
const COLOR_SELECTED = '#2563eb' // blue-600

// Feature-state expressions: MapLibre evaluates these per-feature at render
// time, so hover/selected state changes without any setPaintProperty() call.
// Requires promoteId:'id' on the source (below) so feature state keyed by
// ward.id resolves correctly.
function featureFillColorExpr(): maplibregl.ExpressionSpecification {
  return ['case',
    ['boolean', ['feature-state', 'selected'], false], COLOR_SELECTED,
    ['boolean', ['feature-state', 'hover'], false], COLOR_HOVER,
    COLOR_DEFAULT,
  ]
}
function featureFillOpacityExpr(): maplibregl.ExpressionSpecification {
  return ['case',
    ['boolean', ['feature-state', 'selected'], false], FILL_OPACITY_SELECTED,
    ['boolean', ['feature-state', 'hover'], false], FILL_OPACITY_HOVER,
    FILL_OPACITY_DEFAULT,
  ]
}
function featureLineColorExpr(): maplibregl.ExpressionSpecification {
  return ['case',
    ['boolean', ['feature-state', 'selected'], false], COLOR_SELECTED,
    ['boolean', ['feature-state', 'hover'], false], COLOR_HOVER,
    COLOR_DEFAULT,
  ]
}
function featureLineWidthExpr(): maplibregl.ExpressionSpecification {
  // 'zoom' may only be the input to a top-level 'step' or 'interpolate'
  // expression (MapLibre rule).  Feature-state cases must be nested inside
  // the stop values rather than wrapping the interpolate — the previous
  // ['case', ..., ['interpolate', ['zoom'], ...]] form triggered a console
  // warning on every style load.  The visual behaviour is identical: outlines
  // thin at citywide zoom and widen at ward zoom; hover/selected override
  // at whichever width the zoom would otherwise produce.
  return ['interpolate', ['linear'], ['zoom'],
    9, ['case',
        ['boolean', ['feature-state', 'selected'], false], LINE_WIDTH_SELECTED,
        ['boolean', ['feature-state', 'hover'], false], LINE_WIDTH_HOVER,
        0.45],
    12, ['case',
        ['boolean', ['feature-state', 'selected'], false], LINE_WIDTH_SELECTED,
        ['boolean', ['feature-state', 'hover'], false], LINE_WIDTH_HOVER,
        0.65],
    14, ['case',
        ['boolean', ['feature-state', 'selected'], false], LINE_WIDTH_SELECTED,
        ['boolean', ['feature-state', 'hover'], false], LINE_WIDTH_HOVER,
        1.0],
  ]
}

// AQI → extrusion colour (CPCB category breakpoints).
// ['get','aqi'] returns null when the property value is null; coalesce
// handles that directly — do NOT wrap in to-number first because
// to-number(null) === 0 in MapLibre, which would collapse no-data into
// the "Good" green bucket instead of the grey no-data default.
function aqiExtrusionColorExpr(): maplibregl.ExpressionSpecification {
  return ['step',
    ['coalesce', ['get', 'aqi'], -1],
    '#94a3b8',   // < 0  (null / no data)
    0, '#55a84f',
    50, '#a3c853',
    100, '#fff833',
    200, '#f29c2b',
    300, '#e93f33',
    400, '#af2d24',
  ]
}

// AQI * 8 m so AQI 500 → 4 000 m — dramatic but readable at pitch 45°
// coalesce before multiply: null AQI → 0 → no extrusion (flat ward).
function aqiExtrusionHeightExpr(): maplibregl.ExpressionSpecification {
  return ['*', ['coalesce', ['get', 'aqi'], 0], 8]
}

/** Returns an ImageData of a filled arrowhead pointing north (rotated at render time). */
function createWindArrowImage(): ImageData {
  const size = 48
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return new ImageData(size, size)
  const cx = size / 2
  const tip = 6
  const baseY = size - 8
  const hw = 9
  ctx.clearRect(0, 0, size, size)
  ctx.shadowColor = 'rgba(0,0,0,0.35)'
  ctx.shadowBlur = 4
  ctx.shadowOffsetY = 1
  ctx.fillStyle = 'rgba(30, 100, 220, 0.92)'
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(cx, tip)
  ctx.lineTo(cx + hw, baseY)
  ctx.lineTo(cx, baseY - 7)
  ctx.lineTo(cx - hw, baseY)
  ctx.closePath()
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.stroke()
  return ctx.getImageData(0, 0, size, size)
}

/** Scan the loaded basemap style for the vector tile source that contains a
 *  given OpenMapTiles source-layer name (e.g. 'building', 'landuse',
 *  'landcover'). Skips our own layer IDs so it never returns our own sources.
 *  All OmT-compatible providers (MapTiler, CARTO GL, Protomaps) put every
 *  source-layer in a single vector source, so any match gives the right name. */
function detectVectorSource(map: maplibregl.Map, sourceLayer: string, ...excludeIds: string[]): string | null {
  const skip = new Set(excludeIds)
  const style = map.getStyle()
  if (!style?.layers) return null
  for (const layer of style.layers) {
    if ('source-layer' in layer && !skip.has(layer.id)) {
      const sl = (layer as { 'source-layer'?: string })['source-layer']
      if (sl === sourceLayer) return (layer as { source?: string }).source ?? null
    }
  }
  return null
}

/** Properties stored on each incident GeoJSON feature (built in MapPage). */
export interface IncidentFeatureProps {
  id: number
  severity: string | null
  /** Numeric rank (0–3) matching SEVERITY_RANK; used for cluster aggregation. */
  severity_order: number
  /** 1 if severe, else 0 — used for cluster count aggregation. */
  is_severe: number
  is_high: number
  is_moderate: number
  /** 1 if low or null severity, else 0. */
  is_low: number
  /** Age in minutes from created_at; used for cluster max aggregation. */
  age_minutes: number
  summary: string | null
}

interface Props {
  markers?: MapMarker[]
  center?: [number, number]
  zoom?: number
  /** Basemap style URL or inline style spec - defaults to the keyless CARTO
   *  fallback, exactly the map's behaviour before the basemap switcher
   *  existed (just a nicer default style than the original MapLibre demo). */
  styleUrl?: string | StyleSpecification
  showScaleBar?: boolean
  onMarkerClick?: (marker: MapMarker) => void
  onHoverCoordinates?: (coords: { lng: number; lat: number } | null) => void
  /** [lng, lat] pairs to fit the viewport to - e.g. "Reset view"/"Fit to city". */
  fitBoundsTo?: [number, number][]
  /** Real ward boundary polygons (Supabase `wards.boundary`, Phase 2 import)
   *  - never hardcoded. Omitted/empty means nothing to draw; the layer
   *    control already reflects that by disabling the toggle (MapPage.tsx). */
  wardBoundaries?: FeatureCollection<Polygon | MultiPolygon, WardBoundaryFeatureProps>
  showWardBoundaries?: boolean
  selectedBoundaryId?: number | null
  onBoundaryClick?: (ward: WardBoundaryFeatureProps) => void
  /** DOM-marker selection highlight (stations + incidents). Ward boundaries
   *  use MapLibre feature state instead; this prop drives a CSS class toggle
   *  without recreating markers — safe to change on every selection. */
  selectedMarkerId?: string | null
  /** GeoJSON source for incident clustering. Each feature must carry
   *  IncidentFeatureProps on its properties. Omit to disable incident GL layers. */
  incidentGeoJSON?: FeatureCollection<Point, IncidentFeatureProps>
  /** Called when a single incident point is clicked. */
  onIncidentClick?: (incidentId: number) => void
  /**
   * Called when a cluster is clicked and resolved to a leaf set. MapPage
   * uses this to show IncidentClusterPanel. Not called for zoom-in clusters.
   */
  onClusterSelect?: (incidentIds: number[]) => void
  /** Incident id whose GL feature should show the blue selection halo. */
  selectedIncidentId?: number | null
  /** When true, incident layers render at reduced opacity so station
   *  freshness markers remain the focal point (Data Quality mode). */
  dataQualityMode?: boolean
  /** Extrude ward polygons by AQI — tilts map to pitch 45 while active. */
  show3D?: boolean
  /** Point GeoJSON with WindArrowProps to render directional wind arrows. */
  windGeoJSON?: FeatureCollection<Point, WindArrowProps>
  /** Toggle wind arrow layer visibility. */
  showWind?: boolean
  /** Extrude real OSM building footprints from the basemap vector tile source. */
  showBuildings3D?: boolean
  /** Toggle the AQI station heatmap layer. */
  showAqiHeatmap?: boolean
  /** Station points with aqi weight — source for the heatmap layer. */
  stationHeatmapGeoJSON?: FeatureCollection<Point, { aqi: number }>
  /** Render parks/forests/grass as green 3D blocks (VoxCity-style canopy). */
  showVegetation3D?: boolean
  /** Colour-code land use polygons (industrial/commercial/residential). */
  showLandUse?: boolean
  /** Stable string key derived from the current selection in MapPage.  When
   *  it changes to a value that does not match the spiderfy stack's owner,
   *  the expansion is collapsed.  Defaults to 'none' (no selection). */
  selectionKey?: string
  /** Coordinates [lng, lat] of the currently selected incident.  Used to
   *  pin a DOM marker overlay that stays visible even when the incident is
   *  absorbed into a cluster at lower zoom.  Null removes the overlay. */
  selectedIncidentCoords?: [number, number] | null
  /** Which GIS analysis tool is active - gates map click handling so a tool
   *  click (placing a measure point / buffer center) is never also
   *  interpreted as marker/boundary/incident selection. */
  activeToolKind?: 'none' | 'measure' | 'buffer'
  /** Called with the clicked map coordinate while a tool is active. */
  onToolClick?: (lngLat: { lng: number; lat: number }) => void
  /** Measure line / buffer circle geometry to render - built in MapPage.tsx
   *  (pure geometry, not map-lifecycle logic), same pattern as
   *  wardBoundaries/windGeoJSON below. */
  toolGeoJSON?: FeatureCollection
}

/**
 * Shared map canvas - embedded bare (no props) by CitizenView.tsx/FieldView.tsx
 * as a small context map, and with the full prop set by MapPage.tsx's spatial
 * console. Every prop here is optional and additive: omitting all of them
 * reproduces the exact behaviour this component had before the Map page
 * redesign, so the two bare embeds are unaffected.
 */
export default function MapView({
  markers = [],
  center,
  zoom = 9,
  styleUrl,
  showScaleBar = false,
  onMarkerClick,
  onHoverCoordinates,
  fitBoundsTo,
  wardBoundaries,
  showWardBoundaries = false,
  selectedBoundaryId = null,
  onBoundaryClick,
  selectedMarkerId = null,
  incidentGeoJSON,
  onIncidentClick,
  onClusterSelect,
  selectedIncidentId = null,
  dataQualityMode = false,
  show3D = false,
  windGeoJSON,
  showWind = false,
  showBuildings3D = false,
  showAqiHeatmap = false,
  stationHeatmapGeoJSON,
  showVegetation3D = false,
  showLandUse = false,
  selectionKey = 'none',
  selectedIncidentCoords = null,
  activeToolKind = 'none',
  onToolClick,
  toolGeoJSON,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  // Exposed via state so child components (WindParticles) can access the map
  // instance. Set once in the mount effect; never causes a map re-creation.
  const [mapInstance, setMapInstance] = useState<maplibregl.Map | null>(null)

  // Ward-boundary GL layers are wiped by every setStyle() call (unlike the
  // DOM-based markers below, which survive it) and are read from inside
  // event callbacks registered once at map creation - both need the latest
  // values without re-registering listeners, hence refs kept in sync here.
  const wardBoundariesRef = useRef(wardBoundaries)
  const showWardBoundariesRef = useRef(showWardBoundaries)
  const selectedBoundaryIdRef = useRef(selectedBoundaryId)
  const onBoundaryClickRef = useRef(onBoundaryClick)
  // Set once inside the mount effect below (it needs `map`, only available
  // there) - the wardBoundaries-change effect calls it too, so a fresh
  // arrival of data can create the source/layers for the first time, not
  // just update one that (incorrectly) assumed to already exist.
  const ensureBoundaryLayersRef = useRef<(() => void) | null>(null)
  // Tracks the last-highlighted ward so its selected feature state can be
  // cleared before the next one is set (setFeatureState doesn't auto-clear).
  const prevSelectedBoundaryIdRef = useRef<number | null>(null)
  // Latched true exactly once, by the map's own one-time 'load' event (set
  // in the mount effect below). Deliberately NOT map.isStyleLoaded(): that
  // check also goes false whenever a GeoJSON source is mid-reprocessing
  // after setData() - completely unrelated to whether the STYLE has ever
  // loaded, but indistinguishable from it by that call alone. A toggle
  // click landing in that reprocessing window would see isStyleLoaded()
  // report false and fall back to waiting on 'style.load' - an event that
  // only fires for real style (re)loads, never for a source data update,
  // so it would then wait forever. This ref sidesteps that entirely: once
  // the map has loaded for the first time, every later effect below can
  // apply its change immediately, with no event-based fallback needed.
  const mapReadyRef = useRef(false)

  // ── 3D extrusion + wind refs ──────────────────────────────────────────────
  const show3DRef = useRef(show3D)
  const showWindRef = useRef(showWind)
  const windGeoJSONRef = useRef(windGeoJSON)
  const ensureWindLayerRef = useRef<(() => void) | null>(null)

  // ── Buildings 3D + AQI heatmap refs ──────────────────────────────────────
  const showBuildings3DRef = useRef(showBuildings3D)
  const showAqiHeatmapRef = useRef(showAqiHeatmap)
  const stationHeatmapGeoJSONRef = useRef(stationHeatmapGeoJSON)
  const showVegetation3DRef = useRef(showVegetation3D)
  const showLandUseRef = useRef(showLandUse)

  // ── GIS tool (measure/buffer) refs ────────────────────────────────────────
  const activeToolKindRef = useRef(activeToolKind)
  const onToolClickRef = useRef(onToolClick)
  const toolGeoJSONRef = useRef(toolGeoJSON)
  const ensureToolLayersRef = useRef<(() => void) | null>(null)
  useEffect(() => { activeToolKindRef.current = activeToolKind }, [activeToolKind])
  useEffect(() => { onToolClickRef.current = onToolClick }, [onToolClick])
  useEffect(() => { toolGeoJSONRef.current = toolGeoJSON }, [toolGeoJSON])

  // ── Incident GL layer refs ────────────────────────────────────────────────
  const incidentGeoJSONRef = useRef(incidentGeoJSON)
  const onIncidentClickRef = useRef(onIncidentClick)
  const onClusterSelectRef = useRef(onClusterSelect)
  const dataQualityModeRef = useRef(dataQualityMode)
  const ensureIncidentLayersRef = useRef<(() => void) | null>(null)
  // Tracks the last highlighted incident so its feature state can be cleared.
  const prevSelectedIncidentIdRef = useRef<number | null>(null)
  // DOM markers created during a spiderfy expansion — cleared on next cluster
  // action or when the incident GL layers are torn down.
  const spiderfyMarkersRef = useRef<maplibregl.Marker[]>([])
  // Tracks which selectionKey created the current spiderfy stack so the
  // selectionKey effect can distinguish "the click that opened this" from
  // "a different selection that should close it".
  const spiderfyOwnerKeyRef = useRef<string | null>(null)
  // Single DOM marker overlaid on the selected incident's true coordinates.
  const selectedOverlayMarkerRef = useRef<maplibregl.Marker | null>(null)
  // Shared popup for cluster tooltip (single instance avoids DOM leak).
  const clusterPopupRef = useRef<maplibregl.Popup | null>(null)

  useEffect(() => {
    incidentGeoJSONRef.current = incidentGeoJSON
  }, [incidentGeoJSON])
  useEffect(() => {
    onIncidentClickRef.current = onIncidentClick
  }, [onIncidentClick])
  useEffect(() => {
    onClusterSelectRef.current = onClusterSelect
  }, [onClusterSelect])
  useEffect(() => {
    dataQualityModeRef.current = dataQualityMode
  }, [dataQualityMode])

  useEffect(() => { show3DRef.current = show3D }, [show3D])
  useEffect(() => { showWindRef.current = showWind }, [showWind])
  useEffect(() => { windGeoJSONRef.current = windGeoJSON }, [windGeoJSON])
  useEffect(() => { showBuildings3DRef.current = showBuildings3D }, [showBuildings3D])
  useEffect(() => { showAqiHeatmapRef.current = showAqiHeatmap }, [showAqiHeatmap])
  useEffect(() => { stationHeatmapGeoJSONRef.current = stationHeatmapGeoJSON }, [stationHeatmapGeoJSON])
  useEffect(() => { showVegetation3DRef.current = showVegetation3D }, [showVegetation3D])
  useEffect(() => { showLandUseRef.current = showLandUse }, [showLandUse])

  useEffect(() => {
    wardBoundariesRef.current = wardBoundaries
  }, [wardBoundaries])
  useEffect(() => {
    showWardBoundariesRef.current = showWardBoundaries
  }, [showWardBoundaries])
  useEffect(() => {
    selectedBoundaryIdRef.current = selectedBoundaryId
  }, [selectedBoundaryId])
  useEffect(() => {
    onBoundaryClickRef.current = onBoundaryClick
  }, [onBoundaryClick])

  useEffect(() => {
    ensurePulseStyle()
    ensureSelectedMarkerStyle()
    if (!containerRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl ?? FALLBACK_STYLE,
      center: center ?? DELHI_CENTER,
      zoom,
    })
    // Reset here, not just at useRef's initial value: React StrictMode
    // (dev only) double-invokes effects on mount - mount, cleanup, mount
    // again - and this ref survives that cycle since it belongs to the
    // component, not to any one map instance. Without resetting it against
    // THIS particular map instance, the second (real) mount would see the
    // flag already flipped from the first, torn-down instance's run, and
    // wrongly skip protecting the map that's actually going to stay alive.
    skippedInitialStyleSwap.current = false

    // Previously silent: any MapLibre-level failure (a bad style response,
    // a tile 404, a WebGL error) had no listener at all, so the map just
    // stopped rendering with nothing in the console to explain why.
    map.on('error', (e) => {
      console.error('[MapView] map error:', e.error ?? e)
    })

    // WebGL context loss is a real browser-level failure mode for any
    // canvas-based renderer - GPU memory pressure, a tab backgrounded for a
    // while, a driver reset - and it leaves exactly this symptom: the map
    // was rendering fine, then silently goes blank with no error the app
    // ever sees, because nothing was listening for it. `preventDefault()`
    // on 'webglcontextlost' is required by the WebGL spec for the browser
    // to attempt restoration at all; without it the loss is permanent.
    // `ensureBoundaryLayersRef` already exists for exactly this kind of
    // "the GL state was thrown away, re-add my custom layers" recovery
    // (it's the same function 'style.load' below already relies on for a
    // basemap switch), so context restoration reuses it rather than
    // inventing a second recovery path.
    const canvas = map.getCanvas()
    const onContextLost = (e: Event) => {
      e.preventDefault()
      console.warn('[MapView] WebGL context lost - attempting recovery')
    }
    const onContextRestored = () => {
      console.warn('[MapView] WebGL context restored')
      ensureIncidentLayersRef.current?.()
      ensureBoundaryLayersRef.current?.()
    }
    canvas.addEventListener('webglcontextlost', onContextLost)
    canvas.addEventListener('webglcontextrestored', onContextRestored)

    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    if (showScaleBar) map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right')
    if (onHoverCoordinates) {
      map.on('mousemove', (e) => onHoverCoordinates({ lng: e.lngLat.lng, lat: e.lngLat.lat }))
      map.on('mouseout', () => onHoverCoordinates(null))
    }

    // Generic click handler for GIS tool modes (measure/buffer) - fires on
    // every click; the layer-scoped handlers below each check
    // activeToolKindRef themselves so a tool click is never also
    // interpreted as a marker/boundary/incident selection.
    map.on('click', (e) => {
      if (activeToolKindRef.current === 'none') return
      onToolClickRef.current?.({ lng: e.lngLat.lng, lat: e.lngLat.lat })
    })

    // Delegated listeners on the boundary fill layer - registered once, up
    // front. MapLibre only dispatches these once a layer with this id
    // actually exists, so this is safe even before the layer is first added
    // (initial data load) and keeps working across every later setStyle().
    map.on('click', BOUNDARY_FILL_LAYER_ID, (e) => {
      if (activeToolKindRef.current !== 'none') return
      const feature = e.features?.[0] as Feature<Polygon | MultiPolygon, WardBoundaryFeatureProps> | undefined
      if (feature) onBoundaryClickRef.current?.(feature.properties)
    })
    map.on('mouseenter', BOUNDARY_FILL_LAYER_ID, () => {
      if (activeToolKindRef.current !== 'none') return
      map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', BOUNDARY_FILL_LAYER_ID, () => {
      map.getCanvas().style.cursor = ''
    })

    // Hover state: track which feature is under the pointer and toggle
    // feature state so the paint expressions above (featureFill/LineColorExpr)
    // re-render the hovered ward without any setPaintProperty() call.
    let hoveredBoundaryId: number | null = null
    map.on('mousemove', BOUNDARY_FILL_LAYER_ID, (e) => {
      const id = e.features?.[0]?.properties?.id as number | undefined
      if (id == null) return
      if (hoveredBoundaryId !== null && hoveredBoundaryId !== id) {
        if (map.getSource(BOUNDARY_SOURCE_ID)) {
          map.setFeatureState({ source: BOUNDARY_SOURCE_ID, id: hoveredBoundaryId }, { hover: false })
        }
      }
      hoveredBoundaryId = id
      if (map.getSource(BOUNDARY_SOURCE_ID)) {
        map.setFeatureState({ source: BOUNDARY_SOURCE_ID, id }, { hover: true })
      }
    })
    map.on('mouseleave', BOUNDARY_FILL_LAYER_ID, () => {
      if (hoveredBoundaryId !== null) {
        if (map.getSource(BOUNDARY_SOURCE_ID)) {
          map.setFeatureState({ source: BOUNDARY_SOURCE_ID, id: hoveredBoundaryId }, { hover: false })
        }
        hoveredBoundaryId = null
      }
    })

    // ── Incident GL layers ───────────────────────────────────────────────────
    // Removes spiderfy DOM markers left over from a previous cluster expand.
    const clearSpiderfyMarkers = () => {
      spiderfyMarkersRef.current.forEach((m) => m.remove())
      spiderfyMarkersRef.current = []
      spiderfyOwnerKeyRef.current = null
    }

    const addIncidentLayers = () => {
      const data = incidentGeoJSONRef.current
      const dqMode = dataQualityModeRef.current

      // Tear down any stale layers first (after a style reload they're gone;
      // the checks below are no-ops in that case but make the first-run path
      // and the data-update path share the same branch).
      const existingSource = map.getSource(INCIDENT_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
      if (existingSource) {
        if (data) existingSource.setData(data)
        return
      }

      // No data yet — still register the (empty) source so click handlers
      // and style.load can safely call setData later.
      const emptyCollection: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
      map.addSource(INCIDENT_SOURCE_ID, {
        type: 'geojson',
        data: data ?? emptyCollection,
        cluster: true,
        clusterMaxZoom: INCIDENT_CLUSTER_MAX_ZOOM,
        clusterRadius: INCIDENT_CLUSTER_RADIUS,
        // Aggregate properties across cluster members for tooltip + styling.
        clusterProperties: {
          max_severity_order: ['max', ['get', 'severity_order']],
          count_severe: ['+', ['case', ['==', ['get', 'severity'], 'severe'], 1, 0]],
          count_high: ['+', ['case', ['==', ['get', 'severity'], 'high'], 1, 0]],
          count_moderate: ['+', ['case', ['==', ['get', 'severity'], 'moderate'], 1, 0]],
          count_low: ['+', ['get', 'is_low']],
          max_age_minutes: ['max', ['get', 'age_minutes']],
        } as unknown as Record<string, maplibregl.ExpressionSpecification>,
        // Use feature id for feature-state (individual incident selection halo).
        promoteId: 'id',
      })

      const alpha = dqMode ? 0.35 : 1

      // Cluster body circles
      map.addLayer({
        id: INCIDENT_CLUSTER_LAYER,
        type: 'circle',
        source: INCIDENT_SOURCE_ID,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': incidentCircleColor('max_severity_order'),
          'circle-radius': ['interpolate', ['linear'], ['get', 'point_count'], 2, 18, 10, 24, 50, 30],
          'circle-opacity': alpha,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff',
          'circle-stroke-opacity': alpha,
        },
      })

      // Cluster count labels
      map.addLayer({
        id: INCIDENT_CLUSTER_COUNT_LAYER,
        type: 'symbol',
        source: INCIDENT_SOURCE_ID,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': '{point_count_abbreviated}',
          'text-font': ['Noto Sans Regular'],
          'text-size': 12,
        },
        paint: {
          'text-color': '#fff',
          'text-opacity': alpha,
        },
      })

      // Selection halo — behind individual point, visible only when selected.
      map.addLayer({
        id: INCIDENT_POINT_HALO_LAYER,
        type: 'circle',
        source: INCIDENT_SOURCE_ID,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': 12,
          'circle-color': '#2563eb',
          'circle-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.25, 0],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#2563eb',
          'circle-stroke-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.8, 0],
        },
      })

      // Individual incident circles
      map.addLayer({
        id: INCIDENT_POINT_LAYER,
        type: 'circle',
        source: INCIDENT_SOURCE_ID,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': incidentCircleColor('severity_order'),
          'circle-radius': 7,
          'circle-opacity': alpha,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#fff',
          'circle-stroke-opacity': alpha,
        },
      })
    }

    ensureIncidentLayersRef.current = addIncidentLayers

    // Delegated click/hover listeners — registered once in mount, survive
    // style reloads (MapLibre dispatches these whenever the named layer exists).
    const clusterPopup = new maplibregl.Popup({ offset: 8, closeButton: false, closeOnClick: false })
    clusterPopupRef.current = clusterPopup

    map.on('mouseenter', INCIDENT_CLUSTER_LAYER, (e) => {
      if (activeToolKindRef.current !== 'none') return
      map.getCanvas().style.cursor = 'pointer'
      const props = e.features?.[0]?.properties
      if (!props) return
      const lngLat = (e.features![0]!.geometry as GeoJSON.Point).coordinates as [number, number]
      clusterPopup
        .setLngLat(lngLat)
        .setHTML(clusterTooltipHtml({
          point_count: props.point_count ?? 0,
          count_severe: props.count_severe ?? 0,
          count_high: props.count_high ?? 0,
          count_moderate: props.count_moderate ?? 0,
          count_low: props.count_low ?? 0,
          max_age_minutes: props.max_age_minutes ?? 0,
        }))
        .addTo(map)
    })
    map.on('mouseleave', INCIDENT_CLUSTER_LAYER, () => {
      map.getCanvas().style.cursor = ''
      clusterPopup.remove()
    })
    map.on('mouseenter', INCIDENT_POINT_LAYER, () => {
      if (activeToolKindRef.current === 'none') map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', INCIDENT_POINT_LAYER, () => { map.getCanvas().style.cursor = '' })

    // Cluster click: resolve leaves, zoom in or spiderfy.
    map.on('click', INCIDENT_CLUSTER_LAYER, async (e) => {
      if (activeToolKindRef.current !== 'none') return
      clearSpiderfyMarkers()
      const feature = e.features?.[0]
      if (!feature) return
      const clusterId = feature.properties?.cluster_id as number
      const source = map.getSource(INCIDENT_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
      if (!source) return

      const leaves = await source.getClusterLeaves(clusterId, Infinity, 0)
      const incidentIds = (leaves as GeoJSON.Feature<GeoJSON.Point>[])
        .map((f) => f.properties?.id as number)
        .filter((id) => id != null)

      const coords = (leaves as GeoJSON.Feature<GeoJSON.Point>[])
        .map((f) => f.geometry.coordinates as [number, number])
      const center = (feature.geometry as GeoJSON.Point).coordinates as [number, number]

      if (areIdenticalCoords(coords)) {
        // All incidents share the same coordinate — spiderfy instead of zoom.
        const legs = spiderfyLegs(incidentIds)
        const newMarkers = legs.map(({ incidentId, pixelOffset }) => {
          const el = document.createElement('div')
          el.style.cssText = `
            width:14px;height:14px;border-radius:3px;
            background:#2563eb;border:2px solid #fff;
            transform:rotate(45deg);cursor:pointer;
            box-shadow:0 1px 3px rgba(0,0,0,.4);
          `
          el.setAttribute('aria-label', `Incident ${incidentId}`)
          el.addEventListener('click', () => onIncidentClickRef.current?.(incidentId))
          const marker = new maplibregl.Marker({ element: el, offset: pixelOffset }).setLngLat(center).addTo(map)
          return marker
        })
        spiderfyMarkersRef.current = newMarkers
        // Record the key MapPage will derive for this cluster selection so the
        // selectionKey effect does not immediately clear what we just created.
        spiderfyOwnerKeyRef.current = `incidentCluster:${[...incidentIds].sort((a, b) => a - b).join(',')}`
        onClusterSelectRef.current?.(incidentIds)
      } else {
        // Different coordinates — zoom into cluster expansion zoom.
        const expansionZoom = await source.getClusterExpansionZoom(clusterId)
        const targetZoom = Math.min(expansionZoom + 0.5, INCIDENT_CLUSTER_MAX_ZOOM + 1)
        map.easeTo({ center, zoom: targetZoom })
        if (targetZoom > INCIDENT_CLUSTER_MAX_ZOOM) {
          // Still at/beyond max zoom — show panel for the resolved leaves.
          onClusterSelectRef.current?.(incidentIds)
        }
      }
    })

    // Individual incident click
    map.on('click', INCIDENT_POINT_LAYER, (e) => {
      if (activeToolKindRef.current !== 'none') return
      clearSpiderfyMarkers()
      const id = e.features?.[0]?.properties?.id as number | undefined
      if (id != null) onIncidentClickRef.current?.(id)
    })

    // Initialise on first load
    if (map.isStyleLoaded()) addIncidentLayers()
    else map.once('style.load', addIncidentLayers)
    map.on('style.load', addIncidentLayers)

    // ── Ward boundary layers ─────────────────────────────────────────────────
    const addBoundaryLayers = () => {
      const data = wardBoundariesRef.current
      if (!data) return
      const existingSource = map.getSource(BOUNDARY_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
      if (existingSource) {
        existingSource.setData(data)
        return
      }
      // promoteId:'id' tells MapLibre to use properties.id as the feature ID,
      // which is required for setFeatureState() keyed by ward.id to work.
      map.addSource(BOUNDARY_SOURCE_ID, { type: 'geojson', data, promoteId: 'id' })
      const visibility = showWardBoundariesRef.current ? 'visible' : 'none'
      map.addLayer({
        id: BOUNDARY_FILL_LAYER_ID,
        type: 'fill',
        source: BOUNDARY_SOURCE_ID,
        layout: { visibility },
        paint: {
          'fill-color': featureFillColorExpr(),
          'fill-opacity': featureFillOpacityExpr(),
        },
      })
      map.addLayer({
        id: BOUNDARY_LINE_LAYER_ID,
        type: 'line',
        source: BOUNDARY_SOURCE_ID,
        layout: { visibility },
        paint: {
          'line-color': featureLineColorExpr(),
          'line-width': featureLineWidthExpr(),
          'line-opacity': ['case',
            ['boolean', ['feature-state', 'selected'], false], 0.9,
            ['boolean', ['feature-state', 'hover'], false], 0.7,
            0.28,
          ] as maplibregl.ExpressionSpecification,
        },
      })
      // 3D extrusion layer — same source, hidden until show3D is toggled on.
      // fill-extrusion-height reads AQI from GeoJSON properties (not feature-state),
      // so MapPage must include aqi in wardBoundaryCollection feature properties.
      map.addLayer({
        id: BOUNDARY_EXTRUSION_LAYER_ID,
        type: 'fill-extrusion',
        source: BOUNDARY_SOURCE_ID,
        layout: { visibility: show3DRef.current ? 'visible' : 'none' },
        paint: {
          'fill-extrusion-color': aqiExtrusionColorExpr(),
          'fill-extrusion-height': aqiExtrusionHeightExpr(),
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.82,
        },
      })
      // Incident layers were registered before boundary layers so they
      // land below them in the render stack. Move them to the top so
      // clusters and individual incidents render above ward polygons.
      for (const id of [INCIDENT_CLUSTER_LAYER, INCIDENT_CLUSTER_COUNT_LAYER, INCIDENT_POINT_HALO_LAYER, INCIDENT_POINT_LAYER]) {
        if (map.getLayer(id)) map.moveLayer(id)
      }
    }
    ensureBoundaryLayersRef.current = addBoundaryLayers
    // 'style.load', not 'load': 'load' only ever fires once in the map's
    // whole lifetime, but a real basemap switch (or, before an earlier fix,
    // a redundant one) reloads the style again later - a fallback
    // registered on 'load' during any later reload would wait forever.
    // 'style.load' fires on every style transition, including the first,
    // so it's the correct event here specifically (creating the layers
    // fresh after any style change). The later effects below use
    // mapReadyRef instead - see its declaration for why.
    if (map.isStyleLoaded()) addBoundaryLayers()
    else map.once('style.load', addBoundaryLayers)
    // Persistent (not once): keeps the boundary layer alive across every
    // later basemap switch too, not just this initial load.
    map.on('style.load', addBoundaryLayers)

    // ── Wind arrow layer ─────────────────────────────────────────────────────
    const addWindLayer = () => {
      // Register the arrow image once per style load (stripped on setStyle)
      if (!map.hasImage(WIND_IMAGE_ID)) {
        map.addImage(WIND_IMAGE_ID, createWindArrowImage())
      }
      const data: FeatureCollection<Point, WindArrowProps> = windGeoJSONRef.current ?? { type: 'FeatureCollection', features: [] }
      const existingWindSource = map.getSource(WIND_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
      if (existingWindSource) {
        existingWindSource.setData(data)
        return
      }
      map.addSource(WIND_SOURCE_ID, { type: 'geojson', data })
      map.addLayer({
        id: WIND_LAYER_ID,
        type: 'symbol',
        source: WIND_SOURCE_ID,
        layout: {
          'icon-image': WIND_IMAGE_ID,
          // wind_dir is the direction wind comes FROM; rotate 180° to point
          // the arrow in the direction the air is actually moving.
          'icon-rotate': ['%', ['+', ['to-number', ['get', 'wind_dir']], 180], 360] as maplibregl.ExpressionSpecification,
          'icon-rotation-alignment': 'map',
          'icon-size': ['interpolate', ['linear'], ['to-number', ['get', 'wind_speed']],
            0, 0.45,
            5, 0.6,
            15, 0.9,
            25, 1.15,
          ] as maplibregl.ExpressionSpecification,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          // Wind particles (WindParticles canvas) replace arrows as the visual —
          // arrows stay registered because WIND_LAYER_ID is used as beforeId
          // for the buildings layer, but are never made visible.
          visibility: 'none',
        },
      })
    }
    ensureWindLayerRef.current = addWindLayer
    if (map.isStyleLoaded()) addWindLayer()
    else map.once('style.load', addWindLayer)
    map.on('style.load', addWindLayer)

    // ── City buildings 3D layer ────────────────────────────────────────────
    // Reads building footprints + heights from the basemap's own vector tile
    // source (auto-detected by scanning the loaded style for 'building'
    // source-layer). Only visible at zoom ≥ 13 so it doesn't affect city-
    // level overview. Inserted below wind arrows so arrows stay on top.
    const addBuildings3D = () => {
      if (map.getLayer(BUILDINGS_LAYER_ID)) return
      const buildingSource = detectVectorSource(map, 'building', BUILDINGS_LAYER_ID)
      if (!buildingSource) return
      map.addLayer(
        {
          id: BUILDINGS_LAYER_ID,
          type: 'fill-extrusion',
          source: buildingSource,
          'source-layer': 'building',
          minzoom: 13,
          layout: { visibility: showBuildings3DRef.current ? 'visible' : 'none' },
          paint: {
            'fill-extrusion-color': '#0f172a',
            'fill-extrusion-height': [
              'coalesce', ['get', 'render_height'], ['get', 'height'], 5,
            ] as maplibregl.ExpressionSpecification,
            'fill-extrusion-base': [
              'coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0,
            ] as maplibregl.ExpressionSpecification,
            'fill-extrusion-opacity': 0.92,
          },
        },
        WIND_LAYER_ID,
      )
    }
    if (map.isStyleLoaded()) addBuildings3D()
    else map.once('style.load', addBuildings3D)
    map.on('style.load', addBuildings3D)

    // ── AQI station heatmap layer ──────────────────────────────────────────
    // Smooth AQI gradient from real station readings. Source creates/updates
    // from stationHeatmapGeoJSONRef; layer inserted below ward fill so ward
    // polygons remain the primary spatial unit.
    const addAqiHeatmap = () => {
      const empty: FeatureCollection<Point, { aqi: number }> = { type: 'FeatureCollection', features: [] }
      const data = stationHeatmapGeoJSONRef.current ?? empty
      const existing = map.getSource(AQI_HEATMAP_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
      if (existing) {
        existing.setData(data)
        return
      }
      map.addSource(AQI_HEATMAP_SOURCE_ID, { type: 'geojson', data })
      map.addLayer(
        {
          id: AQI_HEATMAP_LAYER_ID,
          type: 'heatmap',
          source: AQI_HEATMAP_SOURCE_ID,
          layout: { visibility: showAqiHeatmapRef.current ? 'visible' : 'none' },
          paint: {
            'heatmap-weight': [
              'interpolate', ['linear'], ['coalesce', ['get', 'aqi'], 0], 0, 0, 500, 1,
            ] as maplibregl.ExpressionSpecification,
            'heatmap-intensity': [
              'interpolate', ['linear'], ['zoom'], 7, 0.8, 11, 2.0, 14, 3.5,
            ] as maplibregl.ExpressionSpecification,
            'heatmap-color': [
              'interpolate', ['linear'], ['heatmap-density'],
              0,    'rgba(0,0,0,0)',
              0.12, 'rgba(85,168,79,0.55)',
              0.30, 'rgba(163,200,83,0.70)',
              0.48, 'rgba(255,248,51,0.78)',
              0.64, 'rgba(242,156,43,0.86)',
              0.80, 'rgba(233,63,51,0.92)',
              1.0,  'rgba(175,45,36,0.97)',
            ] as maplibregl.ExpressionSpecification,
            'heatmap-radius': [
              'interpolate', ['linear'], ['zoom'], 7, 55, 10, 80, 14, 35,
            ] as maplibregl.ExpressionSpecification,
            'heatmap-opacity': 0.82,
          },
        },
        BOUNDARY_FILL_LAYER_ID,
      )
    }
    if (map.isStyleLoaded()) addAqiHeatmap()
    else map.once('style.load', addAqiHeatmap)
    map.on('style.load', addAqiHeatmap)

    // ── Water bodies (Yamuna + lakes) — base context always on ───────────
    // Renders the `water` OpenMapTiles source-layer as a vivid blue fill so
    // the Yamuna river reads clearly against the dark basemap. Always visible
    // when vector tiles are present — it's baseline geographic context, not a
    // data overlay, so no toggle is needed. Inserted above the AQI heatmap
    // so the river cuts cleanly through the green/yellow gradient.
    const addWater = () => {
      if (map.getLayer(WATER_LAYER_ID)) return
      const src = detectVectorSource(map, 'water', WATER_LAYER_ID)
      if (!src) return
      map.addLayer(
        {
          id: WATER_LAYER_ID,
          type: 'fill',
          source: src,
          'source-layer': 'water',
          layout: { visibility: 'visible' },
          paint: {
            'fill-color': '#0284c7',
            'fill-opacity': 0.80,
          },
        },
        BOUNDARY_FILL_LAYER_ID,
      )
    }
    if (map.isStyleLoaded()) addWater()
    else map.once('style.load', addWater)
    map.on('style.load', addWater)

    // ── Land use colour overlay (below vegetation, below ward fill) ───────
    // Colour-codes OSM land use polygons: industrial = orange, commercial =
    // amber, residential = muted blue. Uses 'landuse' OpenMapTiles source-
    // layer from whatever basemap is loaded. Inserted before BOUNDARY_FILL so
    // the ward fill (very low opacity) remains the top-most spatial reference.
    const addLandUse = () => {
      if (map.getLayer(LANDUSE_LAYER_ID)) return
      const src = detectVectorSource(map, 'landuse', LANDUSE_LAYER_ID, VEGETATION_LAYER_ID)
      if (!src) return
      map.addLayer(
        {
          id: LANDUSE_LAYER_ID,
          type: 'fill',
          source: src,
          'source-layer': 'landuse',
          filter: ['in', ['get', 'class'], ['literal', ['industrial', 'commercial', 'residential', 'retail', 'railway']]] as maplibregl.ExpressionSpecification,
          layout: { visibility: showLandUseRef.current ? 'visible' : 'none' },
          paint: {
            'fill-color': ['match', ['get', 'class'],
              'industrial',  '#c45c20',
              'commercial',  '#c49a20',
              'residential', '#3a6baa',
              'retail',      '#a04060',
              'railway',     '#505060',
              '#000000',
            ] as maplibregl.ExpressionSpecification,
            'fill-opacity': ['match', ['get', 'class'],
              'industrial',  0.48,
              'commercial',  0.42,
              'residential', 0.28,
              'retail',      0.38,
              'railway',     0.30,
              0,
            ] as maplibregl.ExpressionSpecification,
          },
        },
        BOUNDARY_FILL_LAYER_ID,
      )
    }
    if (map.isStyleLoaded()) addLandUse()
    else map.once('style.load', addLandUse)
    map.on('style.load', addLandUse)

    // ── Vegetation 3D layer (parks / forests as green blocks) ─────────────
    // Extrudes OSM park/forest/grass landuse polygons as low 3D green volumes
    // to approximate tree canopy — the VoxCity-style "urban vegetation" layer.
    // Height varies by class: forests 14 m, parks 8 m, grass 2 m.
    // Inserted above land-use and below ward fill so outlines read over trees.
    const addVegetation3D = () => {
      if (map.getLayer(VEGETATION_LAYER_ID)) return
      const src = detectVectorSource(map, 'landuse', VEGETATION_LAYER_ID, LANDUSE_LAYER_ID)
      if (!src) return
      map.addLayer(
        {
          id: VEGETATION_LAYER_ID,
          type: 'fill-extrusion',
          source: src,
          'source-layer': 'landuse',
          filter: ['in', ['get', 'class'], ['literal', ['park', 'forest', 'grass', 'cemetery']]] as maplibregl.ExpressionSpecification,
          layout: { visibility: showVegetation3DRef.current ? 'visible' : 'none' },
          paint: {
            'fill-extrusion-color': ['match', ['get', 'class'],
              'forest',    '#22c55e',
              'park',      '#4ade80',
              'grass',     '#86efac',
              'cemetery',  '#166534',
              '#22c55e',
            ] as maplibregl.ExpressionSpecification,
            'fill-extrusion-height': ['match', ['get', 'class'],
              'forest',   14,
              'park',      8,
              'grass',     2,
              'cemetery',  3,
              5,
            ] as maplibregl.ExpressionSpecification,
            'fill-extrusion-base': 0,
            'fill-extrusion-opacity': 0.85,
          },
        },
        BOUNDARY_FILL_LAYER_ID,
      )
    }
    if (map.isStyleLoaded()) addVegetation3D()
    else map.once('style.load', addVegetation3D)
    map.on('style.load', addVegetation3D)

    // ── Landcover trees (OSM `landcover.wood` — forest/tree-cover patches) ──
    // Supplements the `landuse.forest` layer with the separate `landcover`
    // source-layer which captures woodland not tagged as a land-use zone.
    // Uses the same showVegetation3D toggle and the same bright-green palette.
    const addLandcoverTrees = () => {
      if (map.getLayer(LANDCOVER_TREES_LAYER_ID)) return
      const src = detectVectorSource(map, 'landcover', LANDCOVER_TREES_LAYER_ID)
      if (!src) return
      map.addLayer(
        {
          id: LANDCOVER_TREES_LAYER_ID,
          type: 'fill-extrusion',
          source: src,
          'source-layer': 'landcover',
          filter: ['==', ['get', 'class'], 'wood'] as maplibregl.ExpressionSpecification,
          layout: { visibility: showVegetation3DRef.current ? 'visible' : 'none' },
          paint: {
            'fill-extrusion-color': '#1fa64a',
            'fill-extrusion-height': 12,
            'fill-extrusion-base': 0,
            'fill-extrusion-opacity': 0.80,
          },
        },
        BOUNDARY_FILL_LAYER_ID,
      )
    }
    if (map.isStyleLoaded()) addLandcoverTrees()
    else map.once('style.load', addLandcoverTrees)
    map.on('style.load', addLandcoverTrees)

    // Real, tiltable 3D terrain (a DEM mesh via setTerrain — distinct from
    // the "Terrain" basemap style, which is just a 2D hillshaded raster).
    // Universal across all 5 basemap modes, not a layer toggle: this is
    // base-map-level ground relief, like the always-on water layer, not a
    // data overlay competing for a commander's attention. No-key deployments
    // stay flat, the same graceful-degradation contract as buildings/
    // vegetation/land-use below. Delhi's relief is subtle (the Ridge) but
    // real and meteorologically relevant to local dispersion.
    const addTerrain = () => {
      const key = maptilerKey()
      if (!key) return
      if (!map.getSource(TERRAIN_SOURCE_ID)) {
        map.addSource(TERRAIN_SOURCE_ID, {
          type: 'raster-dem',
          url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${key}`,
          tileSize: 512,
          maxzoom: 14,
        })
      }
      map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: TERRAIN_EXAGGERATION })
    }
    if (map.isStyleLoaded()) addTerrain()
    else map.once('style.load', addTerrain)
    map.on('style.load', addTerrain)

    // Measure-distance / buffer-zone overlay - a single empty-by-default
    // GeoJSON source populated from MapPage's toolGeoJSON prop (pure
    // geometry built there, same pattern as wardBoundaries/windGeoJSON).
    // One `line` layer renders both the measure LineString and the buffer
    // Polygon's outline (MapLibre line layers draw polygon outlines too);
    // the `fill` layer only paints when a Polygon feature is present.
    const addToolLayers = () => {
      if (!map.getSource(TOOL_SOURCE_ID)) {
        map.addSource(TOOL_SOURCE_ID, {
          type: 'geojson',
          data: toolGeoJSONRef.current ?? { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getLayer(TOOL_FILL_LAYER_ID)) {
        map.addLayer({
          id: TOOL_FILL_LAYER_ID,
          type: 'fill',
          source: TOOL_SOURCE_ID,
          filter: ['==', ['geometry-type'], 'Polygon'] as maplibregl.ExpressionSpecification,
          paint: { 'fill-color': '#0F6CBD', 'fill-opacity': 0.08 },
        })
      }
      if (!map.getLayer(TOOL_LINE_LAYER_ID)) {
        map.addLayer({
          id: TOOL_LINE_LAYER_ID,
          type: 'line',
          source: TOOL_SOURCE_ID,
          paint: { 'line-color': '#0F6CBD', 'line-width': 2, 'line-dasharray': [2, 1.5] },
        })
      }
    }
    ensureToolLayersRef.current = addToolLayers
    if (map.isStyleLoaded()) addToolLayers()
    else map.once('style.load', addToolLayers)
    map.on('style.load', addToolLayers)

    map.once('load', () => {
      mapReadyRef.current = true
    })

    mapRef.current = map
    setMapInstance(map)
    return () => {
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      clearSpiderfyMarkers()
      clusterPopup.remove()
      selectedOverlayMarkerRef.current?.remove()
      selectedOverlayMarkerRef.current = null
      map.remove()
      mapRef.current = null
    }
    // Map instance created once - style/bounds/boundary-data changes are
    // handled by their own effects below rather than tearing down and
    // recreating the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Basemap swap on an already-live map - markers are DOM overlays
  // independent of the style, so they persist across setStyle() untouched.
  // Skips its very first run: the mount effect above already constructs the
  // map with `style: styleUrl`, so re-applying the identical URL here on
  // mount is a genuinely redundant setStyle() call - wasted bandwidth for
  // any real (network) style, and - critically - a full style reload that
  // silently strips whatever custom sources/layers (the ward-boundary
  // polygons) got added in the brief window before it completes. Real
  // basemap switches (the user picking a different mode) always change
  // `styleUrl`'s value after this initial skip, so they're unaffected.
  const skippedInitialStyleSwap = useRef(false)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleUrl) return
    if (!skippedInitialStyleSwap.current) {
      skippedInitialStyleSwap.current = true
      return
    }
    if (map.isStyleLoaded()) map.setStyle(styleUrl)
    else map.once('load', () => map.setStyle(styleUrl))
  }, [styleUrl])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !fitBoundsTo || fitBoundsTo.length === 0) return
    const bounds = fitBoundsTo.reduce(
      (b, coord) => b.extend(coord),
      new maplibregl.LngLatBounds(fitBoundsTo[0], fitBoundsTo[0]),
    )
    // minZoom is defense in depth on top of MapPage's own coordinate
    // validation - a bad point should never be able to zoom this out past
    // city scale, even in theory.
    // Extra right padding accounts for the ~256px contextual right panel so
    // selected features are not hidden behind it on fitBounds / Reset to Delhi.
    // Preserve pitch/bearing if 3D extrusion is active — fitBounds resets them
    // to 0 by default, which would flatten the map unexpectedly.
    const pitch = show3DRef.current ? 45 : 0
    const bearing = show3DRef.current ? -12 : 0
    map.fitBounds(bounds, { padding: { top: 48, bottom: 48, left: 48, right: 280 }, minZoom: 9, maxZoom: 13, duration: 600, pitch, bearing })
  }, [fitBoundsTo])

  // sync markers whenever they change (or map is ready)
  useEffect(() => {
    const map = mapRef.current
    if (!map || markers.length === 0) return

    // If the style isn't loaded yet, marker creation is deferred to the
    // 'load' event via map.once() below. If `markers` changes again before
    // that fires (very likely - MapPage.tsx's staggered async fetches
    // change `allMarkers`'s reference shortly after mount), React calls
    // THIS cleanup while addedMarkers/addedPopups are still empty (nothing
    // to remove yet), leaving the original once('load', addMarkers)
    // registration orphaned - it still fires later and adds a full "ghost"
    // generation of markers nothing can ever clean up. `cancelled` +
    // map.off() below close that race.
    let cancelled = false
    const addedMarkers: maplibregl.Marker[] = []
    const addedPopups: maplibregl.Popup[] = []

    const addMarkers = () => {
      if (cancelled) return
      for (const m of markers) {
        const el = createMarkerElement(m)
        const marker = new maplibregl.Marker({ element: el }).setLngLat([m.lng, m.lat]).addTo(map)
        // Popup is managed manually (not via marker.setPopup()) so hover
        // (preview) and click (select, via onMarkerClick) stay independent
        // instead of both fighting over the marker's built-in click-toggle.
        const popup = new maplibregl.Popup({ offset: 16, closeButton: false })
          .setLngLat([m.lng, m.lat])
          .setHTML(m.popupHtml)

        el.addEventListener('mouseenter', () => popup.addTo(map))
        el.addEventListener('mouseleave', () => popup.remove())
        el.addEventListener('click', () => onMarkerClick?.(m))

        addedMarkers.push(marker)
        addedPopups.push(popup)
      }
    }

    if (map.isStyleLoaded()) addMarkers()
    else map.once('load', addMarkers)

    return () => {
      cancelled = true
      map.off('load', addMarkers)
      addedMarkers.forEach((m) => m.remove())
      addedPopups.forEach((p) => p.remove())
    }
  }, [markers, onMarkerClick])

  // Push new/changed boundary data - creates the source/layers fresh if
  // this is their first arrival (MapPage.tsx's fetch resolves
  // asynchronously after mount, same staggered-load pattern as markers
  // above, so the mount effect above almost always runs before any real
  // data exists), or just updates them via setData if they already exist.
  // Gated on mapReadyRef, not isStyleLoaded() - see that ref's declaration.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !wardBoundaries) return
    const apply = () => ensureBoundaryLayersRef.current?.()
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [wardBoundaries])

  // Toggle layer visibility without touching the source/data. Gated on
  // mapReadyRef, not isStyleLoaded() - see that ref's declaration for why:
  // isStyleLoaded() can be transiently false here even long after the map
  // has genuinely finished loading, whenever the boundary source itself is
  // mid-reprocessing from its own setData() call above - a state a
  // 'style.load' fallback would never resolve, since that event doesn't
  // fire for source data changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const visibility = showWardBoundaries ? 'visible' : 'none'
    const apply = () => {
      if (map.getLayer(BOUNDARY_FILL_LAYER_ID)) map.setLayoutProperty(BOUNDARY_FILL_LAYER_ID, 'visibility', visibility)
      if (map.getLayer(BOUNDARY_LINE_LAYER_ID)) map.setLayoutProperty(BOUNDARY_LINE_LAYER_ID, 'visibility', visibility)
    }
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [showWardBoundaries])

  // Highlight the selected ward's polygon via feature state so the
  // paint expressions respond without any setPaintProperty() call.
  // Tracks the previous id in a ref to clear the old feature's state
  // before setting the new one (MapLibre doesn't auto-clear on change).
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const id = selectedBoundaryId ?? null
    const apply = () => {
      if (!map.getSource(BOUNDARY_SOURCE_ID)) return
      const prev = prevSelectedBoundaryIdRef.current
      if (prev !== null) {
        map.setFeatureState({ source: BOUNDARY_SOURCE_ID, id: prev }, { selected: false })
      }
      if (id !== null) {
        map.setFeatureState({ source: BOUNDARY_SOURCE_ID, id }, { selected: true })
      }
      prevSelectedBoundaryIdRef.current = id
    }
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [selectedBoundaryId])

  // Push fresh incident GeoJSON into the GL source (same gating pattern
  // as wardBoundaries above — mapReadyRef not isStyleLoaded()).
  // Also clears any live spiderfy DOM markers: their incident ids come
  // from the previous filtered set and are stale after a filter change.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !incidentGeoJSON) return
    spiderfyMarkersRef.current.forEach((m) => m.remove())
    spiderfyMarkersRef.current = []
    spiderfyOwnerKeyRef.current = null
    const apply = () => {
      const source = map.getSource(INCIDENT_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
      if (source) source.setData(incidentGeoJSON)
      else ensureIncidentLayersRef.current?.()
    }
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [incidentGeoJSON])

  // Collapse spiderfy whenever the selection key changes to something other
  // than the cluster that owns the current expansion.
  useEffect(() => {
    if (spiderfyMarkersRef.current.length === 0) return
    if (selectionKey !== spiderfyOwnerKeyRef.current) {
      spiderfyMarkersRef.current.forEach((m) => m.remove())
      spiderfyMarkersRef.current = []
      spiderfyOwnerKeyRef.current = null
    }
  }, [selectionKey])

  // DOM overlay marker anchored to the selected incident's true coordinates.
  // Rendered above all GL layers so it remains visible even when the incident
  // is absorbed into a cluster at lower zoom.
  useEffect(() => {
    selectedOverlayMarkerRef.current?.remove()
    selectedOverlayMarkerRef.current = null
    const map = mapRef.current
    if (!map || !selectedIncidentCoords) return
    const el = document.createElement('div')
    el.style.cssText = [
      'width:24px', 'height:24px',
      'border:3px solid #2563eb',
      'border-radius:50%',
      'background:rgba(37,99,235,0.12)',
      'box-shadow:0 0 0 5px rgba(37,99,235,0.18)',
      'pointer-events:none',
    ].join(';')
    el.setAttribute('aria-hidden', 'true')
    selectedOverlayMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(selectedIncidentCoords)
      .addTo(map)
  }, [selectedIncidentCoords])

  // Feature-state selection halo on individual incident points.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const id = selectedIncidentId ?? null
    const apply = () => {
      if (!map.getSource(INCIDENT_SOURCE_ID)) return
      const prev = prevSelectedIncidentIdRef.current
      if (prev !== null) {
        map.setFeatureState({ source: INCIDENT_SOURCE_ID, id: prev }, { selected: false })
      }
      if (id !== null) {
        map.setFeatureState({ source: INCIDENT_SOURCE_ID, id }, { selected: true })
      }
      prevSelectedIncidentIdRef.current = id
    }
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [selectedIncidentId])

  // Adjust incident layer opacity in Data Quality mode so station freshness
  // markers remain the spatial focus. Uses setPaintProperty rather than
  // recreating layers — no source data round-trip needed.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const alpha = dataQualityMode ? 0.35 : 1
    const apply = () => {
      if (map.getLayer(INCIDENT_CLUSTER_LAYER)) {
        map.setPaintProperty(INCIDENT_CLUSTER_LAYER, 'circle-opacity', alpha)
        map.setPaintProperty(INCIDENT_CLUSTER_LAYER, 'circle-stroke-opacity', alpha)
      }
      if (map.getLayer(INCIDENT_CLUSTER_COUNT_LAYER)) {
        map.setPaintProperty(INCIDENT_CLUSTER_COUNT_LAYER, 'text-opacity', alpha)
      }
      if (map.getLayer(INCIDENT_POINT_LAYER)) {
        map.setPaintProperty(INCIDENT_POINT_LAYER, 'circle-opacity', alpha)
        map.setPaintProperty(INCIDENT_POINT_LAYER, 'circle-stroke-opacity', alpha)
      }
    }
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [dataQualityMode])

  // Toggle 3D extrusion visibility and map pitch.
  // Camera movement has no layer dependency so easeTo fires unconditionally;
  // only setLayoutProperty needs the layer to exist (hence mapReadyRef guard).
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const applyVisibility = () => {
      if (map.getLayer(BOUNDARY_EXTRUSION_LAYER_ID)) {
        map.setLayoutProperty(BOUNDARY_EXTRUSION_LAYER_ID, 'visibility', show3D ? 'visible' : 'none')
      }
    }
    if (mapReadyRef.current) applyVisibility()
    else map.once('load', applyVisibility)
    // jumpTo is synchronous and cannot be cancelled by concurrent operations
    // (unlike easeTo which can be pre-empted by fitBounds or style reloads).
    // We jumpTo first to guarantee the camera state is set, then immediately
    // start an easeTo from the same position to produce a smooth animation.
    const targetPitch = show3D ? 45 : 0
    const targetBearing = show3D ? -12 : 0
    map.jumpTo({ pitch: targetPitch, bearing: targetBearing })
    map.easeTo({ pitch: targetPitch, bearing: targetBearing, duration: 600 })
  }, [show3D])

  // Push updated wind GeoJSON into the GL source
  useEffect(() => {
    const map = mapRef.current
    if (!map || !windGeoJSON) return
    const apply = () => {
      const source = map.getSource(WIND_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
      if (source) source.setData(windGeoJSON)
      else ensureWindLayerRef.current?.()
    }
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [windGeoJSON])

  // Wind arrows replaced by WindParticles canvas — no GL layer toggle needed.

  // Push updated measure/buffer geometry into the GL source
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      const source = map.getSource(TOOL_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
      const data = toolGeoJSON ?? { type: 'FeatureCollection' as const, features: [] }
      if (source) source.setData(data)
      else ensureToolLayersRef.current?.()
    }
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [toolGeoJSON])

  // Crosshair cursor while a GIS tool is active - the hover handlers above
  // (boundary/incident) already check activeToolKindRef before overriding
  // this with their own 'pointer' cursor, so it doesn't get clobbered.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    map.getCanvas().style.cursor = activeToolKind !== 'none' ? 'crosshair' : ''
  }, [activeToolKind])

  // Push updated station heatmap data into the GL source
  useEffect(() => {
    const map = mapRef.current
    if (!map || !stationHeatmapGeoJSON) return
    const apply = () => {
      const src = map.getSource(AQI_HEATMAP_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
      if (src) src.setData(stationHeatmapGeoJSON)
    }
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [stationHeatmapGeoJSON])

  // Toggle 3D city buildings visibility
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const vis = showBuildings3D ? 'visible' : 'none'
    const apply = () => {
      if (map.getLayer(BUILDINGS_LAYER_ID)) map.setLayoutProperty(BUILDINGS_LAYER_ID, 'visibility', vis)
    }
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [showBuildings3D])

  // Toggle AQI heatmap visibility
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const vis = showAqiHeatmap ? 'visible' : 'none'
    const apply = () => {
      if (map.getLayer(AQI_HEATMAP_LAYER_ID)) map.setLayoutProperty(AQI_HEATMAP_LAYER_ID, 'visibility', vis)
    }
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [showAqiHeatmap])

  // Toggle vegetation 3D visibility (covers both landuse + landcover layers)
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const vis = showVegetation3D ? 'visible' : 'none'
    const apply = () => {
      if (map.getLayer(VEGETATION_LAYER_ID)) map.setLayoutProperty(VEGETATION_LAYER_ID, 'visibility', vis)
      if (map.getLayer(LANDCOVER_TREES_LAYER_ID)) map.setLayoutProperty(LANDCOVER_TREES_LAYER_ID, 'visibility', vis)
    }
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [showVegetation3D])

  // Toggle land use overlay visibility
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const vis = showLandUse ? 'visible' : 'none'
    const apply = () => {
      if (map.getLayer(LANDUSE_LAYER_ID)) map.setLayoutProperty(LANDUSE_LAYER_ID, 'visibility', vis)
    }
    if (mapReadyRef.current) apply()
    else map.once('load', apply)
  }, [showLandUse])

  // Toggle the selected CSS class on the appropriate DOM marker element.
  // Uses a querySelectorAll on the map container rather than recreating all
  // markers — safe to run on every selection change with no flicker.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.querySelectorAll<HTMLElement>('.vg-marker-selected').forEach((el) => {
      el.classList.remove('vg-marker-selected')
    })
    if (selectedMarkerId) {
      const el = container.querySelector<HTMLElement>(`[data-marker-id="${CSS.escape(selectedMarkerId)}"]`)
      el?.classList.add('vg-marker-selected')
    }
  }, [selectedMarkerId])

  // Extract point data for the particle system from the GL GeoJSON source
  // (which already has the right ward centroid positions + wind readings).
  const windPoints = useMemo(
    () =>
      (windGeoJSON?.features ?? []).map((f) => ({
        lng: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        dir: f.properties.wind_dir,
        speed: f.properties.wind_speed,
      })),
    [windGeoJSON],
  )

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} className="h-full w-full" />
      <WindParticles map={mapInstance} points={windPoints} visible={showWind} />
    </div>
  )
}
