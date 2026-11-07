import { describe, expect, it } from 'vitest'
import { CONTEXT_GROUPS, CONTEXT_LAYER_DEFS, CONTEXT_LEGEND, CONTEXT_SWATCH, DEFAULT_CONTEXT_VISIBLE, normalizeBaseImages } from './contextLayers'

describe('Jharkhand layer legend', () => {
  it('has an entry, a swatch and a note for every layer', () => {
    for (const d of CONTEXT_LAYER_DEFS) {
      expect(CONTEXT_LEGEND[d.key], d.key).toBeDefined()
      expect(CONTEXT_SWATCH[d.key], d.key).toBeDefined()
      expect(d.note.length, d.key).toBeGreaterThan(20)
    }
  })

  it('every symbol is described in words', () => {
    for (const [key, symbols] of Object.entries(CONTEXT_LEGEND)) {
      for (const s of symbols) expect(s.label.length, key).toBeGreaterThanOrEqual(3)
    }
  })

  it('layers drawn as symbols have a legend; imagery layers are explained by their own key or notes', () => {
    const drawn = CONTEXT_LAYER_DEFS.map((d) => d.key).filter((k) => !['landcover', 'satellite'].includes(k))
    for (const k of drawn) expect(CONTEXT_LEGEND[k].length, k).toBeGreaterThan(0)
  })
})

describe('layer groups', () => {
  it('list every layer exactly once', () => {
    const listed = CONTEXT_GROUPS.flatMap((g) => g.keys).sort()
    expect(listed).toEqual(CONTEXT_LAYER_DEFS.map((d) => d.key as string).sort())
  })

  it('start with at most one full-map picture on', () => {
    const on = (['satellite', 'landcover', 'nightlights'] as const).filter((k) => DEFAULT_CONTEXT_VISIBLE[k])
    expect(on.length).toBeLessThanOrEqual(1)
  })
})

describe('normalizeBaseImages', () => {
  it('switching one full-map picture on switches the others off', () => {
    expect(normalizeBaseImages({ satellite: true }, { landcover: true })).toEqual({ satellite: true, landcover: false, nightlights: false })
    expect(normalizeBaseImages({ landcover: true }, { satellite: true })).toEqual({ landcover: true, satellite: false, nightlights: false })
  })

  it('leaves other changes alone, and switching off', () => {
    expect(normalizeBaseImages({ roads: true }, { satellite: true })).toEqual({ roads: true })
    expect(normalizeBaseImages({ satellite: false }, { satellite: true })).toEqual({ satellite: false })
  })

  it('when several come on at once, keeps the one already on', () => {
    expect(normalizeBaseImages({ satellite: true, landcover: true }, { landcover: true })).toMatchObject({ landcover: true, satellite: false })
  })
})
