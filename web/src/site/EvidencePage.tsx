import { ShareBar } from './charts'
import { SOURCES } from './content'
import { ScrubText } from './motion'
import { Band, DataTable, Em, H2, Lead, PageHero, Stat } from './ui'

const SECTIONS = [
  ['burden', 'The burden'],
  ['coverage', 'Coverage'],
  ['quality', 'Data quality'],
  ['funding', 'Funding'],
  ['change', 'What is changing'],
  ['sources', 'Sources'],
]

export default function EvidencePage() {
  return (
    <>
      <PageHero
        title={
          <>
            Places that are not measured cannot be planned for, funded or <Em>held to account</Em>
          </>
        }
        lead="The constraint is more basic than funding or policy intent. Here is the evidence behind it."
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
            The burden is <Em>national</Em>, not only metropolitan
          </H2>
          <Lead className="mt-5">
            All 1.4 billion Indians breathe PM2.5 above the WHO guideline, and 46% live where it exceeds even
            India&rsquo;s own national standard.
          </Lead>
        </div>
        <div className="mt-12 grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-4">
          <Stat value="~2 million" label="deaths linked to air pollution in 2023" />
          <Stat value="3.5 years" label="average life lost to long-term exposure, versus 1.6 for malnutrition and 1.5 for tobacco" />
          <Stat value="US$36.8bn" label="economic cost in 2019, 1.36% of GDP" />
          <Stat value="56.3%" label="of Indians still cooked with solid fuels in 2019" />
        </div>
        <p className="mt-12 max-w-3xl leading-relaxed text-slate-600">
          As a share of state income, the cost fell hardest on low-income states such as Uttar Pradesh, Bihar, Madhya
          Pradesh and Chhattisgarh. Jharkhand holds 93.25 billion tonnes of coal resources, second only to Odisha, and
          in the Jharia coalfield underground fires have burned since 1916.
        </p>
      </Band>

      <Band tone="cream" id="coverage">
        <div className="max-w-3xl">
          <H2>
            Coverage follows <Em>attention</Em>, not exposure
          </H2>
          <Lead className="mt-5">
            By the end of 2022, India had 883 manual and 409 real-time stations. Only 12% of its 4,041 statutory towns
            have any monitor, and about 47% of Indians live more than 50 km from one.
          </Lead>
        </div>

        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          <div className="rounded-xl border border-ink-900/10 bg-white p-7" data-reveal>
            <p className="text-sm font-medium text-slate-500">Delhi</p>
            <div className="mt-2 font-display text-7xl leading-none">26%</div>
            <p className="mt-3 text-sm text-slate-600">of residents live within 2 km of a monitor (50 stations)</p>
          </div>
          <div className="rounded-xl bg-ink-900 p-7 text-cream" data-reveal>
            <p className="text-sm font-medium text-cream/70">Jharkhand, twice the population</p>
            <div className="mt-2 font-display text-7xl leading-none">&lt;1%</div>
            <p className="mt-3 text-sm text-cream/75">of residents live within 2 km of a real-time monitor</p>
          </div>
        </div>

        <p className="mt-10 max-w-3xl leading-relaxed text-slate-600">
          Under IS 5182 (Part 14), even a town of fewer than 1 lakh people should have at least four
          particulate-matter monitoring stations. Meeting that standard nationally would take about 17,500 PM
          monitors, some 14,200 of them in small towns. India had 1,292 stations of all kinds. The shortfall is
          largest exactly where most towns are: at the small end.
        </p>

        <div className="mt-8">
          <DataTable
            head={['', 'Delhi', 'Jharkhand']}
            rows={[
              ['Population, 2023', '1.9 crore', '3.9 crore'],
              ['Annual average PM2.5, 2023', '88.4 µg/m³', '42.1 µg/m³'],
              [
                'Monitoring stations',
                '50 (40 real-time, 10 manual; 2022)',
                '2 real-time stations reporting, both in Dhanbad (September 2026)',
              ],
              ['Residents within 2 km of a monitor', '26% (all monitors)', 'under 1% (real-time monitors)'],
              [
                'Capital city covered in real time',
                'Yes',
                "Not found: no Ranchi station on OpenAQ's mirror of the national feed (to confirm with CPCB)",
              ],
            ]}
            source="Sources: population and PM2.5, EPIC; Delhi stations and coverage, Jharkhand coverage, CSE; Jharkhand stations, Vayu Gati analysis of CPCB data via OpenAQ."
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
            Jharkhand&rsquo;s main station reported a stuck NO₂ value for the whole period we examined. In 2022 it did
            not measure PM2.5 at all.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            A town that cannot see its air also cannot be seen: without a monitor it does not appear in national
            rankings, and it is absent from the evidence that shapes plans and budgets.
          </p>
        </div>
      </Band>

      <Band tone="cream" id="funding">
        <div className="max-w-3xl">
          <H2>
            The money follows the <Em>measured</Em>
          </H2>
          <Lead className="mt-5">
            About ₹9,650 crore went to the 131 NCAP cities from FY 2019-20 to December 2023, a list that covers about
            3% of India&rsquo;s statutory towns. Forecasting follows the same pattern, with the flagship service built
            for metropolitan cities.
          </Lead>
        </div>
        <p className="mt-8 max-w-3xl leading-relaxed text-slate-600">
          Even where funds reach a town, the capacity to use them is thin. Jharkhand&rsquo;s three NCAP cities had used
          49% of the ₹279 crore released to them. Every other town in the state received nothing under NCAP.
        </p>
        <div className="mt-8">
          <DataTable
            head={['Jharkhand city in NCAP', 'Released (₹ crore)', 'Used (₹ crore)', 'Share used']}
            rows={[
              ['Dhanbad', '69.09', '57.39', <ShareBar key="d" value={83} />],
              ['Ranchi', '93.50', '48.09', <ShareBar key="r" value={51} />],
              ['Jamshedpur', '116.85', '31.90', <ShareBar key="j" value={27} />],
              ['Total', '279.44', '137.38', <ShareBar key="t" value={49} />],
            ]}
            boldLastRow
            source="Source: PIB (MoEF&CC), Annexure I, FY 2019-20 to 15 December 2023."
          />
        </div>
        <p className="mt-12 max-w-3xl text-2xl font-semibold leading-snug tracking-tight">
          <ScrubText
            parts={[
              'The result is a self-reinforcing trap: no monitor, no record, no listing, no funds, and so',
              { em: 'no monitor.' },
            ]}
          />
        </p>
      </Band>

      <Band tone="ink" id="change">
        <div className="max-w-3xl">
          <H2>
            Air-quality money is about to follow <Em>demonstrable problems</Em>
          </H2>
        </div>
        <div className="mt-12 grid gap-x-6 gap-y-10 sm:grid-cols-2">
          <div>
            <div className="font-display text-5xl leading-none text-sky-300 sm:text-6xl">
              ₹3,56,257 crore
            </div>
            <p className="mt-3 max-w-sm text-sm leading-snug text-cream/70">
              allocated by the XVI Finance Commission to urban local bodies for 2026-31, with sector-specific grants
              discontinued and half of the basic grant left untied
            </p>
          </div>
          <div>
            <div className="font-display text-5xl leading-none text-sky-300 sm:text-6xl">
              ₹1 lakh crore
            </div>
            <p className="mt-3 max-w-sm text-sm leading-snug text-cream/70">
              Urban Challenge Fund, which asks states to focus on tier 2 and tier 3 cities
            </p>
          </div>
        </div>
        <p className="mt-12 max-w-3xl text-lg leading-relaxed text-cream/80">
          As air-quality money stops being ring-fenced, it will follow the problems that towns can demonstrate. A town
          that can measure its air can make its case; a town that cannot will be passed over.
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
