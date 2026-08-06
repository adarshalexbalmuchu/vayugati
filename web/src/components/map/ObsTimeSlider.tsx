import { Loader2 } from 'lucide-react'
import { OBS_SLOT_LABEL, OBS_SLOTS, type ObsSlot } from '../../lib/mapRules'

const SLOT_INDEX: Record<ObsSlot, number> = {
  'now': 0,
  '-3h': 1,
  '-6h': 2,
  '-12h': 3,
  '-24h': 4,
}

export default function ObsTimeSlider({
  value,
  onChange,
  loading = false,
}: {
  value: ObsSlot
  onChange: (s: ObsSlot) => void
  loading?: boolean
}) {
  const isHistorical = value !== 'now'
  const idx = SLOT_INDEX[value]

  return (
    <div className="flex items-center gap-3 border-t border-slate-100 bg-slate-50 px-4 py-2">
      {/* Label */}
      <div className="flex w-28 flex-shrink-0 items-center gap-1.5">
        <span className="text-[11px] font-semibold text-slate-500">Obs. time</span>
        {isHistorical && (
          <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-bold text-amber-700">
            Historical
          </span>
        )}
        {loading && <Loader2 className="h-3 w-3 animate-spin text-slate-400" aria-hidden />}
      </div>

      {/* Slider track + labels */}
      <div className="relative flex-1">
        <input
          type="range"
          min={0}
          max={OBS_SLOTS.length - 1}
          step={1}
          value={idx}
          onChange={(e) => onChange(OBS_SLOTS[Number(e.target.value)])}
          className="obs-slider w-full cursor-pointer"
          aria-label="Observation time"
          aria-valuetext={OBS_SLOT_LABEL[value]}
        />
        {/* Tick labels */}
        <div className="mt-0.5 flex justify-between">
          {OBS_SLOTS.map((s) => (
            <span
              key={s}
              className={`text-[10px] font-medium ${s === value ? 'text-accent-600' : 'text-slate-400'}`}
              style={{ width: `${100 / (OBS_SLOTS.length - 1)}%`, textAlign: 'center', transform: s === 'now' ? 'translateX(-25%)' : s === '-24h' ? 'translateX(25%)' : undefined }}
            >
              {OBS_SLOT_LABEL[s]}
            </span>
          ))}
        </div>
      </div>

      {/* Selected label */}
      <div className="w-10 flex-shrink-0 text-right">
        <span className={`text-xs font-semibold ${isHistorical ? 'text-amber-700' : 'text-slate-700'}`}>
          {OBS_SLOT_LABEL[value]}
        </span>
      </div>
    </div>
  )
}
