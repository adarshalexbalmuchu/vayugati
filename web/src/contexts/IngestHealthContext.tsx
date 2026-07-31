import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { fetchIngestHealth, type IngestHealthResponse } from '../lib/ingestHealth'

interface IngestHealthCtx {
  health: IngestHealthResponse | null
  /**
   * True after the first fetch attempt has settled (success or failure).
   * False during the brief initial loading window — used by CommandView to
   * avoid suppressing derived outputs before the first health check completes
   * (prevents a flash where the page renders degraded-looking data for ~8s
   * then snaps to full data once health confirms fresh).
   */
  healthLoaded: boolean
  /** Confirmed not-ok — drives banner visibility only. Never true on "can't tell." */
  readingDegraded: boolean
  /** Confirmed not-ok — drives banner visibility only. Never true on "can't tell." */
  forecastDegraded: boolean
  /**
   * Confirmed ok — the only condition that disables suppression of derived
   * outputs (dominant_source, forecast peak, risk ranking). Everything else
   * — health=null after load, confirmed stale, endpoint unreachable — keeps
   * those outputs suppressed. Separating this from readingDegraded means a
   * failed health fetch (endpoint down) is treated as "unknown" (suppress),
   * not "ok" (show everything confidently).
   */
  readingConfirmedFresh: boolean
  /** Symmetric with readingConfirmedFresh for the forecast job. */
  forecastConfirmedFresh: boolean
}

const Ctx = createContext<IngestHealthCtx>({
  health: null,
  healthLoaded: false,
  readingDegraded: false,
  forecastDegraded: false,
  readingConfirmedFresh: false,
  forecastConfirmedFresh: false,
})

const POLL_MS = 5 * 60 * 1000

export function IngestHealthProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<IngestHealthResponse | null>(null)
  const [healthLoaded, setHealthLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      const h = await fetchIngestHealth()
      if (cancelled) return
      // On success: update health to the fresh response.
      // On failure (null): keep the last-known health state so a transient
      // 5-minute poll blip doesn't flip confirmed-fresh wards into suppressed
      // state. The first-load case is handled separately below.
      if (h !== null) setHealth(h)
      // Mark loaded after the first attempt regardless of success/failure, so
      // CommandView knows the initial uncertainty window has closed.
      setHealthLoaded(true)
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // Banner signals — only fire on confirmed not-ok. Never on "can't tell."
  const readingDegraded = health !== null && health.checks.reading_freshness.status !== 'ok'
  const forecastDegraded = health !== null && health.checks.jobs.forecast?.status !== 'ok'

  // Suppression signals — only disable suppression on confirmed ok. Everything
  // else (null, error, stale) leaves suppression active after healthLoaded=true.
  const readingConfirmedFresh = health !== null && health.checks.reading_freshness.status === 'ok'
  const forecastConfirmedFresh = health !== null && health.checks.jobs.forecast?.status === 'ok'

  return (
    <Ctx.Provider value={{ health, healthLoaded, readingDegraded, forecastDegraded, readingConfirmedFresh, forecastConfirmedFresh }}>
      {children}
    </Ctx.Provider>
  )
}

export function useIngestHealth() {
  return useContext(Ctx)
}
