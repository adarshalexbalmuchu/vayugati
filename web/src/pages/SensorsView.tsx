import { useState } from 'react'
import AppShell from '../components/AppShell'
import { Card, CardHeader, EmptyState, ErrorState, Skeleton, StaleBadge } from '../components/ui'
import { useAuth } from '../lib/auth'
import { fetchStationHealth, setStationActive, type StationHealthRow } from '../lib/ops'
import { useAsync } from '../lib/useAsync'

/**
 * Sensors — per-station data-quality view (one of the 5 commander nav items
 * that were previously permanently disabled "coming soon" placeholders).
 *
 * Built entirely from real, already-existing data: stations.is_active/
 * sensor_type (Phase 6/10), and each station's own latest readings.ts —
 * station-level freshness has never been surfaced anywhere in this app
 * before (only a city-wide "any reading at all" check existed), but it's
 * computed from the exact same readings table, not a new data source.
 *
 * Deliberately does NOT claim to show "resolved OpenAQ id" status — that's
 * a property of ingest/stations.yaml (a config file), not any database
 * column, so there is no real way for the frontend to query it honestly.
 */

function fmtAge(minutes: number | null): string {
  if (minutes == null) return 'No readings yet'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function StationRow({ station, onToggle, busy }: { station: StationHealthRow; onToggle: () => void; busy: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
          {station.name}
          {station.is_stale && <StaleBadge label={station.latest_reading_at ? 'Stale' : 'No data'} />}
        </p>
        <p className="mt-0.5 truncate text-xs text-slate-400">
          {station.ward_name ?? 'No ward'} · {station.sensor_type} · {fmtAge(station.latest_reading_age_minutes)}
        </p>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={onToggle}
        className={`focus-ring flex-shrink-0 rounded-full px-3 py-1 text-xs font-bold uppercase transition disabled:opacity-50 ${
          station.is_active ? 'bg-status-success/10 text-status-success' : 'bg-slate-100 text-slate-500'
        }`}
      >
        {station.is_active ? 'Active' : 'Inactive'}
      </button>
    </li>
  )
}

export default function SensorsView() {
  const { session } = useAuth()
  const state = useAsync(fetchStationHealth, [])
  const stations = state.data ?? []
  const staleCount = stations.filter((s) => s.is_stale).length
  const [busyId, setBusyId] = useState<number | null>(null)

  const toggle = async (station: StationHealthRow) => {
    if (!session) return
    setBusyId(station.id)
    try {
      await setStationActive(station.id, !station.is_active, session.user.id)
      state.refresh()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <AppShell subtitle="Sensors">
      <div className="mx-auto w-full max-w-3xl flex-1 space-y-3 overflow-y-auto bg-slate-50 p-3 sm:p-4">
        <Card>
          <CardHeader
            title="Sensors"
            subtitle={
              stations.length > 0
                ? `${stations.length} station(s) configured · ${staleCount} stale or without recent data`
                : 'Station-level data quality'
            }
            right={
              <button
                type="button"
                onClick={() => state.refresh()}
                className="focus-ring rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Refresh
              </button>
            }
          />
          {state.loading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : state.error ? (
            <ErrorState message={state.error} onRetry={() => state.refresh()} />
          ) : stations.length === 0 ? (
            <EmptyState icon="◈">No stations configured yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {stations.map((s) => (
                <StationRow key={s.id} station={s} onToggle={() => toggle(s)} busy={busyId === s.id} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  )
}
