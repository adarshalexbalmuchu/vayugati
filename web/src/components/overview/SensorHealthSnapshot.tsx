import { Database } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { DataSourceTally } from '../../lib/latestReadingRules'
import type { StationHealthRollup } from '../../lib/overviewRules'
import { Card, CardHeader } from '../ui'

const SEGMENT_TONE = {
  fresh: { bar: 'bg-status-success', dot: 'bg-status-success', text: 'text-status-success' },
  stale: { bar: 'bg-status-warning', dot: 'bg-status-warning', text: 'text-status-warning' },
  inactive: { bar: 'bg-slate-300', dot: 'bg-slate-300', text: 'text-slate-500' },
} as const

/** Read-only summary of station freshness - per-station activate/deactivate
 *  actions stay on /sensors (SensorsView.tsx), not duplicated here. A stale
 *  reading means the upstream feed hasn't published recently, not that the
 *  app's own monitoring is broken - the copy here says so explicitly rather
 *  than implying a fault, especially in the (real, current) case where every
 *  connected station is stale at once.
 *
 *  Renamed "Feed Health" (from "Sensor Health") - it now covers the
 *  CPCB/data.gov vs OpenAQ reconciliation too, not just OpenAQ-sourced
 *  freshness alone. `dataSourceTally` is optional and additive: undefined
 *  (reconciliation not loaded yet) just omits that row, never fabricated. */
export default function SensorHealthSnapshot({
  rollup,
  dataSourceTally,
}: {
  rollup: StationHealthRollup
  dataSourceTally?: DataSourceTally | null
}) {
  const fresh = rollup.active - rollup.stale
  const segments = [
    { key: 'fresh' as const, count: fresh, label: 'Fresh' },
    { key: 'stale' as const, count: rollup.stale, label: 'Stale' },
    { key: 'inactive' as const, count: rollup.inactive, label: 'Inactive' },
  ]
  const allStale = rollup.active > 0 && fresh === 0

  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <CardHeader
        title="Feed Health"
        right={
          <Link
            to="/sensors"
            className="focus-ring rounded text-xs font-semibold text-accent-600 hover:text-accent-700"
          >
            View Sensors →
          </Link>
        }
      />
      <div className="space-y-3 px-4 py-3.5">
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-800">{rollup.total}</span> stations connected
        </p>

        {dataSourceTally && (
          <div className="flex items-center gap-1.5 text-xs">
            <Database className="h-3.5 w-3.5 flex-shrink-0 text-accent-600" aria-hidden />
            <span className="font-semibold text-accent-700">{dataSourceTally.cpcbMatched} stations via CPCB</span>
            <span className="text-slate-300">·</span>
            <span className="font-semibold text-slate-500">{dataSourceTally.openaqFallback} via OpenAQ fallback</span>
          </div>
        )}

        {allStale ? (
          <p className="text-xs text-status-warning">
            0 fresh · {rollup.stale} stale from upstream readings — the source feed hasn&apos;t published recently,
            not a device fault on this end.
          </p>
        ) : null}

        <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100">
          {segments.map(
            (s) =>
              s.count > 0 && (
                <div
                  key={s.key}
                  className={SEGMENT_TONE[s.key].bar}
                  style={{ width: `${(s.count / Math.max(rollup.total, 1)) * 100}%` }}
                  title={`${s.label}: ${s.count}`}
                />
              ),
          )}
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {segments.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5 text-xs">
              <span className={`h-2 w-2 rounded-full ${SEGMENT_TONE[s.key].dot}`} aria-hidden />
              <span className="text-slate-500">{s.label}</span>
              <span className={`font-semibold tabular-nums ${SEGMENT_TONE[s.key].text}`}>{s.count}</span>
            </span>
          ))}
        </div>

        {rollup.topStale.length > 0 && (
          <div className="border-t border-slate-100 pt-3">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Stalest active</p>
            <ul className="space-y-1">
              {rollup.topStale.map((s) => (
                <li key={s.name} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-slate-600">
                    {s.name}
                    {s.wardName ? ` · ${s.wardName}` : ''}
                  </span>
                  <span className="flex-shrink-0 tabular-nums font-semibold text-status-warning">
                    {s.ageMinutes != null ? `${Math.round(s.ageMinutes / 60)}h` : '—'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  )
}
