import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import AppShell from '../components/AppShell'
import { Card, ErrorState, Skeleton, StaleBadge } from '../components/ui'
import PriorityAlertsPanel from '../components/overview/PriorityAlertsPanel'
import { CityAqiGauge } from '../components/overview/CityAqiGauge'
import CityStatusHero from '../components/overview/CityStatusHero'
import CityKpiRow from '../components/overview/CityKpiRow'
import HotspotsRiskTable from '../components/overview/HotspotsRiskTable'
import {
  fetchAllForecasts,
  fetchAllWardsAqi,
  fetchForecastAccuracySummary,
  fetchGatiMetrics,
  fetchLatestReadingsPreferred,
} from '../lib/data'
import { forecastPollutantFor, type MapPollutant } from '../lib/mapRules'
import { useIngestHealth } from '../contexts/IngestHealthContext'
import {
  hotspotStatus,
  peakWithinWindow,
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
  const { healthLoaded, readingConfirmedFresh, forecastConfirmedFresh } = useIngestHealth()

  const state = useAsync(
    () =>
      Promise.all([
        fetchAllWardsAqi(),
        fetchGatiMetrics(),
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
              Live readings · forecast · incidents
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
      <div className="flex h-full flex-col overflow-hidden bg-sky-50 gap-2 p-3">
        {state.loading || forecastsState.loading ? (
          <>
            <Skeleton className="h-[122px] shrink-0 rounded-xl" />
            <Skeleton className="min-h-0 flex-1 rounded-xl" />
          </>
        ) : state.error ? (
          <Card>
            <ErrorState message={state.error} onRetry={() => state.refresh()} />
          </Card>
        ) : (
          state.data &&
          (() => {
            const [wards, metrics, accuracy] = state.data
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
              // Fall through: CPCB fresh → ward.aqi (OpenAQ 24h) → openaqAqi
              // (raw reading, always populated even when compute_ward_aqi returns
              // null for stale wards — keeps sort order meaningful during outages)
              return p?.sourceUsed === 'cpcb' && p.cpcbAqi != null
                ? p.cpcbAqi
                : (ward.aqi ?? p?.openaqAqi ?? null)
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
            const reviewWards = wardsNeedingReview(wards, forecasts, windowHours)

            // Trend status for the worst ward — same hotspotStatus() the table uses
            // per row, computed once here for the hero, not duplicated.
            const worstWard = displayWards[0] ?? null
            const worstForecast = worstWard ? forecasts.get(worstWard.id) : null
            const worstWindowed = worstForecast ? peakWithinWindow(worstForecast, windowHours) : null
            // Hero shows CPCB-preferred AQI when available, matching the table — prevents
            // the gauge showing 500 (OpenAQ 24h average) while the table shows 277 (CPCB live).
            const worstPreferred = worstWard ? latestReadingsByWard.get(worstWard.id) : undefined
            // ward.ts is null when compute_ward_aqi skips stale wards; fall back
            // to the ISO timestamp from the reconciliation row.
            // cpcbLastUpdate is in DD-MM-YYYY HH:MM:SS (unparseable by JS) — excluded.
            const worstTs = worstWard?.ts ?? worstPreferred?.openaqLastUpdate ?? null
            const worstReadingAge = (() => {
              if (!worstTs) return null
              const ms = Date.now() - new Date(worstTs).getTime()
              return isNaN(ms) ? null : ms / 60_000
            })()
            const worstDisplayAqi = (worstPreferred?.sourceUsed === 'cpcb' && worstPreferred.cpcbAqi != null)
              ? worstPreferred.cpcbAqi
              : (worstWard?.aqi ?? worstPreferred?.openaqAqi ?? null)
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
                {/* Hero — gauge | ward summary | KPI rail, compact single row */}
                <div className="shrink-0 rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-card">
                  <div className="flex items-center gap-0">
                    <div className="flex-shrink-0 pr-5">
                      <CityAqiGauge aqi={worstDisplayAqi} size={112} />
                    </div>
                    <div className="w-px self-stretch bg-slate-100" aria-hidden />
                    <div className="min-w-0 w-[260px] flex-none px-5">
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
                    <div className="w-px self-stretch bg-slate-100" aria-hidden />
                    <div className="flex-1 pl-5">
                      <CityKpiRow
                        reviewCount={reviewWards.length}
                        openIncidents={metrics.openCount}
                        coverage={coverageProp}
                        latestReadingAgeMinutes={latestReadingAgeMinutes}
                      />
                    </div>
                  </div>
                </div>

                {/* Priority alerts — compact banner, shown only when wards are flagged */}
                {severeAlerts.length > 0 && (
                  <div className="shrink-0 max-h-[96px] overflow-hidden">
                    <PriorityAlertsPanel
                      alerts={severeAlerts}
                      windowHours={windowHours}
                      selectedWardId={selectedWardId}
                      onSelectWard={setSelectedWardId}
                    />
                  </div>
                )}

                {/* Ward risk table — grows to fill all remaining vertical space */}
                <div className="min-h-0 flex-1">
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
                </div>

              </>
            )
          })()
        )}
      </div>
    </AppShell>
  )
}
