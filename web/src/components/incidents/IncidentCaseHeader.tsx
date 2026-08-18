import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react'
import { aqiBandLabel, currentReading, POLLUTANT_LABEL, resolveIncidentPollutant } from '../../lib/incidentRules'
import type { IncidentActions } from '../../lib/useIncidentActions'
import type { IncidentDetail } from '../../lib/incidents'

/** AQI reads as an alarm signal at a glance - a 3-tier split (moderate =
 *  warning, poor-and-worse = critical), not the full 6-band CPCB color
 *  scale, which would need 6 new colors just for this one number. The band
 *  NAME next to it (aqiBandLabel) carries the finer-grained "how bad"
 *  reading, in plain text rather than a second colored badge. */
function aqiTone(aqi: number): string {
  if (aqi >= 200) return 'text-status-critical'
  if (aqi >= 100) return 'text-status-warning'
  return 'text-slate-900'
}

function fmtAge(ts: string): string {
  const h = (Date.now() - new Date(ts).getTime()) / 3_600_000
  if (h < 1) return 'less than an hour ago'
  if (h < 48) return `${Math.floor(h)}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/**
 * Persistent, minimal identity strip - visible above all four tabs, not
 * just Summary, so switching to Evidence/Action/Timeline never loses track
 * of which incident this is or how urgent it is. Deliberately does NOT
 * carry the facts grid, severity badge, or action controls the previous
 * design put here - those answer "what caused it" / "what should I do
 * next", which now live in the Summary tab where those questions are
 * actually asked, once, instead of being restated in every tab's header.
 *
 * The one exception is Reopen: for a closed incident it's the only action
 * that exists at all, and it was never hidden behind a menu - keeping it
 * here, always visible, costs nothing. Every OTHER action (Request
 * evidence, Route to authority, Close) used to live behind a "More
 * actions" (⋯) menu here - removed, because an icon with no label hiding
 * the only ways to act on an incident is exactly the kind of "small and
 * hidden, I wouldn't know what we have" control this workspace is trying
 * not to be. They're all plainly visible in Summary's "What should I do
 * next?" section instead. */
export default function IncidentCaseHeader({
  detail,
  wardAqi,
  detectionPollutant,
  actions,
  position,
  queueLabel,
  onBack,
  onPrev,
  onNext,
}: {
  detail: IncidentDetail
  wardAqi: number | null
  /** The pollutant that triggered automated detection, if this incident came
   *  from one - same fallback the Summary tab uses via resolveIncidentPollutant,
   *  so this header can never show a different pollutant than the rest of
   *  the case for the same incident. */
  detectionPollutant?: string | null
  actions: IncidentActions
  /** 1-based position in the current queue, for sequential processing
   *  ("Bawana" is 3 of 68) - the queue list itself is no longer permanently
   *  on screen, so this is the only orientation a commander gets while
   *  working through it via Prev/Next. */
  position: { index: number; total: number } | null
  queueLabel: string
  onBack: () => void
  onPrev?: () => void
  onNext?: () => void
}) {
  const { incident } = detail
  const reading = currentReading(wardAqi, incident.local_excess)
  const pollutant = resolveIncidentPollutant(incident.primary_pollutant, detectionPollutant ?? null)

  return (
    <div className="flex-shrink-0 border-b border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="focus-ring flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-700"
          >
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
            {queueLabel}
          </button>
          {position && (
            <>
              <span className="text-xs text-slate-300">·</span>
              <span className="text-xs tabular-nums text-slate-400">
                {position.index} of {position.total}
              </span>
              <div className="flex items-center">
                <button
                  type="button"
                  disabled={!onPrev}
                  onClick={onPrev}
                  aria-label="Previous incident"
                  className="focus-ring rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30"
                >
                  <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                </button>
                <button
                  type="button"
                  disabled={!onNext}
                  onClick={onNext}
                  aria-label="Next incident"
                  className="focus-ring rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30"
                >
                  <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                </button>
              </div>
            </>
          )}
        </div>

        {incident.status === 'closed' && (
          <button
            type="button"
            disabled={actions.busy}
            onClick={actions.reopen}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-status-warning/40 px-2 py-1 text-xs font-semibold text-status-warning transition hover:bg-status-warning/10 disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Reopen
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="min-w-0 truncate text-lg font-bold text-slate-900">
          {incident.ward_name ?? `Incident #${incident.id}`}
          {pollutant && <span className="font-semibold text-slate-500"> · {POLLUTANT_LABEL[pollutant]}</span>}
        </h1>
        <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold capitalize text-slate-700">
          {incident.status.replace(/_/g, ' ')}
        </span>
      </div>

      <p className="mt-1 flex items-baseline gap-2">
        {reading.kind === 'live' ? (
          <>
            <span className={`text-2xl font-bold tabular-nums ${aqiTone(reading.aqi)}`}>AQI {reading.aqi}</span>
            <span className="text-xs font-semibold text-slate-400">{aqiBandLabel(reading.aqi)}</span>
          </>
        ) : reading.kind === 'forecast' ? (
          <span className="text-2xl font-bold tabular-nums text-slate-900" title="No live station reading - showing the forecast excess instead">
            +{Math.round(reading.excess)} µg/m³
          </span>
        ) : (
          <span className="text-2xl font-bold text-slate-300">No reading</span>
        )}
      </p>
      <p className="mt-0.5 text-xs text-slate-400">Detected {fmtAge(incident.detected_at)}</p>

      {actions.error && <p className="mt-2 text-xs text-status-critical">{actions.error}</p>}
    </div>
  )
}
