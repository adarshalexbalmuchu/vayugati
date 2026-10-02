import type { ForecastPoint } from './data'

/** What the next `hours` of a ward's forecast say about crossing the alert
 *  threshold and about severe levels.
 *
 *  The forecast line is the MOST LIKELY value (the median): forecast lab,
 *  Oct 2026, it runs 10-17% below the average outcome for PM2.5 in winter by
 *  design, and the risk of higher values lives in the range and in these
 *  probabilities, which validated within 1-3 points of observed frequencies
 *  at the alert threshold. Severe risk is coarse on purpose. */
export interface ForecastOutlook {
  /** Highest hourly chance of reaching `threshold` within the window. */
  maxProb: number | null
  maxProbTs: string | null
  threshold: number | null
  /** First hour flagged 'elevated' for severe levels, if any. */
  severeFromTs: string | null
}

export function forecastOutlook(points: ForecastPoint[], hours = 24, now: Date = new Date()): ForecastOutlook {
  const end = now.getTime() + hours * 3600_000
  const inWindow = points.filter((p) => {
    const t = Date.parse(p.horizon_ts)
    return t > now.getTime() && t <= end
  })
  let maxProb: number | null = null
  let maxProbTs: string | null = null
  let threshold: number | null = null
  let severeFromTs: string | null = null
  for (const p of inWindow) {
    if (p.exceedProb != null && (maxProb == null || p.exceedProb > maxProb)) {
      maxProb = p.exceedProb
      maxProbTs = p.horizon_ts
      threshold = p.exceedThreshold
    }
    if (p.severeRisk === 'elevated' && (severeFromTs == null || p.horizon_ts < severeFromTs)) severeFromTs = p.horizon_ts
  }
  return { maxProb, maxProbTs, threshold, severeFromTs }
}

/** Plain-language chance: rounded to 5%, never "0%" or "100%". */
export function chanceLabel(p: number): string {
  const pct = Math.min(95, Math.max(5, Math.round((p * 100) / 5) * 5))
  return `${pct}%`
}
