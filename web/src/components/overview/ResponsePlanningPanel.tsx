import { ClipboardList } from 'lucide-react'
import { Card, CardHeader, Stat } from '../ui'

/**
 * Replaces the old Field Team Allocation slider (Phase 13), which suggested
 * a hypothetical crew split that was never a real dispatch and wasn't
 * clearly actionable. This card only shows numbers Overview already has
 * live: active dispatches, how many are overdue against SLA, and how many
 * wards currently warrant review (severe or trending up) - all real,
 * already-fetched counts, explicitly labelled as planning context rather
 * than a dispatch itself.
 */
export default function ResponsePlanningPanel({
  activeDispatches,
  overdue,
  wardsNeedingReview,
}: {
  activeDispatches: number
  overdue: number
  wardsNeedingReview: number
}) {
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <ClipboardList className="h-4 w-4 text-accent-600" aria-hidden />
            Response Planning
          </span>
        }
        subtitle="Planning guide only — not a dispatch"
      />
      <div className="grid grid-cols-3 gap-2 px-4 py-3.5">
        <Stat value={activeDispatches} label="Dispatches active" />
        <Stat value={overdue} label="Overdue" accent={overdue > 0 ? 'text-status-critical' : 'text-slate-900'} />
        <Stat value={wardsNeedingReview} label="Wards needing review" />
      </div>
    </Card>
  )
}
