import { ChevronRight, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Attribution, WardForecastSummary, WardSummary } from '../../lib/data'
import { confidenceAtPeak, hotspotStatus, HOTSPOT_STATUS_LABEL, type TimeWindowHours } from '../../lib/overviewRules'
import type { ActiveTaskDispatch, Incident } from '../../lib/incidents'
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
  onClose,
}: {
  ward: WardSummary
  forecast: WardForecastSummary | undefined
  pollutant: MapPollutant
  linkedIncidents: Incident[]
  linkedDispatches: ActiveTaskDispatch[]
  attribution: Attribution | null | undefined
  attributionLoading: boolean
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
