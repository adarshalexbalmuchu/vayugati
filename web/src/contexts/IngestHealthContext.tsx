import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { fetchIngestHealth, type IngestHealthResponse } from '../lib/ingestHealth'

interface IngestHealthCtx {
  health: IngestHealthResponse | null
  /** True only when health data has loaded AND reading freshness is not ok. */
  readingDegraded: boolean
  /** True only when health data has loaded AND the forecast job is not ok. */
  forecastDegraded: boolean
}

const Ctx = createContext<IngestHealthCtx>({
  health: null,
  readingDegraded: false,
  forecastDegraded: false,
})

const POLL_MS = 5 * 60 * 1000

export function IngestHealthProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<IngestHealthResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      const h = await fetchIngestHealth()
      if (!cancelled) setHealth(h)
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // Stay silent (false) when health is null — either still loading or the
  // endpoint is unreachable (VITE_INGEST_URL not configured). The banner
  // only fires on confirmed-degraded signals, never on "can't tell."
  const readingDegraded = health !== null && health.checks.reading_freshness.status !== 'ok'
  const forecastDegraded = health !== null && health.checks.jobs.forecast?.status !== 'ok'

  return (
    <Ctx.Provider value={{ health, readingDegraded, forecastDegraded }}>
      {children}
    </Ctx.Provider>
  )
}

export function useIngestHealth() {
  return useContext(Ctx)
}
