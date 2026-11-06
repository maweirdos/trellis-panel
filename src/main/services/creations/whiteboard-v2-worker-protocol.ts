import { z } from 'zod'
import { whiteboardV2CommandSchema, whiteboardV2ListInputSchema, whiteboardV2ViewInputSchema } from '../../../shared/creation-whiteboard-v2'

export const WHITEBOARD_WORKER_MAX_MESSAGE_BYTES = 3 * 1024 * 1024
export const WHITEBOARD_WORKER_MAX_PENDING_BYTES = 24 * 1024 * 1024
export const WHITEBOARD_WORKER_MAX_PENDING_COUNT = 64
const id = z.string().min(1).max(256)
const uuid = z.string().uuid()
const actorSchema = z.object({
  projectId: id, actorId: id, now: z.number().int().nonnegative().safe(), epoch: uuid.optional(),
  activeMemberIds: z.array(id).max(4096),
  spaces: z.array(z.object({ id, archived: z.boolean(), canRead: z.boolean(), canWrite: z.boolean(), memberIds: z.array(id).max(4096) }).strict()).max(1024),
  tasks: z.array(z.object({ id, spaceId: id }).strict()).max(4096)
}).strict()
const sourceSchema = z.object({ workspaceKey: z.string().min(1).max(8192), actorId: id, projectId: z.literal('local'), epoch: uuid.optional(), sourceIdentity: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
export const whiteboardWorkerPendingSchema = z.object({ source: sourceSchema, command: whiteboardV2CommandSchema, recordedAt: z.number().int().nonnegative().safe() }).strict()
export const whiteboardWorkerOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('init'), root: z.string().min(1).max(8192) }).strict(),
  z.object({ op: z.literal('list'), query: whiteboardV2ListInputSchema, actor: actorSchema, source: sourceSchema }).strict(),
  z.object({ op: z.literal('view'), id: uuid, selection: whiteboardV2ViewInputSchema, actor: actorSchema }).strict(),
  z.object({ op: z.literal('command'), command: whiteboardV2CommandSchema, actor: actorSchema, source: sourceSchema }).strict(),
  z.object({ op: z.literal('receipt'), command: whiteboardV2CommandSchema, actor: actorSchema, source: sourceSchema }).strict(),
  z.object({ op: z.literal('receipt-by-id'), creationId: uuid, commandId: uuid, actor: actorSchema, source: sourceSchema }).strict(),
  z.object({ op: z.literal('pending'), source: sourceSchema, id: uuid, actor: actorSchema }).strict(),
  z.object({ op: z.literal('reserve'), pending: whiteboardWorkerPendingSchema, actor: actorSchema }).strict(),
  z.object({ op: z.literal('settle'), pending: whiteboardWorkerPendingSchema, actor: actorSchema }).strict(),
  z.object({ op: z.literal('close') }).strict()
])
export const whiteboardWorkerRequestSchema = z.object({ requestId: z.number().int().positive().safe(), operation: whiteboardWorkerOperationSchema }).strict()
export const whiteboardWorkerResponseSchema = z.discriminatedUnion('ok', [
  z.object({ requestId: z.number().int().positive().safe(), ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ requestId: z.number().int().positive().safe(), ok: z.literal(false), code: z.string().min(1).max(128), message: z.string().max(2048), outcomeUnknown: z.boolean() }).strict()
])
export type WhiteboardWorkerOperation = z.infer<typeof whiteboardWorkerOperationSchema>
export type WhiteboardWorkerActor = z.infer<typeof actorSchema>
export type WhiteboardWorkerSource = z.infer<typeof sourceSchema>
export type WhiteboardWorkerWrite = Extract<WhiteboardWorkerOperation, { op: 'command' | 'reserve' | 'settle' }>
export function isWhiteboardWrite(operation: WhiteboardWorkerOperation): operation is WhiteboardWorkerWrite {
  return operation.op === 'command' || operation.op === 'reserve' || operation.op === 'settle'
}
export function whiteboardWriteId(operation: WhiteboardWorkerWrite): string {
  return operation.op === 'command' ? operation.command.creationId : operation.pending.command.creationId
}
