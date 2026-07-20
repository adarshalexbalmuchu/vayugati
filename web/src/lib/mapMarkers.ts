/**
 * Professional marker DOM factory for the Map page. MapLibre markers are
 * imperative DOM elements (maplibregl.Marker takes a raw HTMLElement), not
 * JSX - this module is the "ProfessionalMapMarker" concept from the plan,
 * implemented as element-builder functions rather than a React component.
 *
 * Colour is pulled from the same design tokens/aqiLevel scale used
 * everywhere else in the app (tokens.ts's own header comment names "canvas/
 * map layer code" as exactly where to reach for it directly) - never a
 * separate ad hoc palette.
 */
import { aqiLevel } from '../components/AqiBadge'
import { status, accent } from '../design/tokens'
import type { Severity, SourceCategory } from './incidentRules'
import type { HotspotStatus } from './overviewRules'

export type MapMarkerKind = 'ward' | 'station' | 'incident' | 'report'

/** Forecast-time-mode marker colouring - there is no honest severity scale
 *  for raw forecast PM2.5 µg/m³ (see mapRules.ts), so forecast modes colour
 *  by crossing-risk tier instead, reusing the same status tokens as
 *  everywhere else rather than inventing a new palette. */
export const HOTSPOT_STATUS_HEX: Record<HotspotStatus, string> = {
  severe: status.critical,
  watch: status.warning,
  stable: status.success,
  no_data: status.neutral,
}

/**
 * Fixed palette for the "source attribution" layer (colour-codes points by
 * leading suspected source, since no zone/polygon geometry exists for any
 * source category - see the Map plan's honesty table). New palette, not
 * reused from elsewhere, because nothing in this codebase colour-coded
 * source categories before this layer. The 3 meta categories
 * (regional_transport/mixed/unresolved - see incidentRules.ts's
 * META_SOURCE_CATEGORIES) get muted slate tones since they describe the
 * SHAPE of the evidence, not a physical source.
 */
export const SOURCE_CATEGORY_HEX: Record<SourceCategory, string> = {
  road_dust: '#B45309',
  construction_dust: '#78716C',
  vehicular: '#2563EB',
  open_burning: '#EA580C',
  industrial: '#7C3AED',
  waste: '#65A30D',
  other: '#94A3B8',
  regional_transport: '#0891B2',
  mixed: '#64748B',
  unresolved: '#CBD5E1',
}

export interface MapMarker {
  id: string
  kind: MapMarkerKind
  lat: number
  lng: number
  label: string
  /** Drives colour for ward/station markers via aqiLevel(). */
  aqi?: number | null
  /** Drives colour for incident markers. */
  severity?: Severity | null
  /** Number/short text shown inside the glyph (e.g. the AQI value). */
  badgeText?: string
  /** Station modifier: dashed/faded ring + a small stale dot. */
  isStale?: boolean
  /** Ward modifier: a restrained pulsing halo (predicted hotspot). */
  pulsing?: boolean
  /** Incident modifier: a small flag corner-badge (has an active dispatch). */
  hasDispatch?: boolean
  /** Source-attribution layer: overrides the normal AQI/severity colour with
   *  the leading source category's colour (see SOURCE_CATEGORY_HEX above). */
  colorOverride?: string | null
  popupHtml: string
}

export const SEVERITY_HEX: Record<Severity, string> = {
  severe: status.critical,
  high: status.warning,
  moderate: status.warning,
  low: status.neutral,
}

function haloElement(colorHex: string): HTMLDivElement {
  const halo = document.createElement('div')
  halo.style.cssText = `
    position:absolute; inset:-10px; border-radius:50%;
    background:${colorHex}; opacity:.28;
    animation: vg-map-pulse 2.2s ease-out infinite;
  `
  return halo
}

function wrapper(): HTMLDivElement {
  const el = document.createElement('div')
  el.style.cssText = 'position:relative; display:flex; align-items:center; justify-content:center; cursor:pointer;'
  return el
}

/** Circular pin - wards (area centroid) and stations (fixed installation)
 *  share this base shape but are visually distinguished by corner radius:
 *  fully round for a ward, a rounded square for a station (a common GIS
 *  convention for "area" vs "fixed point instrument"). */
function pinElement(colorHex: string, badgeText: string, shape: 'circle' | 'square', faded: boolean): HTMLDivElement {
  const pin = document.createElement('div')
  const radius = shape === 'circle' ? '50%' : '8px'
  pin.style.cssText = `
    width:26px; height:26px; border-radius:${radius};
    background:${colorHex}; border:2px solid #fff;
    box-shadow:0 1px 4px rgba(15,23,42,.35);
    display:flex; align-items:center; justify-content:center;
    font-size:9px; font-weight:700; color:#fff;
    ${faded ? 'opacity:.55; border-style:dashed;' : ''}
  `
  pin.textContent = badgeText
  return pin
}

/** Teardrop pin - incidents. Built from a rotated square (CSS-only, no SVG
 *  asset) so it reads as "point of interest" distinct from the round sensor
 *  pins, per the brief's "professional operational markers" requirement. */
function teardropElement(colorHex: string, hollow: boolean): HTMLDivElement {
  const pin = document.createElement('div')
  pin.style.cssText = `
    width:20px; height:20px; border-radius:50% 50% 50% 0;
    transform:rotate(-45deg);
    background:${hollow ? 'transparent' : colorHex};
    border:2.5px solid ${colorHex};
    box-shadow:0 1px 4px rgba(15,23,42,.3);
  `
  return pin
}

export function createMarkerElement(marker: MapMarker): HTMLDivElement {
  const el = wrapper()

  if (marker.kind === 'ward' || marker.kind === 'station') {
    const color = marker.colorOverride ?? aqiLevel(marker.aqi ?? null).hex
    if (marker.pulsing) el.appendChild(haloElement(color))
    const pin = pinElement(color, marker.badgeText ?? (marker.aqi != null ? String(marker.aqi) : '-'), marker.kind === 'ward' ? 'circle' : 'square', !!marker.isStale)
    el.appendChild(pin)
    if (marker.isStale) {
      const dot = document.createElement('span')
      dot.style.cssText = `position:absolute; top:-2px; right:-2px; width:8px; height:8px; border-radius:50%; background:${status.warning}; border:1.5px solid #fff;`
      el.appendChild(dot)
    }
    return el
  }

  if (marker.kind === 'incident') {
    const color = marker.colorOverride ?? (marker.severity ? SEVERITY_HEX[marker.severity] : status.neutral)
    el.style.marginTop = '-8px' // teardrop's point should touch the coordinate, not its center
    el.appendChild(teardropElement(color, false))
    if (marker.hasDispatch) {
      const flag = document.createElement('span')
      flag.style.cssText = `
        position:absolute; top:-6px; right:-8px; width:14px; height:14px; border-radius:3px;
        background:${accent[600]}; border:1.5px solid #fff; box-shadow:0 1px 2px rgba(15,23,42,.3);
      `
      el.appendChild(flag)
    }
    return el
  }

  // citizen report - light-outline teardrop, visually distinct from official markers
  el.style.marginTop = '-6px'
  el.appendChild(teardropElement(accent[500], true))
  return el
}

/** Injected once, lazily - keeps the halo pulse keyframes out of the global
 *  CSS bundle for pages that never render a hotspot. */
let pulseStyleInjected = false
export function ensurePulseStyle() {
  if (pulseStyleInjected || typeof document === 'undefined') return
  pulseStyleInjected = true
  const style = document.createElement('style')
  style.textContent = `
    @keyframes vg-map-pulse {
      0% { transform: scale(.85); opacity: .35; }
      70% { transform: scale(1.6); opacity: 0; }
      100% { transform: scale(1.6); opacity: 0; }
    }
  `
  document.head.appendChild(style)
}
