import { z } from 'zod'
import { isAbsolute } from 'path'
import { promptImagesSchema } from './images'
import { acpSkillPathsSchema } from '../../../shared/acp-context'
import { acpEnvVarSchema, acpExtraArgSchema, acpModelIdSchema } from '../../../shared/acp-launch-options'

export const idSchema = z.string().min(1).max(200).regex(/^[\w.-]+$/)
export const taskDirSchema = z.string().min(1).max(200).regex(/^[^\\/]+$/).refine((value) => value !== '.' && value !== '..' && value !== 'archive')
export const newSessionSchema = z.object({ agentId: idSchema, profileId: idSchema.optional(), taskDir: taskDirSchema.optional() })
export const bindTaskSchema = z.object({ taskDir: taskDirSchema.nullable(), expectedConnectionGeneration: z.string().min(1).max(200) })
export const sourceReferenceSchema = z.object({
  projectRoot: z.string().min(1).max(4096), taskDir: taskDirSchema, relativePath: z.string().min(1).max(4096),
  displayedRevision: z.string().regex(/^[a-f0-9]{16}$/), targetSessionId: idSchema,
  targetConnectionGeneration: z.string().min(1).max(200).optional(), sectionAnchor: z.string().max(500).optional(), quote: z.string().max(8000).optional()
})
const knowledgeReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), sourceId: z.string().uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal('project'), relativePath: z.string().min(1).max(4096), displayedRevision: z.string().regex(/^[a-f0-9]{16}$/) }).strict()
])
export const promptOptionsSchema = z.object({ promptRequestId: z.uuid().optional(), expectedConnectionGeneration: z.string().min(1).max(200).optional(), expectedProjectGeneration: z.number().int().nonnegative().optional(), expectedKnowledgeScopeToken: z.string().regex(/^[a-f0-9]{64}$/).optional(), knowledgeReferences: z.array(knowledgeReferenceSchema).max(4).optional(), sourceReferences: z.array(sourceReferenceSchema).max(8).optional(), images: promptImagesSchema.optional() })
export const profileSchema = z.object({
  id: idSchema, name: z.string().trim().min(1).max(100), description: z.string().max(2000),
  instructions: z.string().max(32000), runtimeId: idSchema,
  // Empty string survives JSON transport as an explicit reset to Runtime inheritance.
  modelId: z.union([z.literal('').transform(() => undefined), acpModelIdSchema]).nullable().optional(),
  skillPaths: acpSkillPathsSchema.optional(),
  mcpServerNames: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)).max(32).optional(),
  cwd: z.string().max(4096).refine((value) => !value || isAbsolute(value), '请填写完整的绝对工作目录；留空则使用当前项目').optional(),
  maxTurnMinutes: z.number().int().min(1).max(120),
  env: z.array(acpEnvVarSchema).max(50).optional(),
  args: z.array(acpExtraArgSchema).max(50).optional()
})
export { acpConfigurationSchema as configureSchema } from '../../../shared/acp-configuration'

export function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function errorMessage(value: unknown): string {
  const parts: string[] = []
  let current = value
  const seen = new Set<unknown>()
  while (current !== undefined && !seen.has(current) && parts.length < 4) {
    seen.add(current)
    const message = current instanceof Error ? current.message : String(current)
    if (!parts.includes(message)) parts.push(message)
    current = current instanceof Error ? current.cause : undefined
  }
  const message = parts.join('；').replace(/(?:sk-|sk_)[A-Za-z0-9_-]{8,}/g, '[redacted]').replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
  return /AUTH_REQUIRED|authentication required|not authenticated|not logged in/i.test(message)
    ? `${message}。请先在本机终端完成对应 Codex / Claude 登录，再显式重试；面板沿用本机配置。`
    : message
}
