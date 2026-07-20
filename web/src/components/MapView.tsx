import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useRef } from 'react'
import { DEMO_STYLE_URL } from '../lib/basemaps'
import { createMarkerElement, ensurePulseStyle, type MapMarker } from '../lib/mapMarkers'

export type { MapMarker, MapMarkerKind } from '../lib/mapMarkers'

const DELHI_CENTER: [number, number] = [77.209, 28.6139]

interface Props {
  markers?: MapMarker[]
  center?: [number, number]
  zoom?: number
  /** Basemap style URL - defaults to the free MapLibre demo style, exactly
   *  the map's behaviour before the basemap switcher existed. */
  styleUrl?: string
  showScaleBar?: boolean
  onMarkerClick?: (marker: MapMarker) => void
  onHoverCoordinates?: (coords: { lng: number; lat: number } | null) => void
  /** [lng, lat] pairs to fit the viewport to - e.g. "Reset view"/"Fit to city". */
  fitBoundsTo?: [number, number][]
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
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)

  useEffect(() => {
    ensurePulseStyle()
    if (!containerRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl ?? DEMO_STYLE_URL,
      center: center ?? DELHI_CENTER,
      zoom,
    })
    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    if (showScaleBar) map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right')
    if (onHoverCoordinates) {
      map.on('mousemove', (e) => onHoverCoordinates({ lng: e.lngLat.lng, lat: e.lngLat.lat }))
      map.on('mouseout', () => onHoverCoordinates(null))
    }
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
    // Map instance created once - style/bounds changes are handled by their
    // own effects below rather than tearing down and recreating the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Basemap swap on an already-live map - markers are DOM overlays
  // independent of the style, so they persist across setStyle() untouched.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleUrl) return
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
    map.fitBounds(bounds, { padding: 56, maxZoom: 13, duration: 600 })
  }, [fitBoundsTo])

  // sync markers whenever they change (or map is ready)
  useEffect(() => {
    const map = mapRef.current
    if (!map || markers.length === 0) return

    const addedMarkers: maplibregl.Marker[] = []
    const addedPopups: maplibregl.Popup[] = []

    const addMarkers = () => {
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
      addedMarkers.forEach((m) => m.remove())
      addedPopups.forEach((p) => p.remove())
    }
  }, [markers, onMarkerClick])

  return <div ref={containerRef} className="h-full w-full" />
}
