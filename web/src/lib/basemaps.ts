/**
 * Basemap style resolution for the Map page (MapTiler-backed, Phase 14).
 *
 * MapTiler was chosen because one API key's hosted style catalog covers all
 * 5 requested looks with real, published style ids - no bespoke style JSON
 * to author or maintain. Unset key -> only Operational Light is available,
 * mapped to the same free MapLibre demo style the app already used before
 * this feature existed, so the page keeps working with zero configuration.
 * The other 4 modes are never silently faked - they're visibly disabled.
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

export const DEMO_STYLE_URL = 'https://demotiles.maplibre.org/style.json'

export const BASEMAP_OPTIONS: BasemapOption[] = [
  { mode: 'operational-light', label: 'Operational Light', description: 'Default - most readable for overlays', maptilerStyleId: 'dataviz' },
  { mode: 'operational-dark', label: 'Operational Dark', description: 'Low-glare night operations view', maptilerStyleId: 'dataviz-dark' },
  { mode: 'satellite-hybrid', label: 'Satellite Hybrid', description: 'Evidence review and visual context', maptilerStyleId: 'hybrid' },
  { mode: 'terrain', label: 'Terrain', description: 'Topographic and wind-context analysis', maptilerStyleId: 'outdoor-v2' },
  { mode: 'minimal-grey', label: 'Minimal Grey GIS', description: 'Lowest-noise base for dense overlays', maptilerStyleId: 'backdrop' },
]

export const DEFAULT_BASEMAP_MODE: BasemapMode = 'operational-light'

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

/** The style URL to hand to maplibregl.Map for a given mode. Falls back to
 *  Operational Light's demo style if an unavailable mode is somehow passed
 *  in (defensive - callers should gate on isBasemapAvailable first). */
export function resolveStyleUrl(mode: BasemapMode): string {
  const key = maptilerKey()
  if (key == null) return DEMO_STYLE_URL
  const option = BASEMAP_OPTIONS.find((o) => o.mode === mode) ?? BASEMAP_OPTIONS[0]
  return `https://api.maptiler.com/maps/${option.maptilerStyleId}/style.json?key=${key}`
}
