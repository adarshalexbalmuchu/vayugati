import { useState } from 'react'
import { Card, CardHeader, EmptyState, ErrorState, Skeleton } from './ui'
import { useAuth } from '../lib/auth'
import {
  TASK_DISPATCH_STATUS_LABEL,
  slaCountdownLabel,
  type TaskDispatchStatus,
} from '../lib/incidentRules'
import {
  listMyTaskDispatches,
  reportTaskResourceUnavailable,
  requestTaskReroute,
  type TaskDispatchRow,
} from '../lib/incidents'
import { runOrQueueTransitionTaskDispatch } from '../lib/offlineSync'
import { useAsync } from '../lib/useAsync'

/**
 * Field task lifecycle (Phase 9, plan §11) — receive assigned tasks,
 * acknowledge, accept or reject with reason, start work (arrival is folded
 * into "start work" — see the migration's own note on why there's no
 * separate arrival status), complete, report resource unavailability,
 * request a reroute. Deliberately mobile-friendly and minimal: no map, no
 * checklist here (that stays in InterventionCompletionForm, which still owns
 * the actual evidence/outcome capture) — this card is purely the DISPATCH
 * lifecycle wrapper around it.
 *
 * The lifecycle rules themselves (which transitions are legal, which need a
 * reason) live in transition_task_dispatch (SQL); this component just calls
 * it and shows the server's own state back.
 */

const NEXT_ACTION: Partial<Record<TaskDispatchStatus, { to: TaskDispatchStatus; label: string; needsReason?: boolean }>> = {
  sent: { to: 'acknowledged', label: 'Acknowledge' },
  acknowledged: { to: 'accepted', label: 'Accept' },
  accepted: { to: 'in_progress', label: 'Start work (mark arrival)' },
  in_progress: { to: 'completed', label: 'Mark completed' },
}

function DispatchCard({ d, onDone }: { d: TaskDispatchRow; onDone: () => void }) {
  const { session } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!session) return null

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onDone()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Action failed.')
    } finally {
      setBusy(false)
    }
  }

  const next = NEXT_ACTION[d.status]

  const handleAdvance = () => {
    if (!next) return
    void act(async () => {
      await runOrQueueTransitionTaskDispatch(
        { dispatchId: d.id, newStatus: next.to, actorId: session.user.id },
        `${next.label} - ${d.physical_location ?? d.asset_description ?? `Task #${d.id}`}`,
      )
    })
  }

  const handleReject = () => {
    const reason = window.prompt('Why are you rejecting this task?')
    if (!reason?.trim()) return
    void act(async () => {
      await runOrQueueTransitionTaskDispatch(
        { dispatchId: d.id, newStatus: 'rejected', actorId: session.user.id, reason: reason.trim() },
        `Reject - ${d.physical_location ?? d.asset_description ?? `Task #${d.id}`}`,
      )
    })
  }

  const handleUnavailable = () => {
    const note = window.prompt('What resource is unavailable? (vehicle, equipment, personnel…)')
    if (!note?.trim()) return
    void act(() => reportTaskResourceUnavailable(d.id, session.user.id, note.trim()))
  }

  const handleReroute = () => {
    const reason = window.prompt('Why should this task be reassigned?')
    if (!reason?.trim()) return
    void act(() => requestTaskReroute(d.id, session.user.id, reason.trim()))
  }

  const canReject = d.status === 'sent' || d.status === 'acknowledged'
  const canReport = d.status !== 'completed' && d.status !== 'verification_pending'

  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-ink-600">
          {TASK_DISPATCH_STATUS_LABEL[d.status]}
        </span>
        {d.status !== 'completed' && d.status !== 'verification_pending' && (
          <span className="text-xs text-ink-400">
            {slaCountdownLabel(d.sla_ack_due_at ?? d.sla_accept_due_at ?? d.sla_arrival_due_at ?? d.sla_completion_due_at)}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm font-medium text-ink-800">{d.physical_location ?? d.asset_description ?? 'Assigned task'}</p>
      {d.responsible_agency && <p className="mt-0.5 text-xs text-ink-400">{d.responsible_agency}</p>}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {next && (
          <button
            type="button"
            disabled={busy}
            onClick={handleAdvance}
            className="focus-ring rounded-lg bg-brand-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
          >
            {next.label}
          </button>
        )}
        {canReject && (
          <button
            type="button"
            disabled={busy}
            onClick={handleReject}
            className="focus-ring rounded-lg border border-status-critical/30 px-2.5 py-1 text-[11px] font-semibold text-status-critical hover:bg-status-critical/10 disabled:opacity-50"
          >
            Reject
          </button>
        )}
        {canReport && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={handleUnavailable}
              className="focus-ring rounded-lg border border-ink-200 px-2.5 py-1 text-[11px] font-semibold text-ink-700 hover:bg-ink-50 disabled:opacity-50"
            >
              Report resource unavailable
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleReroute}
              className="focus-ring rounded-lg border border-ink-200 px-2.5 py-1 text-[11px] font-semibold text-ink-700 hover:bg-ink-50 disabled:opacity-50"
            >
              Request reroute
            </button>
          </>
        )}
      </div>
      {d.status === 'completed' && (
        <p className="mt-1.5 text-[11px] text-ink-500">
          Marked complete - use the intervention card below to attach evidence and record the outcome.
        </p>
      )}
      {error && <p className="mt-1.5 text-[11px] text-status-critical">{error}</p>}
    </li>
  )
}

export default function FieldTaskDispatchCard() {
  const { session } = useAuth()
  const state = useAsync(() => (session ? listMyTaskDispatches() : Promise.resolve([])), [session?.user.id], {
    enabled: !!session,
  })
  const dispatches = state.data ?? []

  if (!state.loading && !state.error && dispatches.length === 0) return null

  return (
    <Card>
      <CardHeader
        title="My dispatched tasks"
        subtitle="Acknowledge, accept, and work assigned interventions"
        right={<span className="rounded-lg bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600">{dispatches.length}</span>}
      />
      {state.loading ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={() => state.refresh()} />
      ) : dispatches.length === 0 ? (
        <EmptyState icon="✅">No dispatched tasks waiting on you.</EmptyState>
      ) : (
        <ul className="divide-y divide-ink-900/5">
          {dispatches.map((d) => (
            <DispatchCard key={d.id} d={d} onDone={() => state.refresh()} />
          ))}
        </ul>
      )}
    </Card>
  )
}
