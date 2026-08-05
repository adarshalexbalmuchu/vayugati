import { useIngestHealth } from '../../contexts/IngestHealthContext'

function KpiCard({
  label,
  value,
  valueColor = 'text-slate-900',
}: {
  label: string
  value: React.ReactNode
  valueColor?: string
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      {/* Brown brand accent stripe at the top of each card */}
      <div className="h-0.5 bg-ink-700" aria-hidden />
      <div className="flex flex-col gap-1.5 px-4 py-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          {label}
        </span>
        <span className={`text-2xl font-extrabold tabular-nums leading-none ${valueColor}`}>
          {value}
        </span>
      </div>
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
  /** null while the accuracy fetch hasn't settled yet */
  coverage: { fresh: number; total: number } | null
}) {
  const { readingConfirmedFresh, healthLoaded } = useIngestHealth()

  const freshnessValue = !healthLoaded ? '—' : readingConfirmedFresh ? 'Live' : 'Degraded'
  const freshnessColor = !healthLoaded
    ? 'text-slate-400'
    : readingConfirmedFresh
    ? 'text-status-success'
    : 'text-status-warning'

  return (
    <div className="grid grid-cols-2 gap-3">
      <KpiCard
        label="Wards flagged"
        value={reviewCount}
        valueColor={reviewCount > 0 ? 'text-status-warning' : 'text-slate-400'}
      />
      <KpiCard
        label="Incidents open"
        value={openIncidents}
        valueColor={openIncidents === 0 ? 'text-status-success' : 'text-status-warning'}
      />
      <KpiCard
        label="Forecast coverage"
        value={coverage ? `${coverage.fresh}/${coverage.total}` : '—'}
        valueColor={coverage ? 'text-slate-900' : 'text-slate-400'}
      />
      <KpiCard
        label="Data freshness"
        value={freshnessValue}
        valueColor={freshnessColor}
      />
    </div>
  )
}
