import { z } from 'zod'
import { hifoxProgressQuerySchema, hifoxProgressStartSchema, hifoxProgressSendSchema, hifoxProgressRespondSchema, hifoxProgressEventsSchema } from './hifox-task-progress'
import { teamTaskProgressCommandReplySchema, teamTaskProgressDtoSchema, teamTaskProgressStateSchema } from './team-task-progress'
import { hifoxWorkMaterialSchema } from './hifox-work'

export const taskProgressPinSchema = z.object({
  workspaceKey: z.string().min(1).max(256), taskId: z.string().min(1).max(200), spaceId: z.string().min(1).max(200),
  connectionId: z.string().uuid(), origin: z.string().url(), pairingId: z.string().uuid(),
  ownerId: z.string().uuid(), deviceId: z.string().uuid(), projectId: z.string().uuid(),
  epoch: z.string().uuid(), instanceId: z.string().uuid(), handlerId: z.string().min(1).max(200)
}).strict()
export type TaskProgressPin = z.infer<typeof taskProgressPinSchema>
export const taskProgressSummarySchema = z.object({
  activity: teamTaskProgressStateSchema,
  step: z.string().trim().min(1).max(500).regex(/^[^\r\n\u0000-\u001f\u007f]+$/).nullable(),
  blocker: z.string().trim().min(1).max(500).regex(/^[^\r\n\u0000-\u001f\u007f]+$/).nullable()
}).strict()
export const taskProgressPlanSchema = z.object({
  root: z.string().min(1).max(8192), taskDir: z.string().min(1).max(200).optional(),
  inputVersion: z.string().regex(/^[a-f0-9]{64}$/), prompt: z.string().min(1).max(32000),
  sourceVersion: z.string().regex(/^[a-f0-9]{64}$/), material: hifoxWorkMaterialSchema.optional(),
  managedDirectory: z.boolean(), engine: hifoxProgressStartSchema.shape.engine, agentId: z.string().max(200).optional()
}).strict()
export const taskProgressNativeSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('catalog') }).strict(),
  z.object({ operation: z.literal('read'), query: hifoxProgressQuerySchema }).strict(),
  z.object({ operation: z.literal('prepare'), pin: taskProgressPinSchema, server: teamTaskProgressDtoSchema, plan: taskProgressPlanSchema.nullable(), takeover: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal('observe'), query: hifoxProgressQuerySchema, server: teamTaskProgressDtoSchema }).strict(),
  z.object({ operation: z.literal('take'), query: hifoxProgressQuerySchema }).strict(),
  z.object({ operation: z.literal('ack'), query: hifoxProgressQuerySchema, reply: teamTaskProgressCommandReplySchema }).strict(),
  z.object({ operation: z.literal('fail'), query: hifoxProgressQuerySchema, commandId: z.string().uuid().optional(), code: z.string().max(100), uncertain: z.boolean(), terminal: z.boolean() }).strict(),
  z.object({ operation: z.literal('report'), query: hifoxProgressQuerySchema, summary: taskProgressSummarySchema }).strict(),
  z.object({ operation: z.literal('run'), query: hifoxProgressQuerySchema }).strict(),
  z.object({ operation: z.literal('detach'), query: hifoxProgressQuerySchema }).strict(),
  z.object({ operation: z.literal('conversation'), query: hifoxProgressQuerySchema }).strict(),
  z.object({ operation: z.literal('events'), input: hifoxProgressEventsSchema }).strict(),
  z.object({ operation: z.literal('send'), input: hifoxProgressSendSchema }).strict(),
  z.object({ operation: z.literal('respond'), input: hifoxProgressRespondSchema }).strict(),
  z.object({ operation: z.literal('cancel'), query: hifoxProgressQuerySchema }).strict(),
  z.object({ operation: z.literal('resume'), query: hifoxProgressQuerySchema }).strict(),
  z.object({ operation: z.literal('sync'), query: hifoxProgressQuerySchema }).strict(),
  z.object({ operation: z.literal('official'), query: hifoxProgressQuerySchema }).strict()
])
export type TaskProgressNativeInput = z.infer<typeof taskProgressNativeSchema>
