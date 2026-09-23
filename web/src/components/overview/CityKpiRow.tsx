import { ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useIngestHealth } from '../../contexts/IngestHealthContext'

function MetricCard({
  tone,
  label,
  value,
  sub,
  valueColor = 'text-slate-900',
  onClick,
  compact = false,
}: {
  /** Small status dot colour — signals severity without needing an icon set. */
  tone: string
  label: string
  value: React.ReactNode
  /** Optional second line — smaller, muted. Use for age or explanatory context. */
  sub?: React.ReactNode
  valueColor?: string
  onClick?: () => void
  /** Single-line "label value" variant for the merged header row — no room
   *  for the stacked label/value/sub block there. Drops `sub` entirely. */
  compact?: boolean
}) {
  const Comp = onClick ? 'button' : 'div'

  if (compact) {
    // Deliberately calmer than the full card: no status dot (redundant with
    // the coloured value right next to it — two signals for one fact), label
    // always neutral slate so only the value itself carries colour, and a
    // normal-weight value so a healthy/quiet state doesn't read as loud as a
    // degraded one. Colour is still the only thing that changes between
    // states — nothing here gets *more* decorated when something's wrong,
    // it just goes from slate to amber/red.
    return (
      <Comp
        type={onClick ? 'button' : undefined}
        onClick={onClick}
        title={label}
        className={`flex h-full flex-shrink-0 items-baseline gap-1.5 whitespace-nowrap px-3 text-xs transition ${
          onClick ? 'focus-ring cursor-pointer hover:bg-slate-50' : ''
        }`}
      >
        <span className="text-slate-400">{label}</span>
        <span className={`font-semibold tabular-nums ${valueColor}`}>{value}</span>
      </Comp>
    )
  }

  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`group flex h-full w-full items-center gap-2 px-3 py-2.5 text-left transition ${
        onClick ? 'focus-ring cursor-pointer hover:bg-slate-50' : ''
      }`}
    >
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${tone}`} aria-hidden />
      <span className="min-w-0">
        <span className="block text-[9px] font-semibold uppercase tracking-wider text-slate-500">
          {label}
        </span>
        <span className={`mt-0.5 block text-lg font-extrabold tabular-nums leading-none ${valueColor}`}>
          {value}
        </span>
        {sub && (
          <span className="mt-0.5 block truncate text-[10px] leading-none text-slate-400">{sub}</span>
        )}
      </span>
      {onClick && (
        <ChevronRight
          className="ml-1 h-3.5 w-3.5 flex-shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-accent-500"
          aria-hidden
        />
      )}
    </Comp>
  )
}

function formatAge(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

export default function CityKpiRow({
  reviewCount,
  openReportCount,
  coverage,
  latestReadingAgeMinutes,
  onWardsFlaggedClick,
  compact = false,
}: {
  reviewCount: number
  openReportCount: number
  /** null while the accuracy fetch hasn't settled */
  coverage: { fresh: number; total: number } | null
  /** Age of the most recently updated ward reading — used to show a
   *  concrete timestamp alongside the pipeline freshness status. */
  latestReadingAgeMinutes?: number | null
  /** Scrolls the ranked ward table into view — only wired up when there's
   *  actually something flagged to jump to. */
  onWardsFlaggedClick?: () => void
  /** Single-line "label value" cells for the merged header row — see
   *  MetricCard's own compact variant. */
  compact?: boolean
}) {
  const { readingConfirmedFresh, forecastConfirmedFresh, healthLoaded, health } = useIngestHealth()
  const navigate = useNavigate()

  // When the forecast pipeline is down, forecast-derived metrics cannot be
  // trusted: wardsNeedingReview() returns 0 because the forecast map is empty,
  // not because no wards are at risk. Surface that honestly.
  const forecastRunFailed = healthLoaded && !forecastConfirmedFresh

  // Data freshness: differentiate pipeline status (readingConfirmedFresh) from
  // actual reading age — "Live" implied continuously current data; the pipeline
  // running doesn't mean stations reported in the last minute.
  // Prefer the health endpoint's age (reads from the readings table directly) over
  // the wards.ts-based age, which only updates when compute_ward_aqi() runs and
  // can show "Delayed" even when fresh CPCB readings are flowing.
  const healthAge = health?.checks.reading_freshness.latest_reading_age_minutes ?? null
  const age = healthAge ?? latestReadingAgeMinutes ?? null
  const freshnessStatus = !healthLoaded
    ? '—'
    : !readingConfirmedFresh
    ? 'Degraded'
    : age != null && age < 60
    ? 'Fresh'
    : age != null && age < 180
    ? 'Delayed'
    : 'Live'  // pipeline ok but reading age unknown
  const freshnessDegraded = healthLoaded && (!readingConfirmedFresh || (age != null && age >= 60))
  const freshnessColor = !healthLoaded
    ? 'text-slate-400'
    : freshnessDegraded
    ? 'text-status-warning'
    : 'text-status-success'
  const freshnessSub = readingConfirmedFresh && age != null ? formatAge(age) : undefined

  // Forecast coverage: show operational status when run failed rather than
  // the configured-count (93/93) that contradicts the "unavailable" banner.
  const forecastLabel = forecastRunFailed ? 'Forecast run' : 'Wards forecast'
  const forecastValue = forecastRunFailed
    ? 'Failed'
    : coverage
    ? `${coverage.fresh}/${coverage.total}`
    : '—'
  const forecastColor = forecastRunFailed
    ? 'text-status-warning'
    : coverage
    ? 'text-slate-900'
    : 'text-slate-400'

  // No wrapper here — CommandView places these as siblings of the spotlight
  // cell inside one shared grid, so every cell (spotlight + 4 KPIs) shares
  // the same border, divider, and row height instead of living in two
  // differently-sized cards.
  return (
    <>
      <MetricCard
        tone={!forecastRunFailed && reviewCount > 0 ? 'bg-status-warning' : 'bg-slate-300'}
        label="Wards flagged"
        value={forecastRunFailed ? '—' : reviewCount}
        sub={forecastRunFailed ? 'Forecast required' : undefined}
        valueColor={forecastRunFailed ? 'text-slate-400' : reviewCount > 0 ? 'text-status-warning' : 'text-slate-400'}
        onClick={onWardsFlaggedClick}
        compact={compact}
      />
      <MetricCard
        tone={openReportCount > 0 ? 'bg-status-warning' : 'bg-slate-300'}
        // Was mislabeled "Incidents open" (Sept 2026 fix) — this value is
        // fetchGatiMetrics().openCount, computed from the `reports` table
        // (citizen submissions), not the separate `incidents` table
        // /incidents shows. Three-way mismatch found during a Map-page
        // review: the label implied `incidents`, the number was `reports`,
        // and the click-through went to /incidents anyway — a viewer
        // clicking this card landed on a page showing a different count
        // than the one they just clicked. Relabeled to say what it actually
        // counts, and the click-through now goes to /citizens (CitizensView,
        // the real reports-table page) instead.
        label="Reports open"
        value={openReportCount}
        // Neutral dark for 0 — green implies a positive outcome; zero open
        // reports during AQI 322 may mean no response was initiated yet.
        valueColor={openReportCount > 0 ? 'text-status-warning' : 'text-slate-900'}
        onClick={() => navigate('/citizens')}
        compact={compact}
      />
      <MetricCard
        tone={forecastRunFailed ? 'bg-status-warning' : coverage ? 'bg-accent-500' : 'bg-slate-300'}
        label={forecastLabel}
        value={forecastValue}
        valueColor={forecastColor}
        onClick={() => navigate('/analytics')}
        compact={compact}
      />
      <MetricCard
        tone={!healthLoaded ? 'bg-slate-300' : freshnessDegraded ? 'bg-status-warning' : 'bg-status-success'}
        label="Data freshness"
        value={freshnessStatus}
        sub={freshnessSub}
        valueColor={freshnessColor}
        onClick={() => navigate('/sensors')}
        compact={compact}
      />
    </>
  )
}
