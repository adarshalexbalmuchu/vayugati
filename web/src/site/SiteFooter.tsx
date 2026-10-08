import { ArrowUp } from 'lucide-react'
import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { LogoWordmark } from '../components/AppShell'
import { ScrollTrigger, gsap, useGsap } from './motion'
import { POSE_COUNT, PersonSymbols } from './people'
import { Container, Em } from './ui'

const COUNT = 30
const STEP = 1100 / COUNT
const FIGURES = Array.from({ length: COUNT }, (_, i) => ({
  i,
  x: STEP * i + 8,
  child: i % 6 === 4,
  pose: (i * 3 + 1) % POSE_COUNT,
}))

export function SiteFooter({ nav, signedIn }: { nav: { to: string; label: string }[]; signedIn: boolean }) {
  const rootRef = useRef<HTMLElement>(null)

  useGsap(rootRef, (_c, q) => {
    const figs = q('[data-ffig]')
    const REST = 'rgba(246,239,228,0.14)'
    gsap.set(figs, { color: REST, y: 8 })

    // The crowd stands up and fills in blue, then does a slow wave while the footer is on screen.
    const intro = gsap.timeline({ paused: true })
    intro.to(figs, {
      color: (i: number) => gsap.utils.interpolate('#2B88D8', '#9FE6FB', i / (COUNT - 1)),
      y: 0,
      duration: 0.5,
      ease: 'back.out(1.8)',
      stagger: 0.045,
    })
    const wave = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 3.5 })
    wave.fromTo(figs, { y: 0 }, { y: -7, duration: 0.3, yoyo: true, repeat: 1, ease: 'sine.inOut', stagger: 0.07 })

    let introDone = false
    let inView = false
    intro.eventCallback('onComplete', () => {
      introDone = true
      if (inView) wave.play()
    })
    ScrollTrigger.create({
      trigger: rootRef.current,
      start: 'top 85%',
      once: true,
      refreshPriority: -1,
      onEnter: () => {
        intro.play()
      },
    })
    ScrollTrigger.create({
      trigger: rootRef.current,
      start: 'top bottom',
      refreshPriority: -1,
      onToggle: (self) => {
        inView = self.isActive
        if (!introDone) return
        if (inView) wave.play()
        else wave.pause()
      },
    })
  })

  return (
    <footer ref={rootRef} className="bg-ink-900 text-cream">
      <Container className="pb-8 pt-20 sm:pt-28">
        <div className="grid gap-14 lg:grid-cols-12 lg:items-end">
          <div className="lg:col-span-8">
            <LogoWordmark className="h-12 w-auto brightness-0 invert" />
            <h2 className="mt-10 text-[clamp(2.8rem,6.2vw,6.25rem)] font-semibold leading-[1] tracking-[-0.03em]">
              From information
              <br />
              <Em className="text-sky-300">to action.</Em>
            </h2>
            <p className="mt-8 max-w-xl text-lg leading-relaxed text-cream/65">
              Closing the gap between air-quality information and local action, starting with the towns India has not
              yet measured.
            </p>
          </div>

          <nav aria-label="Footer" className="lg:col-span-4 lg:justify-self-end">
            <ul className="space-y-3">
              {nav.map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className="inline-block text-3xl font-medium tracking-[-0.01em] transition hover:translate-x-1 hover:text-sky-300"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
              <li>
                <Link
                  to="/app"
                  className="inline-block text-3xl font-medium tracking-[-0.01em] text-cream/60 transition hover:translate-x-1 hover:text-sky-300"
                >
                  {signedIn ? 'Open app' : 'Sign in'}
                </Link>
              </li>
            </ul>
          </nav>
        </div>

        <svg viewBox="0 0 1100 100" aria-hidden className="mt-20 h-auto w-full">
          <defs>
            <PersonSymbols prefix="ft" />
            <pattern id="footer-zigzag" width="16" height="8" patternUnits="userSpaceOnUse">
              <path d="M0 8L8 1L16 8Z" fill="rgba(246,239,228,0.2)" />
            </pattern>
          </defs>
          <path d="M0 92H1100" stroke="rgba(246,239,228,0.22)" strokeWidth={1.5} fill="none" />
          <rect x="0" y="94" width="1100" height="6" fill="url(#footer-zigzag)" />
          {FIGURES.map((f) => (
            <use
              key={f.i}
              data-ffig
              href={`#ft-${f.pose}`}
              x={f.x}
              y={f.child ? 55.6 : 46}
              width={f.child ? 22 : 28}
              height={f.child ? 35.2 : 44.8}
              style={{ color: '#2B88D8' }}
            />
          ))}
        </svg>

        <div className="mt-6 flex items-center justify-between text-sm text-cream/50">
          <span>© {new Date().getFullYear()} Vayu Gati</span>
          <button
            type="button"
            onClick={() => window.scrollTo({ top: 0 })}
            className="inline-flex items-center gap-2 transition hover:text-sky-300"
          >
            Back to top <ArrowUp className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </Container>
    </footer>
  )
}
