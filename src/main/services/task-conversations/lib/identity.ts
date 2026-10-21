import { join, isAbsolute } from 'node:path'
import { realpathSync } from 'node:fs'
import { scanKnownTaskDirs, taskRefFor, type KnownTaskDir } from '../../task-identity'
import { inside } from './paths'
import { TaskConversationError } from '../types'

export type TaskOwner = { key: string; taskRef: string; trellisId: string | null; currentDir: string; priorDirs: string[] }
export function knownTasks(root: string): KnownTaskDir[] {
  return scanKnownTaskDirs(root).filter(task => {
    try { return inside(root, realpathSync(join(root, task.dir))) } catch { return false }
  })
}
/** Public taskDir accepts exact active dirName or exact repository-relative archive path. */
export function resolveTask(root: string, taskDir: string, known: KnownTaskDir[]): KnownTaskDir {
  if (!taskDir || isAbsolute(taskDir) || /[\\\x00-\x1f]/.test(taskDir) || taskDir.split('/').some(part => part === '.' || part === '..' || !part)) {
    throw new TaskConversationError('E_INVALID_ARG', '任务目录无效')
  }
  const dir = taskDir.startsWith('.trellis/tasks/') ? taskDir : `.trellis/tasks/${taskDir}`
  const task = known.find(item => item.dir === dir)
  if (!task || !inside(root, realpathSync(join(root, task.dir)))) throw new TaskConversationError('E_NOT_FOUND', '任务目录不存在')
  return task
}
export function displayTaskDir(dir: string): string { return dir.replace(/^\.trellis\/tasks\//, '') }
export function sameTask(owner: TaskOwner, task: KnownTaskDir): boolean {
  return owner.currentDir === task.dir && owner.taskRef === taskRefFor(task.trellisTaskId, task.dir)
}
/** Match only a missing original and one unique ID target; duplicate copies never merge. */
export function aliasTarget(owner: TaskOwner, owners: TaskOwner[], known: KnownTaskDir[]): KnownTaskDir | undefined {
  if (known.some(task => task.dir === owner.currentDir) || owner.trellisId === null) return undefined
  const matches = known.filter(task => task.trellisTaskId === owner.trellisId)
  const historical = owners.filter(item => item.trellisId === owner.trellisId)
  return matches.length === 1 && historical.length === 1 ? matches[0] : undefined
}
