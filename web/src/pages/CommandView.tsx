import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import AppShell from '../components/AppShell'
import { Card, ErrorState, Skeleton, StaleBadge } from '../components/ui'
import DataSourceConfidenceStrip from '../components/overview/DataSourceConfidenceStrip'
import PriorityAlertsPanel from '../components/overview/PriorityAlertsPanel'
import OperationalSummaryPanel from '../components/overview/OperationalSummaryPanel'
import HotspotsRiskTable from '../components/overview/HotspotsRiskTable'
import SourceMixPanel from '../components/overview/SourceMixPanel'
import ResponsePlanningPanel from '../components/overview/ResponsePlanningPanel'
import SensorHealthSnapshot from '../components/overview/SensorHealthSnapshot'
import TransportActivityPanel from '../components/overview/TransportActivityPanel'
import {
  fetchAllForecasts,
  fetchAllWardsAqi,
  fetchForecastAccuracySummary,
  fetchGatiMetrics,
  fetchLatestReadingsPreferred,
  fetchTransportActivity,
} from '../lib/data'
import { listActiveTaskDispatches } from '../lib/incidents'
import { tallyDataSourceConfidence } from '../lib/latestReadingRules'
import { forecastPollutantFor, type MapPollutant } from '../lib/mapRules'
import { fetchStationHealth } from '../lib/ops'
import { useIngestHealth } from '../contexts/IngestHealthContext'
import {
  bucketDispatchSla,
  rollupStationHealth,
  severeWardsWithin,
  tallySourceMix,
  wardsNeedingReview,
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
  const { healthLoaded, readingConfirmedFresh, forecastConfirmedFresh } = useIngestHealth()

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
  // Independent of the bundle above by design: a slow/unreachable ingest
  // service (or an unset DELHI_OTD_API_KEY) must never block or blank the
  // rest of Overview - fetchTransportActivity() already degrades to null
  // on any failure, and TransportActivityPanel renders an honest
  // "unavailable" state for that, not a loading spinner forever.
  const transitState = useAsync(() => fetchTransportActivity(), [])
  // Same independent-fetch contract as transitState above - a failure here
  // never blocks Overview; HotspotsRiskTable just keeps showing its
  // existing OpenAQ-sourced AQI unchanged when this has nothing to offer.
  const latestReadingsState = useAsync(() => fetchLatestReadingsPreferred(), [])

  return (
    <AppShell
      subtitle="Overview"
      headerContent={
        <div className="flex flex-1 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-slate-900">Delhi City Pack</h1>
              {state.stale && <StaleBadge />}
            </div>
            <p className="mt-0.5 text-xs font-medium text-slate-500">
              Air response command centre · Official AQ readings, forecast risk, and action tracking.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              state.refresh()
              forecastsState.refresh()
              transitState.refresh()
              latestReadingsState.refresh()
            }}
            disabled={state.refreshing}
            className="focus-ring flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${state.refreshing ? 'animate-spin' : ''}`} aria-hidden />
            Refresh
          </button>
        </div>
      }
    >
      <div className="flex-1 space-y-4 overflow-y-auto bg-slate-50 p-3 sm:p-4">
        {state.loading || forecastsState.loading ? (
          <div className="space-y-4">
            <Skeleton className="h-72 w-full rounded-xl" />
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
            const rawForecasts = forecastsState.data ?? new Map()
            const sortedWards = [...wards].sort((a, b) => {
              if (a.aqi === null && b.aqi === null) return 0
              if (a.aqi === null) return 1
              if (b.aqi === null) return -1
              return b.aqi - a.aqi
            })
            // Suppress derived outputs unless health has loaded AND confirmed fresh.
            // healthLoaded gates the initial-load window (avoids a flash where
            // data renders for ~8s looking degraded before the health check settles).
            // After that window closes, only confirmed-ok lifts suppression —
            // health=null (endpoint unreachable) is treated as "unknown" and keeps
            // outputs suppressed, not as "ok" (which would rebuild the original bug:
            // Wazirpur showing "230 · Likely source: industrial" with full confidence
            // despite 9-day staleness simply because the health check timed out).
            const suppressReading = healthLoaded && !readingConfirmedFresh
            const suppressForecast = healthLoaded && !forecastConfirmedFresh
            const displayWards = suppressReading
              ? sortedWards.map((w) => ({ ...w, dominant_source: null as string | null }))
              : sortedWards
            const forecasts = suppressForecast ? new Map() : rawForecasts
            const severeAlerts = severeWardsWithin(wards, forecasts, windowHours)
            const slaBuckets = bucketDispatchSla(dispatchPage.rows)
            const sourceMix = tallySourceMix(wards)
            const stationRollup = rollupStationHealth(stationHealth)
            const reviewWards = wardsNeedingReview(wards, forecasts, windowHours)
            const transitByWard = new Map((transitState.data?.perWard ?? []).map((w) => [w.wardId, w]))
            const latestReadingsByWard = new Map(
              (latestReadingsState.data ?? [])
                .filter((r) => r.wardId != null)
                .map((r) => [r.wardId as number, r]),
            )
            const dataSourceTally = latestReadingsState.data ? tallyDataSourceConfidence(latestReadingsState.data) : null
            // Cross-reference two already-fetched summaries (severe/watch
            // wards x real nearby transit activity) - no new fetch, nothing
            // fabricated when either summary hasn't loaded.
            const highRiskHotspots = reviewWards
              .map((w) => ({ wardName: w.wardName, activity: transitByWard.get(w.wardId) }))
              .filter((h): h is { wardName: string; activity: NonNullable<typeof h.activity> } => !!h.activity && h.activity.vehicleCount > 0)
              .map((h) => ({ wardName: h.wardName, vehicleCount: h.activity.vehicleCount }))

            return (
              <>
                <HotspotsRiskTable
                  wards={displayWards}
                  forecasts={forecasts}
                  pollutant={pollutant}
                  onPollutantChange={setPollutant}
                  windowHours={windowHours}
                  onWindowHoursChange={setWindowHours}
                  selectedWardId={selectedWardId}
                  onSelectWard={setSelectedWardId}
                  transitActivityByWard={transitByWard}
                  latestReadingsByWard={latestReadingsByWard}
                />

                <DataSourceConfidenceStrip />

                <div className="grid items-start gap-4 lg:grid-cols-[1.3fr_1fr]">
                  <PriorityAlertsPanel
                    alerts={severeAlerts}
                    windowHours={windowHours}
                    selectedWardId={selectedWardId}
                    onSelectWard={setSelectedWardId}
                  />
                  <OperationalSummaryPanel metrics={metrics} slaBuckets={slaBuckets} accuracy={accuracy} />
                </div>

                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <SourceMixPanel mix={sourceMix} />
                  <ResponsePlanningPanel
                    activeDispatches={dispatchPage.totalCount}
                    overdue={slaBuckets.overdue}
                    wardsNeedingReview={reviewWards.length}
                  />
                  <SensorHealthSnapshot rollup={stationRollup} dataSourceTally={dataSourceTally} />
                  <TransportActivityPanel
                    summary={transitState.data}
                    onRetry={() => transitState.refresh()}
                    highRiskHotspots={highRiskHotspots}
                  />
                </div>
              </>
            )
          })()
        )}
      </div>
    </AppShell>
  )
}
