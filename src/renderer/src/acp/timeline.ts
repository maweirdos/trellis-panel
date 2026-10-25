import type { AcpSessionStatus, TimelineEvent } from '../../../shared/types'
import { readAcpImages, type AcpImageAttachment } from '../../../shared/acp-images'
import { relativePathUnderRoot, sameRelativeDocumentPath } from '../reader/reader-paths'
import { knowledgeOperationIdentity, nativeKnowledgeOperationId, readKnowledgeOperation, type ConversationKnowledgeOperation } from './knowledge-operations'
import { orderTimelineEvents } from './event-order'

export interface ToolItemState {
  toolCallId: string
  title: string
  status: string
  payload: Record<string, unknown>
}

export interface FileChangeItem {
  path: string
  events: TimelineEvent[]
}

export type RenderItem =
  | { type: 'user' | 'agent' | 'thought'; key: string; text: string; startsAnswer?: boolean; images?: AcpImageAttachment[]; delivery?: 'preparing' | 'sent' | 'not_sent' }
  | { type: 'tool'; key: string; tool: ToolItemState }
  | { type: 'knowledge-operation'; key: string; ev: TimelineEvent; operation: ConversationKnowledgeOperation }
  | { type: 'change-group'; key: string; events: TimelineEvent[]; files: FileChangeItem[] }
  | { type: 'activity'; key: string; events: TimelineEvent[]; scope?: 'connection'; turnId?: string; connectionGeneration?: string; sessionId?: string; projectRoot?: string; startedAt?: number; endedAt?: number; outcome?: 'completed' | 'cancelled' | 'failed'; active?: boolean }
  | { type: 'perm' | 'trellis' | 'detail'; key: string; ev: TimelineEvent }
  | { type: 'turn'; key: string; text: string }

/** Projection only: protocol ownership and partial-update validation live in the runtime. */
export function compileItems(events: TimelineEvent[]): RenderItem[] {
  // Connection history stays available to diagnostics; it is not a user turn.
  // This also isolates old restores that accidentally reused the last turnId.
  const transcriptEvents = events.filter((event) => !isConnectionTimelineEvent(event))
  const sourceEvents = new Map(transcriptEvents.map((event) => [event.id, event]))
  const items: RenderItem[] = []
  const toolIndex = new Map<string, Extract<RenderItem, { type: 'tool' }>>()
  const knowledgeIndex = new Map<string, Extract<RenderItem, { type: 'knowledge-operation' }>>()
  const preparingQuestions = new Map<string, Extract<RenderItem, { type: 'user' | 'agent' | 'thought' }>>()
  const identityOf = (event: TimelineEvent): string => JSON.stringify([event.source, knowledgeOperationIdentity(event, '')])
  const turnStarts = new Map<string, number>()
  const transportObservations = new Map<string, TimelineEvent[]>()
  // Only an actual user/start boundary establishes elapsed time. A paged suffix
  // must not acquire a fabricated start from its first loaded token.
  for (const event of transcriptEvents) {
    if (event.source !== 'acp') continue
    const identity = identityOf(event)
    const startsTurn = event.kind === 'message' && event.payload?.role === 'user' || asObject(event.payload?.observation)?.label === '开始处理'
    if (event.turnId && startsTurn && !turnStarts.has(identity)) turnStarts.set(identity, event.ts)
  }
  let activityGroup: Extract<RenderItem, { type: 'activity' }> | undefined
  let activityScope: string | undefined
  let changeGroup: Extract<RenderItem, { type: 'change-group' }> | undefined
  let changeScope: string | undefined
  // Inspect the original order: even a hidden connection/status fact ends a run.
  for (const ev of events) {
    const key = ev.id
    const delivery = readPromptDelivery(ev)
    if (delivery) {
      const question = preparingQuestions.get(identityOf(ev))
      if (question?.delivery === 'preparing') question.delivery = delivery
      continue
    }
    if (!isRoutineRuntimeEvent(ev) || isConnectionTimelineEvent(ev)) { activityGroup = undefined; activityScope = undefined }
    const operation = readKnowledgeOperation(ev)
    if (operation) {
      const identity = knowledgeOperationIdentity(ev, operation.operationId)
      const previous = knowledgeIndex.get(identity)
      if (previous) { previous.operation = operation; previous.ev = ev }
      else {
        const item: Extract<RenderItem, { type: 'knowledge-operation' }> = { type: 'knowledge-operation', key, ev, operation }
        knowledgeIndex.set(identity, item); items.push(item)
      }
      changeGroup = undefined; changeScope = undefined
      continue
    }
    const change = readFileChange(ev)
    if (change) {
      if (!changeGroup || changeScope !== change.scope) {
        changeGroup = { type: 'change-group', key, events: [], files: [] }
        changeScope = change.scope
        items.push(changeGroup)
      }
      changeGroup.events.push(ev)
      const projectPath = (path: string): string => relativePathUnderRoot(ev.projectRoot, path) ?? path
      const file = changeGroup.files.find((entry) => sameRelativeDocumentPath(ev.projectRoot, projectPath(entry.path), projectPath(change.path)))
      if (file) file.events.push(ev)
      else changeGroup.files.push({ path: change.path, events: [ev] })
      continue
    }
    changeGroup = undefined
    changeScope = undefined
    if (isConnectionTimelineEvent(ev)) continue
    if (ev.source === 'trellis') {
      items.push({ type: 'trellis', key, ev })
      continue
    }
    if (isRoutineRuntimeEvent(ev)) {
      // Routine synchronization stays recorded but does not occupy the transcript.
      if (!ev.payload?.observation) continue
      const identity = identityOf(ev)
      if (isTurnTransportObservation(ev)) {
        const observations = transportObservations.get(identity) ?? []
        observations.push(ev); transportObservations.set(identity, observations)
        continue
      }
      if (!activityGroup || activityScope !== identity) {
        activityGroup = { type: 'activity', key: `activity:${key}`, events: [], turnId: ev.turnId, connectionGeneration: ev.connectionGeneration, sessionId: ev.sessionId, projectRoot: ev.projectRoot, startedAt: turnStarts.get(identity) }
        activityScope = identity
        items.push(activityGroup)
      }
      activityGroup.events.push(ev)
      continue
    }
    if (ev.kind === 'message' || ev.kind === 'thought') {
      const type = ev.kind === 'thought' ? 'thought' : ev.payload?.role === 'user' ? 'user' : 'agent'
      const last = items[items.length - 1]
      const previousSource = last && sourceEvents.get(last.key)
      const sameMessage = previousSource && identityOf(previousSource) === identityOf(ev) && previousSource.payload?.messageId === ev.payload?.messageId
      if (type !== 'user' && last?.type === type && sameMessage) last.text += ev.text ?? ''
      else {
        const item: Extract<RenderItem, { type: 'user' | 'agent' | 'thought' }> = { type, key, text: ev.text ?? '', ...(type === 'user' ? { images: readAcpImages(ev.payload?.images) } : {}) }
        if (type === 'user' && ev.source === 'acp' && hasPromptOwner(ev) && ev.payload?.delivery === 'preparing') {
          item.delivery = 'preparing'
          preparingQuestions.set(identityOf(ev), item)
        }
        items.push(item)
      }
    } else if (ev.kind === 'tool-call') {
      const toolCallId = String(ev.payload?.toolCallId ?? key)
      // Turn IDs prevent a vendor reusing a tool ID from mutating an earlier turn.
      const identity = `${identityOf(ev)}:${toolCallId}`
      const previous = toolIndex.get(identity)
      const prior = previous?.type === 'tool' ? previous.tool : undefined
      const payload = { ...prior?.payload, ...ev.payload }
      if (typeof ev.payload?.outputDelta === 'string') {
        const previousOutput = typeof prior?.payload.outputText === 'string' ? prior.payload.outputText : ''
        const combined = previousOutput + ev.payload.outputDelta
        let displayed = combined.slice(0, 256 * 1024)
        if (/[\uD800-\uDBFF]$/u.test(displayed)) displayed = displayed.slice(0, -1)
        payload.outputText = displayed
        payload.outputDeltaTruncated = prior?.payload.outputDeltaTruncated === true || ev.payload.outputDeltaTruncated === true || combined.length > displayed.length
      }
      // acpx normalizes an omitted patch title to this placeholder. Keep the known
      // label while still applying real title changes, status, output and null fields.
      const isDefaultPatchTitle = ev.payload?.tag === 'tool_call_update' && ev.payload?.title === 'tool call'
      const state: ToolItemState = {
        toolCallId,
        title: isDefaultPatchTitle && prior ? prior.title : ev.text || prior?.title || '工具调用',
        status: typeof payload.status === 'string' ? payload.status : prior?.status ?? 'pending',
        payload
      }
      if (previous?.type === 'tool') previous.tool = state
      else {
        const item: Extract<RenderItem, { type: 'tool' }> = { type: 'tool', key, tool: state }
        toolIndex.set(identity, item)
        items.push(item)
      }
    } else if (ev.kind === 'permission') items.push({ type: 'perm', key, ev })
    else if (ev.kind === 'turn-done') {
      const result = asObject(ev.payload?.result)
      const outcome = result?.status === 'failed' ? 'failed' : result?.status === 'cancelled' || ev.text === '回合已取消' ? 'cancelled' : result?.status === 'completed' || ev.text === '回合已结束' ? 'completed' : undefined
      if (ev.source === 'acp' && ev.turnId) items.push({ type: 'activity', key: `activity:${key}`, events: [...(transportObservations.get(identityOf(ev)) ?? []), ev], turnId: ev.turnId, connectionGeneration: ev.connectionGeneration, sessionId: ev.sessionId, projectRoot: ev.projectRoot, startedAt: turnStarts.get(identityOf(ev)), endedAt: ev.ts, outcome })
      items.push({ type: 'turn', key, text: ev.text ?? '本轮结束' })
    }
    else items.push({ type: 'detail', key, ev })
  }
  // Tool patches mutate only their original scoped row. No turn-wide collection
  // or terminal relocation: each visible segment keeps its first event anchor.
  const answers = new Set<string>()
  const projected = items.filter((item) => {
    const source = sourceEvents.get(item.key)
    if (source && item.type === 'tool') {
      const operationId = nativeKnowledgeOperationId(item.tool.payload)
      if (operationId && knowledgeIndex.has(knowledgeOperationIdentity(source, operationId))) return false
    }
    if (!source?.turnId) return true // Old records have no reliable turn identity.
    const identity = identityOf(source)
    if (item.type === 'agent' && !answers.has(identity)) { item.startsAnswer = true; answers.add(identity) }
    return true
  })
  const tail = projected.at(-1)
  if (tail?.type === 'activity' && tail.endedAt === undefined) tail.active = true
  return projected
}

/** Successful transport milestones are detail-only, not steps competing with the answer. */
function isTurnTransportObservation(event: TimelineEvent): boolean {
  return event.source === 'acp' && event.kind === 'session-status' && Boolean(event.turnId) && ['开始处理', '指令已发送至引擎', '收到首次模型响应'].includes(String(asObject(event.payload?.observation)?.label))
}

function hasPromptOwner(event: TimelineEvent): boolean {
  return [event.projectRoot, event.sessionId, event.connectionGeneration, event.turnId].every((value) => typeof value === 'string' && Boolean(value.trim()))
}

/** Delivery acknowledgement can update only a host-admitted question in its exact turn. */
function readPromptDelivery(event: TimelineEvent): 'sent' | 'not_sent' | undefined {
  if (event.source !== 'acp' || event.kind !== 'diagnostic' || event.payload?.activityScope !== 'turn' || !hasPromptOwner(event)) return undefined
  const state = asObject(event.payload.promptDelivery)?.state
  return state === 'sent' || state === 'not_sent' ? state : undefined
}

/** Only structured file facts establish identity; prose never supplies a path or scope. */
export function readFileChange(event: TimelineEvent): { path: string; scope: string } | undefined {
  if (event.source !== 'trellis' || !['spec-updated', 'doc-created', 'material-change'].includes(event.kind) || !event.id?.trim() || !event.projectRoot?.trim()) return undefined
  const payload = event.payload
  const material = asObject(payload?.materialChange)
  const problem = (value: unknown): boolean => typeof value === 'string' && ['failed', 'failure', 'error', 'warn', 'warning'].includes(value.trim().toLowerCase())
  for (const fact of [payload, asObject(payload?.result), material]) {
    if (fact && ([fact.type, fact.status, fact.severity, fact.level, fact.outcome].some(problem) || fact.error || fact.ok === false || fact.success === false)) return undefined
  }
  const paths = [payload?.path, material?.relativePath, payload?.file]
  const path = paths.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
  if (!path) return undefined
  // A payload scope may fill an absent task scope, but contradictory facts stay separate.
  const tasks = [event.taskDir, payload?.taskDir, material?.taskDir].filter((value): value is string => typeof value === 'string')
  if (new Set(tasks).size > 1 || (material?.projectRoot !== undefined && material.projectRoot !== event.projectRoot)) return undefined
  return { path, scope: JSON.stringify([event.projectRoot, event.sessionId, event.connectionGeneration, event.turnId, tasks[0]]) }
}

/** Known connection facts only: retain unrecognized/error content for inspection. */
export function isConnectionTimelineEvent(event: TimelineEvent): boolean {
  if (event.source !== 'acp') return false
  if (event.payload?.activityScope === 'connection') return true
  if (event.payload?.activityScope === 'turn') return false
  if (isNativeToolsInformation(event)) return true
  const observation = asObject(event.payload?.observation)
  if (event.kind !== 'session-status' || !observation || typeof observation.atMs !== 'number' || typeof observation.label !== 'string') return false
  return ['开始准备会话', '开始恢复原会话', '启动 Runtime', 'Runtime 进程已启动', 'ACP 会话已就绪', '原会话已连接，可以继续对话', '原生会话恢复已验证', '原会话记录已定位；发送时验证原生恢复，失败不会新建会话'].includes(observation.label)
    || observation.label.startsWith('Runtime 启动失败：') || observation.label.startsWith('会话准备失败：')
}

/** Keep explicit errors and unknown diagnostics visible; collapse routine runtime metadata only. */
function isRoutineRuntimeEvent(event: TimelineEvent): boolean {
  const payload = event.payload
  const isProblemLevel = (value: unknown): boolean => value === 'error' || value === 'warning' || value === 'warn'
  if (isProblemLevel(payload?.type) || payload?.error || payload?.code !== undefined || payload?.status === 'failed' || asObject(payload?.observation)?.status === 'failed' || isProblemLevel(payload?.status) || isProblemLevel(payload?.severity) || isProblemLevel(payload?.level)) return false
  if (event.kind === 'config') return true
  if (event.kind === 'diagnostic') return isNativeToolsInformation(event) || event.text === 'Runtime 更新'
  if (event.kind !== 'session-status') return false
  if (payload?.observation) return true // Actual turn observations retain their event segment.
  const tag = payload?.tag
  return tag === 'usage_update' || tag === 'session_info_update' || tag === 'available_commands_update' || tag === 'current_mode_update' || tag === 'config_option_update' || tag === 'update'
    || event.text === 'session updated' || event.text?.startsWith('usage updated') === true
}

/** Existing persisted capability notices lack severity; recognize their structured fact only. */
function isNativeToolsInformation(event: TimelineEvent): boolean {
  if (event.kind !== 'diagnostic') return false
  const payload = event.payload
  const services = asObject(payload?.clientServices)
  return payload?.toolExecution === 'adapter-native' && services?.fs === false && services.terminal === false &&
    payload.code === undefined && payload.error === undefined &&
    (payload.type === undefined || payload.type === 'status' || payload.type === 'info') &&
    (payload.status === undefined || payload.status === 'info') &&
    (payload.severity === undefined || payload.severity === 'info') &&
    (payload.level === undefined || payload.level === 'info')
}

export function runtimeActivityLabel(event: TimelineEvent): string {
  if (isNativeToolsInformation(event)) return '工具能力说明（适配器原生工具）'
  switch (event.payload?.tag) {
    case 'usage_update': return '用量更新（Runtime 报告）'
    case 'available_commands_update': return '可用命令更新'
    case 'config_option_update': return '配置更新'
    case 'current_mode_update': return '运行模式更新'
    case 'session_info_update': return '会话信息更新'
  }
  if (event.payload?.observation) return '运行观测详情'
  return event.kind === 'config' ? '配置更新' : event.kind === 'diagnostic' ? 'Runtime 诊断详情' : '会话状态更新'
}

export function mergeEvents(recorded: TimelineEvent[], live: TimelineEvent[]): TimelineEvent[] {
  const byId = new Map(recorded.map((ev) => [ev.id, ev]))
  // The authoritative list may invalidate a pending request without changing its event ID.
  for (const ev of live) {
    const prior = byId.get(ev.id)
    if (!prior) byId.set(ev.id, ev)
    else if (prior.historySeq === undefined && ev.historySeq !== undefined) byId.set(ev.id, { ...prior, historySeq: ev.historySeq })
  }
  return orderTimelineEvents(byId, [recorded, live])
}

export const SESSION_LABEL: Record<AcpSessionStatus, string> = {
  starting: '准备中', ready: '已就绪', busy: '运行中', awaiting_permission: '等待授权',
  cancelling: '正在中止', disconnected: '已断开', legacy: '旧版记录', error: '运行失败', closed: '已结束'
}

export function isLiveStatus(status: AcpSessionStatus): boolean {
  return status === 'starting' || status === 'ready' || status === 'busy' || status === 'awaiting_permission' || status === 'cancelling'
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`
}
