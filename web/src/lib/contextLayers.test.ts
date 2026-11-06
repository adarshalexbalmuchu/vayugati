import { describe, expect, it } from 'vitest'
import { CONTEXT_LAYER_DEFS, CONTEXT_LEGEND, CONTEXT_SWATCH } from './contextLayers'

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
