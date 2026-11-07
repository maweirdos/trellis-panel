import { createHash } from 'node:crypto'
import { readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { teamTaskRefSchema, type TeamTaskRef } from '../../../../shared/team-task-execution'
import type { CruxStatusCategory, CruxTask, CruxTaskAction } from '../../../../shared/crux'
import { getCruxTaskActions, getCruxTaskStageMetadata } from '../../../../shared/crux-domain/workflow'
import type { JiraBusinessTaskMapping } from '../../../../shared/jira-business-hooks'
import { NativeTeamBusinessSender } from '../../crux/task-progress-sender'
import type { TeamFetch } from '../../team-platform/http'
import { JiraWorkspaceError } from './types'

export interface JiraBusinessHookPort {
  create(input: { spaceId: string; title: string; description: string | null; issue: { instanceId: string; issueId: string; issueKey: string | null; remoteProjectId: string }; providerJobId: string; providerCommandId: string; payloadDigest: string }): Promise<TeamTaskRef>
  update(input: { task: TeamTaskRef; patch: { statusId?: string; title?: string; description?: string }; issue: { instanceId: string; issueId: string; issueKey: string | null; remoteProjectId: string }; providerJobId: string; providerCommandId: string; payloadDigest: string }): Promise<TeamTaskRef>
  lookup(issue: { instanceId: string; issueId: string }): Promise<JiraBusinessTaskMapping | null>
  readTask(task: TeamTaskRef): Promise<CruxTask | null>
}

function taskRef(snapshot: { projectId: string; instanceId: string }, task: CruxTask): TeamTaskRef {
  return teamTaskRefSchema.parse({ instanceId: snapshot.instanceId, projectId: snapshot.projectId, spaceId: task.spaceId, taskId: task.id, taskCreatedAt: task.createdAt })
}

/** Stable UUIDs make retries replay the original platform command and effect. */
function stableUuid(seed: string): string {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function issueIdentity(issue: { instanceId: string; issueId: string }): string {
  return `${issue.instanceId}:${issue.issueId}`
}

function businessEffectId(providerCommandId: string, issue: { instanceId: string; issueId: string }, eventKind: 'intake' | 'status-sync'): string {
  return stableUuid(`${providerCommandId}:jira-business-effect:${eventKind}:${issueIdentity(issue)}`)
}

function actionCategory(task: CruxTask, action: CruxTaskAction): CruxStatusCategory | null {
  if (action === 'arrange') return task.workKind === 'general' ? 'in_progress' : 'todo'
  if (action === 'supplement') return task.workflow?.resumeStage ? getCruxTaskStageMetadata(task.workflow.resumeStage).category : 'backlog'
  const categories: Partial<Record<CruxTaskAction, CruxStatusCategory>> = {
    accept: 'backlog', request_info: 'blocked', decline: 'cancelled', start_design: 'in_progress',
    submit_design: 'in_review', approve_design: 'todo', return_design: 'in_progress',
    begin_development: 'in_progress', approve_plan: 'in_progress', submit_test: 'in_review',
    return_development: 'in_progress', pass_test: 'in_review', accept_delivery: 'done',
    return_delivery: 'in_progress', submit_delivery: 'in_review'
  }
  return categories[action] ?? null
}

function transitionAction(task: CruxTask, target: CruxStatusCategory): CruxTaskAction | null {
  if (!task.workflow) return null
  const candidates = getCruxTaskActions(task).filter((action) => action !== 'reassign' && actionCategory(task, action) === target)
  return candidates.length === 1 ? candidates[0] : null
}

/** Resolve exactly one GUI-issued current-device business credential; guessing a connection is forbidden. */
export function createCurrentJiraBusinessHook(dataDir: string, options: { fetcher?: TeamFetch; unseal?: (body: string) => string } = {}): JiraBusinessHookPort {
  const directory = join(dataDir, 'task-progress-credentials')
  const connectionIds = (): string[] => {
    try {
      return readdirSync(directory).filter(name => name.endsWith('.business.json')).map(name => name.slice(0, -'.business.json'.length)).filter(name => {
        try { const file = join(directory, name + '.business.json'); return lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink() } catch { return false }
      })
    } catch { return [] }
  }
  const sender = (): NativeTeamBusinessSender => {
    const ids = connectionIds()
    if (ids.length !== 1) throw new JiraWorkspaceError('E_UNAVAILABLE', ids.length === 0 ? '当前桌面团队连接尚未授权后台业务 Hook。' : '存在多个团队连接，后台业务 Hook 不会猜测写入身份。')
    return new NativeTeamBusinessSender(dataDir, ids[0], options.fetcher, options.unseal)
  }
  return {
    async lookup(issue) {
      const native = sender(), snapshot = await native.snapshot()
      return native.businessMapping({ projectId: snapshot.projectId, instanceId: issue.instanceId, issueId: issue.issueId })
    },
    async readTask(ref) {
      const native = sender(), snapshot = await native.snapshot()
      if (ref.instanceId !== snapshot.instanceId || ref.projectId !== snapshot.projectId) return null
      return snapshot.snapshot.tasks.find(item => item.id === ref.taskId && item.spaceId === ref.spaceId && item.createdAt === ref.taskCreatedAt) ?? null
    },
    async create(input) {
      const native = sender(), snapshot = await native.snapshot()
      const space = snapshot.snapshot.spaces.find(item => item.id === input.spaceId && item.memberIds.includes(snapshot.actor.id) && !item.archived)
      if (!space) throw new JiraWorkspaceError('E_DENIED', 'Jira 目标 Space 不属于当前桌面账号或已停用。')
      const existing = await native.businessMapping({ projectId: snapshot.projectId, instanceId: input.issue.instanceId, issueId: input.issue.issueId })
      if (existing) {
        if (existing.issue.remoteProjectId !== input.issue.remoteProjectId || existing.issue.issueKey !== input.issue.issueKey) throw new JiraWorkspaceError('E_CONFLICT', 'Jira issue already maps to a different canonical project identity.')
        const mappedTask = snapshot.snapshot.tasks.find(item => item.id === existing.task.taskId && item.spaceId === existing.task.spaceId && item.createdAt === existing.task.taskCreatedAt)
        if (!mappedTask) throw new JiraWorkspaceError('E_CONFLICT', 'Existing Jira mapping points to a missing platform task.')
        await native.recordBusinessEffect({ contractVersion: 1, commandId: stableUuid(`${input.providerCommandId}:jira-business-command:effect:intake:${issueIdentity(input.issue)}`), effectId: businessEffectId(input.providerCommandId, input.issue, 'intake'), eventKind: 'intake', projectId: existing.projectId, issue: input.issue, task: existing.task, expectedMappingRevision: existing.revision, providerJobId: input.providerJobId, providerCommandId: input.providerCommandId, payloadDigest: input.payloadDigest })
        return existing.task
      }
      const result = await native.command('createTask', { spaceId: input.spaceId, title: input.title, ...(input.description ? { description: input.description } : {}), workKind: 'code', assigneeIds: [snapshot.actor.id], triagePending: false }, stableUuid(`${input.providerCommandId}:platform-create:${issueIdentity(input.issue)}`))
      const task = result.result.snapshot.tasks.find(item => item.id === result.result.taskId)
      if (!task) throw new JiraWorkspaceError('E_UNKNOWN', '平台任务创建回执没有返回可核对的任务身份。')
      const ref = taskRef(result.result, task)
      await native.linkBusinessTask({ contractVersion: 1, commandId: stableUuid(`${input.providerCommandId}:jira-business-command:mapping:${issueIdentity(input.issue)}`), projectId: ref.projectId, issue: input.issue, task: ref, expectedRevision: 0 })
      await native.recordBusinessEffect({ contractVersion: 1, commandId: stableUuid(`${input.providerCommandId}:jira-business-command:effect:intake:${issueIdentity(input.issue)}`), effectId: businessEffectId(input.providerCommandId, input.issue, 'intake'), eventKind: 'intake', projectId: ref.projectId, issue: input.issue, task: ref, expectedMappingRevision: 1, providerJobId: input.providerJobId, providerCommandId: input.providerCommandId, payloadDigest: input.payloadDigest })
      return ref
    },
    async update(input) {
      const native = sender(), snapshot = await native.snapshot()
      if (input.task.instanceId !== snapshot.instanceId || input.task.projectId !== snapshot.projectId) throw new JiraWorkspaceError('E_CONFLICT', '平台任务不属于当前团队服务实例或项目。')
      const task = snapshot.snapshot.tasks.find(item => item.id === input.task.taskId && item.spaceId === input.task.spaceId && item.createdAt === input.task.taskCreatedAt)
      if (!task) throw new JiraWorkspaceError('E_CONFLICT', '原 Jira 映射的平台任务已不存在或已更换。')
      const mapping = await native.businessMapping({ projectId: input.task.projectId, instanceId: input.issue.instanceId, issueId: input.issue.issueId })
      if (!mapping || JSON.stringify(mapping.task) !== JSON.stringify(input.task)) throw new JiraWorkspaceError('E_CONFLICT', 'Jira issue has no matching canonical platform task mapping.')

      let current = task
      if (input.patch.statusId !== undefined) {
        const targetStatus = snapshot.snapshot.taskStatuses.find(item => item.id === input.patch.statusId && item.spaceId === task.spaceId)
        const currentStatus = snapshot.snapshot.taskStatuses.find(item => item.id === task.statusId && item.spaceId === task.spaceId)
        if (!targetStatus || !currentStatus) throw new JiraWorkspaceError('E_CONFLICT', 'Jira status has no matching platform status in the mapped Space.')
        if (targetStatus.category !== currentStatus.category) {
          const action = transitionAction(task, targetStatus.category)
          if (!action) throw new JiraWorkspaceError('E_CONFLICT', `Jira status ${input.patch.statusId} cannot be reached by one authorized workflow action from the current platform stage.`)
          const transition = await native.command('transitionTask', { taskId: task.id, action, body: 'Jira status synchronization', expectedStage: task.workflow?.stage, expectedUpdatedAt: task.updatedAt }, stableUuid(`${input.providerCommandId}:platform-transition:${issueIdentity(input.issue)}`))
          current = transition.result.snapshot.tasks.find(item => item.id === task.id) ?? current
        }
      }

      const patch: { statusId?: string; title?: string; description?: string } = { ...input.patch }
      if (patch.statusId !== undefined && patch.statusId === current.statusId) delete patch.statusId
      if (Object.keys(patch).length) {
        const result = await native.command('updateTask', { id: current.id, patch }, stableUuid(`${input.providerCommandId}:platform-update:${issueIdentity(input.issue)}`))
        current = result.result.snapshot.tasks.find(item => item.id === current.id) ?? current
      }
      const ref = taskRef(snapshot, current)
      await native.recordBusinessEffect({ contractVersion: 1, commandId: stableUuid(`${input.providerCommandId}:jira-business-command:effect:status-sync:${issueIdentity(input.issue)}`), effectId: businessEffectId(input.providerCommandId, input.issue, 'status-sync'), eventKind: 'status-sync', projectId: ref.projectId, issue: input.issue, task: ref, expectedMappingRevision: mapping.revision, providerJobId: input.providerJobId, providerCommandId: input.providerCommandId, payloadDigest: input.payloadDigest })
      return ref
    }
  }
}
