import { AlertTriangle, MapPin, X } from 'lucide-react'
import { WARD_DATA_STATUS_LABEL, type WardDataStatus } from '../../lib/mapRules'

type JurisdictionType = 'mcd' | 'ndmc' | 'cantonment'

const JURISDICTION_LABEL: Record<JurisdictionType, string> = {
  mcd: 'Ward boundary',
  ndmc: 'Non-MCD jurisdiction',
  cantonment: 'Non-MCD jurisdiction',
}

const JURISDICTION_NOTE: Record<JurisdictionType, string> = {
  mcd: 'This is a municipal boundary reference (Phase 2 import).',
  ndmc: 'New Delhi Municipal Council (NDMC) - a separate civic body from MCD, so it has no MCD ward number. Shown here for map completeness (OpenStreetMap boundary import).',
  cantonment: 'Delhi Cantonment Board - administered by the Ministry of Defence, a separate civic body from MCD, so it has no MCD ward number. Shown here for map completeness (OpenStreetMap boundary import).',
}

const DATA_STATUS_TONE: Record<WardDataStatus, string> = {
  station_backed: 'text-status-success ring-status-success/40',
  nearest_station_proxy: 'text-status-warning ring-status-warning/40',
  no_station_data: 'text-slate-500 ring-slate-300',
}

export interface WardBoundaryStationRef {
  name: string
  aqi: number | null
  /** The currently-selected metric's value at this station (AQI/PM2.5/
   *  PM10/NO2 depending on the Map toolbar's pollutant toggle). */
  value: number | null
  isStale: boolean
}

export interface WardBoundaryDetail {
  id: number
  name: string
  wardNumber: number | null
  jurisdictionType: JurisdictionType
  dataStatus: WardDataStatus
  directStation: WardBoundaryStationRef | null
  nearestStation: (WardBoundaryStationRef & { distanceMeters: number }) | null
  linkedIncidentCount: number
  /** Null when this ward has no forecast_runs/forecasts history at all -
   *  real for many of the 250 boundary-only wards too, since forecast.py
   *  runs per-ward, not just for the 13 hotspot wards. */
  forecastPeak: number | null
  forecastPollutantLabel: string | null
  /** Label for the "selected metric" value shown for the station refs
   *  above - e.g. "AQI" or "PM10", matching the Map toolbar's toggle. */
  selectedMetricLabel: string
}

function fmtDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`
}

function StationRefBlock({ label, station, metricLabel }: { label: string; station: WardBoundaryStationRef; metricLabel: string }) {
  // When the selected metric IS AQI, station.value and station.aqi are the
  // same number - show it once rather than "AQI 26 · AQI 26".
  const showAqiSeparately = metricLabel !== 'AQI'
  return (
    <div className="mt-2 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px]">
      <p className="font-semibold text-slate-700">
        {label}: {station.name}
      </p>
      <p className="mt-0.5 text-slate-500">
        {metricLabel} {station.value ?? '—'}
        {showAqiSeparately && <> · AQI {station.aqi ?? '—'}</>}
        {station.isStale && <span className="ml-1 font-semibold text-status-warning">(stale reading)</span>}
      </p>
    </div>
  )
}

/**
 * Shown when a clicked boundary polygon is selected - covers all 250 Phase 2
 * municipal-boundary wards (is_hotspot = false) and the two non-MCD
 * jurisdictions (NDMC, Delhi Cantonment) imported from OpenStreetMap. Real
 * context where it exists (direct or nearest station, linked incidents,
 * forecast peak) - honest "no station-backed data" where it doesn't, never
 * a fabricated reading. The 13 monitored hotspot wards still use the full
 * SelectedWardPanel via their marker, unaffected.
 */
export default function SelectedWardBoundaryPanel({
  detail,
  onClose,
}: {
  detail: WardBoundaryDetail
  onClose: () => void
}) {
  const { name, wardNumber, jurisdictionType, dataStatus, directStation, nearestStation, linkedIncidentCount, forecastPeak, forecastPollutantLabel, selectedMetricLabel } = detail

  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{JURISDICTION_LABEL[jurisdictionType]}</p>
          <h2 className="text-sm font-semibold text-slate-800">{name}</h2>
        </div>
        <button type="button" onClick={onClose} className="focus-ring rounded p-1 text-slate-400 hover:bg-slate-100">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        {jurisdictionType === 'mcd' && (
          <div>
            <dt className="text-slate-400">Ward number</dt>
            <dd className="font-semibold tabular-nums text-slate-800">{wardNumber ?? 'Unknown'}</dd>
          </div>
        )}
        <div>
          <dt className="text-slate-400">Data status</dt>
          <dd>
            <span
              className={`mt-0.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ring-1 ring-inset ${DATA_STATUS_TONE[dataStatus]}`}
            >
              {WARD_DATA_STATUS_LABEL[dataStatus]}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Active incidents</dt>
          <dd className="font-semibold tabular-nums text-slate-800">{linkedIncidentCount}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Forecast</dt>
          <dd className="font-semibold text-slate-800">
            {forecastPeak != null ? (
              <>
                {Math.round(forecastPeak)} µg/m³ <span className="font-normal text-slate-400">({forecastPollutantLabel} peak)</span>
              </>
            ) : (
              <span className="font-normal text-slate-400">Not available</span>
            )}
          </dd>
        </div>
      </dl>

      {directStation && <StationRefBlock label="Assigned station" station={directStation} metricLabel={selectedMetricLabel} />}

      {!directStation && nearestStation && (
        <div className="mt-2 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px]">
          <p className="font-semibold text-slate-700">
            Nearest station: {nearestStation.name} <span className="font-normal text-slate-400">({fmtDistance(nearestStation.distanceMeters)} away)</span>
          </p>
          <p className="mt-0.5 text-slate-500">
            {selectedMetricLabel} {nearestStation.value ?? '—'}
            {selectedMetricLabel !== 'AQI' && <> · AQI {nearestStation.aqi ?? '—'}</>}
            {nearestStation.isStale && <span className="ml-1 font-semibold text-status-warning">(stale reading)</span>}
          </p>
          <p className="mt-1 text-[10px] text-slate-400">
            This is a nearby-station reading, not a reading assigned to this ward specifically.
          </p>
        </div>
      )}

      {!directStation && !nearestStation && (
        <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-500">
          <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-slate-400" strokeWidth={2} aria-hidden />
          <span>No direct station assigned. Select a nearby station marker for live readings.</span>
        </div>
      )}

      <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-500">
        <MapPin className="mt-0.5 h-3 w-3 flex-shrink-0 text-slate-400" strokeWidth={2} aria-hidden />
        <span>{JURISDICTION_NOTE[jurisdictionType]}</span>
      </div>
    </div>
  )
}
