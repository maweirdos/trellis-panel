import { z } from 'zod'

const target = { workspaceKey: z.string().min(1), spaceId: z.string().min(1), actorId: z.string().min(1) }
const taskDesign = z.object({
  documentId: z.string().uuid(), conversationId: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().min(1).max(200)
}).strict()
export type ConversationTaskDesign = z.infer<typeof taskDesign>
export const conversationTaskSource = z.object({
  ...target, taskId: z.string().min(1), taskCreatedAt: z.string().min(1), epoch: z.string().optional(), design: taskDesign.optional(),
  expectedUpdatedAt: z.string().min(1).optional()
}).strict()
export type ConversationTaskSource = z.infer<typeof conversationTaskSource>
export const conversationTaskAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ ...target, action: z.literal('create') }).strict(),
  z.object({ ...target, action: z.literal('check') }).strict(),
  z.object({ ...target, action: z.literal('bind'), taskId: z.string().min(1), taskCreatedAt: z.string().min(1) }).strict()
])
export type ConversationTaskAction = z.infer<typeof conversationTaskAction>
export type ConversationTaskTurn = { requestId: string; sessionId: string; connectionGeneration: string; turnId: string }
export type ConversationTaskResult = { state: 'bound'; taskId: string; spaceId: string; title?: string; origin: 'created' | 'bound'; turn?: ConversationTaskTurn } |
  { state: 'working' | 'unknown' | 'failed'; message: string; spaceId?: string; turn?: ConversationTaskTurn } |
  { state: 'idle'; message: string }
