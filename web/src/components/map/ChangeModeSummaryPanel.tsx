import {
  CHANGE_DIRECTION_ARROW,
  CHANGE_DIRECTION_HEX,
  CHANGE_DIRECTION_LABEL,
  changeMarkerBadge,
  OBS_SLOT_LABEL,
  type ChangeDirection,
  type MapPollutant,
  type ObsSlot,
} from '../../lib/mapRules'
import { MAP_POLLUTANT_LABEL } from '../../lib/mapRules'

export interface ChangeRow {
  stationId: number
  stationName: string
  delta: number | null
  direction: ChangeDirection | null
}

function Kpi({ label, value, color, muted }: { label: string; value: string; color?: string; muted?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-50 px-2.5 py-2">
      <p className="text-[10px] text-slate-400">{label}</p>
      <p className="text-base font-bold tabular-nums" style={{ color: color ?? (muted ? '#9ca3af' : '#1e293b') }}>
        {value}
      </p>
    </div>
  )
}

export default function ChangeModeSummaryPanel({
  obsSlot,
  pollutant,
  rows,
}: {
  obsSlot: ObsSlot
  pollutant: MapPollutant
  rows: ChangeRow[]
}) {
  const slotLabel = OBS_SLOT_LABEL[obsSlot]
  const pollutantLabel = MAP_POLLUTANT_LABEL[pollutant]

  const compared = rows.filter((r) => r.direction != null)
  const worsened = compared.filter((r) => r.direction === 'worsening' || r.direction === 'strong_worsening')
  const stable = compared.filter((r) => r.direction === 'stable')
  const improved = compared.filter((r) => r.direction === 'improving' || r.direction === 'strong_improving')
  const missing = rows.filter((r) => r.direction == null)

  const largestDet = worsened.reduce<ChangeRow | null>((best, r) => {
    if (!best || (r.delta ?? -Infinity) > (best.delta ?? -Infinity)) return r
    return best
  }, null)

  const largestImp = improved.reduce<ChangeRow | null>((best, r) => {
    if (!best || (r.delta ?? Infinity) < (best.delta ?? Infinity)) return r
    return best
  }, null)

  return (
    <div className="p-4">
      <div className="mb-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Change summary</p>
        <h2 className="text-sm font-semibold text-slate-800">
          {slotLabel} → Now
        </h2>
        <p className="mt-0.5 text-[11px] text-slate-400">
          {pollutantLabel} · verified station readings only
        </p>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2">
        <Kpi label="Stations compared" value={String(compared.length)} />
        <Kpi label="No comparison" value={String(missing.length)} muted />
        <Kpi label="Worsened" value={String(worsened.length)} color="#f97316" />
        <Kpi label="Stable" value={String(stable.length)} color="#6b7280" />
        <Kpi label="Improved" value={String(improved.length)} color="#22c55e" />
      </div>

      {largestDet && (
        <div className="mb-2 rounded-lg bg-red-50 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-red-400">Largest deterioration</p>
          <p className="mt-0.5 text-xs font-semibold text-red-700">{largestDet.stationName}</p>
          <p className="text-[11px] text-red-600">
            {changeMarkerBadge(largestDet.delta, largestDet.direction)} {pollutantLabel}
          </p>
        </div>
      )}

      {largestImp && (
        <div className="mb-3 rounded-lg bg-green-50 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-green-600">Largest improvement</p>
          <p className="mt-0.5 text-xs font-semibold text-green-700">{largestImp.stationName}</p>
          <p className="text-[11px] text-green-600">
            {changeMarkerBadge(largestImp.delta, largestImp.direction)} {pollutantLabel}
          </p>
        </div>
      )}

      {/* Change direction legend */}
      <div className="border-t border-slate-100 pt-3">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Legend</p>
        {(['strong_worsening', 'worsening', 'stable', 'improving', 'strong_improving'] as ChangeDirection[]).map((d) => (
          <div key={d} className="mb-1 flex items-center gap-1.5">
            <span
              style={{ color: CHANGE_DIRECTION_HEX[d], width: 20, textAlign: 'center' }}
              className="flex-shrink-0 text-xs font-bold"
            >
              {CHANGE_DIRECTION_ARROW[d]}
            </span>
            <span className="text-[11px] text-slate-600">{CHANGE_DIRECTION_LABEL[d]}</span>
          </div>
        ))}
        <div className="mb-1 flex items-center gap-1.5">
          <span style={{ width: 20, textAlign: 'center' }} className="flex-shrink-0 text-xs font-bold text-slate-400">
            —
          </span>
          <span className="text-[11px] text-slate-500">No comparable data</span>
        </div>
      </div>

      <p className="mt-3 text-[10px] text-slate-400">
        Incidents shown are current operational records. Air-quality markers represent the {slotLabel} → Now comparison period.
      </p>
    </div>
  )
}
