import { describe, expect, it } from 'vitest'
import {
  aqSourceLabel,
  DATA_CONFIDENCE_LABEL,
  dataConfidenceLevel,
  parseFlexibleTimestamp,
  tallyDataSourceConfidence,
  timestampMismatchMinutes,
  TIMESTAMP_MISMATCH_MINUTES_THRESHOLD,
} from './latestReadingRules'
import type { LatestReadingReconciliation } from './data'

function row(overrides: Partial<LatestReadingReconciliation> = {}): LatestReadingReconciliation {
  return {
    stationId: 1,
    stationName: 'Narela, Delhi - DPCC',
    wardId: 1,
    matched: true,
    cpcbStationName: 'Narela, Delhi - DPCC',
    cpcbLastUpdate: '22-07-2026 17:20:00',
    openaqLastUpdate: '2026-07-22T11:50:00Z',
    cpcbPollutants: {},
    openaqPollutants: {},
    cpcbAqi: 90,
    openaqAqi: 88,
    sourceUsed: 'cpcb',
    flags: [],
    ...overrides,
  }
}

describe('parseFlexibleTimestamp', () => {
  it('parses ISO 8601 timestamps (OpenAQ format)', () => {
    const ms = parseFlexibleTimestamp('2026-07-22T11:50:00Z')
    expect(ms).toBe(Date.parse('2026-07-22T11:50:00Z'))
  })

  it('parses the real CPCB/data.gov "DD-MM-YYYY HH:MM:SS" IST format', () => {
    // 22-07-2026 17:20:00 IST == 2026-07-22T11:50:00Z (IST is UTC+5:30)
    const ms = parseFlexibleTimestamp('22-07-2026 17:20:00')
    expect(ms).toBe(Date.parse('2026-07-22T11:50:00.000Z'))
  })

  it('returns null for unparseable input rather than a wrong guess', () => {
    expect(parseFlexibleTimestamp('not a timestamp')).toBeNull()
  })
})

describe('timestampMismatchMinutes', () => {
  it('is null when either timestamp is missing', () => {
    expect(timestampMismatchMinutes(null, '2026-07-22T11:50:00Z')).toBeNull()
    expect(timestampMismatchMinutes('22-07-2026 17:20:00', null)).toBeNull()
  })

  it('is ~0 when the two real-format timestamps refer to the same instant', () => {
    const mins = timestampMismatchMinutes('22-07-2026 17:20:00', '2026-07-22T11:50:00Z')
    expect(mins).not.toBeNull()
    expect(mins!).toBeLessThan(1)
  })

  it('reports a real gap when the two sources disagree', () => {
    const mins = timestampMismatchMinutes('22-07-2026 17:20:00', '2026-07-22T09:00:00Z')
    expect(mins).not.toBeNull()
    expect(mins!).toBeGreaterThan(TIMESTAMP_MISMATCH_MINUTES_THRESHOLD)
  })
})

describe('dataConfidenceLevel', () => {
  it('is "matched" for a clean CPCB-sourced, matched row', () => {
    expect(dataConfidenceLevel(row())).toBe('matched')
  })

  it('is "matched" when using OpenAQ fallback with no stale/mismatch flags', () => {
    expect(dataConfidenceLevel(row({ sourceUsed: 'openaq_fallback' }))).toBe('matched')
  })

  it('is "stale" when the ACTIVE source is stale', () => {
    expect(dataConfidenceLevel(row({ sourceUsed: 'cpcb', flags: ['cpcb_stale'] }))).toBe('stale')
    expect(dataConfidenceLevel(row({ sourceUsed: 'openaq_fallback', flags: ['openaq_stale'] }))).toBe('stale')
  })

  it('is NOT "stale" when only the unused source is stale - that would be misleading, not just imprecise', () => {
    // Using CPCB (fresh) while OpenAQ, sitting unused as the fallback,
    // happens to be stale - the displayed reading is genuinely fine.
    expect(dataConfidenceLevel(row({ sourceUsed: 'cpcb', flags: ['openaq_stale'] }))).toBe('matched')
    // Using OpenAQ fallback (fresh) while CPCB, not what's shown, is stale.
    expect(dataConfidenceLevel(row({ sourceUsed: 'openaq_fallback', flags: ['cpcb_stale'] }))).toBe('matched')
  })

  it('is "no_data" when no CPCB station was matched', () => {
    expect(dataConfidenceLevel(row({ matched: false, sourceUsed: 'openaq_fallback' }))).toBe('no_data')
  })

  it('is "no_data" when matched but CPCB had nothing usable', () => {
    expect(dataConfidenceLevel(row({ flags: ['cpcb_missing'] }))).toBe('no_data')
  })

  it('is "mismatch" whenever value_mismatch is flagged, even if matched and CPCB-sourced', () => {
    expect(dataConfidenceLevel(row({ flags: ['value_mismatch'] }))).toBe('mismatch')
  })

  it('mismatch takes priority over no_data', () => {
    expect(dataConfidenceLevel(row({ matched: false, flags: ['value_mismatch'] }))).toBe('mismatch')
  })

  it('every level has a short display label', () => {
    for (const level of ['matched', 'stale', 'mismatch', 'no_data'] as const) {
      expect(DATA_CONFIDENCE_LABEL[level]).toBeTruthy()
    }
  })
})

describe('aqSourceLabel', () => {
  it('is "CPCB" when CPCB is the preferred, matched source', () => {
    expect(aqSourceLabel(row())).toBe('CPCB')
  })

  it('is "OpenAQ" when falling back, but still matched and not mismatched', () => {
    expect(aqSourceLabel(row({ sourceUsed: 'openaq_fallback' }))).toBe('OpenAQ')
  })

  it('is "Review" when unmatched', () => {
    expect(aqSourceLabel(row({ matched: false, sourceUsed: 'openaq_fallback' }))).toBe('Review')
  })

  it('is "Review" on a value mismatch, even if matched and CPCB-sourced', () => {
    expect(aqSourceLabel(row({ flags: ['value_mismatch'] }))).toBe('Review')
  })
})

describe('Fresh · OpenAQ fallback provenance combinations', () => {
  it('"Fresh · OpenAQ": matched fallback row with no stale/mismatch flags', () => {
    // Station reads from OpenAQ but the reading is current — this combination
    // appears as "Fresh · OpenAQ" in DataQualityStationPanel's FreshnessBadge.
    const r = row({ sourceUsed: 'openaq_fallback', matched: true, flags: [] })
    expect(aqSourceLabel(r)).toBe('OpenAQ')
    expect(dataConfidenceLevel(r)).toBe('matched')
  })

  it('"Stale · OpenAQ": OpenAQ fallback with its own stale flag', () => {
    const r = row({ sourceUsed: 'openaq_fallback', flags: ['openaq_stale'] })
    expect(aqSourceLabel(r)).toBe('OpenAQ')
    expect(dataConfidenceLevel(r)).toBe('stale')
  })

  it('"Review" wins over source label on any value_mismatch, regardless of fallback state', () => {
    const r = row({ sourceUsed: 'openaq_fallback', flags: ['value_mismatch'] })
    expect(aqSourceLabel(r)).toBe('Review')
    expect(dataConfidenceLevel(r)).toBe('mismatch')
  })

  it('CPCB-sourced station is never labelled as OpenAQ', () => {
    const r = row({ sourceUsed: 'cpcb', matched: true, flags: [] })
    expect(aqSourceLabel(r)).toBe('CPCB')
    expect(dataConfidenceLevel(r)).toBe('matched')
  })
})

describe('tallyDataSourceConfidence', () => {
  it('counts cpcb vs fallback correctly', () => {
    const rows = [row({ sourceUsed: 'cpcb' }), row({ sourceUsed: 'cpcb' }), row({ sourceUsed: 'openaq_fallback' })]
    const tally = tallyDataSourceConfidence(rows)
    expect(tally.cpcbMatched).toBe(2)
    expect(tally.openaqFallback).toBe(1)
  })

  it('counts unmatched independently of source', () => {
    const rows = [row({ matched: false, sourceUsed: 'openaq_fallback' }), row({ matched: true })]
    expect(tallyDataSourceConfidence(rows).unmatched).toBe(1)
  })

  it('counts staleOrMismatch for any of the three relevant flags', () => {
    const rows = [
      row({ flags: ['cpcb_stale'] }),
      row({ flags: ['openaq_stale'] }),
      row({ flags: ['value_mismatch'] }),
      row({ flags: [] }),
    ]
    expect(tallyDataSourceConfidence(rows).staleOrMismatch).toBe(3)
  })

  it('returns all zeros for an empty list', () => {
    expect(tallyDataSourceConfidence([])).toEqual({ cpcbMatched: 0, openaqFallback: 0, unmatched: 0, staleOrMismatch: 0 })
  })
})
