import { useEffect, useState } from 'react'
import { CheckCircle2, RefreshCw, ShieldCheck } from 'lucide-react'
import { ErrorState, Skeleton, StaleBadge } from '../ui'
import { QUEUE_LABELS, type QueueKey, ESCALATION_SLA_HOURS } from '../../lib/incidentRules'
import type { Incident } from '../../lib/incidents'
import BulkEvidenceMissionDialog from './BulkEvidenceMissionDialog'
import EmptyIncidentState from './EmptyIncidentState'
import IncidentListItem from './IncidentListItem'

export interface IncidentListPagination {
  totalCount: number
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
}

/** The list column - queue header (label/count/stale badge/refresh), the cap
 *  banner, the scrollable row list, load-more (paginated queues only), and
 *  the "refresh failed, showing last data" footer. Extracted from
 *  IncidentsView.tsx's own JSX, restyled - same data, same states.
 *
 *  Also owns bulk-selection state for the "request evidence" action: this
 *  is the actual bottleneck the queue's own numbers point at (most open
 *  incidents are stuck needing the same single action), and it's list-local
 *  UI state that has no reason to live any higher up. */
export default function IncidentList({
  queue,
  onQueueChange,
  visibleRows,
  detailId,
  onSelectIncident,
  wardAqiById,
  loading,
  error,
  onRefresh,
  refreshing,
  stale,
  capHit,
  pagination,
  showStaleFooter,
  recurrenceCount,
}: {
  queue: QueueKey
  /** Switches the underlying queue — used by the Recurrence filter chip
   *  below, which isn't a sidebar tab of its own (see
   *  IncidentQueueSidebar.tsx) but still just flips the same `queue` state. */
  onQueueChange: (q: QueueKey) => void
  recurrenceCount: number
  visibleRows: Incident[]
  detailId: number | null
  onSelectIncident: (id: number) => void
  wardAqiById: Map<number, number | null>
  loading: boolean
  error: string | null
  onRefresh: () => void
  refreshing: boolean
  stale: boolean
  capHit: boolean
  pagination: IncidentListPagination | null
  showStaleFooter: boolean
}) {
  // Recurrence is a filter on the Closed queue, offered as a chip only
  // while viewing it — it has no sidebar slot of its own (unlike Predicted,
  // it's only ever relevant once already looking at Closed incidents).
  const showRecurrenceChip = queue === 'closed' || queue === 'recurrence'

  // Only a 'suspected' incident is eligible for the bulk evidence-request
  // action - a checkbox on anything else would just be checkable UI that
  // does nothing on submit.
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false)
  useEffect(() => setCheckedIds(new Set()), [queue])

  const checkedIncidents = visibleRows.filter((i) => checkedIds.has(i.id))
  const toggleChecked = (id: number) =>
    setCheckedIds((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{QUEUE_LABELS[queue]}</h2>
        <span className="rounded bg-slate-100 px-1.5 text-[10px] font-bold text-slate-600">
          {pagination ? `${visibleRows.length} of ${pagination.totalCount}` : visibleRows.length}
        </span>
        {stale && <StaleBadge />}
        <button
          type="button"
          onClick={onRefresh}
          className="focus-ring ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold text-accent-700 hover:bg-slate-50"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
          Refresh
        </button>
      </div>

      {showRecurrenceChip && (
        <div className="flex items-center gap-1.5 border-b border-slate-100 px-3 py-1.5">
          <button
            type="button"
            onClick={() => onQueueChange(queue === 'recurrence' ? 'closed' : 'recurrence')}
            aria-pressed={queue === 'recurrence'}
            className={`focus-ring rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
              queue === 'recurrence' ? 'bg-accent-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            With recurrence reports ({recurrenceCount})
          </button>
        </div>
      )}

      {capHit && (
        <p className="border-b border-status-warning/30 bg-status-warning/10 px-3 py-1.5 text-[11px] text-slate-700">
          Showing the highest-priority open incidents only — more may exist.
        </p>
      )}

      {checkedIncidents.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-b border-accent-200 bg-accent-50 px-3 py-1.5">
          <p className="text-xs font-semibold text-accent-800">{checkedIncidents.length} selected</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCheckedIds(new Set())}
              className="focus-ring text-[11px] font-semibold text-accent-700 hover:text-accent-900"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setBulkDialogOpen(true)}
              className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-accent-700"
            >
              <ShieldCheck className="h-3 w-3" strokeWidth={2} aria-hidden />
              Request evidence
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-2 p-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : error ? (
          <ErrorState message={error} onRetry={onRefresh} />
        ) : visibleRows.length === 0 ? (
          <EmptyIncidentState icon={CheckCircle2}>
            {queue === 'escalated'
              ? `No incident has been open longer than ${ESCALATION_SLA_HOURS}h without action.`
              : queue === 'predicted'
                ? 'No incidents are currently trending toward a threshold crossing. The automated detection engine re-evaluates every monitoring station on each ingest cycle.'
                : `Nothing in ${QUEUE_LABELS[queue].toLowerCase()}.`}
          </EmptyIncidentState>
        ) : (
          <>
            <ul>
              {visibleRows.map((i) => (
                <IncidentListItem
                  key={i.id}
                  incident={i}
                  wardAqi={i.ward_id != null ? (wardAqiById.get(i.ward_id) ?? null) : null}
                  selected={i.id === detailId}
                  onSelect={() => onSelectIncident(i.id)}
                  checked={i.source_confidence === 'suspected' ? checkedIds.has(i.id) : undefined}
                  onToggleCheck={i.source_confidence === 'suspected' ? () => toggleChecked(i.id) : undefined}
                />
              ))}
            </ul>
            {pagination?.hasMore && (
              <div className="p-2">
                <button
                  type="button"
                  disabled={pagination.loadingMore}
                  onClick={pagination.onLoadMore}
                  className="focus-ring w-full rounded-lg border border-slate-200 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  {pagination.loadingMore
                    ? 'Loading…'
                    : `Load more (${pagination.totalCount - visibleRows.length} remaining)`}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {showStaleFooter && (
        <p className="border-t border-slate-100 bg-status-warning/10 px-3 py-1.5 text-[11px] text-slate-600">
          Showing the last data loaded - refresh failed.
        </p>
      )}

      {bulkDialogOpen && (
        <BulkEvidenceMissionDialog
          incidents={checkedIncidents}
          onClose={() => setBulkDialogOpen(false)}
          onCreated={() => {
            setCheckedIds(new Set())
            onRefresh()
          }}
        />
      )}
    </>
  )
}
