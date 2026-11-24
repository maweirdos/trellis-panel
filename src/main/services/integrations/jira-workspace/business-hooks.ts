import { createHash } from 'node:crypto'
import { readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { teamTaskRefSchema, type TeamTaskRef } from '../../../../shared/team-task-execution'
import type { CruxStatusCategory, CruxTask, CruxTaskAction } from '../../../../shared/crux'
import { getCruxTaskActions, getCruxTaskStageMetadata } from '../../../../shared/crux-domain/workflow'
import type { JiraBusinessTaskMapping } from '../../../../shared/jira-business-hooks'
import type { JiraIssueRecord, JiraMapping } from '../../../../shared/jira-integration'
import { NativeTeamBusinessSender } from '../../crux/task-progress-sender'
import type { TeamFetch } from '../../team-platform/http'
import { JiraWorkspaceError } from './types'

export interface JiraBusinessHookPort {
  shareSource(task: TeamTaskRef, issue: JiraIssueRecord, mapping: JiraMapping): Promise<void>
  create(input: { spaceId: string; title: string; description: string | null; assigneeId?: string; issue: { instanceId: string; issueId: string; issueKey: string | null; remoteProjectId: string }; providerJobId: string; providerCommandId: string; payloadDigest: string; effectId?: string }): Promise<TeamTaskRef>
  update(input: { task: TeamTaskRef; patch: { statusId?: string; title?: string; description?: string }; issue: { instanceId: string; issueId: string; issueKey: string | null; remoteProjectId: string }; providerJobId: string; providerCommandId: string; payloadDigest: string; effectId?: string }): Promise<TeamTaskRef>
  lookup(issue: { instanceId: string; issueId: string }): Promise<JiraBusinessTaskMapping | null>
  readTask(task: TeamTaskRef): Promise<CruxTask | null>
}

function taskRef(snapshot: { projectId: string; instanceId: string }, task: CruxTask): TeamTaskRef {
  return teamTaskRefSchema.parse({ instanceId: snapshot.instanceId, projectId: snapshot.projectId, spaceId: task.spaceId, taskId: task.id, taskCreatedAt: task.createdAt })
}

/** Stable UUIDs make retries replay the original platform command and effect. */
export function stableUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed, 'utf8').digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function issueIdentity(issue: { instanceId: string; issueId: string }): string {
  return `${issue.instanceId}:${issue.issueId}`
}

function businessEffectId(providerCommandId: string, issue: { instanceId: string; issueId: string }, eventKind: 'intake' | 'status-sync'): string {
  return stableUuid(`${providerCommandId}:jira-business-effect:${eventKind}:${issueIdentity(issue)}`)
}

function sameTask(left: TeamTaskRef, right: TeamTaskRef): boolean {
  return left.instanceId === right.instanceId && left.projectId === right.projectId && left.spaceId === right.spaceId
    && left.taskId === right.taskId && left.taskCreatedAt === right.taskCreatedAt
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
export function currentJiraBusinessSender(dataDir: string, options: { fetcher?: TeamFetch; unseal?: (body: string) => string } = {}): NativeTeamBusinessSender {
  const directory = join(dataDir, 'task-progress-credentials')
  const connectionIds = (): string[] => {
    try {
      return readdirSync(directory).filter(name => name.endsWith('.business.json')).map(name => name.slice(0, -'.business.json'.length)).filter(name => {
        try {
          const file = join(directory, name + '.business.json')
          const stat = lstatSync(file)
          return stat.isFile() && !stat.isSymbolicLink()
        } catch { return false }
      })
    } catch { return [] }
  }
  const sender = (): NativeTeamBusinessSender => {
    const ids = connectionIds()
    if (ids.length !== 1) throw new JiraWorkspaceError('E_UNAVAILABLE', ids.length === 0 ? '当前桌面团队连接尚未授权后台业务 Hook。' : '存在多个团队连接，后台业务 Hook 不会猜测写入身份。')
    return new NativeTeamBusinessSender(dataDir, ids[0], options.fetcher, options.unseal)
  }
  return sender()
}

export function createCurrentJiraBusinessHook(dataDir: string, options: { fetcher?: TeamFetch; unseal?: (body: string) => string } = {}): JiraBusinessHookPort {
  const sender = (): NativeTeamBusinessSender => currentJiraBusinessSender(dataDir, options)
  return {
    async shareSource(ref, issue, mapping) {
      const native = sender(), snapshot = await native.snapshot()
      if (snapshot.instanceId !== ref.instanceId || snapshot.projectId !== ref.projectId) throw new JiraWorkspaceError('E_CONFLICT', '任务来源已切换')
      const binding = await native.businessMapping({ projectId: ref.projectId, instanceId: issue.instanceId, issueId: issue.issueId })
      if (!binding || !sameTask(binding.task, ref)) throw new JiraWorkspaceError('E_CONFLICT', '请核对 Jira 工单的任务关联')
      const body = [`Jira ${issue.key} · ${issue.fields.title}`, issue.url,
        mapping.fields.includes('description') && issue.fields.description,
        ...(mapping.fields.includes('comments') ? issue.fields.comments.map(comment => `${comment.author}：${comment.body}`) : []),
        ...issue.references.attachments.map(file => `Jira 附件：${file.name}（${file.id}）`)
      ].filter(Boolean).join('\n\n')
      const sourceId = stableUuid(JSON.stringify([issue.instanceId, issue.issueId, issue.updatedAt, body]))
      if (snapshot.snapshot.comments.some(comment => comment.taskId === ref.taskId && comment.sourceId === sourceId)) return
      await native.command('addComment', { taskId: ref.taskId, authorId: snapshot.actor.id, sourceId, body },
        stableUuid(`${ref.taskId}:${sourceId}:record`))
    },
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
      const native = sender()
      const snapshot = await native.snapshot()
      const rootEffectId = input.effectId ?? businessEffectId(input.providerCommandId, input.issue, 'intake')
      const space = snapshot.snapshot.spaces.find(item => item.id === input.spaceId && item.memberIds.includes(snapshot.actor.id) && !item.archived)
      if (!space) throw new JiraWorkspaceError('E_DENIED', 'Jira 目标 Space 不属于当前桌面账号或已停用。')

      const linked = await native.intakeBusinessTask({
        contractVersion: 1, commandId: stableUuid(`${rootEffectId}:platform-intake`), projectId: snapshot.projectId,
        priorCreateCommandId: stableUuid(`${rootEffectId}:platform-create`),
        expectedEpoch: snapshot.epoch, issue: input.issue, spaceId: input.spaceId, title: input.title,
        description: input.description, assigneeId: input.assigneeId,
      })
      await native.recordBusinessEffect({ contractVersion: 1, commandId: stableUuid(`${rootEffectId}:business-effect:intake`), effectId: rootEffectId, eventKind: 'intake', projectId: linked.projectId, issue: input.issue, task: linked.task, expectedMappingRevision: linked.revision, expectedEpoch: snapshot.epoch, providerJobId: input.providerJobId, providerCommandId: input.providerCommandId, payloadDigest: input.payloadDigest })
      native.confirmBusinessCommands([stableUuid(`${rootEffectId}:platform-create`), stableUuid(`${rootEffectId}:business-mapping`)])
      return linked.task
    },
    async update(input) {
      const native = sender()
      const snapshot = await native.snapshot()
      if (input.task.instanceId !== snapshot.instanceId || input.task.projectId !== snapshot.projectId) throw new JiraWorkspaceError('E_CONFLICT', '平台任务不属于当前团队服务实例或项目。')
      const task = snapshot.snapshot.tasks.find(item => item.id === input.task.taskId && item.spaceId === input.task.spaceId && item.createdAt === input.task.taskCreatedAt)
      if (!task) throw new JiraWorkspaceError('E_CONFLICT', '原 Jira 映射的平台任务已不存在或已更换。')
      const mapping = await native.businessMapping({ projectId: input.task.projectId, instanceId: input.issue.instanceId, issueId: input.issue.issueId })
      if (!mapping || !sameTask(mapping.task, input.task)) throw new JiraWorkspaceError('E_CONFLICT', 'Jira issue has no matching canonical platform task mapping.')
      const rootEffectId = input.effectId ?? businessEffectId(input.providerCommandId, input.issue, 'status-sync')

      let current = task
      if (input.patch.statusId !== undefined) {
        const targetStatus = snapshot.snapshot.taskStatuses.find(item => item.id === input.patch.statusId && item.spaceId === task.spaceId)
        const currentStatus = snapshot.snapshot.taskStatuses.find(item => item.id === task.statusId && item.spaceId === task.spaceId)
        if (!targetStatus || !currentStatus) throw new JiraWorkspaceError('E_CONFLICT', 'Jira status has no matching platform status in the mapped Space.')
        if (targetStatus.category !== currentStatus.category) {
          const action = transitionAction(task, targetStatus.category)
          if (!action) throw new JiraWorkspaceError('E_CONFLICT', `Jira status ${input.patch.statusId} cannot be reached by one authorized workflow action from the current platform stage.`)
          const transition = await native.command('transitionTask', { taskId: task.id, action, body: 'Jira status synchronization', expectedStage: task.workflow?.stage, expectedUpdatedAt: task.updatedAt }, stableUuid(`${rootEffectId}:platform-transition`), { retainUntilEffect: true })
          current = transition.result.snapshot.tasks.find(item => item.id === task.id) ?? current
        }
      }

      const patch: { statusId?: string; title?: string; description?: string } = { ...input.patch }
      if (Object.keys(patch).length) {
        const result = await native.command('updateTask', { id: current.id, patch }, stableUuid(`${rootEffectId}:platform-update`), { retainUntilEffect: true })
        current = result.result.snapshot.tasks.find(item => item.id === current.id) ?? current
      }
      const ref = taskRef(snapshot, current)
      await native.recordBusinessEffect({ contractVersion: 1, commandId: stableUuid(`${rootEffectId}:business-effect:status-sync`), effectId: rootEffectId, eventKind: 'status-sync', projectId: ref.projectId, issue: input.issue, task: ref, expectedMappingRevision: mapping.revision, expectedEpoch: snapshot.epoch, providerJobId: input.providerJobId, providerCommandId: input.providerCommandId, payloadDigest: input.payloadDigest })
      native.confirmBusinessCommands([stableUuid(`${rootEffectId}:platform-transition`), stableUuid(`${rootEffectId}:platform-update`)])
      return ref
    }
  }
}
