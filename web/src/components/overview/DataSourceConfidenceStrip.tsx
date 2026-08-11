import { Database } from 'lucide-react'
import { useIngestHealth } from '../../contexts/IngestHealthContext'

/**
 * Single-line ingest status summary — source counts and unmatched stations
 * from the last completed ingest run, read from the shared IngestHealthContext.
 * Non-interactive; replaces the earlier five-field strip whose data depended
 * on a /readings/latest call that was silently failing in production.
 */
export default function DataSourceConfidenceStrip() {
  const { health } = useIngestHealth()
  const run = health?.last_run

  const parts: string[] = []
  if (run) {
    if (run.cpcb_rows_written > 0) parts.push(`${run.cpcb_rows_written} readings via CPCB`)
    if (run.openaq_rows_written > 0) parts.push(`${run.openaq_rows_written} readings via OpenAQ fallback`)
    if ((run.stations_skipped_no_id?.length ?? 0) > 0)
      parts.push(`${run.stations_skipped_no_id!.join(', ')} unmatched`)
  }

  return (
    <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-500 shadow-card">
      <Database className="h-3.5 w-3.5 flex-shrink-0 text-accent-600" aria-hidden />
      {parts.length > 0 ? (
        <span>{parts.join(' · ')}</span>
      ) : run === null || run === undefined ? (
        <span className="italic">Ingest status unavailable</span>
      ) : (
        <span className="italic">No readings written in last cycle</span>
      )}
      {run?.finished_at && (
        <span className="ml-auto tabular-nums text-slate-400">
          {new Date(run.finished_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
    </div>
  )
}
