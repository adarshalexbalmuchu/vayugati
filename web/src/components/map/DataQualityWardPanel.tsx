import { ArrowUpRight, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  NEARBY_COVERAGE_THRESHOLD_METERS,
  WARD_COVERAGE_HEX,
  WARD_COVERAGE_LABEL,
  type WardCoverageDetail,
} from '../../lib/dataQualityRules'

function fmtDist(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`
}

export default function DataQualityWardPanel({
  wardId,
  wardName,
  wardNumber,
  coverage,
  onClose,
}: {
  wardId: number
  wardName: string
  wardNumber: number | null
  coverage: WardCoverageDetail
  onClose: () => void
}) {
  const thresholdKm = (NEARBY_COVERAGE_THRESHOLD_METERS / 1000).toFixed(0)

  const coverageColor = WARD_COVERAGE_HEX[coverage.class]
  const coverageLabel = WARD_COVERAGE_LABEL[coverage.class]

  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Ward #{wardNumber ?? wardId} · Data Quality
          </p>
          <h2 className="text-sm font-semibold text-slate-800">{wardName}</h2>
        </div>
        <button type="button" onClick={onClose} className="focus-ring rounded p-1 text-slate-400 hover:bg-slate-100">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {/* Coverage classification */}
      <div className="mb-3 rounded-lg border px-3 py-2.5" style={{ borderColor: `${coverageColor}40`, background: `${coverageColor}0d` }}>
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: coverageColor }} aria-hidden />
          <span className="text-xs font-semibold" style={{ color: coverageColor }}>{coverageLabel}</span>
        </div>

        {coverage.class === 'direct' && coverage.directStationName && (
          <p className="mt-1.5 text-[11px] text-slate-600">
            Station assigned: <span className="font-semibold">{coverage.directStationName}</span>
          </p>
        )}

        {coverage.class === 'nearby' && coverage.nearestStationName && coverage.nearestDistanceMeters != null && (
          <p className="mt-1.5 text-[11px] text-slate-600">
            Nearest active station:{' '}
            <span className="font-semibold">{coverage.nearestStationName}</span>{' '}
            — {fmtDist(coverage.nearestDistanceMeters)} straight-line
          </p>
        )}

        {coverage.class === 'insufficient' && (
          <p className="mt-1.5 text-[11px] text-slate-600">
            {coverage.nearestStationName && coverage.nearestDistanceMeters != null
              ? <>
                  Nearest active station:{' '}
                  <span className="font-semibold">{coverage.nearestStationName}</span>{' '}
                  — {fmtDist(coverage.nearestDistanceMeters)} straight-line (beyond {thresholdKm} km threshold)
                </>
              : 'No active station found within Delhi/NCR bounds.'}
          </p>
        )}

        {coverage.class === 'unavailable' && (
          <p className="mt-1.5 text-[11px] text-slate-600">
            Ward centroid is missing or outside Delhi/NCR bounds — distance-based coverage cannot be assessed.
          </p>
        )}
      </div>

      {/* Context */}
      <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
        <p>
          <span className="font-semibold text-slate-700">Coverage basis: </span>
          {coverage.class === 'direct'
            ? 'A station is directly assigned to this ward via ward_id. AQI values on the map reflect this station\'s readings.'
            : coverage.class === 'nearby'
              ? `No station is directly assigned to this ward. The nearest active station is within the ${thresholdKm} km support threshold.`
              : coverage.class === 'insufficient'
                ? `No active station exists within the ${thresholdKm} km support threshold. Any AQI shown is not defensibly attributable to this ward.`
                : 'Ward geometry exists but no valid centroid is available to calculate nearest-station distance.'}
        </p>
        {(coverage.class === 'direct' || coverage.class === 'nearby' || coverage.class === 'insufficient') && (
          <p className="mt-1.5 text-[10px] text-slate-400">
            The {thresholdKm} km threshold is straight-line distance from the ward centroid to the nearest active station, following WMO/CPCB guidance for dense urban monitoring networks. Only active stations count toward coverage.
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="space-y-1.5">
        <Link
          to={`/incidents?wardId=${wardId}`}
          className="focus-ring flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
        >
          View incidents in this ward
          <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        </Link>

        {(coverage.class === 'insufficient' || coverage.class === 'unavailable') && (
          <Link
            to={`/incidents?wardId=${wardId}`}
            className="focus-ring flex items-center justify-center gap-1.5 rounded-lg border border-status-warning/40 bg-status-warning/5 px-3 py-1.5 text-xs font-semibold text-status-warning transition hover:bg-status-warning/10"
          >
            Review monitoring gap
            <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </Link>
        )}
      </div>
    </div>
  )
}
