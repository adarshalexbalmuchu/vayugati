import { SOURCES } from './content'
import { ScrubText } from './motion'
import { Band, DataTable, Em, H2, Lead, PageHero, Stat } from './ui'

const SECTIONS = [
  ['burden', 'The burden'],
  ['coverage', 'Coverage'],
  ['quality', 'Data quality'],
  ['plans', 'National plans'],
  ['missing', 'What is missing'],
  ['sources', 'Sources'],
]

export default function EvidencePage() {
  return (
    <>
      <PageHero
        title={
          <>
            Where the air is barely measured, it is hard to <Em>act on</Em>
          </>
        }
        lead="The evidence behind our work, with every figure dated and sourced."
      >
        <nav aria-label="On this page" className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="text-accent-700 underline-offset-4 hover:underline">
              {label}
            </a>
          ))}
        </nav>
      </PageHero>

      <Band tone="white" id="burden">
        <div className="max-w-3xl">
          <H2>
            Polluted air is part of <Em>daily life</Em> in Jharkhand
          </H2>
          <Lead className="mt-5">
            All 1.4 billion Indians breathe PM2.5 above the World Health Organization&rsquo;s guideline. In Jharkhand,
            the cost falls on people with few means to cope.
          </Lead>
        </div>
        <div className="mt-12 grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-4">
          <Stat value="42.1" label="µg/m³ average PM2.5 in Jharkhand in 2023, above India’s standard of 40" />
          <Stat value="3.6 years" label="of life lost by the average resident, compared with air that meets the WHO guideline" />
          <Stat value="33 towns" label="in the state breached the national PM2.5 standard in every year assessed from 2019 to 2024" />
          <Stat value="69%" label="of people lived in homes cooking with wood, dung, crop waste or coal in 2019–21, the highest share of any state" />
        </div>
        <p className="mt-12 max-w-3xl leading-relaxed text-slate-600">
          In the Jharia coalfield, underground fires have burned since 1916, and 27 surface fires were still active in
          2025. Mines, coal-haul roads and homes sit side by side, and many families earn their living from the same
          coal that pollutes their air.
        </p>
      </Band>

      <Band tone="cream" id="coverage">
        <div className="max-w-3xl">
          <H2>
            Coverage is <Em>thin</Em> where people need it
          </H2>
          <Lead className="mt-5">
            Only 12% of India&rsquo;s 4,041 towns and cities have any air-quality monitor, and about 47% of Indians live
            more than 50 km from one.
          </Lead>
        </div>

        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          <div className="rounded-xl border border-ink-900/10 bg-white p-7" data-reveal>
            <p className="text-sm font-medium text-slate-500">Delhi</p>
            <div className="mt-2 font-display text-7xl leading-none">26%</div>
            <p className="mt-3 text-sm text-slate-600">of residents live within 2 km of a monitor</p>
          </div>
          <div className="rounded-xl bg-ink-900 p-7 text-cream" data-reveal>
            <p className="text-sm font-medium text-cream/70">Jharkhand, twice the population</p>
            <div className="mt-2 font-display text-7xl leading-none">&lt;1%</div>
            <p className="mt-3 text-sm text-cream/75">of residents live within 2 km of a real-time monitor</p>
          </div>
        </div>

        <div className="mt-10">
          <DataTable
            head={['', 'Delhi', 'Jharkhand']}
            rows={[
              ['Population, 2023', '1.9 crore', '3.9 crore'],
              ['Manual stations (samples collected by hand), November 2024', '7', '10, in 7 places'],
              [
                'Continuous stations in the daily air-quality index, 27 October 2026',
                '59 listed; 55 reported',
                'At least 4 listed, all in Dhanbad district; 1 reported',
              ],
              ['Capital city in the daily index', 'Yes', 'No'],
            ]}
            source="Sources: population, EPIC; manual stations, CPCB station list; continuous stations and capital city, CPCB daily bulletins; residents within 2 km, CSE."
          />
        </div>
      </Band>

      <Band tone="white" id="quality">
        <div className="max-w-3xl">
          <H2>
            Where monitors exist, the data is often <Em>unreliable</Em>
          </H2>
        </div>
        <div className="mt-12 grid gap-x-6 gap-y-10 sm:grid-cols-3">
          <Stat value="29%" label="of real-time stations (119 of 409) reported less than three-quarters of their PM2.5 data in 2022" />
          <Stat value="18%" label="of NO₂ station-days across 227 Indo-Gangetic monitors were stuck readings, in our own audit" />
          <Stat value="~50%" label="of PM2.5 hours at Jharkhand's main station failed basic quality checks" />
        </div>
        <div className="mt-12 max-w-3xl">
          <p className="text-sm font-medium text-slate-500">Jorapokhar, Tata Stadium, Dhanbad</p>
          <p className="mt-1 text-xl font-semibold leading-snug">
            Jharkhand&rsquo;s main station reported a stuck NO₂ value on almost every day we examined.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            Data can also exist without reaching the public. The Dhanbad Municipal Corporation told the National Green
            Tribunal in 2023 that it had installed 10 continuous monitors in the city, but their data does not reach
            the national index.
          </p>
        </div>
      </Band>

      <Band tone="cream" id="plans">
        <div className="max-w-3xl">
          <H2>
            National plans reach <Em>few towns</Em>
          </H2>
          <Lead className="mt-5">
            Satellite estimates show that 1,787 Indian towns breached the national PM2.5 standard in every year
            assessed from 2019 to 2024. The National Clean Air Programme covers 67 of them.
          </Lead>
        </div>
        <p className="mt-8 max-w-3xl leading-relaxed text-slate-600">
          Even where money is spent, thin monitoring makes it hard to show where it helped. Dhanbad had used ₹57 crore
          under the programme by December 2023, with one or two working stations to show the effect.
        </p>
        <p className="mt-12 max-w-3xl text-2xl font-semibold leading-snug tracking-tight">
          <ScrubText
            parts={['Where measurement is thin, problems are harder to see, to rank and', { em: 'to fix.' }]}
          />
        </p>
      </Band>

      <Band tone="ink" id="missing">
        <div className="max-w-3xl">
          <H2>
            More stations help, but cannot be <Em>everywhere</Em>
          </H2>
        </div>
        <div className="mt-12 grid gap-x-6 gap-y-10 sm:grid-cols-2">
          <div>
            <div className="font-display text-5xl leading-none text-sky-300 sm:text-6xl">15</div>
            <p className="mt-3 max-w-sm text-sm leading-snug text-cream/70">
              new continuous stations planned by the state pollution control board in December 2025, none of them in
              Dhanbad district
            </p>
          </div>
          <div>
            <div className="font-display text-5xl leading-none text-sky-300 sm:text-6xl">₹27.5 lakh</div>
            <p className="mt-3 max-w-sm text-sm leading-snug text-cream/70">
              a year to run one government reference station (2021-22), too costly to place every few streets
            </p>
          </div>
        </div>
        <p className="mt-12 max-w-3xl text-lg leading-relaxed text-cream/80">
          What is missing is a dense, trusted local layer alongside the government&rsquo;s stations: enough calibrated
          monitors to show how the air differs between a mine edge, a haul road and a school, checked against
          reference stations, and open to everyone. London, the Netherlands and Beijing already run networks like
          this.
        </p>
      </Band>

      <Band tone="white" id="sources">
        <h2 className="text-xl font-semibold">Sources</h2>
        <ul className="mt-6 grid gap-x-10 gap-y-3 text-sm sm:grid-cols-2">
          {SOURCES.map((s) => (
            <li key={s.href}>
              <a
                href={s.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-slate-600 underline decoration-ink-200 underline-offset-4 hover:text-accent-700"
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </Band>
    </>
  )
}
