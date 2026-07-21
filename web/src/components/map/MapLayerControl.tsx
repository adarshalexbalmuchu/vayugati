import { Layers2 } from 'lucide-react'

export type MapLayerKey =
  | 'wardBoundaries'
  | 'wardMarkers'
  | 'stations'
  | 'incidents'
  | 'predictedHotspots'
  | 'sourceAttribution'
  | 'dispatchZones'
  | 'citizenReports'
  | 'sensorFreshness'

export const LAYER_ORDER: MapLayerKey[] = [
  'wardBoundaries',
  'wardMarkers',
  'stations',
  'incidents',
  'predictedHotspots',
  'sourceAttribution',
  'dispatchZones',
  'citizenReports',
  'sensorFreshness',
]

export const LAYER_META: Record<MapLayerKey, { label: string; available: boolean; note: string }> = {
  // `available` here is the no-data default (no boundary geometry captured
  // yet). MapPage.tsx passes `wardBoundariesAvailable` once it knows
  // whether Supabase actually returned any `wards.boundary` rows (Phase 2
  // import) - real Supabase data decides this, never a hardcoded flip.
  wardBoundaries: {
    label: 'Ward boundaries',
    available: false,
    note: 'No boundary geometry has been captured for these wards yet.',
  },
  wardMarkers: {
    label: 'Ward AQI',
    available: true,
    note: 'Ward-level AQI value markers - previously always on with no toggle; now independent of "AQI stations".',
  },
  stations: { label: 'AQI stations', available: true, note: 'Live station readings.' },
  incidents: { label: 'Active incidents', available: true, note: 'Open incidents with a known location.' },
  predictedHotspots: {
    label: 'Predicted hotspots',
    available: true,
    note: 'Wards forecast to cross severe - ward-level, not a drawn zone.',
  },
  sourceAttribution: {
    label: 'Source attribution',
    available: true,
    note: 'Colour-codes markers by leading suspected source - a point signal, not a mapped zone.',
  },
  dispatchZones: {
    label: 'Dispatch/task zones',
    available: true,
    note: "Flags an incident's marker when it has an active dispatch.",
  },
  citizenReports: { label: 'Citizen reports', available: true, note: 'Reports submitted with location.' },
  sensorFreshness: {
    label: 'Sensor freshness',
    available: true,
    note: 'Highlights stations with no recent reading.',
  },
}

export const DEFAULT_LAYER_STATE: Record<MapLayerKey, boolean> = {
  wardBoundaries: false,
  wardMarkers: true,
  stations: true,
  incidents: true,
  predictedHotspots: false,
  sourceAttribution: false,
  dispatchZones: false,
  citizenReports: false,
  sensorFreshness: false,
}

function Toggle({ on, disabled }: { on: boolean; disabled: boolean }) {
  return (
    <span
      className={`relative inline-flex h-3.5 w-6 flex-shrink-0 items-center rounded-full transition ${
        disabled ? 'bg-slate-100' : on ? 'bg-accent-500' : 'bg-slate-200'
      }`}
    >
      <span
        className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white shadow transition ${on ? 'translate-x-3' : 'translate-x-0.5'}`}
      />
    </span>
  )
}

/** Floating layer-control panel (top-left over the map canvas). Every
 *  requested layer is always listed - unavailable ones (no real backing
 *  geometry, see mapRules/plan honesty table) render disabled with the
 *  reason instead of being hidden. Compact by default: one line per layer,
 *  descriptions live in the title tooltip rather than always-visible
 *  subtext, and the panel is a solid card (no glass/blur) so it reads as a
 *  control surface, not a decoration. */
export default function MapLayerControl({
  layers,
  onToggle,
  wardBoundariesAvailable = false,
}: {
  layers: Record<MapLayerKey, boolean>
  onToggle: (key: MapLayerKey) => void
  /** True once Supabase has returned at least one real `wards.boundary`
   *  row (see lib/data.ts's fetchAllWardBoundaries) - flips the otherwise
   *  permanently-disabled "Ward boundaries" toggle on. */
  wardBoundariesAvailable?: boolean
}) {
  return (
    <div className="w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-card">
      <div className="flex items-center gap-1.5 px-1.5 py-1">
        <Layers2 className="h-3 w-3 text-accent-600" strokeWidth={2} aria-hidden />
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Layers</p>
      </div>
      <ul>
        {LAYER_ORDER.map((key) => {
          const meta =
            key === 'wardBoundaries' && wardBoundariesAvailable
              ? { ...LAYER_META[key], available: true, note: 'Real MCD ward boundaries (Phase 2 import).' }
              : LAYER_META[key]
          const on = layers[key] && meta.available
          return (
            <li key={key}>
              <button
                type="button"
                disabled={!meta.available}
                title={meta.note}
                onClick={() => onToggle(key)}
                className={`focus-ring flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left transition ${
                  meta.available ? 'hover:bg-slate-50' : 'cursor-not-allowed opacity-50'
                }`}
              >
                <span className={`truncate text-[11px] font-medium ${meta.available ? 'text-slate-700' : 'text-slate-400'}`}>
                  {meta.label}
                </span>
                <Toggle on={on} disabled={!meta.available} />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
