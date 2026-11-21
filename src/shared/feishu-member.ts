import { z } from 'zod'
import { cruxMutationInputSchemas } from './crux-domain/commands'
import { cruxRemoteCommandReplySchema, cruxRemoteCommandSchema, cruxRemoteSnapshotSchema } from './crux-remote'
import { cruxFeishuSourceSchema, cruxTaskActionSchema, cruxTaskStageSchema } from './crux-schema'
import { teamCommandIdSchema, teamIdSchema } from './team-platform'

export const feishuMemberCodeTtlMs = 5 * 60 * 1000
export const feishuMemberCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/)
const appId = z.string().regex(/^cli_[A-Za-z0-9]{1,100}$/)
const nativeId = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/)
const spaceId = nativeId
const timestamp = z.number().int().nonnegative().safe()

export const feishuMemberIdentitySchema = z.object({
  appId,
  tenantKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  senderOpenId: z.string().regex(/^ou_[A-Za-z0-9_-]{1,120}$/)
}).strict()
export type FeishuMemberIdentity = z.infer<typeof feishuMemberIdentitySchema>

export const feishuMemberSpaceSchema = z.object({ spaceId }).strict()
export const feishuMemberReadySchema = z.object({ epoch: teamIdSchema, instanceId: teamIdSchema }).strict()
export const feishuMemberCodeReplySchema = z.object({ code: feishuMemberCodeSchema, expiresAt: timestamp }).strict()
export const feishuMemberBindingSchema = z.object({ bindingId: teamIdSchema, appId, linkedAt: timestamp }).strict()
export const feishuMemberBindingsSchema = z.array(feishuMemberBindingSchema).max(50)
export const feishuMemberRevokeSchema = feishuMemberSpaceSchema.extend({ bindingId: teamIdSchema })
export const feishuMemberScopeSchema = feishuMemberSpaceSchema.extend({ identity: feishuMemberIdentitySchema })
export const feishuMemberClaimSchema = feishuMemberScopeSchema.extend({ code: feishuMemberCodeSchema })
export const feishuMemberClaimReplySchema = z.object({ bindingId: teamIdSchema, actorId: teamIdSchema }).strict()
export const feishuMemberSnapshotSchema = feishuMemberScopeSchema.extend({ bindingId: teamIdSchema.optional(), agentId: nativeId.optional() })
export const feishuMemberSnapshotReplySchema = z.object({ bindingId: teamIdSchema, snapshot: cruxRemoteSnapshotSchema }).strict()

const commandPin = cruxRemoteCommandSchema.pick({ commandId: true, expectedEpoch: true, expectedRevision: true }).extend({
  expectedAuthorizationRevision: cruxRemoteSnapshotSchema.shape.authorizationRevision
})
const create = cruxMutationInputSchemas.createTask.pick({ spaceId: true, title: true }).extend({
  description: z.string().trim().min(1).max(50_000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).max(20),
  triagePending: z.literal(true), feishuSource: cruxFeishuSourceSchema
})
const patch = cruxMutationInputSchemas.updateTask.shape.patch.pick({ title: true, priority: true })
  .extend({ description: z.string().trim().min(1).max(8000).optional() })
  .refine(value => value.title !== undefined || value.description !== undefined || value.priority !== undefined)
const transition = z.object({
  taskId: nativeId,
  action: cruxTaskActionSchema.exclude(['reassign']),
  body: z.string().trim().max(8_000).optional(),
  expectedStage: cruxTaskStageSchema.optional(),
  expectedUpdatedAt: z.string().min(1).max(64)
}).strict()
export const feishuMemberTaskCommandSchema = z.discriminatedUnion('operation', [
  commandPin.extend({ operation: z.literal('createTask'), input: create }),
  commandPin.extend({ operation: z.literal('updateTask'), input: z.object({ id: nativeId, patch }).strict() }),
  commandPin.extend({ operation: z.literal('transitionTask'), input: transition })
])
const boundScope = feishuMemberScopeSchema.extend({ bindingId: teamIdSchema })
export const feishuMemberCommandSchema = boundScope.extend({ command: feishuMemberTaskCommandSchema })
export const feishuMemberCommandReplySchema = cruxRemoteCommandReplySchema.extend({ bindingId: teamIdSchema })
export const feishuMemberReceiptSchema = boundScope.extend({ commandId: teamCommandIdSchema })
export const feishuMemberReceiptReplySchema = z.object({
  bindingId: teamIdSchema,
  result: cruxRemoteSnapshotSchema.nullable(),
  current: cruxRemoteSnapshotSchema
}).strict()

export type FeishuMemberTaskCommand = z.infer<typeof feishuMemberTaskCommandSchema>
export type FeishuMemberClaim = z.infer<typeof feishuMemberClaimSchema>
export type FeishuMemberSnapshot = z.infer<typeof feishuMemberSnapshotSchema>
export type FeishuMemberCommand = z.infer<typeof feishuMemberCommandSchema>
export type FeishuMemberReceipt = z.infer<typeof feishuMemberReceiptSchema>

export function feishuMemberBase(projectId: string): string {
  return `/api/projects/${teamIdSchema.parse(projectId)}/crux/feishu`
}
