import { TrendingUp, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Incident } from '../../lib/incidents'
import { STATION_STALE_MINUTES } from '../../lib/ops'
import type { SensorRow } from './SensorHealthTable'
import SensorStatusBadge, { sensorStatus } from './SensorStatusBadge'

function fmtAge(minutes: number | null): string {
  if (minutes == null) return 'No readings yet'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function SensorDetailPanel({
  station,
  linkedIncidents,
  onToggleActive,
  toggleBusy,
  onClose,
}: {
  station: SensorRow
  linkedIncidents: Incident[]
  onToggleActive: () => void
  toggleBusy: boolean
  onClose: () => void
}) {
  const status = sensorStatus(station)
  const pollutants: { key: 'pm25' | 'pm10' | 'no2'; label: string }[] = [
    { key: 'pm25', label: 'PM2.5' },
    { key: 'pm10', label: 'PM10' },
    { key: 'no2', label: 'NO₂' },
  ]

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-start justify-between gap-2 border-b border-slate-100 p-4">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Station</p>
          <h2 className="truncate text-sm font-semibold text-slate-800">{station.name}</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            {station.ward_name ?? 'Unknown ward'} · <span className="uppercase">{station.sensor_type}</span>
          </p>
        </div>
        <button type="button" onClick={onClose} className="focus-ring flex-shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <SensorStatusBadge status={status} />
          <span className="text-[11px] text-slate-400">{fmtAge(station.latest_reading_age_minutes)}</span>
        </div>

        {status === 'stale' && (
          <p className="rounded-lg bg-status-warning/10 px-2.5 py-2 text-xs text-status-warning">
            No reading in over {STATION_STALE_MINUTES} minutes ({fmtAge(station.latest_reading_age_minutes)}) - this station is
            marked stale until a fresh reading arrives.
          </p>
        )}
        {status === 'no_data' && (
          <p className="rounded-lg bg-status-critical/10 px-2.5 py-2 text-xs text-status-critical">
            This station has never produced a reading in the readings table.
          </p>
        )}
        {status === 'offline' && (
          <p className="rounded-lg bg-slate-100 px-2.5 py-2 text-xs text-slate-500">
            Deactivated by an operator - excluded from ingestion until re-enabled below.
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <div>
            <dt className="text-slate-400">Coordinates</dt>
            <dd className="font-medium tabular-nums text-slate-800">
              {station.lat != null && station.lng != null ? `${station.lat.toFixed(4)}, ${station.lng.toFixed(4)}` : 'Not recorded'}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Pollutant coverage</dt>
            <dd className="font-medium text-slate-800">
              {['aqi', 'pm25', 'pm10', 'no2'].filter((k) => station[k as 'aqi' | 'pm25' | 'pm10' | 'no2'] != null).length}/4 reporting
            </dd>
          </div>
        </dl>

        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Latest readings
            {station.readingSource && (
              <span className="ml-1.5 font-normal normal-case text-slate-400">
                ({station.readingSource === 'cpcb' ? 'CPCB/data.gov' : 'OpenAQ fallback'})
              </span>
            )}
          </p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <div>
              <dt className="text-slate-400">AQI</dt>
              <dd className="font-semibold tabular-nums text-slate-800">{station.aqi ?? '—'}</dd>
            </div>
            {pollutants.map((p) => (
              <div key={p.key}>
                <dt className="text-slate-400">{p.label}</dt>
                <dd className="font-semibold tabular-nums text-slate-800">{station[p.key] ?? '—'}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="flex items-start gap-1.5 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-500">
          <TrendingUp className="mt-0.5 h-3 w-3 flex-shrink-0 text-slate-400" strokeWidth={2} aria-hidden />
          Trend unavailable for this station in the current dataset.
        </div>

        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Linked incidents ({linkedIncidents.length})
          </p>
          {linkedIncidents.length === 0 ? (
            <p className="text-xs text-slate-400">No open incidents in this station&apos;s ward.</p>
          ) : (
            <ul className="space-y-1">
              {linkedIncidents.slice(0, 5).map((i) => (
                <li key={i.id}>
                  <Link to={`/incidents?incident=${i.id}`} className="focus-ring truncate text-xs text-accent-700 hover:underline">
                    {i.summary ?? `Incident #${i.id}`}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button
          type="button"
          onClick={onToggleActive}
          disabled={toggleBusy}
          className={`focus-ring w-full rounded-lg border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
            station.is_active
              ? 'border-status-critical/30 text-status-critical hover:bg-status-critical/5'
              : 'border-status-success/30 text-status-success hover:bg-status-success/5'
          }`}
        >
          {toggleBusy ? 'Updating…' : station.is_active ? 'Deactivate station' : 'Activate station'}
        </button>
      </div>
    </div>
  )
}
