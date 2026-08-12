import { aqiLevel } from '../AqiBadge'
import type { HotspotStatus } from '../../lib/overviewRules'

const TREND_STYLE: Record<HotspotStatus, { color: string; dot: string }> = {
  severe:  { color: 'text-status-critical', dot: 'bg-status-critical' },
  watch:   { color: 'text-status-warning',  dot: 'bg-status-warning'  },
  stable:  { color: 'text-status-success',  dot: 'bg-status-success'  },
  stale:   { color: 'text-slate-400',       dot: 'bg-slate-300'       },
  no_data: { color: 'text-slate-400',       dot: 'bg-slate-300'       },
}

function formatAge(minutes: number): string {
  if (minutes < 2) return 'Just now'
  if (minutes < 60) return `${Math.round(minutes)}m ago`
  const h = Math.round(minutes / 60)
  return `${h}h ago`
}

export default function CityStatusHero({
  aqi,
  wardName,
  trend,
  forecastPeak,
  readingAgeMinutes,
  forecastLabel = 'PM₂.₅',
  forecastSuppressed = false,
}: {
  aqi: number | null
  wardName: string | null
  trend: HotspotStatus | null
  source?: string | null
  forecastPeak: number | null
  readingAgeMinutes: number | null
  forecastLabel?: string
  /** When true, the forecast-derived trend label ('Stable' or 'Trending up')
   *  is suppressed — it would reflect the absence of forecast data, not an
   *  evaluated result, and would contradict the "Forecast unavailable" banner. */
  forecastSuppressed?: boolean
}) {
  const level = aqiLevel(aqi)
  const ts = trend ? TREND_STYLE[trend] : null
  // 'stable' during forecast failure means "no forecast checked", not
  // "evaluated and found stable" — suppress it when forecasts are unavailable.
  const trendLabel =
    trend === 'watch'  ? 'Trending up' :
    trend === 'severe' ? 'Severe imminent' :
    trend === 'stable' ? (forecastSuppressed ? null : 'Stable') :
    trend === 'stale'  ? 'Stale reading' : null

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
        Worst ward right now
      </span>

      <span className="text-2xl font-extrabold tracking-tight text-slate-900 leading-tight truncate">
        {wardName ?? '—'}
      </span>

      {/* AQI category label only — the number already lives inside the gauge */}
      {aqi !== null && (
        <span className="text-sm font-semibold leading-none" style={{ color: level.hex }}>
          {level.label}
        </span>
      )}

      {ts && trendLabel && (
        <span className={`mt-0.5 flex items-center gap-1.5 text-sm font-medium ${ts.color}`}>
          <span className={`h-2 w-2 flex-shrink-0 rounded-sm ${ts.dot}`} aria-hidden />
          {trendLabel}
        </span>
      )}

      {/* Contextual metadata rows */}
      <div className="mt-2 flex flex-col gap-0.5">
        {forecastPeak !== null && (
          <span className="text-xs text-slate-500 leading-snug">
            Forecast {forecastLabel} peak:{' '}
            <span className="font-medium text-slate-700">{Math.round(forecastPeak)} µg/m³</span>
          </span>
        )}
        {readingAgeMinutes !== null && (
          <span className="text-xs text-slate-500 leading-snug">
            Last observation:{' '}
            <span className="font-medium text-slate-600">{formatAge(readingAgeMinutes)}</span>
          </span>
        )}
      </div>
    </div>
  )
}
