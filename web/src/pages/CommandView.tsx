import { useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import AppShell from '../components/AppShell'
import { Card, ErrorState, Skeleton, StaleBadge } from '../components/ui'
import PriorityAlertsPanel from '../components/overview/PriorityAlertsPanel'
import OperationalSummaryPanel from '../components/overview/OperationalSummaryPanel'
import { CityAqiGauge } from '../components/overview/CityAqiGauge'
import CityStatusHero from '../components/overview/CityStatusHero'
import CityKpiRow from '../components/overview/CityKpiRow'
import HotspotsRiskTable from '../components/overview/HotspotsRiskTable'
import SensorHealthSnapshot from '../components/overview/SensorHealthSnapshot'
import {
  fetchAllForecasts,
  fetchAllWardsAqi,
  fetchForecastAccuracySummary,
  fetchGatiMetrics,
  fetchLatestReadingsPreferred,
} from '../lib/data'
import { listActiveTaskDispatches } from '../lib/incidents'
import { tallyDataSourceConfidence } from '../lib/latestReadingRules'
import { forecastPollutantFor, type MapPollutant } from '../lib/mapRules'
import { fetchStationHealth } from '../lib/ops'
import { useIngestHealth } from '../contexts/IngestHealthContext'
import {
  bucketDispatchSla,
  hotspotStatus,
  peakWithinWindow,
  rollupStationHealth,
  severeWardsWithin,
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
  const [windowHours, setWindowHours] = useState<TimeWindowHours>(24)
  const [selectedWardId, setSelectedWardId] = useState<number | null>(null)
  const { healthLoaded, readingConfirmedFresh, forecastConfirmedFresh, health } = useIngestHealth()

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
  const forecastPollutant = forecastPollutantFor(pollutant)
  const forecastsState = useAsync(() => fetchAllForecasts(forecastPollutant), [forecastPollutant])
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
      <div className="flex-1 space-y-4 overflow-y-auto bg-sky-50 p-3 sm:p-4">
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
            const latestReadingsByWard = new Map(
              (latestReadingsState.data ?? [])
                .filter((r) => r.wardId != null)
                .map((r) => [r.wardId as number, r]),
            )
            // When CPCB data is available for a ward, sort by CPCB AQI so the
            // hero's "worst ward" matches what the table shows, not the OpenAQ
            // 24h-average stored in wards.aqi.
            const getEffectiveAqi = (ward: (typeof wards)[0]) => {
              const p = latestReadingsByWard.get(ward.id)
              return p?.sourceUsed === 'cpcb' && p.cpcbAqi != null ? p.cpcbAqi : ward.aqi
            }
            const sortedWards = [...wards].sort((a, b) => {
              const aqiA = getEffectiveAqi(a)
              const aqiB = getEffectiveAqi(b)
              if (aqiA === null && aqiB === null) return 0
              if (aqiA === null) return 1
              if (aqiB === null) return -1
              return aqiB - aqiA
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
            const stationRollup = rollupStationHealth(stationHealth)
            const reviewWards = wardsNeedingReview(wards, forecasts, windowHours)
            const dataSourceTally = latestReadingsState.data?.length ? tallyDataSourceConfidence(latestReadingsState.data) : null

            // Data freshness banner: show when readings are confirmed stale or pipeline down
            const healthAge = health?.checks.reading_freshness.latest_reading_age_minutes ?? null
            const dataIsStale = healthLoaded && (!readingConfirmedFresh || (healthAge != null && healthAge >= 60))
            const staleAgeLabel = healthAge != null
              ? healthAge < 60 ? `${Math.round(healthAge)}m` : `${Math.round(healthAge / 60)}h`
              : null

            // Trend status for the worst ward — same hotspotStatus() the table uses
            // per row, computed once here for the hero, not duplicated.
            const worstWard = displayWards[0] ?? null
            const worstForecast = worstWard ? forecasts.get(worstWard.id) : null
            const worstWindowed = worstForecast ? peakWithinWindow(worstForecast, windowHours) : null
            const worstReadingAge = worstWard?.ts
              ? (Date.now() - new Date(worstWard.ts).getTime()) / 60_000
              : null
            // Hero shows CPCB-preferred AQI when available, matching the table — prevents
            // the gauge showing 500 (OpenAQ 24h average) while the table shows 277 (CPCB live).
            const worstPreferred = worstWard ? latestReadingsByWard.get(worstWard.id) : undefined
            const worstDisplayAqi = (worstPreferred?.sourceUsed === 'cpcb' && worstPreferred.cpcbAqi != null)
              ? worstPreferred.cpcbAqi
              : (worstWard?.aqi ?? null)
            const worstTrend = worstWard
              ? hotspotStatus(
                  { hoursToSevere: worstForecast?.hoursToSevere ?? null, peakExcess: worstWindowed?.excess ?? null, aqi: worstDisplayAqi, readingAgeMinutes: worstReadingAge },
                  windowHours,
                )
              : null

            // Most-recent ward reading across all wards — used by CityKpiRow to
            // show a concrete age alongside the pipeline freshness status.
            // Suppressed when readings are flagged degraded (suppressReading=true).
            const latestReadingTs = suppressReading ? null : sortedWards
              .flatMap((w) => (w.ts ? [w.ts] : []))
              .reduce<string | null>((best, ts) => (!best || ts > best ? ts : best), null)
            const latestReadingAgeMinutes = latestReadingTs
              ? (Date.now() - new Date(latestReadingTs).getTime()) / 60_000
              : null

            const coverageProp = accuracy.coverage.totalPairs > 0
              ? { fresh: accuracy.coverage.freshCount, total: accuracy.coverage.totalPairs }
              : null

            // Label for the forecast pollutant shown in the hero intel panel.
            // Tracks the pollutant toggle so the label stays honest when the
            // user switches from the default AQI/PM2.5 proxy to PM10 or NO2.
            const forecastLabel =
              forecastPollutant === 'pm25' ? 'PM₂.₅' :
              forecastPollutant === 'pm10' ? 'PM₁₀' : 'NO₂'

            return (
              <>
                {/* Stale data banner — shown prominently when readings are old */}
                {dataIsStale && (
                  <div className="flex items-center gap-2.5 rounded-lg border border-status-warning/30 bg-status-warning/10 px-4 py-2.5 text-sm text-status-warning">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" aria-hidden />
                    <span>
                      <span className="font-semibold">Data delayed</span>
                      {staleAgeLabel ? ` — last reading ${staleAgeLabel} ago.` : '.'}
                      {' '}AQI values on this page may not reflect current conditions.
                    </span>
                  </div>
                )}

                {/* Hero area — gauge | ward summary | KPI rail */}
                <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-card">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:gap-0">
                    <div className="flex-shrink-0 lg:pr-6">
                      <CityAqiGauge aqi={worstDisplayAqi} />
                    </div>
                    <div className="hidden w-px flex-shrink-0 bg-slate-100 lg:block lg:self-stretch" aria-hidden />
                    <div className="min-w-0 flex-1 lg:w-[300px] lg:flex-none lg:px-6">
                      <CityStatusHero
                        aqi={worstDisplayAqi}
                        wardName={worstWard?.name ?? null}
                        trend={worstTrend}
                        source={worstWard?.dominant_source ?? null}
                        forecastPeak={worstWindowed?.value ?? null}
                        readingAgeMinutes={worstReadingAge}
                        forecastLabel={forecastLabel}
                        forecastSuppressed={suppressForecast}
                      />
                    </div>
                    <div className="hidden w-px flex-shrink-0 bg-slate-100 lg:block lg:self-stretch" aria-hidden />
                    <div className="lg:flex-1 lg:pl-6">
                      <CityKpiRow
                        reviewCount={reviewWards.length}
                        openIncidents={metrics.openCount}
                        coverage={coverageProp}
                        latestReadingAgeMinutes={latestReadingAgeMinutes}
                      />
                    </div>
                  </div>
                </div>

                <HotspotsRiskTable
                  wards={displayWards}
                  forecasts={forecasts}
                  pollutant={pollutant}
                  onPollutantChange={setPollutant}
                  windowHours={windowHours}
                  onWindowHoursChange={setWindowHours}
                  selectedWardId={selectedWardId}
                  onSelectWard={setSelectedWardId}
                  latestReadingsByWard={latestReadingsByWard}
                  forecastSuppressed={suppressForecast}
                />

                {/* Priority alerts — only shown when there's something to act on */}
                {severeAlerts.length > 0 && (
                  <PriorityAlertsPanel
                    alerts={severeAlerts}
                    windowHours={windowHours}
                    selectedWardId={selectedWardId}
                    onSelectWard={setSelectedWardId}
                  />
                )}

                <div className="grid gap-4 lg:grid-cols-2">
                  <OperationalSummaryPanel metrics={metrics} slaBuckets={slaBuckets} accuracy={accuracy} />
                  <SensorHealthSnapshot rollup={stationRollup} dataSourceTally={dataSourceTally} />
                </div>
              </>
            )
          })()
        )}
      </div>
    </AppShell>
  )
}
