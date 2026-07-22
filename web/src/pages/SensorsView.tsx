import { useMemo, useState } from 'react'
import { Activity, Gauge, Info, MapPin, PlugZap, RefreshCw, TriangleAlert, Wind } from 'lucide-react'
import AppShell from '../components/AppShell'
import { ErrorState, Skeleton, StaleBadge } from '../components/ui'
import KpiStrip, { type KpiItem } from '../components/overview/KpiStrip'
import DataReadinessCard from '../components/sensors/DataReadinessCard'
import SensorDetailPanel from '../components/sensors/SensorDetailPanel'
import SensorFilterBar, { ALL, type SensorFilters } from '../components/sensors/SensorFilterBar'
import SensorHealthTable, { type SensorRow } from '../components/sensors/SensorHealthTable'
import { sensorStatus, type SensorStatus } from '../components/sensors/SensorStatusBadge'
import { useAuth } from '../lib/auth'
import { fetchAllStationsWithReadings, fetchDataFootprint, fetchForecastAccuracySummary, fetchLatestReadingsPreferred } from '../lib/data'
import { listIncidents } from '../lib/incidents'
import { fetchStationHealth, setStationActive, type StationHealthRow } from '../lib/ops'
import type { DataReadinessInput } from '../lib/readinessRules'
import { useAsync } from '../lib/useAsync'

/**
 * Sensors — station health and data-reliability console (Phase redesign,
 * matching the Overview/Incidents/Map/Tasks visual language). Merges two
 * already-existing, already-correct fetches client-side (fetchStationHealth
 * for freshness/activation state, fetchAllStationsWithReadings for
 * coordinates + latest pollutant values) rather than adding a new query -
 * both already read from the same stations/readings tables. "Linked
 * incidents" is a real spatial join (open incidents in the same ward),
 * not a fabricated relationship - stations have no incident_id of their own.
 */

const DEFAULT_FILTERS: SensorFilters = { status: ALL, ward: ALL, sensorType: ALL }

export default function SensorsView() {
  const { session } = useAuth()
  const [filters, setFilters] = useState<SensorFilters>(DEFAULT_FILTERS)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const state = useAsync(() => Promise.all([fetchStationHealth(), fetchAllStationsWithReadings()]), [])
  const incidentsState = useAsync(() => listIncidents({ excludeClosed: true, limit: 1000 }), [])
  const openIncidents = incidentsState.data ?? []

  // Readiness card's own inputs - independent fetches (not blocking the
  // station table above), same pattern as Analytics' forecastAccuracy hook.
  const footprintState = useAsync(fetchDataFootprint, [])
  const forecastAccuracyState = useAsync(fetchForecastAccuracySummary, [])
  // Same independent-fetch contract - a failure here just leaves every
  // row's existing OpenAQ-sourced aqi unchanged, readingSource undefined.
  const latestReadingsState = useAsync(() => fetchLatestReadingsPreferred(), [])

  const rows: SensorRow[] = useMemo(() => {
    if (!state.data) return []
    const [health, readings] = state.data
    const readingByStationId = new Map(readings.map((r) => [r.id, r]))
    const preferredByStationId = new Map((latestReadingsState.data ?? []).map((r) => [r.stationId, r]))
    const incidentCountByWard = new Map<number, number>()
    for (const i of openIncidents) {
      if (i.ward_id == null) continue
      incidentCountByWard.set(i.ward_id, (incidentCountByWard.get(i.ward_id) ?? 0) + 1)
    }
    return health.map((s: StationHealthRow) => {
      const r = readingByStationId.get(s.id)
      const preferred = preferredByStationId.get(s.id)
      const usingCpcb = preferred?.sourceUsed === 'cpcb' && preferred.cpcbAqi != null
      return {
        ...s,
        lat: r?.lat ?? null,
        lng: r?.lng ?? null,
        aqi: usingCpcb ? preferred!.cpcbAqi : (r?.aqi ?? null),
        pm25: r?.pm25 ?? null,
        pm10: r?.pm10 ?? null,
        no2: r?.no2 ?? null,
        linkedIncidentCount: s.ward_id != null ? (incidentCountByWard.get(s.ward_id) ?? 0) : 0,
        readingSource: preferred?.sourceUsed,
      }
    })
  }, [state.data, openIncidents, latestReadingsState.data])

  const statuses = useMemo(() => [...new Set(rows.map((r) => sensorStatus(r)))].sort() as SensorStatus[], [rows])
  const wards = useMemo(() => [...new Set(rows.map((r) => r.ward_name).filter((w): w is string => w != null))].sort(), [rows])
  const sensorTypes = useMemo(() => [...new Set(rows.map((r) => r.sensor_type))].sort(), [rows])

  const filteredRows = useMemo(
    () =>
      rows.filter((r) => {
        if (filters.status !== ALL && sensorStatus(r) !== filters.status) return false
        if (filters.ward !== ALL && r.ward_name !== filters.ward) return false
        if (filters.sensorType !== ALL && r.sensor_type !== filters.sensorType) return false
        return true
      }),
    [rows, filters],
  )

  const isFiltered = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS)
  const selected = selectedId != null ? rows.find((r) => r.id === selectedId) : undefined
  const selectedWardIncidents = selected ? openIncidents.filter((i) => i.ward_id === selected.ward_id) : []

  const staleOrNoDataCount = useMemo(
    () => rows.filter((r) => sensorStatus(r) === 'stale' || sensorStatus(r) === 'no_data').length,
    [rows],
  )

  const readinessInput: DataReadinessInput | null = useMemo(() => {
    if (state.loading || !footprintState.data || !forecastAccuracyState.data) return null
    return {
      wardBoundaryCount: footprintState.data.wardBoundaryCount,
      stationCount: rows.length,
      activeStationCount: rows.filter((r) => r.is_active).length,
      forecastFreshCount: forecastAccuracyState.data.coverage.freshCount,
      forecastTotalPairs: forecastAccuracyState.data.coverage.totalPairs,
      totalReadingsCount: footprintState.data.totalReadingsCount,
    }
  }, [state.loading, footprintState.data, forecastAccuracyState.data, rows])

  const toggle = async (station: SensorRow) => {
    if (!session) return
    setBusyId(station.id)
    try {
      await setStationActive(station.id, !station.is_active, session.user.id)
      state.refresh()
    } finally {
      setBusyId(null)
    }
  }

  const kpis: KpiItem[] | null = useMemo(() => {
    if (state.loading || rows.length === 0) return rows.length === 0 && !state.loading ? [] : null
    const active = rows.filter((r) => r.is_active)
    const stale = rows.filter((r) => sensorStatus(r) === 'stale')
    const noData = rows.filter((r) => sensorStatus(r) === 'no_data')
    const offline = rows.filter((r) => sensorStatus(r) === 'offline')
    const ageSamples = active.map((r) => r.latest_reading_age_minutes).filter((m): m is number => m != null)
    const avgAge = ageSamples.length ? Math.round(ageSamples.reduce((s, m) => s + m, 0) / ageSamples.length) : null
    const pollutantTotal = rows.reduce(
      (sum, r) => sum + (['aqi', 'pm25', 'pm10', 'no2'] as const).filter((k) => r[k] != null).length,
      0,
    )
    const pollutantPct = rows.length > 0 ? Math.round((pollutantTotal / (rows.length * 4)) * 100) : null

    return [
      { key: 'total', icon: Gauge, label: 'Total stations', value: rows.length, tone: 'neutral' },
      { key: 'active', icon: Activity, label: 'Active stations', value: active.length, tone: 'success' },
      { key: 'stale', icon: TriangleAlert, label: 'Stale stations', value: stale.length, tone: stale.length > 0 ? 'warning' : 'success' },
      {
        key: 'offlineNoData',
        icon: PlugZap,
        label: 'Offline / no data',
        value: offline.length + noData.length,
        sublabel: `${offline.length} offline · ${noData.length} never reported`,
        tone: offline.length + noData.length > 0 ? 'critical' : 'success',
      },
      { key: 'avgAge', icon: Wind, label: 'Avg. last-seen delay', value: avgAge != null ? `${avgAge}m` : 'No sample', tone: 'neutral' },
      { key: 'coverage', icon: Gauge, label: 'Pollutant coverage', value: pollutantPct != null ? `${pollutantPct}%` : '—', tone: 'info' },
    ]
  }, [state.loading, rows])

  return (
    <AppShell subtitle="Sensors">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden bg-slate-50 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-card">
          <div>
            <h1 className="text-base font-bold text-slate-900">Sensors</h1>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
              <MapPin className="h-3 w-3" aria-hidden />
              Delhi City Pack
              {state.stale && <StaleBadge />}
            </p>
            <p className="mt-1 max-w-xl text-xs text-slate-400">
              Monitors CAAQMS/station freshness and reliability - the data foundation every other page depends on.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              state.refresh()
              incidentsState.refresh()
            }}
            disabled={state.refreshing}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${state.refreshing ? 'animate-spin' : ''}`} aria-hidden />
            Refresh
          </button>
        </div>

        {state.loading ? (
          <Skeleton className="h-20 w-full rounded-xl" />
        ) : state.error ? (
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
            <ErrorState message={state.error} onRetry={() => state.refresh()} />
          </div>
        ) : (
          kpis && kpis.length > 0 && <KpiStrip items={kpis} />
        )}

        {!state.loading && !state.error && rows.length > 0 && (
          <SensorFilterBar filters={filters} onChange={setFilters} statuses={statuses} wards={wards} sensorTypes={sensorTypes} />
        )}

        {!state.loading && !state.error && staleOrNoDataCount > 0 && (
          <div className="flex items-start gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-500 shadow-card">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-slate-400" aria-hidden />
            <span>
              {staleOrNoDataCount} station{staleOrNoDataCount === 1 ? '' : 's'} showing stale or no data - some of this is expected
              (upstream OpenAQ publish delays, or a known gap - see Data Readiness for specifics), not necessarily a broken sensor.
            </span>
          </div>
        )}

        {!state.loading && !state.error && rows.length > 0 && (
          <p className="px-1 text-[11px] text-slate-400">
            Latest readings: CPCB/data.gov preferred · OpenAQ fallback. AQI computed using CPCB breakpoint logic.
          </p>
        )}

        <div className="flex min-h-0 flex-1 gap-3">
          <SensorHealthTable
            rows={filteredRows}
            totalCount={rows.length}
            loading={state.loading}
            error={state.error}
            onRetry={() => state.refresh()}
            selectedId={selectedId}
            onSelect={setSelectedId}
            isFiltered={isFiltered}
          />
          <div className="w-80 flex-shrink-0 overflow-y-auto">
            {selected ? (
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
                <SensorDetailPanel
                  station={selected}
                  linkedIncidents={selectedWardIncidents}
                  onToggleActive={() => toggle(selected)}
                  toggleBusy={busyId === selected.id}
                  onClose={() => setSelectedId(null)}
                />
              </div>
            ) : (
              <DataReadinessCard input={readinessInput} loading={readinessInput == null} />
            )}
          </div>
        </div>
      </div>
    </AppShell>
  )
}
