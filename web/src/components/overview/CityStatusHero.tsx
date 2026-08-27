import { aqiLevel } from '../AqiBadge'
import { formatWardName } from '../../lib/format'
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
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[9px] font-semibold uppercase tracking-widest text-slate-400">
        Worst ward
      </span>

      <span
        className="truncate text-xl font-extrabold leading-tight tracking-tight text-slate-900"
        title={wardName ? formatWardName(wardName) : undefined}
      >
        {wardName ? formatWardName(wardName) : '—'}
      </span>

      <div className="flex items-center gap-2">
        {aqi !== null && (
          <span className="text-xs font-semibold" style={{ color: level.hex }}>
            {level.label}
          </span>
        )}
        {ts && trendLabel && (
          <span className={`flex items-center gap-1 text-xs font-medium ${ts.color}`}>
            <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-sm ${ts.dot}`} aria-hidden />
            {trendLabel}
          </span>
        )}
      </div>

      <div className="mt-0.5 flex flex-col gap-px">
        {forecastPeak !== null && (
          <span className="text-[11px] leading-snug text-slate-500">
            Peak {forecastLabel}:{' '}
            <span className="font-medium text-slate-700">{Math.round(forecastPeak)} µg/m³</span>
          </span>
        )}
        {readingAgeMinutes !== null && (
          <span className="text-[11px] leading-snug text-slate-400">
            {formatAge(readingAgeMinutes)}
          </span>
        )}
      </div>
    </div>
  )
}
