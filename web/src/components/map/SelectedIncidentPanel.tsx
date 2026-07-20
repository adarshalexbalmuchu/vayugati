import { ArrowUpRight, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { CONFIDENCE_LABEL, type Severity } from '../../lib/incidentRules'
import type { Incident } from '../../lib/incidents'

const SEVERITY_TONE: Record<Severity, string> = {
  severe: 'text-status-critical ring-status-critical/40',
  high: 'text-status-warning ring-status-warning/40',
  moderate: 'text-status-warning ring-status-warning/30',
  low: 'text-slate-500 ring-slate-300',
}

/** Deliberately thin - the Incidents page's own detail workspace
 *  (IncidentStatusHeader/tabs) is the authoritative place for the full
 *  picture. This is a map-context preview with a prominent link out. */
export default function SelectedIncidentPanel({ incident, onClose }: { incident: Incident; onClose: () => void }) {
  const severity = (incident.severity ?? null) as Severity | null

  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Incident #{incident.id}</p>
          <h2 className="text-sm font-semibold text-slate-800">{incident.summary ?? `Incident #${incident.id}`}</h2>
        </div>
        <button type="button" onClick={onClose} className="focus-ring rounded p-1 text-slate-400 hover:bg-slate-100">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <div>
          <dt className="text-slate-400">Ward</dt>
          <dd className="font-semibold text-slate-800">{incident.ward_name ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Pollutant</dt>
          <dd className="font-semibold uppercase text-slate-800">{incident.primary_pollutant ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Severity</dt>
          <dd>
            {severity ? (
              <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ring-1 ring-inset ${SEVERITY_TONE[severity]}`}>
                {severity}
              </span>
            ) : (
              <span className="text-slate-400">Unavailable</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Evidence level</dt>
          <dd className="font-semibold text-slate-800">{CONFIDENCE_LABEL[incident.source_confidence]}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-slate-400">Status</dt>
          <dd className="font-semibold capitalize text-slate-800">{incident.status.replace(/_/g, ' ')}</dd>
        </div>
      </dl>

      <Link
        to={`/incidents?incident=${incident.id}`}
        className="focus-ring mt-4 flex items-center justify-center gap-1.5 rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-700"
      >
        Open in Incidents workspace
        <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
      </Link>
    </div>
  )
}
