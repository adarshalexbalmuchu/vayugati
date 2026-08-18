import { AlertTriangle } from 'lucide-react'
import {
  CONFIDENCE_LABEL,
  currentReading,
  ESCALATION_SLA_HOURS,
  isEscalated,
  nextActionLabel,
  type Severity,
} from '../../lib/incidentRules'
import type { Incident } from '../../lib/incidents'

// Severity now reads as an ambient left-edge accent rather than a
// competing badge - "Severity unavailable" no longer needs a pill of its
// own on the (common) rows where there's no forecast to derive it from.
const SEVERITY_BORDER: Record<Severity, string> = {
  severe: 'border-status-critical',
  high: 'border-status-warning',
  moderate: 'border-status-warning/60',
  low: 'border-slate-300',
}

const NEXT_ACTION_TONE: Record<string, string> = {
  'Needs evidence': 'bg-status-warning/10 text-status-warning',
  'Ready to route': 'bg-accent-100 text-accent-800',
  'Awaiting dispatch': 'bg-slate-100 text-slate-600',
  'In progress': 'bg-slate-100 text-slate-600',
  'Awaiting verification': 'bg-accent-100 text-accent-800',
}

function fmtAge(ts: string): string {
  const h = (Date.now() - new Date(ts).getTime()) / 3_600_000
  if (h < 1) return '<1h'
  if (h < 48) return `${Math.floor(h)}h`
  return `${Math.floor(h / 24)}d`
}

function ReadingBadge({ wardAqi, localExcess }: { wardAqi: number | null; localExcess: number | null }) {
  const reading = currentReading(wardAqi, localExcess)
  if (reading.kind === 'live') {
    return <span className="tabular-nums text-slate-700">AQI {reading.aqi}</span>
  }
  if (reading.kind === 'forecast') {
    return <span className="tabular-nums text-slate-500">+{Math.round(reading.excess)} µg/m³ excess</span>
  }
  return <span className="text-slate-300">No reading</span>
}

export default function IncidentListItem({
  incident,
  wardAqi,
  selected,
  onSelect,
  checked,
  onToggleCheck,
}: {
  incident: Incident
  wardAqi: number | null
  selected: boolean
  onSelect: () => void
  /** Undefined when this row isn't eligible for the bulk evidence-request
   *  action (only 'suspected' incidents are) - no checkbox rendered then. */
  checked?: boolean
  onToggleCheck?: () => void
}) {
  const severity = (incident.severity ?? null) as Severity | null
  const escalated = isEscalated(incident)
  const nextAction = nextActionLabel(incident)
  const checkable = onToggleCheck != null

  return (
    <li
      className={`flex items-start gap-1 border-l-[3px] pr-2 transition ${
        selected
          ? 'border-accent-600 bg-accent-50'
          : `${severity ? SEVERITY_BORDER[severity] : 'border-slate-200'} hover:bg-slate-50`
      }`}
    >
      {checkable && (
        <input
          type="checkbox"
          checked={checked ?? false}
          onChange={onToggleCheck}
          aria-label="Select for bulk evidence request"
          className="focus-ring mt-3 ml-2 h-3.5 w-3.5 flex-shrink-0 rounded border-slate-300"
        />
      )}
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={`focus-ring min-w-0 flex-1 py-2 text-left ${checkable ? 'pl-1.5' : 'pl-3'}`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-semibold text-slate-800">
            {incident.ward_name ?? `Incident #${incident.id}`}
            {incident.primary_pollutant && (
              <span className="ml-1 font-normal uppercase text-slate-400">· {incident.primary_pollutant}</span>
            )}
          </p>
          <span className="flex-shrink-0 text-[11px] tabular-nums text-slate-400">{fmtAge(incident.detected_at)}</span>
        </div>

        <div className="mt-0.5 flex items-center gap-x-1.5 text-[11px] text-slate-500">
          <ReadingBadge wardAqi={wardAqi} localExcess={incident.local_excess} />
          <span>· {CONFIDENCE_LABEL[incident.source_confidence]}</span>
          {escalated && (
            <span title={`Open longer than ${ESCALATION_SLA_HOURS}h with nothing dispatched`}>
              <AlertTriangle className="h-3 w-3 flex-shrink-0 text-status-critical" strokeWidth={2.5} aria-hidden />
            </span>
          )}
        </div>

        {nextAction && (
          <span
            className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
              NEXT_ACTION_TONE[nextAction] ?? 'bg-slate-100 text-slate-600'
            }`}
          >
            {nextAction}
          </span>
        )}
      </button>
    </li>
  )
}
