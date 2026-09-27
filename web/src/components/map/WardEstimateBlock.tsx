import { fetchWardEstimates, type WardEstimate } from '../../lib/data'
import { useAsync } from '../../lib/useAsync'
import { Skeleton } from '../ui'

/** CPCB NAQI 24h breakpoints (µg/m³), for naming the band an estimate falls in. */
const BANDS: Record<WardEstimate['pollutant'], { label: string; breaks: number[] }> = {
  pm25: { label: 'PM2.5', breaks: [30, 60, 90, 120, 250] },
  no2: { label: 'NO₂', breaks: [40, 80, 180, 280, 400] },
}
const BAND_NAMES = ['Good', 'Satisfactory', 'Moderate', 'Poor', 'Very Poor', 'Severe']
const BAND_COLORS = ['#55a84f', '#a3c853', '#fff833', '#f29c2b', '#e93f33', '#af2d24']

function bandOf(v: number, breaks: number[]): number {
  const i = breaks.findIndex((b) => v <= b)
  return i === -1 ? breaks.length : i
}

/** Validated accuracy of a daily estimate at an unmonitored spot inside a
 *  monitored city (2 km-group cross-validation on Indo-Gangetic-plain
 *  monitors, Sept 2026; see ingest/scripts/species/export_ward_model.py). */
const VALIDATION: Record<WardEstimate['pollutant'], string> = {
  pm25: 'R² 0.72, typical error ±16 µg/m³',
  no2: 'R² 0.35, typical error ±11 µg/m³',
}

/** Model estimate of 24h PM2.5 and NO₂ for a ward, mainly for the wards with
 *  no monitor. Always labelled as an estimate, with its honest 90% range and
 *  the date its 24h window ended (an upstream outage shows an older date,
 *  never a stale value presented as current). */
export default function WardEstimateBlock({ wardId, title = 'Estimated air quality (24 h)' }: { wardId: number; title?: string }) {
  const state = useAsync(() => fetchWardEstimates(wardId), [wardId], { cacheKey: `ward-estimates:${wardId}` })
  const rows = state.data ?? []

  return (
    <div className="mt-1">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{title}</p>
      {state.loading ? (
        <Skeleton className="mt-1 h-16 w-full" />
      ) : rows.length === 0 ? (
        <p className="mt-1 text-xs text-slate-400">No estimate available yet for this ward.</p>
      ) : (
        <div className="mt-1 space-y-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-2.5 py-2">
          {rows.map((r) => {
            const cfg = BANDS[r.pollutant]
            const b = bandOf(r.estimate, cfg.breaks)
            const lo = bandOf(r.lower_90, cfg.breaks)
            const hi = bandOf(r.upper_90, cfg.breaks)
            const max = Math.max(cfg.breaks[3], r.upper_90) * 1.05
            const pct = (v: number) => `${Math.min(100, (v / max) * 100)}%`
            return (
              <div key={r.pollutant}>
                <div className="flex items-baseline justify-between text-[11px]">
                  <span className="font-semibold text-slate-700">{cfg.label}</span>
                  <span className="tabular-nums text-slate-800">
                    <span className="font-bold">~{Math.round(r.estimate)}</span>
                    <span className="text-slate-400"> µg/m³ · range {Math.round(r.lower_90)}–{Math.round(r.upper_90)}</span>
                  </span>
                </div>
                <div className="relative mt-1 h-1.5 rounded-full bg-slate-200" aria-hidden>
                  <div className="absolute h-1.5 rounded-full opacity-60"
                       style={{ left: pct(r.lower_90), width: `calc(${pct(r.upper_90)} - ${pct(r.lower_90)})`, backgroundColor: BAND_COLORS[b] }} />
                  <div className="absolute -top-0.5 h-2.5 w-0.5 rounded bg-slate-700" style={{ left: pct(r.estimate) }} />
                </div>
                <p className="mt-0.5 text-[10px] text-slate-500">
                  Likely {BAND_NAMES[b]}
                  {lo !== hi ? ` (could be ${BAND_NAMES[lo]} to ${BAND_NAMES[hi]})` : ''} · {VALIDATION[r.pollutant]}
                </p>
              </div>
            )
          })}
          <p className="text-[10px] leading-snug text-slate-400">
            Model estimate, not a measurement: live network average ({rows[0].n_stations} stations) × this ward's usual
            ratio from roads, satellite NO₂, population, built-up area{rows.some((r) => r.pollutant === 'pm25') ? ' and power plants (PM2.5)' : ''}.
            90% range. 24 h ending {new Date(rows[0].window_end).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.
          </p>
        </div>
      )}
    </div>
  )
}
