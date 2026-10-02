import type { AqiForecastPoint } from './data'

/** Longest lead the forecast AQI is published for: the backtest
 *  (ingest/scripts/aqi_forecast_backtest.py -> data/models/aqi_forecast_gate.json,
 *  Oct 2026) found it beats "today's AQI holds" by 30-57% up to 12 h, and
 *  not beyond (24 h: +7%, 95% CI -8 to +21). */
export const AQI_FORECAST_MAX_LEAD_H = 12

export const POLLUTANT_NAME: Record<string, string> = {
  pm25: 'PM2.5', pm10: 'PM10', no2: 'NO₂', so2: 'SO₂', co: 'CO', o3: 'O₃', nh3: 'NH₃',
}

/** The forecast AQI points nearest each of `hoursFromNow` (within ±3 h of
 *  now + h), skipping hours the ward has no validated forecast for. One
 *  point is never shown twice. `hours` is the point's REAL time ahead of
 *  now (rounded), not the hour asked for: the forecast's origin is the
 *  latest reading, usually an hour or two old. */
export function aqiOutlook(
  points: AqiForecastPoint[],
  hoursFromNow: number[] = [3, 6, 12],
  nowMs: number = Date.now(),
): { hours: number; point: AqiForecastPoint }[] {
  const out: { hours: number; point: AqiForecastPoint }[] = []
  const used = new Set<number>()
  for (const h of hoursFromNow) {
    const target = nowMs + h * 3_600_000
    let best: AqiForecastPoint | null = null
    for (const p of points) {
      const d = Math.abs(Date.parse(p.targetTs) - target)
      if (d > 3 * 3_600_000 || used.has(p.leadHours)) continue
      if (!best || d < Math.abs(Date.parse(best.targetTs) - target)) best = p
    }
    if (best) {
      used.add(best.leadHours)
      out.push({ hours: Math.max(0, Math.round((Date.parse(best.targetTs) - nowMs) / 3_600_000)), point: best })
    }
  }
  return out
}
