import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Droplets, Thermometer } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { roleHome, useAuth } from '../lib/auth'
import { fetchCityWeatherNow } from '../lib/data'
import { initOfflineSync } from '../lib/offlineSync'
import { useAsync } from '../lib/useAsync'
import headerSkyline from '../assets/header-skyline.jpg'
import DegradedDataBanner from './DegradedDataBanner'
import { GlassFilterDefs } from './GlassSurface'
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
/** City temperature and humidity now (median across wards of each ward's
 *  latest Open-Meteo reading, see fetchCityWeatherNow), re-fetched every
 *  10 min. Renders nothing when weather ingest has nothing from the last
 *  3 h, rather than showing an old value as current. */
function HeaderWeather() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 10 * 60_000)
    return () => clearInterval(t)
  }, [])
  const { data } = useAsync(fetchCityWeatherNow, [tick], { cacheKey: 'header-weather', staleAfterMs: 15 * 60_000 })
  if (!data || (data.tempC == null && data.humidity == null)) return null
  const asOf = new Date(data.ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const label = [
    data.tempC != null ? `${Math.round(data.tempC)}°C` : null,
    data.humidity != null ? `humidity ${Math.round(data.humidity)}%` : null,
  ].filter(Boolean).join(', ')
  return (
    <div
      className="hidden items-center gap-2.5 rounded-lg bg-white/75 px-2.5 py-1.5 text-xs font-semibold tabular-nums text-slate-700 shadow-sm backdrop-blur-sm md:flex"
      title={`Delhi now: ${label}. Median of ${data.wards} wards, Open-Meteo, as of ${asOf}.`}
      aria-label={`Delhi weather now: ${label}`}
    >
      {data.tempC != null && (
        <span className="flex items-center gap-1">
          <Thermometer className="h-3.5 w-3.5 text-orange-500" aria-hidden />
          {Math.round(data.tempC)}°C
        </span>
      )}
      {data.humidity != null && (
        <span className="flex items-center gap-1">
          <Droplets className="h-3.5 w-3.5 text-sky-500" aria-hidden />
          {Math.round(data.humidity)}%
        </span>
      )}
    </div>
  )
}

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

/** Desktop-only nav panel — light, thin-border, Outlook/Fluent-style. Hidden
 *  below `sm`; MobileBottomNav takes over navigation on narrow viewports.
 *
 *  Click-to-toggle (not hover): hover doesn't have a reliable "off" state on
 *  touch, which left it stuck open and overlapping the header on tablets.
 *  The menu button in TopBar controls `open`; this renders a backdrop (click
 *  to close) plus a panel anchored below the header so it never overlaps the
 *  logo/header row above it. Opens from the right (Sept 2026) to match the
 *  ☰ button's position at the end of the header, next to the account menu. */
function IconRail({
  role,
  homePath,
  open,
  onClose,
}: {
  role: string | undefined
  homePath: string
  open: boolean
  onClose: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const items = railItemsForRole(role, homePath)

  if (!open) return null

  return (
    <>
      {/* Backdrop — click outside the panel to close. Positioned below the
          header (top-16, matching the header's own h-16) rather than
          full-screen, so the header stays usable. */}
      <div className="fixed inset-0 top-16 z-rail hidden bg-slate-900/10 sm:block" onClick={onClose} aria-hidden />
      <nav
        aria-label="Primary"
        className="fixed right-0 top-16 z-rail hidden w-16 flex-col items-center gap-1 border-l border-t border-slate-200 bg-white py-3 shadow-card-lg sm:flex"
        style={{ height: 'calc(100dvh - 4rem)' }}
      >
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
              onClick={() => {
                if (item.to) {
                  navigate(item.to)
                  onClose()
                }
              }}
              className={`focus-ring group relative flex w-12 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10px] font-medium transition ${
                active
                  ? 'bg-accent-50 text-accent-700'
                  : disabled
                    ? 'cursor-not-allowed text-slate-300'
                    : 'text-slate-500 hover:bg-slate-100 hover:text-accent-600'
              }`}
            >
              {active && (
                <span className="absolute -right-2.5 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent-600" aria-hidden />
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
    </>
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
function TopBar({
  subtitle,
  headerContent,
  railOpen,
  onMenuClick,
}: {
  subtitle?: string
  headerContent?: ReactNode
  railOpen: boolean
  onMenuClick: () => void
}) {
  const { profile, signOut } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    document.title = subtitle ? `${subtitle} · Vayu Gati` : 'Vayu Gati'
  }, [subtitle])

  return (
    // Illustrated Delhi skyline header (Sept 2026, user request: the plain
    // glass bar read as too clean for the product). The image is ~10:1 and
    // the bar 64px tall, so it is cropped to its lower band (monuments +
    // tree line); soft white fades at both ends keep the logo, tagline and
    // account controls readable over the trees. Height stays h-16: the nav
    // rail (top-16, calc(100dvh - 4rem)) and the Map toolbar assume it.
    <div className="z-header flex-shrink-0 border-b border-slate-200/70">
      <div
        className="relative flex h-16 items-center gap-3 bg-cover bg-no-repeat px-3 sm:px-4"
        style={{
          backgroundImage: `linear-gradient(to right, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.5) 16rem, rgba(255,255,255,0) 26rem, rgba(255,255,255,0) calc(100% - 20rem), rgba(255,255,255,0.7) 100%), url(${headerSkyline})`,
          backgroundPosition: 'center, center 85%',
          backgroundSize: 'cover, cover',
        }}
      >
        {/* Clicking the logo goes back to the role's own home/Overview page
            (Sept 2026) — was purely decorative before, a common convention
            this app didn't yet follow. */}
        <button
          type="button"
          onClick={() => navigate(profile ? roleHome(profile.role) : '/')}
          aria-label="Go to Overview"
          className="focus-ring flex-shrink-0 rounded-lg"
        >
          <LogoMark className="h-12 w-20" />
        </button>

        {/* Bilingual action-verb tagline (Sept 2026, direct request) — the
            product's own documented Hindi identity line ("Jankari se
            Karyavahi Tak", already the subtitle in
            docs/vayu-gati-product-plan-v2.md), shown next to the logo on
            every page rather than per-page content, since it's brand
            identity, not something a specific page owns. Hidden below sm:
            (a phone-width header has no room for logo + tagline + a page's
            own controls all at once) — the logo alone still identifies the
            product at that width. */}
        <div className="hidden flex-shrink-0 flex-col justify-center leading-tight sm:flex">
          <span className="text-[11px] font-semibold text-slate-600">From information to Action</span>
          <span className="text-[11px] font-semibold text-slate-500">जानकारी से कार्रवाई तक</span>
        </div>

        <div className="min-w-0 flex-1">
          {headerContent ?? <span className="truncate text-[15px] font-bold tracking-tight text-slate-900">Vayu Gati</span>}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <HeaderWeather />
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="focus-ring flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-700 transition hover:bg-white/40"
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

          {/* Nav toggle — moved here (Sept 2026), after the account button, at
              the user's request. Still opens the same left-edge nav panel
              (IconRail/onMenuClick unchanged) - only the button's own position
              moved from before the logo to the end of the header. */}
          <button
            type="button"
            onClick={onMenuClick}
            aria-label={railOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={railOpen}
            className="focus-ring hidden flex-shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-white/40 sm:block"
          >
            <span className="block text-lg leading-none" aria-hidden>
              ☰
            </span>
          </button>
        </div>
      </div>
    </div>
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
  const [railOpen, setRailOpen] = useState(false)
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
      {/* Backs every <GlassSurface> in the app (the
          page-level ones like the Map/Overview floating bars) via
          url(#glass-distortion) — mounted once here at the shell root
          rather than per-page.
          Page-level mounts of this same component were removed as
          redundant (Sept 2026). */}
      <GlassFilterDefs />
      <IconRail role={profile?.role} homePath={homePath} open={railOpen} onClose={() => setRailOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col bg-white text-slate-900">
        <TopBar
          subtitle={subtitle}
          headerContent={headerContent}
          railOpen={railOpen}
          onMenuClick={() => setRailOpen((v) => !v)}
        />
        <OfflineBanner />
        <DegradedDataBanner />
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
