import Lenis from 'lenis'
import 'lenis/dist/lenis.css'
import { useEffect, useRef } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { LogoWordmark } from '../components/AppShell'
import { GlassFilterDefs, GlassSurface } from '../components/GlassSurface'
import { useAuth } from '../lib/auth'
import { ScrollTrigger, gsap, useGsap } from './motion'
import { SiteFooter } from './SiteFooter'

const NAV = [
  { to: '/platform', label: 'Platform' },
  { to: '/evidence', label: 'Evidence' },
  { to: '/about', label: 'About' },
  { to: '/contact', label: 'Contact' },
]

export default function SiteLayout() {
  const { session } = useAuth()
  const { pathname, hash } = useLocation()
  const rootRef = useRef<HTMLDivElement>(null)
  const lenisRef = useRef<Lenis | null>(null)

  // Smooth, ScrollTrigger-synced scrolling; also removes pin jitter on trackpads.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const lenis = new Lenis({ lerp: 0.1, anchors: true })
    lenisRef.current = lenis
    lenis.on('scroll', ScrollTrigger.update)
    const tick = (t: number) => lenis.raf(t * 1000)
    gsap.ticker.add(tick)
    gsap.ticker.lagSmoothing(0)
    return () => {
      gsap.ticker.remove(tick)
      lenis.destroy()
      lenisRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!hash) {
      if (lenisRef.current) lenisRef.current.scrollTo(0, { immediate: true })
      else window.scrollTo(0, 0)
    }
    ScrollTrigger.refresh()
    void document.fonts?.ready.then(() => ScrollTrigger.refresh())
    const refresh = () => ScrollTrigger.refresh()
    document.fonts?.addEventListener('loadingdone', refresh)
    window.addEventListener('load', refresh)
    return () => {
      document.fonts?.removeEventListener('loadingdone', refresh)
      window.removeEventListener('load', refresh)
    }
  }, [pathname, hash])

  // Shared scroll behaviour for every public page, driven by data attributes.
  useGsap(
    rootRef,
    (_c, q) => {
      const items = q('[data-reveal]')
      gsap.set(items, { y: 36, opacity: 0 })
      ScrollTrigger.batch(items, {
        start: 'top 90%',
        once: true,
        onEnter: (batch) =>
          gsap.to(batch, { y: 0, opacity: 1, duration: 0.9, ease: 'power3.out', stagger: 0.1, overwrite: true }),
      })

      const restore: Array<() => void> = []
      q('[data-count]').forEach((node) => {
        const el = node as HTMLElement
        const raw = el.dataset.count ?? ''
        const to = parseFloat(raw)
        if (!(to >= 5)) return
        const dec = (raw.split('.')[1] ?? '').length
        const pre = el.dataset.prefix ?? ''
        const suf = el.dataset.suffix ?? ''
        const final = el.textContent
        const obj = { v: 0 }
        el.textContent = pre + (0).toFixed(dec) + suf
        gsap.to(obj, {
          v: to,
          duration: 1.6,
          ease: 'power2.out',
          scrollTrigger: { trigger: el, start: 'top 90%', once: true },
          onUpdate: () => {
            el.textContent = pre + obj.v.toFixed(dec) + suf
          },
        })
        restore.push(() => {
          el.textContent = final
        })
      })

      q('[data-scrub]').forEach((el) => {
        gsap.fromTo(
          el.querySelectorAll('[data-w]'),
          { opacity: 0.14 },
          {
            opacity: 1,
            ease: 'none',
            stagger: 0.12,
            scrollTrigger: { trigger: el, start: 'top 82%', end: 'bottom 52%', scrub: true },
          },
        )
      })

      return () => restore.forEach((fn) => fn())
    },
    [pathname],
  )

  return (
    <div ref={rootRef} className="flex min-h-screen flex-col bg-cream font-site text-ink-900">
      <GlassFilterDefs />

      <header className="fixed inset-x-0 top-3 z-30 px-3 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <GlassSurface radiusClassName="rounded-[28px] md:rounded-full" tint={0.86} className="pl-5 pr-2 sm:pl-6">
            <div className="grid h-16 grid-cols-[auto_1fr_auto] items-center gap-4">
              <Link to="/" aria-label="Vayu Gati home">
                <LogoWordmark className="h-11 w-auto" />
              </Link>
              <nav className="hidden items-center justify-center gap-7 text-sm md:flex" aria-label="Primary">
                {NAV.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      isActive ? 'font-medium text-slate-900' : 'text-slate-700 hover:text-slate-900'
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </nav>
              <Link
                to="/app"
                className="col-start-3 rounded-full bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-700"
              >
                {session ? 'Open app' : 'Sign in'}
              </Link>
            </div>
            <nav
              className="flex items-center gap-5 overflow-x-auto pb-3 pr-3 text-sm md:hidden"
              aria-label="Primary mobile"
            >
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    isActive ? 'font-medium text-slate-900' : 'text-slate-700'
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </GlassSurface>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <SiteFooter nav={NAV} signedIn={!!session} />
    </div>
  )
}
