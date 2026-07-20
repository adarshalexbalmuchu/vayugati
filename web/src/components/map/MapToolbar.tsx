import { Crosshair, RefreshCw } from 'lucide-react'
import { SOURCE_CATEGORY_LABEL, sourceCategoryLabel, type Severity, type SourceCategory } from '../../lib/incidentRules'
import { MAP_POLLUTANT_LABEL, type MapPollutant, type MapTimeMode } from '../../lib/mapRules'

const POLLUTANTS: MapPollutant[] = ['aqi', 'pm25', 'pm10', 'no2']
const TIME_MODES: { key: MapTimeMode; label: string }[] = [
  { key: 'now', label: 'Now' },
  { key: '24h', label: '24h forecast' },
  { key: '48h', label: '48h forecast' },
]
const SEVERITY_ORDER: Severity[] = ['severe', 'high', 'moderate', 'low']
const SOURCE_CATEGORIES = Object.keys(SOURCE_CATEGORY_LABEL) as SourceCategory[]

function SegmentedGroup<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { key: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-slate-200 p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`focus-ring rounded-md px-2.5 py-1 text-xs font-semibold transition ${
            value === o.key ? 'bg-accent-500 text-white' : 'text-slate-500 hover:bg-slate-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export default function MapToolbar({
  pollutant,
  onPollutantChange,
  timeMode,
  onTimeModeChange,
  sourceFilter,
  onSourceFilterChange,
  severityFilter,
  onSeverityFilterChange,
  onResetView,
  onRefresh,
  refreshing,
}: {
  pollutant: MapPollutant
  onPollutantChange: (p: MapPollutant) => void
  timeMode: MapTimeMode
  onTimeModeChange: (t: MapTimeMode) => void
  sourceFilter: SourceCategory | null
  onSourceFilterChange: (s: SourceCategory | null) => void
  severityFilter: Severity | null
  onSeverityFilterChange: (s: Severity | null) => void
  onResetView: () => void
  onRefresh: () => void
  refreshing: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
      <SegmentedGroup
        value={pollutant}
        onChange={onPollutantChange}
        options={POLLUTANTS.map((p) => ({ key: p, label: MAP_POLLUTANT_LABEL[p] }))}
      />
      <SegmentedGroup value={timeMode} onChange={onTimeModeChange} options={TIME_MODES} />

      <select
        value={sourceFilter ?? ''}
        onChange={(e) => onSourceFilterChange((e.target.value || null) as SourceCategory | null)}
        className="focus-ring rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"
      >
        <option value="">All sources</option>
        {SOURCE_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {sourceCategoryLabel(c)}
          </option>
        ))}
      </select>

      <select
        value={severityFilter ?? ''}
        onChange={(e) => onSeverityFilterChange((e.target.value || null) as Severity | null)}
        className="focus-ring rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs capitalize text-slate-700"
      >
        <option value="">All severities</option>
        {SEVERITY_ORDER.map((s) => (
          <option key={s} value={s} className="capitalize">
            {s}
          </option>
        ))}
      </select>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onResetView}
          className="focus-ring flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          <Crosshair className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Reset view
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="focus-ring flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
          Refresh
        </button>
      </div>
    </div>
  )
}
