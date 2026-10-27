import { z } from 'zod'

export const piDocumentOpenInputSchema = z.object({
  operationId: z.string().uuid(),
  expectedRoot: z.string().min(1).max(8192),
  sessionId: z.string().min(1).max(256),
  connectionGeneration: z.string().min(1).max(256),
  path: z.string().min(1).max(8192)
}).strict()
export type PiDocumentOpenInput = z.infer<typeof piDocumentOpenInputSchema>
