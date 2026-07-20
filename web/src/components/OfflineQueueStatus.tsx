import { useEffect, useState } from 'react'
import type { QueuedMutation } from '../lib/offlineDb'
import {
  discardMutation,
  listQueueForDisplay,
  retryMutation,
  runSyncOnce,
  subscribeToQueueChanges,
} from '../lib/offlineSync'
import { Card, CardHeader, Modal } from './ui'

/**
 * Field-surface-only (per ui.tsx's own extension-point comment, not a
 * shell-wide banner) — shows what's queued while offline, lets the officer
 * sync manually, and surfaces conflicts/failures for explicit action rather
 * than silently retrying or dropping them.
 */

const KIND_LABEL: Record<QueuedMutation['kind'], string> = {
  transitionTaskDispatch: 'Task update',
  submitMissionResult: 'Mission result',
  submitFieldCompletion: 'Intervention completion',
}

function StatusPill({ status }: { status: QueuedMutation['status'] }) {
  const style =
    status === 'conflict'
      ? 'bg-status-critical/10 text-status-critical'
      : status === 'failed'
        ? 'bg-status-warning/10 text-status-warning'
        : status === 'syncing'
          ? 'bg-status-info/10 text-status-info'
          : 'bg-slate-100 text-slate-500'
  const text = status === 'pending' ? 'Queued' : status === 'syncing' ? 'Syncing…' : status === 'failed' ? 'Failed' : 'Conflict'
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${style}`}>{text}</span>
}

function ConflictDetail({ mutation }: { mutation: QueuedMutation }) {
  if (mutation.kind !== 'transitionTaskDispatch') return null
  const payload = mutation.payload as { newStatus: string }
  return (
    <p className="mt-1 text-xs text-ink-500">
      You tried to set this task to <span className="font-semibold">{payload.newStatus}</span>, but someone else moved it
      to a different state while you were offline. Retrying will attempt your original update again against its current
      state; discarding drops your queued change entirely.
    </p>
  )
}

export default function OfflineQueueStatus() {
  const [items, setItems] = useState<QueuedMutation[]>([])
  const [expanded, setExpanded] = useState(false)
  const [detailItem, setDetailItem] = useState<QueuedMutation | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = () => {
    void listQueueForDisplay().then(setItems)
  }

  useEffect(() => {
    refresh()
    return subscribeToQueueChanges(refresh)
  }, [])

  if (items.length === 0) return null

  const needsAttention = items.filter((i) => i.status === 'conflict' || i.status === 'failed').length

  const act = async (id: string, fn: (id: string) => Promise<void>) => {
    setBusyId(id)
    try {
      await fn(id)
    } finally {
      setBusyId(null)
      setDetailItem(null)
    }
  }

  return (
    <Card>
      <CardHeader
        title="Offline queue"
        subtitle={
          needsAttention > 0
            ? `${needsAttention} item(s) need your attention`
            : `${items.length} item(s) waiting to sync`
        }
        right={
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void runSyncOnce()}
              className="focus-ring rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Sync now
            </button>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="focus-ring rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
            >
              {expanded ? 'Hide' : 'Show'}
            </button>
          </div>
        }
      />
      {expanded && (
        <ul className="divide-y divide-slate-100">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-700">{item.label}</p>
                <p className="text-xs text-slate-400">{KIND_LABEL[item.kind]}</p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <StatusPill status={item.status} />
                {(item.status === 'failed' || item.status === 'conflict') && (
                  <button
                    type="button"
                    onClick={() => setDetailItem(item)}
                    className="focus-ring rounded-lg px-2 py-1 text-xs font-semibold text-accent-700 hover:bg-accent-50"
                  >
                    Review
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {detailItem && (
        <Modal title={KIND_LABEL[detailItem.kind]} onClose={() => setDetailItem(null)}>
          <p className="text-sm text-ink-700">{detailItem.label}</p>
          {detailItem.lastError && <p className="mt-2 text-xs text-status-critical">{detailItem.lastError}</p>}
          <ConflictDetail mutation={detailItem} />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              disabled={busyId === detailItem.id}
              onClick={() => act(detailItem.id, discardMutation)}
              className="focus-ring rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Discard
            </button>
            <button
              type="button"
              disabled={busyId === detailItem.id}
              onClick={() => act(detailItem.id, retryMutation)}
              className="focus-ring rounded-lg bg-ink-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-ink-800 disabled:opacity-50"
            >
              {busyId === detailItem.id ? 'Working…' : 'Retry'}
            </button>
          </div>
        </Modal>
      )}
    </Card>
  )
}
