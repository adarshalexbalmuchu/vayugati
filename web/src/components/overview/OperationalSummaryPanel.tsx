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
        title="Operational Summary"
        subtitle="Live snapshot of the current queue and forecast trust"
      />
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-800">{metrics.openCount}</span> incidents open,{' '}
          <span className="font-semibold text-slate-800">{metrics.resolvedCount}</span> resolved with a recorded
          outcome
          {metrics.medianHours != null && parseFloat(metrics.medianHours.toFixed(1)) > 0 && (
            <>
              {' '}
              &mdash; median time to action{' '}
              <span className="font-semibold text-slate-800">{metrics.medianHours.toFixed(1)}h</span>
            </>
          )}
          .
        </p>

        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Active dispatch SLA
          </p>
          {slaBuckets.overdue + slaBuckets.dueSoon + slaBuckets.onTrack + slaBuckets.noSla === 0 ? (
            <p className="text-xs text-slate-400">No active dispatches right now.</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              <Stat value={slaBuckets.overdue} label="Overdue" accent="text-status-critical" />
              <Stat value={slaBuckets.dueSoon} label="Due soon" accent="text-status-warning" />
              <Stat value={slaBuckets.onTrack} label="On track" accent="text-status-success" />
              <Stat value={slaBuckets.noSla} label="No SLA" accent="text-slate-500" />
            </div>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Forecast pipeline</p>
          <div className="grid grid-cols-2 gap-2">
            <Stat
              value={forecastPipelineStatusLabel(accuracy.coverage)}
              label="Status"
              accent={PIPELINE_STATUS_TONE[forecastPipelineStatusLabel(accuracy.coverage)]}
            />
            <Stat value={`${accuracy.coverage.freshCount}/${accuracy.coverage.totalPairs}`} label="Wards covered" />
          </div>
          {accuracy.coverage.latestGeneratedAt && (
            <p className="mt-2 text-[11px] text-slate-400">
              Last run: {new Date(accuracy.coverage.latestGeneratedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}
