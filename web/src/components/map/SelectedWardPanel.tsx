import { ChevronRight, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Attribution, VayuTraceAttribution, WardForecastSummary, WardSummary } from '../../lib/data'
import { forecastFallbackStatus, FORECAST_METHOD_LABEL, type ForecastMethod } from '../../lib/incidentRules'
import { confidenceAtPeak, hotspotStatus, HOTSPOT_STATUS_LABEL, type TimeWindowHours } from '../../lib/overviewRules'
import type { ActiveTaskDispatch, ForecastRunRow, Incident } from '../../lib/incidents'
import { MAP_POLLUTANT_LABEL, stationReadingValue, type MapPollutant } from '../../lib/mapRules'
import { Skeleton } from '../ui'

const NEXT_ACTION: Record<string, string> = {
  severe: 'Dispatch verification - forecast to cross severe soon.',
  watch: 'Monitor closely - local excess is rising.',
  stable: 'No action needed - readings are within normal range.',
  no_data: 'No current or forecast data available for this ward.',
}

export default function SelectedWardPanel({
  ward,
  forecast,
  pollutant,
  linkedIncidents,
  linkedDispatches,
  attribution,
  attributionLoading,
  vayuTraceAttribution,
  vayuTraceAttributionLoading,
  latestForecastRun,
  latestForecastRunLoading,
  onClose,
}: {
  ward: WardSummary
  forecast: WardForecastSummary | undefined
  pollutant: MapPollutant
  linkedIncidents: Incident[]
  linkedDispatches: ActiveTaskDispatch[]
  attribution: Attribution | null | undefined
  attributionLoading: boolean
  vayuTraceAttribution: VayuTraceAttribution | null | undefined
  vayuTraceAttributionLoading: boolean
  /** PM2.5's latest validation record for this ward - same table
   *  PredictedIncidentPanel.tsx reads, just surfaced here too so "is this
   *  forecast ML-validated or a conservative baseline fallback" is visible
   *  without leaving the Map. */
  latestForecastRun: ForecastRunRow | null | undefined
  latestForecastRunLoading: boolean
  onClose: () => void
}) {
  const reading = stationReadingValue(ward, pollutant)
  const confidence = confidenceAtPeak(forecast)
  const windowHours: TimeWindowHours = 36
  const status = hotspotStatus(
    { hoursToSevere: forecast?.hoursToSevere ?? null, peakExcess: forecast?.peakExcess ?? null, aqi: ward.aqi },
    windowHours,
  )
  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Ward</p>
          <h2 className="text-sm font-semibold text-slate-800">{ward.name}</h2>
          {ward.station_name && (
            <p className="mt-0.5 text-[11px] text-slate-400">
              {ward.station_name}
              {ward.station_agency && (
                <span className="ml-1 rounded bg-slate-100 px-1 py-0.5 font-medium text-slate-500">
                  {ward.station_agency}
                </span>
              )}
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} className="focus-ring rounded p-1 text-slate-400 hover:bg-slate-100">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <div>
          <dt className="text-slate-400">{MAP_POLLUTANT_LABEL[pollutant]} now</dt>
          <dd className="font-semibold tabular-nums text-slate-800">{reading ?? 'Unavailable'}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Local excess</dt>
          <dd className="font-semibold tabular-nums text-slate-800">
            {forecast?.peakExcess != null ? `+${Math.round(forecast.peakExcess)} µg/m³` : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Forecast peak</dt>
          <dd className="font-semibold tabular-nums text-slate-800">
            {forecast?.peakPred != null ? `${Math.round(forecast.peakPred)} µg/m³` : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Confidence</dt>
          <dd className="font-semibold tabular-nums text-slate-800">{confidence != null ? `${Math.round(confidence * 100)}%` : '—'}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-slate-400">Likely source</dt>
          <dd className="font-semibold capitalize text-slate-800">{ward.dominant_source?.replace(/_/g, ' ') ?? 'Unknown'}</dd>
        </div>
      </dl>

      <div className="mt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Current readings</p>
        {ward.station_name ? (
          <dl className="mt-1 grid grid-cols-3 gap-x-2 gap-y-1.5 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px]">
            {(
              [
                { key: 'pm25', label: 'PM2.5', unit: 'µg/m³', value: ward.pm25 },
                { key: 'pm10', label: 'PM10', unit: 'µg/m³', value: ward.pm10 },
                { key: 'no2', label: 'NO₂', unit: 'µg/m³', value: ward.no2 },
                { key: 'so2', label: 'SO₂', unit: 'µg/m³', value: ward.so2 },
                { key: 'co', label: 'CO', unit: 'mg/m³', value: ward.co },
                { key: 'o3', label: 'O₃', unit: 'µg/m³', value: ward.o3 },
              ] as const
            ).map(({ key, label, unit, value }) => (
              <div key={key}>
                <dt className="text-slate-400">{label}</dt>
                <dd className="font-semibold tabular-nums text-slate-800">
                  {value != null ? value.toFixed(1) : <span className="font-normal text-slate-400">—</span>}
                </dd>
                <dd className="text-[10px] text-slate-400">{unit}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-1 text-xs text-slate-400">No monitoring station matched for this ward.</p>
        )}
      </div>

      <div className="mt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">PM2.5 forecast status</p>
        {latestForecastRunLoading ? (
          <Skeleton className="mt-1 h-10 w-full" />
        ) : latestForecastRun ? (
          (() => {
            const method: ForecastMethod = latestForecastRun.method === 'lightgbm' ? 'lightgbm' : 'diurnal_persistence'
            return (
              <div className="mt-1 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-600">
                <p className="font-semibold text-slate-800">{FORECAST_METHOD_LABEL[method]}</p>
                <p className="mt-0.5">{forecastFallbackStatus(method, latestForecastRun.beats_persistence)}</p>
                <p className="mt-1 text-slate-400">
                  Latest cycle: {new Date(latestForecastRun.generated_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                </p>
              </div>
            )
          })()
        ) : (
          <p className="mt-1 text-xs text-slate-400">No forecast validation record yet for this ward.</p>
        )}
      </div>

      <div className="mt-3 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-600">
        <span className="font-semibold">Recommended next action:</span> {NEXT_ACTION[status]}
        <span className="ml-1 text-slate-400">({HOTSPOT_STATUS_LABEL[status]})</span>
      </div>

      <div className="mt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Upwind signal</p>
        {attributionLoading ? (
          <Skeleton className="mt-1 h-8 w-full" />
        ) : attribution ? (
          <p className="mt-1 text-xs text-slate-600">
            Load arriving predominantly from the <span className="font-semibold">{attribution.direction ?? 'unknown'}</span>{' '}
            sector
            {attribution.confidence != null && ` (${Math.round(attribution.confidence * 100)}% confidence)`} - a
            wind-rose signal, not a mapped plume.
          </p>
        ) : (
          <p className="mt-1 text-xs text-slate-400">No wind-attribution data available for this ward.</p>
        )}
      </div>

      <div className="mt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Estimated source mix
        </p>
        {vayuTraceAttributionLoading ? (
          <Skeleton className="mt-1 h-12 w-full" />
        ) : vayuTraceAttribution?.breakdown ? (
          <div className="mt-1 space-y-1.5">
            {(
              [
                { key: 'industrial' as const, label: 'Industrial', color: 'bg-orange-400' },
                { key: 'road'       as const, label: 'Road traffic', color: 'bg-blue-400' },
                { key: 'fire'       as const, label: 'Fire / biomass', color: 'bg-red-400' },
              ] as const
            ).map(({ key, label, color }) => {
              const pct = Math.round((vayuTraceAttribution.breakdown![key] ?? 0) * 100)
              return (
                <div key={key}>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-600">{label}</span>
                    <span className="tabular-nums font-semibold text-slate-800">{pct}%</span>
                  </div>
                  <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
            {vayuTraceAttribution.confidence != null && (
              <p className="text-[10px] text-slate-400">
                Confidence {Math.round(vayuTraceAttribution.confidence * 100)}% · local excess only · forward model, not a measurement
              </p>
            )}
            {vayuTraceAttribution.regional_fraction_prior != null && (
              <p className="text-[10px] text-slate-400 mt-0.5">
                ~{Math.round(vayuTraceAttribution.regional_fraction_prior * 100)}% estimated regional/upwind transport (non-fire base + current fire activity) — not captured above
              </p>
            )}
            {vayuTraceAttribution.regional_fire_index != null &&
              vayuTraceAttribution.regional_fire_index > 0.05 && (
              <div className="mt-1 flex items-center gap-1.5 rounded-md bg-orange-50 px-2 py-1">
                <span className="text-[10px] text-orange-700 font-medium">
                  {vayuTraceAttribution.regional_fire_index >= 0.4
                    ? '🔥 Active burning episode'
                    : '⚠ Regional fire transport'}
                </span>
                <span className="text-[10px] text-orange-500 tabular-nums">
                  {Math.round(vayuTraceAttribution.regional_fire_index * 100)}% index
                </span>
                <span className="text-[10px] text-orange-400">
                  — Punjab/Haryana/UP smoke detected upwind
                </span>
              </div>
            )}
          </div>
        ) : (
          <p className="mt-1 text-xs text-slate-400">No source-mix estimate yet for this ward.</p>
        )}
      </div>

      <div className="mt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Linked incidents ({linkedIncidents.length})
        </p>
        {linkedIncidents.length === 0 ? (
          <p className="mt-1 text-xs text-slate-400">None open.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {linkedIncidents.slice(0, 5).map((i) => (
              <li key={i.id}>
                <Link
                  to={`/incidents?incident=${i.id}`}
                  className="focus-ring flex items-center gap-1 rounded text-xs text-accent-700 hover:underline"
                >
                  <ChevronRight className="h-3 w-3 flex-shrink-0" aria-hidden />
                  <span className="truncate">{i.summary ?? `Incident #${i.id}`}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Linked tasks ({linkedDispatches.length})
        </p>
        {linkedDispatches.length === 0 ? (
          <p className="mt-1 text-xs text-slate-400">No active dispatches.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-xs text-slate-600">
            {linkedDispatches.slice(0, 5).map((d) => (
              <li key={d.id} className="truncate">
                {d.incident_summary ?? `Dispatch #${d.id}`} · <span className="capitalize">{d.status.replace(/_/g, ' ')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
