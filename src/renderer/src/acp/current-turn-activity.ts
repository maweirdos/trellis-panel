import type { AcpSessionRecord, TimelineEvent } from '../../../shared/types'
import { projectRootKey } from '../my/navigation'
import { knowledgeOperationLabel, readKnowledgeOperation } from './knowledge-operations'

export interface CurrentTurnIdentity {
  projectRoot: string
  sessionId: string
  connectionGeneration?: string
  turnId: string
}

/** Local admission bridge only; never stored in conversation history. */
export interface CurrentTurnRequest {
  requestId: string
  projectRoot: string
  sessionId: string
  connectionGeneration?: string
  previousTurnId?: string
  turnId?: string
  phase: 'submitting' | 'accepted'
}

export interface CurrentTurnActivity {
  phase: 'submitting' | 'knowledge' | 'waiting' | 'thinking' | 'tool' | 'replying' | 'processing' | 'permission' | 'cancelling'
  label: string
  detail?: string
  spinning: boolean
}

export function ownsCurrentTurnRequest(request: CurrentTurnRequest | undefined, session: AcpSessionRecord | null, root: string): request is CurrentTurnRequest {
  return Boolean(request && session && projectRootKey(root) === projectRootKey(request.projectRoot) && projectRootKey(session.projectRoot) === projectRootKey(root) && request.sessionId === session.sessionId && request.connectionGeneration === session.connectionGeneration)
}

const runningStatus = (status: string): boolean => ['busy', 'awaiting_permission', 'cancelling'].includes(status)

/** Only exact current facts select a label. Gaps keep the real turn visible. */
export function projectCurrentTurnActivity({ root, session, events, request, terminalTurns = [], interactive = true }: {
  root: string
  session: AcpSessionRecord | null
  events: readonly TimelineEvent[]
  request?: CurrentTurnRequest
  terminalTurns?: readonly CurrentTurnIdentity[]
  interactive?: boolean
}): CurrentTurnActivity | null {
  if (!interactive || !session || !root || projectRootKey(session.projectRoot) !== projectRootKey(root) || session.historyKind === 'legacy' || session.historyKind === 'transcript') return null
  const local = ownsCurrentTurnRequest(request, session, root) ? request : undefined
  if (['error', 'closed', 'disconnected', 'legacy'].includes(session.status)) return null
  const owned = (fact: { projectRoot: string; sessionId?: string; connectionGeneration?: string }): boolean => projectRootKey(fact.projectRoot) === projectRootKey(root) && fact.sessionId === session.sessionId && fact.connectionGeneration === session.connectionGeneration
  const currentEvents = events.filter((event) => event.source === 'acp' && owned(event) && event.payload?.activityScope !== 'connection')
  // Metadata can still describe the preceding completed turn during admission.
  // An observed/acknowledged new ID is the bridge until that metadata catches up.
  const observedTurn = local && runningStatus(session.status) && session.turnId !== local.previousTurnId ? session.turnId : undefined
  const turnId = local ? local.turnId ?? observedTurn : session.turnId
  const facts = turnId ? currentEvents.filter((event) => event.turnId === turnId) : []
  const terminal = Boolean(turnId && (facts.some((event) => event.kind === 'turn-done') || terminalTurns.some((fact) => owned(fact) && fact.turnId === turnId)))
  if (terminal) return null
  // Older live connections can report busy without turn IDs. Keep only generic
  // status there; uncorrelated history can never select a thought/tool phase.
  const currentState = Boolean(session.connectionGeneration && runningStatus(session.status) && (!turnId || session.turnId === turnId))
  if (!local && !currentState) return null
  if (currentState && session.status === 'awaiting_permission') return { phase: 'permission', label: '等待你的授权', spinning: false }
  if (currentState && session.status === 'cancelling') return { phase: 'cancelling', label: '正在停止…', spinning: true }
  if (local?.phase === 'submitting' && !local.turnId && !currentState) return { phase: 'submitting', label: '正在发送…', spinning: true }
  const latest = [...facts].reverse().find((event) =>
    (event.kind === 'message' && event.payload?.role !== 'user' && Boolean(event.text?.trim())) ||
    (event.kind === 'thought' && Boolean(event.text?.trim())) || event.kind === 'tool-call' || event.kind === 'plan' || readKnowledgeOperation(event))
  const knowledge = latest && readKnowledgeOperation(latest)
  if (knowledge?.phase === 'running') return { phase: 'knowledge', label: knowledgeOperationLabel(knowledge, true), detail: knowledge.query, spinning: true }
  if (latest?.kind === 'message') return { phase: 'replying', label: '正在生成回复', spinning: true }
  if (latest?.kind === 'thought') return { phase: 'thinking', label: '正在思考', spinning: true }
  if (latest?.kind === 'tool-call') {
    const toolId = latest.payload?.toolCallId ?? latest.id
    const status = [...facts].reverse().find((event) => event.kind === 'tool-call' && (event.payload?.toolCallId ?? event.id) === toolId && typeof event.payload?.status === 'string')?.payload?.status
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return { phase: 'processing', label: '处理中', spinning: true }
    return { phase: 'tool', label: '正在调用工具', spinning: true }
  }
  if (latest?.kind === 'plan') return { phase: 'processing', label: '处理中', spinning: true }
  // Host lookup can finish before the native transport accepts its input.
  // A recorded question alone does not establish that a model is answering it.
  const preparing = facts.some((event) => event.kind === 'message' && event.payload?.role === 'user' && event.payload.delivery === 'preparing')
  const delivered = facts.some((event) =>
    event.kind === 'diagnostic' && event.payload?.activityScope === 'turn' && typeof event.payload.promptDelivery === 'object' && event.payload.promptDelivery !== null && 'state' in event.payload.promptDelivery && event.payload.promptDelivery.state === 'sent' ||
    event.kind === 'session-status' && typeof event.payload?.observation === 'object' && event.payload.observation !== null && 'label' in event.payload.observation && event.payload.observation.label === '指令已发送至引擎')
  if (preparing && !delivered) return { phase: 'processing', label: '正在准备回复', spinning: true }
  return { phase: 'waiting', label: '等待模型回复', spinning: true }
}
