import { beforeEach, describe, expect, it, vi } from 'vitest'

// A recording stand-in for the Supabase client: every builder call is logged
// per table, and awaiting a query resolves to that table's canned rows. No
// network, no keys - the point is which filters each query sends.
type Call = [method: string, ...args: unknown[]]
const calls: Record<string, Call[][]> = {}
const rowsByTable: Record<string, unknown[]> = {}

function builder(table: string) {
  const log: Call[] = []
  ;(calls[table] ??= []).push(log)
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'not', 'gte', 'lte', 'lt', 'order', 'limit', 'is', 'or']) {
    b[m] = (...args: unknown[]) => {
      log.push([m, ...args])
      return b
    }
  }
  b.maybeSingle = () => {
    log.push(['maybeSingle'])
    return Promise.resolve({ data: null, error: null })
  }
  b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rowsByTable[table] ?? [], error: null })
  return b
}

vi.mock('./supabase', () => ({ supabase: { from: (table: string) => builder(table) } }))

const { fetchAllStationsWithReadings, fetchAllWardBoundaries, fetchAllWardsAqi } = await import('./data')

beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k]
  for (const k of Object.keys(rowsByTable)) delete rowsByTable[k]
})

const has = (log: Call[], method: string, ...args: unknown[]) =>
  log.some(([m, ...a]) => m === method && JSON.stringify(a) === JSON.stringify(args))

describe('fetchAllWardBoundaries', () => {
  it('filters wards by city_id when a city is given', async () => {
    await fetchAllWardBoundaries(2)
    expect(has(calls.wards[0], 'eq', 'city_id', 2)).toBe(true)
  })

  it('sends no city filter when cityId is null (the pre-city behaviour)', async () => {
    await fetchAllWardBoundaries(null)
    expect(calls.wards[0].some(([m]) => m === 'eq')).toBe(false)
  })
})

describe('fetchAllWardsAqi', () => {
  it("scopes wards by city_id and stations through their ward's city", async () => {
    await fetchAllWardsAqi(2)
    expect(has(calls.wards[0], 'eq', 'city_id', 2)).toBe(true)
    const stations = calls.stations[0]
    expect(stations[0][0]).toBe('select')
    expect(String(stations[0][1])).toContain('wards!inner(city_id)')
    expect(has(stations, 'eq', 'wards.city_id', 2)).toBe(true)
  })

  it('is unscoped for cityId null', async () => {
    await fetchAllWardsAqi(null)
    expect(calls.wards[0].some(([m]) => m === 'eq')).toBe(false)
    expect(String(calls.stations[0][0][1])).not.toContain('wards')
    expect(has(calls.stations[0], 'eq', 'is_active', true)).toBe(true)
  })

  it("returns only the city's wards with that city's station readings", async () => {
    rowsByTable.wards = [{ id: 10, name: 'DH-01-01', dominant_source: null, lat: 23.8, lng: 86.4 }]
    rowsByTable.stations = [{ id: 7, name: 'Sardar Patel Nagar', agency: 'JSPCB', ward_id: 10, is_primary: true }]
    rowsByTable.readings = [{ station_id: 7, aqi: 180, pm25: 90, pm10: 160, no2: 20, so2: 8, co: 1, o3: 30, ts: new Date().toISOString(), value_basis: 'naqi_window' }]
    const wards = await fetchAllWardsAqi(2)
    expect(wards).toHaveLength(1)
    expect(wards[0]).toMatchObject({ id: 10, aqi: 180, station_name: 'Sardar Patel Nagar', isMonitored: true })
  })
})

describe('fetchAllStationsWithReadings', () => {
  it("keeps the city's stations and ward-less ones, drops other cities'", async () => {
    rowsByTable.stations = [
      { id: 1, name: 'Delhi station', lat: 28.6, lng: 77.2, ward_id: 5, wards: { city_id: 1 } },
      { id: 2, name: 'Dhanbad station', lat: 23.8, lng: 86.4, ward_id: 10, wards: { city_id: 2 } },
      { id: 3, name: 'No ward', lat: 23.7, lng: 86.4, ward_id: null, wards: null },
    ]
    const out = await fetchAllStationsWithReadings(2)
    expect(out.map((s) => s.id)).toEqual([2, 3])
    expect(String(calls.stations[0][0][1])).toContain('wards(city_id)')
  })

  it('returns every station for cityId null', async () => {
    rowsByTable.stations = [
      { id: 1, name: 'A', lat: 28.6, lng: 77.2 },
      { id: 2, name: 'B', lat: 23.8, lng: 86.4 },
    ]
    const out = await fetchAllStationsWithReadings(null)
    expect(out.map((s) => s.id)).toEqual([1, 2])
    expect(String(calls.stations[0][0][1])).not.toContain('wards')
  })
})
