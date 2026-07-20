import { MapPin, RefreshCw } from 'lucide-react'
import { StaleBadge } from '../ui'

/** Page header - title, city context, last-updated timestamp, refresh.
 *  Same pattern as the Overview/Incidents page headers. */
export default function MapPageHeader({
  stale,
  fetchedAt,
  refreshing,
  onRefresh,
}: {
  stale: boolean
  fetchedAt: number | null
  refreshing: boolean
  onRefresh: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
      <div>
        <h1 className="text-base font-bold text-slate-900">Map</h1>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
          <MapPin className="h-3 w-3" aria-hidden />
          Delhi City Pack
          {stale && <StaleBadge />}
          {fetchedAt != null && (
            <span>· Updated {new Date(fetchedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
          )}
        </p>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="focus-ring flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
        Refresh
      </button>
    </div>
  )
}
