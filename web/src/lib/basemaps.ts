import type { StyleSpecification } from 'maplibre-gl'

/**
 * Basemap style resolution for the Map page (MapTiler-backed, Phase 14).
 *
 * MapTiler was chosen because one API key's hosted style catalog covers all
 * 5 requested looks with real, published style ids - no bespoke style JSON
 * to author or maintain. Unset key -> only Operational Light is available,
 * mapped to a keyless CARTO Positron basemap (see FALLBACK_STYLE below), so
 * the page keeps working with zero configuration. The other 4 modes are
 * never silently faked - they're visibly disabled.
 */

export type BasemapMode = 'operational-light' | 'operational-dark' | 'satellite-hybrid' | 'terrain' | 'minimal-grey'

export interface BasemapOption {
  mode: BasemapMode
  label: string
  description: string
  /** MapTiler style id (https://api.maptiler.com/maps/{id}/style.json). Null
   *  for the fallback-only Operational Light entry when no key is configured. */
  maptilerStyleId: string
}

/**
 * No-key fallback for Operational Light - CARTO's free, keyless "Positron"
 * (light_all) raster tiles: a real, widely-used, low-saturation civic/admin
 * basemap, not MapLibre's own public "demo" style (a colourful political
 * atlas, wrong tone for an operations console). No API key of any kind is
 * involved - this is a public tile endpoint, proper attribution included.
 */
export const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    'carto-light': {
      type: 'raster',
      tiles: ['https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'],
      tileSize: 256,
      maxzoom: 20,
      attribution:
        '© <a href="https://carto.com/attributions">CARTO</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#F1F5F9' } },
    { id: 'carto-light-layer', type: 'raster', source: 'carto-light' },
  ],
}

export const BASEMAP_OPTIONS: BasemapOption[] = [
  { mode: 'operational-light', label: 'Operational Light', description: 'Default - most readable for overlays', maptilerStyleId: 'dataviz' },
  { mode: 'operational-dark', label: 'Operational Dark', description: 'Low-glare night operations view', maptilerStyleId: 'dataviz-dark' },
  { mode: 'satellite-hybrid', label: 'Satellite Hybrid', description: 'Evidence review and visual context', maptilerStyleId: 'hybrid' },
  { mode: 'terrain', label: 'Terrain', description: 'Topographic and wind-context analysis', maptilerStyleId: 'outdoor-v2' },
  { mode: 'minimal-grey', label: 'Minimal Grey GIS', description: 'Lowest-noise base for dense overlays', maptilerStyleId: 'backdrop' },
]

export const DEFAULT_BASEMAP_MODE: BasemapMode = 'operational-dark'

export function maptilerKey(): string | null {
  const key = import.meta.env.VITE_MAPTILER_KEY
  return key && key.trim().length > 0 ? key.trim() : null
}

/** Whether a given mode can actually be selected right now - only
 *  Operational Light works without a configured API key. */
export function isBasemapAvailable(mode: BasemapMode): boolean {
  if (mode === 'operational-light') return true
  return maptilerKey() != null
}

/** The style to hand to maplibregl.Map for a given mode - a MapTiler style
 *  URL when a key is configured, otherwise the keyless CARTO fallback
 *  (defensive - callers should gate on isBasemapAvailable first). */
export function resolveStyleUrl(mode: BasemapMode): string | StyleSpecification {
  const key = maptilerKey()
  if (key == null) return FALLBACK_STYLE
  const option = BASEMAP_OPTIONS.find((o) => o.mode === mode) ?? BASEMAP_OPTIONS[0]
  return `https://api.maptiler.com/maps/${option.maptilerStyleId}/style.json?key=${key}`
}
