import { JHARKHAND as J } from './geo/jharkhand'

const [dx, dy] = J.cities.Dhanbad
const SCALE_100 = 100 * J.pxPerKm

// Seen to unseen: <50, 50-100, 100-200, >200 km from a district centre to the nearest reporting station.
const DISTANCE_FILL = ['#1F6FBF', '#5FA3E3', '#B5D5F2', '#E6D9C3']
const DISTANCE_LABEL = ['Under 50 km', '50 to 100 km', '100 to 200 km', 'Over 200 km']

const HOLLOW = ['Ranchi', 'Jamshedpur'] as const
// White outline keeps labels legible over district fills.
const HALO = '[paint-order:stroke] stroke-white stroke-[3px] [stroke-linejoin:round]'

export function JharkhandMap() {
  return (
    <figure data-jh data-px-per-km={J.pxPerKm}>
      <p
        data-jh-readout
        style={{ visibility: 'hidden' }}
        className="mb-3 flex flex-col gap-1 whitespace-nowrap text-sm text-slate-600"
      >
        <span>
          Distance from the Dhanbad stations{' '}
          <b data-jh-km className="inline-block min-w-[3ch] text-right text-xl font-semibold tabular-nums text-ink-900">
            280
          </b>{' '}
          km
        </span>
        <span>
          Districts within that distance{' '}
          <b data-jh-n className="inline-block min-w-[3ch] text-right text-xl font-semibold tabular-nums text-ink-900">
            24
          </b>{' '}
          of 24
        </span>
      </p>
      <svg
        viewBox={`0 0 ${J.width} ${J.height}`}
        role="img"
        aria-label="Map of Jharkhand's 24 districts, shaded by distance to the nearest real-time station. The only two stations reporting to the national feed, both in Dhanbad, are marked. Only Dhanbad and Bokaro are within 50 km; most districts, including Ranchi and Jamshedpur, are far beyond."
        className="mx-auto h-auto max-h-[min(46vh,30rem)] w-full"
      >
        <defs>
          <clipPath id="jh-clip">
            {J.districts.map((d) => (
              <path key={d.name} d={d.d} />
            ))}
          </clipPath>
        </defs>
        <g aria-hidden>
          {J.districts.map((d) => (
            <path key={d.name} d={d.d} fill="#6B4A2A" stroke="#6B4A2A" strokeWidth={3.2} strokeLinejoin="round" />
          ))}
        </g>
        <g>
          {J.districts.map((d) => (
            <path
              key={d.name}
              d={d.d}
              data-km={d.km}
              data-fill={DISTANCE_FILL[d.bin]}
              fill={DISTANCE_FILL[d.bin]}
              stroke="#fff"
              strokeWidth={1.2}
              strokeLinejoin="round"
            >
              <title>{`${d.name}: about ${d.km} km from the nearest reporting station`}</title>
            </path>
          ))}
        </g>

        <g clipPath="url(#jh-clip)" style={{ pointerEvents: 'none' }}>
          <circle data-ring-fill cx={dx} cy={dy} r={0} fill="#0F6CBD" fillOpacity={0.1} />
          <circle data-ring cx={dx} cy={dy} r={0} fill="none" stroke="#0F6CBD" strokeWidth={2.5} />
        </g>

        {HOLLOW.map((name) => {
          const [x, y] = J.cities[name]
          const left = name === 'Ranchi'
          return (
            <g key={name}>
              <circle cx={x} cy={y} r={6} fill="#fff" stroke="#422B1C" strokeWidth={2} />
              <text
                x={left ? x - 14 : x + 14}
                y={y + 1}
                textAnchor={left ? 'end' : 'start'}
                className={`fill-ink-900 text-[15px] font-semibold ${HALO}`}
              >
                {name}
              </text>
              <text
                x={left ? x - 14 : x + 14}
                y={y + 18}
                textAnchor={left ? 'end' : 'start'}
                className={`fill-slate-500 text-[12px] ${HALO}`}
              >
                {name === 'Ranchi' ? 'capital, no station found' : 'no station reporting'}
              </text>
            </g>
          )
        })}

        <g>
          <circle
            cx={dx}
            cy={dy}
            r={9}
            fill="#422B1C"
            className="origin-center animate-ping [transform-box:fill-box] motion-reduce:hidden"
          />
          <circle cx={dx} cy={dy} r={7} fill="#fff" stroke="#422B1C" strokeWidth={2.5} />
          <circle cx={dx} cy={dy} r={3.2} fill="#422B1C" />
          <text x={dx + 16} y={dy - 6} className={`fill-ink-900 text-[15px] font-semibold ${HALO}`}>
            Dhanbad
          </text>
          <text x={dx + 16} y={dy + 11} className={`fill-ink-900 text-[12px] font-medium ${HALO}`}>
            2 stations, the only ones reporting
          </text>
        </g>

        <g transform={`translate(16 ${J.height - 20})`}>
          <path d={`M0 0V6H${SCALE_100}V0`} fill="none" stroke="#6B4A2A" strokeWidth={1.5} />
          <text x={SCALE_100 / 2} y={-6} textAnchor="middle" className="fill-slate-500 text-[11px]">
            100 km
          </text>
        </g>
      </svg>

      <div className="mt-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Distance to the nearest reporting station
        </p>
        <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-slate-600 sm:grid-cols-4">
          {DISTANCE_LABEL.map((label, i) => (
            <li key={label} className="flex items-center gap-2 whitespace-nowrap">
              <span className="h-3 w-5 shrink-0 rounded-sm" style={{ background: DISTANCE_FILL[i] }} aria-hidden />
              {label}
            </li>
          ))}
        </ul>
        <p className="mt-3 flex items-center gap-2 text-sm text-slate-600">
          <span className="h-3 w-3 rounded-full bg-white ring-2 ring-ink-700" aria-hidden />
          Major city with no station reporting
        </p>
      </div>
    </figure>
  )
}

export function JharkhandMapCaption() {
  return (
    <p className="mt-4 max-w-3xl text-xs leading-relaxed text-slate-500">
      Jharkhand&rsquo;s 24 districts, shaded by the distance from each district centre to the nearest real-time station
      reporting to the national feed, September 2026. Source: Vayu Gati analysis of CPCB data via OpenAQ; the absence of a
      Ranchi station is to be confirmed with CPCB. Boundaries: geoBoundaries (DataMeet India; Pathways Data and
      lgdirectory.gov.in, ODbL 1.0).
    </p>
  )
}

const RAMP = ['#E5F9FF', '#C4F1FF', '#6ED4F0', '#2A9BB9', '#1B5F71']

export function DelhiWardMap() {
  return (
    <figure>
      <img
        src="/site/delhi-wards.svg"
        alt="Map of Delhi's municipal wards, shaded by ward population."
        loading="lazy"
        className="mx-auto h-auto w-full max-w-md"
      />
      <div className="mx-auto mt-5 flex max-w-md items-center gap-3 text-xs text-slate-500">
        <span>Fewer residents</span>
        <span className="flex flex-1 overflow-hidden rounded-full" aria-hidden>
          {RAMP.map((c) => (
            <span key={c} className="h-2.5 flex-1" style={{ background: c }} />
          ))}
        </span>
        <span>More residents</span>
      </div>
      <figcaption className="mx-auto mt-3 max-w-md text-center text-xs text-slate-500">
        Delhi&rsquo;s municipal wards, shaded by ward population; New Delhi (NDMC) and the Cantonment, outside the
        ward map, in beige. Source: ward boundary data in the Vayu Gati platform.
      </figcaption>
    </figure>
  )
}
