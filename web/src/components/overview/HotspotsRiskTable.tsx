import WardEstimateBlock from '../map/WardEstimateBlock'
import { Fragment, useState } from 'react'
import { ChevronRight, Info, MapPin, Search, X } from 'lucide-react'
import { aqiLevel } from '../AqiBadge'
import {
  fetchVayuTraceAttribution,
  fetchWardHistory,
  fetchWardRollup,
  type ForecastPoint,
  type LatestReadingReconciliation,
  type VayuTraceAttribution,
  type WardForecastSummary,
  type WardHistoryPoint,
  type WardSummary,
} from '../../lib/data'
import { useAsync } from '../../lib/useAsync'
import OverviewChoroplethMap from './OverviewChoroplethMap'
import { formatWardName } from '../../lib/format'
import { aqSourceLabel, dataConfidenceLevel, DATA_CONFIDENCE_LABEL, type DataConfidenceLevel } from '../../lib/latestReadingRules'
import { forecastPollutantFor, MAP_POLLUTANT_LABEL, mapPollutantUnit, wardPollutantValue, type MapPollutant } from '../../lib/mapRules'
import {
  compareByUrgency,
  forecastMethodFor,
  hotspotStatus,
  HOTSPOT_STATUS_LABEL,
  peakWithinWindow,
  type HotspotStatus,
  type TimeWindowHours,
  type WindowedPeak,
} from '../../lib/overviewRules'
import { confidenceTierLabel, FORECAST_METHOD_LABEL, forecastFallbackStatus } from '../../lib/incidentRules'
import { Card } from '../ui'
import AqiForecastBlock from '../map/AqiForecastBlock'
import ForecastOutlook from '../map/ForecastOutlook'

const POLLUTANT_OPTIONS: MapPollutant[] = ['aqi', 'pm25', 'pm10', 'no2', 'so2', 'co', 'o3']

const SOURCE_LABELS: Record<string, string> = {
  construction_dust: 'Construction dust',
  road_dust:         'Road dust',
  industrial:        'Industrial activity',
  vehicular:         'Vehicular emissions',
  waste:             'Waste burning',
}
function formatSource(s: string): string {
  return SOURCE_LABELS[s] ?? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function ageMinutes(ts: string | null): number | null {
  if (!ts) return null
  const ms = Date.now() - new Date(ts).getTime()
  return isNaN(ms) ? null : ms / 60_000
}

function timeAgo(ts: string | null): string {
  if (!ts) return '—'
  const ms = Date.now() - new Date(ts).getTime()
  if (isNaN(ms)) return '—'
  const h = Math.floor(ms / 3_600_000)
  return h < 1 ? '<1h' : `${h}h`
}

/** "+18 by 6:00 PM" — the actual size and timing of the forecast move, not
 *  just a direction label. windowed comes from peakWithinWindow(), so this
 *  is scoped to the same horizon (12h/24h/36h/48h) the table is already
 *  showing, never a peak from beyond it. Returns null when there's nothing
 *  concrete to say (no windowed peak, or excess too small to be worth
 *  calling out — mirrors hotspotStatus's own +10 µg/m³ "meaningful" bar). */
function forecastDeltaLabel(windowed: WindowedPeak): string | null {
  if (windowed.excess == null || windowed.ts == null || windowed.excess < 10) return null
  // Hour only ("11 PM"), not hour:minute — this column is already tight at
  // 380px with a ward name, sparkline, badge and this line all sharing it;
  // the hour is precise enough for a peak-timing hint.
  const time = new Date(windowed.ts).toLocaleTimeString(undefined, { hour: 'numeric' })
  const sign = windowed.excess > 0 ? '+' : ''
  return `${sign}${Math.round(windowed.excess)} by ${time}`
}

/** The Trend column's ONLY visual now (Sept 2026 redesign) — the sparkline's
 *  shape carries direction, magnitude and roughly-where-it-peaks all at
 *  once, which a status badge + a "+45 by 11 PM" delta line were each only
 *  restating in a different form (three encodings of the same underlying
 *  peakWithinWindow() number). A policy maker triaging 39 rows needs to see
 *  which ones are accelerating vs. flat vs. already peaking-out at a glance,
 *  not read a sentence per row — a line does that; text doesn't. The exact
 *  numbers/timing this replaced aren't gone, just relocated to this
 *  component's own `title` tooltip and to the ward detail panel on click.
 *
 *  Rendered as a filled area + line (not a bare line) since the fill makes
 *  the shape readable at a glance even at small size, the same convention
 *  stock-ticker/analytics sparklines use. Colour is status-derived, same
 *  tone STATUS_TONE/STATUS_DOT already use elsewhere — no new colour
 *  language introduced. Min/max-normalised to the line's own range (not the
 *  global AQI scale) so a ward oscillating within a narrow band still shows
 *  visible movement instead of a flat line lost at chart scale. Renders a
 *  plain dot (not a fabricated flat line) when there are fewer than 2 real
 *  points to connect. */
function TrendSparkline({
  points,
  status,
  title,
}: {
  points: { horizon_ts: string; value: number | null }[]
  status: HotspotStatus
  title: string
}) {
  const values = points.filter((p) => p.value != null) as { horizon_ts: string; value: number }[]
  const color =
    status === 'severe' ? '#dc2626' : status === 'watch' || status === 'stale' ? '#f97316' : '#16a34a'

  if (values.length < 2) {
    return (
      <span className="inline-flex h-6 w-14 flex-shrink-0 items-center justify-center" title={title}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      </span>
    )
  }

  const width = 56
  const height = 24
  const pad = 2
  const min = Math.min(...values.map((p) => p.value))
  const max = Math.max(...values.map((p) => p.value))
  // Floor the normalisation range at 10 µg/m³ (the same "meaningful move"
  // threshold hotspotStatus/forecastDeltaLabel already use) instead of
  // always stretching min..max to fill the full height. Without this floor,
  // a ward genuinely flat within ±1-2 µg/m³ of noise got its tiny wiggle
  // rescaled to look like a dramatic spike — visually contradicting the
  // detail panel's ForecastChart, which plots the same data on a real,
  // shared y-axis and correctly shows it as flat. A real 10+ µg/m³ move
  // still fills the sparkline normally; only sub-threshold noise gets
  // compressed toward a flat line, matching what the number is actually
  // doing rather than what a tiny range looks like when stretched.
  const range = Math.max(max - min, 10)
  const mid = (max + min) / 2
  const points2d = values.map((p, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2)
    // Centred on `mid`, not anchored at `min` — so a flooring range draws a
    // flat line through the vertical middle of the chart, not pinned to its
    // bottom edge (which anchoring at raw min would do once range no longer
    // equals max-min).
    const y = height / 2 - ((p.value - mid) / range) * (height - pad * 2)
    return [x, y] as const
  })
  const linePoints = points2d.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const areaPoints = [
    `${points2d[0][0].toFixed(1)},${height}`,
    ...points2d.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`),
    `${points2d[points2d.length - 1][0].toFixed(1)},${height}`,
  ].join(' ')

  return (
    <span title={title} className="inline-flex flex-shrink-0 cursor-default">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
        <polygon points={areaPoints} fill={color} fillOpacity={0.12} />
        <polyline points={linePoints} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </span>
  )
}

function CurrentReadingBadge({
  ward,
  pollutant,
  preferred,
}: {
  ward: WardSummary
  pollutant: MapPollutant
  preferred?: LatestReadingReconciliation
}) {
  if (pollutant !== 'aqi') {
    // Bug fix (Sept 2026): this used to fall through to ward.no2 for any
    // pollutant that wasn't pm25/pm10 — so selecting SO2/CO/O3 silently
    // showed NO2's value instead. WardSummary already carries so2/co/o3 (see
    // fetchAllWardsAqi in lib/data.ts); this was purely a missing branch
    // here, not a missing data fetch. Now shares wardPollutantValue() with
    // the table's own row-ranking logic below, instead of two independently
    // maintained copies of the same pollutant→field mapping.
    const value = wardPollutantValue(ward, pollutant)
    // Bug fix (Sept 2026): CO is stored/reported in mg/m³ at a much smaller
    // magnitude (typically 0.02-0.1) than every other pollutant here (µg/m³,
    // typically tens-hundreds) — Math.round() was silently flooring every
    // real CO reading to 0. CO now keeps 2 decimal places; everything else
    // is unchanged. Unit label also now follows mapPollutantUnit() instead
    // of a hardcoded "µg/m³", which was simply wrong for CO.
    const displayValue = value == null ? null : pollutant === 'co' ? value.toFixed(2) : Math.round(value)
    return (
      <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-xs font-bold tabular-nums text-slate-700">
        {displayValue != null ? `${displayValue} ${mapPollutantUnit(pollutant)}` : '—'}
      </span>
    )
  }
  const usingCpcb = preferred?.sourceUsed === 'cpcb' && preferred.cpcbAqi != null
  const rawDisplayAqi = usingCpcb ? preferred!.cpcbAqi : (ward.aqi ?? preferred?.openaqAqi ?? null)
  // Same reasoning as WardDetailPanel: don't show a max-sub-index number built
  // from trace pollutants alone as if it were a trustworthy reading.
  const noData = preferred ? dataConfidenceLevel(preferred) === 'no_data' : false
  const displayAqi = noData ? null : rawDisplayAqi
  const isStaleValue = !usingCpcb && displayAqi != null && ward.aqi == null
  const level = aqiLevel(displayAqi)
  return (
    <span
      title={
        noData
          ? 'Matched station, but no recognized pollutant values in the latest CPCB reading'
          : usingCpcb
          ? 'Latest reading: CPCB/data.gov preferred'
          : isStaleValue
          ? 'Last known value — readings are stale'
          : 'Latest reading: OpenAQ fallback'
      }
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-bold tabular-nums ${isStaleValue ? 'opacity-50' : ''}`}
      style={{ backgroundColor: `${level.hex}1f`, color: level.hex }}
    >
      <span
        className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${usingCpcb ? 'bg-accent-500' : 'bg-slate-300'}`}
        aria-hidden
      />
      {displayAqi ?? '—'}
    </span>
  )
}

const AQ_SOURCE_TONE: Record<string, string> = {
  CPCB: 'text-accent-700 ring-accent-200 bg-accent-50',
  OpenAQ: 'text-slate-600 ring-slate-200 bg-slate-50',
  Review: 'text-status-warning ring-status-warning/30 bg-status-warning/10',
}

function AqSourceBadge({ preferred }: { preferred: LatestReadingReconciliation | undefined }) {
  if (!preferred) return <span className="text-slate-300">—</span>
  const label = aqSourceLabel(preferred)
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${AQ_SOURCE_TONE[label]}`}>
      {label}
    </span>
  )
}

const DATA_CONFIDENCE_TONE: Record<DataConfidenceLevel, string> = {
  matched: 'text-status-success ring-status-success/30 bg-status-success/10',
  stale: 'text-status-warning ring-status-warning/30 bg-status-warning/10',
  mismatch: 'text-status-critical ring-status-critical/30 bg-status-critical/10',
  no_data: 'text-slate-400 ring-slate-200 bg-slate-50',
}

function DataConfidenceBadge({ preferred }: { preferred: LatestReadingReconciliation | undefined }) {
  if (!preferred) return <span className="text-slate-300">—</span>
  const level = dataConfidenceLevel(preferred)
  return (
    <span
      title={preferred.flags.length > 0 ? `Flags: ${preferred.flags.join(', ')}` : undefined}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${DATA_CONFIDENCE_TONE[level]}`}
    >
      {DATA_CONFIDENCE_LABEL[level]}
    </span>
  )
}

// The local duplicate of lib/mapRules.ts's forecastPollutantFor that used
// to live here (this file never imported the shared one, and the two were
// "kept in sync by hand") is gone as of Sept 2026 — that hand-sync silently
// failed: when forecastPollutantFor in mapRules.ts was extended to forecast
// so2/co/o3 for real, this file's own stale copy kept hardcoding the old
// pm25/pm10/no2-only fallback, so SO2/CO/O3 kept showing a "(proxy)" label
// and PM2.5's curve here even after they had real forecasts of their own
// everywhere else in the app. Now imports the single shared implementation
// instead, so this can't drift out of sync again.

// ── Forecast chart ─────────────────────────────────────────────────────────────

const AQI_BAND_COLORS = ['#55A84F', '#A3C853', '#FFF833', '#F29C33', '#E93F33', '#AF2D24']

function levelColor(val: number, breaks: number[]): string {
  for (let i = 0; i < breaks.length; i++) {
    if (val <= breaks[i]) return AQI_BAND_COLORS[i]
  }
  return AQI_BAND_COLORS[5]
}

// AQI's own CPCB category breakpoints — the history chart always shows AQI
// regardless of the pollutant toggle (unlike ForecastChart, which follows
// the toggle), since "how did we get here" is asking about the ward's
// overall condition over the past week, the same fixed metric the hero
// gauge/worst-ward card already use, not whichever pollutant happens to be
// selected right now.
const AQI_HISTORY_BREAKS = [50, 100, 200, 300, 400]

/** 7 days of a ward's real past readings — the "how did we get here"
 *  complement to ForecastChart below, which only ever shows the future.
 *
 *  Line/area chart (Sept 2026, 2nd pass) — was a bar chart matching
 *  ForecastChart's own style, on the reasoning that past and future should
 *  read as visual siblings. Changed on direct request for "whatever's most
 *  effective" per chart's actual purpose: ~150+ hourly-ish bars compressed
 *  into 260px reads as visual noise (a dense comb, not a trend); a
 *  continuous line makes the actual trajectory (rising/falling/cyclical)
 *  the thing your eye follows, which is what "how did we get here" is
 *  actually asking. The line is coloured per-segment by AQI band (still
 *  using AQI_HISTORY_BREAKS/levelColor(), same signal the old bars
 *  carried) rather than one flat colour, so a real band-crossing is still
 *  visible without needing to read the y-axis. */
function WardHistoryChart({ points }: { points: WardHistoryPoint[] }) {
  const data = points.filter((p) => p.aqi != null) as (WardHistoryPoint & { aqi: number })[]
  if (data.length < 2) {
    return (
      <div className="flex h-28 items-center justify-center">
        <span className="text-[11px] text-slate-300">Not enough history yet</span>
      </div>
    )
  }

  const vals = data.map((p) => p.aqi)
  const maxVal = Math.max(...vals, 50)

  const W = 260, H = 112, ML = 26, MB = 18, MT = 6, MR = 2
  const cW = W - ML - MR
  const cH = H - MT - MB
  const n = data.length

  const yTicks = [0, Math.round(maxVal / 2), Math.round(maxVal)]

  const xAt = (i: number) => ML + (n === 1 ? 0 : (i / (n - 1)) * cW)
  const yAt = (val: number) => MT + cH - (val / maxVal) * cH
  const linePoints = vals.map((val, i) => [xAt(i), yAt(val)] as const)
  const areaPath =
    `M ${linePoints[0][0]} ${MT + cH} ` +
    linePoints.map(([x, y]) => `L ${x} ${y}`).join(' ') +
    ` L ${linePoints[linePoints.length - 1][0]} ${MT + cH} Z`

  // Day-boundary labels (not every-6-hours like the forecast chart — 7 days
  // of hourly-ish points is too dense for that cadence to stay readable).
  //
  // Bug fix (Sept 2026): a day boundary landing near the very end of the
  // fetched window (e.g. "today" cut off after only 1-3 hourly points)
  // placed its label right on top of the previous day's — nothing enforced
  // a minimum gap between consecutive labels, so two adjacent short-form
  // weekday names (e.g. "Mon"/"Tue") visually ran together. Each candidate
  // label is now only kept if it's at least one label-width away from the
  // last one actually placed, so a too-close trailing day is dropped
  // instead of overlapping — the chart still reads correctly with one
  // fewer label on a short final segment, rather than an illegible smear.
  const MIN_LABEL_GAP_PX = 20
  const xLabels: { x: number; label: string }[] = []
  let lastDay = -1
  let lastLabelX = -Infinity
  data.forEach((p, i) => {
    const d = new Date(p.ts)
    if (isNaN(d.getTime())) return
    const day = d.getDate()
    if (day !== lastDay) {
      lastDay = day
      const x = xAt(i)
      if (x - lastLabelX >= MIN_LABEL_GAP_PX) {
        xLabels.push({ x, label: d.toLocaleDateString(undefined, { weekday: 'short' }) })
        lastLabelX = x
      }
    }
  })

  // Colour the line/area by the LATEST reading's AQI band — a single trend
  // line can't be multi-coloured per-segment without either a gradient
  // (imprecise at exact breakpoints) or many separate <path> segments
  // (visually busy for a 7-day glance chart); the latest value is also the
  // one this card's headline number/status already reflects, so it stays
  // consistent with the rest of the panel rather than introducing a third,
  // independently-computed colour signal.
  const latestColor = levelColor(vals[vals.length - 1], AQI_HISTORY_BREAKS)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" height={H}>
      {yTicks.map((v) => {
        const y = MT + cH - (v / maxVal) * cH
        return (
          <g key={v}>
            <line x1={ML} y1={y} x2={W - MR} y2={y} stroke="#f1f5f9" strokeWidth={1} />
            <text x={ML - 3} y={y + 3} textAnchor="end" fontSize={6.5} fill="#cbd5e1">
              {v}
            </text>
          </g>
        )
      })}
      <path d={areaPath} fill={latestColor} opacity={0.14} />
      <polyline
        points={linePoints.map(([x, y]) => `${x},${y}`).join(' ')}
        fill="none"
        stroke={latestColor}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {xLabels.map(({ x, label }, i) => (
        <text key={`${label}-${i}`} x={x} y={H - 2} textAnchor="middle" fontSize={6.5} fill="#94a3b8">
          {label}
        </text>
      ))}
    </svg>
  )
}

function ForecastChart({ points, pollutant }: { points: ForecastPoint[]; pollutant: MapPollutant }) {
  if (!points.length) {
    return (
      <div className="flex h-28 items-center justify-center">
        <span className="text-[11px] text-slate-300">No forecast data</span>
      </div>
    )
  }

  const key = forecastPollutantFor(pollutant)
  // Reuses POLLUTANT_CFG's real CPCB breakpoints (Sept 2026) instead of a
  // second, separately-maintained FORECAST_BREAKS table — that table only
  // ever had pm25/pm10/no2 entries and silently fell back to pm25's
  // breakpoints for so2/co/o3 (mis-colouring their severity bands), the
  // exact same kind of "two copies, one goes stale" bug this file's local
  // forecastPollutantFor duplicate just caused above.
  const breaks = POLLUTANT_CFG[key]?.breaks ?? POLLUTANT_CFG.pm25.breaks
  const vals = points.map((p) => (p.predicted_value ?? p.pm25_pred ?? 0) as number)
  // Real model uncertainty (Sept 2026 addition) — lower_bound/upper_bound
  // are genuine quantile predictions (preds_q10/preds_q90) when the model
  // produces them, with an explicit fallback and an honest null when it
  // can't (see forecast.py's own lower_bound/upper_bound assignment) —
  // never fabricated. Shown as a shaded band so "this is an estimate, not
  // a fact" (already stated in text as "Baseline estimate" above this
  // chart) is visible in the chart itself, not just a caption a viewer
  // might not read. A point with no bound just contributes nothing to the
  // band at that x position, rather than a fabricated width.
  const maxVal = Math.max(...vals, ...points.map((p) => p.upper_bound ?? 0), 50)

  const W = 260, H = 112, ML = 26, MB = 18, MT = 6, MR = 2
  const cW = W - ML - MR
  const cH = H - MT - MB
  const n = points.length
  const gap = 1.5
  const bW = Math.max(2, cW / n - gap)

  const yTicks = [0, Math.round(maxVal / 2), Math.round(maxVal)]
  const yAt = (v: number) => MT + cH - (v / maxVal) * cH
  const xAt = (i: number) => ML + (i / n) * cW + bW / 2

  const xLabels: { x: number; label: string }[] = []
  points.forEach((p, i) => {
    const d = new Date(p.horizon_ts)
    if (isNaN(d.getTime())) return
    const h = d.getHours()
    if (h % 6 === 0) {
      const label = h === 0 ? '12AM' : h === 12 ? '12PM' : h < 12 ? `${h}AM` : `${h - 12}PM`
      xLabels.push({ x: xAt(i), label })
    }
  })

  // Uncertainty band as one filled area (upper edge left-to-right, lower
  // edge back right-to-left) over only the contiguous stretch of points
  // that actually have both bounds — segments with a gap in bound data
  // start a new band piece rather than bridging across missing points.
  const bandSegments: { upper: [number, number][]; lower: [number, number][] }[] = []
  let current: { upper: [number, number][]; lower: [number, number][] } | null = null
  points.forEach((p, i) => {
    if (p.lower_bound != null && p.upper_bound != null) {
      if (!current) {
        current = { upper: [], lower: [] }
        bandSegments.push(current)
      }
      current.upper.push([xAt(i), yAt(p.upper_bound)])
      current.lower.push([xAt(i), yAt(p.lower_bound)])
    } else {
      current = null
    }
  })

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" height={H}>
      {yTicks.map((v) => {
        const y = MT + cH - (v / maxVal) * cH
        return (
          <g key={v}>
            <line x1={ML} y1={y} x2={W - MR} y2={y} stroke="#f1f5f9" strokeWidth={1} />
            <text x={ML - 3} y={y + 3} textAnchor="end" fontSize={6.5} fill="#cbd5e1">
              {v}
            </text>
          </g>
        )
      })}
      {/* Bug fix (Sept 2026): #94a3b8 at 0.16 opacity was reported too
          faint to actually notice against the white card background —
          darkened the fill and added a visible upper-edge stroke so the
          band's actual extent (not just a barely-there wash) is legible. */}
      {bandSegments
        .filter((seg) => seg.upper.length >= 2)
        .map((seg, i) => (
          <g key={i}>
            <path
              d={
                `M ${seg.upper.map(([x, y]) => `${x},${y}`).join(' L ')} ` +
                `L ${[...seg.lower].reverse().map(([x, y]) => `${x},${y}`).join(' L ')} Z`
              }
              fill="#64748b"
              opacity={0.28}
            />
            <polyline
              points={seg.upper.map(([x, y]) => `${x},${y}`).join(' ')}
              fill="none"
              stroke="#64748b"
              strokeWidth={1}
              strokeDasharray="2 1.5"
              opacity={0.6}
            />
          </g>
        ))}
      {vals.map((val, i) => {
        const bH = val > 0 ? Math.max(2, (val / maxVal) * cH) : 0
        const x = ML + (i / n) * cW + gap / 2
        return (
          <rect
            key={i}
            x={x}
            y={MT + cH - bH}
            width={bW}
            height={bH}
            fill={levelColor(val, breaks)}
            rx={1.5}
            opacity={0.88}
          />
        )
      })}
      {xLabels.map(({ x, label }) => (
        <text key={label} x={x} y={H - 2} textAnchor="middle" fontSize={6.5} fill="#94a3b8">
          {label}
        </text>
      ))}
    </svg>
  )
}

// ── Pollutant breakdown ─────────────────────────────────────────────────────────

// CPCB official breakpoints; CO in mg/m³, all others in µg/m³
const POLLUTANT_CFG: Record<string, { label: string; unit: string; breaks: number[]; barMax: number }> = {
  pm25: { label: 'PM₂.₅', unit: 'µg/m³', breaks: [30, 60, 90, 120, 250],        barMax: 300  },
  pm10: { label: 'PM₁₀',  unit: 'µg/m³', breaks: [50, 100, 250, 350, 430],       barMax: 500  },
  no2:  { label: 'NO₂',   unit: 'µg/m³', breaks: [40, 80, 180, 280, 400],        barMax: 450  },
  so2:  { label: 'SO₂',   unit: 'µg/m³', breaks: [40, 80, 380, 800, 1600],       barMax: 500  },
  o3:   { label: 'O₃',    unit: 'µg/m³', breaks: [50, 100, 168, 208, 748],       barMax: 400  },
  co:   { label: 'CO',    unit: 'mg/m³', breaks: [1, 2, 10, 17, 34],             barMax: 40   },
  nh3:  { label: 'NH₃',  unit: 'µg/m³', breaks: [200, 400, 800, 1200, 1800],    barMax: 2000 },
}

const POLLUTANT_ORDER = ['pm25', 'pm10', 'no2', 'so2', 'co', 'o3', 'nh3'] as const

/** Bug fix (Sept 2026): the CPCB data.gov.in live feed's `pollutants.co.avg`
 *  field can be reported in either "MG/M3" or "UG/M3" depending on
 *  station/feed quirks — the ingest pipeline (ingest.py, latest_readings.py)
 *  already checks `unit` before treating a CO value as mg/m³, but this
 *  panel was reading `cpcbPollutants.co.avg` raw with no equivalent check,
 *  so a station reporting CO in µg/m³ that hour displayed as if it were
 *  mg/m³ — a 1000x inflation (e.g. a real ~62 µg/m³ reading showing as
 *  "62.00 mg/m³", pegging the pollutant at Severe). Mirrors the backend's
 *  own `co_data.get("unit", "MG/M3") == "MG/M3"` default-to-mg/m³ logic
 *  exactly, so both sides agree on the same value for the same raw feed. */
function normalizeCpcbCo(co: { avg: number; unit?: string }): number {
  return (co.unit ?? 'MG/M3') === 'MG/M3' ? co.avg : co.avg / 1000
}

/** "Current readings" as a proper horizontal bar chart (Sept 2026, 2nd
 *  pass) — was a stack of individual thin progress bars (PollutantRow
 *  above), each reading its own width from a plain div with no axis,
 *  gridlines, or shared frame, which read as noticeably plainer/smaller
 *  than the two real SVG charts elsewhere on this same panel.
 *
 *  The 6 pollutants can't share one literal numeric axis — CO is measured
 *  in mg/m³ at a completely different real-world magnitude (~0.5-2 in Delhi;
 *  the ~0.05 once seen here was an ingest unit bug, fixed Sept 2026)
 *  than PM10 (~50-200+ µg/m³); plotting both on the same absolute scale
 *  would make CO's bar invisible. Instead each bar is drawn as a percentage
 *  of THAT pollutant's own CPCB severity scale (cfg.barMax — the same
 *  ratio PollutantRow already computed, just now on one shared 0-100%
 *  axis with real gridlines/ticks), so "how close to concerning is this
 *  reading" is genuinely comparable across pollutants, even though their
 *  raw units aren't. */
function CurrentReadingsChart({ readings, keys }: { readings: Partial<Record<string, number>>; keys: readonly string[] }) {
  // ML/MR reserve fixed columns for the pollutant label (left) and the
  // value+unit (right) so the coloured bar track sits in the middle,
  // never overlapped by either text — the value column is wide enough for
  // the longest real reading here ("1600 µg/m³"-ish) at this font size.
  const W = 260, H_PER_ROW = 22, ML = 32, MR = 62, MT = 6, MB = 16
  const rows = keys.filter((k) => readings[k] != null && POLLUTANT_CFG[k])
  const H = MT + MB + rows.length * H_PER_ROW
  const cW = W - ML - MR
  const xTicks = [0, 50, 100]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" height={H}>
      {xTicks.map((t) => {
        const x = ML + (t / 100) * cW
        return (
          <g key={t}>
            <line x1={x} y1={MT} x2={x} y2={H - MB} stroke="#f1f5f9" strokeWidth={1} />
            <text x={x} y={H - MB + 10} textAnchor="middle" fontSize={6.5} fill="#cbd5e1">
              {t}%
            </text>
          </g>
        )
      })}
      {rows.map((k, i) => {
        const cfg = POLLUTANT_CFG[k]
        const value = readings[k]!
        const pct = Math.min(100, (value / cfg.barMax) * 100)
        const color = levelColor(value, cfg.breaks)
        const y = MT + i * H_PER_ROW
        const barH = 10
        const display = k === 'co' ? value.toFixed(2) : Math.round(value)
        return (
          <g key={k}>
            <text x={ML - 4} y={y + barH / 2 + 3} textAnchor="end" fontSize={9} fontWeight={600} fill="#94a3b8">
              {cfg.label}
            </text>
            <rect x={ML} y={y} width={cW} height={barH} rx={3} fill="#f1f5f9" />
            <rect x={ML} y={y} width={Math.max(2, (pct / 100) * cW)} height={barH} rx={3} fill={color} />
            <text x={ML + cW + 6} y={y + barH / 2 + 3} textAnchor="start" fontSize={8.5} fontWeight={600} fill="#475569">
              {display}
              <tspan fill="#94a3b8" fontWeight={400}> {cfg.unit}</tspan>
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ── Ward detail panel (right side) ─────────────────────────────────────────────

function WardDetailPanel({
  selectedWardId,
  wards,
  rankedWards,
  forecasts,
  latestReadingsByWard,
  pollutant,
  windowHours,
  forecastSuppressed,
}: {
  selectedWardId: number | null
  wards: WardSummary[]
  /** Full urgency-ranked ward order (unfiltered by the left list's search
   *  box) — used only to compute the selected ward's own rank/of-M below;
   *  never re-sorted or re-derived here, so this panel's rank always
   *  matches the left list's actual row order. */
  rankedWards: WardSummary[]
  forecasts: Map<number, WardForecastSummary>
  latestReadingsByWard?: Map<number, LatestReadingReconciliation>
  pollutant: MapPollutant
  windowHours: TimeWindowHours
  forecastSuppressed?: boolean
}) {
  const ward = wards.find((w) => w.id === selectedWardId) ?? null

  // 7-day real history — the "how did we get here" complement to the 48h
  // forecast below (Sept 2026 addition; see fetchWardHistory's own doc
  // comment). Fetched per-selected-ward, not for all wards up front, since
  // most selections never need it. Hook called unconditionally (before the
  // `!ward` early return) per React's rules-of-hooks; `enabled` gates the
  // actual fetch instead.
  const historyState = useAsync(
    () => (selectedWardId != null ? fetchWardHistory(selectedWardId, 7) : Promise.resolve([])),
    [selectedWardId],
    { enabled: selectedWardId != null, cacheKey: selectedWardId != null ? `ward-history:${selectedWardId}` : undefined },
  )

  // VayuTrace source attribution — the real ISRM dispersion-kernel estimate
  // (industrial/road/fire/unknown breakdown + confidence + regional/fire
  // transport signal), already fetched and shown on the Map page's
  // SelectedWardPanel but previously absent here, where this panel's only
  // "why is this ward bad" answer was the coarser rule-based
  // ward.dominant_source string. Added Sept 2026 per direct request, after
  // confirming the richer data already exists and just wasn't wired in.
  const vayuTraceState = useAsync(
    () => (selectedWardId != null ? fetchVayuTraceAttribution(selectedWardId) : Promise.resolve(null)),
    [selectedWardId],
    { enabled: selectedWardId != null, cacheKey: selectedWardId != null ? `ward-vayutrace:${selectedWardId}` : undefined },
  )

  // Citizen report rollup — same fetchWardRollup() FieldView already uses
  // for a field officer's own assigned ward, reused here so a commander can
  // see whether citizens are actually reporting problems in the ward
  // they're looking at, not just what the sensors say.
  const rollupState = useAsync(
    () => (selectedWardId != null ? fetchWardRollup(selectedWardId) : Promise.resolve(null)),
    [selectedWardId],
    { enabled: selectedWardId != null, cacheKey: selectedWardId != null ? `ward-rollup:${selectedWardId}` : undefined },
  )

  if (!ward) {
    const withAqi = wards.filter(w => w.aqi != null)
    const avgAqi = withAqi.length > 0
      ? Math.round(withAqi.reduce((sum, w) => sum + w.aqi!, 0) / withAqi.length)
      : null
    const worstWard = withAqi[0] ?? null
    const bestWard = withAqi[withAqi.length - 1] ?? null
    const avgLevel = aqiLevel(avgAqi)
    const worstLevel = aqiLevel(worstWard?.aqi ?? null)
    const bestLevel = aqiLevel(bestWard?.aqi ?? null)

    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <div className="border-b border-slate-100 px-4 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">City overview</p>
          {/* Bug fix (Sept 2026): wards.length used to BE the monitored
              count, back when fetchAllWardsAqi() only returned monitored
              wards. That function now returns all 265 (so VayuTrace, which
              needs no station, is reachable everywhere) - counting
              isMonitored explicitly keeps this stat accurate. */}
          <p className="mt-0.5 text-sm font-bold text-slate-800">{wards.filter(w => w.isMonitored).length} wards monitored</p>
        </div>
        <div className="divide-y divide-slate-100">
          {avgAqi != null && (
            <div className="px-4 py-3">
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">City avg AQI</p>
              <span className="text-2xl font-extrabold tabular-nums leading-none" style={{ color: avgLevel.hex }}>
                {avgAqi}
              </span>
              <p className="mt-0.5 text-xs font-semibold" style={{ color: avgLevel.hex }}>{avgLevel.label}</p>
            </div>
          )}
          {worstWard && (
            <div className="px-4 py-3">
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Worst ward</p>
              <p className="truncate text-sm font-bold text-slate-800">{formatWardName(worstWard.name)}</p>
              <p className="mt-0.5 text-xs font-semibold tabular-nums" style={{ color: worstLevel.hex }}>
                AQI {worstWard.aqi} · {worstLevel.label}
              </p>
            </div>
          )}
          {bestWard && bestWard.id !== worstWard?.id && (
            <div className="px-4 py-3">
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Best ward</p>
              <p className="truncate text-sm font-bold text-slate-800">{formatWardName(bestWard.name)}</p>
              <p className="mt-0.5 text-xs font-semibold tabular-nums" style={{ color: bestLevel.hex }}>
                AQI {bestWard.aqi} · {bestLevel.label}
              </p>
            </div>
          )}
        </div>
        <div className="mt-auto border-t border-slate-100 px-4 py-3">
          <p className="text-[10px] leading-relaxed text-slate-400">
            Select a ward row or tap the map for detailed forecast.
          </p>
        </div>
      </div>
    )
  }

  const forecast = forecasts.get(ward.id) ?? null
  const preferred = latestReadingsByWard?.get(ward.id)
  const forecastPoints = !forecastSuppressed && forecast?.points ? forecast.points : []
  // Which method actually produced this chart — real model vs. seasonal
  // baseline fallback (Sept 2026 addition; see forecastMethodFor's own doc
  // comment). Only meaningful when there's a real curve to attribute.
  const forecastMethod = forecastPoints.length > 0 ? forecastMethodFor(forecast ?? undefined) : null
  // Concrete validated-horizon trust statement (Sept 2026 addition) — was
  // fetched (ForecastPoint.maxValidatedHorizonHours/beatsPersistence, see
  // data.ts) but only ever read into a binary "Validated model"/"Baseline
  // estimate" badge label here. confidenceTierLabel already exists in
  // incidentRules.ts for exactly this ("Validated to Nh" vs. "Not
  // statistically validated") and is used elsewhere (PredictedIncidentPanel)
  // — reusing it instead of inventing new copy for the same fields.
  const validatedHorizonPoint = forecastPoints.find((p) => p.maxValidatedHorizonHours != null || p.beatsPersistence != null)
  const validatedHorizonLabel = validatedHorizonPoint
    ? confidenceTierLabel(validatedHorizonPoint.maxValidatedHorizonHours, validatedHorizonPoint.beatsPersistence ?? false)
    : null

  const usingCpcb = preferred?.sourceUsed === 'cpcb' && preferred.cpcbAqi != null
  const rawDisplayAqi = usingCpcb
    ? preferred!.cpcbAqi
    : (ward.aqi ?? preferred?.openaqAqi ?? null)
  // A max-sub-index AQI computed from only trace pollutants (e.g. O3/CO) while
  // PM2.5/PM10/NO2 are all absent is technically a real number but not a
  // meaningful one — it can read "Good" while the pollutants that actually
  // drive Delhi's air quality have simply stopped reporting. The reconcile
  // pipeline already flags this case as 'no_data' for the badge below; reuse
  // that instead of showing a falsely confident number next to a "No data" badge.
  const noData = preferred ? dataConfidenceLevel(preferred) === 'no_data' : false
  const displayAqi = noData ? null : rawDisplayAqi
  const level = aqiLevel(displayAqi)

  // Rank among monitored wards for the selected pollutant (Sept 2026
  // addition) — computed from the same order the left list already renders
  // in (rankedWards), not re-sorted here, so this number can never disagree
  // with the row's actual position. monitoredCount (not rankedWards.length)
  // is the honest denominator: rankedWards includes every ward passed in,
  // but only monitored ones have a real reading to be ranked by.
  const monitoredRanked = rankedWards.filter((w) => w.isMonitored)
  const rankIndex = monitoredRanked.findIndex((w) => w.id === ward.id)
  const wardRank = ward.isMonitored && rankIndex >= 0 ? rankIndex + 1 : null
  const wardRankTotal = monitoredRanked.length

  // Build pollutant readings. A real hourly mean (readings_hourly) wins when
  // one is fresh: CPCB's feed carries only 24-hour averages (Sept 2026
  // finding), which are a poor stand-in for "current". Otherwise
  // CPCB → OpenAQ (skip CO from OpenAQ, wrong unit) → ward fields, labelled
  // as the 24-hour averages they are.
  const readings: Partial<Record<typeof POLLUTANT_ORDER[number], number>> = {}
  const hourly = ward.hourly
  if (hourly) {
    for (const k of ['pm25', 'pm10', 'no2', 'so2', 'co', 'o3'] as const) {
      if (hourly[k] != null) readings[k] = hourly[k] as number
    }
  }
  const readingsBasis: 'hourly' | 'cpcb24h' | 'latest' =
    hourly && Object.keys(readings).length > 0
      ? 'hourly'
      : preferred?.cpcbPollutants || ward.valueBasis === 'naqi_window'
        ? 'cpcb24h'
        : 'latest'
  if (readingsBasis !== 'hourly' && preferred?.cpcbPollutants) {
    for (const k of POLLUTANT_ORDER) {
      const v = preferred.cpcbPollutants[k]
      if (v?.avg == null) continue
      // CO needs its unit checked (see normalizeCpcbCo) — every other
      // pollutant in this feed is consistently µg/m³, so `avg` is used as-is.
      readings[k] = k === 'co' ? normalizeCpcbCo(v) : v.avg
    }
  }
  if (readingsBasis !== 'hourly' && preferred?.openaqPollutants) {
    for (const k of POLLUTANT_ORDER) {
      if (k === 'co') continue // OpenAQ CO is µg/m³; config expects mg/m³ — skip
      const v = preferred.openaqPollutants[k]
      if (!(k in readings) && (v as number | undefined) != null) readings[k] = v as number
    }
  }
  // Bug fix (Sept 2026): this ward-level fallback previously only covered
  // pm25/pm10/no2 — so2/co/o3 fell through with no fallback at all if
  // cpcbPollutants/openaqPollutants happened to be missing them, even though
  // WardSummary carries real so2/co/o3 values (fetchAllWardsAqi already
  // selects them). nh3 has no ward.nh3 field to fall back to (see
  // mapRules.ts's own note: nh3 isn't queried at the ward level anywhere
  // yet), so it's correctly left out here, not a remaining gap.
  if (readingsBasis !== 'hourly') {
  if (!('pm25' in readings) && ward.pm25 != null) readings.pm25 = ward.pm25
  if (!('pm10' in readings) && ward.pm10 != null) readings.pm10 = ward.pm10
  if (!('no2' in readings) && ward.no2 != null) readings.no2 = ward.no2
  if (!('so2' in readings) && ward.so2 != null) readings.so2 = ward.so2
  if (!('co' in readings) && ward.co != null) readings.co = ward.co
  if (!('o3' in readings) && ward.o3 != null) readings.o3 = ward.o3
  }
  // Age suffix whenever the values are older than 3h (e.g. during an upstream
  // outage), so last-known values never read as current.
  const valuesTs = readingsBasis === 'hourly' && hourly ? hourly.ts : ward.ts
  const valuesAgeH = valuesTs ? (Date.now() - new Date(valuesTs).getTime()) / 3_600_000 : null
  const ageSuffix = valuesAgeH != null && valuesAgeH > 3 ? ` · ${Math.round(valuesAgeH)} h old` : ''
  const readingsLabel =
    (readingsBasis === 'hourly' && hourly
      ? `Readings · hourly mean from ${new Date(hourly.ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
      : readingsBasis === 'cpcb24h'
        ? 'Readings · 24-hour averages (CPCB)'
        : 'Readings') + ageSuffix

  const readingKeys = POLLUTANT_ORDER.filter((k) => readings[k] != null)

  // Generic, not special-cased to AQI (Sept 2026): forecastForPollutant
  // differs from `pollutant` only when that pollutant genuinely has no
  // forecast of its own — today that's AQI only (a composite index; see
  // forecastPollutantFor's own comment). SO2/CO/O3 used to also hit this
  // "(proxy)" branch (a gap in forecast.py's enabled-pollutants list, not a
  // real data limit — see forecastPollutantFor's 2nd-pass comment), so
  // this label logic needed no rewrite when that was fixed, just the
  // shared function underneath it starting to tell the truth.
  const forecastForPollutant = forecastPollutantFor(pollutant)
  const forecastLabel =
    pollutant === forecastForPollutant
      ? MAP_POLLUTANT_LABEL[pollutant]
      : `${MAP_POLLUTANT_LABEL[forecastForPollutant]} (drives AQI)`

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* AQI-coloured hero — serves as the visual "photo" area; swap for a real
          station image once we discover the CPCB CDN URL pattern. */}
      <div
        className="relative shrink-0 overflow-hidden px-4 pb-3 pt-4"
        style={{
          background: `linear-gradient(135deg, ${level.hex}22 0%, ${level.hex}0a 100%)`,
          borderBottom: `2px solid ${level.hex}35`,
        }}
      >
        {/* Subtle dot grid for texture */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.06) 1px, transparent 1px)',
            backgroundSize: '14px 14px',
          }}
        />
        <div className="relative flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-slate-400">Ward</p>
            <h3 className="mt-0.5 truncate text-sm font-bold text-slate-800" title={formatWardName(ward.name)}>
              {formatWardName(ward.name)}
            </h3>
            <p className="mt-0.5 text-xs font-semibold" style={{ color: level.hex }}>
              {level.label}
            </p>
          </div>
          {displayAqi != null && (
            <span
              className="shrink-0 text-3xl font-extrabold tabular-nums leading-none"
              style={{ color: level.hex }}
            >
              {displayAqi}
            </span>
          )}
        </div>
        {/* Rank among monitored wards (Sept 2026 addition) — turns a bare
            number into context: is this ward an outlier or middling for the
            selected pollutant right now. Uses the same order/urgency ranking
            the left list renders in (see wardRank's own comment above). */}
        {wardRank != null && wardRankTotal > 1 && (
          <p className="relative mt-1 text-[10px] font-medium text-slate-500">
            {wardRank === 1 ? (
              <span className="font-semibold" style={{ color: level.hex }}>Worst</span>
            ) : (
              <>
                <span className="font-semibold text-slate-700">#{wardRank}</span> worst
              </>
            )}
            {' '}of {wardRankTotal} monitored wards · {MAP_POLLUTANT_LABEL[pollutant]}
            {ward.ts && Date.now() - new Date(ward.ts).getTime() > 3 * 3_600_000 && (
              <span className="text-status-warning"> · reading {Math.round((Date.now() - new Date(ward.ts).getTime()) / 3_600_000)} h old</span>
            )}
          </p>
        )}
        {/* Health advisory (Sept 2026 addition) — aqiLevel() already carries
            this per CPCB-band text (used today only on the citizen-facing
            AqiGauge); reusing it here is a zero-new-fetch way to turn a bare
            number into a concrete action, not a new guideline source. */}
        {displayAqi != null && (
          <p className="relative mt-1.5 rounded-md px-2 py-1 text-[10px] leading-snug text-slate-600" style={{ backgroundColor: `${level.hex}14` }}>
            {level.advice}
          </p>
        )}
        {preferred && (
          <div className="relative mt-2 flex items-center gap-1.5">
            <AqSourceBadge preferred={preferred} />
            <DataConfidenceBadge preferred={preferred} />
          </div>
        )}
      </div>

      {/* Past 7 days — real history, sits above the forecast so past and
          future read together as one story (Sept 2026 addition; see
          fetchWardHistory's own doc comment for why this was missing). */}
      <div className="border-t border-slate-100 px-4 pt-3">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          AQI · past 7 days
        </p>
        {historyState.loading ? (
          <div className="flex h-28 items-center justify-center">
            <span className="text-[11px] text-slate-300">Loading history…</span>
          </div>
        ) : (
          <WardHistoryChart points={historyState.data ?? []} />
        )}
      </div>

      {/* Forecast chart */}
      <div className="border-t border-slate-100 px-4 pt-3">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {forecastLabel} · next {windowHours}h
          </p>
          {/* Method badge — real model vs. seasonal baseline (Sept 2026).
              Not decorative: per the platform's own validation audit
              (docs/data/forecast-validation-report.md), the model clears its
              accuracy bar for only ~1% of ward+pollutant pairs at any given
              time, so the honest default assumption for any chart is
              "baseline," and that has to be visible here, not just in an
              analytics tab a commander may never open mid-incident. */}
          {forecastMethod && (
            <span
              title={forecastFallbackStatus(forecastMethod, forecastMethod === 'lightgbm')}
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                forecastMethod === 'lightgbm'
                  ? 'bg-status-success/10 text-status-success'
                  : 'bg-slate-100 text-slate-500'
              }`}
            >
              {forecastMethod === 'lightgbm' ? 'Validated model' : 'Baseline estimate'}
            </span>
          )}
        </div>
        <ForecastChart points={forecastPoints} pollutant={pollutant} />
        <ForecastOutlook points={forecastPoints} />
        {!forecastSuppressed && <AqiForecastBlock wardId={ward.id} />}
        {forecastMethod && (
          <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
            {forecastFallbackStatus(forecastMethod, forecastMethod === 'lightgbm')}
          </p>
        )}
        {validatedHorizonLabel && (
          <p className="mt-0.5 text-[10px] font-medium text-slate-400">{validatedHorizonLabel}</p>
        )}
        {forecast?.hoursToSevere != null && (
          <p className="mt-1 text-[10px] font-semibold text-status-critical">
            Predicted severe in {forecast.hoursToSevere}h
          </p>
        )}
        {forecastSuppressed && (
          <p className="mt-1 text-[10px] text-slate-400">Forecast unavailable</p>
        )}
        {!forecastSuppressed && noData && forecastPoints.length > 0 && (
          <p className="mt-1 text-[10px] text-slate-400">
            Based on recent history — current station reading unavailable, see below.
          </p>
        )}
      </div>

      {/* Pollutant breakdown — one shared chart (Sept 2026 2nd pass) instead
          of a stack of individual PollutantRow progress bars, matching the
          two real SVG charts elsewhere on this panel (history/forecast)
          instead of reading as noticeably plainer. */}
      {readingKeys.length > 0 && (
        <div className="px-4 pt-4 pb-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {readingsLabel}
          </p>
          <CurrentReadingsChart readings={readings} keys={readingKeys} />
        </div>
      )}

      {/* Wards with no monitor (~226 of 265): model estimate with its honest
          90% range instead of an empty panel (Sept 2026). */}
      {!ward.isMonitored && (
        <div className="px-4 pt-4 pb-4">
          <WardEstimateBlock wardId={ward.id} />
        </div>
      )}

      {/* Source attribution — VayuTrace's real ISRM dispersion-kernel
          estimate (Sept 2026 addition): industrial/road/fire/unknown
          breakdown as one stacked proportional bar, same pattern as the Map
          page's SelectedWardPanel (the segment width IS the percentage).
          This is genuinely richer than the plain `dominant_source` string
          that used to be this panel's only source signal — it carries
          confidence and a regional/fire-transport read alongside the local
          mix, not just a single rule-engine category name. */}
      {(vayuTraceState.loading || vayuTraceState.data?.breakdown) && (
        <div className="border-t border-slate-100 px-4 py-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Source attribution
          </p>
          {vayuTraceState.loading ? (
            <div className="h-16 animate-pulse rounded-lg bg-slate-100" />
          ) : (
            (() => {
              const attribution = vayuTraceState.data as VayuTraceAttribution
              const b = attribution.breakdown!
              const SEGMENTS = [
                { key: 'industrial' as const, label: 'Industrial', color: 'bg-orange-400', dot: 'bg-orange-400' },
                { key: 'road' as const, label: 'Road traffic', color: 'bg-blue-400', dot: 'bg-blue-400' },
                // Dust (AP-42 road resuspension + WRAP construction), added
                // Sept 2026. Absent on older rows, which read 0.
                { key: 'dust' as const, label: 'Dust', color: 'bg-amber-300', dot: 'bg-amber-300' },
                { key: 'fire' as const, label: 'Fire / biomass', color: 'bg-red-400', dot: 'bg-red-400' },
              ] as const
              // Monte Carlo p10-p90. Shown beside each percentage because
              // the bands are wide and a bare figure overstates precision.
              const bands = attribution.breakdown_uncertainty
              const pcts = SEGMENTS.map((s) => {
                const band = bands?.[s.key]
                return {
                  ...s,
                  pct: Math.round(((b as Record<string, number>)[s.key] ?? 0) * 100),
                  lo: band ? Math.round(band.p10 * 100) : null,
                  hi: band ? Math.round(band.p90 * 100) : null,
                }
              })
              const nonZeroCount = pcts.filter((s) => s.pct > 0).length
              const hasFireAlert = attribution.regional_fire_index != null && attribution.regional_fire_index > 0.05
              return (
                <div>
                  <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                    {pcts.filter((s) => s.pct > 0).map((s) => (
                      <div
                        key={s.key}
                        className={`h-full ${s.color} first:rounded-l-full last:rounded-r-full`}
                        style={{ width: `${s.pct}%` }}
                        title={`${s.label}: ${s.pct}%`}
                      />
                    ))}
                  </div>
                  <div className="mt-1.5 space-y-1">
                    {pcts.map((s) => (
                      <div key={s.key} className="flex items-center gap-1.5 text-[10px]">
                        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${s.dot}`} aria-hidden />
                        <span className="text-slate-500">{s.label}</span>
                        <span className="ml-auto tabular-nums font-semibold text-slate-700">{s.pct}%</span>
                        {s.lo != null && s.hi != null && (
                          <span
                            className="tabular-nums text-[9px] text-slate-400"
                            title="10th-90th percentile over the model's known input uncertainty"
                          >
                            ({s.lo}-{s.hi})
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  {nonZeroCount <= 1 && (
                    <p className="mt-1.5 flex items-start gap-1 text-[9px] leading-snug text-amber-700">
                      <span aria-hidden>⚠</span>
                      <span>Only one source category had data — treat this as &quot;no other modelled source competed,&quot; not certainty.</span>
                    </p>
                  )}
                  {bands && (
                    <p className="mt-1 text-[9px] leading-snug text-slate-400">
                      Bracketed ranges are 10th-90th percentile over the model's
                      input uncertainty — wide because Delhi has no local
                      silt-loading or traffic-count data to constrain emission
                      strength. Indicative, not exact.
                    </p>
                  )}
                  {/* Validation, Sept 2026 (on real hourly data, 29 wards):
                      the dispersion model ranks wards by local load only
                      weakly (rho ~0.13) and its source SHARES cannot be
                      checked without chemical speciation. Say so. */}
                  <p className="mt-1 text-[9px] leading-snug text-slate-400">
                    Model-based, not measured: checked against hourly monitor data it
                    ranks wards only weakly, and source shares are unverified without
                    chemical analysis. Use as a lead for field checks, not as a finding.
                  </p>
                  {attribution.confidence != null && (
                    <p className="mt-1 text-[9px] text-slate-400">
                      Split precision{' '}
                      <span className="font-semibold text-slate-600">
                        {attribution.confidence >= 0.66 ? 'high' : attribution.confidence >= 0.33 ? 'medium' : 'low'}
                      </span>
                      {' '}· how tight the dominant source's range is
                      {' '}· local excess only, not a measurement
                    </p>
                  )}
                  {hasFireAlert && (
                    <p className="mt-1 flex items-center gap-1 text-[9px] font-medium text-orange-700">
                      <span aria-hidden>{attribution.regional_fire_index! >= 0.4 ? '🔥' : '⚠'}</span>
                      <span>
                        {attribution.regional_fire_index! >= 0.4 ? 'Active burning episode' : 'Regional fire transport'}
                        {' '}<span className="tabular-nums text-orange-500">({Math.round(attribution.regional_fire_index! * 100)}%)</span>
                        {' '}upwind
                      </span>
                    </p>
                  )}
                </div>
              )
            })()
          )}
        </div>
      )}

      {/* Citizen reports — same fetchWardRollup() FieldView already uses,
          reused here (Sept 2026 addition) so a selected ward's sensor
          reading and its citizen-reported ground truth sit in the same
          view instead of two disconnected pages. Hidden entirely rather
          than showing "0 reports" when a ward genuinely has none yet. */}
      {rollupState.data && (rollupState.data.open > 0 || rollupState.data.resolved > 0) && (
        <div className="border-t border-slate-100 px-4 py-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Citizen reports
          </p>
          <div className="flex items-center gap-3">
            {rollupState.data.open > 0 && (
              <div>
                <span className="text-lg font-extrabold tabular-nums leading-none text-status-critical">
                  {rollupState.data.open}
                </span>
                <span className="ml-1 text-[10px] text-slate-400">open</span>
              </div>
            )}
            {rollupState.data.resolved > 0 && (
              <div>
                <span className="text-lg font-extrabold tabular-nums leading-none text-slate-500">
                  {rollupState.data.resolved}
                </span>
                <span className="ml-1 text-[10px] text-slate-400">resolved</span>
              </div>
            )}
            {rollupState.data.topCategory && (
              <span className="ml-auto truncate text-[10px] text-slate-400">
                Top: <span className="font-medium text-slate-500">{formatSource(rollupState.data.topCategory)}</span>
              </span>
            )}
          </div>
          {rollupState.data.medianGatiHours != null && (
            <p className="mt-1 text-[9px] text-slate-400">
              Median resolution time: {rollupState.data.medianGatiHours.toFixed(1)}h
            </p>
          )}
        </div>
      )}

      {/* Monitoring station info */}
      {(ward.station_name || ward.station_agency || (ward.lat != null && ward.lng != null)) && (
        <div className="border-t border-slate-100 px-4 py-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Monitoring station
          </p>

          {/* Location card — tap to open in Google Maps */}
          {ward.lat != null && ward.lng != null && (
            <a
              href={`https://maps.google.com/?q=${ward.lat},${ward.lng}`}
              target="_blank"
              rel="noopener noreferrer"
              className="group mb-2.5 flex items-center gap-2.5 overflow-hidden rounded-lg border border-slate-100 bg-gradient-to-br from-sky-50 to-blue-50 px-3 py-2 transition hover:border-sky-200 hover:from-sky-100 hover:to-blue-100"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sky-100 transition group-hover:bg-sky-200">
                <MapPin className="h-3.5 w-3.5 text-sky-500" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold text-sky-600">Open in Maps ↗</p>
                <p className="font-mono text-[10px] text-slate-500 tabular-nums">
                  {ward.lat.toFixed(5)}, {ward.lng.toFixed(5)}
                </p>
              </div>
            </a>
          )}

          {ward.station_name && (
            <p className="truncate text-xs font-semibold leading-tight text-slate-700">
              {ward.station_name}
            </p>
          )}
          {ward.station_agency && (
            <p className="mt-0.5 text-[11px] text-slate-400">{ward.station_agency}</p>
          )}
        </div>
      )}

      {/* Rule-based category — same reasoning as the AQI number above: this
          is attributed from pollutant concentrations, so it's just as
          stale/meaningless as the AQI when the station has no current
          readings. Named explicitly as a distinct, coarser method (Sept
          2026, matching SelectedWardPanel's own footnote treatment) now
          that VayuTrace's real dispersion-kernel estimate is the headline
          source signal above, so the two never read as one contradicting
          the other with no explanation. */}
      {ward.dominant_source && !noData && (
        <div className="border-t border-slate-100 px-4 py-2.5 mt-auto">
          <span className="text-[10px] text-slate-400">
            Rule-based category:{' '}
            <span className="font-semibold text-slate-500">{formatSource(ward.dominant_source)}</span>
          </span>
        </div>
      )}
    </div>
  )
}

// ── Main export ────────────────────────────────────────────────────────────────

export default function HotspotsRiskTable({
  wards,
  forecasts,
  pollutant,
  onPollutantChange,
  windowHours,
  selectedWardId,
  onSelectWard,
  latestReadingsByWard,
  forecastSuppressed,
  reviewCount,
  openReportCount,
  coverage,
  latestReadingAgeMinutes,
  onWardsFlaggedClick,
}: {
  wards: WardSummary[]
  forecasts: Map<number, WardForecastSummary>
  pollutant: MapPollutant
  onPollutantChange: (p: MapPollutant) => void
  /** Still a real data parameter (drives peakWithinWindow/hotspotStatus and
   *  the detail panel below) even though the horizon-picker UI that used to
   *  change it was removed — it just isn't user-changeable from here anymore. */
  windowHours: TimeWindowHours
  selectedWardId: number | null
  onSelectWard: (wardId: number | null) => void
  latestReadingsByWard?: Map<number, LatestReadingReconciliation>
  forecastSuppressed?: boolean
  /** The 4 city KPIs (Wards flagged/Incidents open/Wards forecast/Data
   *  freshness) — passed through to the map's own glass KPI bar (Sept
   *  2026 move off the page header). Same props CityKpiRow has always taken. */
  reviewCount: number
  openReportCount: number
  coverage: { fresh: number; total: number } | null
  latestReadingAgeMinutes?: number | null
  onWardsFlaggedClick?: () => void
}) {
  const forecastPollutant = forecastPollutantFor(pollutant)
  const forecastPollutantLabel = MAP_POLLUTANT_LABEL[forecastPollutant]
  const isProxy = pollutant === 'aqi'
  const [infoOpen, setInfoOpen] = useState(false)
  // Ward search (direct request, Sept 2026) — a quick name filter for the
  // ranked list, since scrolling/scanning is the only way to find a
  // specific ward otherwise. Toggled via a search icon next to "Ward" in
  // the table header rather than always-on, to keep the header compact.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const isForecastSuppressed = forecastSuppressed ?? false

  // Row order: urgency (status tier, then soonest threshold-crossing), not
  // just current AQI (Sept 2026) — a ward trending toward Severe belongs
  // above one that's merely high-and-flat, even if the flat one's number is
  // bigger right now. Scoped to this table only; the header hero's "worst
  // ward" gauge intentionally keeps its own plain-AQI meaning (see
  // CommandView.tsx) so this doesn't change what the page's headline number
  // means, only the table's row order.
  // Bug fix (Sept 2026): compareByUrgency's numeric tie-breaker (and its
  // total fallback order below, when forecast is suppressed) used to
  // always sort by ward.aqi regardless of which of the 7 pollutant tabs
  // was selected — clicking PM2.5/SO2/CO/etc. changed what value the AQI
  // column *displayed* per row (CurrentReadingBadge) but never actually
  // re-ranked the rows by that pollutant. The severity TIER itself
  // (severe/watch/stable) is still left alone here — hotspotStatus()'s
  // hoursToSevere/hoursToVeryPoor inputs are computed against PM2.5-
  // specific concentration thresholds (SEVERE_THRESHOLD_PM25/
  // VERY_POOR_THRESHOLD_PM25 in data.ts) regardless of which pollutant's
  // curve produced them — so2/co/o3 DO now have their own real forecast
  // (forecast.py trains on all six; forecastPollutantFor() no longer falls
  // them back to pm25 — Sept 2026, 2nd pass), but giving each pollutant its
  // own severity-tier thresholds (their own CPCB Severe/Very-Poor
  // concentration cutoffs, not PM2.5's) is a separate, bigger change than
  // this fix and was left out of scope here. What DOES reflect the
  // selected pollutant today is the tie-breaker within a tier, and the
  // fallback order entirely — both use wardPollutantValue(ward, pollutant)
  // instead of a hardcoded ward.aqi, so every one of the 7 tabs (not just
  // AQI) actually re-sorts the table by its own real value.
  const rankedWards = isForecastSuppressed
    ? [...wards].sort((a, b) => {
        const av = wardPollutantValue(a, pollutant)
        const bv = wardPollutantValue(b, pollutant)
        if (av === null && bv === null) return 0
        if (av === null) return 1
        if (bv === null) return -1
        return bv - av
      })
    : [...wards]
        .map((ward) => {
          const forecast = forecasts.get(ward.id)
          const preferred = latestReadingsByWard?.get(ward.id)
          const windowed = peakWithinWindow(forecast, windowHours)
          const displayTs = ward.ts ?? preferred?.openaqLastUpdate ?? null
          const status = hotspotStatus(
            {
              hoursToSevere: forecast?.hoursToSevere ?? null,
              hoursToVeryPoor: forecast?.hoursToVeryPoor ?? null,
              peakExcess: windowed.excess,
              aqi: ward.aqi,
              readingAgeMinutes: ageMinutes(displayTs),
            },
            windowHours,
          )
          const hoursToThreshold =
            forecast?.hoursToSevere ?? forecast?.hoursToVeryPoor ?? null
          return { ward, status, hoursToThreshold, aqi: wardPollutantValue(ward, pollutant) }
        })
        .sort((a, b) => compareByUrgency(a, b))
        .map((r) => r.ward)

  // Search filters the displayed rows only — `rankedWards` itself (and each
  // ward's rank within it) stays computed over the full list, so a ward's
  // position/urgency order never shifts just because a search is active.
  const trimmedQuery = searchQuery.trim().toLowerCase()
  const visibleWards = trimmedQuery
    ? rankedWards.filter((w) => formatWardName(w.name).toLowerCase().includes(trimmedQuery))
    : rankedWards

  return (
    // Flush, edge-to-edge on the Overview page (no floating card look there) —
    // overrides Card's own rounded-2xl/shadow/ring via explicit utility
    // classes, which win over the `.card` @layer components class regardless
    // of source order (utilities layer beats components layer in Tailwind).
    //
    // No full-width CardHeader here anymore ("Wards by risk" title/subtitle
    // and the 12h/24h/36h/48h horizon buttons were removed — the title was
    // decorative and the horizon buttons drove a forecast that isn't
    // producing results with the current dataset, so they were dead
    // controls). The one control that's still genuinely useful — the
    // pollutant toggle, since it changes what the table/map actually show —
    // moved to sit directly above the ward table it controls, instead of
    // spanning the full width above the map too.
    <Card className="flex h-full min-h-0 flex-col overflow-hidden rounded-none shadow-none ring-0">
      {/* Split: table (left) | map (center) | detail (right) */}
      <div className="flex min-h-0 flex-1 divide-x divide-slate-100 overflow-hidden">

        {/* Left: compact ward table — 320px (Sept 2026, 2nd pass; was 380px).
            Narrowed further per direct request to leave more room for the
            map. The 7 pollutant buttons (AQI/PM2.5/PM10/NO2/SO2/CO/O3) wrap
            to two rows at this width instead of fitting on one — an
            accepted tradeoff (flex-wrap already in place below) rather
            than keeping the wider column just to avoid the wrap. */}
        <div className="relative flex min-h-0 w-[320px] shrink-0 flex-col overflow-hidden">
          {/* 7 options (was 4) — used to wrap to two rows at this column
              width, costing real vertical space above the table for
              something that's really just a compact toggle row. Sept 2026
              3rd pass: a horizontally-scrollable single row (2nd pass) had
              the opposite problem — O3 (the last button) scrolled out of
              view by default, needing a manual scroll just to see every
              option exists. Fixed properly instead: smaller text/padding/
              gap so all 7 short labels (AQI/PM2.5/PM10/NO2/SO2/CO/O3, max 4
              chars) fit on one row, fully visible, no scroll needed. */}
          <div className="flex-shrink-0 border-b border-slate-100 bg-slate-50/60 px-3 py-2">
            {/* One bordered "pill container" holding the pollutant buttons.
                Unselected buttons get their own border + white fill at rest
                (not just a hover colour, invisible until you're already
                hovering) so every option reads as clickable before you
                touch it, same as the selected one obviously is. */}
            <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white p-1">
              {POLLUTANT_OPTIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPollutantChange(p)}
                  aria-pressed={pollutant === p}
                  className={`focus-ring flex-1 rounded-md px-1 py-1 text-[11px] font-semibold transition ${
                    pollutant === p
                      ? 'bg-accent-500 text-white shadow-sm'
                      : 'border border-slate-200 bg-white text-slate-600 hover:border-accent-300 hover:bg-accent-50 hover:text-accent-700'
                  }`}
                >
                  {MAP_POLLUTANT_LABEL[p]}
                </button>
              ))}
            </div>
          </div>
          {searchOpen && (
            <div className="flex-shrink-0 border-b border-slate-100 bg-slate-50/60 px-3 py-2">
              <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1">
                <Search className="h-3.5 w-3.5 shrink-0 text-slate-300" aria-hidden />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search wards…"
                  autoFocus
                  className="w-full min-w-0 border-0 bg-transparent text-xs text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-0"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                    className="focus-ring shrink-0 rounded p-0.5 text-slate-300 transition hover:bg-slate-100 hover:text-slate-500"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                )}
              </div>
            </div>
          )}
          {infoOpen && (
            // Rendered as a sibling of the scrolling table (Sept 2026 fix),
            // not nested inside it: it used to live inside the table's own
            // `overflow-x-auto overflow-y-auto` div, which is a positioning/
            // clipping context of its own — an `absolute` child inside it
            // is placed relative to the table's scrollable content box, not
            // the visible 320px column, so it rendered off-panel regardless
            // of which edge it was anchored to. Anchored here to the outer
            // column (now `relative`, itself not a scroll container)
            // instead, and narrowed from w-72 (288px) to comfortably fit
            // with margin inside the 320px panel. Shifted down further when
            // the search row is also open, so it doesn't land on top of it.
            <div
              className={`absolute right-3 z-10 w-64 rounded-lg border border-slate-200 bg-white p-3 text-[11px] font-normal leading-relaxed text-slate-600 shadow-card-lg ${
                searchOpen ? 'top-[128px]' : 'top-[88px]'
              }`}
            >
              {/* Plainer, warmer copy (Sept 2026) — was denser/
                  more clinical, and used to assume forecast was
                  healthy when it had actually been failing for
                  weeks (fixed: see the missing-migration +
                  nowcast_backtest_passed NOT NULL fixes). Now
                  genuinely reflects live pipeline health instead
                  of always claiming a working forecast. */}
              <p>
                {pollutant === 'aqi'
                  ? "AQI colours follow India's official NAQI scale."
                  : 'Readings are shown in µg/m³.'}
              </p>
              <p className="mt-1.5">
                {isForecastSuppressed
                  ? "Forecasts aren't available right now — we're showing live readings only until the next successful run."
                  : isProxy
                  ? `AQI itself isn't forecast — trends use ${forecastPollutantLabel} as the closest available signal.`
                  : `Trend forecasts use ${forecastPollutantLabel}.`}
              </p>
              <p className="mt-1.5 text-slate-400">
                We use official CPCB/data.gov readings first, and fall back to OpenAQ only when those aren't available.
              </p>
            </div>
          )}
          <div className="flex-1 overflow-x-auto overflow-y-auto">
            {/* table-fixed + explicit widths (Sept 2026) instead of the
                browser's default auto-layout, which was sizing the Ward
                column to fit its widest content across every row and
                leaving a large, unstyled gap after short names like
                "Bawana" — auto-layout can't be trimmed with a max-w on one
                cell, since the column width is shared across all rows. */}
            <table className="w-full min-w-[300px] table-fixed border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {/* Rebalanced (Sept 2026, 2nd pass) — was 38/24/30/8.
                      Narrowing the panel to 320px made ward names like
                      "Sangam Vihar-b"/"Chandni Chowk" truncate hard; the AQI
                      badge (a short pill: dot + up-to-3-digit number) and
                      the fixed-56px-wide sparkline didn't need as much of
                      the row as they were getting, so width moved from
                      both into Ward instead. */}
                  <th className="w-[46%] px-2 py-1.5 font-semibold">
                    {/* Search toggle (direct request, Sept 2026) — opens a
                        name-filter input in place of the pollutant tab row's
                        bottom border, rather than an always-visible input
                        that would eat into the compact header permanently. */}
                    <span className="inline-flex items-center gap-1">
                      Ward
                      <button
                        type="button"
                        onClick={() => setSearchOpen((v) => !v)}
                        aria-label={searchOpen ? 'Close ward search' : 'Search wards'}
                        aria-expanded={searchOpen}
                        className="focus-ring rounded p-0.5 normal-case text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                      >
                        <Search className="h-3 w-3" aria-hidden />
                      </button>
                    </span>
                  </th>
                  <th className="w-[18%] px-2 py-1.5 font-semibold">{MAP_POLLUTANT_LABEL[pollutant]}</th>
                  <th className="w-[28%] px-2 py-1.5 font-semibold">
                    {/* About — moved next to "Trend" (Sept 2026), the
                        column it actually explains, instead of sitting in
                        the pollutant toggle bar above where it read as
                        about the whole table rather than specifically the
                        forecast/trend data. Opens downward into the table's
                        own open space. th isn't naturally a positioning
                        context for absolute children in every browser the
                        same way a div is, so the popup wrapper is
                        `relative` on its own inline-flex span, not the th. */}
                    <span className="inline-flex items-center gap-1">
                      Trend
                      <button
                        type="button"
                        onClick={() => setInfoOpen((v) => !v)}
                        aria-label="About these readings"
                        aria-expanded={infoOpen}
                        className="focus-ring rounded p-0.5 normal-case text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                      >
                        <Info className="h-3 w-3" aria-hidden />
                      </button>
                    </span>
                  </th>
                  <th className="w-[8%] px-1 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleWards.map((ward) => {
                  const forecast = forecasts.get(ward.id)
                  const preferred = latestReadingsByWard?.get(ward.id)
                  const windowed = peakWithinWindow(forecast, windowHours)
                  const displayTs = ward.ts ?? preferred?.openaqLastUpdate ?? null
                  const status = hotspotStatus(
                    {
                      hoursToSevere: forecast?.hoursToSevere ?? null,
                      hoursToVeryPoor: forecast?.hoursToVeryPoor ?? null,
                      peakExcess: windowed.excess,
                      aqi: ward.aqi,
                      readingAgeMinutes: ageMinutes(displayTs),
                    },
                    windowHours,
                  )
                  const deltaLabel = isForecastSuppressed ? null : forecastDeltaLabel(windowed)
                  const sparklinePoints = isForecastSuppressed
                    ? []
                    : (forecast?.points ?? []).map((p) => ({
                        horizon_ts: p.horizon_ts,
                        value: p.predicted_value ?? p.pm25_pred,
                      }))
                  // Method behind this row's sparkline — same honesty as the
                  // detail panel's chart (Sept 2026), surfaced in the hover
                  // tooltip since the row itself has no room for a badge.
                  const rowForecastMethod =
                    isForecastSuppressed || sparklinePoints.length === 0
                      ? null
                      : forecastMethodFor(forecast)
                  const selected = ward.id === selectedWardId
                  return (
                    <Fragment key={ward.id}>
                      <tr
                        onClick={() => onSelectWard(selected ? null : ward.id)}
                        className={`cursor-pointer transition ${selected ? 'bg-accent-50' : 'hover:bg-slate-50'}`}
                      >
                        <td
                          title={formatWardName(ward.name)}
                          className="overflow-hidden truncate px-2 py-1.5 font-medium text-slate-800"
                        >
                          {formatWardName(ward.name)}
                        </td>
                        <td className="px-2 py-1.5">
                          <CurrentReadingBadge ward={ward} pollutant={pollutant} preferred={preferred} />
                        </td>
                        <td className="px-2 py-1.5">
                          {isForecastSuppressed && status === 'stable' ? (
                            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-semibold text-slate-400 ring-1 ring-inset ring-slate-200">
                              —
                            </span>
                          ) : (
                            // Just the sparkline now (Sept 2026) — see
                            // TrendSparkline's own doc comment. The status
                            // label, delta and timing this used to spell out
                            // in the row are still here, just moved into the
                            // hover tooltip and (on click) the ward detail
                            // panel to the right, instead of competing for
                            // space on every row at once.
                            <TrendSparkline
                              points={sparklinePoints}
                              status={status}
                              title={[
                                HOTSPOT_STATUS_LABEL[status],
                                status === 'stale' ? `last fresh reading ${timeAgo(displayTs)} ago` : deltaLabel,
                                // Only true for AQI now (Sept 2026, 2nd
                                // pass) — a composite index has no forecast
                                // of its own, so its trend line is really
                                // PM2.5's trajectory, said explicitly here
                                // rather than silently showing a different
                                // pollutant's trend with no indication of
                                // the mismatch. SO2/CO/O3 used to hit this
                                // branch too (forecastPollutantFor's old
                                // 3-pollutant-only fallback), but now have
                                // real forecasts of their own.
                                pollutant !== forecastPollutant && sparklinePoints.length > 0
                                  ? `trend uses ${forecastPollutantLabel} (${MAP_POLLUTANT_LABEL[pollutant]} isn't forecast)`
                                  : null,
                                rowForecastMethod ? FORECAST_METHOD_LABEL[rowForecastMethod] : null,
                              ]
                                .filter(Boolean)
                                .join(' — ')}
                            />
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-slate-300">
                          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${selected ? 'rotate-90 text-accent-500' : ''}`} aria-hidden />
                        </td>
                      </tr>
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
            {rankedWards.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-slate-400">No ward data available.</p>
            )}
            {rankedWards.length > 0 && visibleWards.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-slate-400">No wards match “{searchQuery.trim()}”.</p>
            )}
          </div>
        </div>

        {/* Center: AQI choropleth map */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <OverviewChoroplethMap
            wards={wards}
            selectedWardId={selectedWardId}
            onSelectWard={onSelectWard}
            latestReadingsByWard={latestReadingsByWard}
            reviewCount={reviewCount}
            openReportCount={openReportCount}
            coverage={coverage}
            latestReadingAgeMinutes={latestReadingAgeMinutes}
            onWardsFlaggedClick={onWardsFlaggedClick}
          />
        </div>

        {/* Right: ward detail panel — 320px (Sept 2026, was 260px), matching
            the left ward-list panel's own width per direct feedback that it
            looked noticeably smaller/cramped by comparison. */}
        <div className="w-[320px] shrink-0 overflow-hidden">
          <WardDetailPanel
            selectedWardId={selectedWardId}
            wards={wards}
            rankedWards={rankedWards}
            forecasts={forecasts}
            latestReadingsByWard={latestReadingsByWard}
            pollutant={pollutant}
            windowHours={windowHours}
            forecastSuppressed={isForecastSuppressed}
          />
        </div>
      </div>
    </Card>
  )
}
