/**
 * A minimal embedded MapLibre map for placing or moving an incident's location.
 *
 * Responsibilities:
 *  - Show Delhi ward boundaries (read-only)
 *  - Show the existing incident point (orange pin) when valid
 *  - Show a draggable placement marker (blue pin) at the proposed location
 *  - On click/drag emit the new [lat, lng] to the parent
 *  - Display real-time coordinates and containing ward at the proposed point
 *
 * This intentionally does NOT reuse MapView.tsx: that component manages
 * app-level layers, filters, and selection state. LocationPickerMap is
 * self-contained for the remediation workspace.
 */
import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { WardBoundary } from '../../lib/data'
import { DELHI_CENTER, DELHI_DEFAULT_ZOOM } from '../../lib/mapRules'
import { findContainingWard } from '../../lib/incidentLocationRules'

const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

interface Props {
  /** Ward boundaries for the fill layer. */
  wardBoundaries: WardBoundary[]
  /** Existing (possibly invalid) incident coordinates — shown as an orange pin. */
  existingLat?: number | null
  existingLng?: number | null
  /** Current proposed placement — shown as a draggable blue pin. */
  proposedLat: number | null
  proposedLng: number | null
  /** Called whenever the user places or moves the blue pin. */
  onChange: (lat: number, lng: number) => void
  /** Notifies parent of the containing ward at the proposed point. */
  onWardResolved: (ward: { id: number; name: string; wardNumber: number | null } | null) => void
}

export default function LocationPickerMap({
  wardBoundaries,
  existingLat,
  existingLng,
  proposedLat,
  proposedLng,
  onChange,
  onWardResolved,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const existingMarkerRef = useRef<maplibregl.Marker | null>(null)
  const proposedMarkerRef = useRef<maplibregl.Marker | null>(null)
  const [mapReady, setMapReady] = useState(false)

  // ── Initialise map ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const container = containerRef.current
    let map: maplibregl.Map | null = null

    function initMap() {
      if (map || !container.offsetWidth || !container.offsetHeight) return

      map = new maplibregl.Map({
        container,
        style: BASEMAP_STYLE,
        center: DELHI_CENTER,
        zoom: DELHI_DEFAULT_ZOOM,
        attributionControl: false,
      })

      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')

      map.on('load', () => {
        const geojson: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features: wardBoundaries
            .filter((w) => w.geometry)
            .map((w) => ({
              type: 'Feature',
              id: w.id,
              properties: { id: w.id, name: w.name },
              geometry: w.geometry,
            })),
        }

        map!.addSource('wards', { type: 'geojson', data: geojson })
        map!.addLayer({
          id: 'ward-fill',
          type: 'fill',
          source: 'wards',
          paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.04 },
        })
        map!.addLayer({
          id: 'ward-line',
          type: 'line',
          source: 'wards',
          paint: { 'line-color': '#94a3b8', 'line-width': 0.8, 'line-opacity': 0.5 },
        })

        setMapReady(true)
      })

      map.on('click', (e) => {
        onChange(e.lngLat.lat, e.lngLat.lng)
      })

      map.getCanvas().style.cursor = 'crosshair'
      mapRef.current = map
    }

    // ResizeObserver: initialises the map once the container has non-zero
    // dimensions (deferred init), then keeps the map sized correctly on any
    // subsequent layout change. This handles the case where MapLibre is
    // mounted before the flex layout has committed real pixel dimensions.
    const ro = new ResizeObserver(() => {
      if (!mapRef.current) initMap()
      else mapRef.current.resize()
    })
    ro.observe(container)

    // Also try immediately in case the container already has dimensions.
    initMap()

    return () => {
      ro.disconnect()
      if (map) {
        map.remove()
        mapRef.current = null
        setMapReady(false)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Existing-location marker (orange, non-draggable) ─────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    existingMarkerRef.current?.remove()

    if (existingLat != null && existingLng != null) {
      const el = document.createElement('div')
      el.style.cssText = `
        width:14px; height:14px; border-radius:50%;
        background:#f97316; border:2px solid white;
        box-shadow:0 1px 3px rgba(0,0,0,.4);
        cursor:default;
      `
      el.title = 'Current coordinates'
      existingMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([existingLng, existingLat])
        .addTo(mapRef.current)
    }
  }, [mapReady, existingLat, existingLng])

  // ── Proposed-location marker (blue, draggable) ───────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    proposedMarkerRef.current?.remove()

    if (proposedLat != null && proposedLng != null) {
      const el = document.createElement('div')
      el.style.cssText = `
        width:18px; height:18px; border-radius:50%;
        background:#2563eb; border:3px solid white;
        box-shadow:0 2px 4px rgba(0,0,0,.5);
        cursor:grab;
      `
      el.title = 'Drag to adjust position'

      const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([proposedLng, proposedLat])
        .addTo(mapRef.current)

      marker.on('dragend', () => {
        const pos = marker.getLngLat()
        onChange(pos.lat, pos.lng)
      })

      proposedMarkerRef.current = marker

      // Resolve containing ward
      const containing = findContainingWard(proposedLat, proposedLng, wardBoundaries)
      onWardResolved(containing)
    } else {
      onWardResolved(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, proposedLat, proposedLng])

  return (
    <div className="absolute inset-0 overflow-hidden rounded-lg">
      <div ref={containerRef} className="absolute inset-0" />

      {/* Coordinate readout */}
      {proposedLat != null && proposedLng != null && (
        <div className="pointer-events-none absolute bottom-8 left-2 rounded bg-white/90 px-2 py-1 text-[10px] font-mono text-slate-700 shadow-sm">
          {proposedLat.toFixed(5)}, {proposedLng.toFixed(5)}
        </div>
      )}

      {/* Instruction overlay when nothing placed yet */}
      {proposedLat == null && (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
          <div className="rounded-full bg-white/90 px-3 py-1 text-xs text-slate-600 shadow-sm">
            Click the map to place the incident location
          </div>
        </div>
      )}
    </div>
  )
}
