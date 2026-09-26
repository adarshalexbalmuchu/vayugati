import type { Database } from './database.types'
import { geometryCentroid } from './dataQualityRules'
import {
  summarizeBaselineWinners,
  summarizeForecastCoverage,
  summarizeForecastMethodMix,
  summarizeForecastReach,
  type BaselineWinnerTally,
  type ForecastCoverageSummary,
  type ForecastMethodMix,
  type ForecastReachSummary,
  type ForecastRunLike,
} from './forecastTrustRules'
import { supabase } from './supabase'

/** Enum types come from the generated schema, so a DB change surfaces as a
 *  compile error here rather than a runtime 400 from PostgREST. */
export type ReportStatus = Database['public']['Enums']['report_status']
export type SourceCategory = Database['public']['Enums']['source_category']

export interface Reading {
  aqi: number | null
  pm25: number | null
  pm10: number | null
  no2: number | null
  so2: number | null
  co: number | null
  o3: number | null
  ts: string | null
  /** Station that produced this reading — null when no station match exists. */
  station_name: string | null
  /** Monitoring agency (DPCC / IMD / IITM / CPCB) from stations.agency. */
  station_agency: string | null
}

export interface Weather {
  temp_c: number | null
  humidity: number | null
  wind_speed: number | null
  wind_dir: number | null
  precipitation: number | null
  ts: string | null
}

export interface WardSummary {
  id: number
  name: string
  dominant_source: string | null
  lat: number | null
  lng: number | null
  aqi: number | null
  pm25: number | null
  pm10: number | null
  no2: number | null
  so2: number | null
  co: number | null
  o3: number | null
  ts: string | null
  station_name: string | null
  station_agency: string | null
  /** The ward station's latest real HOURLY mean (readings_hourly), when one
   *  exists within HOURLY_FRESH_HOURS. The top-level pm25/no2/... fields come
   *  from `readings`, whose CPCB rows are 24-hour averages (CPCB publishes
   *  nothing finer), so this is what "current concentration" should show.
   *  `ts` is the start of that hour. CO in mg/m³, like everywhere else. */
  hourly: {
    ts: string
    pm25: number | null
    pm10: number | null
    no2: number | null
    so2: number | null
    co: number | null
    o3: number | null
  } | null
  /** Has at least one active station assigned. Added Sept 2026 when
   *  fetchAllWardsAqi() was extended to return every ward (not just
   *  monitored ones) — see that function's own doc comment for why.
   *  Every place that used to infer "is this ward monitored" from mere
   *  presence in the wards array (OverviewChoroplethMap's `isMonitored`,
   *  MapPage's boundary-click routing) must check this field explicitly
   *  now instead, since array presence alone no longer means monitored. */
  isMonitored: boolean
}

export interface Report {
  id: number
  description: string | null
  ai_category: string | null
  ai_meta: { note_draft?: string; confidence?: number } | null
  photo_url: string | null
  status: string
  created_at: string
  lat: number | null
  lng: number | null
}

async function stationIdsForWard(wardId: number): Promise<number[]> {
  const { data } = await supabase.from('stations').select('id').eq('ward_id', wardId)
  return (data ?? []).map((s) => s.id)
}

export async function fetchLatestReading(wardId: number): Promise<Reading | null> {
  const ids = await stationIdsForWard(wardId)
  if (!ids.length) return null
  const { data } = await supabase
    .from('readings')
    .select('aqi, pm25, pm10, no2, so2, co, o3, ts, stations(name, agency)')
    .in('station_id', ids)
    .order('ts', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  // readings.station_id → stations.id is a many-to-one FK, so PostgREST
  // returns stations as a single object, not an array.
  const st = data.stations as { name: string; agency: string | null } | null
  return {
    aqi: data.aqi,
    pm25: data.pm25,
    pm10: data.pm10,
    no2: data.no2,
    so2: data.so2 ?? null,
    co: data.co ?? null,
    o3: data.o3 ?? null,
    ts: data.ts,
    station_name: st?.name ?? null,
    station_agency: st?.agency ?? null,
  }
}

export async function fetchCurrentWeather(wardId: number): Promise<Weather | null> {
  const { data } = await supabase
    .from('weather')
    .select('temp_c, humidity, wind_speed, wind_dir, precipitation, ts')
    .eq('ward_id', wardId)
    .order('ts', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ?? null
}

export interface WindFieldPoint {
  wardId: number
  wardName: string
  lat: number
  lng: number
  windSpeed: number | null
  windDir: number | null
  ts: string | null
}

/** A small, honest wind field for the Overview map's spatial-correlation
 *  view (Sept 2026 addition) — several real wind readings spread across the
 *  city, not one fabricated "city wind" value. Wind is fetched per-location
 *  from Open-Meteo's real grid (ingest/app/open_meteo.py), so it genuinely
 *  can vary ward to ward; a single arrow would misrepresent that.
 *
 *  Bug fix (Sept 2026, 2nd pass): used to hard-filter to wards with a real
 *  captured lat/lng point — only the original 13 hotspot wards, so every
 *  wind arrow ever drawn clustered around those 13 specific locations, not
 *  a genuinely city-wide sample, even though weather data exists for all
 *  265 wards (via the boundary-centroid fallback ingest.py's weather step
 *  already uses). The old doc comment argued the 13 "happens to already be
 *  spread across the city... so it doubles as a reasonable spatial
 *  sample" — true as far as it went, but a real per-ward sample covering
 *  all 265 is strictly better than a fixed 13-point proxy for "spread
 *  across the city," and costs nothing extra: fetchAllWindByWard() already
 *  does one bulk query for every ward's latest reading (same query
 *  MapPage's own wind-arrow layer uses), so this just joins that against
 *  every ward's position (real point, or geometryCentroid() of its
 *  boundary — same fallback classifyWardCoverage() already uses) instead
 *  of a second per-ward fetchCurrentWeather() call per point. */
export async function fetchWindField(): Promise<WindFieldPoint[]> {
  const [{ data: wards }, windByWard] = await Promise.all([
    supabase.from('wards').select('id, name, lat, lng, boundary'),
    fetchAllWindByWard(),
  ])
  if (!wards) return []

  const windById = new Map(windByWard.map((w) => [w.ward_id, w]))
  const points: WindFieldPoint[] = []
  for (const w of wards) {
    let lat = w.lat
    let lng = w.lng
    if (lat == null || lng == null) {
      const geometry = w.boundary as unknown as GeoJSON.Polygon | GeoJSON.MultiPolygon | null
      const centroid = geometry ? geometryCentroid(geometry) : null
      if (!centroid) continue // genuinely no usable position — skipped, not fabricated
      lat = centroid.lat
      lng = centroid.lng
    }
    const wind = windById.get(w.id)
    points.push({
      wardId: w.id,
      wardName: w.name,
      lat,
      lng,
      windSpeed: wind?.wind_speed ?? null,
      windDir: wind?.wind_dir ?? null,
      ts: wind?.ts ?? null,
    })
  }
  return points
}

/** How far back fetchAllWardsAqi looks for a station's last-known reading
 *  when it has nothing in the normal 3h window. Long enough to ride out a
 *  multi-day upstream outage; the reading's `ts` marks it stale downstream. */
export const LAST_KNOWN_READING_HOURS = 72

/** An hourly mean older than this isn't shown as "current". The ingest
 *  service fills readings_hourly once an hour with a 6h look-back. */
export const HOURLY_FRESH_HOURS = 6

export async function fetchAllWardsAqi(): Promise<WardSummary[]> {
  // Bug fix (Sept 2026): this used to return ONLY "monitored" wards (has
  // at least one active station) — 39 of 265. That was fine while nothing
  // else needed an unmonitored ward's row, but VayuTrace source
  // attribution (vayutrace_v1) now covers all 265 wards (confirmed live:
  // every ward gets a real dispersion-kernel estimate from wind +
  // boundary-centroid alone, no station required) — yet the Map page's
  // ward detail panel could never show it for the other 226, because they
  // were never even present in this array for `wards.find(...)` to match.
  // Now returns every ward; AQI/pollutant/station fields are null for an
  // unmonitored one (already handled gracefully everywhere this array is
  // consumed - "Unavailable" fallbacks, "No monitoring station matched"
  // messages, etc.) rather than the row being absent entirely.
  //
  // `isMonitored` (see WardSummary's own doc comment) is the explicit
  // replacement for "is this id present in the array" as the monitored
  // signal, now that presence alone no longer means monitored.
  const { data: allStations } = await supabase.from('stations').select('id, name, agency, ward_id, is_primary').eq('is_active', true)
  const monitoredWardIds = new Set((allStations ?? []).map((s) => s.ward_id).filter((id): id is number => id != null))

  const allStationIds = (allStations ?? []).map((s) => s.id)
  const since = new Date(Date.now() - 3 * 3600 * 1000).toISOString()

  const [{ data: wards }, { data: recentReadings }] = await Promise.all([
    supabase.from('wards').select('id, name, dominant_source, lat, lng').order('name'),
    // Latest reading per station: fetch recent window, keep first row per station.
    // Empty allStationIds (no active stations at all) still resolves fine —
    // .in('station_id', []) returns zero rows, not an error.
    supabase
      .from('readings')
      .select('station_id, aqi, pm25, pm10, no2, so2, co, o3, ts')
      .in('station_id', allStationIds)
      .gte('ts', since)
      .order('ts', { ascending: false })
      .limit(Math.max(allStationIds.length, 1) * 4),
  ])
  if (!wards) return []

  // Latest real hourly mean per station (see WardSummary.hourly).
  const hourlySince = new Date(Date.now() - HOURLY_FRESH_HOURS * 3600 * 1000).toISOString()
  const { data: hourlyRows } = await supabase
    .from('readings_hourly')
    .select('station_id, ts, pm25, pm10, no2, so2, co, o3')
    .in('station_id', allStationIds)
    .gte('ts', hourlySince)
    .order('ts', { ascending: false })
    .limit(Math.max(allStationIds.length, 1) * (HOURLY_FRESH_HOURS + 1))
  const hourlyByStation = new Map<number, NonNullable<WardSummary['hourly']>>()
  for (const r of hourlyRows ?? []) {
    if (!hourlyByStation.has(r.station_id)) {
      hourlyByStation.set(r.station_id, { ts: r.ts, pm25: r.pm25, pm10: r.pm10, no2: r.no2, so2: r.so2, co: r.co, o3: r.o3 })
    }
  }

  const wardStations = new Map<number, { id: number; name: string; agency: string | null; is_primary: boolean }[]>()
  for (const s of allStations ?? []) {
    if (s.ward_id == null) continue
    const list = wardStations.get(s.ward_id) ?? []
    list.push({ id: s.id, name: s.name, agency: s.agency, is_primary: s.is_primary ?? false })
    wardStations.set(s.ward_id, list)
  }

  const latestByStation = new Map<number, typeof recentReadings extends (infer T)[] | null ? T : never>()
  for (const r of recentReadings ?? []) {
    if (!latestByStation.has(r.station_id)) latestByStation.set(r.station_id, r)
  }

  // Last-known fallback (Sept 2026, CPCB outage): a station with nothing in
  // the 3h window used to vanish, so a ~2-day data.gov.in/OpenAQ outage
  // blanked every AQI on the dashboard. Look further back for just those
  // stations and show their last value; `ts` rides along so every consumer's
  // existing staleness handling (hotspotStatus 'stale', the map's faded
  // fill, "(stale reading)" labels) marks it as old rather than current.
  const missing = allStationIds.filter((id) => !latestByStation.has(id))
  if (missing.length > 0) {
    const lastKnownSince = new Date(Date.now() - LAST_KNOWN_READING_HOURS * 3600 * 1000).toISOString()
    const { data: older } = await supabase
      .from('readings')
      .select('station_id, aqi, pm25, pm10, no2, so2, co, o3, ts')
      .in('station_id', missing)
      .gte('ts', lastKnownSince)
      .lt('ts', since)
      .order('ts', { ascending: false })
      .limit(missing.length * 4)
    for (const r of older ?? []) {
      if (!latestByStation.has(r.station_id)) latestByStation.set(r.station_id, r)
    }
  }

  return wards.map((ward) => {
    const stations = wardStations.get(ward.id) ?? []
    // Prefer the is_primary station if it has a recent reading; fall back to
    // the station with the freshest reading. This prevents apparent AQI
    // step-changes caused by silent sensor switches when a station goes offline.
    let best: { reading: typeof recentReadings extends (infer T)[] | null ? T : never; station: typeof stations[number] } | null = null
    for (const s of stations) {
      const r = latestByStation.get(s.id)
      if (!r) continue
      if (!best || (s.is_primary && !best.station.is_primary) || (!best.station.is_primary && r.ts > best.reading.ts)) {
        best = { reading: r, station: s }
      }
    }
    return {
      ...ward,
      aqi: best?.reading.aqi ?? null,
      pm25: best?.reading.pm25 ?? null,
      pm10: best?.reading.pm10 ?? null,
      no2: best?.reading.no2 ?? null,
      so2: best?.reading.so2 ?? null,
      co: best?.reading.co ?? null,
      o3: best?.reading.o3 ?? null,
      ts: best?.reading.ts ?? null,
      station_name: best?.station.name ?? null,
      station_agency: best?.station.agency ?? null,
      // Same station as the reading above when it has an hourly mean; else
      // whichever of the ward's stations does.
      hourly: (best && hourlyByStation.get(best.station.id))
        ?? stations.map((s) => hourlyByStation.get(s.id)).find((h) => h != null)
        ?? null,
      isMonitored: monitoredWardIds.has(ward.id),
    }
  })
}

export interface WardBoundary {
  id: number
  name: string
  wardNumber: number | null
  /** 'mcd' for a real numbered municipal ward (Phase 2 import); 'ndmc' or
   *  'cantonment' for the two non-MCD jurisdictions inside the Map's
   *  viewport (OSM import) - read from wards.metadata.jurisdiction_type,
   *  defaulting to 'mcd' for rows that predate that field. */
  jurisdictionType: 'mcd' | 'ndmc' | 'cantonment'
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
  /** A representative point for this ward, if one was captured during
   *  import - null for many of the 250 Phase 2 municipal-boundary wards
   *  (only the 13 hotspot wards were guaranteed one). Used only to compute
   *  "nearest station" honestly - never fabricated when absent. */
  lat: number | null
  lng: number | null
  /** Set only for hotspot wards whose boundary was borrowed from an MCD
   *  ward polygon (scripts/link-hotspot-ward-boundaries.ts) - the Ward_No
   *  of that donor polygon, so the Overview map can hide the now-redundant
   *  grey MCD polygon underneath the colored hotspot fill. Null for the
   *  250 real municipal-boundary wards themselves and for any hotspot
   *  ward not yet linked. */
  donorWardNumber: number | null
}

/** Real ward boundary polygons for the Map's ward-boundary layer - covers
 *  every ward with real captured geometry (the Phase 2 municipal import,
 *  the NDMC/Cantonment OSM import, and the 13 hotspot wards now linked by
 *  scripts/link-hotspot-ward-boundaries.ts), not just the monitored-ward
 *  set fetchAllWardsAqi() is scoped to. Never a hardcoded polygon - if
 *  Supabase has no boundary data yet, this returns an empty array and the
 *  layer stays disabled (see MapPage.tsx). */
export async function fetchAllWardBoundaries(): Promise<WardBoundary[]> {
  const { data } = await supabase
    .from('wards')
    .select('id, name, ward_number, boundary, metadata, lat, lng')
    .not('boundary', 'is', null)
    .order('ward_number', { ascending: true, nullsFirst: false })
  if (!data) return []
  return data
    .filter((w): w is typeof w & { boundary: NonNullable<typeof w.boundary> } => w.boundary != null)
    .map((w) => {
      const meta = w.metadata as { jurisdiction_type?: string; donor_ward_number?: number } | null
      const jurisdictionType = meta?.jurisdiction_type === 'ndmc' || meta?.jurisdiction_type === 'cantonment' ? meta.jurisdiction_type : 'mcd'
      return {
        id: w.id,
        name: w.name,
        wardNumber: w.ward_number,
        jurisdictionType,
        geometry: w.boundary as unknown as GeoJSON.Polygon | GeoJSON.MultiPolygon,
        lat: w.lat,
        lng: w.lng,
        donorWardNumber: typeof meta?.donor_ward_number === 'number' ? meta.donor_ward_number : null,
      }
    })
}

export interface StationMarker {
  id: number
  name: string
  lat: number
  lng: number
  aqi: number | null
  pm25: number | null
  pm10: number | null
  no2: number | null
  so2: number | null
  co: number | null
  o3: number | null
}

/** Station-level counterpart to fetchAllWardsAqi — same shape MapView
 *  already renders, just one marker per station instead of per ward.
 *
 *  Previously "two queries total (stations, readings), never one per
 *  station" - a single unfiltered `readings` fetch, deduped to "latest per
 *  station" in JS. That was fine when `readings` was small, but at current
 *  scale (19 stations, 25k+ rows and growing with every ingest run) it
 *  pulled the ENTIRE table - 2.5MB, all history, to use 19 rows of it -
 *  and did so on every Map page load. Switched to one bounded `.limit(1)`
 *  query per station instead, run in parallel (`Promise.all`, not a
 *  sequential loop) - the same `readings (station_id, ts desc)` index this
 *  file's own `fetchLatestReading()` already relies on makes each of those
 *  trivially fast, and the total payload drops to ~19 rows regardless of
 *  how large `readings` grows. Still correctly shows a stale station's
 *  true last reading (not silently "no data") - a fixed recent-time-window
 *  filter on the single query was considered and rejected for exactly that
 *  reason. */
// Readings older than this are treated as stale: AQI is suppressed to null
// so the marker renders grey rather than showing a misleading outdated value.
// 3h matches the ingest service's own STALE_MINUTES=180 convention.
const STATION_AQI_STALE_MS = 3 * 60 * 60 * 1000

export async function fetchAllStationsWithReadings(): Promise<StationMarker[]> {
  const { data: stations } = await supabase.from('stations').select('id, name, lat, lng').order('name')
  if (!stations) return []

  // Only look at readings from the last 3 hours. Readings older than that
  // are stale — showing their AQI as current would mislead (e.g. Wazirpur
  // at 274 when CPCB has no data for it means the station went offline after
  // its last report, not that it's currently at 274).
  const staleCutoff = new Date(Date.now() - STATION_AQI_STALE_MS).toISOString()

  const latestByStation = new Map<number, { aqi: number | null; pm25: number | null; pm10: number | null; no2: number | null; so2: number | null; co: number | null; o3: number | null }>()
  await Promise.all(
    stations.map(async (s) => {
      const { data } = await supabase
        .from('readings')
        .select('aqi, pm25, pm10, no2, so2, co, o3')
        .eq('station_id', s.id)
        .gte('ts', staleCutoff)
        .order('ts', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (data) latestByStation.set(s.id, data)
    }),
  )

  return stations
    .filter((s) => s.lat != null && s.lng != null)
    .map((s) => {
      const reading = latestByStation.get(s.id)
      return {
        id: s.id,
        name: s.name,
        lat: s.lat as number,
        lng: s.lng as number,
        aqi: reading?.aqi ?? null,
        pm25: reading?.pm25 ?? null,
        pm10: reading?.pm10 ?? null,
        no2: reading?.no2 ?? null,
        so2: reading?.so2 ?? null,
        co: reading?.co ?? null,
        o3: reading?.o3 ?? null,
      }
    })
}

export interface WardHistoryPoint {
  ts: string
  aqi: number | null
  pm25: number | null
}

/** A ward's own real reading history over the last `days` — the "how did we
 *  get here" complement to the 48h forecast chart, which only ever shows
 *  the future. Added Sept 2026 after a review of the Overview dashboard
 *  from a researcher/policy-maker's perspective flagged that this app had
 *  no way to see whether a current reading is a sudden spike or a slow
 *  multi-day climb — every existing number was a single snapshot in time.
 *
 *  Picks ONE representative station per ward (the same is_primary-preferred
 *  choice fetchAllWardsAqi already makes for "the ward's current reading"),
 *  not an average across multiple stations — consistent with what a
 *  commander/researcher already sees as "this ward's AQI" elsewhere in the
 *  app, rather than a second, differently-computed number for the same ward. */
export async function fetchWardHistory(wardId: number, days: number): Promise<WardHistoryPoint[]> {
  const { data: stations } = await supabase
    .from('stations')
    .select('id, is_primary')
    .eq('ward_id', wardId)
    .eq('is_active', true)
  if (!stations || stations.length === 0) return []

  const primary = stations.find((s) => s.is_primary)
  const stationId = primary?.id ?? stations[0].id

  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
  const { data } = await supabase
    .from('readings')
    .select('ts, aqi, pm25')
    .eq('station_id', stationId)
    .gte('ts', since)
    .order('ts', { ascending: true })
  return (data ?? []).map((r) => ({ ts: r.ts, aqi: r.aqi, pm25: r.pm25 }))
}

export interface HistoricalStationReading {
  stationId: number
  aqi: number | null
  pm25: number | null
  pm10: number | null
  no2: number | null
  /** ISO timestamp of the reading row that was selected (nearest to `at` but not after). */
  ts: string | null
}

/** Fetch the reading closest to `at` (but not after it) for each station id,
 *  using the existing `readings (station_id, ts desc)` index.  Returns a Map
 *  keyed by station id; stations with no row before `at` are absent.  Runs
 *  in parallel — same pattern as fetchAllStationsWithReadings. */
export async function fetchHistoricalStationReadings(
  stationIds: number[],
  at: Date,
): Promise<Map<number, HistoricalStationReading>> {
  const result = new Map<number, HistoricalStationReading>()
  if (stationIds.length === 0) return result
  const atIso = at.toISOString()
  await Promise.all(
    stationIds.map(async (id) => {
      const { data } = await supabase
        .from('readings')
        .select('aqi, pm25, pm10, no2, ts')
        .eq('station_id', id)
        .lte('ts', atIso)
        .order('ts', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (data) {
        result.set(id, {
          stationId: id,
          aqi: data.aqi,
          pm25: data.pm25,
          pm10: data.pm10,
          no2: data.no2,
          ts: data.ts,
        })
      }
    }),
  )
  return result
}

export async function fetchOpenReports(wardId: number): Promise<Report[]> {
  const { data } = await supabase
    .from('reports')
    .select('id, description, ai_category, ai_meta, photo_url, status, created_at, lat, lng')
    .eq('ward_id', wardId)
    .in('status', ['submitted', 'verified', 'assigned'])
    .order('created_at', { ascending: false })
    .limit(20)
  return (data ?? []) as Report[]
}

/** City-wide counterpart to fetchOpenReports - same real table/status filter,
 *  without the ward scope, for the Map page's citizen-reports layer. */
export async function fetchAllOpenReports(): Promise<Report[]> {
  const { data } = await supabase
    .from('reports')
    .select('id, description, ai_category, ai_meta, photo_url, status, created_at, lat, lng')
    .in('status', ['submitted', 'verified', 'assigned'])
    .order('created_at', { ascending: false })
    .limit(200)
  return (data ?? []) as Report[]
}

// ── report submission ────────────────────────────────────────────────────────

/** Upload a photo to the report-photos bucket under the user's folder. Returns public URL. */
export async function uploadReportPhoto(file: File, userId: string): Promise<string> {
  const ext = file.name.split('.').pop() || 'jpg'
  const path = `${userId}/${Date.now()}.${ext}`
  const { error } = await supabase.storage
    .from('report-photos')
    .upload(path, file, { contentType: file.type, upsert: false })
  if (error) throw error
  const { data } = supabase.storage.from('report-photos').getPublicUrl(path)
  return data.publicUrl
}

export async function insertReport(params: {
  wardId: number
  reporterId: string
  description: string
  lat: number | null
  lng: number | null
  photoUrl?: string | null
}): Promise<number> {
  const { data, error } = await supabase
    .from('reports')
    .insert({
      ward_id: params.wardId,
      reporter_id: params.reporterId,
      description: params.description,
      lat: params.lat,
      lng: params.lng,
      photo_url: params.photoUrl ?? null,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

// ── ranked action queue (Phase 1/4): priority by predicted impact ────────────

// how actionable / severe each source is, as an enforcement lever
const CATEGORY_WEIGHT: Record<string, number> = {
  open_burning: 1.0,
  construction_dust: 0.9,
  industrial: 0.85,
  road_dust: 0.7,
  waste: 0.7,
  vehicular: 0.6,
  other: 0.5,
}

/** Rank a report by predicted impact: source severity × AI confidence × age (SLA
 *  urgency) × the ward's forecast local excess (the controllable load that's rising). */
export function priorityScore(report: Report, wardPeakExcess: number | null): number {
  const cat = CATEGORY_WEIGHT[report.ai_category ?? 'other'] ?? 0.5
  const conf = report.ai_meta?.confidence ?? 0.5
  const ageH = (Date.now() - new Date(report.created_at).getTime()) / 3_600_000
  const ageFactor = 1 + Math.min(ageH / 24, 2) // older unresolved → more urgent, cap 3×
  const excess = Math.max(wardPeakExcess ?? 0, 0)
  const excessFactor = 1 + Math.min(excess / 100, 1) // rising forecast load amplifies
  return cat * (0.5 + 0.5 * conf) * ageFactor * excessFactor
}

export function priorityBand(score: number): { label: string; cls: string } {
  if (score >= 4) return { label: 'High', cls: 'bg-red-100 text-red-700' }
  if (score >= 2.5) return { label: 'Medium', cls: 'bg-orange-100 text-orange-700' }
  return { label: 'Low', cls: 'bg-slate-100 text-slate-600' }
}

// ── daily roll-up (Phase 1): the auto-generated War Room summary ──────────────

export interface WardRollup {
  open: number
  resolved: number
  medianGatiHours: number | null
  topCategory: string | null
}

export async function fetchWardRollup(wardId: number): Promise<WardRollup> {
  const { data: reports } = await supabase
    .from('reports')
    .select('id, created_at, status, ai_category')
    .eq('ward_id', wardId)
    .limit(500)

  const ids = (reports ?? []).map((r) => r.id as number)
  const resolvedAt = new Map<number, string>()
  if (ids.length) {
    const { data: events } = await supabase
      .from('report_events')
      .select('report_id, ts')
      .eq('status', 'resolved')
      .in('report_id', ids)
      .limit(1000)
    for (const e of events ?? []) resolvedAt.set(e.report_id as number, e.ts as string)
  }

  let open = 0
  const durations: number[] = []
  const catCount: Record<string, number> = {}
  for (const r of reports ?? []) {
    const res = resolvedAt.get(r.id as number)
    if (res) {
      durations.push((new Date(res).getTime() - new Date(r.created_at as string).getTime()) / 3_600_000)
    } else if (r.status !== 'rejected') {
      open++
    }
    if (r.ai_category) catCount[r.ai_category as string] = (catCount[r.ai_category as string] ?? 0) + 1
  }
  durations.sort((a, b) => a - b)
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : null
  const topCategory =
    Object.entries(catCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  return { open, resolved: durations.length, medianGatiHours: median, topCategory }
}

// ── citizen: my reports ──────────────────────────────────────────────────────

export interface MyReport {
  id: number
  description: string | null
  ai_category: string | null
  ai_meta: { hindi_advisory?: string } | null
  status: string
  created_at: string
  /** Set once the report has been matched to (or has opened) an incident. */
  incident_id: number | null
}

export async function fetchMyReports(userId: string): Promise<MyReport[]> {
  const { data } = await supabase
    .from('reports')
    .select('id, description, ai_category, ai_meta, status, created_at, incident_id')
    .eq('reporter_id', userId)
    .order('created_at', { ascending: false })
    .limit(10)
  return (data ?? []) as MyReport[]
}

// ── field officer: status transitions ───────────────────────────────────────

export async function updateReportStatus(
  reportId: number,
  status: ReportStatus,
  actorId: string,
  note?: string,
): Promise<void> {
  // Single atomic RPC — updates reports.status AND inserts report_events in
  // one transaction. Prevents the audit log recording a transition that never
  // took effect (or a network drop leaving status updated with no audit row).
  const { error } = await supabase.rpc('update_report_status', {
    p_report_id: reportId,
    p_status: status,
    p_actor_id: actorId,
    p_note: note,
  })
  if (error) throw error
}

// ── AI classification (calls ingest service) ─────────────────────────────────

// ── forecast (Phase 2) ───────────────────────────────────────────────────────

export interface ForecastPoint {
  horizon_ts: string
  pm25_pred: number | null
  baseline_pred: number | null
  local_excess: number | null
  confidence: number | null
  model_version: string | null
  /** Universal predicted-value column (every pollutant); `pm25_pred` is a
   *  legacy alias only ever populated for pollutant='pm25' rows (see
   *  forecast.py). Optional here since fetchForecast()'s narrower select
   *  below doesn't fetch it - only fetchAllForecasts() (Map/Overview,
   *  multi-pollutant) does. */
  predicted_value?: number | null
  /** Ward-level nowcasting (+1h). True on at most one row per forecast_run_id
   *  (forecasts_one_nowcast_point_per_run partial unique index) - the row
   *  the backend selected as closest to generated_at+1h within tolerance,
   *  never independently recomputed client-side against Date.now(). */
  is_nowcast_point: boolean
  lower_bound: number | null
  upper_bound: number | null
  /** Which candidate (lightgbm/persistence/diurnal/same_hour_yesterday/
   *  rolling_24h_avg) actually produced this row's value - only populated on
   *  the is_nowcast_point row. */
  nowcast_method: string | null
  nowcast_backtest_samples: number | null
  /** Never collapses to "lightgbm won" - true whenever the periodic backtest
   *  (ingest/scripts/nowcast_backtest.py) selected ANY candidate, baseline or
   *  model, with enough samples and a met performance bar. False means the
   *  persistence fallback is showing, not that no number exists. */
  nowcast_backtest_passed: boolean | null
  /** forecast_runs provenance, joined via forecast_run_id - the anchor
   *  reading's own timestamp (training_period_end), NOT generated_at+1h;
   *  these two can differ whenever the anchor lags generation. */
  anchorObservedAt: string | null
  forecastGeneratedAt: string | null
  forecastMethod: string | null
  dataQualityStatus: string | null
  /** forecast_runs.max_validated_horizon_hours / beats_persistence — added
   *  Sept 2026 so callers can show an honest confidence tier (see
   *  incidentRules.ts's confidenceTierLabel) instead of the misleading raw
   *  `confidence` float above, which is a hand-picked 0.4-0.9 tier marker,
   *  not a calibrated probability, and collides to the same 0.5 value for
   *  both "validated to 12h" and "not validated at all." */
  maxValidatedHorizonHours: number | null
  beatsPersistence: boolean | null
}

/**
 * The citizen-facing PM2.5 curve. Explicitly scoped to `pollutant = 'pm25'`
 * as of Phase 8 — `forecasts` now also holds pm10/no2 rows for the same
 * ward side by side, so an unscoped query here would silently mix a
 * different pollutant's numbers into what this chart presents as PM2.5.
 */
/** forecasts row shape as returned by supabase-js with the forecast_runs
 *  embed - the embed comes back as a nested object keyed by the related
 *  table name, not flattened, so callers map it into ForecastPoint's flat
 *  anchorObservedAt/forecastGeneratedAt/forecastMethod/dataQualityStatus. */
interface _ForecastRow {
  horizon_ts: string
  pm25_pred: number | null
  baseline_pred: number | null
  local_excess: number | null
  confidence: number | null
  model_version: string | null
  predicted_value?: number | null
  is_nowcast_point: boolean
  lower_bound: number | null
  upper_bound: number | null
  nowcast_method: string | null
  nowcast_backtest_samples: number | null
  nowcast_backtest_passed: boolean | null
  forecast_runs: {
    training_period_end: string | null
    generated_at: string
    method: string
    data_quality_status: string
    max_validated_horizon_hours: number | null
    beats_persistence: boolean
  } | null
}

function _mapForecastRow(row: _ForecastRow): ForecastPoint {
  return {
    horizon_ts: row.horizon_ts,
    pm25_pred: row.pm25_pred,
    baseline_pred: row.baseline_pred,
    local_excess: row.local_excess,
    confidence: row.confidence,
    model_version: row.model_version,
    predicted_value: row.predicted_value,
    is_nowcast_point: row.is_nowcast_point,
    lower_bound: row.lower_bound,
    upper_bound: row.upper_bound,
    nowcast_method: row.nowcast_method,
    nowcast_backtest_samples: row.nowcast_backtest_samples,
    nowcast_backtest_passed: row.nowcast_backtest_passed,
    anchorObservedAt: row.forecast_runs?.training_period_end ?? null,
    forecastGeneratedAt: row.forecast_runs?.generated_at ?? null,
    forecastMethod: row.forecast_runs?.method ?? null,
    dataQualityStatus: row.forecast_runs?.data_quality_status ?? null,
    maxValidatedHorizonHours: row.forecast_runs?.max_validated_horizon_hours ?? null,
    beatsPersistence: row.forecast_runs?.beats_persistence ?? null,
  }
}

const FORECAST_ROW_SELECT =
  'horizon_ts, pm25_pred, baseline_pred, local_excess, confidence, model_version, is_nowcast_point, lower_bound, upper_bound, nowcast_method, nowcast_backtest_samples, nowcast_backtest_passed, forecast_runs(training_period_end, generated_at, method, data_quality_status, max_validated_horizon_hours, beats_persistence)'

export async function fetchForecast(wardId: number): Promise<ForecastPoint[]> {
  const { data } = await supabase
    .from('forecasts')
    .select(FORECAST_ROW_SELECT)
    .eq('ward_id', wardId)
    .eq('pollutant', 'pm25')
    .order('horizon_ts')
    .limit(48)
  return ((data ?? []) as unknown as _ForecastRow[]).map(_mapForecastRow)
}

// ── wind data (Phase 1I: wind flow layer) ────────────────────────────────────

export interface WindReading {
  ward_id: number
  wind_speed: number | null
  wind_dir: number | null
  /** Added Sept 2026 (was already fetched, just not returned) so
   *  fetchWindField() can show it without a second per-ward query. */
  ts: string | null
}

/** Latest wind reading per ward (last 2h window). One query, deduped in JS. */
export async function fetchAllWindByWard(): Promise<WindReading[]> {
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const { data } = await supabase
    .from('weather')
    .select('ward_id, ts, wind_speed, wind_dir')
    .gte('ts', since)
    .order('ts', { ascending: false })
  const latest = new Map<number, WindReading>()
  for (const row of (data ?? [])) {
    if (row.ward_id != null && !latest.has(row.ward_id)) {
      latest.set(row.ward_id, { ward_id: row.ward_id, wind_speed: row.wind_speed, wind_dir: row.wind_dir, ts: row.ts ?? null })
    }
  }
  return [...latest.values()]
}

// Sept 2026: extended from ('pm25' | 'pm10' | 'no2') — forecast.py's
// DEFAULT_ENABLED_POLLUTANTS now trains so2/co/o3 too, since the readings
// data (db.get_readings_history()) and the forecast_runs/forecasts schema
// already supported all six pollutants; only the Python enabled-list and
// this type were still hardcoded to three. See forecastPollutantFor()'s
// own updated comment for what this actually changes for callers.
export type ForecastPollutant = 'pm25' | 'pm10' | 'no2' | 'so2' | 'co' | 'o3'

export interface WardForecastSummary {
  wardId: number
  /** Which pollutant these points/peaks actually are - carried alongside
   *  the data itself so a consumer several components away (Map markers,
   *  Overview's Hotspots table) can never silently mislabel it. */
  pollutant: ForecastPollutant
  points: ForecastPoint[]
  peakPred: number | null
  peakExcess: number | null
  peakTs: string | null
  /** Hours until the forecast first crosses the CPCB AQI "Severe" entry
   *  (PM2.5 = 250 µg/m³ → AQI 400). Only computed for PM2.5; always null
   *  for PM10/NO2 - never a fabricated severity claim for a pollutant with
   *  no stated threshold here. */
  hoursToSevere: number | null
  /** Hours until the forecast first crosses the AQI "Very Poor" entry
   *  (PM2.5 = 120 µg/m³ → AQI 300). This is the operationally meaningful
   *  action threshold:
   *    • GRAP (CAQM) Stage III construction/generator bans trigger at AQI 300.
   *    • AQHI epidemiology study (IOP ERL 2025): +9% excess daily mortality
   *      in the AQI 300–400 range — steepest health inflection point.
   *    • Cusworth et al. (ES&T 2020) uses 120 µg/m³ as the "episode" threshold.
   *  Distinct from hoursToSevere so callers can choose the appropriate level
   *  for their purpose (advisory vs. enforcement). Only computed for PM2.5. */
  hoursToVeryPoor: number | null
  /** Hours until the forecast first crosses India's NAAQS 24h PM2.5 standard
   *  (60 µg/m³ → AQI ~100, top of "Satisfactory"). NAAQS exceedance is the
   *  primary metric used in Indian health-burden literature (GBD India 2019;
   *  Chowdhury et al. 2019 Lancet Planet. Health; Navinya et al. 2020) because
   *  it anchors to the country's own legal air quality standard — a ward
   *  perpetually "Satisfactory" by CPCB AQI is still exceeding NAAQS if PM2.5
   *  stays above 60 µg/m³. Only computed for PM2.5. */
  hoursToNaaqs: number | null
}

/** PM2.5 concentration (µg/m³) at the CPCB AQI "Severe" band entry (AQI 400).
 *  Source: CPCB National AQI 2014 breakpoints, unchanged as of Aug 2026. */
const SEVERE_THRESHOLD_PM25 = 250

/** PM2.5 concentration (µg/m³) at the CPCB AQI "Very Poor" band entry (AQI 300).
 *  This is the GRAP Stage III / AQHI-defined primary action threshold. */
const VERY_POOR_THRESHOLD_PM25 = 120

/** India's NAAQS 24h PM2.5 standard (µg/m³). Exceeding this is the primary
 *  metric used in Indian health-burden and policy literature:
 *    • GBD India Collaborators (2019) Lancet: PM2.5 burden framed against NAAQS.
 *    • Chowdhury et al. (2019) Lancet Planet. Health: 660,000 deaths/year above NAAQS.
 *    • Navinya et al. (2020): exceedance days per year as the core KPI.
 *  Corresponds to CPCB AQI ≈ 100 (top of "Satisfactory" band).
 *  Source: CPCB NAAQS notification, updated 2012; unchanged as of Aug 2026. */
const NAAQS_THRESHOLD_PM25 = 60

/** WHO Air Quality Guidelines 2021 — 24h PM2.5 mean (µg/m³). Nearly every
 *  Delhi ward exceeds this continuously. Surfacing the ratio (actual ÷ WHO AQG)
 *  contextualises "Good" CPCB AQI readings for non-expert users. */
export const WHO_AQG_PM25_24H = 15

/** Real forecast.py output for whichever of the 3 forecast-covered
 *  pollutants is requested (pm25/pm10/no2 - see forecast.py's
 *  DEFAULT_ENABLED_POLLUTANTS; AQI itself is never forecast, it's a
 *  composite index the pipeline doesn't compute - callers needing an
 *  "AQI view" use this with pollutant='pm25' as an explicitly-labelled
 *  proxy, never a fabricated AQI number). Defaults to 'pm25' to match every
 *  existing caller's prior behaviour before this became parameterized. */
export async function fetchAllForecasts(pollutant: ForecastPollutant = 'pm25'): Promise<Map<number, WardForecastSummary>> {
  const { data } = await supabase
    .from('forecasts')
    .select(`ward_id, predicted_value, ${FORECAST_ROW_SELECT}`)
    .eq('pollutant', pollutant)
    .gte('horizon_ts', new Date().toISOString())
    .order('horizon_ts')
    .limit(48 * 300)
  const byWard = new Map<number, WardForecastSummary>()
  for (const row of (data ?? []) as unknown as (_ForecastRow & { ward_id: number })[]) {
    const wardId = row.ward_id
    let entry = byWard.get(wardId)
    if (!entry) {
      entry = { wardId, pollutant, points: [], peakPred: null, peakExcess: null, peakTs: null, hoursToSevere: null, hoursToVeryPoor: null, hoursToNaaqs: null }
      byWard.set(wardId, entry)
    }
    entry.points.push(_mapForecastRow(row))
  }
  const now = Date.now()
  for (const entry of byWard.values()) {
    for (const p of entry.points) {
      // predicted_value is the universal column; pm25_pred is kept as a
      // fallback only for a row written before that column existed.
      const predicted = p.predicted_value ?? p.pm25_pred
      if (predicted != null && (entry.peakPred == null || predicted > entry.peakPred)) {
        entry.peakPred = predicted
        entry.peakExcess = p.local_excess
        entry.peakTs = p.horizon_ts
      }
      if (pollutant === 'pm25' && predicted != null) {
        const hoursOut = Math.round((new Date(p.horizon_ts).getTime() - now) / 3_600_000)
        if (entry.hoursToNaaqs == null && predicted >= NAAQS_THRESHOLD_PM25) {
          entry.hoursToNaaqs = hoursOut
        }
        if (entry.hoursToVeryPoor == null && predicted >= VERY_POOR_THRESHOLD_PM25) {
          entry.hoursToVeryPoor = hoursOut
        }
        if (entry.hoursToSevere == null && predicted >= SEVERE_THRESHOLD_PM25) {
          entry.hoursToSevere = hoursOut
        }
      }
    }
  }
  return byWard
}

// ── attribution (Phase 3) ────────────────────────────────────────────────────

export interface Attribution {
  direction: string | null
  breakdown: Record<string, number> | null
  confidence: number | null
  method: string | null
  ts: string
}

export async function fetchAttribution(wardId: number): Promise<Attribution | null> {
  // Filter to the wind-rose method so this function always returns directional
  // data (direction, compass breakdown). The ISRM source-type breakdown is
  // fetched separately via fetchVayuTraceAttribution().
  const { data } = await supabase
    .from('attributions')
    .select('direction, breakdown, confidence, method, ts')
    .eq('ward_id', wardId)
    .eq('method', 'pollution_rose_v1')
    .order('ts', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  return { ...data, breakdown: (data.breakdown ?? null) as Record<string, number> | null }
}

/** p10/p50/p90 for one source type's share, from the kernel's Monte Carlo
 *  draws. Bands are WIDE — median dominant-source width is ~0.44 across
 *  Delhi — so anything rendering `breakdown` must render these too rather
 *  than presenting a point estimate as settled. */
export interface VayuTraceBand {
  p10: number
  p50: number
  p90: number
}

export interface VayuTraceAttribution {
  /** {industrial, road, fire, dust, unknown} — fractions summing to 1,
   *  local excess only. `dust` added Sept 2026 (AP-42 road resuspension +
   *  WRAP construction); rows written before that omit it. */
  breakdown:
    | { industrial: number; road: number; fire: number; dust?: number; unknown: number }
    | null
  /** Per-source-type Monte Carlo bands matching `breakdown`. NULL on rows
   *  written before the uncertainty work, or when the kernel ran with
   *  mc_draws=0. */
  breakdown_uncertainty: Record<string, VayuTraceBand> | null
  /** 0-1. As of Sept 2026 this means "how TIGHT is the dominant source's
   *  Monte Carlo interval", i.e. a real uncertainty measure. It previously
   *  meant distance-to-nearest-station, which is now `station_proximity`. */
  confidence: number | null
  /** 0-1 proximity to the nearest CPCB station — a model-ANCHORING proxy,
   *  not a confidence measure. A ward can sit next to a station and still
   *  be attributed wrongly if the local emission geometry is wrong. */
  station_proximity: number | null
  /**
   * IITK 2016 / TERI-ARAI 2018 city-level seasonal prior: fraction of Delhi's
   * total PM2.5 attributable to regional/upwind transport.
   * ~0.64 in winter (Oct–Feb), ~0.26 in summer (Mar–Sep).
   */
  regional_fraction_prior: number | null
  /**
   * 0–1 index of current IGP airshed fire transport load.
   * Measures how much Punjab/Haryana/UP agricultural fire smoke is being
   * carried toward this ward by the current wind (travel-time decay model).
   * 0 = no active fires or wind not aligned; ~0.4+ = active burning episode.
   */
  regional_fire_index: number | null
  ts: string
}

export async function fetchVayuTraceAttribution(wardId: number): Promise<VayuTraceAttribution | null> {
  const { data } = await supabase
    .from('attributions')
    .select('breakdown, breakdown_uncertainty, confidence, station_proximity, regional_fraction_prior, regional_fire_index, ts')
    .eq('ward_id', wardId)
    .eq('method', 'vayutrace_v1')
    .order('ts', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  return {
    breakdown: (data.breakdown ?? null) as VayuTraceAttribution['breakdown'],
    breakdown_uncertainty:
      (data.breakdown_uncertainty ?? null) as VayuTraceAttribution['breakdown_uncertainty'],
    confidence: data.confidence ?? null,
    station_proximity: data.station_proximity ?? null,
    regional_fraction_prior: data.regional_fraction_prior ?? null,
    regional_fire_index: data.regional_fire_index ?? null,
    ts: data.ts,
  }
}

/**
 * Latest VayuTrace attribution per ward, city-wide - same "fetch a broad
 * window, keep first (latest) row per key" pattern fetchAllWardsAqi already
 * uses above, rather than one query per ward. A ward with no VayuTrace row
 * yet is simply absent from the returned Map (never fabricated).
 */
export async function fetchAllVayuTraceAttributions(): Promise<Map<number, VayuTraceAttribution>> {
  const { data } = await supabase
    .from('attributions')
    .select('ward_id, breakdown, breakdown_uncertainty, confidence, station_proximity, regional_fraction_prior, regional_fire_index, ts')
    .eq('method', 'vayutrace_v1')
    .order('ts', { ascending: false })

  const byWard = new Map<number, VayuTraceAttribution>()
  for (const row of data ?? []) {
    if (byWard.has(row.ward_id)) continue // already have the latest (rows are ts-desc)
    byWard.set(row.ward_id, {
      breakdown: (row.breakdown ?? null) as VayuTraceAttribution['breakdown'],
      breakdown_uncertainty:
        (row.breakdown_uncertainty ?? null) as VayuTraceAttribution['breakdown_uncertainty'],
      confidence: row.confidence ?? null,
      station_proximity: row.station_proximity ?? null,
      regional_fraction_prior: row.regional_fraction_prior ?? null,
      regional_fire_index: row.regional_fire_index ?? null,
      ts: row.ts,
    })
  }
  return byWard
}

// ── Gati metric (Phase 4): signal-to-action time ─────────────────────────────

export interface GatiMetrics {
  resolvedCount: number
  openCount: number
  medianHours: number | null
}

export async function fetchGatiMetrics(): Promise<GatiMetrics> {
  // 90-day window keeps counts correct as the table grows past 1000 rows.
  // Order by created_at desc so the limit always captures the most recent
  // data rather than an arbitrary PostgREST default ordering.
  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
  const { data: reports } = await supabase
    .from('reports')
    .select('id, created_at, status')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(5000)
  const { data: events } = await supabase
    .from('report_events')
    .select('report_id, status, ts')
    .eq('status', 'resolved')
    .gte('ts', since)
    .order('ts', { ascending: false })
    .limit(5000)

  const resolvedAt = new Map<number, string>()
  for (const e of events ?? []) resolvedAt.set(e.report_id as number, e.ts as string)

  const durations: number[] = []
  let openCount = 0
  for (const r of reports ?? []) {
    const res = resolvedAt.get(r.id as number)
    if (res) {
      durations.push((new Date(res).getTime() - new Date(r.created_at as string).getTime()) / 3_600_000)
    } else if (r.status !== 'resolved' && r.status !== 'rejected') {
      openCount++
    }
  }
  durations.sort((a, b) => a - b)
  const median = durations.length
    ? durations[Math.floor(durations.length / 2)]
    : null
  return { resolvedCount: durations.length, openCount, medianHours: median }
}

// ── Citizens (commander-wide reporter activity) ───────────────────────────────

export interface CitizenActivity {
  reporter_id: string
  full_name: string | null
  report_count: number
  first_report_at: string
  last_report_at: string
  ward_count: number
}

/** profiles_self_read doesn't let commander read another citizen's full_name
 *  directly - this goes through list_citizen_report_activity(), a narrow
 *  SECURITY DEFINER RPC (commander/admin only, checked server-side) that
 *  aggregates reports+profiles in one query rather than fetching every
 *  individual report client-side. full_name may be null - the caller must
 *  show "Citizen <id prefix>", never invent a name. */
export async function listCitizenActivity(): Promise<CitizenActivity[]> {
  const { data } = await supabase.rpc('list_citizen_report_activity')
  return (data ?? []) as CitizenActivity[]
}

export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  submitted: 'New / unreviewed',
  verified: 'Verified',
  assigned: 'Assigned',
  acted: 'Action taken',
  resolved: 'Resolved',
  rejected: 'Rejected',
}

export interface CitizenReportRow {
  id: number
  description: string | null
  ai_category: SourceCategory | null
  status: ReportStatus
  created_at: string | null
  ward_id: number | null
  ward_name: string | null
  incident_id: number | null
  photo_url: string | null
}

/** Report-level queue for the Citizens page (plan: KPI strip + queue, not
 *  just the per-reporter rollup listCitizenActivity() already provides).
 *  Same `reports` table fetchAllOpenReports() already reads for the Map's
 *  citizen-reports layer - this is unfiltered by status (so rejected/
 *  resolved reports are visible too, which the open-only queries
 *  deliberately exclude) and joins ward name the same way ops.ts's
 *  fetchStationHealth() does (a separate lookup, not a nested select). */
export async function listAllCitizenReports(limit = 300): Promise<CitizenReportRow[]> {
  const { data, error } = await supabase
    .from('reports')
    .select('id, description, ai_category, status, created_at, ward_id, incident_id, photo_url')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`Could not load citizen reports: ${error.message}`)
  const rows = data ?? []
  if (rows.length === 0) return []

  const wardIds = [...new Set(rows.map((r) => r.ward_id).filter((id): id is number => id != null))]
  const wardNameById = new Map<number, string>()
  if (wardIds.length > 0) {
    const { data: wards } = await supabase.from('wards').select('id, name').in('id', wardIds)
    for (const w of wards ?? []) wardNameById.set(w.id, w.name)
  }

  return rows.map((r) => ({
    ...r,
    ward_name: r.ward_id != null ? (wardNameById.get(r.ward_id) ?? null) : null,
  }))
}

// ── Analytics (commander-wide outcome/forecast rollups) ──────────────────────

export interface ImpactOutcomeSummary {
  outcome: string
  count: number
}

/** impact_evaluations has no ward/city column of its own (only a
 *  method-specific comparison_ward_id) — this is a city-wide rollup by
 *  `outcome`, not scoped per ward. RLS lets commander/admin read every row
 *  unconditionally (see impact_evaluations_read policy). */
export async function fetchImpactOutcomeSummary(): Promise<ImpactOutcomeSummary[]> {
  const { data } = await supabase.from('impact_evaluations').select('outcome').limit(2000)
  const counts = new Map<string, number>()
  for (const row of data ?? []) counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1)
  return [...counts.entries()]
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((a, b) => b.count - a.count)
}

export interface ForecastAccuracySummary {
  totalWardPollutantPairs: number
  beatsPersistenceCount: number
  wardsWithAnyValidatedHorizon: number
  /** Model-selection breakdown (lightgbm vs. diurnal_persistence vs. the
   *  unused-in-practice defensive "other" bucket) - the honest denominator
   *  behind "the low LightGBM rate", not hidden behind a single percentage. */
  methodMix: ForecastMethodMix
  /** Which of the 4 candidate baselines is hardest to beat, if the fleet
   *  has any post-baseline-gate-upgrade rows yet (docs/data/
   *  forecast-baseline-gate-upgrade.md) - null-safe for a still-mixed or
   *  fully pre-upgrade fleet, see forecastTrustRules.ts. */
  baselineWinners: BaselineWinnerTally
  /** Coverage/freshness - "is the engine actually producing forecasts, and
   *  recently" - distinct from "does the model beat a baseline". */
  coverage: ForecastCoverageSummary
  /** How much of the city/pollutant surface this covers - separate from the
   *  raw pair count, which mixes wards × pollutants together. */
  reach: ForecastReachSummary
}

/** Latest forecast_runs row per (ward_id, pollutant) — a ward/pollutant pair
 *  can have many historical runs, so "latest" means highest generated_at,
 *  matching fetchLatestForecastRun's own ordering. beats_persistence and
 *  max_validated_horizon_hours are exactly the two honest trust signals
 *  docs/HISTORICAL_REPLAY_REPORT.md establishes - never fabricate an
 *  accuracy percentage beyond what those two columns already say. `method`
 *  and `validation_metrics` are read alongside them (same row, no extra
 *  query) purely to derive the plain-language framing in
 *  forecastTrustRules.ts — never a second source of truth. */
export async function fetchForecastAccuracySummary(): Promise<ForecastAccuracySummary> {
  const { data } = await supabase
    .from('forecast_runs')
    .select('ward_id, pollutant, method, beats_persistence, max_validated_horizon_hours, generated_at, validation_metrics')
    .order('generated_at', { ascending: false })
    .limit(2000)

  const latestByPair = new Map<string, ForecastRunLike>()
  for (const row of data ?? []) {
    const key = `${row.ward_id}:${row.pollutant}`
    if (!latestByPair.has(key)) latestByPair.set(key, row) // first hit per pair = newest, thanks to the order() above
  }
  const latestRows = [...latestByPair.values()]

  let beatsPersistenceCount = 0
  let wardsWithAnyValidatedHorizon = 0
  for (const entry of latestRows) {
    if (entry.beats_persistence) beatsPersistenceCount++
    if (entry.max_validated_horizon_hours != null) wardsWithAnyValidatedHorizon++
  }

  return {
    totalWardPollutantPairs: latestRows.length,
    beatsPersistenceCount,
    wardsWithAnyValidatedHorizon,
    methodMix: summarizeForecastMethodMix(latestRows),
    baselineWinners: summarizeBaselineWinners(latestRows),
    coverage: summarizeForecastCoverage(latestRows),
    reach: summarizeForecastReach(latestRows),
  }
}

// ── data footprint (launch readiness): how much real data is loaded? ────────

export interface DataFootprint {
  wardBoundaryCount: number
  totalReadingsCount: number
  earliestReadingAt: string | null
  latestReadingAt: string | null
}

/** Count-only, head:true queries (no rows transferred) - cheap enough to run
 *  on every Sensors page load, unlike fetchAllWardBoundaries' full ~8MB
 *  geometry payload. Backs the Data Readiness card's real numbers - never a
 *  hardcoded "250 wards" / "44k readings" string, always the live count. */
export async function fetchDataFootprint(): Promise<DataFootprint> {
  const [wardBoundaries, readingsCount, earliest, latest] = await Promise.all([
    supabase.from('wards').select('id', { count: 'exact', head: true }).not('boundary', 'is', null),
    supabase.from('readings').select('id', { count: 'exact', head: true }),
    supabase.from('readings').select('ts').order('ts', { ascending: true }).limit(1).maybeSingle(),
    supabase.from('readings').select('ts').order('ts', { ascending: false }).limit(1).maybeSingle(),
  ])
  return {
    wardBoundaryCount: wardBoundaries.count ?? 0,
    totalReadingsCount: readingsCount.count ?? 0,
    earliestReadingAt: earliest.data?.ts ?? null,
    latestReadingAt: latest.data?.ts ?? null,
  }
}

const INGEST_URL = (import.meta.env.VITE_INGEST_URL as string) || 'http://localhost:8000'

/** How long to wait for classification before giving up on it. */
const CLASSIFY_TIMEOUT_MS = 8_000

/**
 * Classify a report via the ingest service, which writes `ai_category`/`ai_meta`
 * back onto the report row.
 *
 * Best-effort by design: returns null when the service is down, unconfigured or
 * slow, and the caller carries on. The timeout matters now that the report ->
 * incident link waits for this (the matching rule reads `ai_category`): without
 * it, an unreachable ingest service would hang the citizen's submit button
 * indefinitely rather than falling back to an unclassified report.
 */
export async function classifyReport(params: {
  reportId: number
  description: string
  wardName: string
  photoUrl?: string | null
}): Promise<{ category: string; hindi_advisory: string } | null> {
  try {
    const res = await fetch(`${INGEST_URL}/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        report_id: params.reportId,
        description: params.description,
        ward_name: params.wardName,
        photo_url: params.photoUrl ?? null,
      }),
      signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

/** How long to wait for the GeoAI agent before giving up on it. LLM calls
 *  with structured outputs are slower than classifyReport's plain-text call
 *  above, especially the first request against a new schema (Anthropic
 *  compiles + caches the schema server-side on first use). */
const GEOAI_TIMEOUT_MS = 20_000

export interface GeoAiEntityRef {
  type: 'ward' | 'station'
  id: string
}

export type GeoAiAction =
  | { type: 'set_time'; time_mode: 'now' | '1h' | '24h' | '48h' | null; obs_slot: 'now' | '-3h' | '-6h' | '-12h' | '-24h' | null }
  | {
      type: 'set_filters'
      pollutant: 'aqi' | 'pm25' | 'pm10' | 'no2' | null
      source_filter: string | null
      severity_filter: 'severe' | 'high' | 'moderate' | 'low' | null
      view_mode: 'pollution' | 'data_quality' | null
    }
  | { type: 'focus'; target_ref: GeoAiEntityRef | null }
  | {
      type: 'query'
      target: 'wards' | 'stations' | 'incidents'
      near_ref: GeoAiEntityRef | null
      radius_km: number | null
      pollutant: 'aqi' | 'pm25' | 'pm10' | 'no2' | null
      op: '>' | '>=' | '<' | '<=' | null
      threshold: number | null
      source_category: string | null
      severity: 'severe' | 'high' | 'moderate' | 'low' | null
    }
  | { type: 'unsupported'; reason: string }

export interface GeoAiResponse {
  explanation: string
  actions: GeoAiAction[]
}

/**
 * Ask the GeoAI agent (natural-language -> structured map actions) via the
 * ingest service. Public, rate-limited endpoint - no auth key, matching
 * classifyReport's best-effort pattern above: returns null on any failure
 * (down, unconfigured, rate-limited, slow) and the caller shows a plain
 * "couldn't reach GeoAI" message rather than hanging or throwing.
 *
 * `entities` is the compact ward/station catalog already loaded on the Map
 * page - used server-side only to resolve fuzzy place names to exact IDs,
 * never persisted.
 */
export async function askGeoAi(
  question: string,
  entities: { type: 'ward' | 'station'; id: string; name: string }[],
): Promise<GeoAiResponse | null> {
  try {
    const res = await fetch(`${INGEST_URL}/geoai/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, entities }),
      signal: AbortSignal.timeout(GEOAI_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

// ── Delhi Open Transit Data (transport-activity context layer) ─────────────
// Context only - never pollution evidence, never congestion/emission
// attribution. See docs/data/delhi-otd-transport-context-integration-report.md.

export interface TransportActivityWard {
  wardId: number
  wardName: string
  vehicleCount: number
  activityLevel: 'none' | 'low' | 'medium' | 'high'
}

export interface TransportActivitySummary {
  generatedAt: string
  /** null (not 0) when the backend never got a real reading this cycle -
   *  see ingest/app/transit_activity.py's unavailable_summary(). */
  liveBusesTracked: number | null
  activeRoutes: number | null
  bufferKm: number
  perWard: TransportActivityWard[]
  label: string
  disclaimer: string
  unavailableReason?: string | null
}

const TRANSIT_TIMEOUT_MS = 8_000

/**
 * Best-effort fetch of the ingest service's transit-activity summary -
 * same pattern as classifyReport above (timeout, catch-all, null on any
 * failure). The ingest service itself already degrades gracefully when
 * DELHI_OTD_API_KEY is unset or the feed call fails (returns an explicit
 * "unavailable" summary rather than erroring), so this function has two
 * independent layers of graceful degradation: this fetch failing entirely
 * (service down/unreachable) returns null; the service responding but with
 * nothing to report returns a summary with `unavailableReason` set.
 */
export async function fetchTransportActivity(): Promise<TransportActivitySummary | null> {
  try {
    const res = await fetch(`${INGEST_URL}/transit/activity`, { signal: AbortSignal.timeout(TRANSIT_TIMEOUT_MS) })
    if (!res.ok) return null
    const data = await res.json()
    return {
      generatedAt: data.generated_at,
      liveBusesTracked: data.live_buses_tracked ?? null,
      activeRoutes: data.active_routes ?? null,
      bufferKm: data.buffer_km,
      perWard: (data.per_ward ?? []).map((w: { ward_id: number; ward_name: string; vehicle_count: number; activity_level: TransportActivityWard['activityLevel'] }) => ({
        wardId: w.ward_id,
        wardName: w.ward_name,
        vehicleCount: w.vehicle_count,
        activityLevel: w.activity_level,
      })),
      label: data.label,
      disclaimer: data.disclaimer,
      unavailableReason: data.unavailable_reason ?? null,
    }
  } catch {
    return null
  }
}

// ── CPCB/data.gov preferred latest-reading source ───────────────────────────
// Latest readings only - never replaces OpenAQ history or forecast.py
// inputs, which keep running exactly as before. See
// docs/data/cpcb-data-gov-primary-latest-integration-report.md.

export type LatestReadingSource = 'cpcb' | 'openaq_fallback'

export interface LatestReadingReconciliation {
  stationId: number
  stationName: string
  wardId: number | null
  matched: boolean
  cpcbStationName: string | null
  cpcbLastUpdate: string | null
  openaqLastUpdate: string | null
  // `unit` mirrors the raw CPCB data.gov.in feed's own per-pollutant unit
  // field — mostly a no-op ("UG/M3" for everything but CO), but CO
  // specifically can come through as either "MG/M3" or "UG/M3" depending on
  // station/feed quirks (see latest_readings.py's own co_data.get("unit", ...)
  // handling on the backend). Consumers displaying/comparing raw CO values
  // from this map MUST check `unit` before treating `avg` as mg/m³ — see
  // HotspotsRiskTable.tsx's normalizeCpcbCo() for the one place that does.
  cpcbPollutants: Record<string, { avg: number; min: number | null; max: number | null; unit?: string }>
  openaqPollutants: Record<string, number>
  cpcbAqi: number | null
  openaqAqi: number | null
  sourceUsed: LatestReadingSource
  flags: string[]
}

const LATEST_READINGS_TIMEOUT_MS = 8_000
const REFRESH_TIMEOUT_MS = 15_000

/**
 * Ask the ingest service to re-fetch fresh CPCB data from data.gov.in right
 * now, without needing an API key. The server enforces a 10-minute cooldown
 * so this is safe to call on every button click.
 *
 * Returns:
 *   { status: 'ok', refreshed_at: number }          — fresh data fetched
 *   { status: 'recent', next_in_s: number }          — still within cooldown
 *   null                                              — ingest service unreachable
 */
export async function triggerIngestRefresh(): Promise<
  { status: 'ok'; refreshed_at: number } | { status: 'recent'; next_in_s: number } | null
> {
  try {
    const res = await fetch(`${INGEST_URL}/refresh`, {
      method: 'POST',
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    })
    const data: unknown = await res.json()
    if (res.status === 429) return { status: 'recent', next_in_s: (data as { next_in_s: number }).next_in_s ?? 600 }
    if (!res.ok) return null
    return { status: 'ok', refreshed_at: (data as { refreshed_at: number }).refreshed_at }
  } catch {
    return null
  }
}

/**
 * Best-effort fetch of the ingest service's CPCB-preferred-latest-reading
 * reconciliation, one row per station - same pattern as
 * fetchTransportActivity above (timeout, catch-all, null on any failure).
 * Callers overlay this ON TOP of their existing Supabase-sourced OpenAQ
 * reads for DISPLAY only (Overview hotspot table, Sensors, Map popups) -
 * this never replaces those queries, so a failure here just means the
 * existing OpenAQ-sourced numbers keep showing, unchanged.
 */
export async function fetchLatestReadingsPreferred(): Promise<LatestReadingReconciliation[] | null> {
  try {
    const res = await fetch(`${INGEST_URL}/readings/latest`, { signal: AbortSignal.timeout(LATEST_READINGS_TIMEOUT_MS) })
    if (!res.ok) return null
    const data: unknown = await res.json()
    if (!Array.isArray(data)) return null
    return data.map(
      (r: {
        station_id: number
        station_name: string
        ward_id: number | null
        matched: boolean
        cpcb_station_name: string | null
        cpcb_last_update: string | null
        openaq_last_update: string | null
        cpcb_pollutants: Record<string, { avg: number; min: number | null; max: number | null; unit?: string }> | null
        openaq_pollutants: Record<string, number> | null
        cpcb_aqi: number | null
        openaq_aqi: number | null
        source_used: LatestReadingSource
        flags: string[] | null
      }) => ({
        stationId: r.station_id,
        stationName: r.station_name,
        wardId: r.ward_id,
        matched: r.matched,
        cpcbStationName: r.cpcb_station_name,
        cpcbLastUpdate: r.cpcb_last_update,
        openaqLastUpdate: r.openaq_last_update,
        cpcbPollutants: r.cpcb_pollutants ?? {},
        openaqPollutants: r.openaq_pollutants ?? {},
        cpcbAqi: r.cpcb_aqi,
        openaqAqi: r.openaq_aqi,
        sourceUsed: r.source_used,
        flags: r.flags ?? [],
      }),
    )
  } catch {
    return null
  }
}
