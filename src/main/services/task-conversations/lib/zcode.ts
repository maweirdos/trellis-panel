import { join } from 'node:path'
import { projectRows, readNativeDatabase } from './native-sqlite'
import type { ExternalConversation } from '../../../../shared/task-conversations'
import type { NativeIdentity, NativeHistoryFile } from '../types'
import { safeId } from './paths'

export function readZcode(sourceRoot: string, root: string, requested: NativeIdentity[], histories: NativeHistoryFile[] = []): ExternalConversation[] {
  // Native task_id is always the destination identity; acp_session_id only verifies provider aliases.
  return readNativeDatabase(sourceRoot, join(sourceRoot, 'tasks-index.sqlite'), (db, columns) => {
    const fields = columns('tasks')
    if (!['task_id', 'workspace_path', 'title', 'updated_at', 'deleted'].every(name => fields.has(name))) {
      throw new Error('ZCode 元信息索引 schema 不受支持')
    }
    return projectRows(db, root, 'zcode', { table: 'tasks', id: 'task_id', cwd: 'workspace_path', title: 'title', updated: 'updated_at', predicate: 'deleted=0',
      workspaceKey: fields.has('workspace_key') ? 'workspace_key' : undefined,
      providerId: fields.has('acp_session_id') ? 'acp_session_id' : undefined
    }, requested, (row, item) => {
      if (row.workspaceKey && safeId(row.workspaceKey)) histories.push({ conversation: item, sourceRoot,
        file: join(sourceRoot, 'sessions', row.workspaceKey, `${item.sessionId}.json`), providerId: row.providerId || undefined })
    })
  })
}
