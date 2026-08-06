import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson'
import maplibregl, { type StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useRef } from 'react'
import { FALLBACK_STYLE } from '../lib/basemaps'
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
  // Default case uses zoom-interpolation so outlines thin at citywide view
  // and widen slightly when zoomed to ward level — interaction blue stays
  // reserved for hover and selected states.
  return ['case',
    ['boolean', ['feature-state', 'selected'], false], LINE_WIDTH_SELECTED,
    ['boolean', ['feature-state', 'hover'], false], LINE_WIDTH_HOVER,
    ['interpolate', ['linear'], ['zoom'], 9, 0.45, 12, 0.65, 14, 1.0],
  ]
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
  /** Stable string key derived from the current selection in MapPage.  When
   *  it changes to a value that does not match the spiderfy stack's owner,
   *  the expansion is collapsed.  Defaults to 'none' (no selection). */
  selectionKey?: string
  /** Coordinates [lng, lat] of the currently selected incident.  Used to
   *  pin a DOM marker overlay that stays visible even when the incident is
   *  absorbed into a cluster at lower zoom.  Null removes the overlay. */
  selectedIncidentCoords?: [number, number] | null
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
  selectionKey = 'none',
  selectedIncidentCoords = null,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)

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

    // Delegated listeners on the boundary fill layer - registered once, up
    // front. MapLibre only dispatches these once a layer with this id
    // actually exists, so this is safe even before the layer is first added
    // (initial data load) and keeps working across every later setStyle().
    map.on('click', BOUNDARY_FILL_LAYER_ID, (e) => {
      const feature = e.features?.[0] as Feature<Polygon | MultiPolygon, WardBoundaryFeatureProps> | undefined
      if (feature) onBoundaryClickRef.current?.(feature.properties)
    })
    map.on('mouseenter', BOUNDARY_FILL_LAYER_ID, () => {
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
    map.on('mouseenter', INCIDENT_POINT_LAYER, () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', INCIDENT_POINT_LAYER, () => { map.getCanvas().style.cursor = '' })

    // Cluster click: resolve leaves, zoom in or spiderfy.
    map.on('click', INCIDENT_CLUSTER_LAYER, async (e) => {
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
    map.once('load', () => {
      mapReadyRef.current = true
    })

    mapRef.current = map
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
    map.fitBounds(bounds, { padding: { top: 48, bottom: 48, left: 48, right: 280 }, minZoom: 9, maxZoom: 13, duration: 600 })
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

  return <div ref={containerRef} className="h-full w-full" />
}
