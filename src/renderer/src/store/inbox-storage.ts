import type { InboxEntry } from './types'
import type { ProjectSnapshot } from '../../../shared/types'

/**
 * 将收件箱数据与项目最新快照进行对齐（Reconciliation）：
 * 1. 物理删除的任务（既不在 tasks 也不在 archived 中）：彻底从 inbox 剔除并持久化
 * 2. 已归档任务：从 inbox 剔除（无需在待确认中展示）
 * 3. 外部已推进任务（状态非 planning，如 in_progress/review/completed）：自动标记为 accepted
 */
export function reconcileInbox(
  inbox: Record<string, InboxEntry>,
  snapshot: ProjectSnapshot | null,
  projectRoot: string | null
): Record<string, InboxEntry> {
  if (!snapshot || !projectRoot) return inbox
  const activeDirs = new Set(snapshot.tasks.map((t) => t.dirName))
  const archivedDirs = new Set(snapshot.archived.map((t) => t.dirName))

  let changed = false
  const next: Record<string, InboxEntry> = {}

  for (const [dir, entry] of Object.entries(inbox)) {
    // 1. 磁盘上已被删除或已被归档：直接移除
    if (!activeDirs.has(dir) || archivedDirs.has(dir)) {
      changed = true
      continue
    }

    // 2. 外部已推进到非 planning 状态：自动标记为已确认
    const task = snapshot.tasks.find((t) => t.dirName === dir)
    const st = (task?.record?.status ?? '').toLowerCase()
    if (st && st !== 'planning' && entry.state === 'pending') {
      next[dir] = { ...entry, state: 'accepted' }
      changed = true
      continue
    }

    next[dir] = entry
  }

  if (changed) {
    saveInbox(next, projectRoot)
  }
  return next
}

const INBOX_KEY = 'tpanel.inbox.v2'

function inboxStorageKey(projectRoot: string): string {
  return `${INBOX_KEY}.${encodeURIComponent(projectRoot)}`
}

export function loadInbox(projectRoot: string | null): Record<string, InboxEntry> {
  if (!projectRoot) return {}
  try {
    return JSON.parse(localStorage.getItem(inboxStorageKey(projectRoot)) ?? '{}') as Record<string, InboxEntry>
  } catch {
    return {}
  }
}

export function saveInbox(map: Record<string, InboxEntry>, projectRoot: string | null): void {
  if (!projectRoot) return
  try {
    // cap stored entries — keep newest 200
    const entries = Object.entries(map).sort((a, b) => b[1].ts - a[1].ts).slice(0, 200)
    localStorage.setItem(inboxStorageKey(projectRoot), JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // persistence is best-effort
  }
}
