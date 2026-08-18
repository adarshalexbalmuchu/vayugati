import { useState } from 'react'
import { useAuth } from '../../lib/auth'
import { createEvidenceMission, listAssignableOfficers, type AssignableOfficer, type Incident } from '../../lib/incidents'
import { useAsync } from '../../lib/useAsync'
import { Modal, Skeleton } from '../ui'
import OptionPicker from './OptionPicker'

interface WardGroup {
  wardId: number | null
  wardName: string
  incidents: Incident[]
}

type SubmitResult = { incidentId: number; ok: boolean; error?: string }

/**
 * Bulk version of EvidenceMissionDialog - dispatches the same "smallest
 * useful evidence mission" to many incidents at once, grouped by ward
 * (field-officer assignment is ward-scoped - list_assignable_officers()
 * only returns officers who actually cover that ward, see the SQL
 * function's own comment). One officer picker per ward group, not per
 * incident, is the actual unblock: today, clearing a backlog of incidents
 * all needing evidence means opening the same dialog N times and picking
 * the same officer N times. This does it once per ward instead.
 *
 * Deliberately does NOT skip the officer requirement - an unassigned
 * mission reaches nobody (see EvidenceMissionDialog's own rationale). A
 * ward group with no assignable officer is shown as a real, honest
 * dead-end, not silently dropped or faked as sent.
 */
export default function BulkEvidenceMissionDialog({
  incidents,
  onClose,
  onCreated,
}: {
  incidents: Incident[]
  onClose: () => void
  onCreated: () => void
}) {
  const { session } = useAuth()
  const [rationale, setRationale] = useState(
    'Source confidence is insufficient to justify an action task. A geotagged field photograph is the smallest evidence that can corroborate or rule out the suspected source.',
  )
  const [assigneeByWard, setAssigneeByWard] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<SubmitResult[] | null>(null)

  // Every field officer city-wide, fetched once - list_assignable_officers(null)
  // returns all of them (each tagged with their own ward_id), so grouping and
  // filtering happens here in render rather than one hook call per ward group
  // (which would break the Rules of Hooks the moment the group count changes).
  const officers = useAsync(() => listAssignableOfficers(null), [])
  const officerList: AssignableOfficer[] = officers.data ?? []

  const groups: WardGroup[] = (() => {
    const byWard = new Map<string, WardGroup>()
    for (const i of incidents) {
      const key = String(i.ward_id ?? 'none')
      const group = byWard.get(key) ?? { wardId: i.ward_id, wardName: i.ward_name ?? 'Unknown ward', incidents: [] }
      group.incidents.push(i)
      byWard.set(key, group)
    }
    return [...byWard.values()].sort((a, b) => a.wardName.localeCompare(b.wardName))
  })()

  const officersForWard = (wardId: number | null) => officerList.filter((o) => o.ward_id === wardId)

  const readyCount = groups.reduce((n, g) => (assigneeByWard[String(g.wardId ?? 'none')] ? n + g.incidents.length : n), 0)

  const submit = async () => {
    if (!session) return
    setBusy(true)
    const out: SubmitResult[] = []
    for (const group of groups) {
      const assignee = assigneeByWard[String(group.wardId ?? 'none')]
      if (!assignee) continue // no officer chosen for this ward - skip, not fake-send
      for (const incident of group.incidents) {
        try {
          await createEvidenceMission({
            incidentId: incident.id,
            missionType: 'field_photo',
            assignedTo: assignee,
            rationale,
            publicPrompt: null,
            actorId: session.user.id,
          })
          out.push({ incidentId: incident.id, ok: true })
        } catch (e: unknown) {
          out.push({ incidentId: incident.id, ok: false, error: e instanceof Error ? e.message : 'Failed' })
        }
      }
    }
    setResults(out)
    setBusy(false)
    if (out.some((r) => r.ok)) onCreated()
  }

  if (results) {
    const succeeded = results.filter((r) => r.ok).length
    const failed = results.length - succeeded
    const skipped = incidents.length - results.length
    return (
      <Modal title="Evidence missions dispatched" onClose={onClose}>
        <p className="text-sm text-slate-700">
          {succeeded} mission{succeeded === 1 ? '' : 's'} created.
          {failed > 0 && ` ${failed} failed.`}
          {skipped > 0 && ` ${skipped} skipped - no officer was chosen for that ward.`}
        </p>
        {failed > 0 && (
          <ul className="mt-2 max-h-32 space-y-0.5 overflow-y-auto text-xs text-status-critical">
            {results
              .filter((r) => !r.ok)
              .map((r) => (
                <li key={r.incidentId}>
                  #{r.incidentId}: {r.error}
                </li>
              ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="focus-ring rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-700"
          >
            Done
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={`Request evidence for ${incidents.length} incidents`} onClose={onClose}>
      <p className="-mt-1 text-xs text-slate-400">
        Grouped by ward, since who can be assigned depends on which ward they cover. Choose one officer per ward -
        every incident in that ward gets the same mission.
      </p>

      {officers.loading ? (
        <Skeleton className="mt-3 h-24 w-full" />
      ) : officers.error ? (
        <p className="mt-3 text-xs text-status-critical">{officers.error}</p>
      ) : (
        <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
          {groups.map((group) => {
            const key = String(group.wardId ?? 'none')
            const wardOfficers = officersForWard(group.wardId)
            return (
              <div key={key} className="rounded-lg border border-slate-200 p-2.5">
                <p className="text-xs font-semibold text-slate-700">
                  {group.wardName} <span className="font-normal text-slate-400">({group.incidents.length})</span>
                </p>
                <OptionPicker
                  options={wardOfficers.map((o) => ({ value: o.id, label: o.full_name ?? o.id.slice(0, 8) }))}
                  value={assigneeByWard[key] ?? ''}
                  onChange={(v) => setAssigneeByWard((s) => ({ ...s, [key]: v }))}
                  emptyMessage={`No field officer covers this ward - these ${group.incidents.length} will be skipped.`}
                />
              </div>
            )
          })}
        </div>
      )}

      <label className="mt-3 block text-xs font-semibold text-slate-700">
        Why is this evidence needed? <span className="font-normal text-slate-400">(recorded on every incident)</span>
      </label>
      <textarea
        rows={3}
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
        className="focus-ring mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs"
      />

      <div className="mt-4 flex items-center justify-between gap-2">
        <p className="text-[11px] text-slate-400">
          {readyCount} of {incidents.length} will be dispatched
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="focus-ring rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !rationale.trim() || readyCount === 0}
            onClick={submit}
            className="focus-ring rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-700 disabled:opacity-50"
          >
            {busy ? 'Dispatching…' : `Dispatch ${readyCount}`}
          </button>
        </div>
      </div>
    </Modal>
  )
}
