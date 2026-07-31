import { aqiLevel } from '../AqiBadge'

// Arc geometry — 270° sweep (¾ circle), gap at the bottom.
// SVG circles start drawing at 3 o'clock; rotating 135° puts
// the arc start at 7:30 o'clock, matching a standard instrument gauge.
const R = 44
const CX = 60
const CY = 60
const SW = 10
const CIRCUMFERENCE = 2 * Math.PI * R          // 276.46
const TRACK_LEN = CIRCUMFERENCE * (270 / 360)   // 207.35
const START_ROT = 135

export function CityAqiGauge({ aqi, size = 160 }: { aqi: number | null; size?: number }) {
  const level = aqiLevel(aqi)
  const fillLen = aqi !== null ? Math.min(aqi / 500, 1) * TRACK_LEN : 0

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 120 120" className="absolute inset-0 h-full w-full" aria-hidden>
        {/* Gauge face — ink.800 (#341F14) so the brown brand warm dark sits
            behind the AQI arc rather than the default near-black */}
        <circle cx={CX} cy={CY} r={58} fill="#341F14" />
        {/* Unfilled track — ink.600 (#6B4A2A), lighter than the face so the
            empty portion of the arc reads as a groove, not a void */}
        <circle
          cx={CX} cy={CY} r={R}
          fill="none"
          stroke="#6B4A2A"
          strokeWidth={SW}
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
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="text-3xl font-extrabold tabular-nums leading-none"
          style={{ color: aqi !== null ? level.hex : '#475569' }}
        >
          {aqi ?? '—'}
        </span>
        <span className="mt-1 text-[11px] font-medium tracking-wide text-slate-400">
          {level.label}
        </span>
      </div>
    </div>
  )
}
