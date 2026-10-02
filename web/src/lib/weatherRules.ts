/** City-wide "weather now" for the header: the median over wards of each
 *  ward's latest reading. Median, not one ward's value, because weather is
 *  stored per ward (Open-Meteo grid, ingest/app/open_meteo.py) and the
 *  hourly write lands ward by ward, so the single newest timestamp is often
 *  only partly filled. */
export interface WeatherRow {
  ward_id: number
  ts: string
  temp_c: number | null
  humidity: number | null
}

export interface CityWeather {
  tempC: number | null
  humidity: number | null
  /** Newest reading used. */
  ts: string
  wards: number
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function summarizeCityWeather(rows: WeatherRow[]): CityWeather | null {
  const latest = new Map<number, WeatherRow>()
  for (const r of rows) {
    const cur = latest.get(r.ward_id)
    if (!cur || r.ts > cur.ts) latest.set(r.ward_id, r)
  }
  const vals = [...latest.values()]
  const temps = vals.map((r) => r.temp_c).filter((v): v is number => v != null)
  const rh = vals.map((r) => r.humidity).filter((v): v is number => v != null)
  if (temps.length === 0 && rh.length === 0) return null
  return {
    tempC: median(temps),
    humidity: median(rh),
    ts: vals.reduce((a, r) => (r.ts > a ? r.ts : a), vals[0].ts),
    wards: vals.length,
  }
}
