import type { ForecastPoint } from '../lib/data'
import { confidenceTierLabel } from '../lib/incidentRules'

// India NAQI band colors, aligned with AqiBadge / MapView
const BANDS = [
  { max: 50, color: '#22c55e' },
  { max: 100, color: '#84cc16' },
  { max: 200, color: '#eab308' },
  { max: 300, color: '#f97316' },
  { max: 400, color: '#ef4444' },
  { max: Infinity, color: '#9333ea' },
]

function bandColor(v: number): string {
  return (BANDS.find((b) => v <= b.max) ?? BANDS[BANDS.length - 1]).color
}

/** 48h PM2.5 forecast as a compact inline-SVG area chart. No chart library. */
export default function ForecastChart({ points }: { points: ForecastPoint[] }) {
  const data = points.filter((p) => p.pm25_pred != null) as (ForecastPoint & { pm25_pred: number })[]
  if (data.length < 2) {
    return <p className="text-sm text-gray-400">No forecast yet - needs a few hours of readings first.</p>
  }

  const W = 320
  const H = 96
  const pad = { top: 8, right: 8, bottom: 16, left: 28 }
  const innerW = W - pad.left - pad.right
  const innerH = H - pad.top - pad.bottom

  const maxV = Math.max(...data.map((p) => p.pm25_pred), 100)
  const minV = 0
  const x = (i: number) => pad.left + (i / (data.length - 1)) * innerW
  const y = (v: number) => pad.top + innerH - ((v - minV) / (maxV - minV)) * innerH

  const line = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.pm25_pred)}`).join(' ')
  const area = `${line} L${x(data.length - 1)},${y(0)} L${x(0)},${y(0)} Z`

  const peak = data.reduce((a, b) => (b.pm25_pred > a.pm25_pred ? b : a), data[0])
  const peakIdx = data.indexOf(peak)
  const isPlaceholder = data[0].model_version?.startsWith('diurnal')
  // Was a raw "{confidence * 100}%" from data[0].confidence — that field is
  // a hand-picked tier marker (0.4-0.9), not a calibrated probability (see
  // confidenceTierLabel's own doc comment in incidentRules.ts). Replaced
  // Sept 2026 with the honest version derived from the real
  // maxValidatedHorizonHours/beatsPersistence fields the forecast_runs join
  // already provides on every point.
  const confidenceLabel = confidenceTierLabel(data[0].maxValidatedHorizonHours, data[0].beatsPersistence ?? false)

  // gridlines at NAQI thresholds that fall in range
  const gridVals = [100, 200, 300, 400].filter((v) => v <= maxV)

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="48-hour PM2.5 forecast">
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={pad.left} x2={W - pad.right} y1={y(v)} y2={y(v)} stroke="#e5e7eb" strokeWidth={1} />
            <text x={2} y={y(v) + 3} fontSize={8} fill="#9ca3af">{v}</text>
          </g>
        ))}
        <path d={area} fill={bandColor(peak.pm25_pred)} opacity={0.15} />
        <path d={line} fill="none" stroke={bandColor(peak.pm25_pred)} strokeWidth={1.5} />
        <circle cx={x(peakIdx)} cy={y(peak.pm25_pred)} r={2.5} fill={bandColor(peak.pm25_pred)} />
        <text x={x(0)} y={H - 4} fontSize={8} fill="#9ca3af">now</text>
        <text x={W - pad.right} y={H - 4} fontSize={8} fill="#9ca3af" textAnchor="end">+48h</text>
      </svg>
      <div className="mt-1 flex items-center justify-between text-xs text-gray-500">
        <span>
          Peak <span className="font-semibold" style={{ color: bandColor(peak.pm25_pred) }}>{Math.round(peak.pm25_pred)}</span> µg/m³
          {peak.local_excess != null && (
            <span className="text-gray-400"> · +{Math.round(peak.local_excess)} local</span>
          )}
        </span>
        <span className="text-gray-400">
          {isPlaceholder ? 'baseline' : 'model'} · {confidenceLabel}
        </span>
      </div>
    </div>
  )
}
