/**
 * Split-view location review workspace.
 *
 * Left pane: incident information, evidence, current location state.
 * Right pane: LocationPickerMap for visual placement.
 *
 * Workflow:
 *   1. Reviewer opens an incident from the remediation queue.
 *   2. They see the current location state and any available evidence.
 *   3. They click the map to place or move the point, or click Confirm to
 *      validate the existing location, or Clear to remove it.
 *   4. They choose a source and reason, then save.
 *   5. The atomic RPC writes the audit row + updates the incident.
 *
 * What is NOT done here:
 *   - Automatic geocoding (the map and description are the evidence)
 *   - Ward-centroid assignment (the RPC blocks it server-side too)
 *   - Auto-save on drag (always explicit commit)
 */
import { AlertTriangle, CheckCircle, MapPin, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { WardBoundary } from '../../lib/data'
import type { Incident } from '../../lib/incidents'
import { updateIncidentLocation } from '../../lib/incidents'
import {
  classifyCoordinateLocation,
  coordinateDisplacementMeters,
  coordinateLocationLabel,
  COORDINATE_CONFIDENCE_LABEL,
  COORDINATE_SOURCE_LABEL,
  deriveLocationQuality,
  findContainingWard,
  LARGE_DISPLACEMENT_WARNING_METERS,
  LOCATION_QUALITY_HEX,
  LOCATION_QUALITY_LABEL,
  REVIEW_REASON_LABEL,
  validateCoordinates,
  type CoordinateConfidence,
  type CoordinateSource,
  type ReviewReason,
} from '../../lib/incidentLocationRules'
import LocationPickerMap from './LocationPickerMap'

interface Props {
  incident: Incident
  wardBoundaries: WardBoundary[]
  onSaved: (updated: Incident) => void
  onCancel: () => void
}

type Action = 'place' | 'confirm' | 'clear'

export default function LocationReviewWorkspace({ incident, wardBoundaries, onSaved, onCancel }: Props) {
  const currentQuality = deriveLocationQuality(incident, wardBoundaries)
  const hasValidExisting =
    currentQuality.coordinateLocation === 'delhi' ||
    currentQuality.coordinateLocation === 'ncr_outside_delhi'

  const [action, setAction] = useState<Action>(hasValidExisting ? 'confirm' : 'place')
  const [proposedLat, setProposedLat] = useState<number | null>(
    hasValidExisting ? (incident.lat ?? null) : null,
  )
  const [proposedLng, setProposedLng] = useState<number | null>(
    hasValidExisting ? (incident.lng ?? null) : null,
  )
  const [resolvedWard, setResolvedWard] = useState<{ id: number; name: string; wardNumber: number | null } | null>(
    hasValidExisting && incident.lat != null && incident.lng != null
      ? findContainingWard(incident.lat, incident.lng, wardBoundaries)
      : null,
  )

  const [source, setSource] = useState<CoordinateSource>('manually_placed')
  const [confidence, setConfidence] = useState<CoordinateConfidence>('medium')
  const [reason, setReason] = useState<ReviewReason>('address_verified')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [ncrConfirmed, setNcrConfirmed] = useState(false)

  const proposedValidation = validateCoordinates(proposedLat, proposedLng)
  const requiresNcrConfirmation = proposedValidation.requiresNcrConfirmation && !ncrConfirmed

  // Displacement warning
  const displacementM =
    action === 'place' &&
    hasValidExisting &&
    incident.lat != null && incident.lng != null &&
    proposedLat != null && proposedLng != null
      ? coordinateDisplacementMeters(incident.lat, incident.lng, proposedLat, proposedLng)
      : null

  const largeMove = displacementM != null && displacementM > LARGE_DISPLACEMENT_WARNING_METERS

  // Ward mismatch: resolved ward differs from assigned ward_id
  const wardMismatch =
    resolvedWard != null &&
    incident.ward_id != null &&
    resolvedWard.id !== incident.ward_id

  const canSave =
    !saving &&
    (action === 'clear' || (proposedValidation.valid && !requiresNcrConfirmation))

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    setSaveError(null)
    try {
      const effectiveSource: CoordinateSource =
        action === 'clear'   ? ((incident.coordinate_source as CoordinateSource | null) ?? 'unknown_legacy') :
        action === 'confirm' ? 'confirmed_existing' :
        source

      const effectiveReason: ReviewReason =
        action === 'clear' ? 'location_cleared' :
        action === 'confirm' ? 'location_confirmed' :
        reason

      const effectiveConfidence: CoordinateConfidence =
        action === 'clear' ? 'unreviewed' :
        action === 'confirm' ? confidence :
        confidence

      await updateIncidentLocation({
        incidentId: incident.id,
        newLat: action === 'clear' ? null : proposedLat,
        newLng: action === 'clear' ? null : proposedLng,
        newWardId: action === 'clear' ? null : (resolvedWard?.id ?? incident.ward_id),
        locationSource: effectiveSource,
        confidence: effectiveConfidence,
        reviewReason: effectiveReason,
        reviewNote: note.trim() || null,
      })

      // Optimistically update the incident object so the parent can refresh its list
      const updated: Incident = {
        ...incident,
        lat: action === 'clear' ? null : proposedLat,
        lng: action === 'clear' ? null : proposedLng,
        ward_id: action === 'clear' ? incident.ward_id : (resolvedWard?.id ?? incident.ward_id),
        coordinate_source: effectiveSource,
        coordinate_confidence: effectiveConfidence,
        coordinate_review_status: action === 'clear' ? 'unreviewed' : effectiveConfidence === 'verified' ? 'reviewed' : 'awaiting_review',
        coordinate_reviewed_at: new Date().toISOString(),
      }
      onSaved(updated)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Location Review · Incident #{incident.id}
          </p>
          <h2 className="text-sm font-semibold text-slate-800 leading-tight">
            {incident.summary ?? `Incident #${incident.id}`}
          </h2>
        </div>
        <button type="button" onClick={onCancel} className="focus-ring rounded p-1 text-slate-400 hover:bg-slate-100">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {/* Body: two panes */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left pane: info + controls ─────────────────────────────────── */}
        <div className="flex w-72 flex-shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white p-4">

          {/* Current location state */}
          <div className="mb-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Current location</p>
            <div className="flex items-center gap-1.5 text-xs">
              <span
                className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                style={{ background: LOCATION_QUALITY_HEX[currentQuality.status] }}
                aria-hidden
              />
              <span className="font-semibold text-slate-800">{LOCATION_QUALITY_LABEL[currentQuality.status]}</span>
            </div>
            {incident.lat != null && incident.lng != null && (
              <p className="mt-0.5 font-mono text-[10px] text-slate-400">
                {incident.lat.toFixed(5)}, {incident.lng.toFixed(5)}
              </p>
            )}
            {incident.ward_name && (
              <p className="text-[11px] text-slate-500">Ward: {incident.ward_name}</p>
            )}
          </div>

          {/* Action selector */}
          <div className="mb-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Action</p>
            <div className="flex flex-col gap-1">
              {(['place', 'confirm', 'clear'] as Action[]).map((a) => (
                <label key={a} className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs hover:bg-slate-50">
                  <input
                    type="radio"
                    name="action"
                    value={a}
                    checked={action === a}
                    onChange={() => {
                      setAction(a)
                      if (a === 'confirm' && hasValidExisting) {
                        setProposedLat(incident.lat ?? null)
                        setProposedLng(incident.lng ?? null)
                        setSource('confirmed_existing')
                        setReason('location_confirmed')
                        setConfidence('medium')
                      }
                      if (a === 'place') {
                        setSource('manually_placed')
                        setReason('address_verified')
                      }
                    }}
                    className="accent-accent-600"
                  />
                  <span className="font-medium text-slate-700">
                    {a === 'place' ? 'Place / move location' :
                     a === 'confirm' ? 'Confirm existing location' :
                     'Clear incorrect location'}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Proposed point details */}
          {action !== 'clear' && (
            <div className="mb-3 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-600">
              {proposedLat != null && proposedLng != null ? (
                <>
                  <p className="font-mono">{proposedLat.toFixed(5)}, {proposedLng.toFixed(5)}</p>
                  <p className="mt-0.5">
                    {coordinateLocationLabel(classifyCoordinateLocation(proposedLat, proposedLng))}
                  </p>
                  {resolvedWard ? (
                    <p className="mt-0.5">
                      <span className={wardMismatch ? 'text-status-warning font-semibold' : 'text-slate-600'}>
                        Containing ward: {resolvedWard.name}
                        {wardMismatch && ' ⚠ mismatch'}
                      </span>
                    </p>
                  ) : (
                    <p className="mt-0.5 text-slate-400">Outside all ward boundaries</p>
                  )}
                  {displacementM != null && (
                    <p className={`mt-0.5 ${largeMove ? 'text-status-warning font-semibold' : 'text-slate-400'}`}>
                      {largeMove ? '⚠ ' : ''}
                      {displacementM < 1000
                        ? `${Math.round(displacementM)} m from current`
                        : `${(displacementM / 1000).toFixed(1)} km from current`}
                      {largeMove && ' — unusually large move'}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-slate-400">Click the map to place the point.</p>
              )}
            </div>
          )}

          {/* NCR confirmation */}
          {proposedValidation.requiresNcrConfirmation && action !== 'clear' && (
            <label className="mb-3 flex cursor-pointer items-start gap-2 rounded-lg border border-status-warning/40 bg-status-warning/5 px-2.5 py-2 text-[11px] text-status-warning">
              <input
                type="checkbox"
                checked={ncrConfirmed}
                onChange={(e) => setNcrConfirmed(e.target.checked)}
                className="mt-0.5 accent-status-warning"
              />
              <span>
                This point is outside Delhi but inside the NCR operating area. Confirm this location is correct.
              </span>
            </label>
          )}

          {/* Ward mismatch confirmation */}
          {wardMismatch && (
            <div className="mb-3 flex items-start gap-1.5 rounded-lg border border-status-warning/40 bg-status-warning/5 px-2.5 py-2 text-[11px] text-status-warning">
              <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" strokeWidth={2} aria-hidden />
              <span>
                The selected point falls in <strong>{resolvedWard?.name}</strong>, but this incident is assigned to{' '}
                <strong>{incident.ward_name ?? `ward ${incident.ward_id}`}</strong>. Saving will update the ward ID to match the point.
              </span>
            </div>
          )}

          {/* Provenance form */}
          {action !== 'clear' && (
            <div className="mb-3 space-y-2">
              <div>
                <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Coordinate source
                </label>
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value as CoordinateSource)}
                  disabled={action === 'confirm'}
                  className="focus-ring w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 disabled:opacity-60"
                >
                  {(Object.entries(COORDINATE_SOURCE_LABEL) as [CoordinateSource, string][])
                    .filter(([k]) => k !== 'unknown_legacy')
                    .map(([k, label]) => (
                      <option key={k} value={k}>{label}</option>
                    ))}
                </select>
              </div>

              <div>
                <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Confidence
                </label>
                <select
                  value={confidence}
                  onChange={(e) => setConfidence(e.target.value as CoordinateConfidence)}
                  className="focus-ring w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"
                >
                  {(Object.entries(COORDINATE_CONFIDENCE_LABEL) as [CoordinateConfidence, string][]).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Review reason
                </label>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value as ReviewReason)}
                  disabled={action === 'confirm'}
                  className="focus-ring w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 disabled:opacity-60"
                >
                  {(Object.entries(REVIEW_REASON_LABEL) as [ReviewReason, string][])
                    .filter(([k]) => k !== 'location_cleared' && k !== 'location_confirmed')
                    .map(([k, label]) => (
                      <option key={k} value={k}>{label}</option>
                    ))}
                </select>
              </div>
            </div>
          )}

          <div className="mb-4">
            <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Note (optional)
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Describe the evidence used to place this location…"
              className="focus-ring w-full resize-none rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-700 placeholder:text-slate-300"
            />
          </div>

          {saveError && (
            <div className="mb-3 flex items-start gap-1.5 rounded-lg bg-status-critical/10 px-2.5 py-2 text-[11px] text-status-critical">
              <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" strokeWidth={2} aria-hidden />
              <span>{saveError}</span>
            </div>
          )}

          {/* Action buttons */}
          <div className="mt-auto space-y-1.5">
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className="focus-ring flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-accent-700 disabled:opacity-40"
            >
              {action === 'clear' ? (
                <><Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden /> Clear location</>
              ) : action === 'confirm' ? (
                <><CheckCircle className="h-3.5 w-3.5" strokeWidth={2} aria-hidden /> Confirm location</>
              ) : (
                <><MapPin className="h-3.5 w-3.5" strokeWidth={2} aria-hidden /> Save location</>
              )}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="focus-ring flex w-full items-center justify-center rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>

        {/* ── Right pane: map ────────────────────────────────────────────── */}
        <div className="relative flex-1 bg-slate-100 p-2">
          {action === 'clear' ? (
            <div className="flex h-full items-center justify-center text-center text-sm text-slate-400">
              <div>
                <Trash2 className="mx-auto mb-2 h-8 w-8 text-slate-300" strokeWidth={1.5} />
                <p className="font-medium">Clearing the location</p>
                <p className="mt-1 text-xs">The existing coordinates will be removed.<br />The ward assignment will be preserved.</p>
              </div>
            </div>
          ) : (
            <LocationPickerMap
              wardBoundaries={wardBoundaries}
              existingLat={hasValidExisting ? (incident.lat ?? undefined) : undefined}
              existingLng={hasValidExisting ? (incident.lng ?? undefined) : undefined}
              proposedLat={proposedLat}
              proposedLng={proposedLng}
              onChange={(lat, lng) => {
                setProposedLat(lat)
                setProposedLng(lng)
                setNcrConfirmed(false)
              }}
              onWardResolved={setResolvedWard}
            />
          )}
        </div>
      </div>
    </div>
  )
}
