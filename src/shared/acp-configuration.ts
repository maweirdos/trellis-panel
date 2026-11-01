import { z } from 'zod'

export const acpConfigurationSchema = z.object({
  kind: z.enum(['model', 'mode', 'config']), id: z.string().min(1).max(300), value: z.string().max(1000).optional()
})
export type AcpConfiguration = z.infer<typeof acpConfigurationSchema>

export const conversationConfigureSchema = z.object({
  expectedConnectionGeneration: z.string().min(1).max(200), configuration: acpConfigurationSchema
}).strict()
export const conversationRecoverModelSchema = z.object({
  expectedConnectionGeneration: z.string().min(1).max(200), modelId: z.string().min(1).max(300)
}).strict()
export type ConversationConfigure = z.infer<typeof conversationConfigureSchema>
export type ConversationRecoverModel = z.infer<typeof conversationRecoverModelSchema>
