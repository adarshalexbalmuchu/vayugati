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
  // Map never passes hotspotStatus() the new optional readingAgeMinutes
  // input (see overviewRules.ts), so this status never actually occurs
  // here - present only so this Record stays exhaustive against the type.
  stale: status.neutral,
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

/**
 * Transit-activity context layer (Delhi Open Transit Data) - a deliberately
 * distinct teal family, not reused from the AQI/status/source palettes
 * above, so this never reads as a severity or source-attribution signal.
 * See docs/data/delhi-otd-transport-context-integration-report.md: this is
 * public transport activity, never pollution evidence or congestion.
 */
export const TRANSIT_ACTIVITY_HEX: Record<'low' | 'medium' | 'high', string> = {
  low: '#5EEAD4',
  medium: '#14B8A6',
  high: '#0F766E',
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
  /** Station modifier: a small accent-coloured dot (bottom-left corner) when
   *  CPCB/data.gov is the confirmed, fresh source behind this marker's AQI -
   *  see docs/data/cpcb-data-gov-primary-latest-integration-report.md.
   *  Undefined/false (OpenAQ fallback, or the reconciliation hasn't loaded)
   *  shows no dot at all - the default, unmarked state. */
  isCpcbSourced?: boolean
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
  // No `position` here - maplibregl.Marker's own CSS class
  // (`.maplibregl-marker { position: absolute; top: 0; left: 0 }`) supplies
  // it, and positions the element purely via `transform: translate(...)`.
  // An inline `position:relative` here would win the cascade over that
  // class rule (inline styles always beat class selectors), knocking the
  // marker out of the map canvas's absolute-positioning context and into
  // normal document flow - every marker stacking under the last one - which
  // is exactly the "markers line up vertically" bug this fixes. `absolute`
  // (from the class) is still a valid positioning context for this
  // element's own absolutely-positioned children (halo ring, stale dot,
  // dispatch flag), so nothing else needs to change.
  el.style.cssText = 'display:flex; align-items:center; justify-content:center; cursor:pointer;'
  return el
}

/** Ward centroid pin — 26px full circle with AQI fill. */
function wardCircle(colorHex: string, badgeText: string): HTMLDivElement {
  const pin = document.createElement('div')
  pin.style.cssText = `
    width:26px; height:26px; border-radius:50%;
    background:${colorHex}; border:2px solid #fff;
    box-shadow:0 1px 4px rgba(15,23,42,.35);
    display:flex; align-items:center; justify-content:center;
    font-size:9px; font-weight:700; color:#fff; letter-spacing:-0.5px;
  `
  pin.textContent = badgeText
  return pin
}

/** AQ station — compact two-ring circle: outer freshness ring (solid=fresh,
 *  dashed-orange=stale) + inner AQI circle. The outer ring differentiates
 *  stations from ward circles (which have no outer ring) even when they
 *  overlap at the same coordinate. The container is sized to 26px so the
 *  CPCB dot appended to the wrapper is positioned relative to its full area. */
function stationCircle(colorHex: string, badgeText: string, isStale: boolean): HTMLDivElement {
  const container = document.createElement('div')
  container.style.cssText = `
    position:relative; width:26px; height:26px;
    display:flex; align-items:center; justify-content:center;
  `

  const ring = document.createElement('div')
  ring.style.cssText = `
    position:absolute; inset:0; border-radius:50%;
    border:1.5px ${isStale ? 'dashed' : 'solid'} ${isStale ? '#D97706' : 'rgba(200,220,255,0.75)'};
    ${isStale ? 'opacity:.85;' : ''}
  `
  container.appendChild(ring)

  const core = document.createElement('div')
  core.style.cssText = `
    width:19px; height:19px; border-radius:50%;
    background:${colorHex};
    box-shadow:0 1px 3px rgba(15,23,42,.3);
    display:flex; align-items:center; justify-content:center;
    font-size:8px; font-weight:700; color:#fff; letter-spacing:-0.5px;
    ${isStale ? 'opacity:.6;' : ''}
  `
  core.textContent = badgeText
  container.appendChild(core)

  return container
}

/** Incident — rotated square (diamond) clearly different from both circle
 *  types. Sized at 15px so 29 incidents remain individually readable at
 *  citywide zoom without dominating the station layer. */
function diamondElement(colorHex: string): HTMLDivElement {
  const pin = document.createElement('div')
  pin.style.cssText = `
    width:15px; height:15px;
    background:${colorHex}; border:2px solid rgba(255,255,255,0.95);
    box-shadow:0 1px 4px rgba(15,23,42,.35);
    transform:rotate(45deg);
  `
  return pin
}

/** Citizen report — hollow teardrop shape, visually separate from all official markers. */
function teardropElement(colorHex: string): HTMLDivElement {
  const pin = document.createElement('div')
  pin.style.cssText = `
    width:18px; height:18px; border-radius:50% 50% 50% 0;
    transform:rotate(-45deg);
    background:transparent;
    border:2px solid ${colorHex};
    box-shadow:0 1px 3px rgba(15,23,42,.25);
  `
  return pin
}

// Explicit stacking priority for click/visual precedence, rather than
// relying on DOM append order (MapPage.tsx's allMarkers array order today
// happens to put stations after wards, but that's an incidental property
// of array-spread order, not a guarantee) - a station marker must always
// be reachable over a ward marker or ward-boundary polygon it happens to
// sit near/on top of. Ward-boundary polygons are MapLibre GL canvas layers,
// which sit BELOW every DOM marker by default (the canvas element is
// created before any marker `<div>` is appended) - this table only needs
// to order the DOM markers against each other.
const MARKER_Z_INDEX: Record<MapMarkerKind, number> = {
  report: 1,
  ward: 2,
  station: 3,
  incident: 4,
}

export function createMarkerElement(marker: MapMarker): HTMLDivElement {
  const el = wrapper()
  el.dataset.markerKind = marker.kind
  el.dataset.markerId = marker.id
  el.style.zIndex = String(MARKER_Z_INDEX[marker.kind])

  if (marker.kind === 'ward') {
    const color = marker.colorOverride ?? aqiLevel(marker.aqi ?? null).hex
    if (marker.pulsing) el.appendChild(haloElement(color))
    el.appendChild(wardCircle(color, marker.badgeText ?? (marker.aqi != null ? String(marker.aqi) : '-')))
    return el
  }

  if (marker.kind === 'station') {
    const color = marker.colorOverride ?? aqiLevel(marker.aqi ?? null).hex
    el.appendChild(stationCircle(color, marker.badgeText ?? (marker.aqi != null ? String(marker.aqi) : '-'), !!marker.isStale))
    if (marker.isCpcbSourced) {
      const dot = document.createElement('span')
      dot.title = 'CPCB/data.gov preferred'
      dot.style.cssText = `position:absolute; bottom:-1px; left:-1px; width:7px; height:7px; border-radius:50%; background:${accent[500]}; border:1.5px solid #fff;`
      el.appendChild(dot)
    }
    return el
  }

  if (marker.kind === 'incident') {
    const color = marker.colorOverride ?? (marker.severity ? SEVERITY_HEX[marker.severity] : status.neutral)
    el.appendChild(diamondElement(color))
    if (marker.hasDispatch) {
      const flag = document.createElement('span')
      flag.style.cssText = `
        position:absolute; top:-5px; right:-7px; width:8px; height:8px; border-radius:50%;
        background:${accent[600]}; border:1.5px solid #fff; box-shadow:0 1px 2px rgba(15,23,42,.3);
      `
      el.appendChild(flag)
    }
    return el
  }

  // citizen report — hollow teardrop, visually separate from all official markers
  el.style.marginTop = '-4px'
  el.appendChild(teardropElement(accent[500]))
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

/** Injects a single <style> block that handles the selected-marker blue ring.
 *  Uses ::before pseudo-elements so no DOM mutation is needed — just toggle
 *  the 'vg-marker-selected' class on the marker wrapper element. */
let selectedStyleInjected = false
export function ensureSelectedMarkerStyle() {
  if (selectedStyleInjected || typeof document === 'undefined') return
  selectedStyleInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .maplibregl-marker.vg-marker-selected {
      z-index: 100 !important;
    }
    /* Blue ring: circular halo around stations */
    .maplibregl-marker.vg-marker-selected[data-marker-kind="station"]::before {
      content: '';
      position: absolute;
      inset: -5px;
      border-radius: 50%;
      border: 2.5px solid #2563eb;
      pointer-events: none;
    }
    /* Blue ring: circular halo around incident diamonds */
    .maplibregl-marker.vg-marker-selected[data-marker-kind="incident"]::before {
      content: '';
      position: absolute;
      inset: -6px;
      border-radius: 50%;
      border: 2.5px solid #2563eb;
      pointer-events: none;
    }
  `
  document.head.appendChild(style)
}
