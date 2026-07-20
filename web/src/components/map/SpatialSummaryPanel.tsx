import { Compass, TriangleAlert } from 'lucide-react'
import { Stat } from '../ui'

/** City-level summary shown in the right panel when nothing is selected -
 *  every figure is a straight pass-through of already-computed data (no new
 *  aggregation logic; severeWardsWithin/tallySourceMix/rollupStationHealth
 *  are the same overviewRules.ts functions the Overview page uses). */
export default function SpatialSummaryPanel({
  wardsShown,
  stationsActive,
  activeIncidents,
  predictedHotspots,
  dominantSource,
  staleSensors,
  locationsUnavailable,
}: {
  wardsShown: number
  stationsActive: number
  activeIncidents: number
  predictedHotspots: number
  dominantSource: { source: string; count: number } | null
  staleSensors: number
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
        <Stat value={wardsShown} label="Wards shown" />
        <Stat value={stationsActive} label="Stations active" />
        <Stat value={activeIncidents} label="Active incidents" accent={activeIncidents > 0 ? 'text-status-critical' : 'text-slate-900'} />
        <Stat value={predictedHotspots} label="Predicted hotspots" accent={predictedHotspots > 0 ? 'text-status-warning' : 'text-slate-900'} />
        <Stat value={staleSensors} label="Stale sensors" accent={staleSensors > 0 ? 'text-status-warning' : 'text-slate-900'} />
      </div>

      {/* Full-width, smaller type - this value is a word ("construction
          dust"), not a short number like the tiles above, so it needs more
          room than the shared Stat component's text-2xl numeric sizing. */}
      <div className="mt-2 rounded-xl bg-slate-50 px-3 py-2.5 text-center">
        <p className="truncate text-base font-bold capitalize text-slate-900" title={dominantSource?.source.replace(/_/g, ' ')}>
          {dominantSource ? dominantSource.source.replace(/_/g, ' ') : '—'}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">Dominant source signal</p>
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
