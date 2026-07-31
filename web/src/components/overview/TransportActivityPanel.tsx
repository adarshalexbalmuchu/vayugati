import { Bus } from 'lucide-react'
import type { TransportActivitySummary } from '../../lib/data'
import { Card, CardHeader, Stat } from '../ui'

export interface HighRiskTransitHotspot {
  wardName: string
  vehicleCount: number
}

/**
 * Public transport activity context - a signal, never proof. Never labelled
 * or implied as pollution evidence, congestion, or vehicular-emission
 * attribution - see docs/data/delhi-otd-transport-context-integration-report.md.
 * `summary` is null when the ingest service itself couldn't be reached at
 * all (distinct from a reachable-but-empty summary, which still renders
 * with its own `unavailableReason`).
 *
 * The unavailable state is commonly just a startup race (the ingest
 * service's first scheduled refresh hasn't landed yet - see docs/data/
 * final-overview-source-aware-ui-fix-report.md), not a real failure - a
 * direct Retry action here recovers from that without needing to know the
 * page-level Refresh button now also re-fetches this.
 */
export default function TransportActivityPanel({
  summary,
  highRiskHotspots,
}: {
  summary: TransportActivitySummary | null
  /** Wards that are both currently high-risk (severe/trending up) AND have
   *  real nearby transit activity right now - a cross-reference of two
   *  already-fetched summaries, computed by the caller. Undefined while
   *  either summary hasn't loaded yet; empty array once both have loaded
   *  and nothing qualifies. */
  highRiskHotspots?: HighRiskTransitHotspot[]
}) {
  const unavailableReason = summary?.unavailableReason ?? (summary ? null : 'Transit service unreachable')

  if (unavailableReason) {
    return (
      <Card className="flex min-h-0 flex-col overflow-hidden">
        <CardHeader
          title={
            <span className="flex items-center gap-1.5">
              <Bus className="h-4 w-4 text-slate-300" aria-hidden />
              Transport Activity Context
            </span>
          }
          subtitle="Public transport activity via Delhi Open Transit Data."
        />
        <div className="px-4 py-3.5 space-y-1.5">
          <p className="text-xs text-slate-400">Real-time bus data unavailable right now.</p>
          <p className="text-xs text-slate-400">Context layer only — not proof of emissions or congestion.</p>
        </div>
      </Card>
    )
  }

  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <Bus className="h-4 w-4 text-accent-600" aria-hidden />
            Transport Activity Context
          </span>
        }
        subtitle="Public transport activity via Delhi Open Transit Data."
      />
      <div className="space-y-2.5 px-4 py-3.5">
        <div className="grid grid-cols-2 gap-2">
          <Stat value={summary!.liveBusesTracked ?? '—'} label="Live buses tracked" />
          <Stat value={summary!.activeRoutes ?? '—'} label="Active routes" />
        </div>
        {highRiskHotspots && highRiskHotspots.length > 0 && (
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              High-risk hotspots with transit activity
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {highRiskHotspots.map((h) => (
                <li
                  key={h.wardName}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600"
                >
                  {h.wardName}
                  <span className="font-semibold text-slate-800">{h.vehicleCount}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-slate-500">Context layer only — not proof of emissions or congestion.</p>
      </div>
    </Card>
  )
}
