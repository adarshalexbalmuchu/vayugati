import { ChevronRight } from 'lucide-react'
import type { StationHealthRow } from '../../lib/ops'
import { Card, CardHeader, ErrorState, Skeleton } from '../ui'
import EmptySensorState from './EmptySensorState'
import SensorStatusBadge, { sensorStatus } from './SensorStatusBadge'

export interface SensorRow extends StationHealthRow {
  lat: number | null
  lng: number | null
  aqi: number | null
  pm25: number | null
  pm10: number | null
  no2: number | null
  linkedIncidentCount: number
  /** Which source `aqi` above actually came from - undefined when the
   *  CPCB/data.gov reconciliation hasn't loaded (falls back to the
   *  existing OpenAQ-sourced value either way). See
   *  docs/data/cpcb-data-gov-primary-latest-integration-report.md. */
  readingSource?: 'cpcb' | 'openaq_fallback'
}

const POLLUTANT_KEYS = ['aqi', 'pm25', 'pm10', 'no2'] as const

function fmtAge(minutes: number | null): string {
  if (minutes == null) return 'No readings yet'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function SensorHealthTable({
  rows,
  totalCount,
  loading,
  error,
  onRetry,
  selectedId,
  onSelect,
  isFiltered,
}: {
  rows: SensorRow[]
  totalCount: number
  loading: boolean
  error: string | null
  onRetry: () => void
  selectedId: number | null
  onSelect: (id: number) => void
  isFiltered: boolean
}) {
  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <CardHeader title="Stations" subtitle={`${rows.length} of ${totalCount} shown - click a row for detail`} />
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && rows.length === 0 ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : rows.length === 0 ? (
          <EmptySensorState filtered={isFiltered} />
        ) : (
          <table className="w-full min-w-[1080px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50">
              <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                <th className="px-3 py-2 font-semibold">Station</th>
                <th className="px-3 py-2 font-semibold">Ward</th>
                <th className="px-3 py-2 font-semibold">Type</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Last seen</th>
                <th className="px-3 py-2 font-semibold" title="Latest readings: CPCB/data.gov preferred · OpenAQ fallback">
                  Latest AQI
                </th>
                <th className="px-3 py-2 font-semibold">Pollutants</th>
                <th className="px-3 py-2 font-semibold">Coverage</th>
                <th className="px-3 py-2 font-semibold">Linked incidents</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((s) => {
                const selected = s.id === selectedId
                const status = sensorStatus(s)
                const available = POLLUTANT_KEYS.filter((k) => s[k] != null)
                return (
                  <tr
                    key={s.id}
                    onClick={() => onSelect(s.id)}
                    className={`cursor-pointer transition ${selected ? 'bg-accent-50' : 'hover:bg-slate-50'}`}
                  >
                    <td className="px-3 py-2 font-medium text-slate-800">{s.name}</td>
                    <td className="px-3 py-2 text-slate-600">{s.ward_name ?? '—'}</td>
                    <td className="px-3 py-2 uppercase text-slate-500">{s.sensor_type}</td>
                    <td className="px-3 py-2">
                      <SensorStatusBadge status={status} />
                    </td>
                    <td className="px-3 py-2 tabular-nums text-slate-500">{fmtAge(s.latest_reading_age_minutes)}</td>
                    <td className="px-3 py-2 tabular-nums font-semibold text-slate-800">
                      <span
                        className="inline-flex items-center gap-1.5"
                        title={
                          s.readingSource === 'cpcb'
                            ? 'Latest reading: CPCB/data.gov preferred'
                            : s.readingSource === 'openaq_fallback'
                              ? 'Latest reading: OpenAQ fallback'
                              : undefined
                        }
                      >
                        {s.readingSource && (
                          <span
                            className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${s.readingSource === 'cpcb' ? 'bg-accent-500' : 'bg-slate-300'}`}
                            aria-hidden
                          />
                        )}
                        {s.aqi ?? '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-500">
                      {available.length > 0 ? available.map((k) => k.toUpperCase()).join(', ') : 'None'}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-slate-500">{available.length}/4</td>
                    <td className="px-3 py-2 tabular-nums text-slate-600">{s.linkedIncidentCount}</td>
                    <td className="w-6 px-1 text-slate-300">
                      <ChevronRight className="h-4 w-4" aria-hidden />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  )
}
