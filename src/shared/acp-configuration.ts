import { z } from 'zod'
import { modelIdWithinLimit, modelSelectionIdSchema } from './model-selection'

export const acpConfigurationSchema = z.object({
  kind: z.enum(['model', 'mode', 'config']), id: z.string().min(1), value: z.string().optional()
}).refine(value => value.kind === 'model' ? modelIdWithinLimit(value.id) : value.id.length <= 300, '模型或配置项 ID 超出长度限制')
  .refine(value => value.value === undefined || value.value.length <= 1000 || modelIdWithinLimit(value.value), '配置值超出长度限制')
export type AcpConfiguration = z.infer<typeof acpConfigurationSchema>

export const conversationConfigureSchema = z.object({
  expectedConnectionGeneration: z.string().min(1).max(200), configuration: acpConfigurationSchema
}).strict()
export const conversationRecoverModelSchema = z.object({
  expectedConnectionGeneration: z.string().min(1).max(200), modelId: modelSelectionIdSchema
}).strict()
export type ConversationConfigure = z.infer<typeof conversationConfigureSchema>
export type ConversationRecoverModel = z.infer<typeof conversationRecoverModelSchema>
