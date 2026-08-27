import { Fragment, useState } from 'react'
import { ChevronRight, Clock, Info, MapPin } from 'lucide-react'
import { aqiLevel } from '../AqiBadge'
import type { ForecastPoint, LatestReadingReconciliation, WardForecastSummary, WardSummary } from '../../lib/data'
import OverviewChoroplethMap from './OverviewChoroplethMap'
import { formatWardName } from '../../lib/format'
import { aqSourceLabel, dataConfidenceLevel, DATA_CONFIDENCE_LABEL, type DataConfidenceLevel } from '../../lib/latestReadingRules'
import { MAP_POLLUTANT_LABEL, type MapPollutant } from '../../lib/mapRules'
import {
  hotspotStatus,
  HOTSPOT_STATUS_LABEL,
  peakWithinWindow,
  type HotspotStatus,
  type TimeWindowHours,
} from '../../lib/overviewRules'
import { Card, CardHeader } from '../ui'

const POLLUTANT_OPTIONS: MapPollutant[] = ['aqi', 'pm25', 'pm10', 'no2']
const WINDOW_OPTIONS: TimeWindowHours[] = [12, 24, 36, 48]

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

const STATUS_TONE: Record<HotspotStatus, string> = {
  severe: 'text-status-critical ring-status-critical/40',
  watch: 'text-status-warning ring-status-warning/40',
  stable: 'text-status-success ring-status-success/40',
  stale: 'text-status-warning ring-status-warning/40',
  no_data: 'text-slate-500 ring-slate-300',
}

const STATUS_DOT: Record<HotspotStatus, string> = {
  severe: 'bg-status-critical',
  watch: 'bg-status-warning',
  stable: 'bg-status-success',
  stale: 'bg-status-warning',
  no_data: 'bg-slate-400',
}

function StatusBadge({ status, title }: { status: HotspotStatus; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${STATUS_TONE[status]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} aria-hidden />
      {HOTSPOT_STATUS_LABEL[status]}
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
    const value = pollutant === 'pm25' ? ward.pm25 : pollutant === 'pm10' ? ward.pm10 : ward.no2
    return (
      <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-xs font-bold tabular-nums text-slate-700">
        {value != null ? `${Math.round(value)} µg/m³` : '—'}
      </span>
    )
  }
  const usingCpcb = preferred?.sourceUsed === 'cpcb' && preferred.cpcbAqi != null
  const displayAqi = usingCpcb ? preferred!.cpcbAqi : (ward.aqi ?? preferred?.openaqAqi ?? null)
  const isStaleValue = !usingCpcb && displayAqi != null && ward.aqi == null
  const level = aqiLevel(displayAqi)
  return (
    <span
      title={
        usingCpcb
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

function forecastPollutantFor(pollutant: MapPollutant): 'pm25' | 'pm10' | 'no2' {
  return pollutant === 'aqi' ? 'pm25' : pollutant
}

// ── Forecast chart ─────────────────────────────────────────────────────────────

const AQI_BAND_COLORS = ['#55A84F', '#A3C853', '#FFF833', '#F29C33', '#E93F33', '#AF2D24']

function levelColor(val: number, breaks: number[]): string {
  for (let i = 0; i < breaks.length; i++) {
    if (val <= breaks[i]) return AQI_BAND_COLORS[i]
  }
  return AQI_BAND_COLORS[5]
}

const FORECAST_BREAKS: Record<string, number[]> = {
  pm25: [30, 60, 90, 120, 250],
  pm10: [50, 100, 250, 350, 430],
  no2:  [40, 80, 180, 280, 400],
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
  const breaks = FORECAST_BREAKS[key] ?? FORECAST_BREAKS.pm25
  const vals = points.map((p) => (p.predicted_value ?? p.pm25_pred ?? 0) as number)
  const maxVal = Math.max(...vals, 50)

  const W = 260, H = 112, ML = 26, MB = 18, MT = 6, MR = 2
  const cW = W - ML - MR
  const cH = H - MT - MB
  const n = points.length
  const gap = 1.5
  const bW = Math.max(2, cW / n - gap)

  const yTicks = [0, Math.round(maxVal / 2), Math.round(maxVal)]

  const xLabels: { x: number; label: string }[] = []
  points.forEach((p, i) => {
    const d = new Date(p.horizon_ts)
    if (isNaN(d.getTime())) return
    const h = d.getHours()
    if (h % 6 === 0) {
      const label = h === 0 ? '12AM' : h === 12 ? '12PM' : h < 12 ? `${h}AM` : `${h - 12}PM`
      xLabels.push({ x: ML + (i / n) * cW + bW / 2, label })
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

function PollutantRow({ id, value }: { id: string; value: number }) {
  const cfg = POLLUTANT_CFG[id]
  if (!cfg) return null
  const color = levelColor(value, cfg.breaks)
  const pct = Math.min(100, (value / cfg.barMax) * 100)
  const display = id === 'co' ? value.toFixed(2) : Math.round(value)
  return (
    <div className="flex items-center gap-2">
      <span className="w-9 shrink-0 text-[10px] font-semibold text-slate-400">{cfg.label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="w-[68px] shrink-0 text-right text-[10px] tabular-nums text-slate-600">
        {display}{' '}
        <span className="text-slate-400">{cfg.unit}</span>
      </span>
    </div>
  )
}

// ── Ward detail panel (right side) ─────────────────────────────────────────────

function WardDetailPanel({
  selectedWardId,
  wards,
  forecasts,
  latestReadingsByWard,
  pollutant,
  windowHours,
  forecastSuppressed,
}: {
  selectedWardId: number | null
  wards: WardSummary[]
  forecasts: Map<number, WardForecastSummary>
  latestReadingsByWard?: Map<number, LatestReadingReconciliation>
  pollutant: MapPollutant
  windowHours: TimeWindowHours
  forecastSuppressed?: boolean
}) {
  const ward = wards.find((w) => w.id === selectedWardId) ?? null

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
        <div className="border-b border-slate-100 px-4 pb-3 pt-4">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">City overview</p>
          <p className="mt-0.5 text-sm font-bold text-slate-800">{wards.length} wards monitored</p>
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

  const usingCpcb = preferred?.sourceUsed === 'cpcb' && preferred.cpcbAqi != null
  const displayAqi = usingCpcb
    ? preferred!.cpcbAqi
    : (ward.aqi ?? preferred?.openaqAqi ?? null)
  const level = aqiLevel(displayAqi)

  // Build pollutant readings: CPCB → OpenAQ (skip CO from OpenAQ, wrong unit) → ward fields
  const readings: Partial<Record<typeof POLLUTANT_ORDER[number], number>> = {}
  if (preferred?.cpcbPollutants) {
    for (const k of POLLUTANT_ORDER) {
      const v = preferred.cpcbPollutants[k]
      if (v?.avg != null) readings[k] = v.avg
    }
  }
  if (preferred?.openaqPollutants) {
    for (const k of POLLUTANT_ORDER) {
      if (k === 'co') continue // OpenAQ CO is µg/m³; config expects mg/m³ — skip
      const v = preferred.openaqPollutants[k]
      if (!(k in readings) && (v as number | undefined) != null) readings[k] = v as number
    }
  }
  if (!('pm25' in readings) && ward.pm25 != null) readings.pm25 = ward.pm25
  if (!('pm10' in readings) && ward.pm10 != null) readings.pm10 = ward.pm10
  if (!('no2' in readings) && ward.no2 != null) readings.no2 = ward.no2

  const readingKeys = POLLUTANT_ORDER.filter((k) => readings[k] != null)

  const forecastLabel = pollutant === 'aqi' ? 'PM₂.₅ (proxy)' : MAP_POLLUTANT_LABEL[pollutant]

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
            {displayAqi != null && (
              <p className="mt-0.5 text-xs font-semibold" style={{ color: level.hex }}>
                {level.label}
              </p>
            )}
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
        {preferred && (
          <div className="mt-2 flex items-center gap-1.5">
            <AqSourceBadge preferred={preferred} />
            <DataConfidenceBadge preferred={preferred} />
          </div>
        )}
      </div>

      {/* Forecast chart */}
      <div className="px-4 pt-3">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          {forecastLabel} · next {windowHours}h
        </p>
        <ForecastChart points={forecastPoints} pollutant={pollutant} />
        {forecast?.hoursToSevere != null && (
          <p className="mt-1 text-[10px] font-semibold text-status-critical">
            Predicted severe in {forecast.hoursToSevere}h
          </p>
        )}
        {forecastSuppressed && (
          <p className="mt-1 text-[10px] text-slate-400">Forecast unavailable</p>
        )}
      </div>

      {/* Pollutant breakdown */}
      {readingKeys.length > 0 && (
        <div className="px-4 pt-4 pb-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Current readings
          </p>
          <div className="space-y-2">
            {readingKeys.map((k) => (
              <PollutantRow key={k} id={k} value={readings[k]!} />
            ))}
          </div>
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

      {/* Dominant source */}
      {ward.dominant_source && (
        <div className="border-t border-slate-100 px-4 py-2.5 mt-auto">
          <span className="text-[10px] text-slate-400">
            Likely source:{' '}
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
  onWindowHoursChange,
  selectedWardId,
  onSelectWard,
  latestReadingsByWard,
  forecastSuppressed,
}: {
  wards: WardSummary[]
  forecasts: Map<number, WardForecastSummary>
  pollutant: MapPollutant
  onPollutantChange: (p: MapPollutant) => void
  windowHours: TimeWindowHours
  onWindowHoursChange: (h: TimeWindowHours) => void
  selectedWardId: number | null
  onSelectWard: (wardId: number | null) => void
  latestReadingsByWard?: Map<number, LatestReadingReconciliation>
  forecastSuppressed?: boolean
}) {
  const forecastPollutant = forecastPollutantFor(pollutant)
  const forecastPollutantLabel = MAP_POLLUTANT_LABEL[forecastPollutant]
  const isProxy = pollutant === 'aqi'
  const [infoOpen, setInfoOpen] = useState(false)
  const isForecastSuppressed = forecastSuppressed ?? false

  return (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden">
      <CardHeader
        title="Wards by risk"
        subtitle="Ranked by current AQI and forecast trajectory."
        right={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 p-0.5">
              {POLLUTANT_OPTIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPollutantChange(p)}
                  className={`focus-ring rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                    pollutant === p ? 'bg-accent-500 text-white' : 'text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  {MAP_POLLUTANT_LABEL[p]}
                </button>
              ))}
            </div>
            <div
              className="flex items-center gap-1 rounded-lg border border-slate-200 p-0.5"
              title={isForecastSuppressed ? 'Horizon filter unavailable until the next successful forecast run' : undefined}
            >
              <Clock className={`ml-1.5 h-3.5 w-3.5 ${isForecastSuppressed ? 'text-slate-300' : 'text-slate-400'}`} aria-hidden />
              {WINDOW_OPTIONS.map((h) => (
                <button
                  key={h}
                  type="button"
                  disabled={isForecastSuppressed}
                  onClick={() => onWindowHoursChange(h)}
                  className={`focus-ring rounded-md px-2 py-1 text-xs font-semibold transition ${
                    isForecastSuppressed
                      ? 'cursor-not-allowed text-slate-300'
                      : windowHours === h
                      ? 'bg-accent-500 text-white'
                      : 'text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  {h}h
                </button>
              ))}
            </div>
          </div>
        }
      />

      {/* Split: table (left) | map (center) | detail (right) */}
      <div className="flex min-h-0 flex-1 divide-x divide-slate-100 overflow-hidden">

        {/* Left: compact ward table */}
        <div className="flex min-h-0 w-[300px] shrink-0 flex-col overflow-hidden">
          <div className="flex-1 overflow-x-auto overflow-y-auto">
            <table className="w-full min-w-[300px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-1.5 font-semibold">Ward</th>
                  <th className="px-2 py-1.5 font-semibold">{MAP_POLLUTANT_LABEL[pollutant]}</th>
                  <th className="px-2 py-1.5 font-semibold">Trend</th>
                  <th className="w-8 px-2 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {wards.map((ward) => {
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
                  const selected = ward.id === selectedWardId
                  return (
                    <Fragment key={ward.id}>
                      <tr
                        onClick={() => onSelectWard(selected ? null : ward.id)}
                        className={`cursor-pointer transition ${selected ? 'bg-accent-50' : 'hover:bg-slate-50'}`}
                      >
                        <td
                          title={formatWardName(ward.name)}
                          className="max-w-[110px] truncate px-2 py-1.5 font-medium text-slate-800"
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
                            <StatusBadge
                              status={status}
                              title={status === 'stale' ? `Last fresh reading ${timeAgo(displayTs)} ago` : undefined}
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
            {wards.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-slate-400">No ward data available.</p>
            )}
          </div>

          {/* Table footer */}
          <div className="flex items-center justify-end border-t border-slate-100 px-3 py-1.5">
            <div className="relative flex-shrink-0">
              <button
                type="button"
                onClick={() => setInfoOpen((v) => !v)}
                aria-label="About these readings"
                className="focus-ring flex items-center gap-1 rounded p-0.5 text-[10px] text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <Info className="h-3 w-3" aria-hidden />
                <span>About</span>
              </button>
              {infoOpen && (
                <div className="absolute bottom-full left-0 z-10 mb-1.5 w-64 rounded-lg border border-slate-200 bg-white p-2.5 text-[11px] leading-relaxed text-slate-600 shadow-card-lg">
                  <p>
                    {pollutant === 'aqi'
                      ? 'Current reading colour-coded on India NAQI scale.'
                      : 'Current reading in µg/m³.'}{' '}
                    {isProxy
                      ? 'AQI is not forecast — PM2.5 shown as proxy.'
                      : `Forecast uses ${forecastPollutantLabel}.`}
                  </p>
                  <p className="mt-1.5">
                    CPCB/data.gov preferred, OpenAQ fallback.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Center: AQI choropleth map */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <OverviewChoroplethMap
            wards={wards}
            selectedWardId={selectedWardId}
            onSelectWard={onSelectWard}
            latestReadingsByWard={latestReadingsByWard}
          />
        </div>

        {/* Right: ward detail panel */}
        <div className="w-[260px] shrink-0 overflow-hidden">
          <WardDetailPanel
            selectedWardId={selectedWardId}
            wards={wards}
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
