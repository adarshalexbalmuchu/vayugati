import { Fragment } from 'react'
import { ChevronDown, ChevronRight, Flame } from 'lucide-react'
import { aqiLevel } from '../AqiBadge'
import type { WardForecastSummary, WardSummary } from '../../lib/data'
import { MAP_POLLUTANT_LABEL, type MapPollutant } from '../../lib/mapRules'
import {
  hotspotStatus,
  HOTSPOT_STATUS_LABEL,
  isWardDataBacked,
  peakWithinWindow,
  type HotspotStatus,
  type TimeWindowHours,
} from '../../lib/overviewRules'
import { Card, CardHeader } from '../ui'

function ageMinutes(ts: string | null): number | null {
  return ts ? (Date.now() - new Date(ts).getTime()) / 60_000 : null
}

function timeAgo(ts: string | null): string {
  if (!ts) return '—'
  const h = Math.floor((Date.now() - new Date(ts).getTime()) / 3_600_000)
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

function CurrentReadingBadge({ ward, pollutant }: { ward: WardSummary; pollutant: MapPollutant }) {
  if (pollutant !== 'aqi') {
    const value = pollutant === 'pm25' ? ward.pm25 : pollutant === 'pm10' ? ward.pm10 : ward.no2
    return (
      <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-xs font-bold tabular-nums text-slate-700">
        {value != null ? `${Math.round(value)} µg/m³` : '—'}
      </span>
    )
  }
  const level = aqiLevel(ward.aqi)
  return (
    <span
      className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-bold tabular-nums"
      style={{ backgroundColor: `${level.hex}1f`, color: level.hex }}
    >
      {ward.aqi ?? '—'}
    </span>
  )
}

/** AQI has no forecast of its own (forecast.py never computes the composite
 *  index) - PM2.5/PM10/NO2 all do (forecast.py's DEFAULT_ENABLED_POLLUTANTS).
 *  Matches the same proxy convention Map uses (forecastPollutantFor). */
function forecastPollutantFor(pollutant: MapPollutant): 'pm25' | 'pm10' | 'no2' {
  return pollutant === 'aqi' ? 'pm25' : pollutant
}

export default function HotspotsRiskTable({
  wards,
  forecasts,
  pollutant,
  windowHours,
  selectedWardId,
  onSelectWard,
}: {
  wards: WardSummary[]
  /** Keyed by ward id, values already scoped to whichever real forecast
   *  pollutant forecastPollutantFor(pollutant) names - CommandView.tsx
   *  fetches accordingly, this component never mixes pollutants itself. */
  forecasts: Map<number, WardForecastSummary>
  pollutant: MapPollutant
  windowHours: TimeWindowHours
  selectedWardId: number | null
  onSelectWard: (wardId: number) => void
}) {
  const forecastPollutant = forecastPollutantFor(pollutant)
  const forecastPollutantLabel = MAP_POLLUTANT_LABEL[forecastPollutant]
  const isProxy = pollutant === 'aqi'

  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <Flame className="h-4 w-4 text-status-warning" aria-hidden />
            Hotspots &amp; Forecast Risk
          </span>
        }
        subtitle="Ranked by current reading, city-wide - click a row for detail"
      />
      <p className="border-b border-slate-100 px-4 py-2 text-[11px] text-slate-500">
        Showing current {MAP_POLLUTANT_LABEL[pollutant]}
        {isProxy && ' with PM2.5 forecast-risk signal'} and forecast peak within {windowHours}h.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2 font-semibold">#</th>
              <th className="px-3 py-2 font-semibold">Ward</th>
              <th className="px-3 py-2 font-semibold">
                Current {MAP_POLLUTANT_LABEL[pollutant]}
                {pollutant !== 'aqi' && <span className="normal-case"> (µg/m³)</span>}
              </th>
              <th className="px-3 py-2 font-semibold">
                Forecast {forecastPollutantLabel} Peak <span className="normal-case">(µg/m³, within {windowHours}h)</span>
                {isProxy && <span className="normal-case"> - risk signal</span>}
              </th>
              <th className="px-3 py-2 font-semibold">
                Local Excess <span className="normal-case">(µg/m³)</span>
              </th>
              <th className="px-3 py-2 font-semibold">Likely Source</th>
              <th className="px-3 py-2 font-semibold">Forecast Confidence</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Age</th>
              <th className="w-8 px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {wards.map((ward, i) => {
              const forecast = forecasts.get(ward.id)
              const dataBacked = isWardDataBacked(ward)
              const windowed = peakWithinWindow(forecast, windowHours)
              const status = hotspotStatus(
                {
                  hoursToSevere: forecast?.hoursToSevere ?? null,
                  peakExcess: windowed.excess,
                  aqi: ward.aqi,
                  readingAgeMinutes: ageMinutes(ward.ts),
                },
                windowHours,
              )
              // What the status would read without the staleness check - shown
              // as a secondary note on a stale badge rather than silently lost,
              // per the "keep the trend, but stale-qualified" requirement.
              const underlyingTrend = windowed.excess != null && windowed.excess > 0 ? 'was trending up' : null
              const confidence = windowed.ts != null ? (forecast?.points.find((p) => p.horizon_ts === windowed.ts)?.confidence ?? null) : null
              const selected = ward.id === selectedWardId
              return (
                <Fragment key={ward.id}>
                  <tr
                    onClick={() => onSelectWard(ward.id)}
                    className={`cursor-pointer transition ${selected ? 'bg-accent-50' : 'hover:bg-slate-50'}`}
                  >
                    <td className="px-3 py-2 tabular-nums text-slate-400">{i + 1}</td>
                    <td className="px-3 py-2 font-medium text-slate-800">{ward.name}</td>
                    <td className="px-3 py-2">
                      <CurrentReadingBadge ward={ward} pollutant={pollutant} />
                    </td>
                    <td className="px-3 py-2 tabular-nums text-slate-600">
                      {windowed.value != null ? `${Math.round(windowed.value)} µg/m³` : <span className="text-slate-400">Forecast unavailable</span>}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-slate-600">
                      {windowed.excess != null ? `${windowed.excess > 0 ? '+' : ''}${Math.round(windowed.excess)}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {dataBacked ? (
                        (ward.dominant_source ?? 'Unknown')
                      ) : (
                        <span className="text-slate-400" title="No station-backed data for this ward - a source cannot be assessed">
                          Not assessed
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-slate-600">
                      {confidence != null ? `${Math.round(confidence * 100)}%` : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge
                        status={status}
                        title={status === 'stale' ? `Last fresh reading ${timeAgo(ward.ts)} ago${underlyingTrend ? ` - ${underlyingTrend}` : ''}` : undefined}
                      />
                    </td>
                    <td className="px-3 py-2 tabular-nums text-slate-500">{timeAgo(ward.ts)}</td>
                    <td className="px-2 py-2 text-slate-300">
                      {selected ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                    </td>
                  </tr>
                  {selected && (
                    <tr className="bg-accent-50/60">
                      <td colSpan={10} className="px-3 py-3">
                        <div className="flex flex-wrap gap-x-8 gap-y-2 text-xs text-slate-600">
                          <span>
                            <span className="font-semibold text-slate-500">PM2.5 now:</span>{' '}
                            {ward.pm25 != null ? `${Math.round(ward.pm25)} µg/m³` : 'no reading'}
                          </span>
                          <span>
                            <span className="font-semibold text-slate-500">Predicted severe in:</span>{' '}
                            {forecast?.hoursToSevere != null ? `${forecast.hoursToSevere}h` : 'not predicted'}
                          </span>
                          <span>
                            <span className="font-semibold text-slate-500">Last reading:</span>{' '}
                            {ward.ts ? new Date(ward.ts).toLocaleString() : 'unavailable'}
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {wards.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-400">No ward data available.</p>}
      <div className="space-y-1 border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
        <p>
          {pollutant === 'aqi'
            ? 'Current reading is colour-coded on the India NAQI scale.'
            : 'Current reading shown in µg/m³ — colour bands apply to the AQI view only.'}{' '}
          {isProxy
            ? 'Forecast peaks are shown only for pollutants with validated forecast data - AQI itself is not forecast, so PM2.5 is shown as a risk signal instead.'
            : `Forecast Peak and Local Excess are both ${forecastPollutantLabel}, matching the selected metric.`}
        </p>
        <p>
          Likely Source is a preliminary citywide signal, not confirmed evidence - source confidence is only refined
          per-incident with citizen, field, or authority evidence in the Incidents workspace. Forecast Confidence
          reflects the forecast model's own reliability at its predicted peak, not confidence in the likely source.
        </p>
      </div>
    </Card>
  )
}
