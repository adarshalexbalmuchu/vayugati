import { useState } from 'react'
import { useAuth } from '../../lib/auth'
import { createEvidenceMission, listAssignableOfficers, listLinkedReports, type Incident } from '../../lib/incidents'
import { useAsync } from '../../lib/useAsync'
import { Modal, Skeleton } from '../ui'
import OptionPicker from './OptionPicker'

const MISSION_TYPE_OPTIONS = [
  { value: 'field_photo' as const, label: 'Geotagged field photograph', description: 'An officer visits and photographs the source in place.' },
  { value: 'source_status_check' as const, label: 'Source operating-status check', description: 'An officer confirms whether the suspected source is currently operating.' },
  { value: 'citizen_verification' as const, label: 'Targeted citizen verification', description: 'Ask the person who reported this whether it is still happening.' },
]

/**
 * Next-best-evidence dialog (plan §10). The rationale is mandatory — the system
 * must always say WHY the evidence is needed, not just ask for it — and a
 * mission with no assignee would never reach anyone, so the officer picker is
 * part of dispatching rather than an afterthought.
 *
 * Every choice here (mission type, who it goes to) is a small, fully visible
 * list via OptionPicker rather than a native <select> - with only 3 mission
 * types and typically a handful of officers per ward, hiding them behind a
 * dropdown costs more in "what all things do we have" clarity than it saves
 * in space.
 */
export default function EvidenceMissionDialog({
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
  const officerList = officers.data ?? []
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
    <Modal title="Request the next best evidence" onClose={onClose}>
      <p className="-mt-1 text-xs text-slate-400">
        The smallest useful mission that would raise or rule out confidence in this source.
      </p>

      <label className="mt-3 block text-xs font-semibold text-slate-700">Mission type</label>
      <OptionPicker
        options={MISSION_TYPE_OPTIONS}
        value={missionType}
        onChange={(v) => {
          setMissionType(v)
          setAssignee('')
        }}
      />

      <label className="mt-3 block text-xs font-semibold text-slate-700">
        {isCitizenMission ? 'Ask which reporter' : 'Assign to'}
      </label>
      {(isCitizenMission ? reporters.loading : officers.loading) ? (
        <Skeleton className="mt-1 h-9 w-full" />
      ) : (isCitizenMission ? reporters.error : officers.error) ? (
        <p className="mt-1 text-xs text-status-critical">{isCitizenMission ? reporters.error : officers.error}</p>
      ) : isCitizenMission ? (
        <OptionPicker
          options={reporterList.map((r) => ({
            value: r.reporter_id ?? '',
            label: `Reporter of #${r.id}`,
            description: new Date(r.created_at).toLocaleDateString(),
          }))}
          value={assignee}
          onChange={setAssignee}
          emptyMessage="No citizen reports are linked to this incident, so there is nobody to ask. Use an officer mission instead."
        />
      ) : (
        <OptionPicker
          options={officerList.map((o) => ({ value: o.id, label: o.full_name ?? o.id.slice(0, 8) }))}
          value={assignee}
          onChange={setAssignee}
          // Honest dead-end: a real operational state (no officer covers this
          // ward), not an empty dropdown to shrug at.
          emptyMessage="No field officer is assigned to this ward, so this mission cannot be dispatched. Ask an admin to assign a field officer to this ward before dispatching."
        />
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
    </Modal>
  )
}
