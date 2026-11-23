import { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react'
import { ArrowRight, ArrowRightLeft, ChevronDown, Folder, Loader2, RefreshCw, X } from 'lucide-react'
import { api } from '../api'
import { Button, Dropdown, DropdownItem, Modal } from '../my/ui'
import { useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { RuntimeMark } from './RuntimePicker'
import { handoffRequest, readRuntimeHandoffDraft, runtimeHandoffSourceKey, writeRuntimeHandoffDraft, type RuntimeHandoffDraft } from './runtime-handoff-state'
import { acpHandoffContextSchema, type AcpHandoffOperation, type AcpHandoffPreview } from '../../../shared/acp-handoff'
import type { AcpAgentStatus, AcpSessionRecord } from '../../../shared/types'
import { IpcErrorCode } from '../../../shared/ipc-errors'

const errorText = (error: unknown): string => error instanceof Error ? error.message : '请求失败，请重试。'
const POLL_LIMIT = 12
const POLL_INTERVAL_MS = 1500

export function RuntimeHandoffDialog({ root, source, agents, sourceIssue, isCurrent, onRefreshAgents, onReady, onChanged, onClose }: {
  root: string
  source: AcpSessionRecord
  agents: AcpAgentStatus[]
  sourceIssue?: string
  isCurrent: () => boolean
  onRefreshAgents: () => void
  onReady: (operation: AcpHandoffOperation) => Promise<void>
  onChanged: () => void
  onClose: () => void
}): JSX.Element {
  const canInteract = useInteractionGuard()
  const signal = useInteractionSignal()
  const contextId = useId()
  const [draft, setDraft] = useState(() => readRuntimeHandoffDraft(root, source.sessionId))
  const draftRef = useRef(draft)
  const [preview, setPreview] = useState<{ value: AcpHandoffPreview; owner: string; target: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewRevision, setPreviewRevision] = useState(0)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<'create' | 'cancel' | 'status' | 'navigate' | null>(null)
  const [paused, setPaused] = useState(false)
  const [pollRevision, setPollRevision] = useState(0)
  const [verifiedOperationId, setVerifiedOperationId] = useState<string | null>(null)
  const [foreground, setForeground] = useState(document.visibilityState !== 'hidden')
  const panelRef = useRef<HTMLDivElement>(null)
  const [submittedHeight, setSubmittedHeight] = useState<number>()
  const lock = useRef(false)
  const live = useRef(true)
  const previewSerial = useRef(0)
  const navigationTried = useRef<string | null>(null)
  const owner = runtimeHandoffSourceKey(source)
  const latest = useRef({ owner, sourceIssue, isCurrent, onReady, onChanged, canInteract, signal })
  latest.current = { owner, sourceIssue, isCurrent, onReady, onChanged, canInteract, signal }
  const current = useCallback((): boolean => live.current && latest.current.isCurrent() && latest.current.canInteract() && !latest.current.signal?.aborted, [])
  const sourceRuntime = source.runtimeSnapshot?.id ?? source.agentId
  const targets = agents.filter((agent) => agent.enabled && agent.available && !agent.setupRequired && agent.health === 'ready' && (agent.runtimeId ?? agent.id) !== sourceRuntime)
  const target = targets.find((agent) => (agent.runtimeId ?? agent.id) === draft.targetRuntimeId)
  const attempt = draft.attempt
  const operation = draft.operation
  const operationVerified = Boolean(operation && operation.id === verifiedOperationId)
  const usablePreview = preview?.owner === owner && preview.target === draft.targetRuntimeId && !sourceIssue && target ? preview.value : null
  const context = draft.context ?? usablePreview?.context ?? ''
  const contextBytes = new TextEncoder().encode(context).length
  const needsSummary = usablePreview?.latestTurnIncluded === false
  const summaryEdited = Boolean(usablePreview && context.trim() !== usablePreview.context.trim())
  const contextValid = acpHandoffContextSchema.safeParse(context).success && (!needsSummary || summaryEdited)
  const terminal = operationVerified && operation && ['failed', 'cancelled', 'sent'].includes(operation.state)

  const save = useCallback((next: RuntimeHandoffDraft): void => {
    draftRef.current = next
    writeRuntimeHandoffDraft(root, source.sessionId, next)
    setDraft(next)
  }, [root, source.sessionId])

  useEffect(() => {
    live.current = true
    const visibility = (): void => setForeground(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', visibility)
    return () => { live.current = false; previewSerial.current++; document.removeEventListener('visibilitychange', visibility) }
  }, [])

  useEffect(() => {
    if (attempt || target || !targets.length) return
    save({ ...draftRef.current, targetRuntimeId: targets[0].runtimeId ?? targets[0].id })
  }, [attempt, target, targets, save])

  useEffect(() => {
    const serial = ++previewSerial.current
    setPreview(null)
    setPreviewLoading(false)
    if (attempt || !target || sourceIssue || !current()) return
    let valid = true
    const targetRuntimeId = target.runtimeId ?? target.id
    setPreviewLoading(true); setError('')
    void handoffRequest(api.acpSessionHandoffPreview(source.sessionId, { targetRuntimeId })).then((result) => {
      if (!valid || !current() || serial !== previewSerial.current || latest.current.owner !== owner || latest.current.sourceIssue) return
      if (!result.ok) throw Error(result.error)
      if (result.preview.source.sessionId !== source.sessionId || result.preview.target.runtimeId !== targetRuntimeId) throw Error('接续预览与当前选择不一致，请重新预览。')
      setPreview({ value: result.preview, owner, target: targetRuntimeId })
    }).catch((reason) => { if (valid && current() && serial === previewSerial.current) setError(errorText(reason)) })
      .finally(() => { if (valid && current() && serial === previewSerial.current) setPreviewLoading(false) })
    return () => { valid = false }
  }, [owner, source.sessionId, sourceIssue, target?.runtimeId, target?.id, attempt, previewRevision, current])

  const accept = useCallback((next: AcpHandoffOperation): void => {
    const saved = draftRef.current
    if (!saved.attempt || next.id !== saved.attempt.operationId || next.sourceSessionId !== source.sessionId || next.targetRuntimeId !== saved.attempt.targetRuntimeId) throw Error('接续状态与当前会话不一致，请重新检查。')
    save({ ...saved, operation: next, rejected: undefined })
    setVerifiedOperationId(next.id)
    latest.current.onChanged()
  }, [save, source.sessionId])

  const readStatus = useCallback(async (explicit = false): Promise<boolean> => {
    const saved = draftRef.current.attempt
    if (!saved || lock.current || !current()) return true
    lock.current = true
    if (explicit) setPending('status')
    try {
      const result = await handoffRequest(api.acpSessionHandoffStatus(source.sessionId, saved.operationId))
      if (!current() || saved.operationId !== draftRef.current.attempt?.operationId) return false
      if (!result.ok) throw Error(result.error)
      accept(result.operation); setError('')
      return result.operation.state === 'creating'
    } catch (reason) { if (current()) { setError(errorText(reason)); setPaused(true) }; return false }
    finally { lock.current = false; if (current() && explicit) setPending(null) }
  }, [accept, current, source.sessionId])

  // Read-only, bounded foreground monitoring. Creation is always an explicit action.
  useEffect(() => {
    if (!attempt || draft.rejected || (operationVerified && operation && operation.state !== 'creating') || !foreground || paused) return
    let valid = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let polls = 0
    const poll = async (): Promise<void> => {
      if (!valid || !current()) return
      if (lock.current) { timer = setTimeout(() => void poll(), POLL_INTERVAL_MS); return }
      const again = await readStatus()
      if (!valid || !current() || !again) return
      if (++polls >= POLL_LIMIT) { setPaused(true); return }
      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS)
    }
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS)
    return () => { valid = false; clearTimeout(timer) }
  }, [attempt?.operationId, draft.rejected, operation?.state, operationVerified, foreground, paused, pollRevision, current, readStatus])

  const openTarget = useCallback(async (next: AcpHandoffOperation): Promise<void> => {
    if (!current() || lock.current || !next.targetSessionId || !['ready', 'sent'].includes(next.state)) return
    lock.current = true; setPending('navigate')
    try { await latest.current.onReady(next) }
    catch (reason) { if (current()) setError(errorText(reason)) }
    finally { lock.current = false; if (current()) setPending(null) }
  }, [current])

  useEffect(() => {
    if (!foreground || !operationVerified || !operation || !['ready', 'sent'].includes(operation.state) || !operation.targetSessionId || pending || navigationTried.current === operation.id) return
    navigationTried.current = operation.id
    void openTarget(operation)
  }, [operation, operationVerified, pending, foreground, openTarget])

  const create = async (retry = false): Promise<void> => {
    if (!current() || lock.current) return
    const saved = draftRef.current
    if (!retry && (!usablePreview || !contextValid || contextBytes > usablePreview.contextByteLimit || saved.attempt)) return
    const submitted = retry ? saved.attempt : usablePreview && { operationId: crypto.randomUUID(), previewId: usablePreview.id, context, targetRuntimeId: usablePreview.target.runtimeId }
    if (!submitted) return
    setSubmittedHeight(panelRef.current?.getBoundingClientRect().height)
    lock.current = true; setPending('create'); setError(''); setPaused(false)
    // Persist the immutable retry payload before crossing IPC, even if the result is lost.
    save({ ...saved, attempt: submitted, rejected: undefined })
    try {
      const result = await handoffRequest(api.acpSessionHandoffCreate(source.sessionId, { operationId: submitted.operationId, previewId: submitted.previewId, context: submitted.context }))
      if (!current()) return
      if (!result.ok) {
        if (result.code === IpcErrorCode.Conflict || result.code === IpcErrorCode.InvalidArg) save({ ...draftRef.current, context: draftRef.current.context ?? submitted.context, rejected: true })
        throw Error(result.error)
      }
      accept(result.operation)
    } catch (reason) { if (current()) { setError(errorText(reason)); setPaused(true) } }
    finally { lock.current = false; if (current()) setPending(null) }
  }

  const cancel = async (): Promise<void> => {
    const saved = draftRef.current.attempt
    if (!saved || !current() || lock.current) return
    lock.current = true; setPending('cancel'); setError('')
    try {
      const result = await handoffRequest(api.acpSessionHandoffCancel(source.sessionId, { operationId: saved.operationId }))
      if (!current()) return
      if (!result.ok) throw Error(result.error)
      accept(result.operation)
      if (result.operation.state !== 'cancelled') setError(result.operation.state === 'sent' ? '接续内容已发送，无法取消。' : '取消结果尚未确认，请检查状态。')
    } catch (reason) { if (current()) { setError(errorText(reason)); setPaused(true) } }
    finally { lock.current = false; if (current()) setPending(null) }
  }

  const check = (): void => { setPaused(false); setPollRevision((value) => value + 1); void readStatus(true) }
  const restart = (): void => {
    if ((!terminal && !draft.rejected) || lock.current) return
    navigationTried.current = null; setVerifiedOperationId(null); setSubmittedHeight(undefined); setError(''); setPaused(false)
    save({ targetRuntimeId: draft.targetRuntimeId, context: draft.context })
    setPreviewRevision((value) => value + 1)
  }
  const checkpoint = usablePreview?.source
  const status = draft.rejected ? '接续请求未被接纳，内容未发送' : !operationVerified ? paused ? '接续结果待确认' : pending === 'create' ? '正在准备接续会话…' : '正在核对接续状态…'
    : operation?.state === 'sent' ? '接续内容已发送'
    : operation?.state === 'ready' ? '接续会话已就绪，内容尚未发送'
      : operation?.state === 'cancelled' ? '接续已取消，内容未发送'
        : operation?.state === 'failed' ? '接续未完成'
          : paused ? '接续结果待确认' : '正在准备接续会话…'

  return <Modal open ariaLabel="用另一个 Runtime 接续" width={720} onClose={onClose}>
    <div ref={panelRef} className="acp-handoff-dialog" style={submittedHeight ? { height: submittedHeight } : undefined}>
      <header className="flex shrink-0 items-start gap-3 border-b border-my-line px-5 py-4">
        <ArrowRightLeft size={18} className="mt-1 shrink-0 text-my-secondary" aria-hidden="true" />
        <div className="min-w-0 flex-1"><h2 className="text-my-lg font-semibold">用另一个 Runtime 接续</h2><p className="mt-1 text-my-sm text-my-secondary">建立关联的新对话，保留原始消息。</p></div>
        <Button size="sm" variant="ghost" aria-label={attempt ? '返回对话，保留接续状态' : '关闭接续预览'} onClick={onClose}><X size={16} /></Button>
      </header>
      <div className="acp-handoff-body my-scrollbar space-y-4 px-5 py-4">
        <section className="space-y-2" aria-label="接续来源">
          <p className="text-my-xs text-my-tertiary">来源对话</p>
          <p className="break-words text-my-sm font-medium">{checkpoint?.title ?? source.title ?? source.profileSnapshot?.name ?? source.agentName}</p>
          <div className="flex flex-wrap items-center gap-2 text-my-sm text-my-secondary"><RuntimeMark runtimeId={sourceRuntime} /><span>{checkpoint?.runtimeName ?? source.runtimeSnapshot?.name ?? source.agentName}</span><ArrowRight size={14} aria-hidden="true" />
            <Dropdown align="left" trigger={({ open, toggle }) => <button type="button" className="acp-runtime-trigger" aria-label="目标 Runtime" aria-expanded={open} disabled={!!attempt || !targets.length} onClick={toggle}><RuntimeMark runtimeId={draft.targetRuntimeId} /><span>{target?.name ?? (attempt ? agents.find((agent) => (agent.runtimeId ?? agent.id) === attempt.targetRuntimeId)?.name ?? attempt.targetRuntimeId : '选择 Runtime')}</span><ChevronDown size={13} /></button>}>
              {(close) => <>{targets.map((agent) => <DropdownItem key={agent.id} icon={<RuntimeMark runtimeId={agent.runtimeId ?? agent.id} />} selected={(agent.runtimeId ?? agent.id) === draft.targetRuntimeId} onClick={() => { save({ ...draftRef.current, targetRuntimeId: agent.runtimeId ?? agent.id }); close() }}>{agent.name}</DropdownItem>)}</>}
            </Dropdown>
          </div>
          {checkpoint && <p className="text-my-xs text-my-tertiary">接续检查点 · 记录 {checkpoint.checkpointSeq} · 已完成并保存的回合</p>}
        </section>
        {!attempt && !targets.length && <div className="rounded-my-md border border-my-line p-3 text-my-sm"><p>没有其他已就绪的 Runtime。</p><Button size="sm" variant="ghost" className="mt-2" onClick={onRefreshAgents}><RefreshCw size={13} />刷新 Runtime</Button></div>}
        {!attempt && sourceIssue && <p role="status" className="text-my-sm text-my-warning-text">{sourceIssue}</p>}
        {previewLoading && <p role="status" className="flex items-center gap-2 text-my-sm text-my-secondary"><Loader2 size={14} className="acp-progress-spinner" />正在准备接续预览…</p>}
        {usablePreview && !attempt && <>
          <div className="flex items-start gap-2 rounded-my-md bg-my-layer-1 p-3 text-my-sm text-my-secondary"><Folder size={14} className="mt-1 shrink-0" aria-hidden="true" /><div className="min-w-0"><p className="text-my-xs text-my-tertiary">工作目录</p><p className="mt-1 break-all">{usablePreview.cwd}</p></div></div>
          <div className="space-y-1 text-my-sm text-my-secondary" aria-label="接续范围"><p>摘录 {usablePreview.includedMessages} 条已保存消息{usablePreview.omittedMessages > 0 ? ` · 省略 ${usablePreview.omittedMessages} 条` : ''}{usablePreview.truncated ? ' · 内容已缩减' : ''}</p><p>{usablePreview.coverage === 'complete' ? '来源历史保存完整' : usablePreview.coverage === 'partial' ? '仅有部分历史，完整范围未确认' : '历史完整性尚无法确认'}</p>{(usablePreview.attachments > 0 || usablePreview.toolCalls > 0) && <p className="text-my-xs text-my-secondary">{[usablePreview.attachments > 0 ? `${usablePreview.attachments} 个附件` : '', usablePreview.toolCalls > 0 ? `${usablePreview.toolCalls} 次工具调用` : ''].filter(Boolean).join('、')}的正文保留在来源对话。请补充关键结果{usablePreview.attachments > 0 ? '，并在新对话重新添加需要的图片' : ''}。</p>}</div>
          {source.profileSnapshot && <details className="text-my-sm text-my-secondary"><summary className="cursor-pointer">角色 · {source.profileSnapshot.name}{source.profileSnapshot.skillPaths?.length ? ` · ${source.profileSnapshot.skillPaths.length} 项项目技能` : ''}</summary><pre className="mt-2 whitespace-pre-wrap break-words font-sans">{source.profileSnapshot.instructions || '未配置额外角色指令'}</pre>{source.profileSnapshot.skillPaths?.map((path) => <p key={path} className="mt-1 break-all text-my-xs text-my-tertiary">{path}</p>)}</details>}
          <div><div className="mb-2 flex flex-wrap items-center gap-2"><label htmlFor={contextId} className="min-w-0 flex-1 text-my-sm font-medium">交接内容</label>{draft.context !== undefined && <Button size="sm" variant="ghost" onClick={() => save({ ...draftRef.current, context: undefined })}>恢复预览内容</Button>}</div><p className="mb-2 text-my-xs text-my-tertiary">已保存对话摘录，可补充角色要求与接下来要做的事。</p>
            {needsSummary && <p id={`${contextId}-warning`} role="alert" className="mb-2 text-my-sm text-my-warning-text">最近一轮内容过大，未包含在摘录中；请补充交接摘要</p>}
            <textarea id={contextId} className="my-input acp-handoff-context my-scrollbar" rows={8} maxLength={usablePreview.contextByteLimit * 2} value={context} onChange={(event) => save({ ...draftRef.current, context: event.target.value })} aria-invalid={needsSummary && !summaryEdited || contextBytes > usablePreview.contextByteLimit || undefined} aria-describedby={`${contextId}-size${needsSummary ? ` ${contextId}-warning` : ''}`} />
            <p id={`${contextId}-size`} className={`mt-2 text-my-xs ${contextBytes > usablePreview.contextByteLimit || !context.trim() ? 'text-my-danger-text' : 'text-my-tertiary'}`}>{contextBytes.toLocaleString()} / {usablePreview.contextByteLimit.toLocaleString()} 字节{draft.context !== undefined ? ' · 已保留编辑内容' : ''}</p>
          </div>
        </>}
        {attempt && <section className="space-y-3 rounded-my-md border border-my-line p-3" aria-label="接续进度"><p role="status" className="flex items-center gap-2 text-my-sm font-medium">{!terminal && operation?.state !== 'ready' && !paused && <Loader2 size={14} className="acp-progress-spinner" aria-hidden="true" />}{status}</p>{operation?.error && <p className="break-words text-my-sm text-my-danger-text">{operation.error}</p>}<details className="text-my-sm text-my-secondary"><summary className="cursor-pointer">查看保留的接续内容</summary><pre className="mt-2 whitespace-pre-wrap break-words font-sans">{attempt.context}</pre></details>{!terminal && <p className="text-my-xs text-my-tertiary">关闭窗口后可从会话菜单查看进度。取消接续需点击“取消接续”。</p>}</section>}
        {error && <div role="alert" className="space-y-2 rounded-my-md border border-my-line p-3 text-my-sm"><p className="text-my-danger-text">{error}</p>{attempt && !operation && <p className="text-my-secondary">创建结果尚未确认。可检查状态，或重试同一次接续。</p>}{!attempt && <Button size="sm" variant="outline" disabled={previewLoading || !!sourceIssue || !target} onClick={() => setPreviewRevision((value) => value + 1)}>重新预览</Button>}</div>}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-my-line px-5 py-3">
        {!attempt && <p className="min-w-0 flex-1 text-my-xs text-my-secondary">接续内容将在你发送第一条指令时一并发送。</p>}
        <Button size="sm" variant="ghost" onClick={onClose}>{attempt ? '返回对话' : '取消'}</Button>
        {!attempt ? <Button size="sm" variant="primary" disabled={!usablePreview || !contextValid || previewLoading || !!pending} onClick={() => void create()}>创建接续对话<ArrowRight size={14} /></Button> : <>
          {!terminal && <Button size="sm" variant="outline" disabled={!!pending} onClick={() => void cancel()}>{pending === 'cancel' ? '正在取消…' : '取消接续'}</Button>}
          {(!operation || operation.state === 'creating' || paused) && <Button size="sm" variant="outline" disabled={!!pending} onClick={check}>{pending === 'status' ? '正在检查…' : '检查状态'}</Button>}
          {!operation && <Button size="sm" variant="primary" disabled={!!pending} onClick={() => void create(true)}>{pending === 'create' ? '正在准备…' : '重试本次创建'}</Button>}
          {operationVerified && operation?.targetSessionId && ['ready', 'sent'].includes(operation.state) && <Button size="sm" variant="primary" disabled={!!pending} onClick={() => void openTarget(operation)}>{pending === 'navigate' ? '正在打开…' : '打开接续对话'}<ArrowRight size={14} /></Button>}
          {(terminal || draft.rejected) && <Button size="sm" variant="outline" disabled={!!pending || !!sourceIssue} onClick={restart}>重新预览</Button>}
        </>}
      </footer>
    </div>
  </Modal>
}
