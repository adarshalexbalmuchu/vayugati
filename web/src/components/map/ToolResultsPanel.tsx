import { ChevronRight, Circle, Ruler, X } from 'lucide-react'
import { Stat } from '../ui'

export interface NearbyMatch {
  id: number
  label: string
}

/** Right-panel results for the two GIS analysis tools (measure/buffer),
 *  rendered in place of the marker-selection panels while a tool is active
 *  — same panel slot, same header/close-button convention as
 *  SelectedWardPanel.tsx, same Stat-tile grid convention as
 *  SpatialSummaryPanel.tsx for the buffer counts. */
export default function ToolResultsPanel({
  mode,
  measurePointCount,
  measureDistanceKm,
  onClearMeasure,
  radiusKm,
  wardMatches,
  stationMatches,
  incidentMatches,
  onSelectWard,
  onSelectStation,
  onSelectIncident,
  onClose,
}: {
  mode: 'measure' | 'buffer'
  measurePointCount: number
  measureDistanceKm: number | null
  onClearMeasure: () => void
  radiusKm: number
  wardMatches: NearbyMatch[]
  stationMatches: NearbyMatch[]
  incidentMatches: NearbyMatch[]
  onSelectWard: (id: number) => void
  onSelectStation: (id: number) => void
  onSelectIncident: (id: number) => void
  onClose: () => void
}) {
  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {mode === 'measure' ? (
            <Ruler className="h-4 w-4 text-accent-600" strokeWidth={2} aria-hidden />
          ) : (
            <Circle className="h-4 w-4 text-accent-600" strokeWidth={2} aria-hidden />
          )}
          <h2 className="text-sm font-semibold text-slate-800">
            {mode === 'measure' ? 'Measure distance' : 'Buffer zone'}
          </h2>
        </div>
        <button type="button" onClick={onClose} className="focus-ring rounded p-1 text-slate-400 hover:bg-slate-100">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {mode === 'measure' ? (
        <>
          <p className="mb-3 text-xs text-slate-400">Click the map to add points. Click Done or press Escape to finish.</p>
          <div className="grid grid-cols-2 gap-2">
            <Stat value={measurePointCount} label="Points placed" />
            <Stat
              value={measureDistanceKm != null ? `${measureDistanceKm.toFixed(2)} km` : '—'}
              label="Cumulative distance"
            />
          </div>
          {measurePointCount > 0 && (
            <button
              type="button"
              onClick={onClearMeasure}
              className="focus-ring mt-3 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Clear points
            </button>
          )}
        </>
      ) : (
        <>
          <p className="mb-3 text-xs text-slate-400">Click the map to place the buffer center.</p>
          <div className="grid grid-cols-3 gap-2">
            <Stat value={wardMatches.length} label="Nearby wards" />
            <Stat value={stationMatches.length} label="Stations" />
            <Stat value={incidentMatches.length} label="Incidents" />
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
            Within {radiusKm}km — ward results use centroid proximity, a v1 approximation, not polygon intersection.
          </p>

          {([
            { title: 'Wards', matches: wardMatches, onSelect: onSelectWard },
            { title: 'Stations', matches: stationMatches, onSelect: onSelectStation },
            { title: 'Incidents', matches: incidentMatches, onSelect: onSelectIncident },
          ] as const).map(({ title, matches, onSelect }) =>
            matches.length > 0 ? (
              <div key={title} className="mt-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{title}</p>
                <ul className="mt-1 space-y-1">
                  {matches.slice(0, 8).map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(m.id)}
                        className="focus-ring flex w-full items-center gap-1 rounded text-left text-xs text-accent-700 hover:underline"
                      >
                        <ChevronRight className="h-3 w-3 flex-shrink-0" aria-hidden />
                        <span className="truncate">{m.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </>
      )}
    </div>
  )
}
