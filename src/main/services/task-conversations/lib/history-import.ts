import { join } from 'node:path'
import { z } from 'zod'
import type { ExternalConversation } from '../../../../shared/task-conversations'
import type { NativeTaskEvidence } from '../types'
import type { KnownTaskDir } from '../../task-identity'
import { sameTask } from './identity'
import { ownedPath, readBounded, timestamp } from './paths'
import type { ConversationStore } from './store'
import { isCodexSubagent } from './codex'

const creationSchema = z.object({ createdAt: z.union([z.string(), z.number()]).optional(), created_at: z.union([z.string(), z.number()]).optional() })
function existedAt(root: string, task: KnownTaskDir, occurredAt: number): boolean {
  if (!occurredAt) return false
  try {
    const parsed = creationSchema.safeParse(JSON.parse(readBounded(ownedPath(root, join(root, task.dir, 'task.json')), 256 * 1024)))
    if (!parsed.success) return false
    const created = timestamp(parsed.data.createdAt ?? parsed.data.created_at)
    return created > 0 && created <= occurredAt
  } catch { return false }
}

export function importHistory(root: string, known: KnownTaskDir[], items: ExternalConversation[], evidence: NativeTaskEvidence[], store: ConversationStore, now: number): void {
  for (const hint of evidence) {
    const conversation = items.find(item => item.source === hint.source && item.sessionId === hint.sessionId && !isCodexSubagent(item))
    if (!conversation) continue
    const owners = store.owners()
    const exact = known.find(task => task.dir === hint.taskDir)
    let task: KnownTaskDir | undefined
    if (hint.trellisId) {
      // A reused original is never redirected to some other task with the historical ID.
      if (exact && exact.trellisTaskId !== hint.trellisId) continue
      const matches = known.filter(item => item.trellisTaskId === hint.trellisId)
      if (matches.length !== 1) continue
      task = matches[0]
    } else {
      // Paths cannot establish an archived/renamed task's stable identity.
      if (!exact || exact.dir.startsWith('.trellis/tasks/archive/') || !existedAt(root, exact, hint.occurredAt)) continue
      if (owners.some(owner => (owner.currentDir === exact.dir || owner.priorDirs.includes(exact.dir)) && owner.trellisId !== exact.trellisTaskId)) continue
      task = exact
    }
    if (task.trellisTaskId && known.filter(item => item.trellisTaskId === task.trellisTaskId).length !== 1) continue
    const owner = owners.find(item => sameTask(item, task))
    if (!owner && task.trellisTaskId && owners.some(item => item.trellisId === task.trellisTaskId)) continue
    store.bind(owner ?? store.owner(task), conversation, 'runtime', now)
  }
}
