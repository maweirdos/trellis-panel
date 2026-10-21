import type { AcpSessionRecord, TimelineEvent } from '../../../shared/types'
import { projectRootKey } from '../my/navigation'
import { asObject, readFileChange } from './timeline'

const turnKey = (event: Pick<TimelineEvent, 'sessionId' | 'connectionGeneration' | 'turnId'>): string => JSON.stringify([event.sessionId, event.connectionGeneration, event.turnId])

/** Project watcher facts have no implied relationship to the selected reply. */
export function partitionConversationEvents(events: TimelineEvent[], session: AcpSessionRecord): { transcript: TimelineEvent[]; background: TimelineEvent[] } {
  const transcript: TimelineEvent[] = [], background: TimelineEvent[] = []
  const turns = new Set(events.filter((event) => event.source === 'acp' && projectRootKey(event.projectRoot) === projectRootKey(session.projectRoot) && event.sessionId === session.sessionId && event.turnId && event.connectionGeneration).map(turnKey))
  if (session.turnId && session.connectionGeneration) turns.add(turnKey(session))
  for (const event of events) {
    if (!readFileChange(event) || projectRootKey(event.projectRoot) !== projectRootKey(session.projectRoot)) { transcript.push(event); continue }
    const material = asObject(event.payload?.materialChange)
    const taskDir = event.taskDir ?? event.payload?.taskDir ?? material?.taskDir
    const sameTask = Boolean(session.taskDir && taskDir === session.taskDir && (!event.sessionId || event.sessionId === session.sessionId))
    const sameTurn = Boolean(event.sessionId === session.sessionId && event.turnId && event.connectionGeneration && turns.has(turnKey(event)))
    if (sameTask || sameTurn) transcript.push(event)
    else background.push(event)
  }
  return { transcript, background }
}

export interface KnowledgeBridgeObservation {
  state: 'attached' | 'discovered' | 'active' | 'unavailable' | 'revoked'
  detail?: string
  status?: string
  persistence?: string
  operationId?: string
}

export function knowledgeObservation(event: TimelineEvent): KnowledgeBridgeObservation | undefined {
  const observation = asObject(event.payload?.knowledgeBridge)
  if (event.source !== 'acp' || event.kind !== 'diagnostic' || !observation) return undefined
  const state = observation.state
  if (state !== 'attached' && state !== 'discovered' && state !== 'active' && state !== 'unavailable' && state !== 'revoked') return undefined
  if (['detail', 'status', 'persistence', 'operationId'].some((key) => observation[key] !== undefined && typeof observation[key] !== 'string')) return undefined
  return {
    state,
    detail: typeof observation.detail === 'string' ? observation.detail : undefined,
    status: typeof observation.status === 'string' ? observation.status : undefined,
    persistence: typeof observation.persistence === 'string' ? observation.persistence : undefined,
    operationId: typeof observation.operationId === 'string' ? observation.operationId : undefined
  }
}

export function currentKnowledgeObservation(events: TimelineEvent[], session: AcpSessionRecord): KnowledgeBridgeObservation | undefined {
  if (!session.connectionGeneration) return undefined
  for (const event of [...events].reverse()) {
    if (event.sessionId !== session.sessionId || event.connectionGeneration !== session.connectionGeneration || projectRootKey(event.projectRoot) !== projectRootKey(session.projectRoot)) continue
    const observation = knowledgeObservation(event)
    if (observation) return observation
  }
  return undefined
}

export function knowledgeObservationLabel(observation: KnowledgeBridgeObservation): string {
  if (observation.persistence === 'degraded') return '来源快照保存异常'
  if (observation.state === 'active') {
    const statuses: Record<string, string> = { ok: '知识检索已返回结果', empty: '知识检索无命中', partial: '知识检索返回部分结果', not_configured: '项目知识未配置', denied: '知识访问被拒绝', unavailable: '知识检索暂不可用', cancelled: '知识检索已取消' }
    return statuses[observation.status ?? ''] ?? '正在处理项目知识'
  }
  return { attached: '知识工具已附加，等待引擎确认', discovered: '引擎已发现知识工具，按需调用', unavailable: '当前知识工具不可用', revoked: '当前连接的知识访问已撤销' }[observation.state]
}
