import type { CruxWorkSource } from './task-workspace-source'
import { sha256Hex } from '../local-task/operations'

type TaskIdentity = Pick<CruxWorkSource, 'workspaceKey' | 'actorId' | 'spaceId' | 'taskId' | 'taskCreatedAt'>

/** Legacy identity is for matching an original recovery intent only. */
export function legacyTaskDevelopmentKey(source: TaskIdentity): string {
  return sha256Hex(JSON.stringify([source.workspaceKey, source.actorId, source.spaceId, source.taskId, source.taskCreatedAt]))
}

/** Only trusted source or native pin fields may define a new workcopy admission. */
export function taskDevelopmentKey(source: TaskIdentity & { instanceId?: string; epoch?: string }): string {
  const scope = source.workspaceKey === 'local' ? ['local'] : ['team', source.instanceId, source.epoch]
  if (source.workspaceKey !== 'local' && (!source.instanceId || !source.epoch)) throw new Error('团队任务缺少可信服务实例或世代，不能建立工作副本授权。')
  return sha256Hex(JSON.stringify(['task-development-v2', ...scope, source.workspaceKey, source.actorId, source.spaceId, source.taskId, source.taskCreatedAt]))
}
