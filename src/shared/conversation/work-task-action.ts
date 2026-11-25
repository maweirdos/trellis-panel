import { z } from 'zod'

export const workTaskActionChannel = 'conversation:workTaskAction'

const original = z.object({
  cwd: z.string().min(1).max(8192),
  threadId: z.string().min(1).max(200).regex(/^[\w.-]+$/),
  workspaceKey: z.string().min(1).max(512),
  commandId: z.string().uuid(),
}).strict()
const spaceId = z.string().min(1).max(200)

export const workTaskActionSchema = z.discriminatedUnion('action', [
  original.extend({ action: z.literal('generate'), spaceId }),
  original.extend({ action: z.literal('bind'), spaceId, taskId: z.string().min(1).max(200), taskCreatedAt: z.string().min(1).max(100),
    expectedAuthorizationRevision: z.number().int().nonnegative().safe().optional() }),
  original.extend({ action: z.literal('status') }),
  original.extend({ action: z.literal('publish'), candidateRevision: z.string().regex(/^[a-f0-9]{64}$/) }),
  original.extend({ action: z.literal('retry') }),
])

export type WorkTaskAction = z.infer<typeof workTaskActionSchema>
export type WorkTaskActionValue =
  | { state: 'idle' | 'working' | 'unknown' | 'failed'; detail: string; canRetry?: true }
  | { state: 'candidate'; candidateRevision: string; title: string; description: string }
  | { state: 'bound'; taskId: string; spaceId: string; taskCreatedAt: string }
