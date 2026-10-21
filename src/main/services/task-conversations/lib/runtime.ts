import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ExternalConversation, TaskConversationSource } from '../../../../shared/task-conversations'
import type { KnownTaskDir } from '../../task-identity'
import { boundedEntries, ownedPath, pathKey, readBounded, safeId } from './paths'
import { resolveTask, sameTask } from './identity'
import type { ConversationStore } from './store'
import { isCodexSubagent } from './codex'

const runtimeSchema = z.object({
  current_task: z.string().min(1).max(1024), platform: z.string().max(128).optional(),
  session_id: z.string().max(256).optional(), sessionId: z.string().max(256).optional(),
  cwd: z.string().max(4096).optional()
})
function sourceFor(platform: string | undefined): TaskConversationSource | undefined {
  if (platform === 'codex') return 'codex'
  if (platform === 'claude' || platform === 'claude-code') return 'claude-code'
  if (platform === 'zcode') return 'zcode'
  return undefined
}
export function importRuntime(root: string, known: KnownTaskDir[], items: ExternalConversation[], store: ConversationStore, now: number): void {
  const directory = join(root, '.trellis', '.runtime', 'sessions')
  if (!existsSync(directory)) return
  const owned = ownedPath(root, directory)
  for (const file of boundedEntries(owned).names) {
    if (!file.endsWith('.json')) continue
    let record: z.infer<typeof runtimeSchema>
    try {
      const parsed = runtimeSchema.safeParse(JSON.parse(readBounded(ownedPath(owned, join(owned, file)), 64 * 1024)))
      if (!parsed.success) continue
      record = parsed.data
    } catch { continue }
    let task: KnownTaskDir
    try { task = resolveTask(root, record.current_task, known) } catch { continue }
    if (task.trellisTaskId && known.filter(item => item.trellisTaskId === task.trellisTaskId).length !== 1) continue
    const explicitId = record.session_id || record.sessionId
    const legacyId = file.slice(0, -5).replace(/^(?:claude_sess_|claude_|codex_|zcode_)/, '')
    const id = explicitId || legacyId
    if (!safeId(id)) continue
    const source = sourceFor(record.platform)
    if (record.platform && record.platform !== 'session' && !source) continue
    const candidates = items.filter(item => !isCodexSubagent(item) && item.sessionId === id && (!source || item.source === source)
      && (!record.cwd || pathKey(record.cwd) === pathKey(item.cwd)))
    // Runtime records are hints; only a unique native ID+project match is imported.
    if (candidates.length !== 1) continue
    const owners = store.owners()
    const owner = owners.find(item => sameTask(item, task))
    // Reconciliation deliberately leaves ambiguous historical owners unresolved.
    // A fresh owner here would bypass their unlink tombstones and manual primary.
    if (!owner && task.trellisTaskId && owners.some(item => item.trellisId === task.trellisTaskId)) continue
    store.bind(owner ?? store.owner(task), candidates[0], 'runtime', now)
  }
}
