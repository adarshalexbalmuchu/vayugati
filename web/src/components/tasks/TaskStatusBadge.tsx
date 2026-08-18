import { TASK_DISPATCH_STATUS_LABEL, type TaskDispatchStatus } from '../../lib/incidentRules'

// Same critical/warning/success/info/neutral semantic grouping already
// established for incident severity (IncidentListItem.tsx/IncidentCaseHeader.tsx)
// and hotspot status (HotspotsRiskTable.tsx) - not a new tone vocabulary.
const STATUS_TONE: Record<TaskDispatchStatus, string> = {
  drafted: 'text-slate-500 ring-slate-300',
  awaiting_approval: 'text-status-info ring-status-info/40',
  approved: 'text-status-info ring-status-info/40',
  routed: 'text-status-info ring-status-info/40',
  sent: 'text-status-info ring-status-info/40',
  acknowledged: 'text-status-warning ring-status-warning/40',
  accepted: 'text-status-warning ring-status-warning/40',
  in_progress: 'text-status-warning ring-status-warning/40',
  completed: 'text-status-success ring-status-success/40',
  verification_pending: 'text-status-info ring-status-info/40',
  overdue: 'text-status-critical ring-status-critical/40',
  escalated: 'text-status-critical ring-status-critical/40',
  rejected: 'text-status-critical ring-status-critical/40',
  rerouted: 'text-status-warning ring-status-warning/40',
  cancelled: 'text-slate-500 ring-slate-300',
}

const STATUS_DOT: Record<TaskDispatchStatus, string> = {
  drafted: 'bg-slate-400',
  awaiting_approval: 'bg-status-info',
  approved: 'bg-status-info',
  routed: 'bg-status-info',
  sent: 'bg-status-info',
  acknowledged: 'bg-status-warning',
  accepted: 'bg-status-warning',
  in_progress: 'bg-status-warning',
  completed: 'bg-status-success',
  verification_pending: 'bg-status-info',
  overdue: 'bg-status-critical',
  escalated: 'bg-status-critical',
  rejected: 'bg-status-critical',
  rerouted: 'bg-status-warning',
  cancelled: 'bg-slate-400',
}

export default function TaskStatusBadge({ status }: { status: TaskDispatchStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${STATUS_TONE[status]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} aria-hidden />
      {TASK_DISPATCH_STATUS_LABEL[status]}
    </span>
  )
}

// Reuses the incident severity vocabulary as this dispatch's priority
// signal (see ActiveTaskDispatch.incident_severity's own doc comment) -
// same tone mapping already established in IncidentListItem.tsx/
// IncidentStatusHeader.tsx, not a new scale.
const PRIORITY_TONE: Record<string, string> = {
  severe: 'text-status-critical ring-status-critical/40',
  high: 'text-status-warning ring-status-warning/40',
  moderate: 'text-status-warning ring-status-warning/30',
  low: 'text-slate-500 ring-slate-300',
}

export function TaskPriorityBadge({ severity }: { severity: string | null }) {
  if (!severity) {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-400 ring-1 ring-inset ring-slate-200">
        Unknown
      </span>
    )
  }
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase ring-1 ring-inset ${
        PRIORITY_TONE[severity] ?? 'text-slate-500 ring-slate-300'
      }`}
    >
      {severity}
    </span>
  )
}
