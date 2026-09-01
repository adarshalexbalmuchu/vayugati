import type { VayuTraceAttribution } from './data'

/**
 * Ranking weights for VayuTrace actionability. Each is a documented,
 * arguable constant summing to 100 - same convention as
 * PLAYBOOK_RANK_WEIGHTS in incidentRules.ts, so a city can point at any one
 * of these and ask "why 35 and not 25", which is the entire point of a
 * rule-based (not ML) ranking.
 */
export const ACTIONABILITY_WEIGHTS = {
  confidence: 35, // trust in the estimate itself
  dominance: 35, // one clear dominant local source beats a diffuse split
  addressability: 30, // how much of this ward's pollution is even locally fixable
} as const

export type DominantSource = 'industrial' | 'road' | 'fire'

export const DOMINANT_SOURCE_LABEL: Record<DominantSource, string> = {
  industrial: 'Industrial',
  road: 'Road',
  fire: 'Local fire',
}

export interface ActionabilityScore {
  wardId: number
  wardName: string
  score: number
  dominantSource: DominantSource | null
  reasons: string[]
}

/**
 * Score one ward's actionability from its own VayuTrace attribution - how
 * worth prioritizing a local intervention is here, based purely on
 * attribution quality (confidence, how concentrated the local source mix
 * is, how much of the pollution is even locally fixable). Deliberately NOT
 * weighted by current AQI/severity - that's a different question, already
 * answerable via the existing AQI ranking.
 */
export function scoreWardActionability(
  ward: { id: number; name: string },
  attribution: VayuTraceAttribution,
): ActionabilityScore {
  const reasons: string[] = []
  let score = 0

  // 1. confidence - trust in the estimate itself.
  const confidence = attribution.confidence ?? 0
  score += ACTIONABILITY_WEIGHTS.confidence * confidence
  if (confidence >= 0.7) reasons.push('High-confidence estimate (near a CPCB station).')

  // 2. dominance - the largest single local source share. A ward where one
  // source is 70% of the local mix scores near-full; an even 3-way split
  // scores ~0.33.
  const breakdown = attribution.breakdown
  let dominantSource: DominantSource | null = null
  let dominance = 0
  if (breakdown) {
    const entries: [DominantSource, number][] = [
      ['industrial', breakdown.industrial],
      ['road', breakdown.road],
      ['fire', breakdown.fire],
    ]
    for (const [key, value] of entries) {
      if (value > dominance) {
        dominance = value
        dominantSource = key
      }
    }
  }
  score += ACTIONABILITY_WEIGHTS.dominance * dominance
  if (dominantSource && dominance >= 0.5) {
    reasons.push(`${DOMINANT_SOURCE_LABEL[dominantSource]} is the clear dominant local source (${Math.round(dominance * 100)}%).`)
  }

  // 3. addressability - the fraction of this ward's pollution that isn't
  // regional/upwind transport. `regional_fraction_prior` is a false-friend
  // name: despite reading like a static baseline, it's the live per-request
  // nowcast output (ingest/app/vayutrace_kernel.py's regional_fraction_
  // nowcast(): min(seasonal base + regional_fire_index * 0.40, 0.78)) -
  // already fire-inclusive and already capped. Do NOT also subtract
  // regional_fire_index here; that would double-count the exact same signal
  // this field already carries.
  const regionalFraction = attribution.regional_fraction_prior ?? 0
  const addressable = Math.max(0, 1 - regionalFraction)
  score += ACTIONABILITY_WEIGHTS.addressability * addressable
  if (regionalFraction >= 0.5) {
    reasons.push(`Most of this ward's pollution (${Math.round(regionalFraction * 100)}%) is regional/upwind transport, not locally addressable.`)
  }
  if ((attribution.regional_fire_index ?? 0) >= 0.4) {
    reasons.push('An active regional fire-transport episode is currently underway.')
  }

  if (reasons.length === 0) reasons.push('Moderate confidence, mixed local sources.')

  return { wardId: ward.id, wardName: ward.name, score, dominantSource, reasons }
}

/**
 * Score every ward that has a VayuTrace attribution and sort best-first. A
 * ward with no attribution yet is excluded, not scored as 0 - never
 * fabricate. Stable tiebreak on ward id keeps the order deterministic when
 * two wards score identically (no ML, no randomness).
 */
export function rankWardsByActionability(
  wards: { id: number; name: string }[],
  attributionsByWardId: Map<number, VayuTraceAttribution>,
): ActionabilityScore[] {
  return wards
    .map((w) => {
      const attribution = attributionsByWardId.get(w.id)
      return attribution ? scoreWardActionability(w, attribution) : null
    })
    .filter((s): s is ActionabilityScore => s != null)
    .sort((a, b) => b.score - a.score || a.wardId - b.wardId)
}
