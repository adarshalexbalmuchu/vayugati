import { useRef } from 'react'
import { ScrollTrigger, gsap, useGsap } from './motion'
import { POSE_COUNT, PersonSymbols } from './people'
import { useInView } from './ui'

const PM25: [string, number][] = [
  ['Delhi', 88.4],
  ['Bihar', 60.1],
  ['Haryana', 58.7],
  ['Uttar Pradesh', 56.2],
  ['Chhattisgarh', 51.5],
  ['Punjab', 49.6],
  ['West Bengal', 46.9],
  ['Jharkhand', 42.1],
  ['Rajasthan', 38.3],
  ['Madhya Pradesh', 36.8],
  ['Odisha', 36.4],
  ['Maharashtra', 33.9],
  ['Karnataka', 21.4],
  ['Kerala', 18.5],
]
const MAX = 95
const WHO = 5
const INDIA = 40
const pct = (v: number) => `${(v / MAX) * 100}%`

export function Pm25Chart() {
  const [ref, seen] = useInView<HTMLDivElement>()
  const cols = 'grid grid-cols-[6.5rem_1fr_2.75rem] sm:grid-cols-[8rem_1fr_3rem] items-center gap-x-3'
  return (
    <div
      ref={ref}
      role="img"
      aria-label="Annual average PM2.5 in 2023 by state, in micrograms per cubic metre. Delhi 88.4, Bihar 60.1, Haryana 58.7, Uttar Pradesh 56.2, Chhattisgarh 51.5, Punjab 49.6, West Bengal 46.9, Jharkhand 42.1, Rajasthan 38.3, Madhya Pradesh 36.8, Odisha 36.4, Maharashtra 33.9, Karnataka 21.4, Kerala 18.5. The WHO guideline is 5 and India's standard is 40."
    >
      <div className={`${cols} mb-2 text-[11px] leading-tight text-slate-500`}>
        <span />
        <div className="relative h-8">
          <span className="absolute -translate-x-1/2 text-center" style={{ left: pct(WHO) }}>
            WHO<span className="hidden sm:inline"> guideline</span>
            <br />
            {WHO}
          </span>
          <span className="absolute -translate-x-1/2 text-center" style={{ left: pct(INDIA) }}>
            India<span className="hidden sm:inline"> standard</span>
            <br />
            {INDIA}
          </span>
        </div>
        <span className="text-right">µg/m³</span>
      </div>
      <ul className="space-y-1.5" aria-hidden>
        {PM25.map(([name, v]) => {
          const hl = name === 'Jharkhand'
          return (
            <li key={name} className={`${cols} text-sm`}>
              <span className={`truncate ${hl ? 'font-semibold text-ink-900' : 'text-slate-600'}`}>{name}</span>
              <div className="relative h-5">
                <div
                  className={`absolute inset-y-0 left-0 rounded-r-md transition-[width] duration-1000 ease-out ${
                    hl ? 'bg-accent-500' : 'bg-ink-200'
                  }`}
                  style={{ width: seen ? pct(v) : '0%' }}
                />
                {[WHO, INDIA].map((m) => (
                  <span
                    key={m}
                    className="absolute -inset-y-[3px] border-l border-dashed border-slate-400/80"
                    style={{ left: pct(m) }}
                  />
                ))}
              </div>
              <span className={`text-right tabular-nums ${hl ? 'font-semibold text-ink-900' : 'text-slate-500'}`}>
                {v}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="mt-4 text-xs text-slate-500">
        Annual average PM2.5, 2023, population-weighted over whole states (villages and towns included). Source: EPIC,
        Air Quality Life Index.
      </p>
    </div>
  )
}

const LOOP = [
  {
    title: 'No monitor in the town',
    body: '88% of statutory towns have none',
    note: 'Where Vayu Gati enters: calibrated local data for towns that have none',
    fig: { to: 88, prefix: '', suffix: '%', caption: 'of statutory towns have no monitor' },
  },
  {
    title: 'No five-year record',
    body: 'of breaching the national standard',
    fig: { to: 5, prefix: '', suffix: ' years', caption: 'of monitored exceedance needed to qualify' },
  },
  {
    title: 'Not on the NCAP list',
    body: '131 cities are; other towns are not',
    fig: { to: 131, prefix: '', suffix: '', caption: 'cities on the NCAP list' },
  },
  {
    title: 'No NCAP funds',
    body: 'no money for monitors or action',
    fig: { to: 9650, prefix: '₹', suffix: '', caption: 'crore released to those cities' },
  },
]

const ACTIVE = '#2B88D8'

// Four chasing arrows around a ring: each arc is one step of the trap, drawn clockwise. Steps sit counter-clockwise
// of each other, so the ring turning clockwise brings the next step's arc into the active slot at the top.
const C = 150
const R = 108
const STROKE = 30
const HEAD = 26
const pt = (deg: number, r = R) => {
  const a = (deg * Math.PI) / 180
  return [C + r * Math.cos(a), C + r * Math.sin(a)]
}
const ARCS = LOOP.map((_, i) => {
  const start = -90 - i * 90 + 7
  const end = start + 62
  const [x1, y1] = pt(start)
  const [x2, y2] = pt(end)
  const a = (end * Math.PI) / 180
  const tangent = [-Math.sin(a), Math.cos(a)]
  const tip = [x2 + tangent[0] * HEAD, y2 + tangent[1] * HEAD]
  return {
    start,
    end,
    d: `M${x1.toFixed(1)} ${y1.toFixed(1)}A${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`,
    tip: [tip[0].toFixed(1), tip[1].toFixed(1)],
  }
})

// Arrowhead drawn at angle 0 (3 o'clock, pointing down); rotated about the centre to wherever the stroke ends.
const HEAD_W = STROKE / 2 + 9
const HEAD_0 = `${C + R + HEAD_W},${C} ${C + R},${C + HEAD} ${C + R - HEAD_W},${C}`

export function TrapLoop() {
  return (
    <div className="grid items-center gap-10 sm:grid-cols-[20rem_1fr]">
      <div className="relative mx-auto w-[16rem] sm:w-[20rem]">
        <svg data-ring-svg viewBox="0 0 300 300" aria-hidden className="h-auto w-full overflow-visible">
          {ARCS.map((a, i) => (
            <g key={i}>
              <g className="text-white" opacity={0.12}>
                <path d={a.d} fill="none" stroke="currentColor" strokeWidth={STROKE} />
                <polygon points={HEAD_0} transform={`rotate(${a.end} ${C} ${C})`} fill="currentColor" />
              </g>
              <g data-arc style={{ color: i === 0 ? ACTIVE : 'transparent' }}>
                <path data-draw d={a.d} fill="none" stroke="currentColor" strokeWidth={STROKE} />
                <polygon
                  data-head
                  data-start={a.start}
                  data-end={a.end}
                  points={HEAD_0}
                  transform={`rotate(${a.end} ${C} ${C})`}
                  fill="currentColor"
                />
              </g>
              <circle
                data-ping
                cx={a.tip[0]}
                cy={a.tip[1]}
                r={12}
                fill="none"
                stroke={ACTIVE}
                strokeWidth={2}
                opacity={0}
              />
            </g>
          ))}
        </svg>

        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative h-32 w-44 text-center">
            {LOOP.map((s, i) => (
              <div
                key={s.title}
                data-fig
                className="absolute inset-0 flex flex-col items-center justify-center"
                style={{ opacity: i === 0 ? 1 : 0 }}
              >
                <span className="font-display text-5xl leading-none">
                  {s.fig.prefix}
                  <span data-figval data-to={s.fig.to} data-prefix={s.fig.prefix} data-suffix={s.fig.suffix}>
                    {s.fig.to.toLocaleString('en-US')}
                    {s.fig.suffix}
                  </span>
                </span>
                <span className="mt-2 text-xs leading-snug text-cream/70">{s.fig.caption}</span>
              </div>
            ))}
            <div
              data-fig
              className="absolute inset-0 flex flex-col items-center justify-center"
              style={{ opacity: 0 }}
            >
              <span className="font-display text-4xl italic leading-none">no monitor</span>
              <span className="mt-2 text-xs leading-snug text-cream/70">and the loop starts again</span>
            </div>
          </div>
        </div>
      </div>

      <ol className="space-y-6">
        {LOOP.map((s, i) => (
          <li key={s.title} data-step className="flex gap-4">
            <span
              data-dot
              aria-hidden
              className="mt-2 h-3 w-3 shrink-0 rounded-full"
              style={{ background: i === 0 ? '#2B88D8' : 'rgba(255,255,255,0.25)' }}
            />
            <div>
              <h3 className="text-lg font-semibold">{s.title}</h3>
              <p className="mt-0.5 text-sm text-cream/70">{s.body}</p>
              {s.note && <p className="mt-2 text-sm font-medium text-sky-300">{s.note}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

const SITUATIONS = [
  {
    pct: 4,
    name: 'Within reach',
    range: 'within 2 km of a monitor',
    constraint: 'One station, one point; data can fail unnoticed',
    need: 'Quality control, and readings extended across the ward or town',
  },
  {
    pct: 49,
    name: "In a monitor's shadow",
    range: '2–50 km from a monitor',
    constraint: 'A distant station cannot see local sources',
    need: 'Local sensors, calibrated against that station',
  },
  {
    pct: 47,
    name: 'Beyond the network',
    range: 'more than 50 km away',
    constraint: 'No data at all; estimates explain only about half',
    need: 'Local sensors first; satellite and models as a backstop',
    note: '655 million people',
  },
]

// A crowd of 100 people, one per 1% of Indians, in four rows: first those within 2 km of a monitor,
// then the 2-50 km shadow, then those beyond 50 km. Counts are exact: 4, 49 and 47.
const ROWS = 4
const COL_X = (c: number) => 70 + c * 40
const ROW_Y = (r: number) => 22 + r * 46
const GROUP_COLOR = ['#1F6FBF', '#5FA3E3', '#B79B6E']
const PEOPLE = Array.from({ length: 100 }, (_, n) => {
  const col = Math.floor(n / ROWS)
  const row = n % ROWS
  const group = n < 4 ? 0 : n < 53 ? 1 : 2
  const child = n % 7 === 3
  return { n, group, x: COL_X(col), y: ROW_Y(row), child, pose: (n + Math.floor(n / 4)) % POSE_COUNT }
})
const VB_W = 1100
const pctX = (x: number) => `${(x / VB_W) * 100}%`

export function DistanceCards() {
  const rootRef = useRef<HTMLDivElement>(null)

  useGsap(rootRef, (_c, q) => {
    const people = [0, 1, 2].map((g) => q(`[data-person="${g}"]`))
    const allPeople = q('[data-person]')
    const links = q('[data-link]')
    const cols = q('[data-col]')
    const pcts = q('[data-pct]') as HTMLElement[]
    const tower = q('[data-tower]')
    const bracket = q('[data-bracket]')
    const bracketText = q('[data-bracket-text]')
    const OFF = 'rgba(66,43,28,0.14)'

    gsap.set(allPeople, { color: OFF, y: 6 })
    gsap.set(links, { opacity: 0 })
    gsap.set(cols, { opacity: 0, y: 18 })
    gsap.set(bracket, { scaleX: 0, transformOrigin: '50% 50%' })
    gsap.set(bracketText, { opacity: 0, y: 10 })
    gsap.set(tower, { opacity: 0.35 })
    pcts.forEach((el) => {
      el.textContent = '0'
    })

    // Plays once on a clock, so it stays smooth at any scroll speed.
    const tl = gsap.timeline({ paused: true })
    let t = 0
    tl.to(tower, { opacity: 1, duration: 0.5 }, 0)
    people.forEach((ps, g) => {
      const per = g === 0 ? 0.09 : 0.016
      const span = ps.length * per
      tl.to(ps, { color: GROUP_COLOR[g], y: 0, duration: 0.45, ease: 'back.out(1.8)', stagger: per }, t)
      tl.to(links[g], { opacity: 1, duration: 0.5 }, t + span * 0.4)
      tl.to(cols[g], { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' }, t + span * 0.4 + 0.15)
      const obj = { v: 0 }
      tl.to(
        obj,
        {
          v: Number((pcts[g] as HTMLElement).dataset.to),
          duration: Math.max(0.7, span),
          ease: 'power2.out',
          onUpdate: () => {
            pcts[g].textContent = String(Math.round(obj.v))
          },
        },
        t,
      )
      t += span + 0.45
    })
    // Everyone is covered: the whole crowd turns blue, centre outward.
    tl.to(allPeople, { color: ACTIVE, duration: 0.4, stagger: { each: 0.006, from: 'start' } }, t + 0.1)
    tl.to(bracket, { scaleX: 1, duration: 0.8, ease: 'power3.inOut' }, t + 0.1)
    tl.to(bracketText, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' }, t + 0.5)

    // After the intro the crowd keeps cycling: each group takes a turn (with its column), then everyone lights up.
    const arcs = q('[data-arcs]')
    const REST = 'rgba(66,43,28,0.14)'
    const loopTl = gsap.timeline({ paused: true, repeat: -1 })
    const turn = (g: number, at: number) => {
      loopTl.to(allPeople, { color: REST, duration: 0.35 }, at)
      loopTl.to(people[g], { color: GROUP_COLOR[g], duration: 0.4, stagger: g === 0 ? 0.08 : 0.01 }, at + 0.15)
      loopTl.fromTo(
        people[g],
        { y: 0 },
        { y: -6, duration: 0.25, yoyo: true, repeat: 1, ease: 'sine.inOut', stagger: g === 0 ? 0.08 : 0.01 },
        at + 0.15,
      )
      loopTl.to(cols, { opacity: (i: number) => (i === g ? 1 : 0.3), duration: 0.4 }, at)
    }
    turn(0, 0)
    turn(1, 2.4)
    turn(2, 4.8)
    const sweep = 7.2
    loopTl.to(allPeople, { color: ACTIVE, duration: 0.4, stagger: 0.008 }, sweep)
    loopTl.fromTo(allPeople, { y: 0 }, { y: -6, duration: 0.25, yoyo: true, repeat: 1, ease: 'sine.inOut', stagger: 0.008 }, sweep)
    loopTl.to(cols, { opacity: 1, duration: 0.4 }, sweep)
    loopTl.fromTo(arcs, { opacity: 0.25 }, { opacity: 1, duration: 0.3, yoyo: true, repeat: 3 }, sweep)
    loopTl.to({}, { duration: 2.6 }, sweep + 0.4)

    let introDone = false
    let inView = false
    tl.eventCallback('onComplete', () => {
      introDone = true
      if (inView) loopTl.play()
    })
    // The loop only runs while the crowd is on screen.
    ScrollTrigger.create({
      trigger: rootRef.current,
      start: 'top bottom',
      end: 'bottom top',
      refreshPriority: -1,
      onToggle: (self) => {
        inView = self.isActive
        if (!introDone) return
        if (inView) loopTl.play()
        else loopTl.pause()
      },
    })
    ScrollTrigger.create({
      trigger: rootRef.current,
      start: 'top 70%',
      once: true,
      refreshPriority: -1,
      onEnter: () => {
        tl.play()
      },
    })
  })

  return (
    <div ref={rootRef}>
      <div className="relative">
        <svg
          viewBox={`0 0 ${VB_W} 218`}
          role="img"
          aria-label="A crowd of 100 people, each one per cent of Indians: 4 within 2 km of a monitor, 49 between 2 and 50 km, 47 beyond 50 km."
          className="h-auto w-full"
        >
          <defs>
            <PersonSymbols prefix="dc" />
          </defs>

          <path d="M10 206H1090" stroke="rgba(66,43,28,0.25)" strokeWidth={1.5} fill="none" />
          <g stroke="rgba(66,43,28,0.3)" strokeDasharray="3 5" strokeWidth={1.2}>
            <path d="M104 14V206" />
            <path d="M584 14V206" />
          </g>

          <g data-tower fill="#422B1C">
            <rect x="22" y="26" width="16" height="22" rx="3" />
            <rect x="28.5" y="48" width="3" height="158" />
            <path data-arcs d="M18 20a16 16 0 0 1 24 0M12 13a24 24 0 0 1 36 0" fill="none" stroke="#422B1C" strokeWidth="2" strokeLinecap="round" />
          </g>

          {PEOPLE.map((p) => (
            <use
              key={p.n}
              data-person={p.group}
              href={`#dc-${p.pose}`}
              x={p.x}
              y={p.child ? p.y + 9.6 : p.y}
              width={p.child ? 22 : 28}
              height={p.child ? 35.2 : 44.8}
              style={{ color: GROUP_COLOR[p.group] }}
            />
          ))}
        </svg>

        <div className="relative mt-1 h-5 text-xs text-slate-500">
          <span className="absolute -translate-x-1/2" style={{ left: pctX(30) }}>
            monitor
          </span>
          <span className="absolute -translate-x-1/2" style={{ left: pctX(104) }}>
            2 km
          </span>
          <span className="absolute -translate-x-1/2" style={{ left: pctX(584) }}>
            50 km
          </span>
          <span className="absolute right-0">farther from a monitor</span>
        </div>
        <p className="mt-2 text-xs text-slate-500">Each person is 1% of Indians. Distances are not to scale.</p>
      </div>

      <svg viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden className="mt-2 hidden h-12 w-full md:block">
        <g fill="none" stroke="rgba(66,43,28,0.35)" strokeWidth={1.2} vectorEffect="non-scaling-stroke">
          {[
            ['M7.6 0V5H0.6V14', 0],
            ['M31.3 0V5H35.3V14', 1],
            ['M74.9 0V5H69.9V14', 2],
          ].map(([d, i]) => (
            <path key={i} data-link d={String(d)} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      </svg>

      <div className="mt-2 grid gap-y-12 md:grid-cols-3 md:gap-x-[4%]">
        {SITUATIONS.map((s) => (
          <div key={s.name} data-col>
            <p className="text-base font-semibold">{s.name}</p>
            <p className="text-sm text-slate-500">{s.range}</p>
            <p className="mt-4 font-display text-[clamp(4.5rem,7vw,6.5rem)] leading-[0.85]">
              <span data-pct data-to={s.pct}>
                {s.pct}
              </span>
              <span className="text-[0.5em]">%</span>
            </p>
            <p className="mt-2 text-sm text-slate-600">of Indians{s.note ? ` (${s.note})` : ''}</p>
            <dl className="mt-6 space-y-4 text-sm">
              <div>
                <dt className="text-xs font-medium text-slate-500">Constraint</dt>
                <dd className="mt-1">{s.constraint}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-slate-500">What is needed</dt>
                <dd className="mt-1">{s.need}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>

      <div className="mt-14">
        <div data-bracket className="h-3 w-full border-x-2 border-b-2 border-accent-500" />
        <div data-bracket-text className="mt-4 text-center">
          <p className="text-2xl font-semibold text-accent-700 sm:text-3xl">Vayu Gati in every case</p>
          <p className="mx-auto mt-2 max-w-2xl leading-relaxed text-slate-600">
            Calibrated sensors, automatic quality checks, ward-level estimates and forecasts, and alerts and tasks for
            local officials.
          </p>
        </div>
      </div>
    </div>
  )
}

export function ShareBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 w-28 overflow-hidden rounded-full bg-ink-100">
        <div className={`h-full rounded-full ${value < 50 ? 'bg-status-warning' : 'bg-accent-500'}`} style={{ width: `${value}%` }} />
      </div>
      <span className="tabular-nums">{value}%</span>
    </div>
  )
}
