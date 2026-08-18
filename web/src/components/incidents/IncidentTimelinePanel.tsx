import { Label, UnavailableBadge } from '../ui'
import type { IncidentDetail } from '../../lib/incidents'
import IncidentTimeline from '../IncidentTimeline'

/**
 * Its own tab now (previously buried at the bottom of Evidence) - command
 * users reach for chronological context often enough on its own that it
 * shouldn't cost a scroll through reports/monitoring/missions to get to.
 * Same data, same component (IncidentTimeline) - just promoted.
 */
export default function IncidentTimelinePanel({ detail }: { detail: IncidentDetail }) {
  const { events, unavailable } = detail
  const missingTimeline = unavailable.includes('Timeline')

  return (
    <section className="px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <Label dark>Incident timeline</Label>
        {!missingTimeline && (
          <span className="rounded bg-slate-100 px-1.5 text-[10px] font-bold text-slate-600">{events.length}</span>
        )}
        {missingTimeline && <UnavailableBadge label="Couldn't load" />}
      </div>
      <IncidentTimeline events={events} showVisibility />
    </section>
  )
}
