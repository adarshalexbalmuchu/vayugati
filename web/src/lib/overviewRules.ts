/**
 * Pure derivation rules shared by the commander Overview, Tasks, Sensors and
 * Analytics pages. No I/O here - mirrors incidentRules.ts's own convention
 * (pure functions, unit-tested directly rather than only through the UI).
 * Every input here comes from data already fetched by existing lib/*.ts
 * functions; nothing in this file invents a new metric that isn't grounded
 * in real columns.
 */
import type { ActiveTaskDispatch, Incident } from './incidents'
import { minutesUntil } from './incidentRules'
import type { StationHealthRow } from './ops'
import type { WardForecastSummary, WardSummary } from './data'

export type TimeWindowHours = 12 | 24 | 36 | 48

export interface SevereWardAlert {
  wardId: number
  wardName: string
  peakPred: number | null
  hoursToSevere: number | null
}

/** Today's exact `grapAlerts` logic, generalized: `hoursToSevere <= windowHours`
 *  instead of a hardcoded 36. */
export function severeWardsWithin(
  wards: WardSummary[],
  forecasts: Map<number, WardForecastSummary>,
  windowHours: TimeWindowHours,
): SevereWardAlert[] {
  return [...forecasts.values()]
    .filter((f) => f.hoursToSevere != null && f.hoursToSevere <= windowHours)
    .map((f) => ({
      wardId: f.wardId,
      wardName: wards.find((w) => w.id === f.wardId)?.name ?? `Ward ${f.wardId}`,
      peakPred: f.peakPred,
      hoursToSevere: f.hoursToSevere,
    }))
    .sort((a, b) => (a.hoursToSevere ?? 99) - (b.hoursToSevere ?? 99))
}

/** The only real "confidence" value tied to a ward's forecast peak - the
 *  confidence of the specific point where the peak occurs, not an invented
 *  aggregate. */
export function confidenceAtPeak(forecast: WardForecastSummary | undefined): number | null {
  if (!forecast?.peakTs) return null
  return forecast.points.find((p) => p.horizon_ts === forecast.peakTs)?.confidence ?? null
}

export interface WindowedPeak {
  value: number | null
  excess: number | null
  ts: string | null
}

/** WardForecastSummary.peakPred is the peak across the whole fetched curve
 *  (up to 48h out, used by Map markers/PriorityAlerts/TeamAllocation, which
 *  all want "the worst it gets"). The Hotspots table's own selected horizon
 *  (12h/24h/36h/48h) needs a peak scoped to exactly that window instead -
 *  selecting "12h" must not still show a peak the model predicts at hour 40.
 *  A separate function, not a WardForecastSummary field, so those other
 *  consumers' semantics stay exactly as they were. */
export function peakWithinWindow(forecast: WardForecastSummary | undefined, windowHours: TimeWindowHours): WindowedPeak {
  if (!forecast) return { value: null, excess: null, ts: null }
  const cutoffMs = Date.now() + windowHours * 3_600_000
  let best: WindowedPeak = { value: null, excess: null, ts: null }
  for (const p of forecast.points) {
    const ms = new Date(p.horizon_ts).getTime()
    if (ms > cutoffMs) continue
    const value = p.predicted_value ?? p.pm25_pred
    if (value == null) continue
    if (best.value == null || value > best.value) best = { value, excess: p.local_excess, ts: p.horizon_ts }
  }
  return best
}

export type HotspotStatus = 'severe' | 'watch' | 'stable' | 'stale' | 'no_data'

export const HOTSPOT_STATUS_LABEL: Record<HotspotStatus, string> = {
  severe: 'Severe imminent',
  watch: 'Trending up',
  stable: 'Stable',
  stale: 'Stale reading',
  no_data: 'No data',
}

/** Same real-world threshold as ops.ts's STATION_STALE_MINUTES (kept as its
 *  own literal here rather than importing across that module boundary for
 *  one constant) - a ward whose current reading is older than this is not
 *  "trending up" or "stable", it's stale, and that has to be the headline,
 *  not a caveat next to an otherwise-normal-looking status. */
export const HOTSPOT_READING_STALE_MINUTES = 180

/** Severe (AQI Severe entry — PM2.5 ≥ 250 µg/m³ — crossing within the
 *  selected window) -> Stale (current reading older than the threshold -
 *  checked before watch/stable, since a rising-looking trend built on a stale
 *  reading is misleading, not informative) -> Watch (forecast to cross AQI
 *  Very Poor / PM2.5 ≥ 120 µg/m³ / GRAP Stage III within the window, OR
 *  rising local excess ≥ 10 µg/m³) -> Stable (a current reading exists) ->
 *  No data. A UI-only categorization built entirely from fields the page
 *  already has - not a new detection signal.
 *
 *  `readingAgeMinutes` and `hoursToVeryPoor` are optional and default to
 *  "unknown/not applicable" when omitted, preserving existing caller behaviour.
 *  Severe is checked first and deliberately NOT demoted by staleness: it
 *  reflects the forecast pipeline crossing a threshold, not the live reading.
 *
 *  Literature basis for the Very Poor threshold:
 *    CPCB 2014: PM2.5 = 120 µg/m³ is the entry to AQI 300 (Very Poor).
 *    GRAP 2023: Stage III restrictions trigger at sustained AQI ≥ 300.
 *    IOP ERL 2025: +9% excess daily mortality in the AQI 300–400 band.
 *  Using hoursToVeryPoor for 'watch' surfaces the GRAP action threshold
 *  earlier than the more severe (250 µg/m³) crossing would. */
export function hotspotStatus(
  row: {
    hoursToSevere: number | null
    hoursToVeryPoor?: number | null
    peakExcess: number | null
    aqi: number | null
    readingAgeMinutes?: number | null
  },
  windowHours: TimeWindowHours,
): HotspotStatus {
  if (row.hoursToSevere != null && row.hoursToSevere <= windowHours) return 'severe'
  if (row.aqi != null && row.readingAgeMinutes != null && row.readingAgeMinutes > HOTSPOT_READING_STALE_MINUTES) {
    return 'stale'
  }
  // hoursToVeryPoor (PM2.5 ≥ 120 µg/m³, GRAP Stage III) reaching within the
  // window is a stronger 'watch' signal than local excess alone.
  if (row.hoursToVeryPoor != null && row.hoursToVeryPoor <= windowHours) return 'watch'
  // Require a meaningful local excess to call it "Trending up" — +2 µg/m³ is
  // indistinguishable from model noise on a 40 µg/m³ city baseline.
  if (row.peakExcess != null && row.peakExcess >= 10) return 'watch'
  if (row.aqi != null) return 'stable'
  return 'no_data'
}

/** How many wards currently warrant a commander's attention - severe within
 *  the window, or trending up towards it (hotspotStatus's 'severe'/'watch'
 *  tiers), tallied city-wide. An aggregate of what the Hotspot table already
 *  computes per row, not a new signal - used by Overview's Response
 *  Planning card in place of the removed team-allocation slider. */
export interface WardNeedingReview {
  wardId: number
  wardName: string
}

/** The actual wards behind wardsNeedingReviewCount's number - same
 *  severe-or-watch check, exposed as a list so callers (e.g. Overview's
 *  transport-activity cross-reference) can identify WHICH wards, not just
 *  how many. */
export function wardsNeedingReview(
  wards: WardSummary[],
  forecasts: Map<number, WardForecastSummary>,
  windowHours: TimeWindowHours,
): WardNeedingReview[] {
  const result: WardNeedingReview[] = []
  for (const w of wards) {
    const forecast = forecasts.get(w.id)
    const windowed = peakWithinWindow(forecast, windowHours)
    const readingAgeMinutes = w.ts ? (Date.now() - new Date(w.ts).getTime()) / 60_000 : null
    const status = hotspotStatus(
      {
        hoursToSevere: forecast?.hoursToSevere ?? null,
        hoursToVeryPoor: forecast?.hoursToVeryPoor ?? null,
        peakExcess: windowed.excess,
        aqi: w.aqi,
        readingAgeMinutes,
      },
      windowHours,
    )
    if (status === 'severe' || status === 'watch') result.push({ wardId: w.id, wardName: w.name })
  }
  return result
}

export function wardsNeedingReviewCount(
  wards: WardSummary[],
  forecasts: Map<number, WardForecastSummary>,
  windowHours: TimeWindowHours,
): number {
  return wardsNeedingReview(wards, forecasts, windowHours).length
}

/** Same "first populated checkpoint column" fallback already duplicated in
 *  TasksView.tsx / FieldTaskDispatchCard.tsx / TaskDispatchPanel.tsx -
 *  centralizing here is incidental cleanup, not a new rule. */
export function nextDueAt(d: ActiveTaskDispatch): string | null {
  return d.sla_ack_due_at ?? d.sla_accept_due_at ?? d.sla_arrival_due_at ?? d.sla_completion_due_at
}

export interface DispatchSlaBuckets {
  overdue: number
  dueSoon: number
  onTrack: number
  noSla: number
}

/** overdue: past due. Due soon: due within 2h. On track: due later than
 *  that. No SLA: no checkpoint column populated at all (e.g. already
 *  awaiting verification). */
export function bucketDispatchSla(dispatches: ActiveTaskDispatch[]): DispatchSlaBuckets {
  const buckets: DispatchSlaBuckets = { overdue: 0, dueSoon: 0, onTrack: 0, noSla: 0 }
  for (const d of dispatches) {
    const mins = minutesUntil(nextDueAt(d))
    if (mins == null) buckets.noSla++
    else if (mins < 0) buckets.overdue++
    else if (mins <= 120) buckets.dueSoon++
    else buckets.onTrack++
  }
  return buckets
}

export interface SourceMixEntry {
  source: string
  count: number
}

/** A ward's `dominant_source` is only a meaningful signal when the ward
 *  actually has a current reading - seeding can set a category before a
 *  ward ever had a working station (Mayapuri: proxy-only, no official
 *  station, still unresolved per docs/data/delhi-station-reconciliation.md),
 *  and that stored category must never be shown as though it were a live,
 *  evidence-backed source for a ward with no data at all. */
export function isWardDataBacked(ward: { ts: string | null }): boolean {
  return ward.ts != null
}

/** Pure client-side tally of wards[].dominant_source - no new fetch. */
export function tallySourceMix(wards: WardSummary[]): SourceMixEntry[] {
  const counts = new Map<string, number>()
  for (const w of wards) {
    const key = w.dominant_source ?? 'Unknown'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)
}

export interface StationHealthRollup {
  total: number
  active: number
  stale: number
  inactive: number
  topStale: { name: string; wardName: string | null; ageMinutes: number | null }[]
}

/** Compact summary distinct from the full /sensors page - no per-station
 *  actions here, those write paths stay on SensorsView.tsx. */
export function rollupStationHealth(rows: StationHealthRow[]): StationHealthRollup {
  const active = rows.filter((r) => r.is_active)
  const stale = active.filter((r) => r.is_stale)
  const inactive = rows.filter((r) => !r.is_active)
  const topStale = [...stale]
    .sort((a, b) => (b.latest_reading_age_minutes ?? 0) - (a.latest_reading_age_minutes ?? 0))
    .slice(0, 3)
    .map((r) => ({ name: r.name, wardName: r.ward_name, ageMinutes: r.latest_reading_age_minutes }))
  return { total: rows.length, active: active.length, stale: stale.length, inactive: inactive.length, topStale }
}

// ── Analytics page ────────────────────────────────────────────────────────

export interface AgencyPerformanceRow {
  agency: string
  assigned: number
  completed: number
  overdue: number
  /** Median minutes from sent_at to acknowledged_at, across dispatches
   *  where both timestamps exist. Null (not 0) when no dispatch for this
   *  agency has both - an honest "no sample" rather than a fabricated
   *  instant response time. */
  medianResponseMinutes: number | null
}

const CLOSED_DISPATCH_STATUSES = new Set(['completed', 'cancelled', 'rejected', 'verification_pending'])

/** Per-agency rollup from a wider dispatch window (listTaskDispatchesForAnalytics),
 *  not the active-only set - completed/cancelled work has to be counted for
 *  "how is this agency actually performing" to mean anything. Every dispatch
 *  with no responsible_agency at all is grouped under "Unassigned" rather
 *  than silently dropped, since an unrouted dispatch is itself a real signal. */
export function bucketAgencyPerformance(dispatches: ActiveTaskDispatch[]): AgencyPerformanceRow[] {
  const byAgency = new Map<string, ActiveTaskDispatch[]>()
  for (const d of dispatches) {
    const key = d.responsible_agency ?? 'Unassigned'
    const bucket = byAgency.get(key) ?? []
    bucket.push(d)
    byAgency.set(key, bucket)
  }
  const rows: AgencyPerformanceRow[] = []
  for (const [agency, group] of byAgency) {
    const completed = group.filter((d) => d.status === 'completed').length
    const overdue = group.filter((d) => {
      if (CLOSED_DISPATCH_STATUSES.has(d.status)) return false
      const mins = minutesUntil(nextDueAt(d))
      return mins != null && mins < 0
    }).length
    const responseMinutes = group
      .filter((d) => d.sent_at && d.acknowledged_at)
      .map((d) => (new Date(d.acknowledged_at as string).getTime() - new Date(d.sent_at as string).getTime()) / 60_000)
      .sort((a, b) => a - b)
    const medianResponseMinutes = responseMinutes.length ? responseMinutes[Math.floor(responseMinutes.length / 2)] : null
    rows.push({ agency, assigned: group.length, completed, overdue, medianResponseMinutes })
  }
  return rows.sort((a, b) => b.assigned - a.assigned)
}

export interface RecurringWardSummary {
  wardId: number
  wardName: string
  recurrenceCount: number
}

/** Wards with at least one incident whose recurrence_of_incident_id is set
 *  - the real, purpose-built column for "this happened again", not a
 *  heuristic re-derivation from raw incident counts (a ward can legitimately
 *  have many unrelated incidents without any of them being a recurrence). */
export function recurringWardsSummary(incidents: Incident[]): RecurringWardSummary[] {
  const byWard = new Map<number, { wardName: string; count: number }>()
  for (const i of incidents) {
    if (i.recurrence_of_incident_id == null || i.ward_id == null) continue
    const entry = byWard.get(i.ward_id) ?? { wardName: i.ward_name ?? `Ward ${i.ward_id}`, count: 0 }
    entry.count++
    byWard.set(i.ward_id, entry)
  }
  return [...byWard.entries()]
    .map(([wardId, { wardName, count }]) => ({ wardId, wardName, recurrenceCount: count }))
    .sort((a, b) => b.recurrenceCount - a.recurrenceCount)
}
