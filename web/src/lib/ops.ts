/**
 * Operations data layer (Phase 10, extended in Phase 12): system health,
 * city feature flags, station activation, and real create/edit forms for
 * responsibility_registry / sla_rules / intervention_playbooks (Phase 12
 * deliberately overrides the earlier "toggle-only, no in-app editor" scope
 * decision for exactly these three tables — stations stay toggle-only,
 * they're RPC-gated, not a direct-write table like these three). Still not
 * a generic database editor: three purpose-built typed forms, not a
 * schema-driven table editor. Sibling to incidents.ts/data.ts: this is the
 * only place that knows these table/column names.
 */
import type { Database } from './database.types'
import type { ChecklistItem } from './incidentRules'
import { supabase } from './supabase'

type Row<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row']
type Enum<T extends keyof Database['public']['Enums']> = Database['public']['Enums'][T]

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

/** Every station + its ward name + the age of its own latest reading.
 *
 *  Used to say "one query per table (stations, wards, readings), never one
 *  query per station" - an unfiltered `readings` fetch deduped to "latest
 *  per station" in JS. At current scale (19 stations, 25k+ rows and
 *  growing with every ingest run) that pulled the entire `readings` table
 *  just to keep 19 timestamps out of it, on every Map/Sensors page load -
 *  the exact same anti-pattern `data.ts`'s `fetchAllStationsWithReadings`
 *  had, fixed the same way here: one bounded `.limit(1)` query per
 *  station, run in parallel via `Promise.all` (not a sequential loop, so
 *  this doesn't reintroduce the round-trip cost the original comment was
 *  guarding against), using the same `readings (station_id, ts desc)`
 *  index. Station-level freshness has never been computed anywhere else in
 *  this codebase (only the city-wide "any reading at all" check in
 *  health_checks.py) - this is new, but built entirely from the same
 *  readings table that check already reads, not a new data source. */
export async function fetchStationHealth(cityId?: number): Promise<StationHealthRow[]> {
  const stations = await fetchStations(cityId)
  if (stations.length === 0) return []

  const wardIds = [...new Set(stations.map((s) => s.ward_id).filter((id): id is number => id != null))]
  const { data: wards, error: wardsError } = await supabase.from('wards').select('id, name').in('id', wardIds)
  if (wardsError) fail('Could not load ward names', wardsError)
  const wardNameById = new Map((wards ?? []).map((w) => [w.id, w.name]))

  const latestTsByStation = new Map<number, string>()
  await Promise.all(
    stations.map(async (s) => {
      const { data, error } = await supabase
        .from('readings')
        .select('ts')
        .eq('station_id', s.id)
        .order('ts', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) fail('Could not load station readings', error)
      if (data) latestTsByStation.set(s.id, data.ts)
    }),
  )

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

// ── Real editors (Phase 12): registry / SLA rule / playbook create+edit ─────
// Named field types, not Partial<Row> — a raw DB column (id/created_at/
// updated_at/is_active) can never be submitted from a form by accident.
// is_active stays managed by the toggle functions above; these only ever
// write the substantive fields.

export interface ContactChannel {
  phone?: string
  email?: string
  [key: string]: string | undefined
}

export interface EscalationHierarchyEntry {
  level: number
  role: string
  contact: string
  [key: string]: string | number | undefined
}

export interface RegistryFormFields {
  source_category: Enum<'source_category'> | null
  ward_id: number | null
  asset_description: string | null
  owner_name: string | null
  regulating_authority: string | null
  division_zone: string | null
  responsible_officer: string | null
  escalation_contact: string | null
  team_name: string | null
  backup_agency: string | null
  backup_team: string | null
  backup_officer: string | null
  zone_description: string | null
  contact_channel: ContactChannel
  supported_intervention_types: string[]
  /** Free text (e.g. "Mon-Sat 09:00-18:00 IST") — matches the convention
   *  already established in supabase/RESPONSIBILITY_REGISTRY_IMPORT_TEMPLATE.csv,
   *  stored as a plain jsonb string scalar rather than a structured per-day shape
   *  no consumer currently needs. */
  working_hours: string | null
  escalation_hierarchy: EscalationHierarchyEntry[]
  mapping_confidence: string
  mapping_source: string | null
}

export async function createRegistryEntry(
  cityId: number,
  fields: RegistryFormFields,
): Promise<ResponsibilityRegistryRow> {
  const { data, error } = await supabase
    .from('responsibility_registry')
    .insert({ city_id: cityId, ...fields })
    .select()
    .single()
  if (error) fail('Could not create the registry entry', error)
  return data
}

export async function updateRegistryEntry(id: number, fields: RegistryFormFields): Promise<void> {
  const { error } = await supabase.from('responsibility_registry').update(fields).eq('id', id)
  if (error) fail('Could not update the registry entry', error)
}

export interface SlaRuleFormFields {
  slug: string | null
  severity: string | null
  source_category: Enum<'source_category'> | null
  evidence_level: Enum<'source_confidence_level'> | null
  action_type: string | null
  agency: string | null
  time_of_day: string | null
  ack_hours: number
  accept_hours: number
  arrival_hours: number
  completion_hours: number
  verification_hours: number
  priority: number
}

export async function createSlaRule(cityId: number, fields: SlaRuleFormFields): Promise<SlaRuleRow> {
  const { data, error } = await supabase
    .from('sla_rules')
    .insert({ city_id: cityId, ...fields })
    .select()
    .single()
  if (error) fail('Could not create the SLA rule', error)
  return data
}

export async function updateSlaRule(id: number, fields: SlaRuleFormFields): Promise<void> {
  const { error } = await supabase.from('sla_rules').update(fields).eq('id', id)
  if (error) fail('Could not update the SLA rule', error)
}

export interface PlaybookFormFields {
  title: string
  /** null only valid when for_regional=true (DB check: not for_regional or source_category is null). */
  source_category: Enum<'source_category'> | null
  action_type: string
  min_evidence_level: Enum<'source_confidence_level'>
  approval_level: Enum<'approval_level'>
  for_regional: boolean
  checklist: ChecklistItem[]
  required_team: string | null
  required_equipment: string | null
  estimated_minutes: number | null
  estimated_cost_min: number | null
  estimated_cost_max: number | null
  expected_effect: string | null
  expected_time_to_effect_hours: number | null
  expected_duration_hours: number | null
  verification_window_hours: number | null
  known_limitations: string | null
  required_proof: string | null
  verification_method: string | null
  evidence_basis: string | null
  responsible_agency_type: string | null
  instructions: string | null
  recommended_pollutants: string[]
  slug: string | null
  /** Bumped by a human editing the template, never automatically — see the
   *  migration comment on intervention_playbooks.version. */
  version: number
}

// checklist is ChecklistItem[] (the shared field-app-consumed shape from
// incidentRules.ts, not owned here) — a plain jsonb write, cast to satisfy
// the generated Json type rather than adding an index signature to a type
// other modules also rely on.
export async function createPlaybook(cityId: number, fields: PlaybookFormFields): Promise<PlaybookRow> {
  const { data, error } = await supabase
    .from('intervention_playbooks')
    .insert({ city_id: cityId, ...fields, checklist: fields.checklist as unknown as Database['public']['Tables']['intervention_playbooks']['Insert']['checklist'] })
    .select()
    .single()
  if (error) fail('Could not create the playbook', error)
  return data
}

export async function updatePlaybook(id: number, fields: PlaybookFormFields): Promise<void> {
  const { error } = await supabase
    .from('intervention_playbooks')
    .update({ ...fields, checklist: fields.checklist as unknown as Database['public']['Tables']['intervention_playbooks']['Insert']['checklist'] })
    .eq('id', id)
  if (error) fail('Could not update the playbook', error)
}
