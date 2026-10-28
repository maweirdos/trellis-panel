import { useEffect, useRef, useState } from 'react'
import { Activity, ArrowUpRight, CircleAlert, Loader2, Pencil, Play, RefreshCw, Unlink } from 'lucide-react'
import type { HifoxSnapshot, HifoxTask } from '@shared/hifox'
import type { HifoxProgressApi, HifoxProgressReportInput, HifoxProgressResult, HifoxProgressValue } from '@shared/hifox-task-progress'
import { hifoxProgressReportSchema } from '@shared/hifox-task-progress'
import type { TeamTaskProgressState } from '@shared/team-task-progress'
import type { AcpAgentStatus } from '@shared/types'
import { api } from '../../../api'
import { confirmDialog } from '../../../components/Dialogs'
import { Button, Modal, Tooltip } from '../../../my/ui'
import { useInteractionActive } from '../../../utils/interaction-scope'
import { memberOf, statusOf, useHifox } from '../../store'
import { Field, inputClass, MemberChip } from '../../ui'
import { taskActorId, useTaskSource } from './use-task-source'
import { useTaskDraft, useTaskDraftField } from './task-drafts'
import { openTaskConversation } from '../../task-conversation'
import { ConnectionPanel } from '../../ConnectionPanel'

const ACTIVITY_LABELS: Record<TeamTaskProgressState, string> = { running: '进行中', waiting_confirmation: '等确认', paused: '已暂停', interrupted: '已中断', idle: '待继续' }
const PROGRESS_FIELDS = ['activity', 'step', 'blocker']
function bridge(): HifoxProgressApi | undefined {
  return api && Object.hasOwn(api, 'hifoxProgress') ? (api as typeof api & { hifoxProgress?: HifoxProgressApi }).hifoxProgress : undefined
}
const nativeBridge = (): boolean => Boolean(api && Object.hasOwn(api, 'hifoxWork') && bridge())
const messageOf = (error: unknown): string => error instanceof Error ? error.message : '进度暂不可用，请重试。'
const time = (at: number): string => new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** A bounded summary over the real primary conversation; formal phase stays in TaskWorkflow. */
export function TaskProgressPanel({ snapshot, task }: { snapshot: HifoxSnapshot; task: HifoxTask }): JSX.Element {
  const local = useHifox((state) => state.workspaceContext.state === 'local')
  return local ? <section aria-label="任务执行进度" className="flex flex-wrap items-center gap-2 rounded-my-lg border border-my-line p-3 text-my-xs text-my-tertiary"><Activity size={15} /><span>连接团队服务后可同步执行动态</span><span className="ml-auto"><ConnectionPanel trigger="connect" /></span></section> : <SharedTaskProgressPanel snapshot={snapshot} task={task} />
}

function SharedTaskProgressPanel({ snapshot, task }: { snapshot: HifoxSnapshot; task: HifoxTask }): JSX.Element {
  const context = useHifox((state) => state.workspaceContext)
  const interactive = useInteractionActive()
  const source = useTaskSource({ taskId: task.id, spaceId: task.spaceId })
  const [value, setValue] = useState<HifoxProgressValue | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [editor, setEditor] = useState(false)
  const [starting, setStarting] = useState(false)
  const [takeover, setTakeover] = useState<HifoxProgressReportInput['takeover']>()
  const [refresh, setRefresh] = useState(0)
  const [now, setNow] = useState(Date.now)
  const serial = useRef(0), writing = useRef(false)
  const mutationFailure = useRef(false)
  const client = bridge()
  const actor = taskActorId(snapshot, context)
  const handler = task.workflow?.handlerId ?? task.assigneeIds[0]
  const category = statusOf(snapshot, task.statusId)?.category
  const inactive = Boolean(task.completedAt || task.triagePending || ['done', 'cancelled'].includes(task.workflow?.stage ?? '') || category === 'done' || category === 'cancelled' || !handler)
  const version = JSON.stringify([task.id, task.createdAt, task.updatedAt, task.spaceId, task.workKind, task.workflow?.stage, handler, inactive])
  const [loadedVersion, setLoadedVersion] = useState('')
  const currentValue = version === loadedVersion && !inactive ? value : null
  const remote = currentValue?.server
  const local = currentValue?.local
  const ownsBinding = nativeBridge() ? local?.ownsBinding === true : Boolean(remote?.binding?.source.kind === 'web' && remote.binding.reporterId === actor)
  const pending = Boolean(local?.pendingCount || local?.outcomeUnknown || currentValue?.freshness === 'pending')
  const offline = context.state === 'offline' || currentValue?.freshness === 'cached-offline'
  const conflict = Boolean(errorCode.includes('CONFLICT') || local?.errorCode?.includes('CONFLICT') || errorCode.includes('EPOCH'))
  const unavailable = !client || inactive || Boolean(error)
  const writable = source.available && actor === handler && !inactive && !offline && !snapshot.spaces.find((space) => space.id === task.spaceId)?.archived
  const stateLabel = conflict ? '需核对' : offline ? '离线' : pending ? '待同步' : unavailable ? '不可用' : currentValue ? '已同步' : '核对中'
  const query = { workspaceKey: context.key, taskId: task.id }
  const accepts = (reply: HifoxProgressValue): boolean => reply.workspaceKey === context.key && reply.taskId === task.id && (!reply.server || reply.server.taskId === task.id && reply.server.spaceId === task.spaceId && (!context.projectId || reply.server.projectId === context.projectId) && (!context.epoch || reply.server.epoch === context.epoch) && (!context.instanceId || reply.server.instanceId === context.instanceId))

  useEffect(() => {
    if (!interactive || inactive || !client || !source.available) return
    let live = true, reading = false
    const read = async (): Promise<void> => {
      if (!live || reading || writing.current || document.visibilityState === 'hidden' || !source.owns()) return
      reading = true
      const ticket = ++serial.current
      setLoading(true)
      try {
        const reply = await client.status(query)
        if (!live || ticket !== serial.current || !source.owns()) return
        if (reply.value && accepts(reply.value)) { setValue(reply.value); setLoadedVersion(version) }
        else if (reply.ok) throw Error('进度来源已改变，请重新核对。')
        if (!reply.ok) { setError(reply.error); setErrorCode(reply.code); if (!reply.value) { setValue(null); setLoadedVersion('') } }
        else if (!mutationFailure.current) { setError(''); setErrorCode('') }
        setNow(Date.now())
      } catch (cause) {
        if (live && ticket === serial.current && source.owns()) { setError(messageOf(cause)); setErrorCode('UNAVAILABLE') }
      } finally { reading = false; if (live && ticket === serial.current && source.owns()) setLoading(false) }
    }
    void read()
    const visible = (): void => { if (document.visibilityState === 'visible') void read() }
    document.addEventListener('visibilitychange', visible)
    const timer = window.setInterval(() => void read(), 15_000)
    return () => { live = false; serial.current++; clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
    // Source objects are render-local; their ownership is immutable for this keyed detail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive, source.available, client, context.key, version, refresh])

  const act = async (call: () => Promise<HifoxProgressResult>): Promise<boolean> => {
    const ticket = source.ticket()
    if (writing.current || !source.canWrite(ticket) || !writable) return false
    writing.current = true; serial.current++; mutationFailure.current = false; setBusy(true); setError(''); setErrorCode('')
    try {
      const result = await call()
      if (!source.owns(ticket)) return false
      if (result.value && accepts(result.value)) { setValue(result.value); setLoadedVersion(version) }
      if (!result.ok) { mutationFailure.current = true; setError(result.error); setErrorCode(result.code); return false }
      if (!accepts(result.value)) { setError('进度来源已改变，请重新核对。'); return false }
      return true
    } catch (cause) { if (source.owns(ticket)) { mutationFailure.current = true; setError(messageOf(cause)) }; return false }
    finally { writing.current = false; if (source.owns(ticket)) { setBusy(false); setLoading(false); setRefresh((value) => value + 1) } }
  }
  const detach = async (): Promise<void> => {
    if (!client || !source.canWrite()) return
    const confirmed = await confirmDialog({ title: '解除任务的主要会话绑定？', message: '后续摘要不再同步到此任务。会话和运行记录保留，正式任务阶段保持当前状态。', confirmText: '解除绑定' }, source.signal)
    if (confirmed && source.canWrite()) await act(() => client.detach(query))
  }
  const continueSession = async (): Promise<void> => {
    if (!local?.session || !source.owns()) return
    try { await openTaskConversation(query.workspaceKey, task, local.session, !ownsBinding) }
    catch (cause) { if (source.owns()) setError(messageOf(cause)) }
  }
  const canStartCode = task.workKind === 'general' || ['planning', 'developing'].includes(task.workflow?.stage ?? '')
  const foreignBinding = Boolean(remote?.binding && !ownsBinding)
  const restart = nativeBridge() && Boolean(local && ['stopped', 'detached'].includes(local.state))
  const manualStart = nativeBridge() && ownsBinding && !local?.session
  const confirmTakeover = async (start: boolean): Promise<void> => {
    const binding = remote?.binding
    if (!remote || !writable || !source.canWrite()) return
    const confirmed = await confirmDialog({ title: restart && !binding ? '重新绑定并启动主要会话？' : manualStart ? '绑定并启动主要会话？' : start ? '接管并启动主要会话？' : '接管任务进度上报？', message: '这会切换此任务的主要上报归属，旧绑定将失效。旧设备上的进程不保证停止，请确认没有重复执行的风险。', confirmText: start ? '确认绑定并启动' : '接管上报' }, source.signal)
    if (!confirmed || !source.canWrite()) return
    setTakeover({ expectedGeneration: remote.generation, expectedBindingId: binding?.bindingId ?? null })
    if (start) setStarting(true)
    else setEditor(true)
  }
  const stale = Boolean(remote?.progress && (remote.serverTime + Math.max(0, Date.now() - now) - remote.progress.updatedAt > 5 * 60_000))
  return <section className="flex min-w-0 flex-col gap-3 rounded-my-lg border border-my-line bg-my-layer-1 p-3" aria-label="任务执行进度">
    <header className="flex flex-wrap items-center gap-2"><Activity size={16} className="text-my-icon-secondary" /><h3 className="text-my-sm font-medium text-my-primary">执行动态</h3><span className="my-chip text-my-tertiary" role="status">{stateLabel}</span><span className="flex-1" /><Tooltip label="核对最新进度"><Button size="sm" variant="ghost" aria-label="核对最新进度" disabled={loading || busy || !client || inactive} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></Button></Tooltip></header>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-my-xs text-my-secondary"><span>负责人</span><MemberChip member={memberOf(snapshot, handler)} size="md" />{!handler && <span>待安排</span>}{remote?.progress && <><span className="my-chip">{ACTIVITY_LABELS[remote.progress.state]}</span><time dateTime={new Date(remote.progress.updatedAt).toISOString()}>更新 {time(remote.progress.updatedAt)}</time></>}</div>
    {remote?.progress ? <div className="flex flex-col gap-2 text-my-sm"><p className="whitespace-pre-wrap break-words text-my-primary">{remote.progress.step ?? '尚未记录最新步骤'}</p>{remote.progress.blockingReason && <p className="flex items-start gap-2 whitespace-pre-wrap break-words text-my-warning-text"><CircleAlert size={15} className="mt-0.5 shrink-0" /><span>阻塞：{remote.progress.blockingReason}</span></p>}</div> : <p className="text-my-sm text-my-tertiary">{inactive ? '此任务当前没有可更新的执行进度' : !client ? '当前环境暂不支持执行进度' : loading ? '正在核对执行进度…' : '尚未记录执行摘要'}</p>}
    {remote && <p className="text-my-xs text-my-tertiary">最后同步 {time(remote.serverTime)}{stale && ' · 摘要较早，待负责人更新'}{offline && ' · 上次已核对内容'}{pending && ' · 新结果待同步'}</p>}
    {local?.session ? <div className="flex flex-wrap items-center gap-2 border-t border-my-line pt-2 text-my-xs text-my-secondary"><span>{ownsBinding ? '主要会话' : '原会话 · 只读'}</span><span className="my-chip">{local.session.engine === 'pi' ? 'Pi' : 'ACP'}</span><code className="min-w-0 truncate" title={local.session.sessionId}>{local.session.sessionId}</code><Button size="sm" variant="ghost" disabled={busy || !nativeBridge()} onClick={() => void continueSession()}><ArrowUpRight size={13} />{ownsBinding ? '在 Agent 继续' : '查看原会话'}</Button>{local.dispatch === 'unknown' && <span role="status" className="text-my-warning-text">首次发送结果未确认，请先查看原会话</span>}</div> : remote?.binding && <p className="text-my-xs text-my-tertiary">{ownsBinding && nativeBridge() ? '人工进度 · 本机上报' : remote.binding.source.kind === 'desktop' ? `主要会话 · ${remote.binding.source.engine} · ${remote.binding.source.directoryName}（其他设备）` : '人工进度 · 网页上报'}</p>}
    {error && !inactive && <p role="alert" className="break-words text-my-xs text-my-danger-text">{error}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {nativeBridge() && !local?.session && !remote?.binding && !restart && <Button size="sm" variant="outline" disabled={!writable || busy || loading || pending || !currentValue || !canStartCode} onClick={() => setStarting(true)}><Play size={13} />启动 Agent</Button>}
      {(restart || manualStart) && !foreignBinding && <Button size="sm" variant="outline" disabled={!writable || busy || loading || pending || !currentValue || !canStartCode} onClick={() => void confirmTakeover(true)}><Play size={13} />{restart ? '重新绑定并启动' : '绑定并启动主要会话'}</Button>}
      {foreignBinding && <>{nativeBridge() && <Button size="sm" variant="outline" disabled={!writable || busy || loading || pending || !canStartCode} onClick={() => void confirmTakeover(true)}><Play size={13} />接管并启动</Button>}<Button size="sm" variant="outline" disabled={!writable || busy || loading || pending} onClick={() => void confirmTakeover(false)}><Pencil size={13} />接管上报</Button></>}
      <Button size="sm" variant="ghost" disabled={!writable || busy || pending || loading || !currentValue || foreignBinding} onClick={() => setEditor(true)}><Pencil size={13} />更新摘要</Button>
      {pending && client && <Button size="sm" variant="outline" disabled={busy || !writable} onClick={() => void act(() => client.retry(query))}><RefreshCw size={13} />重试未同步</Button>}
      {remote?.binding && client && <Button size="sm" variant="ghost" disabled={!writable || busy || pending || !ownsBinding} onClick={() => void detach()}><Unlink size={13} />解除绑定</Button>}
    </div>
    {nativeBridge() && !canStartCode && !inactive && <p className="text-my-xs text-my-tertiary">先在任务流程中开始处理，准备并审阅代码任务材料。</p>}
    {!nativeBridge() && <p className="text-my-xs text-my-tertiary">Agent 执行与主要会话续接需要桌面端。</p>}
    {editor && currentValue && client && <ProgressEditor snapshot={snapshot} task={task} value={currentValue} busy={busy} error={error} onClose={() => { setEditor(false); setTakeover(undefined) }} onSubmit={async (input, acknowledge) => { const ok = await act(() => client.report({ ...query, ...input, ...(takeover ? { takeover } : {}) })); if (ok) { acknowledge(); setEditor(false); setTakeover(undefined) } }} />}
    {starting && client && <StartAgentDialog busy={busy} failure={error} onClose={() => { setStarting(false); setTakeover(undefined) }} onStart={async (engine, agentId) => { if (await act(() => client.start({ ...query, engine, ...(agentId ? { agentId } : {}), ...(takeover ? { takeover } : {}) }))) { setStarting(false); setTakeover(undefined) } }} />}
  </section>
}

function ProgressEditor({ snapshot, task, value, busy, error, onClose, onSubmit }: { snapshot: HifoxSnapshot; task: HifoxTask; value: HifoxProgressValue; busy: boolean; error: string; onClose(): void; onSubmit(input: { activity: TeamTaskProgressState; step: string | null; blocker: string | null }, acknowledge: () => void): Promise<void> }): JSX.Element {
  const context = useHifox((state) => state.workspaceContext)
  const base = JSON.stringify([value.server?.generation, value.server?.binding?.bindingId, value.server?.progress?.seq, value.local?.inputVersion])
  const draft = useTaskDraft(snapshot, context, { kind: 'progress', spaceId: task.spaceId, task, base })
  const [activity, setActivity] = useTaskDraftField<TeamTaskProgressState>(draft, 'activity', value.server?.progress?.state ?? 'idle')
  const [step, setStep] = useTaskDraftField(draft, 'step', value.server?.progress?.step ?? '')
  const [blocker, setBlocker] = useTaskDraftField(draft, 'blocker', value.server?.progress?.blockingReason ?? '')
  const [validation, setValidation] = useState('')
  const submit = (): void => {
    const parsed = hifoxProgressReportSchema.safeParse({ workspaceKey: context.key, taskId: task.id, activity, step: step.trim() || null, blocker: blocker.trim() || null })
    if (!parsed.success) { setValidation('摘要与阻塞各限 500 字，使用单行文字。'); return }
    setValidation('')
    void onSubmit(parsed.data, draft.acknowledge(PROGRESS_FIELDS))
  }
  return <Modal open onClose={onClose} ariaLabel="更新执行摘要" width={480}><div className="flex flex-col gap-4 p-5"><h2 className="text-my-lg font-semibold text-my-primary">更新执行摘要</h2>
    <Field label="活动状态"><select aria-label="活动状态" className={inputClass} value={activity} disabled={busy} onChange={(event) => setActivity(event.target.value as TeamTaskProgressState)}>{Object.entries(ACTIVITY_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
    <Field label="最新步骤"><input aria-label="最新步骤" className={inputClass} value={step} maxLength={500} disabled={busy} onChange={(event) => setStep(event.target.value)} /></Field>
    <Field label="阻塞原因（选填）"><input aria-label="阻塞原因" className={inputClass} value={blocker} maxLength={500} disabled={busy} onChange={(event) => setBlocker(event.target.value)} /></Field>
    {draft.stale && <div role="alert" className="flex flex-col gap-2 text-my-xs text-my-warning-text"><p>执行摘要或绑定已更新，草稿已保留。</p><p>当前：{value.server?.progress?.step ?? '暂无摘要'} · {value.server?.progress?.blockingReason ?? '无阻塞'}</p><Button size="sm" disabled={busy} onClick={draft.review}>已核对，保留草稿</Button></div>}
    {validation && <p role="alert" className="text-my-xs text-my-danger-text">{validation}</p>}
    {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}
    <p className="text-my-xs text-my-tertiary">摘要仅记录执行活动；提交测试与验收仍在任务流程中确认。</p>
    <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={onClose}>暂存并关闭</Button><Button size="sm" variant="primary" disabled={busy || draft.stale} onClick={submit}>{busy && <Loader2 size={13} className="animate-spin" />}保存摘要</Button></div>
  </div></Modal>
}

function StartAgentDialog({ busy, failure, onClose, onStart }: { busy: boolean; failure: string; onClose(): void; onStart(engine: 'pi' | 'acp', agentId?: string): Promise<void> }): JSX.Element {
  const [engine, setEngine] = useState<'pi' | 'acp'>('pi')
  const [agents, setAgents] = useState<AcpAgentStatus[]>([])
  const [agentId, setAgentId] = useState('')
  const [error, setError] = useState('')
  const active = useInteractionActive()
  useEffect(() => {
    if (!active || engine !== 'acp') return
    let live = true
    void api.acpAgents().then((reply) => { if (!live) return; if (!reply.ok) { setError(reply.error ?? '读取 ACP 引擎失败'); return }; setAgents(reply.agents ?? []) }).catch((cause) => { if (live) setError(messageOf(cause)) })
    return () => { live = false }
  }, [active, engine])
  return <Modal open onClose={onClose} ariaLabel="启动任务 Agent" width={480}><div className="flex flex-col gap-4 p-5"><h2 className="text-my-lg font-semibold text-my-primary">启动任务 Agent</h2><Field label="执行引擎"><select className={inputClass} value={engine} disabled={busy} onChange={(event) => setEngine(event.target.value as 'pi' | 'acp')}><option value="pi">Pi</option><option value="acp">ACP</option></select></Field>{engine === 'acp' && <Field label="本机 ACP 引擎"><select className={inputClass} value={agentId} disabled={busy} onChange={(event) => setAgentId(event.target.value)}><option value="">选择已安装引擎</option>{agents.map((agent) => <option key={agent.id} value={agent.id} disabled={!agent.enabled || !agent.available}>{agent.name}{!agent.available ? ' · 不可用' : ''}</option>)}</select></Field>}{(error || failure) && <p role="alert" className="text-my-xs text-my-danger-text">{error || failure}</p>}<div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={onClose}>取消</Button><Button size="sm" variant="primary" disabled={busy || engine === 'acp' && !agentId} onClick={() => void onStart(engine, engine === 'acp' ? agentId : undefined)}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}启动并绑定主要会话</Button></div></div></Modal>
}
