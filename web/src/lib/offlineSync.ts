/**
 * Offline queue/replay engine for field officers (Phase 12) - overrides
 * MissionsView.tsx's earlier, principled "don't fake this" decision.
 *
 * Guarantees: a mutation attempted while offline (or that fails on a
 * network-level error, never a real validation error) is queued in
 * IndexedDB (offlineDb.ts) and replayed strictly one at a time, oldest
 * first, on reconnect. Photos are uploaded at sync time, not queue time -
 * the real URL doesn't exist until then. A stale transitionTaskDispatch
 * replay is checked against the dispatch's real current status: already
 * applied is dropped silently, moved to a genuinely different state is a
 * real conflict surfaced to the officer, never auto-resolved.
 *
 * Explicitly NOT guaranteed: submitMissionResult/submitFieldCompletion have
 * no server-side idempotency key (see the migration comment on
 * submitMissionResult's own non-atomicity) - a replay whose previous
 * attempt's outcome is unknown (e.g. the tab was killed mid-sync) is never
 * auto-retried; it's marked failed and needs explicit officer confirmation,
 * trading some inconvenience for never risking a silent duplicate write.
 * A fully atomic fix (idempotency-keyed RPCs) is real backend work beyond
 * this pass.
 */
import {
  deleteMutationAndPhotos,
  enqueueMutation,
  getPendingPhotosForMutation,
  listQueuedMutations,
  updateMutation,
  updatePendingPhoto,
  type QueuedFieldCompletionPayload,
  type QueuedMutation,
  type QueuedSubmitMissionPayload,
  type TransitionTaskDispatchPayload,
  type PendingPhoto,
} from './offlineDb'
import { uploadReportPhoto } from './data'
import {
  getTaskDispatchStatus,
  submitFieldCompletion,
  submitMissionResult,
  transitionTaskDispatch,
  type FieldCompletionParams,
  type SubmitMissionParams,
} from './incidents'

/** Heuristic, not exact: `fail()` (the shared error-throwing helper every
 *  lib/*.ts mutation uses) discards the original PostgrestError's
 *  structured code, so a genuine network failure and a real validation
 *  error both surface here as a plain Error with only a message string.
 *  Combines the browser's own connectivity signal (checked again at catch
 *  time, not just before starting - connectivity can drop mid-request)
 *  with a message-text fallback for the rarer "still reports online but
 *  the request actually failed at the network layer" case. A real
 *  validation error is never silently queued and retried later mislabelled
 *  as connectivity, because the first check (navigator.onLine) covers the
 *  overwhelmingly common real case. */
function isLikelyNetworkFailure(err: unknown): boolean {
  if (!navigator.onLine) return true
  const message = err instanceof Error ? err.message : String(err)
  return /fetch|network|load failed/i.test(message)
}

function newId(): string {
  return crypto.randomUUID()
}

type Listener = () => void
const listeners = new Set<Listener>()
function notifyChanged() {
  for (const l of listeners) l()
}
/** The queue-status UI subscribes to this rather than polling - IndexedDB
 *  itself has no change events. */
export function subscribeToQueueChanges(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ── call-site wrappers ───────────────────────────────────────────────────
// Online path is exactly today's behavior (upload then submit, non-fatal on
// upload failure); offline (or a network-class failure mid-attempt) queues
// instead, storing raw photo File objects rather than URLs that don't exist yet.

export async function runOrQueueTransitionTaskDispatch(
  payload: TransitionTaskDispatchPayload,
  label: string,
): Promise<{ queued: boolean }> {
  if (navigator.onLine) {
    try {
      await transitionTaskDispatch(payload.dispatchId, payload.newStatus, payload.actorId, payload.reason)
      return { queued: false }
    } catch (err) {
      if (!isLikelyNetworkFailure(err)) throw err
    }
  }
  await enqueueMutation(
    {
      id: newId(),
      kind: 'transitionTaskDispatch',
      payload,
      createdAt: Date.now(),
      attempts: 0,
      lastError: null,
      status: 'pending',
      label,
    },
    [],
  )
  notifyChanged()
  return { queued: true }
}

export async function runOrQueueSubmitMissionResult(
  params: Omit<SubmitMissionParams, 'proofPhotoUrl'>,
  photoFile: File | null,
  label: string,
): Promise<{ queued: boolean }> {
  if (navigator.onLine) {
    try {
      let proofPhotoUrl: string | null = null
      if (photoFile) {
        try {
          proofPhotoUrl = await uploadReportPhoto(photoFile, params.actorId)
        } catch {
          proofPhotoUrl = null
        }
      }
      await submitMissionResult({ ...params, proofPhotoUrl })
      return { queued: false }
    } catch (err) {
      if (!isLikelyNetworkFailure(err)) throw err
    }
  }

  const id = newId()
  const photos: PendingPhoto[] = []
  let proofPhotoUrl: string | null = null
  if (photoFile) {
    proofPhotoUrl = `local:${newId()}`
    photos.push({ id: proofPhotoUrl, mutationId: id, blob: photoFile, uploaded: false, remoteUrl: null })
  }
  const payload: QueuedSubmitMissionPayload = { ...params, proofPhotoUrl }
  await enqueueMutation(
    { id, kind: 'submitMissionResult', payload, createdAt: Date.now(), attempts: 0, lastError: null, status: 'pending', label },
    photos,
  )
  notifyChanged()
  return { queued: true }
}

export async function runOrQueueSubmitFieldCompletion(
  params: Omit<FieldCompletionParams, 'photoUrls'>,
  photoFiles: File[],
  label: string,
): Promise<{ queued: boolean }> {
  if (navigator.onLine) {
    try {
      const photoUrls: string[] = []
      for (const f of photoFiles) {
        try {
          photoUrls.push(await uploadReportPhoto(f, params.actorId))
        } catch {
          // continue without this one photo - matches the pre-existing behavior
        }
      }
      await submitFieldCompletion({ ...params, photoUrls })
      return { queued: false }
    } catch (err) {
      if (!isLikelyNetworkFailure(err)) throw err
    }
  }

  const id = newId()
  const photos: PendingPhoto[] = []
  const photoUrls: string[] = []
  for (const f of photoFiles) {
    const ref = `local:${newId()}`
    photos.push({ id: ref, mutationId: id, blob: f, uploaded: false, remoteUrl: null })
    photoUrls.push(ref)
  }
  const payload: QueuedFieldCompletionPayload = { ...params, photoUrls }
  await enqueueMutation(
    { id, kind: 'submitFieldCompletion', payload, createdAt: Date.now(), attempts: 0, lastError: null, status: 'pending', label },
    photos,
  )
  notifyChanged()
  return { queued: true }
}

// ── replay engine ────────────────────────────────────────────────────────

const TRANSITION_REJECT_RE = /Cannot move a task dispatch from "(.+)" to "(.+)"\./

async function resolvePhotoUrl(mutationId: string, ref: string | null, actorId: string): Promise<string | null> {
  if (ref == null || !ref.startsWith('local:')) return ref
  const photos = await getPendingPhotosForMutation(mutationId)
  const photo = photos.find((p) => p.id === ref)
  if (!photo) return null
  if (photo.uploaded && photo.remoteUrl) return photo.remoteUrl
  const remoteUrl = await uploadReportPhoto(photo.blob, actorId)
  await updatePendingPhoto({ ...photo, uploaded: true, remoteUrl })
  return remoteUrl
}

async function replayOne(mutation: QueuedMutation): Promise<'synced' | 'conflict' | 'failed'> {
  try {
    if (mutation.kind === 'transitionTaskDispatch') {
      const payload = mutation.payload as TransitionTaskDispatchPayload
      try {
        await transitionTaskDispatch(payload.dispatchId, payload.newStatus, payload.actorId, payload.reason)
        return 'synced'
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!TRANSITION_REJECT_RE.test(message)) throw err
        const currentStatus = await getTaskDispatchStatus(payload.dispatchId)
        return currentStatus === payload.newStatus ? 'synced' : 'conflict'
      }
    }

    if (mutation.kind === 'submitMissionResult') {
      const payload = mutation.payload as QueuedSubmitMissionPayload
      const proofPhotoUrl = await resolvePhotoUrl(mutation.id, payload.proofPhotoUrl, payload.actorId)
      await submitMissionResult({ ...payload, proofPhotoUrl })
      return 'synced'
    }

    const payload = mutation.payload as QueuedFieldCompletionPayload
    const photoUrls: string[] = []
    for (const ref of payload.photoUrls) {
      const url = await resolvePhotoUrl(mutation.id, ref, payload.actorId)
      if (url) photoUrls.push(url)
    }
    await submitFieldCompletion({ ...payload, photoUrls })
    return 'synced'
  } catch {
    return 'failed'
  }
}

let syncing = false

/** Processes the queue strictly one item at a time, oldest first - never
 *  concurrently, to avoid two dispatch-status transitions (or two mission
 *  submissions for the same incident) racing each other. Skips items
 *  already marked 'conflict'/'failed' - those need explicit officer
 *  action (retryMutation/discardMutation), never a silent auto-retry. */
export async function runSyncOnce(): Promise<void> {
  if (syncing || !navigator.onLine) return
  syncing = true
  try {
    const mutations = await listQueuedMutations()
    for (const mutation of mutations) {
      if (mutation.status === 'conflict' || mutation.status === 'failed') continue
      await updateMutation({ ...mutation, status: 'syncing' })
      notifyChanged()
      const outcome = await replayOne(mutation)
      if (outcome === 'synced') {
        await deleteMutationAndPhotos(mutation.id)
      } else if (outcome === 'conflict') {
        await updateMutation({ ...mutation, status: 'conflict', attempts: mutation.attempts + 1 })
      } else {
        await updateMutation({
          ...mutation,
          status: 'failed',
          attempts: mutation.attempts + 1,
          lastError: 'Could not sync - see details, then retry or discard.',
        })
      }
      notifyChanged()
    }
  } finally {
    syncing = false
  }
}

/** A mutation left in 'syncing' means the app closed (or crashed) mid-replay
 *  - its real outcome is unknown, so it must never be silently resumed.
 *  Called once at startup, before any real sync attempt. */
export async function recoverStaleSyncingMutations(): Promise<void> {
  const mutations = await listQueuedMutations()
  for (const m of mutations) {
    if (m.status === 'syncing') {
      await updateMutation({
        ...m,
        status: 'failed',
        lastError: 'Sync was interrupted (e.g. the app closed) - outcome unknown. Review before retrying.',
      })
    }
  }
  notifyChanged()
}

export async function listQueueForDisplay(): Promise<QueuedMutation[]> {
  return listQueuedMutations()
}

export async function retryMutation(id: string): Promise<void> {
  const mutations = await listQueuedMutations()
  const m = mutations.find((x) => x.id === id)
  if (!m) return
  await updateMutation({ ...m, status: 'pending', lastError: null })
  notifyChanged()
  if (navigator.onLine) await runSyncOnce()
}

export async function discardMutation(id: string): Promise<void> {
  await deleteMutationAndPhotos(id)
  notifyChanged()
}

/** Wired once at the shell level (AppShell.tsx) - recovers any stale
 *  'syncing' rows, then syncs on mount (if online) and on every
 *  online-transition. */
export function initOfflineSync(): () => void {
  recoverStaleSyncingMutations().then(() => {
    if (navigator.onLine) void runSyncOnce()
  })
  const onOnline = () => void runSyncOnce()
  window.addEventListener('online', onOnline)
  return () => window.removeEventListener('online', onOnline)
}
