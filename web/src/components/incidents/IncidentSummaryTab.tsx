import {
  CONFIDENCE_LABEL,
  POLLUTANT_LABEL,
  resolveIncidentPollutant,
  sourceCategoryLabel,
} from '../../lib/incidentRules'
import type { IncidentActions } from '../../lib/useIncidentActions'
import type { IncidentDetail } from '../../lib/incidents'
import EvidenceMissionDialog from './EvidenceMissionDialog'
import PredictedIncidentPanel from '../PredictedIncidentPanel'
import RecurrencePanel from '../RecurrencePanel'

const CLOSE_BLOCKED_NOTE =
  'This incident has a completed action with no impact evaluation. Record whether pollution actually changed (Action tab) before closing.'

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits)
}

function fmtAge(ts: string): string {
  const h = (Date.now() - new Date(ts).getTime()) / 3_600_000
  if (h < 1) return 'less than an hour ago'
  if (h < 48) return `${Math.floor(h)}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function Question({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-slate-100 px-4 py-3 first:border-t-0">
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">{title}</p>
      {children}
    </section>
  )
}

/**
 * The Summary tab - the whole case, organized around the four questions a
 * commander actually needs answered, once each: what happened, how serious
 * is it, what caused it, what should I do next. Everything else this
 * incident carries (the full evidence log, the ranked source hypotheses,
 * intervention/dispatch tracking, the raw detection facts) lives one tab
 * away or behind a disclosure - Summary's job is to let someone reach a
 * judgment without reading nine facts and three cards to get there.
 */
export default function IncidentSummaryTab({
  detail,
  actions,
  onRefresh,
  onGoToEvidence,
}: {
  detail: IncidentDetail
  actions: IncidentActions
  onRefresh: () => void
  onGoToEvidence: () => void
}) {
  const { incident, anomalyCandidates, hypotheses } = detail
  const latest = anomalyCandidates[0] ?? null
  const pollutant = resolveIncidentPollutant(incident.primary_pollutant, latest?.pollutant ?? null)
  const currentHypothesis = hypotheses.find((h) => h.is_current) ?? null

  return (
    <div>
      <Question title="What happened?">
        <p className="text-sm text-slate-700">
          {pollutant ? POLLUTANT_LABEL[pollutant] : 'A pollutant'} exceeded safe levels at{' '}
          {incident.ward_name ?? 'this ward'}.
        </p>
        <p className="mt-1 text-xs text-slate-400">
          {latest?.current_concentration != null && latest?.threshold_used != null
            ? `Reached ${fmt(latest.current_concentration)} µg/m³ against a threshold of ${fmt(latest.threshold_used)}, first detected ${fmtAge(incident.detected_at)}.`
            : `Reported ${fmtAge(incident.detected_at)} via ${incident.detection_method.replace(/_/g, ' ')}.`}
        </p>
      </Question>

      <Question title="How serious is it?">
        {incident.local_excess != null ? (
          <p className="text-sm text-slate-700">
            <span className="font-semibold tabular-nums">+{Math.round(incident.local_excess)} µg/m³</span> above what's
            normal for this ward.
          </p>
        ) : (
          <p className="text-sm text-slate-400">No forecast baseline available to compare against.</p>
        )}
      </Question>

      <Question title="What caused it?">
        {currentHypothesis?.source_category ? (
          <p className="text-sm text-slate-700">
            Likely <span className="font-semibold">{sourceCategoryLabel(currentHypothesis.source_category)}</span> —{' '}
            {CONFIDENCE_LABEL[currentHypothesis.confidence_level].toLowerCase()} (
            <span className="tabular-nums">{Math.round(currentHypothesis.probability * 100)}%</span>)
          </p>
        ) : (
          <p className="text-sm text-slate-400">No source hypothesis calculated yet.</p>
        )}
        {incident.classification && (
          <p className="mt-1 text-xs capitalize text-slate-400">{incident.classification} pollution event.</p>
        )}
        <button
          type="button"
          onClick={onGoToEvidence}
          className="focus-ring mt-1.5 text-xs font-semibold text-accent-700 hover:text-accent-800"
        >
          Full attribution analysis →
        </button>
      </Question>

      <Question title="What should I do next?">
        {actions.recommended ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-600">{actions.recommended.helper}</p>
            <button
              type="button"
              disabled={actions.busy}
              onClick={actions.recommended.key === 'evidence' ? actions.requestEvidence : actions.route}
              className="focus-ring flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-700 disabled:opacity-50"
            >
              {actions.recommended.label}
            </button>
          </div>
        ) : incident.status === 'closed' ? (
          <p className="text-sm text-slate-400">Closed — reopen from the header if this recurs.</p>
        ) : (
          <p className="text-sm text-slate-400">{actions.nextAction}</p>
        )}
        {incident.assigned_authority && (
          <p className="mt-1 text-xs text-slate-400">Routed to {incident.assigned_authority}.</p>
        )}

        {/* Every other action is plainly visible here too, not hidden behind
            a menu - whichever of these isn't already the recommendation
            above still needs to be findable without opening anything first. */}
        {incident.status !== 'closed' && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 border-t border-slate-100 pt-2.5">
            {actions.recommended?.key !== 'evidence' && (
              <button
                type="button"
                disabled={actions.busy}
                onClick={actions.requestEvidence}
                className="focus-ring text-xs font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-40"
              >
                Request evidence
              </button>
            )}
            {actions.recommended?.key !== 'route' && (
              <div>
                <button
                  type="button"
                  disabled={actions.busy || !!actions.inspectionBlocked}
                  onClick={actions.route}
                  className="focus-ring text-xs font-semibold text-slate-500 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Route to authority
                </button>
                {actions.inspectionBlocked && <p className="mt-0.5 max-w-[220px] text-[10px] leading-snug text-slate-400">{actions.inspectionBlocked}</p>}
              </div>
            )}
            <div>
              <button
                type="button"
                disabled={actions.busy || actions.closeBlocked}
                onClick={actions.close}
                className="focus-ring text-xs font-semibold text-slate-500 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Close incident
              </button>
              {actions.closeBlocked && <p className="mt-0.5 max-w-[220px] text-[10px] leading-snug text-slate-400">{CLOSE_BLOCKED_NOTE}</p>}
            </div>
          </div>
        )}

        <PredictedIncidentPanel detail={detail} onRefresh={onRefresh} />
        <RecurrencePanel detail={detail} onRefresh={onRefresh} />
      </Question>

      {actions.missionOpen && (
        <EvidenceMissionDialog incident={incident} onClose={actions.closeMissionDialog} onCreated={actions.onMissionCreated} />
      )}
    </div>
  )
}
