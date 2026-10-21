import { z } from 'zod'
import type { IpcFail } from './ipc-errors'

export const taskConversationSourceSchema = z.enum(['codex', 'claude-code', 'zcode'])
export const taskConversationCapabilitySchema = z.enum(['session', 'workspace', 'unavailable'])
export const externalConversationSchema = z.object({
  id: z.string().min(1).max(256),
  source: taskConversationSourceSchema,
  sessionId: z.string().min(1).max(256),
  title: z.string().min(1).max(4096),
  titleSource: z.enum(['native', 'summary', 'fallback']),
  cwd: z.string().min(1).max(4096),
  updatedAt: z.number().int().nonnegative(),
  capability: taskConversationCapabilitySchema,
  unavailableReason: z.string().max(1024).optional(),
  /** Names the actual destination, especially CLI history restore vs desktop focus. */
  destinationLabel: z.string().max(128).optional(),
  /** Native role evidence only. Unknown/older metadata never implies a user session. */
  role: z.enum(['user', 'subagent', 'unknown']).optional(),
  parentSessionId: z.string().max(256).optional()
})
export const taskConversationBindingSchema = z.object({
  id: z.string().min(1).max(256),
  taskDir: z.string().min(1).max(1024),
  taskRef: z.string().min(1).max(2048),
  /** Main-authoritative current ownership; null preserves an orphan without assigning it to a replacement task. */
  currentTaskRef: z.string().min(1).max(2048).nullable(),
  conversation: externalConversationSchema,
  primary: z.boolean(),
  linkedAt: z.number().int().nonnegative(),
  origin: z.enum(['manual', 'runtime'])
})
export const taskConversationSourceStatusSchema = z.object({
  source: taskConversationSourceSchema,
  available: z.boolean(),
  detail: z.string().max(1024).optional()
})
export const taskConversationsSnapshotSchema = z.object({
  projectRoot: z.string(),
  bindings: z.array(taskConversationBindingSchema),
  sources: z.array(taskConversationSourceStatusSchema),
  refreshedAt: z.number().int().nonnegative()
})
export const taskConversationCandidatesSchema = z.object({
  projectRoot: z.string(),
  items: z.array(externalConversationSchema),
  sources: z.array(taskConversationSourceStatusSchema),
  truncated: z.boolean()
})
export const taskConversationOpenResultSchema = z.object({
  source: taskConversationSourceSchema,
  sessionId: z.string(),
  capability: z.enum(['session', 'workspace']),
  detail: z.string().optional(),
  destinationLabel: z.string().max(128).optional()
})
export const taskConversationProjectInputSchema = z.object({ expectedRoot: z.string().min(1).max(4096) }).strict()
export const taskConversationBindInputSchema = taskConversationProjectInputSchema.extend({
  taskDir: z.string().min(1).max(1024), conversationId: z.string().min(1).max(256)
}).strict()
export const taskConversationBindingInputSchema = taskConversationProjectInputSchema.extend({
  taskDir: z.string().min(1).max(1024), bindingId: z.string().min(1).max(256)
}).strict()

export type TaskConversationSource = z.infer<typeof taskConversationSourceSchema>
export type TaskConversationCapability = z.infer<typeof taskConversationCapabilitySchema>
export type ExternalConversation = z.infer<typeof externalConversationSchema>
export type TaskConversationBinding = z.infer<typeof taskConversationBindingSchema>
export type TaskConversationSourceStatus = z.infer<typeof taskConversationSourceStatusSchema>
export type TaskConversationsSnapshot = z.infer<typeof taskConversationsSnapshotSchema>
export type TaskConversationCandidates = z.infer<typeof taskConversationCandidatesSchema>
export type TaskConversationOpenResult = z.infer<typeof taskConversationOpenResultSchema>
export type TaskConversationProjectInput = z.infer<typeof taskConversationProjectInputSchema>
export type TaskConversationBindInput = z.infer<typeof taskConversationBindInputSchema>
export type TaskConversationBindingInput = z.infer<typeof taskConversationBindingInputSchema>

export interface TaskConversationsApi {
  taskConversationsList(input: TaskConversationProjectInput): Promise<{ ok: true; value: TaskConversationsSnapshot } | IpcFail>
  taskConversationsDiscover(input: TaskConversationProjectInput): Promise<{ ok: true; value: TaskConversationCandidates } | IpcFail>
  taskConversationsBind(input: TaskConversationBindInput): Promise<{ ok: true; value: TaskConversationsSnapshot } | IpcFail>
  taskConversationsSetPrimary(input: TaskConversationBindingInput): Promise<{ ok: true; value: TaskConversationsSnapshot } | IpcFail>
  taskConversationsUnbind(input: TaskConversationBindingInput): Promise<{ ok: true; value: TaskConversationsSnapshot } | IpcFail>
  taskConversationsOpen(input: TaskConversationBindingInput): Promise<{ ok: true; value: TaskConversationOpenResult } | IpcFail>
}
