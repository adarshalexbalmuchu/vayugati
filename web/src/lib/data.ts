import type { Database } from './database.types'
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
  ts: string | null
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
  ts: string | null
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
    .select('aqi, pm25, pm10, no2, ts')
    .in('station_id', ids)
    .order('ts', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ?? null
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

export async function fetchAllWardsAqi(): Promise<WardSummary[]> {
  // is_hotspot=true scopes this to the 13 seeded, monitored hotspot wards -
  // every existing caller (Overview, Incidents' ward filter, the admin
  // Registry form) expects exactly that set. Phase 2 (delhi-ward-import-
  // report.md) added up to 250 more municipal-boundary-only wards with
  // is_hotspot=false and no station/AQI data; they're deliberately excluded
  // here and served instead by fetchAllWardBoundaries() below, so this
  // function's callers see no change in behaviour.
  const { data: wards } = await supabase
    .from('wards')
    .select('id, name, dominant_source, lat, lng')
    .eq('is_hotspot', true)
    .order('name')
  if (!wards) return []

  return Promise.all(
    wards.map(async (ward) => {
      const reading = await fetchLatestReading(ward.id)
      return {
        ...ward,
        aqi: reading?.aqi ?? null,
        pm25: reading?.pm25 ?? null,
        pm10: reading?.pm10 ?? null,
        no2: reading?.no2 ?? null,
        ts: reading?.ts ?? null,
      }
    }),
  )
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
}

/** Real ward boundary polygons for the Map's ward-boundary layer - covers
 *  every ward with real captured geometry (the Phase 2 municipal import,
 *  the NDMC/Cantonment OSM import, and any of the 13 hotspot wards if
 *  they're ever given one too), not just the monitored hotspot set
 *  fetchAllWardsAqi() is scoped to. Never a hardcoded polygon - if
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
      const meta = w.metadata as { jurisdiction_type?: string } | null
      const jurisdictionType = meta?.jurisdiction_type === 'ndmc' || meta?.jurisdiction_type === 'cantonment' ? meta.jurisdiction_type : 'mcd'
      return {
        id: w.id,
        name: w.name,
        wardNumber: w.ward_number,
        jurisdictionType,
        geometry: w.boundary as unknown as GeoJSON.Polygon | GeoJSON.MultiPolygon,
        lat: w.lat,
        lng: w.lng,
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
export async function fetchAllStationsWithReadings(): Promise<StationMarker[]> {
  const { data: stations } = await supabase.from('stations').select('id, name, lat, lng').order('name')
  if (!stations) return []

  const latestByStation = new Map<number, { aqi: number | null; pm25: number | null; pm10: number | null; no2: number | null }>()
  await Promise.all(
    stations.map(async (s) => {
      const { data } = await supabase
        .from('readings')
        .select('aqi, pm25, pm10, no2')
        .eq('station_id', s.id)
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
      }
    })
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
  await supabase.from('reports').update({ status }).eq('id', reportId)
  await supabase.from('report_events').insert({
    report_id: reportId,
    status,
    actor_id: actorId,
    note: note ?? null,
  })
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
}

/**
 * The citizen-facing PM2.5 curve. Explicitly scoped to `pollutant = 'pm25'`
 * as of Phase 8 — `forecasts` now also holds pm10/no2 rows for the same
 * ward side by side, so an unscoped query here would silently mix a
 * different pollutant's numbers into what this chart presents as PM2.5.
 */
export async function fetchForecast(wardId: number): Promise<ForecastPoint[]> {
  const { data } = await supabase
    .from('forecasts')
    .select('horizon_ts, pm25_pred, baseline_pred, local_excess, confidence, model_version')
    .eq('ward_id', wardId)
    .eq('pollutant', 'pm25')
    .order('horizon_ts')
    .limit(48)
  return data ?? []
}

export type ForecastPollutant = 'pm25' | 'pm10' | 'no2'

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
  /** Hours until this pollutant's own forecast first crosses its severity
   *  threshold - only ever computed for PM2.5, the one pollutant with an
   *  established threshold in this codebase (SEVERE_THRESHOLD_PM25). Always
   *  null for PM10/NO2 - never a fabricated severity claim for a pollutant
   *  with no stated threshold here. */
  hoursToSevere: number | null
}

const SEVERE_THRESHOLD_PM25 = 400

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
    .select('ward_id, horizon_ts, pm25_pred, baseline_pred, local_excess, confidence, model_version, predicted_value')
    .eq('pollutant', pollutant)
    .order('horizon_ts')
    .limit(48 * 20)
  const byWard = new Map<number, WardForecastSummary>()
  for (const row of data ?? []) {
    const wardId = row.ward_id as number
    let entry = byWard.get(wardId)
    if (!entry) {
      entry = { wardId, pollutant, points: [], peakPred: null, peakExcess: null, peakTs: null, hoursToSevere: null }
      byWard.set(wardId, entry)
    }
    entry.points.push(row as ForecastPoint)
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
      if (pollutant === 'pm25' && entry.hoursToSevere == null && predicted != null && predicted >= SEVERE_THRESHOLD_PM25) {
        entry.hoursToSevere = Math.round((new Date(p.horizon_ts).getTime() - now) / 3_600_000)
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
  const { data } = await supabase
    .from('attributions')
    .select('direction, breakdown, confidence, method, ts')
    .eq('ward_id', wardId)
    .order('ts', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  // `breakdown` is jsonb, so the generated type is `Json`. Narrow it here (the
  // ingest service writes {source: share}) rather than widening Attribution.
  return { ...data, breakdown: (data.breakdown ?? null) as Record<string, number> | null }
}

// ── Gati metric (Phase 4): signal-to-action time ─────────────────────────────

export interface GatiMetrics {
  resolvedCount: number
  openCount: number
  medianHours: number | null
}

export async function fetchGatiMetrics(): Promise<GatiMetrics> {
  const { data: reports } = await supabase
    .from('reports')
    .select('id, created_at, status')
    .limit(1000)
  const { data: events } = await supabase
    .from('report_events')
    .select('report_id, status, ts')
    .eq('status', 'resolved')
    .limit(1000)

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

// ── LP-style asset allocation (Phase 4) ──────────────────────────────────────

export interface Allocation {
  wardId: number
  wardName: string
  peakPred: number | null
  peakExcess: number | null
  teams: number
}

/** Allocate a fixed number of teams across wards, weighted by predicted local excess
 *  (the controllable load). Largest-remainder method for integer, proportional shares. */
export function allocateTeams(
  wards: { id: number; name: string }[],
  forecasts: Map<number, WardForecastSummary>,
  totalTeams: number,
): Allocation[] {
  const rows = wards.map((w) => {
    const f = forecasts.get(w.id)
    const weight = Math.max(f?.peakExcess ?? 0, 0)
    return { wardId: w.id, wardName: w.name, peakPred: f?.peakPred ?? null, peakExcess: f?.peakExcess ?? null, weight }
  })
  const totalWeight = rows.reduce((s, r) => s + r.weight, 0)
  if (totalWeight <= 0) {
    return rows.map((r) => ({ ...r, teams: 0 }))
  }
  // proportional shares, then largest-remainder rounding to hit exactly totalTeams
  const exact = rows.map((r) => (r.weight / totalWeight) * totalTeams)
  const floors = exact.map((e) => Math.floor(e))
  let remaining = totalTeams - floors.reduce((s, f) => s + f, 0)
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac)
  const teams = [...floors]
  for (let k = 0; k < order.length && remaining > 0; k++, remaining--) {
    teams[order[k].i]++
  }
  return rows
    .map((r, i) => ({ wardId: r.wardId, wardName: r.wardName, peakPred: r.peakPred, peakExcess: r.peakExcess, teams: teams[i] }))
    .sort((a, b) => b.teams - a.teams)
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
  cpcbPollutants: Record<string, { avg: number; min: number | null; max: number | null }>
  openaqPollutants: Record<string, number>
  cpcbAqi: number | null
  openaqAqi: number | null
  sourceUsed: LatestReadingSource
  flags: string[]
}

const LATEST_READINGS_TIMEOUT_MS = 8_000

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
        cpcb_pollutants: Record<string, { avg: number; min: number | null; max: number | null }> | null
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
