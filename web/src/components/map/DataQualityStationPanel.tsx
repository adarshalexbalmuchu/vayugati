import { ArrowUpRight, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  FRESHNESS_HEX,
  FRESHNESS_LABEL,
  formatReadingAge,
  stationFreshnessClass,
  type FreshnessClass,
} from '../../lib/dataQualityRules'
import type { StationHealthRow } from '../../lib/ops'

export interface DataQualityStationInfo {
  health: StationHealthRow
  /** Station lat/lng — null when not in the stations list. */
  lat: number | null
  lng: number | null
  /** Available pollutants from the live reading (non-null values). */
  availablePollutants: string[]
  /** Latest reading source determined by the CPCB/OpenAQ reconciliation. */
  readingSource: 'CPCB' | 'OpenAQ' | 'unknown'
  /** Time of last CPCB update (from reconciliation), if available. */
  cpcbLastUpdate: string | null
  /** Time of last OpenAQ update (from reconciliation), if available. */
  openaqLastUpdate: string | null
  /** Whether the reconciliation found a CPCB match for this station. */
  cpcbMatched: boolean
  /** Raw flags from the reconciliation (e.g. "stale", "no_cpcb_match"). */
  flags: string[]
}

function FreshnessBadge({ cls, fallback }: { cls: FreshnessClass; fallback?: boolean }) {
  const isGood = cls === 'fresh'
  const isWarn = cls === 'delayed'
  const isBad = cls === 'stale' || cls === 'no_reading' || cls === 'unavailable'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ring-1 ring-inset ${
        isGood ? 'text-status-success ring-status-success/40'
        : isWarn ? 'text-status-warning ring-status-warning/40'
        : isBad ? 'text-status-critical ring-status-critical/40'
        : 'text-slate-500 ring-slate-300'
      }`}
      style={{ color: FRESHNESS_HEX[cls] }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: FRESHNESS_HEX[cls] }} aria-hidden />
      {FRESHNESS_LABEL[cls]}{fallback ? ' · OpenAQ' : ''}
    </span>
  )
}

function fmtTs(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

export default function DataQualityStationPanel({
  info,
  onClose,
}: {
  info: DataQualityStationInfo
  onClose: () => void
}) {
  const cls = stationFreshnessClass(info.health)
  const age = info.health.latest_reading_age_minutes

  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Station · Data Quality</p>
          <h2 className="text-sm font-semibold text-slate-800">{info.health.name}</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            {info.health.ward_name ?? 'Unknown ward'} · <span className="uppercase">{info.health.sensor_type}</span>
          </p>
        </div>
        <button type="button" onClick={onClose} className="focus-ring rounded p-1 text-slate-400 hover:bg-slate-100">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {/* Freshness */}
      <div className="mb-3 flex items-center gap-2">
        <FreshnessBadge cls={cls} fallback={info.readingSource === 'OpenAQ'} />
        <span className="text-[11px] text-slate-400">{formatReadingAge(age)}</span>
        {!info.health.is_active && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-500">
            Inactive
          </span>
        )}
      </div>

      {/* Observation timestamps */}
      <dl className="mb-3 grid grid-cols-1 gap-y-1.5 rounded-lg bg-slate-50 px-3 py-2 text-[11px]">
        <div className="flex items-center justify-between">
          <dt className="text-slate-400">Last successful ingestion</dt>
          <dd className="font-semibold text-slate-700">{fmtTs(info.health.latest_reading_at)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-slate-400">Latest source</dt>
          <dd className="font-semibold text-slate-700">{info.readingSource}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-slate-400">CPCB match</dt>
          <dd className={`font-semibold ${info.cpcbMatched ? 'text-status-success' : 'text-slate-400'}`}>
            {info.cpcbMatched ? 'Yes' : 'No match found'}
          </dd>
        </div>
        {info.cpcbLastUpdate && (
          <div className="flex items-center justify-between">
            <dt className="text-slate-400">CPCB last update</dt>
            <dd className="font-semibold text-slate-700">{fmtTs(info.cpcbLastUpdate)}</dd>
          </div>
        )}
        {info.openaqLastUpdate && (
          <div className="flex items-center justify-between">
            <dt className="text-slate-400">OpenAQ last update</dt>
            <dd className="font-semibold text-slate-700">{fmtTs(info.openaqLastUpdate)}</dd>
          </div>
        )}
        <div className="flex items-baseline justify-between">
          <dt className="text-slate-400">Coordinates</dt>
          <dd className="font-mono text-[10px] text-slate-600">
            {info.lat != null && info.lng != null
              ? `${info.lat.toFixed(4)}, ${info.lng.toFixed(4)}`
              : 'Not available'}
          </dd>
        </div>
        <div className="flex items-baseline justify-between">
          <dt className="text-slate-400">Ward ID</dt>
          <dd className="font-semibold text-slate-700">
            {info.health.ward_id != null ? `#${info.health.ward_id}` : 'Unassigned'}
          </dd>
        </div>
      </dl>

      {/* Pollutant coverage */}
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Pollutant coverage</p>
      <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2">
        {info.availablePollutants.length === 0 ? (
          <p className="text-[11px] text-slate-400">No pollutant data available.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {(['AQI', 'PM2.5', 'PM10', 'NO₂'] as const).map((p) => {
              const key = p === 'AQI' ? 'aqi' : p === 'PM2.5' ? 'pm25' : p === 'PM10' ? 'pm10' : 'no2'
              const available = info.availablePollutants.includes(key)
              return (
                <span
                  key={p}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    available
                      ? 'bg-accent-50 text-accent-700 ring-1 ring-inset ring-accent-200'
                      : 'bg-slate-100 text-slate-400 line-through'
                  }`}
                >
                  {p}
                </span>
              )
            })}
          </div>
        )}
      </div>

      {/* Flags */}
      {info.flags.length > 0 && (
        <div className="mb-3 rounded-lg bg-status-warning/10 px-2.5 py-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-status-warning">Ingestion flags</p>
          <ul className="space-y-0.5 text-[11px] text-status-warning">
            {info.flags.map((f) => (
              <li key={f}>• {f}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      <div className="space-y-1.5">
        {info.health.ward_id != null && (
          <Link
            to={`/incidents?wardId=${info.health.ward_id}`}
            className="focus-ring flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
          >
            View incidents in this ward
            <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </Link>
        )}
        <Link
          to="/sensors"
          className="focus-ring flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
        >
          View station history
          <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        </Link>
      </div>
    </div>
  )
}
