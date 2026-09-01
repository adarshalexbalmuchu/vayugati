import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock3, ClipboardList, HourglassIcon, MapPin, RefreshCw, Timer } from 'lucide-react'
import AppShell from '../components/AppShell'
import { ErrorState, Skeleton, StaleBadge } from '../components/ui'
import KpiStrip, { type KpiItem } from '../components/overview/KpiStrip'
import DispatchTable from '../components/tasks/DispatchTable'
import TaskDetailPanel from '../components/tasks/TaskDetailPanel'
import TaskFilterBar, { ALL, type TaskFilters } from '../components/tasks/TaskFilterBar'
import { minutesUntil, type TaskDispatchStatus } from '../lib/incidentRules'
import { listActiveTaskDispatches, listLeadingSourceCategories, listTaskDispatchesForAnalytics } from '../lib/incidents'
import { nextDueAt } from '../lib/overviewRules'
import { useAsync } from '../lib/useAsync'

/**
 * Tasks / Dispatch — the field-dispatch execution console (Phase redesign,
 * matching the Overview/Incidents/Map visual language). Every row is a real
 * task_dispatches row; every KPI is derived from real columns already on
 * that table or its incidents/actions join - nothing here is invented.
 *
 * Two real fetches: the full active set (everything actionable right now -
 * matches this page's own first question, "what's active") and a 30-day
 * window of every dispatch regardless of status (for KPI context only -
 * completed-today, awaiting-evidence, and average-time-to-close all need
 * completed/verification_pending rows the active set deliberately excludes).
 */

const DEFAULT_FILTERS: TaskFilters = { status: ALL, ward: ALL, agency: ALL, severity: ALL, dueWindow: ALL }
const ANALYTICS_WINDOW_DAYS = 30

function isToday(ts: string | null): boolean {
  if (!ts) return false
  const d = new Date(ts)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

export default function TasksView() {
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_FILTERS)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const active = useAsync(() => listActiveTaskDispatches({ offset: 0, pageSize: 1000 }), [], {
    cacheKey: 'tasks:active',
  })
  const activeRows = useMemo(() => active.data?.rows ?? [], [active.data])

  const analytics = useAsync(() => listTaskDispatchesForAnalytics(ANALYTICS_WINDOW_DAYS), [], {
    cacheKey: 'tasks:analytics',
  })
  const analyticsRows = analytics.data ?? []

  const leadingSource = useAsync(
    () => listLeadingSourceCategories(activeRows.map((d) => d.incident_id).filter((id): id is number => id != null)),
    [activeRows],
    { cacheKey: 'tasks:leading-source' },
  )
  const leadingSourceById = leadingSource.data ?? new Map()

  const statuses = useMemo(() => [...new Set(activeRows.map((r) => r.status))].sort() as TaskDispatchStatus[], [activeRows])
  const wards = useMemo(
    () => [...new Set(activeRows.map((r) => r.ward_name).filter((w): w is string => w != null))].sort(),
    [activeRows],
  )
  const agencies = useMemo(
    () => [...new Set(activeRows.map((r) => r.responsible_agency).filter((a): a is string => a != null))].sort(),
    [activeRows],
  )
  const severities = useMemo(
    () => [...new Set(activeRows.map((r) => r.incident_severity).filter((s): s is string => s != null))],
    [activeRows],
  )

  const filteredRows = useMemo(() => {
    return activeRows.filter((d) => {
      if (filters.status !== ALL && d.status !== filters.status) return false
      if (filters.ward !== ALL && d.ward_name !== filters.ward) return false
      if (filters.agency !== ALL && d.responsible_agency !== filters.agency) return false
      if (filters.severity !== ALL && d.incident_severity !== filters.severity) return false
      if (filters.dueWindow !== ALL) {
        const mins = minutesUntil(nextDueAt(d))
        if (mins == null) return false
        if (filters.dueWindow === 'overdue' && mins >= 0) return false
        if (filters.dueWindow === 'today' && (mins < 0 || mins > 24 * 60)) return false
        if (filters.dueWindow === 'week' && (mins < 0 || mins > 7 * 24 * 60)) return false
      }
      return true
    })
  }, [activeRows, filters])

  const isFiltered = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS)
  const detailTask = selectedId != null ? activeRows.find((d) => d.id === selectedId) : undefined

  const loading = active.loading
  const error = active.error

  const kpis: KpiItem[] | null = useMemo(() => {
    if (active.loading || !active.data) return null
    const overdue = activeRows.filter((d) => {
      const mins = minutesUntil(nextDueAt(d))
      return mins != null && mins < 0
    }).length
    const dueToday = activeRows.filter((d) => {
      const mins = minutesUntil(nextDueAt(d))
      return mins != null && mins >= 0 && mins <= 24 * 60
    }).length
    const completedToday = analyticsRows.filter((d) => d.status === 'completed' && isToday(d.completed_at)).length
    const awaitingEvidence = analyticsRows.filter((d) => d.status === 'verification_pending').length
    const closedDurationsHours = analyticsRows
      .filter((d) => d.status === 'completed' && d.completed_at)
      .map((d) => (new Date(d.completed_at as string).getTime() - new Date(d.created_at).getTime()) / 3_600_000)
      .sort((a, b) => a - b)
    const avgClose = closedDurationsHours.length ? closedDurationsHours[Math.floor(closedDurationsHours.length / 2)] : null

    return [
      { key: 'active', icon: ClipboardList, label: 'Active tasks', value: active.data.totalCount, tone: 'info' },
      { key: 'overdue', icon: AlertTriangle, label: 'Overdue', value: overdue, tone: overdue > 0 ? 'critical' : 'success' },
      { key: 'dueToday', icon: Clock3, label: 'Due today', value: dueToday, tone: dueToday > 0 ? 'warning' : 'neutral' },
      {
        key: 'completedToday',
        icon: CheckCircle2,
        label: 'Completed today',
        value: analytics.loading ? '…' : completedToday,
        tone: 'success',
      },
      {
        key: 'awaitingEvidence',
        icon: HourglassIcon,
        label: 'Awaiting evidence',
        value: analytics.loading ? '…' : awaitingEvidence,
        sublabel: `last ${ANALYTICS_WINDOW_DAYS}d`,
        tone: 'info',
      },
      {
        key: 'avgClose',
        icon: Timer,
        label: 'Avg. time to close',
        value: analytics.loading ? '…' : avgClose != null ? `${avgClose.toFixed(1)}h` : 'No sample',
        sublabel: `last ${ANALYTICS_WINDOW_DAYS}d`,
        tone: 'neutral',
      },
    ]
  }, [active.loading, active.data, activeRows, analytics.loading, analyticsRows])

  return (
    <AppShell subtitle="Tasks">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden bg-sky-50 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-card">
          <div>
            <h1 className="text-base font-bold text-slate-900">Tasks / Dispatch</h1>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
              <MapPin className="h-3 w-3" aria-hidden />
              Delhi City Pack
              {active.stale && <StaleBadge />}
            </p>
            <p className="mt-1 max-w-xl text-xs text-slate-400">
              Tracks routed enforcement actions and field follow-up - every incident assigned to an authority becomes a
              dispatch here until it&apos;s completed and verified.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              active.refresh()
              analytics.refresh()
            }}
            disabled={active.refreshing}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${active.refreshing ? 'animate-spin' : ''}`} aria-hidden />
            Refresh
          </button>
        </div>

        {loading ? (
          <Skeleton className="h-20 w-full rounded-xl" />
        ) : error ? (
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
            <ErrorState message={error} onRetry={() => active.refresh()} />
          </div>
        ) : (
          kpis && <KpiStrip items={kpis} />
        )}

        {!loading && !error && (
          <TaskFilterBar filters={filters} onChange={setFilters} statuses={statuses} wards={wards} agencies={agencies} severities={severities} />
        )}

        <div className="flex min-h-0 flex-1 gap-3">
          <DispatchTable
            rows={filteredRows}
            totalCount={active.data?.totalCount ?? 0}
            loading={loading}
            error={error}
            onRetry={() => active.refresh()}
            selectedId={selectedId}
            onSelect={setSelectedId}
            leadingSourceById={leadingSourceById}
            isFiltered={isFiltered}
          />
          {detailTask && (
            <div className="w-80 flex-shrink-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
              <TaskDetailPanel task={detailTask} onClose={() => setSelectedId(null)} />
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
