import { useMemo, useState } from 'react'
import { CheckCircle2, Clock3, MapPin, RefreshCw, ShieldCheck, TrendingUp } from 'lucide-react'
import AppShell from '../components/AppShell'
import { ErrorState, Skeleton, StaleBadge } from '../components/ui'
import KpiStrip, { type KpiItem } from '../components/overview/KpiStrip'
import AgencyPerformancePanel from '../components/analytics/AgencyPerformancePanel'
import ForecastTrustPanel from '../components/analytics/ForecastTrustPanel'
import InterventionOutcomesPanel from '../components/analytics/InterventionOutcomesPanel'
import RecurrencePanel from '../components/analytics/RecurrencePanel'
import { fetchAllWardsAqi, fetchForecastAccuracySummary, fetchGatiMetrics, fetchImpactOutcomeSummary } from '../lib/data'
import { listIncidents, listTaskDispatchesForAnalytics } from '../lib/incidents'
import { bucketAgencyPerformance, recurringWardsSummary, tallySourceMix } from '../lib/overviewRules'
import { useAsync } from '../lib/useAsync'

/**
 * Analytics — outcomes, forecast trust, and performance console (Phase
 * redesign, matching the Overview/Incidents/Map/Tasks/Sensors visual
 * language). Not a chart dashboard: every section proves something specific
 * (did interventions work, can forecasts be trusted, what recurs, are
 * agencies responding in time) using data already validated elsewhere in
 * this app (impact_evaluations, forecast_runs, task_dispatches, incidents) -
 * nothing here is a new metric invented for this page.
 *
 * The time-range selector genuinely re-scopes agency performance,
 * recurrence, and time-to-resolution (all computed from a real windowed
 * fetch). Intervention outcomes, forecast trust, and time-to-action come
 * from data.ts functions shared with the Overview page that have no date
 * parameter, so they stay labelled "all-time" rather than silently
 * pretending to be filtered. "Median time to action" reuses
 * fetchGatiMetrics().medianHours with the exact same label Overview's own
 * KPI strip already gives that value - not a second, differently-named
 * copy of the same number.
 */

const WINDOW_OPTIONS = [7, 30, 90] as const
type WindowDays = (typeof WINDOW_OPTIONS)[number]

export default function AnalyticsView() {
  const [windowDays, setWindowDays] = useState<WindowDays>(30)
  const windowLabel = `last ${windowDays}d`

  const gati = useAsync(fetchGatiMetrics, [], { cacheKey: 'analytics:gati' })
  const outcomes = useAsync(fetchImpactOutcomeSummary, [], { cacheKey: 'analytics:outcomes' })
  const forecastAccuracy = useAsync(fetchForecastAccuracySummary, [], { cacheKey: 'analytics:forecast-accuracy' })
  const wardsState = useAsync(fetchAllWardsAqi, [], { cacheKey: 'analytics:wards' })
  const incidentsState = useAsync(() => listIncidents({ limit: 1000 }), [], { cacheKey: 'analytics:incidents' })
  const dispatchState = useAsync(() => listTaskDispatchesForAnalytics(windowDays), [windowDays], {
    cacheKey: `analytics:dispatch:${windowDays}`,
  })

  const cutoff = useMemo(() => new Date(Date.now() - windowDays * 24 * 3_600_000), [windowDays])
  const incidentsInWindow = useMemo(
    () => (incidentsState.data ?? []).filter((i) => new Date(i.detected_at) >= cutoff),
    [incidentsState.data, cutoff],
  )
  const recurringWards = useMemo(() => recurringWardsSummary(incidentsInWindow), [incidentsInWindow])
  const sourceMix = useMemo(() => tallySourceMix(wardsState.data ?? []), [wardsState.data])
  const agencyRows = useMemo(() => bucketAgencyPerformance(dispatchState.data ?? []), [dispatchState.data])

  // Real, distinct from gati.medianHours below: incident.closed_at minus
  // incident.detected_at, for incidents actually closed in this window -
  // the incident lifecycle's own resolution time, not the citizen-report-
  // based "Gati" duration Overview's KPI strip already labels "time to
  // action" (same fetchGatiMetrics() value, reused with that exact label
  // here too, rather than relabelling the same number inconsistently).
  const timeToResolutionHours = useMemo(() => {
    const samples = incidentsInWindow
      .filter((i) => i.status === 'closed' && i.closed_at)
      .map((i) => (new Date(i.closed_at as string).getTime() - new Date(i.detected_at).getTime()) / 3_600_000)
      .sort((a, b) => a - b)
    return samples.length ? samples[Math.floor(samples.length / 2)] : null
  }, [incidentsInWindow])

  const kpiLoading = gati.loading || forecastAccuracy.loading || dispatchState.loading
  const kpis: KpiItem[] | null = useMemo(() => {
    if (kpiLoading || !gati.data || !forecastAccuracy.data) return null
    return [
      { key: 'resolved', icon: CheckCircle2, label: 'Resolved incidents', value: gati.data.resolvedCount, tone: 'success' },
      { key: 'open', icon: Clock3, label: 'Open incidents', value: gati.data.openCount, tone: gati.data.openCount > 0 ? 'info' : 'success' },
      {
        key: 'timeToAction',
        icon: Clock3,
        label: 'Median time to action',
        value: gati.data.medianHours != null ? `${gati.data.medianHours.toFixed(1)}h` : 'No sample',
        sublabel: 'all-time - same figure as Overview',
        tone: 'neutral',
      },
      {
        key: 'timeToResolution',
        icon: Clock3,
        label: 'Median time to resolution',
        value: timeToResolutionHours != null ? `${timeToResolutionHours.toFixed(1)}h` : 'No sample',
        sublabel: windowLabel,
        tone: 'neutral',
      },
      {
        key: 'validated',
        icon: ShieldCheck,
        label: 'Forecasts validated',
        value: forecastAccuracy.data.wardsWithAnyValidatedHorizon,
        sublabel: `of ${forecastAccuracy.data.totalWardPollutantPairs} pairs`,
        tone: 'info',
      },
      {
        key: 'usingMl',
        icon: TrendingUp,
        label: 'Using machine learning',
        value: forecastAccuracy.data.methodMix.lightgbmCount,
        sublabel: `of ${forecastAccuracy.data.methodMix.total} pairs - rest use a safer baseline`,
        // Deliberately always 'info', never conditional on the count: a low
        // number here means the gate is being conservative, not that
        // anything is broken - see docs/data/forecast-trust-ui-framing-report.md.
        tone: 'info',
      },
    ]
  }, [kpiLoading, gati.data, forecastAccuracy.data, timeToResolutionHours, windowLabel])

  const refreshAll = () => {
    gati.refresh()
    outcomes.refresh()
    forecastAccuracy.refresh()
    wardsState.refresh()
    incidentsState.refresh()
    dispatchState.refresh()
  }

  return (
    <AppShell subtitle="Analytics">
      <div className="flex-1 space-y-4 overflow-y-auto bg-sky-50 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-card">
          <div>
            <h1 className="text-base font-bold text-slate-900">Analytics</h1>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
              <MapPin className="h-3 w-3" aria-hidden />
              Delhi City Pack
              {(dispatchState.stale || incidentsState.stale) && <StaleBadge />}
            </p>
            <p className="mt-1 max-w-xl text-xs text-slate-400">
              Tracks system performance, forecast trust, recurrence, and intervention outcomes - proof of whether the
              platform is producing verified action, not a generic chart dashboard.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 p-0.5">
              <Clock3 className="ml-1.5 h-3.5 w-3.5 text-slate-400" aria-hidden />
              {WINDOW_OPTIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setWindowDays(d)}
                  className={`focus-ring rounded-md px-2 py-1 text-xs font-semibold transition ${
                    windowDays === d ? 'bg-accent-500 text-white' : 'text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={refreshAll}
              disabled={dispatchState.refreshing}
              className="focus-ring flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${dispatchState.refreshing ? 'animate-spin' : ''}`} aria-hidden />
              Refresh
            </button>
          </div>
        </div>

        {kpiLoading ? (
          <Skeleton className="h-20 w-full rounded-xl" />
        ) : gati.error || forecastAccuracy.error ? (
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
            <ErrorState message={gati.error ?? forecastAccuracy.error ?? undefined} onRetry={refreshAll} />
          </div>
        ) : (
          kpis && <KpiStrip items={kpis} />
        )}

        <InterventionOutcomesPanel rows={outcomes.data ?? []} loading={outcomes.loading} error={outcomes.error} onRetry={outcomes.refresh} />

        <ForecastTrustPanel
          data={forecastAccuracy.data ?? null}
          loading={forecastAccuracy.loading}
          error={forecastAccuracy.error}
          onRetry={forecastAccuracy.refresh}
        />

        <RecurrencePanel
          recurringWards={recurringWards}
          sourceMix={sourceMix}
          windowLabel={windowLabel}
          loading={incidentsState.loading || wardsState.loading}
          error={incidentsState.error ?? wardsState.error}
          onRetry={() => {
            incidentsState.refresh()
            wardsState.refresh()
          }}
        />

        <AgencyPerformancePanel
          rows={agencyRows}
          windowLabel={windowLabel}
          loading={dispatchState.loading}
          error={dispatchState.error}
          onRetry={dispatchState.refresh}
        />
      </div>
    </AppShell>
  )
}
