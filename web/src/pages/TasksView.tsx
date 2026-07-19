import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { Card, CardHeader, EmptyState, ErrorState, Skeleton } from '../components/ui'
import { listActiveTaskDispatches, type ActiveTaskDispatch } from '../lib/incidents'
import { TASK_DISPATCH_STATUS_LABEL, slaCountdownLabel } from '../lib/incidentRules'

/**
 * Tasks — every active task_dispatches row city-wide (one of the 5 commander
 * nav items that were previously permanently disabled "coming soon"
 * placeholders). Distinct from /missions, which is a field officer's own
 * personal queue: same underlying table, but no ward/officer scoping and a
 * read-only row (no Acknowledge/Accept/Complete buttons - those mutations
 * stay officer-facing, matching task_dispatches' own write-policy discipline).
 *
 * Paginated (100/page): status/ward filters are built from currently-loaded
 * rows only - a status/ward that only exists on a later page won't yet
 * appear as a filter option (see listActiveTaskDispatches' own comment).
 */

const ALL = '__all__'
const PAGE_SIZE = 100

// Same "first populated checkpoint column" convention already used by
// FieldTaskDispatchCard.tsx / TaskDispatchPanel.tsx - the DB only ever
// populates the currently-relevant sla_*_due_at column.
function nextDueAt(d: ActiveTaskDispatch): string | null {
  return d.sla_ack_due_at ?? d.sla_accept_due_at ?? d.sla_arrival_due_at ?? d.sla_completion_due_at
}

function DispatchRow({ d }: { d: ActiveTaskDispatch }) {
  return (
    <li className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <Link
          to={d.incident_id != null ? `/incidents?incident=${d.incident_id}` : '/incidents'}
          className="focus-ring text-sm font-medium text-slate-800 hover:text-accent-700 hover:underline"
        >
          {d.incident_summary ?? `Incident #${d.incident_id}`}
        </Link>
        <p className="mt-0.5 truncate text-xs text-slate-400">
          {d.ward_name ?? 'No ward'} · {d.responsible_agency ?? 'Unrouted'}
        </p>
      </div>
      <div className="flex-shrink-0 text-right">
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-600">
          {TASK_DISPATCH_STATUS_LABEL[d.status]}
        </span>
        <p className="mt-1 text-xs text-slate-400">{slaCountdownLabel(nextDueAt(d))}</p>
      </div>
    </li>
  )
}

export default function TasksView() {
  const [rows, setRows] = useState<ActiveTaskDispatch[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState(ALL)
  const [wardFilter, setWardFilter] = useState(ALL)

  const loadPage = useCallback(
    async (reset: boolean) => {
      setLoading(true)
      setError(null)
      try {
        const offset = reset ? 0 : rows.length
        const page = await listActiveTaskDispatches({ offset, pageSize: PAGE_SIZE })
        setRows((prev) => (reset ? page.rows : [...prev, ...page.rows]))
        setTotalCount(page.totalCount)
        setHasMore(page.hasMore)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load active dispatches')
      } finally {
        setLoading(false)
      }
    },
    [rows.length],
  )

  // Load once on mount only - loadPage itself is intentionally excluded from
  // these deps (it's recreated every time rows.length changes, for "load
  // more" to see fresh state; re-running this effect on that change would
  // refetch from scratch on every page load).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    loadPage(true)
  }, [])

  const statuses = useMemo(() => [...new Set(rows.map((r) => r.status))].sort(), [rows])
  const wards = useMemo(
    () => [...new Set(rows.map((r) => r.ward_name).filter((w): w is string => w != null))].sort(),
    [rows],
  )

  const filtered = rows.filter(
    (r) => (statusFilter === ALL || r.status === statusFilter) && (wardFilter === ALL || r.ward_name === wardFilter),
  )

  return (
    <AppShell subtitle="Tasks">
      <div className="mx-auto w-full max-w-3xl flex-1 space-y-3 overflow-y-auto bg-slate-50 p-3 sm:p-4">
        <Card>
          <CardHeader
            title="Tasks"
            subtitle={`${filtered.length} of ${totalCount} active dispatch(es) shown`}
            right={
              <button
                type="button"
                onClick={() => loadPage(true)}
                className="focus-ring rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Refresh
              </button>
            }
          />
          <div className="flex flex-wrap gap-2 border-b border-slate-100 px-4 py-2.5">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="focus-ring rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700"
            >
              <option value={ALL}>All statuses</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {TASK_DISPATCH_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <select
              value={wardFilter}
              onChange={(e) => setWardFilter(e.target.value)}
              className="focus-ring rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700"
            >
              <option value={ALL}>All wards</option>
              {wards.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </div>
          {loading && rows.length === 0 ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : error ? (
            <ErrorState message={error} onRetry={() => loadPage(true)} />
          ) : filtered.length === 0 ? (
            <EmptyState icon="☑">No active dispatches match this filter.</EmptyState>
          ) : (
            <>
              <ul className="divide-y divide-slate-100">
                {filtered.map((d) => (
                  <DispatchRow key={d.id} d={d} />
                ))}
              </ul>
              {hasMore && (
                <div className="p-3">
                  <button
                    type="button"
                    onClick={() => loadPage(false)}
                    disabled={loading}
                    className="focus-ring w-full rounded-lg border border-slate-200 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {loading ? 'Loading…' : `Load more (${totalCount - rows.length} remaining)`}
                  </button>
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </AppShell>
  )
}
