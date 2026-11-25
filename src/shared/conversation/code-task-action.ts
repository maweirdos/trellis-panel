import { z } from 'zod'

export const codeTaskActionChannel = 'conversation:codeTaskAction'

const root = z.string().min(1).max(8192).regex(/^[^\u0000-\u001f\u007f]+$/u)
const threadId = z.string().min(1).max(200).regex(/^[\w.-]+$/u)
export const codeTaskDirectory = z.string().min(1).max(200)
  .refine(value => value !== 'archive' && !/[\\/:<>|"*?\u0000-\u001f\u007f]|[ .]$/u.test(value), '任务目录无效')
const taskRef = z.string().min(1).max(2048)
  .regex(/^(?:task:.{1,256}|dir:\.trellis\/tasks\/[^/]+)$/u, '本地任务身份无效')
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), '本地任务身份无效')
const taskIdentity = z.string().regex(/^\d+:\d+:\d+$/u)

export const codeTaskActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list'), cwd: root }),
  z.strictObject({ action: z.literal('status'), cwd: root, threadId, commandId: z.string().uuid().optional() }),
  z.strictObject({ action: z.literal('bind'), cwd: root, threadId, commandId: z.string().uuid(), taskDir: codeTaskDirectory, taskRef, taskIdentity }),
])

export type CodeTaskAction = z.infer<typeof codeTaskActionSchema>

export interface CodeTaskSummary {
  readonly taskDir: string
  readonly taskRef: string
  readonly taskIdentity: string
  readonly title: string
  readonly status?: string
  readonly updatedAt: number
}

export type CodeTaskActionValue =
  | { readonly state: 'tasks'; readonly root: string; readonly tasks: readonly CodeTaskSummary[]; readonly truncated: boolean }
  | { readonly state: 'idle'; readonly detail: string }
  | { readonly state: 'bound'; readonly taskDir: string; readonly taskRef: string; readonly title: string }
  | { readonly state: 'conflict' | 'failed'; readonly detail: string }

export interface ComposerCodeTaskSelection {
  readonly authority: string
  readonly commandId: string
  readonly taskDir: string
  readonly taskRef: string
  readonly taskIdentity: string
  readonly title: string
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isComposerCodeTaskSelection(value: unknown): value is ComposerCodeTaskSelection {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.authority === 'string' && item.authority.length > 0 && item.authority.length <= 4096
    && typeof item.commandId === 'string' && uuidPattern.test(item.commandId)
    && codeTaskDirectory.safeParse(item.taskDir).success
    && typeof item.taskRef === 'string' && taskRef.safeParse(item.taskRef).success
    && taskIdentity.safeParse(item.taskIdentity).success
    && typeof item.title === 'string' && item.title.trim().length > 0 && item.title.length <= 500
}
