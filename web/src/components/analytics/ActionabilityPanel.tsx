import { Target } from 'lucide-react'
import { DOMINANT_SOURCE_LABEL, type ActionabilityScore } from '../../lib/actionabilityRules'
import { Card, CardHeader, ErrorState, Skeleton } from '../ui'

/**
 * Ranks wards by VayuTrace attribution quality, not pollution severity -
 * "is this ward's signal clean enough and local enough to act on", a
 * different question from "is this ward's air the worst right now" (already
 * answerable via the AQI ranking elsewhere). Mirrors RecurrencePanel.tsx's
 * single-card ranked-list layout exactly.
 */
export default function ActionabilityPanel({
  rankings,
  loading,
  error,
  onRetry,
}: {
  rankings: ActionabilityScore[]
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <Target className="h-4 w-4 text-accent-600" aria-hidden />
            Most actionable wards
          </span>
        }
        subtitle="VayuTrace attribution quality - confidence, source dominance, local addressability"
      />
      {loading ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : rankings.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-slate-400">
          No VayuTrace attribution data available yet for any ward.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rankings.slice(0, 8).map((r) => (
            <li key={r.wardId} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-700">{r.wardName}</p>
                <p className="truncate text-xs text-slate-400">
                  {r.dominantSource ? `${DOMINANT_SOURCE_LABEL[r.dominantSource]}-dominated` : 'No clear dominant source'}
                </p>
              </div>
              <span className="flex-shrink-0 font-semibold tabular-nums text-accent-600">{Math.round(r.score)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
