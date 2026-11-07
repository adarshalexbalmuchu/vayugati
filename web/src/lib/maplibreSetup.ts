/**
 * MapLibre 6 starts its tile worker from a separate file. Bundlers do not find that file by themselves, so the map would
 * stop with "Worker failed to load". Vite bundles the worker (with the shared code it imports) and gives its URL, and
 * MapLibre is told to use it. Imported once, at start-up, before any map is created.
 */
import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

setWorkerUrl(workerUrl)
