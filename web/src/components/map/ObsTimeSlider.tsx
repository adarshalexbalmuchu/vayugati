import { useEffect, useRef, useState } from 'react'
import { Loader2, Pause, Play } from 'lucide-react'
import { OBS_SLOT_LABEL, OBS_SLOTS, type ObsSlot, type ObsViewMode } from '../../lib/mapRules'

const SLOT_INDEX: Record<ObsSlot, number> = {
  'now': 0,
  '-3h': 1,
  '-6h': 2,
  '-12h': 3,
  '-24h': 4,
}

// Chronological playback order (oldest -> newest) - Play reads as "watch
// pollution evolve forward in time toward Now", not backward. Reuses the
// exact same onChange/fetch pipeline manual slider dragging already goes
// through; this is purely "drive the existing control automatically".
const PLAYBACK_ORDER: ObsSlot[] = [...OBS_SLOTS].reverse()
const PLAYBACK_INTERVAL_MS = 1800

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

  const [isPlaying, setIsPlaying] = useState(false)
  // Interval tick reads the latest value via ref rather than closing over
  // the prop directly - otherwise a stale closure from when the interval
  // was created would always compute "next" from the ORIGINAL value, not
  // wherever onChange has since moved playback to.
  const valueRef = useRef(value)
  useEffect(() => { valueRef.current = value }, [value])

  useEffect(() => {
    if (!isPlaying) return
    const id = window.setInterval(() => {
      const currentIdx = PLAYBACK_ORDER.indexOf(valueRef.current)
      const nextIdx = currentIdx + 1
      if (nextIdx >= PLAYBACK_ORDER.length) {
        setIsPlaying(false) // reached Now - stop rather than loop
        return
      }
      onChange(PLAYBACK_ORDER[nextIdx])
    }, PLAYBACK_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [isPlaying, onChange])

  const togglePlay = () => {
    if (!isPlaying) {
      if (value === 'now') {
        // Starting from the end of the sequence - restart from the oldest
        // slot so Play always has somewhere to go, matching how a video
        // "replay" button behaves rather than doing nothing.
        onChange(PLAYBACK_ORDER[0])
      }
      // Raw absolute AQI numbers across ~40+ markers are unreadable frame to
      // frame - "Change vs Now" shows a colored delta per marker instead, the
      // only way this animation is actually perceptible. Reverts to Snapshot
      // automatically once playback reaches Now (MapPage.tsx's existing
      // obsSlot==='now' effect already does this).
      onObsViewModeChange('change')
    }
    setIsPlaying((v) => !v)
  }

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

        {/* Play/pause - animates through Obs. time so pollution movement over
            the last 24h is watchable, not just inspectable one slot at a time. */}
        <button
          type="button"
          onClick={togglePlay}
          title={isPlaying ? 'Pause' : 'Play — watch pollution move through the last 24h'}
          className="focus-ring flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          {isPlaying ? <Pause className="h-3 w-3" aria-hidden /> : <Play className="h-3 w-3" aria-hidden />}
        </button>

        {/* Slider track + labels */}
        <div className="relative flex-1">
          <input
            type="range"
            min={0}
            max={OBS_SLOTS.length - 1}
            step={1}
            value={idx}
            onChange={(e) => {
              setIsPlaying(false) // manual scrub takes over from playback
              onChange(OBS_SLOTS[Number(e.target.value)])
            }}
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
