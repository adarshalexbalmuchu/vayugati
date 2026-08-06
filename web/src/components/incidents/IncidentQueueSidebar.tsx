import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  MapPin,
  RotateCcw,
  ShieldQuestion,
  TrendingUp,
  UserCheck,
  type LucideIcon,
} from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { QUEUE_LABELS, type QueueKey } from '../../lib/incidentRules'

const QUEUE_ORDER: QueueKey[] = ['active', 'predicted', 'verification', 'assigned', 'escalated', 'recurrence', 'closed']

const QUEUE_ICON: Record<QueueKey, LucideIcon> = {
  active: Inbox,
  predicted: TrendingUp,
  verification: ShieldQuestion,
  assigned: UserCheck,
  escalated: AlertTriangle,
  recurrence: RotateCcw,
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
  const location = useLocation()
  const onRemediation = location.pathname === '/incidents/remediation'

  return (
    <div className="flex gap-1.5 overflow-x-auto sm:flex-col sm:gap-0.5 sm:overflow-visible">
      {QUEUE_ORDER.map((q) => {
        const selected = q === active
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
      <div className="hidden sm:block sm:mt-2 sm:border-t sm:border-slate-200 sm:pt-2">
        <Link
          to="/incidents/remediation"
          className={`focus-ring flex items-center gap-2 rounded-md border-l-2 px-2 py-1.5 text-sm transition ${
            onRemediation
              ? 'border-accent-600 bg-accent-50 font-semibold text-accent-800'
              : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-700'
          }`}
        >
          <MapPin className="h-3.5 w-3.5 flex-shrink-0 text-slate-400" strokeWidth={2} aria-hidden />
          <span className="flex-1 truncate">Location Audit</span>
        </Link>
      </div>
    </div>
  )
}
