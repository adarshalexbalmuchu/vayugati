/**
 * IndexedDB storage for the field-officer offline queue (Phase 12). Just
 * persistence - queueing/replay/conflict logic lives in offlineSync.ts.
 *
 * Two stores:
 *  - mutationQueue: one row per queued call to transitionTaskDispatch /
 *    submitMissionResult / submitFieldCompletion. `id` (a client-generated
 *    UUID) doubles as the idempotency key.
 *  - pendingPhotos: raw photo blobs queued alongside a mutation, keyed by a
 *    local ref (`local:<uuid>`) that the mutation's own payload embeds in
 *    place of a real Supabase Storage URL - the real URL doesn't exist yet
 *    until the blob is uploaded at sync time (see offlineSync.ts).
 *
 * No service worker / vite-plugin-pwa here - this only needs background-
 * tab-independent persistent storage, which IndexedDB alone provides.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { FieldCompletionParams, SubmitMissionParams } from './incidents'
import type { TaskDispatchStatus } from './incidentRules'

export type QueuedMutationKind = 'transitionTaskDispatch' | 'submitMissionResult' | 'submitFieldCompletion'
export type QueuedMutationStatus = 'pending' | 'syncing' | 'failed' | 'conflict'

export interface TransitionTaskDispatchPayload {
  dispatchId: number
  newStatus: TaskDispatchStatus
  actorId: string
  reason?: string
}

/** proofPhotoUrl becomes a `local:<uuid>` placeholder when queued offline -
 *  see pendingPhotos above. */
export type QueuedSubmitMissionPayload = Omit<SubmitMissionParams, 'proofPhotoUrl'> & { proofPhotoUrl: string | null }

/** Same substitution for each entry of photoUrls. */
export type QueuedFieldCompletionPayload = Omit<FieldCompletionParams, 'photoUrls'> & { photoUrls: string[] }

export type QueuedMutationPayload =
  | TransitionTaskDispatchPayload
  | QueuedSubmitMissionPayload
  | QueuedFieldCompletionPayload

export interface QueuedMutation {
  id: string
  kind: QueuedMutationKind
  payload: QueuedMutationPayload
  createdAt: number
  attempts: number
  lastError: string | null
  status: QueuedMutationStatus
  /** Human-readable label for the queue-status UI, e.g. "Mission result - Incident #42". */
  label: string
}

export interface PendingPhoto {
  id: string
  mutationId: string
  /** A real File (not a bare Blob) — uploadReportPhoto reads .name off it
   *  for the extension, and IndexedDB's structured-clone algorithm stores a
   *  File natively, so this round-trips with no conversion needed. */
  blob: File
  uploaded: boolean
  remoteUrl: string | null
}

interface OfflineDBSchema extends DBSchema {
  mutationQueue: {
    key: string
    value: QueuedMutation
    indexes: { 'by-createdAt': number }
  }
  pendingPhotos: {
    key: string
    value: PendingPhoto
    indexes: { 'by-mutationId': string }
  }
}

const DB_NAME = 'vayugati-offline'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<OfflineDBSchema>> | null = null

function getDb(): Promise<IDBPDatabase<OfflineDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<OfflineDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const mutations = db.createObjectStore('mutationQueue', { keyPath: 'id' })
        mutations.createIndex('by-createdAt', 'createdAt')
        const photos = db.createObjectStore('pendingPhotos', { keyPath: 'id' })
        photos.createIndex('by-mutationId', 'mutationId')
      },
    })
  }
  return dbPromise
}

export async function enqueueMutation(mutation: QueuedMutation, photos: PendingPhoto[]): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['mutationQueue', 'pendingPhotos'], 'readwrite')
  await tx.objectStore('mutationQueue').put(mutation)
  for (const p of photos) await tx.objectStore('pendingPhotos').put(p)
  await tx.done
}

export async function listQueuedMutations(): Promise<QueuedMutation[]> {
  const db = await getDb()
  return db.getAllFromIndex('mutationQueue', 'by-createdAt')
}

export async function getPendingPhotosForMutation(mutationId: string): Promise<PendingPhoto[]> {
  const db = await getDb()
  return db.getAllFromIndex('pendingPhotos', 'by-mutationId', mutationId)
}

export async function updateMutation(mutation: QueuedMutation): Promise<void> {
  const db = await getDb()
  await db.put('mutationQueue', mutation)
}

export async function updatePendingPhoto(photo: PendingPhoto): Promise<void> {
  const db = await getDb()
  await db.put('pendingPhotos', photo)
}

export async function deleteMutationAndPhotos(mutationId: string): Promise<void> {
  const db = await getDb()
  const photos = await db.getAllFromIndex('pendingPhotos', 'by-mutationId', mutationId)
  const tx = db.transaction(['mutationQueue', 'pendingPhotos'], 'readwrite')
  await tx.objectStore('mutationQueue').delete(mutationId)
  for (const p of photos) await tx.objectStore('pendingPhotos').delete(p.id)
  await tx.done
}
