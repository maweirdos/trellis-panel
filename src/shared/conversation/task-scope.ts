import { z } from 'zod'
import type { CruxTask } from '../crux'

/** Renderer supplies a locator only. Every authority field is resolved by the host. */
const key = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)

export const conversationTaskLocatorSchema = z.object({
  workspaceKey: key,
  taskId: key,
  taskCreatedAt: z.string().min(1).max(64),
  scopeKey: digest.optional(),
}).strict()
export type ConversationTaskLocator = z.infer<typeof conversationTaskLocatorSchema>

export const conversationTaskBindingSchema = z.object({
  kind: z.literal('task'),
  mode: z.literal('conversation'),
  taskId: key,
  taskCreatedAt: z.string().min(1).max(64),
  spaceId: key,
  handlerId: key,
  assigneeGeneration: z.number().int().positive().safe(),
  materialRevision: digest,
  executionId: z.null(),
  nodeId: z.null(),
  codeRevision: z.null(),
}).strict()
export type ConversationTaskBinding = z.infer<typeof conversationTaskBindingSchema>

/** Host-resolved projection returned to the renderer for the shell header and send gating. */
export const conversationTaskScopeSchema = z.object({
  locator: conversationTaskLocatorSchema,
  scopeKey: digest,
  spaceId: key,
  title: z.string().min(1).max(500),
  workKind: z.enum(['code', 'general']),
  handlerId: key,
  actorId: key,
  actorName: z.string().min(1).max(200),
  materialRevision: digest,
  cwd: z.string().min(1).max(8192),
  binding: conversationTaskBindingSchema,
  closed: z.boolean(),
  canSend: z.boolean(),
  reason: z.string().max(400).optional(),
}).strict()
export type ConversationTaskScope = z.infer<typeof conversationTaskScopeSchema>

export function isOrdinaryConversationTask(task: CruxTask): boolean {
  return !task.workflow && !task.executor && task.workKind !== 'code'
}

export function sameConversationTaskLocator(
  left: ConversationTaskLocator, right: ConversationTaskLocator,
): boolean {
  return left.workspaceKey === right.workspaceKey && left.taskId === right.taskId && left.taskCreatedAt === right.taskCreatedAt
}
