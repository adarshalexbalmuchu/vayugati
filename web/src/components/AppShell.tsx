import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { initOfflineSync } from '../lib/offlineSync'
import MobileBottomNav from './MobileNav'
import { OfflineBanner } from './ui'

// ── Brand marks ──────────────────────────────────────────────────────────────
// The real Vayu Gati logo (web/public/brand/logo.png) — the same file used
// in every branding placement (icon rail, top bar, login screen), per the
// explicit "use everywhere the same image" instruction, rather than
// commissioning separate icon/wordmark variants. Background made
// transparent from the original flat-sky-blue export (a mechanical
// background-strip, not a redraw) so it sits cleanly on the white shell.
// The source artwork already contains the full "VAYU GATI" wordmark, so
// LogoWordmark below renders the image alone — no separate text label
// layered next to it, which would just duplicate what's already drawn.
export function LogoMark({ className = 'h-8 w-14' }: { className?: string }) {
  return <img src="/brand/logo.png" alt="Vayu Gati" aria-hidden className={`${className} object-contain`} />
}

/** Full wordmark - for login / brand surfaces only. */
export function LogoWordmark({ className = 'h-16 w-auto' }: { className?: string }) {
  return <img src="/brand/logo.png" alt="Vayu Gati" className={`${className} object-contain`} />
}

const ROLE_LABEL: Record<string, string> = {
  citizen: 'Citizen',
  field_officer: 'Field Officer',
  commander: 'Commander',
  admin: 'Admin',
}

export interface RailItem {
  key: string
  label: string
  icon: string
  /** Path to navigate to. Undefined = not built yet in this phase. */
  to?: string
  comingSoon?: string
}

/** Shared between the desktop rail and the mobile bottom nav, so the two
 *  navigation surfaces can never silently drift out of sync with each other. */
export function railItemsForRole(role: string | undefined, homePath: string): RailItem[] {
  const isCommand = role === 'commander' || role === 'admin'
  const isField = role === 'field_officer' || role === 'admin'
  return [
    { key: 'overview', label: 'Overview', icon: '⌂', to: homePath },
    {
      key: 'incidents',
      label: 'Incidents',
      icon: '⚠',
      // Built in Phase 3, for the command roles. Field officers work incidents
      // through their missions rather than the queue.
      to: isCommand ? '/incidents' : undefined,
      comingSoon: isCommand ? undefined : 'The incident queue is a command-centre surface',
    },
    { key: 'map', label: 'Map', icon: '⚲', to: isCommand ? '/map' : undefined },
    {
      key: 'tasks',
      label: 'Tasks',
      icon: '☑',
      to: isField ? '/missions' : isCommand ? '/tasks' : undefined,
    },
    { key: 'citizens', label: 'Citizens', icon: '☺', to: isCommand ? '/citizens' : undefined },
    { key: 'sensors', label: 'Sensors', icon: '◈', to: isCommand ? '/sensors' : undefined },
    { key: 'analytics', label: 'Analytics', icon: '▤', to: isCommand ? '/analytics' : undefined },
    {
      key: 'settings',
      label: 'Settings',
      icon: '⚙',
      // Phase 10: system health + the minimal pilot admin surface.
      to: isCommand ? '/ops' : undefined,
      comingSoon: isCommand ? undefined : 'City Pack settings are a command-centre surface',
    },
  ]
}

/** Desktop-only icon rail — light, thin-border, Outlook/Fluent-style. Hidden
 *  below `sm`; MobileBottomNav takes over navigation on narrow viewports. */
function IconRail({ role, homePath }: { role: string | undefined; homePath: string }) {
  const navigate = useNavigate()
  const location = useLocation()
  const items = railItemsForRole(role, homePath)

  return (
    <nav
      aria-label="Primary"
      className="z-rail hidden w-16 flex-shrink-0 flex-col items-center gap-1 border-r border-slate-200 bg-white py-3 sm:flex"
    >
      <div className="mb-2">
        <LogoMark className="h-7 w-11" />
      </div>
      {items.map((item) => {
        const active = !!item.to && location.pathname === item.to
        const disabled = !item.to
        return (
          <button
            key={item.key}
            type="button"
            disabled={disabled}
            title={disabled ? item.comingSoon : item.label}
            aria-current={active ? 'page' : undefined}
            aria-disabled={disabled}
            onClick={() => item.to && navigate(item.to)}
            className={`focus-ring group relative flex w-12 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10px] font-medium transition ${
              active
                ? 'bg-accent-50 text-accent-700'
                : disabled
                  ? 'cursor-not-allowed text-slate-300'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-accent-600'
            }`}
          >
            {active && (
              <span className="absolute -left-2.5 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent-600" aria-hidden />
            )}
            <span className="text-base leading-none" aria-hidden>
              {item.icon}
            </span>
            <span className="leading-none">{item.label}</span>
            {disabled && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-slate-300" aria-hidden />}
          </button>
        )
      })}
    </nav>
  )
}

/** Minimal top bar (launch UI pass): no breadcrumb text, no search input (was
 *  a disabled placeholder anyway), no help flyout — just the brand mark,
 *  notifications, and the profile menu. `subtitle` still names the active
 *  page for the browser tab title (accessibility/orientation), it just isn't
 *  rendered as visible breadcrumb text anymore - each page already carries
 *  its own in-page title.
 *
 *  `headerContent`, when passed, REPLACES the "Vayu Gati" brand text with
 *  page-specific content (Overview's own identity block + Refresh button,
 *  merging what used to be a separate row into this one) - opt-in per page,
 *  so every page that doesn't pass it keeps the plain brand text unchanged,
 *  including the mobile-only branding role that text otherwise plays (the
 *  icon rail is desktop-only; a page that opts in accepts trading that for
 *  its own content on mobile too). */
function TopBar({ subtitle, headerContent }: { subtitle?: string; headerContent?: ReactNode }) {
  const { profile, signOut } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    document.title = subtitle ? `${subtitle} · Vayu Gati` : 'Vayu Gati'
  }, [subtitle])

  return (
    <header className="z-header flex items-center gap-3 border-b border-slate-200 bg-white px-3 py-2 sm:px-4">
      <div className="min-w-0 flex-1">
        {headerContent ?? <span className="truncate text-[15px] font-bold tracking-tight text-slate-900">Vayu Gati</span>}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          title="Alerts - none yet"
          className="focus-ring relative rounded-lg p-2 text-sm text-slate-500 transition hover:bg-slate-100"
        >
          <span aria-hidden>🔔</span>
          <span className="sr-only">Alerts</span>
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="focus-ring flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100"
          >
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-100 text-[11px] font-bold text-accent-700"
              aria-hidden
            >
              {(profile ? ROLE_LABEL[profile.role] : '?').charAt(0)}
            </span>
            <span className="hidden text-xs font-medium sm:inline">
              {profile ? ROLE_LABEL[profile.role] ?? profile.role : ''}
            </span>
          </button>
          {menuOpen && (
            <div className="z-dropdown absolute right-0 top-full mt-1 w-48 rounded-xl border border-slate-200 bg-white p-1.5 text-sm shadow-card-lg">
              {profile && (
                <div className="border-b border-slate-100 px-2.5 py-2">
                  <p className="font-semibold text-slate-800">{ROLE_LABEL[profile.role] ?? profile.role}</p>
                  {profile.wardName && <p className="text-xs text-slate-400">{profile.wardName}</p>}
                </div>
              )}
              <button
                onClick={signOut}
                className="mt-1 w-full rounded-lg px-2.5 py-1.5 text-left text-slate-700 transition hover:bg-slate-50"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

/**
 * Shared, role-aware application shell: white top bar + light left icon rail
 * (desktop) / bottom nav (mobile) + responsive main workspace. Main surfaces
 * are always white/slate — no dark-themed variant (Phase 11 UI redesign
 * retired the old `dark` prop along with Overview's dark panels; see
 * docs/DESIGN_SYSTEM.md).
 */
export default function AppShell({
  subtitle,
  headerContent,
  secondaryNav,
  children,
}: {
  subtitle?: string
  /** Replaces the "Vayu Gati" brand text in the top bar with page-specific
   *  content - see TopBar's own doc comment above for the tradeoffs. */
  headerContent?: ReactNode
  /** Contextual secondary navigation for the active module (plan §19). Optional:
   *  pages that don't pass it keep the previous single-pane layout unchanged. */
  secondaryNav?: ReactNode
  children: ReactNode
}) {
  const { profile } = useAuth()
  const homePath = profile
    ? profile.role === 'field_officer'
      ? '/field'
      : profile.role === 'commander' || profile.role === 'admin'
        ? '/command'
        : '/citizen'
    : '/'
  const railItems = railItemsForRole(profile?.role, homePath)

  // Field-officer offline queue (Phase 12) - wired once at the shell level,
  // next to useOnlineStatus/OfflineBanner below, per ui.tsx's own extension-
  // point comment. Harmless for every other role: the queue is only ever
  // populated by MissionsView.tsx's own mutation sites.
  useEffect(() => initOfflineSync(), [])

  return (
    <div className="flex h-[100dvh]">
      <IconRail role={profile?.role} homePath={homePath} />
      <div className="flex min-w-0 flex-1 flex-col bg-white text-slate-900">
        <TopBar subtitle={subtitle} headerContent={headerContent} />
        <OfflineBanner />
        {secondaryNav ? (
          // Contextual nav: a column on desktop, a scrollable strip on narrow
          // screens. It must never simply disappear — it is the only way to
          // change queue.
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <nav
              aria-label="Secondary"
              className="flex-shrink-0 overflow-x-auto border-b border-slate-200 bg-slate-50 p-2 sm:w-44 sm:overflow-x-visible sm:overflow-y-auto sm:border-b-0 sm:border-r"
            >
              {secondaryNav}
            </nav>
            <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
          </div>
        ) : (
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
        )}
        <MobileBottomNav items={railItems} />
      </div>
    </div>
  )
}
