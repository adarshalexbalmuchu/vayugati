import { X } from 'lucide-react'
import { forecastFallbackStatus, FORECAST_METHOD_LABEL, type ForecastMethod } from '../../lib/incidentRules'
import type { ForecastRunRow } from '../../lib/incidents'
import { MAP_POLLUTANT_LABEL, type MapPollutant, type MapTimeMode } from '../../lib/mapRules'
import { Skeleton } from '../ui'

export interface SelectedStation {
  id: number
  name: string
  wardName: string | null
  sensorType: string
  aqi: number | null
  pm25: number | null
  pm10: number | null
  no2: number | null
  ageMinutes: number | null
  isStale: boolean
  isActive: boolean
  /** Which source `aqi` came from - undefined when the CPCB/data.gov
   *  reconciliation hasn't loaded (falls back to the existing OpenAQ-
   *  sourced value either way). See docs/data/cpcb-data-gov-primary-
   *  latest-integration-report.md. */
  readingSource?: 'cpcb' | 'openaq_fallback'
}

function fmtAge(minutes: number | null): string {
  if (minutes == null) return 'No readings yet'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function SelectedStationPanel({
  station,
  pollutant,
  timeMode,
  forecastPeak,
  forecastPollutantLabel,
  latestForecastRun,
  latestForecastRunLoading,
  onClose,
}: {
  station: SelectedStation
  pollutant: MapPollutant
  timeMode: MapTimeMode
  /** This station's linked ward's forecast peak, in whichever pollutant
   *  forecastPollutantLabel names - null when no forecast data covers this
   *  ward at all (never fabricated). */
  forecastPeak: number | null
  forecastPollutantLabel: string
  /** The linked ward's latest forecast_runs row - same table/query
   *  PredictedIncidentPanel.tsx already uses, just surfaced here too. */
  latestForecastRun: ForecastRunRow | null | undefined
  latestForecastRunLoading: boolean
  onClose: () => void
}) {
  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Station</p>
          <h2 className="text-sm font-semibold text-slate-800">{station.name}</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            {station.wardName ?? 'Unknown ward'} · <span className="uppercase">{station.sensorType}</span>
          </p>
        </div>
        <button type="button" onClick={onClose} className="focus-ring rounded p-1 text-slate-400 hover:bg-slate-100">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {station.isStale && (
        <div className="mb-2 flex items-center gap-1.5 rounded-lg bg-status-warning/10 px-2.5 py-1.5 text-[11px] font-semibold text-status-warning">
          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-status-warning" aria-hidden />
          Stale reading - last seen {fmtAge(station.ageMinutes)}, values below may not reflect current conditions.
        </div>
      )}

      <div className="mb-2 flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ring-1 ring-inset ${
            station.isStale ? 'text-status-warning ring-status-warning/40' : 'text-status-success ring-status-success/40'
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${station.isStale ? 'bg-status-warning' : 'bg-status-success'}`} aria-hidden />
          {station.isStale ? 'Stale' : 'Fresh'}
        </span>
        <span className="text-[11px] text-slate-400">{fmtAge(station.ageMinutes)}</span>
        {!station.isActive && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-500">Inactive</span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <div>
          <dt className="text-slate-400">{MAP_POLLUTANT_LABEL[pollutant]}</dt>
          <dd className="font-semibold tabular-nums text-slate-800">
            {(pollutant === 'aqi' ? station.aqi : pollutant === 'pm25' ? station.pm25 : pollutant === 'pm10' ? station.pm10 : station.no2) ?? '—'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">
            AQI
            {station.readingSource && (
              <span className="ml-1 font-normal normal-case text-slate-400">
                ({station.readingSource === 'cpcb' ? 'CPCB/data.gov' : 'OpenAQ fallback'})
              </span>
            )}
          </dt>
          <dd className="font-semibold tabular-nums text-slate-800">{station.aqi ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-slate-400">PM2.5</dt>
          <dd className="font-semibold tabular-nums text-slate-800">{station.pm25 ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-slate-400">PM10</dt>
          <dd className="font-semibold tabular-nums text-slate-800">{station.pm10 ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-slate-400">NO₂</dt>
          <dd className="font-semibold tabular-nums text-slate-800">{station.no2 ?? '—'}</dd>
        </div>
      </dl>

      <div className="mt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Forecast (linked ward)</p>
        {latestForecastRunLoading ? (
          <Skeleton className="mt-1 h-14 w-full" />
        ) : latestForecastRun ? (
          (() => {
            const method: ForecastMethod = latestForecastRun.method === 'lightgbm' ? 'lightgbm' : 'diurnal_persistence'
            return (
              <div className="mt-1 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-600">
                <p className="font-semibold text-slate-800">{FORECAST_METHOD_LABEL[method]}</p>
                <p className="mt-0.5">{forecastFallbackStatus(method, latestForecastRun.beats_persistence)}</p>
                <p className="mt-1 text-slate-500">
                  {timeMode === 'now' ? 'Latest cycle' : `${timeMode} forecast peak`}:{' '}
                  {timeMode === 'now'
                    ? new Date(latestForecastRun.generated_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
                    : forecastPeak != null
                      ? `${Math.round(forecastPeak)} µg/m³ (${forecastPollutantLabel})`
                      : 'Not available'}
                </p>
              </div>
            )
          })()
        ) : (
          <p className="mt-1 text-xs text-slate-400">No forecast validation record for this station's ward yet.</p>
        )}
      </div>
    </div>
  )
}
