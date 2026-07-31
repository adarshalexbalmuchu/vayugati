import { CityAqiGauge } from './CityAqiGauge'
import type { HotspotStatus } from '../../lib/overviewRules'

const TREND_STYLE: Record<HotspotStatus, { color: string; dot: string }> = {
  severe:  { color: 'text-status-critical', dot: 'bg-status-critical' },
  watch:   { color: 'text-status-warning',  dot: 'bg-status-warning'  },
  stable:  { color: 'text-status-success',  dot: 'bg-status-success'  },
  stale:   { color: 'text-slate-400',       dot: 'bg-slate-300'       },
  no_data: { color: 'text-slate-400',       dot: 'bg-slate-300'       },
}

function formatSource(s: string | null) {
  return s ? s.replace(/_/g, ' ') : null
}

export default function CityStatusHero({
  aqi,
  wardName,
  trend,
  source,
}: {
  aqi: number | null
  wardName: string | null
  trend: HotspotStatus | null
  source: string | null
}) {
  const ts = trend ? TREND_STYLE[trend] : null
  const trendLabel = trend ? (
    trend === 'watch' ? 'Trending up' :
    trend === 'severe' ? 'Severe imminent' :
    trend === 'stable' ? 'Stable' :
    trend === 'stale' ? 'Stale reading' : null
  ) : null

  const formattedSource = formatSource(source)
  const trendLine = [trendLabel, formattedSource].filter(Boolean).join(', ')

  return (
    <div className="flex items-center gap-6 sm:gap-8">
      <CityAqiGauge aqi={aqi} />

      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
          Worst ward right now
        </span>
        <span className="text-2xl font-extrabold text-slate-900 tracking-tight leading-none truncate">
          {wardName ?? '—'}
        </span>
        {ts && trendLine && (
          <span className={`flex items-center gap-1.5 text-sm font-medium ${ts.color}`}>
            <span className={`h-2 w-2 flex-shrink-0 rounded-sm ${ts.dot}`} aria-hidden />
            {trendLine}
          </span>
        )}
      </div>
    </div>
  )
}
