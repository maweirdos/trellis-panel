import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowLeft, ArrowRight, ArrowRightLeft } from 'lucide-react'
import { api } from '../api'
import { Button } from '../my/ui'
import { useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { RuntimeMark } from './RuntimePicker'
import { handoffRequest, readRuntimeHandoffDraft, writeRuntimeHandoffDraft } from './runtime-handoff-state'
import type { AcpAgentStatus, AcpSessionRecord } from '../../../shared/types'
import type { AcpHandoffOperation, AcpHandoffState } from '../../../shared/acp-handoff'

const TARGET_STATE: Record<AcpHandoffState, string> = { creating: '正在准备', ready: '内容已准备，尚未发送', sent: '接续内容已发送', failed: '接续未完成', cancelled: '已取消' }

export function ConversationHandoff({ root, session, agents, operation, checking, statusError, isCurrent, onSelect, onCheck, onOperation, onChanged, onCancelled }: {
  root: string
  session: AcpSessionRecord
  agents: AcpAgentStatus[]
  operation: AcpHandoffOperation | null
  checking: boolean
  statusError: string
  isCurrent: () => boolean
  onSelect: (sessionId: string) => void
  onCheck: () => void
  onOperation: (operation: AcpHandoffOperation) => void
  onChanged: () => void
  onCancelled: (sourceSessionId: string) => void
}): JSX.Element | null {
  const canInteract = useInteractionGuard()
  const signal = useInteractionSignal()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const action = useRef<symbol | null>(null)
  const live = useRef(true)
  const latest = useRef({ isCurrent, canInteract, signal, generation: session.connectionGeneration, delivery: session.handoff?.delivery })
  latest.current = { isCurrent, canInteract, signal, generation: session.connectionGeneration, delivery: session.handoff?.delivery }
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => { action.current = null; setPending(false); setError('') }, [signal, session.connectionGeneration])
  const current = (): boolean => live.current && latest.current.isCurrent() && latest.current.canInteract() && !latest.current.signal?.aborted
  const origin = session.handoff
  const links = session.handoffTargets ?? []
  if (!origin && !links.length) return null

  const cancel = async (): Promise<void> => {
    if (!origin || origin.delivery === 'sent' || !current() || action.current) return
    const generation = session.connectionGeneration
    const ticket = Symbol('cancel-handoff')
    const valid = (): boolean => current() && !signal?.aborted && action.current === ticket && generation === latest.current.generation
    action.current = ticket; setPending(true); setError('')
    try {
      const result = await handoffRequest(api.acpSessionHandoffCancel(origin.sourceSessionId, { operationId: origin.operationId }))
      if (!valid()) return
      if (!result.ok) throw Error(result.error)
      const operation = result.operation
      if (operation.id !== origin.operationId || operation.sourceSessionId !== origin.sourceSessionId || operation.targetSessionId !== session.sessionId) throw Error('接续状态与当前对话不一致，请刷新后重试。')
      const saved = readRuntimeHandoffDraft(root, origin.sourceSessionId)
      if (saved.attempt?.operationId === operation.id) writeRuntimeHandoffDraft(root, origin.sourceSessionId, { ...saved, operation })
      onOperation(operation)
      onChanged()
      if (operation.state === 'cancelled') onCancelled(origin.sourceSessionId)
      else setError(operation.state === 'sent' ? '接续内容已发送，无法取消。' : '取消结果尚未确认，请刷新后检查。')
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : '取消结果尚未确认，请重试。') }
    finally { if (action.current === ticket) { action.current = null; if (current()) setPending(false) } }
  }

  const delivered = origin?.delivery === 'sent' || operation?.delivery === 'sent'
  const cancelled = operation?.state === 'cancelled'
  const failed = operation?.state === 'failed'
  const prepared = !delivered && operation?.state === 'ready'
  const status = delivered ? '接续内容已随首条指令发送' : cancelled ? '接续已取消，内容未发送' : failed ? operation.delivery === 'not_sent' ? '接续未完成，内容未发送' : '接续未完成，内容送达尚未确认' : prepared ? '接续内容已准备，尚未发送' : checking ? '正在核对接续状态…' : '接续状态待确认'

  return <section className="acp-handoff-lineage space-y-3 rounded-my-md border border-my-line bg-my-layer-1 p-3 text-my-sm" aria-label="Runtime 接续">
    {origin && <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2"><ArrowRightLeft size={14} className="shrink-0 text-my-tertiary" aria-hidden="true" /><p role="status" className="min-w-0 flex-1 font-medium">{status}</p>{!delivered && !cancelled && <Button size="sm" variant="ghost" disabled={pending || ['starting', 'busy', 'awaiting_permission', 'cancelling'].includes(session.status)} onClick={() => void cancel()}>{pending ? '正在取消…' : '取消接续'}</Button>}</div>
      <div className="flex flex-wrap items-center gap-2 text-my-secondary"><Button size="sm" variant="ghost" className="min-w-0 max-w-full" onClick={() => { if (current()) onSelect(origin.sourceSessionId) }}><ArrowLeft size={13} /><RuntimeMark runtimeId={origin.sourceRuntimeId} /><span className="truncate">{origin.sourceTitle || '来源对话'}</span></Button><span className="text-my-xs text-my-tertiary">检查点 · 记录 {origin.checkpointSeq}</span></div>
      {prepared && <p className="text-my-xs text-my-secondary">发送第一条指令时会带上接续内容。原始消息保留在来源对话。</p>}
      {(failed || cancelled) && <p className="text-my-xs text-my-secondary">请返回来源对话继续处理。这里的草稿仍保留。</p>}
      {(origin.attachments > 0 || origin.toolCalls > 0) && <p className="text-my-xs text-my-secondary">附件与工具正文保留在来源对话。请补充关键结果{origin.attachments > 0 ? '，并在此重新添加需要的图片' : ''}。</p>}
      {(origin.omittedMessages > 0 || origin.truncated || origin.coverage !== 'complete') && <p className="text-my-xs text-my-tertiary">包含 {origin.includedMessages} 条消息{origin.omittedMessages > 0 ? ` · 省略 ${origin.omittedMessages} 条` : ''}{origin.truncated ? ' · 内容已缩减' : ''}{origin.coverage !== 'complete' ? ' · 历史完整范围未确认' : ''}</p>}
      {origin.latestTurnIncluded === false && <p className="text-my-xs text-my-warning-text">最近一轮未包含 · 自定义交接内容</p>}
      {error && <p role="alert" className="break-words text-my-danger-text">{error}</p>}
      {(statusError || operation?.error) && <p role="alert" className="break-words text-my-danger-text">{statusError || operation?.error}</p>}
      {!delivered && !cancelled && <Button size="sm" variant="ghost" disabled={checking || pending} onClick={onCheck}>{checking ? '正在检查…' : '检查接续状态'}</Button>}
    </div>}
    {links.length > 0 && <div className="space-y-2" aria-label="接续对话">{links.map((link) => <div key={link.operationId} className="flex flex-wrap items-center gap-x-2 gap-y-1"><Button size="sm" variant="ghost" className="min-w-0 max-w-full" onClick={() => { if (current()) onSelect(link.targetSessionId) }}><RuntimeMark runtimeId={link.runtimeId} /><span className="truncate">{agents.find((agent) => (agent.runtimeId ?? agent.id) === link.runtimeId)?.name ?? link.runtimeId} 接续对话</span><ArrowRight size={13} /></Button><span className="text-my-xs text-my-tertiary">{TARGET_STATE[link.state]}</span></div>)}</div>}
  </section>
}
