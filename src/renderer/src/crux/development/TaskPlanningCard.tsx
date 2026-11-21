import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { FileText, FolderOpen, Loader2, RefreshCw, Save, Square } from 'lucide-react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import type { AcpAgentStatus } from '@shared/types'
import type { TaskPlanningApi, TaskPlanningReply, TaskPlanningView } from '@shared/task-planning'
import type { TeamTaskMaterialMetadata, TeamTaskMaterialReceipt } from '@shared/team-task-materials'
import { cleanModelDisplayName } from '@shared/model-selection'
import { api } from '../../api'
import { Button } from '../../my/ui'
import { Select } from '../../components/Select'
import { RuntimePicker } from '../../acp/RuntimePicker'
import { EventRow } from '../../acp/TranscriptRow'
import { TeamMarkdown } from '../../team/TeamMarkdown'
import { useApp } from '../../store'
import { useCrux } from '../store'
import { useTaskSource } from '../pages/task-detail/use-task-source'
import '../../acp/workspace.css'

const labels: Record<TaskPlanningView['state'], string> = { empty: '', prepared: '工程已确认', sending: '正在连接', running: '正在生成方案',
  candidate: '方案待审阅', cancelled: '已停止', failed: '本次未完成', unknown: '原结果待核对' }
const planningApi = (): TaskPlanningApi | null => api && Object.hasOwn(api, 'taskPlanning') && api.taskPlanning ? api.taskPlanning : null
const modelCaption = (name: string): string => cleanModelDisplayName(name, 'acp').replace(/^codex\//, '')

type TaskPlanningCardProps = {
  snapshot: CruxSnapshot; task: CruxTask; onOpenMaterial(receipt: TeamTaskMaterialReceipt): void; onOwnerChange?(occupied: boolean): void
}
/** A task action and a private candidate, alongside the original material editor. */
export function TaskPlanningCard(props: TaskPlanningCardProps): JSX.Element {
  const context = useCrux(state => state.workspaceContext)
  return <PlanningCard key={JSON.stringify([context.key, context.actorId, props.task.spaceId, props.task.id, props.task.createdAt])} {...props} />
}
function PlanningCard({ snapshot, task, onOpenMaterial, onOwnerChange }: TaskPlanningCardProps): JSX.Element | null {
  const context = useCrux(state => state.workspaceContext), source = useTaskSource({ spaceId: task.spaceId, taskId: task.id }), client = planningApi()
  const [view, setView] = useState<TaskPlanningView | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true)
  const [agents, setAgents] = useState<AcpAgentStatus[]>([]), [models, setModels] = useState<Array<{ value: string; label: string }>>([]), [modelId, setModelId] = useState('')
  const [documents, setDocuments] = useState<TeamTaskMaterialMetadata[]>([]), [targetId, setTargetId] = useState(''), [approverId, setApproverId] = useState('')
  const [canCreateDocument, setCanCreateDocument] = useState(false)
  const [permissionPending, setPermissionPending] = useState<Record<string, boolean>>({}), [permissionErrors, setPermissionErrors] = useState<Record<string, string>>({})
  const [stopping, setStopping] = useState(false)
  const live = useRef(true), pending = useRef(false), reads = useRef(0), prepareId = useRef<string | null>(null)
  const reading = useRef(false), operations = useRef(0), permissionLocks = useRef(new Set<string>())
  const stopRequest = useRef(false)
  const latestView = useRef(view); latestView.current = view
  const currentSource = useRef(source); currentSource.current = source
  const query = useMemo(() => ({ workspaceKey: context.key, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt }), [context.key, task.id, task.spaceId, task.createdAt])
  const actor = context.actorId ?? '', handler = task.workflow?.handlerId ?? task.assigneeIds[0]
  const canPlan = source.canWrite() && context.state === 'connected' && actor === handler && task.workflow?.stage === 'planning'
  const accept = (reply: TaskPlanningReply): void => {
    if (reply.ok) {
      const previous = latestView.current, next = reply.value
      if (previous?.planningId && previous.planningId === next.planningId
        && (previous.candidate && !next.candidate
          || ['cancelled', 'failed'].includes(previous.state) && ['prepared', 'sending', 'running', 'unknown'].includes(next.state)
          || previous.cleanupConfirmed && previous.state !== 'prepared' && !next.cleanupConfirmed)) return
      latestView.current = next; setView(next); setError(''); if (next.planningId) prepareId.current = null; onOwnerChange?.(!next.cleanupConfirmed)
    }
    else setError(reply.error)
  }
  useEffect(() => { live.current = true; return () => { live.current = false; reads.current++; operations.current++ } }, [])
  const readLive = async (): Promise<void> => {
    if (!client || reading.current || !live.current || !currentSource.current.owns()) return
    const ticket = ++reads.current
    reading.current = true
    try {
      const reply = await client.read(query)
      if (live.current && currentSource.current.owns() && ticket === reads.current) accept(reply)
    } catch (cause) {
      if (live.current && currentSource.current.owns() && ticket === reads.current) setError(cause instanceof Error ? cause.message : '规划状态暂不可读。')
    } finally { reading.current = false }
  }
  useEffect(() => {
    if (!client) { setLoading(false); onOwnerChange?.(false); return }
    let active = true
    const ticket = ++reads.current
    setLoading(true)
    void client.read(query).then(reply => { if (active && live.current && currentSource.current.owns() && ticket === reads.current) accept(reply) })
      .catch(cause => { if (active && live.current && currentSource.current.owns() && ticket === reads.current) setError(cause instanceof Error ? cause.message : '原规划读取失败。') })
      .finally(() => { if (active && live.current) setLoading(false) })
    return () => { active = false }
  }, [client, query, task.updatedAt])
  useEffect(() => {
    if (!client || !canPlan) return
    let valid = true
    void Promise.all([api.acpAgents(), api.getSettings(), api.acpSessions()]).then(([runtimes, settings, sessions]) => {
      if (!valid || !currentSource.current.owns()) return
      if (runtimes.ok) setAgents((runtimes.agents ?? []).filter(item => item.id === 'codex'))
      const configured = settings.acp?.runtimeDefaults?.codex?.modelId
      const options = new Map<string, string>()
      if (configured && /^.+\[[a-z]+\]$/.test(configured)) options.set(configured, modelCaption(configured))
      for (const session of sessions.sessions ?? []) if (session.agentId === 'codex') {
        for (const model of session.models ?? []) if (/^.+\[[a-z]+\]$/.test(model.modelId)) options.set(model.modelId, modelCaption(model.name))
      }
      const choices = [...options].map(([value, label]) => ({ value, label }))
      setModels(choices); setModelId(current => current || (configured && options.has(configured) ? configured : ''))
    }).catch(cause => { if (valid && currentSource.current.owns()) setError(cause instanceof Error ? cause.message : '执行模型读取失败。') })
    return () => { valid = false }
  }, [client, canPlan])
  useEffect(() => {
    if (!client || !api.cruxMaterials || !canPlan) return
    let valid = true
    void api.cruxMaterials.list({ ...query, limit: 100 }).then(reply => {
      if (!valid || !currentSource.current.owns()) return
      if (!reply.ok) { setError(reply.error); return }
      const choices = reply.value.page.items.filter(document => document.kind === 'implement' && document.editorIds.includes(actor))
      setDocuments(choices)
      setCanCreateDocument(!reply.value.page.hasMore && !reply.value.page.items.some(document => document.kind === 'implement'))
      if (reply.value.page.hasMore) setError('材料目录尚未完整读取，请在原任务材料区确认目标草稿。')
      else setTargetId(current => current || choices[0]?.documentId || '')
    }).catch(cause => { if (valid && currentSource.current.owns()) setError(cause instanceof Error ? cause.message : '技术方案草稿读取失败。') })
    return () => { valid = false }
  }, [client, query, canPlan, view?.save?.state])
  const act = async (action: () => Promise<TaskPlanningReply>, cleanup = false): Promise<void> => {
    if (pending.current || stopRequest.current || !cleanup && !canPlan) return
    const operation = ++operations.current
    reads.current++
    pending.current = true; setBusy(true); setError('')
    try { const reply = await action(); if (live.current && currentSource.current.owns() && operation === operations.current) { reads.current++; accept(reply) } }
    catch (cause) { if (live.current && currentSource.current.owns() && operation === operations.current) setError(cause instanceof Error ? cause.message : '原操作尚待核对。') }
    finally { pending.current = false; if (live.current) setBusy(false) }
  }
  const generatePlan = (planningId: string, sourceDigest: string): void => {
    if (!client || pending.current || !canPlan) return
    if (latestView.current) latestView.current = { ...latestView.current, state: 'sending', cleanupConfirmed: false }
    setView(latestView.current)
    onOwnerChange?.(true)
    void act(() => client.generate({ planningId, sourceDigest }))
  }
  useEffect(() => {
    if (!client || !view?.planningId || view.cleanupConfirmed || !source.available) return
    const planningId = view.planningId
    let active = true, timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      if (!active || !live.current) return
      const current = latestView.current
      if (pending.current || permissionLocks.current.size || current?.state === 'sending'
        || current?.nativeView && ['starting', 'busy', 'awaiting_permission'].includes(current.nativeView.status)) await readLive()
      else await act(() => client.reconcile({ planningId }), true)
      if (active && live.current) timer = setTimeout(() => void poll(), 1500)
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => { active = false; clearTimeout(timer) }
  }, [client, query, view?.planningId, view?.cleanupConfirmed, source.available])
  const respond = async (requestId: string, optionId: string): Promise<void> => {
    const current = latestView.current, native = current?.nativeView
    const permission = native?.pendingPermissions.find(item => item.requestId === requestId)
    if (!client || stopping || !canPlan || !current?.current || !current.planningId || !native || !permission || permission.expiresAt <= Date.now()
      || !permission.options.some(option => option.optionId === optionId) || permissionLocks.current.has(requestId)) return
    const operation = operations.current
    permissionLocks.current.add(requestId)
    reads.current++
    setPermissionPending(old => ({ ...old, [requestId]: true }))
    setPermissionErrors(old => ({ ...old, [requestId]: '' }))
    try {
      const reply = await client.respond({ planningId: current.planningId, requestId, optionId, expectedConnectionGeneration: native.connectionGeneration })
      if (!live.current || !currentSource.current.owns() || operation !== operations.current) return
      reads.current++
      if (!reply.ok) throw Error(reply.error)
      accept(reply)
    } catch (cause) {
      if (live.current && currentSource.current.owns() && operation === operations.current) setPermissionErrors(old => ({ ...old, [requestId]: cause instanceof Error ? cause.message : '本次确认尚未提交，请检查状态。' }))
    } finally {
      permissionLocks.current.delete(requestId)
      if (live.current) setPermissionPending(old => ({ ...old, [requestId]: false }))
    }
  }
  if (!client || context.state === 'local') return null
  const planningId = view?.planningId
  if (!planningId && !canPlan && !busy && !stopping && !error && !view?.sourceError && (!view || view.state === 'empty')) return null
  const canPrepare = !loading && !busy && canPlan && Boolean(modelId) && (!planningId || view.cleanupConfirmed)
  const selectedDocument = documents.find(item => item.documentId === targetId)
  const members = snapshot.members.filter(member => snapshot.spaces.find(space => space.id === task.spaceId)?.memberIds.includes(member.id))
  const save = view?.save
  const permissions = stopping ? [] : view?.nativeView?.pendingPermissions.filter(permission => permission.expiresAt > Date.now()) ?? []
  const pendingPerm = Object.fromEntries(permissions.map(permission => [permission.requestId, permission]))
  return <section aria-label="任务技术方案" className="min-w-0 space-y-3 rounded-my-md border border-my-line bg-my-surface-1 p-3">
    <header className="flex flex-wrap items-center gap-2"><FileText size={15} className="text-my-icon-secondary" /><h3 className="flex-1 text-my-sm font-medium text-my-primary">技术方案</h3>
      <span role="status" className="text-my-xs text-my-secondary">{stopping ? '正在停止…' : permissions.length ? '等待确认' : loading && !view ? '正在核对…' : view?.nativeView?.status === 'busy' ? '正在生成方案' : view ? labels[view.state] : ''}</span>
      <Button size="sm" variant="ghost" aria-label="核对原技术方案" onClick={() => { if (pending.current) void readLive(); else void act(() => planningId ? client.reconcile({ planningId }) : client.read(query), true) }}><RefreshCw size={13} className={loading ? 'animate-spin motion-reduce:animate-none' : undefined} /></Button>
    </header>
    {canPlan && (!planningId || view?.cleanupConfirmed) && <div className="flex flex-wrap items-center gap-2">
      <RuntimePicker agents={agents} value="codex" onSelect={() => {}} isCurrent={source.owns} />
      <Select size="sm" value={modelId} options={models} onChange={value => { setModelId(value); prepareId.current = null }} ariaLabel="规划模型" placeholder="选择规划模型" disabled={busy} />
      <Button size="sm" variant="ghost" disabled={!canPrepare} onClick={() => {
        prepareId.current ??= crypto.randomUUID()
        void act(() => client.prepare({ ...query, commandId: prepareId.current ?? '', expectedUpdatedAt: task.updatedAt, agentId: 'codex', modelId,
          ...(planningId ? { reusePlanningId: planningId } : {}) }))
      }}><FolderOpen size={13} />{planningId ? '重新准备' : '选择工程'}</Button>
      {!models.length && <Button size="sm" variant="ghost" onClick={() => useApp.getState().setPage('settings')}>模型与执行配置</Button>}
    </div>}
    {view?.directoryName && <div className="flex flex-wrap items-center gap-2"><span className="my-item-title">{view.directoryName}</span><span className="my-item-description">{modelCaption(view.modelId ?? '')}</span></div>}
    {view && view.sources.length > 0 && <details className="text-my-xs text-my-secondary"><summary className="cursor-pointer">规划依据</summary><ul className="mt-2 space-y-1">{view.sources.map((item, index) => <li key={`${item.title}:${index}`} className="break-words"><span className="my-item-title">{item.title}</span></li>)}</ul></details>}
    {planningId && view?.state === 'prepared' && canPlan && <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="ghost" disabled={busy || !view.current} onClick={() => void act(() => client.selectSources({ planningId }))}>选取工程资料</Button>
      <Button size="sm" disabled={busy || !view.current || !view.sourceDigest} onClick={() => { if (view.sourceDigest) generatePlan(planningId, view.sourceDigest) }}>{busy && <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />}生成技术方案</Button>
    </div>}
    {planningId && view?.state === 'unknown' && canPlan && <Button size="sm" variant="ghost" disabled={busy || !view.current || !view.sourceDigest} onClick={() => { if (view.sourceDigest) generatePlan(planningId, view.sourceDigest) }}>继续原规划请求</Button>}
    {permissions.map(permission => <fieldset key={permission.requestId} aria-label="操作确认" disabled={!canPlan || !view?.current || permissionPending[permission.requestId]} className="min-w-0 space-y-2 border-t border-my-line pt-3">
      {permission.reviewContext && <div className="min-w-0 space-y-2">
        <div><p className="my-item-description">命令</p><pre className="my-scrollbar max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-my-sm text-my-primary">{permission.reviewContext.command}</pre></div>
        <div><p className="my-item-description">运行目录</p><p className="break-all font-mono text-my-sm text-my-primary">{permission.reviewContext.cwd}</p></div>
        {permission.reviewContext.details && <details className="text-my-xs text-my-secondary"><summary className="cursor-pointer">操作详情</summary><pre className="my-scrollbar mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{permission.reviewContext.details}</pre></details>}
      </div>}
      <EventRow item={{ type: 'perm', key: permission.requestId, ev: { id: permission.requestId, ts: 0, source: 'acp', kind: 'permission',
        sessionId: permission.sessionId, projectRoot: permission.projectRoot ?? '', payload: { requestId: permission.requestId } } }}
        privateConversation pendingPerm={pendingPerm} permissionPending={permissionPending} permissionErrors={permissionErrors}
        onRespond={(requestId, optionId) => void respond(requestId, optionId)} onOpenTask={() => {}} onOpenArtifact={() => {}} onOpenSpec={() => {}} onOpenJira={() => {}} />
    </fieldset>)}
    {view?.candidate && <article aria-label="生成的技术方案" className="space-y-3">
      <div className="my-scrollbar max-h-96 overflow-auto border-y border-my-line py-3"><TeamMarkdown text={view.candidate.value.markdown} identity={`${planningId}:${view.candidate.revision}`} /></div>
      {canPlan && !save && <div className="flex flex-wrap items-center gap-2">
        <Select size="sm" value={targetId} onChange={setTargetId} options={[...(canCreateDocument ? [{ value: '', label: '新建技术方案草稿' }] : []), ...documents.map(document => ({ value: document.documentId, label: document.draft.title }))]} ariaLabel="方案保存目标" disabled={busy} />
        {!targetId && canCreateDocument && <Select size="sm" value={approverId} onChange={setApproverId} options={members.map(member => ({ value: member.id, label: member.name }))} ariaLabel="方案审批人" placeholder="选择审批人" disabled={busy} />}
        <Button size="sm" disabled={busy || !view.current || !view.cleanupConfirmed || !selectedDocument && (!canCreateDocument || !approverId)} onClick={() => {
          if (planningId && view.candidate) void act(() => client.saveDraft({ planningId, candidateRevision: view.candidate?.revision ?? '',
            target: selectedDocument ? { kind: 'draft', documentId: selectedDocument.documentId, expectedDraftRevision: selectedDocument.draftRevision }
              : { kind: 'create', editorIds: [actor], approverIds: [approverId] } }))
        }}><Save size={13} />保存到技术方案草稿</Button>
      </div>}
    </article>}
    {save?.receipt && <div className="flex flex-wrap items-center gap-2"><span role="status" className="text-my-xs text-my-secondary">{save.state === 'conflict' ? '并发稿件已保留，待比较' : '草稿已保存'}</span><Button size="sm" variant="ghost" onClick={() => { if (save.receipt) onOpenMaterial(save.receipt) }}>打开技术方案草稿</Button></div>}
    {planningId && save && !save.receipt && <div className="flex flex-wrap items-center gap-2"><span role="status" className="text-my-xs text-my-warning-text">保存结果待核对</span><Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => client.recoverSave({ planningId, retry: false }), true)}>检查保存结果</Button><Button size="sm" variant="ghost" disabled={busy || !view.current} onClick={() => void act(() => client.recoverSave({ planningId, retry: true }))}>重试保存</Button></div>}
    {planningId && !view?.cleanupConfirmed && <Button size="sm" variant="ghost" disabled={stopping} onClick={() => {
      if (stopRequest.current) return
      stopRequest.current = true
      const operation = ++operations.current
      reads.current++
      setStopping(true)
      setView(current => current ? { ...current, nativeView: undefined } : current)
      latestView.current = latestView.current ? { ...latestView.current, nativeView: undefined } : null
      void client.stop({ planningId }).then(reply => { if (live.current && currentSource.current.owns() && operation === operations.current) { reads.current++; accept(reply) } }).catch(cause => { if (live.current && operation === operations.current) setError(cause instanceof Error ? cause.message : '停止尚待核对。') })
        .finally(() => { stopRequest.current = false; if (live.current && operation === operations.current) setStopping(false) })
    }}><Square size={13} />停止规划</Button>}
    {(error || view?.sourceError || save?.error) && <p role="alert" className="text-my-xs text-my-danger-text">{error || save?.error || view?.sourceError}</p>}
  </section>
}
