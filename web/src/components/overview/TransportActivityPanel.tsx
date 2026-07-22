import { Bus } from 'lucide-react'
import type { TransportActivitySummary } from '../../lib/data'
import { Card, CardHeader, Stat } from '../ui'

/**
 * Public transport activity context - a signal, never proof. Never labelled
 * or implied as pollution evidence, congestion, or vehicular-emission
 * attribution - see docs/data/delhi-otd-transport-context-integration-report.md.
 * `summary` is null when the ingest service itself couldn't be reached at
 * all (distinct from a reachable-but-empty summary, which still renders
 * with its own `unavailableReason`).
 */
export default function TransportActivityPanel({ summary }: { summary: TransportActivitySummary | null }) {
  const unavailableReason = summary?.unavailableReason ?? (summary ? null : 'Transit service unreachable')

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
        {unavailableReason ? (
          <p className="text-sm text-slate-400">Transport activity data unavailable right now.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Stat value={summary!.liveBusesTracked ?? '—'} label="Live buses tracked" />
            <Stat value={summary!.activeRoutes ?? '—'} label="Active routes" />
          </div>
        )}
        <p className="text-xs text-slate-500">Context layer only — not proof of emissions or congestion.</p>
      </div>
    </Card>
  )
}
