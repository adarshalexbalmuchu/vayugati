import { ChevronRight, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Attribution, VayuTraceAttribution, WardForecastSummary, WardSummary } from '../../lib/data'
import { confidenceTierLabel, forecastFallbackStatus, FORECAST_METHOD_LABEL, type ForecastMethod } from '../../lib/incidentRules'
import { hotspotStatus, HOTSPOT_STATUS_LABEL, type TimeWindowHours } from '../../lib/overviewRules'
import type { ActiveTaskDispatch, ForecastRunRow, Incident } from '../../lib/incidents'
import { MAP_POLLUTANT_LABEL, nowcastPoint, stationReadingValue, type MapPollutant, type MapTimeMode } from '../../lib/mapRules'
import { Skeleton } from '../ui'
import NowcastBlock from './NowcastBlock'
import WardEstimateBlock from './WardEstimateBlock'

const NEXT_ACTION: Record<string, string> = {
  severe: 'Dispatch verification - forecast to cross severe soon.',
  watch: 'Monitor closely - local excess is rising.',
  stable: 'No action needed - readings are within normal range.',
  no_data: 'No current or forecast data available for this ward.',
}

export default function SelectedWardPanel({
  ward,
  forecast,
  timeMode,
  pollutant,
  linkedIncidents,
  linkedDispatches,
  attribution,
  attributionLoading,
  vayuTraceAttribution,
  vayuTraceAttributionLoading,
  latestForecastRun,
  latestForecastRunLoading,
  onClose,
}: {
  ward: WardSummary
  forecast: WardForecastSummary | undefined
  timeMode: MapTimeMode
  pollutant: MapPollutant
  linkedIncidents: Incident[]
  linkedDispatches: ActiveTaskDispatch[]
  attribution: Attribution | null | undefined
  attributionLoading: boolean
  vayuTraceAttribution: VayuTraceAttribution | null | undefined
  vayuTraceAttributionLoading: boolean
  /** PM2.5's latest validation record for this ward - same table
   *  PredictedIncidentPanel.tsx reads, just surfaced here too so "is this
   *  forecast ML-validated or a conservative baseline fallback" is visible
   *  without leaving the Map. */
  latestForecastRun: ForecastRunRow | null | undefined
  latestForecastRunLoading: boolean
  onClose: () => void
}) {
  const reading = stationReadingValue(ward, pollutant)
  const windowHours: TimeWindowHours = 36
  const status = hotspotStatus(
    {
      hoursToSevere: forecast?.hoursToSevere ?? null,
      hoursToVeryPoor: forecast?.hoursToVeryPoor ?? null,
      peakExcess: forecast?.peakExcess ?? null,
      aqi: ward.aqi,
    },
    windowHours,
  )
  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Ward</p>
          <h2 className="text-sm font-semibold text-slate-800">{ward.name}</h2>
          {ward.station_name && (
            <p className="mt-0.5 text-[11px] text-slate-400">
              {ward.station_name}
              {ward.station_agency && (
                <span className="ml-1 rounded bg-slate-100 px-1 py-0.5 font-medium text-slate-500">
                  {ward.station_agency}
                </span>
              )}
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} className="focus-ring rounded p-1 text-slate-400 hover:bg-slate-100">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <div>
          <dt className="text-slate-400">{MAP_POLLUTANT_LABEL[pollutant]} now</dt>
          <dd className="font-semibold tabular-nums text-slate-800">{reading ?? 'Unavailable'}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Local excess</dt>
          <dd className="font-semibold tabular-nums text-slate-800">
            {forecast?.peakExcess != null ? `+${Math.round(forecast.peakExcess)} µg/m³` : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Forecast peak</dt>
          <dd className="font-semibold tabular-nums text-slate-800">
            {forecast?.peakPred != null ? `${Math.round(forecast.peakPred)} µg/m³` : 'Unavailable'}
          </dd>
        </div>
        <div>
          {/* Was a raw "{confidence * 100}%" from confidenceAtPeak(forecast)
              — that field is a hand-picked tier marker (0.4-0.9), not a
              calibrated probability, and this panel already has the honest
              version below ("PM2.5 forecast status", from
              latestForecastRun.beats_persistence) — this line was a second,
              inconsistent confidence signal sitting right next to the
              correct one. Replaced Sept 2026 to match. */}
          <dt className="text-slate-400">Forecast confidence</dt>
          <dd className="font-semibold text-slate-800">
            {latestForecastRun
              ? confidenceTierLabel(latestForecastRun.max_validated_horizon_hours, latestForecastRun.beats_persistence)
              : '—'}
          </dd>
        </div>
      </dl>

      <div className="mt-3">
        {/* Real hourly mean when one is fresh (readings_hourly); otherwise the
            CPCB values, labelled as the 24-hour averages they are (Sept 2026:
            CPCB's feed carries AQI-window averages only). One basis for the
            whole grid, never mixed per pollutant. */}
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          {(ward.hourly
            ? `Readings · hourly mean from ${new Date(ward.hourly.ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
            : ward.valueBasis === 'naqi_window' ? 'Readings · 24-hour averages (CPCB)' : 'Readings') +
            (() => {
              const t = ward.hourly?.ts ?? ward.ts
              const h = t ? (Date.now() - new Date(t).getTime()) / 3_600_000 : null
              return h != null && h > 3 ? ` · ${Math.round(h)} h old` : ''
            })()}
        </p>
        {ward.station_name ? (
          <dl className="mt-1 grid grid-cols-3 gap-x-2 gap-y-1.5 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px]">
            {(
              [
                { key: 'pm25', label: 'PM2.5', unit: 'µg/m³', value: (ward.hourly ?? ward).pm25 },
                { key: 'pm10', label: 'PM10', unit: 'µg/m³', value: (ward.hourly ?? ward).pm10 },
                { key: 'no2', label: 'NO₂', unit: 'µg/m³', value: (ward.hourly ?? ward).no2 },
                { key: 'so2', label: 'SO₂', unit: 'µg/m³', value: (ward.hourly ?? ward).so2 },
                { key: 'co', label: 'CO', unit: 'mg/m³', value: (ward.hourly ?? ward).co },
                { key: 'o3', label: 'O₃', unit: 'µg/m³', value: (ward.hourly ?? ward).o3 },
              ] as const
            ).map(({ key, label, unit, value }) => (
              <div key={key}>
                <dt className="text-slate-400">{label}</dt>
                <dd className="font-semibold tabular-nums text-slate-800">
                  {value != null ? value.toFixed(1) : <span className="font-normal text-slate-400">—</span>}
                </dd>
                <dd className="text-[10px] text-slate-400">{unit}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <>
            <p className="mt-1 text-xs text-slate-400">No monitoring station in this ward.</p>
            <WardEstimateBlock wardId={ward.id} />
          </>
        )}
      </div>

      <div className="mt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">PM2.5 forecast status</p>
        {latestForecastRunLoading ? (
          <Skeleton className="mt-1 h-10 w-full" />
        ) : latestForecastRun ? (
          (() => {
            const method: ForecastMethod = latestForecastRun.method === 'lightgbm' ? 'lightgbm' : 'diurnal_persistence'
            return (
              <div className="mt-1 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-600">
                <p className="font-semibold text-slate-800">{FORECAST_METHOD_LABEL[method]}</p>
                <p className="mt-0.5">{forecastFallbackStatus(method, latestForecastRun.beats_persistence)}</p>
                <p className="mt-1 text-slate-400">
                  Latest cycle: {new Date(latestForecastRun.generated_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                </p>
              </div>
            )
          })()
        ) : (
          <p className="mt-1 text-xs text-slate-400">No forecast validation record yet for this ward.</p>
        )}
      </div>

      <NowcastBlock timeMode={timeMode} point={nowcastPoint(forecast)} heading="+1h ward nowcast" />

      <div className="mt-3 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-600">
        <span className="font-semibold">Recommended next action:</span> {NEXT_ACTION[status]}
        <span className="ml-1 text-slate-400">({HOTSPOT_STATUS_LABEL[status]})</span>
      </div>

      <div className="mt-3">
        {/* Consolidated source attribution (Sept 2026) — this panel used to
            show three independent, unreconciled attribution signals with no
            cross-reference: ward.dominant_source ("Likely source", a
            rule-engine category) in the summary grid above, a wind-rose
            direction ("Upwind signal"), and the VayuTrace kernel's
            source-mix breakdown ("Estimated source mix") - each computed by
            a different backend process, sometimes visibly disagreeing (e.g.
            "Likely source: Unknown" next to "Industrial 100%"), with no
            indication they were even different methods. VayuTrace is now
            the single headline answer here (the most physically-grounded of
            the three - a real dispersion kernel, not a category lookup or a
            bare compass direction); the other two are named, minor
            supporting footnotes underneath rather than equal-weight
            sections competing for the same answer.

            Visual restructure (2nd pass, Sept 2026): three separate thin
            mini-bars with 11px labels made the split something you had to
            READ, not see - no single glance told you which category
            dominates. Replaced with one stacked proportional bar (a real
            part-to-whole visual, each segment's width IS its percentage)
            plus a legend row directly under it. Confidence/regional-
            transport/fire-index used to be three inconsistently-styled
            floating bits (a colored box, plain text, another colored box);
            now a single bordered "context" card holds all of it with one
            consistent treatment, so "primary result" (the bar) and
            "supporting context" (the card) are two visually distinct tiers
            instead of one flat stack of same-weight lines. */}
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Source attribution
        </p>
        {vayuTraceAttributionLoading ? (
          <Skeleton className="mt-1 h-16 w-full" />
        ) : vayuTraceAttribution?.breakdown ? (
          (() => {
            const b = vayuTraceAttribution.breakdown!
            const SEGMENTS = [
              { key: 'industrial' as const, label: 'Industrial', color: 'bg-orange-400', dot: 'bg-orange-400' },
              { key: 'road'       as const, label: 'Road traffic', color: 'bg-blue-400', dot: 'bg-blue-400' },
              // Dust added Sept 2026 (AP-42 road resuspension + WRAP
              // construction). Rows written before then have no `dust` key,
              // so it simply reads 0 rather than breaking.
              { key: 'dust'       as const, label: 'Dust', color: 'bg-amber-300', dot: 'bg-amber-300' },
              { key: 'fire'       as const, label: 'Fire / biomass', color: 'bg-red-400', dot: 'bg-red-400' },
            ] as const
            // Monte Carlo p10-p90 per source type. Shown next to every
            // percentage because the bands are WIDE (median dominant-source
            // width ~0.44 across Delhi) and a bare "75%" reads as far more
            // settled than the model can actually support.
            const bands = vayuTraceAttribution.breakdown_uncertainty
            const pcts = SEGMENTS.map((s) => {
              const band = bands?.[s.key]
              return {
                ...s,
                pct: Math.round(((b as Record<string, number>)[s.key] ?? 0) * 100),
                lo: band ? Math.round(band.p10 * 100) : null,
                hi: band ? Math.round(band.p90 * 100) : null,
              }
            })
            const nonZeroCount = pcts.filter((s) => s.pct > 0).length
            const hasFireAlert = vayuTraceAttribution.regional_fire_index != null && vayuTraceAttribution.regional_fire_index > 0.05

            return (
              <div className="mt-1.5">
                {/* One stacked bar — segment width IS the percentage, so the
                    dominant category is visible instantly, not something
                    you read three numbers to find. */}
                <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
                  {pcts.filter((s) => s.pct > 0).map((s) => (
                    <div
                      key={s.key}
                      className={`h-full ${s.color} first:rounded-l-full last:rounded-r-full`}
                      style={{ width: `${s.pct}%` }}
                      title={`${s.label}: ${s.pct}%`}
                    />
                  ))}
                </div>
                {/* Legend — one row per category (was a 3-column grid; at this
                    panel's real width "Road traffic"/"Fire / biomass" got
                    ellipsis-truncated to "Road traf…"/"Fire / bio…" — a
                    vertical stack always has room for the full label). */}
                <div className="mt-1.5 space-y-1">
                  {pcts.map((s) => (
                    <div key={s.key} className="flex items-center gap-1.5 text-[11px]">
                      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${s.dot}`} aria-hidden />
                      <span className="text-slate-500">{s.label}</span>
                      <span className="ml-auto tabular-nums font-semibold text-slate-800">{s.pct}%</span>
                      {s.lo != null && s.hi != null && (
                        <span
                          className="tabular-nums text-[10px] text-slate-400"
                          title="10th-90th percentile across Monte Carlo draws over the model's known input uncertainty"
                        >
                          ({s.lo}-{s.hi})
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Context card — every caveat/supporting fact about THIS
                    number lives in one consistently-styled block, instead
                    of a scattered mix of plain text and colored boxes. */}
                <div className="mt-2 space-y-1.5 rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-2">
                  {nonZeroCount <= 1 && (
                    // A single category reading 100% is a real, honest kernel
                    // output - it means the OTHER source inventories (roads,
                    // fires) had literally nothing to contribute today, not
                    // that this category is certainly the sole cause.
                    <p className="flex items-start gap-1.5 text-[10px] text-amber-700">
                      <span aria-hidden>⚠</span>
                      <span>
                        Only one source category had data for this estimate — treat {pcts.find((s) => s.pct > 0)?.pct ?? 100}%
                        as &quot;no other modelled source competed,&quot; not as certainty.
                      </span>
                    </p>
                  )}
                  {/* The ranges above are genuinely wide, so say why in
                      words rather than leaving a low "confidence %" to read
                      as though something is broken. The width is driven
                      almost entirely by emission-inventory uncertainty (no
                      local silt-loading measurements, no traffic counts, no
                      stack data) — not by the dispersion physics. */}
                  {vayuTraceAttribution.breakdown_uncertainty && (
                    <p className="text-[10px] leading-relaxed text-slate-500">
                      Ranges in brackets are 10th-90th percentile over the model's
                      known input uncertainty. They are wide because Delhi has no
                      local silt-loading or traffic-count measurements to constrain
                      emission strength — treat the split as indicative, not exact.
                    </p>
                  )}
                  <p className="text-[10px] leading-relaxed text-slate-500">
                    Model-based, not measured: checked against hourly monitor data it
                    ranks wards only weakly, and source shares are unverified without
                    chemical analysis. Use as a lead for field checks, not as a finding.
                  </p>
                  {vayuTraceAttribution.confidence != null && (
                    <p className="text-[10px] text-slate-500">
                      Split precision{' '}
                      <span className="font-semibold text-slate-700">
                        {vayuTraceAttribution.confidence >= 0.66 ? 'high' : vayuTraceAttribution.confidence >= 0.33 ? 'medium' : 'low'}
                      </span>
                      {' '}· how tight the dominant source's range is
                      {' '}· local excess only · forward model, not a measurement
                    </p>
                  )}
                  {vayuTraceAttribution.regional_fraction_prior != null && (
                    <p className="text-[10px] text-slate-500">
                      ~<span className="font-semibold text-slate-700">{Math.round(vayuTraceAttribution.regional_fraction_prior * 100)}%</span>
                      {' '}estimated regional/upwind transport (non-fire base + current fire activity) — not captured above
                    </p>
                  )}
                  {hasFireAlert && (
                    <p className="flex items-center gap-1.5 text-[10px] font-medium text-orange-700">
                      <span aria-hidden>{vayuTraceAttribution.regional_fire_index! >= 0.4 ? '🔥' : '⚠'}</span>
                      <span>
                        {vayuTraceAttribution.regional_fire_index! >= 0.4 ? 'Active burning episode' : 'Regional fire transport'}
                        {' '}<span className="tabular-nums text-orange-500">({Math.round(vayuTraceAttribution.regional_fire_index! * 100)}% index)</span>
                        {' '}— Punjab/Haryana/UP smoke detected upwind
                      </span>
                    </p>
                  )}
                </div>
              </div>
            )
          })()
        ) : (
          <p className="mt-1 text-xs text-slate-400">No source-mix estimate yet for this ward.</p>
        )}

        {/* Supporting signals — named by method so they read as two other
            perspectives on the same question, not competing final answers.
            Kept only as small footnotes; VayuTrace above is the headline. */}
        <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
          {attributionLoading ? (
            <Skeleton className="h-4 w-full" />
          ) : attribution ? (
            <p className="text-[10px] text-slate-400">
              <span className="font-medium text-slate-500">Wind-rose signal:</span> load arriving predominantly
              from the <span className="font-medium">{attribution.direction ?? 'unknown'}</span> sector
              {attribution.confidence != null && ` (${Math.round(attribution.confidence * 100)}% confidence)`} — a
              compass-direction signal, not a mapped plume.
            </p>
          ) : null}
          {ward.dominant_source && (
            <p className="text-[10px] text-slate-400">
              <span className="font-medium text-slate-500">Rule-based category:</span>{' '}
              {ward.dominant_source.replace(/_/g, ' ')}
            </p>
          )}
        </div>
      </div>

      <div className="mt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Linked incidents ({linkedIncidents.length})
        </p>
        {linkedIncidents.length === 0 ? (
          <p className="mt-1 text-xs text-slate-400">None open.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {linkedIncidents.slice(0, 5).map((i) => (
              <li key={i.id}>
                <Link
                  to={`/incidents?incident=${i.id}`}
                  className="focus-ring flex items-center gap-1 rounded text-xs text-accent-700 hover:underline"
                >
                  <ChevronRight className="h-3 w-3 flex-shrink-0" aria-hidden />
                  <span className="truncate">{i.summary ?? `Incident #${i.id}`}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Linked tasks ({linkedDispatches.length})
        </p>
        {linkedDispatches.length === 0 ? (
          <p className="mt-1 text-xs text-slate-400">No active dispatches.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-xs text-slate-600">
            {linkedDispatches.slice(0, 5).map((d) => (
              <li key={d.id} className="truncate">
                {d.incident_summary ?? `Dispatch #${d.id}`} · <span className="capitalize">{d.status.replace(/_/g, ' ')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
