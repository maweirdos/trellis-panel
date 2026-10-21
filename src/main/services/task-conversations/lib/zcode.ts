import { join } from 'node:path'
import { projectRows, readNativeDatabase } from './native-sqlite'
import type { ExternalConversation } from '../../../../shared/task-conversations'
import type { NativeIdentity } from '../types'

export function readZcode(sourceRoot: string, root: string, requested: NativeIdentity[]): ExternalConversation[] {
  // Native task_id identifies ZCode history; acp_session_id is deliberately never used.
  return readNativeDatabase(sourceRoot, join(sourceRoot, 'tasks-index.sqlite'), (db, columns) => {
    const fields = columns('tasks')
    if (!['task_id', 'workspace_path', 'title', 'updated_at', 'deleted'].every(name => fields.has(name))) {
      throw new Error('ZCode 元信息索引 schema 不受支持')
    }
    return projectRows(db, root, 'zcode', { table: 'tasks', id: 'task_id', cwd: 'workspace_path', title: 'title', updated: 'updated_at', predicate: 'deleted=0' }, requested)
  })
}
