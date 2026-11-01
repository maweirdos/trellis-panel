import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ChevronLeft, MoreHorizontal, UserRound } from 'lucide-react'
import { hasGitlabWorkspaceApi, type GitlabBinding, type GitlabInput, type GitlabOutput, type GitlabProject, type GitlabResult, type GitlabUser, type GitlabWorkspaceApi } from '@shared/gitlab-integration'
import type { IntegrationJob } from '@shared/integration-work'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../../../../../utils/interaction-scope'
import { useEscLayer } from '../../../../../utils/use-esc-layer'
import { Select } from '../../../../../components/Select'
import { confirmDialog } from '../../../../../components/Dialogs'
import { Button, Dropdown, DropdownItem, Tooltip } from '../../../../ui'
import type { ProviderWorkspaceProps } from '../../provider-workspace'
import { IntegrationJobHistory, IntegrationResourceState, IntegrationSection, type IntegrationResource, type IntegrationSectionAction } from '../../IntegrationSections'
import { IntegrationProductIcon } from '../../IntegrationProductIcon'
import { GitlabPlanEditor } from './PlanEditor'
import { GitlabDialog } from './GitlabDialog'

function nativeApi(): GitlabWorkspaceApi | null {
  const value = (window.trellis as unknown as { gitlabWorkspace?: unknown } | undefined)?.gitlabWorkspace
  return hasGitlabWorkspaceApi(value) ? value : null
}
class GitlabUiError extends Error { constructor(message: string, readonly code: string) { super(message) } }
function unwrap<T>(result: GitlabResult<T>): T { if (!result.ok) throw new GitlabUiError(result.error, result.code); return result.data }
type Snapshot = GitlabOutput<'snapshot'>
type JobPage = GitlabOutput<'jobs'>
interface ImportSubmission {
  input: GitlabInput<'startImport'>
  preview: GitlabOutput<'previewImport'>
  page: number
  projectPath: string
  state: 'pending' | 'unknown' | 'received'
  detail: string | null
  job: IntegrationJob | null
  reconciled: boolean
}
function isOriginalImport(record: ImportSubmission, job: IntegrationJob): boolean {
  return job.commandId === record.input.commandId && job.input.kind === 'import'
    && job.input.previewId === record.input.previewId && job.input.previewDigest === record.input.previewDigest
    && job.source.connectionId === record.input.connectionId && job.source.connectionRevision === record.input.connectionRevision
    && job.source.bindingId === record.input.bindingId && job.source.bindingRevision === record.input.bindingRevision
    && job.source.instanceId === record.preview.source.instanceId && job.source.remoteProjectId === record.preview.source.remoteProjectId
}
type Panel = 'permissions' | 'binding' | 'import' | 'history' | 'job' | 'issue' | 'create' | 'conflicts'
const planStates = { unverified: '尚未验证', active: '同步中', paused: '已暂停', degraded: '需要处理', blocked: '已阻止' }
const accountStates = { unverified: '尚未验证', linked: '已绑定', revoked: '授权已撤销', unavailable: '暂不可用' }

/** The parent owns the one instance row for both GitLab Issues entries. */
export function GitlabSetupSection(_props: ProviderWorkspaceProps): null { return null }
export function GitlabWorkspaceContent(props: ProviderWorkspaceProps): JSX.Element {
  const api = nativeApi()
  const syncHeading = useId()
  const setupReason = props.root ? '先绑定实例' : '请先打开项目'
  if (!props.nativeAvailable || !api) return <IntegrationSection title="GitLab Issues"><IntegrationResourceState resource={{ state: 'unavailable', detail: '当前原生版本不支持 GitLab Issues，请完整重启或更新应用。' }} /></IntegrationSection>
  if (!props.root || !props.connection) return <>
    <IntegrationSection title="个人账号"><p className="my-item-description">连接实例后可绑定当前 GitLab 用户。</p></IntegrationSection>
    <section aria-labelledby={syncHeading} className="integration-section rounded-my-lg border border-my-line bg-my-surface-1">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <h3 id={syncHeading} className="min-w-0 flex-1 text-my-sm font-medium">项目同步</h3>
        <Tooltip label={setupReason}><span role="group" tabIndex={0} aria-label={`新建同步：${setupReason}`}><Button size="sm" disabled>新建同步</Button></span></Tooltip>
      </div>
      <div className="px-5 pb-4"><p className="my-item-description">{props.root ? '尚未创建项目同步。' : '请先打开本地项目。'}</p></div>
    </section>
    <IntegrationSection title="导入 Issue 数据"><p className="my-item-description">创建项目同步后，可预览并导入已有 Issue。</p></IntegrationSection>
  </>
  return <GitlabWorkspace key={`${props.root}:${props.connection.id}:${props.connection.revision}`} {...props} api={api} context={{ expectedRoot: props.root, connectionId: props.connection.id, connectionRevision: props.connection.revision }} />
}
function GitlabWorkspace({ api, context: ownerContext, refresh: refreshConnections, connection, authorizationAvailable, onEditConnection, onFlowChange }: ProviderWorkspaceProps & { api: GitlabWorkspaceApi; context: GitlabInput<'snapshot'> }): JSX.Element {
  const [readGroup] = useState(() => crypto.randomUUID())
  const context = useMemo(() => ({ expectedRoot: ownerContext.expectedRoot, connectionId: ownerContext.connectionId, connectionRevision: ownerContext.connectionRevision, requestId: readGroup }), [ownerContext.expectedRoot, ownerContext.connectionId, ownerContext.connectionRevision, readGroup])
  const [resource, setResource] = useState<IntegrationResource<Snapshot>>({ state: 'loading' })
  const [jobs, setJobs] = useState<JobPage>({ items: [], next: null, failures: [], hasMoreFailures: false })
  const [after, setAfter] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [projects, setProjects] = useState<GitlabProject[]>([]), [projectPage, setProjectPage] = useState(1), [moreProjects, setMoreProjects] = useState(false), [query, setQuery] = useState(''), [projectQuery, setProjectQuery] = useState(''), [searched, setSearched] = useState(false)
  const [members, setMembers] = useState<GitlabUser[]>([]), [memberProject, setMemberProject] = useState(''), [memberPage, setMemberPage] = useState(1), [moreMembers, setMoreMembers] = useState(false), [membersBusy, setMembersBusy] = useState(false), [membersError, setMembersError] = useState<string | null>(null)
  const [editor, setEditor] = useState<GitlabBinding | 'new' | null>(null), [selected, setSelected] = useState('')
  const [panel, setPanel] = useState<Panel | null>(null), [selectedJob, setSelectedJob] = useState<IntegrationJob | null>(null)
  const [preview, setPreview] = useState<GitlabOutput<'previewImport'> | null>(null), [previewPage, setPreviewPage] = useState(1)
  // The mounted workspace owns submission evidence; a dialog is only its view.
  const [importSubmission, setImportSubmission] = useState<ImportSubmission | null>(null)
  const importSubmissionRef = useRef<ImportSubmission | null>(null)
  const retainImport = useCallback((record: ImportSubmission | null) => { importSubmissionRef.current = record; setImportSubmission(record) }, [])
  const [detail, setDetail] = useState<GitlabOutput<'issueDetail'> | null>(null), [iid, setIid] = useState(''), [notePage, setNotePage] = useState(1), [comment, setComment] = useState('')
  const [localTasks, setLocalTasks] = useState<GitlabOutput<'localTasks'>>({ items: [], hasMore: false }), [localPage, setLocalPage] = useState(1), [localSelection, setLocalSelection] = useState('')
  const [authorizing, setAuthorizing] = useState(false)
  const [closingEditor, setClosingEditor] = useState(false)
  const canInteract = useInteractionGuard(), signal = useInteractionSignal(), active = useInteractionActive()
  const generation = useRef(0), memberRequest = useRef(0), viewRevision = useRef(0), authorization = useRef<string | null>(null), commands = useRef(new Map<string, string>()), running = useRef(false), memberPending = useRef(false)
  const editorDirty = useRef(false)
  const editorSession = useRef(0)
  const closePending = useRef(false)
  const dirtyChange = useCallback((dirty: boolean) => { editorDirty.current = dirty }, [])
  const owner = `${context.expectedRoot}:${context.connectionId}:${context.connectionRevision}`
  const currentOwner = useRef(owner); currentOwner.current = owner
  const commandFor = (key: string) => { const id = commands.current.get(key) ?? crypto.randomUUID(); commands.current.set(key, id); return id }
  const observeImportJobs = useCallback((items: IntegrationJob[]) => {
    const retained = importSubmissionRef.current
    if (!retained) return
    const job = items.find((item) => isOriginalImport(retained, item))
    if (!job) return
    if (retained.job && job.revision < retained.job.revision) return
    retainImport({ ...retained, job, state: job.state === 'unknown' && !retained.reconciled ? 'unknown' : 'received' })
    if (job.state !== 'unknown' || retained.reconciled) commands.current.delete(`import:${retained.preview.id}`)
  }, [retainImport])
  const reload = useCallback(async () => {
    const ticket = generation.current, source = currentOwner.current
    try {
      const [snapshot, history] = await Promise.all([api.snapshot(context), api.jobs({ ...context, after })])
      if (ticket !== generation.current || source !== currentOwner.current || !canInteract()) return
      const data = unwrap(snapshot), page = unwrap(history)
      setResource({ state: 'ready', data }); setJobs(page); observeImportJobs(page.items)
    } catch (err) { if (ticket === generation.current && source === currentOwner.current && canInteract()) { const detail = err instanceof Error ? err.message : 'GitLab 后台读取失败'; const state = err instanceof GitlabUiError && err.code === 'E_UNAVAILABLE' ? 'unavailable' : err instanceof GitlabUiError && err.code === 'E_DENIED' ? 'denied' : 'error'; setError(detail); setResource((previous) => previous.state === 'ready' ? previous : { state, detail }) } }
  }, [api, context, after, canInteract, observeImportJobs])
  useEffect(() => {
    if (!active) return
    void reload()
    const timer = setInterval(() => { if (canInteract()) void reload() }, 15000)
    const cancel = () => { generation.current++; memberRequest.current++; viewRevision.current++; running.current = false; memberPending.current = false; setBusy(false); setMembersBusy(false); const retained = importSubmissionRef.current; if (retained?.state === 'pending') retainImport({ ...retained, state: 'unknown', detail: '导入响应尚未确认，请查询原作业。' }); void api.cancelRead({ requestId: readGroup }).catch(() => {}); if (authorization.current) void api.cancelAuthorization({ requestId: authorization.current }).catch(() => {}); authorization.current = null; setAuthorizing(false) }
    signal?.addEventListener('abort', cancel, { once: true })
    return () => { clearInterval(timer); signal?.removeEventListener('abort', cancel); cancel() }
  }, [active, api, signal, reload, canInteract, readGroup, retainImport])
  const fullSetup = editor === 'new'
  // Re-arm after a cancelled discard prompt, including when Modal consumed its own Escape layer.
  useEscLayer(Boolean(editor) && !busy && !closingEditor, { kind: fullSetup ? 'preview' : 'modal', id: `gitlab-editor-${readGroup}`, onClose: () => void requestCloseEditor(), deferWhenInputFocused: fullSetup })
  useEffect(() => { onFlowChange?.(fullSetup && active); return () => onFlowChange?.(false) }, [fullSetup, active, onFlowChange])
  useLayoutEffect(() => { if (!active) { editorSession.current++; setPanel(null); setEditor(null); editorDirty.current = false } }, [active])
  useLayoutEffect(() => () => { editorSession.current++ }, [])
  async function perform<T>(call: () => Promise<GitlabResult<T>>, done?: (data: T) => void, commandKey?: string, acceptOwnedResult?: (data: T) => void) {
    if (!canInteract() || running.current) return
    const ticket = generation.current, source = owner, view = viewRevision.current
    running.current = true; setBusy(true); setError(null)
    try { const data = unwrap(await call()); if (commandKey) commands.current.delete(commandKey); if (ticket !== generation.current || source !== currentOwner.current || !canInteract()) return; acceptOwnedResult?.(data); if (view === viewRevision.current) done?.(data); await reload() }
    catch (err) { if (ticket === generation.current && source === currentOwner.current && canInteract()) setError(err instanceof Error ? err.message : '操作失败，请查看原作业记录') }
    finally { if (ticket === generation.current && source === currentOwner.current && canInteract()) { running.current = false; setBusy(false) } }
  }
  const loadMembers = useCallback((projectId: string) => {
    if (!canInteract()) return
    const ticket = generation.current, memberTicket = ++memberRequest.current, source = currentOwner.current
    memberPending.current = true
    setMemberProject(projectId); setMembers([]); setMemberPage(1); setMoreMembers(false); setMembersBusy(true); setMembersError(null)
    void api.members({ ...context, projectId, page: 1 }).then((result) => { if (ticket !== generation.current || memberTicket !== memberRequest.current || source !== currentOwner.current || !canInteract()) return; const data = unwrap(result); setMembers(data.items); setMoreMembers(data.hasMore) }).catch((err: unknown) => { if (ticket === generation.current && memberTicket === memberRequest.current && source === currentOwner.current && canInteract()) setMembersError(err instanceof Error ? err.message : '成员读取失败') }).finally(() => { if (ticket === generation.current && memberTicket === memberRequest.current && source === currentOwner.current && canInteract()) { memberPending.current = false; setMembersBusy(false) } })
  }, [api, context, canInteract])
  function loadMoreMembers(): void {
    if (memberPending.current || !memberProject || !canInteract()) return
    const ticket = generation.current, memberTicket = memberRequest.current, source = currentOwner.current, projectId = memberProject, page = memberPage + 1
    memberPending.current = true; setMembersBusy(true); setMembersError(null)
    void api.members({ ...context, projectId, page }).then((result) => { if (ticket !== generation.current || memberTicket !== memberRequest.current || source !== currentOwner.current || !canInteract()) return; const data = unwrap(result); setMembers((old) => [...old, ...data.items]); setMoreMembers(data.hasMore); setMemberPage(page) }).catch((err: unknown) => { if (ticket === generation.current && memberTicket === memberRequest.current && source === currentOwner.current && canInteract()) setMembersError(err instanceof Error ? err.message : '成员读取失败') }).finally(() => { if (ticket === generation.current && memberTicket === memberRequest.current && source === currentOwner.current && canInteract()) { memberPending.current = false; setMembersBusy(false) } })
  }
  function closePanel(): void { viewRevision.current++; setPanel(null) }
  function openPanel(next: Panel, b?: GitlabBinding): void {
    if (!canInteract()) return
    viewRevision.current++; setError(null); setPanel(next)
    const retained = next === 'import' ? importSubmissionRef.current : null
    if (retained) { setSelected(retained.input.bindingId); setPreview(retained.preview); setPreviewPage(retained.page) }
    else { if (b) setSelected(b.plan.id); if (next === 'import') { setPreview(null); setPreviewPage(1) } }
    if (next === 'issue') { setDetail(null); setIid(''); setComment(''); setNotePage(1) }
    if (next === 'create') { setLocalTasks({ items: [], hasMore: false }); setLocalSelection(''); setLocalPage(1) }
  }
  function openEditor(value: GitlabBinding | 'new'): void {
    if (!canInteract() || running.current) return
    viewRevision.current++; memberRequest.current++; editorSession.current++; editorDirty.current = false; memberPending.current = false; closePending.current = false; setClosingEditor(false); setEditor(value); setPanel(null); setError(null); setProjects([]); setQuery(''); setProjectQuery(''); setSearched(false); setProjectPage(1); setMoreProjects(false); setMembers([]); setMoreMembers(false); setMembersBusy(false); setMembersError(null)
  }
  function closeEditor(): void { viewRevision.current++; memberRequest.current++; editorSession.current++; editorDirty.current = false; memberPending.current = false; setEditor(null); setMembersBusy(false) }
  async function requestCloseEditor(): Promise<void> {
    if (running.current || closePending.current || !canInteract()) return
    const session = editorSession.current, source = currentOwner.current, interaction = signal
    closePending.current = true; setClosingEditor(true)
    try {
      const confirmed = !editorDirty.current || await confirmDialog({ title: '放弃本次配置？', message: '尚未保存的修改将被丢弃。', confirmText: '放弃修改' }, signal)
      // A read refresh or closing the confirmation does not replace this editor.
      if (confirmed && canInteract() && !interaction?.aborted && session === editorSession.current && source === currentOwner.current) closeEditor()
    } finally { closePending.current = false; if (canInteract()) setClosingEditor(false) }
  }
  if (resource.state !== 'ready') return <IntegrationSection title="GitLab Issues"><IntegrationResourceState resource={resource} /><Button size="sm" onClick={() => void reload()}>重试</Button></IntegrationSection>
  const snapshot = resource.data, binding = snapshot.bindings.find((b) => b.plan.id === selected)
  const bound = binding ? { ...context, bindingId: binding.plan.id, bindingRevision: binding.plan.source.bindingRevision } : null
  const currentBinding = binding?.plan.source.connectionRevision === context.connectionRevision
  const previewCurrent = Boolean(preview && bound && currentBinding && preview.source.bindingId === bound.bindingId && preview.bindingRevision === bound.bindingRevision && preview.source.connectionRevision === context.connectionRevision)
  const disabled = busy || closingEditor || !active
  const action = (label: string, fn: () => void, extraDisabled = false): IntegrationSectionAction => ({ label, onClick: fn, disabled: disabled || extraDisabled })
  function runBinding(b: GitlabBinding, operation: 'catchUp' | 'recoverHook') {
    const key = `${operation}:${b.plan.id}:${b.plan.revision}`, input = { ...context, bindingId: b.plan.id, bindingRevision: b.plan.source.bindingRevision, commandId: commandFor(key) }
    void perform(() => operation === 'catchUp' ? api.catchUp(input) : api.recoverHook({ ...input, acknowledgeRegistration: true }), (job) => { setNotice('操作已提交，可在历史记录中查看进度。'); setSelectedJob(job) }, key)
  }
  async function submitImport(): Promise<void> {
    const existingSubmission = importSubmissionRef.current
    if (!preview || !bound || !binding || !previewCurrent || existingSubmission || running.current || !canInteract()) return
    const key = `import:${preview.id}`, ticket = generation.current, source = owner, view = viewRevision.current
    const retained: ImportSubmission = {
      input: { ...bound, commandId: commandFor(key), previewId: preview.id, previewDigest: preview.digest },
      preview, page: previewPage, projectPath: binding.project.path, state: 'pending', detail: null, job: null, reconciled: false
    }
    // Publish the frozen command/preview/target before dispatch, independently of the modal's lifetime.
    retainImport(retained); running.current = true; setBusy(true); setError(null)
    const current = () => ticket === generation.current && source === currentOwner.current && canInteract()
    try {
      const accepted = unwrap(await api.startImport(retained.input))
      if (!current()) return
      if (!isOriginalImport(retained, accepted)) throw new Error('返回作业与原导入身份不一致，请保留原命令并核实。')
      observeImportJobs([accepted])
      if (view === viewRevision.current) { setPreview(null); setSelectedJob(accepted); setPanel('job'); setNotice('已提交本页导入。') }
    } catch (err) {
      if (!current()) return
      const original = importSubmissionRef.current
      const detail = err instanceof Error ? err.message : '导入响应尚未确认，请查询原作业。'
      if (original?.input.commandId === retained.input.commandId) retainImport({ ...original, state: original.reconciled || (original.job && original.job.state !== 'unknown') ? 'received' : 'unknown', detail })
      if (view === viewRevision.current) setError(detail)
    } finally { if (current()) { running.current = false; setBusy(false) } }
    if (current()) await reload()
  }
  function refreshImport(): void {
    const original = importSubmissionRef.current
    if (!original) return
    void perform(() => api.jobs({ expectedRoot: original.input.expectedRoot, connectionId: original.input.connectionId, connectionRevision: original.input.connectionRevision, requestId: readGroup, after: null }), (page) => {
      if (!page.items.some((item) => isOriginalImport(original, item)) && original.state !== 'received') setNotice('最新返回页尚未找到原作业，可在历史记录中继续查找；原结果仍待核实。')
    }, undefined, (page) => observeImportJobs(page.items))
  }
  function continueImport(): void {
    const original = importSubmissionRef.current
    if (!original || original.state !== 'received' || !original.job || running.current || !canInteract()) return
    // Only a matching native job or explicit reconciliation releases this admission record.
    commands.current.delete(`import:${original.preview.id}`)
    retainImport(null); setPreview(null); setPreviewPage(1); setError(null)
  }
  function jobActions(job: IntegrationJob): IntegrationSectionAction[] {
    const actions: IntegrationSectionAction[] = []
    if (['queued', 'dispatched', 'running'].includes(job.state)) actions.push(action('取消作业', () => { const key = `cancel:${job.id}:${job.revision}`; void perform(() => api.cancelJob({ ...context, jobId: job.id, revision: job.revision, commandId: commandFor(key) }), setSelectedJob, key, (result) => observeImportJobs([result])) }))
    if (job.state === 'unknown') actions.push(action('核实原写入', () => void perform(() => api.reconcileJob({ ...context, jobId: job.id, revision: job.revision }), (data) => { if (!data.resolved) setError('尚无充分远端证据。原结果保持未知，不会自动重发。'); else setNotice('已找到原写入的对账证据。') }, undefined, (data) => {
      const original = importSubmissionRef.current
      if (data.resolved && original && isOriginalImport(original, job)) retainImport({ ...original, job, reconciled: true, state: 'received' })
    })))
    return actions
  }
  const historyRows = (items: IntegrationJob[]) => items.map((job) => ({ job, sourceLabel: snapshot.bindings.find((b) => b.plan.id === job.source.bindingId)?.project.path ?? `GitLab 项目 ${job.source.remoteProjectId}`, destinationLabel: '当前项目', detail: job.input.kind === 'import' ? 'Issue 导入' : '同步 / GitLab 操作' }))
  const job = jobs.items.find((item) => item.id === selectedJob?.id) ?? selectedJob
  const importBindings = snapshot.bindings.filter((b) => b.plan.source.connectionRevision === context.connectionRevision)
  const importRecovery = importSubmission && <div className="space-y-4">
    <p role="status" className="text-my-sm font-medium">{importSubmission.state === 'pending' ? '正在提交原导入' : importSubmission.state === 'unknown' ? '原导入结果待核实' : '已找到原导入作业'}</p>
    <p className="break-words text-my-sm text-my-secondary">{importSubmission.projectPath} → 当前项目 · 第 {importSubmission.page} 页 · {importSubmission.preview.count} 项</p>
    {importSubmission.state === 'unknown' && <p className="text-my-sm text-my-warning-text">请先核实原作业。查询和关闭此窗口都不会重新提交导入。</p>}
    {importSubmission.job && <IntegrationJobHistory resource={{ state: 'ready', data: historyRows([importSubmission.job]) }} jobActions={jobActions} />}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={disabled} onClick={refreshImport}>查询原作业</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => openPanel('history')}>查看历史记录</Button>
      {importSubmission.job && <Button size="sm" disabled={disabled} onClick={() => { setSelectedJob(importSubmission.job); openPanel('job') }}>原作业详情</Button>}
      {importSubmission.state === 'received' && <Button size="sm" disabled={disabled} onClick={continueImport}>继续选择导入</Button>}
    </div>
    <details className="space-y-2 break-words text-my-xs text-my-tertiary"><summary className="cursor-pointer">原提交与预览</summary>
      {importSubmission.detail && <p>{importSubmission.detail}</p>}
      <p>原命令：{importSubmission.input.commandId}<br />预览：{importSubmission.input.previewId}<br />摘要：{importSubmission.input.previewDigest}<br />实例：{importSubmission.preview.source.instanceId}<br />项目：{importSubmission.preview.source.remoteProjectId}<br />绑定修订：{importSubmission.input.bindingRevision}<br />目标：{importSubmission.input.expectedRoot}</p>
      {importSubmission.preview.issues.map((issue) => <p key={issue.id}>#{issue.iid} · {issue.fields.title}</p>)}
    </details>
  </div>
  const editorContent = editor && <GitlabPlanEditor key={editor === 'new' ? 'new' : `${editor.plan.id}:${editor.plan.source.bindingRevision}`} initial={editor === 'new' ? undefined : editor} snapshot={snapshot} projects={projects} members={members} busy={disabled} query={query} setQuery={setQuery} searched={searched} moreProjects={moreProjects} search={() => { const searchQuery = query; void perform(() => api.projects({ ...context, page: 1, query: searchQuery }), (data) => { setProjects(data.items); setProjectPage(1); setProjectQuery(searchQuery); setMoreProjects(data.hasMore); setSearched(true) }) }} loadMoreProjects={() => void perform(() => api.projects({ ...context, page: projectPage + 1, query: projectQuery }), (data) => { setProjects((old) => [...old, ...data.items]); setProjectPage((old) => old + 1); setMoreProjects(data.hasMore) })} moreMembers={moreMembers} loadMoreMembers={loadMoreMembers} membersBusy={membersBusy} membersError={membersError} loadMembers={loadMembers} dirtyChange={dirtyChange} close={() => void requestCloseEditor()} save={(draft) => void perform(() => api.savePlan({ ...context, ...draft }), () => { closeEditor(); setPreview(null); setNotice('同步配置已保存，当前处于暂停状态。') })} />
  if (fullSetup) return <div className="integration-setup-column space-y-6" data-gitlab-setup="new">
    <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void requestCloseEditor()}><ChevronLeft size={15} />返回 GitLab Issues</Button>
    <div className="flex items-center gap-3"><IntegrationProductIcon provider="gitlab" /><h2 className="text-my-xl font-semibold">新建项目同步</h2></div>
    {busy && <p role="status" className="text-my-sm text-my-secondary">正在处理…</p>}{error && <p role="alert" className="text-my-sm text-my-danger-text">{error}</p>}
    {editorContent}
  </div>
  return <>
    {!panel && !editor && error && <p role="alert" className="rounded-my-md border border-my-line p-3 text-my-sm text-my-danger-text">{error}</p>}
    {notice && <div role="status" className="flex items-center justify-between gap-3 text-my-sm text-my-secondary"><span>{notice}</span><Button size="sm" variant="ghost" onClick={() => setNotice(null)}>关闭</Button></div>}
    {busy && !panel && !editor && <p role="status" className="text-my-xs text-my-secondary">正在处理…</p>}
    <section aria-label="个人账号" className="integration-account-row">
      <h3 className="text-my-sm font-medium">个人账号</h3><div className="min-w-0 flex-1">
      {snapshot.accounts.length === 0 ? <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><UserRound size={18} className="text-my-tertiary" /><p className="text-my-sm text-my-secondary">未绑定 GitLab 用户</p></div><Button size="sm" disabled={disabled} onClick={() => void perform(() => api.linkAccount(context))}>绑定当前用户</Button></div> : snapshot.accounts.map((account) => <div key={account.id} className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><UserRound size={18} className="text-my-tertiary" /><div><p className="my-item-title">{account.displayName || account.remoteUserId}</p><p className="text-my-xs text-my-tertiary">{accountStates[account.state]}</p></div></div><Dropdown align="right" trigger={({ open, toggle }) => <Button size="sm" variant="ghost" aria-expanded={open} aria-label="个人账号操作" disabled={disabled} onClick={toggle}><MoreHorizontal size={16} /></Button>}>{(close) => <><DropdownItem onClick={() => { close(); onEditConnection() }}>更换连接凭证</DropdownItem>{account.state === 'linked' ? <DropdownItem onClick={() => { close(); void perform(() => api.unlinkAccount({ ...context, accountId: account.id, revision: account.revision })) }}>解除个人绑定</DropdownItem> : <DropdownItem onClick={() => { close(); void perform(() => api.linkAccount(context)) }}>重新绑定当前用户</DropdownItem>}</>}</Dropdown></div>)}
      </div>
    </section>
    <IntegrationSection title="项目同步" action={action('新建同步', () => openEditor('new'))}>
      {snapshot.bindings.length === 0 && <p className="my-item-description py-2">尚未创建项目同步。</p>}
      {snapshot.bindings.map((b) => {
        const current = b.plan.source.connectionRevision === context.connectionRevision
        return <div key={b.plan.id} className="flex flex-wrap items-center gap-3 border-b border-my-line py-3 last:border-0">
          <button type="button" className="min-w-0 flex-1 rounded-my-md text-left hover:bg-my-layer-2" disabled={disabled} onClick={() => openEditor(b)}><p className="my-item-title break-words">{b.project.path} <span className="my-item-description">{b.plan.direction === 'bidirectional' ? '↔' : '→'} 当前项目</span></p><p className="mt-1 text-my-xs text-my-tertiary">{planStates[b.plan.state]} · {b.plan.direction === 'inbound' ? '单向同步' : '双向同步'} · {b.lastSuccessAt ? new Date(b.lastSuccessAt).toLocaleString() : '尚未完成同步'}</p>{!current && <p className="mt-1 text-my-xs text-my-warning-text">连接已更新，请编辑同步以确认来源。</p>}{b.lastError && <p className="mt-1 text-my-xs text-my-warning-text">{b.lastError}</p>}</button>
          <Dropdown align="right" trigger={({ open, toggle }) => <Button size="sm" variant="ghost" aria-expanded={open} aria-label={`${b.project.path} 同步操作`} disabled={disabled} onClick={toggle}><MoreHorizontal size={16} /></Button>}>{(close) => <>
            <DropdownItem onClick={() => { close(); openEditor(b) }}>编辑同步</DropdownItem>
            <DropdownItem disabled={!current} onClick={() => { close(); void perform(() => api.setPlanState({ ...context, bindingId: b.plan.id, bindingRevision: b.plan.source.bindingRevision, state: b.plan.state === 'paused' ? 'active' : 'paused' })) }}>{b.plan.state === 'paused' ? '启用同步' : '暂停同步'}</DropdownItem>
            <DropdownItem disabled={!current || b.plan.state === 'paused'} onClick={() => { close(); runBinding(b, 'catchUp') }}>立即同步 / 继续分页</DropdownItem>
            <DropdownItem disabled={!current} onClick={() => { close(); openPanel('import', b) }}>导入已有 Issue</DropdownItem>
            <DropdownItem disabled={!current} onClick={() => { close(); openPanel('issue', b) }}>Issue 与评论</DropdownItem>
            {b.plan.direction === 'bidirectional' && <DropdownItem disabled={!current} onClick={() => { close(); openPanel('create', b) }}>从本地任务创建 Issue</DropdownItem>}
            <DropdownItem onClick={() => { close(); openPanel('binding', b) }}>同步详情与恢复</DropdownItem>
          </>}</Dropdown>
        </div>
      })}
      <div className="flex flex-wrap items-center justify-end gap-2"><Button size="sm" variant="ghost" disabled={disabled} onClick={() => openPanel('permissions')}>权限与连接恢复</Button>{snapshot.conflicts.length > 0 && <Button size="sm" disabled={disabled} onClick={() => openPanel('conflicts')}>处理冲突 · {snapshot.conflicts.length}</Button>}</div>
    </IntegrationSection>
    <IntegrationSection title="导入 Issue 数据" action={action(importSubmission ? '查看原导入' : '导入数据', () => openPanel('import', importBindings[0]), !importBindings.length && !importSubmission)}>
      <p className="my-item-description">{snapshot.bindings.length ? '预览已有 Issue，确认后导入当前项目。' : '请先创建项目同步，再选择要导入的 Issue。'}</p>
      {importSubmission && <p role="status" className="text-my-sm text-my-secondary">{importSubmission.projectPath} · {importSubmission.state === 'pending' ? '正在提交原导入' : importSubmission.state === 'unknown' ? '原导入结果待核实' : '已找到原导入作业'}</p>}
      {jobs.items.length > 0 && <IntegrationJobHistory resource={{ state: 'ready', data: historyRows(jobs.items.slice(0, 3)) }} jobActions={(job) => [action('查看详情', () => { setSelectedJob(job); openPanel('job') })]} />}
      {!jobs.items.length && <p className="text-my-xs text-my-tertiary">{after ? '本页没有作业记录。' : '暂无导入或同步记录。'}</p>}
      {(jobs.items.length > 0 || after) && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => openPanel('history')}>查看全部记录</Button>}
    </IntegrationSection>
    {editor && <GitlabDialog title="编辑项目同步" subtitle={editor.project.path} busy={busy} error={error} close={() => void requestCloseEditor()} drawer>{editorContent}</GitlabDialog>}
    {panel === 'permissions' && <GitlabDialog title="权限与连接恢复" busy={busy} error={error} close={closePanel}>
      <p className="text-my-sm text-my-secondary">{snapshot.permission?.evidence ?? '尚未验证连接权限。'}</p>
      {snapshot.permission && <dl className="grid grid-cols-2 gap-2 text-my-sm"><dt>读取</dt><dd>{snapshot.permission.read}</dd><dt>写入</dt><dd>{snapshot.permission.write}</dd><dt>Webhook</dt><dd>{snapshot.permission.hooks}</dd></dl>}
      <Button size="sm" disabled={disabled} onClick={() => void perform(() => api.inspect({ ...context, ...(binding ? { projectId: binding.project.id } : {}) }))}>重新验证权限</Button>
      <div className="space-y-3 border-t border-my-line pt-4">
        <h4 className="text-my-sm font-medium">写入授权</h4>
        {connection?.config.authMethod === 'oauth2' ? <>
          <p className="text-my-sm text-my-warning-text">将向 GitLab 请求 api 范围，允许代表当前账号写入 API 及注册 Webhook。请先在自己的 OAuth 应用中启用 api。授权后需重新保存项目同步。</p>
          <Button size="sm" disabled={disabled || !authorizationAvailable} onClick={() => {
            if (running.current || !canInteract()) return
            const requestId = crypto.randomUUID(); authorization.current = requestId; setAuthorizing(true)
            void perform(() => api.authorizeWrites({ ...context, requestId, acknowledgeApiScope: true }), () => { void refreshConnections() }).finally(() => {
              if (authorization.current === requestId) { authorization.current = null; if (canInteract()) setAuthorizing(false) }
            })
          }}>授权 api 范围</Button>
          {!authorizationAvailable && <p className="text-my-xs text-my-warning-text">当前原生版本未提供浏览器授权。</p>}
        </> : <p className="text-my-sm text-my-secondary">请手动替换具备 api 范围的 PAT，再重新验证权限。</p>}
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => { closePanel(); onEditConnection() }}>更新连接凭证</Button>
        {authorizing && <div role="status" className="flex flex-wrap items-center gap-3 text-my-sm"><span>等待浏览器完成授权</span><Button size="sm" onClick={() => { const requestId = authorization.current; if (requestId) void api.cancelAuthorization({ requestId }).catch(() => {}) }}>取消授权</Button></div>}
      </div>
      <details className="space-y-2 text-my-xs text-my-tertiary"><summary className="cursor-pointer">验证详情</summary><p>{snapshot.permission?.scopes.join('、') || '未返回授权范围'}</p>{snapshot.permission && <p>{new Date(snapshot.permission.checkedAt).toLocaleString()}</p>}</details>
    </GitlabDialog>}
    {authorizing && panel !== 'permissions' && <div role="status" className="flex items-center justify-between gap-3 rounded-my-md border border-my-line p-3 text-my-sm"><span>等待浏览器完成授权</span><Button size="sm" onClick={() => { const requestId = authorization.current; if (requestId) void api.cancelAuthorization({ requestId }).catch(() => {}) }}>取消授权</Button></div>}
    {panel === 'binding' && binding && <GitlabDialog title="同步详情" subtitle={binding.project.path} busy={busy} error={error} close={closePanel}>
      <p className="text-my-sm">{planStates[binding.plan.state]} · {binding.plan.direction === 'inbound' ? 'GitLab → 当前项目' : '双向同步'}</p>
      {!currentBinding && <p role="status" className="text-my-sm text-my-warning-text">连接已更新。请编辑并保存同步以重新确认来源和权限。</p>}
      <p className="text-my-sm text-my-secondary">上次完整同步：{binding.lastSuccessAt ? new Date(binding.lastSuccessAt).toLocaleString() : '尚未完成'}<br />下次同步：{binding.plan.state === 'paused' ? '已暂停' : new Date(binding.nextPollAt).toLocaleString()}</p>
      {binding.lastError && <p className="text-my-sm text-my-warning-text">{binding.lastError}</p>}
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled} onClick={() => openEditor(binding)}>编辑同步</Button><Button size="sm" disabled={disabled || !currentBinding || binding.plan.state === 'paused'} onClick={() => runBinding(binding, 'catchUp')}>立即同步 / 继续分页</Button><Button size="sm" disabled={disabled || !currentBinding} onClick={() => openPanel('import', binding)}>导入已有 Issue</Button></div>
      <div className="space-y-3 border-t border-my-line pt-4">
        <h4 className="text-my-sm font-medium">Webhook</h4>
        <p className="text-my-sm text-my-secondary">{binding.hook.state} · {binding.hook.detail}</p>
        {binding.plan.transport === 'webhook' && <>
          <p className="text-my-xs text-my-tertiary">此操作会在 GitLab 项目中注册或恢复 Webhook。</p>
          <Button size="sm" disabled={disabled || !currentBinding || !snapshot.receiverAvailable || binding.hook.state === 'unknown'} onClick={() => runBinding(binding, 'recoverHook')}>确认注册 / 恢复 Webhook</Button>
          {!snapshot.receiverAvailable && <p role="status" className="text-my-xs text-my-warning-text">接收端不可用，可编辑为定时同步。</p>}
        </>}
      </div>
      <details className="space-y-2 break-words text-my-xs text-my-tertiary"><summary className="cursor-pointer">来源与版本详情</summary><p>实例：{binding.plan.source.instanceId}<br />项目：{binding.project.id}<br />绑定修订：{binding.plan.source.bindingRevision}<br />连接修订：{binding.plan.source.connectionRevision}<br />目标：{context.expectedRoot}</p></details>
    </GitlabDialog>}
    {panel === 'import' && <GitlabDialog title="导入已有 Issue" subtitle={importSubmission?.projectPath ?? binding?.project.path} busy={busy} error={error} close={closePanel}>
      {importSubmission ? importRecovery : <>
        <label className="block space-y-2"><span className="my-item-title">来源项目</span><Select ariaLabel="导入来源项目" className="w-full" value={selected} disabled={disabled} onChange={(value) => { viewRevision.current++; setSelected(value); setPreview(null); setPreviewPage(1) }} options={[{ value: '', label: '选择项目同步' }, ...importBindings.map((b) => ({ value: b.plan.id, label: b.project.path }))]} /></label>
        <Button size="sm" disabled={disabled || !bound || !currentBinding} onClick={() => { if (bound) void perform(() => api.previewImport({ ...bound, page: previewPage, state: 'all' }), setPreview) }}>预览 Issue</Button>
        {preview && !previewCurrent && <p role="status" className="text-my-sm text-my-warning-text">同步配置已变更，请重新预览后再导入。</p>}
        {preview && bound && <>
          <p className="text-my-sm font-medium">第 {previewPage} 页 · {preview.count} 项</p>
          {preview.warnings.map((warning) => <p key={warning} className="text-my-xs text-my-secondary">{warning}</p>)}
          <div className="space-y-3">{preview.issues.map((issue) => <p key={issue.id} className="border-b border-my-line pb-3 text-my-sm">#{issue.iid} · {issue.fields.title}</p>)}</div>
          <p className="text-my-xs text-my-tertiary">仅导入本页。取消会停止后续处理，已创建的任务不会自动删除。</p>
          <div className="flex flex-wrap justify-end gap-2">
            {preview.hasMore && <Button size="sm" disabled={disabled || !currentBinding} onClick={() => { const page = previewPage + 1; void perform(() => api.previewImport({ ...bound, page, state: 'all' }), (data) => { setPreviewPage(page); setPreview(data) }) }}>预览下一页</Button>}
            <Button size="sm" variant="primary" disabled={disabled || !preview.count || !previewCurrent} onClick={() => void submitImport()}>确认导入本页</Button>
          </div>
        </>}
      </>}
    </GitlabDialog>}
    {panel === 'history' && <GitlabDialog title="导入与同步记录" busy={busy} error={error} close={closePanel}>
      <IntegrationJobHistory resource={{ state: 'ready', data: historyRows(jobs.items) }} jobActions={(job) => [action('查看详情', () => { setSelectedJob(job); openPanel('job') }), ...jobActions(job)]} pagination={{ hasMore: Boolean(jobs.next), previous: after ? action('返回最新记录', () => setAfter(null)) : undefined, next: jobs.next ? action('更早记录', () => setAfter(jobs.next)) : undefined }} />
    </GitlabDialog>}
    {panel === 'job' && job && <GitlabDialog title="作业详情" busy={busy} error={error} close={closePanel}>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => openPanel('history')}><ChevronLeft size={14} />返回记录</Button>
      <IntegrationJobHistory resource={{ state: 'ready', data: historyRows([job]) }} jobActions={jobActions} />
      {jobs.failures.filter((failure) => failure.jobId === job.id).map((failure, index) => <p key={`${failure.issueId}:${index}`} className="text-my-sm text-my-warning-text">Issue ID {failure.issueId} · {failure.detail} · {new Date(failure.at).toLocaleString()}</p>)}
      {jobs.hasMoreFailures && <p className="text-my-xs text-my-tertiary">当前页只返回部分失败证据，其余记录保留在后台。</p>}
      <details className="space-y-2 break-words text-my-xs text-my-tertiary"><summary className="cursor-pointer">原始作业与来源</summary><p>作业：{job.id}<br />命令：{job.commandId}<br />连接：{job.source.connectionId}<br />实例：{job.source.instanceId}<br />项目：{job.source.remoteProjectId}<br />绑定修订：{job.source.bindingRevision}<br />作业修订：{job.revision}<br />目标：{context.expectedRoot}<br />证据：{job.evidenceRef || '尚无证据引用'}</p></details>
    </GitlabDialog>}
    {panel === 'issue' && bound && <GitlabDialog title="Issue 与评论" subtitle={binding?.project.path} busy={busy} error={error} close={closePanel}>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!/^[1-9]\d*$/.test(iid) || !Number.isSafeInteger(Number(iid))) return; setNotePage(1); setDetail(null); void perform(() => api.issueDetail({ ...bound, iid: Number(iid), notesPage: 1 }), setDetail) }}><input className="my-input min-w-0 flex-1" aria-label="Issue IID" placeholder="Issue 编号，例如 42" inputMode="numeric" value={iid} disabled={disabled} onChange={(e) => setIid(e.target.value)} /><Button size="sm" onClick={(event) => event.currentTarget.form?.requestSubmit()} disabled={disabled || !currentBinding}>读取 Issue</Button></form>
      {detail && <><h4 className="text-my-sm font-medium">#{detail.issue.iid} · {detail.issue.fields.title}</h4><p className="whitespace-pre-wrap break-words text-my-sm text-my-secondary">{detail.issue.fields.description}</p>{detail.notes.map((note) => <article key={note.id} className="space-y-2 border-t border-my-line pt-3"><p className="text-my-xs text-my-tertiary">用户 {note.authorId}{note.system ? ' · 系统记录' : ''} · {new Date(note.createdAt).toLocaleString()}</p><p className="whitespace-pre-wrap break-words text-my-sm">{note.body}</p></article>)}{detail.hasMore && <Button size="sm" disabled={disabled || !currentBinding} onClick={() => void perform(() => api.issueDetail({ ...bound, iid: detail.issue.iid, notesPage: notePage + 1 }), (data) => { setDetail(data); setNotePage((p) => p + 1) })}>下一页评论</Button>}
        <label className="block space-y-2"><span className="my-item-title">发布评论</span><textarea className="my-input w-full" aria-label="新增 Issue 评论" placeholder="输入要发布到 GitLab 的评论" maxLength={10000} value={comment} disabled={disabled} onChange={(e) => setComment(e.target.value)} /></label><p className="text-my-xs text-my-warning-text">评论将以当前连接的 GitLab 用户发布到远端。</p><Button size="sm" disabled={disabled || !currentBinding || !comment.trim() || binding?.plan.direction !== 'bidirectional' || binding?.plan.state === 'paused' || snapshot.permission?.write !== 'granted'} onClick={() => { const key = `note:${detail.issue.id}:${comment}`; void perform(() => api.addComment({ ...bound, issueId: detail.issue.id, body: comment, commandId: commandFor(key), acknowledgeWrite: true }), () => { setComment(''); setNotice('评论已提交，可在历史记录中查看结果。') }, key) }}>确认发布评论</Button>
        <details className="text-my-xs text-my-tertiary"><summary className="cursor-pointer">Issue 来源详情</summary><p>数字 Issue ID：{detail.issue.id} · {detail.issue.fields.state} · {detail.issue.updatedAt}</p></details>
      </>}
    </GitlabDialog>}
    {panel === 'create' && bound && binding?.plan.direction === 'bidirectional' && <GitlabDialog title="从本地任务创建 Issue" subtitle={binding.project.path} busy={busy} error={error} close={closePanel}>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled} onClick={() => { setLocalPage(1); setLocalSelection(''); void perform(() => api.localTasks({ ...context, page: 1 }), setLocalTasks) }}>读取本地任务</Button>{localTasks.hasMore && <Button size="sm" disabled={disabled} onClick={() => void perform(() => api.localTasks({ ...context, page: localPage + 1 }), (data) => { setLocalPage((p) => p + 1); setLocalTasks(data); setLocalSelection('') })}>下一页任务</Button>}</div>
      <Select ariaLabel="新建 Issue 的本地任务" className="w-full" value={localSelection} disabled={disabled} onChange={setLocalSelection} options={[{ value: '', label: '选择尚无业务来源的本地任务' }, ...localTasks.items.filter((task) => !task.hasSource).map((task) => ({ value: task.taskRef, label: task.title }))]} />
      <p className="text-my-sm text-my-warning-text">所选任务会按当前映射创建为 GitLab Issue，内容将写入远端项目。</p>
      <Button size="sm" variant="primary" disabled={disabled || !currentBinding || !localSelection || snapshot.permission?.write !== 'granted' || binding.plan.state === 'paused'} onClick={() => { const task = localTasks.items.find((v) => v.taskRef === localSelection); if (!task) return; const key = `create:${binding.plan.id}:${task.taskRef}:${task.revision}`; void perform(() => api.createIssue({ ...bound, taskRef: task.taskRef, localRevision: task.revision, commandId: commandFor(key), acknowledgeWrite: true }), (job) => { setLocalSelection(''); setLocalTasks({ items: [], hasMore: false }); setSelectedJob(job); setPanel('job') }, key) }}>确认创建 GitLab Issue</Button>
    </GitlabDialog>}
    {panel === 'conflicts' && <GitlabDialog title="字段冲突" busy={busy} error={error} close={closePanel}>
      {!snapshot.conflicts.length && <p className="text-my-sm text-my-tertiary">当前没有待处理冲突。</p>}
      {snapshot.conflicts.map((conflict) => { const b = snapshot.bindings.find((v) => v.plan.id === conflict.bindingId); return <article key={conflict.id} className="space-y-3 border-b border-my-line pb-4"><p className="text-my-sm">{b?.project.path} · Issue #{conflict.issue.iid} · {conflict.field}</p><p className="break-words text-my-xs text-my-secondary">本地：{JSON.stringify(conflict.local)}<br />GitLab：{JSON.stringify(conflict.remote)}</p><div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled || !b} onClick={() => { if (b) void perform(() => api.resolveConflict({ ...context, bindingId: b.plan.id, bindingRevision: b.plan.source.bindingRevision, conflictId: conflict.id, resolution: 'remote' })) }}>采用 GitLab 值</Button>{b?.plan.direction === 'bidirectional' && <Button size="sm" disabled={disabled} onClick={() => void perform(() => api.resolveConflict({ ...context, bindingId: b.plan.id, bindingRevision: b.plan.source.bindingRevision, conflictId: conflict.id, resolution: 'local' }))}>采用本地值（下次同步写回）</Button>}</div></article> })}
    </GitlabDialog>}
  </>
}
