import { useEffect, useRef, useState } from 'react'
import { Activity, CircleAlert, Loader2, Pencil, RefreshCw, Unlink } from 'lucide-react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import type { CruxProgressApi, CruxProgressReportInput, CruxProgressResult, CruxProgressValue } from '@shared/crux-task-progress'
import { cruxProgressReportSchema } from '@shared/crux-task-progress'
import type { TeamTaskProgressState } from '@shared/team-task-progress'
import { api } from '../../../api'
import { confirmDialog } from '../../../components/Dialogs'
import { Button, Modal, Tooltip } from '../../../my/ui'
import { useInteractionActive } from '../../../utils/interaction-scope'
import { memberOf, statusOf, useCrux } from '../../store'
import { Field, inputClass, MemberChip, Select } from '../../ui'
import { taskActorId, useTaskSource } from './use-task-source'
import { useTaskDraft, useTaskDraftField } from './task-drafts'
import { ConnectionPanel } from '../../ConnectionPanel'

const ACTIVITY_LABELS: Record<TeamTaskProgressState, string> = { running: '进行中', waiting_confirmation: '等确认', paused: '已暂停', interrupted: '已中断', idle: '待继续' }
const PROGRESS_FIELDS = ['activity', 'step', 'blocker']
const messageOf = (error: unknown): string => error instanceof Error ? error.message : '进度暂不可用，请重试。'
const time = (at: number): string => new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function TaskProgressPanel({ snapshot, task }: { snapshot: CruxSnapshot; task: CruxTask }): JSX.Element {
  const local = useCrux(state => state.workspaceContext.state === 'local')
  if (local) return <section aria-label="任务执行进度" className="flex flex-wrap items-center gap-2 rounded-my-base border border-my-line p-3 text-my-xs text-my-tertiary">
    <Activity size={15} /><span>连接团队服务后可同步执行动态</span><span className="ml-auto"><ConnectionPanel trigger="connect" /></span>
  </section>
  return <SharedTaskProgressPanel snapshot={snapshot} task={task} />
}

function SharedTaskProgressPanel({ snapshot, task }: { snapshot: CruxSnapshot; task: CruxTask }): JSX.Element {
  const context = useCrux(state => state.workspaceContext)
  const interactive = useInteractionActive()
  const source = useTaskSource({ taskId: task.id, spaceId: task.spaceId })
  const [value, setValue] = useState<CruxProgressValue | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editor, setEditor] = useState(false)
  const [takeover, setTakeover] = useState<CruxProgressReportInput['takeover']>()
  const [refresh, setRefresh] = useState(0)
  const [now, setNow] = useState(Date.now)
  const serial = useRef(0), writing = useRef(false), mutationFailure = useRef(false)
  const client: CruxProgressApi | undefined = api?.cruxProgress
  const actor = taskActorId(snapshot, context)
  const handler = task.workflow?.handlerId ?? task.assigneeIds[0]
  const category = statusOf(snapshot, task.statusId)?.category
  const inactive = Boolean(task.completedAt || task.triagePending || task.workflow?.stage === 'done' || category === 'done' || category === 'cancelled' || !handler)
  const version = JSON.stringify([task.id, task.createdAt, task.updatedAt, task.spaceId, task.workKind, task.workflow?.stage, handler, inactive])
  const [loadedVersion, setLoadedVersion] = useState('')
  const currentValue = version === loadedVersion ? value : null
  const remote = currentValue?.server
  const local = currentValue?.local
  const cleanupRequired = local?.cleanupRequired === true
  const pending = Boolean(local?.pendingCount || local?.outcomeUnknown || currentValue?.freshness === 'pending')
  const offline = context.state === 'offline' || currentValue?.freshness === 'cached-offline'
  const ownsBinding = local?.ownsBinding === true
  const foreignBinding = Boolean(remote?.binding && !ownsBinding)
  const writable = source.available && actor === handler && !inactive && !offline && !snapshot.spaces.find(space => space.id === task.spaceId)?.archived
  const stateLabel = offline ? '离线' : cleanupRequired || local?.errorCode ? '需核对' : pending ? '待同步' : !client || error ? '不可用' : currentValue ? '已同步' : '核对中'
  const query = { workspaceKey: context.key, taskId: task.id }
  const accepts = (reply: CruxProgressValue): boolean => reply.workspaceKey === context.key && reply.taskId === task.id && (!reply.server ||
    reply.server.taskId === task.id && reply.server.spaceId === task.spaceId && (!context.projectId || reply.server.projectId === context.projectId) &&
    (!context.epoch || reply.server.epoch === context.epoch) && (!context.instanceId || reply.server.instanceId === context.instanceId))

  useEffect(() => {
    if (!interactive || !client || !source.available || !handler) return
    let live = true, reading = false
    const read = async (): Promise<void> => {
      if (!live || reading || writing.current || document.visibilityState === 'hidden' || !source.owns()) return
      reading = true
      const ticket = ++serial.current
      setLoading(true)
      try {
        const reply = await client.status(query)
        if (!live || ticket !== serial.current || !source.owns()) return
        if (reply.value && accepts(reply.value)) {
          setValue(reply.value)
          setLoadedVersion(version)
        } else if (reply.ok) throw Error('进度来源已改变，请重新核对。')
        if (!reply.ok) {
          setError(reply.error)
          if (!reply.value) { setValue(null); setLoadedVersion('') }
        } else if (!mutationFailure.current) setError('')
        setNow(Date.now())
      } catch (cause) {
        if (live && ticket === serial.current && source.owns()) setError(messageOf(cause))
      } finally {
        reading = false
        if (live && ticket === serial.current && source.owns()) setLoading(false)
      }
    }
    void read()
    const visible = (): void => { if (document.visibilityState === 'visible') void read() }
    document.addEventListener('visibilitychange', visible)
    const timer = window.setInterval(() => void read(), 15_000)
    return () => { live = false; serial.current++; clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
    // Source objects are render-local; their ownership is immutable for this keyed detail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive, source.available, client, context.key, version, refresh])

  const act = async (call: () => Promise<CruxProgressResult>, allowed = writable): Promise<boolean> => {
    const ticket = source.ticket()
    if (writing.current || !source.canWrite(ticket) || !allowed) return false
    writing.current = true
    serial.current++
    mutationFailure.current = false
    setBusy(true)
    setError('')
    try {
      const result = await call()
      if (!source.owns(ticket)) return false
      if (result.value && accepts(result.value)) { setValue(result.value); setLoadedVersion(version) }
      if (!result.ok) { mutationFailure.current = true; setError(result.error); return false }
      if (!accepts(result.value)) { setError('进度来源已改变，请重新核对。'); return false }
      return true
    } catch (cause) {
      if (source.owns(ticket)) { mutationFailure.current = true; setError(messageOf(cause)) }
      return false
    } finally {
      writing.current = false
      if (source.owns(ticket)) { setBusy(false); setLoading(false); setRefresh(value => value + 1) }
    }
  }
  const detach = async (): Promise<void> => {
    if (!client || !source.canWrite()) return
    const confirmed = await confirmDialog({
      title: '解除任务的进度绑定？', message: '后续摘要不再同步到此任务。任务阶段保持当前状态。',
      confirmText: '解除绑定',
    }, source.signal)
    if (confirmed && source.canWrite()) await act(() => client.detach(query))
  }
  const confirmTakeover = async (): Promise<void> => {
    const binding = remote?.binding
    if (!remote || !binding || !writable || !source.canWrite() || pending) return
    const confirmed = await confirmDialog({
      title: '接管任务进度上报？', message: '上报归属将切换到当前处理人。原设备上的任务执行需要由原设备核对。',
      confirmText: '接管上报',
    }, source.signal)
    if (!confirmed || !source.canWrite()) return
    setTakeover({ expectedGeneration: remote.generation, expectedBindingId: binding.bindingId })
    setEditor(true)
  }
  const stale = Boolean(remote?.progress && remote.serverTime + Math.max(0, Date.now() - now) - remote.progress.updatedAt > 5 * 60_000)
  return <section className="flex min-w-0 flex-col gap-3 rounded-my-base border border-my-line bg-my-layer-1 p-3" aria-label="任务执行进度">
    <header className="flex flex-wrap items-center gap-2"><Activity size={16} className="text-my-icon-secondary" /><h3 className="text-my-sm font-medium text-my-primary">执行动态</h3><span className="my-chip text-my-tertiary" role="status">{stateLabel}</span><span className="flex-1" /><Tooltip label="核对最新进度"><Button size="sm" variant="ghost" aria-label="核对最新进度" disabled={loading || busy || !client || !handler} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} className={loading ? 'animate-spin motion-reduce:animate-none' : undefined} /></Button></Tooltip></header>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-my-xs text-my-secondary"><span>负责人</span><MemberChip member={memberOf(snapshot, handler)} size="md" />{!handler && <span>待安排</span>}{remote?.progress && <><span className="my-chip">{ACTIVITY_LABELS[remote.progress.state]}</span><time dateTime={new Date(remote.progress.updatedAt).toISOString()}>更新 {time(remote.progress.updatedAt)}</time></>}</div>
    {remote?.progress ? <div className="flex flex-col gap-2 text-my-sm"><p className="whitespace-pre-wrap break-words text-my-primary">{remote.progress.step ?? '尚未记录最新步骤'}</p>{remote.progress.blockingReason && <p className="flex items-start gap-2 whitespace-pre-wrap break-words text-my-warning-text"><CircleAlert size={15} className="mt-0.5 shrink-0" /><span>阻塞：{remote.progress.blockingReason}</span></p>}</div> : <p className="text-my-sm text-my-tertiary">{inactive ? '此任务当前没有可更新的执行进度' : !client ? '当前环境暂不支持执行进度' : loading ? '正在核对执行进度…' : '尚未记录执行摘要'}</p>}
    {remote && <p className="text-my-xs text-my-tertiary">最后同步 {time(remote.serverTime)}{stale && ' · 摘要较早，待负责人更新'}{offline && ' · 上次已核对内容'}{pending && ' · 有待核对的记录'}</p>}
    {cleanupRequired && <p role="status" className="my-item-description">原设备执行清理待确认</p>}
    {error && <p role="alert" className="break-words text-my-xs text-my-danger-text">{error}</p>}
    {client && <div className="flex flex-wrap items-center gap-2">
      {foreignBinding && <Button size="sm" variant="outline" disabled={!writable || busy || loading || pending} onClick={() => void confirmTakeover()}><Pencil size={13} />接管上报</Button>}
      <Button size="sm" variant="ghost" disabled={!writable || busy || pending || loading || !currentValue || foreignBinding} onClick={() => setEditor(true)}><Pencil size={13} />更新摘要</Button>
      {cleanupRequired && <Button size="sm" variant="outline" disabled={busy || !source.available} onClick={() => void act(() => client.retry(query), source.available)}><RefreshCw size={13} />核对原清理</Button>}
      {pending && !cleanupRequired && <Button size="sm" variant="outline" disabled={busy || !writable} onClick={() => void act(() => client.retry(query))}><RefreshCw size={13} />重试未同步</Button>}
      {remote?.binding && <Button size="sm" variant="ghost" disabled={!writable || busy || pending || !ownsBinding} onClick={() => void detach()}><Unlink size={13} />解除绑定</Button>}
    </div>}
    {editor && currentValue && client && <ProgressEditor snapshot={snapshot} task={task} value={currentValue} busy={busy} error={error}
      onClose={() => { setEditor(false); setTakeover(undefined) }} onSubmit={async (input, acknowledge) => {
        const ok = await act(() => client.report({ ...query, ...input, ...(takeover ? { takeover } : {}) }))
        if (ok) { acknowledge(); setEditor(false); setTakeover(undefined) }
      }} />}
  </section>
}

function ProgressEditor({ snapshot, task, value, busy, error, onClose, onSubmit }: {
  snapshot: CruxSnapshot; task: CruxTask; value: CruxProgressValue; busy: boolean; error: string
  onClose(): void
  onSubmit(input: { activity: TeamTaskProgressState; step: string | null; blocker: string | null }, acknowledge: () => void): Promise<void>
}): JSX.Element {
  const context = useCrux(state => state.workspaceContext)
  const base = JSON.stringify([value.server?.generation, value.server?.binding?.bindingId, value.server?.progress?.seq, value.local?.inputVersion])
  const draft = useTaskDraft(snapshot, context, { kind: 'progress', spaceId: task.spaceId, task, base })
  const [activity, setActivity] = useTaskDraftField<TeamTaskProgressState>(draft, 'activity', value.server?.progress?.state ?? 'idle')
  const [step, setStep] = useTaskDraftField(draft, 'step', value.server?.progress?.step ?? '')
  const [blocker, setBlocker] = useTaskDraftField(draft, 'blocker', value.server?.progress?.blockingReason ?? '')
  const [validation, setValidation] = useState('')
  const submit = (): void => {
    const parsed = cruxProgressReportSchema.safeParse({ workspaceKey: context.key, taskId: task.id, activity, step: step.trim() || null, blocker: blocker.trim() || null })
    if (!parsed.success) { setValidation('摘要与阻塞各限 500 字，使用单行文字。'); return }
    setValidation('')
    void onSubmit(parsed.data, draft.acknowledge(PROGRESS_FIELDS))
  }
  return <Modal open placement="center" onClose={onClose} ariaLabel="更新执行摘要" width={480}><div className="flex flex-col gap-4 p-5"><h2 className="text-my-lg font-medium text-my-primary">更新执行摘要</h2>
    <Field label="活动状态">
      <Select className="w-full" ariaLabel="活动状态" value={activity} disabled={busy} onChange={val => setActivity(val as TeamTaskProgressState)}
        options={Object.entries(ACTIVITY_LABELS).map(([id, label]) => ({ value: id as TeamTaskProgressState, label }))} />
    </Field>
    <Field label="最新步骤"><input aria-label="最新步骤" className={inputClass} value={step} maxLength={500} disabled={busy} onChange={event => setStep(event.target.value)} /></Field>
    <Field label="阻塞原因（选填）"><input aria-label="阻塞原因" className={inputClass} value={blocker} maxLength={500} disabled={busy} onChange={event => setBlocker(event.target.value)} /></Field>
    {draft.stale && <div role="alert" className="flex flex-col gap-2 text-my-xs text-my-warning-text"><p>执行摘要或绑定已更新，草稿已保留。</p><p>当前：{value.server?.progress?.step ?? '暂无摘要'} · {value.server?.progress?.blockingReason ?? '无阻塞'}</p><Button size="sm" disabled={busy} onClick={draft.review}>已核对，保留草稿</Button></div>}
    {validation && <p role="alert" className="text-my-xs text-my-danger-text">{validation}</p>}
    {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}
    <p className="text-my-xs text-my-tertiary">摘要仅记录执行活动；提交测试与验收仍在任务流程中确认。</p>
    <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={onClose}>暂存并关闭</Button><Button size="sm" variant="primary" disabled={busy || draft.stale} onClick={submit}>{busy && <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />}保存摘要</Button></div>
  </div></Modal>
}
