import { useIngestHealth } from '../../contexts/IngestHealthContext'

function KpiCard({
  label,
  value,
  valueColor = 'text-white',
}: {
  label: string
  value: React.ReactNode
  valueColor?: string
}) {
  return (
    <div className="flex flex-1 flex-col gap-1.5 rounded-xl bg-slate-900 px-4 py-3.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </span>
      <span className={`text-2xl font-extrabold tabular-nums leading-none ${valueColor}`}>
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
  /** null while the accuracy fetch hasn't settled yet */
  coverage: { fresh: number; total: number } | null
}) {
  const { readingConfirmedFresh, healthLoaded } = useIngestHealth()

  const freshnessValue = !healthLoaded
    ? '—'
    : readingConfirmedFresh
    ? 'Live'
    : 'Degraded'
  const freshnessColor = !healthLoaded
    ? 'text-slate-500'
    : readingConfirmedFresh
    ? 'text-status-success'
    : 'text-status-warning'

  return (
    <div className="flex gap-3">
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
        valueColor={coverage ? 'text-white' : 'text-slate-500'}
      />
      <KpiCard
        label="Data freshness"
        value={freshnessValue}
        valueColor={freshnessColor}
      />
    </div>
  )
}
