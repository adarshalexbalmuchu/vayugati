import type { Database } from './database.types'
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
  const { data: wards } = await supabase
    .from('wards')
    .select('id, name, dominant_source, lat, lng')
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
 *  already renders, just one marker per station instead of per ward. Two
 *  queries total (stations, readings), never one per station. */
export async function fetchAllStationsWithReadings(): Promise<StationMarker[]> {
  const { data: stations } = await supabase.from('stations').select('id, name, lat, lng').order('name')
  if (!stations) return []

  const ids = stations.map((s) => s.id)
  const { data: readings } = await supabase
    .from('readings')
    .select('station_id, aqi, pm25, pm10, no2, ts')
    .in('station_id', ids)
    .order('ts', { ascending: false })

  const latestByStation = new Map<number, { aqi: number | null; pm25: number | null; pm10: number | null; no2: number | null }>()
  for (const r of readings ?? []) {
    if (!latestByStation.has(r.station_id)) latestByStation.set(r.station_id, r) // first hit per station = newest
  }

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

export interface WardForecastSummary {
  wardId: number
  points: ForecastPoint[]
  peakPred: number | null
  peakExcess: number | null
  peakTs: string | null
  hoursToSevere: number | null // hours until pm25_pred first crosses 400
}

const SEVERE_THRESHOLD = 400

export async function fetchAllForecasts(): Promise<Map<number, WardForecastSummary>> {
  const { data } = await supabase
    .from('forecasts')
    .select('ward_id, horizon_ts, pm25_pred, baseline_pred, local_excess, confidence, model_version')
    .eq('pollutant', 'pm25')
    .order('horizon_ts')
    .limit(48 * 20)
  const byWard = new Map<number, WardForecastSummary>()
  for (const row of data ?? []) {
    const wardId = row.ward_id as number
    let entry = byWard.get(wardId)
    if (!entry) {
      entry = { wardId, points: [], peakPred: null, peakExcess: null, peakTs: null, hoursToSevere: null }
      byWard.set(wardId, entry)
    }
    entry.points.push(row as ForecastPoint)
  }
  const now = Date.now()
  for (const entry of byWard.values()) {
    for (let i = 0; i < entry.points.length; i++) {
      const p = entry.points[i]
      if (p.pm25_pred != null && (entry.peakPred == null || p.pm25_pred > entry.peakPred)) {
        entry.peakPred = p.pm25_pred
        entry.peakExcess = p.local_excess
        entry.peakTs = p.horizon_ts
      }
      if (
        entry.hoursToSevere == null &&
        p.pm25_pred != null &&
        p.pm25_pred >= SEVERE_THRESHOLD
      ) {
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
}

/** Latest forecast_runs row per (ward_id, pollutant) — a ward/pollutant pair
 *  can have many historical runs, so "latest" means highest generated_at,
 *  matching fetchLatestForecastRun's own ordering. beats_persistence and
 *  max_validated_horizon_hours are exactly the two honest trust signals
 *  docs/HISTORICAL_REPLAY_REPORT.md establishes - never fabricate an
 *  accuracy percentage beyond what those two columns already say. */
export async function fetchForecastAccuracySummary(): Promise<ForecastAccuracySummary> {
  const { data } = await supabase
    .from('forecast_runs')
    .select('ward_id, pollutant, beats_persistence, max_validated_horizon_hours, generated_at')
    .order('generated_at', { ascending: false })
    .limit(2000)

  const latestByPair = new Map<string, { beats_persistence: boolean; max_validated_horizon_hours: number | null }>()
  for (const row of data ?? []) {
    const key = `${row.ward_id}:${row.pollutant}`
    if (!latestByPair.has(key)) latestByPair.set(key, row) // first hit per pair = newest, thanks to the order() above
  }

  let beatsPersistenceCount = 0
  let wardsWithAnyValidatedHorizon = 0
  for (const entry of latestByPair.values()) {
    if (entry.beats_persistence) beatsPersistenceCount++
    if (entry.max_validated_horizon_hours != null) wardsWithAnyValidatedHorizon++
  }

  return {
    totalWardPollutantPairs: latestByPair.size,
    beatsPersistenceCount,
    wardsWithAnyValidatedHorizon,
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
