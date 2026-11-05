import { z } from 'zod'
import { governanceIdentityShape, governanceScopeSchema, governanceVersionSchema } from './team-governance'
import { taskMaterialInputReferenceSchema } from './task-material-inputs'
import { teamCommandIdSchema, teamCommandReplySchema, teamDigestSchema, teamIdSchema } from './team-platform'
import { teamTaskMaterialScopeSchema } from './team-task-materials'
import { teamTaskProgressResourceIdSchema } from './team-task-progress'
import { taskInputCanonical } from './team-canonical'
export { taskInputCanonical } from './team-canonical'
export * from './team-execution-input'

const counter = z.number().int().nonnegative().safe()
const serial = counter.min(1)
export const taskInputScopeSchema = governanceScopeSchema.extend({ ...teamTaskMaterialScopeSchema.shape, taskId: teamTaskProgressResourceIdSchema }).strict()
const task = { projectId: teamIdSchema, taskId: teamTaskProgressResourceIdSchema, ...teamTaskMaterialScopeSchema.shape }
const versionSelection = z.object({ packageId: teamIdSchema, versionId: teamIdSchema }).strict()
const envelope = { commandId: teamCommandIdSchema, expectedEpoch: teamIdSchema, ...teamTaskMaterialScopeSchema.shape, expectedRevision: counter }
export const taskInputCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...envelope, action: z.literal('adopt'), documents: z.array(z.object({ documentId: teamIdSchema, versionId: teamIdSchema }).strict()).max(4), rules: z.array(versionSelection).max(64), template: versionSelection.nullable() }).strict(),
  z.object({ ...envelope, action: z.literal('withdrawDocument'), documentId: teamIdSchema, versionId: teamIdSchema, reason: z.string().trim().min(1).max(2000) }).strict()
])
export const taskInputBundleSchema = z.object({
  ...governanceIdentityShape, ...task, bundleId: teamIdSchema, revision: serial, digest: teamDigestSchema,
  documents: z.array(taskMaterialInputReferenceSchema).max(4), rules: z.array(governanceVersionSchema).max(64), template: governanceVersionSchema.nullable(),
  adoptedBy: teamIdSchema, deviceId: teamIdSchema.nullable(), adoptedAt: counter
}).strict()
export const taskInputAdmissionSchema = z.object({ status: z.enum(['ready', 'requires-adoption', 'blocked', 'review-required']), blockers: z.array(z.string().min(1).max(1000)).max(128) }).strict()
export const taskInputReadSchema = z.object({
  ...governanceIdentityShape, ...task, revision: counter, current: taskInputBundleSchema.nullable(), admission: taskInputAdmissionSchema,
  legacySummary: z.object({ title: z.string().max(1000), description: z.string().max(1024 * 1024), bodyDigest: teamDigestSchema, byteLength: counter.max(1024 * 1024), workspaceRevision: counter }).strict().nullable()
}).strict()
export const taskInputCandidatesSchema = z.object({
  ...governanceIdentityShape, ...task, documents: z.array(taskMaterialInputReferenceSchema).max(4), rules: z.array(governanceVersionSchema).max(64), templates: z.array(governanceVersionSchema).max(64), blockers: z.array(z.string().max(1000)).max(128)
}).strict()
export const taskInputReceiptSchema = z.object({
  ...governanceIdentityShape, ...task, commandId: teamCommandIdSchema, action: z.enum(['adopt', 'withdrawDocument']),
  revision: serial, bundleId: teamIdSchema.nullable(), digest: teamDigestSchema.nullable(), actorId: teamIdSchema, deviceId: teamIdSchema.nullable(), committedAt: counter
}).strict()
export const taskInputDocumentViewSchema = z.object({ ...governanceIdentityShape, ...task, reference: taskMaterialInputReferenceSchema, text: z.string().min(1).max(1024 * 1024), canWithdraw: z.boolean().default(false) }).strict()
export type TaskInputDocumentView = z.infer<typeof taskInputDocumentViewSchema>
export const taskInputCommandReplySchema = teamCommandReplySchema(taskInputReceiptSchema)
export const taskInputAdoptInputSchema = taskInputScopeSchema.extend({ command: taskInputCommandSchema }).strict()
export const taskInputRevisionInputSchema = taskInputScopeSchema.extend({ revision: serial }).strict()
export type TaskInputScope = z.infer<typeof taskInputScopeSchema>
export type TaskInputBundle = z.infer<typeof taskInputBundleSchema>
export type TaskInputCandidates = z.infer<typeof taskInputCandidatesSchema>
export type TaskInputCommand = z.infer<typeof taskInputCommandSchema>
export type TaskInputReceipt = z.infer<typeof taskInputReceiptSchema>
export type TaskInputRead = z.infer<typeof taskInputReadSchema>

/** Exact server digest preimage; digest itself is excluded. */
export function taskInputBundleDigestText(bundle: TaskInputBundle): string {
  const { digest: _digest, ...content } = taskInputBundleSchema.parse(bundle)
  return taskInputCanonical(content)
}
