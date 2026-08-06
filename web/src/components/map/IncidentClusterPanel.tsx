import { AlertTriangle, ArrowUpRight, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { SOURCE_CATEGORY_LABEL, type Severity } from '../../lib/incidentRules'
import type { Incident } from '../../lib/incidents'
import {
  buildClusterPanelData,
  fmtClusterAge,
  type ClusterPanelData,
} from '../../lib/incidentClusterRules'
import type { SourceCategory } from '../../lib/incidentRules'

const SEVERITY_TONE: Record<Severity, { badge: string; dot: string }> = {
  severe: { badge: 'bg-status-critical/10 text-status-critical ring-status-critical/30', dot: 'bg-status-critical' },
  high: { badge: 'bg-status-warning/10 text-status-warning ring-status-warning/30', dot: 'bg-status-warning' },
  moderate: { badge: 'bg-status-warning/5 text-status-warning ring-status-warning/20', dot: 'bg-status-warning/60' },
  low: { badge: 'bg-slate-100 text-slate-500 ring-slate-200', dot: 'bg-slate-400' },
}

const SEVERITY_LABEL: Record<Severity, string> = {
  severe: 'Severe',
  high: 'High',
  moderate: 'Moderate',
  low: 'Low',
}

function SeverityBadge({ severity }: { severity: Severity }) {
  const tone = SEVERITY_TONE[severity]
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ring-1 ring-inset ${tone.badge}`}>
      {SEVERITY_LABEL[severity]}
    </span>
  )
}

function BreakdownRow({ label, count, severity }: { label: string; count: number; severity: Severity }) {
  const tone = SEVERITY_TONE[severity]
  return (
    <div className="flex items-center gap-2">
      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${tone.dot}`} aria-hidden />
      <span className="text-xs text-slate-700">{label}</span>
      <span className="ml-auto text-xs font-semibold text-slate-800">{count}</span>
    </div>
  )
}

export default function IncidentClusterPanel({
  incidents,
  leadingSourceById,
  onClose,
}: {
  incidents: Incident[]
  leadingSourceById: Map<number, SourceCategory>
  onClose: () => void
}) {
  const data: ClusterPanelData = buildClusterPanelData(incidents, leadingSourceById)

  const { breakdown, highestSeverity, categories, wardNames, oldestOpenMinutes, overdueCount, assignedCount, unassignedCount } = data

  const hasBreakdown = breakdown.severe + breakdown.high + breakdown.moderate + breakdown.low > 0

  return (
    <div className="p-4">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Incident Cluster</p>
          <h2 className="text-sm font-semibold text-slate-800">
            {data.count} active incident{data.count !== 1 ? 's' : ''}
          </h2>
        </div>
        <div className="flex items-center gap-1.5">
          {highestSeverity && <SeverityBadge severity={highestSeverity} />}
          <button
            type="button"
            onClick={onClose}
            className="focus-ring rounded p-1 text-slate-400 hover:bg-slate-100"
            aria-label="Close cluster panel"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {/* Overdue alert */}
      {overdueCount > 0 && (
        <div className="mb-3 flex items-center gap-1.5 rounded-md bg-status-critical/5 px-2.5 py-1.5 text-xs text-status-critical ring-1 ring-inset ring-status-critical/20">
          <AlertTriangle className="h-3 w-3 flex-shrink-0" aria-hidden />
          {overdueCount} incident{overdueCount !== 1 ? 's' : ''} past 24-h escalation SLA
        </div>
      )}

      <dl className="space-y-3 text-xs">
        {/* Severity breakdown */}
        {hasBreakdown && (
          <div>
            <dt className="mb-1.5 text-slate-400">Severity breakdown</dt>
            <dd className="space-y-1.5">
              {breakdown.severe > 0 && <BreakdownRow label="Severe" count={breakdown.severe} severity="severe" />}
              {breakdown.high > 0 && <BreakdownRow label="High" count={breakdown.high} severity="high" />}
              {breakdown.moderate > 0 && <BreakdownRow label="Moderate" count={breakdown.moderate} severity="moderate" />}
              {breakdown.low > 0 && <BreakdownRow label="Low / unclassified" count={breakdown.low} severity="low" />}
            </dd>
          </div>
        )}

        {/* Assignment */}
        <div className="grid grid-cols-2 gap-x-3">
          <div>
            <dt className="text-slate-400">Assigned</dt>
            <dd className="font-semibold text-slate-800">{assignedCount}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Unassigned</dt>
            <dd className={`font-semibold ${unassignedCount > 0 ? 'text-status-warning' : 'text-slate-800'}`}>
              {unassignedCount}
            </dd>
          </div>
        </div>

        {/* Oldest open */}
        {oldestOpenMinutes != null && (
          <div>
            <dt className="text-slate-400">Oldest open</dt>
            <dd className={`font-semibold ${oldestOpenMinutes > 24 * 60 ? 'text-status-critical' : 'text-slate-800'}`}>
              {fmtClusterAge(oldestOpenMinutes)}
            </dd>
          </div>
        )}

        {/* Wards */}
        {wardNames.length > 0 && (
          <div>
            <dt className="text-slate-400">Wards ({wardNames.length})</dt>
            <dd className="mt-0.5 flex flex-wrap gap-1">
              {wardNames.map((name) => (
                <span key={name} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700">
                  {name}
                </span>
              ))}
            </dd>
          </div>
        )}

        {/* Source categories */}
        {categories.length > 0 && (
          <div>
            <dt className="text-slate-400">Source categories</dt>
            <dd className="mt-0.5 flex flex-wrap gap-1">
              {categories.map((cat) => (
                <span key={cat} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700">
                  {SOURCE_CATEGORY_LABEL[cat] ?? cat.replace(/_/g, ' ')}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>

      {/* Individual incident list */}
      <div className="mt-4">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Incidents in cluster</p>
        <ul className="space-y-1">
          {incidents.map((inc) => {
            const sev = (inc.severity ?? null) as Severity | null
            return (
              <li key={inc.id}>
                <Link
                  to={`/incidents?incident=${inc.id}`}
                  className="focus-ring flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                >
                  {sev && (
                    <span
                      className={`h-2 w-2 flex-shrink-0 rounded-full ${SEVERITY_TONE[sev].dot}`}
                      aria-label={sev}
                    />
                  )}
                  <span className="flex-1 truncate">{inc.summary ?? `Incident #${inc.id}`}</span>
                  <span className="flex-shrink-0 text-[10px] text-slate-400">#{inc.id}</span>
                  <ArrowUpRight className="h-3 w-3 flex-shrink-0 text-slate-300" aria-hidden />
                </Link>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
