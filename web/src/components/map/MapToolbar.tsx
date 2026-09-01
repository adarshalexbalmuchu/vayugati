import { Crosshair, Info } from 'lucide-react'
import { FRESHNESS_LABEL, type FreshnessClass } from '../../lib/dataQualityRules'
import { SOURCE_CATEGORY_LABEL, sourceCategoryLabel, type Severity, type SourceCategory } from '../../lib/incidentRules'
import { MAP_POLLUTANT_LABEL, markerMeaningLabel, OBS_SLOT_LABEL, type MapPollutant, type MapTimeMode, type ObsSlot, type ObsViewMode } from '../../lib/mapRules'
import ObsTimeSlider from './ObsTimeSlider'

export type MapViewMode = 'pollution' | 'data_quality'
/** GIS analysis tool mode — 'none' means normal marker/boundary selection
 *  behaviour, unaffected by anything in this file. */
export type ToolKind = 'none' | 'measure' | 'buffer'

const POLLUTANTS: MapPollutant[] = ['aqi', 'pm25', 'pm10', 'no2']
const TIME_MODES: { key: MapTimeMode; label: string }[] = [
  { key: 'now', label: 'Now' },
  { key: '24h', label: '24h forecast' },
  { key: '48h', label: '48h forecast' },
]
const SEVERITY_ORDER: Severity[] = ['severe', 'high', 'moderate', 'low']
const SOURCE_CATEGORIES = Object.keys(SOURCE_CATEGORY_LABEL) as SourceCategory[]
const FRESHNESS_FILTER_OPTIONS: FreshnessClass[] = ['fresh', 'delayed', 'stale', 'no_reading', 'unavailable']
const TOOL_OPTIONS: { key: ToolKind; label: string }[] = [
  { key: 'none', label: 'Select' },
  { key: 'measure', label: 'Measure' },
  { key: 'buffer', label: 'Buffer' },
]
const RADIUS_PRESETS_KM = [1, 2, 5]

function SegmentedGroup<T extends string>({
  value,
  options,
  onChange,
  disabledKeys,
  disabledTitle,
}: {
  value: T
  options: { key: T; label: string }[]
  onChange: (v: T) => void
  disabledKeys?: T[]
  disabledTitle?: string
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-slate-200 p-0.5">
      {options.map((o) => {
        const isDisabled = disabledKeys?.includes(o.key) ?? false
        const isActive = value === o.key && !isDisabled
        return (
          <button
            key={o.key}
            type="button"
            disabled={isDisabled}
            title={isDisabled ? disabledTitle : undefined}
            onClick={() => !isDisabled && onChange(o.key)}
            className={`focus-ring rounded-md px-2.5 py-1 text-xs font-semibold transition ${
              isDisabled
                ? 'cursor-not-allowed opacity-40 text-slate-400'
                : isActive
                  ? 'bg-accent-500 text-white'
                  : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export default function MapToolbar({
  viewMode,
  onViewModeChange,
  pollutant,
  onPollutantChange,
  timeMode,
  onTimeModeChange,
  sourceFilter,
  onSourceFilterChange,
  severityFilter,
  onSeverityFilterChange,
  freshnessFilter,
  onFreshnessFilterChange,
  onResetView,
  forecastSuppressed = false,
  obsSlot,
  onObsSlotChange,
  obsLoading = false,
  obsViewMode,
  onObsViewModeChange,
  activeTool = 'none',
  onActiveToolChange,
  bufferRadiusKm = 1,
  onBufferRadiusChange,
}: {
  viewMode: MapViewMode
  onViewModeChange: (m: MapViewMode) => void
  pollutant: MapPollutant
  onPollutantChange: (p: MapPollutant) => void
  timeMode: MapTimeMode
  onTimeModeChange: (t: MapTimeMode) => void
  sourceFilter: SourceCategory | null
  onSourceFilterChange: (s: SourceCategory | null) => void
  severityFilter: Severity | null
  onSeverityFilterChange: (s: Severity | null) => void
  /** Freshness-class filter — only active in data_quality mode. */
  freshnessFilter: FreshnessClass | null
  onFreshnessFilterChange: (f: FreshnessClass | null) => void
  onResetView: () => void
  forecastSuppressed?: boolean
  obsSlot: ObsSlot
  onObsSlotChange: (s: ObsSlot) => void
  obsLoading?: boolean
  obsViewMode: ObsViewMode
  onObsViewModeChange: (m: ObsViewMode) => void
  activeTool?: ToolKind
  onActiveToolChange?: (t: ToolKind) => void
  /** Only shown/relevant while activeTool === 'buffer'. */
  bufferRadiusKm?: number
  onBufferRadiusChange?: (km: number) => void
}) {
  const isHistorical = obsSlot !== 'now'
  // Forecast modes are unavailable when viewing historical observations: a
  // future forecast on a past observation baseline makes no sense visually.
  const forecastDisabledKeys: MapTimeMode[] = (forecastSuppressed || isHistorical) ? ['24h', '48h'] : []
  const forecastDisabledTitle = isHistorical
    ? 'Forecast unavailable while viewing historical observations.'
    : 'Unavailable until a successful forecast run completes.'
  const isQuality = viewMode === 'data_quality'

  return (
    <div className="border-b border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        {/* View mode — always first */}
        <SegmentedGroup
          value={viewMode}
          onChange={onViewModeChange}
          options={[
            { key: 'pollution' as MapViewMode, label: 'Pollution' },
            { key: 'data_quality' as MapViewMode, label: 'Data quality' },
          ]}
        />

        {isQuality ? (
          /* Data quality mode controls */
          <select
            value={freshnessFilter ?? ''}
            onChange={(e) => onFreshnessFilterChange((e.target.value || null) as FreshnessClass | null)}
            className="focus-ring rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"
          >
            <option value="">All freshness states</option>
            {FRESHNESS_FILTER_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {FRESHNESS_LABEL[f]}
              </option>
            ))}
          </select>
        ) : (
          /* Pollution mode controls */
          <>
            <SegmentedGroup
              value={pollutant}
              onChange={onPollutantChange}
              options={POLLUTANTS.map((p) => ({ key: p, label: MAP_POLLUTANT_LABEL[p] }))}
            />
            <SegmentedGroup
              value={forecastSuppressed ? 'now' : timeMode}
              onChange={onTimeModeChange}
              options={TIME_MODES}
              disabledKeys={forecastDisabledKeys}
              disabledTitle={forecastDisabledTitle}
            />
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
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {!isQuality && onActiveToolChange && (
            <>
              <SegmentedGroup value={activeTool} onChange={onActiveToolChange} options={TOOL_OPTIONS} />
              {activeTool === 'buffer' && onBufferRadiusChange && (
                <SegmentedGroup
                  value={String(bufferRadiusKm)}
                  onChange={(v) => onBufferRadiusChange(Number(v))}
                  options={RADIUS_PRESETS_KM.map((km) => ({ key: String(km), label: `${km}km` }))}
                />
              )}
            </>
          )}
          <span
            title={
              isQuality
                ? 'Showing station freshness and ward monitoring coverage. Station colour shows data age, not AQI severity.'
                : isHistorical && obsViewMode === 'change'
                  ? `Markers show ${MAP_POLLUTANT_LABEL[pollutant]} change from ${OBS_SLOT_LABEL[obsSlot]} to Now — verified station readings only.`
                  : markerMeaningLabel(pollutant, timeMode, obsSlot)
            }
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <Info className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </span>
          <button
            type="button"
            onClick={onResetView}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Crosshair className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Reset to Delhi
          </button>
        </div>
      </div>

      {!isQuality && (
        <ObsTimeSlider
          value={obsSlot}
          onChange={onObsSlotChange}
          loading={obsLoading}
          obsViewMode={obsViewMode}
          onObsViewModeChange={onObsViewModeChange}
        />
      )}
    </div>
  )
}
