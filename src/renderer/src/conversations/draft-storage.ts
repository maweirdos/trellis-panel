import { z } from 'zod'
import { modelIdWithinLimit } from '@shared/model-selection'

const storedDraftSchema = z.object({
  key: z.string().min(1).max(200), conversationId: z.string().uuid().optional(),
  kind: z.enum(['work', 'code']), projectId: z.string().max(256).optional(), text: z.string().max(200_000),
  runtimeId: z.string().max(200).optional(), modelId: z.string().optional(), modelTooLong: z.boolean().optional(), dirty: z.boolean(), updatedAt: z.number().finite()
}).strict()
const selections = z.record(z.string().max(1200), z.string().max(200))
const projectSelections = z.record(z.string().max(1200), z.string().max(256).nullable())
const storedWorkspaceSchema = z.object({
  version: z.literal(2), entries: z.array(storedDraftSchema).max(200), selected: selections, projects: projectSelections
}).strict()
export type StoredWorkspace = z.infer<typeof storedWorkspaceSchema>

// V1 is read only during installation-owned cache conversion; it is never used by the live controller.
const legacyContext = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal') }).strict(),
  z.object({ kind: z.literal('team'), workspaceKey: z.string(), spaceId: z.string() }).strict()
])
const legacyWorkspaceSchema = z.object({
  version: z.literal(1), entries: z.array(storedDraftSchema.extend({ context: legacyContext })).max(40),
  selected: selections, projects: projectSelections, context: legacyContext.optional()
}).strict()
const prefix = 'tpanel.private-conversations.'
const storageKey = (owner: string): string => `${prefix}v2.${encodeURIComponent(owner)}`
function readJson(raw: string): unknown {
  if (raw.length > 4_000_000) throw new Error('本机草稿缓存超出读取范围，请先保留输入。')
  return JSON.parse(raw)
}
function safeModels(value: StoredWorkspace): StoredWorkspace {
  return { ...value, entries: value.entries.map((item) => item.modelId && !modelIdWithinLimit(item.modelId) ? { ...item, modelId: undefined, modelTooLong: true } : item) }
}

export function readStoredWorkspace(owner: string, admittedConversationIds: ReadonlySet<string>): StoredWorkspace | null {
  const raw = localStorage.getItem(storageKey(owner))
  if (raw !== null) return safeModels(storedWorkspaceSchema.parse(readJson(raw)))
  const legacyKeys = new Set([`${prefix}v1.${encodeURIComponent(owner)}`])
  const installationLegacyPrefix = `${prefix}v1.${encodeURIComponent(`${owner}:team:`)}`
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (key?.startsWith(installationLegacyPrefix)) legacyKeys.add(key)
  }
  const snapshots = [...legacyKeys].flatMap((key) => {
    const value = localStorage.getItem(key)
    return value === null ? [] : [legacyWorkspaceSchema.parse(readJson(value))]
  }).sort((a, b) => Number(Boolean(b.context)) - Number(Boolean(a.context)) || Math.max(0, ...b.entries.map((item) => item.updatedAt)) - Math.max(0, ...a.entries.map((item) => item.updatedAt)))
  if (!snapshots.length) return null
  const entries = new Map<string, StoredWorkspace['entries'][number]>()
  for (const snapshot of snapshots) for (const legacy of snapshot.entries) {
    const { context, ...item } = legacy
    if (context.kind === 'team' && (!item.conversationId || !admittedConversationIds.has(item.conversationId))) continue
    const migrated = { ...item, ...(context.kind === 'team' ? { projectId: undefined } : {}) }
    const previous = entries.get(item.key)
    if (!previous || item.updatedAt > previous.updatedAt) entries.set(item.key, migrated)
  }
  const selected: StoredWorkspace['selected'] = {}, projects: StoredWorkspace['projects'] = {}
  for (const snapshot of snapshots) {
    for (const key of Object.values(snapshot.selected)) {
      const item = entries.get(key)
      if (item) selected[`${item.kind}:${item.projectId ?? ''}`] ??= key
    }
    for (const [scope, project] of Object.entries(snapshot.projects)) {
      const kind = scope.split(':', 1)[0]
      if ((kind === 'work' || kind === 'code') && !(kind in projects)) {
        const selectedEntry = entries.get(snapshot.selected[`${scope}:${project ?? ''}`] ?? '')
        if (scope === `${kind}:personal`) projects[kind] = project
        else if (selectedEntry) projects[kind] = selectedEntry.projectId ?? null
      }
    }
  }
  const migrated: StoredWorkspace = safeModels({ version: 2, entries: [...entries.values()], selected, projects })
  writeStoredWorkspace(owner, migrated)
  return migrated
}

export function writeStoredWorkspace(owner: string, value: StoredWorkspace): void {
  const raw = JSON.stringify(storedWorkspaceSchema.parse(safeModels(value)))
  if (raw.length > 4_000_000) throw new Error('本机草稿缓存已满，请先为 Code 草稿选择目录并保存。')
  localStorage.setItem(storageKey(owner), raw)
}

/** Installation tokens never become storage keys or persisted plaintext. */
export async function installationNamespace(token: string): Promise<string> {
  if (!token) throw new Error('尚未确认本机身份，输入暂保留在当前窗口。')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return `native:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
