import { useSyncExternalStore } from 'react'

/** The district open on the Jharkhand map (null: the whole state). The map sets it; the header weather reads it. */
let selected: string | null = null
const listeners = new Set<() => void>()

export function setSelectedDistrict(name: string | null): void {
  if (name === selected) return
  selected = name
  listeners.forEach((f) => f())
}

export function useSelectedDistrict(): string | null {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f)
      return () => listeners.delete(f)
    },
    () => selected,
  )
}
