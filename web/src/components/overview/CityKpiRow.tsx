import { useIngestHealth } from '../../contexts/IngestHealthContext'

function MetricCell({
  label,
  value,
  valueColor = 'text-slate-900',
}: {
  label: string
  value: React.ReactNode
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
    </div>
  )
}

export default function CityKpiRow({
  reviewCount,
  openIncidents,
  coverage,
}: {
  reviewCount: number
  openIncidents: number
  /** null while the accuracy fetch hasn't settled */
  coverage: { fresh: number; total: number } | null
}) {
  const { readingConfirmedFresh, forecastConfirmedFresh, healthLoaded } = useIngestHealth()

  const freshnessValue = !healthLoaded ? '—' : readingConfirmedFresh ? 'Live' : 'Degraded'
  const freshnessColor = !healthLoaded
    ? 'text-slate-400'
    : readingConfirmedFresh
    ? 'text-status-success'
    : 'text-status-warning'

  // When the health endpoint confirms the forecast pipeline is down, surface
  // the operational failure rather than the configured-coverage count — that
  // count (93/93) would contradict the "Forecast unavailable" banner above.
  const forecastRunFailed = healthLoaded && !forecastConfirmedFresh
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
          value={reviewCount}
          valueColor={reviewCount > 0 ? 'text-status-warning' : 'text-slate-400'}
        />
        <MetricCell
          label="Incidents open"
          value={openIncidents}
          valueColor={openIncidents === 0 ? 'text-status-success' : 'text-status-warning'}
        />
        <MetricCell
          label={forecastLabel}
          value={forecastValue}
          valueColor={forecastColor}
        />
        <MetricCell
          label="Data freshness"
          value={freshnessValue}
          valueColor={freshnessColor}
        />
      </div>
    </div>
  )
}
