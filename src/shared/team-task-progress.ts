import { z } from 'zod'
import { teamCommandIdSchema, teamIdSchema } from './team-platform'

const counter = z.number().int().nonnegative().safe()
export const teamTaskProgressResourceIdSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.-]+$/)
const text = z.string().trim().min(1).max(500).refine((value) => !/[\r\n\u0000-\u001f\u007f]/.test(value), 'Use a short single-line summary')
const opaqueName = z.string().min(1).max(200).regex(/^[\p{L}\p{N}_.@ -]+$/u)
const directoryName = z.string().trim().min(1).max(100).refine((value) => !/[\\/:\u0000-\u001f\u007f]/.test(value) && value !== '.' && value !== '..', 'Use a directory display name without a path')

export const teamTaskProgressStateSchema = z.enum(['running', 'waiting_confirmation', 'paused', 'interrupted', 'idle'])
export const teamTaskProgressSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('desktop'), sessionId: opaqueName, engine: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/), directoryName }).strict(),
  z.object({ kind: z.literal('web') }).strict()
])
export const teamTaskProgressBindingSchema = z.object({
  bindingId: z.string().uuid(), generation: counter, reporterId: teamIdSchema,
  deviceId: teamIdSchema.nullable(), source: teamTaskProgressSourceSchema
}).strict()
export const teamTaskProgressRecordSchema = z.object({
  seq: counter, state: teamTaskProgressStateSchema, step: text.nullable(), blockingReason: text.nullable(), updatedAt: counter
}).strict()
export const teamTaskProgressDtoSchema = z.object({
  instanceId: z.string().uuid(), epoch: z.string().uuid(), authorizationRevision: counter,
  projectId: teamIdSchema, taskId: teamTaskProgressResourceIdSchema, spaceId: teamTaskProgressResourceIdSchema, generation: counter,
  binding: teamTaskProgressBindingSchema.nullable(), progress: teamTaskProgressRecordSchema.nullable(), serverTime: counter
}).strict()
const envelope = { commandId: teamCommandIdSchema, expectedEpoch: z.string().uuid() }
export const teamTaskProgressCommandSchema = z.discriminatedUnion('kind', [
  z.object({ ...envelope, kind: z.literal('bind'), expectedGeneration: counter, expectedBindingId: z.string().uuid().nullable(), source: teamTaskProgressSourceSchema }).strict(),
  z.object({ ...envelope, kind: z.literal('report'), bindingId: z.string().uuid(), seq: counter.min(1), state: teamTaskProgressStateSchema, step: text.nullable(), blockingReason: text.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal('release'), bindingId: z.string().uuid(), seq: counter.min(1) }).strict()
])
export const teamTaskProgressCommandReplySchema = z.object({
  status: z.enum(['committed', 'duplicate']), commandId: teamCommandIdSchema, result: teamTaskProgressDtoSchema
}).strict()
/** Compact acknowledgement only: summaries are overwritten, never retained in receipts. */
export const teamTaskProgressReceiptSchema = z.object({
  commandId: teamCommandIdSchema, kind: z.enum(['bind', 'report', 'release']), epoch: z.string().uuid(),
  generation: counter, bindingId: z.string().uuid().nullable(), seq: counter, committedAt: counter
}).strict()

export type TeamTaskProgressState = z.infer<typeof teamTaskProgressStateSchema>
export type TeamTaskProgressSource = z.infer<typeof teamTaskProgressSourceSchema>
export type TeamTaskProgressBinding = z.infer<typeof teamTaskProgressBindingSchema>
export type TeamTaskProgressRecord = z.infer<typeof teamTaskProgressRecordSchema>
export type TeamTaskProgressDto = z.infer<typeof teamTaskProgressDtoSchema>
export type TeamTaskProgressCommand = z.infer<typeof teamTaskProgressCommandSchema>
export type TeamTaskProgressCommandReply = z.infer<typeof teamTaskProgressCommandReplySchema>
export type TeamTaskProgressReceipt = z.infer<typeof teamTaskProgressReceiptSchema>
