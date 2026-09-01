import { useState } from 'react'
import { ChevronRight, Loader2, Sparkles, X } from 'lucide-react'
import { askGeoAi, type GeoAiAction, type GeoAiEntityRef, type GeoAiResponse } from '../../lib/data'
import type { Incident } from '../../lib/incidents'
import type { StationMarker, WardSummary } from '../../lib/data'
import { type MapPollutant, type MapTimeMode, type ObsSlot } from '../../lib/mapRules'
import { type Severity, type SourceCategory } from '../../lib/incidentRules'
import { findWithinRadius, matchesThreshold, type RadiusMatch } from '../../lib/spatialQuery'
import { Stat } from '../ui'
import type { MapViewMode } from './MapToolbar'

const EXAMPLE_QUESTIONS = [
  'Wards near Anand Vihar with AQI over 200',
  'Show severe open burning incidents',
  'Switch to PM2.5, last 24 hours',
]

function pollutantValue(entity: { aqi: number | null; pm25: number | null; pm10: number | null; no2: number | null }, pollutant: MapPollutant): number | null {
  return entity[pollutant]
}

/**
 * GeoAI results for a single question - deliberately styled as a query
 * console (input + Run + result block), not a chat thread: each new
 * question replaces the previous result rather than appending to a
 * transcript. Every action the model returns is executed against the exact
 * same deterministic code the manual tools use (spatialQuery.ts) - this
 * panel never trusts the model's own idea of "what's nearby".
 */
export default function GeoAiPanel({
  wards,
  stations,
  incidents,
  wardBoundaryByWardId,
  onFocus,
  onSetPollutant,
  onSetTimeMode,
  onSetObsSlot,
  onSetSourceFilter,
  onSetSeverityFilter,
  onSetViewMode,
  onSelectWard,
  onSelectStation,
  onSelectIncident,
  onClose,
}: {
  wards: WardSummary[]
  stations: StationMarker[]
  incidents: Incident[]
  wardBoundaryByWardId: Map<number, GeoJSON.Polygon | GeoJSON.MultiPolygon>
  onFocus: (kind: 'ward' | 'station', id: number, coords: [number, number]) => void
  onSetPollutant: (p: MapPollutant) => void
  onSetTimeMode: (t: MapTimeMode) => void
  onSetObsSlot: (s: ObsSlot) => void
  onSetSourceFilter: (s: SourceCategory | null) => void
  onSetSeverityFilter: (s: Severity | null) => void
  onSetViewMode: (m: MapViewMode) => void
  onSelectWard: (id: number) => void
  onSelectStation: (id: number) => void
  onSelectIncident: (id: number) => void
  onClose: () => void
}) {
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<GeoAiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [queryResults, setQueryResults] = useState<{ wards: RadiusMatch[]; stations: RadiusMatch[]; incidents: RadiusMatch[] } | null>(null)
  const [mapUpdated, setMapUpdated] = useState(false)

  const resolveEntity = (ref: GeoAiEntityRef | null): { coords: [number, number]; name: string } | null => {
    if (!ref) return null
    const numericId = Number(ref.id)
    if (ref.type === 'ward') {
      const w = wards.find((w) => w.id === numericId)
      if (!w || w.lat == null || w.lng == null) return null
      return { coords: [w.lng, w.lat], name: w.name }
    }
    const s = stations.find((s) => s.id === numericId)
    if (!s) return null
    return { coords: [s.lng, s.lat], name: s.name }
  }

  const executeActions = (actions: GeoAiAction[]) => {
    let updated = false
    let results: { wards: RadiusMatch[]; stations: RadiusMatch[]; incidents: RadiusMatch[] } | null = null

    for (const action of actions) {
      if (action.type === 'set_time') {
        if (action.time_mode) { onSetTimeMode(action.time_mode); updated = true }
        if (action.obs_slot) { onSetObsSlot(action.obs_slot); updated = true }
      } else if (action.type === 'set_filters') {
        if (action.pollutant) { onSetPollutant(action.pollutant); updated = true }
        if (action.severity_filter) { onSetSeverityFilter(action.severity_filter); updated = true }
        if (action.view_mode) { onSetViewMode(action.view_mode); updated = true }
        if (action.source_filter) { onSetSourceFilter(action.source_filter as SourceCategory); updated = true }
      } else if (action.type === 'focus') {
        const resolved = resolveEntity(action.target_ref)
        if (resolved && action.target_ref) {
          onFocus(action.target_ref.type, Number(action.target_ref.id), resolved.coords)
          updated = true
        }
      } else if (action.type === 'query') {
        const center = resolveEntity(action.near_ref)
        const radiusKm = action.radius_km ?? 3
        const base = center
          ? findWithinRadius(center.coords, radiusKm, { wards, stations, incidents, wardBoundaryByWardId })
          : {
              wards: wards.map((w) => ({ id: w.id, label: w.name })),
              stations: stations.map((s) => ({ id: s.id, label: s.name })),
              incidents: incidents.map((i) => ({ id: i.id, label: i.summary ?? `Incident #${i.id}` })),
            }

        if (action.target === 'incidents') {
          const filteredIds = new Set(
            incidents
              .filter((i) => action.severity == null || i.severity === action.severity)
              .map((i) => i.id),
          )
          results = { wards: [], stations: [], incidents: base.incidents.filter((m) => filteredIds.has(m.id)) }
        } else {
          const wardIds = action.pollutant && action.op && action.threshold != null
            ? new Set(wards.filter((w) => matchesThreshold(pollutantValue(w, action.pollutant!), action.op!, action.threshold!)).map((w) => w.id))
            : null
          const stationIds = action.pollutant && action.op && action.threshold != null
            ? new Set(stations.filter((s) => matchesThreshold(pollutantValue(s, action.pollutant!), action.op!, action.threshold!)).map((s) => s.id))
            : null
          results = {
            wards: action.target === 'wards' ? base.wards.filter((m) => wardIds == null || wardIds.has(m.id)) : [],
            stations: action.target === 'stations' ? base.stations.filter((m) => stationIds == null || stationIds.has(m.id)) : [],
            incidents: [],
          }
        }
        updated = true
      }
    }

    setQueryResults(results)
    setMapUpdated(updated)
  }

  const handleSubmit = async () => {
    const trimmed = question.trim()
    if (!trimmed || loading) return
    setLoading(true)
    setError(null)
    setResponse(null)
    setQueryResults(null)
    setMapUpdated(false)

    const entities = [
      ...wards.map((w) => ({ type: 'ward' as const, id: String(w.id), name: w.name })),
      ...stations.map((s) => ({ type: 'station' as const, id: String(s.id), name: s.name })),
    ]

    const result = await askGeoAi(trimmed, entities)
    setLoading(false)
    if (!result) {
      setError("Couldn't reach GeoAI — try again in a moment.")
      return
    }
    setResponse(result)
    executeActions(result.actions)
  }

  const unsupported = response?.actions.find((a) => a.type === 'unsupported')
  const queryAction = response?.actions.find((a) => a.type === 'query')

  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-4 w-4 text-accent-600" strokeWidth={2} aria-hidden />
          <h2 className="text-sm font-semibold text-slate-800">Ask Vayu Gati</h2>
        </div>
        <button type="button" onClick={onClose} className="focus-ring rounded p-1 text-slate-400 hover:bg-slate-100">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="Wards near Anand Vihar with AQI over 200"
          className="focus-ring flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={loading || !question.trim()}
          className="focus-ring flex-shrink-0 rounded-lg bg-accent-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : 'Run'}
        </button>
      </div>

      {!response && !loading && !error && (
        <div className="mt-3 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Try asking</p>
          {EXAMPLE_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => setQuestion(q)}
              className="focus-ring block w-full rounded-lg border border-slate-100 px-2.5 py-1.5 text-left text-xs text-slate-500 hover:bg-slate-50"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}

      {response && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-slate-600">{response.explanation}</p>

          {unsupported && (
            <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-xs text-amber-800">{unsupported.reason}</p>
          )}

          {queryAction && queryResults && (
            <>
              <div className="grid grid-cols-3 gap-2">
                <Stat value={queryResults.wards.length} label="Wards" />
                <Stat value={queryResults.stations.length} label="Stations" />
                <Stat value={queryResults.incidents.length} label="Incidents" />
              </div>
              {([
                { title: 'Wards', matches: queryResults.wards, onSelect: onSelectWard },
                { title: 'Stations', matches: queryResults.stations, onSelect: onSelectStation },
                { title: 'Incidents', matches: queryResults.incidents, onSelect: onSelectIncident },
              ] as const).map(({ title, matches, onSelect }) =>
                matches.length > 0 ? (
                  <div key={title}>
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

          {mapUpdated && <p className="text-[10px] font-semibold text-status-success">Map updated</p>}
        </div>
      )}
    </div>
  )
}
