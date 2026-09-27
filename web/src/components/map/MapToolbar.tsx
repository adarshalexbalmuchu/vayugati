import { ChevronDown, Crosshair, Info, RefreshCw, SlidersHorizontal } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FRESHNESS_LABEL, type FreshnessClass } from '../../lib/dataQualityRules'
import type { ForecastAccuracySummary } from '../../lib/data'
import { SOURCE_CATEGORY_LABEL, sourceCategoryLabel, type Severity, type SourceCategory } from '../../lib/incidentRules'
import { MAP_POLLUTANT_LABEL, markerMeaningLabel, OBS_SLOT_LABEL, pollutantHasForecast, type MapPollutant, type MapTimeMode, type ObsSlot, type ObsViewMode } from '../../lib/mapRules'
import { NOWCAST_FEATURE_ENABLED } from '../../lib/nowcastConfig'
import { StaleBadge } from '../ui'
import ObsTimeSlider from './ObsTimeSlider'

export type MapViewMode = 'pollution' | 'data_quality'
/** GIS analysis tool mode — 'none' means normal marker/boundary selection
 *  behaviour, unaffected by anything in this file. */
export type ToolKind = 'none' | 'measure' | 'buffer' | 'ask'

const POLLUTANTS: MapPollutant[] = ['aqi', 'pm25', 'pm10', 'no2', 'so2', 'co', 'o3']
// The '+1h' entry is gated behind NOWCAST_FEATURE_ENABLED - hiding it here
// is one of two required gates (GeoAiPanel.tsx's executor is the other;
// hiding this button alone doesn't stop GeoAI from independently emitting
// time_mode: '1h').
const TIME_MODES: { key: MapTimeMode; label: string }[] = [
  { key: 'now', label: 'Now' },
  ...(NOWCAST_FEATURE_ENABLED ? [{ key: '1h' as const, label: '+1h' }] : []),
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
  { key: 'ask', label: 'Ask' },
]
const RADIUS_PRESETS_KM = [1, 2, 5]

/** Sept 2026, 3rd pass: MapToolbar used to be its own floating glass pill
 *  over the map (white-on-glass text, tuned for that dark backdrop). Per
 *  direct request it now lives INSIDE AppShell's header row instead (see
 *  MapPage.tsx), which uses dark-on-light glass everywhere else — so every
 *  control here switches from white/translucent to slate/light styling to
 *  match, rather than reading as a mismatched dark fragment inside a light
 *  header. `variant` keeps this reusable without a second near-duplicate
 *  component: 'light' (new default, for the header) vs 'dark' (kept in
 *  case a future caller still needs the original glass-over-map look). */
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
    <div className="flex flex-shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white/60 p-0.5">
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
                ? 'cursor-not-allowed text-slate-300'
                : isActive
                  ? 'bg-accent-500 text-white'
                  : 'text-slate-600 hover:bg-white'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export interface MapToolbarProps {
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
  /** City-wide validated-vs-baseline forecast mix (Sept 2026 addition) —
   *  drives the honesty note next to the 24h/48h forecast buttons, so a
   *  viewer sees "most of these are the seasonal baseline, not a validated
   *  model" at the point of selecting a forecast time mode, not only if
   *  they later click into a specific ward/station's own detail panel. */
  forecastAccuracy?: ForecastAccuracySummary | null
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
  /** Compact data-freshness text (e.g. "Updated 13:15 · Latest reading 1h
   *  ago"). Moved into the "Filters & tools" dropdown (Sept 2026, 3rd
   *  pass) along with Refresh/Reset/Info, per direct request to keep the
   *  header row itself down to just pollutant + time + the dropdown
   *  trigger. */
  freshnessLabel?: string | null
  isStale?: boolean
  onRefresh?: () => void
  refreshing?: boolean
}

/** The compact, always-visible strip: pollutant tabs + time tabs + the
 *  "Filters & tools" dropdown trigger — sized to sit inside AppShell's
 *  64px header row (see MapPage.tsx, passed as `headerContent`) rather
 *  than as its own separate floating bar. Renders the SAME dropdown panel
 *  every other control lives in (freshness/Refresh/Reset/Info/view
 *  mode/filters/GIS tools/historical time-travel) — this component owns
 *  the open/closed state and positions the dropdown itself so callers
 *  don't need to coordinate two components. */
export default function MapToolbar(props: MapToolbarProps) {
  const {
    viewMode, onViewModeChange, pollutant, onPollutantChange, timeMode, onTimeModeChange,
    sourceFilter, onSourceFilterChange, severityFilter, onSeverityFilterChange,
    freshnessFilter, onFreshnessFilterChange, onResetView,
    forecastSuppressed = false, forecastAccuracy = null,
    obsSlot, onObsSlotChange, obsLoading = false, obsViewMode, onObsViewModeChange,
    activeTool = 'none', onActiveToolChange, bufferRadiusKm = 1, onBufferRadiusChange,
    freshnessLabel, isStale = false, onRefresh, refreshing = false,
  } = props

  const isHistorical = obsSlot !== 'now'
  // Forecast modes are unavailable when viewing historical observations (a
  // future forecast on a past observation baseline makes no sense visually),
  // when the forecast pipeline itself is down, or when the selected
  // pollutant (so2/co/o3) was never forecast in the first place — distinct
  // from pipeline health, and checked separately so the right reason shows.
  const pollutantForecastless = !pollutantHasForecast(pollutant)
  const forecastDisabledKeys: MapTimeMode[] =
    (forecastSuppressed || isHistorical || pollutantForecastless) ? ['1h', '24h', '48h'] : []
  const forecastDisabledTitle = isHistorical
    ? 'Forecast unavailable while viewing historical observations.'
    : pollutantForecastless
    ? `${MAP_POLLUTANT_LABEL[pollutant]} isn't forecast yet — showing live readings only.`
    : 'Unavailable until a successful forecast run completes.'
  const isQuality = viewMode === 'data_quality'

  const [moreOpen, setMoreOpen] = useState(false)
  const activeFilterCount =
    (viewMode === 'data_quality' ? 1 : 0) +
    (sourceFilter ? 1 : 0) +
    (severityFilter ? 1 : 0) +
    (freshnessFilter ? 1 : 0) +
    (activeTool !== 'none' ? 1 : 0) +
    (obsSlot !== 'now' ? 1 : 0)

  // Bug fix (Sept 2026, 3rd pass): this toolbar now lives inside AppShell's
  // header, which is wrapped in <GlassSurface> — that component's outer
  // shell is `overflow-hidden` (needed so its glass background layers clip
  // to its own rounded/flush shape). A plain `position: absolute; top:
  // 100%` dropdown, positioned relative to an ancestor inside that shell,
  // gets clipped at the shell's own bottom edge instead of floating below
  // the header the way it visually needs to. Portalled to document.body
  // and positioned from the trigger button's real viewport coordinates
  // instead, which is unaffected by any ancestor's overflow/clipping.
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number } | null>(null)

  useLayoutEffect(() => {
    if (!moreOpen || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setDropdownPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right })
  }, [moreOpen])

  // Close on an outside click / Escape — standard dropdown behaviour, and
  // necessary now that the panel is portalled (it's no longer a DOM
  // descendant of the trigger, so a naive "click anywhere closes it"
  // listener would need this same outside-check regardless).
  useEffect(() => {
    if (!moreOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      const panel = document.getElementById('map-toolbar-dropdown')
      if (panel?.contains(target)) return
      setMoreOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [moreOpen])

  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-2">
      {/* Sept 2026, 3rd pass: this row now shares a fixed-height 64px
          header with the logo/account menu (previously its own full-width
          floating bar with room to spare) — 7 pollutant tabs + 4 time-mode
          tabs is a lot of horizontal content for what's left. Scrolls
          horizontally on a narrow viewport instead of silently clipping a
          tab off-screen with no way to reach it. */}
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
        {!isQuality ? (
          <>
            <SegmentedGroup
              value={pollutant}
              onChange={onPollutantChange}
              options={POLLUTANTS.map((p) => ({ key: p, label: MAP_POLLUTANT_LABEL[p] }))}
            />
            <SegmentedGroup
              value={forecastSuppressed || pollutantForecastless ? 'now' : timeMode}
              onChange={onTimeModeChange}
              options={TIME_MODES}
              disabledKeys={forecastDisabledKeys}
              disabledTitle={forecastDisabledTitle}
            />
          </>
        ) : (
          <span className="flex-shrink-0 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600">
            Data quality mode
          </span>
        )}
      </div>

      <div className="ml-auto flex flex-shrink-0 items-center gap-2">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
          className={`focus-ring flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
            moreOpen || activeFilterCount > 0
              ? 'border-accent-300 bg-accent-50 text-accent-700'
              : 'border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Filters &amp; tools
          {activeFilterCount > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-500 px-1 text-[10px] font-bold text-white">
              {activeFilterCount}
            </span>
          )}
          <ChevronDown className={`h-3 w-3 transition-transform ${moreOpen ? 'rotate-180' : ''}`} aria-hidden />
        </button>
      </div>

      {/* Dropdown — everything that used to sit in the toolbar's own always-
          visible row (freshness text, Refresh, the forecast honesty badge,
          Info, Reset to Delhi) plus the pre-existing secondary controls
          (view mode, filters, GIS tools, historical time-travel).
          Portalled to document.body (see the positioning effect above for
          why) rather than absolutely positioned inline. */}
      {moreOpen && dropdownPos && createPortal(
        <div
          id="map-toolbar-dropdown"
          style={{ position: 'fixed', top: dropdownPos.top, right: dropdownPos.right }}
          className="z-dropdown w-[min(92vw,26rem)] rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-card-lg">
          <div className="flex flex-wrap items-center gap-2">
            {freshnessLabel && (
              <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-500">
                {isStale && <StaleBadge />}
                {freshnessLabel}
              </span>
            )}
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                disabled={refreshing}
                className="focus-ring ml-auto flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
                Refresh
              </button>
            )}
            <button
              type="button"
              onClick={onResetView}
              className="focus-ring flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Crosshair className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Reset to Delhi
            </button>
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
          </div>

          {/* Validated-vs-baseline honesty note (Sept 2026) — only shown
              while an actual forecast time mode is selected (not "Now",
              which shows live readings with nothing to caveat). Per the
              platform's own validation audit
              (docs/data/forecast-validation-report.md), the model clears
              its accuracy bar for a small fraction of ward+pollutant pairs
              at any given time — everything else shown on a 24h/48h view
              is the seasonal baseline wearing the same visual presentation
              as a validated prediction. */}
          {!isQuality && (timeMode === '24h' || timeMode === '48h') && !forecastSuppressed && !pollutantForecastless && forecastAccuracy && forecastAccuracy.totalWardPollutantPairs > 0 && (
            <div
              title="The trained model is used only at lead times where it beat simple forecast rules in validation; elsewhere the best simple rule is shown."
              className="mt-2 flex items-center gap-1 rounded-lg border border-status-warning/30 bg-status-warning/10 px-2 py-1 text-[11px] font-medium text-status-warning"
            >
              <Info className="h-3 w-3 flex-shrink-0" aria-hidden />
              Only {forecastAccuracy.beatsPersistenceCount}/{forecastAccuracy.totalWardPollutantPairs} validated model
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
            <SegmentedGroup
              value={viewMode}
              onChange={onViewModeChange}
              options={[
                { key: 'pollution' as MapViewMode, label: 'Pollution' },
                { key: 'data_quality' as MapViewMode, label: 'Data quality' },
              ]}
            />

            {isQuality ? (
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
              <>
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
                {onActiveToolChange && (
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
              </>
            )}
          </div>

          {!isQuality && (
            <div className="mt-2 border-t border-slate-100 pt-2">
              <ObsTimeSlider
                value={obsSlot}
                onChange={onObsSlotChange}
                loading={obsLoading}
                obsViewMode={obsViewMode}
                onObsViewModeChange={onObsViewModeChange}
              />
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
