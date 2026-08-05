import { Compass, TriangleAlert } from 'lucide-react'
import { sourceCategoryLabel } from '../../lib/incidentRules'
import { Stat } from '../ui'

/** City-level summary shown in the right panel when nothing is selected -
 *  every figure is a straight pass-through of already-computed data (no new
 *  aggregation logic; rollupStationHealth/severeWardsWithin are the same
 *  overviewRules.ts functions the Overview page uses). */
export default function SpatialSummaryPanel({
  stationsTotal,
  stationsFresh,
  stationsStale,
  activeIncidents,
  forecastAlerts,
  dominantSource,
  locationsUnavailable,
  forecastSuppressed,
  forecastLoading = false,
  highestAqiWard,
  wardsWithCoverage,
}: {
  stationsTotal: number
  stationsFresh: number
  stationsStale: number
  activeIncidents: number
  /** Wards forecast to cross severe within the alert window - a ward-level
   *  forecast signal, distinct from Incidents' own "Predicted" queue
   *  (auto-detected anomaly incidents), which this deliberately does not
   *  try to reconcile into one merged number. */
  forecastAlerts: number
  dominantSource: { source: string; count: number } | null
  /** Count of wards/stations/incidents/reports with missing or out-of-Delhi
   *  coordinates - dropped from the map rather than plotted incorrectly. */
  locationsUnavailable: number
  /** When true, forecast-derived values are suppressed and shown as '—'. */
  forecastSuppressed: boolean
  /** When true the forecast fetch is still in flight — show '—' rather than
   *  the premature '0' that appears before any data arrives. */
  forecastLoading?: boolean
  /** The ward with the highest observed AQI (or null if none available). */
  highestAqiWard: { name: string; aqi: number } | null
  /** Number of wards that have a non-null AQI. */
  wardsWithCoverage: number
}) {
  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-1.5">
        <Compass className="h-4 w-4 text-accent-600" strokeWidth={2} aria-hidden />
        <h2 className="text-sm font-semibold text-slate-800">Spatial Summary</h2>
      </div>
      <p className="mb-3 text-xs text-slate-400">Select a ward, station, or incident marker for detail.</p>

      <div className="grid grid-cols-2 gap-2">
        <Stat
          value={wardsWithCoverage}
          label="Wards with AQ support"
          title="Wards that have a non-null AQI reading from an assigned monitoring station"
        />
        <Stat value={stationsTotal} label="AQ stations" />
        <Stat value={stationsFresh} label="Fresh stations" accent={stationsFresh > 0 ? 'text-status-success' : 'text-slate-900'} />
        <Stat value={stationsStale} label="Stale stations" accent={stationsStale > 0 ? 'text-status-warning' : 'text-slate-900'} />
        <Stat value={activeIncidents} label="Active incidents" accent={activeIncidents > 0 ? 'text-status-critical' : 'text-slate-900'} />
        <Stat
          value={forecastSuppressed || forecastLoading ? '—' : forecastAlerts}
          label={forecastSuppressed ? 'Forecast unavailable' : 'Forecast alerts'}
          accent={forecastSuppressed || forecastLoading ? 'text-slate-400' : forecastAlerts > 0 ? 'text-status-warning' : 'text-slate-900'}
        />
      </div>

      {/* Full-width info box — dominant source + highest AQI ward stacked */}
      <div className="mt-2 space-y-2">
        <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-center">
          <p
            className="truncate text-base font-bold capitalize text-slate-900"
            title={dominantSource ? sourceCategoryLabel(dominantSource.source as Parameters<typeof sourceCategoryLabel>[0]) : undefined}
          >
            {dominantSource ? sourceCategoryLabel(dominantSource.source as Parameters<typeof sourceCategoryLabel>[0]) : '—'}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">Dominant suspected source signal (preliminary, citywide)</p>
        </div>

        {highestAqiWard != null && (
          <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-center">
            <p className="text-base font-bold text-slate-900">{highestAqiWard.aqi}</p>
            <p className="mt-0.5 truncate text-xs text-slate-500" title={highestAqiWard.name}>
              Highest observed AQI · {highestAqiWard.name}
            </p>
          </div>
        )}
      </div>

      {locationsUnavailable > 0 && (
        <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500">
          <TriangleAlert className="h-3 w-3 flex-shrink-0 text-slate-400" strokeWidth={2} aria-hidden />
          {locationsUnavailable} location{locationsUnavailable > 1 ? 's' : ''} unavailable - missing or outside Delhi/NCR.
        </p>
      )}

      <p className="mt-3 text-[10px] text-slate-400">252 municipal boundaries in the GIS layer</p>
    </div>
  )
}
