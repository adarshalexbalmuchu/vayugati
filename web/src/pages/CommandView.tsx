import { useState } from 'react'
import { AlertCircle, CheckCircle2, Radar, Radio, RefreshCw, ShieldCheck, TrendingUp, Truck } from 'lucide-react'
import AppShell from '../components/AppShell'
import { Card, ErrorState, Skeleton, StaleBadge } from '../components/ui'
import KpiStrip, { type KpiItem } from '../components/overview/KpiStrip'
import ActionLoopStrip, { type ActionLoopStage } from '../components/overview/ActionLoopStrip'
import PriorityAlertsPanel from '../components/overview/PriorityAlertsPanel'
import OperationalSummaryPanel from '../components/overview/OperationalSummaryPanel'
import HotspotsRiskTable from '../components/overview/HotspotsRiskTable'
import SourceMixPanel from '../components/overview/SourceMixPanel'
import ResponsePlanningPanel from '../components/overview/ResponsePlanningPanel'
import SensorHealthSnapshot from '../components/overview/SensorHealthSnapshot'
import { fetchAllForecasts, fetchAllWardsAqi, fetchForecastAccuracySummary, fetchGatiMetrics } from '../lib/data'
import { listActiveTaskDispatches } from '../lib/incidents'
import { forecastPollutantFor, type MapPollutant } from '../lib/mapRules'
import { fetchStationHealth } from '../lib/ops'
import {
  bucketDispatchSla,
  rollupStationHealth,
  severeWardsWithin,
  tallySourceMix,
  wardsNeedingReviewCount,
  type TimeWindowHours,
} from '../lib/overviewRules'
import { useAsync } from '../lib/useAsync'

/**
 * Overview — the commander's daily City Command Dashboard (launch UI pass).
 * A thin composition shell: one parallel fetch, all derivation lives in
 * overviewRules.ts (pure functions), all presentation lives in
 * components/overview/*. Every KPI here comes from a function that already
 * existed elsewhere in the app (Tasks/Sensors/Analytics) — this page adds no
 * new data source, only a single ranked, cross-referenced read of them.
 */
export default function CommandView() {
  const [pollutant, setPollutant] = useState<MapPollutant>('aqi')
  const [windowHours, setWindowHours] = useState<TimeWindowHours>(36)
  const [selectedWardId, setSelectedWardId] = useState<number | null>(null)

  const state = useAsync(
    () =>
      Promise.all([
        fetchAllWardsAqi(),
        fetchGatiMetrics(),
        listActiveTaskDispatches({ offset: 0, pageSize: 200 }),
        fetchStationHealth(),
        fetchForecastAccuracySummary(),
      ]),
    [],
  )
  // Separate from the bundle above so switching pollutants only re-fetches
  // forecasts, not wards/metrics/dispatches/station health/accuracy too -
  // same split MapPage.tsx uses. AQI maps to a labelled PM2.5 proxy
  // (forecastPollutantFor) since forecast.py never computes AQI itself.
  const forecastPollutant = forecastPollutantFor(pollutant)
  const forecastsState = useAsync(() => fetchAllForecasts(forecastPollutant), [forecastPollutant])

  return (
    <AppShell subtitle="Overview">
      <div className="flex-1 space-y-4 overflow-y-auto bg-slate-50 p-3 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-card">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-slate-900">Delhi City Pack</h1>
              {state.stale && <StaleBadge />}
            </div>
            <p className="mt-0.5 text-xs font-medium text-slate-500">
              Air response command centre · From monitoring to accountable action
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Station data is converted into hotspot triage, forecast risk, evidence needs, and action tracking.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              state.refresh()
              forecastsState.refresh()
            }}
            disabled={state.refreshing}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${state.refreshing ? 'animate-spin' : ''}`} aria-hidden />
            Refresh
          </button>
        </div>

        {state.loading || forecastsState.loading ? (
          <div className="space-y-4">
            <Skeleton className="h-72 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
            <div className="grid gap-4 lg:grid-cols-2">
              <Skeleton className="h-64 rounded-xl" />
              <Skeleton className="h-64 rounded-xl" />
            </div>
          </div>
        ) : state.error ? (
          <Card>
            <ErrorState message={state.error} onRetry={() => state.refresh()} />
          </Card>
        ) : (
          state.data &&
          (() => {
            const [wards, metrics, dispatchPage, stationHealth, accuracy] = state.data
            const forecasts = forecastsState.data ?? new Map()
            const sortedWards = [...wards].sort((a, b) => {
              if (a.aqi === null && b.aqi === null) return 0
              if (a.aqi === null) return 1
              if (b.aqi === null) return -1
              return b.aqi - a.aqi
            })
            const severeAlerts = severeWardsWithin(wards, forecasts, windowHours)
            const slaBuckets = bucketDispatchSla(dispatchPage.rows)
            const sourceMix = tallySourceMix(wards)
            const stationRollup = rollupStationHealth(stationHealth)
            const reviewCount = wardsNeedingReviewCount(wards, forecasts, windowHours)

            const kpis: KpiItem[] = [
              { key: 'open', icon: AlertCircle, label: 'Open incidents', value: metrics.openCount, tone: 'info' },
              {
                key: 'severe',
                icon: TrendingUp,
                label: 'Predicted severe',
                value: severeAlerts.length,
                sublabel: `within ${windowHours}h`,
                tone: severeAlerts.length > 0 ? 'critical' : 'success',
              },
              {
                key: 'dispatches',
                icon: Truck,
                label: 'Active dispatches',
                value: dispatchPage.totalCount,
                sublabel: `${slaBuckets.overdue} overdue`,
                tone: slaBuckets.overdue > 0 ? 'critical' : 'info',
              },
              {
                key: 'sensors',
                icon: Radio,
                label: 'Sensor freshness',
                value: `${stationRollup.active - stationRollup.stale}/${stationRollup.total}`,
                sublabel: 'fresh',
                tone: stationRollup.stale > 0 ? 'warning' : 'success',
              },
              {
                key: 'trust',
                icon: ShieldCheck,
                label: 'Using machine learning',
                value: accuracy.methodMix.total > 0 ? `${accuracy.methodMix.lightgbmCount}/${accuracy.methodMix.total}` : '—',
                sublabel: 'rest use a safer baseline',
                // Deliberately always 'info': a low count here means the
                // forecast gate is being conservative, not that anything is
                // broken — see docs/data/forecast-trust-ui-framing-report.md.
                tone: 'info',
              },
            ]

            // The product's action loop, city-wide. Only stages this page
            // already has a live count for get a number - the rest show '—'
            // rather than a fabricated or misleading figure.
            const actionLoopStages: ActionLoopStage[] = [
              { key: 'monitor', label: 'Monitor', icon: Radio, value: `${stationRollup.active}/${stationRollup.total}` },
              { key: 'detect', label: 'Detect', icon: AlertCircle, value: String(metrics.openCount) },
              { key: 'predict', label: 'Predict', icon: TrendingUp, value: String(severeAlerts.length) },
              { key: 'attribute', label: 'Attribute', icon: Radar, value: '—' },
              { key: 'verify', label: 'Verify', icon: ShieldCheck, value: '—' },
              { key: 'dispatch', label: 'Dispatch', icon: Truck, value: String(dispatchPage.totalCount) },
              { key: 'evaluate', label: 'Evaluate', icon: CheckCircle2, value: String(metrics.resolvedCount) },
            ]

            return (
              <>
                <HotspotsRiskTable
                  wards={sortedWards}
                  forecasts={forecasts}
                  pollutant={pollutant}
                  onPollutantChange={setPollutant}
                  windowHours={windowHours}
                  onWindowHoursChange={setWindowHours}
                  selectedWardId={selectedWardId}
                  onSelectWard={setSelectedWardId}
                />

                <ActionLoopStrip stages={actionLoopStages} />

                <KpiStrip items={kpis} columns={5} />

                <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
                  <PriorityAlertsPanel
                    alerts={severeAlerts}
                    windowHours={windowHours}
                    selectedWardId={selectedWardId}
                    onSelectWard={setSelectedWardId}
                  />
                  <OperationalSummaryPanel metrics={metrics} slaBuckets={slaBuckets} accuracy={accuracy} />
                </div>

                <div className="grid gap-4 lg:grid-cols-3">
                  <SourceMixPanel mix={sourceMix} />
                  <ResponsePlanningPanel
                    activeDispatches={dispatchPage.totalCount}
                    overdue={slaBuckets.overdue}
                    wardsNeedingReview={reviewCount}
                  />
                  <SensorHealthSnapshot rollup={stationRollup} />
                </div>
              </>
            )
          })()
        )}
      </div>
    </AppShell>
  )
}
