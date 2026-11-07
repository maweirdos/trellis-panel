import { z } from 'zod'
import type { CruxTask } from '@shared/crux'
import type { TeamTaskMaterialView } from '@shared/team-task-materials'

const referenceSchema = z.object({ documentId: z.string().min(1).max(256), versionId: z.string().min(1).max(256), bodyDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type DesignReference = z.infer<typeof referenceSchema>
const PREFIX = '共享设计版本：'

/** The existing workflow stores handoff text; keep a resolvable fixed reference in that text. */
export function designReferenceBody(reference: DesignReference): string {
  return `${PREFIX}${JSON.stringify(reference)}`
}

export function designHandoffText(body: string): string {
  return body.split('\n').filter((line) => !line.startsWith(PREFIX)).join('\n').trim() || '已关联共享设计固定版本'
}

export function taskDesignReference(task: CruxTask): DesignReference | null {
  for (const event of (task.workflow?.history ?? []).slice().reverse()) {
    if (!['submit_design', 'approve_design'].includes(event.action)) continue
    const line = event.body?.split('\n').find((value) => value.startsWith(PREFIX))
    if (!line) { if (event.action === 'submit_design') return null; continue }
    try { const parsed = referenceSchema.safeParse(JSON.parse(line.slice(PREFIX.length))); if (parsed.success) return parsed.data } catch { /* Unstructured historical handoff. */ }
  }
  return null
}

export function matchesDesignReference(view: TeamTaskMaterialView, task: CruxTask, reference: DesignReference): boolean {
  return view.document.kind === 'design' && view.document.taskId === task.id && view.document.taskCreatedAt === task.createdAt &&
    view.document.spaceId === task.spaceId && view.document.documentId === reference.documentId &&
    view.selected.documentId === reference.documentId && view.selected.versionId === reference.versionId && view.selected.bodyDigest === reference.bodyDigest
}
