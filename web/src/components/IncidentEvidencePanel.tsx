import { Inbox } from 'lucide-react'
import { cleanMissionRationale, groupDuplicateMissions, haversineMeters, missionRationaleIsAutomated } from '../lib/incidentRules'
import type { IncidentDetail } from '../lib/incidents'
import EmptyIncidentState from './incidents/EmptyIncidentState'
import EvidenceSummaryCard from './EvidenceSummaryCard'
import { Label, PartialDataBadge, UnavailableBadge } from './ui'

/**
 * Evidence workspace for the selected incident (plan §8): linked reports,
 * monitoring evidence, source hypotheses, supporting AND contradictory
 * evidence, evidence quality, and the timeline.
 *
 * The contradictory-evidence section is not decoration — plan §8 requires the
 * interface to show evidence that argues against the leading hypothesis, so it
 * gets equal billing and says so explicitly when there is none.
 */

function pct(p: number | null): string {
  return p == null ? '-' : `${Math.round(p * 100)}%`
}

function Section({
  title,
  count,
  unavailable,
  children,
}: {
  title: string
  count?: number
  unavailable?: boolean
  children: React.ReactNode
}) {
  return (
    <section className="border-t border-slate-100 px-4 py-3 first:border-t-0">
      <div className="mb-2 flex items-center gap-2">
        <Label dark>{title}</Label>
        {count != null && !unavailable && (
          <span className="rounded bg-slate-100 px-1.5 text-[10px] font-bold text-slate-600">{count}</span>
        )}
        {unavailable && <UnavailableBadge label="Couldn't load" />}
      </div>
      {children}
    </section>
  )
}

export default function IncidentEvidencePanel({ detail }: { detail: IncidentDetail }) {
  const { incident, reports, evidence, missions, sensor, unavailable } = detail
  const missing = (label: string) => unavailable.includes(label)

  const supporting = evidence.filter((e) => e.supports === true)
  const contradicting = evidence.filter((e) => e.supports === false)
  const inconclusive = evidence.filter((e) => e.supports == null)

  return (
    <div className="divide-y divide-slate-100">
      {unavailable.length > 0 && (
        <div className="flex items-center gap-2 bg-status-info/10 px-4 py-2">
          <PartialDataBadge />
          <p className="text-xs text-slate-600">
            Some sections could not be loaded: {unavailable.join(', ')}. What you see below is incomplete.
          </p>
        </div>
      )}

      <EvidenceSummaryCard detail={detail} />

      {/* Probable source hypotheses moved to SourceAttributionPanel (Phase 7) -
          ranked, with evidence-scored confidence, contradictions, missing
          evidence, classification and responsibility routing. Shown above
          this panel in the incident workspace whenever a current hypothesis
          exists. */}

      {/* ── linked citizen reports ── */}
      <Section title="Linked citizen reports" count={reports.length} unavailable={missing('Linked reports')}>
        {reports.length === 0 ? (
          <EmptyIncidentState icon={Inbox}>No citizen reports are linked to this incident.</EmptyIncidentState>
        ) : (
          <ul className="space-y-2">
            {reports.map((r) => {
              const dist =
                r.lat != null && r.lng != null && incident.lat != null && incident.lng != null
                  ? haversineMeters({ lat: r.lat, lng: r.lng }, { lat: incident.lat, lng: incident.lng })
                  : null
              return (
                <li key={r.id} className="flex gap-2.5 rounded-lg bg-slate-50 p-2">
                  {r.photo_url && (
                    <a href={r.photo_url} target="_blank" rel="noreferrer" className="flex-shrink-0">
                      <img src={r.photo_url} alt="" className="h-12 w-12 rounded object-cover" />
                    </a>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-slate-800">{r.description || '(no description)'}</p>
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      #{r.id} · {new Date(r.created_at).toLocaleString()}
                      {r.ai_category && ` · ${r.ai_category.replace(/_/g, ' ')}`}
                      {dist != null && ` · ${Math.round(dist)}m from centre`}
                    </p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      {/* ── monitoring evidence ── */}
      <Section title="Monitoring evidence" unavailable={missing('Monitoring data')}>
        {missing('Monitoring data') ? (
          <p className="text-xs text-slate-500">Monitoring data could not be loaded.</p>
        ) : !sensor ? (
          // Honest unavailable state: several seeded wards have no working
          // station id in ingest/stations.yaml, so this is a real situation.
          <div className="flex items-center gap-2">
            <UnavailableBadge label="No station" />
            <p className="text-xs text-slate-500">
              No monitoring station reports for this ward, so there is no sensor evidence either way.
            </p>
          </div>
        ) : (
          <dl className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <dt className="text-slate-400">PM2.5</dt>
              <dd className="font-semibold tabular-nums text-slate-800">{sensor.pm25 ?? '-'}</dd>
            </div>
            <div>
              <dt className="text-slate-400">PM10</dt>
              <dd className="font-semibold tabular-nums text-slate-800">{sensor.pm10 ?? '-'}</dd>
            </div>
            <div>
              <dt className="text-slate-400">AQI</dt>
              <dd className="font-semibold tabular-nums text-slate-800">{sensor.aqi ?? '-'}</dd>
            </div>
            {sensor.ts && (
              <div className="col-span-3 text-[11px] text-slate-400">
                Last reading {new Date(sensor.ts).toLocaleString()}
              </div>
            )}
          </dl>
        )}
      </Section>

      {/* ── supporting / contradictory ── */}
      <Section title="Supporting evidence" count={supporting.length} unavailable={missing('Evidence')}>
        {supporting.length === 0 ? (
          <p className="text-xs text-slate-500">Nothing recorded yet.</p>
        ) : (
          <ul className="space-y-1 text-xs text-slate-600">
            {supporting.map((e) => (
              <li key={e.id} className="flex items-center gap-2">
                <span className="text-status-success" aria-hidden>▲</span>
                <span className="capitalize">{e.evidence_type.replace(/_/g, ' ')}</span>
                <span className="text-slate-400">{new Date(e.collected_at).toLocaleDateString()}</span>
                {e.confidence != null && <span className="text-slate-400">· {pct(e.confidence)} confidence</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Contradictory evidence" count={contradicting.length} unavailable={missing('Evidence')}>
        {contradicting.length === 0 ? (
          <p className="text-xs text-slate-500">
            None recorded. Absence of contradictory evidence is not confirmation - it may simply not have been looked for.
          </p>
        ) : (
          <ul className="space-y-1 text-xs text-slate-600">
            {contradicting.map((e) => (
              <li key={e.id} className="flex items-center gap-2">
                <span className="text-status-critical" aria-hidden>▼</span>
                <span className="capitalize">{e.evidence_type.replace(/_/g, ' ')}</span>
                <span className="text-slate-400">{new Date(e.collected_at).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        )}
        {inconclusive.length > 0 && (
          <p className="mt-1.5 text-[11px] text-slate-400">
            {inconclusive.length} inconclusive item{inconclusive.length > 1 ? 's' : ''} (neither supports nor contradicts).
          </p>
        )}
      </Section>

      {/* ── evidence missions ── */}
      <Section title="Evidence missions" count={missions.length} unavailable={missing('Evidence missions')}>
        {missions.length === 0 ? (
          <p className="text-xs text-slate-500">No evidence missions requested.</p>
        ) : (
          <ul className="space-y-1.5">
            {groupDuplicateMissions(missions).map(({ mission: m, count }) => (
              <li key={m.id} className="rounded-lg bg-slate-50 p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold capitalize text-slate-800">
                    {m.mission_type.replace(/_/g, ' ')}
                    {count > 1 && <span className="ml-1 font-normal normal-case text-slate-400">× {count}</span>}
                  </span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-600">
                    {m.status}
                  </span>
                  {m.outcome && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                        m.outcome === 'confirmed'
                          ? 'bg-status-success/10 text-status-success'
                          : m.outcome === 'rejected'
                            ? 'bg-status-critical/10 text-status-critical'
                            : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {m.outcome}
                    </span>
                  )}
                </div>
                {m.rationale && (
                  <p className="mt-0.5 text-slate-500">
                    {missionRationaleIsAutomated(m.rationale) && (
                      <span className="mr-1 rounded bg-accent-100 px-1 text-[10px] font-bold uppercase text-accent-700">
                        Automated attribution
                      </span>
                    )}
                    {cleanMissionRationale(m.rationale)}
                  </p>
                )}
                {m.proof_photo_url && (
                  <a
                    href={m.proof_photo_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block font-semibold text-accent-700 hover:underline"
                  >
                    View geotagged proof →
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
