import { z } from 'zod'
import { isAbsolute } from 'path'
import { promptImagesSchema } from './images'
import { acpSkillPathsSchema } from '../../../shared/acp-context'

export const idSchema = z.string().min(1).max(200).regex(/^[\w.-]+$/)
export const taskDirSchema = z.string().min(1).max(200).regex(/^[^\\/]+$/).refine((value) => value !== '.' && value !== '..' && value !== 'archive')
export const newSessionSchema = z.object({ agentId: idSchema, profileId: idSchema.optional(), taskDir: taskDirSchema.optional() })
export const bindTaskSchema = z.object({ taskDir: taskDirSchema.nullable(), expectedConnectionGeneration: z.string().min(1).max(200) })
export const sourceReferenceSchema = z.object({
  projectRoot: z.string().min(1).max(4096), taskDir: taskDirSchema, relativePath: z.string().min(1).max(4096),
  displayedRevision: z.string().regex(/^[a-f0-9]{16}$/), targetSessionId: idSchema,
  targetConnectionGeneration: z.string().min(1).max(200).optional(), sectionAnchor: z.string().max(500).optional(), quote: z.string().max(8000).optional()
})
export const promptOptionsSchema = z.object({ expectedConnectionGeneration: z.string().min(1).max(200).optional(), sourceReferences: z.array(sourceReferenceSchema).max(8).optional(), images: promptImagesSchema.optional() })
export const profileSchema = z.object({
  id: idSchema, name: z.string().trim().min(1).max(100), description: z.string().max(2000),
  instructions: z.string().max(32000), runtimeId: idSchema,
  skillPaths: acpSkillPathsSchema.optional(),
  cwd: z.string().max(4096).refine((value) => !value || isAbsolute(value), '请填写完整的绝对工作目录；留空则使用当前项目').optional(),
  maxTurnMinutes: z.number().int().min(1).max(120),
  env: z.array(z.object({ key: z.string().trim().min(1).max(200).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '环境变量名只能包含字母、数字和下划线，且不以数字开头'), value: z.string().max(4000) })).max(50).optional(),
  args: z.array(z.object({ name: z.string().trim().min(1).max(200), value: z.string().max(4000) })).max(50).optional()
})
export const configureSchema = z.object({ kind: z.enum(['model', 'mode', 'config']), id: z.string().min(1).max(300), value: z.string().max(1000).optional() })

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
