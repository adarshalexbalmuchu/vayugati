import { useCallback, useEffect, useMemo, useState } from 'react'
import { aqiLevel } from '../components/AqiBadge'
import AppShell from '../components/AppShell'
import MapView, { type WardBoundaryFeatureProps } from '../components/MapView'
import { ErrorState, Skeleton } from '../components/ui'
import BasemapSwitcher from '../components/map/BasemapSwitcher'
import MapLayerControl, { DEFAULT_LAYER_STATE, type MapLayerKey } from '../components/map/MapLayerControl'
import MapLegend from '../components/map/MapLegend'
import MapPageHeader from '../components/map/MapPageHeader'
import MapToolbar, { type MapViewMode } from '../components/map/MapToolbar'
import DataQualityStationPanel, { type DataQualityStationInfo } from '../components/map/DataQualityStationPanel'
import DataQualitySummaryPanel from '../components/map/DataQualitySummaryPanel'
import DataQualityWardPanel from '../components/map/DataQualityWardPanel'
import SelectedIncidentPanel from '../components/map/SelectedIncidentPanel'
import SelectedStationPanel, { type SelectedStation } from '../components/map/SelectedStationPanel'
import SelectedWardBoundaryPanel, { type WardBoundaryDetail, type WardBoundaryStationRef } from '../components/map/SelectedWardBoundaryPanel'
import SelectedWardPanel from '../components/map/SelectedWardPanel'
import SpatialSummaryPanel from '../components/map/SpatialSummaryPanel'
import { DEFAULT_BASEMAP_MODE, resolveStyleUrl, type BasemapMode } from '../lib/basemaps'
import {
  fetchAllForecasts,
  fetchAllOpenReports,
  fetchAllStationsWithReadings,
  fetchAllWardBoundaries,
  fetchAllWardsAqi,
  fetchAttribution,
  fetchLatestReadingsPreferred,
  fetchTransportActivity,
  type Report,
  type StationMarker,
  type WardBoundary,
  type WardForecastSummary,
  type WardSummary,
} from '../lib/data'
import type { Severity, SourceCategory } from '../lib/incidentRules'
import { useIngestHealth } from '../contexts/IngestHealthContext'
import {
  fetchLatestForecastRun,
  listActiveTaskDispatches,
  listIncidents,
  listLeadingSourceCategories,
  type ActiveTaskDispatchesPage,
  type Incident,
} from '../lib/incidents'
import { HOTSPOT_STATUS_HEX, SOURCE_CATEGORY_HEX, TRANSIT_ACTIVITY_HEX, type MapMarker } from '../lib/mapMarkers'
import {
  auditIncidentCoordinates,
  classifyWardCoverage,
  FRESHNESS_HEX,
  rollupStationQuality,
  stationFreshnessClass,
  type FreshnessClass,
  type WardCoverageClass,
  type WardCoverageDetail,
} from '../lib/dataQualityRules'
import {
  DELHI_BOUNDS,
  DELHI_CENTER,
  DELHI_DEFAULT_ZOOM,
  forecastPollutantFor,
  isValidDelhiCoordinate,
  MAP_POLLUTANT_LABEL,
  nearestForecastPoint,
  nearestStationTo,
  resolveWardReading,
  stationReadingValue,
  wardDataStatus,
  type MapPollutant,
  type MapTimeMode,
} from '../lib/mapRules'
import { rollupStationHealth, severeWardsWithin, tallySourceMix } from '../lib/overviewRules'
import { fetchStationHealth, type StationHealthRow } from '../lib/ops'
import { useAsync } from '../lib/useAsync'

type Selection =
  | { kind: 'ward'; id: number }
  | { kind: 'station'; id: number }
  | { kind: 'incident'; id: number }
  | { kind: 'wardBoundary'; id: number }
  | null

// Stable module-level fallback for state.data's pre-load shape. An inline
// `?? [[], [], ...]` literal would allocate a NEW array/tuple every render
// while loading, which - fed into a nested useAsync's own dependency array -
// causes that effect to re-fire every render (a real render-storm bug this
// caught, not just a style nit).
const EMPTY_DATA: [WardSummary[], StationMarker[], Incident[], Report[], StationHealthRow[], ActiveTaskDispatchesPage] = [
  [],
  [],
  [],
  [],
  [],
  { rows: [], totalCount: 0, hasMore: false },
]

const EMPTY_BOUNDARIES: WardBoundary[] = []
const EMPTY_FORECASTS: Map<number, WardForecastSummary> = new Map()

function fmtAge(minutes: number): string {
  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${Math.round(minutes)}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

function wardPopup(name: string, value: number | null | undefined, unit: string, aqi: number | null | undefined, ts: string | null): string {
  const level = aqi != null ? aqiLevel(aqi) : null
  const age = ts ? fmtAge((Date.now() - new Date(ts).getTime()) / 60_000) : null
  const valStr = value != null ? `${Math.round(value)} ${unit}` : '—'
  return (
    `<div style="font-size:13px;font-weight:600">${name}</div>` +
    (level
      ? `<div style="font-size:12px;color:${level.hex}">${valStr} · ${level.label}</div>`
      : `<div style="font-size:12px;color:#9ca3af">${valStr}</div>`) +
    (age ? `<div style="font-size:11px;color:#9ca3af">${age}</div>` : '')
  )
}

function stationPopup(name: string, displayAqi: number | null | undefined, usingCpcb: boolean, ageMinutes: number | null | undefined): string {
  const level = displayAqi != null ? aqiLevel(displayAqi) : null
  const source = usingCpcb ? 'CPCB · data.gov.in' : 'OpenAQ'
  const age = ageMinutes != null ? fmtAge(ageMinutes) : null
  return (
    `<div style="font-size:13px;font-weight:600">${name}</div>` +
    (level
      ? `<div style="font-size:12px;color:${level.hex}">AQI ${displayAqi} · ${level.label}</div>`
      : `<div style="font-size:12px;color:#9ca3af">No reading</div>`) +
    `<div style="font-size:11px;color:#9ca3af">${source}${age ? ` · ${age}` : ''}</div>`
  )
}

function incidentPopup(summary: string, wardName: string | null, status: string, createdAt: string | null): string {
  const age = createdAt ? fmtAge((Date.now() - new Date(createdAt).getTime()) / 60_000) : null
  const statusLabel = status.replace(/_/g, ' ')
  return (
    `<div style="font-size:13px;font-weight:600">${summary}</div>` +
    (wardName ? `<div style="font-size:12px;color:#555">${wardName}</div>` : '') +
    `<div style="font-size:11px;color:#9ca3af">${statusLabel}${age ? ` · ${age}` : ''}</div>`
  )
}

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
  const [viewMode, setViewMode] = useState<MapViewMode>('pollution')
  const [freshnessFilter, setFreshnessFilter] = useState<FreshnessClass | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [resetToken, setResetToken] = useState(0)

  const { healthLoaded, forecastConfirmedFresh } = useIngestHealth()
  const forecastSuppressed = healthLoaded && !forecastConfirmedFresh

  // When forecast becomes unavailable, snap timeMode back to 'now' so the
  // map doesn't stay on a forecast time horizon that has no data.
  useEffect(() => {
    if (forecastSuppressed && timeMode !== 'now') setTimeMode('now')
  }, [forecastSuppressed, timeMode])

  // Escape key clears any active selection.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelection(null)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Warm the browser's cache for every basemap the user hasn't picked yet,
  // so a later manual switch is instant instead of paying its real
  // first-visit network cost (measured: 1.6-2.5s even on a fast connection
  // - see lib/basemapPrefetch.ts). Fires once, a few seconds after mount so
  // it never competes with the page's own critical data fetch or the real
  // map's first paint; cancelled on unmount if the user navigates away
  // before it fires. Deliberately excludes `basemap` from deps - this
  // should run exactly once per page visit, not re-fire every time the
  // user picks a different mode.
  useEffect(() => {
    const t = window.setTimeout(() => {
      void import('../lib/basemapPrefetch').then(({ prefetchOtherBasemaps }) =>
        prefetchOtherBasemaps(basemap, DELHI_CENTER, DELHI_DEFAULT_ZOOM),
      )
    }, 3000)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const state = useAsync(
    () =>
      Promise.all([
        fetchAllWardsAqi(),
        fetchAllStationsWithReadings(),
        listIncidents({ excludeClosed: true }),
        fetchAllOpenReports(),
        fetchStationHealth(),
        listActiveTaskDispatches({ offset: 0, pageSize: 200 }),
      ]),
    [],
  )

  const [wards, stations, incidents, reports, stationHealth, dispatchPage] = state.data ?? EMPTY_DATA

  // Real forecast.py output for whichever pollutant is actually selected -
  // AQI has no forecast of its own (the pipeline never computes the
  // composite index), so it maps to a labelled PM2.5 proxy (see
  // forecastPollutantFor). A separate fetch from the main bundle above so
  // switching pollutants doesn't re-fetch wards/stations/incidents/etc, and
  // re-runs whenever the selection changes (unlike the old hardcoded-pm25
  // one-shot fetch).
  const forecastPollutant = forecastPollutantFor(pollutant)
  const forecastsState = useAsync(() => fetchAllForecasts(forecastPollutant), [forecastPollutant])
  const forecasts = (forecastSuppressed ? new Map() : forecastsState.data) ?? EMPTY_FORECASTS

  // Ward boundary polygons are ~8MB of real OSM-derived GeoJSON across all
  // 250+ wards (measured) - loaded separately from the rest of the page's
  // data, not inside the `Promise.all` above, so the whole console no
  // longer blocks on it. The "Ward boundaries" layer defaults to OFF
  // (MapLayerControl's DEFAULT_LAYER_STATE), so most loads never need this
  // payload at all; when they do, `wardBoundariesAvailable` below already
  // correctly reflects "not loaded yet" via the same disabled-toggle affordance
  // that previously covered a hard fetch failure - no new UI state needed.
  const wardBoundariesState = useAsync(() => fetchAllWardBoundaries(), [])
  const wardBoundaries = wardBoundariesState.data ?? EMPTY_BOUNDARIES

  // Delhi OTD transport-activity context layer - independent fetch, same
  // graceful-degradation contract as Overview's own TransportActivityPanel
  // (null on any failure, an explicit unavailableReason on a reachable-but-
  // empty summary). Never blocks the rest of the map.
  const transitState = useAsync(() => fetchTransportActivity(), [])
  const transitByWard = useMemo(
    () => new Map((transitState.data?.perWard ?? []).map((w) => [w.wardId, w])),
    [transitState.data],
  )

  // CPCB/data.gov preferred-latest-reading reconciliation - same
  // independent-fetch, overlay-only contract as transitState above. A
  // failure here just leaves station markers/popups on their existing
  // OpenAQ-sourced AQI, unchanged. See docs/data/cpcb-data-gov-primary-
  // latest-integration-report.md.
  const latestReadingsState = useAsync(() => fetchLatestReadingsPreferred(), [])
  const latestReadingByStationId = useMemo(
    () => new Map((latestReadingsState.data ?? []).map((r) => [r.stationId, r])),
    [latestReadingsState.data],
  )

  const leadingSource = useAsync(() => listLeadingSourceCategories(incidents.map((i) => i.id)), [incidents])
  const leadingSourceById = leadingSource.data ?? new Map()

  const stationHealthById = useMemo(() => new Map(stationHealth.map((s) => [s.id, s])), [stationHealth])

  // ── Data Quality mode derivations ────────────────────────────────────────
  const stationQuality = useMemo(() => rollupStationQuality(stationHealth), [stationHealth])

  const wardCoverageById = useMemo<Map<number, WardCoverageDetail>>(() => {
    const map = new Map<number, WardCoverageDetail>()
    for (const b of wardBoundaries) {
      map.set(b.id, classifyWardCoverage(b, stationHealth, stations))
    }
    return map
  }, [wardBoundaries, stationHealth, stations])

  const wardCoverageSummary = useMemo<Record<WardCoverageClass, number>>(() => {
    const acc: Record<WardCoverageClass, number> = { direct: 0, nearby: 0, insufficient: 0, unavailable: 0 }
    for (const detail of wardCoverageById.values()) acc[detail.class]++
    return acc
  }, [wardCoverageById])

  const incidentAudit = useMemo(() => auditIncidentCoordinates(incidents), [incidents])

  const selectedWardId = selection?.kind === 'ward' ? selection.id : null
  const attributionState = useAsync(
    () => (selectedWardId == null ? Promise.resolve(null) : fetchAttribution(selectedWardId)),
    [selectedWardId],
    { enabled: selectedWardId != null },
  )

  // The ward whose forecast validation record is relevant right now - the
  // selected ward directly, or a selected station's linked ward (stations
  // have no forecast of their own; forecast.py runs per-ward). Broadened
  // from a ward-only fetch so SelectedStationPanel can show real forecast
  // context too, not just SelectedWardPanel.
  const selectedStationWardId =
    selection?.kind === 'station' ? (stationHealthById.get(selection.id)?.ward_id ?? null) : null
  const forecastRelevantWardId = selectedWardId ?? selectedStationWardId
  const latestForecastRunState = useAsync(
    () => (forecastRelevantWardId == null ? Promise.resolve(null) : fetchLatestForecastRun(forecastRelevantWardId, forecastPollutant)),
    [forecastRelevantWardId, forecastPollutant],
    { enabled: forecastRelevantWardId != null },
  )
  // A selected station has no forecast of its own - this is its linked
  // ward's forecast, at the same "nearest point to the selected horizon"
  // logic resolveWardReading uses for ward markers, so a station's forecast
  // number in 24h/48h mode matches what that ward's own marker would show.
  const stationForecastPoint =
    timeMode !== 'now' && forecastRelevantWardId != null
      ? nearestForecastPoint(forecasts.get(forecastRelevantWardId), timeMode === '24h' ? 24 : 48)
      : null
  const stationForecastValue = stationForecastPoint?.predicted_value ?? stationForecastPoint?.pm25_pred ?? null

  const dispatchIncidentIds = useMemo(
    () => new Set(dispatchPage.rows.map((d) => d.incident_id).filter((id): id is number => id != null)),
    [dispatchPage.rows],
  )
  const severeWards = useMemo(() => severeWardsWithin(wards, forecasts, 36), [wards, forecasts])
  const severeWardIds = useMemo(() => new Set(severeWards.map((s) => s.wardId)), [severeWards])
  const sourceMix = useMemo(() => tallySourceMix(wards), [wards])
  const healthRollup = useMemo(() => rollupStationHealth(stationHealth), [stationHealth])

  const latestStationReadingAgeMinutes = useMemo(() => {
    const ages = stationHealth
      .filter((s) => s.latest_reading_age_minutes != null)
      .map((s) => s.latest_reading_age_minutes as number)
    return ages.length > 0 ? Math.min(...ages) : null
  }, [stationHealth])

  const wardsWithCoverage = useMemo(() => wards.filter((w) => w.aqi != null).length, [wards])

  const highestAqiWard = useMemo(() => {
    const sorted = [...wards].filter((w) => w.aqi != null).sort((a, b) => (b.aqi ?? 0) - (a.aqi ?? 0))
    const top = sorted[0]
    return top ? { name: top.name, aqi: top.aqi as number } : null
  }, [wards])

  // ── marker construction ──────────────────────────────────────────────────
  const wardMarkers: MapMarker[] = useMemo(
    () =>
      layers.wardMarkers
        ? wards
            .filter((w) => isValidDelhiCoordinate(w.lat, w.lng))
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
                popupHtml: wardPopup(w.name, reading.value, reading.unit, w.aqi, w.ts ?? null),
              }
            })
        : [],
    [layers.wardMarkers, wards, forecasts, pollutant, timeMode, layers.sourceAttribution, layers.predictedHotspots, severeWardIds],
  )

  const stationMarkers: MapMarker[] = useMemo(
    () =>
      layers.stations
        ? stations
            .filter((s) => isValidDelhiCoordinate(s.lat, s.lng))
            .filter((s) => {
              // In quality mode, apply freshness filter
              if (viewMode === 'data_quality' && freshnessFilter != null) {
                const h = stationHealthById.get(s.id)
                return h ? stationFreshnessClass(h) === freshnessFilter : freshnessFilter === 'unavailable'
              }
              return true
            })
            .map((s) => {
              const health = stationHealthById.get(s.id)
              const isStale = layers.sensorFreshness && !!health?.is_stale
              const preferred = latestReadingByStationId.get(s.id)
              const usingCpcb = preferred?.sourceUsed === 'cpcb' && preferred.cpcbAqi != null
              const displayAqi = usingCpcb ? preferred!.cpcbAqi : s.aqi
              if (viewMode === 'data_quality' && health) {
                const cls = stationFreshnessClass(health)
                return {
                  id: `station-${s.id}`,
                  kind: 'station' as const,
                  lat: s.lat,
                  lng: s.lng,
                  label: s.name,
                  aqi: null,  // suppress AQI colour in quality mode
                  isStale: cls === 'stale',
                  isCpcbSourced: usingCpcb,
                  // Badge shows reading age; color shows freshness state
                  badgeText: health.latest_reading_age_minutes != null
                    ? health.latest_reading_age_minutes < 60
                      ? `${health.latest_reading_age_minutes}m`
                      : `${Math.round(health.latest_reading_age_minutes / 60)}h`
                    : '—',
                  colorOverride: FRESHNESS_HEX[cls],
                  popupHtml: stationPopup(s.name, displayAqi, usingCpcb, health.latest_reading_age_minutes),
                }
              }
              return {
                id: `station-${s.id}`,
                kind: 'station' as const,
                lat: s.lat,
                lng: s.lng,
                label: s.name,
                aqi: displayAqi,
                isStale,
                isCpcbSourced: usingCpcb,
                popupHtml: stationPopup(s.name, displayAqi, usingCpcb, health?.latest_reading_age_minutes),
              }
            })
        : [],
    [viewMode, freshnessFilter, layers.stations, layers.sensorFreshness, stations, stationHealthById, latestReadingByStationId],
  )

  const incidentMarkers: MapMarker[] = useMemo(() => {
    if (!layers.incidents) return []
    const filteredIncidents = incidents.filter((i) => {
      if (severityFilter && i.severity !== severityFilter) return false
      if (sourceFilter && leadingSourceById.get(i.id) !== sourceFilter) return false
      return true
    })
    return filteredIncidents
      .filter((i) => isValidDelhiCoordinate(i.lat, i.lng))
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
          popupHtml: incidentPopup(i.summary ?? `Incident #${i.id}`, i.ward_name, i.status, i.created_at ?? null),
        }
      })
  }, [layers.incidents, layers.sourceAttribution, layers.dispatchZones, incidents, severityFilter, sourceFilter, leadingSourceById, dispatchIncidentIds])

  const reportMarkers: MapMarker[] = useMemo(
    () =>
      layers.citizenReports
        ? reports
            .filter((r) => isValidDelhiCoordinate(r.lat, r.lng))
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

  // Ward-level only - the backend never exposes raw per-vehicle positions to
  // the browser (see docs/data/delhi-otd-transport-context-integration-
  // report.md), just the same per-ward vehicle_count/activity_level summary
  // Overview's hotspot table shows. Wards with zero nearby vehicles are
  // omitted rather than drawn as an empty marker, to keep the layer legible.
  const transitMarkers: MapMarker[] = useMemo(
    () =>
      layers.transitActivity
        ? wards
            .filter((w) => isValidDelhiCoordinate(w.lat, w.lng))
            .map((w) => ({ ward: w, activity: transitByWard.get(w.id) }))
            .filter((x): x is { ward: WardSummary; activity: NonNullable<typeof x.activity> } => !!x.activity && x.activity.vehicleCount > 0)
            .map(({ ward: w, activity }) => ({
              id: `transit-${w.id}`,
              kind: 'ward' as const,
              lat: w.lat as number,
              lng: w.lng as number,
              label: w.name,
              badgeText: String(activity.vehicleCount),
              colorOverride: TRANSIT_ACTIVITY_HEX[activity.activityLevel === 'none' ? 'low' : activity.activityLevel],
              popupHtml: popup(w.name, [
                `${activity.vehicleCount} vehicles nearby (${activity.activityLevel})`,
                'Public transport activity via Delhi Open Transit Data.',
                'Context layer only — not proof of emissions or congestion.',
              ]),
            }))
        : [],
    [layers.transitActivity, wards, transitByWard],
  )

  const allMarkers = useMemo(
    () => [...wardMarkers, ...stationMarkers, ...incidentMarkers, ...reportMarkers, ...transitMarkers],
    [wardMarkers, stationMarkers, incidentMarkers, reportMarkers, transitMarkers],
  )

  // Only ever built from validated Delhi/NCR coordinates - a single bad row
  // elsewhere in India must never be able to stretch "Reset to Delhi" out to
  // city/world scale (see mapRules.ts's isValidDelhiCoordinate).
  const cityBoundsCoords = useMemo<[number, number][]>(() => {
    const coords: [number, number][] = []
    for (const w of wards) if (isValidDelhiCoordinate(w.lat, w.lng)) coords.push([w.lng as number, w.lat as number])
    for (const s of stations) if (isValidDelhiCoordinate(s.lat, s.lng)) coords.push([s.lng, s.lat])
    return coords
  }, [wards, stations])
  // No valid points at all -> fit to the Delhi bounds box itself, a real
  // geographic constant, rather than an empty/undefined fitBounds call.
  const delhiBoundsCoords: [number, number][] = [
    [DELHI_BOUNDS.minLng, DELHI_BOUNDS.minLat],
    [DELHI_BOUNDS.maxLng, DELHI_BOUNDS.maxLat],
  ]
  const fitBoundsTo = useMemo(
    () => (resetToken > 0 ? (cityBoundsCoords.length > 0 ? [...cityBoundsCoords] : delhiBoundsCoords) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resetToken],
  )

  const locationsUnavailable = useMemo(() => {
    const invalidWards = wards.filter((w) => !isValidDelhiCoordinate(w.lat, w.lng)).length
    const invalidStations = stations.filter((s) => !isValidDelhiCoordinate(s.lat, s.lng)).length
    const invalidIncidents = incidents.filter((i) => !isValidDelhiCoordinate(i.lat, i.lng)).length
    const invalidReports = reports.filter((r) => !isValidDelhiCoordinate(r.lat, r.lng)).length
    return invalidWards + invalidStations + invalidIncidents + invalidReports
  }, [wards, stations, incidents, reports])

  const handleMarkerClick = useCallback((marker: MapMarker) => {
    const [kind, rawId] = marker.id.split('-')
    const id = Number(rawId)
    if (kind === 'ward') setSelection({ kind: 'ward', id })
    else if (kind === 'station') setSelection({ kind: 'station', id })
    else if (kind === 'incident') setSelection({ kind: 'incident', id })
  }, [])

  // Real Supabase boundary rows only (see lib/data.ts's fetchAllWardBoundaries)
  // - an empty array here means the layer control correctly shows the
  // toggle as unavailable (MapLayerControl's wardBoundariesAvailable prop),
  // never a placeholder/hardcoded shape.
  const wardBoundaryCollection = useMemo<GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, WardBoundaryFeatureProps>>(
    () => ({
      type: 'FeatureCollection',
      features: wardBoundaries.map((w) => ({
        type: 'Feature',
        properties: { id: w.id, name: w.name, wardNumber: w.wardNumber, jurisdictionType: w.jurisdictionType },
        geometry: w.geometry,
      })),
    }),
    [wardBoundaries],
  )
  const wardBoundariesAvailable = wardBoundaries.length > 0
  const handleBoundaryClick = useCallback((ward: WardBoundaryFeatureProps) => {
    setSelection({ kind: 'wardBoundary', id: ward.id })
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
          const preferred = latestReadingByStationId.get(selection.id)
          const usingCpcb = preferred?.sourceUsed === 'cpcb' && preferred.cpcbAqi != null
          return {
            id: s.id,
            name: s.name,
            wardName: health?.ward_name ?? null,
            wardId: health?.ward_id ?? null,
            sensorType: health?.sensor_type ?? 'unknown',
            aqi: usingCpcb ? preferred!.cpcbAqi : s.aqi,
            pm25: s.pm25,
            pm10: s.pm10,
            no2: s.no2,
            ageMinutes: health?.latest_reading_age_minutes ?? null,
            isStale: health?.is_stale ?? false,
            isActive: health?.is_active ?? true,
            readingSource: preferred?.sourceUsed,
          }
        })()
      : undefined

  const nearbyIncidentsCount = useMemo(() => {
    if (!selectedStation) return 0
    if (selectedStation.wardId != null) {
      return incidents.filter((i) => i.ward_id === selectedStation.wardId).length
    }
    return 0
  }, [selectedStation, incidents])

  const incidentNearestStation = useMemo(() => {
    if (!selectedIncident) return null
    const result = nearestStationTo(selectedIncident.lat ?? null, selectedIncident.lng ?? null, stations)
    if (!result) return null
    const health = stationHealthById.get(result.station.id)
    const preferred = latestReadingByStationId.get(result.station.id)
    const readingSource = preferred?.sourceUsed === 'cpcb' && preferred.cpcbAqi != null ? 'CPCB' : 'OpenAQ'
    return {
      name: result.station.name,
      distanceMeters: result.distanceMeters,
      isStale: health?.is_stale ?? false,
      ageMinutes: health?.latest_reading_age_minutes ?? null,
      readingSource,
    }
  }, [selectedIncident, stations, stationHealthById, latestReadingByStationId])

  const dataQualityStationInfo: DataQualityStationInfo | null = useMemo(() => {
    if (viewMode !== 'data_quality' || selection?.kind !== 'station') return null
    const s = stations.find((st) => st.id === selection.id)
    const health = stationHealthById.get(selection.id)
    if (!health) return null
    const preferred = latestReadingByStationId.get(selection.id)
    const usingCpcb = preferred?.sourceUsed === 'cpcb' && preferred.cpcbAqi != null
    const availablePollutants: string[] = []
    if ((usingCpcb ? preferred!.cpcbAqi : s?.aqi) != null) availablePollutants.push('aqi')
    if (s?.pm25 != null) availablePollutants.push('pm25')
    if (s?.pm10 != null) availablePollutants.push('pm10')
    if (s?.no2 != null) availablePollutants.push('no2')
    return {
      health,
      lat: s?.lat ?? null,
      lng: s?.lng ?? null,
      availablePollutants,
      readingSource: usingCpcb ? 'CPCB' : 'OpenAQ',
      cpcbLastUpdate: preferred?.cpcbLastUpdate ?? null,
      openaqLastUpdate: preferred?.openaqLastUpdate ?? null,
      cpcbMatched: preferred?.matched ?? false,
      flags: preferred?.flags ?? [],
    }
  }, [viewMode, selection, stations, stationHealthById, latestReadingByStationId])

  const dataQualityWardCoverage: WardCoverageDetail | null = useMemo(() => {
    if (viewMode !== 'data_quality' || selection?.kind !== 'wardBoundary') return null
    return wardCoverageById.get(selection.id) ?? null
  }, [viewMode, selection, wardCoverageById])

  // Enrichment for a clicked ward-boundary polygon (one of the 250 non-
  // hotspot municipal wards, or NDMC/Cantonment) - real station/incident/
  // forecast context where it exists, honest null/"no data" where it
  // doesn't. Looked up from arrays already fetched for the rest of the
  // page, not a new query.
  const wardBoundaryDetail: WardBoundaryDetail | undefined = useMemo(() => {
    if (selection?.kind !== 'wardBoundary') return undefined
    const boundary = wardBoundaries.find((b) => b.id === selection.id)
    if (!boundary) return undefined

    const directHealth = stationHealth.find((s) => s.ward_id === boundary.id)
    const directMarker = directHealth ? stations.find((st) => st.id === directHealth.id) : undefined
    const directStation: WardBoundaryStationRef | null =
      directMarker && directHealth
        ? {
            name: directMarker.name,
            aqi: directMarker.aqi,
            value: stationReadingValue(directMarker, pollutant),
            isStale: directHealth.is_stale,
          }
        : null

    const nearest = nearestStationTo(boundary.lat, boundary.lng, stations)
    const nearestHealth = nearest ? stationHealthById.get(nearest.station.id) : undefined
    const nearestStation =
      nearest != null
        ? {
            name: nearest.station.name,
            aqi: nearest.station.aqi,
            value: stationReadingValue(nearest.station, pollutant),
            isStale: nearestHealth?.is_stale ?? false,
            distanceMeters: nearest.distanceMeters,
          }
        : null

    const wardForecast = forecasts.get(boundary.id)

    return {
      id: boundary.id,
      name: boundary.name,
      wardNumber: boundary.wardNumber,
      jurisdictionType: boundary.jurisdictionType,
      dataStatus: wardDataStatus(directStation != null, nearestStation != null),
      directStation,
      nearestStation,
      linkedIncidentCount: incidents.filter((i) => i.ward_id === boundary.id).length,
      forecastPeak: wardForecast?.peakPred ?? null,
      forecastPollutantLabel: MAP_POLLUTANT_LABEL[forecastPollutant],
      selectedMetricLabel: MAP_POLLUTANT_LABEL[pollutant],
    }
  }, [selection, wardBoundaries, stationHealth, stations, stationHealthById, incidents, forecasts, pollutant, forecastPollutant])

  // Same "must refresh every independent fetch, not just the main bundle"
  // fix as Overview's Refresh button - transitState/latestReadingsState
  // otherwise stay on whatever they resolved to on first mount (commonly
  // "unavailable" if the ingest service's first scheduled refresh hadn't
  // landed yet) even after the visible Refresh button is clicked.
  const refreshAll = () => {
    state.refresh()
    transitState.refresh()
    latestReadingsState.refresh()
  }

  return (
    <AppShell subtitle="Map">
      <div className="flex min-h-0 flex-1 flex-col">
        <MapPageHeader stale={state.stale} fetchedAt={state.fetchedAt} refreshing={state.refreshing} onRefresh={refreshAll} latestStationReadingAgeMinutes={latestStationReadingAgeMinutes} />

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
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              pollutant={pollutant}
              onPollutantChange={setPollutant}
              timeMode={timeMode}
              onTimeModeChange={setTimeMode}
              sourceFilter={sourceFilter}
              onSourceFilterChange={setSourceFilter}
              severityFilter={severityFilter}
              onSeverityFilterChange={setSeverityFilter}
              freshnessFilter={freshnessFilter}
              onFreshnessFilterChange={setFreshnessFilter}
              onResetView={() => setResetToken((t) => t + 1)}
              forecastSuppressed={forecastSuppressed}
            />
            <div className="flex min-h-0 flex-1">
              <div className="relative min-h-0 flex-1">
                <MapView
                  markers={allMarkers}
                  center={DELHI_CENTER}
                  zoom={DELHI_DEFAULT_ZOOM}
                  styleUrl={resolveStyleUrl(basemap)}
                  showScaleBar
                  onMarkerClick={handleMarkerClick}
                  fitBoundsTo={fitBoundsTo}
                  wardBoundaries={wardBoundaryCollection}
                  showWardBoundaries={layers.wardBoundaries && wardBoundariesAvailable}
                  selectedBoundaryId={selection?.kind === 'wardBoundary' ? selection.id : null}
                  onBoundaryClick={handleBoundaryClick}
                  selectedMarkerId={
                    selection?.kind === 'station' ? `station-${selection.id}`
                    : selection?.kind === 'incident' ? `incident-${selection.id}`
                    : null
                  }
                />
                <div className="absolute bottom-14 left-3 top-3 z-10 flex flex-col gap-2 overflow-y-auto">
                  <MapLayerControl
                    layers={layers}
                    onToggle={(key: MapLayerKey) => setLayers((l) => ({ ...l, [key]: !l[key] }))}
                    wardBoundariesAvailable={wardBoundariesAvailable}
                    wardBoundariesLoading={wardBoundariesState.loading}
                    dispatchZonesAvailable={dispatchIncidentIds.size > 0}
                    citizenReportsAvailable={reports.length > 0}
                    transitActivityAvailable={transitState.data?.unavailableReason == null && (transitState.data?.perWard.length ?? 0) > 0}
                    forecastSuppressed={forecastSuppressed}
                  />
                  <MapLegend viewMode={viewMode} sourceAttributionOn={layers.sourceAttribution} pollutant={pollutant} transitActivityOn={layers.transitActivity} forecastSuppressed={forecastSuppressed} />
                </div>
                <BasemapSwitcher mode={basemap} onChange={setBasemap} />
              </div>

              <div className="w-80 flex-shrink-0 overflow-y-auto border-l border-slate-200 bg-white">
                {viewMode === 'data_quality' ? (
                  /* ── Data Quality mode panels ───────────────────────── */
                  dataQualityStationInfo ? (
                    <DataQualityStationPanel info={dataQualityStationInfo} onClose={() => setSelection(null)} />
                  ) : selection?.kind === 'wardBoundary' && dataQualityWardCoverage ? (
                    (() => {
                      const b = wardBoundaries.find((w) => w.id === selection.id)
                      return b ? (
                        <DataQualityWardPanel
                          wardId={b.id}
                          wardName={b.name}
                          wardNumber={b.wardNumber}
                          coverage={dataQualityWardCoverage}
                          onClose={() => setSelection(null)}
                        />
                      ) : null
                    })()
                  ) : selectedIncident ? (
                    <SelectedIncidentPanel incident={selectedIncident} nearestStation={incidentNearestStation} onClose={() => setSelection(null)} />
                  ) : (
                    <DataQualitySummaryPanel
                      stationQuality={stationQuality}
                      wardCoverage={wardCoverageSummary}
                      incidentAudit={incidentAudit}
                    />
                  )
                ) : (
                  /* ── Pollution mode panels (existing) ───────────────── */
                  selection == null ? (
                    <SpatialSummaryPanel
                      stationsTotal={healthRollup.total}
                      stationsFresh={healthRollup.active - healthRollup.stale}
                      stationsStale={healthRollup.stale}
                      activeIncidents={incidents.length}
                      forecastAlerts={severeWards.length}
                      dominantSource={sourceMix[0] ?? null}
                      locationsUnavailable={locationsUnavailable}
                      forecastSuppressed={forecastSuppressed}
                      forecastLoading={forecastsState.loading}
                      highestAqiWard={highestAqiWard}
                      wardsWithCoverage={wardsWithCoverage}
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
                      latestForecastRun={latestForecastRunState.data}
                      latestForecastRunLoading={latestForecastRunState.loading}
                      onClose={() => setSelection(null)}
                    />
                  ) : selectedStation ? (
                    <SelectedStationPanel
                      station={selectedStation}
                      pollutant={pollutant}
                      timeMode={timeMode}
                      forecastPeak={stationForecastValue}
                      forecastPollutantLabel={MAP_POLLUTANT_LABEL[forecastPollutant]}
                      latestForecastRun={latestForecastRunState.data}
                      latestForecastRunLoading={latestForecastRunState.loading}
                      nearbyIncidentsCount={nearbyIncidentsCount}
                      onClose={() => setSelection(null)}
                    />
                  ) : selectedIncident ? (
                    <SelectedIncidentPanel incident={selectedIncident} nearestStation={incidentNearestStation} onClose={() => setSelection(null)} />
                  ) : selection?.kind === 'wardBoundary' && wardBoundaryDetail ? (
                    <SelectedWardBoundaryPanel detail={wardBoundaryDetail} onClose={() => setSelection(null)} />
                  ) : (
                    <SpatialSummaryPanel
                      stationsTotal={healthRollup.total}
                      stationsFresh={healthRollup.active - healthRollup.stale}
                      stationsStale={healthRollup.stale}
                      activeIncidents={incidents.length}
                      forecastAlerts={severeWards.length}
                      dominantSource={sourceMix[0] ?? null}
                      locationsUnavailable={locationsUnavailable}
                      forecastSuppressed={forecastSuppressed}
                      forecastLoading={forecastsState.loading}
                      highestAqiWard={highestAqiWard}
                      wardsWithCoverage={wardsWithCoverage}
                    />
                  )
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}
