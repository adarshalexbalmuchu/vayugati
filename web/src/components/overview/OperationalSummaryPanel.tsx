import { Activity } from 'lucide-react'
import type { ForecastAccuracySummary, GatiMetrics } from '../../lib/data'
import { forecastPipelineStatusLabel } from '../../lib/forecastTrustRules'
import type { DispatchSlaBuckets } from '../../lib/overviewRules'
import { Card, CardHeader, Stat } from '../ui'

const PIPELINE_STATUS_TONE: Record<string, string> = {
  Live: 'text-status-success',
  'Partially live': 'text-status-warning',
  Stale: 'text-status-critical',
  'No data': 'text-slate-400',
}

/** A live snapshot synthesis of already-fetched data - deliberately not an
 *  "improving/worsening" trend claim, since no historical time-series
 *  baseline exists in this app to honestly support that. */
export default function OperationalSummaryPanel({
  metrics,
  slaBuckets,
  accuracy,
}: {
  metrics: GatiMetrics
  slaBuckets: DispatchSlaBuckets
  accuracy: ForecastAccuracySummary
}) {
  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <Activity className="h-4 w-4 text-accent-600" aria-hidden />
            Operational Summary
          </span>
        }
        subtitle="Live snapshot of the current queue and forecast trust"
      />
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3.5">
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-800">{metrics.openCount}</span> incidents open,{' '}
          <span className="font-semibold text-slate-800">{metrics.resolvedCount}</span> resolved with a recorded
          outcome
          {metrics.medianHours != null && (
            <>
              {' '}
              &mdash; median time to action{' '}
              <span className="font-semibold text-slate-800">{metrics.medianHours.toFixed(1)}h</span>
            </>
          )}
          .
        </p>

        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Active dispatch SLA
          </p>
          <div className="grid grid-cols-4 gap-2">
            <Stat value={slaBuckets.overdue} label="Overdue" accent="text-status-critical" />
            <Stat value={slaBuckets.dueSoon} label="Due soon" accent="text-status-warning" />
            <Stat value={slaBuckets.onTrack} label="On track" accent="text-status-success" />
            <Stat value={slaBuckets.noSla} label="No SLA" accent="text-slate-500" />
          </div>
        </div>

        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Forecast trust</p>
          <div className="grid grid-cols-2 gap-2">
            <Stat
              value={forecastPipelineStatusLabel(accuracy.coverage)}
              label="Pipeline"
              accent={PIPELINE_STATUS_TONE[forecastPipelineStatusLabel(accuracy.coverage)]}
            />
            <Stat value={`${accuracy.coverage.freshCount}/${accuracy.coverage.totalPairs}`} label="Coverage" />
          </div>

          <div className="mt-3">
            <div className="flex h-2 overflow-hidden rounded-full bg-slate-100">
              {accuracy.methodMix.total > 0 && (
                <>
                  <div
                    className="bg-accent-500"
                    style={{ width: `${(accuracy.methodMix.lightgbmCount / accuracy.methodMix.total) * 100}%` }}
                    title={`ML selected: ${accuracy.methodMix.lightgbmCount}`}
                  />
                  <div
                    className="bg-slate-300"
                    style={{ width: `${(accuracy.methodMix.diurnalPersistenceCount / accuracy.methodMix.total) * 100}%` }}
                    title={`Safer baseline: ${accuracy.methodMix.diurnalPersistenceCount}`}
                  />
                </>
              )}
            </div>
            <div className="mt-1.5 flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-semibold text-accent-700">
                <span className="h-2 w-2 rounded-full bg-accent-500" aria-hidden />
                ML selected {accuracy.methodMix.lightgbmCount}
              </span>
              <span className="flex items-center gap-1.5 font-semibold text-slate-500">
                <span className="h-2 w-2 rounded-full bg-slate-300" aria-hidden />
                Safer baseline {accuracy.methodMix.diurnalPersistenceCount}
              </span>
            </div>
          </div>

          <p className="mt-2 text-xs text-slate-500">ML is used only when it beats strong simple baselines.</p>
          {accuracy.coverage.latestGeneratedAt && (
            <p className="mt-1 text-[11px] text-slate-400">
              Latest forecast cycle: {new Date(accuracy.coverage.latestGeneratedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}
