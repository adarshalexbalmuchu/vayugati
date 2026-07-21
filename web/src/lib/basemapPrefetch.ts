import maplibregl from 'maplibre-gl'
import { BASEMAP_OPTIONS, isBasemapAvailable, resolveStyleUrl, type BasemapMode } from './basemaps'

/**
 * Quietly warms the browser's HTTP cache for every OTHER basemap mode's
 * tiles at the given view, so a later manual switch to one of them is
 * served from cache instead of paying its real first-visit network cost.
 * Measured directly (basemap speed test, 2026-07-21): a first-time switch
 * to a style like Terrain or Satellite Hybrid takes ~1.6-2.5s even on a
 * fast connection (multiple vector/raster/terrain-DEM sources); a repeat
 * visit is served 100% from disk cache (confirmed via Chrome DevTools
 * Protocol's `fromDiskCache` flag) with zero network bytes. This makes
 * every OTHER mode's first visit happen here, off-screen, before the user
 * ever clicks it.
 *
 * Runs entirely off-screen - one hidden, non-interactive MapLibre instance
 * per mode, sized to roughly match a real viewport (so it requests the
 * same tile set a real switch would, not a mismatched one), torn down the
 * moment its own tiles finish loading (`idle`) or after a safety timeout.
 * Never touches the real, visible map or its container - if this is slow
 * or fails outright, the user's actual map is completely unaffected.
 */
export function prefetchOtherBasemaps(activeMode: BasemapMode, center: [number, number], zoom: number): void {
  const others = BASEMAP_OPTIONS.map((o) => o.mode).filter((m) => m !== activeMode && isBasemapAvailable(m))
  others.forEach((mode, i) => {
    // Staggered, not simultaneous - avoids a bandwidth spike competing with
    // whatever the user's own browser is doing right after the page loads.
    window.setTimeout(() => prefetchOne(mode, center, zoom), i * 600)
  })
}

const PREFETCH_SAFETY_TIMEOUT_MS = 20_000

function prefetchOne(mode: BasemapMode, center: [number, number], zoom: number): void {
  const container = document.createElement('div')
  container.style.cssText =
    'position:fixed; top:-9999px; left:-9999px; width:800px; height:600px; visibility:hidden; pointer-events:none;'
  document.body.appendChild(container)

  let done = false
  const cleanup = () => {
    if (done) return
    done = true
    map.remove()
    container.remove()
  }

  const map = new maplibregl.Map({
    container,
    style: resolveStyleUrl(mode),
    center,
    zoom,
    interactive: false,
    attributionControl: false,
  })
  map.once('idle', cleanup) // every tile/sprite/glyph this view needs has loaded
  window.setTimeout(cleanup, PREFETCH_SAFETY_TIMEOUT_MS) // never leave a hidden map running indefinitely
}
