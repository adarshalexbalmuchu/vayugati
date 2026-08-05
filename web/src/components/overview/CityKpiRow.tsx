import { useIngestHealth } from '../../contexts/IngestHealthContext'

function MetricCell({
  label,
  value,
  sub,
  valueColor = 'text-slate-900',
}: {
  label: string
  value: React.ReactNode
  /** Optional second line — smaller, muted. Use for age or explanatory context. */
  sub?: React.ReactNode
  valueColor?: string
}) {
  return (
    <div className="px-4 py-3.5">
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </span>
      <span className={`mt-1.5 block text-2xl font-extrabold tabular-nums leading-none ${valueColor}`}>
        {value}
      </span>
      {sub && (
        <span className="mt-0.5 block text-[11px] leading-none text-slate-400">{sub}</span>
      )}
    </div>
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
}: {
  reviewCount: number
  openIncidents: number
  /** null while the accuracy fetch hasn't settled */
  coverage: { fresh: number; total: number } | null
  /** Age of the most recently updated ward reading — used to show a
   *  concrete timestamp alongside the pipeline freshness status. */
  latestReadingAgeMinutes?: number | null
}) {
  const { readingConfirmedFresh, forecastConfirmedFresh, healthLoaded } = useIngestHealth()

  // When the forecast pipeline is down, forecast-derived metrics cannot be
  // trusted: wardsNeedingReview() returns 0 because the forecast map is empty,
  // not because no wards are at risk. Surface that honestly.
  const forecastRunFailed = healthLoaded && !forecastConfirmedFresh

  // Data freshness: differentiate pipeline status (readingConfirmedFresh) from
  // actual reading age — "Live" implied continuously current data; the pipeline
  // running doesn't mean stations reported in the last minute.
  const age = latestReadingAgeMinutes ?? null
  const freshnessStatus = !healthLoaded
    ? '—'
    : !readingConfirmedFresh
    ? 'Degraded'
    : age != null && age < 60
    ? 'Fresh'
    : age != null && age < 180
    ? 'Delayed'
    : 'Live'  // pipeline ok but reading age unknown
  const freshnessColor = !healthLoaded
    ? 'text-slate-400'
    : !readingConfirmedFresh
    ? 'text-status-warning'
    : age != null && age >= 60
    ? 'text-status-warning'
    : 'text-status-success'
  const freshnessSub = readingConfirmedFresh && age != null ? formatAge(age) : undefined

  // Forecast coverage: show operational status when run failed rather than
  // the configured-count (93/93) that contradicts the "unavailable" banner.
  const forecastLabel = forecastRunFailed ? 'Forecast run' : 'Forecast'
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
      {/* Single brand accent rule spanning the full panel — not per-metric */}
      <div className="h-0.5 bg-ink-700" aria-hidden />
      {/* 2×2 on mobile, 4-across on sm+ — dividers replace individual card borders */}
      <div className="grid grid-cols-2 divide-x divide-y divide-slate-100 sm:grid-cols-4 sm:divide-y-0">
        <MetricCell
          label="Wards flagged"
          value={forecastRunFailed ? '—' : reviewCount}
          sub={forecastRunFailed ? 'Forecast required' : undefined}
          valueColor={forecastRunFailed ? 'text-slate-400' : reviewCount > 0 ? 'text-status-warning' : 'text-slate-400'}
        />
        <MetricCell
          label="Incidents open"
          value={openIncidents}
          // Neutral dark for 0 — green implies a positive outcome; zero open
          // incidents during AQI 322 may mean no response was initiated yet.
          valueColor={openIncidents > 0 ? 'text-status-warning' : 'text-slate-900'}
        />
        <MetricCell
          label={forecastLabel}
          value={forecastValue}
          valueColor={forecastColor}
        />
        <MetricCell
          label="Data freshness"
          value={freshnessStatus}
          sub={freshnessSub}
          valueColor={freshnessColor}
        />
      </div>
    </div>
  )
}
