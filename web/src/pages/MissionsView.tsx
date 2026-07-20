import { useState } from 'react'
import AppShell from '../components/AppShell'
import FieldTaskDispatchCard from '../components/FieldTaskDispatchCard'
import OfflineQueueStatus from '../components/OfflineQueueStatus'
import { Card, CardHeader, EmptyState, ErrorState, Label, Skeleton } from '../components/ui'
import { useAuth } from '../lib/auth'
import {
  OUTCOME_LABELS,
  PLAYBOOK_ACTION_TYPE_LABEL,
  WORKFLOW_STATUS_LABEL,
  checklistFor,
  evidenceLevelAfterFieldOutcome,
  incidentStatusAfterFieldOutcome,
  isOutcomeStatus,
  parseChecklistSnapshot,
  type ChecklistItem,
  type MissionOutcome,
  type PlaybookActionType,
} from '../lib/incidentRules'
import {
  getPlaybook,
  listInterventionsForOfficer,
  listMissionsForUser,
  updateIncidentStatus,
  updateSourceConfidence,
  type InterventionWithIncident,
  type MissionWithIncident,
} from '../lib/incidents'
import { runOrQueueSubmitFieldCompletion, runOrQueueSubmitMissionResult } from '../lib/offlineSync'
import { useAsync } from '../lib/useAsync'

/**
 * Field evidence missions (plan §10, §18 Field application).
 *
 * Mobile-first and camera/GPS-first, reusing the existing report-photos upload
 * path rather than introducing a second storage mechanism.
 *
 * Offline support (Phase 12): a mission result or intervention completion
 * submitted with no connection (or that fails on a network-level error) is
 * queued in IndexedDB and replayed in order once back online - see
 * lib/offlineSync.ts for exactly what is and isn't guaranteed (in short: no
 * protection against a genuine double-write if the tab is killed mid-replay,
 * since neither mutation has a server-side idempotency key yet). The
 * "Offline queue" card below surfaces what's pending/failed/conflicting.
 */

const OUTCOME_STYLE: Record<MissionOutcome, string> = {
  confirmed: 'bg-brand-700 text-white hover:bg-brand-800',
  rejected: 'border border-ink-200 text-ink-700 hover:bg-ink-50',
  unresolved: 'border border-ink-200 text-ink-500 hover:bg-ink-50',
}

function ChecklistField({
  item,
  value,
  onChange,
}: {
  item: ChecklistItem
  value: unknown
  onChange: (v: unknown) => void
}) {
  if (item.type === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="text-sm text-ink-700">{item.label}</span>
        <div className="flex flex-shrink-0 gap-1">
          {[
            { v: true, label: 'Yes' },
            { v: false, label: 'No' },
          ].map(({ v, label }) => (
            <button
              key={label}
              type="button"
              onClick={() => onChange(value === v ? null : v)}
              aria-pressed={value === v}
              className={`focus-ring min-w-[52px] rounded-lg px-3 py-2 text-xs font-semibold transition ${
                value === v ? 'bg-brand-700 text-white' : 'border border-ink-200 text-ink-600 hover:bg-ink-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="py-2">
      <label className="block text-sm text-ink-700">{item.label}</label>
      <textarea
        rows={2}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        className="focus-ring mt-1 w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm"
      />
    </div>
  )
}

function MissionForm({ m, onDone }: { m: MissionWithIncident; onDone: () => void }) {
  const { session, profile } = useAuth()
  const items = checklistFor(m.leadingCategory)

  const [responses, setResponses] = useState<Record<string, unknown>>({})
  const [photo, setPhoto] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [geoBusy, setGeoBusy] = useState(false)
  const [geoError, setGeoError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const capture = () => {
    setGeoBusy(true)
    setGeoError(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setGeoBusy(false)
      },
      (e) => {
        // A failed fix must be visible: proof without a location is much weaker
        // evidence, and the officer needs to know it didn't attach.
        setGeoError(e.message || 'Could not get your location.')
        setGeoBusy(false)
      },
      { timeout: 10_000, enableHighAccuracy: true },
    )
  }

  const pickPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null
    setPhoto(f)
    setPreview(f ? URL.createObjectURL(f) : null)
    // Photo and location are captured together: a geotagged photo is the point.
    if (f && !coords) capture()
  }

  const submit = async (outcome: MissionOutcome) => {
    if (!session) return
    setBusy(true)
    setError(null)
    try {
      const { queued } = await runOrQueueSubmitMissionResult(
        {
          missionId: m.mission.id,
          incidentId: m.mission.incident_id,
          outcome,
          checklistResponse: responses,
          lat: coords?.lat ?? null,
          lng: coords?.lng ?? null,
          notes: typeof responses.notes === 'string' ? responses.notes : null,
          actorId: session.user.id,
          // A field officer IS an authorised officer — their confirmation is what
          // makes a source officially verified (plan §9).
          isAuthorisedOfficer: profile?.role === 'field_officer' || profile?.role === 'admin',
        },
        photo,
        `Mission result - Incident #${m.mission.incident_id}`,
      )

      // Queued for later sync: the incident-level follow-on writes below
      // depend on the mission result actually having landed, so they only
      // run for the immediate (online) path - the sync engine doesn't chain
      // them, since a queued mission result may itself still be pending or
      // rejected by the time it eventually replays.
      if (!queued) {
        const incident = m.incident
        if (incident) {
          const nextLevel = evidenceLevelAfterFieldOutcome(incident.source_confidence, outcome)
          if (nextLevel !== incident.source_confidence) {
            await updateSourceConfidence(
              incident.id,
              nextLevel,
              session.user.id,
              outcome === 'confirmed'
                ? 'An authorised officer confirmed the source on site.'
                : 'An officer visited and did not find the suspected source; the hypothesis returns to suspected.',
            )
          }
          const nextStatus = incidentStatusAfterFieldOutcome(incident.status, outcome)
          if (nextStatus !== incident.status) {
            await updateIncidentStatus(incident.id, nextStatus, session.user.id)
          }
        }
      }
      // The "Offline queue" card (rendered persistently above) picks up the
      // queued item immediately - no transient message here, since this
      // form collapses (via onDone) right after submitting either way.
      onDone()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not submit the mission.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-4">
      <Label dark>Checklist</Label>
      <div className="mt-1 divide-y divide-ink-900/5">
        {items.map((item) => (
          <ChecklistField
            key={item.id}
            item={item}
            value={responses[item.id]}
            onChange={(v) => setResponses((r) => ({ ...r, [item.id]: v }))}
          />
        ))}
      </div>

      <div className="mt-3">
        <Label dark>Geotagged proof</Label>
        {preview && <img src={preview} alt="Proof preview" className="mt-2 h-44 w-full rounded-xl object-cover" />}
        <div className="mt-2 flex flex-wrap gap-2">
          <label className="focus-ring cursor-pointer rounded-lg border border-ink-200 px-3 py-2 text-xs font-semibold text-ink-700 transition hover:bg-ink-50">
            {photo ? '📷 Photo attached' : '📷 Take photo'}
            <input type="file" accept="image/*" capture="environment" onChange={pickPhoto} className="hidden" />
          </label>
          <button
            type="button"
            onClick={capture}
            disabled={geoBusy}
            className="focus-ring rounded-lg border border-ink-200 px-3 py-2 text-xs font-semibold text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
          >
            {geoBusy ? 'Locating…' : coords ? '📍 Location attached' : '📍 Attach location'}
          </button>
        </div>
        {coords && (
          <p className="mt-1 text-[11px] tabular-nums text-ink-400">
            {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
          </p>
        )}
        {geoError && <p className="mt-1 text-[11px] text-status-warning">{geoError} Proof will be saved without GPS.</p>}
        {photo && !coords && !geoBusy && (
          <p className="mt-1 text-[11px] text-status-warning">
            This photo has no location attached - it is weaker evidence without one.
          </p>
        )}
      </div>

      <div className="mt-4">
        <Label dark>Was the suspected source there?</Label>
        <div className="mt-2 flex flex-wrap gap-2">
          {(Object.keys(OUTCOME_LABELS) as MissionOutcome[]).map((o) => (
            <button
              key={o}
              type="button"
              disabled={busy}
              onClick={() => submit(o)}
              className={`focus-ring flex-1 rounded-lg px-3 py-2.5 text-xs font-semibold transition disabled:opacity-50 ${OUTCOME_STYLE[o]}`}
            >
              {busy ? '…' : OUTCOME_LABELS[o]}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
          Confirming officially verifies the source. &ldquo;Source not present&rdquo; does not close the incident - the
          pollution may be real with a different cause, so it returns for review.
        </p>
      </div>

      {error && <p className="mt-2 text-xs text-status-critical">{error}</p>}
    </div>
  )
}

// ── Phase 4: intervention field completion ──────────────────────────────────

const WORKFLOW_STYLE: Record<string, string> = {
  assigned: 'bg-sky-100 text-sky-800',
  accepted: 'bg-sky-100 text-sky-800',
  in_progress: 'bg-amber-100 text-amber-800',
  completed: 'bg-ink-200 text-ink-700',
  verification_pending: 'bg-amber-100 text-amber-800',
}

function InterventionCompletionForm({ item, onDone }: { item: InterventionWithIncident; onDone: () => void }) {
  const { session } = useAuth()
  // Phase 5: an intervention created from a playbook carries a SNAPSHOT of
  // that playbook's own checklist, taken at selection time — stable even if
  // the master playbook is edited later (see the migration's comment on
  // `checklist_snapshot`). Only fall back to the generic per-category
  // checklist when there is no snapshot (a custom, non-playbook intervention).
  const items = parseChecklistSnapshot(item.action.checklist_snapshot) ?? checklistFor(item.leadingCategory)

  // Playbook hints (required proof / verification method) are informational
  // only — field officers already have RLS read access to
  // intervention_playbooks (Phase 2 policy), so this is a plain fetch, not a
  // new permission. Absent for a custom (non-playbook) intervention.
  const playbook = useAsync(
    () => (item.action.playbook_id != null ? getPlaybook(item.action.playbook_id) : Promise.resolve(null)),
    [item.action.playbook_id],
    { enabled: item.action.playbook_id != null },
  )

  const [responses, setResponses] = useState<Record<string, unknown>>({})
  const [sourceConfirmed, setSourceConfirmed] = useState<boolean | null>(null)
  const [actionPerformed, setActionPerformed] = useState('')
  const [photos, setPhotos] = useState<File[]>([])
  const [previews, setPreviews] = useState<string[]>([])
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [geoBusy, setGeoBusy] = useState(false)
  const [geoError, setGeoError] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState<string | null>(null)
  const [completedAt, setCompletedAt] = useState<string | null>(null)
  const [couldNotComplete, setCouldNotComplete] = useState(false)
  const [notCompletedReason, setNotCompletedReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const capture = () => {
    setGeoBusy(true)
    setGeoError(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setGeoBusy(false)
      },
      (e) => {
        setGeoError(e.message || 'Could not get your location.')
        setGeoBusy(false)
      },
      { timeout: 10_000, enableHighAccuracy: true },
    )
  }

  const addPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null
    if (!f) return
    setPhotos((p) => [...p, f])
    setPreviews((p) => [...p, URL.createObjectURL(f)])
    if (!coords) capture()
    e.target.value = ''
  }

  const submit = async () => {
    if (!session) return
    if (couldNotComplete && !notCompletedReason.trim()) {
      setError('Record why the action could not be completed.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await runOrQueueSubmitFieldCompletion(
        {
          actionId: item.action.id,
          incidentId: item.action.incident_id!,
          actorId: session.user.id,
          sourceConfirmed,
          actionPerformed,
          startedAt,
          completedAt: couldNotComplete ? null : (completedAt ?? new Date().toISOString()),
          checklistResponse: responses,
          lat: coords?.lat ?? null,
          lng: coords?.lng ?? null,
          notCompletedReason: couldNotComplete ? notCompletedReason.trim() : null,
        },
        photos,
        `Intervention completion - Incident #${item.action.incident_id}`,
      )
      // The "Offline queue" card (rendered persistently in MissionsView)
      // picks up a queued item immediately - no transient message needed
      // here, since this form collapses (via onDone) right after either way.
      onDone()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not submit the completion.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-4">
      {(playbook.data?.required_proof || playbook.data?.verification_method || item.action.playbook_notes_override) && (
        <div className="mb-3 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">
          {item.action.playbook_notes_override && <p className="italic">{item.action.playbook_notes_override}</p>}
          {playbook.data?.required_proof && (
            <p className="mt-1">
              <span className="font-semibold">What to bring back:</span> {playbook.data.required_proof}
            </p>
          )}
          {playbook.data?.verification_method && (
            <p className="mt-1">
              <span className="font-semibold">How this gets checked:</span> {playbook.data.verification_method}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!!startedAt}
          onClick={() => setStartedAt(new Date().toISOString())}
          className="focus-ring rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-semibold text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
        >
          {startedAt ? `Started ${new Date(startedAt).toLocaleTimeString()}` : 'Mark start time'}
        </button>
        <button
          type="button"
          disabled={!startedAt || !!completedAt || couldNotComplete}
          onClick={() => setCompletedAt(new Date().toISOString())}
          className="focus-ring rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-semibold text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
        >
          {completedAt ? `Completed ${new Date(completedAt).toLocaleTimeString()}` : 'Mark completion time'}
        </button>
      </div>

      <div className="mt-3">
        <Label dark>Was the source confirmed on site?</Label>
        <div className="mt-1 flex gap-1">
          {[
            { v: true, label: 'Confirmed' },
            { v: false, label: 'Not confirmed' },
          ].map(({ v, label }) => (
            <button
              key={label}
              type="button"
              onClick={() => setSourceConfirmed(sourceConfirmed === v ? null : v)}
              aria-pressed={sourceConfirmed === v}
              className={`focus-ring rounded-lg px-3 py-2 text-xs font-semibold transition ${
                sourceConfirmed === v ? 'bg-brand-700 text-white' : 'border border-ink-200 text-ink-600 hover:bg-ink-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <Label dark>Action performed</Label>
        <textarea
          rows={2}
          value={actionPerformed}
          onChange={(e) => setActionPerformed(e.target.value)}
          placeholder="What was actually done on site?"
          className="focus-ring mt-1 w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm"
        />
      </div>

      <div className="mt-3">
        <Label dark>Checklist</Label>
        <div className="mt-1 divide-y divide-ink-900/5">
          {items.map((item2) => (
            <ChecklistField
              key={item2.id}
              item={item2}
              value={responses[item2.id]}
              onChange={(v) => setResponses((r) => ({ ...r, [item2.id]: v }))}
            />
          ))}
        </div>
      </div>

      <div className="mt-3">
        <Label dark>Geotagged photographs</Label>
        {previews.length > 0 && (
          <div className="mt-2 grid grid-cols-3 gap-2">
            {previews.map((src, i) => (
              <img key={i} src={src} alt={`Proof ${i + 1}`} className="h-20 w-full rounded-lg object-cover" />
            ))}
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <label className="focus-ring cursor-pointer rounded-lg border border-ink-200 px-3 py-2 text-xs font-semibold text-ink-700 transition hover:bg-ink-50">
            📷 {photos.length ? `Add another (${photos.length} added)` : 'Add photo'}
            <input type="file" accept="image/*" capture="environment" onChange={addPhoto} className="hidden" />
          </label>
          <button
            type="button"
            onClick={capture}
            disabled={geoBusy}
            className="focus-ring rounded-lg border border-ink-200 px-3 py-2 text-xs font-semibold text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
          >
            {geoBusy ? 'Locating…' : coords ? '📍 Location attached' : '📍 Attach location'}
          </button>
        </div>
        {geoError && <p className="mt-1 text-[11px] text-status-warning">{geoError} Proof will be saved without GPS.</p>}
      </div>

      <div className="mt-3 rounded-lg bg-ink-50 p-3">
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={couldNotComplete}
            onChange={(e) => setCouldNotComplete(e.target.checked)}
            className="h-4 w-4"
          />
          This action could not be completed
        </label>
        {couldNotComplete && (
          <textarea
            rows={2}
            value={notCompletedReason}
            onChange={(e) => setNotCompletedReason(e.target.value)}
            placeholder="Why could this not be completed? (e.g. site inaccessible, source owner absent)"
            className="focus-ring mt-2 w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm"
          />
        )}
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={submit}
        className="focus-ring mt-4 w-full rounded-lg bg-brand-700 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-800 disabled:opacity-50"
      >
        {busy ? 'Submitting…' : couldNotComplete ? 'Submit - not completed' : 'Submit completion'}
      </button>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
        This records what happened operationally. It does not by itself mean pollution was reduced - the command
        workspace records that separately from a before/after reading.
      </p>

      {error && <p className="mt-2 text-xs text-status-critical">{error}</p>}
    </div>
  )
}

function InterventionsCard() {
  const { session } = useAuth()
  const [openId, setOpenId] = useState<number | null>(null)

  const state = useAsync(
    () => (session ? listInterventionsForOfficer(session.user.id) : Promise.resolve([])),
    [session?.user.id],
    { enabled: !!session },
  )

  const interventions = state.data ?? []
  const open = interventions.filter((i) => !isOutcomeStatus(i.action.workflow_status) && i.action.workflow_status !== 'completed')
  const awaitingResult = interventions.filter((i) => i.action.workflow_status === 'completed')

  if (!state.loading && !state.error && interventions.length === 0) return null

  return (
    <Card>
      <CardHeader
        title="Interventions assigned to me"
        subtitle="Actions to carry out on the ground"
        right={<span className="rounded-lg bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600">{open.length}</span>}
      />
      {state.loading ? (
        <div className="space-y-2 p-4">
          {[0].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={() => state.refresh()} />
      ) : open.length === 0 ? (
        <EmptyState icon="✅">No interventions waiting on you.</EmptyState>
      ) : (
        <ul className="divide-y divide-ink-900/5">
          {open.map((item) => {
            const expanded = openId === item.action.id
            return (
              <li key={item.action.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(expanded ? null : item.action.id)}
                  aria-expanded={expanded}
                  className="focus-ring w-full px-4 py-3 text-left transition hover:bg-ink-50"
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-brand-800">
                      {(item.action.type && PLAYBOOK_ACTION_TYPE_LABEL[item.action.type as PlaybookActionType]) ||
                        item.action.type ||
                        'intervention'}
                    </span>
                    {item.action.playbook_id == null && (
                      <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-ink-500">
                        Custom intervention
                      </span>
                    )}
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${WORKFLOW_STYLE[item.action.workflow_status] ?? 'bg-ink-100 text-ink-600'}`}
                    >
                      {WORKFLOW_STATUS_LABEL[item.action.workflow_status]}
                    </span>
                    <span className="ml-auto text-xs text-ink-400">{expanded ? '▲' : '▼'}</span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-ink-800">
                    {item.incident?.summary ?? `Incident #${item.action.incident_id}`}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    #{item.action.incident_id}
                    {item.incident?.ward_name && ` · ${item.incident.ward_name}`}
                    {item.action.deadline && ` · due ${new Date(item.action.deadline).toLocaleDateString()}`}
                  </p>
                  {item.action.recommended_action && (
                    <p className="mt-1.5 rounded-lg bg-brand-50 px-2.5 py-1.5 text-xs italic text-brand-800">
                      {item.action.recommended_action}
                    </p>
                  )}
                </button>
                {expanded && (
                  <div className="border-t border-ink-900/5 bg-white">
                    <InterventionCompletionForm
                      item={item}
                      onDone={() => {
                        setOpenId(null)
                        state.refresh()
                      }}
                    />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {awaitingResult.length > 0 && (
        <div className="border-t border-ink-900/5 px-4 py-2.5">
          <p className="text-xs text-ink-500">
            {awaitingResult.length} completed and awaiting a before/after impact evaluation from the command team.
          </p>
        </div>
      )}
    </Card>
  )
}

export default function MissionsView() {
  const { session } = useAuth()
  const [openId, setOpenId] = useState<number | null>(null)

  const state = useAsync(
    () => (session ? listMissionsForUser(session.user.id) : Promise.resolve([])),
    [session?.user.id],
    { enabled: !!session },
  )

  const missions = state.data ?? []
  const open = missions.filter((m) => m.mission.status !== 'completed' && m.mission.status !== 'cancelled')
  const done = missions.filter((m) => m.mission.status === 'completed')

  return (
    <AppShell subtitle="Evidence missions">
      <div className="mx-auto w-full max-w-2xl flex-1 space-y-3 overflow-y-auto p-4">
        <OfflineQueueStatus />

        {/* Dispatch tasks (Phase 9) are the routing/lifecycle WRAPPER around an
            intervention - acknowledge/accept/reject/start before the
            evidence/outcome capture below even becomes relevant. */}
        <FieldTaskDispatchCard />

        {/* Interventions (Phase 4) are a distinct task type from evidence
            missions - a mission asks "what is the source?", an intervention
            asks "go do something about it" - so they get separate cards rather
            than one undifferentiated list. */}
        <InterventionsCard />

        <Card>
          <CardHeader
            title="Assigned to me"
            subtitle="Evidence requests from the command centre"
            right={
              <span className="rounded-lg bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600">{open.length}</span>
            }
          />
          {state.loading ? (
            <div className="space-y-2 p-4">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : state.error ? (
            <ErrorState message={state.error} onRetry={() => state.refresh()} />
          ) : open.length === 0 ? (
            <EmptyState icon="✅">No evidence missions assigned to you.</EmptyState>
          ) : (
            <ul className="divide-y divide-ink-900/5">
              {open.map((m) => {
                const expanded = openId === m.mission.id
                return (
                  <li key={m.mission.id}>
                    <button
                      type="button"
                      onClick={() => setOpenId(expanded ? null : m.mission.id)}
                      aria-expanded={expanded}
                      className="focus-ring w-full px-4 py-3 text-left transition hover:bg-ink-50"
                    >
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-sky-800">
                          {m.mission.mission_type.replace(/_/g, ' ')}
                        </span>
                        <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-ink-600">
                          {m.mission.status}
                        </span>
                        <span className="ml-auto text-xs text-ink-400">{expanded ? '▲' : '▼'}</span>
                      </div>
                      <p className="mt-1 text-sm font-medium text-ink-800">
                        {m.incident?.summary ?? `Incident #${m.mission.incident_id}`}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-400">
                        #{m.mission.incident_id}
                        {m.incident?.ward_name && ` · ${m.incident.ward_name}`}
                        {m.leadingCategory && ` · suspected ${m.leadingCategory.replace(/_/g, ' ')}`}
                      </p>
                      {/* Why this evidence is needed - required by plan §10 */}
                      {m.mission.rationale && (
                        <p className="mt-1.5 rounded-lg bg-brand-50 px-2.5 py-1.5 text-xs italic text-brand-800">
                          {m.mission.rationale}
                        </p>
                      )}
                    </button>
                    {expanded && (
                      <div className="border-t border-ink-900/5 bg-white">
                        <MissionForm
                          m={m}
                          onDone={() => {
                            setOpenId(null)
                            state.refresh()
                          }}
                        />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        {done.length > 0 && (
          <Card>
            <CardHeader title="Completed" />
            <ul className="divide-y divide-ink-900/5">
              {done.map((m) => (
                <li key={m.mission.id} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                  <span className="text-ink-700">{m.incident?.summary ?? `Incident #${m.mission.incident_id}`}</span>
                  {m.mission.outcome && (
                    <span
                      className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                        m.mission.outcome === 'confirmed'
                          ? 'bg-green-100 text-green-800'
                          : m.mission.outcome === 'rejected'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-ink-100 text-ink-600'
                      }`}
                    >
                      {OUTCOME_LABELS[m.mission.outcome as MissionOutcome]}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </AppShell>
  )
}
