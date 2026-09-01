import { useCallback, useEffect, useRef, useState } from 'react'

// Module-level — survives a component unmounting (e.g. navigating away to
// another sidebar page) as long as the page itself isn't hard-reloaded.
// Keyed by the caller-supplied cacheKey; unrelated to React state/lifecycle
// on purpose, so returning to a page can seed from it before the first
// render even happens.
const cache = new Map<string, { data: unknown; fetchedAt: number }>()

export interface AsyncState<T> {
  data: T | null
  error: string | null
  /** True only on the FIRST load. A refresh keeps the old data visible instead. */
  loading: boolean
  /** True while a refresh runs over data that is already on screen. */
  refreshing: boolean
  /** True when the data on screen is older than `staleAfterMs`. */
  stale: boolean
  fetchedAt: number | null
  refresh: () => void
}

/**
 * Run an async loader and expose the states the product plan requires
 * explicitly: loading, error, empty (data === [] — the caller's call), and
 * stale.
 *
 * Three deliberate behaviours:
 *  - a refresh does NOT clear `data`, so the workspace doesn't flash empty
 *    every poll; `refreshing` covers that case instead of `loading`.
 *  - a failed refresh keeps the last good data AND sets `error`, so the UI can
 *    show stale-but-real data with a warning rather than throwing it away.
 *    Silently showing old data as if it were fresh is the thing to avoid.
 *  - passing `cacheKey` seeds `data`/`fetchedAt` from the last result fetched
 *    under that key, so navigating back to a page you already visited shows
 *    the last-known view on the very first render (loading=false) instead of
 *    a blank skeleton, while a real fetch still runs in the background
 *    (refreshing=true) and replaces it the moment fresh data lands. Without a
 *    cacheKey, behaviour is unchanged from before this option existed.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[],
  options: { staleAfterMs?: number; enabled?: boolean; cacheKey?: string } = {},
): AsyncState<T> {
  const { staleAfterMs = 120_000, enabled = true, cacheKey } = options
  const cached = cacheKey ? (cache.get(cacheKey) as { data: T; fetchedAt: number } | undefined) : undefined

  const [data, setData] = useState<T | null>(cached?.data ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(enabled && !cached)
  const [refreshing, setRefreshing] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<number | null>(cached?.fetchedAt ?? null)
  const [tick, setTick] = useState(0)

  // Guards against a slow earlier request landing after a newer one.
  const runId = useRef(0)
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  const run = useCallback(async () => {
    const id = ++runId.current
    setData((prev) => {
      if (prev === null) setLoading(true)
      else setRefreshing(true)
      return prev
    })
    try {
      const result = await loaderRef.current()
      if (id !== runId.current) return
      setData(result)
      setError(null)
      const now = Date.now()
      setFetchedAt(now)
      if (cacheKey) cache.set(cacheKey, { data: result, fetchedAt: now })
    } catch (e) {
      if (id !== runId.current) return
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      if (id === runId.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [cacheKey])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    void run()
    // `deps` is the caller's dependency list; `run` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, run, ...deps])

  // Re-render periodically so `stale` flips on its own rather than only when
  // something else happens to re-render the tree.
  useEffect(() => {
    if (fetchedAt == null) return
    const t = setInterval(() => setTick((v) => v + 1), 30_000)
    return () => clearInterval(t)
  }, [fetchedAt])

  const stale = fetchedAt != null && Date.now() - fetchedAt > staleAfterMs
  void tick

  return { data, error, loading, refreshing, stale, fetchedAt, refresh: () => void run() }
}
