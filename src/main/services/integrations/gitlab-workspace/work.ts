import { z } from 'zod'
import type { IntegrationWorkPort } from '../work-ports'
import type { WorkspaceGrant } from '../../../../shared/daemon'
import type { GitlabBinding, GitlabFields, GitlabIssue, GitlabPermission } from '../../../../shared/gitlab-integration'
import { IntegrationError, type ResolvedConnection } from '../types'
import { GitlabIssueAdapter } from './adapter'
import { digest, equal, mappedChanges } from './mapping'
import type { GitlabWorkspacePorts } from './ports'
import type { GitlabBaseline, GitlabEffect } from './types'

const cursorSchema = z.object({ page: z.number().int().min(1).max(201), index: z.number().int().min(0).max(30), since: z.string().optional(), until: z.string(), locals: z.number().int().nonnegative(), hadFailures: z.boolean(), phase: z.enum(['local', 'remote']) }).strict()
export function sameSource(a: GitlabBinding['plan']['source'], b: GitlabBinding['plan']['source']): boolean { return (Object.keys(a) as (keyof typeof a)[]).every((key) => a[key] === b[key]) }
export function assertBindingOwner(binding: GitlabBinding, workspace: WorkspaceGrant, c: ResolvedConnection, profileId: string): void {
  const source = binding.plan.source
  if (binding.plan.target.profileId !== profileId || source.providerId !== 'gitlab' || workspace.workspaceId !== binding.owner.workspaceId || binding.plan.target.workspaceId !== workspace.workspaceId || workspace.grantId !== binding.owner.grantId || workspace.revision !== binding.owner.grantRevision || source.connectionId !== c.public.id || source.connectionRevision !== c.public.revision || source.instanceId !== c.instanceId || source.remoteProjectId !== binding.project.id || source.bindingId !== binding.plan.id || binding.mapping.revision !== binding.plan.fieldMappingRevision || c.public.providerId !== 'gitlab') throw new IntegrationError('GitLab 工作区、实例或连接修订已变更', 'conflict')
}
export function createGitlabWorkPort(ports: GitlabWorkspacePorts, remote: GitlabIssueAdapter): IntegrationWorkPort {
  const repo = ports.repository
  function current(binding: GitlabBinding, workspace: WorkspaceGrant, c: ResolvedConnection): GitlabBinding {
    ports.assertWorkspace(workspace)
    const latest = repo.read().bindings.find((b) => b.plan.id === binding.plan.id)
    if (!latest || !sameSource(latest.plan.source, binding.plan.source) || latest.plan.revision !== binding.plan.revision) throw new IntegrationError('GitLab 同步配置已更新', 'conflict')
    assertBindingOwner(latest, workspace, c, ports.profileId)
    if (latest.plan.target.profileId !== ports.profileId) throw new IntegrationError('同步计划属于其他本机配置身份', 'denied')
    return latest
  }
  async function check(binding: GitlabBinding, workspace: WorkspaceGrant, c: ResolvedConnection) { current(binding, workspace, c); await ports.credentials.assertCurrent(c); return current(binding, workspace, c) }
  async function persistEffect(effect: GitlabEffect, action: () => Promise<string>): Promise<void> {
    const previous = repo.read().effects.find((e) => e.id === effect.id)
    if (previous?.state === 'confirmed') return
    if (previous && previous.state !== 'rejected') throw new IntegrationError('原 GitLab 写入尚待对账，禁止重发', 'uncertain')
    // A rejected command is evidence too. New explicit intent needs a new common job.
    if (previous) throw new IntegrationError('原 GitLab 写入已被拒绝，请修复后显式创建新作业', 'denied')
    repo.change((state) => { state.effects.push(effect) })
    try {
      const remoteId = await action()
      repo.change((state) => { const row = state.effects.find((e) => e.id === effect.id); if (!row) throw new IntegrationError('写入回执不存在', 'io'); row.state = 'confirmed'; row.remoteId = remoteId })
    } catch (error) {
      repo.change((state) => { const row = state.effects.find((e) => e.id === effect.id); if (row) row.state = error instanceof IntegrationError && ['denied', 'invalid'].includes(error.kind) ? 'rejected' : 'unknown' })
      throw error
    }
  }
  async function synchronizeIssue(binding: GitlabBinding, issue: GitlabIssue, workspace: WorkspaceGrant, c: ResolvedConnection, jobId: string, signal: AbortSignal, permission?: GitlabPermission): Promise<boolean> {
    await check(binding, workspace, c)
    if (issue.instanceId !== c.instanceId || issue.projectId !== binding.project.id) throw new IntegrationError('Issue 来源不符合已接纳作业', 'conflict')
    const state = repo.read(), base = state.baselines.find((b) => b.bindingId === binding.plan.id && b.issue.id === issue.id)
    let task = base ? ports.tasks.read(workspace, base.taskRef) : binding.createMissing ? await ports.tasks.import(workspace, issue, binding.mapping) : null
    if (!task) return true
    await check(binding, workspace, c)
    if (!task.source || task.source.provider !== 'gitlab' || task.source.instanceId !== issue.instanceId || task.source.id !== issue.id) throw new IntegrationError('本地任务的业务来源已变更或被移除', 'conflict')
    if (task.archived) throw new IntegrationError('已归档任务保留来源，不执行自动字段更新', 'conflict')
    if (task.created) {
      const patch = Object.fromEntries(binding.mapping.fields.map((field) => [field, issue.fields[field]])) as Partial<GitlabFields>
      task = ports.tasks.apply(workspace, task, patch, binding.mapping)
    }
    const changes = mappedChanges(binding.plan.id, issue, task, binding.mapping, base, binding.plan.direction, state.conflicts.filter((v) => v.bindingId === binding.plan.id))
    repo.change((next) => {
      // Superseded conflict values cannot remain actionable after a refresh.
      next.conflicts = next.conflicts.filter((v) => v.bindingId !== binding.plan.id || v.issue.id !== issue.id || v.state !== 'open' || changes.conflicts.some((c) => c.id === v.id))
      for (const conflict of changes.conflicts) if (!next.conflicts.some((v) => v.id === conflict.id)) next.conflicts.push(conflict)
    })
    if (Object.keys(changes.inbound).length) { await check(binding, workspace, c); task = ports.tasks.apply(workspace, task, changes.inbound, binding.mapping) }
    let updated = issue
    if (Object.keys(changes.outbound).length) {
      if (!permission || permission.write !== 'granted') throw new IntegrationError('双向同步需要重新验证 api 授权', 'denied')
      const granted = permission, retainedTask = task
      const latest = await remote.issue(c, issue.projectId, issue.iid, signal)
      if (latest.id !== issue.id || latest.updatedAt !== issue.updatedAt) throw new IntegrationError('GitLab Issue 在写入前已变更，请重新预览', 'conflict')
      const local = ports.tasks.read(workspace, retainedTask.taskRef)
      if (local.revision !== retainedTask.revision) throw new IntegrationError('本地任务在写入前已变更', 'conflict')
      await check(binding, workspace, c)
      if (signal.aborted) throw new IntegrationError('操作已取消', 'denied')
      const effect: GitlabEffect = { id: digest([jobId, issue.id, changes.outbound]), jobId, bindingId: binding.plan.id, kind: 'edit', state: 'prepared', issue, patch: changes.outbound, taskRef: task.taskRef, expectedLocalRevision: task.revision, remoteId: null, body: null, at: new Date().toISOString() }
      await persistEffect(effect, async () => {
        updated = await remote.edit(c, issue, changes.outbound, granted, signal)
        if (updated.id !== issue.id || Object.entries(changes.outbound).some(([field, value]) => !equal(field as keyof GitlabFields, updated.fields[field as keyof GitlabFields], value))) throw new IntegrationError('GitLab 写入响应未证明目标字段已生效', 'uncertain')
        return updated.id
      })
    }
    await check(binding, workspace, c)
    const merged = { ...updated.fields }
    for (const conflict of changes.conflicts) if (base) Object.assign(merged, { [conflict.field]: base.fields[conflict.field] })
    const baseline: GitlabBaseline = { bindingId: binding.plan.id, issue: updated, taskRef: task.taskRef, localRevision: task.revision, fields: merged, noteCursor: base?.noteCursor ?? 1, notesAfter: base ? base.notesAfter : binding.history ? null : new Date().toISOString(), notesComplete: false }
    repo.change((next) => { const index = next.baselines.findIndex((b) => b.bindingId === binding.plan.id && b.issue.id === issue.id); if (index < 0) next.baselines.push(baseline); else next.baselines[index] = baseline })
    // Import notes through stable numeric IDs, including edits. System notes stay evidence.
    if (binding.mapping.comments && (binding.history || base)) {
      for (let count = 0; count < 10; count++) {
        const page = await remote.notes(c, issue.projectId, issue.iid, baseline.noteCursor, signal, issue.id)
        await check(binding, workspace, c)
        repo.change((next) => {
          for (const note of page.items) { if (baseline.notesAfter && Date.parse(note.createdAt) < Date.parse(baseline.notesAfter)) continue; const found = next.notes.find((v) => v.bindingId === binding.plan.id && v.issueId === issue.id && v.note.id === note.id); if (found) found.note = note; else next.notes.push({ bindingId: binding.plan.id, issueId: issue.id, note }) }
          const stored = next.baselines.find((b) => b.bindingId === binding.plan.id && b.issue.id === issue.id)
          if (stored) { stored.noteCursor = page.hasMore ? baseline.noteCursor + 1 : 1; stored.notesComplete = !page.hasMore }
        })
        if (!page.hasMore) { baseline.notesComplete = true; break }
        baseline.noteCursor++
      }
      if (!baseline.notesComplete) throw new IntegrationError('评论历史尚未读完；已保存游标，继续追赶可恢复', 'upstream')
    }
    return changes.conflicts.length === 0
  }
  const work: IntegrationWorkPort = {
    supports(kind) { return kind === 'sync' || kind === 'import' },
    async dispatch(input) {
      const { job, workspace, connection: c, signal } = input
      if (job.workspaceId !== workspace.workspaceId) throw new IntegrationError('作业不属于已授权工作区', 'denied')
      const binding = repo.read().bindings.find((b) => b.plan.id === job.source.bindingId)
      if (!binding || !sameSource(binding.plan.source, job.source)) throw new IntegrationError('作业绑定或来源已变更', 'conflict')
      await check(binding, workspace, c)
      if (repo.read().effects.some((e) => e.bindingId === binding.plan.id && ['prepared', 'unknown'].includes(e.state))) throw new IntegrationError('此来源存在未确认的远端写入，请先对账原作业', 'uncertain')
      if (job.input.kind !== 'sync' && job.input.kind !== 'import') throw new IntegrationError('GitLab 不支持此作业类型', 'invalid')
      if (job.input.kind === 'sync' && (job.input.planId !== binding.plan.id || job.input.planRevision !== binding.plan.revision)) throw new IntegrationError('同步计划修订不匹配', 'conflict')
      let revision = job.revision, counts = { ...job.counts }
      const retainedCursor = job.cursor ?? (job.input.kind === 'sync' ? binding.continuation : null)
      const cursor: z.infer<typeof cursorSchema> = retainedCursor ? cursorSchema.parse(JSON.parse(retainedCursor)) : { page: 1, index: 0, since: binding.lastSuccessAt && binding.lastFullScanAt && Date.now() - Date.parse(binding.lastFullScanAt) < 86400000 ? new Date(Date.parse(binding.lastSuccessAt) - 120000).toISOString() : undefined, until: new Date().toISOString(), locals: 0, hadFailures: false, phase: 'local' }
      const evidence = `gitlab:${job.id}`
      const result = (state: 'completed' | 'partially-failed' | 'paused' | 'unknown' | 'cancelled') => {
        if (job.input.kind === 'sync') repo.change((s) => { const b = s.bindings.find((v) => v.plan.id === binding.plan.id); if (b && sameSource(b.plan.source, job.source)) { b.continuation = state === 'paused' ? JSON.stringify(cursor) : null; if (state === 'paused' || state === 'cancelled') b.nextPollAt = Date.now() + 60000 } })
        return { state, evidenceRef: evidence, cursor: JSON.stringify(cursor), counts }
      }
      const checkpoint = () => { const saved = input.checkpoint(revision, { cursor: JSON.stringify(cursor), counts }, evidence); revision = saved.revision }
      if (job.input.kind === 'sync' && current(binding, workspace, c).plan.state === 'paused') return result('paused')
      if (binding.plan.state === 'blocked' || binding.plan.state === 'unverified') throw new IntegrationError('同步计划尚未通过权限检查', 'denied')
      let permission: GitlabPermission | undefined
      if (job.input.kind === 'sync' && (binding.plan.direction === 'bidirectional' || binding.hook.state === 'pending')) permission = await remote.inspect(c, binding.project.id, signal)
      const intent = repo.read().intents.find((i) => i.commandId === job.commandId)
      if (intent) {
        if (intent.bindingId !== binding.plan.id || intent.bindingRevision !== binding.plan.revision || binding.plan.direction !== 'bidirectional' || permission?.write !== 'granted') throw new IntegrationError('写入意图与原绑定或授权不一致', 'denied')
        const granted = permission
        if (signal.aborted) return result('cancelled')
        let task = ports.tasks.read(workspace, intent.taskRef)
        const retained = repo.read().effects.find((e) => e.id === intent.commandId)
        const repair = intent.kind === 'create' && retained?.state === 'confirmed' && retained.issue && task.source?.provider === 'gitlab' && task.source.instanceId === retained.issue.instanceId && task.source.id === retained.issue.id
        if (task.revision !== intent.localRevision && !repair || task.archived) throw new IntegrationError('写入预览的本地任务已变更', 'conflict')
        if (intent.kind === 'note' && (!intent.issue || task.source?.provider !== 'gitlab' || task.source.instanceId !== intent.issue.instanceId || task.source.id !== intent.issue.id)) throw new IntegrationError('评论关联的本地来源已被修改或移除', 'conflict')
        const effect: GitlabEffect = { id: intent.commandId, jobId: job.id, bindingId: binding.plan.id, kind: intent.kind, state: 'prepared', issue: intent.issue, patch: intent.fields ? Object.fromEntries(binding.mapping.fields.map((field) => [field, intent.fields?.[field]])) as Partial<GitlabFields> : null, taskRef: task.taskRef, expectedLocalRevision: task.revision, remoteId: null, body: intent.body, at: new Date().toISOString() }
        if (intent.kind === 'note' && intent.issue) {
          const actual = await remote.issue(c, intent.issue.projectId, intent.issue.iid, signal)
          if (actual.id !== intent.issue.id) throw new IntegrationError('评论目标 Issue 身份已变更', 'conflict')
          await check(binding, workspace, c)
        }
        await persistEffect(effect, async () => {
          await check(binding, workspace, c)
          if (intent.kind === 'create' && intent.fields) { const created = await remote.create(c, binding.project.id, intent.fields, binding.mapping.fields, granted, signal); repo.change((s) => { const receipt = s.effects.find((v) => v.id === effect.id); if (receipt) receipt.issue = created }); return created.id }
          if (intent.kind === 'note' && intent.issue && intent.body) {
            const note = await remote.comment(c, intent.issue, intent.body, granted, signal)
            return note.id
          }
          throw new IntegrationError('持久写入意图不完整', 'invalid')
        })
        const receipt = repo.read().effects.find((e) => e.id === effect.id)
        if (intent.kind === 'create') {
          // A confirmed effect can be replayed after local publication failed.
          // Its exact response survives; do not report completion before repair.
          const issue = receipt?.issue
          if (!issue) throw new IntegrationError('远端创建已确认但缺少原响应证据', 'uncertain')
          await check(binding, workspace, c)
          task = ports.tasks.attachSource(workspace, task, issue)
          repo.change((state) => { if (!state.baselines.some((b) => b.bindingId === binding.plan.id && b.issue.id === issue.id && b.taskRef === task.taskRef)) state.baselines.push({ bindingId: binding.plan.id, issue, taskRef: task.taskRef, localRevision: task.revision, fields: issue.fields, noteCursor: 1, notesAfter: binding.history ? null : new Date().toISOString(), notesComplete: false }) })
        }
        counts = { processed: 1, failed: 0, total: 1 }; checkpoint()
        return result('completed')
      }
      if (job.input.kind === 'sync' && binding.hook.state === 'pending') {
        if (!ports.receiver || !permission || permission.hooks !== 'granted') throw new IntegrationError('可达接收端或 Webhook 权限不可用', 'denied')
        const granted = permission
        const config = await ports.receiver.configuration(binding)
        const url = new URL(config.url)
        if (url.protocol !== 'https:' || url.username || url.password || url.hash || config.token.length < 32 || config.token.length > 256 || /[\u0000-\u001f\u007f]/.test(config.token)) throw new IntegrationError('Webhook 必须使用已配置的 HTTPS 接收端及受保护的高强度共享令牌', 'denied')
        await check(binding, workspace, c)
        const knownHookId = binding.hook.remoteId ?? repo.read().effects.filter((e) => e.bindingId === binding.plan.id && e.kind === 'hook' && e.state === 'confirmed').at(-1)?.remoteId ?? null
        const effect: GitlabEffect = { id: digest([job.id, 'hook']), jobId: job.id, bindingId: binding.plan.id, kind: 'hook', state: 'prepared', issue: null, patch: null, taskRef: null, expectedLocalRevision: null, remoteId: knownHookId, body: null, at: new Date().toISOString() }
        try {
          await persistEffect(effect, async () => { const hook = await remote.registerHook(c, binding.project.id, { ...config, ...(knownHookId ? { id: knownHookId } : {}) }, granted, signal); return hook.id })
          repo.change((state) => { const b = state.bindings.find((v) => v.plan.id === binding.plan.id), receipt = state.effects.find((v) => v.id === effect.id); if (b && receipt) { b.hook.state = 'registered'; b.hook.remoteId = receipt.remoteId; b.hook.detail = '已注册，尚未收到经验证事件' } })
        } catch (error) { repo.change((state) => { const b = state.bindings.find((v) => v.plan.id === binding.plan.id); if (b) { b.hook.state = error instanceof IntegrationError && error.kind === 'denied' ? 'failed' : 'unknown'; b.hook.detail = '注册未确认；请核实原作业，轮询继续可用' } }); throw error }
      }
      const workInput = job.input
      const preview = workInput.kind === 'import' ? repo.read().previews.find((p) => p.id === workInput.previewId) : undefined
      if (job.input.kind === 'import' && (!preview || preview.digest !== job.input.previewDigest || !sameSource(preview.source, job.source))) throw new IntegrationError('导入预览与作业身份不匹配', 'conflict')
      if (preview && digest({ source: preview.source, bindingRevision: preview.bindingRevision, issues: preview.issues, mapping: binding.mapping, history: binding.history }) !== preview.digest) throw new IntegrationError('导入预览摘要不匹配', 'conflict')
      if (preview) { counts.total = preview.issues.length; cursor.phase = 'remote' }
      const visit = async (issue: GitlabIssue) => {
        const priorFailed = counts.failed
        try { if (!await synchronizeIssue(preview ? { ...binding, createMissing: true, plan: { ...binding.plan, direction: 'inbound' } } : binding, issue, workspace, c, job.id, signal, permission)) counts.failed++ }
        catch (error) {
          if (!(error instanceof IntegrationError) || error.kind === 'uncertain' || error.kind === 'io') throw error
          counts.failed++
          repo.change((state) => { state.failures.push({ jobId: job.id, issueId: issue.id, detail: error.message.slice(0, 400), at: new Date().toISOString() }); const b = state.bindings.find((v) => v.plan.id === binding.plan.id); if (b && sameSource(b.plan.source, binding.plan.source)) { if (b.plan.state !== 'paused') b.plan.state = 'degraded'; b.lastError = error.message.slice(0, 400) } })
        }
        if (counts.failed > priorFailed) cursor.hadFailures = true
        counts.processed++
      }
      try {
        // Include local edits even if no remote issue has changed since the watermark.
        const baselines = repo.read().baselines.filter((b) => b.bindingId === binding.plan.id)
        let localBatch = 0
        while (cursor.phase === 'local' && cursor.locals < baselines.length && localBatch < 30) {
          if (signal.aborted) return result('cancelled')
          if (!preview && (await check(binding, workspace, c)).plan.state === 'paused') return result('paused')
          const base = baselines[cursor.locals]
          if (base) await visit(await remote.issue(c, base.issue.projectId, base.issue.iid, signal))
          cursor.locals++; localBatch++; checkpoint()
        }
        if (cursor.phase === 'local' && cursor.locals < baselines.length) return result('paused')
        cursor.phase = 'remote'
        for (let batch = 0; batch < 20; batch++) {
          if (signal.aborted) return result('cancelled')
          if (!preview && (await check(binding, workspace, c)).plan.state === 'paused') return result('paused')
          const page = preview ? { items: preview.issues, hasMore: false } : await remote.issues(c, binding.project.id, cursor.page, cursor.since, cursor.until, 'all', signal)
          while (cursor.index < page.items.length) {
            if (signal.aborted) return result('cancelled')
            const item = page.items[cursor.index]; if (item) await visit(item)
            cursor.index++; checkpoint()
          }
          if (!page.hasMore) {
            repo.change((state) => { const b = state.bindings.find((v) => v.plan.id === binding.plan.id); if (b && !preview) { if (!cursor.hadFailures) { b.lastSuccessAt = cursor.until; if (!cursor.since) b.lastFullScanAt = cursor.until; b.lastError = null } b.failures = cursor.hadFailures ? b.failures + 1 : 0; b.nextPollAt = Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(b.failures, 6)); if (b.plan.state !== 'paused') b.plan.state = cursor.hadFailures ? 'degraded' : 'active' } })
            return result(cursor.hadFailures ? 'partially-failed' : 'completed')
          }
          cursor.page++; cursor.index = 0; checkpoint()
          if (cursor.page > 200) throw new IntegrationError('本轮追赶达到分页上限，请缩小范围或继续分批导入', 'upstream')
        }
        // Finite worker slice; next explicit catch-up uses the retained cursor.
        return result('paused')
      } catch (error) {
        if (repo.read().effects.some((e) => e.jobId === job.id && ['unknown', 'prepared'].includes(e.state))) return result('unknown')
        if (signal.aborted) return result('cancelled')
        throw error
      }
    },
    async reconcile({ job, workspace, connection: c }) {
      const binding = repo.read().bindings.find((b) => b.plan.id === job.source.bindingId)
      if (!binding || !sameSource(binding.plan.source, job.source)) return { resolved: false, evidenceRef: null }
      await check(binding, workspace, c)
      const allEffects = repo.read().effects.filter((e) => e.jobId === job.id)
      const effects = allEffects.filter((e) => ['unknown', 'prepared'].includes(e.state))
      if (!allEffects.length) return { resolved: true, evidenceRef: `gitlab:${job.id}:no-remote-dispatch-retry-safe` }
      for (const effect of effects) {
        // Existing Issue edits can be reconciled by actual object fields. Creation,
        // notes and hook secrets cannot be proven absent from a timeout/list page.
        if (!['edit', 'create'].includes(effect.kind) || !effect.issue || !effect.patch) return { resolved: false, evidenceRef: null }
        const actual = await remote.issue(c, effect.issue.projectId, effect.issue.iid)
        if (actual.id !== effect.issue.id || Object.entries(effect.patch).some(([field, value]) => !equal(field as keyof GitlabFields, actual.fields[field as keyof GitlabFields], value))) return { resolved: false, evidenceRef: null }
        await check(binding, workspace, c)
        repo.change((state) => { const row = state.effects.find((e) => e.id === effect.id); if (row) { row.state = 'confirmed'; row.remoteId = actual.id } })
      }
      // Acknowledged remote creation is not local-link completion. Repair that
      // exact task using captured revision; never create another remote Issue.
      for (const effect of repo.read().effects.filter((e) => e.jobId === job.id && e.kind === 'create' && e.state === 'confirmed')) {
        if (!effect.issue || !effect.taskRef) return { resolved: false, evidenceRef: null }
        if (repo.read().baselines.some((b) => b.bindingId === binding.plan.id && b.issue.id === effect.issue?.id && b.taskRef !== effect.taskRef)) return { resolved: false, evidenceRef: null }
        let task = ports.tasks.read(workspace, effect.taskRef)
        if (!task.source && task.revision !== effect.expectedLocalRevision) return { resolved: false, evidenceRef: null }
        await check(binding, workspace, c)
        task = ports.tasks.attachSource(workspace, task, effect.issue)
        const issue = effect.issue
        repo.change((state) => { if (!state.baselines.some((b) => b.bindingId === binding.plan.id && b.issue.id === issue.id && b.taskRef === task.taskRef)) state.baselines.push({ bindingId: binding.plan.id, issue, taskRef: task.taskRef, localRevision: task.revision, fields: issue.fields, noteCursor: 1, notesAfter: binding.history ? null : new Date().toISOString(), notesComplete: false }) })
      }
      for (const effect of repo.read().effects.filter((e) => e.jobId === job.id && e.kind === 'hook' && e.state === 'confirmed')) {
        if (!effect.remoteId) return { resolved: false, evidenceRef: null }
        await check(binding, workspace, c)
        repo.change((state) => { const b = state.bindings.find((v) => v.plan.id === binding.plan.id); if (b) { b.hook.remoteId = effect.remoteId; if (b.hook.state !== 'receiving') b.hook.state = 'registered'; b.hook.detail = '已恢复原注册回执；等待已验证事件确认接收健康' } })
      }
      return { resolved: true, evidenceRef: `gitlab:${job.id}:reconciled` }
    }
  }
  const running = new Map<string, Promise<void>>()
  return { ...work, async dispatch(input) {
    const key = `${input.workspace.workspaceId}\0${input.job.source.bindingId}`, previous = running.get(key)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    running.set(key, gate)
    try { await previous; if (input.signal.aborted) return { state: 'cancelled' as const, evidenceRef: null, cursor: input.job.cursor, counts: input.job.counts }; return await work.dispatch(input) }
    finally { release(); if (running.get(key) === gate) running.delete(key) }
  } }
}
