import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { ChevronRight, FolderOpen, Loader2, Play, RefreshCw, Square } from 'lucide-react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import { productTaskEngineSchema, type ProductTaskApi, type ProductTaskReply, type ProductTaskView } from '@shared/product-task-entry'
import type { NativeTaskStart } from '@shared/native-task-execution'
import { isAcpPermissionReviewable } from '@shared/acp-permission-review'
import { api } from '../../api'
import { Button, DisclosureGrid } from '../../my/ui'

function InlineDisclosure({ label, defaultOpen = false, className, children }: { label: ReactNode; defaultOpen?: boolean; className?: string; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return <div className={className}>
    <button type="button" className="flex cursor-pointer items-center gap-1.5 text-left text-my-xs text-my-secondary transition-colors hover:text-my-primary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      <ChevronRight size={12} className="my-disclosure-chevron shrink-0 text-my-tertiary" data-open={open || undefined} />
      <span>{label}</span>
    </button>
    <DisclosureGrid open={open}>{children}</DisclosureGrid>
  </div>
}
import { ConversationModelPicker } from '../../conversation-workbench/ConversationModelPicker'
import { unavailableModelReason, useConversationModelCatalog } from '../../conversation-workbench/useConversationModelCatalog'
import type { ComposerModel } from '../../conversation-workbench/useComposerSend'
import { useApp } from '../../store'
import { useCrux } from '../store'
import { inputClass, Field, textareaClass } from '../ui'
import { useTaskSource } from '../pages/task-detail/use-task-source'
import '../../acp/workspace.css'

export function productTaskApi(): ProductTaskApi | null {
  return api && Object.hasOwn(api, 'productTask') && api.productTask ? api.productTask : null
}
const labels: Record<ProductTaskView['state'], string> = { unavailable: '待准备', available: '待准备', preparing: '原准备待核对', prepared: '已准备', starting: '启动中', running: '运行中', idle: '本次执行已结束', failed: '执行未完成', 'stop-requested': '正在停止', stopped: '已停止', unknown: '原结果待核对' }
const outputNames: Record<string, string> = { 'implementation-report': '实施记录', 'check-report': '检查记录', general: '处理结果', 'source-patch': '代码补丁', 'selected-file': '工程文件' }

async function readExecutionCatalog(instanceId?: string) {
  const client = api.taskPlanning
  if (!client) throw Error('正式执行模型目录暂不可用。')
  const result = await client.catalog({ purpose: 'execution', instanceId })
  if (result.ok && result.value.purpose !== 'execution') throw Error('正式执行模型目录暂不可用。')
  return result
}

const executionCatalog = {
  async list() {
    const result = await readExecutionCatalog()
    return result.ok ? { ok: true as const, drivers: result.value.drivers } : result
  },
  async describe(instanceId: string) {
    const result = await readExecutionCatalog(instanceId)
    if (!result.ok) return result
    if (!result.value.descriptor) throw Error('原实例未提供正式执行模型目录。')
    return { ok: true as const, descriptor: result.value.descriptor }
  },
}

/** Existing development entry, with retained legacy records routed to their original controls. */
export function ProductTaskEntry({ task, openRequest = 0, resourceRefresh = 0, planningOwnerRevision = 0, legacy, onOpenInputs, onExecutionChanged }: {
  snapshot: CruxSnapshot; task: CruxTask; openRequest?: number; resourceRefresh?: number; planningOwnerRevision?: number; legacy: ReactNode; onOpenInputs?(): void; onExecutionChanged?(): void
}): JSX.Element {
  const context = useCrux(s => s.workspaceContext), client = productTaskApi(), source = useTaskSource({ spaceId: task.spaceId, taskId: task.id })
  const [view, setView] = useState<ProductTaskView | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [operationError, setOperationError] = useState('')
  const [model, setModel] = useState<ComposerModel | null>(null), modelAnchor = useRef<HTMLDivElement>(null)
  const [instruction, setInstruction] = useState(''), [paths, setPaths] = useState<Record<string, string>>({})
  const [refresh, setRefresh] = useState(0), [starting, setStarting] = useState(false), root = useRef<HTMLElement>(null), live = useRef(true), inFlight = useRef(false), sequence = useRef(0)
  const latest = useRef<ProductTaskView | null>(null), operations = useRef(0), stopRequest = useRef(false)
  const retryFocus = useRef<string | null>(null)
  const permissionLocks = useRef(new Set<string>()), answered = useRef(new Set<string>())
  const [stopping, setStopping] = useState(false), [permissionPending, setPermissionPending] = useState<Record<string, boolean>>({})
  const [permissionErrors, setPermissionErrors] = useState<Record<string, string>>({})
  const currentSource = useRef(source); currentSource.current = source
  const query = { workspaceKey: context.key, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt }
  const defaultsEntry = useRef<string | null>(null)
  const handler = task.workflow?.handlerId ?? task.assigneeIds[0]
  const canRespond = source.canWrite() && context.state === 'connected' && context.actorId === handler
  const writable = canRespond && !busy && !stopping && !view?.readOnly
  const catalog = useConversationModelCatalog('', writable && view?.owner === 'native',
    JSON.stringify([context.key, context.actorId, task.spaceId, task.id, task.createdAt, task.assigneeGeneration]), undefined, executionCatalog)
  const accept = (reply: ProductTaskReply, operation = false): void => {
    if (!reply.ok) { if (operation) setOperationError(reply.error); else setError(reply.error); return }
    const previous = latest.current, next = reply.value
    if (previous?.entryId === next.entryId) {
      if (previous.cleanupConfirmed && !next.cleanupConfirmed || previous.outcome && !next.outcome
        || ['stop-requested', 'stopped'].includes(previous.state) && !['stop-requested', 'stopped'].includes(next.state)
        || !['preparing', 'prepared'].includes(previous.state) && ['preparing', 'prepared'].includes(next.state)) return
    }
    const value = { ...next, permissions: next.permissions.filter(p => !answered.current.has(`${next.entryId}:${p.requestId}`)) }
    if (operation || previous?.entryId === next.entryId && previous.state === 'preparing' && (next.preparationPending || next.state === 'prepared')) setOperationError('')
    latest.current = value; setView(value); setError(''); onExecutionChanged?.()
  }
  useEffect(() => { live.current = true; return () => { live.current = false; sequence.current++; operations.current++ } }, [])
  useEffect(() => {
    if (!view?.entryId || view.state !== 'prepared' || defaultsEntry.current === view.entryId) return
    defaultsEntry.current = view.entryId
    if (view.outputSelections) setPaths(Object.fromEntries(view.outputSelections.flatMap(output => output.source.kind === 'file' ? [[output.outputId, output.source.relativePath]] : [])))
  }, [view?.entryId, view?.state, view?.outputSelections])
  useEffect(() => {
    if (!client) { setLoading(false); return }
    let active = true
    const ticket = ++sequence.current
    setLoading(true)
    void client.read(query).then(reply => { if (active && live.current && currentSource.current.owns() && ticket === sequence.current) accept(reply) }).catch(cause => { if (active && live.current && currentSource.current.owns() && ticket === sequence.current) setError(cause instanceof Error ? cause.message : '开发环境读取失败。') }).finally(() => { if (active && live.current) setLoading(false) })
    return () => { active = false }
  }, [client, context.key, context.state, task.id, task.createdAt, task.updatedAt, resourceRefresh, planningOwnerRevision, refresh])
  useEffect(() => { if (openRequest > 0) { root.current?.focus({ preventScroll: true }); root.current?.scrollIntoView({ block: 'nearest' }) } }, [openRequest])
  useEffect(() => {
    if (view?.state === 'prepared' && root.current?.contains(document.activeElement)) root.current.querySelector('textarea')?.focus({ preventScroll: true })
  }, [view?.state])
  useEffect(() => {
    if (view?.state === 'prepared' && view.retryOf === retryFocus.current) {
      retryFocus.current = null
      root.current?.querySelector<HTMLButtonElement>('button[data-task-start]')?.focus({ preventScroll: true })
    }
  }, [view?.state, view?.retryOf])
  const act = async (call: () => Promise<ProductTaskReply>, control = false, launch = false): Promise<void> => {
    if (inFlight.current || stopRequest.current || !control && !writable) return
    const operation = ++operations.current
    sequence.current++
    inFlight.current = true; setBusy(true); setStarting(launch); setError(''); setOperationError('')
    try { const reply = await call(); if (live.current && currentSource.current.owns() && operation === operations.current) { sequence.current++; accept(reply, true); if (!reply.ok) setRefresh(n => n + 1) } }
    catch (cause) { if (live.current && currentSource.current.owns() && operation === operations.current) { setOperationError(cause instanceof Error ? cause.message : '原结果尚未确认，请核对。'); setRefresh(n => n + 1) } }
    finally { inFlight.current = false; if (live.current) { setBusy(false); setStarting(false) } }
  }
  const readLive = async (): Promise<void> => {
    const entryId = latest.current?.entryId
    if (!client || !entryId || !currentSource.current.owns()) return
    const ticket = ++sequence.current
    try {
      const reply = await client.read({ ...query, entryId })
      if (live.current && currentSource.current.owns() && ticket === sequence.current) accept(reply)
    } catch (cause) {
      if (live.current && currentSource.current.owns() && ticket === sequence.current) setError(cause instanceof Error ? cause.message : '执行状态尚未确认。')
    }
  }
  // Live observation must not wait behind Start or a pending permission response.
  useEffect(() => {
    if (!client || !view?.entryId || view.readOnly || view.cleanupConfirmed || !starting && !view.preparationPending && !['starting', 'running', 'stop-requested', 'unknown'].includes(view.state) || !source.available) return
    let active = true, timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      if (!active) return
      await readLive()
      if (active) timer = setTimeout(() => void poll(), view.preparationPending ? 2500 : 1500)
    }
    timer = setTimeout(() => void poll(), 500)
    return () => { active = false; clearTimeout(timer) }
  }, [view?.entryId, view?.state, view?.cleanupConfirmed, view?.preparationPending, view?.readOnly, client, starting, source.available])
  const respond = async (requestId: string, optionId: string): Promise<void> => {
    const current = latest.current, permission = current?.permissions.find(p => p.requestId === requestId)
    if (!client || !current?.entryId || !permission || !canRespond || !currentSource.current.canWrite() || stopRequest.current
      || current.blockers.length || current.historical || permission.expiresAt != null && permission.expiresAt <= Date.now()) return
    const key = `${current.entryId}:${requestId}`, operation = operations.current
    if (permissionLocks.current.has(key) || answered.current.has(key)) return
    permissionLocks.current.add(key); sequence.current++
    setPermissionPending(old => ({ ...old, [key]: true })); setPermissionErrors(old => ({ ...old, [key]: '' }))
    try {
      const reply = await client.permission({ entryId: current.entryId, requestId, optionId })
      if (!live.current || !currentSource.current.owns() || operation !== operations.current) return
      sequence.current++
      if (!reply.ok) throw Error(reply.error)
      answered.current.add(key); accept(reply, true)
    } catch (cause) {
      if (live.current && currentSource.current.owns() && operation === operations.current) setPermissionErrors(old => ({ ...old, [key]: cause instanceof Error ? cause.message : '本次确认尚未提交，请核对。' }))
    } finally {
      permissionLocks.current.delete(key)
      if (live.current) setPermissionPending(old => ({ ...old, [key]: false }))
    }
  }
  const stop = async (): Promise<void> => {
    const entryId = latest.current?.entryId
    if (!client || !entryId || stopRequest.current) return
    stopRequest.current = true; setStopping(true); operations.current++; sequence.current++; setError(''); setOperationError('')
    try { const reply = await client.stop({ entryId }); if (live.current) { sequence.current++; accept(reply, true) } }
    catch (cause) { if (live.current) setOperationError(cause instanceof Error ? cause.message : '停止尚未确认，请核对原结果。') }
    finally { stopRequest.current = false; if (live.current) setStopping(false) }
  }
  if (view?.owner === 'legacy') return <>{legacy}</>
  const entryId = view?.entryId
  const prepared = view?.state === 'prepared'
  const retryOutputs = view?.retryOf ? view.outputSelections : undefined
  const permissions = stopping || !source.available ? [] : view?.permissions.filter(p => p.expiresAt == null || p.expiresAt > Date.now()) ?? []
  const picked = model && !unavailableModelReason(catalog, model) && catalog.models.find(item => item.id === model.id && item.instanceId === model.instanceId)
  const selected = picked && model && productTaskEngineSchema.safeParse({ agentId: picked.driverKind,
    conversation: { instanceId: model.instanceId, model: model.id, options: model.options } })
  const engine = selected && selected.success ? selected.data : undefined
  const canPrepare = Boolean(view && (!entryId || view.successor) && view.blockers.every(b => ['directory', 'runtime'].includes(b.target)) && engine && writable && !loading)
  return <section ref={root} tabIndex={-1} aria-label="任务开发环境" className="my-card mt-3 min-w-0 space-y-3 p-3">
    <header className="flex flex-wrap items-center gap-2"><FolderOpen size={15} className="text-my-icon-secondary" /><h3 className="flex-1 text-my-sm font-medium text-my-primary">{view?.readOnly ? '执行记录' : view?.historical ? '上次开发环境' : '本机开发环境'}</h3><span role="status" className="text-my-xs text-my-secondary">{view?.readOnly ? '任务已结束' : stopping ? '正在停止' : permissions.length ? '等待确认' : view?.preparationPending ? '正在准备' : starting && view?.state === 'prepared' ? '启动中' : loading && !view ? '正在核对…' : view ? labels[view.state] : '暂不可用'}</span><Button size="sm" variant="ghost" aria-label="核对开发环境" onClick={() => { if (inFlight.current) void readLive(); else setRefresh(n => n + 1) }}><RefreshCw size={13} className={loading ? 'animate-spin motion-reduce:animate-none' : undefined} /></Button></header>
    {view && <>
      {(view.resourceName || view.directoryName || view.nodeName) && <p className="flex flex-wrap gap-x-3 gap-y-1 text-my-xs text-my-secondary">{view.resourceName && <span>{view.resourceName}</span>}{view.directoryName && <span>{view.directoryName}</span>}{view.nodeName && <span>{view.nodeName}</span>}</p>}
      {view.blockers.map((blocker, index) => <div key={`${blocker.target}-${index}`} className="flex flex-wrap items-center gap-2 text-my-xs text-my-warning-text"><span className="min-w-0 flex-1">{blocker.message}</span>{['inputs', 'workflow'].includes(blocker.target) && onOpenInputs && <Button size="sm" variant="ghost" onClick={onOpenInputs}>采用输入</Button>}{blocker.target === 'runtime' && <Button size="sm" variant="ghost" onClick={() => useApp.getState().setPage('settings')}>模型与执行配置</Button>}{blocker.target === 'resource' && <Button size="sm" variant="ghost" onClick={() => root.current?.closest('[aria-label="任务详情"]')?.querySelector<HTMLElement>('[aria-label="任务代码资源"]')?.scrollIntoView({ block: 'nearest' })}>代码资源</Button>}</div>)}
      {view.materials.length > 0 && <InlineDisclosure label="已采用材料"><ul className="mt-2 space-y-1 text-my-xs text-my-secondary">{view.materials.map((m, index) => <li key={index} className="flex flex-wrap gap-x-2"><span className="my-item-title">{m.title}</span><span className="my-item-description">{m.version.startsWith('R') ? m.version : '已确认版本'}</span></li>)}</ul></InlineDisclosure>}
      {(view.successor?.feedback ?? view.feedback) && <InlineDisclosure defaultOpen label="退回反馈"><p className="my-scrollbar mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-my-xs text-my-secondary">{(view.successor?.feedback ?? view.feedback)?.body}</p></InlineDisclosure>}
      {!view.readOnly && (!entryId || view.successor) && <div ref={modelAnchor} className="flex flex-wrap items-center gap-2">
        <ConversationModelPicker anchor={modelAnchor} catalog={catalog} value={model}
          onChange={value => { if (writable && source.owns()) setModel(value) }} disabled={!writable || loading} />
        <Button size="sm" disabled={!canPrepare} onClick={() => {
          if (client && engine) void act(() => client.prepare({ ...query, engine, ...(view.successor ? {
            successor: { predecessorEntryId: view.successor.predecessorEntryId, returnEventId: view.successor.returnEventId, expectedInputBundle: view.successor.expectedInputBundle },
          } : {}) }))
        }}>{busy ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" /> : <FolderOpen size={13} />}{view.successor ? '准备返工' : '准备'}</Button>
      </div>}
      {prepared && !view.readOnly && <div className="space-y-3">
        {!view.retryOf && <Field label="补充要求（选填）"><textarea aria-label="补充要求（选填）" className={textareaClass} value={instruction} onChange={e => setInstruction(e.target.value)} maxLength={view.instructionRemaining ?? 32000} disabled={!writable} /></Field>}
        {view.outputs.map(output => {
          const fixed = retryOutputs?.find(item => item.outputId === output.id)
          return <Field key={output.id} label={`${outputNames[output.kind] ?? '任务产物'}${output.required ? ' · 必需' : ' · 选填'}`}>{['selected-file', 'source-patch'].includes(output.kind) ? <input className={inputClass} aria-label={`${outputNames[output.kind]}的工程相对路径`} placeholder="工程相对路径" value={view.retryOf ? fixed?.source.kind === 'file' ? fixed.source.relativePath : '' : paths[output.id] ?? ''} onChange={e => setPaths(p => ({ ...p, [output.id]: e.target.value }))} readOnly={Boolean(view.retryOf)} disabled={!writable} /> : <span className="text-my-xs text-my-secondary">保存本次最终答复</span>}</Field>
        })}
        <Button size="sm" data-task-start disabled={!writable || loading || Boolean(view.blockers.length) || view.outputs.some(o => o.required && (view.retryOf ? !retryOutputs?.some(item => item.outputId === o.id) : ['selected-file', 'source-patch'].includes(o.kind) && !paths[o.id]?.trim()))} onClick={() => { if (client && entryId) void act(() => client.start({ entryId, instruction: view.retryOf ? '' : instruction, outputs: retryOutputs ?? view.outputs.flatMap<NativeTaskStart['outputs'][number]>(o => ['selected-file', 'source-patch'].includes(o.kind) ? paths[o.id]?.trim() ? [{ outputId: o.id, source: { kind: 'file', relativePath: paths[o.id].trim() } }] : [] : [{ outputId: o.id, source: { kind: 'assistant' } }]) }), false, true) }}><Play size={13} />启动并同步所选成果到此任务</Button>
      </div>}
      {view.outcome && <p role="status" className="text-my-xs text-my-secondary">{view.outcome === 'completed' ? view.state === 'failed' || view.canRestart ? '本次执行已结束，所选成果尚未就绪。' : '本次执行已结束。' : view.outcome === 'cancelled' ? '本次执行已取消。' : '本次执行失败，请核对原记录。'}</p>}
      {permissions.map(p => {
        const review = p.reviewContext, key = `${entryId}:${p.requestId}`
        return <fieldset key={p.requestId} className="min-w-0 space-y-2 text-my-xs text-my-primary" aria-label="操作确认">
          <legend className="my-item-title">{p.tool ?? '操作确认'}</legend>
          {review?.command && <pre className="my-scrollbar max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-my-base bg-my-surface-2 p-2 text-my-primary">{review.command}</pre>}
          {review?.cwd && <p className="break-all text-my-secondary">运行目录：{review.cwd}</p>}
          {review?.changes?.map((change, index) => <div key={`${change.path}:${index}`} className="min-w-0 space-y-1">
            <p className="break-all text-my-secondary">{change.path}</p>
            {change.patch !== undefined ? <pre className="my-scrollbar max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-my-base bg-my-surface-2 p-2">{change.patch}</pre> : <>
              <p className="text-my-secondary">变更前片段</p><pre className="my-scrollbar max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-my-base bg-my-surface-2 p-2">{change.oldText ?? '未提供'}</pre>
              <p className="text-my-secondary">变更后片段</p><pre className="my-scrollbar max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-my-base bg-my-surface-2 p-2">{change.newText ?? '未提供'}</pre>
            </>}
          </div>)}
          {!isAcpPermissionReviewable(review) && <p className="text-my-warning-text">{review?.unavailable ?? '执行引擎未提供可审查的操作内容，请拒绝或停止后核对。'}</p>}
          {review?.details && <InlineDisclosure label="操作详情"><pre className="my-scrollbar mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-my-xs text-my-secondary">{review.details}</pre></InlineDisclosure>}
          <div className="flex flex-wrap gap-2">{p.options.map(option => <Button key={option.optionId} size="sm" variant="outline" disabled={!canRespond || stopping || Boolean(permissionPending[key]) || Boolean(view.blockers.length) || view.historical || !option.kind?.startsWith('reject') && !isAcpPermissionReviewable(review)} onClick={() => void respond(p.requestId, option.optionId)}>{option.name}</Button>)}</div>
          {permissionErrors[key] && <p role="alert" className="text-my-danger-text">{permissionErrors[key]}</p>}
        </fieldset>
      })}
      {entryId && !view.readOnly && <div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" onClick={() => { if (client) { if (inFlight.current || stopping) void readLive(); else void act(() => client.reconcile({ entryId }), true) } }}><RefreshCw size={13} />核对原结果</Button>{(view.canRetry === true || view.canRestart === true) && view.state === 'stopped' && view.cleanupConfirmed && !view.historical && <Button size="sm" variant="ghost" aria-busy={busy} disabled={!writable || loading || Boolean(view.blockers.length)} onClick={() => { if (client) { retryFocus.current = entryId; void act(() => client.retryPrepare({ entryId, ...(view.canRestart ? { afterCompleted: true as const } : {}) })) } }}>{busy ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" /> : <FolderOpen size={13} />}{view.canRestart ? '准备再次执行' : '重新准备'}</Button>}{(starting || !['preparing', 'prepared'].includes(view.state)) && !view.cleanupConfirmed && <Button size="sm" variant="ghost" disabled={stopping} onClick={() => void stop()}><Square size={13} />停止</Button>}</div>}
    </>}
    {(operationError || error) && <p role="alert" className="break-words text-my-xs text-my-danger-text">{operationError || error}</p>}
  </section>
}
