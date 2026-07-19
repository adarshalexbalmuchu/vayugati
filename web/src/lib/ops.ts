/**
 * Operations data layer (Phase 10): system health and the minimal pilot
 * admin surface — city feature flags, station/registry/SLA-rule/playbook
 * activation. Deliberately narrow (plan §18: "do not create a broad
 * generic admin panel") — this is pilot configuration, not a general
 * database editor. Sibling to incidents.ts/data.ts: this is the only place
 * that knows these table/column names.
 */
import type { Database } from './database.types'
import { supabase } from './supabase'

type Row<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row']

export type CityConfigRow = Row<'city_config'>
export type StationRow = Row<'stations'>
export type ResponsibilityRegistryRow = Row<'responsibility_registry'>
export type SlaRuleRow = Row<'sla_rules'>
export type PlaybookRow = Row<'intervention_playbooks'>

export interface SystemHealthRow {
  job_name: string
  city_code: string | null
  last_status: string | null
  last_started_at: string | null
  last_completed_at: string | null
  last_error_message: string | null
  is_stale: boolean
}

function fail(context: string, error: { message: string }): never {
  throw new Error(`${context}: ${error.message}`)
}

/** The System Health rollup (plan §10) — one row per job+city, the same
 *  data the ingest service's own /health endpoint reads. Commander/admin
 *  only; the underlying function checks this itself, so a citizen or
 *  officer call simply raises rather than silently returning nothing. */
export async function fetchSystemHealth(): Promise<SystemHealthRow[]> {
  const { data, error } = await supabase.rpc('system_health_summary')
  if (error) fail('Could not load system health', error)
  return (data ?? []) as SystemHealthRow[]
}

export async function fetchCities(): Promise<CityConfigRow[]> {
  const { data, error } = await supabase.from('city_config').select('*').order('name')
  if (error) fail('Could not load cities', error)
  return data ?? []
}

/** The 9 pilot-disableable flags this phase wires into the SQL/Python
 *  engines. Kept as an explicit list (not "any string key") so the UI can
 *  never write a flag name the backend doesn't actually check. */
export const KNOWN_FEATURE_FLAGS = [
  'anomaly_detection',
  'validated_forecasting',
  'source_attribution',
  'citizen_evidence_missions',
  'operational_dispatch',
  'automatic_escalation',
  'notifications_email',
  'notifications_sms',
  'notifications_whatsapp',
] as const
export type FeatureFlagName = (typeof KNOWN_FEATURE_FLAGS)[number]

export function getFeatureFlags(city: CityConfigRow): Record<FeatureFlagName, boolean> {
  const raw = (city.config as Record<string, unknown> | null)?.feature_flags as Record<string, boolean> | undefined
  const out = {} as Record<FeatureFlagName, boolean>
  for (const flag of KNOWN_FEATURE_FLAGS) out[flag] = raw?.[flag] ?? true // matches city_feature_enabled's own default
  return out
}

/** Merge-updates one flag — never overwrites the rest of `config` (city_config.config
 *  also holds anomaly_detection/attribution/forecasting/dispatch sub-keys from
 *  earlier phases), matching every earlier phase's own `config || jsonb_build_object(...)`
 *  merge discipline. */
export async function setCityFeatureFlag(city: CityConfigRow, flag: FeatureFlagName, enabled: boolean): Promise<void> {
  const current = (city.config as Record<string, unknown> | null) ?? {}
  const currentFlags = (current.feature_flags as Record<string, boolean> | undefined) ?? {}
  const nextConfig = { ...current, feature_flags: { ...currentFlags, [flag]: enabled } }
  const { error } = await supabase.from('city_config').update({ config: nextConfig }).eq('id', city.id)
  if (error) fail('Could not update the feature flag', error)
}

export async function fetchStations(cityId?: number): Promise<StationRow[]> {
  let q = supabase.from('stations').select('*, wards!inner(city_id)').order('name')
  if (cityId != null) q = q.eq('wards.city_id', cityId)
  const { data, error } = await q
  if (error) fail('Could not load stations', error)
  return (data ?? []) as StationRow[]
}

/** Same 180-minute staleness cutoff the ingest service's own
 *  /health -> compute_health() -> _reading_freshness() uses
 *  (ingest/app/health_checks.py) — kept as one shared constant here rather
 *  than reinvented, so "stale" means the same thing on this page as it
 *  does on the System Health rollup. */
export const STATION_STALE_MINUTES = 180

export interface StationHealthRow {
  id: number
  name: string
  ward_id: number | null
  ward_name: string | null
  sensor_type: string
  is_active: boolean
  latest_reading_at: string | null
  latest_reading_age_minutes: number | null
  is_stale: boolean
}

/** Every station + its ward name + the age of its own latest reading —
 *  one query per table (stations, wards, readings), never one query per
 *  station, so this stays cheap regardless of station count. Station-level
 *  freshness has never been computed anywhere in this codebase before
 *  (only the city-wide "any reading at all" check in health_checks.py) —
 *  this is new, but built entirely from the same readings table that
 *  check already reads, not a new data source. */
export async function fetchStationHealth(cityId?: number): Promise<StationHealthRow[]> {
  const stations = await fetchStations(cityId)
  if (stations.length === 0) return []

  const wardIds = [...new Set(stations.map((s) => s.ward_id).filter((id): id is number => id != null))]
  const { data: wards, error: wardsError } = await supabase.from('wards').select('id, name').in('id', wardIds)
  if (wardsError) fail('Could not load ward names', wardsError)
  const wardNameById = new Map((wards ?? []).map((w) => [w.id, w.name]))

  const stationIds = stations.map((s) => s.id)
  const { data: readings, error: readingsError } = await supabase
    .from('readings')
    .select('station_id, ts')
    .in('station_id', stationIds)
    .order('ts', { ascending: false })
  if (readingsError) fail('Could not load station readings', readingsError)

  const latestTsByStation = new Map<number, string>()
  for (const r of readings ?? []) {
    if (!latestTsByStation.has(r.station_id)) latestTsByStation.set(r.station_id, r.ts) // first hit per station = newest, thanks to the order() above
  }

  const now = Date.now()
  return stations.map((s) => {
    const latestTs = latestTsByStation.get(s.id) ?? null
    const ageMinutes = latestTs ? Math.round((now - new Date(latestTs).getTime()) / 60_000) : null
    return {
      id: s.id,
      name: s.name,
      ward_id: s.ward_id,
      ward_name: s.ward_id != null ? (wardNameById.get(s.ward_id) ?? null) : null,
      sensor_type: s.sensor_type,
      is_active: s.is_active,
      latest_reading_at: latestTs,
      latest_reading_age_minutes: ageMinutes,
      is_stale: ageMinutes == null || ageMinutes > STATION_STALE_MINUTES,
    }
  })
}

/** stations has no authenticated write policy at all (only the ingest
 *  service's service_role connection writes it) — goes through the
 *  narrow set_station_active RPC, matching this codebase's own
 *  "the function is the only write path" discipline elsewhere. */
export async function setStationActive(stationId: number, isActive: boolean, actorId: string): Promise<void> {
  const { error } = await supabase.rpc('set_station_active', {
    p_station_id: stationId,
    p_is_active: isActive,
    p_actor_id: actorId,
  })
  if (error) fail('Could not update the station', error)
}

export async function fetchResponsibilityRegistryForAdmin(cityId: number): Promise<ResponsibilityRegistryRow[]> {
  const { data, error } = await supabase
    .from('responsibility_registry')
    .select('*')
    .eq('city_id', cityId)
    .order('regulating_authority')
  if (error) fail('Could not load the responsibility registry', error)
  return data ?? []
}

/** responsibility_registry already has a commander/admin RLS write policy
 *  (Phase 2) — a direct update is fine here, unlike stations. */
export async function setRegistryActive(id: number, isActive: boolean): Promise<void> {
  const { error } = await supabase.from('responsibility_registry').update({ is_active: isActive }).eq('id', id)
  if (error) fail('Could not update the registry entry', error)
}

export async function fetchSlaRulesForAdmin(cityId: number): Promise<SlaRuleRow[]> {
  const { data, error } = await supabase
    .from('sla_rules')
    .select('*')
    .eq('city_id', cityId)
    .order('priority', { ascending: false })
  if (error) fail('Could not load SLA rules', error)
  return data ?? []
}

export async function setSlaRuleActive(id: number, isActive: boolean): Promise<void> {
  const { error } = await supabase.from('sla_rules').update({ is_active: isActive }).eq('id', id)
  if (error) fail('Could not update the SLA rule', error)
}

export async function fetchPlaybooksForAdmin(cityId: number): Promise<PlaybookRow[]> {
  const { data, error } = await supabase
    .from('intervention_playbooks')
    .select('*')
    .eq('city_id', cityId)
    .order('action_type')
  if (error) fail('Could not load playbooks', error)
  return data ?? []
}

export async function setPlaybookActive(id: number, isActive: boolean): Promise<void> {
  const { error } = await supabase.from('intervention_playbooks').update({ is_active: isActive }).eq('id', id)
  if (error) fail('Could not update the playbook', error)
}
