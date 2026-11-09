/** Whole-workcopy activation. Native inventory, installation and process evidence remain local. */
import { z } from 'zod'
import { teamCommandIdSchema, teamDigestSchema, teamIdSchema, teamOpaqueIdSchema, teamRelativePathSchema } from './team-platform'
import { teamExecutionBundleRefSchema, teamTaskIdentity, teamTaskRefSchema } from './team-task-execution'
import { teamTaskProgressResourceIdSchema } from './team-task-progress'
import { canonicalImportJson } from './team-import'

export const TEAM_CUTOVER_VERSION = 1 as const
export const CUTOVER_LIMITS = Object.freeze({ tasks: 1000, files: 64, conversions: 1000 })
const counter = z.number().int().nonnegative().safe()
export const cutoverScopeSchema = z.object({ instanceId: teamIdSchema, projectId: teamIdSchema,
  namespaceId: teamIdSchema, workcopyDigest: teamDigestSchema }).strict()
export type CutoverScope = z.infer<typeof cutoverScopeSchema>
export const cutoverNativeConnectorSchema = z.object({ id: z.literal('trellis-panel-native'), version: z.literal('1'), digest: teamDigestSchema }).strict()
export const cutoverTaskSchema = z.object({ sourceTaskKey: teamOpaqueIdSchema, task: teamTaskRefSchema,
  inputBundle: teamExecutionBundleRefSchema }).strict()
export const cutoverFileSchema = z.object({ targetPath: teamRelativePathSchema, beforeDigest: teamDigestSchema.nullable(), afterDigest: teamDigestSchema.nullable() }).strict()
export const cutoverConversionSchema = z.object({ itemKey: teamDigestSchema, sourceDigest: teamDigestSchema,
  implementation: z.enum(['platform-root-v1', 'platform-skill-v1', 'platform-hook-v1', 'platform-python-v1', 'platform-configuration-v1', 'platform-workflow-v1', 'removed-dispatch-v1', 'retained-nondispatch-v1']),
  targetPath: teamRelativePathSchema }).strict()
export const cutoverManifestSchema = z.object({ contractVersion: z.literal(1), boundary: z.literal('whole-workcopy'),
  importId: teamIdSchema, importManifestDigest: teamDigestSchema, nativeConnector: cutoverNativeConnectorSchema,
  tasks: z.array(cutoverTaskSchema).min(1).max(CUTOVER_LIMITS.tasks),
  files: z.array(cutoverFileSchema).min(1).max(CUTOVER_LIMITS.files),
  conversions: z.array(cutoverConversionSchema).max(CUTOVER_LIMITS.conversions)
}).strict().superRefine((m, ctx) => {
  for (const [field, keys] of [ ['tasks', m.tasks.map(t => t.sourceTaskKey)], ['tasks', m.tasks.map(t => teamTaskIdentity(t.task))],
    ['files', m.files.map(f => f.targetPath.toLowerCase())], ['conversions', m.conversions.map(c => c.itemKey)] ] as const) {
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: [field], message: 'Duplicate cutover identity' })
  }
  const paths = new Set(m.files.map(f => f.targetPath))
  if (m.conversions.some(c => !paths.has(c.targetPath))) ctx.addIssue({ code: 'custom', path: ['conversions'], message: 'Conversion requires an installed file' })
})
export type CutoverManifest = z.infer<typeof cutoverManifestSchema>
export const cutoverInstallationSchema = z.object({ manifestDigest: teamDigestSchema, connectorDigest: teamDigestSchema,
  files: z.array(z.object({ targetPath: teamRelativePathSchema, afterDigest: teamDigestSchema.nullable() }).strict()).min(1).max(CUTOVER_LIMITS.files)
}).strict().refine(v => new Set(v.files.map(f => f.targetPath.toLowerCase())).size === v.files.length, 'Duplicate installed file')
export type CutoverInstallation = z.infer<typeof cutoverInstallationSchema>
const envelope = { ...cutoverScopeSchema.shape, contractVersion: z.literal(1), commandId: teamCommandIdSchema,
  operationId: teamIdSchema, expectedEpoch: teamIdSchema, expectedActorId: teamIdSchema, expectedDeviceId: teamIdSchema,
  expectedRevision: counter }
export const cutoverCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...envelope, action: z.literal('stage'), manifest: cutoverManifestSchema, manifestDigest: teamDigestSchema }).strict(),
  z.object({ ...envelope, action: z.literal('installed'), installation: cutoverInstallationSchema }).strict(),
  z.object({ ...envelope, action: z.literal('activate') }).strict(),
  z.object({ ...envelope, action: z.literal('suspend') }).strict(),
  z.object({ ...envelope, action: z.literal('rollback') }).strict()
])
export type CutoverCommand = z.infer<typeof cutoverCommandSchema>
export const cutoverStateSchema = z.enum(['staged', 'installed', 'active', 'suspended', 'rolled-back'])
export const cutoverRecordSchema = z.object({ contractVersion: z.literal(1), scope: cutoverScopeSchema, epoch: teamIdSchema,
  operationId: teamIdSchema, revision: counter.min(1), state: cutoverStateSchema, manifestDigest: teamDigestSchema,
  manifest: cutoverManifestSchema, actorId: teamIdSchema, deviceId: teamIdSchema,
  stageCommandId: teamIdSchema, lastCommandId: teamIdSchema, installedCommandId: teamIdSchema.nullable(), createdAt: counter, updatedAt: counter }).strict()
export type CutoverRecord = z.infer<typeof cutoverRecordSchema>
export const cutoverReceiptSchema = z.object({ contractVersion: z.literal(1), commandId: teamIdSchema,
  operationId: teamIdSchema, scope: cutoverScopeSchema, epoch: teamIdSchema, actorId: teamIdSchema, deviceId: teamIdSchema,
  action: z.enum(['stage', 'installed', 'activate', 'suspend', 'rollback']), requestDigest: teamDigestSchema,
  manifestDigest: teamDigestSchema, revision: counter.min(1), state: cutoverStateSchema, committedAt: counter }).strict()
export type CutoverReceipt = z.infer<typeof cutoverReceiptSchema>
export const cutoverCommandReplySchema = z.object({ status: z.enum(['committed', 'duplicate']), commandId: teamIdSchema, result: cutoverReceiptSchema }).strict()
export type CutoverCommandReply = z.infer<typeof cutoverCommandReplySchema>
/** Kept structural in the execution command leaf to avoid a runtime schema import cycle. */
export const cutoverAdmissionSchema = z.object({ operationId: teamIdSchema, manifestDigest: teamDigestSchema }).strict()
export type CutoverAdmission = z.infer<typeof cutoverAdmissionSchema>
export const cutoverReadQuerySchema = z.object({ instanceId: teamIdSchema, namespaceId: teamIdSchema, operationId: teamIdSchema.optional() }).strict()
export const cutoverTaskQuerySchema = z.object({ instanceId: teamIdSchema, spaceId: teamTaskProgressResourceIdSchema,
  taskCreatedAt: z.string().min(1).max(100) }).strict()
export const canonicalCutoverJson = canonicalImportJson
