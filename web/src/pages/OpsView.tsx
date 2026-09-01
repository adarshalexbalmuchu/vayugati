import { useState } from 'react'
import PlaybookForm from '../components/admin/PlaybookForm'
import RegistryEntryForm from '../components/admin/RegistryEntryForm'
import SlaRuleForm from '../components/admin/SlaRuleForm'
import AppShell from '../components/AppShell'
import { Card, CardHeader, EmptyState, ErrorState, Label, Modal, Skeleton } from '../components/ui'
import { useAuth } from '../lib/auth'
import { BUILD_INFO } from '../lib/env'
import {
  KNOWN_FEATURE_FLAGS,
  fetchCities,
  fetchPlaybooksForAdmin,
  fetchResponsibilityRegistryForAdmin,
  fetchSlaRulesForAdmin,
  fetchStations,
  fetchSystemHealth,
  getFeatureFlags,
  setCityFeatureFlag,
  setPlaybookActive,
  setRegistryActive,
  setSlaRuleActive,
  setStationActive,
  type CityConfigRow,
  type FeatureFlagName,
  type PlaybookRow,
  type ResponsibilityRegistryRow,
  type SlaRuleRow,
} from '../lib/ops'
import { useAsync } from '../lib/useAsync'

/**
 * Operations & pilot administration (Phase 10, plan §10/§18). Phase 11 UI
 * redesign: same deliberately-narrow scope, restyled to the light/white
 * admin-console look — a mobile card view for system health (rather than a
 * shrunk table), and a denser two-column grid for the activation sections
 * on wide screens so the page doesn't read as one long, sparse column.
 *
 * Phase 12: registry/SLA-rule/playbook sections gained real create/edit
 * forms (deliberately overriding the earlier "toggle-only, no in-app editor"
 * decision for exactly these three tables). Stations stays toggle-only —
 * it's RPC-gated (setStationActive), not a direct commander/admin write like
 * the other three, so a form here would need a different write path
 * entirely. Still not a generic schema-driven editor: three purpose-built
 * typed forms (web/src/components/admin/*Form.tsx), not a table browser.
 */

const FEATURE_FLAG_LABEL: Record<FeatureFlagName, string> = {
  anomaly_detection: 'Automated anomaly detection',
  validated_forecasting: 'Validated forecasting',
  source_attribution: 'Source attribution',
  citizen_evidence_missions: 'Citizen evidence missions',
  operational_dispatch: 'Operational dispatch',
  automatic_escalation: 'Automatic escalation',
  notifications_email: 'Email notifications',
  notifications_sms: 'SMS notifications',
  notifications_whatsapp: 'WhatsApp notifications',
}

function StatusBadge({ isStale }: { isStale: boolean }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
        isStale ? 'bg-status-critical/10 text-status-critical' : 'bg-status-success/10 text-status-success'
      }`}
    >
      {isStale ? 'Stale' : 'OK'}
    </span>
  )
}

function ToggleButton({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`focus-ring rounded-full px-3 py-1 text-xs font-bold uppercase transition disabled:opacity-50 ${
        on ? 'bg-status-success/10 text-status-success' : 'bg-slate-100 text-slate-500'
      }`}
    >
      {on ? 'On' : 'Off'}
    </button>
  )
}

function SystemHealthSection() {
  const state = useAsync(fetchSystemHealth, [], { cacheKey: 'ops:system-health' })
  const rows = state.data ?? []

  return (
    <Card>
      <CardHeader
        title="System health"
        subtitle="Last run of every scheduled job - reads the same rollup the ingest service's /health endpoint uses"
        right={
          <button
            type="button"
            onClick={() => state.refresh()}
            className="focus-ring rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Refresh
          </button>
        }
      />
      {state.loading ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={() => state.refresh()} />
      ) : rows.length === 0 ? (
        <EmptyState icon="🩺">No job runs recorded yet - jobs record themselves the first time they run.</EmptyState>
      ) : (
        <>
          {/* Mobile: compact cards, not a shrunk table */}
          <ul className="divide-y divide-slate-100 sm:hidden">
            {rows.map((r) => (
              <li key={`${r.job_name}:${r.city_code ?? ''}`} className="px-4 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-800">{r.job_name}</span>
                  <StatusBadge isStale={r.is_stale} />
                </div>
                <p className="mt-0.5 text-xs text-slate-400">
                  {r.city_code ?? 'all'} · {r.last_status} ·{' '}
                  {r.last_completed_at ? new Date(r.last_completed_at).toLocaleString() : 'never run'}
                </p>
                {r.last_error_message && (
                  <p className="mt-1 truncate text-xs text-status-critical" title={r.last_error_message}>
                    {r.last_error_message}
                  </p>
                )}
              </li>
            ))}
          </ul>

          {/* Desktop: table */}
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Job</th>
                  <th className="px-2 py-2 font-medium">City</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                  <th className="px-2 py-2 font-medium">Last run</th>
                  <th className="px-2 py-2 font-medium">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={`${r.job_name}:${r.city_code ?? ''}`}>
                    <td className="px-4 py-2 font-semibold text-slate-800">{r.job_name}</td>
                    <td className="px-2 py-2 text-slate-500">{r.city_code ?? 'all'}</td>
                    <td className="px-2 py-2">
                      <StatusBadge isStale={r.is_stale} />
                      <span className="ml-1.5 text-slate-400">{r.last_status}</span>
                    </td>
                    <td className="px-2 py-2 text-slate-500">
                      {r.last_completed_at ? new Date(r.last_completed_at).toLocaleString() : '-'}
                    </td>
                    <td className="max-w-xs truncate px-2 py-2 text-status-critical" title={r.last_error_message ?? ''}>
                      {r.last_error_message ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  )
}

function FeatureFlagsSection({ city, onChanged }: { city: CityConfigRow; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const flags = getFeatureFlags(city)

  const toggle = async (flag: FeatureFlagName) => {
    setBusy(flag)
    try {
      await setCityFeatureFlag(city, flag, !flags[flag])
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader title="Feature flags" subtitle={`${city.name} - pause a risky pilot feature without a redeploy`} />
      <ul className="divide-y divide-slate-100">
        {KNOWN_FEATURE_FLAGS.map((flag) => (
          <li key={flag} className="flex items-center justify-between px-4 py-2.5">
            <span className="text-sm text-slate-700">{FEATURE_FLAG_LABEL[flag]}</span>
            <ToggleButton on={flags[flag]} disabled={busy === flag} onClick={() => toggle(flag)} />
          </li>
        ))}
      </ul>
    </Card>
  )
}

function ActivationList<T extends { id: number; is_active: boolean | null }>({
  title,
  subtitle,
  items,
  label,
  onToggle,
  onEdit,
  onCreate,
}: {
  title: string
  subtitle: string
  items: T[]
  label: (item: T) => string
  onToggle: (item: T) => Promise<void>
  /** Omit to keep a section toggle-only (e.g. Stations, which is RPC-gated). */
  onEdit?: (item: T) => void
  onCreate?: () => void
}) {
  const [busyId, setBusyId] = useState<number | null>(null)

  const handleToggle = async (item: T) => {
    setBusyId(item.id)
    try {
      await onToggle(item)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={subtitle}
        right={
          onCreate && (
            <button
              type="button"
              onClick={onCreate}
              className="focus-ring rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              + Add new
            </button>
          )
        }
      />
      {items.length === 0 ? (
        <EmptyState icon="-">Nothing configured yet for this city.</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
              <span className="min-w-0 truncate text-sm text-slate-700">{label(item)}</span>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                {onEdit && (
                  <button
                    type="button"
                    onClick={() => onEdit(item)}
                    className="focus-ring rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  >
                    Edit
                  </button>
                )}
                <ToggleButton on={!!item.is_active} disabled={busyId === item.id} onClick={() => handleToggle(item)} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

type EditTarget =
  | { kind: 'registry'; row: ResponsibilityRegistryRow | null }
  | { kind: 'sla'; row: SlaRuleRow | null }
  | { kind: 'playbook'; row: PlaybookRow | null }

function PilotAdminSections({ city }: { city: CityConfigRow }) {
  const { session } = useAuth()
  const stations = useAsync(() => fetchStations(city.id), [city.id], { cacheKey: `ops:stations:${city.id}` })
  const registry = useAsync(() => fetchResponsibilityRegistryForAdmin(city.id), [city.id], {
    cacheKey: `ops:registry:${city.id}`,
  })
  const slaRules = useAsync(() => fetchSlaRulesForAdmin(city.id), [city.id], {
    cacheKey: `ops:sla-rules:${city.id}`,
  })
  const playbooks = useAsync(() => fetchPlaybooksForAdmin(city.id), [city.id], {
    cacheKey: `ops:playbooks:${city.id}`,
  })
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)

  if (!session) return null

  const closeModal = () => setEditTarget(null)
  const savedRegistry = () => {
    registry.refresh()
    closeModal()
  }
  const savedSla = () => {
    slaRules.refresh()
    closeModal()
  }
  const savedPlaybook = () => {
    playbooks.refresh()
    closeModal()
  }

  return (
    <>
      <div className="grid gap-3 lg:grid-cols-2">
        <ActivationList
          title="Stations"
          subtitle="Deactivate a faulty/offline station - anomaly detection skips it immediately"
          items={stations.data ?? []}
          label={(s) => s.name}
          onToggle={async (s) => {
            await setStationActive(s.id, !s.is_active, session.user.id)
            stations.refresh()
          }}
        />
        <ActivationList
          title="Responsibility registry"
          subtitle="An inactive row is skipped by routing resolution entirely"
          items={registry.data ?? []}
          label={(r) => `${r.regulating_authority ?? 'Unnamed unit'}${r.division_zone ? ` · ${r.division_zone}` : ''}`}
          onToggle={async (r) => {
            await setRegistryActive(r.id, !r.is_active)
            registry.refresh()
          }}
          onEdit={(r) => setEditTarget({ kind: 'registry', row: r })}
          onCreate={() => setEditTarget({ kind: 'registry', row: null })}
        />
        <ActivationList
          title="SLA rules"
          subtitle="An inactive rule falls through to the next most-specific active rule"
          items={slaRules.data ?? []}
          label={(r) => r.slug ?? `Rule #${r.id}`}
          onToggle={async (r) => {
            await setSlaRuleActive(r.id, !r.is_active)
            slaRules.refresh()
          }}
          onEdit={(r) => setEditTarget({ kind: 'sla', row: r })}
          onCreate={() => setEditTarget({ kind: 'sla', row: null })}
        />
        <ActivationList
          title="Playbooks"
          subtitle="An inactive playbook no longer appears in the field-officer picker"
          items={playbooks.data ?? []}
          label={(p) => p.title}
          onToggle={async (p) => {
            await setPlaybookActive(p.id, !p.is_active)
            playbooks.refresh()
          }}
          onEdit={(p) => setEditTarget({ kind: 'playbook', row: p })}
          onCreate={() => setEditTarget({ kind: 'playbook', row: null })}
        />
      </div>

      {editTarget?.kind === 'registry' && (
        <Modal title={editTarget.row ? 'Edit registry entry' : 'New registry entry'} onClose={closeModal}>
          <RegistryEntryForm cityId={city.id} existing={editTarget.row} onSaved={savedRegistry} onCancel={closeModal} />
        </Modal>
      )}
      {editTarget?.kind === 'sla' && (
        <Modal title={editTarget.row ? 'Edit SLA rule' : 'New SLA rule'} onClose={closeModal}>
          <SlaRuleForm cityId={city.id} existing={editTarget.row} onSaved={savedSla} onCancel={closeModal} />
        </Modal>
      )}
      {editTarget?.kind === 'playbook' && (
        <Modal title={editTarget.row ? 'Edit playbook' : 'New playbook'} onClose={closeModal}>
          <PlaybookForm cityId={city.id} existing={editTarget.row} onSaved={savedPlaybook} onCancel={closeModal} />
        </Modal>
      )}
    </>
  )
}

export default function OpsView() {
  const citiesState = useAsync(fetchCities, [], { cacheKey: 'ops:cities' })
  const cities = citiesState.data ?? []
  const [selectedCityId, setSelectedCityId] = useState<number | null>(null)
  const activeCity = cities.find((c) => c.id === selectedCityId) ?? cities[0] ?? null

  return (
    <AppShell subtitle="Operations & pilot admin">
      <div className="mx-auto w-full max-w-5xl flex-1 space-y-3 overflow-y-auto bg-sky-50 p-3 sm:p-4">
        <SystemHealthSection />

        {citiesState.loading ? (
          <Skeleton className="h-24 w-full" />
        ) : citiesState.error ? (
          <ErrorState message={citiesState.error} onRetry={() => citiesState.refresh()} />
        ) : cities.length === 0 ? (
          <EmptyState icon="🏙">No cities configured yet.</EmptyState>
        ) : (
          <>
            {cities.length > 1 && (
              <div className="flex items-center gap-2">
                <Label>City</Label>
                <select
                  value={activeCity?.id ?? ''}
                  onChange={(e) => setSelectedCityId(Number(e.target.value))}
                  className="focus-ring rounded-lg border border-slate-200 px-2 py-1 text-sm"
                >
                  {cities.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {activeCity && (
              <>
                <FeatureFlagsSection city={activeCity} onChanged={() => citiesState.refresh()} />
                <PilotAdminSections city={activeCity} />
              </>
            )}
          </>
        )}

        <p className="pb-2 text-center text-[11px] text-slate-300">
          Build {BUILD_INFO.sha} · {BUILD_INFO.environment}
        </p>
      </div>
    </AppShell>
  )
}
