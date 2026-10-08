import { Link } from 'react-router-dom'
import { DELIVERABLES, FOUNDER, PHASES, SITUATIONS } from './content'
import { BTN_PRIMARY, Band, Em, H2, Lead, PageHero, Stat, TEXT_LINK } from './ui'

const initials = FOUNDER.name
  .split(' ')
  .filter((_, i, a) => i === 0 || i === a.length - 1)
  .map((w) => w[0])
  .join('')

export default function AboutPage() {
  return (
    <>
      <PageHero
        title={
          <>
            A small team making <Em>local air</Em> visible
          </>
        }
        lead="Vayu Gati is a small, independent team building the tools to close the gap between air-quality information and local action."
      />

      <Band tone="white">
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <div>
            <H2>
              Software cannot help a town <Em>that has no data</Em>
            </H2>
            <Lead className="mt-5">
              We built and validated a working platform on live data from Delhi’s 44 official monitors. It estimates
              air quality for every ward, forecasts six pollutants and routes alerts to ward officers. Building it
              taught us one lesson above all: where there is no monitor, there is nothing for software to work with.
            </Lead>
          </div>
          <div className="grid gap-10 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            <Stat value="44" label="official Delhi monitors the platform runs on" />
            <Stat value="18%" label="of NO₂ monitor-days lost to stuck analysers across the Indo-Gangetic plain" />
            <Stat value="12%" label="of India’s 4,041 statutory towns have any air-quality monitor" />
          </div>
        </div>
      </Band>

      <Band tone="cream">
        <H2 className="max-w-3xl">
          What people can know about their air depends on <Em>how far they live from a monitor</Em>
        </H2>
        <div className="mt-12 grid gap-x-10 gap-y-10 md:grid-cols-3">
          {SITUATIONS.map((s) => (
            <div key={s.range} data-reveal className="border-t border-ink-900/20 pt-4">
              <h3 className="text-lg font-semibold">{s.range}</h3>
              <p className="mt-1 text-sm text-accent-700">{s.share}</p>
              <p className="mt-3 leading-relaxed text-slate-600">{s.body}</p>
            </div>
          ))}
        </div>
      </Band>

      <Band tone="ink">
        <H2 className="max-w-3xl">
          We start with <Em>one coalfield</Em>
        </H2>
        <Lead className="mt-5 max-w-2xl">
          Dhanbad and Jharia is where a failing reference station and a large monitor shadow sit side by side. Our
          approach complements reference monitoring rather than replacing it, at about 55 to 60% of what one government
          reference station costs to run for a year.
        </Lead>
        <div className="mt-12 grid gap-8 md:grid-cols-2">
          {PHASES.map((p) => (
            <div key={p.label} data-reveal className="rounded-lg border border-cream/15 p-6">
              <p className="text-sm text-sky-200">{p.label}</p>
              <h3 className="mt-2 text-xl font-semibold">{p.title}</h3>
              <p className="mt-3 leading-relaxed opacity-75">{p.body}</p>
            </div>
          ))}
        </div>
      </Band>

      <Band tone="white">
        <div className="grid gap-14 lg:grid-cols-[18rem_1fr]">
          <div data-reveal>
            <div
              aria-hidden
              className="flex h-40 w-40 items-center justify-center rounded-full bg-sky-200 font-display text-5xl text-ink-900"
            >
              {initials}
            </div>
          </div>
          <div>
            <p className="text-sm text-accent-700">{FOUNDER.role}</p>
            <H2 className="mt-2">{FOUNDER.name}</H2>
            <div className="mt-5 max-w-2xl space-y-4">
              {FOUNDER.bio.map((p) => (
                <Lead key={p}>{p}</Lead>
              ))}
            </div>
            <ul className="mt-6 flex flex-wrap gap-2">
              {FOUNDER.principles.map((p) => (
                <li key={p} className="rounded-full border border-ink-900/15 px-4 py-1.5 text-sm text-slate-700">
                  {p}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Band>

      <Band tone="cream">
        <H2 className="max-w-3xl">
          What the first phase will <Em>deliver</Em>
        </H2>
        <ul className="mt-10 grid gap-x-10 gap-y-6 sm:grid-cols-2">
          {DELIVERABLES.map((d) => (
            <li key={d} data-reveal className="border-t border-ink-900/20 pt-4 leading-relaxed text-slate-700">
              {d}
            </li>
          ))}
        </ul>
        <div className="mt-12 flex flex-wrap items-center gap-6">
          <Link to="/contact" className={BTN_PRIMARY}>
            Get in touch
          </Link>
          <Link to="/evidence" className={TEXT_LINK}>
            Read the evidence →
          </Link>
        </div>
      </Band>
    </>
  )
}
