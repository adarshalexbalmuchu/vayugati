/**
 * City registry: the map settings for each City Pack the web app can show.
 * Pure (no I/O, no React) so it can be unit tested directly; the React side
 * lives in lib/city.tsx.
 *
 * A city is identified by `city_config.city_code`. The registry below holds
 * code-side defaults; `city_config.config.map`, when present, overrides them
 * field by field (see parseMapOverride), so map settings can move into the
 * database later without a code change.
 */

/** A lng/lat bounding box. Same shape the old DELHI_BOUNDS used. */
export interface MapBounds {
  minLng: number
  maxLng: number
  minLat: number
  maxLat: number
}

/** A broader area around the city that is still operationally relevant
 *  (Delhi's is the NCR). A point here is not rejected, but the reviewer has
 *  to confirm it explicitly (see incidentLocationRules.ts). */
export interface WiderArea {
  /** Short name, used in labels: "Within Delhi/NCR", "inside NCR operating area". */
  label: string
  bounds: MapBounds
}

export interface CityMapSettings {
  /** Display name, e.g. "Delhi". */
  label: string
  /** [lng, lat] - MapLibre's order. */
  center: [number, number]
  defaultZoom: number
  /** The operational map: used for fitBounds/reset and as the gate every
   *  marker runs through before it is plotted. */
  bounds: MapBounds
  widerArea: WiderArea | null
}

export const DEFAULT_CITY_CODE = 'delhi'

/** Delhi: the values that used to be DELHI_CENTER / DELHI_DEFAULT_ZOOM /
 *  DELHI_BOUNDS (mapRules.ts) and NCR_BOUNDS (incidentLocationRules.ts),
 *  unchanged. */
const DELHI: CityMapSettings = {
  label: 'Delhi',
  center: [77.209, 28.6139],
  defaultZoom: 10,
  bounds: { minLng: 76.7, maxLng: 77.7, minLat: 28.2, maxLat: 29.0 },
  widerArea: { label: 'NCR', bounds: { minLng: 76.5, maxLng: 78.0, minLat: 28.0, maxLat: 29.2 } },
}

/** Dhanbad–Jharia (docs/JHARKHAND_CITY_PACK.md). Derived from the extent of
 *  data/jharkhand/processed/dhanbad_grid_3km.geojson (265 cells):
 *    lng 86.11429 – 86.82481, lat 23.62204 – 24.05615
 *  centre = the midpoint of that extent, rounded to 2 decimals;
 *  bounds = the extent plus a 0.05° margin (about 5 km) on every side,
 *  rounded outwards to 2 decimals. Zoom 10 matches Delhi's, whose box is a
 *  similar size (1.0° × 0.8° against Dhanbad's 0.82° × 0.54°).
 *  No wider area yet: the Asansol/Durgapur reference stations (lng ~86.94 –
 *  87.36) fall outside these bounds; whether they belong to this city's map
 *  is a decision for the database import step. */
const DHANBAD: CityMapSettings = {
  label: 'Dhanbad–Jharia',
  center: [86.47, 23.84],
  defaultZoom: 10,
  bounds: { minLng: 86.06, maxLng: 86.88, minLat: 23.57, maxLat: 24.11 },
  widerArea: null,
}

export const CITY_REGISTRY: Readonly<Record<string, CityMapSettings>> = {
  delhi: DELHI,
  dhanbad: DHANBAD,
}

/** Delhi's entry - for pure functions whose default stays Delhi so existing
 *  callers and tests keep their behaviour. */
export const DELHI_MAP_SETTINGS: CityMapSettings = DELHI

// ── geometry helpers ─────────────────────────────────────────────────────────

/** True only for a finite lat/lng pair inside `bounds` (edges included). */
export function isWithinBounds(
  lat: number | null | undefined,
  lng: number | null | undefined,
  bounds: MapBounds,
): boolean {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return false
  return lat >= bounds.minLat && lat <= bounds.maxLat && lng >= bounds.minLng && lng <= bounds.maxLng
}

/** MapLibre's fitBounds / maxBounds pair: [[west, south], [east, north]]. */
export function boundsToLngLatPair(bounds: MapBounds): [[number, number], [number, number]] {
  return [
    [bounds.minLng, bounds.minLat],
    [bounds.maxLng, bounds.maxLat],
  ]
}

// ── city_config.config.map override ──────────────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function parseBounds(v: unknown): MapBounds | null {
  if (v == null || typeof v !== 'object') return null
  const b = v as Record<string, unknown>
  const { minLng, maxLng, minLat, maxLat } = b
  if (!isFiniteNumber(minLng) || !isFiniteNumber(maxLng) || !isFiniteNumber(minLat) || !isFiniteNumber(maxLat)) return null
  if (minLng >= maxLng || minLat >= maxLat) return null
  if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180) return null
  return { minLng, maxLng, minLat, maxLat }
}

function parseCenter(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  const [lng, lat] = v
  if (!isFiniteNumber(lng) || !isFiniteNumber(lat)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return [lng, lat]
}

/**
 * Reads `city_config.config.map`. Expected shape (every key optional):
 *
 *   { "label": "Dhanbad–Jharia",
 *     "center": [86.47, 23.84],                        // [lng, lat]
 *     "default_zoom": 10,                              // or "defaultZoom"
 *     "bounds": { "minLng": 86.06, "maxLng": 86.88, "minLat": 23.57, "maxLat": 24.11 },
 *     "wider_area": { "label": "NCR", "bounds": { ... } } | null   // or "widerArea"
 *   }
 *
 * Each field is validated on its own; a malformed field is ignored (the
 * registry's value stays) rather than breaking the map.
 */
export function parseMapOverride(config: unknown): Partial<CityMapSettings> {
  if (config == null || typeof config !== 'object' || Array.isArray(config)) return {}
  const map = (config as Record<string, unknown>).map
  if (map == null || typeof map !== 'object' || Array.isArray(map)) return {}
  const m = map as Record<string, unknown>
  const out: Partial<CityMapSettings> = {}

  if (typeof m.label === 'string' && m.label.trim() !== '') out.label = m.label.trim()
  const center = parseCenter(m.center)
  if (center) out.center = center
  const zoom = m.default_zoom ?? m.defaultZoom
  if (isFiniteNumber(zoom) && zoom >= 0 && zoom <= 22) out.defaultZoom = zoom
  const bounds = parseBounds(m.bounds)
  if (bounds) out.bounds = bounds

  const wider = 'wider_area' in m ? m.wider_area : m.widerArea
  if (wider === null) {
    out.widerArea = null
  } else if (wider != null && typeof wider === 'object') {
    const w = wider as Record<string, unknown>
    const wb = parseBounds(w.bounds)
    if (typeof w.label === 'string' && w.label.trim() !== '' && wb) out.widerArea = { label: w.label.trim(), bounds: wb }
  }
  return out
}

/** Registry entry for `cityCode` with `config.map` applied on top. A city
 *  missing from the registry is usable only if its config supplies at least
 *  centre and bounds; otherwise null. */
export function resolveCityMapSettings(cityCode: string, config?: unknown, fallbackLabel?: string): CityMapSettings | null {
  const base = CITY_REGISTRY[cityCode]
  const override = parseMapOverride(config)
  if (base) return { ...base, ...override }
  if (!override.center || !override.bounds) return null
  return {
    label: override.label ?? fallbackLabel ?? cityCode,
    center: override.center,
    defaultZoom: override.defaultZoom ?? 10,
    bounds: override.bounds,
    widerArea: override.widerArea ?? null,
  }
}

// ── cities available to the app ──────────────────────────────────────────────

/** The subset of a city_config row this module needs. */
export interface CityConfigLike {
  id: number
  city_code: string
  name: string
  is_active: boolean
  config: unknown
}

export interface CityOption {
  id: number
  cityCode: string
  name: string
  map: CityMapSettings
}

/** Active city_config rows that have usable map settings, in row order. */
export function buildCityOptions(rows: CityConfigLike[]): CityOption[] {
  const out: CityOption[] = []
  for (const r of rows) {
    if (!r.is_active) continue
    const map = resolveCityMapSettings(r.city_code, r.config, r.name)
    if (!map) continue
    out.push({ id: r.id, cityCode: r.city_code, name: r.name, map })
  }
  return out
}

/** Normalises a city code from the URL or storage: trimmed, lower case. */
export function normalizeCityCode(v: string | null | undefined): string | null {
  if (v == null) return null
  const s = v.trim().toLowerCase()
  return s === '' ? null : s
}

// ── last choice in localStorage ──────────────────────────────────────────────

export const CITY_STORAGE_KEY = 'vayugati:active-city'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null // access itself can throw (blocked site data)
  }
}

/** The last city chosen on this browser, or null. Never throws: storage can
 *  be missing, blocked, or throw in a private window. */
export function readStoredCityCode(storage: StorageLike | null = defaultStorage()): string | null {
  try {
    return normalizeCityCode(storage?.getItem(CITY_STORAGE_KEY))
  } catch {
    return null
  }
}

/** Saves the choice; silently does nothing when storage is unavailable. */
export function writeStoredCityCode(code: string, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(CITY_STORAGE_KEY, code)
  } catch {
    // ignore: the choice just won't survive a reload
  }
}

/**
 * The active city, in this order: `?city=` in the URL, then the last choice
 * saved in localStorage, then the signed-in user's profile ward's city, then
 * 'delhi'. A candidate counts only if it is one of `available` (active in
 * city_config with usable map settings); an unknown or inactive code falls
 * through to the next one.
 */
export function resolveActiveCityCode(input: {
  urlCity: string | null | undefined
  storedCity: string | null | undefined
  profileCityCode: string | null | undefined
  available: readonly string[]
}): string {
  const available = new Set(input.available)
  for (const candidate of [input.urlCity, input.storedCity, input.profileCityCode]) {
    const code = normalizeCityCode(candidate)
    if (code && available.has(code)) return code
  }
  return DEFAULT_CITY_CODE
}
