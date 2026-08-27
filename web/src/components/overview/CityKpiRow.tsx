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
}: {
  /** Small status dot colour — signals severity without needing an icon set. */
  tone: string
  label: string
  value: React.ReactNode
  /** Optional second line — smaller, muted. Use for age or explanatory context. */
  sub?: React.ReactNode
  valueColor?: string
  onClick?: () => void
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`group flex w-full items-center gap-2 px-3 py-2.5 text-left transition ${
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
  openIncidents,
  coverage,
  latestReadingAgeMinutes,
  onWardsFlaggedClick,
}: {
  reviewCount: number
  openIncidents: number
  /** null while the accuracy fetch hasn't settled */
  coverage: { fresh: number; total: number } | null
  /** Age of the most recently updated ward reading — used to show a
   *  concrete timestamp alongside the pipeline freshness status. */
  latestReadingAgeMinutes?: number | null
  /** Scrolls the ranked ward table into view — only wired up when there's
   *  actually something flagged to jump to. */
  onWardsFlaggedClick?: () => void
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

  return (
    <div className="overflow-hidden rounded-xl border border-slate-100 bg-white">
      {/* 2×2 on mobile, 4-across on sm+ — dividers replace individual card borders */}
      <div className="grid grid-cols-2 divide-x divide-y divide-slate-100 sm:grid-cols-4 sm:divide-y-0">
        <MetricCard
          tone={!forecastRunFailed && reviewCount > 0 ? 'bg-status-warning' : 'bg-slate-300'}
          label="Wards flagged"
          value={forecastRunFailed ? '—' : reviewCount}
          sub={forecastRunFailed ? 'Forecast required' : undefined}
          valueColor={forecastRunFailed ? 'text-slate-400' : reviewCount > 0 ? 'text-status-warning' : 'text-slate-400'}
          onClick={onWardsFlaggedClick}
        />
        <MetricCard
          tone={openIncidents > 0 ? 'bg-status-warning' : 'bg-slate-300'}
          label="Incidents open"
          value={openIncidents}
          // Neutral dark for 0 — green implies a positive outcome; zero open
          // incidents during AQI 322 may mean no response was initiated yet.
          valueColor={openIncidents > 0 ? 'text-status-warning' : 'text-slate-900'}
          onClick={() => navigate('/incidents')}
        />
        <MetricCard
          tone={forecastRunFailed ? 'bg-status-warning' : coverage ? 'bg-accent-500' : 'bg-slate-300'}
          label={forecastLabel}
          value={forecastValue}
          valueColor={forecastColor}
          onClick={() => navigate('/analytics')}
        />
        <MetricCard
          tone={!healthLoaded ? 'bg-slate-300' : freshnessDegraded ? 'bg-status-warning' : 'bg-status-success'}
          label="Data freshness"
          value={freshnessStatus}
          sub={freshnessSub}
          valueColor={freshnessColor}
          onClick={() => navigate('/sensors')}
        />
      </div>
    </div>
  )
}
