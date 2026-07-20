import { Layers2 } from 'lucide-react'

export type MapLayerKey =
  | 'wardBoundaries'
  | 'stations'
  | 'incidents'
  | 'predictedHotspots'
  | 'sourceAttribution'
  | 'dispatchZones'
  | 'citizenReports'
  | 'sensorFreshness'

export const LAYER_ORDER: MapLayerKey[] = [
  'wardBoundaries',
  'stations',
  'incidents',
  'predictedHotspots',
  'sourceAttribution',
  'dispatchZones',
  'citizenReports',
  'sensorFreshness',
]

export const LAYER_META: Record<MapLayerKey, { label: string; available: boolean; note: string }> = {
  wardBoundaries: {
    label: 'Ward boundaries',
    available: false,
    note: 'No boundary geometry has been captured for these wards yet.',
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
      className={`relative inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full transition ${
        disabled ? 'bg-slate-100' : on ? 'bg-accent-500' : 'bg-slate-200'
      }`}
    >
      <span
        className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition ${on ? 'translate-x-3.5' : 'translate-x-0.5'}`}
      />
    </span>
  )
}

/** Floating layer-control panel (top-left over the map canvas). Every
 *  requested layer is always listed - unavailable ones (no real backing
 *  geometry, see mapRules/plan honesty table) render disabled with the
 *  reason instead of being hidden. */
export default function MapLayerControl({
  layers,
  onToggle,
}: {
  layers: Record<MapLayerKey, boolean>
  onToggle: (key: MapLayerKey) => void
}) {
  return (
    <div className="w-64 rounded-xl border border-slate-200 bg-white/97 p-2 shadow-card-lg backdrop-blur-sm">
      <div className="flex items-center gap-1.5 px-1.5 py-1">
        <Layers2 className="h-3.5 w-3.5 text-accent-600" strokeWidth={2} aria-hidden />
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Layers</p>
      </div>
      <ul>
        {LAYER_ORDER.map((key) => {
          const meta = LAYER_META[key]
          const on = layers[key] && meta.available
          return (
            <li key={key}>
              <button
                type="button"
                disabled={!meta.available}
                title={meta.available ? undefined : meta.note}
                onClick={() => onToggle(key)}
                className={`focus-ring flex w-full items-center justify-between gap-2 rounded-lg px-1.5 py-1.5 text-left transition ${
                  meta.available ? 'hover:bg-slate-50' : 'cursor-not-allowed opacity-50'
                }`}
              >
                <span className="min-w-0">
                  <span className={`block text-xs font-medium ${meta.available ? 'text-slate-700' : 'text-slate-400'}`}>
                    {meta.label}
                  </span>
                  <span className="block truncate text-[10px] text-slate-400">{meta.note}</span>
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
