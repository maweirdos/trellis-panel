import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { hasGitlabWorkspaceApi, type GitlabBinding, type GitlabInput, type GitlabOutput, type GitlabProject, type GitlabResult, type GitlabUser, type GitlabWorkspaceApi } from '@shared/gitlab-integration'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../../../../../utils/interaction-scope'
import { Select } from '../../../../../components/Select'
import { Button } from '../../../../ui'
import type { ProviderWorkspaceProps } from '../../provider-workspace'
import { IntegrationAccountSection, IntegrationImportSection, IntegrationResourceState, IntegrationSection, IntegrationSyncSection, type IntegrationResource, type IntegrationSectionAction } from '../../IntegrationSections'
import { GitlabPlanEditor } from './PlanEditor'

function nativeApi(): GitlabWorkspaceApi | null {
  const value = (window.trellis as unknown as { gitlabWorkspace?: unknown } | undefined)?.gitlabWorkspace
  return hasGitlabWorkspaceApi(value) ? value : null
}
class GitlabUiError extends Error { constructor(message: string, readonly code: string) { super(message) } }
function unwrap<T>(result: GitlabResult<T>): T { if (!result.ok) throw new GitlabUiError(result.error, result.code); return result.data }
type Snapshot = GitlabOutput<'snapshot'>
type JobPage = GitlabOutput<'jobs'>
export function GitlabSetupSection({ entry, connection }: ProviderWorkspaceProps): JSX.Element {
  return <IntegrationSection title={entry.id === 'gitlab-issues-self-managed' ? '自建 GitLab / 极狐实例' : 'GitLab.com / 极狐 GitLab'} description="Issues 与仓库复用同一连接和凭证；个人身份与项目同步单独绑定。">
    <p className="break-words text-my-sm text-my-secondary">{connection ? `来源实例：${connection.config.baseUrl} · ${connection.legacy ? '兼容配置' : connection.config.authMethod === 'oauth2' ? '浏览器 PKCE 授权' : '个人访问令牌'}` : '先在下方配置实际实例地址及浏览器 OAuth 或个人访问令牌。'}</p>
    <p className="text-my-xs text-my-tertiary">浏览器只读授权可读取项目与 Issue。双向写入及注册 Webhook 需要明确授予 api 范围；接收端未配置时可使用定时同步。具体权限以实际实例的验证结果为准。</p>
  </IntegrationSection>
}
export function GitlabWorkspaceContent(props: ProviderWorkspaceProps): JSX.Element {
  const api = nativeApi()
  if (!props.nativeAvailable || !api) return <IntegrationSection title="GitLab Issues"><IntegrationResourceState resource={{ state: 'unavailable', detail: '当前原生版本尚未接入 GitLab Issues 后台能力。完成主进程与 preload 接线后，完整重启应用以加载；现有仓库和 MR 功能仍可使用。' }} /></IntegrationSection>
  if (!props.root || !props.connection) return <IntegrationSection title="GitLab Issues"><p className="text-my-sm text-my-tertiary">请选择本地项目及 GitLab 连接。</p></IntegrationSection>
  return <GitlabWorkspace key={`${props.root}:${props.connection.id}:${props.connection.revision}`} {...props} api={api} context={{ expectedRoot: props.root, connectionId: props.connection.id, connectionRevision: props.connection.revision }} />
}
function GitlabWorkspace({ api, context: ownerContext, refresh: refreshConnections }: ProviderWorkspaceProps & { api: GitlabWorkspaceApi; context: GitlabInput<'snapshot'> }): JSX.Element {
  const [readGroup] = useState(() => crypto.randomUUID())
  const context = useMemo(() => ({ ...ownerContext, requestId: readGroup }), [ownerContext, readGroup])
  const [resource, setResource] = useState<IntegrationResource<Snapshot>>({ state: 'loading' })
  const [jobs, setJobs] = useState<JobPage>({ items: [], next: null, failures: [], hasMoreFailures: false })
  const [after, setAfter] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const [projects, setProjects] = useState<GitlabProject[]>([]), [projectPage, setProjectPage] = useState(1), [moreProjects, setMoreProjects] = useState(false), [query, setQuery] = useState('')
  const [members, setMembers] = useState<GitlabUser[]>([]), [memberProject, setMemberProject] = useState(''), [memberPage, setMemberPage] = useState(1), [moreMembers, setMoreMembers] = useState(false)
  const [editor, setEditor] = useState<GitlabBinding | 'new' | null>(null), [selected, setSelected] = useState<string>('')
  const [preview, setPreview] = useState<GitlabOutput<'previewImport'> | null>(null), [previewPage, setPreviewPage] = useState(1)
  const [detail, setDetail] = useState<GitlabOutput<'issueDetail'> | null>(null), [iid, setIid] = useState(''), [notePage, setNotePage] = useState(1), [comment, setComment] = useState('')
  const [localTasks, setLocalTasks] = useState<GitlabOutput<'localTasks'>>({ items: [], hasMore: false }), [localPage, setLocalPage] = useState(1), [localSelection, setLocalSelection] = useState('')
  const canInteract = useInteractionGuard(), signal = useInteractionSignal(), active = useInteractionActive()
  const generation = useRef(0), memberRequest = useRef(0), authorization = useRef<string | null>(null), commands = useRef(new Map<string, string>())
  const owner = `${context.expectedRoot}:${context.connectionId}:${context.connectionRevision}`
  const currentOwner = useRef(owner); currentOwner.current = owner
  const commandFor = (key: string) => { const id = commands.current.get(key) ?? crypto.randomUUID(); commands.current.set(key, id); return id }
  const reload = useCallback(async () => {
    const ticket = generation.current, source = currentOwner.current
    try {
      const [snapshot, history] = await Promise.all([api.snapshot(context), api.jobs({ ...context, after })])
      if (ticket !== generation.current || source !== currentOwner.current || !canInteract()) return
      const data = unwrap(snapshot); setResource({ state: 'ready', data }); setJobs(unwrap(history))
      setSelected((old) => data.bindings.some((b) => b.plan.id === old) ? old : data.bindings[0]?.plan.id ?? '')
    } catch (err) { if (ticket === generation.current && source === currentOwner.current && canInteract()) { const detail = err instanceof Error ? err.message : 'GitLab 后台读取失败'; const state = err instanceof GitlabUiError && err.code === 'E_UNAVAILABLE' ? 'unavailable' : err instanceof GitlabUiError && err.code === 'E_DENIED' ? 'denied' : 'error'; setError(detail); setResource((previous) => previous.state === 'ready' ? previous : { state, detail }) } }
  }, [api, context, after, canInteract])
  useEffect(() => {
    if (!active) return
    void reload()
    const timer = setInterval(() => { if (canInteract()) void reload() }, 15000)
    const cancel = () => { generation.current++; setBusy(false); void api.cancelRead({ requestId: readGroup }).catch(() => {}); if (authorization.current) void api.cancelAuthorization({ requestId: authorization.current }).catch(() => {}); authorization.current = null }
    signal?.addEventListener('abort', cancel, { once: true })
    return () => { clearInterval(timer); signal?.removeEventListener('abort', cancel); cancel() }
  }, [active, api, signal, reload, canInteract, readGroup])
  async function perform<T>(call: () => Promise<GitlabResult<T>>, done?: (data: T) => void, commandKey?: string) {
    if (!canInteract() || busy) return
    const ticket = generation.current, source = owner
    setBusy(true); setError(null)
    try { const data = unwrap(await call()); if (commandKey) commands.current.delete(commandKey); if (ticket !== generation.current || source !== currentOwner.current || !canInteract()) return; done?.(data); await reload() }
    catch (err) { if (ticket === generation.current && source === currentOwner.current && canInteract()) setError(err instanceof Error ? err.message : '操作失败，请查看原作业记录') }
    finally { if (ticket === generation.current && source === currentOwner.current && canInteract()) setBusy(false) }
  }
  const loadMembers = useCallback((projectId: string) => {
    if (!canInteract()) return
    const ticket = generation.current, memberTicket = ++memberRequest.current
    setMemberProject(projectId); setMembers([]); setMemberPage(1); setMoreMembers(false)
    void api.members({ ...context, projectId, page: 1 }).then((result) => { if (ticket !== generation.current || memberTicket !== memberRequest.current || !canInteract()) return; const data = unwrap(result); setMembers(data.items); setMoreMembers(data.hasMore) }).catch((err: unknown) => { if (ticket === generation.current && memberTicket === memberRequest.current && canInteract()) setError(err instanceof Error ? err.message : '成员读取失败') })
  }, [api, context, canInteract])
  if (resource.state !== 'ready') return <IntegrationSection title="GitLab Issues"><IntegrationResourceState resource={resource} /><Button size="sm" onClick={() => void reload()}>重新读取后台状态</Button></IntegrationSection>
  const snapshot = resource.data, binding = snapshot.bindings.find((b) => b.plan.id === selected)
  const bound = binding ? { ...context, bindingId: binding.plan.id, bindingRevision: binding.plan.source.bindingRevision } : null
  const currentBinding = binding?.plan.source.connectionRevision === context.connectionRevision
  const disabled = busy || !active
  const action = (label: string, fn: () => void, extraDisabled = false): IntegrationSectionAction => ({ label, onClick: fn, disabled: disabled || extraDisabled })
  function runBinding(b: GitlabBinding, operation: 'catchUp' | 'recoverHook') {
    const key = `${operation}:${b.plan.id}:${b.plan.revision}`, input = { ...context, bindingId: b.plan.id, bindingRevision: b.plan.source.bindingRevision, commandId: commandFor(key) }
    void perform(() => operation === 'catchUp' ? api.catchUp(input) : api.recoverHook({ ...input, acknowledgeRegistration: true }), undefined, key)
  }
  return <>
    {error && <div role="alert" className="rounded-my-md border border-my-line p-4 text-my-sm text-my-danger-text">{error}</div>}
    <IntegrationAccountSection resource={{ state: 'ready', data: snapshot.accounts }} action={action('绑定当前 GitLab 用户', () => void perform(() => api.linkAccount(context)))} accountAction={(account) => account.state === 'linked' ? action('解除个人绑定', () => void perform(() => api.unlinkAccount({ ...context, accountId: account.id, revision: account.revision }))) : undefined} />
    <IntegrationSection title="权限与恢复" action={action('重新验证读取与范围', () => void perform(() => api.inspect({ ...context, ...(binding ? { projectId: binding.project.id } : {}) })))}>
      <p className="text-my-sm text-my-secondary">{snapshot.permission ? `${snapshot.permission.evidence} · ${new Date(snapshot.permission.checkedAt).toLocaleString()}` : '尚未验证。连接存在不代表已有写入权限。'}</p>
      <details className="space-y-3 text-my-sm"><summary className="cursor-pointer">升级浏览器写入权限</summary><p className="text-my-secondary">下一步将请求 GitLab 的 api 范围，允许代表当前账号操作 API。请先在自己的 OAuth 应用中启用 api；当前页面不会代为注册应用。成功后需重新保存项目绑定。</p><Button size="sm" disabled={disabled} onClick={() => { const requestId = crypto.randomUUID(); authorization.current = requestId; void perform(() => api.authorizeWrites({ ...context, requestId, acknowledgeApiScope: true }), () => { authorization.current = null; void refreshConnections() }) }}>明确授权 api 范围</Button>{authorization.current && <Button size="sm" onClick={() => { const requestId = authorization.current; if (requestId) void api.cancelAuthorization({ requestId }) }}>取消当前授权</Button>}</details>
      <p className="text-my-xs text-my-tertiary">PAT 连接请在上方显式替换具备 api 范围的令牌，再验证项目；原只读凭证不会被自动扩权。</p>
    </IntegrationSection>
    <IntegrationSyncSection resource={{ state: 'ready', data: snapshot.bindings.map((b) => b.plan) }} label={(plan) => snapshot.bindings.find((b) => b.plan.id === plan.id)?.project.path ?? plan.source.remoteProjectId} action={action('配置项目同步', () => { setEditor('new'); setError(null) })} planAction={(plan) => action(plan.state === 'paused' ? '启用同步' : '暂停同步', () => { const b = snapshot.bindings.find((item) => item.plan.id === plan.id); if (b) void perform(() => api.setPlanState({ ...context, bindingId: b.plan.id, bindingRevision: b.plan.source.bindingRevision, state: plan.state === 'paused' ? 'active' : 'paused' })) }, plan.source.connectionRevision !== context.connectionRevision)} />
    {editor && <IntegrationSection title={editor === 'new' ? '新建项目同步' : '编辑项目同步'}>
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setProjectPage(1); void perform(() => api.projects({ ...context, page: 1, query }), (data) => { setProjects(data.items); setMoreProjects(data.hasMore) }) }}><input aria-label="搜索 GitLab 项目" className="my-input min-w-0 flex-1" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="项目名称或路径" /><Button size="sm" onClick={(event) => event.currentTarget.form?.requestSubmit()} disabled={disabled}>读取项目</Button>{moreProjects && <Button size="sm" disabled={disabled} onClick={() => void perform(() => api.projects({ ...context, page: projectPage + 1, query }), (data) => { setProjects((old) => [...old, ...data.items]); setProjectPage((old) => old + 1); setMoreProjects(data.hasMore) })}>更多项目</Button>}</form>
      <GitlabPlanEditor key={editor === 'new' ? 'new' : editor.plan.id} initial={editor === 'new' ? undefined : editor} snapshot={snapshot} projects={projects} members={members} busy={disabled} loadMembers={loadMembers} close={() => setEditor(null)} save={(draft) => void perform(() => api.savePlan({ ...context, ...draft }), () => { setEditor(null); setPreview(null) })} />
      {moreMembers && <Button size="sm" disabled={disabled} onClick={() => void perform(() => api.members({ ...context, projectId: memberProject, page: memberPage + 1 }), (data) => { setMembers((old) => [...old, ...data.items]); setMoreMembers(data.hasMore); setMemberPage((old) => old + 1) })}>读取更多项目成员</Button>}
    </IntegrationSection>}
    {binding && bound && <IntegrationSection title="所选来源与追赶">
      <label className="block space-y-2 text-my-sm"><span>项目绑定</span><Select ariaLabel="项目绑定" className="w-full" value={selected} disabled={disabled} onChange={(value) => { setSelected(value); setPreview(null); setPreviewPage(1); setDetail(null) }} options={snapshot.bindings.map((b) => ({ value: b.plan.id, label: b.project.path }))} /></label>
      <p className="break-words text-my-xs text-my-tertiary">{binding.plan.source.instanceId} · 项目 {binding.project.id} · 绑定修订 {binding.plan.source.bindingRevision}</p>
      {!currentBinding && <p role="status" className="text-my-sm text-my-warning-text">连接修订已变更。编辑并保存此绑定以重新确认来源和权限，原任务证据会保留。</p>}
      <p className="text-my-sm text-my-secondary">上次完整追赶：{binding.lastSuccessAt ? new Date(binding.lastSuccessAt).toLocaleString() : '尚未完成'} · 下次计划：{binding.plan.state === 'paused' ? '已暂停' : new Date(binding.nextPollAt).toLocaleString()}</p>
      {binding.lastError && <p role="status" className="text-my-sm text-my-warning-text">{binding.lastError}</p>}
      <p className="text-my-sm text-my-secondary">Webhook：{binding.hook.state} · {binding.hook.detail}</p>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled} onClick={() => setEditor(binding)}>编辑绑定与映射</Button><Button size="sm" disabled={disabled || !currentBinding || binding.plan.state === 'paused'} onClick={() => runBinding(binding, 'catchUp')}>追赶变更 / 继续分页</Button>{binding.plan.transport === 'webhook' && <Button size="sm" disabled={disabled || !currentBinding || !snapshot.receiverAvailable || binding.hook.state === 'unknown'} onClick={() => runBinding(binding, 'recoverHook')}>明确注册 / 恢复 Webhook</Button>}</div>
    </IntegrationSection>}
    <IntegrationImportSection resource={{ state: 'ready', data: jobs.items.map((job) => ({ job, sourceLabel: snapshot.bindings.find((b) => b.plan.id === job.source.bindingId)?.project.path ?? job.source.remoteProjectId, destinationLabel: context.expectedRoot, detail: job.input.kind === 'import' ? 'API 分页快照导入' : '映射同步 / 追赶' })) }} action={action('预览已有 Issue', () => { if (bound) void perform(() => api.previewImport({ ...bound, page: previewPage, state: 'all' }), setPreview) }, !bound || !currentBinding)} jobActions={(job) => {
      const actions: IntegrationSectionAction[] = []
      if (['queued', 'dispatched', 'running'].includes(job.state)) actions.push(action('取消原作业', () => { const key = `cancel:${job.id}:${job.revision}`; void perform(() => api.cancelJob({ ...context, jobId: job.id, revision: job.revision, commandId: commandFor(key) }), undefined, key) }))
      if (job.state === 'unknown') actions.push(action('对账原写入', () => void perform(() => api.reconcileJob({ ...context, jobId: job.id, revision: job.revision }), (data) => { if (!data.resolved) setError('尚无充分远端证据。原结果保持未知，不会自动重发。') })))
      return actions
    }} pagination={{ hasMore: Boolean(jobs.next), previous: after ? action('返回最新记录', () => setAfter(null)) : undefined, next: jobs.next ? action('更早作业', () => setAfter(jobs.next)) : undefined }} />
    {jobs.failures.length > 0 && <IntegrationSection title="本页作业的逐项失败记录">{jobs.failures.map((failure, index) => <p key={`${failure.jobId}:${failure.issueId}:${index}`} className="text-my-sm text-my-warning-text">数字 Issue ID {failure.issueId} · {failure.detail} · {new Date(failure.at).toLocaleString()}</p>)}{jobs.hasMoreFailures && <p className="text-my-xs text-my-tertiary">还有失败记录未显示；完整证据保留在后台。</p>}</IntegrationSection>}
    {preview && bound && <IntegrationSection title={`导入预览 · 本页 ${preview.count} 项`}>
      {preview.warnings.map((warning) => <p key={warning} className="text-my-xs text-my-secondary">{warning}</p>)}
      {preview.issues.map((issue) => <div key={issue.id} className="border-t border-my-line pt-3"><p className="text-my-sm">#{issue.iid} · {issue.fields.title}</p><p className="text-my-xs text-my-tertiary">数字 ID {issue.id} · {issue.fields.state}</p></div>)}
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled || !preview.count} onClick={() => { const key = `import:${preview.id}`; void perform(() => api.startImport({ ...bound, commandId: commandFor(key), previewId: preview.id, previewDigest: preview.digest }), () => setPreview(null), key) }}>确认导入本页</Button>{preview.hasMore && <Button size="sm" disabled={disabled} onClick={() => { const page = previewPage + 1; void perform(() => api.previewImport({ ...bound, page, state: 'all' }), (data) => { setPreviewPage(page); setPreview(data) }) }}>预览下一页</Button>}</div>
      <p className="text-my-xs text-my-tertiary">取消仅停止后续处理。当前版本不自动删除已导入或已编辑的本地任务。</p>
    </IntegrationSection>}
    {bound && <IntegrationSection title="Issue 与评论">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!/^[1-9]\d*$/.test(iid)) return; setNotePage(1); void perform(() => api.issueDetail({ ...bound, iid: Number(iid), notesPage: 1 }), setDetail) }}><input className="my-input min-w-0 flex-1" aria-label="Issue IID" placeholder="项目内 Issue 编号，例如 42" inputMode="numeric" value={iid} onChange={(e) => setIid(e.target.value)} /><Button size="sm" onClick={(event) => event.currentTarget.form?.requestSubmit()} disabled={disabled || !currentBinding}>读取 Issue</Button></form>
      {detail && <><h4 className="text-my-sm font-medium">#{detail.issue.iid} · {detail.issue.fields.title}</h4><p className="whitespace-pre-wrap break-words text-my-sm text-my-secondary">{detail.issue.fields.description}</p><p className="text-my-xs text-my-tertiary">数字 Issue ID {detail.issue.id} · {detail.issue.fields.state} · {detail.issue.updatedAt}</p>{detail.notes.map((note) => <article key={note.id} className="space-y-2 border-t border-my-line pt-3"><p className="text-my-xs text-my-tertiary">用户 {note.authorId} · note {note.id}{note.system ? ' · 系统记录' : ''} · {new Date(note.createdAt).toLocaleString()}</p><p className="whitespace-pre-wrap break-words text-my-sm">{note.body}</p></article>)}{detail.hasMore && <Button size="sm" disabled={disabled} onClick={() => void perform(() => api.issueDetail({ ...bound, iid: detail.issue.iid, notesPage: notePage + 1 }), (data) => { setDetail(data); setNotePage((p) => p + 1) })}>下一页评论</Button>}
        <textarea className="my-input w-full" aria-label="新增 Issue 评论" placeholder="输入要发布到 GitLab 的评论" maxLength={10000} value={comment} disabled={disabled} onChange={(e) => setComment(e.target.value)} /><Button size="sm" disabled={disabled || !comment.trim() || binding?.plan.direction !== 'bidirectional' || snapshot.permission?.write !== 'granted'} onClick={() => { const key = `note:${detail.issue.id}:${comment}`; void perform(() => api.addComment({ ...bound, issueId: detail.issue.id, body: comment, commandId: commandFor(key), acknowledgeWrite: true }), () => setComment(''), key) }}>明确发布评论（持久作业）</Button></>}
    </IntegrationSection>}
    {bound && binding?.plan.direction === 'bidirectional' && <IntegrationSection title="从本地任务创建 GitLab Issue" description="只接受当前工作区中尚无业务来源的任务，按当前映射创建。不会创建 MR。">
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled} onClick={() => { setLocalPage(1); void perform(() => api.localTasks({ ...context, page: 1 }), setLocalTasks) }}>读取可选本地任务</Button>{localTasks.hasMore && <Button size="sm" disabled={disabled} onClick={() => void perform(() => api.localTasks({ ...context, page: localPage + 1 }), (data) => { setLocalPage((p) => p + 1); setLocalTasks(data) })}>下一页本地任务</Button>}</div>
      <Select ariaLabel="新建 Issue 的本地任务" className="w-full" value={localSelection} disabled={disabled} onChange={setLocalSelection} options={[{ value: '', label: '选择尚无业务来源的本地任务' }, ...localTasks.items.filter((task) => !task.hasSource).map((task) => ({ value: task.taskRef, label: task.title }))]} />
      <Button size="sm" disabled={disabled || !currentBinding || !localSelection || snapshot.permission?.write !== 'granted' || binding.plan.state === 'paused'} onClick={() => { const task = localTasks.items.find((v) => v.taskRef === localSelection); if (!task) return; const key = `create:${binding.plan.id}:${task.taskRef}:${task.revision}`; void perform(() => api.createIssue({ ...bound, taskRef: task.taskRef, localRevision: task.revision, commandId: commandFor(key), acknowledgeWrite: true }), () => { setLocalSelection(''); setLocalTasks({ items: [], hasMore: false }) }, key) }}>明确创建 Issue（持久作业）</Button>
    </IntegrationSection>}
    {snapshot.conflicts.length > 0 && <IntegrationSection title="字段冲突">
      {snapshot.conflicts.map((conflict) => { const b = snapshot.bindings.find((v) => v.plan.id === conflict.bindingId); return <article key={conflict.id} className="space-y-3 border-t border-my-line pt-3"><p className="text-my-sm">Issue #{conflict.issue.iid} · {conflict.field}</p><p className="break-words text-my-xs text-my-secondary">本地：{JSON.stringify(conflict.local)}<br />GitLab：{JSON.stringify(conflict.remote)}</p><div className="flex gap-2"><Button size="sm" disabled={disabled || !b} onClick={() => { if (b) void perform(() => api.resolveConflict({ ...context, bindingId: b.plan.id, bindingRevision: b.plan.source.bindingRevision, conflictId: conflict.id, resolution: 'remote' })) }}>采用远端值</Button>{b?.plan.direction === 'bidirectional' && <Button size="sm" disabled={disabled} onClick={() => void perform(() => api.resolveConflict({ ...context, bindingId: b.plan.id, bindingRevision: b.plan.source.bindingRevision, conflictId: conflict.id, resolution: 'local' }))}>采用本地值（下次追赶写回）</Button>}</div></article> })}
    </IntegrationSection>}
  </>
}
