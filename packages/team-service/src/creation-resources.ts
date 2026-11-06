import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  CREATION_RESOURCE_MAX_BYTES, creationResourceBindingPreimage, creationResourceManifestSchema,
  type CreationResourceManifest
} from '../../../src/shared/creation-resource-manifest'
import type { CreationActorContext, CreationRecord } from '../../../src/shared/creations'
import { viewCreation } from '../../../src/shared/creations-domain'
import { TeamServiceError } from './errors'

const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const resourceScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('draft'), revisionId: z.string().uuid(), serial: z.number().int().positive().safe() }).strict(),
  z.object({ kind: z.literal('published'), revisionId: z.string().uuid() }).strict()
])

// Internal proposal only: never add this to the strict legacy creation record or expose it as an API.
export const creationResourceSnapshotSchema = z.object({
  projectId: z.string().min(1), creationId: z.string().uuid(), spaceId: z.string().min(1).nullable(),
  scope: resourceScope, bodyDigest: digest,
  manifest: creationResourceManifestSchema, bindingDigest: digest
}).strict()
export type CreationResourceSnapshot = z.infer<typeof creationResourceSnapshotSchema>

function conflict(message: string): never { throw new TeamServiceError('CREATION_RESOURCE_CONFLICT', message, 409) }

/**
 * Call on every use with current service-derived authority, a freshly loaded
 * creation and a snapshot loaded from trusted ownership-bound metadata. A
 * caller-supplied manifest and its digest do not prove that ownership.
 */
export function authorizeResourceSnapshot(raw: unknown, record: CreationRecord, actor: CreationActorContext, expectedEpoch: string): CreationResourceSnapshot {
  const snapshot = creationResourceSnapshotSchema.parse(raw)
  if (!actor.epoch || expectedEpoch !== actor.epoch || snapshot.projectId !== record.projectId ||
      snapshot.creationId !== record.creationId || snapshot.spaceId !== record.spaceId) conflict('Resource source or service generation changed')
  const selected = viewCreation(record, actor, { revisionId: snapshot.scope.revisionId, commentLimit: 1 }).selected
  if (snapshot.scope.kind === 'draft') {
    if (selected.published || snapshot.scope.revisionId !== record.draft.revisionId || snapshot.scope.serial !== record.draft.serial) conflict('Resource draft changed')
  } else if (!selected.published || !record.revisions.some((revision) => revision.revisionId === snapshot.scope.revisionId)) {
    conflict('Resource publication is unavailable')
  }
  if (hash(selected.body) !== selected.bodyDigest || selected.bodyDigest !== snapshot.bodyDigest ||
      hash(creationResourceBindingPreimage(snapshot.bodyDigest, snapshot.manifest)) !== snapshot.bindingDigest) conflict('Resource body or manifest binding changed')
  return snapshot
}

/** Verify actual selected bytes, never accepting a digest as authority to fetch a blob. */
export function verifyResourceBytes(manifest: CreationResourceManifest, readSelected: (resourceId: string) => Uint8Array): void {
  const parsed = creationResourceManifestSchema.parse(manifest)
  for (const resource of parsed.resources) {
    const bytes = readSelected(resource.id)
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== resource.byteLength ||
        bytes.byteLength < 1 || bytes.byteLength > CREATION_RESOURCE_MAX_BYTES || hash(bytes) !== resource.sha256) {
      conflict('Selected resource bytes do not match their manifest')
    }
  }
}

/** Invoke inside the existing writer transaction, against the actual blobs table. */
export function resourceQuotaAfterDeduplication(
  manifest: CreationResourceManifest, currentBytes: number, quotaBytes: number,
  storedLength: (digest: string) => number | undefined
): number {
  const parsed = creationResourceManifestSchema.parse(manifest)
  if (!Number.isSafeInteger(currentBytes) || currentBytes < 0 || !Number.isSafeInteger(quotaBytes) || quotaBytes < 0) {
    throw new TeamServiceError('CORRUPT_STORE', 'Blob quota is invalid', 503)
  }
  let total = currentBytes
  const seen = new Set<string>()
  for (const resource of parsed.resources) {
    if (seen.has(resource.sha256)) continue
    seen.add(resource.sha256)
    const existing = storedLength(resource.sha256)
    if (existing !== undefined && existing !== resource.byteLength) throw new TeamServiceError('CORRUPT_STORE', 'Stored blob length does not match its digest', 503)
    if (existing === undefined) total += resource.byteLength
    if (!Number.isSafeInteger(total) || total > quotaBytes) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Team blob quota is full', 507)
  }
  return total
}
