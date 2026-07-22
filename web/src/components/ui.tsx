import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'

// ── Card ─────────────────────────────────────────────────────────────────────
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>
}

export function CardHeader({
  title,
  subtitle,
  right,
}: {
  title: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}

// ── Skeleton ─────────────────────────────────────────────────────────────────
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />
}

// ── Stat tile ────────────────────────────────────────────────────────────────
export function Stat({
  value,
  label,
  accent = 'text-slate-900',
}: {
  value: ReactNode
  label: string
  accent?: string
}) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-center">
      <p className={`text-2xl font-bold tabular-nums ${accent}`}>{value}</p>
      <p className="mt-0.5 text-xs text-slate-500">{label}</p>
    </div>
  )
}

// ── Empty state ──────────────────────────────────────────────────────────────
export function EmptyState({ icon, children }: { icon?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
      {icon && <div className="mb-2 text-2xl opacity-60">{icon}</div>}
      <p className="text-sm text-slate-400">{children}</p>
    </div>
  )
}

// ── Section label ────────────────────────────────────────────────────────────
export function Label({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return (
    <p className={`text-xs font-semibold uppercase tracking-wide ${dark ? 'text-slate-500' : 'text-slate-400'}`}>
      {children}
    </p>
  )
}

// ── Error state ──────────────────────────────────────────────────────────────
// For a failed fetch/mutation. Distinct from EmptyState (which means "nothing
// to show", not "something went wrong").
export function ErrorState({
  message = 'Something went wrong loading this data.',
  onRetry,
}: {
  message?: string
  onRetry?: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      <div className="mb-1 text-2xl" aria-hidden>
        ⚠️
      </div>
      <p className="text-sm text-status-critical">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="focus-ring mt-1 rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-semibold text-ink-700 transition hover:bg-ink-50"
        >
          Retry
        </button>
      )}
    </div>
  )
}

// ── Data-quality badges ──────────────────────────────────────────────────────
// Small, explicit labels — never silently show fresh-looking data that is
// actually stale, partial, or unavailable. See docs/DATA_QUALITY_AND_SCIENCE.md.
export function StaleBadge({ label = 'Stale' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-status-warning ring-1 ring-inset ring-status-warning/40">
      <span className="h-1.5 w-1.5 rounded-full bg-status-warning" aria-hidden />
      {label}
    </span>
  )
}

export function PartialDataBadge({ label = 'Partial data' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-status-info ring-1 ring-inset ring-status-info/40">
      <span className="h-1.5 w-1.5 rounded-full bg-status-info" aria-hidden />
      {label}
    </span>
  )
}

export function UnavailableBadge({ label = 'Unavailable' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 ring-1 ring-inset ring-slate-300">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" aria-hidden />
      {label}
    </span>
  )
}

// ── Modal ────────────────────────────────────────────────────────────────────
// The first shared modal primitive in this codebase — prior dialogs (e.g. the
// evidence dialog in IncidentsView.tsx) each rolled their own inline overlay.
// Deliberately minimal: centered panel, Escape closes, first field autofocus.
// Not a generic form-builder — callers still bring their own form markup.
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const firstField = panelRef.current?.querySelector<HTMLElement>('input, select, textarea, button')
    firstField?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="z-modal fixed inset-0 flex items-center justify-center bg-slate-900/40 p-3" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-4 shadow-card-lg sm:p-5"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="focus-ring rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
// Purely presentational: every panel it wraps stays mounted (a hidden tab is
// `className="hidden"`, not unmounted), so switching tabs never re-triggers a
// panel's own data fetching — behaviourally identical to the pre-redesign
// always-stacked layout, just one section visible at a time.
export interface TabItem {
  key: string
  label: string
  /** Optional - renders left of the label when present. Backward compatible:
   *  consumers that don't pass one (e.g. MapPage.tsx) are unaffected. */
  icon?: LucideIcon
}

export function Tabs({ tabs, active, onChange }: { tabs: TabItem[]; active: string; onChange: (key: string) => void }) {
  return (
    <div role="tablist" aria-label="Incident sections" className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-white px-2 sm:px-3">
      {tabs.map((t) => {
        const selected = t.key === active
        const Icon = t.icon
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(t.key)}
            className={`focus-ring flex flex-shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition ${
              selected ? 'border-accent-600 text-accent-700' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {Icon && <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />}
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

export function TabPanel({ active, children }: { active: boolean; children: ReactNode }) {
  return <div className={active ? 'contents' : 'hidden'}>{children}</div>
}

// ── Sticky action bar ────────────────────────────────────────────────────────
// Mobile: pinned to the bottom of the nearest scroll container, above any
// content, with a top border/backdrop separating it from what's scrolled
// underneath. Desktop: a normal, non-sticky inline toolbar — "sticky" is a
// mobile-specific affordance for thumb reach, not a desktop requirement.
export function StickyActionBar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-slate-200 bg-white/95 px-3 py-2.5 backdrop-blur sm:static sm:border-t-0 sm:bg-transparent sm:px-0 sm:py-0 sm:backdrop-blur-none ${className}`}
    >
      {children}
    </div>
  )
}

// ── Offline banner ───────────────────────────────────────────────────────────
// Shell-level: tracks the browser's connectivity state and surfaces it
// explicitly rather than letting screens fail silently. Field/citizen surfaces
// that support offline drafts (Phase 3) will layer their own queue status on
// top of this.
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])
  return online
}

export function OfflineBanner() {
  const online = useOnlineStatus()
  if (online) return null
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-status-warning/15 px-4 py-1.5 text-xs font-semibold text-status-warning"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-status-warning" aria-hidden />
      You&apos;re offline - showing the last data loaded on this device.
    </div>
  )
}
