import type { ForecastPoint } from '../../lib/data'
import { FRESHNESS_HEX, FRESHNESS_LABEL, formatReadingAge } from '../../lib/dataQualityRules'
import { anchorFreshnessClass, type MapTimeMode } from '../../lib/mapRules'

/**
 * The +1h nowcast provenance block, shared across all three ward-data
 * panels (SelectedWardPanel, SelectedWardBoundaryPanel, SelectedStationPanel)
 * so the three don't drift into three slightly different renderings of the
 * same facts. Only renders anything when timeMode === '1h' - null otherwise,
 * letting each caller keep its own '24h'/'48h'/'now' rendering untouched.
 */
export default function NowcastBlock({
  timeMode,
  point,
  heading,
}: {
  timeMode: MapTimeMode
  point: ForecastPoint | null
  /** "+1h ward nowcast" for the ward's own data, "Linked ward +1h nowcast"
   *  for a station panel showing its linked ward's data - never "station
   *  forecast", this is always ward-level data. */
  heading: string
}) {
  if (timeMode !== '1h') return null

  const freshness = anchorFreshnessClass(point?.anchorObservedAt ?? null)
  const usableAnchor = freshness === 'fresh' || freshness === 'delayed'
  const ageMinutes = point?.anchorObservedAt ? (Date.now() - new Date(point.anchorObservedAt).getTime()) / 60_000 : null

  return (
    <div className="mt-3 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-600">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{heading}</p>
      {!usableAnchor ? (
        <p className="mt-1 text-slate-500">
          Nowcast unavailable — {freshness === 'no_reading' ? 'no recent observation for this ward.' : freshness === 'unavailable' ? 'observation timestamp is invalid.' : `latest observation is too old (${formatReadingAge(ageMinutes)}).`}
        </p>
      ) : (
        <>
          <p className="mt-1 font-semibold text-slate-800">
            {point?.predicted_value != null ? `${Math.round(point.predicted_value)} µg/m³` : 'Unavailable'}
          </p>
          <p className="mt-0.5 text-slate-500">
            Valid at {point?.horizon_ts ? new Date(point.horizon_ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—'}
          </p>
          <p className="mt-0.5 text-slate-500">
            Anchored to observation {formatReadingAge(ageMinutes)} ·{' '}
            <span style={{ color: FRESHNESS_HEX[freshness] }}>{FRESHNESS_LABEL[freshness]}</span>
          </p>
          <p className="mt-0.5 text-slate-500">
            {point?.nowcast_method ? `${point.nowcast_method.replace(/_/g, ' ')} method` : 'Method unavailable'}
          </p>
          {point?.lower_bound != null && point?.upper_bound != null ? (
            <p className="mt-0.5 text-slate-500">
              Expected range: {Math.round(point.lower_bound)}–{Math.round(point.upper_bound)} µg/m³
            </p>
          ) : (
            <p className="mt-0.5 text-slate-400">Uncertainty range unavailable.</p>
          )}
          {point?.nowcast_backtest_passed === false && (
            <p className="mt-1 text-status-warning">Not yet validated for this ward — showing the conservative baseline.</p>
          )}
        </>
      )}
    </div>
  )
}
