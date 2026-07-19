import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import AppShell from '../components/AppShell'
import IncidentEvidencePanel from '../components/IncidentEvidencePanel'
import { EmptyState, ErrorState, Skeleton, StaleBadge, StickyActionBar, TabPanel, Tabs, type TabItem } from '../components/ui'
import { useAuth } from '../lib/auth'
import {
  CONFIDENCE_LABEL,
  ESCALATION_SLA_HOURS,
  QUEUE_LABELS,
  SEVERITY_RANK,
  allowedTaskKinds,
  inQueue,
  isEscalated,
  taskBlockedReason,
  type QueueKey,
  type Severity,
} from '../lib/incidentRules'
import InterventionPanel from '../components/InterventionPanel'
import PredictedIncidentPanel from '../components/PredictedIncidentPanel'
import RecurrencePanel from '../components/RecurrencePanel'
import SourceAttributionPanel from '../components/SourceAttributionPanel'
import TaskDispatchPanel from '../components/TaskDispatchPanel'
import {
  createEvidenceMission,
  getIncidentDetail,
  listAssignableOfficers,
  listClosedIncidents,
  listLinkedReports,
  listIncidents,
  listRecurrenceQueueIncidents,
  reopenIncident,
  updateIncidentAssignment,
  updateIncidentStatus,
  type AssignableOfficer,
  type Incident,
  type IncidentsPage,
} from '../lib/incidents'
import { useAsync } from '../lib/useAsync'

/**
 * Command incident queue — the Outlook-style list-detail-action workspace the
 * plan makes the *primary* command surface (§18-19). Phase 11 UI redesign:
 * light/white surfaces, a real detail-workspace tab structure (Overview /
 * Evidence / Source attribution / Intervention / Dispatch — mapped onto the
 * EXISTING panel components below, no panel's own logic touched), and a
 * mobile layout that swaps the desktop's simultaneous list+detail columns
 * for queue chips → list → a full-screen detail page with back navigation,
 * rather than shrinking the same 3-column layout.
 *
 * Added alongside the existing /command dashboard rather than replacing it: the
 * dashboard still works and is still useful, and the migration rule is to keep
 * the app usable while a new flow is proven.
 */

const QUEUE_ORDER: QueueKey[] = ['active', 'predicted', 'verification', 'assigned', 'escalated', 'recurrence', 'closed']
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

const DETAIL_TABS: TabItem[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'evidence', label: 'Evidence' },
  { key: 'attribution', label: 'Source attribution' },
  { key: 'intervention', label: 'Intervention' },
  { key: 'dispatch', label: 'Dispatch' },
]

const SEVERITY_STYLE: Record<Severity, string> = {
  severe: 'bg-red-100 text-red-800',
  high: 'bg-orange-100 text-orange-800',
  moderate: 'bg-amber-100 text-amber-800',
  low: 'bg-slate-100 text-slate-600',
}

const CONFIDENCE_STYLE: Record<string, string> = {
  suspected: 'bg-slate-100 text-slate-600',
  corroborated: 'bg-accent-100 text-accent-800',
  officially_verified: 'bg-green-100 text-green-800',
}

function ageHours(ts: string): number {
  return (Date.now() - new Date(ts).getTime()) / 3_600_000
}

function fmtAge(ts: string): string {
  const h = ageHours(ts)
  if (h < 1) return '<1h'
  if (h < 48) return `${Math.floor(h)}h`
  return `${Math.floor(h / 24)}d`
}

/** Desktop: a vertical list of queue rows (rendered in AppShell's secondaryNav
 *  column). Mobile: the SAME data, styled as horizontally-scrollable chips —
 *  intentionally distinct treatments of one shared data structure, not one
 *  layout auto-shrunk into the other. */
function QueueNav({
  counts,
  active,
  onSelect,
}: {
  counts: Record<QueueKey, number>
  active: QueueKey
  onSelect: (q: QueueKey) => void
}) {
  return (
    <div className="flex gap-1.5 overflow-x-auto sm:flex-col sm:gap-1 sm:overflow-visible">
      {QUEUE_ORDER.map((q) => {
        const selected = q === active
        return (
          <button
            key={q}
            type="button"
            onClick={() => onSelect(q)}
            aria-current={selected ? 'true' : undefined}
            className={`focus-ring flex flex-shrink-0 items-center justify-between gap-2 rounded-full px-3 py-1.5 text-left text-sm transition sm:rounded-lg sm:px-2.5 ${
              selected ? 'bg-accent-600 font-semibold text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 sm:bg-transparent sm:ring-0 sm:hover:bg-slate-100'
            }`}
          >
            <span>{QUEUE_LABELS[q]}</span>
            <span
              className={`rounded px-1.5 text-[10px] font-bold tabular-nums ${
                selected ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
              }`}
            >
              {counts[q]}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function IncidentRow({
  incident,
  selected,
  onSelect,
}: {
  incident: Incident
  selected: boolean
  onSelect: () => void
}) {
  const severity = (incident.severity ?? null) as Severity | null
  const escalated = isEscalated(incident)

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={`focus-ring w-full border-l-2 px-3 py-2.5 text-left transition ${
          selected ? 'border-accent-600 bg-accent-50' : 'border-transparent hover:bg-slate-50'
        }`}
      >
        <div className="flex items-center gap-1.5">
          {severity ? (
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${SEVERITY_STYLE[severity]}`}>
              {severity}
            </span>
          ) : (
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-400 ring-1 ring-inset ring-slate-200"
              title="No forecast for this ward, so severity could not be derived"
            >
              No severity
            </span>
          )}
          {escalated && (
            <span
              className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-red-700"
              title={`Open longer than ${ESCALATION_SLA_HOURS}h with nothing dispatched`}
            >
              Escalated
            </span>
          )}
          <span className="ml-auto text-[11px] tabular-nums text-slate-400">{fmtAge(incident.detected_at)}</span>
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-slate-800">{incident.summary ?? `Incident #${incident.id}`}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-400">
          <span>#{incident.id}</span>
          {incident.ward_name && <span>· {incident.ward_name}</span>}
          <span
            className={`rounded px-1 font-semibold ${CONFIDENCE_STYLE[incident.source_confidence] ?? 'bg-slate-100'}`}
          >
            {CONFIDENCE_LABEL[incident.source_confidence]}
          </span>
        </div>
      </button>
    </li>
  )
}

/**
 * Next-best-evidence dialog (plan §10). The rationale is mandatory — the system
 * must always say WHY the evidence is needed, not just ask for it — and a
 * mission with no assignee would never reach anyone, so the officer picker is
 * part of dispatching rather than an afterthought.
 */
function EvidenceMissionDialog({
  incident,
  onClose,
  onCreated,
}: {
  incident: Incident
  onClose: () => void
  onCreated: () => void
}) {
  const { session } = useAuth()
  const [missionType, setMissionType] = useState<'field_photo' | 'citizen_verification' | 'source_status_check'>(
    'field_photo',
  )
  const [assignee, setAssignee] = useState<string>('')
  const [rationale, setRationale] = useState(
    'Source confidence is insufficient to justify an action task. A geotagged field photograph is the smallest evidence that can corroborate or rule out the suspected source.',
  )
  const [publicPrompt, setPublicPrompt] = useState('Is the pollution you reported still happening?')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const officers = useAsync(() => listAssignableOfficers(incident.ward_id), [incident.ward_id])
  const officerList: AssignableOfficer[] = officers.data ?? []
  const isCitizenMission = missionType === 'citizen_verification'

  // A citizen mission has to be addressed to a specific citizen: they only ever
  // see missions assigned to them. The people who reported this incident are the
  // ones who are actually there, so they are the candidates.
  const reporters = useAsync(
    async () => {
      const rs = await listLinkedReports(incident.id)
      const seen = new Set<string>()
      return rs.filter((r) => r.reporter_id && !seen.has(r.reporter_id) && seen.add(r.reporter_id))
    },
    [incident.id],
    { enabled: isCitizenMission },
  )
  const reporterList = reporters.data ?? []

  const create = async () => {
    if (!session) return
    setBusy(true)
    setError(null)
    try {
      await createEvidenceMission({
        incidentId: incident.id,
        missionType,
        // Either way this must name a person: a mission with no assignee is
        // visible to nobody under RLS and would sit unworked forever.
        assignedTo: assignee || null,
        rationale,
        publicPrompt: isCitizenMission ? publicPrompt : null,
        actorId: session.user.id,
      })
      onCreated()
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not create the mission.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="z-modal fixed inset-0 flex items-end justify-center bg-slate-900/40 p-3 sm:items-center">
      <div role="dialog" aria-modal="true" aria-label="Request evidence" className="w-full max-w-md rounded-2xl bg-white p-4 shadow-card-lg">
        <h2 className="text-sm font-semibold text-slate-900">Request the next best evidence</h2>
        <p className="mt-0.5 text-xs text-slate-400">
          The smallest useful mission that would raise or rule out confidence in this source.
        </p>

        <label className="mt-3 block text-xs font-semibold text-slate-700">Mission type</label>
        <select
          value={missionType}
          onChange={(e) => setMissionType(e.target.value as typeof missionType)}
          className="focus-ring mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm"
        >
          <option value="field_photo">Geotagged field photograph (officer)</option>
          <option value="source_status_check">Source operating-status check (officer)</option>
          <option value="citizen_verification">Targeted citizen verification</option>
        </select>

        <label className="mt-3 block text-xs font-semibold text-slate-700">
          {isCitizenMission ? 'Ask which reporter' : 'Assign to'}
        </label>
        {(isCitizenMission ? reporters.loading : officers.loading) ? (
          <Skeleton className="mt-1 h-9 w-full" />
        ) : (isCitizenMission ? reporters.error : officers.error) ? (
          <p className="mt-1 text-xs text-status-critical">{isCitizenMission ? reporters.error : officers.error}</p>
        ) : isCitizenMission ? (
          reporterList.length === 0 ? (
            <p className="mt-1 rounded-lg bg-status-warning/10 px-2.5 py-2 text-xs text-slate-600">
              No citizen reports are linked to this incident, so there is nobody to ask. Use an officer mission instead.
            </p>
          ) : (
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className="focus-ring mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm"
            >
              <option value="">Select a reporter…</option>
              {reporterList.map((r) => (
                <option key={r.id} value={r.reporter_id ?? ''}>
                  Reporter of #{r.id} · {new Date(r.created_at).toLocaleDateString()}
                </option>
              ))}
            </select>
          )
        ) : officerList.length === 0 ? (
          // Honest dead-end: a real operational state (no officer covers this
          // ward), not an empty dropdown to shrug at.
          <p className="mt-1 rounded-lg bg-status-warning/10 px-2.5 py-2 text-xs text-slate-600">
            No field officer is assigned to this ward, so this mission cannot be dispatched. Assign an officer to the
            ward first (roles are set in SQL today - see README).
          </p>
        ) : (
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className="focus-ring mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm"
          >
            <option value="">Select an officer…</option>
            {officerList.map((o) => (
              <option key={o.id} value={o.id}>
                {o.full_name ?? o.id.slice(0, 8)}
              </option>
            ))}
          </select>
        )}

        {isCitizenMission && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
            The citizen is only shown this if our safety rule allows it - we never ask the public to approach fires or
            industrial sites, or to go outside when the air is severe.
          </p>
        )}

        <label className="mt-3 block text-xs font-semibold text-slate-700">
          Why is this evidence needed? <span className="font-normal text-slate-400">(recorded on the incident)</span>
        </label>
        <textarea
          rows={3}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          className="focus-ring mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs"
        />

        {isCitizenMission && (
          <>
            <label className="mt-3 block text-xs font-semibold text-slate-700">
              Question shown to the citizen{' '}
              <span className="font-normal text-slate-400">(never include enforcement detail)</span>
            </label>
            <input
              value={publicPrompt}
              onChange={(e) => setPublicPrompt(e.target.value)}
              className="focus-ring mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs"
            />
          </>
        )}

        {error && <p className="mt-2 text-xs text-status-critical">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="focus-ring rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !rationale.trim() || !assignee}
            title={!assignee ? 'Choose who this mission goes to - an unassigned mission reaches nobody' : undefined}
            onClick={create}
            className="focus-ring rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-700 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create mission'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DetailHeader({
  incident,
  onRefresh,
  onBack,
}: {
  incident: Incident
  onRefresh: () => void
  onBack?: () => void
}) {
  const { session } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missionOpen, setMissionOpen] = useState(false)
  const severity = (incident.severity ?? null) as Severity | null
  const kinds = allowedTaskKinds(incident.source_confidence)

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onRefresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Action failed.')
    } finally {
      setBusy(false)
    }
  }

  const assign = () => {
    if (!session) return
    const authority = window.prompt('Refer this incident to which authority?')
    if (!authority?.trim()) return
    void act(() => updateIncidentAssignment(incident.id, authority.trim(), session.user.id))
  }

  const close = () => {
    if (!session) return
    void act(() => updateIncidentStatus(incident.id, 'closed', session.user.id, 'Closed from the command workspace.'))
  }

  const reopen = () => {
    if (!session) return
    const note = window.prompt('Why is this incident being reopened? (e.g. problem recurred)')
    if (!note?.trim()) return
    void act(() => reopenIncident(incident.id, null, session.user.id, note.trim()))
  }

  const inspectionBlocked = taskBlockedReason(incident.source_confidence, 'inspection')

  return (
    <div className="flex-shrink-0 border-b border-slate-200 bg-white px-4 py-3">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="focus-ring mb-2 flex items-center gap-1 text-xs font-semibold text-accent-700 lg:hidden"
        >
          ← Back to queue
        </button>
      )}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-slate-900">{incident.summary ?? `Incident #${incident.id}`}</h1>
          <p className="mt-0.5 text-xs text-slate-400">
            #{incident.id} · detected {new Date(incident.detected_at).toLocaleString()} · via{' '}
            {incident.detection_method.replace(/_/g, ' ')}
          </p>
        </div>
        <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold capitalize text-slate-700">
          {incident.status.replace(/_/g, ' ')}
        </span>
      </div>

      {/* The facts the plan requires on the selected incident (§4 of the brief) */}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-slate-400">Location</dt>
          <dd className="font-semibold text-slate-800">
            {incident.ward_name ?? 'Unknown ward'}
            {incident.lat != null && incident.lng != null && (
              <span className="ml-1 font-normal text-slate-400">
                {incident.lat.toFixed(3)}, {incident.lng.toFixed(3)}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Pollutant</dt>
          <dd className="font-semibold uppercase text-slate-800">{incident.primary_pollutant ?? '-'}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Local excess</dt>
          <dd className="font-semibold tabular-nums text-slate-800">
            {incident.local_excess != null ? (
              `+${Math.round(incident.local_excess)} µg/m³`
            ) : (
              <span className="font-normal text-slate-400" title="No forecast available for this ward">
                Unavailable
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Severity</dt>
          <dd>
            {severity ? (
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${SEVERITY_STYLE[severity]}`}>
                {severity}
              </span>
            ) : (
              <span className="text-slate-400">Unavailable</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Evidence level</dt>
          <dd>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                CONFIDENCE_STYLE[incident.source_confidence]
              }`}
            >
              {CONFIDENCE_LABEL[incident.source_confidence]}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Assigned authority</dt>
          <dd className="font-semibold text-slate-800">
            {incident.assigned_authority ?? <span className="font-normal text-slate-400">Not routed yet</span>}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Classification</dt>
          <dd className="font-semibold capitalize text-slate-800">
            {incident.classification ?? <span className="font-normal text-slate-400">Not classified</span>}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Permitted tasks</dt>
          <dd className="font-semibold text-slate-800">{kinds.join(', ')}</dd>
        </div>
      </dl>

      {/* Action toolbar - sticky at the bottom of the viewport on mobile
          (thumb reach), a normal inline row on desktop. Which buttons exist is
          decided by the evidence level, and a blocked action explains itself
          rather than being silently absent. */}
      <StickyActionBar className="-mx-4 mt-3 px-4 sm:mx-0">
        <button
          type="button"
          disabled={busy}
          onClick={() => setMissionOpen(true)}
          className="focus-ring rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-700 disabled:opacity-50"
        >
          Request evidence
        </button>
        <button
          type="button"
          disabled={busy || !!inspectionBlocked}
          title={inspectionBlocked ?? 'Refer to the responsible authority'}
          onClick={assign}
          className="focus-ring rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Route to authority
        </button>
        {incident.status === 'closed' ? (
          <button
            type="button"
            disabled={busy}
            onClick={reopen}
            className="focus-ring rounded-lg border border-status-warning/40 px-3 py-1.5 text-xs font-semibold text-status-warning transition hover:bg-status-warning/10 disabled:opacity-50"
          >
            Reopen (recurrence)
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={close}
            title="An incident with a completed action and no impact evaluation cannot be closed."
            className="focus-ring rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            Close incident
          </button>
        )}
      </StickyActionBar>

      {inspectionBlocked && (
        <p className="mt-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-600">
          <span className="font-semibold">Why is routing unavailable?</span> {inspectionBlocked}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-status-critical">{error}</p>}

      {missionOpen && (
        <EvidenceMissionDialog incident={incident} onClose={() => setMissionOpen(false)} onCreated={onRefresh} />
      )}
    </div>
  )
}

export default function IncidentsView() {
  const [queue, setQueue] = useState<QueueKey>('active')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState('overview')
  const [searchParams] = useSearchParams()
  const appliedDeepLinkRef = useRef(false)

  // The 5 open queues, loaded in full (capped defensively - see OPEN_QUEUE_CAP).
  const list = useAsync(() => listIncidents({ limit: OPEN_QUEUE_CAP, excludeClosed: true }), [], {
    staleAfterMs: 120_000,
  })
  const openIncidents = useMemo(() => list.data ?? [], [list.data])

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

  // A new incident selection always starts on Overview — staying on e.g.
  // "Dispatch" from the previously-viewed incident would be a confusing
  // leftover, not a deliberate choice.
  useEffect(() => {
    setActiveTab('overview')
  }, [detailId])

  const refreshBoth = useCallback(() => {
    list.refresh()
    detail.refresh()
  }, [list, detail])

  const paginatedState = queue === 'closed' ? closedState : queue === 'recurrence' ? recurrenceState : null
  const activeLoading = paginatedState ? paginatedState.loading && visibleRows.length === 0 : list.loading
  const activeError = paginatedState ? paginatedState.error : list.error
  const refreshActiveQueue = () => (paginatedState ? loadPaginatedQueue(queue as 'closed' | 'recurrence', true) : list.refresh())

  return (
    <AppShell
      subtitle="Incidents"
      secondaryNav={<QueueNav counts={counts} active={queue} onSelect={setQueue} />}
    >
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* ── list column: hidden on mobile once an incident is selected ── */}
        <div
          className={`min-h-0 w-full flex-col border-b border-slate-200 bg-white lg:flex lg:w-80 lg:border-b-0 lg:border-r ${
            detailId != null ? 'hidden lg:flex' : 'flex'
          }`}
        >
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{QUEUE_LABELS[queue]}</h2>
            <span className="rounded bg-slate-100 px-1.5 text-[10px] font-bold text-slate-600">
              {paginatedState ? `${visibleRows.length} of ${paginatedState.totalCount}` : visibleRows.length}
            </span>
            {!paginatedState && list.stale && <StaleBadge />}
            <button
              type="button"
              onClick={refreshActiveQueue}
              className="focus-ring ml-auto rounded px-1.5 py-0.5 text-[11px] font-semibold text-accent-700 hover:bg-slate-50"
            >
              {(paginatedState ? paginatedState.loading : list.refreshing) ? '…' : 'Refresh'}
            </button>
          </div>

          {!paginatedState && openIncidents.length >= OPEN_QUEUE_CAP && (
            <p className="border-b border-status-warning/30 bg-status-warning/10 px-3 py-1.5 text-[11px] text-slate-700">
              Showing the {OPEN_QUEUE_CAP} highest-priority open incidents — more may exist.
            </p>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {activeLoading ? (
              <div className="space-y-2 p-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : activeError ? (
              <ErrorState message={activeError} onRetry={refreshActiveQueue} />
            ) : visibleRows.length === 0 ? (
              <EmptyState icon="✅">
                {queue === 'escalated'
                  ? `No incident has been open longer than ${ESCALATION_SLA_HOURS}h without action.`
                  : queue === 'predicted'
                    ? 'No incidents are currently trending toward a threshold crossing. The automated detection engine re-evaluates every monitoring station on each ingest cycle.'
                    : `Nothing in ${QUEUE_LABELS[queue].toLowerCase()}.`}
              </EmptyState>
            ) : (
              <>
                <ul>
                  {visibleRows.map((i) => (
                    <IncidentRow
                      key={i.id}
                      incident={i}
                      selected={i.id === detailId}
                      onSelect={() => setSelectedId(i.id)}
                    />
                  ))}
                </ul>
                {paginatedState?.hasMore && (
                  <div className="p-2">
                    <button
                      type="button"
                      disabled={paginatedState.loading}
                      onClick={() => loadPaginatedQueue(queue as 'closed' | 'recurrence', false)}
                      className="focus-ring w-full rounded-lg border border-slate-200 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {paginatedState.loading
                        ? 'Loading…'
                        : `Load more (${paginatedState.totalCount - paginatedState.rows.length} remaining)`}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* The list is the primary surface; say so about stale data rather than
              quietly showing old rows as current. */}
          {!paginatedState && list.error && !list.loading && (list.data?.length ?? 0) > 0 && (
            <p className="border-t border-slate-100 bg-status-warning/10 px-3 py-1.5 text-[11px] text-slate-600">
              Showing the last data loaded - refresh failed.
            </p>
          )}
        </div>

        {/* ── detail column: hidden on mobile until an incident is selected;
              a full-screen page there, not a squeezed side column ── */}
        <div
          className={`min-h-0 flex-1 flex-col bg-slate-50 lg:flex ${detailId != null ? 'flex' : 'hidden lg:flex'}`}
        >
          {detailId == null ? (
            <EmptyState icon="📋">Select an incident to see its evidence workspace.</EmptyState>
          ) : detail.loading ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : detail.error ? (
            <ErrorState message={detail.error} onRetry={() => detail.refresh()} />
          ) : !detail.data ? (
            <EmptyState icon="🔍">This incident is no longer available.</EmptyState>
          ) : (
            <>
              <DetailHeader
                incident={detail.data.incident}
                onRefresh={refreshBoth}
                onBack={() => setSelectedId(null)}
              />
              <Tabs tabs={DETAIL_TABS} active={activeTab} onChange={setActiveTab} />
              <div className="min-h-0 flex-1 overflow-y-auto">
                <TabPanel active={activeTab === 'overview'}>
                  <PredictedIncidentPanel detail={detail.data} onRefresh={refreshBoth} />
                  <RecurrencePanel detail={detail.data} onRefresh={refreshBoth} />
                </TabPanel>
                <TabPanel active={activeTab === 'evidence'}>
                  <IncidentEvidencePanel detail={detail.data} />
                </TabPanel>
                <TabPanel active={activeTab === 'attribution'}>
                  <SourceAttributionPanel detail={detail.data} onRefresh={refreshBoth} />
                </TabPanel>
                <TabPanel active={activeTab === 'intervention'}>
                  <InterventionPanel detail={detail.data} onRefresh={refreshBoth} />
                </TabPanel>
                <TabPanel active={activeTab === 'dispatch'}>
                  <TaskDispatchPanel detail={detail.data} onRefresh={refreshBoth} />
                </TabPanel>
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  )
}
