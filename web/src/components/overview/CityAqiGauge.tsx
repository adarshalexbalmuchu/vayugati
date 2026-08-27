import { aqiLevel } from '../AqiBadge'

// Arc geometry — 270° sweep (¾ circle), gap at the bottom.
// SVG circles start drawing at 3 o'clock; rotating 135° puts
// the arc start at 7:30 o'clock, matching a standard instrument gauge.
const R = 44
const CX = 60
const CY = 60
const SW = 10
const SW_TRACK = 8  // unfilled track slightly thinner so the filled arc pops
const CIRCUMFERENCE = 2 * Math.PI * R          // 276.46
const TRACK_LEN = CIRCUMFERENCE * (270 / 360)   // 207.35
const START_ROT = 135

export function CityAqiGauge({ aqi, size = 140 }: { aqi: number | null; size?: number }) {
  const level = aqiLevel(aqi)
  const fillLen = aqi !== null ? Math.min(aqi / 500, 1) * TRACK_LEN : 0
  // Text was fixed at 30px/11px regardless of `size` — fine at the original
  // 140px default, but at smaller sizes (e.g. the 96px hero gauge) the label
  // outgrew the safe inner circle and visually spilled over the arc. Scale
  // both to the same ratios the fixed sizes had at size=140.
  const valueSize = Math.round(size * 0.214)
  const labelSize = Math.max(8, Math.round(size * 0.079))

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 120 120" className="absolute inset-0 h-full w-full" aria-hidden>
        {/* Gauge face — ink.800 (#341F14) warm dark brown */}
        <circle cx={CX} cy={CY} r={58} fill="#341F14" />
        {/* Unfilled track — ink.600 (#6B4A2A), narrower than the fill arc
            so the active arc visually sits proud of the groove */}
        <circle
          cx={CX} cy={CY} r={R}
          fill="none"
          stroke="#6B4A2A"
          strokeWidth={SW_TRACK}
          strokeLinecap="round"
          strokeDasharray={`${TRACK_LEN} ${CIRCUMFERENCE - TRACK_LEN}`}
          transform={`rotate(${START_ROT}, ${CX}, ${CY})`}
        />
        {/* Filled arc — proportional to AQI on 0–500 Indian scale */}
        {fillLen > 0.5 && (
          <circle
            cx={CX} cy={CY} r={R}
            fill="none"
            stroke={level.hex}
            strokeWidth={SW}
            strokeLinecap="round"
            strokeDasharray={`${fillLen} ${CIRCUMFERENCE - fillLen}`}
            transform={`rotate(${START_ROT}, ${CX}, ${CY})`}
          />
        )}
      </svg>

      {/* Centre text — HTML overlay for consistent font rendering */}
      <div className="absolute inset-0 flex flex-col items-center justify-center px-2">
        <span
          className="font-extrabold tabular-nums leading-none"
          style={{ color: aqi !== null ? level.hex : '#475569', fontSize: valueSize }}
        >
          {aqi ?? '—'}
        </span>
        {/* ink-200 (#DEC7A0) warm cream — higher contrast than slate-400 on dark face */}
        <span
          className="mt-1 whitespace-nowrap font-medium tracking-wide text-ink-200"
          style={{ fontSize: labelSize }}
        >
          {level.label}
        </span>
      </div>
    </div>
  )
}
