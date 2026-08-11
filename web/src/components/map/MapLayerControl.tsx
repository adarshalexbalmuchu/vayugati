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
  | 'transitActivity'
  | 'aqiExtrusion'
  | 'windFlow'

export const LAYER_ORDER: MapLayerKey[] = [
  'wardBoundaries',
  'aqiExtrusion',
  'windFlow',
  'wardMarkers',
  'stations',
  'sensorFreshness',
  'incidents',
  'predictedHotspots',
  'dispatchZones',
  'sourceAttribution',
  'citizenReports',
  'transitActivity',
]

/** Groups define the UI structure. Order within each group matches LAYER_ORDER. */
const LAYER_GROUPS: { label: string; keys: MapLayerKey[] }[] = [
  {
    label: 'Air quality',
    keys: ['wardBoundaries', 'aqiExtrusion', 'windFlow', 'wardMarkers', 'stations', 'sensorFreshness'],
  },
  {
    label: 'Operations',
    keys: ['incidents', 'predictedHotspots', 'dispatchZones'],
  },
  {
    label: 'Source context',
    keys: ['sourceAttribution', 'citizenReports', 'transitActivity'],
  },
]

export const LAYER_META: Record<MapLayerKey, { label: string; available: boolean; note: string }> = {
  // `available` here is the no-data default. MapPage.tsx overrides it once
  // it knows the real backing data exists (real Supabase rows decide this,
  // never a hardcoded flip) - see the wardBoundaries/dispatchZones/
  // citizenReports handling in the component below.
  wardBoundaries: {
    label: 'Ward boundaries',
    available: false,
    note: 'No boundary geometry has been captured for these wards yet.',
  },
  wardMarkers: {
    label: 'Hotspot AQI markers',
    available: true,
    note: 'Ward-linked AQI - the reading assigned to each of the 13 monitored hotspot wards via its own station, not an independent ward-level calculation. Off by default since it duplicates AQ station readings for the same 13 wards - see the legend for the full explanation.',
  },
  stations: {
    label: 'AQ station readings',
    available: true,
    note: 'Actual monitoring station locations - the 34 real CAAQMS/DPCC/IMD stations.',
  },
  sensorFreshness: {
    label: 'Sensor freshness',
    available: true,
    note: 'Highlights stations with no recent reading.',
  },
  incidents: { label: 'Active incidents', available: true, note: 'Open incidents with a known location.' },
  predictedHotspots: {
    label: 'Forecast alerts',
    available: true,
    note: 'Wards forecast to cross severe within the alert window - a ward-level forecast signal, distinct from Incidents\' own "Predicted" queue (auto-detected anomaly incidents).',
  },
  sourceAttribution: {
    label: 'Suspected source signals',
    available: true,
    note: 'Colour-codes markers by leading suspected source - a preliminary point signal, not a mapped zone or confirmed finding.',
  },
  dispatchZones: {
    label: 'Dispatch/task zones',
    available: false,
    note: 'No incident currently has an active dispatch to flag.',
  },
  citizenReports: {
    label: 'Citizen reports',
    available: false,
    note: 'No open citizen reports with a location right now.',
  },
  transitActivity: {
    label: 'Public transport activity',
    available: false,
    note: 'Delhi Open Transit Data is unavailable right now.',
  },
  aqiExtrusion: {
    label: '3D Pollution mountains',
    available: false,
    note: 'Ward polygons extruded by AQI — height shows pollution level. Requires ward boundaries.',
  },
  windFlow: {
    label: 'Wind flow arrows',
    available: false,
    note: 'Live wind direction and speed at each ward centroid from Open-Meteo.',
  },
}

export const DEFAULT_LAYER_STATE: Record<MapLayerKey, boolean> = {
  wardBoundaries: true,
  // Off by default: for the 13 hotspot wards, this duplicates AQ station
  // readings (the ward's AQI is literally its own station's latest
  // reading, not an independent calculation) - AQ station readings stays
  // on as the single source of truth by default.
  wardMarkers: false,
  stations: true,
  incidents: true,
  predictedHotspots: false,
  sourceAttribution: false,
  dispatchZones: false,
  citizenReports: false,
  sensorFreshness: false,
  transitActivity: false,
  aqiExtrusion: false,
  windFlow: false,
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
 *  data right now) render disabled with the reason instead of being hidden
 *  outright, so a commander can tell "this exists but has nothing to show"
 *  apart from "this was never built". Compact by default: one line per
 *  layer, descriptions live in the title tooltip rather than always-visible
 *  subtext, and the panel is a solid card (no glass/blur) so it reads as a
 *  control surface, not a decoration. */
export default function MapLayerControl({
  layers,
  onToggle,
  wardBoundariesAvailable = false,
  wardBoundariesLoading = false,
  dispatchZonesAvailable = false,
  citizenReportsAvailable = false,
  transitActivityAvailable = false,
  aqiExtrusionAvailable = false,
  windFlowAvailable = false,
  forecastSuppressed = false,
}: {
  layers: Record<MapLayerKey, boolean>
  onToggle: (key: MapLayerKey) => void
  wardBoundariesAvailable?: boolean
  wardBoundariesLoading?: boolean
  dispatchZonesAvailable?: boolean
  citizenReportsAvailable?: boolean
  transitActivityAvailable?: boolean
  /** True once ward boundaries are loaded — same requirement as the boundary layer. */
  aqiExtrusionAvailable?: boolean
  /** True once wind readings are present for at least one ward. */
  windFlowAvailable?: boolean
  forecastSuppressed?: boolean
}) {
  // Compute effective meta for each key (same logic as before, now used in
  // grouped rendering below).
  function effectiveMeta(key: MapLayerKey): { label: string; available: boolean; note: string } {
    let meta = LAYER_META[key]
    if (key === 'wardBoundaries') {
      meta = wardBoundariesLoading
        ? { ...meta, available: false, note: 'Ward boundaries are loading…' }
        : wardBoundariesAvailable
          ? { ...meta, available: true, note: 'Real MCD ward boundaries (Phase 2 import).' }
          : meta
    } else if (key === 'dispatchZones' && dispatchZonesAvailable) {
      meta = { ...meta, available: true, note: "Flags an incident's marker when it has an active dispatch." }
    } else if (key === 'citizenReports' && citizenReportsAvailable) {
      meta = { ...meta, available: true, note: 'Open citizen reports with a known location.' }
    } else if (key === 'transitActivity' && transitActivityAvailable) {
      meta = {
        ...meta,
        available: true,
        note: 'Public transport activity via Delhi Open Transit Data. Context layer only — not proof of emissions or congestion.',
      }
    } else if (key === 'aqiExtrusion' && aqiExtrusionAvailable) {
      meta = { ...meta, available: true }
    } else if (key === 'windFlow' && windFlowAvailable) {
      meta = { ...meta, available: true }
    } else if (key === 'predictedHotspots' && forecastSuppressed) {
      meta = { ...meta, available: false, note: 'Unavailable — latest forecast run failed.' }
    }
    return meta
  }

  const activeCount = LAYER_ORDER.filter((key) => {
    const meta = effectiveMeta(key)
    return meta.available && layers[key]
  }).length

  return (
    <div className="w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-card">
      <div className="flex items-center gap-1.5 px-1.5 py-1">
        <Layers2 className="h-3 w-3 text-accent-600" strokeWidth={2} aria-hidden />
        <p className="flex-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Layers</p>
        {activeCount > 0 && (
          <span className="rounded-full bg-accent-100 px-1.5 py-0.5 text-[9px] font-semibold text-accent-700">
            {activeCount} active
          </span>
        )}
      </div>

      {LAYER_GROUPS.map((group) => (
        <div key={group.label}>
          <p className="mt-1 px-1.5 pb-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
            {group.label}
          </p>
          <ul>
            {group.keys.map((key) => {
              const meta = effectiveMeta(key)
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
      ))}
    </div>
  )
}
