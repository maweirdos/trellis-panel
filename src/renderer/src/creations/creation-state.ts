import type { CreationComment, CreationScenario, CreationSummary, CreationView } from '@shared/creations'
import { creationBodySchema, creationScenarioSchema } from '@shared/creations'
import { utf8ByteLength } from '@shared/material-budget'

export type CreationTarget = CreationComment['target']
export type CreationDraft = {
  baseSerial: number
  baseRevisionId: string
  title: string
  body: string
  scenarios: CreationScenario[]
  privateNotes?: string
  dirty: boolean
}

/** Local unsaved inputs only. No record, permission or server success is inferred here. */
const retainedDrafts = new Map<string, CreationDraft>()
const MAX_RETAINED_DRAFTS = 24

export function readRetainedDraft(key: string): CreationDraft | undefined { return retainedDrafts.get(key) }

export function retainDraft(key: string, draft: CreationDraft): void {
  retainedDrafts.delete(key)
  if (draft.dirty) retainedDrafts.set(key, draft)
  while (retainedDrafts.size > MAX_RETAINED_DRAFTS) {
    const oldest = retainedDrafts.keys().next().value
    if (oldest === undefined) break
    retainedDrafts.delete(oldest)
  }
}

export function draftFromView(view: CreationView): CreationDraft | null {
  if (!view.draft || view.selected.revisionId !== view.draft.revisionId) return null
  return {
    baseSerial: view.draft.serial, baseRevisionId: view.draft.revisionId,
    title: view.summary.title, body: view.selected.body, scenarios: structuredClone(view.selected.scenarios),
    ...(view.privateNotes !== undefined ? { privateNotes: view.privateNotes } : {}), dirty: false
  }
}

export function sameDraftContents(left: CreationDraft, right: CreationDraft): boolean {
  return left.title === right.title && left.body === right.body && left.privateNotes === right.privateNotes && JSON.stringify(left.scenarios) === JSON.stringify(right.scenarios)
}

export function validateDraft(draft: Pick<CreationDraft, 'title' | 'body' | 'scenarios'>): string | null {
  if (!draft.title.trim() || draft.title.trim().length > 200) return '标题需为 1–200 个字符'
  if (!creationBodySchema.safeParse(draft.body).success) return '正文超过 256 KiB UTF-8 上限'
  if (draft.scenarios.length > 40) return '最多保存 40 个场景'
  for (const [index, scenario] of draft.scenarios.entries()) {
    const result = creationScenarioSchema.safeParse({ ...scenario, preconditions: scenario.preconditions.filter((line) => line.trim()) })
    if (!result.success) return `场景 ${index + 1}：请填写标题、至少一个步骤与预期结果，单项不超过 2000 字`
  }
  return null
}

export function mergeSummaries(current: CreationSummary[], incoming: CreationSummary[]): CreationSummary[] {
  const entries = new Map(current.map((item) => [item.creationId, item]))
  for (const item of incoming) entries.set(item.creationId, item)
  return Array.from(entries.values())
}

export function mergeComments(current: CreationComment[], incoming: CreationComment[]): CreationComment[] {
  const entries = new Map(current.map((item) => [item.commentId, item]))
  for (const item of incoming) entries.set(item.commentId, item)
  return Array.from(entries.values())
}

export function targetLabel(target: CreationTarget): string {
  switch (target.kind) {
    case 'web': return target.name || target.text || target.stableId || target.selector || target.role || '页面区域'
    case 'text': return `“${target.quote.slice(0, 50)}${target.quote.length > 50 ? '…' : ''}”`
    case 'scenario': return '交互场景'
    case 'general': return '整体意见'
  }
}

export function bodySize(body: string): string {
  return `${(utf8ByteLength(body) / 1024).toFixed(1)} / 256 KiB`
}
