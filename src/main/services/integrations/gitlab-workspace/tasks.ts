import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { WorkspaceGrant } from '../../../../shared/daemon'
import type { GitlabFields, GitlabIssue, GitlabMapping } from '../../../../shared/gitlab-integration'
import { createOrOpenTaskFromExternal, externalSourceLinkKey } from '../../local-task'
import { LocalControlStore, localRuntimeDirOf } from '../../local-task/control-store'
import { scanKnownTaskDirs, taskRefFor } from '../../task-identity'
import { updateTaskRecordAt } from '../../scan'
import { readBounded } from '../../../daemon/files'
import { IntegrationError } from '../types'
import { recordOf, textOf } from '../transport'

export interface GitlabLocalTask { taskRef: string; revision: string; fields: GitlabFields; archived: boolean; created?: boolean; source?: { provider: string; instanceId: string; id: string } }
export interface GitlabTaskPort {
  list(workspace: WorkspaceGrant, page: number): { items: { taskRef: string; title: string; revision: string; hasSource: boolean }[]; hasMore: boolean }
  read(workspace: WorkspaceGrant, taskRef: string): GitlabLocalTask
  import(workspace: WorkspaceGrant, issue: GitlabIssue, mapping: GitlabMapping): Promise<GitlabLocalTask>
  apply(workspace: WorkspaceGrant, task: GitlabLocalTask, patch: Partial<GitlabFields>, mapping: GitlabMapping): GitlabLocalTask
  attachSource(workspace: WorkspaceGrant, task: GitlabLocalTask, issue: GitlabIssue): GitlabLocalTask
  choices(workspace: WorkspaceGrant): { members: { id: string; name: string }[]; statuses: { id: string; name: string }[] }
}
/** Uses existing identity, task creation and metadata editor; never edits an authored PRD.
 * Source status is separate metadata. Trellis lifecycle stays owned by its workflow. */
export function createGitlabTaskAdapter(assertWorkspace: (workspace: WorkspaceGrant) => void, choices: GitlabTaskPort['choices']): GitlabTaskPort {
  function locate(workspace: WorkspaceGrant, ref: string) {
    assertWorkspace(workspace)
    const candidates = scanKnownTaskDirs(workspace.root).filter((entry) => taskRefFor(entry.trellisTaskId, entry.dir) === ref)
    if (candidates.length !== 1) throw new IntegrationError('本地任务身份缺失或存在多个候选，请先修复关联', 'conflict')
    const entry = candidates[0]
    if (!entry) throw new IntegrationError('任务不存在', 'conflict')
    const dir = realpathSync(join(workspace.root, entry.dir))
    const expectedTasks = join(realpathSync(workspace.root), '.trellis', 'tasks')
    if (realpathSync(expectedTasks) !== expectedTasks) throw new IntegrationError('任务根目录不能被重定向到工作区之外', 'denied')
    const allowed = expectedTasks + sep
    const file = join(dir, 'task.json')
    if (!dir.startsWith(allowed) || lstatSync(file).isSymbolicLink() || realpathSync(file) !== resolve(file)) throw new IntegrationError('任务路径越过已授权工作区', 'denied')
    const before = lstatSync(file), content = readBounded(file, 256 * 1024), after = lstatSync(file)
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new IntegrationError('读取时任务文件已被修改，请刷新', 'conflict')
    const raw = recordOf(JSON.parse(content)), meta = recordOf(raw.meta)
    return { dir, entry, raw, meta, mtime: after.mtimeMs, revision: createHash('sha256').update(content).digest('hex'), archived: entry.dir.startsWith('.trellis/tasks/archive/') }
  }
  const adapter: GitlabTaskPort = {
    choices,
    list(workspace, page) {
      assertWorkspace(workspace)
      const entries = scanKnownTaskDirs(workspace.root).filter((v) => !v.dir.startsWith('.trellis/tasks/archive/')).sort((a, b) => a.dir.localeCompare(b.dir))
      const offset = (page - 1) * 30
      return { items: entries.slice(offset, offset + 30).map((v) => { const task = adapter.read(workspace, taskRefFor(v.trellisTaskId, v.dir)); return { taskRef: task.taskRef, title: task.fields.title, revision: task.revision, hasSource: Boolean(task.source) } }), hasMore: entries.length > offset + 30 }
    },
    attachSource(workspace, task, issue) {
      const current = locate(workspace, task.taskRef)
      if (current.archived || current.revision !== task.revision) throw new IntegrationError('本地任务已变更，请核实远端创建回执', 'conflict')
      if (current.meta.panel_source_provider) {
        if (current.meta.panel_source_provider !== 'gitlab' || current.meta.panel_source_instance_id !== issue.instanceId || current.meta.panel_source_id !== issue.id) throw new IntegrationError('本地任务已经关联其他业务来源', 'conflict')
      }
      if (!current.meta.panel_source_provider && (current.meta.panel_source_instance_id || current.meta.panel_source_id || current.meta.panel_source_key || current.meta.panel_source_url)) throw new IntegrationError('本地来源元数据不完整，请先修复', 'conflict')
      if (current.meta.panel_jira_issue_id || current.meta.panel_jira_issue_key) throw new IntegrationError('本地任务已有 Jira 来源，不能替换', 'conflict')
      const store = new LocalControlStore(localRuntimeDirOf(workspace.root))
      try {
        store.open()
        const sourceKey = externalSourceLinkKey('gitlab', issue.instanceId, issue.id)
        // Inspect retained evidence through a read-only handle. The existing
        // control store remains the only writer; no import operation is invented.
        const evidence = new DatabaseSync(store.controlDbPath(), { readOnly: true })
        let linked = false
        try {
          const links = evidence.prepare("SELECT sourceKind, sourceKey, taskRef FROM source_links WHERE workspaceId=? AND ((sourceKind='gitlab' AND sourceKey=?) OR (taskRef=? AND sourceKind IN ('jira','gitlab','dingtalk'))) LIMIT 101").all(workspace.workspaceId, sourceKey, task.taskRef)
          if (links.length > 100) throw new IntegrationError('本地来源证据过多，需要人工核实', 'conflict')
          const legacyKey = `${issue.instanceId}#${issue.id}`
          if (links.some((link) => link.taskRef !== task.taskRef || link.sourceKind !== 'gitlab' || link.sourceKey !== sourceKey && link.sourceKey !== legacyKey)) throw new IntegrationError('本地来源关联与原创建回执冲突', 'conflict')
          linked = links.some((link) => link.sourceKey === sourceKey)
        } finally { evidence.close() }
        assertWorkspace(workspace)
        if (!store.upsertAlias(task.taskRef, current.entry.trellisTaskId, current.entry.dir)) throw new IntegrationError('任务别名无法确认', 'conflict')
        if (locate(workspace, task.taskRef).revision !== current.revision) throw new IntegrationError('发布来源前本地任务已变更', 'conflict')
        // Metadata first. If publication of the link fails, a retry of the
        // confirmed remote receipt repairs it even when metadata already matches.
        const metadata = { panel_source_provider: 'gitlab', panel_source_instance_id: issue.instanceId, panel_source_id: issue.id, panel_source_key: `GL-${issue.projectId}-${issue.iid}`, panel_source_url: issue.url }
        if (Object.entries(metadata).some(([key, value]) => current.meta[key] !== value)) updateTaskRecordAt(workspace.root, current.dir, { meta: metadata }, current.mtime)
        const attached = locate(workspace, task.taskRef)
        if (Object.entries(metadata).some(([key, value]) => attached.meta[key] !== value)) throw new IntegrationError('来源元数据未能确认，保留原创建回执', 'conflict')
        if (!linked) store.insertSourceLink({ workspaceId: workspace.workspaceId, sourceKind: 'gitlab', sourceKey, taskRef: task.taskRef, payload: { provider: 'gitlab', externalId: issue.id, issueId: Number.isSafeInteger(Number(issue.id)) ? Number(issue.id) : null, issueKey: `GL-${issue.projectId}-${issue.iid}`, url: issue.url, updatedAtMs: Date.parse(issue.updatedAt), fetchedAtMs: Date.now() } })
      } finally { store.close() }
      return adapter.read(workspace, task.taskRef)
    },
    read(workspace, taskRef) {
      const task = locate(workspace, taskRef)
      // Metadata holds the mapped *source* state, never local task completion.
      const labels = Array.isArray(task.meta.gitlab_labels) ? task.meta.gitlab_labels.filter((v): v is string => typeof v === 'string') : []
      return { taskRef, revision: task.revision, archived: task.archived, ...(task.meta.panel_source_provider ? { source: { provider: textOf(task.meta.panel_source_provider), instanceId: textOf(task.meta.panel_source_instance_id), id: textOf(task.meta.panel_source_id) } } : task.meta.panel_jira_issue_id || task.meta.panel_jira_issue_key ? { source: { provider: 'jira', instanceId: textOf(task.meta.panel_jira_instance_id), id: textOf(task.meta.panel_jira_issue_id) || textOf(task.meta.panel_jira_issue_key) } } : {}), fields: { title: textOf(task.raw.title), description: textOf(task.raw.description), state: task.meta.gitlab_state === 'closed' ? 'closed' : 'opened', labels, assignees: typeof task.raw.assignee === 'string' && task.raw.assignee ? [task.raw.assignee] : [] } }
    },
    async import(workspace, issue, mapping) {
      assertWorkspace(workspace)
      const mappedAssignees = mapping.fields.includes('assignees') ? issue.fields.assignees : []
      if (mappedAssignees.length > 1) throw new IntegrationError('本地任务只支持单负责人；请处理成员映射冲突后导入', 'conflict')
      const remoteAssignee = mappedAssignees[0], assignee = remoteAssignee ? mapping.members.find((m) => m.remote === remoteAssignee)?.local ?? '' : ''
      if (remoteAssignee && !assignee) throw new IntegrationError('GitLab 负责人尚未映射；未创建缺失负责人信息的任务', 'conflict')
      if (assignee && !choices(workspace).members.some((m) => m.id === assignee)) throw new IntegrationError('本地成员映射已失效，请重新确认同步配置', 'conflict')
      const result = await createOrOpenTaskFromExternal({ root: workspace.root, instanceId: issue.instanceId, issueKey: `GL-${issue.projectId}-${issue.iid}`, issueId: Number.isSafeInteger(Number(issue.id)) ? Number(issue.id) : null, externalSource: { provider: 'gitlab', id: issue.id }, title: issue.fields.title, summaryDescription: issue.fields.description.slice(0, 4000), description: issue.fields.description, url: issue.url, updatedAtMs: Date.parse(issue.updatedAt), priority: 'P2', assignee, allowAdditional: false })
      assertWorkspace(workspace)
      if (!result.ok) throw new IntegrationError(`GitLab 本地导入未完成（${result.code}），请恢复原任务操作`, 'conflict')
      const candidates = scanKnownTaskDirs(workspace.root).filter((task) => task.dir.endsWith(`/${result.dirName}`))
      if (candidates.length !== 1 || !candidates[0]) throw new IntegrationError('导入后任务身份不唯一', 'conflict')
      return { ...adapter.read(workspace, taskRefFor(candidates[0].trellisTaskId, candidates[0].dir)), created: result.created }
    },
    apply(workspace, task, patch, mapping) {
      const current = locate(workspace, task.taskRef)
      if (current.archived || current.revision !== task.revision) throw new IntegrationError('本地任务已变更或归档，停止字段更新', 'conflict')
      const metadata: Record<string, unknown> = {}, update: Record<string, unknown> = {}
      if (patch.title !== undefined) update.title = patch.title
      if (patch.description !== undefined) update.description = patch.description
      if (patch.labels) metadata.gitlab_labels = patch.labels
      if (patch.state) {
        const status = mapping.statuses.find((s) => s.remote === patch.state)
        if (!status || !choices(workspace).statuses.some((s) => s.id === status.local)) throw new IntegrationError('本地状态映射已失效，请重新确认同步配置', 'conflict')
        metadata.gitlab_state = patch.state; metadata.gitlab_mapped_status = status.local
      }
      if (patch.assignees) {
        if (patch.assignees.length > 1) throw new IntegrationError('本地任务只支持单负责人；请处理成员映射冲突', 'conflict')
        const member = patch.assignees[0] ? mapping.members.find((m) => m.remote === patch.assignees?.[0]) : null
        if (patch.assignees.length && !member) throw new IntegrationError('GitLab 成员尚未映射', 'conflict')
        if (member && !choices(workspace).members.some((m) => m.id === member.local)) throw new IntegrationError('本地成员映射已失效，请重新确认同步配置', 'conflict')
        update.assignee = member?.local ?? ''
      }
      update.meta = metadata
      assertWorkspace(workspace)
      updateTaskRecordAt(workspace.root, current.dir, update, current.mtime)
      return adapter.read(workspace, task.taskRef)
    }
  }
  return adapter
}
