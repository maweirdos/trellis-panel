import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { FileText, FolderOpen, Loader2, RefreshCw, Save, Square, ChevronRight } from 'lucide-react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import type { TaskPlanningRuntimeCatalog } from '@shared/conversation/task-planning-runtime'
import type { TaskPlanningApi, TaskPlanningReply, TaskPlanningView } from '@shared/task-planning'
import type { TeamTaskMaterialMetadata, TeamTaskMaterialReceipt } from '@shared/team-task-materials'
import { cleanModelDisplayName } from '@shared/model-selection'
import { api } from '../../api'
import { Button, DisclosureGrid } from '../../my/ui'
import { Select } from '../../components/Select'
import { ConversationModelPicker } from '../../conversation-workbench/ConversationModelPicker'
import type { ComposerModel } from '../../conversation-workbench/useComposerSend'
import type { ConversationInstanceCatalog, ConversationModelCatalog } from '../../conversation-workbench/useConversationModelCatalog'
import { TeamMarkdown } from '../../team/TeamMarkdown'
import { useCrux } from '../store'
import { useTaskSource } from '../pages/task-detail/use-task-source'
import '../../acp/workspace.css'

const labels: Record<TaskPlanningView['state'], string> = { empty: '', prepared: '工程已确认', sending: '正在连接', running: '正在生成方案',
  candidate: '方案待审阅', cancelled: '回合已取消', failed: '本次未完成', unknown: '回合结果待核对' }
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
  const [readGeneration, setReadGeneration] = useState<number | undefined>()
  const [drivers, setDrivers] = useState<TaskPlanningRuntimeCatalog['drivers']>()
  const [model, setModel] = useState<ComposerModel | null>(null)
  const [descriptions, setDescriptions] = useState<Record<string, ConversationInstanceCatalog['read']>>({})
  const modelAnchor = useRef<HTMLDivElement>(null), modelRequests = useRef(new Set<string>())
  const [documents, setDocuments] = useState<TeamTaskMaterialMetadata[]>([]), [targetId, setTargetId] = useState(''), [approverId, setApproverId] = useState('')
  const [canCreateDocument, setCanCreateDocument] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const live = useRef(true), pending = useRef(false), reads = useRef(0), prepareId = useRef<string | null>(null)
  const reading = useRef(false), operations = useRef(0)
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
      latestView.current = next; setView(next); setReadGeneration(task.assigneeGeneration); setError('')
      if (next.planningId) prepareId.current = null
      onOwnerChange?.(!next.cleanupConfirmed)
    }
    else {
      setReadGeneration(undefined)
      setError(reply.error)
    }
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
  const refresh = useCallback(async () => {
    if (!client || !canPlan || modelRequests.current.has('')) return
    modelRequests.current.add('')
    try {
      const reply = await client.catalog({})
      if (!live.current || !currentSource.current.owns()) return
      if (!reply.ok) throw Error(reply.error)
      setDrivers(reply.value.drivers)
    } catch (cause) {
      if (live.current && currentSource.current.owns()) setError(cause instanceof Error ? cause.message : '规划实例读取失败。')
    } finally { modelRequests.current.delete('') }
  }, [client, canPlan])
  useEffect(() => { if (canPlan && !drivers) void refresh() }, [canPlan, drivers, refresh])
  const ensure = useCallback(async (instanceId: string, force = false) => {
    if (!client || !canPlan || !drivers?.some(driver => driver.instanceId === instanceId) || modelRequests.current.has(instanceId)
      || descriptions[instanceId] && !force) return
    modelRequests.current.add(instanceId)
    setDescriptions(previous => ({ ...previous, [instanceId]: { status: 'loading' } }))
    try {
      const reply = await client.catalog({ instanceId })
      if (!live.current || !currentSource.current.owns()) return
      if (!reply.ok || !reply.value.descriptor) throw Error(reply.ok ? '原实例未提供只读规划目录。' : reply.error)
      const descriptor = reply.value.descriptor
      setDescriptions(previous => ({ ...previous, [instanceId]: { status: 'ready', descriptor } }))
    } catch (cause) {
      if (live.current && currentSource.current.owns()) setDescriptions(previous => ({
        ...previous, [instanceId]: { status: 'failed', error: cause instanceof Error ? cause.message : '原实例不可用。' },
      }))
    } finally { modelRequests.current.delete(instanceId) }
  }, [client, canPlan, descriptions, drivers])
  const catalog: ConversationModelCatalog = {
    status: drivers ? 'ready' : 'idle', error: undefined, scopeAllowsSkills: false, refresh, ensure,
    instances: (drivers ?? []).map(driver => ({ ...driver, read: descriptions[driver.instanceId] })),
    models: (drivers ?? []).flatMap(driver => {
      const read = descriptions[driver.instanceId]
      return read?.status === 'ready' ? read.descriptor.models.map(item => ({ ...driver, ...item })) : []
    }),
  }
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
  const stopPlan = async (planningId: string): Promise<void> => {
    if (!client || stopRequest.current) return
    stopRequest.current = true
    const operation = ++operations.current
    reads.current++
    const current = (): boolean => live.current && currentSource.current.owns() && operation === operations.current
    setStopping(true)
    setError('')
    try {
      const reply = await client.stop({ planningId })
      if (!current()) return
      if (!reply.ok || !reply.value.cleanupConfirmed) {
        setError(reply.ok ? '原进程停止待核对。' : reply.error)
        return
      }
      reads.current++
      const previous = latestView.current
      if (previous?.planningId === planningId) {
        const state = previous.state === 'running' || previous.state === 'sending' ? 'unknown' : previous.state
        const stopped = { ...previous, state, sourceError: null, nativeView: undefined, cleanupConfirmed: true }
        latestView.current = stopped
        setView(stopped)
      }
      onOwnerChange?.(false)
      setStopping(false)
      const observed = await client.reconcile({ planningId })
      if (current()) accept(observed)
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : '停止尚待核对。')
    } finally {
      stopRequest.current = false
      if (current()) setStopping(false)
    }
  }
  useEffect(() => {
    if (!client || !view?.planningId || view.cleanupConfirmed || !source.available) return
    const planningId = view.planningId
    let active = true, timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      if (!active || !live.current) return
      if (pending.current || latestView.current?.state === 'sending') await readLive()
      else await act(() => client.reconcile({ planningId }), true)
      if (active && live.current) timer = setTimeout(() => void poll(), 1500)
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => { active = false; clearTimeout(timer) }
  }, [client, query, view?.planningId, view?.cleanupConfirmed, source.available])
  if (!client || context.state === 'local') return null
  const planningId = view?.planningId
  if (!planningId && !canPlan && !busy && !stopping && !error && !view?.sourceError && (!view || view.state === 'empty')) return null
  const canPrepare = !loading && !busy && canPlan && Boolean(model) && (!planningId || view.cleanupConfirmed)
  const selectedDocument = documents.find(item => item.documentId === targetId)
  const members = snapshot.members.filter(member => snapshot.spaces.find(space => space.id === task.spaceId)?.memberIds.includes(member.id))
  const mayDisplayPlan = Boolean(actor && actor === handler && readGeneration === task.assigneeGeneration)
  const save = mayDisplayPlan ? view?.save : undefined
  return <section aria-label="任务技术方案" className="my-card min-w-0 space-y-3 p-3">
    <header className="flex flex-wrap items-center gap-2"><FileText size={15} className="text-my-icon-secondary" /><h3 className="flex-1 text-my-sm font-medium text-my-primary">技术方案</h3>
      <span role="status" className="text-my-xs text-my-secondary">{stopping ? '正在停止原进程…' : loading && !view ? '正在核对…' : view
        ? view.cleanupConfirmed && view.state !== 'empty' && view.state !== 'prepared' ? `原进程已停止 · ${labels[view.state]}` : labels[view.state] : ''}</span>
      <Button size="sm" variant="ghost" aria-label="核对原技术方案" onClick={() => { if (pending.current) void readLive(); else void act(() => planningId ? client.reconcile({ planningId }) : client.read(query), true) }}><RefreshCw size={13} className={loading ? 'animate-spin motion-reduce:animate-none' : undefined} /></Button>
    </header>
    {canPlan && (!planningId || view?.cleanupConfirmed) && <div ref={modelAnchor} className="flex flex-wrap items-center gap-2">
      <ConversationModelPicker catalog={catalog} value={model} onChange={value => { setModel(value); prepareId.current = null }} anchor={modelAnchor} disabled={busy} />
      <Button size="sm" variant="ghost" disabled={!canPrepare} onClick={() => {
        if (!model) return
        prepareId.current ??= crypto.randomUUID()
        void act(() => client.prepare({ ...query, commandId: prepareId.current ?? '', expectedUpdatedAt: task.updatedAt,
          instanceId: model.instanceId, modelId: model.id, ...(model.options && { options: [...model.options] }),
          ...(planningId ? { reusePlanningId: planningId } : {}) }))
      }}><FolderOpen size={13} />{planningId ? '重新准备' : '选择工程'}</Button>
    </div>}
    {mayDisplayPlan && view?.directoryName && <div className="flex flex-wrap items-center gap-2"><span className="my-item-title">{view.directoryName}</span><span className="my-item-description">{modelCaption(view.modelId ?? '')}</span></div>}
    {mayDisplayPlan && view && view.sources.length > 0 && <div className="text-my-xs text-my-secondary">
      <button type="button" className="flex cursor-pointer items-center gap-1.5 text-my-xs text-my-secondary transition-colors hover:text-my-primary" aria-expanded={sourcesOpen} onClick={() => setSourcesOpen((v) => !v)}>
        <ChevronRight size={12} className="my-disclosure-chevron shrink-0 text-my-tertiary" data-open={sourcesOpen || undefined} />
        <span>规划依据</span>
      </button>
      <DisclosureGrid open={sourcesOpen}>
        <ul className="mt-2 space-y-1">{view.sources.map((item, index) => <li key={`${item.title}:${index}`} className="break-words"><span className="my-item-title">{item.title}</span></li>)}</ul>
      </DisclosureGrid>
    </div>}
    {planningId && view?.state === 'prepared' && canPlan && <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="ghost" disabled={busy || !view.current} onClick={() => void act(() => client.selectSources({ planningId }))}>选取工程资料</Button>
      <Button size="sm" disabled={busy || !view.current || !view.sourceDigest} onClick={() => { if (view.sourceDigest) generatePlan(planningId, view.sourceDigest) }}>{busy && <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />}生成技术方案</Button>
    </div>}
    {mayDisplayPlan && view?.candidate && <article aria-label="生成的技术方案" className="space-y-3">
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
    {planningId && !view?.cleanupConfirmed && <Button size="sm" variant="ghost" disabled={stopping}
      onClick={() => void stopPlan(planningId)}><Square size={13} />停止规划</Button>}
    {(error || view?.sourceError || save?.error) && <p role="alert" className="text-my-xs text-my-danger-text">{error || save?.error || view?.sourceError}</p>}
  </section>
}
