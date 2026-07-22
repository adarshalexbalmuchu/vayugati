import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export type KpiTone = 'critical' | 'warning' | 'success' | 'info' | 'neutral' | 'accent'

export interface KpiItem {
  key: string
  icon: LucideIcon
  label: string
  value: ReactNode
  sublabel?: ReactNode
  tone?: KpiTone
}

const TONE_CLASSES: Record<KpiTone, { icon: string; chip: string }> = {
  critical: { icon: 'text-status-critical', chip: 'bg-status-critical/10' },
  warning: { icon: 'text-status-warning', chip: 'bg-status-warning/10' },
  success: { icon: 'text-status-success', chip: 'bg-status-success/10' },
  info: { icon: 'text-status-info', chip: 'bg-status-info/10' },
  neutral: { icon: 'text-status-neutral', chip: 'bg-status-neutral/10' },
  accent: { icon: 'text-accent-600', chip: 'bg-accent-50' },
}

function KpiCard({ icon: Icon, label, value, sublabel, tone = 'neutral' }: Omit<KpiItem, 'key'>) {
  const tones = TONE_CLASSES[tone]
  return (
    <div className="flex items-start gap-3 bg-white px-3.5 py-3">
      <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg ${tones.chip}`}>
        <Icon className={`h-[18px] w-[18px] ${tones.icon}`} strokeWidth={2} aria-hidden />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-bold leading-none tabular-nums text-slate-900">{value}</p>
        <p className="mt-1.5 truncate text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
        {sublabel && <p className="mt-0.5 truncate text-xs text-slate-500">{sublabel}</p>}
      </div>
    </div>
  )
}

const DESKTOP_COLS: Record<number, string> = {
  4: 'lg:grid-cols-4',
  5: 'lg:grid-cols-5',
  6: 'lg:grid-cols-6',
}

/** Compact operational status strip - the page's answer to "is the city
 *  normal or worsening" at a glance, before any panel below is read.
 *  `columns` only changes the desktop column count (default 6, matching
 *  every existing caller) - narrower callers can opt into a tighter strip
 *  without affecting anyone who doesn't pass it. */
export default function KpiStrip({ items, columns = 6 }: { items: KpiItem[]; columns?: 4 | 5 | 6 }) {
  return (
    <div
      className={`grid grid-cols-2 divide-x divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 shadow-card sm:grid-cols-3 ${DESKTOP_COLS[columns]} lg:divide-y-0`}
    >
      {items.map(({ key, ...item }) => (
        <KpiCard key={key} {...item} />
      ))}
    </div>
  )
}
