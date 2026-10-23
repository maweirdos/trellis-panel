import { randomUUID } from 'node:crypto'
import type { IntegrationAccount } from '../../../../../shared/integration-work'
import type { WorkspaceGrant } from '../../../../../shared/daemon'
import { gitlabBindingSchema, type GitlabBinding, type GitlabInput, type GitlabMethod, type GitlabOutput, type GitlabPreview } from '../../../../../shared/gitlab-integration'
import type { IntegrationWorkPort } from '../../work-ports'
import { IntegrationError, type ResolvedConnection } from '../../types'
import { GitlabIssueAdapter } from '../adapter'
import { digest, remoteLocal } from '../mapping'
import type { GitlabWorkspacePorts } from '../ports'
import { assertBindingOwner, sameSource } from '../work'

export type GitlabWorkspaceActions = { [M in Exclude<GitlabMethod, 'cancelAuthorization' | 'cancelRead'>]: (input: GitlabInput<M>, signal?: AbortSignal) => Promise<GitlabOutput<M>> }
export function createGitlabWorkspaceActions(ports: GitlabWorkspacePorts, remote: GitlabIssueAdapter, work: IntegrationWorkPort): GitlabWorkspaceActions {
  const repo = ports.repository
  async function capture(input: GitlabInput<'snapshot'>) {
    const workspace = await ports.workspace(input.expectedRoot)
    ports.assertWorkspace(workspace)
    const connection = await ports.connection(input)
    if (connection.public.providerId !== 'gitlab' || connection.public.id !== input.connectionId || connection.public.revision !== input.connectionRevision) throw new IntegrationError('连接不是所选 GitLab 来源', 'conflict')
    ports.assertWorkspace(workspace)
    await ports.credentials.assertCurrent(connection)
    return { workspace, connection }
  }
  async function recheck(workspace: WorkspaceGrant, connection: ResolvedConnection) { ports.assertWorkspace(workspace); await ports.credentials.assertCurrent(connection); ports.assertWorkspace(workspace) }
  function bound(input: { bindingId: string; bindingRevision: number }, workspace: WorkspaceGrant, connection: ResolvedConnection): GitlabBinding {
    const binding = repo.read().bindings.find((b) => b.plan.id === input.bindingId)
    if (!binding || binding.plan.source.bindingRevision !== input.bindingRevision) throw new IntegrationError('绑定已变更，请刷新', 'conflict')
    assertBindingOwner(binding, workspace, connection, ports.profileId)
    return binding
  }
  async function noActive(workspace: WorkspaceGrant, binding: GitlabBinding) {
    let after: string | null = null
    do { const page = await ports.jobs(workspace, after); if (page.items.some((j) => j.source.bindingId === binding.plan.id && ['queued', 'dispatched', 'running', 'cancel-requested', 'unknown'].includes(j.state))) throw new IntegrationError('请先停止或对账此绑定的原作业，再修改配置', 'conflict'); after = page.next } while (after)
  }
  function rememberPermission(c: ResolvedConnection, projectId: string | null, permission: GitlabOutput<'inspect'>) {
    repo.change((state) => { state.permissions = state.permissions.filter((p) => p.connectionId !== c.public.id || p.projectId !== projectId); state.permissions.push({ connectionId: c.public.id, revision: c.public.revision, instanceId: c.instanceId, projectId, permission }) })
  }
  async function queueWrite(kind: 'create' | 'note', input: GitlabInput<'createIssue'> | GitlabInput<'addComment'>, signal?: AbortSignal) {
    const { workspace, connection } = await capture(input), binding = bound(input, workspace, connection)
    if (binding.plan.state === 'paused' || binding.plan.direction !== 'bidirectional') throw new IntegrationError('远端创建或评论需启用双向同步及 api 授权', 'denied')
    const permission = await remote.inspect(connection, binding.project.id, signal)
    if (permission.write !== 'granted') throw new IntegrationError('请先明确升级 api 授权', 'denied')
    const base = 'issueId' in input ? repo.read().baselines.find((b) => b.bindingId === binding.plan.id && b.issue.id === input.issueId) : undefined
    const taskRef = 'taskRef' in input ? input.taskRef : base?.taskRef
    if (!taskRef) throw new IntegrationError('评论只支持已映射的数字 Issue 身份', 'conflict')
    const task = ports.tasks.read(workspace, taskRef)
    if (task.archived || 'localRevision' in input && task.revision !== input.localRevision) throw new IntegrationError('本地任务已变更，请重新预览', 'conflict')
    if (kind === 'note' && (!base || task.source?.provider !== 'gitlab' || task.source.instanceId !== base.issue.instanceId || task.source.id !== base.issue.id)) throw new IntegrationError('评论关联的本地来源已被修改或移除', 'conflict')
    if (kind === 'create' && repo.read().baselines.some((b) => b.bindingId === binding.plan.id && b.taskRef === taskRef)) throw new IntegrationError('此任务已有关联的 GitLab Issue', 'conflict')
    if (kind === 'create' && task.source) throw new IntegrationError('本地任务已存在业务来源，不能自动替换为新建 Issue', 'conflict')
    const localFields = kind === 'create' ? remoteLocal(task, binding.mapping) : null
    const fields = localFields ? { title: localFields.title, description: binding.mapping.fields.includes('description') ? localFields.description : '', state: localFields.state, labels: binding.mapping.fields.includes('labels') ? localFields.labels : [], assignees: binding.mapping.fields.includes('assignees') ? localFields.assignees : [] } : null
    if (fields && (fields.state !== 'opened' || !binding.mapping.fields.includes('title'))) throw new IntegrationError('远端新建只支持 opened Issue，并要求映射标题', 'invalid')
    const intent = { commandId: input.commandId, digest: digest({ ...input, requestId: undefined }), bindingId: binding.plan.id, bindingRevision: binding.plan.revision, kind, taskRef, localRevision: task.revision, fields, issue: base?.issue ?? null, body: 'body' in input ? input.body : null }
    await noActive(workspace, binding); await recheck(workspace, connection); bound(input, workspace, connection)
    repo.change((state) => { const previous = state.intents.find((v) => v.commandId === input.commandId); if (previous && previous.digest !== intent.digest) throw new IntegrationError('命令标识已被不同写入内容使用', 'conflict'); if (!previous) state.intents.push(intent) })
    return ports.enqueue(workspace, binding.plan.source, { kind: 'sync', planId: binding.plan.id, planRevision: binding.plan.revision }, input.commandId)
  }
  const actions: GitlabWorkspaceActions = {
    async snapshot(input) {
      const { workspace, connection } = await capture(input), state = repo.read(), choices = ports.tasks.choices(workspace)
      const bindings = state.bindings.filter((b) => b.owner.workspaceId === workspace.workspaceId && b.owner.grantId === workspace.grantId && b.owner.grantRevision === workspace.revision && b.plan.target.profileId === ports.profileId && b.plan.source.connectionId === connection.public.id && b.plan.source.instanceId === connection.instanceId)
      return { nativeVersion: 1, accounts: state.accounts.filter((a) => a.ownerId === workspace.workspaceId && a.account.connectionId === connection.public.id && a.instanceId === connection.instanceId).map((a) => a.verifiedRevision === connection.public.revision || a.account.state !== 'linked' ? a.account : { ...a.account, state: 'unverified' as const }), bindings, conflicts: state.conflicts.filter((c) => c.state === 'open' && bindings.some((b) => b.plan.id === c.bindingId)).slice(0, 100), permission: state.permissions.find((p) => p.connectionId === connection.public.id && p.revision === connection.public.revision && p.instanceId === connection.instanceId)?.permission ?? null, localMembers: choices.members, localStatuses: choices.statuses, receiverAvailable: Boolean(ports.receiver) }
    },
    async projects(input, signal) { const { workspace, connection } = await capture(input); const result = await remote.projects(connection, input.page, input.query, signal); await recheck(workspace, connection); return result },
    async members(input, signal) { const { workspace, connection } = await capture(input); const result = await remote.members(connection, input.projectId, input.page, signal); await recheck(workspace, connection); return result },
    async inspect(input, signal) { const { workspace, connection } = await capture(input); const permission = await remote.inspect(connection, input.projectId, signal); await recheck(workspace, connection); rememberPermission(connection, input.projectId ?? null, permission); return permission },
    async linkAccount(input, signal) {
      const { workspace, connection } = await capture(input)
      const user = await remote.user(connection, signal)
      if (user.state !== 'active') throw new IntegrationError('GitLab 个人账号不可用', 'denied')
      await recheck(workspace, connection)
      return repo.change((state) => {
        const previous = state.accounts.find((a) => a.ownerId === workspace.workspaceId && a.account.connectionId === connection.public.id)
        const account: IntegrationAccount = { id: previous?.account.id ?? randomUUID(), providerId: 'gitlab', connectionId: connection.public.id, remoteUserId: user.id, displayName: `${user.name} (@${user.username})`, revision: (previous?.account.revision ?? 0) + 1, state: 'linked' }
        state.accounts = state.accounts.filter((a) => a.ownerId !== workspace.workspaceId || a.account.connectionId !== connection.public.id)
        state.accounts.push({ account, instanceId: connection.instanceId, ownerId: workspace.workspaceId, verifiedRevision: connection.public.revision }); return account
      })
    },
    async unlinkAccount(input) { const { workspace, connection } = await capture(input); repo.change((state) => { const account = state.accounts.find((a) => a.ownerId === workspace.workspaceId && a.account.id === input.accountId && a.account.connectionId === connection.public.id); if (!account || account.account.revision !== input.revision) throw new IntegrationError('个人绑定已变更', 'conflict'); account.account.state = 'revoked'; account.account.revision++ }); return null },
    async savePlan(input, signal) {
      const { workspace, connection } = await capture(input)
      // Explicit save may adopt a renewed credential revision, while preserving
      // binding/project identity and refusing an unrelated source or workspace.
      const previous = input.bindingId ? repo.read().bindings.find((b) => b.plan.id === input.bindingId) : undefined
      if (Boolean(input.bindingId) !== Boolean(input.bindingRevision)) throw new IntegrationError('修改绑定必须同时携带 ID 和修订', 'invalid')
      if (input.bindingId && (!previous || previous.plan.source.bindingRevision !== input.bindingRevision || previous.owner.workspaceId !== workspace.workspaceId || previous.owner.grantId !== workspace.grantId || previous.owner.grantRevision !== workspace.revision || previous.plan.target.profileId !== ports.profileId || previous.plan.source.connectionId !== connection.public.id || previous.plan.source.instanceId !== connection.instanceId || previous.project.id !== input.projectId)) throw new IntegrationError('编辑绑定必须保留原工作区、实例和项目身份', 'conflict')
      if (previous) await noActive(workspace, previous)
      if (input.transport === 'webhook' && !ports.receiver) throw new IntegrationError('尚未配置可达的 GitLab Webhook 接收端，请选择定时同步', 'denied')
      const project = await remote.project(connection, input.projectId, signal)
      if (!project.issuesEnabled) throw new IntegrationError('所选项目未启用 Issues', 'denied')
      const permission = await remote.inspect(connection, input.projectId, signal)
      if (input.direction === 'bidirectional' && permission.write !== 'granted') throw new IntegrationError('当前令牌未验证 api 范围，请显式升级授权', 'denied')
      if (input.transport === 'webhook' && permission.hooks !== 'granted') throw new IntegrationError('Webhook 需要 api 范围和 Maintainer 项目角色', 'denied')
      const choices = ports.tasks.choices(workspace)
      if (input.mapping.statuses.some((s) => !choices.statuses.some((v) => v.id === s.local)) || input.mapping.members.some((m) => !choices.members.some((v) => v.id === m.local))) throw new IntegrationError('映射目标不属于当前工作区', 'invalid')
      for (const member of input.mapping.members) await remote.member(connection, project.id, member.remote, signal)
      await recheck(workspace, connection)
      if (previous) { await noActive(workspace, previous); await recheck(workspace, connection); const latest = repo.read().bindings.find((b) => b.plan.id === previous.plan.id); if (!latest || latest.plan.revision !== previous.plan.revision) throw new IntegrationError('绑定在保存前已变更', 'conflict') }
      const bindingId = previous?.plan.id ?? randomUUID(), revision = (previous?.plan.revision ?? 0) + 1
      const binding = gitlabBindingSchema.parse({ plan: { id: bindingId, revision, source: { providerId: 'gitlab', connectionId: connection.public.id, connectionRevision: connection.public.revision, instanceId: connection.instanceId, remoteProjectId: project.id, bindingId, bindingRevision: revision }, target: { kind: 'local-daemon', profileId: ports.profileId, workspaceId: workspace.workspaceId }, direction: input.direction, state: 'paused', transport: input.transport, fieldMappingRevision: revision }, owner: { workspaceId: workspace.workspaceId, grantId: workspace.grantId, grantRevision: workspace.revision }, project, mapping: { ...input.mapping, revision }, createMissing: input.createMissing, history: input.history, lastSuccessAt: previous?.project.id === project.id ? previous.lastSuccessAt : null, lastFullScanAt: null, continuation: null, lastError: null, nextPollAt: Date.now() + 60000, failures: 0, hook: previous?.project.id === project.id ? previous.hook : { state: 'absent', remoteId: null, lastEventAt: null, detail: '未注册；保存配置不会创建 Webhook' } })
      rememberPermission(connection, project.id, permission)
      return repo.change((state) => {
        if (!previous && state.bindings.some((b) => b.owner.workspaceId === workspace.workspaceId && b.plan.source.connectionId === connection.public.id && b.project.id === project.id)) throw new IntegrationError('此来源项目已绑定，编辑原绑定以保留同步基线', 'conflict')
        if (previous && !previous.history && input.history) for (const baseline of state.baselines) if (baseline.bindingId === bindingId) { baseline.notesAfter = null; baseline.noteCursor = 1; baseline.notesComplete = false }
        const index = state.bindings.findIndex((b) => b.plan.id === bindingId)
        if (index < 0) state.bindings.push(binding); else state.bindings[index] = binding
        return binding
      })
    },
    async setPlanState(input, signal) {
      const { workspace, connection } = await capture(input), binding = bound(input, workspace, connection)
      if (input.state === 'active') { const permission = await remote.inspect(connection, binding.project.id, signal); if (binding.plan.direction === 'bidirectional' && permission.write !== 'granted') throw new IntegrationError('写入授权不可用', 'denied'); await recheck(workspace, connection); bound(input, workspace, connection) }
      return repo.change((state) => { const b = state.bindings.find((v) => v.plan.id === binding.plan.id); if (!b) throw new IntegrationError('绑定已删除', 'conflict'); b.plan.state = input.state; b.nextPollAt = Date.now(); return b })
    },
    async previewImport(input, signal) {
      const { workspace, connection } = await capture(input), binding = bound(input, workspace, connection)
      const page = await remote.issues(connection, binding.project.id, input.page, undefined, undefined, input.state, signal)
      await recheck(workspace, connection); bound(input, workspace, connection)
      const content = { source: binding.plan.source, bindingRevision: binding.plan.revision, issues: page.items, mapping: binding.mapping, history: binding.history }
      const preview: GitlabPreview = { id: randomUUID(), source: binding.plan.source, bindingRevision: binding.plan.revision, digest: digest(content), count: page.items.length, hasMore: page.hasMore, issues: page.items, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), warnings: ['仅导入本次展示的一个分页；总量未知。', '本地已有任务或已编辑 PRD 保持原有内容，差异进入冲突处理。', ...(binding.history ? ['评论历史通过数字 note ID 分页归档；附件仅保留正文引用，不自动下载。'] : [])] }
      if (Buffer.byteLength(JSON.stringify(preview)) > 180000) throw new IntegrationError('预览超过单次响应容量，请缩小 Issue 描述或分批选择', 'invalid')
      // Admitted jobs retain their exact previews even after expiry. Never evict a
      // snapshot merely because a later preview was requested.
      const retained = new Set<string>(); let after: string | null = null
      do { const page = await ports.jobs(workspace, after); for (const job of page.items) if (job.input.kind === 'import' && !['completed', 'cancelled'].includes(job.state)) retained.add(job.input.previewId); after = page.next } while (after)
      await recheck(workspace, connection); bound(input, workspace, connection)
      repo.change((state) => { state.previews = state.previews.filter((p) => p.source.bindingId !== binding.plan.id || Date.parse(p.expiresAt) > Date.now() || retained.has(p.id)); if (state.previews.length >= 20) throw new IntegrationError('导入预览容量已满；等待未提交预览过期或处理原作业后重试', 'io'); state.previews.push(preview) })
      return preview
    },
    async startImport(input) {
      const { workspace, connection } = await capture(input), binding = bound(input, workspace, connection), preview = repo.read().previews.find((p) => p.id === input.previewId)
      if (!preview || preview.digest !== input.previewDigest || Date.parse(preview.expiresAt) <= Date.now() || !sameSource(preview.source, binding.plan.source) || preview.bindingRevision !== binding.plan.revision) throw new IntegrationError('预览已过期或配置已变更，请重新预览', 'conflict')
      await noActive(workspace, binding); await recheck(workspace, connection); bound(input, workspace, connection)
      if (Date.parse(preview.expiresAt) <= Date.now()) throw new IntegrationError('导入预览在接纳前已过期，请重新预览', 'conflict')
      return ports.enqueue(workspace, binding.plan.source, { kind: 'import', previewId: preview.id, previewDigest: preview.digest, format: 'api' }, input.commandId)
    },
    async catchUp(input) {
      const { workspace, connection } = await capture(input), binding = bound(input, workspace, connection)
      if (binding.plan.state === 'paused' || binding.plan.state === 'blocked') throw new IntegrationError('先启用此同步，再执行追赶', 'denied')
      await noActive(workspace, binding); await recheck(workspace, connection); bound(input, workspace, connection)
      return ports.enqueue(workspace, binding.plan.source, { kind: 'sync', planId: binding.plan.id, planRevision: binding.plan.revision }, input.commandId)
    },
    async jobs(input) { const { workspace, connection } = await capture(input); const page = await ports.jobs(workspace, input.after); await recheck(workspace, connection); const items = page.items.filter((job) => job.source.providerId === 'gitlab' && job.source.connectionId === connection.public.id && job.source.instanceId === connection.instanceId); const failures = repo.read().failures.filter((f) => items.some((j) => j.id === f.jobId)); return { items, next: page.next, failures: failures.slice(0, 100), hasMoreFailures: failures.length > 100 } },
    async cancelJob(input) { const { workspace, connection } = await capture(input), job = await ports.job(workspace, input.jobId); if (!job || job.revision !== input.revision || job.source.providerId !== 'gitlab' || job.source.connectionId !== connection.public.id || job.source.instanceId !== connection.instanceId) throw new IntegrationError('原作业已变更或不属于所选来源', 'conflict'); await recheck(workspace, connection); return ports.cancel(workspace, job, input.commandId) },
    async reconcileJob(input) {
      const { workspace, connection } = await capture(input), job = await ports.job(workspace, input.jobId)
      if (!job || job.revision !== input.revision || job.source.connectionId !== connection.public.id || job.source.instanceId !== connection.instanceId || job.source.providerId !== 'gitlab') throw new IntegrationError('对账作业身份不匹配', 'conflict')
      const result = await work.reconcile({ job, workspace, connection }); await recheck(workspace, connection)
      if (result.resolved && result.evidenceRef) await ports.reconciled(workspace, job, result.evidenceRef)
      return result
    },
    async resolveConflict(input) {
      const { workspace, connection } = await capture(input), binding = bound(input, workspace, connection)
      if (input.resolution === 'local' && binding.plan.direction !== 'bidirectional') throw new IntegrationError('单向导入不能将本地值写回远端', 'denied')
      repo.change((state) => { const conflict = state.conflicts.find((c) => c.id === input.conflictId && c.bindingId === binding.plan.id && c.state === 'open'); if (!conflict) throw new IntegrationError('冲突已处理或不属于当前绑定', 'conflict'); conflict.resolution = input.resolution; conflict.state = 'resolved' })
      return null
    },
    async authorizeWrites(input, signal) { const { workspace, connection } = await capture(input); if (!signal) throw new IntegrationError('缺少可取消的原生授权会话', 'invalid'); const result = await ports.authorizeWrites(connection, signal); ports.assertWorkspace(workspace); return result },
    async recoverHook(input) {
      const { workspace, connection } = await capture(input), binding = bound(input, workspace, connection)
      if (!ports.receiver || binding.plan.transport !== 'webhook' || binding.plan.state === 'paused') throw new IntegrationError('请先配置接收端并启用 Webhook 同步', 'denied')
      await noActive(workspace, binding); const permission = await remote.inspect(connection, binding.project.id); if (permission.hooks !== 'granted') throw new IntegrationError('没有注册 Webhook 的授权', 'denied'); await recheck(workspace, connection); bound(input, workspace, connection)
      repo.change((state) => { const b = state.bindings.find((v) => v.plan.id === binding.plan.id); if (b) { if (b.hook.state === 'unknown') throw new IntegrationError('原 Hook 注册结果未知，不能再次注册', 'conflict'); b.hook.state = 'pending'; b.hook.detail = '已明确请求注册，等待持久作业执行' } })
      return ports.enqueue(workspace, binding.plan.source, { kind: 'sync', planId: binding.plan.id, planRevision: binding.plan.revision }, input.commandId)
    },
    async createIssue(input, signal) { return queueWrite('create', input, signal) },
    async addComment(input, signal) { return queueWrite('note', input, signal) },
    async issueDetail(input, signal) { const { workspace, connection } = await capture(input), binding = bound(input, workspace, connection); const issue = await remote.issue(connection, binding.project.id, input.iid, signal); const notes = await remote.notes(connection, binding.project.id, input.iid, input.notesPage, signal, issue.id); await recheck(workspace, connection); bound(input, workspace, connection); return { issue, notes: notes.items, hasMore: notes.hasMore } },
    async localTasks(input) { const { workspace } = await capture(input); return ports.tasks.list(workspace, input.page) }
  }
  // Serialize admissions and config mutation per captured connection. This is a
  // short application lock, not another job scheduler or persistence authority.
  const admissions = new Map<string, Promise<void>>()
  async function serial<T>(input: GitlabInput<'snapshot'>, action: () => Promise<T>): Promise<T> {
    const key = input.connectionId, previous = admissions.get(key)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    admissions.set(key, gate)
    try { await previous; return await action() } finally { release(); if (admissions.get(key) === gate) admissions.delete(key) }
  }
  return { ...actions,
    savePlan: (i, s) => serial(i, () => actions.savePlan(i, s)), setPlanState: (i, s) => serial(i, () => actions.setPlanState(i, s)),
    startImport: (i, s) => serial(i, () => actions.startImport(i, s)), catchUp: (i, s) => serial(i, () => actions.catchUp(i, s)),
    createIssue: (i, s) => serial(i, () => actions.createIssue(i, s)), addComment: (i, s) => serial(i, () => actions.addComment(i, s)), recoverHook: (i, s) => serial(i, () => actions.recoverHook(i, s))
  }
}
