import { ArrowUpRight, MapPin, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { CONFIDENCE_LABEL, type Severity } from '../../lib/incidentRules'
import type { Incident } from '../../lib/incidents'
import {
  deriveLocationQuality,
  LOCATION_QUALITY_HEX,
  LOCATION_QUALITY_LABEL,
} from '../../lib/incidentLocationRules'

const SEVERITY_TONE: Record<Severity, string> = {
  severe: 'text-status-critical ring-status-critical/40',
  high: 'text-status-warning ring-status-warning/40',
  moderate: 'text-status-warning ring-status-warning/30',
  low: 'text-slate-500 ring-slate-300',
}

/** Deliberately thin - the Incidents page's own detail workspace
 *  (IncidentStatusHeader/tabs) is the authoritative place for the full
 *  picture. This is a map-context preview with a prominent link out. */
export default function SelectedIncidentPanel({
  incident,
  nearestStation = null,
  onClose,
}: {
  incident: Incident
  /** Nearest AQ station to this incident's location - null when unavailable. */
  nearestStation?: {
    name: string
    distanceMeters: number
    isStale: boolean
    ageMinutes: number | null
    readingSource: string
  } | null
  onClose: () => void
}) {
  const severity = (incident.severity ?? null) as Severity | null
  const locationQuality = deriveLocationQuality(incident)
  const needsLocationReview = locationQuality.status === 'missing' || locationQuality.status === 'needs_review' || locationQuality.status === 'ward_mismatch' || locationQuality.status === 'outside_area'

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

        {/* Location quality */}
        <div className="col-span-2">
          <dt className="text-slate-400">Location</dt>
          <dd className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
              style={{ background: LOCATION_QUALITY_HEX[locationQuality.status] }}
              aria-hidden
            />
            <span className="font-semibold text-slate-800">{LOCATION_QUALITY_LABEL[locationQuality.status]}</span>
            {locationQuality.source && locationQuality.source !== 'unknown_legacy' && (
              <span className="text-slate-400">· {locationQuality.source.replace(/_/g, ' ')}</span>
            )}
          </dd>
          {locationQuality.status === 'ward_mismatch' && locationQuality.containingWardName && (
            <dd className="mt-0.5 text-[11px] text-status-warning">
              Point falls in {locationQuality.containingWardName} — ward record differs
            </dd>
          )}
          {locationQuality.status === 'missing' && incident.ward_name && (
            <dd className="mt-0.5 text-[11px] text-slate-400">
              Ward supplied: {incident.ward_name}
            </dd>
          )}
        </div>

        {nearestStation != null && (
          <div className="col-span-2">
            <dt className="text-slate-400">Nearest AQ station</dt>
            <dd>
              <span className="font-semibold text-slate-800">{nearestStation.name}</span>
              {' '}
              <span className="font-normal text-slate-400">
                — {nearestStation.distanceMeters < 1000
                  ? `${Math.round(nearestStation.distanceMeters)} m`
                  : `${(nearestStation.distanceMeters / 1000).toFixed(1)} km`} straight-line
              </span>
              <br />
              <span className={`text-[10px] ${nearestStation.isStale ? 'text-status-warning' : 'text-status-success'}`}>
                {nearestStation.isStale
                  ? `Stale · last reading ${nearestStation.ageMinutes != null ? nearestStation.ageMinutes < 60 ? `${nearestStation.ageMinutes}m ago` : `${Math.round(nearestStation.ageMinutes / 60)}h ago` : 'unknown'}`
                  : 'Fresh'}
              </span>
              <span className="text-[10px] text-slate-400"> · {nearestStation.readingSource}</span>
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-4 space-y-1.5">
        <Link
          to={`/incidents?incident=${incident.id}`}
          className="focus-ring flex items-center justify-center gap-1.5 rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-700"
        >
          Open in Incidents workspace
          <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        </Link>

        {needsLocationReview && (
          <Link
            to={`/incidents/remediation?incident=${incident.id}`}
            className="focus-ring flex items-center justify-center gap-1.5 rounded-lg border border-status-warning/40 bg-status-warning/5 px-3 py-1.5 text-xs font-semibold text-status-warning transition hover:bg-status-warning/10"
          >
            <MapPin className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Review location
          </Link>
        )}
      </div>
    </div>
  )
}
