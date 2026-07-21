import { Link } from 'react-router-dom'
import { Inbox, RefreshCw, Users } from 'lucide-react'
import AppShell from '../components/AppShell'
import { Card, CardHeader, ErrorState, Skeleton, StaleBadge } from '../components/ui'
import KpiStrip, { type KpiItem } from '../components/overview/KpiStrip'
import { sourceCategoryLabel } from '../lib/incidentRules'
import { listAllCitizenReports, REPORT_STATUS_LABEL, type CitizenReportRow } from '../lib/data'
import { useAsync } from '../lib/useAsync'

/**
 * Citizens — report-level queue across every ward (launch-hardening
 * redesign, matching Tasks/Sensors/Analytics' Card/CardHeader/KpiStrip
 * visual language). listAllCitizenReports() reads the same `reports` table
 * fetchAllOpenReports() already reads for the Map's citizen-reports layer -
 * unfiltered by status here, so rejected/resolved reports are visible too,
 * which the open-only queries deliberately exclude.
 */

const STATUS_TONE: Record<string, string> = {
  submitted: 'bg-status-info/10 text-status-info',
  verified: 'bg-accent-100 text-accent-700',
  assigned: 'bg-accent-100 text-accent-700',
  acted: 'bg-status-success/10 text-status-success',
  resolved: 'bg-status-success/10 text-status-success',
  rejected: 'bg-status-critical/10 text-status-critical',
}

function fmtDateTime(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown time'
}

function ReportRow({ r }: { r: CitizenReportRow }) {
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">{fmtDateTime(r.created_at)}</td>
      <td className="px-3 py-2 text-xs font-medium text-slate-800">{r.ward_name ?? 'Unknown ward'}</td>
      <td className="max-w-xs truncate px-3 py-2 text-xs text-slate-600" title={r.description ?? undefined}>
        {r.description || '(no description)'}
      </td>
      <td className="px-3 py-2 text-xs capitalize text-slate-600">
        {r.ai_category ? sourceCategoryLabel(r.ai_category) : <span className="text-slate-400">Not yet classified</span>}
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${STATUS_TONE[r.status] ?? 'bg-slate-100 text-slate-600'}`}>
          {REPORT_STATUS_LABEL[r.status]}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-xs">
        {r.incident_id != null ? (
          <Link to={`/incidents?incident=${r.incident_id}`} className="focus-ring text-accent-700 hover:underline">
            #{r.incident_id}
          </Link>
        ) : (
          <span className="text-slate-400">Not linked</span>
        )}
      </td>
    </tr>
  )
}

export default function CitizensView() {
  const state = useAsync(() => listAllCitizenReports(), [])
  const rows = state.data ?? []

  const kpis: KpiItem[] | null = state.loading
    ? null
    : [
        { key: 'total', icon: Inbox, label: 'Total reports', value: rows.length, tone: 'neutral' },
        {
          key: 'new',
          icon: Inbox,
          label: 'New / unreviewed',
          value: rows.filter((r) => r.status === 'submitted').length,
          tone: 'info',
        },
        {
          key: 'linked',
          icon: Inbox,
          label: 'Linked to incidents',
          value: rows.filter((r) => r.incident_id != null).length,
          tone: 'info',
        },
        {
          key: 'rejected',
          icon: Inbox,
          label: 'Rejected',
          value: rows.filter((r) => r.status === 'rejected').length,
          tone: rows.some((r) => r.status === 'rejected') ? 'warning' : 'success',
        },
      ]

  return (
    <AppShell subtitle="Citizens">
      <div className="flex-1 space-y-4 overflow-y-auto bg-slate-50 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-card">
          <div>
            <h1 className="text-base font-bold text-slate-900">Citizen Reports</h1>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
              Community-submitted observations and verification signals
              {state.stale && <StaleBadge />}
            </p>
          </div>
          <button
            type="button"
            onClick={() => state.refresh()}
            disabled={state.refreshing}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${state.refreshing ? 'animate-spin' : ''}`} aria-hidden />
            Refresh
          </button>
        </div>

        {state.loading ? (
          <Skeleton className="h-20 w-full rounded-xl" />
        ) : state.error ? (
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
            <ErrorState message={state.error} onRetry={() => state.refresh()} />
          </div>
        ) : (
          kpis && <KpiStrip items={kpis} />
        )}

        {!state.loading && !state.error && (
          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <Card className="flex min-h-0 flex-col overflow-hidden">
              <CardHeader
                title={
                  <span className="flex items-center gap-1.5">
                    <Users className="h-4 w-4 text-accent-600" aria-hidden />
                    Report queue
                  </span>
                }
                subtitle={`${rows.length} report${rows.length === 1 ? '' : 's'} - most recent first`}
              />
              {rows.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                  <Inbox className="h-8 w-8 text-slate-300" strokeWidth={1.75} aria-hidden />
                  <p className="text-sm font-semibold text-slate-700">No citizen reports recorded yet.</p>
                  <p className="max-w-md text-xs text-slate-500">
                    When citizen reports arrive, they can be linked to open incidents when they match ward, source
                    category, time window, and location rules.
                  </p>
                  <p className="max-w-md text-xs text-slate-400">
                    Citizen evidence supports verification but does not independently prove pollution reduction or
                    violation.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] border-collapse text-left">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        <th className="px-3 py-2">Time</th>
                        <th className="px-3 py-2">Ward</th>
                        <th className="px-3 py-2">Description</th>
                        <th className="px-3 py-2">Source category</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2">Linked incident</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <ReportRow key={r.id} r={r} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card>
              <CardHeader title="How citizen reports are used" />
              <div className="space-y-3 px-4 py-3.5 text-xs leading-relaxed text-slate-600">
                <p>
                  Citizen reports do not automatically prove a violation. They help corroborate source attribution,
                  field evidence, and incident verification.
                </p>
                <p>
                  A new report joins an open incident automatically when it arrives within the matching window, names
                  a similar source category, and (when both have GPS) sits close enough to the same location.
                  Otherwise it stays unlinked until a commander reviews it.
                </p>
                <p className="text-slate-400">
                  Source category shown here is the automated first-pass classification of the report itself, not a
                  confirmed finding - the Incidents workspace's Source Attribution tab is where evidence is actually
                  weighed.
                </p>
              </div>
            </Card>
          </div>
        )}
      </div>
    </AppShell>
  )
}
