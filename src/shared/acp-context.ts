import { z } from 'zod'

export const acpSkillPathSchema = z.string().min(1).max(2048)
  .transform((value) => value.replace(/\\/g, '/'))
  .refine((value) => !/^[A-Za-z]:|^\/|[\u0000-\u001f\u007f]/u.test(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    && value.endsWith('/SKILL.md'), '请选择当前项目内的 SKILL.md')

export const acpSkillPathsSchema = z.array(acpSkillPathSchema).max(32)
  .refine((values) => new Set(values).size === values.length, '不能重复绑定同一技能')

export const acpSkillContextSchema = z.object({
  relativePath: acpSkillPathSchema,
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  revision: z.string().regex(/^[a-f0-9]{64}$/)
})
export type AcpSkillContext = z.infer<typeof acpSkillContextSchema>

export const acpAgentContextDeliverySchema = z.object({
  state: z.enum(['prepared', 'sent', 'not_sent']),
  method: z.enum(['embedded-resource', 'sdk-context']),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  uri: z.string().max(2048),
  instructionsProvided: z.boolean(),
  skills: z.array(acpSkillContextSchema).max(32),
  connectionGeneration: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200)
})
export type AcpAgentContextDelivery = z.infer<typeof acpAgentContextDeliverySchema>
