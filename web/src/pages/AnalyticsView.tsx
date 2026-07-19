import AppShell from '../components/AppShell'
import { Card, CardHeader, EmptyState, ErrorState, Skeleton, Stat } from '../components/ui'
import { fetchForecastAccuracySummary, fetchGatiMetrics, fetchImpactOutcomeSummary } from '../lib/data'
import { useAsync } from '../lib/useAsync'

/**
 * Analytics — city-wide outcome and forecast-trust rollups (one of the 5
 * commander nav items that were previously permanently disabled "coming
 * soon" placeholders). Built entirely from impact_evaluations and
 * forecast_runs, which already carry the only honest signals this app has
 * for "did it work" and "do we trust this forecast" - no new metric is
 * invented beyond what those tables already record.
 */

const OUTCOME_LABEL: Record<string, string> = {
  effective: 'Effective',
  partly_effective: 'Partly effective',
  ineffective: 'Ineffective',
  inconclusive: 'Inconclusive',
  source_disproved: 'Source disproved',
  completed_no_change: 'Completed, no change',
  recurred: 'Recurred',
}

export default function AnalyticsView() {
  const gati = useAsync(fetchGatiMetrics, [])
  const outcomes = useAsync(fetchImpactOutcomeSummary, [])
  const forecastAccuracy = useAsync(fetchForecastAccuracySummary, [])

  const outcomeRows = outcomes.data ?? []
  const totalEvaluations = outcomeRows.reduce((s, r) => s + r.count, 0)

  return (
    <AppShell subtitle="Analytics">
      <div className="mx-auto w-full max-w-3xl flex-1 space-y-3 overflow-y-auto bg-slate-50 p-3 sm:p-4">
        <Card>
          <CardHeader title="Time to resolution" subtitle="Signal-to-action time (Gati), across all wards" />
          <div className="grid grid-cols-3 gap-2 p-4">
            {gati.loading ? (
              <>
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </>
            ) : gati.error ? (
              <div className="col-span-3">
                <ErrorState message={gati.error} onRetry={gati.refresh} />
              </div>
            ) : (
              <>
                <Stat value={gati.data?.resolvedCount ?? 0} label="Resolved" />
                <Stat value={gati.data?.openCount ?? 0} label="Open" />
                <Stat
                  value={gati.data?.medianHours != null ? `${gati.data.medianHours.toFixed(1)}h` : '-'}
                  label="Median Gati"
                />
              </>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Intervention outcomes"
            subtitle={
              totalEvaluations > 0
                ? `${totalEvaluations} impact evaluation(s) recorded`
                : 'How verified interventions actually played out'
            }
          />
          {outcomes.loading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : outcomes.error ? (
            <ErrorState message={outcomes.error} onRetry={outcomes.refresh} />
          ) : outcomeRows.length === 0 ? (
            <EmptyState icon="▤">No impact evaluations recorded yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {outcomeRows.map((r) => (
                <li key={r.outcome} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-slate-700">{OUTCOME_LABEL[r.outcome] ?? r.outcome}</span>
                  <span className="font-semibold tabular-nums text-slate-900">{r.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Forecast trust"
            subtitle="Latest validated run per ward + pollutant"
          />
          {forecastAccuracy.loading ? (
            <div className="grid grid-cols-2 gap-2 p-4">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          ) : forecastAccuracy.error ? (
            <ErrorState message={forecastAccuracy.error} onRetry={forecastAccuracy.refresh} />
          ) : !forecastAccuracy.data || forecastAccuracy.data.totalWardPollutantPairs === 0 ? (
            <EmptyState icon="▤">No forecast runs recorded yet.</EmptyState>
          ) : (
            <div className="grid grid-cols-2 gap-2 p-4">
              <Stat
                value={`${forecastAccuracy.data.beatsPersistenceCount}/${forecastAccuracy.data.totalWardPollutantPairs}`}
                label="Beat the persistence baseline"
              />
              <Stat
                value={`${forecastAccuracy.data.wardsWithAnyValidatedHorizon}/${forecastAccuracy.data.totalWardPollutantPairs}`}
                label="Have a validated horizon"
              />
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  )
}
