import { Compass, TriangleAlert } from 'lucide-react'
import { Stat } from '../ui'

/** City-level summary shown in the right panel when nothing is selected -
 *  every figure is a straight pass-through of already-computed data (no new
 *  aggregation logic; rollupStationHealth/severeWardsWithin are the same
 *  overviewRules.ts functions the Overview page uses). Deliberately
 *  distinguishes "252 municipal boundaries" from "13 monitored hotspot
 *  wards" - two real, different counts that read as contradictory if only
 *  one is shown without the other. */
export default function SpatialSummaryPanel({
  municipalBoundaryCount,
  hotspotWardCount,
  stationsTotal,
  stationsFresh,
  stationsStale,
  activeIncidents,
  forecastAlerts,
  dominantSource,
  locationsUnavailable,
}: {
  /** Real count from fetchAllWardBoundaries() - null while that fetch is
   *  still in flight, shown as "—" rather than a misleading 0. */
  municipalBoundaryCount: number | null
  hotspotWardCount: number
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
}) {
  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-1.5">
        <Compass className="h-4 w-4 text-accent-600" strokeWidth={2} aria-hidden />
        <h2 className="text-sm font-semibold text-slate-800">Spatial Summary</h2>
      </div>
      <p className="mb-3 text-xs text-slate-400">Select a ward, station, or incident marker for detail.</p>

      <div className="grid grid-cols-2 gap-2">
        <Stat value={municipalBoundaryCount ?? '—'} label="Municipal boundaries" />
        <Stat value={hotspotWardCount} label="Hotspot wards" />
        <Stat value={stationsTotal} label="AQ stations" />
        <Stat value={stationsFresh} label="Fresh stations" accent={stationsFresh > 0 ? 'text-status-success' : 'text-slate-900'} />
        <Stat value={stationsStale} label="Stale stations" accent={stationsStale > 0 ? 'text-status-warning' : 'text-slate-900'} />
        <Stat value={activeIncidents} label="Active incidents" accent={activeIncidents > 0 ? 'text-status-critical' : 'text-slate-900'} />
        <Stat value={forecastAlerts} label="Forecast alerts" accent={forecastAlerts > 0 ? 'text-status-warning' : 'text-slate-900'} />
      </div>

      {/* Full-width, smaller type - this value is a word ("construction
          dust"), not a short number like the tiles above, so it needs more
          room than the shared Stat component's text-2xl numeric sizing. */}
      <div className="mt-2 rounded-xl bg-slate-50 px-3 py-2.5 text-center">
        <p className="truncate text-base font-bold capitalize text-slate-900" title={dominantSource?.source.replace(/_/g, ' ')}>
          {dominantSource ? dominantSource.source.replace(/_/g, ' ') : '—'}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">Dominant suspected source signal (preliminary, citywide)</p>
      </div>

      {locationsUnavailable > 0 && (
        <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500">
          <TriangleAlert className="h-3 w-3 flex-shrink-0 text-slate-400" strokeWidth={2} aria-hidden />
          {locationsUnavailable} location{locationsUnavailable > 1 ? 's' : ''} unavailable - missing or outside Delhi/NCR.
        </p>
      )}
    </div>
  )
}
