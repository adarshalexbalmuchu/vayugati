/**
 * Incident Location Remediation Queue (Phase 1F)
 *
 * Route: /incidents/remediation?filter=<RemediationFilter>&incident=<id>
 *
 * Three-column layout (on wide screens):
 *   [Filter sidebar] [Incident list] [Review workspace]
 *
 * On narrow screens the list and workspace stack vertically.
 *
 * Permission: commander / admin only (enforced at route level in App.tsx and
 * defensively checked here). The underlying `update_incident_location` RPC
 * performs the authoritative server-side check regardless.
 */
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Clock, ListFilter, MapPin, RefreshCw } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { type Incident, listRemediationIncidents } from '../lib/incidents'
import { fetchAllWardBoundaries, type WardBoundary } from '../lib/data'
import {
  deriveLocationQuality,
  LOCATION_QUALITY_HEX,
  LOCATION_QUALITY_LABEL,
  matchesRemediationFilter,
  REMEDIATION_FILTER_LABEL,
  type LocationQualityDetail,
  type RemediationFilter,
} from '../lib/incidentLocationRules'
import LocationReviewWorkspace from '../components/incidents/LocationReviewWorkspace'

const ALL_FILTERS: RemediationFilter[] = [
  'all_invalid',
  'missing',
  'outside_area',
  'ward_no_coords',
  'coords_no_ward',
  'ward_mismatch',
  'awaiting_review',
]

function fmtAge(detectedAt: string): string {
  const ms = Date.now() - new Date(detectedAt).getTime()
  const h = Math.floor(ms / 3_600_000)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function IncidentRemediationPage() {
  const { profile } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const activeFilter = (searchParams.get('filter') as RemediationFilter | null) ?? 'all_invalid'
  const focusedIncidentId = searchParams.get('incident') ? Number(searchParams.get('incident')) : null

  const [incidents, setIncidents] = useState<Incident[]>([])
  const [wardBoundaries, setWardBoundaries] = useState<WardBoundary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(focusedIncidentId)

  const canEdit = profile?.role === 'commander' || profile?.role === 'admin'

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([listRemediationIncidents(), fetchAllWardBoundaries()])
      .then(([incs, wards]) => {
        if (cancelled) return
        setIncidents(incs)
        setWardBoundaries(wards)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  // Pre-compute location quality for all incidents (no PIP for the list — too slow for 500 rows)
  // PIP is computed inside LocationReviewWorkspace for the selected incident only.
  const qualityById = useMemo<Map<number, LocationQualityDetail>>(() => {
    const m = new Map<number, LocationQualityDetail>()
    for (const inc of incidents) {
      m.set(inc.id, deriveLocationQuality(inc))  // no wardBoundaries = no PIP in list
    }
    return m
  }, [incidents])

  // Filtered list
  const filtered = useMemo(() => {
    return incidents.filter((inc) => {
      const q = qualityById.get(inc.id)
      if (!q) return false
      return matchesRemediationFilter(inc, q, activeFilter)
    })
  }, [incidents, qualityById, activeFilter])

  // Count per filter
  const filterCounts = useMemo<Record<RemediationFilter, number>>(() => {
    const counts = {} as Record<RemediationFilter, number>
    for (const f of ALL_FILTERS) {
      counts[f] = incidents.filter((inc) => {
        const q = qualityById.get(inc.id)
        return q ? matchesRemediationFilter(inc, q, f) : false
      }).length
    }
    return counts
  }, [incidents, qualityById])

  const selectedIncident = incidents.find((i) => i.id === selectedId) ?? null
  const selectedWards = wardBoundaries  // pass all for PIP inside workspace

  function setFilter(f: RemediationFilter) {
    setSearchParams((p) => { p.set('filter', f); return p })
    setSelectedId(null)
  }

  function handleSaved(updated: Incident) {
    setIncidents((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
    setSelectedId(null)
  }

  // ── Permission guard ────────────────────────────────────────────────────────
  if (profile && !canEdit) {
    return (
      <div className="flex h-screen items-center justify-center p-8 text-center">
        <div>
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-status-warning" strokeWidth={1.5} />
          <p className="font-semibold text-slate-800">Access restricted</p>
          <p className="mt-1 text-sm text-slate-500">Location remediation is available to commanders and administrators only.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-white">
      {/* Page header */}
      <div className="border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-accent-600" strokeWidth={2} aria-hidden />
          <h1 className="text-sm font-semibold text-slate-800">Incident Location Remediation</h1>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
            {loading ? '…' : `${filterCounts['all_invalid']} requiring attention`}
          </span>
          <button
            type="button"
            onClick={() => { setLoading(true); listRemediationIncidents().then(setIncidents).finally(() => setLoading(false)) }}
            className="focus-ring ml-auto rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </button>
        </div>
        <p className="mt-0.5 text-xs text-slate-400">
          Review and repair incident locations. Every change is recorded with full provenance.
        </p>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-slate-400">Loading…</div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div>
            <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-status-critical" strokeWidth={1.5} />
            <p className="text-sm text-slate-600">{error}</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">

          {/* ── Filter sidebar ──────────────────────────────────────────────── */}
          <div className="w-52 flex-shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              <ListFilter className="h-3 w-3" aria-hidden />
              Filter
            </div>
            {ALL_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`focus-ring mb-0.5 flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition ${
                  activeFilter === f
                    ? 'bg-accent-600 font-semibold text-white'
                    : 'text-slate-600 hover:bg-white hover:text-slate-800'
                }`}
              >
                <span>{REMEDIATION_FILTER_LABEL[f]}</span>
                <span className={`tabular-nums rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                  activeFilter === f ? 'bg-white/20 text-white' : filterCounts[f] > 0 ? 'bg-slate-200 text-slate-600' : 'text-slate-300'
                }`}>
                  {filterCounts[f]}
                </span>
              </button>
            ))}
          </div>

          {/* ── Incident list ───────────────────────────────────────────────── */}
          <div className="flex w-72 flex-shrink-0 flex-col overflow-y-auto border-r border-slate-200">
            {filtered.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
                <CheckCircle2 className="mb-2 h-6 w-6 text-status-success" strokeWidth={1.5} />
                <p className="text-sm font-medium text-slate-600">No incidents in this category</p>
              </div>
            ) : (
              <>
                <div className="border-b border-slate-100 px-3 py-2 text-[11px] text-slate-400">
                  {filtered.length} incident{filtered.length !== 1 ? 's' : ''}
                </div>
                {filtered.map((inc) => {
                  const q = qualityById.get(inc.id)
                  const isSelected = inc.id === selectedId
                  return (
                    <button
                      key={inc.id}
                      type="button"
                      onClick={() => setSelectedId(isSelected ? null : inc.id)}
                      className={`focus-ring w-full border-b border-slate-100 px-3 py-2.5 text-left transition ${
                        isSelected ? 'bg-accent-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <p className="text-[11px] font-semibold text-slate-800 leading-snug line-clamp-2">
                          {inc.summary ?? `Incident #${inc.id}`}
                        </p>
                        <span className="flex-shrink-0 text-[10px] text-slate-400">{fmtAge(inc.detected_at)}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px]">
                        <span className="text-slate-400">#{inc.id}</span>
                        {inc.ward_name && <span className="text-slate-500">{inc.ward_name}</span>}
                        {q && (
                          <span className="flex items-center gap-0.5 font-semibold" style={{ color: LOCATION_QUALITY_HEX[q.status] }}>
                            <span
                              className="inline-block h-1.5 w-1.5 rounded-full"
                              style={{ background: LOCATION_QUALITY_HEX[q.status] }}
                              aria-hidden
                            />
                            {LOCATION_QUALITY_LABEL[q.status]}
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </>
            )}
          </div>

          {/* ── Review workspace ────────────────────────────────────────────── */}
          <div className="flex flex-1 overflow-hidden">
            {selectedIncident ? (
              canEdit ? (
                <LocationReviewWorkspace
                  incident={selectedIncident}
                  wardBoundaries={selectedWards}
                  onSaved={handleSaved}
                  onCancel={() => setSelectedId(null)}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center p-8 text-center">
                  <div>
                    <Clock className="mx-auto mb-2 h-6 w-6 text-slate-300" strokeWidth={1.5} />
                    <p className="text-sm text-slate-500">Read-only view — location editing requires commander role.</p>
                  </div>
                </div>
              )
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-slate-400">
                <MapPin className="mb-2 h-8 w-8 text-slate-200" strokeWidth={1.5} />
                <p className="text-sm font-medium text-slate-600">Select an incident to review its location</p>
                <p className="mt-1 text-xs">
                  {filtered.length > 0
                    ? `${filtered.length} incident${filtered.length !== 1 ? 's' : ''} in this category`
                    : 'No incidents match the current filter'}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
