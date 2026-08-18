import { useState } from 'react'
import { useAuth } from './auth'
import { nextActionLabel, taskBlockedReason } from './incidentRules'
import { reopenIncident, updateIncidentAssignment, updateIncidentStatus, type IncidentDetail } from './incidents'

export interface RecommendedAction {
  key: 'evidence' | 'route'
  label: string
  helper: string
}

/**
 * The incident action toolbar's mutation logic, extracted into a hook so the
 * persistent case header (More actions menu) and the Summary tab (the
 * primary recommended-action button) can share one source of truth instead
 * of two independent copies of the same busy/error state and Close gate.
 *
 * Close's gate mirrors enforce_incident_closure_rules() exactly (a
 * completed/verification_pending action with no linked impact_evaluations
 * row blocks closure) from data already loaded in `detail`, so the button
 * is disabled and explained BEFORE submit, not after a raw DB error.
 */
export function useIncidentActions(detail: IncidentDetail, onRefresh: () => void) {
  const { incident, interventions, impactEvaluations } = detail
  const { session } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missionOpen, setMissionOpen] = useState(false)

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

  const requestEvidence = () => setMissionOpen(true)

  const route = () => {
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

  const closeBlocked = interventions.some(
    (iv) =>
      (iv.action.workflow_status === 'completed' || iv.action.workflow_status === 'verification_pending') &&
      !impactEvaluations.some((e) => e.action_id === iv.action.id),
  )

  const nextAction = incident.status === 'closed' ? null : nextActionLabel(incident)
  const recommended: RecommendedAction | null =
    nextAction === 'Needs evidence'
      ? { key: 'evidence', label: 'Request evidence', helper: 'Collect evidence to corroborate the suspected source before this can be routed.' }
      : nextAction === 'Ready to route'
        ? { key: 'route', label: 'Route to authority', helper: 'Evidence is corroborated — route this to the responsible authority.' }
        : null

  return {
    busy,
    error,
    missionOpen,
    closeMissionDialog: () => setMissionOpen(false),
    onMissionCreated: () => {
      setMissionOpen(false)
      onRefresh()
    },
    requestEvidence,
    route,
    close,
    reopen,
    inspectionBlocked,
    closeBlocked,
    nextAction,
    recommended,
  }
}

export type IncidentActions = ReturnType<typeof useIncidentActions>
