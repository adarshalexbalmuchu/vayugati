import { describe, expect, it } from 'vitest'
import gridRaw from '../../../data/jharkhand/processed/dhanbad_grid_3km.geojson?raw'
import {
  boundsToLngLatPair,
  buildCityOptions,
  CITY_REGISTRY,
  CITY_STORAGE_KEY,
  DEFAULT_CITY_CODE,
  isWithinBounds,
  parseMapOverride,
  readStoredCityCode,
  resolveActiveCityCode,
  resolveCityMapSettings,
  writeStoredCityCode,
  type CityConfigLike,
} from './cities'

// ── registry ─────────────────────────────────────────────────────────────────

describe('CITY_REGISTRY', () => {
  it('keeps the Delhi values the app always used', () => {
    const delhi = CITY_REGISTRY.delhi
    expect(delhi.label).toBe('Delhi')
    expect(delhi.center).toEqual([77.209, 28.6139])
    expect(delhi.defaultZoom).toBe(10)
    expect(delhi.bounds).toEqual({ minLng: 76.7, maxLng: 77.7, minLat: 28.2, maxLat: 29.0 })
    expect(delhi.widerArea).toEqual({ label: 'NCR', bounds: { minLng: 76.5, maxLng: 78.0, minLat: 28.0, maxLat: 29.2 } })
  })

  it('defaults to delhi', () => {
    expect(DEFAULT_CITY_CODE).toBe('delhi')
    expect(CITY_REGISTRY[DEFAULT_CITY_CODE]).toBeDefined()
  })

  it('has a Dhanbad entry with its centre inside its bounds', () => {
    const d = CITY_REGISTRY.dhanbad
    expect(d.label).toBe('Dhanbad–Jharia')
    expect(d.menuLabel).toBe('Jharkhand')
    const [lng, lat] = d.center
    expect(isWithinBounds(lat, lng, d.bounds)).toBe(true)
    expect(d.widerArea).toBeNull()
  })

  it('Delhi and Dhanbad bounds do not overlap', () => {
    const a = CITY_REGISTRY.delhi.bounds
    const b = CITY_REGISTRY.dhanbad.bounds
    expect(a.maxLng < b.minLng || b.maxLng < a.minLng || a.maxLat < b.minLat || b.maxLat < a.minLat).toBe(true)
  })
})

// The Dhanbad numbers are derived from the 3 km grid's extent plus a margin;
// recheck that derivation against the committed layer.
describe('Dhanbad bounds vs data/jharkhand/processed/dhanbad_grid_3km.geojson', () => {
  const grid = JSON.parse(gridRaw) as GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>

  const coords: number[][] = []
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') coords.push(c as number[])
    else if (Array.isArray(c)) c.forEach(walk)
  }
  for (const f of grid.features) walk(f.geometry.coordinates)
  const minLng = Math.min(...coords.map((c) => c[0]))
  const maxLng = Math.max(...coords.map((c) => c[0]))
  const minLat = Math.min(...coords.map((c) => c[1]))
  const maxLat = Math.max(...coords.map((c) => c[1]))
  const b = CITY_REGISTRY.dhanbad.bounds

  it('has the 265 cells the city pack describes', () => {
    expect(grid.features).toHaveLength(265)
  })

  it('contains every grid vertex', () => {
    for (const [lng, lat] of coords) expect(isWithinBounds(lat, lng, b)).toBe(true)
  })

  it('adds a margin of about 0.05° (no more than 0.06°) on every side', () => {
    for (const margin of [minLng - b.minLng, b.maxLng - maxLng, minLat - b.minLat, b.maxLat - maxLat]) {
      expect(margin).toBeGreaterThanOrEqual(0.04)
      expect(margin).toBeLessThanOrEqual(0.06)
    }
  })

  it('centres on the grid extent', () => {
    const [lng, lat] = CITY_REGISTRY.dhanbad.center
    expect(lng).toBeCloseTo((minLng + maxLng) / 2, 1)
    expect(lat).toBeCloseTo((minLat + maxLat) / 2, 1)
  })
})

// ── bounds helpers ───────────────────────────────────────────────────────────

describe('isWithinBounds', () => {
  const b = { minLng: 10, maxLng: 20, minLat: 30, maxLat: 40 }
  it('includes the edges', () => {
    expect(isWithinBounds(30, 10, b)).toBe(true)
    expect(isWithinBounds(40, 20, b)).toBe(true)
  })
  it('rejects outside points, nulls and non-finite values', () => {
    expect(isWithinBounds(29.99, 15, b)).toBe(false)
    expect(isWithinBounds(35, 20.01, b)).toBe(false)
    expect(isWithinBounds(null, 15, b)).toBe(false)
    expect(isWithinBounds(35, undefined, b)).toBe(false)
    expect(isWithinBounds(NaN, 15, b)).toBe(false)
    expect(isWithinBounds(35, Infinity, b)).toBe(false)
  })
})

describe('boundsToLngLatPair', () => {
  it('returns [[west, south], [east, north]]', () => {
    expect(boundsToLngLatPair(CITY_REGISTRY.delhi.bounds)).toEqual([[76.7, 28.2], [77.7, 29.0]])
  })
})

// ── city_config.config.map override ──────────────────────────────────────────

describe('parseMapOverride', () => {
  it('returns nothing for missing or non-object config/map', () => {
    expect(parseMapOverride(null)).toEqual({})
    expect(parseMapOverride({})).toEqual({})
    expect(parseMapOverride({ feature_flags: {} })).toEqual({})
    expect(parseMapOverride({ map: 'x' })).toEqual({})
    expect(parseMapOverride({ map: [1, 2] })).toEqual({})
  })

  it('reads every field (snake_case keys)', () => {
    const o = parseMapOverride({
      map: {
        label: ' Dhanbad ',
        center: [86.5, 23.8],
        default_zoom: 11,
        bounds: { minLng: 86, maxLng: 87, minLat: 23.5, maxLat: 24.2 },
        wider_area: { label: 'Coalfield', bounds: { minLng: 85.8, maxLng: 87.5, minLat: 23.3, maxLat: 24.3 } },
      },
    })
    expect(o).toEqual({
      label: 'Dhanbad',
      center: [86.5, 23.8],
      defaultZoom: 11,
      bounds: { minLng: 86, maxLng: 87, minLat: 23.5, maxLat: 24.2 },
      widerArea: { label: 'Coalfield', bounds: { minLng: 85.8, maxLng: 87.5, minLat: 23.3, maxLat: 24.3 } },
    })
  })

  it('accepts camelCase defaultZoom / widerArea too', () => {
    const o = parseMapOverride({ map: { defaultZoom: 9, widerArea: null } })
    expect(o).toEqual({ defaultZoom: 9, widerArea: null })
  })

  it('ignores malformed fields one by one', () => {
    const o = parseMapOverride({
      map: {
        label: '',
        center: [86.5],
        default_zoom: 'ten',
        bounds: { minLng: 87, maxLng: 86, minLat: 23.5, maxLat: 24.2 }, // min > max
        wider_area: { label: 'x', bounds: null },
      },
    })
    expect(o).toEqual({})
  })

  it('rejects an out-of-range centre or bounds', () => {
    expect(parseMapOverride({ map: { center: [200, 23] } })).toEqual({})
    expect(parseMapOverride({ map: { bounds: { minLng: 0, maxLng: 1, minLat: -95, maxLat: 1 } } })).toEqual({})
  })
})

describe('resolveCityMapSettings', () => {
  it('returns the registry entry when config has no map', () => {
    expect(resolveCityMapSettings('delhi', {})).toEqual(CITY_REGISTRY.delhi)
  })

  it('lets config.map override the registry field by field', () => {
    const s = resolveCityMapSettings('delhi', { map: { default_zoom: 11 } })!
    expect(s.defaultZoom).toBe(11)
    expect(s.center).toEqual(CITY_REGISTRY.delhi.center)
    expect(s.bounds).toEqual(CITY_REGISTRY.delhi.bounds)
    expect(CITY_REGISTRY.delhi.defaultZoom).toBe(10) // registry itself untouched
  })

  it('returns null for an unknown city without centre and bounds in config', () => {
    expect(resolveCityMapSettings('ranchi', {})).toBeNull()
    expect(resolveCityMapSettings('ranchi', { map: { center: [85.3, 23.35] } })).toBeNull()
  })

  it('builds an unknown city entirely from config', () => {
    const s = resolveCityMapSettings(
      'ranchi',
      { map: { center: [85.3, 23.35], bounds: { minLng: 85.1, maxLng: 85.5, minLat: 23.2, maxLat: 23.5 } } },
      'Ranchi',
    )
    expect(s).toEqual({
      label: 'Ranchi',
      center: [85.3, 23.35],
      defaultZoom: 10,
      bounds: { minLng: 85.1, maxLng: 85.5, minLat: 23.2, maxLat: 23.5 },
      widerArea: null,
    })
  })
})

// ── available cities ─────────────────────────────────────────────────────────

const row = (over: Partial<CityConfigLike>): CityConfigLike => ({
  id: 1, city_code: 'delhi', name: 'Delhi', is_active: true, config: {}, ...over,
})

describe('buildCityOptions', () => {
  it('is just Delhi today', () => {
    const opts = buildCityOptions([row({})])
    expect(opts).toHaveLength(1)
    expect(opts[0]).toMatchObject({ id: 1, cityCode: 'delhi', name: 'Delhi' })
    expect(opts[0].map).toEqual(CITY_REGISTRY.delhi)
  })

  it('skips inactive rows and cities with no map settings', () => {
    const opts = buildCityOptions([
      row({}),
      row({ id: 2, city_code: 'dhanbad', name: 'Dhanbad', is_active: false }),
      row({ id: 3, city_code: 'replay_dec2018', name: 'Replay', is_active: true }),
    ])
    expect(opts.map((o) => o.cityCode)).toEqual(['delhi'])
  })

  it('includes Dhanbad once it is an active row', () => {
    const opts = buildCityOptions([row({}), row({ id: 2, city_code: 'dhanbad', name: 'Dhanbad' })])
    expect(opts.map((o) => [o.id, o.cityCode])).toEqual([[1, 'delhi'], [2, 'dhanbad']])
    expect(opts[1].map).toEqual(CITY_REGISTRY.dhanbad)
  })
})

// ── resolution order ─────────────────────────────────────────────────────────

describe('resolveActiveCityCode', () => {
  const both = ['delhi', 'dhanbad']
  const none = { urlCity: null, storedCity: null, profileCityCode: null }

  it('falls back to delhi when nothing is set', () => {
    expect(resolveActiveCityCode({ ...none, available: both })).toBe('delhi')
  })

  it('URL wins over storage and profile', () => {
    expect(resolveActiveCityCode({ urlCity: 'dhanbad', storedCity: 'delhi', profileCityCode: 'delhi', available: both })).toBe('dhanbad')
    expect(resolveActiveCityCode({ urlCity: 'delhi', storedCity: 'dhanbad', profileCityCode: 'dhanbad', available: both })).toBe('delhi')
  })

  it('storage wins over profile', () => {
    expect(resolveActiveCityCode({ ...none, storedCity: 'dhanbad', profileCityCode: 'delhi', available: both })).toBe('dhanbad')
    expect(resolveActiveCityCode({ ...none, storedCity: 'delhi', profileCityCode: 'dhanbad', available: both })).toBe('delhi')
  })

  it("uses the profile ward's city when URL and storage are empty", () => {
    expect(resolveActiveCityCode({ ...none, profileCityCode: 'dhanbad', available: both })).toBe('dhanbad')
  })

  it('skips a candidate that is not an available city', () => {
    expect(resolveActiveCityCode({ urlCity: 'mumbai', storedCity: 'dhanbad', profileCityCode: null, available: both })).toBe('dhanbad')
    expect(resolveActiveCityCode({ urlCity: 'dhanbad', storedCity: 'dhanbad', profileCityCode: 'dhanbad', available: ['delhi'] })).toBe('delhi')
  })

  it('normalises case and whitespace', () => {
    expect(resolveActiveCityCode({ ...none, urlCity: ' Dhanbad ', available: both })).toBe('dhanbad')
    expect(resolveActiveCityCode({ ...none, urlCity: '', storedCity: 'DHANBAD', available: both })).toBe('dhanbad')
  })

  it('returns delhi when no cities could be loaded', () => {
    expect(resolveActiveCityCode({ urlCity: 'dhanbad', storedCity: null, profileCityCode: null, available: [] })).toBe('delhi')
  })
})

// ── storage ──────────────────────────────────────────────────────────────────

describe('stored city', () => {
  function memoryStorage() {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
  }
  const throwing = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('blocked') },
  }

  it('round-trips through storage', () => {
    const s = memoryStorage()
    expect(readStoredCityCode(s)).toBeNull()
    writeStoredCityCode('dhanbad', s)
    expect(s.m.get(CITY_STORAGE_KEY)).toBe('dhanbad')
    expect(readStoredCityCode(s)).toBe('dhanbad')
  })

  it('never throws when storage is blocked or missing', () => {
    expect(readStoredCityCode(throwing)).toBeNull()
    expect(() => writeStoredCityCode('dhanbad', throwing)).not.toThrow()
    expect(readStoredCityCode(null)).toBeNull()
    expect(() => writeStoredCityCode('dhanbad', null)).not.toThrow()
  })
})
