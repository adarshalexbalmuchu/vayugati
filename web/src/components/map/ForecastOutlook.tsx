import type { ForecastPoint } from '../../lib/data'
import { chanceLabel, forecastOutlook } from '../../lib/forecastOutlook'

function hourLabel(ts: string): string {
  return new Date(ts).toLocaleTimeString(undefined, { weekday: 'short', hour: 'numeric' })
}

/** Next-24h outlook beside a ward's forecast: the chance of reaching the
 *  alert threshold and a coarse severe-risk flag. Renders nothing when the
 *  forecast carries neither (no classifier with validated skill, no risk). */
export default function ForecastOutlook({ points, unit = 'µg/m³' }: { points: ForecastPoint[] | undefined; unit?: string }) {
  if (!points?.length) return null
  const o = forecastOutlook(points)
  if (o.maxProb == null && o.severeFromTs == null) return null
  const high = o.maxProb != null && o.maxProb >= 0.5
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] leading-snug">
      {o.maxProb != null && o.threshold != null && (
        <p className="text-slate-700">
          Chance of reaching <span className="font-semibold">{Math.round(o.threshold)} {unit}</span> in the next 24 h:{' '}
          <span className={`font-bold tabular-nums ${high ? 'text-orange-600' : 'text-slate-800'}`}>{chanceLabel(o.maxProb)}</span>
          {o.maxProbTs && <span className="text-slate-400"> (highest around {hourLabel(o.maxProbTs)})</span>}
        </p>
      )}
      {o.severeFromTs && (
        <p className="mt-1 font-semibold text-red-700">
          Risk of severe levels: elevated from {hourLabel(o.severeFromTs)}
        </p>
      )}
      <p className="mt-1 text-[10px] text-slate-400">
        The forecast line is the most likely value; the shaded range holds about 80% of outcomes.
      </p>
    </div>
  )
}
