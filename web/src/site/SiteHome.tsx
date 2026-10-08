import { ArrowRight } from 'lucide-react'
import { useRef } from 'react'
import { Link } from 'react-router-dom'
import headerSkyline from '../assets/header-skyline.jpg'
import { DistanceCards, Pm25Chart, TrapLoop } from './charts'
import { CAPABILITIES, LEVERS } from './content'
import { JharkhandMap, JharkhandMapCaption } from './maps'
import { Words, ScrubText, ScrollTrigger, gsap, useGsap } from './motion'
import { BTN_PRIMARY, Band, Container, Em, H2, Lead, TEXT_LINK } from './ui'

const STATS = [
  { prefix: '', to: 12, suffix: '%', label: "of India's 4,041 statutory towns have any air-quality monitor", tone: 'bg-white text-ink-900' },
  { prefix: '', to: 47, suffix: '%', label: 'of Indians live more than 50 km from a monitor', tone: 'bg-sky-200 text-ink-900' },
  { prefix: '<', to: 1, suffix: '%', label: "of Jharkhand's residents live within 2 km of a real-time monitor", tone: 'bg-ink-100 text-ink-900' },
  { prefix: '', to: 2, suffix: '', label: 'Jharkhand stations reporting to the national real-time feed, September 2026', tone: 'bg-ink-900 text-cream' },
]

export default function SiteHome() {
  const rootRef = useRef<HTMLDivElement>(null)

  useGsap(rootRef, (c, q) => {
    const hero = q('[data-hero]')[0]

    // Hero: headline words rise out of a mask, then the rest settles in.
    gsap
      .timeline({ defaults: { ease: 'power4.out' } })
      .from(q('[data-word]'), { yPercent: 118, duration: 1.2, stagger: 0.07 })
      .from(q('[data-hero-fade]'), { y: 26, opacity: 0, duration: 0.9, stagger: 0.12 }, '-=0.7')

    // Scrolling away, the hero text fades out: the unmeasured go unseen.
    gsap.to(q('[data-hero-text]'), {
      y: -70,
      opacity: 0.08,
      ease: 'none',
      scrollTrigger: { trigger: hero, start: 'top top', end: '75% top', scrub: true },
    })
    gsap.to(q('[data-hero-skyline]'), {
      yPercent: 35,
      ease: 'none',
      scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: true },
    })

    // Key numbers: each card opens upward like a shutter, then the next one stacks over it.
    const cards = q('[data-card]')
    cards.forEach((card, i) => {
      const inner = card.querySelector('[data-card-inner]')
      gsap.fromTo(
        inner,
        { clipPath: 'inset(100% 0% 0% 0% round 28px)' },
        {
          clipPath: 'inset(0% 0% 0% 0% round 28px)',
          ease: 'none',
          scrollTrigger: { trigger: card, start: 'top 100%', end: 'top 45%', scrub: true },
        },
      )
      const num = card.querySelector<HTMLElement>('[data-num]')
      if (num && Number(num.dataset.to) >= 5) {
        const to = Number(num.dataset.to)
        const obj = { v: 0 }
        num.textContent = '0' + (num.dataset.suffix ?? '')
        gsap.to(obj, {
          v: to,
          duration: 1.4,
          ease: 'power2.out',
          scrollTrigger: { trigger: card, start: 'top 75%', once: true },
          onUpdate: () => {
            num.textContent = Math.round(obj.v) + (num.dataset.suffix ?? '')
          },
        })
      }
      if (cards[i + 1]) {
        gsap.to(inner, {
          scale: 0.94,
          transformOrigin: '50% 0%',
          ease: 'none',
          scrollTrigger: { trigger: cards[i + 1], start: 'top 90%', end: 'top 25%', scrub: true },
        })
        gsap.to(card.querySelector('[data-card-dim]'), {
          opacity: 0.14,
          ease: 'none',
          scrollTrigger: { trigger: cards[i + 1], start: 'top 90%', end: 'top 25%', scrub: true },
        })
      }
    })

    // The trap: the section pins and the loop closes itself step by step.
    const gap = q('#gap')[0]
    const steps = q('[data-step]')
    const dots = q('[data-dot]')
    const arcs = q('[data-arc]')
    const draws = q('[data-draw]') as SVGPathElement[]
    const heads = q('[data-head]') as SVGElement[]
    const pings = q('[data-ping]')
    const figs = q('[data-fig]')
    const vals = q('[data-figval]') as HTMLElement[]
    const ring = q('[data-ring-svg]')[0]
    const ACTIVE = '#2B88D8'
    const TRAIL = 'rgba(43,136,216,0.4)'
    const IDLE = 'rgba(255,255,255,0.16)'
    const STEP = 1.6
    const lens = draws.map((p) => p.getTotalLength())

    gsap.set(steps, { opacity: 0.2, x: -14 })
    gsap.set(dots, { backgroundColor: IDLE })
    gsap.set(arcs, { color: ACTIVE, opacity: 1 })
    gsap.set(pings, { opacity: 0, transformOrigin: '50% 50%' })
    gsap.set(figs, { opacity: 0, y: 12 })
    draws.forEach((p, i) => gsap.set(p, { strokeDasharray: lens[i], strokeDashoffset: lens[i] }))
    gsap.set(heads, { opacity: 0 })
    gsap.set(ring, { transformOrigin: '50% 50%', rotation: 0, scale: 1 })

    // Scroll only picks the step; the animation itself plays on a clock so it is smooth at any scroll speed.
    const loop = gsap.timeline({ paused: true })
    loop.addLabel('start', 0)

    // Each step the whole ring turns a quarter counter-clockwise, bringing the next arc up to the active slot
    // (back.inOut gives the wind-up and overshoot); the stroke draws on as it arrives, then the figure rolls in.
    steps.forEach((row, i) => {
      const t = i * STEP
      if (i > 0) {
        loop.to(ring, { rotation: -90 * i, duration: 1.1, ease: 'back.inOut(1.3)' }, t)
      }

      loop.to(row, { opacity: 1, x: 0, duration: 0.5, ease: 'power3.out' }, t + 0.1)
      loop.to(dots[i], { backgroundColor: ACTIVE, duration: 0.3 }, t + 0.1)
      loop.fromTo(dots[i], { scale: 0.4 }, { scale: 1, duration: 0.6, ease: 'back.out(3)' }, t + 0.1)

      loop.to(draws[i], { strokeDashoffset: 0, duration: 0.9, ease: 'power2.inOut' }, t + 0.3)
      loop.to(heads[i], { opacity: 1, duration: 0.15 }, t + 1.1)

      loop.set(pings[i], { opacity: 0.9, scale: 0.3 }, t + 1.1)
      loop.to(pings[i], { scale: 2.6, opacity: 0, duration: 0.6, ease: 'power2.out' }, t + 1.1)

      if (i > 0) {
        loop.to(figs[i - 1], { opacity: 0, y: -12, duration: 0.3 }, t + 0.2)
        loop.to(steps[i - 1], { opacity: 0.5, duration: 0.5 }, t + 0.2)
        loop.to(arcs[i - 1], { color: TRAIL, duration: 0.5 }, t + 0.2)
        loop.to(dots[i - 1], { backgroundColor: TRAIL, duration: 0.5 }, t + 0.2)
      }
      loop.to(figs[i], { opacity: 1, y: 0, duration: 0.4, ease: 'power3.out' }, t + 1.0)
      loop.addLabel(`s${i}`, t + 1.58)
      const to = Number(vals[i].dataset.to)
      const suf = vals[i].dataset.suffix ?? ''
      const count = { v: 0 }
      loop.to(
        count,
        {
          v: to,
          duration: 0.55,
          ease: 'power3.out',
          onUpdate: () => {
            vals[i].textContent = Math.round(count.v).toLocaleString('en-US') + suf
          },
        },
        t + 1.0,
      )
    })

    // Loop closed: the ring completes a full turn, lights up all round, and the figure says what happens next.
    const closeAt = steps.length * STEP + 0.1
    loop.to(figs[steps.length - 1], { opacity: 0, y: -12, duration: 0.3 }, closeAt)
    loop.to(ring, { rotation: -90 * steps.length, duration: 1.2, ease: 'back.inOut(1.3)' }, closeAt)
    loop.to(arcs, { color: ACTIVE, duration: 0.4, stagger: 0.12 }, closeAt + 0.3)
    loop.to(steps, { opacity: 1, duration: 0.4, stagger: 0.1 }, closeAt + 0.3)
    loop.to(dots, { backgroundColor: ACTIVE, duration: 0.3, stagger: 0.1 }, closeAt + 0.3)
    loop.to(figs[steps.length], { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, closeAt + 0.7)
    loop.addLabel('close', closeAt + 1.6)

    // Step 1 plays as the section arrives, so the pinned scroll never opens on an empty ring.
    const states = [...steps.map((_, i) => `s${i}`), 'close']
    const N = states.length
    const MARGIN = 0.1
    let current = -1
    let playing: gsap.core.Tween | undefined
    const playTo = (label: string) => {
      const target = loop.labels[label]
      playing?.kill()
      playing = loop.tweenTo(target, {
        duration: Math.min(2, Math.max(0.55, Math.abs(loop.time() - target) * 0.5)),
        ease: 'power1.inOut',
      })
    }
    const area = c.pin ? gap : steps[0].parentElement
    ScrollTrigger.create({
      trigger: area,
      start: 'top 65%',
      onEnter: () => {
        if (current < 0) {
          current = 0
          playTo(states[0])
        }
      },
      onLeaveBack: () => {
        current = -1
        playTo('start')
      },
    })
    ScrollTrigger.create({
      trigger: area,
      ...(c.pin
        ? { start: 'top top', end: '+=2600', pin: true, anticipatePin: 1 }
        : { start: 'top 60%', end: 'bottom 40%' }),
      onUpdate: (self) => {
        const raw = self.progress * N
        const cand = Math.min(N - 1, Math.floor(raw))
        if (cand === current) return
        // Hysteresis: only change step once the scroll clears the boundary, so a hovering wheel never flickers.
        if (cand > current && current >= 0 && raw < cand + MARGIN) return
        if (cand < current && raw > cand + 1 - MARGIN) return
        current = cand
        playTo(states[cand])
      },
    })

    // The reach of the two stations ripples outward and the districts take their colour.
    const row = q('[data-jh-row]')[0]
    const fig = q('[data-jh]')[0] as HTMLElement
    const paths = Array.from(fig.querySelectorAll<SVGPathElement>('path[data-km]'))
    const maxKm = Math.max(...paths.map((p) => Number(p.dataset.km)))
    const pxPerKm = Number(fig.dataset.pxPerKm)
    const readout = fig.querySelector('[data-jh-readout]')
    const kmEl = fig.querySelector('[data-jh-km]')
    const nEl = fig.querySelector('[data-jh-n]')
    const rings = fig.querySelectorAll('[data-ring], [data-ring-fill]')
    const update = (km: number) => {
      if (kmEl) kmEl.textContent = String(Math.round(km))
      if (nEl) nEl.textContent = String(paths.filter((p) => Number(p.dataset.km) <= km).length)
    }
    gsap.set(paths, { fill: '#EDE0CB' })
    gsap.set(readout, { autoAlpha: 1 })
    update(0)
    const ripple = gsap.timeline({
      scrollTrigger: c.pin
        ? { trigger: row, start: 'top 110px', end: '+=1800', pin: true, scrub: true, anticipatePin: 1 }
        : { trigger: row, start: 'top 70%', end: 'bottom 45%', scrub: true },
    })
    const proxy = { km: 0 }
    ripple.to(proxy, { km: maxKm, ease: 'none', duration: 1, onUpdate: () => update(proxy.km) }, 0)
    ripple.to(rings, { attr: { r: maxKm * pxPerKm }, ease: 'none', duration: 1 }, 0)
    paths.forEach((p) => {
      ripple.to(p, { fill: p.dataset.fill, duration: 0.05, ease: 'none' }, (Number(p.dataset.km) / maxKm) * 0.95)
    })

    // Pinned blocks get a fixed height; re-measure if their content later changes size.
    let timer = 0
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => ScrollTrigger.refresh(), 120)
    })
    ro.observe(fig)
    if (steps[0].parentElement) ro.observe(steps[0].parentElement)
    return () => {
      window.clearTimeout(timer)
      ro.disconnect()
    }
  })

  return (
    <div ref={rootRef}>
      <section data-hero className="relative overflow-hidden bg-gradient-to-b from-sky-300 via-sky-200 to-sky-100 text-ink-900">
        <Container className="relative z-10 pb-52 pt-36 sm:pb-64 sm:pt-44">
          <div data-hero-text className="will-change-transform">
            <h1 className="max-w-4xl text-4xl font-semibold leading-[1.08] tracking-[-0.015em] sm:text-6xl">
              <Words text="India’s air-quality crisis is national." />{' '}
              <Em className="text-accent-700">
                <Words text="Its measurement is not." />
              </Em>
            </h1>
            <Lead className="mt-6 max-w-2xl">
              <span data-hero-fade className="block">
                Small towns and poorer states are not only exposed to polluted air. They are invisible to the systems
                built to help them. Vayu Gati closes the gap between air-quality information and local action.
              </span>
            </Lead>
            <Link to="/platform" data-hero-fade className={`${BTN_PRIMARY} mt-8`}>
              Explore the platform
            </Link>
          </div>
        </Container>
        <img
          data-hero-skyline
          src={headerSkyline}
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-32 w-full object-cover opacity-90 sm:h-auto [mask-image:linear-gradient(to_bottom,transparent,black_35%)]"
        />
      </section>

      <section className="bg-cream">
        <Container className="pb-24 pt-10 sm:pt-16">
          {STATS.map((s, i) => (
            <div
              key={s.label}
              data-card
              className="sticky"
              style={{ top: `calc(7rem + ${i}rem)`, marginBottom: i < STATS.length - 1 ? '16vh' : 0, zIndex: i + 1 }}
            >
              <div
                data-card-inner
                className={`relative flex min-h-[20rem] will-change-transform flex-col justify-between gap-8 rounded-[28px] p-8 ring-1 ring-ink-900/10 sm:p-12 lg:h-[min(60vh,30rem)] lg:flex-row lg:items-center ${s.tone}`}
              >
                <div
                  data-card-dim
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-[28px] bg-ink-900 opacity-0"
                />
                <div
                  data-num
                  data-to={s.to}
                  data-suffix={s.suffix}
                  className="font-display text-[clamp(6rem,14vw,12rem)] leading-none"
                >
                  {s.prefix}
                  {s.to}
                  {s.suffix}
                </div>
                <p className="max-w-sm text-xl leading-snug sm:text-2xl lg:text-right">{s.label}</p>
              </div>
            </div>
          ))}
        </Container>
      </section>

      <Band tone="ink" id="gap" fill>
        <div className="grid items-center gap-14 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <H2>Small towns are not only exposed. <Em>They are invisible.</Em></H2>
            <p className="mt-6 text-lg leading-relaxed text-cream/75">
              All 1.4 billion Indians breathe air above the WHO guideline, and the burden is heaviest in low-income
              states. Yet monitoring, funding and forecasting remain concentrated in a few large cities.
            </p>
            <p className="mt-4 leading-relaxed text-cream/65">
              The National Clean Air Programme selects cities by five consecutive years of monitored exceedance. A
              town without a monitor cannot enter the programme, receive its funds or be held to its targets.
            </p>
            <Link to="/evidence" className={`${TEXT_LINK} mt-6 !text-sky-300`}>
              Read the evidence <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
          <div className="lg:col-span-7">
            <TrapLoop />
          </div>
        </div>
      </Band>

      <Band tone="cream" id="jharkhand">
        <H2 className="max-w-3xl">
          Jharkhand sees the gap <Em>sharply</Em>
        </H2>

        <div data-jh-row className="mt-12 grid items-center gap-10 lg:grid-cols-12">
          <div className="rounded-xl border border-ink-900/10 bg-white p-6 sm:p-8 lg:col-span-7">
            <JharkhandMap />
          </div>
          <div className="lg:col-span-5">
            <p className="text-2xl font-semibold leading-snug tracking-tight">
              Two stations. <Em>Both in Dhanbad.</Em>
            </p>
            <p className="mt-4 leading-relaxed text-slate-600">
              In September 2026 these were the only stations in the state reporting to the national real-time feed, and
              the main one failed basic quality checks. Only Dhanbad and Bokaro districts lie within 50 km of a
              station; Ranchi and Jamshedpur are both well over 100 km away.
            </p>
          </div>
        </div>
        <JharkhandMapCaption />

        <div className="mt-20 grid items-start gap-12 lg:grid-cols-2">
          <div>
            <div className="font-display text-8xl leading-none text-accent-600 sm:text-9xl">42.1</div>
            <p className="mt-3 text-lg">
              µg/m³ statewide average PM2.5 in 2023, above India&rsquo;s own standard of 40.
            </p>
            <ul className="mt-6 space-y-2 text-slate-700">
              <li>Three in four residents live in rural areas.</li>
              <li>Fewer than 1% live within 2 km of a real-time monitor.</li>
            </ul>
            <div className="mt-8">
              <p className="text-sm font-medium text-slate-500">Dhanbad–Jharia coalfield</p>
              <p className="mt-1 text-lg">
                <span className="font-semibold">322 µg/m³</span> PM10 at Jharia in 2018, India&rsquo;s highest.
              </p>
              <p className="mt-1 text-sm text-slate-600">
                Underground coal fires have burned here since 1916, and about 500,000 people breathe their fumes.
              </p>
            </div>
          </div>
          <div className="rounded-xl border border-ink-900/10 bg-white p-6 sm:p-8">
            <Pm25Chart />
          </div>
        </div>
      </Band>

      <Band tone="white" id="approach">
        <div className="max-w-4xl">
          <H2>
            Measurement first, at <Em>every distance</Em> from a monitor
          </H2>
          <Lead className="mt-5">
            What people can know about their air depends on how far they live from a working monitor, and the
            constraint differs in each situation.
          </Lead>
        </div>
        <div className="mt-12">
          <DistanceCards />
        </div>

        <blockquote className="mt-20 max-w-3xl text-2xl font-semibold leading-snug tracking-[-0.015em] sm:text-3xl">
          <ScrubText
            parts={[
              'Small-town India’s clean-air challenge is not first a policy gap. It is an',
              { em: 'information gap.' },
            ]}
          />
        </blockquote>

        <div className="mt-16 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {LEVERS.map((l) => (
            <div key={l.title} data-reveal className="border-t border-ink-900/20 pt-4">
              <h3 className="font-semibold">{l.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{l.body}</p>
            </div>
          ))}
        </div>
      </Band>

      <Band tone="cream" id="built">
        <div className="grid items-start gap-14 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <H2>
              A working platform on <Em>live Delhi data</Em>
            </H2>
            <Lead className="mt-5">
              Vayu Gati is a small, independent team. Our platform is validated on live data from Delhi&rsquo;s 44
              official monitors.
            </Lead>
            <p className="mt-6 text-lg font-medium leading-snug">
              Building it taught us one lesson above all: software cannot help a town that has no data.
            </p>
            <Link to="/platform" className={`${TEXT_LINK} mt-6`}>
              See the platform <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
          <div className="grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:col-span-7">
            {CAPABILITIES.map((c) => (
              <div key={c.title} data-reveal className="border-t border-ink-900/20 pt-4">
                <h3 className="font-semibold">{c.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </Band>

      <section className="bg-gradient-to-b from-sky-200 to-sky-300 text-ink-900">
        <Container className="py-20 sm:py-24">
          <H2 className="max-w-2xl">
            We start with one coalfield: <Em>Dhanbad–Jharia</Em>
          </H2>
          <Lead className="mt-5 max-w-2xl">
            A failing reference station and a large monitor shadow sit side by side. If measurement-first works here,
            it can work in the towns that are still unseen.
          </Lead>
          <Link to="/contact" className={`${TEXT_LINK} mt-6`}>
            Get in touch <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </Container>
      </section>
    </div>
  )
}
