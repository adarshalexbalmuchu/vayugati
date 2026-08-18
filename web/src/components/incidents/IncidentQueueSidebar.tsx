import { AlertTriangle, CheckCircle2, Inbox, ShieldQuestion, TrendingUp, UserCheck, type LucideIcon } from 'lucide-react'
import { QUEUE_LABELS, type QueueKey } from '../../lib/incidentRules'

/** The 6 working views. `predicted` is a real nav row here (a saved lens
 *  over the open set, same as e.g. Gmail's "Starred" sitting next to
 *  "Inbox") - it does not need to be hidden to be honest about overlapping
 *  with `active`, as long as nothing on the page implies these counts sum
 *  to a total (they don't: there's no "N incidents total" figure anywhere
 *  that a reader could misadd them into). `recurrence` stays a filter chip
 *  inside the Closed queue instead (see IncidentList.tsx) - unlike
 *  predicted it's only ever relevant once already viewing Closed, so a
 *  permanent top-level row for it would be dead weight the rest of the
 *  time. `escalated` (rendered "Needs Attention") is the one queue meant
 *  to demand action regardless of what else is selected. Location Audit
 *  lives in the page header now (IncidentsView.tsx) — it's a data-quality
 *  tool, not an incident queue, and living here made it read as an 8th
 *  queue in this same workflow. */
const QUEUE_ORDER: QueueKey[] = ['active', 'escalated', 'predicted', 'verification', 'assigned', 'closed']

const QUEUE_ICON: Record<QueueKey, LucideIcon> = {
  active: Inbox,
  predicted: TrendingUp,
  verification: ShieldQuestion,
  assigned: UserCheck,
  escalated: AlertTriangle,
  recurrence: CheckCircle2,
  closed: CheckCircle2,
}

/** Desktop: a vertical list of queue rows (rendered in AppShell's secondaryNav
 *  column) - compact list styling, not large colored pills. Mobile: the SAME
 *  data as horizontally-scrollable chips - intentionally distinct treatments
 *  of one shared data structure, not one layout auto-shrunk into the other. */
export default function IncidentQueueSidebar({
  counts,
  active,
  onSelect,
}: {
  counts: Record<QueueKey, number>
  active: QueueKey
  onSelect: (q: QueueKey) => void
}) {
  return (
    <div className="flex gap-1.5 overflow-x-auto sm:flex-col sm:gap-0.5 sm:overflow-visible">
      {QUEUE_ORDER.map((q) => {
        // `closed` stays highlighted while the recurrence filter chip is
        // applied on top of it — recurrence has no sidebar slot of its own
        // (see IncidentList.tsx), so falling back to `closed`'s highlight
        // is more honest than showing no selection at all.
        const selected = q === active || (q === 'closed' && active === 'recurrence')
        const Icon = QUEUE_ICON[q]
        return (
          <button
            key={q}
            type="button"
            onClick={() => onSelect(q)}
            aria-current={selected ? 'true' : undefined}
            className={`focus-ring flex flex-shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-left text-sm transition sm:rounded-md sm:border-l-2 sm:px-2 sm:py-1.5 ${
              selected
                ? 'bg-accent-600 font-semibold text-white sm:border-accent-600 sm:bg-accent-50 sm:font-semibold sm:text-accent-800'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 sm:border-transparent sm:bg-transparent sm:text-slate-600 sm:ring-0 sm:hover:bg-slate-100'
            }`}
          >
            <Icon
              className={`h-3.5 w-3.5 flex-shrink-0 ${selected ? 'sm:text-accent-700' : 'text-slate-400'}`}
              strokeWidth={2}
              aria-hidden
            />
            <span className="flex-1 truncate">{QUEUE_LABELS[q]}</span>
            <span
              className={`flex-shrink-0 rounded px-1.5 text-[10px] font-bold tabular-nums ${
                selected ? 'bg-white/20 text-white sm:bg-accent-100 sm:text-accent-800' : 'bg-slate-100 text-slate-500'
              }`}
            >
              {counts[q]}
            </span>
          </button>
        )
      })}
    </div>
  )
}
