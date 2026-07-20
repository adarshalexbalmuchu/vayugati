import { Compass } from 'lucide-react'
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
}: {
  wardsShown: number
  stationsActive: number
  activeIncidents: number
  predictedHotspots: number
  dominantSource: { source: string; count: number } | null
  staleSensors: number
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
        <Stat
          value={dominantSource ? dominantSource.source.replace(/_/g, ' ') : '—'}
          label="Dominant source signal"
        />
      </div>
    </div>
  )
}
