/** Read-only source migration. These records never grant execution or material approval. */
import { z } from 'zod'
import { teamCommandIdSchema, teamDigestSchema, teamIdSchema, teamOpaqueIdSchema, teamPageInputSchema, teamRelativePathSchema } from './team-platform'
import { teamTaskRefSchema } from './team-task-execution'
import { teamTaskProgressResourceIdSchema } from './team-task-progress'

export const TEAM_IMPORT_VERSION = 1 as const
export const IMPORT_LIMITS = Object.freeze({ entries: 12000, files: 2500, depth: 12, fileBytes: 1024 * 1024, totalBytes: 24 * 1024 * 1024, selections: 1000, tasks: 1000, owners: 100 })
const count = z.number().int().nonnegative().safe()
const label = z.string().trim().min(1).max(300)
export const importPurposeSchema = z.enum(['product-requirement', 'developer-prd', 'design', 'implementation', 'spec', 'workflow', 'agent', 'skill', 'hook', 'root-instruction', 'context', 'task-metadata', 'unresolved', 'other'])
export const importAssetKindSchema = z.enum(['task', 'material', 'context', 'spec', 'workflow', 'agent', 'skill', 'command', 'hook', 'script', 'root-instruction', 'configuration'])
export const importBlockerSchema = z.object({ code: z.string().min(1).max(100), relativePath: teamRelativePathSchema.nullable(), scope: z.enum(['asset', 'task', 'root', 'workcopy']), detail: z.string().max(500) }).strict()
export const importTaskSourceSchema = z.object({
  sourceTaskKey: teamOpaqueIdSchema, originalId: teamOpaqueIdSchema.max(256).nullable(), location: teamRelativePathSchema,
  title: label, localStatus: z.string().max(100).nullable(), archived: z.boolean(), authors: z.array(teamOpaqueIdSchema).max(20)
}).strict()
export const importAssetSchema = z.object({
  itemKey: teamDigestSchema, relativePath: teamRelativePathSchema, kind: importAssetKindSchema, purpose: importPurposeSchema,
  sourceTaskKey: teamOpaqueIdSchema.nullable(), sourceDigest: teamDigestSchema, byteLength: count.max(IMPORT_LIMITS.fileBytes),
  representation: z.enum(['source', 'task-summary']), sharing: z.enum(['review-required', 'metadata-only']),
  scope: z.enum(['asset', 'task', 'root']), unknownFieldCount: count, templateDigest: teamDigestSchema.nullable()
}).strict()
export const importContextRefSchema = z.object({ assetKey: teamDigestSchema, stage: z.string().max(100), order: count, relativePath: teamRelativePathSchema.nullable(), reason: z.string().max(2000), availability: z.enum(['available', 'missing', 'external', 'invalid']) }).strict()
export const importOwnerEvidenceSchema = z.object({ ownerId: teamOpaqueIdSchema, sessionId: teamOpaqueIdSchema.nullable(), taskKey: teamOpaqueIdSchema.nullable(), state: z.enum(['active', 'idle', 'unknown']), evidence: z.enum(['native-owner', 'retained-metadata']), observedAt: count }).strict()
export const importPreviewSchema = z.object({
  contractVersion: z.literal(1), previewId: teamIdSchema, createdAt: count,
  assets: z.array(importAssetSchema).max(IMPORT_LIMITS.files), tasks: z.array(importTaskSourceSchema).max(IMPORT_LIMITS.tasks),
  context: z.array(importContextRefSchema).max(IMPORT_LIMITS.entries), owners: z.array(importOwnerEvidenceSchema).max(IMPORT_LIMITS.owners),
  blockers: z.array(importBlockerSchema).max(IMPORT_LIMITS.entries), truncated: z.boolean(),
  scanned: z.object({ entries: count, files: count, bytes: count }).strict(),
  limits: z.object({ entries: count, files: count, depth: count, fileBytes: count, totalBytes: count, selections: count, tasks: count, owners: count }).strict(),
  executionAuthority: z.literal('local-unmodified'), activationReady: z.literal(false)
}).strict()
export const importSelectionSchema = z.object({ itemKey: teamDigestSchema, expectedSourceDigest: teamDigestSchema, purpose: importPurposeSchema, reviewedForSharing: z.literal(true), includeOpaqueTaskFields: z.boolean().default(false) }).strict()
export const importSelectedAssetSchema = importAssetSchema.omit({ sharing: true, templateDigest: true }).extend({
  bodyDigest: teamDigestSchema, bodyByteLength: count.min(1).max(IMPORT_LIMITS.fileBytes), reviewedForSharing: z.literal(true), includeOpaqueTaskFields: z.boolean()
}).strict()
export const importAuthorMappingSchema = z.object({ sourceAuthor: teamOpaqueIdSchema, accountId: teamIdSchema.nullable() }).strict()
export const importManifestSchema = z.object({
  contractVersion: z.literal(1), assets: z.array(importSelectedAssetSchema).max(IMPORT_LIMITS.selections),
  tasks: z.array(importTaskSourceSchema).max(IMPORT_LIMITS.tasks), authors: z.array(importAuthorMappingSchema).max(500),
  blockers: z.array(importBlockerSchema).max(IMPORT_LIMITS.entries), truncated: z.boolean()
}).strict().superRefine((value, ctx) => {
  for (const [key, entries] of [['assets', value.assets.map(a => a.itemKey)], ['tasks', value.tasks.map(t => t.sourceTaskKey)], ['authors', value.authors.map(a => a.sourceAuthor)]] as const) {
    if (new Set(entries).size !== entries.length) ctx.addIssue({ code: 'custom', path: [key], message: 'Duplicate source identities require explicit comparison' })
  }
  const tasks = new Set(value.tasks.map(t => t.sourceTaskKey)), authors = new Set(value.authors.map(a => a.sourceAuthor))
  if (value.assets.some(a => a.sourceTaskKey !== null && !tasks.has(a.sourceTaskKey))) ctx.addIssue({ code: 'custom', message: 'Selected task asset requires its original task identity' })
  if (value.tasks.some(t => t.authors.some(a => !authors.has(a)))) ctx.addIssue({ code: 'custom', message: 'Every source author requires an explicit account mapping or unresolved null' })
  if (value.assets.some(a => a.representation === 'task-summary' && a.kind !== 'task')) ctx.addIssue({ code: 'custom', message: 'Only task metadata can use the safe task-summary representation' })
})
export const importCaptureSchema = z.object({ manifest: importManifestSchema, manifestDigest: teamDigestSchema, bodies: z.array(z.object({ itemKey: teamDigestSchema, text: z.string().max(IMPORT_LIMITS.fileBytes) }).strict()).max(IMPORT_LIMITS.selections) }).strict()

const command = { contractVersion: z.literal(1), commandId: teamCommandIdSchema, instanceId: teamIdSchema, projectId: teamIdSchema, expectedEpoch: teamIdSchema, expectedActorId: teamIdSchema, expectedDeviceId: teamIdSchema.nullable() }
export const importCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...command, action: z.literal('enroll'), enrollmentKey: teamIdSchema, spaceId: teamTaskProgressResourceIdSchema, spaceCreatedAt: z.string().min(1).max(100), label }).strict(),
  z.object({ ...command, action: z.literal('begin'), namespaceId: teamIdSchema, importId: teamIdSchema, manifest: importManifestSchema, manifestDigest: teamDigestSchema }).strict(),
  z.object({ ...command, action: z.literal('map-task'), namespaceId: teamIdSchema, importId: teamIdSchema, sourceTaskKey: teamOpaqueIdSchema, expectedWorkspaceRevision: count,
    aliasFrom: teamRelativePathSchema.nullable(), decision: z.discriminatedUnion('kind', [z.object({ kind: z.literal('create') }).strict(), z.object({ kind: z.literal('link'), task: teamTaskRefSchema }).strict()]) }).strict(),
  z.object({ ...command, action: z.literal('snapshot'), namespaceId: teamIdSchema, importId: teamIdSchema, itemKey: teamDigestSchema, text: z.string().max(IMPORT_LIMITS.fileBytes) }).strict()
])
export const importNamespaceSchema = z.object({ namespaceId: teamIdSchema, projectId: teamIdSchema, enrollmentKey: teamIdSchema, spaceId: teamTaskProgressResourceIdSchema, spaceCreatedAt: z.string().min(1).max(100), label, createdBy: teamIdSchema, createdAt: count, authority: z.literal('unactivated') }).strict()
export const importTaskMappingSchema = z.object({ namespaceId: teamIdSchema, sourceTaskKey: teamOpaqueIdSchema, originalId: teamOpaqueIdSchema.nullable(), locations: z.array(teamRelativePathSchema).min(1).max(100), task: teamTaskRefSchema, createdAt: count }).strict()
export const importCandidateSchema = z.object({
  candidateId: teamIdSchema, namespaceId: teamIdSchema, importId: teamIdSchema, itemKey: teamDigestSchema,
  asset: importSelectedAssetSchema, baseCandidateId: teamIdSchema.nullable(), previousCandidateId: teamIdSchema.nullable(),
  task: teamTaskRefSchema.nullable(), sourceAuthors: z.array(importAuthorMappingSchema).max(500),
  comparison: z.object({ sourceChanged: z.boolean(), teamHeadPresent: z.boolean(), teamHeadChanged: z.boolean(), purposeConflict: z.boolean(), targetFingerprint: teamDigestSchema.nullable() }).strict(),
  conflicts: z.array(z.string().max(100)).max(20), createdBy: teamIdSchema, createdAt: count, state: z.literal('candidate'), approved: z.literal(false), writerGranted: z.literal(false)
}).strict()
export const importReceiptSchema = z.object({ contractVersion: z.literal(1), commandId: teamIdSchema, projectId: teamIdSchema, actorId: teamIdSchema, deviceId: teamIdSchema.nullable(),
  namespaceId: teamIdSchema, importId: teamIdSchema.nullable(), itemKey: z.string().max(512).nullable(), namespace: importNamespaceSchema.nullable(), mapping: importTaskMappingSchema.nullable(), candidate: importCandidateSchema.nullable(),
  comparison: importCandidateSchema.shape.comparison.nullable(), conflicts: z.array(z.string().max(100)).max(20), reused: z.boolean(), authority: z.literal('unactivated') }).strict()
export const importListQuerySchema = teamPageInputSchema.extend({ namespaceId: teamIdSchema.optional(), importId: teamIdSchema.optional() }).strict()
export type ImportPurpose = z.infer<typeof importPurposeSchema>
export type ImportAsset = z.infer<typeof importAssetSchema>
export type ImportPreview = z.infer<typeof importPreviewSchema>
export type ImportTaskSource = z.infer<typeof importTaskSourceSchema>
export type ImportSelection = z.infer<typeof importSelectionSchema>
export type ImportManifest = z.infer<typeof importManifestSchema>
export type ImportCapture = z.infer<typeof importCaptureSchema>
export type ImportCommand = z.infer<typeof importCommandSchema>
export type ImportNamespace = z.infer<typeof importNamespaceSchema>
export type ImportTaskMapping = z.infer<typeof importTaskMappingSchema>
export type ImportCandidate = z.infer<typeof importCandidateSchema>
export type ImportReceipt = z.infer<typeof importReceiptSchema>
export type ImportOwnerEvidence = z.infer<typeof importOwnerEvidenceSchema>

export function importTaskSummary(task: ImportTaskSource): string {
  return canonicalImportJson({ sourceTaskKey: task.sourceTaskKey, originalId: task.originalId, title: task.title, localStatus: task.localStatus, authors: task.authors })
}

/** Canonical bytes are hashed at the owning Node boundary; no native dependencies in shared. */
export function canonicalImportJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalImportJson).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalImportJson((value as Record<string, unknown>)[key])).join(',') + '}'
  if (value === undefined) throw new Error('Undefined import value')
  return JSON.stringify(value)
}

/** Reject recognizable secrets/private payloads even after explicit content selection. */
export function assertImportShareableText(text: string): void {
  if (/(?:[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|\/(?:Users|home)\/[^\s/]+\/)/.test(text) || /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH)/.test(text)
    || /(?:"|\b)(?:password|passwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|credentials?|secret|authorization)(?:"|\b)\s*[:=]\s*["']?[^\s"',}\]]+/i.test(text)) throw new Error('IMPORT_PRIVATE_CONTENT: selected text contains a private path or recognizable credential; select a reviewed portable document instead')
}
