import { z } from 'zod'
import { conversationContextSchema } from '@shared/private-conversations'

const storedDraftSchema = z.object({
  key: z.string().min(1).max(200), conversationId: z.string().uuid().optional(),
  kind: z.enum(['work', 'code']), context: conversationContextSchema,
  projectId: z.string().max(256).optional(), text: z.string().max(200_000),
  runtimeId: z.string().max(200).optional(), dirty: z.boolean(), updatedAt: z.number().finite()
}).strict()
const storedWorkspaceSchema = z.object({
  version: z.literal(1), entries: z.array(storedDraftSchema).max(40),
  selected: z.record(z.string().max(1200), z.string().max(200)),
  projects: z.record(z.string().max(1200), z.string().max(256).nullable()),
  context: conversationContextSchema.optional()
}).strict()
export type StoredWorkspace = z.infer<typeof storedWorkspaceSchema>

const storageKey = (owner: string): string => `tpanel.private-conversations.v1.${encodeURIComponent(owner)}`
export function readStoredWorkspace(owner: string): StoredWorkspace | null {
  const raw = localStorage.getItem(storageKey(owner))
  if (!raw) return null
  if (raw.length > 4_000_000) throw new Error('本机草稿缓存超出读取范围，请先保留输入。')
  const result = storedWorkspaceSchema.safeParse(JSON.parse(raw))
  if (!result.success) throw new Error('本机草稿缓存无法读取，未覆盖已有草稿。')
  return result.data
}
export function writeStoredWorkspace(owner: string, value: StoredWorkspace): void {
  const raw = JSON.stringify(storedWorkspaceSchema.parse(value))
  if (raw.length > 4_000_000) throw new Error('本机草稿缓存已满，请先为 Code 草稿选择目录并保存。')
  localStorage.setItem(storageKey(owner), raw)
}

/** Installation tokens never become storage keys or persisted plaintext. */
export async function installationNamespace(token: string): Promise<string> {
  if (!token) throw new Error('尚未确认本机身份，输入暂保留在当前窗口。')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return `native:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
