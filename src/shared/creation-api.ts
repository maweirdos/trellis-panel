import { z } from 'zod'
import { creationCommandSchema, creationListInputSchema, creationViewInputSchema, type CreationCommandReply, type CreationView } from './creations'

const workspaceKey = z.string().min(1).max(1024)
export const creationClientListSchema = creationListInputSchema.extend({ workspaceKey }).strict()
export const creationClientGetSchema = creationViewInputSchema.extend({ workspaceKey, creationId: z.string().uuid() }).strict()
export const creationClientCommandSchema = z.object({ workspaceKey, command: creationCommandSchema }).strict()
export const creationGenerateSchema = z.object({
  workspaceKey, creationId: z.string().uuid(), commandId: z.string().uuid(), expectedRevision: z.number().int().positive(),
  commentIds: z.array(z.string().uuid()).min(1).max(8), instruction: z.string().trim().max(1000).optional()
}).strict()
export const creationCancelSchema = z.object({ workspaceKey, commandId: z.string().uuid() }).strict()
export const creationRecoverSchema = z.object({ workspaceKey, creationId: z.string().uuid() }).strict()

export type CreationReply<T> = { ok: true; value: T } | { ok: false; code: string; error: string; outcomeUnknown?: boolean }
export type CreationGenerationPlan = { inputBytes: number; estimatedTokens: number; fragmentCount: number; selectedCount: number; maxInputBytes: number; model: string | null; available: boolean }
export type CreationList = z.infer<typeof import('./creations').creationListSchema>
export type CreationApi = {
  list(input: z.input<typeof creationClientListSchema>): Promise<CreationReply<CreationList>>
  get(input: z.input<typeof creationClientGetSchema>): Promise<CreationReply<CreationView>>
  command(input: z.input<typeof creationClientCommandSchema>): Promise<CreationReply<CreationCommandReply>>
  planCandidate(input: z.input<typeof creationGenerateSchema>): Promise<CreationReply<CreationGenerationPlan>>
  generateCandidate(input: z.input<typeof creationGenerateSchema>): Promise<CreationReply<CreationCommandReply>>
  cancelCandidate(input: z.input<typeof creationCancelSchema>): Promise<CreationReply<{ cancelled: boolean }>>
  recover(input: z.input<typeof creationRecoverSchema>): Promise<CreationReply<CreationCommandReply | null>>
  onChanged(callback: (event: { workspaceKey: string; creationId: string | null }) => void): () => void
}
