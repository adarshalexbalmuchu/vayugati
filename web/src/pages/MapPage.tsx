import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { aqiLevel } from '../components/AqiBadge'
import AppShell from '../components/AppShell'
import MapView, { type IncidentFeatureProps, type WardBoundaryFeatureProps, type WindArrowProps } from '../components/MapView'
import ChangeModeSummaryPanel, { type ChangeRow } from '../components/map/ChangeModeSummaryPanel'
import IncidentClusterPanel from '../components/map/IncidentClusterPanel'
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
import SelectedStationPanel, { type SelectedStation, type StationHistoricalComparison } from '../components/map/SelectedStationPanel'
import SelectedWardBoundaryPanel, { type WardBoundaryDetail, type WardBoundaryStationRef } from '../components/map/SelectedWardBoundaryPanel'
import SelectedWardPanel from '../components/map/SelectedWardPanel'
import SpatialSummaryPanel from '../components/map/SpatialSummaryPanel'
import { DEFAULT_BASEMAP_MODE, maptilerKey, resolveStyleUrl, type BasemapMode } from '../lib/basemaps'
import {
  fetchAllForecasts,
  fetchAllOpenReports,
  fetchAllStationsWithReadings,
  fetchAllWardBoundaries,
  fetchAllWardsAqi,
  fetchAllWindByWard,
  fetchAttribution,
  fetchVayuTraceAttribution,
  fetchHistoricalStationReadings,
  fetchLatestReadingsPreferred,
  fetchTransportActivity,
  triggerIngestRefresh,
  type HistoricalStationReading,
  type Report,
  type StationMarker,
  type WardBoundary,
  type WardForecastSummary,
  type WardSummary,
} from '../lib/data'
import { SEVERITY_RANK, type Severity, type SourceCategory } from '../lib/incidentRules'
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
  CHANGE_DIRECTION_ARROW,
  CHANGE_DIRECTION_HEX,
  changeMarkerBadge,
  classifyChangeDirection,
  DELHI_BOUNDS,
  DELHI_CENTER,
  DELHI_DEFAULT_ZOOM,
  forecastPollutantFor,
  HISTORICAL_TOLERANCE_MS,
  isValidDelhiCoordinate,
  MAP_POLLUTANT_LABEL,
  nearestForecastPoint,
  nearestStationTo,
  OBS_SLOT_HOURS,
  OBS_SLOT_LABEL,
  resolveWardReading,
  stationReadingValue,
  wardDataStatus,
  type ChangeDirection,
  type MapPollutant,
  type MapTimeMode,
  type ObsSlot,
  type ObsViewMode,
} from '../lib/mapRules'
import { rollupStationHealth, severeWardsWithin, tallySourceMix } from '../lib/overviewRules'
import { fetchStationHealth, type StationHealthRow } from '../lib/ops'
import { useAsync } from '../lib/useAsync'

type Selection =
  | { kind: 'ward'; id: number }
  | { kind: 'station'; id: number }
  | { kind: 'incident'; id: number }
  | { kind: 'wardBoundary'; id: number }
  | { kind: 'incidentCluster'; incidentIds: number[] }
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

function stationPopup(
  name: string,
  displayAqi: number | null | undefined,
  usingCpcb: boolean,
  ageMinutes: number | null | undefined,
  pollutantLabel?: string,
  pollutantValue?: number | null,
): string {
  const level = displayAqi != null ? aqiLevel(displayAqi) : null
  const source = usingCpcb ? 'CPCB · data.gov.in' : 'OpenAQ'
  const age = ageMinutes != null ? fmtAge(ageMinutes) : null
  const isConcentration = pollutantLabel && pollutantLabel !== 'AQI'
  const mainLine = isConcentration
    ? `<div style="font-size:12px;color:${level?.hex ?? '#9ca3af'}">${pollutantLabel}: ${pollutantValue != null ? `${Math.round(pollutantValue)} µg/m³` : '—'}</div>`
    : level
      ? `<div style="font-size:12px;color:${level.hex}">AQI ${displayAqi} · ${level.label}</div>`
      : `<div style="font-size:12px;color:#9ca3af">No reading</div>`
  return (
    `<div style="font-size:13px;font-weight:600">${name}</div>` +
    mainLine +
    `<div style="font-size:11px;color:#9ca3af">${source}${age ? ` · ${age}` : ''}</div>`
  )
}


function historicalSnapshotPopup(
  name: string,
  displayValue: number | null,
  pollutantLabel: string,
  displayAqi: number | null,
  ts: string | null,
): string {
  const level = displayAqi != null ? aqiLevel(displayAqi) : null
  const age = ts ? fmtAge((Date.now() - new Date(ts).getTime()) / 60_000) : null
  const unit = pollutantLabel === 'AQI' ? '' : ' µg/m³'
  const valStr = displayValue != null ? `${Math.round(displayValue)}${unit}` : '—'
  return (
    `<div style="font-size:13px;font-weight:600">${name}</div>` +
    `<div style="font-size:12px;color:${level?.hex ?? '#9ca3af'}">${pollutantLabel}: ${valStr}</div>` +
    (age ? `<div style="font-size:11px;color:#9ca3af">Historical · ${age}</div>` : '')
  )
}

function changePopup(name: string, change: { delta: number | null; direction: ChangeDirection | null; earlierValue: number | null; laterValue: number | null } | undefined, pollutantLabel: string): string {
  if (!change || change.delta == null || change.direction == null) {
    return (
      `<div style="font-size:13px;font-weight:600">${name}</div>` +
      `<div style="font-size:12px;color:#9ca3af">No comparable data</div>`
    )
  }
  const hex = CHANGE_DIRECTION_HEX[change.direction]
  const arrow = CHANGE_DIRECTION_ARROW[change.direction]
  const sign = change.delta > 0 ? '+' : ''
  return (
    `<div style="font-size:13px;font-weight:600">${name}</div>` +
    `<div style="font-size:12px;color:${hex}">${arrow} ${sign}${Math.round(change.delta)} ${pollutantLabel}</div>` +
    `<div style="font-size:11px;color:#9ca3af">${change.earlierValue ?? '—'} → ${change.laterValue ?? '—'}</div>`
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
  const [obsSlot, setObsSlot] = useState<ObsSlot>('now')
  const [sourceFilter, setSourceFilter] = useState<SourceCategory | null>(null)
  const [severityFilter, setSeverityFilter] = useState<Severity | null>(null)
  const [viewMode, setViewMode] = useState<MapViewMode>('pollution')
  const [freshnessFilter, setFreshnessFilter] = useState<FreshnessClass | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [resetToken, setResetToken] = useState(0)
  const [historicalReadingByStationId, setHistoricalReadingByStationId] = useState<Map<number, HistoricalStationReading>>(new Map())
  const [obsLoading, setObsLoading] = useState(false)
  const [obsViewMode, setObsViewMode] = useState<ObsViewMode>('snapshot')

  const { healthLoaded, forecastConfirmedFresh } = useIngestHealth()
  const forecastSuppressed = healthLoaded && !forecastConfirmedFresh

  // When forecast becomes unavailable, snap timeMode back to 'now' so the
  // map doesn't stay on a forecast time horizon that has no data.
  useEffect(() => {
    if (forecastSuppressed && timeMode !== 'now') setTimeMode('now')
  }, [forecastSuppressed, timeMode])

  // Historical obs and forecast are mutually exclusive: a future forecast
  // overlaid on a past observation baseline is meaningless.
  useEffect(() => {
    if (obsSlot !== 'now' && timeMode !== 'now') setTimeMode('now')
  }, [obsSlot, timeMode])

  // Data Quality mode is live-only: reset obsSlot and obsViewMode when switching into it.
  useEffect(() => {
    if (viewMode === 'data_quality' && obsSlot !== 'now') setObsSlot('now')
  }, [viewMode, obsSlot])

  // Change mode has no meaning when the slot is 'now' (there's no earlier point to compare).
  useEffect(() => {
    if (obsSlot === 'now' && obsViewMode !== 'snapshot') setObsViewMode('snapshot')
  }, [obsSlot, obsViewMode])

  // Data Quality mode: reset view mode to snapshot.
  useEffect(() => {
    if (viewMode === 'data_quality' && obsViewMode !== 'snapshot') setObsViewMode('snapshot')
  }, [viewMode, obsViewMode])

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
    { cacheKey: 'map:main' },
  )

  const [wards, stations, incidents, reports, stationHealth, dispatchPage] = state.data ?? EMPTY_DATA

  // Fetch historical station readings when obsSlot changes.  Cancelled on
  // cleanup so a slow fetch that lands after a subsequent slot change is
  // silently dropped instead of overwriting the newer result.
  useEffect(() => {
    if (obsSlot === 'now') {
      setHistoricalReadingByStationId(new Map())
      setObsLoading(false)
      return
    }
    const hours = OBS_SLOT_HOURS[obsSlot]!
    const at = new Date(Date.now() - hours * 3_600_000)
    let cancelled = false
    setObsLoading(true)
    fetchHistoricalStationReadings(stations.map((s) => s.id), at).then((data) => {
      if (!cancelled) {
        setHistoricalReadingByStationId(data)
        setObsLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [obsSlot, stations])

  // Real forecast.py output for whichever pollutant is actually selected -
  // AQI has no forecast of its own (the pipeline never computes the
  // composite index), so it maps to a labelled PM2.5 proxy (see
  // forecastPollutantFor). A separate fetch from the main bundle above so
  // switching pollutants doesn't re-fetch wards/stations/incidents/etc, and
  // re-runs whenever the selection changes (unlike the old hardcoded-pm25
  // one-shot fetch).
  const forecastPollutant = forecastPollutantFor(pollutant)
  const forecastsState = useAsync(() => fetchAllForecasts(forecastPollutant), [forecastPollutant], {
    cacheKey: `map:forecasts:${forecastPollutant}`,
  })
  const forecasts = (forecastSuppressed ? new Map() : forecastsState.data) ?? EMPTY_FORECASTS

  // Ward boundary polygons are ~8MB of real OSM-derived GeoJSON across all
  // 250+ wards (measured) - loaded separately from the rest of the page's
  // data, not inside the `Promise.all` above, so the whole console no
  // longer blocks on it. The "Ward boundaries" layer defaults to OFF
  // (MapLayerControl's DEFAULT_LAYER_STATE), so most loads never need this
  // payload at all; when they do, `wardBoundariesAvailable` below already
  // correctly reflects "not loaded yet" via the same disabled-toggle affordance
  // that previously covered a hard fetch failure - no new UI state needed.
  const wardBoundariesState = useAsync(() => fetchAllWardBoundaries(), [], { cacheKey: 'map:ward-boundaries' })
  const wardBoundaries = wardBoundariesState.data ?? EMPTY_BOUNDARIES

  // Delhi OTD transport-activity context layer - independent fetch, same
  // graceful-degradation contract as Overview's own TransportActivityPanel
  // (null on any failure, an explicit unavailableReason on a reachable-but-
  // empty summary). Never blocks the rest of the map.
  const transitState = useAsync(() => fetchTransportActivity(), [], { cacheKey: 'map:transit' })
  const transitByWard = useMemo(
    () => new Map((transitState.data?.perWard ?? []).map((w) => [w.wardId, w])),
    [transitState.data],
  )

  // CPCB/data.gov preferred-latest-reading reconciliation - same
  // independent-fetch, overlay-only contract as transitState above. A
  // failure here just leaves station markers/popups on their existing
  // OpenAQ-sourced AQI, unchanged. See docs/data/cpcb-data-gov-primary-
  // latest-integration-report.md.
  const latestReadingsState = useAsync(() => fetchLatestReadingsPreferred(), [], {
    cacheKey: 'map:latest-readings',
  })
  const latestReadingByStationId = useMemo(
    () => new Map((latestReadingsState.data ?? []).map((r) => [r.stationId, r])),
    [latestReadingsState.data],
  )

  // Wind data — Open-Meteo readings per ward, latest within 2h.
  // Independent fetch so a slow/missing weather table never blocks the map.
  const windState = useAsync(() => fetchAllWindByWard(), [], { cacheKey: 'map:wind' })
  const windByWardId = useMemo(
    () => new Map((windState.data ?? []).map((w) => [w.ward_id, w])),
    [windState.data],
  )

  const leadingSource = useAsync(() => listLeadingSourceCategories(incidents.map((i) => i.id)), [incidents], {
    cacheKey: 'map:leading-source',
  })
  const leadingSourceById = leadingSource.data ?? new Map()

  const stationHealthById = useMemo(() => new Map(stationHealth.map((s) => [s.id, s])), [stationHealth])

  // Per-station change data — computed only in Change mode.  Uses the
  // historicalReadingByStationId already fetched by the Snapshot fetch effect
  // as the "earlier" point, and the live station reading as the "later" point.
  // Both sides are checked against a 2-hour tolerance window.
  type ChangeData = { delta: number | null; direction: ChangeDirection | null; earlierValue: number | null; laterValue: number | null; earlierTs: string | null }
  const changeByStationId = useMemo<Map<number, ChangeData>>(() => {
    const result = new Map<number, ChangeData>()
    if (obsSlot === 'now' || obsViewMode !== 'change') return result
    const hours = OBS_SLOT_HOURS[obsSlot]!
    const targetAtMs = Date.now() - hours * 3_600_000
    for (const s of stations) {
      const historical = historicalReadingByStationId.get(s.id)
      const health = stationHealthById.get(s.id)
      const historicalTsMs = historical?.ts ? new Date(historical.ts).getTime() : null
      // Earlier point: must be within 2h *before* the target slot time.
      const historicalValid = historicalTsMs != null && historicalTsMs >= targetAtMs - HISTORICAL_TOLERANCE_MS
      // Later (live) point: reading must be no older than 2h.
      const liveAgeMs = health?.latest_reading_age_minutes != null ? health.latest_reading_age_minutes * 60_000 : null
      const liveValid = liveAgeMs != null && liveAgeMs <= HISTORICAL_TOLERANCE_MS
      if (!historicalValid || !liveValid) {
        result.set(s.id, { delta: null, direction: null, earlierValue: null, laterValue: null, earlierTs: historical?.ts ?? null })
        continue
      }
      const earlierValue = stationReadingValue(historical!, pollutant)
      const laterValue = stationReadingValue(s, pollutant)
      if (earlierValue == null || laterValue == null) {
        result.set(s.id, { delta: null, direction: null, earlierValue, laterValue, earlierTs: historical!.ts })
        continue
      }
      const delta = laterValue - earlierValue
      const direction = classifyChangeDirection(delta, pollutant)
      result.set(s.id, { delta, direction, earlierValue, laterValue, earlierTs: historical!.ts })
    }
    return result
  }, [obsSlot, obsViewMode, stations, historicalReadingByStationId, stationHealthById, pollutant])

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
  const vayuTraceAttributionState = useAsync(
    () => (selectedWardId == null ? Promise.resolve(null) : fetchVayuTraceAttribution(selectedWardId)),
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
              const isHistoricalSlot = obsSlot !== 'now'
              const preferred = latestReadingByStationId.get(s.id)
              const historicalReading = historicalReadingByStationId.get(s.id)

              // Historical slot: branch between Change mode (Δ badge) and Snapshot mode (historical AQI).
              if (isHistoricalSlot) {
                if (obsViewMode === 'change') {
                  const change = changeByStationId.get(s.id)
                  const direction = change?.direction ?? null
                  const colorOverride = direction != null ? CHANGE_DIRECTION_HEX[direction] : '#94a3b8'
                  const badgeText = changeMarkerBadge(change?.delta ?? null, direction)
                  return {
                    id: `station-${s.id}`,
                    kind: 'station' as const,
                    lat: s.lat,
                    lng: s.lng,
                    label: s.name,
                    aqi: null,
                    isStale: false,
                    isCpcbSourced: false,
                    badgeText,
                    colorOverride,
                    popupHtml: changePopup(s.name, change, MAP_POLLUTANT_LABEL[pollutant]),
                  }
                }
                // Snapshot mode: badge shows the selected pollutant's historical
                // value; colour is still AQI-driven (no established severity
                // colour scale exists for raw concentration values).
                const displayAqi = historicalReading?.aqi ?? null
                const displayValue = historicalReading ? stationReadingValue(historicalReading, pollutant) : null
                return {
                  id: `station-${s.id}`,
                  kind: 'station' as const,
                  lat: s.lat,
                  lng: s.lng,
                  label: s.name,
                  aqi: displayAqi,
                  isStale: false,
                  isCpcbSourced: false,
                  badgeText: displayValue != null ? String(Math.round(displayValue)) : '—',
                  popupHtml: historicalSnapshotPopup(s.name, displayValue, MAP_POLLUTANT_LABEL[pollutant], displayAqi, historicalReading?.ts ?? null),
                }
              }

              const usingCpcb = preferred?.sourceUsed === 'cpcb' && preferred.cpcbAqi != null
              const displayAqi = usingCpcb ? preferred!.cpcbAqi : s.aqi
              const isStale = layers.sensorFreshness && !!health?.is_stale
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
                  freshnessClass: cls,
                  isOpenAqFallback: preferred?.sourceUsed === 'openaq_fallback',
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
              const liveValue = stationReadingValue(s, pollutant)
              const liveBadge = liveValue != null ? String(Math.round(liveValue)) : '—'
              return {
                id: `station-${s.id}`,
                kind: 'station' as const,
                lat: s.lat,
                lng: s.lng,
                label: s.name,
                aqi: displayAqi,
                isStale,
                isCpcbSourced: usingCpcb,
                badgeText: liveBadge,
                popupHtml: stationPopup(s.name, displayAqi, usingCpcb, health?.latest_reading_age_minutes, MAP_POLLUTANT_LABEL[pollutant], liveValue),
              }
            })
        : [],
    [viewMode, freshnessFilter, layers.stations, layers.sensorFreshness, stations, stationHealthById, latestReadingByStationId, obsSlot, obsViewMode, historicalReadingByStationId, changeByStationId, pollutant],
  )

  // Incidents are rendered as a MapLibre GL cluster source (not DOM markers)
  // so individual point positions, cluster circles, and spiderfy all live in
  // the GL layer stack rather than the DOM. The GeoJSON is rebuilt whenever
  // the filter settings or incident data change; MapView's GeoJSONSource
  // receives it via setData() without recreating the source.
  const incidentGeoJSON = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point, IncidentFeatureProps>>(
    () => {
      if (!layers.incidents) return { type: 'FeatureCollection', features: [] }
      const filteredIncidents = incidents.filter((i) => {
        if (severityFilter && i.severity !== severityFilter) return false
        if (sourceFilter && leadingSourceById.get(i.id) !== sourceFilter) return false
        return true
      })
      const features = filteredIncidents
        .filter((i) => isValidDelhiCoordinate(i.lat, i.lng))
        .map((i) => {
          const sev = (i.severity ?? null) as Severity | null
          const severityOrder = sev ? (SEVERITY_RANK[sev] ?? 0) : 0
          const ageMinutes = i.created_at ? (Date.now() - new Date(i.created_at).getTime()) / 60_000 : 0
          return {
            type: 'Feature' as const,
            id: i.id,
            properties: {
              id: i.id,
              severity: i.severity,
              severity_order: severityOrder,
              is_severe: sev === 'severe' ? 1 : 0,
              is_high: sev === 'high' ? 1 : 0,
              is_moderate: sev === 'moderate' ? 1 : 0,
              is_low: !sev || sev === 'low' ? 1 : 0,
              age_minutes: ageMinutes,
              summary: i.summary,
            },
            geometry: { type: 'Point' as const, coordinates: [i.lng as number, i.lat as number] },
          }
        })
      return { type: 'FeatureCollection', features }
    },
    [layers.incidents, incidents, severityFilter, sourceFilter, leadingSourceById],
  )

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
    () => [...wardMarkers, ...stationMarkers, ...reportMarkers, ...transitMarkers],
    [wardMarkers, stationMarkers, reportMarkers, transitMarkers],
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
  }, [])

  const handleIncidentClick = useCallback((id: number) => {
    setSelection({ kind: 'incident', id })
  }, [])

  const handleClusterSelect = useCallback((incidentIds: number[]) => {
    setSelection({ kind: 'incidentCluster', incidentIds })
  }, [])

  // Incidents belonging to the currently-selected cluster (for IncidentClusterPanel).
  const selectedClusterIncidents = useMemo(() => {
    if (selection?.kind !== 'incidentCluster') return []
    const idsSet = new Set(selection.incidentIds)
    return incidents.filter((i) => idsSet.has(i.id))
  }, [selection, incidents])

  // Stable string key passed to MapView so it can detect selection changes
  // without receiving the full Selection object.
  const selectionKey = !selection
    ? 'none'
    : selection.kind === 'incidentCluster'
    ? `incidentCluster:${[...selection.incidentIds].sort((a, b) => a - b).join(',')}`
    : `${selection.kind}:${selection.id}`

  // Clear a stale cluster-panel selection when the filter set changes — the
  // cluster's incident IDs may no longer exist in the new filtered source.
  const incidentFilterInitRef = useRef(false)
  useEffect(() => {
    if (!incidentFilterInitRef.current) { incidentFilterInitRef.current = true; return }
    setSelection((prev) => (prev?.kind === 'incidentCluster' ? null : prev))
  }, [layers.incidents, severityFilter, sourceFilter])

  // Lookup map for fast AQI join into ward boundary properties
  const wardsById = useMemo(() => new Map(wards.map((w) => [w.id, w])), [wards])

  // Station points with AQI weight — source for the AQI heatmap layer
  const stationHeatmapGeoJSON = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point, { aqi: number }>>(() => ({
    type: 'FeatureCollection',
    features: stations
      .filter((s): s is typeof s & { lat: number; lng: number } => s.lat != null && s.lng != null)
      .flatMap((s) => {
        const aqi = s.aqi
        if (aqi == null) return []
        return [{
          type: 'Feature' as const,
          properties: { aqi },
          geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
        }]
      }),
  }), [stations])

  // Real Supabase boundary rows only (see lib/data.ts's fetchAllWardBoundaries)
  // - an empty array here means the layer control correctly shows the
  // toggle as unavailable (MapLayerControl's wardBoundariesAvailable prop),
  // never a placeholder/hardcoded shape.
  // aqi is included in properties so the 3D extrusion layer can read it directly
  // from feature properties (fill-extrusion-height cannot use feature-state).
  const wardBoundaryCollection = useMemo<GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, WardBoundaryFeatureProps>>(
    () => ({
      type: 'FeatureCollection',
      features: wardBoundaries.map((w) => ({
        type: 'Feature',
        properties: {
          id: w.id,
          name: w.name,
          wardNumber: w.wardNumber,
          jurisdictionType: w.jurisdictionType,
          aqi: wardsById.get(w.id)?.aqi ?? null,
        },
        geometry: w.geometry,
      })),
    }),
    [wardBoundaries, wardsById],
  )
  const wardBoundariesAvailable = wardBoundaries.length > 0

  // Wind arrow GeoJSON — point features at ward centroids from WardSummary lat/lng
  const windGeoJSON = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point, WindArrowProps>>(() => ({
    type: 'FeatureCollection',
    features: wards
      .filter((w) => w.lat != null && w.lng != null)
      .flatMap((w) => {
        const wind = windByWardId.get(w.id)
        if (!wind || wind.wind_dir == null || wind.wind_speed == null) return []
        return [{
          type: 'Feature' as const,
          properties: { ward_id: w.id, wind_dir: wind.wind_dir, wind_speed: wind.wind_speed },
          geometry: { type: 'Point' as const, coordinates: [w.lng as number, w.lat as number] },
        }]
      }),
  }), [wards, windByWardId])
  const handleBoundaryClick = useCallback((ward: WardBoundaryFeatureProps) => {
    setSelection({ kind: 'wardBoundary', id: ward.id })
  }, [])

  const selectedWard = selection?.kind === 'ward' ? wards.find((w) => w.id === selection.id) : undefined
  const selectedIncident: Incident | undefined =
    selection?.kind === 'incident' ? incidents.find((i) => i.id === selection.id) : undefined
  // Derive overlay coords from the filtered GeoJSON, not the full incidents
  // list — this way the overlay naturally disappears when the selected
  // incident is excluded by a severity/source filter or the layer is off.
  const selectedIncidentCoords = useMemo<[number, number] | null>(() => {
    if (selection?.kind !== 'incident') return null
    const feature = incidentGeoJSON.features.find((f) => f.id === selection.id)
    if (!feature) return null
    const [lng, lat] = feature.geometry.coordinates
    return [lng, lat]
  }, [selection, incidentGeoJSON])
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

  // Flat list of per-station change data for ChangeModeSummaryPanel.
  const changeSummaryRows = useMemo<ChangeRow[]>(
    () =>
      stations.map((s) => {
        const c = changeByStationId.get(s.id)
        return { stationId: s.id, stationName: s.name, delta: c?.delta ?? null, direction: c?.direction ?? null }
      }),
    [stations, changeByStationId],
  )

  // Historical comparison for the selected station — present only in Change mode.
  const selectedStationHistoricalComparison = useMemo<StationHistoricalComparison | undefined>(() => {
    if (obsViewMode !== 'change' || obsSlot === 'now' || selection?.kind !== 'station') return undefined
    const change = changeByStationId.get(selection.id)
    if (!change) return undefined
    return {
      obsSlotLabel: OBS_SLOT_LABEL[obsSlot],
      earlierValue: change.earlierValue,
      laterValue: change.laterValue,
      delta: change.delta,
      direction: change.direction,
      pollutantLabel: MAP_POLLUTANT_LABEL[pollutant],
      earlierTs: change.earlierTs,
    }
  }, [obsViewMode, obsSlot, selection, changeByStationId, pollutant])

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

  // Ask the ingest service to pull fresh data from data.gov.in before
  // re-fetching from Supabase. The server enforces a 10-min cooldown so
  // rapid clicks just get a "recent" response and we fall through to a
  // normal Supabase re-fetch, which is still useful (picks up any ingest
  // that ran in the background since the last page load).
  const refreshAll = async () => {
    await triggerIngestRefresh()
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
              obsSlot={obsSlot}
              onObsSlotChange={setObsSlot}
              obsLoading={obsLoading}
              obsViewMode={obsViewMode}
              onObsViewModeChange={setObsViewMode}
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
                  selectedMarkerId={selection?.kind === 'station' ? `station-${selection.id}` : null}
                  incidentGeoJSON={incidentGeoJSON}
                  onIncidentClick={handleIncidentClick}
                  onClusterSelect={handleClusterSelect}
                  selectedIncidentId={selection?.kind === 'incident' ? selection.id : null}
                  dataQualityMode={viewMode === 'data_quality'}
                  show3D={layers.aqiExtrusion && wardBoundariesAvailable}
                  windGeoJSON={windGeoJSON}
                  showWind={layers.windFlow && windGeoJSON.features.length > 0}
                  showBuildings3D={layers.buildings3D && maptilerKey() != null}
                  showAqiHeatmap={layers.aqiHeatmap && stationHeatmapGeoJSON.features.length > 0}
                  stationHeatmapGeoJSON={stationHeatmapGeoJSON}
                  showVegetation3D={layers.vegetation3D && maptilerKey() != null}
                  showLandUse={layers.landUse && maptilerKey() != null}
                  selectionKey={selectionKey}
                  selectedIncidentCoords={selectedIncidentCoords}
                />
                <div className="absolute bottom-14 left-3 top-3 z-10 flex flex-col gap-2 overflow-y-auto">
                  <MapLayerControl
                    layers={layers}
                    onToggle={(key: MapLayerKey) => setLayers((l) => ({ ...l, [key]: !l[key] }))}
                    wardBoundariesAvailable={wardBoundariesAvailable}
                    wardBoundariesLoading={wardBoundariesState.loading}
                    dispatchZonesAvailable={dispatchIncidentIds.size > 0}
                    citizenReportsAvailable={reports.length > 0}
                    transitActivityAvailable={transitState.data?.unavailableReason == null && (transitState.data?.perWard?.length ?? 0) > 0}
                    aqiExtrusionAvailable={wardBoundariesAvailable}
                    windFlowAvailable={windGeoJSON.features.length > 0}
                    buildings3DAvailable={maptilerKey() != null}
                    aqiHeatmapAvailable={stationHeatmapGeoJSON.features.length > 0}
                    vegetation3DAvailable={maptilerKey() != null}
                    landUseAvailable={maptilerKey() != null}
                    forecastSuppressed={forecastSuppressed}
                  />
                  <MapLegend viewMode={viewMode} sourceAttributionOn={layers.sourceAttribution} pollutant={pollutant} transitActivityOn={layers.transitActivity} forecastSuppressed={forecastSuppressed} obsViewMode={obsViewMode} />
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
                  ) : selection?.kind === 'incidentCluster' ? (
                    <IncidentClusterPanel
                      incidents={selectedClusterIncidents}
                      leadingSourceById={leadingSourceById}
                      onClose={() => setSelection(null)}
                    />
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
                    obsViewMode === 'change' && obsSlot !== 'now' ? (
                      <ChangeModeSummaryPanel obsSlot={obsSlot} pollutant={pollutant} rows={changeSummaryRows} />
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
                  ) : selectedWard ? (
                    <SelectedWardPanel
                      ward={selectedWard}
                      forecast={forecasts.get(selectedWard.id)}
                      pollutant={pollutant}
                      linkedIncidents={incidents.filter((i) => i.ward_id === selectedWard.id)}
                      linkedDispatches={dispatchPage.rows.filter((d) => d.ward_name === selectedWard.name)}
                      attribution={attributionState.data}
                      attributionLoading={attributionState.loading}
                      vayuTraceAttribution={vayuTraceAttributionState.data}
                      vayuTraceAttributionLoading={vayuTraceAttributionState.loading}
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
                      historicalComparison={selectedStationHistoricalComparison}
                      onClose={() => setSelection(null)}
                    />
                  ) : selection?.kind === 'incidentCluster' ? (
                    <IncidentClusterPanel
                      incidents={selectedClusterIncidents}
                      leadingSourceById={leadingSourceById}
                      onClose={() => setSelection(null)}
                    />
                  ) : selectedIncident ? (
                    <SelectedIncidentPanel incident={selectedIncident} nearestStation={incidentNearestStation} onClose={() => setSelection(null)} />
                  ) : selection?.kind === 'wardBoundary' && wardBoundaryDetail ? (
                    <SelectedWardBoundaryPanel detail={wardBoundaryDetail} onClose={() => setSelection(null)} />
                  ) : obsViewMode === 'change' && obsSlot !== 'now' ? (
                    <ChangeModeSummaryPanel obsSlot={obsSlot} pollutant={pollutant} rows={changeSummaryRows} />
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
