import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapPin } from 'lucide-react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import AppShell from '../components/AppShell'
import IncidentDetailPanel from '../components/incidents/IncidentDetailPanel'
import IncidentList, { type IncidentListPagination } from '../components/incidents/IncidentList'
import IncidentQueueSidebar from '../components/incidents/IncidentQueueSidebar'
import { fetchAllWardsAqi } from '../lib/data'
import { inQueue, QUEUE_LABELS, SEVERITY_RANK, type QueueKey, type Severity } from '../lib/incidentRules'
import {
  getIncidentDetail,
  listClosedIncidents,
  listIncidents,
  listRecurrenceQueueIncidents,
  type Incident,
  type IncidentsPage,
} from '../lib/incidents'
import { useAsync } from '../lib/useAsync'

/**
 * Command incident workspace - a calm, single-pane case view, not a
 * permanent list-detail split. The queue sidebar (left) and either the
 * list OR the open case fill the content area; never list and case at
 * once, so a selected incident gets the full width. Sequential processing
 * through a queue happens via the case header's Prev/Next (see
 * IncidentCaseHeader.tsx), not by keeping the list docked on screen.
 * See components/incidents/ for the extracted pieces (IncidentQueueSidebar,
 * IncidentList/IncidentListItem, IncidentDetailPanel/IncidentCaseHeader/
 * IncidentSummaryTab).
 *
 * Added alongside the existing /command dashboard rather than replacing it: the
 * dashboard still works and is still useful, and the migration rule is to keep
 * the app usable while a new flow is proven.
 */

// The 5 "open" queues are loaded in full (an incomplete view of what's
// currently unresolved is dangerous, not just cosmetically wrong) - only
// `closed` and `recurrence` are paginated, since closed incidents are the
// one historical record that grows unboundedly. See listClosedIncidents'
// own comment in incidents.ts for the offset-vs-keyset trade-off.
const OPEN_QUEUE_ORDER: QueueKey[] = ['active', 'predicted', 'verification', 'assigned', 'escalated']
const PAGE_SIZE = 50
// Comfortably above the project's own forward-looking target (~5,000
// incidents, most of which are closed and excluded here) - if this is ever
// hit, the banner below says so explicitly rather than silently truncating.
const OPEN_QUEUE_CAP = 1000

interface PaginatedQueueState {
  rows: Incident[]
  totalCount: number
  hasMore: boolean
  loading: boolean
  error: string | null
}
const EMPTY_PAGE: PaginatedQueueState = { rows: [], totalCount: 0, hasMore: false, loading: false, error: null }

export default function IncidentsView() {
  const [queue, setQueue] = useState<QueueKey>('active')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState('summary')
  const [searchParams] = useSearchParams()
  const appliedDeepLinkRef = useRef(false)
  const location = useLocation()
  const onRemediation = location.pathname === '/incidents/remediation'

  // The 5 open queues, loaded in full (capped defensively - see OPEN_QUEUE_CAP).
  const list = useAsync(() => listIncidents({ limit: OPEN_QUEUE_CAP, excludeClosed: true }), [], {
    staleAfterMs: 120_000,
    cacheKey: 'incidents:list',
  })
  const openIncidents = useMemo(() => list.data ?? [], [list.data])

  // Ward-level live AQI, for the "current reading" column/fact - fetched once
  // per page load, independent of queue, reused from the Overview page's own
  // data.ts function. Real data, not a new backend endpoint.
  const wardAqi = useAsync(fetchAllWardsAqi, [], { cacheKey: 'incidents:ward-aqi' })
  const wardAqiById = useMemo(() => new Map(wardAqi.data?.map((w) => [w.id, w.aqi]) ?? []), [wardAqi.data])

  // `closed` and `recurrence` are paginated independently of each other and
  // of the open set — see listClosedIncidents/listRecurrenceQueueIncidents
  // in incidents.ts. Lazy-loaded: only fetched once the commander actually
  // opens that tab, not on every page load.
  const [closedState, setClosedState] = useState<PaginatedQueueState>(EMPTY_PAGE)
  const [recurrenceState, setRecurrenceState] = useState<PaginatedQueueState>(EMPTY_PAGE)

  const loadPaginatedQueue = useCallback(
    async (kind: 'closed' | 'recurrence', reset: boolean) => {
      const setState = kind === 'closed' ? setClosedState : setRecurrenceState
      const fetcher = kind === 'closed' ? listClosedIncidents : listRecurrenceQueueIncidents
      const currentRows = kind === 'closed' ? closedState.rows : recurrenceState.rows
      setState((s) => ({ ...s, loading: true, error: null }))
      try {
        const offset = reset ? 0 : currentRows.length
        const page: IncidentsPage = await fetcher({ offset, pageSize: PAGE_SIZE })
        setState({
          rows: reset ? page.rows : [...currentRows, ...page.rows],
          totalCount: page.totalCount,
          hasMore: page.hasMore,
          loading: false,
          error: null,
        })
      } catch (err) {
        setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : 'Could not load' }))
      }
    },
    [closedState.rows, recurrenceState.rows],
  )

  useEffect(() => {
    if (queue === 'closed' && closedState.rows.length === 0 && !closedState.loading) loadPaginatedQueue('closed', true)
    if (queue === 'recurrence' && recurrenceState.rows.length === 0 && !recurrenceState.loading) {
      loadPaginatedQueue('recurrence', true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue])

  const counts = useMemo(() => {
    const c = {} as Record<QueueKey, number>
    for (const q of OPEN_QUEUE_ORDER) c[q] = openIncidents.filter((i) => inQueue(i, q)).length
    c.closed = closedState.totalCount
    c.recurrence = recurrenceState.totalCount
    return c
  }, [openIncidents, closedState.totalCount, recurrenceState.totalCount])

  const visibleRows = useMemo(() => {
    if (queue === 'closed') return closedState.rows
    if (queue === 'recurrence') return recurrenceState.rows
    return openIncidents
      .filter((i) => inQueue(i, queue))
      .sort((a, b) => {
        // Worst first, then oldest — the queue is a work order, not a feed.
        // (closed/recurrence are already resolved, so they stay in the
        // server's detected_at-desc order instead - most recently closed first.)
        const sa = SEVERITY_RANK[(a.severity ?? 'low') as Severity] ?? 0
        const sb = SEVERITY_RANK[(b.severity ?? 'low') as Severity] ?? 0
        if (sa !== sb) return sb - sa
        return new Date(a.detected_at).getTime() - new Date(b.detected_at).getTime()
      })
  }, [openIncidents, queue, closedState.rows, recurrenceState.rows])

  // Deep-link support (?incident=<id>) — e.g. a Tasks-page row linking
  // straight into this incident's detail workspace instead of the bare
  // queue. Applied once list.data is loaded, and only once per page load:
  // switches to whichever queue actually contains the incident (it may not
  // be in the default 'active' queue), then selects it. Scoped to the open
  // set only — in practice every real deep-link source (the Tasks page)
  // only ever links to incidents with an active dispatch, which are never
  // closed, so this scoping is not a real limitation today.
  useEffect(() => {
    if (appliedDeepLinkRef.current || list.loading) return
    const raw = searchParams.get('incident')
    if (raw == null) return
    const id = Number(raw)
    const target = openIncidents.find((i) => i.id === id)
    if (!target) return
    appliedDeepLinkRef.current = true
    setQueue(OPEN_QUEUE_ORDER.find((q) => inQueue(target, q)) ?? 'active')
    setSelectedId(id)
  }, [searchParams, list.loading, openIncidents])

  const detailId = selectedId != null && visibleRows.some((i) => i.id === selectedId) ? selectedId : null

  const detail = useAsync(
    () => (detailId == null ? Promise.resolve(null) : getIncidentDetail(detailId)),
    [detailId],
    { enabled: detailId != null },
  )

  // A new incident selection always starts on Summary — staying on e.g.
  // "Action" from the previously-viewed incident would be a confusing
  // leftover, not a deliberate choice.
  useEffect(() => {
    setActiveTab('summary')
  }, [detailId])

  const refreshBoth = useCallback(() => {
    list.refresh()
    detail.refresh()
  }, [list, detail])

  const paginatedState = queue === 'closed' ? closedState : queue === 'recurrence' ? recurrenceState : null
  const activeLoading = paginatedState ? paginatedState.loading && visibleRows.length === 0 : list.loading
  const activeError = paginatedState ? paginatedState.error : list.error
  const refreshActiveQueue = () => (paginatedState ? loadPaginatedQueue(queue as 'closed' | 'recurrence', true) : list.refresh())

  const pagination: IncidentListPagination | null = paginatedState
    ? {
        totalCount: paginatedState.totalCount,
        hasMore: paginatedState.hasMore,
        loadingMore: paginatedState.loading,
        onLoadMore: () => loadPaginatedQueue(queue as 'closed' | 'recurrence', false),
      }
    : null

  const selectedWardId = detail.data?.incident.ward_id ?? null
  const selectedWardAqi = selectedWardId != null ? (wardAqiById.get(selectedWardId) ?? null) : null

  // Sequential processing without a permanently-docked list: Prev/Next walk
  // the currently-selected queue's own order, same rows the list would show.
  const currentIndex = detailId != null ? visibleRows.findIndex((i) => i.id === detailId) : -1
  const position = currentIndex >= 0 ? { index: currentIndex + 1, total: visibleRows.length } : null
  const goPrev = currentIndex > 0 ? () => setSelectedId(visibleRows[currentIndex - 1].id) : undefined
  const goNext =
    currentIndex >= 0 && currentIndex < visibleRows.length - 1
      ? () => setSelectedId(visibleRows[currentIndex + 1].id)
      : undefined

  return (
    <AppShell
      subtitle="Incidents"
      headerContent={
        <div className="flex items-center gap-3">
          <span className="truncate text-[15px] font-bold tracking-tight text-slate-900">Incidents</span>
          {/* Location Audit is a coordinate/data-quality remediation tool, not
              an incident queue - kept one click away while working incidents,
              but deliberately out of the queue sidebar so it never reads as
              an 8th queue in that same workflow. */}
          <Link
            to="/incidents/remediation"
            className={`focus-ring flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold transition ${
              onRemediation ? 'bg-accent-50 text-accent-800' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
            }`}
          >
            <MapPin className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2} aria-hidden />
            Location Audit
          </Link>
        </div>
      }
      secondaryNav={<IncidentQueueSidebar counts={counts} active={queue} onSelect={setQueue} />}
    >
      {/* Single-pane, at every breakpoint: the list and the open case are
          never shown side by side. A selected incident gets the full
          content width instead of sharing it with a permanently-docked
          list column - sequential processing through a queue happens via
          the case header's Prev/Next, not by keeping the list in view. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className={`min-h-0 flex-1 flex-col bg-white ${detailId != null ? 'hidden' : 'flex'}`}>
          <IncidentList
            queue={queue}
            onQueueChange={setQueue}
            recurrenceCount={counts.recurrence}
            visibleRows={visibleRows}
            detailId={detailId}
            onSelectIncident={setSelectedId}
            wardAqiById={wardAqiById}
            loading={activeLoading}
            error={activeError}
            onRefresh={refreshActiveQueue}
            refreshing={paginatedState ? paginatedState.loading : list.refreshing}
            stale={!paginatedState && list.stale}
            capHit={!paginatedState && openIncidents.length >= OPEN_QUEUE_CAP}
            pagination={pagination}
            showStaleFooter={!paginatedState && !!list.error && !list.loading && (list.data?.length ?? 0) > 0}
          />
        </div>

        {detailId != null && (
          <div className="flex min-h-0 flex-1 flex-col bg-slate-50">
            <IncidentDetailPanel
              detail={detail}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              onRefresh={refreshBoth}
              onBack={() => setSelectedId(null)}
              onPrev={goPrev}
              onNext={goNext}
              position={position}
              queueLabel={QUEUE_LABELS[queue]}
              wardAqi={selectedWardAqi}
            />
          </div>
        )}
      </div>
    </AppShell>
  )
}
