import { z } from 'zod'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const instruction = z.string().trim().min(1).max(16_000)

export const taskDescriptionSelectionSchema = z.object({
  text: z.string().min(1).max(16_000),
  bodyRevision: digest,
  from: z.number().int().nonnegative().max(200_000),
  to: z.number().int().positive().max(200_000),
  comparisonOnly: z.boolean().optional()
}).strict().refine(value => value.to > value.from && value.text.length === value.to - value.from, 'Task selection must match raw UTF-16 text')

export const taskDescriptionSuggestionStartSchema = z.object({
  conversationId: z.string().uuid(),
  workspaceKey: z.string().min(1),
  actorId: z.string().min(1),
  taskId: z.string().min(1),
  taskCreatedAt: z.string().min(1).max(100),
  commandId: z.string().uuid(),
  selection: taskDescriptionSelectionSchema,
  instruction
}).strict()

export const taskDescriptionSuggestionCheckSchema = z.object({
  conversationId: z.string().uuid(),
  commandId: z.string().uuid()
}).strict()

export const taskDescriptionSuggestionAdoptSchema = z.object({
  conversationId: z.string().uuid(),
  workspaceKey: z.string().min(1),
  actorId: z.string().min(1),
  taskId: z.string().min(1),
  taskCreatedAt: z.string().min(1).max(100),
  commandId: z.string().uuid(),
  expectedDescription: z.string().max(1024 * 1024),
  description: z.string().max(1024 * 1024)
}).strict()

export const taskDescriptionSuggestionCloseSchema = z.object({
  conversationId: z.string().uuid(),
  commandId: z.string().uuid()
}).strict()

export type TaskDescriptionSelection = z.infer<typeof taskDescriptionSelectionSchema>
export type TaskDescriptionSuggestionStart = z.infer<typeof taskDescriptionSuggestionStartSchema>
export type TaskDescriptionSuggestionCheck = z.infer<typeof taskDescriptionSuggestionCheckSchema>
export type TaskDescriptionSuggestionAdopt = z.infer<typeof taskDescriptionSuggestionAdoptSchema>
export type TaskDescriptionSuggestionClose = z.infer<typeof taskDescriptionSuggestionCloseSchema>
export type TaskDescriptionSuggestionResult =
  | { state: 'running'; message: string }
  | { state: 'candidate'; replacement: string; source: TaskDescriptionSelection; message: string }
  | { state: 'adopted'; taskId: string; description: string; message: string }
  | { state: 'closed'; message: string }
  | { state: 'failed'; message: string }
  | { state: 'unknown'; message: string }
