import { AlertTriangle } from 'lucide-react'
import { useIngestHealth } from '../contexts/IngestHealthContext'
import { useCity } from '../lib/city'

export default function DegradedDataBanner() {
  const { health, readingDegraded, forecastDegraded } = useIngestHealth()
  const { map: cityMap } = useCity()
  // Ingest health reports Delhi's readings and forecast jobs; a map-first
  // city (Dhanbad–Jharia) has no forecast, so the banner would mislead there.
  if (cityMap.mapFirst) return null
  if (!readingDegraded && !forecastDegraded) return null

  const ageMin = health?.checks.reading_freshness.latest_reading_age_minutes
  const forecastFailed = health?.checks.jobs.forecast?.last_status === 'failed'

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-1 border-b border-status-warning/30 bg-status-warning/10 px-4 py-2"
    >
      {readingDegraded && (
        <div className="flex items-start gap-2 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
          <span>
            <strong>Live readings stale</strong>
            {ageMin != null ? ` — last reading ${Math.round(ageMin)} min ago` : ''}.{' '}
            Showing last-known raw values. Derived outputs (likely source, risk ranking) hidden.
          </span>
        </div>
      )}
      {forecastDegraded && (
        <div className="flex items-start gap-2 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
          <span>
            <strong>Forecast unavailable</strong>
            {forecastFailed ? ' — forecast job failed' : ' — forecast data is stale'}.{' '}
            Peak predictions and recommended actions hidden.
          </span>
        </div>
      )}
    </div>
  )
}
