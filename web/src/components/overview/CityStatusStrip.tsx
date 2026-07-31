import { aqiLevel } from '../AqiBadge'
import type { TimeWindowHours } from '../../lib/overviewRules'

function Divider() {
  return <span className="h-4 w-px flex-shrink-0 bg-slate-200" aria-hidden />
}

function Stat({
  value,
  label,
  color,
}: {
  value: React.ReactNode
  label: string
  color?: string
}) {
  return (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span className={`text-sm font-bold tabular-nums ${color ?? 'text-slate-800'}`}>{value}</span>
      <span className="text-xs text-slate-400">{label}</span>
    </span>
  )
}

export default function CityStatusStrip({
  worstWard,
  reviewCount,
  severeInWindowCount,
  openIncidents,
  windowHours,
}: {
  worstWard: { name: string; aqi: number | null } | null
  /** Wards at severe or watch status right now (from hotspotStatus). */
  reviewCount: number
  /** Wards forecast to hit severe within the selected window (from severeWardsWithin). */
  severeInWindowCount: number
  openIncidents: number
  windowHours: TimeWindowHours
}) {
  const level = worstWard ? aqiLevel(worstWard.aqi) : null

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs shadow-card">
      {worstWard && level ? (
        <>
          <span className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 flex-shrink-0 rounded-full"
              style={{ backgroundColor: level.hex }}
              aria-hidden
            />
            <span className="font-bold tabular-nums" style={{ color: level.hex }}>
              {worstWard.aqi ?? '—'}
            </span>
            <span className="text-slate-500">{level.label}</span>
            <span className="text-slate-300">·</span>
            <span className="font-medium text-slate-700">{worstWard.name}</span>
          </span>
          <Divider />
        </>
      ) : null}

      <Stat
        value={reviewCount}
        label="wards flagged"
        color={reviewCount > 0 ? 'text-status-warning' : 'text-slate-800'}
      />

      {severeInWindowCount > 0 && (
        <>
          <Divider />
          <Stat
            value={`${severeInWindowCount} severe in ${windowHours}h`}
            label="forecast"
            color="text-status-critical"
          />
        </>
      )}

      <Divider />

      <Stat
        value={openIncidents}
        label="incidents open"
        color={openIncidents > 0 ? 'text-slate-800' : 'text-slate-400'}
      />
    </div>
  )
}
