import { useState } from 'react'
import { useAuth } from '../lib/auth'
import {
  DETECTION_STAGE_LABEL,
  FORECAST_DATA_QUALITY_LABEL,
  FORECAST_DISCLAIMER,
  FORECAST_METHOD_LABEL,
  POLLUTANT_LABEL,
  PREDICTION_METHOD_LABEL,
  describeTriggeredRule,
  forecastFallbackStatus,
  isHorizonValidated,
  resolveIncidentPollutant,
  sensorQualityCaveat,
  type ForecastDataQualityStatus,
  type ForecastMethod,
  type PredictionMethod,
} from '../lib/incidentRules'
import {
  confirmPredictedIncident,
  continueMonitoringPredictedIncident,
  dismissPredictedIncident,
  fetchForecastCurve,
  fetchLatestForecastRun,
  listStationsForWard,
  mergePredictedIncident,
  type IncidentDetail,
} from '../lib/incidents'
import { useAsync } from '../lib/useAsync'

/**
 * Automated anomaly-detection review (Phase 6). Shown only for an incident
 * that originated from `evaluate_station_pollutant_anomaly`
 * (`incident.detection_stage` set) — a citizen-reported or manually-created
 * incident never has this panel. Rendered inside the Summary tab's "What
 * should I do next?" section, alongside the general request-evidence/
 * route-to-authority actions.
 *
 * The rule engine itself lives entirely in SQL; the plain command review
 * actions (confirm / continue monitoring / dismiss / merge) stay visible by
 * default, but everything else this panel knows about the detection - the
 * raw facts, the forecast chart, triggered rules, nearby stations - sits
 * behind a collapsed <details> disclosure. It's real, checkable detail a
 * commander may want, not something that needs to compete for space with
 * the four questions the Summary tab is built around.
 */

function fmt(n: number | null, digits = 1): string {
  return n == null ? '-' : n.toFixed(digits)
}

function FactCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 p-2.5">
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">{title}</p>
      <dl className="space-y-1">{children}</dl>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right font-semibold text-slate-700">{children}</dd>
    </div>
  )
}

/** Peak of a forecast curve - shared by the chart and the header stat line
 *  above it, so the two numbers can never drift apart. */
function forecastPeak(
  points: { predicted_value: number | null }[],
): number | null {
  const values = points.map((p) => p.predicted_value).filter((v): v is number => v != null)
  return values.length > 0 ? Math.max(...values) : null
}

/** Compact inline-SVG forecast curve with an uncertainty band - no chart
 *  library, matching ForecastChart.tsx's own approach, generalised to any
 *  pollutant and to the Phase 8 lower/upper bound columns. Height trimmed
 *  (96 → 60) and the in-chart "peak Xµg/m³" text label dropped - that
 *  number now lives in the header stat line above instead, so the chart is
 *  supporting evidence for it rather than a second place it's repeated. */
function ForecastCurveChart({
  points,
  threshold,
}: {
  points: { horizon_ts: string; predicted_value: number | null; lower_bound: number | null; upper_bound: number | null }[]
  /** anomalyCandidates[0].threshold_used, when this incident originated from
   *  automated detection - drawn as a dashed reference line so "did the
   *  forecast cross the same line that triggered detection" reads directly
   *  off the chart instead of requiring a mental cross-reference against
   *  the facts card. */
  threshold: number | null
}) {
  const data = points.filter((p) => p.predicted_value != null) as (typeof points[number] & { predicted_value: number })[]
  if (data.length < 2) return <p className="text-xs text-slate-400">No forecast curve yet.</p>

  const W = 320
  const H = 60
  const pad = { top: 6, right: 8, bottom: 14, left: 32 }
  const innerW = W - pad.left - pad.right
  const innerH = H - pad.top - pad.bottom
  const maxV = Math.max(...data.map((p) => p.upper_bound ?? p.predicted_value), threshold ?? 0, 10)
  const x = (i: number) => pad.left + (i / (data.length - 1)) * innerW
  const y = (v: number) => pad.top + innerH - (Math.max(v, 0) / maxV) * innerH

  const line = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.predicted_value)}`).join(' ')
  const hasBand = data.every((p) => p.lower_bound != null && p.upper_bound != null)
  const band = hasBand
    ? `${data.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.upper_bound as number)}`).join(' ')} ${data
        .map((_p, i) => `L${x(data.length - 1 - i)},${y(data[data.length - 1 - i].lower_bound as number)}`)
        .join(' ')} Z`
    : null

  const peak = data.reduce((a, b) => (b.predicted_value > a.predicted_value ? b : a), data[0])

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Forecast curve">
      {band && <path d={band} fill="#7c3aed" fillOpacity={0.12} />}
      {threshold != null && (
        <line x1={pad.left} x2={W - pad.right} y1={y(threshold)} y2={y(threshold)} stroke="#dc2626" strokeWidth={1} strokeDasharray="3,2" />
      )}
      <path d={line} fill="none" stroke="#7c3aed" strokeWidth={1.5} />
      <circle cx={x(data.indexOf(peak))} cy={y(peak.predicted_value)} r={2.5} fill="#7c3aed" />
    </svg>
  )
}

export default function PredictedIncidentPanel({ detail, onRefresh }: { detail: IncidentDetail; onRefresh: () => void }) {
  const { session } = useAuth()
  const { incident, anomalyCandidates } = detail
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stations = useAsync(() => listStationsForWard(incident.ward_id as number), [incident.ward_id], {
    enabled: incident.ward_id != null,
  })

  const latest = anomalyCandidates[0] ?? null
  const pollutant = resolveIncidentPollutant(incident.primary_pollutant, latest?.pollutant ?? null)

  const forecastRun = useAsync(
    () => fetchLatestForecastRun(incident.ward_id as number, pollutant as string),
    [incident.ward_id, pollutant],
    { enabled: incident.ward_id != null && pollutant != null },
  )
  const forecastCurve = useAsync(
    () => fetchForecastCurve(incident.ward_id as number, pollutant as string),
    [incident.ward_id, pollutant],
    { enabled: incident.ward_id != null && pollutant != null },
  )

  if (incident.detection_stage == null) return null

  const nearbyStations = (stations.data ?? []).filter((s) => s.id !== latest?.station_id)
  const triggeredRules = (latest?.triggered_rules as string[] | null) ?? []
  const run = forecastRun.data
  const curveData = forecastCurve.data ?? []
  const peak = forecastPeak(curveData)
  const forecastHorizonHours =
    curveData.length >= 2
      ? Math.round(
          (new Date(curveData[curveData.length - 1].horizon_ts).getTime() - new Date(curveData[0].horizon_ts).getTime()) /
            3_600_000,
        )
      : null

  const act = async (fn: () => Promise<void>) => {
    if (!session) return
    setBusy(true)
    setError(null)
    try {
      await fn()
      onRefresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Action failed.')
    } finally {
      setBusy(false)
    }
  }

  const continueMonitoring = () => {
    if (!session) return
    void act(() => continueMonitoringPredictedIncident(incident.id, session.user.id))
  }

  const confirm = () => {
    if (!session) return
    void act(() => confirmPredictedIncident(incident.id, session.user.id))
  }

  const dismiss = () => {
    if (!session) return
    const reason = window.prompt('Why is this being dismissed as a data anomaly? (kept free of internal sensor detail)')
    if (!reason?.trim()) return
    void act(() => dismissPredictedIncident(incident.id, session.user.id, reason.trim()))
  }

  const merge = () => {
    if (!session) return
    const targetIdRaw = window.prompt('Incident # to merge this into:')
    const targetId = targetIdRaw ? Number(targetIdRaw) : NaN
    if (!Number.isFinite(targetId)) return
    void act(() => mergePredictedIncident(incident.id, targetId, session.user.id))
  }

  const isActionable = incident.status !== 'closed'

  return (
    <div className="mt-2">
      {isActionable && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <button type="button" disabled={busy} onClick={confirm} className="focus-ring font-semibold text-accent-700 hover:text-accent-800 disabled:opacity-50">
            Promote to active incident
          </button>
          <button type="button" disabled={busy} onClick={continueMonitoring} className="focus-ring text-slate-500 hover:text-slate-700 disabled:opacity-50">
            Continue monitoring
          </button>
          <button type="button" disabled={busy} onClick={dismiss} className="focus-ring text-slate-500 hover:text-slate-700 disabled:opacity-50">
            Dismiss as data anomaly
          </button>
          <button type="button" disabled={busy} onClick={merge} className="focus-ring text-slate-500 hover:text-slate-700 disabled:opacity-50">
            Merge with existing incident
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-status-critical">{error}</p>}

      <details className="mt-2 group">
        <summary className="focus-ring cursor-pointer list-none text-xs font-semibold text-slate-400 hover:text-slate-600">
          <span className="inline-flex items-center gap-1">
            Automated detection details ({DETECTION_STAGE_LABEL[incident.detection_stage]})
            <span className="transition group-open:rotate-90">›</span>
          </span>
        </summary>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <FactCard title="Detection details">
          <Fact label="Location">{incident.ward_name ?? 'Unknown ward'}</Fact>
          <Fact label="Pollutant">{pollutant ? POLLUTANT_LABEL[pollutant] : '-'}</Fact>
          <Fact label="Current concentration">{fmt(latest?.current_concentration ?? null)}</Fact>
          <Fact label="Rate of increase">{latest?.rate_of_increase != null ? `${fmt(latest.rate_of_increase)}/h` : '-'}</Fact>
          {latest?.prediction_method && (
            <Fact label="Prediction method">{PREDICTION_METHOD_LABEL[latest.prediction_method as PredictionMethod]}</Fact>
          )}
        </FactCard>
        <FactCard title="Threshold & confidence">
          <Fact label="Expected threshold crossing">
            {latest?.projected_crossing_at
              ? new Date(latest.projected_crossing_at).toLocaleString()
              : latest?.detection_stage === 'detected'
                ? 'Already crossed'
                : '-'}
          </Fact>
          <Fact label="Threshold used">{fmt(latest?.threshold_used ?? null)}</Fact>
          <Fact label="Data confidence">{latest?.confidence != null ? `${Math.round(latest.confidence * 100)}%` : '-'}</Fact>
          <Fact label="Sensor">
            {latest?.sensor_quality ?? '-'}
            {sensorQualityCaveat(latest?.sensor_quality ?? null) && (
              <span className="ml-1 font-normal text-slate-400">({sensorQualityCaveat(latest?.sensor_quality ?? null)})</span>
            )}
          </Fact>
        </FactCard>
        <FactCard title="Local context">
          <Fact label="Local excess">{fmt(latest?.local_excess ?? null)}</Fact>
          <Fact label="Classification">
            <span className="capitalize">{incident.classification ?? 'Not classified'}</span>
          </Fact>
          <Fact label="Assigned authority">{incident.assigned_authority ?? 'Not routed yet'}</Fact>
        </FactCard>
      </div>

      {latest?.prediction_method === 'validated_forecast' && run && run.method !== 'lightgbm' && (
        <p className="mt-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500">
          This incident was detected using a validated forecast at the time of detection. The Forecast card below
          shows the most recent forecast cycle, which now uses the baseline model instead - forecasts are
          revalidated every cycle and can change; this is not a contradiction.
        </p>
      )}

      {triggeredRules.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-semibold text-slate-600">Triggered detection rules</p>
          <ul className="mt-0.5 list-disc pl-4 text-[11px] text-slate-600">
            {triggeredRules.map((r) => (
              <li key={r}>{describeTriggeredRule(r)}</li>
            ))}
          </ul>
        </div>
      )}

      {nearbyStations.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-semibold text-slate-600">Nearby monitoring stations</p>
          <p className="mt-0.5 text-[11px] text-slate-500">{nearbyStations.map((s) => s.name).join(', ')}</p>
        </div>
      )}

      {run && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-semibold text-slate-700">
              {pollutant ? POLLUTANT_LABEL[pollutant] : ''} forecast
              {forecastHorizonHours != null && <span className="font-normal text-slate-400"> · next {forecastHorizonHours}h</span>}
            </p>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-500">{FORECAST_DISCLAIMER}</span>
          </div>

          {/* Honest header stats, not a fabricated confidence tier - the
              forecast has no single Low/Medium/High confidence value, only
              a validated-horizon boundary (see "Validated up to" below), so
              that's what stands in for confidence here too. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-600">
            {latest?.current_concentration != null && peak != null && (
              <span>
                Current <span className="font-semibold tabular-nums text-slate-800">{fmt(latest.current_concentration, 0)}</span>
                {' → '}
                Peak <span className="font-semibold tabular-nums text-slate-800">{fmt(peak, 0)}</span> µg/m³
              </span>
            )}
            {latest?.threshold_used != null && (
              <span>
                Threshold <span className="font-semibold tabular-nums text-slate-800">{fmt(latest.threshold_used, 0)}</span>
              </span>
            )}
          </div>

          <div className="mt-2">
            <ForecastCurveChart points={forecastCurve.data ?? []} threshold={latest?.threshold_used ?? null} />
          </div>

          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-3">
            <div>
              <dt className="text-slate-400">Method used</dt>
              <dd className="font-semibold text-slate-700">{FORECAST_METHOD_LABEL[run.method as ForecastMethod]}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Fallback status</dt>
              <dd className="font-semibold text-slate-700">{forecastFallbackStatus(run.method as ForecastMethod, run.beats_persistence)}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Validated up to</dt>
              <dd className="font-semibold text-slate-700">
                {run.max_validated_horizon_hours != null ? `${run.max_validated_horizon_hours}h` : 'Not yet validated'}
              </dd>
            </div>
          </dl>

          {run.validation_metrics && Object.keys(run.validation_metrics as object).length > 0 && (
            <div className="mt-2">
              <p className="text-[11px] font-semibold text-slate-600">Forecast error by horizon</p>
              <p className="text-[10px] text-slate-400">
                Compared against the strongest available simple baseline where validation data exists.
              </p>
              <div className="mt-1 flex flex-wrap gap-2">
                {Object.entries(
                  run.validation_metrics as Record<
                    string,
                    { mae: number; persistence_mae: number; beats_persistence: boolean; best_baseline?: string; best_baseline_mae?: number }
                  >,
                ).map(([h, m]) => (
                  <span
                    key={h}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      isHorizonValidated(run.max_validated_horizon_hours, Number(h))
                        ? 'bg-status-success/10 text-status-success'
                        : 'bg-slate-100 text-slate-500'
                    }`}
                    title={
                      m.best_baseline_mae != null
                        ? `Best baseline (${m.best_baseline ?? 'unknown'}) MAE ${m.best_baseline_mae}`
                        : `Persistence MAE ${m.persistence_mae}`
                    }
                  >
                    {h}h: MAE {m.mae}
                  </span>
                ))}
              </div>
            </div>
          )}

          {run.data_quality_status !== 'ok' && (
            <p className="mt-2 rounded-lg bg-status-warning/10 px-2 py-1 text-[11px] text-status-warning">
              {FORECAST_DATA_QUALITY_LABEL[run.data_quality_status as ForecastDataQualityStatus]}
            </p>
          )}
        </div>
      )}

      {anomalyCandidates.length > 1 && (
        <p className="mt-2 text-[11px] text-slate-400">{anomalyCandidates.length} detection signals recorded for this incident.</p>
      )}
      </details>
    </div>
  )
}
