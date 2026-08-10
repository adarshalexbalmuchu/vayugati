import { Loader2 } from 'lucide-react'
import { OBS_SLOT_LABEL, OBS_SLOTS, type ObsSlot, type ObsViewMode } from '../../lib/mapRules'

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
  obsViewMode,
  onObsViewModeChange,
}: {
  value: ObsSlot
  onChange: (s: ObsSlot) => void
  loading?: boolean
  obsViewMode: ObsViewMode
  onObsViewModeChange: (m: ObsViewMode) => void
}) {
  const isHistorical = value !== 'now'
  const idx = SLOT_INDEX[value]

  return (
    <div className="border-t border-slate-100 bg-slate-50 px-4 py-2">
      <div className="flex items-center gap-3">
        {/* Label */}
        <div className="flex w-28 flex-shrink-0 items-center gap-1.5">
          <span className="text-[11px] font-semibold text-slate-500">Obs. time</span>
          {isHistorical && (
            <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-bold text-amber-700">
              {obsViewMode === 'change' ? 'Change' : 'Historical'}
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
          {/* Tick labels — absolutely positioned so centres land exactly under thumb stops */}
          <div className="relative mt-0.5 h-4">
            {OBS_SLOTS.map((s, i) => {
              const pct = (i / (OBS_SLOTS.length - 1)) * 100
              const isFirst = i === 0
              const isLast = i === OBS_SLOTS.length - 1
              return (
                <span
                  key={s}
                  className={`absolute whitespace-nowrap text-[10px] font-medium ${s === value ? 'text-accent-600' : 'text-slate-400'}`}
                  style={{
                    left: isLast ? undefined : `${pct}%`,
                    right: isLast ? '0' : undefined,
                    transform: !isFirst && !isLast ? 'translateX(-50%)' : undefined,
                  }}
                >
                  {OBS_SLOT_LABEL[s]}
                </span>
              )
            })}
          </div>
        </div>

        {/* Selected label */}
        <div className="w-10 flex-shrink-0 text-right">
          <span className={`text-xs font-semibold ${isHistorical ? 'text-amber-700' : 'text-slate-700'}`}>
            {OBS_SLOT_LABEL[value]}
          </span>
        </div>
      </div>

      {/* Snapshot / Change toggle — only meaningful when a historical slot is active */}
      {isHistorical && (
        <div className="mt-1.5 flex items-center gap-2">
          <span className="w-28 flex-shrink-0 text-[10px] text-slate-400">View mode</span>
          <div className="flex items-center gap-0.5 rounded-md border border-slate-200 bg-white p-0.5">
            {(['snapshot', 'change'] as ObsViewMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onObsViewModeChange(m)}
                className={`focus-ring rounded px-2 py-0.5 text-[10px] font-semibold transition ${
                  obsViewMode === m
                    ? 'bg-accent-500 text-white'
                    : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                {m === 'snapshot' ? 'Snapshot' : 'Change vs Now'}
              </button>
            ))}
          </div>
          {obsViewMode === 'change' && (
            <span className="text-[10px] text-slate-500">
              {OBS_SLOT_LABEL[value]} → Now
            </span>
          )}
        </div>
      )}
    </div>
  )
}
