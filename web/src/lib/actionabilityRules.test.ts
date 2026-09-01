import { describe, expect, it } from 'vitest'
import { rankWardsByActionability, scoreWardActionability } from './actionabilityRules'
import type { VayuTraceAttribution } from './data'

function attribution(overrides: Partial<VayuTraceAttribution> = {}): VayuTraceAttribution {
  return {
    breakdown: { industrial: 0.34, road: 0.33, fire: 0.33, unknown: 0 },
    confidence: 0.5,
    regional_fraction_prior: 0.35,
    regional_fire_index: 0,
    ts: new Date().toISOString(),
    ...overrides,
  }
}

describe('scoreWardActionability', () => {
  it('scores a clean, high-confidence, single-dominant-source ward highly', () => {
    const result = scoreWardActionability(
      { id: 1, name: 'Ward A' },
      attribution({
        confidence: 0.9,
        breakdown: { industrial: 0.75, road: 0.15, fire: 0.1, unknown: 0 },
        regional_fraction_prior: 0.1,
        regional_fire_index: 0,
      }),
    )
    expect(result.dominantSource).toBe('industrial')
    expect(result.score).toBeGreaterThan(80)
    expect(result.reasons.some((r) => r.includes('Industrial') && r.includes('dominant'))).toBe(true)
  })

  it('scores a regional-transport-dominated ward low even with high confidence', () => {
    const result = scoreWardActionability(
      { id: 2, name: 'Ward B' },
      attribution({
        confidence: 0.9,
        breakdown: { industrial: 0.34, road: 0.33, fire: 0.33, unknown: 0 },
        regional_fraction_prior: 0.75,
        regional_fire_index: 0.9,
      }),
    )
    // confidence alone contributes 31.5 (0.9*35); dominance and
    // addressability should stay low given the diffuse mix + heavy regional
    // transport, keeping the total well under the clean-ward case above.
    expect(result.score).toBeLessThan(60)
    expect(result.reasons.some((r) => r.includes('regional/upwind'))).toBe(true)
    expect(result.reasons.some((r) => r.includes('fire-transport episode'))).toBe(true)
  })

  it('does not double-count regional_fire_index against regional_fraction_prior', () => {
    // regional_fraction_prior is already the nowcast output (fire-inclusive,
    // capped at 0.78) - the addressability term must not subtract
    // regional_fire_index a second time on top of it.
    const withHighFireIndex = scoreWardActionability(
      { id: 3, name: 'Ward C' },
      attribution({ regional_fraction_prior: 0.75, regional_fire_index: 1.0 }),
    )
    const sameFractionNoFireFlag = scoreWardActionability(
      { id: 3, name: 'Ward C' },
      attribution({ regional_fraction_prior: 0.75, regional_fire_index: 0 }),
    )
    // Only the addressability term should differ based on regional_fraction_
    // prior itself; regional_fire_index must not further reduce the score.
    expect(withHighFireIndex.score).toBeCloseTo(sameFractionNoFireFlag.score, 5)
  })

  it('falls back to a neutral reason when nothing stands out', () => {
    const result = scoreWardActionability({ id: 4, name: 'Ward D' }, attribution())
    expect(result.reasons).toContain('Moderate confidence, mixed local sources.')
  })
})

describe('rankWardsByActionability', () => {
  it('excludes wards with no attribution rather than scoring them 0', () => {
    const wards = [
      { id: 1, name: 'Has data' },
      { id: 2, name: 'No data' },
    ]
    const attributions = new Map([[1, attribution()]])
    const ranked = rankWardsByActionability(wards, attributions)
    expect(ranked).toHaveLength(1)
    expect(ranked[0].wardId).toBe(1)
  })

  it('sorts best-first with a stable id tiebreak on equal scores', () => {
    const wards = [
      { id: 2, name: 'Ward Two' },
      { id: 1, name: 'Ward One' },
    ]
    const identical = attribution()
    const attributions = new Map([
      [2, identical],
      [1, identical],
    ])
    const ranked = rankWardsByActionability(wards, attributions)
    expect(ranked.map((r) => r.wardId)).toEqual([1, 2])
  })

  it('ranks a clean local-source ward above a regional-dominated one', () => {
    const wards = [
      { id: 1, name: 'Clean local' },
      { id: 2, name: 'Regional-dominated' },
    ]
    const attributions = new Map([
      [1, attribution({ confidence: 0.9, breakdown: { industrial: 0.8, road: 0.1, fire: 0.1, unknown: 0 }, regional_fraction_prior: 0.1 })],
      [2, attribution({ confidence: 0.9, breakdown: { industrial: 0.34, road: 0.33, fire: 0.33, unknown: 0 }, regional_fraction_prior: 0.78 })],
    ])
    const ranked = rankWardsByActionability(wards, attributions)
    expect(ranked[0].wardId).toBe(1)
  })
})
