/**
 * A small, always-visible set of choices - every option and what it means
 * is on screen at once, nothing needs a click to discover. Replaces native
 * <select> for the handful of places in the incident workflow (mission
 * type, officer/reporter assignment) where the option count is small
 * enough that hiding it behind a dropdown costs more in discoverability
 * than it saves in space - "what all things do we have" should be
 * answerable by looking, not by opening something first.
 */
export default function OptionPicker<T extends string>({
  options,
  value,
  onChange,
  emptyMessage,
}: {
  options: { value: T; label: string; description?: string }[]
  value: T | ''
  onChange: (v: T) => void
  emptyMessage?: string
}) {
  if (options.length === 0) {
    return (
      <p className="mt-1 rounded-lg bg-status-warning/10 px-2.5 py-2 text-xs text-slate-600">
        {emptyMessage ?? 'Nothing available.'}
      </p>
    )
  }
  return (
    <div className="mt-1 space-y-1">
      {options.map((opt) => {
        const selected = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={selected}
            className={`focus-ring flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition ${
              selected ? 'border-accent-600 bg-accent-50' : 'border-slate-200 hover:bg-slate-50'
            }`}
          >
            <span
              className={`mt-0.5 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border-2 ${
                selected ? 'border-accent-600' : 'border-slate-300'
              }`}
              aria-hidden
            >
              {selected && <span className="h-1.5 w-1.5 rounded-full bg-accent-600" />}
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-slate-800">{opt.label}</span>
              {opt.description && <span className="block text-[11px] text-slate-400">{opt.description}</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}
