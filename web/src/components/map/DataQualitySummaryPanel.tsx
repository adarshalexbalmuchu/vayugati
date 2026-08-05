import { Activity, AlertTriangle, MapPin } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  FRESHNESS_HEX,
  FRESHNESS_LABEL,
  NEARBY_COVERAGE_THRESHOLD_METERS,
  WARD_COVERAGE_HEX,
  WARD_COVERAGE_LABEL,
  type FreshnessClass,
  type IncidentCoordinateAudit,
  type StationQualityRollup,
  type WardCoverageClass,
} from '../../lib/dataQualityRules'

function FreshnessDot({ cls }: { cls: FreshnessClass }) {
  return (
    <span
      className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
      style={{ background: FRESHNESS_HEX[cls] }}
      aria-hidden
    />
  )
}

function CoverageDot({ cls }: { cls: WardCoverageClass }) {
  return (
    <span
      className="inline-block h-2 w-2 flex-shrink-0 rounded-sm"
      style={{ background: WARD_COVERAGE_HEX[cls] }}
      aria-hidden
    />
  )
}

function Row({ label, value, dim }: { label: string; value: number | string; dim?: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className={dim ? 'text-slate-400' : 'text-slate-600'}>{label}</span>
      <span className={`tabular-nums font-semibold ${dim ? 'text-slate-400' : 'text-slate-800'}`}>{value}</span>
    </div>
  )
}

export default function DataQualitySummaryPanel({
  stationQuality,
  wardCoverage,
  incidentAudit,
}: {
  stationQuality: StationQualityRollup
  /** Count of ward-boundary records in each coverage class. */
  wardCoverage: Record<WardCoverageClass, number>
  incidentAudit: IncidentCoordinateAudit
}) {
  const thresholdKm = (NEARBY_COVERAGE_THRESHOLD_METERS / 1000).toFixed(0)

  const latestStr = stationQuality.latestActiveReadingAt
    ? new Date(stationQuality.latestActiveReadingAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : '—'

  const oldestStr = stationQuality.oldestActiveReadingAt
    ? new Date(stationQuality.oldestActiveReadingAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : '—'

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-1.5">
        <Activity className="h-4 w-4 text-accent-600" strokeWidth={2} aria-hidden />
        <h2 className="text-sm font-semibold text-slate-800">Data Quality</h2>
      </div>
      <p className="mb-4 text-xs text-slate-400">Select a station or ward for coverage detail.</p>

      {/* Station freshness */}
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        AQ stations · {stationQuality.total} total
      </p>
      <div className="mb-3 space-y-1 rounded-lg bg-slate-50 px-3 py-2">
        {(['fresh', 'delayed', 'stale', 'no_reading', 'unavailable'] as FreshnessClass[]).map((cls) => {
          const count =
            cls === 'fresh' ? stationQuality.fresh
            : cls === 'delayed' ? stationQuality.delayed
            : cls === 'stale' ? stationQuality.stale
            : cls === 'no_reading' ? stationQuality.noReading
            : stationQuality.unavailable
          return (
            <div key={cls} className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-slate-600">
                <FreshnessDot cls={cls} />
                {FRESHNESS_LABEL[cls]}
              </span>
              <span className={`tabular-nums font-semibold ${count === 0 ? 'text-slate-300' : 'text-slate-800'}`}>{count}</span>
            </div>
          )
        })}
      </div>

      <div className="mb-3 space-y-1 text-[11px] text-slate-500">
        <div className="flex justify-between">
          <span>Latest valid observation</span>
          <span className="font-semibold text-slate-700">{latestStr}</span>
        </div>
        <div className="flex justify-between">
          <span>Oldest active station reading</span>
          <span className="font-semibold text-slate-700">{oldestStr}</span>
        </div>
      </div>

      {/* Ward coverage */}
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        Ward monitoring coverage
      </p>
      <div className="mb-1 space-y-1 rounded-lg bg-slate-50 px-3 py-2">
        {(['direct', 'nearby', 'insufficient', 'unavailable'] as WardCoverageClass[]).map((cls) => (
          <div key={cls} className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-slate-600">
              <CoverageDot cls={cls} />
              {WARD_COVERAGE_LABEL[cls]}
            </span>
            <span className={`tabular-nums font-semibold ${wardCoverage[cls] === 0 ? 'text-slate-300' : 'text-slate-800'}`}>
              {wardCoverage[cls]}
            </span>
          </div>
        ))}
      </div>
      <p className="mb-4 text-[10px] text-slate-400">
        Nearby threshold: {thresholdKm} km straight-line · active stations only
      </p>

      {/* Incident coordinate audit */}
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        Incident spatial completeness
      </p>
      <div className="mb-2 rounded-lg bg-slate-50 px-3 py-2">
        {incidentAudit.total === 0 ? (
          <p className="text-xs text-slate-400">No active incidents.</p>
        ) : (
          <>
            <div className="mb-1.5 text-[11px] font-medium text-slate-700">
              {incidentAudit.total} active · {incidentAudit.spatiallyValid} mapped · {incidentAudit.total - incidentAudit.spatiallyValid} unmapped
            </div>
            <div className="space-y-0.5">
              <Row label="Spatially valid" value={incidentAudit.spatiallyValid} />
              <Row
                label="Missing coordinates"
                value={incidentAudit.missingCoordinates}
                dim={incidentAudit.missingCoordinates === 0}
              />
              <Row
                label="Outside Delhi/NCR bounds"
                value={incidentAudit.outsideBounds}
                dim={incidentAudit.outsideBounds === 0}
              />
              <Row
                label="Ward set but no coordinates"
                value={incidentAudit.withWardButNoCoords}
                dim={incidentAudit.withWardButNoCoords === 0}
              />
              <Row
                label="Coords but no ward assigned"
                value={incidentAudit.withCoordsButNoWard}
                dim={incidentAudit.withCoordsButNoWard === 0}
              />
            </div>
          </>
        )}
      </div>

      {incidentAudit.missingCoordinates > 0 && (
        <div className="mb-3 flex items-start gap-1.5 rounded-lg bg-status-warning/10 px-2.5 py-2 text-[11px] text-status-warning">
          <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" strokeWidth={2} aria-hidden />
          <span>
            {incidentAudit.missingCoordinates} incident{incidentAudit.missingCoordinates > 1 ? 's' : ''} cannot be plotted — coordinates missing. Clusters will not reflect these records.
          </span>
        </div>
      )}

      <Link
        to="/incidents"
        className="focus-ring flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
      >
        <MapPin className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        Review incidents for coordinate repair
      </Link>
    </div>
  )
}
