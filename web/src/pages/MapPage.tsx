import { useCallback, useMemo, useState } from 'react'
import AppShell from '../components/AppShell'
import MapView from '../components/MapView'
import { ErrorState, Skeleton } from '../components/ui'
import BasemapSwitcher from '../components/map/BasemapSwitcher'
import MapLayerControl, { DEFAULT_LAYER_STATE, type MapLayerKey } from '../components/map/MapLayerControl'
import MapLegend from '../components/map/MapLegend'
import MapPageHeader from '../components/map/MapPageHeader'
import MapToolbar from '../components/map/MapToolbar'
import SelectedIncidentPanel from '../components/map/SelectedIncidentPanel'
import SelectedStationPanel, { type SelectedStation } from '../components/map/SelectedStationPanel'
import SelectedWardPanel from '../components/map/SelectedWardPanel'
import SpatialSummaryPanel from '../components/map/SpatialSummaryPanel'
import { DEFAULT_BASEMAP_MODE, resolveStyleUrl, type BasemapMode } from '../lib/basemaps'
import {
  fetchAllForecasts,
  fetchAllOpenReports,
  fetchAllStationsWithReadings,
  fetchAllWardsAqi,
  fetchAttribution,
  type Report,
  type StationMarker,
  type WardForecastSummary,
  type WardSummary,
} from '../lib/data'
import type { Severity, SourceCategory } from '../lib/incidentRules'
import {
  listActiveTaskDispatches,
  listIncidents,
  listLeadingSourceCategories,
  type ActiveTaskDispatchesPage,
  type Incident,
} from '../lib/incidents'
import { HOTSPOT_STATUS_HEX, SOURCE_CATEGORY_HEX, type MapMarker } from '../lib/mapMarkers'
import { resolveWardReading, type MapPollutant, type MapTimeMode } from '../lib/mapRules'
import { rollupStationHealth, severeWardsWithin, tallySourceMix } from '../lib/overviewRules'
import { fetchStationHealth, type StationHealthRow } from '../lib/ops'
import { useAsync } from '../lib/useAsync'

type Selection = { kind: 'ward'; id: number } | { kind: 'station'; id: number } | { kind: 'incident'; id: number } | null

// Stable module-level fallback for state.data's pre-load shape. An inline
// `?? [[], [], ...]` literal would allocate a NEW array/tuple every render
// while loading, which - fed into a nested useAsync's own dependency array -
// causes that effect to re-fire every render (a real render-storm bug this
// caught, not just a style nit).
const EMPTY_DATA: [
  WardSummary[],
  StationMarker[],
  Map<number, WardForecastSummary>,
  Incident[],
  Report[],
  StationHealthRow[],
  ActiveTaskDispatchesPage,
] = [[], [], new Map(), [], [], [], { rows: [], totalCount: 0, hasMore: false }]

function popup(title: string, lines: string[]): string {
  return (
    `<div style="font-size:13px;font-weight:600">${title}</div>` +
    lines.map((l) => `<div style="font-size:12px;color:#555">${l}</div>`).join('')
  )
}

/**
 * Spatial operations console (Phase 15 redesign). Thin-ish composition shell
 * like Overview/Incidents: one bundled fetch, all layer/marker derivation
 * inline (this page's own glue, not reusable business logic), all real
 * counts/rules reused from overviewRules.ts rather than recomputed.
 */
export default function MapPage() {
  const [basemap, setBasemap] = useState<BasemapMode>(DEFAULT_BASEMAP_MODE)
  const [layers, setLayers] = useState(DEFAULT_LAYER_STATE)
  const [pollutant, setPollutant] = useState<MapPollutant>('aqi')
  const [timeMode, setTimeMode] = useState<MapTimeMode>('now')
  const [sourceFilter, setSourceFilter] = useState<SourceCategory | null>(null)
  const [severityFilter, setSeverityFilter] = useState<Severity | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [resetToken, setResetToken] = useState(0)

  const state = useAsync(
    () =>
      Promise.all([
        fetchAllWardsAqi(),
        fetchAllStationsWithReadings(),
        fetchAllForecasts(),
        listIncidents({ excludeClosed: true }),
        fetchAllOpenReports(),
        fetchStationHealth(),
        listActiveTaskDispatches({ offset: 0, pageSize: 200 }),
      ]),
    [],
  )

  const [wards, stations, forecasts, incidents, reports, stationHealth, dispatchPage] = state.data ?? EMPTY_DATA

  const leadingSource = useAsync(() => listLeadingSourceCategories(incidents.map((i) => i.id)), [incidents])
  const leadingSourceById = leadingSource.data ?? new Map()

  const selectedWardId = selection?.kind === 'ward' ? selection.id : null
  const attributionState = useAsync(
    () => (selectedWardId == null ? Promise.resolve(null) : fetchAttribution(selectedWardId)),
    [selectedWardId],
    { enabled: selectedWardId != null },
  )

  const dispatchIncidentIds = useMemo(
    () => new Set(dispatchPage.rows.map((d) => d.incident_id).filter((id): id is number => id != null)),
    [dispatchPage.rows],
  )
  const stationHealthById = useMemo(() => new Map(stationHealth.map((s) => [s.id, s])), [stationHealth])
  const severeWards = useMemo(() => severeWardsWithin(wards, forecasts, 36), [wards, forecasts])
  const severeWardIds = useMemo(() => new Set(severeWards.map((s) => s.wardId)), [severeWards])
  const sourceMix = useMemo(() => tallySourceMix(wards), [wards])
  const healthRollup = useMemo(() => rollupStationHealth(stationHealth), [stationHealth])

  // ── marker construction ──────────────────────────────────────────────────
  const wardMarkers: MapMarker[] = useMemo(
    () =>
      wards
        .filter((w) => w.lat != null && w.lng != null)
        .map((w) => {
          const forecast = forecasts.get(w.id)
          const reading = resolveWardReading(w, pollutant, timeMode, forecast)
          const colorOverride =
            layers.sourceAttribution && w.dominant_source
              ? (SOURCE_CATEGORY_HEX[w.dominant_source as SourceCategory] ?? null)
              : timeMode !== 'now'
                ? HOTSPOT_STATUS_HEX[reading.status ?? 'no_data']
                : null
          return {
            id: `ward-${w.id}`,
            kind: 'ward' as const,
            lat: w.lat as number,
            lng: w.lng as number,
            label: w.name,
            aqi: w.aqi,
            badgeText: reading.value != null ? String(Math.round(reading.value)) : '-',
            pulsing: layers.predictedHotspots && severeWardIds.has(w.id),
            colorOverride,
            popupHtml: popup(w.name, [`${reading.value ?? '-'} ${reading.unit}`]),
          }
        }),
    [wards, forecasts, pollutant, timeMode, layers.sourceAttribution, layers.predictedHotspots, severeWardIds],
  )

  const stationMarkers: MapMarker[] = useMemo(
    () =>
      layers.stations
        ? stations.map((s) => {
            const health = stationHealthById.get(s.id)
            const isStale = layers.sensorFreshness && !!health?.is_stale
            return {
              id: `station-${s.id}`,
              kind: 'station' as const,
              lat: s.lat,
              lng: s.lng,
              label: s.name,
              aqi: s.aqi,
              isStale,
              popupHtml: popup(s.name, [`AQI ${s.aqi ?? '-'}`, health?.ward_name ? health.ward_name : '']),
            }
          })
        : [],
    [layers.stations, layers.sensorFreshness, stations, stationHealthById],
  )

  const incidentMarkers: MapMarker[] = useMemo(() => {
    if (!layers.incidents) return []
    const filteredIncidents = incidents.filter((i) => {
      if (severityFilter && i.severity !== severityFilter) return false
      if (sourceFilter && leadingSourceById.get(i.id) !== sourceFilter) return false
      return true
    })
    return filteredIncidents
      .filter((i) => i.lat != null && i.lng != null)
      .map((i) => {
        const leading = leadingSourceById.get(i.id) as SourceCategory | undefined
        const colorOverride = layers.sourceAttribution && leading ? (SOURCE_CATEGORY_HEX[leading] ?? null) : null
        return {
          id: `incident-${i.id}`,
          kind: 'incident' as const,
          lat: i.lat as number,
          lng: i.lng as number,
          label: i.summary ?? `Incident #${i.id}`,
          severity: (i.severity ?? null) as Severity | null,
          hasDispatch: layers.dispatchZones && dispatchIncidentIds.has(i.id),
          colorOverride,
          popupHtml: popup(i.summary ?? `Incident #${i.id}`, [i.ward_name ?? '', i.status.replace(/_/g, ' ')]),
        }
      })
  }, [layers.incidents, layers.sourceAttribution, layers.dispatchZones, incidents, severityFilter, sourceFilter, leadingSourceById, dispatchIncidentIds])

  const reportMarkers: MapMarker[] = useMemo(
    () =>
      layers.citizenReports
        ? reports
            .filter((r) => r.lat != null && r.lng != null)
            .map((r) => ({
              id: `report-${r.id}`,
              kind: 'report' as const,
              lat: r.lat as number,
              lng: r.lng as number,
              label: r.description ?? 'Citizen report',
              popupHtml: popup('Citizen report', [
                r.description ?? '(no description)',
                new Date(r.created_at).toLocaleDateString(),
              ]),
            }))
        : [],
    [layers.citizenReports, reports],
  )

  const allMarkers = useMemo(
    () => [...wardMarkers, ...stationMarkers, ...incidentMarkers, ...reportMarkers],
    [wardMarkers, stationMarkers, incidentMarkers, reportMarkers],
  )

  const cityBoundsCoords = useMemo<[number, number][]>(() => {
    const coords: [number, number][] = []
    for (const w of wards) if (w.lat != null && w.lng != null) coords.push([w.lng as number, w.lat as number])
    for (const s of stations) coords.push([s.lng, s.lat])
    return coords
  }, [wards, stations])
  const fitBoundsTo = useMemo(
    () => (resetToken > 0 ? [...cityBoundsCoords] : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resetToken],
  )

  const handleMarkerClick = useCallback((marker: MapMarker) => {
    const [kind, rawId] = marker.id.split('-')
    const id = Number(rawId)
    if (kind === 'ward') setSelection({ kind: 'ward', id })
    else if (kind === 'station') setSelection({ kind: 'station', id })
    else if (kind === 'incident') setSelection({ kind: 'incident', id })
  }, [])

  const selectedWard = selection?.kind === 'ward' ? wards.find((w) => w.id === selection.id) : undefined
  const selectedIncident: Incident | undefined =
    selection?.kind === 'incident' ? incidents.find((i) => i.id === selection.id) : undefined
  const selectedStation: SelectedStation | undefined =
    selection?.kind === 'station'
      ? (() => {
          const s = stations.find((st) => st.id === selection.id)
          const health = stationHealthById.get(selection.id)
          if (!s) return undefined
          return {
            id: s.id,
            name: s.name,
            wardName: health?.ward_name ?? null,
            sensorType: health?.sensor_type ?? 'unknown',
            aqi: s.aqi,
            pm25: s.pm25,
            pm10: s.pm10,
            no2: s.no2,
            ageMinutes: health?.latest_reading_age_minutes ?? null,
            isStale: health?.is_stale ?? false,
            isActive: health?.is_active ?? true,
          }
        })()
      : undefined

  return (
    <AppShell subtitle="Map">
      <div className="flex min-h-0 flex-1 flex-col">
        <MapPageHeader stale={state.stale} fetchedAt={state.fetchedAt} refreshing={state.refreshing} onRefresh={state.refresh} />

        {state.loading ? (
          <div className="flex-1 p-4">
            <Skeleton className="h-full w-full" />
          </div>
        ) : state.error ? (
          <div className="flex-1 p-4">
            <ErrorState message={state.error} onRetry={state.refresh} />
          </div>
        ) : (
          <>
            <MapToolbar
              pollutant={pollutant}
              onPollutantChange={setPollutant}
              timeMode={timeMode}
              onTimeModeChange={setTimeMode}
              sourceFilter={sourceFilter}
              onSourceFilterChange={setSourceFilter}
              severityFilter={severityFilter}
              onSeverityFilterChange={setSeverityFilter}
              onResetView={() => setResetToken((t) => t + 1)}
              onRefresh={state.refresh}
              refreshing={state.refreshing}
            />
            <div className="flex min-h-0 flex-1">
              <div className="relative min-h-0 flex-1">
                <MapView
                  markers={allMarkers}
                  styleUrl={resolveStyleUrl(basemap)}
                  showScaleBar
                  onMarkerClick={handleMarkerClick}
                  fitBoundsTo={fitBoundsTo}
                />
                <div className="absolute bottom-14 left-3 top-3 z-10 flex flex-col gap-2 overflow-y-auto">
                  <MapLayerControl layers={layers} onToggle={(key: MapLayerKey) => setLayers((l) => ({ ...l, [key]: !l[key] }))} />
                  <MapLegend sourceAttributionOn={layers.sourceAttribution} />
                </div>
                <BasemapSwitcher mode={basemap} onChange={setBasemap} />
              </div>

              <div className="w-80 flex-shrink-0 overflow-y-auto border-l border-slate-200 bg-white">
                {selection == null ? (
                  <SpatialSummaryPanel
                    wardsShown={wardMarkers.length}
                    stationsActive={healthRollup.active}
                    activeIncidents={incidents.length}
                    predictedHotspots={severeWards.length}
                    dominantSource={sourceMix[0] ?? null}
                    staleSensors={healthRollup.stale}
                  />
                ) : selectedWard ? (
                  <SelectedWardPanel
                    ward={selectedWard}
                    forecast={forecasts.get(selectedWard.id)}
                    pollutant={pollutant}
                    linkedIncidents={incidents.filter((i) => i.ward_id === selectedWard.id)}
                    linkedDispatches={dispatchPage.rows.filter((d) => d.ward_name === selectedWard.name)}
                    attribution={attributionState.data}
                    attributionLoading={attributionState.loading}
                    onClose={() => setSelection(null)}
                  />
                ) : selectedStation ? (
                  <SelectedStationPanel station={selectedStation} pollutant={pollutant} onClose={() => setSelection(null)} />
                ) : selectedIncident ? (
                  <SelectedIncidentPanel incident={selectedIncident} onClose={() => setSelection(null)} />
                ) : (
                  <SpatialSummaryPanel
                    wardsShown={wardMarkers.length}
                    stationsActive={healthRollup.active}
                    activeIncidents={incidents.length}
                    predictedHotspots={severeWards.length}
                    dominantSource={sourceMix[0] ?? null}
                    staleSensors={healthRollup.stale}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}
