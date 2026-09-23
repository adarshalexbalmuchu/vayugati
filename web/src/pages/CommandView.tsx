import { useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import AppShell from '../components/AppShell'
import { Card, ErrorState, Skeleton } from '../components/ui'
import PriorityAlertsPanel from '../components/overview/PriorityAlertsPanel'
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
 *
 * The hero (gauge + worst ward + KPIs) is merged into AppShell's header row,
 * alongside Refresh — not a separate card in the page body. That means the
 * loading/error/success branching below has to produce both the header's
 * content (`heroContent`) and the body's content (`body`), since headerContent
 * is set once when <AppShell> is rendered, not re-derived per branch.
 */
export default function CommandView() {
  const [pollutant, setPollutant] = useState<MapPollutant>('aqi')
  // No longer user-changeable (the 12h/24h/36h/48h picker was removed — dead
  // UI while the forecast pipeline isn't producing results) but still a real
  // input to the trend/severity calculations below, so it stays as a fixed
  // 24h default rather than disappearing outright.
  const windowHours: TimeWindowHours = 24
  const [selectedWardId, setSelectedWardId] = useState<number | null>(null)
  const { healthLoaded, readingConfirmedFresh, forecastConfirmedFresh } = useIngestHealth()
  const riskTableRef = useRef<HTMLDivElement | null>(null)
  const [flaggedPulse, setFlaggedPulse] = useState(false)

  // Scrolls the ranked ward table into view and briefly rings it — used by
  // the "Wards flagged" KPI card so the number always points somewhere,
  // instead of sitting there as inert text.
  const jumpToRiskTable = () => {
    riskTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    setFlaggedPulse(true)
    window.setTimeout(() => setFlaggedPulse(false), 1200)
  }

  const state = useAsync(
    () =>
      Promise.all([
        fetchAllWardsAqi(),
        fetchGatiMetrics(),
        fetchForecastAccuracySummary(),
      ]),
    [],
    { cacheKey: 'command:main' },
  )
  const forecastPollutant = forecastPollutantFor(pollutant)
  const forecastsState = useAsync(() => fetchAllForecasts(forecastPollutant), [forecastPollutant], {
    cacheKey: `command:forecasts:${forecastPollutant}`,
  })
  const latestReadingsState = useAsync(() => fetchLatestReadingsPreferred(), [], {
    cacheKey: 'command:latest-readings',
  })

  const refreshButton = (
    <button
      type="button"
      onClick={() => {
        state.refresh()
        forecastsState.refresh()
        latestReadingsState.refresh()
      }}
      disabled={state.refreshing}
      // Matches the glass account pill next to it in the header (Sept
      // 2026) — was a flat white-bordered button, a visibly different
      // design language from the translucent GlassSurface header it sits
      // in and the pill beside it.
      className="focus-ring flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-white/60 bg-white/40 px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm backdrop-blur-sm transition hover:bg-white/60 disabled:opacity-50"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${state.refreshing ? 'animate-spin' : ''}`} aria-hidden />
      Refresh
    </button>
  )

  // heroContent removed (Sept 2026, 2nd pass) — the worst-ward gauge used
  // to live in AppShell's header row; per direct request it moved onto the
  // Overview map itself (OverviewChoroplethMap's top-left card, which now
  // shows the worst ward by default and the selected ward once one is
  // picked — one card, two possible contents, instead of a separate
  // always-on header widget). This page no longer passes headerContent to
  // AppShell at all, so it falls back to the default "Vayu Gati" brand text.
  let body: React.ReactNode = null

  if (state.loading || forecastsState.loading) {
    body = (
      <div className="flex min-h-0 flex-1 flex-col gap-2 bg-sky-50 p-3">
        <Skeleton className="min-h-0 flex-1 rounded-xl" />
      </div>
    )
  } else if (state.error) {
    body = (
      <div className="flex min-h-0 flex-1 flex-col gap-2 bg-sky-50 p-3">
        <Card>
          <ErrorState message={state.error} onRetry={() => state.refresh()} />
        </Card>
      </div>
    )
  } else if (state.data) {
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
    // Bug fix (Sept 2026): `wards` now includes every ward (fetchAllWardsAqi()
    // was extended so VayuTrace attribution, which needs no station, is
    // reachable everywhere) — this ranked risk table's whole purpose is
    // "hotspots among monitored wards", so it filters to isMonitored here
    // rather than list ~226 unmonitored wards with nothing to rank.
    const sortedWards = wards.filter((w) => w.isMonitored).sort((a, b) => {
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

    body = (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
        {/* Priority alerts — compact banner, shown only when wards are flagged */}
        {severeAlerts.length > 0 && (
          <div className="shrink-0 max-h-[96px] overflow-hidden border-b border-slate-100 px-3 pt-3">
            <PriorityAlertsPanel
              alerts={severeAlerts}
              windowHours={windowHours}
              selectedWardId={selectedWardId}
              onSelectWard={setSelectedWardId}
            />
          </div>
        )}

        {/* Ward risk table — flush, fills all remaining space edge-to-edge */}
        <div
          ref={riskTableRef}
          className={`min-h-0 flex-1 transition-shadow duration-700 ${
            flaggedPulse ? 'ring-2 ring-inset ring-accent-400' : 'ring-0 ring-transparent'
          }`}
        >
          <HotspotsRiskTable
            wards={displayWards}
            forecasts={forecasts}
            pollutant={pollutant}
            onPollutantChange={setPollutant}
            windowHours={windowHours}
            selectedWardId={selectedWardId}
            onSelectWard={setSelectedWardId}
            latestReadingsByWard={latestReadingsByWard}
            forecastSuppressed={suppressForecast}
            reviewCount={reviewWards.length}
            openReportCount={metrics.openCount}
            coverage={coverageProp}
            latestReadingAgeMinutes={latestReadingAgeMinutes}
            onWardsFlaggedClick={reviewWards.length > 0 ? jumpToRiskTable : undefined}
          />
        </div>
      </div>
    )
  }

  return (
    <AppShell
      subtitle="Overview"
      headerContent={
        // Sept 2026, 2nd pass: the worst-ward gauge (heroContent) moved
        // onto the map itself (OverviewChoroplethMap's top-left card) — see
        // that component's own doc comment. Only Refresh is left here now.
        <div className="flex flex-1 items-center justify-end">
          {refreshButton}
        </div>
      }
    >
      <div className="flex h-full flex-col overflow-hidden">{body}</div>
    </AppShell>
  )
}
