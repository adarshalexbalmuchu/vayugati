import { Layers } from 'lucide-react'
import { SOURCE_CATEGORY_LABEL, type SourceCategory } from '../../lib/incidentRules'
import { SOURCE_CATEGORY_HEX } from '../../lib/mapMarkers'
import type { SourceMixEntry } from '../../lib/overviewRules'
import { Card, CardHeader } from '../ui'

const UNKNOWN_HEX = '#CBD5E1'

function colorFor(source: string): string {
  return SOURCE_CATEGORY_HEX[source as SourceCategory] ?? UNKNOWN_HEX
}

function labelFor(source: string): string {
  return SOURCE_CATEGORY_LABEL[source as SourceCategory] ?? source
}

const RADIUS = 40
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * Donut over the same tallySourceMix() counts the old bar-list version used
 * - no new data, just a more scannable visual. Colours reuse
 * SOURCE_CATEGORY_HEX (the Map page's own source-attribution palette) so a
 * category reads as the same colour everywhere in the app, not a separate
 * ad hoc chart palette.
 */
export default function SourceMixPanel({ mix }: { mix: SourceMixEntry[] }) {
  const total = mix.reduce((s, m) => s + m.count, 0)
  let cumulative = 0

  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <Layers className="h-4 w-4 text-accent-600" aria-hidden />
            Source Mix
          </span>
        }
        subtitle="Dominant source by ward, city-wide"
      />
      {mix.length === 0 || total === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-slate-400">No source data available.</p>
      ) : (
        <div className="flex flex-1 items-center gap-4 px-4 py-3.5">
          <svg viewBox="0 0 100 100" className="h-28 w-28 flex-shrink-0" role="img" aria-label="Source mix breakdown">
            <circle cx="50" cy="50" r={RADIUS} fill="none" stroke="#F1F5F9" strokeWidth="16" />
            {mix.map((m) => {
              const segment = (m.count / total) * CIRCUMFERENCE
              const dashoffset = -cumulative
              cumulative += segment
              return (
                <circle
                  key={m.source}
                  cx="50"
                  cy="50"
                  r={RADIUS}
                  fill="none"
                  stroke={colorFor(m.source)}
                  strokeWidth="16"
                  strokeDasharray={`${segment} ${CIRCUMFERENCE - segment}`}
                  strokeDashoffset={dashoffset}
                  transform="rotate(-90 50 50)"
                />
              )
            })}
            <text x="50" y="47" textAnchor="middle" className="fill-current text-slate-900" fontSize="18" fontWeight="700">
              {total}
            </text>
            <text
              x="50"
              y="61"
              textAnchor="middle"
              className="fill-current text-slate-400"
              fontSize="8"
              fontWeight="600"
              letterSpacing="0.5"
            >
              WARDS
            </text>
          </svg>

          <ul className="min-w-0 flex-1 space-y-1.5">
            {mix.map((m) => (
              <li key={m.source} className="flex items-center gap-2 text-xs">
                <span
                  className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: colorFor(m.source) }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate font-medium text-slate-700">{labelFor(m.source)}</span>
                <span className="flex-shrink-0 tabular-nums text-slate-500">{m.count}</span>
                <span className="w-9 flex-shrink-0 text-right tabular-nums text-slate-400">
                  {Math.round((m.count / total) * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
