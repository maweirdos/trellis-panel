import { cruxWorkQuerySchema, type CruxWorkQuery } from '../../../shared/crux-work'
import type { CruxWorkspaceContext } from '../../../shared/crux-remote'
import type { TeamTaskCodeResourceDto } from '../../../shared/team-code-resources'
import { withDesktopTeamService } from '../team-desktop'
import { selectTaskCreationReferences } from '../creations/task-references'
import { selectTaskMaterialInputs } from './task-material-inputs'
import { cruxWorkspaceGeneration, cruxWorkspaceStatus } from './connection-service'
import { CruxWorkError, readCruxWorkSource, type CruxWorkSource, type CruxWorkSourceDependencies } from './task-workspace-source'

export type TaskExecutionSource = CruxWorkSource & { codeResource: TeamTaskCodeResourceDto }
const identity = (value: CruxWorkspaceContext): string => JSON.stringify([value.key, value.connectionId, value.actorId, value.projectId, value.origin, value.instanceId, value.epoch, value.authorizationRevision, value.state])

/** A fresh server-owned projection for one read phase, never an execution grant cache. */
export async function readTaskExecutionSource(raw: CruxWorkQuery, expected?: CruxWorkSource, postAttachments?: CruxWorkSourceDependencies['postAttachments']): Promise<TaskExecutionSource | null> {
  const query = cruxWorkQuerySchema.parse(raw), generation = cruxWorkspaceGeneration(), before = await cruxWorkspaceStatus()
  if (before.state === 'local') return null
  if (before.state !== 'connected' || before.key !== query.workspaceKey || !before.connectionId || !before.instanceId || !before.epoch || !before.actorId || !before.projectId) throw new CruxWorkError('scope_changed', '请先在原团队工作区核对开发来源。')
  const connectionId = before.connectionId, instanceId = before.instanceId
  const original = identity(before)
  const guard = async (): Promise<void> => {
    const current = await cruxWorkspaceStatus()
    if (generation !== cruxWorkspaceGeneration() || identity(current) !== original) throw new CruxWorkError('scope_changed', '开发来源已切换或授权已变化，旧操作不会恢复权限。')
  }
  await guard()
  const value = await withDesktopTeamService(service => service.taskDevelopmentContext(connectionId, query.taskId, instanceId))
  await guard()
  const packet = value.snapshot
  if (packet.projectId !== before.projectId || packet.actor.id !== before.actorId || packet.instanceId !== before.instanceId || packet.epoch !== before.epoch || value.inputs.taskId !== query.taskId) throw new CruxWorkError('scope_changed', '服务器返回的开发上下文不属于原人员、任务或服务世代。')
  const context: CruxWorkspaceContext = { ...before, revision: packet.revision, authorizationRevision: packet.authorizationRevision, canManage: packet.canManage }
  const status = async (): Promise<CruxWorkspaceContext> => { await guard(); return context }
  const source = await readCruxWorkSource({ workspaceStatus: status, workspaceSnapshot: async () => { await guard(); return { context, snapshot: packet.snapshot } }, workspaceGeneration: cruxWorkspaceGeneration,
    postAttachments, creationReferences: async request => selectTaskCreationReferences(request, value.creations),
    teamInputs: async scope => selectTaskMaterialInputs(scope, value.inputs)
  }, query, expected)
  await guard()
  if (expected && (source.workspaceKey !== expected.workspaceKey || source.actorId !== expected.actorId || source.identity !== expected.identity ||
    source.spaceId !== expected.spaceId || source.taskId !== expected.taskId || source.taskCreatedAt !== expected.taskCreatedAt)) {
    throw new CruxWorkError('scope_changed', '原任务或身份已变化，请重新打开并核对开发环境。')
  }
  return { ...source, codeResource: value.codeResource }
}
