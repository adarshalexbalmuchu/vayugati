import { AlertTriangle, CheckCircle2, ChevronRight } from 'lucide-react'
import { formatWardName } from '../../lib/format'
import type { SevereWardAlert, TimeWindowHours } from '../../lib/overviewRules'
import { Card, CardHeader } from '../ui'

/** Answers "which wards need attention first" - the single ranked list a
 *  commander reads before anything else on the page. */
export default function PriorityAlertsPanel({
  alerts,
  windowHours,
  selectedWardId,
  onSelectWard,
}: {
  alerts: SevereWardAlert[]
  windowHours: TimeWindowHours
  selectedWardId: number | null
  onSelectWard: (wardId: number) => void
}) {
  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4 text-status-critical" aria-hidden />
            Priority Alerts
          </span>
        }
        subtitle={`Wards predicted to cross severe within ${windowHours}h`}
      />
      {alerts.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-3 text-sm text-slate-500">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-status-success" aria-hidden />
          No wards predicted to cross severe within {windowHours}h.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-y-auto">
          {alerts.map((a) => {
            const selected = a.wardId === selectedWardId
            return (
              <li key={a.wardId}>
                <button
                  type="button"
                  onClick={() => onSelectWard(a.wardId)}
                  className={`focus-ring flex w-full items-center gap-3 px-4 py-2.5 text-left transition ${
                    selected ? 'bg-accent-50' : 'hover:bg-slate-50'
                  }`}
                >
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-status-critical/10 text-xs font-bold tabular-nums text-status-critical">
                    {a.hoursToSevere}h
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-800">{formatWardName(a.wardName)}</span>
                    <span className="block text-xs text-slate-400">
                      Peak forecast {a.peakPred != null ? `${Math.round(a.peakPred)} µg/m³` : 'unknown'}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 flex-shrink-0 text-slate-300" aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
