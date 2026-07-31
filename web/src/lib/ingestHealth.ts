const INGEST_URL = (import.meta.env.VITE_INGEST_URL as string) || 'http://localhost:8000'

export interface IngestHealthJobCheck {
  status: 'ok' | 'stale' | 'error'
  last_status: string
  last_completed_at: string | null
}

export interface IngestHealthResponse {
  status: 'ok' | 'degraded'
  checks: {
    reading_freshness: {
      status: 'ok' | 'stale' | 'error'
      latest_reading_age_minutes: number | null
    }
    jobs: {
      forecast?: IngestHealthJobCheck
      ingest?: IngestHealthJobCheck
      attribution?: IngestHealthJobCheck
    }
  }
  last_run: {
    cpcb_rows_written: number
    openaq_rows_written: number
    stations_skipped_no_id: string[]
    readings_upserted: number
    finished_at: string | null
  } | null
}

export async function fetchIngestHealth(): Promise<IngestHealthResponse | null> {
  try {
    const res = await fetch(`${INGEST_URL}/health`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    return (await res.json()) as IngestHealthResponse
  } catch {
    return null
  }
}
