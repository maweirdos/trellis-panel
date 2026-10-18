import type { AcpSessionStatus, TimelineEvent } from '../../../shared/types'

export interface ToolItemState {
  toolCallId: string
  title: string
  status: string
  payload: Record<string, unknown>
}

export type RenderItem =
  | { type: 'user' | 'agent' | 'thought'; key: string; text: string; startsAnswer?: boolean }
  | { type: 'tool'; key: string; tool: ToolItemState }
  | { type: 'activity'; key: string; events: TimelineEvent[]; children?: RenderItem[]; turnId?: string; connectionGeneration?: string; startedAt?: number; endedAt?: number; outcome?: 'completed' | 'cancelled' | 'failed' }
  | { type: 'perm' | 'trellis' | 'detail'; key: string; ev: TimelineEvent }
  | { type: 'turn'; key: string; text: string }

/** Projection only: protocol ownership and partial-update validation live in the runtime. */
export function compileItems(events: TimelineEvent[]): RenderItem[] {
  // Connection history stays available to diagnostics; it is not a user turn.
  // This also isolates old restores that accidentally reused the last turnId.
  const transcriptEvents = events.filter((event) => !isConnectionTimelineEvent(event))
  const items: RenderItem[] = []
  const toolIndex = new Map<string, number>()
  const activityGroups = new Map<string, Extract<RenderItem, { type: 'activity' }>>()
  const identityOf = (event: TimelineEvent): string => `${event.connectionGeneration ?? ''}:${event.turnId ?? ''}`
  const userTurns = new Set(transcriptEvents.filter((event) => event.source === 'acp' && event.kind === 'message' && event.payload?.role === 'user').map(identityOf))
  const renderedActivity = new Set<string>()
  // Project turn timing before rendering, so a completed header stays beside
  // its user message even when later metadata arrives after the answer.
  for (const event of transcriptEvents) {
    if (event.source !== 'acp') continue
    const identity = identityOf(event)
    let group = activityGroups.get(identity)
    if (!group) {
      group = { type: 'activity', key: `activity:${identity}`, events: [], turnId: event.turnId, connectionGeneration: event.connectionGeneration, startedAt: event.ts }
      activityGroups.set(identity, group)
    }
    if (isRoutineRuntimeEvent(event)) group.events.push(event)
    if (event.kind === 'turn-done') {
      const result = asObject(event.payload?.result)
      group.endedAt = event.ts
      group.outcome = result?.status === 'failed' ? 'failed' : result?.status === 'cancelled' || event.text === '回合已取消' ? 'cancelled' : result?.status === 'completed' || event.text === '回合已结束' ? 'completed' : undefined
    }
  }
  for (const ev of transcriptEvents) {
    const key = ev.id
    if (ev.source === 'trellis') {
      items.push({ type: 'trellis', key, ev })
      continue
    }
    if (isRoutineRuntimeEvent(ev)) {
      const identity = identityOf(ev)
      const group = activityGroups.get(identity)
      if (group?.turnId && !userTurns.has(identity) && !renderedActivity.has(identity)) { items.push(group); renderedActivity.add(identity) }
      continue
    }
    if (ev.kind === 'message' || ev.kind === 'thought') {
      const type = ev.kind === 'thought' ? 'thought' : ev.payload?.role === 'user' ? 'user' : 'agent'
      const last = items[items.length - 1]
      if (type !== 'user' && last?.type === type) last.text += ev.text ?? ''
      else items.push({ type, key, text: ev.text ?? '' })
      if (type === 'user') {
        const identity = identityOf(ev), group = activityGroups.get(identity)
        if (group && !renderedActivity.has(identity)) { items.push(group); renderedActivity.add(identity) }
      }
    } else if (ev.kind === 'tool-call') {
      const toolCallId = String(ev.payload?.toolCallId ?? key)
      // Turn IDs prevent a vendor reusing a tool ID from mutating an earlier turn.
      const identity = `${ev.turnId ?? ''}:${toolCallId}`
      const at = toolIndex.get(identity)
      const previous = at === undefined ? undefined : items[at]
      const prior = previous?.type === 'tool' ? previous.tool : undefined
      const payload = { ...prior?.payload, ...ev.payload }
      // acpx normalizes an omitted patch title to this placeholder. Keep the known
      // label while still applying real title changes, status, output and null fields.
      const isDefaultPatchTitle = ev.payload?.tag === 'tool_call_update' && ev.payload?.title === 'tool call'
      const state: ToolItemState = {
        toolCallId,
        title: isDefaultPatchTitle && prior ? prior.title : ev.text ?? prior?.title ?? '工具调用',
        status: typeof payload.status === 'string' ? payload.status : prior?.status ?? 'pending',
        payload
      }
      if (previous?.type === 'tool') previous.tool = state
      else {
        toolIndex.set(identity, items.length)
        items.push({ type: 'tool', key, tool: state })
      }
    } else if (ev.kind === 'permission') items.push({ type: 'perm', key, ev })
    else if (ev.kind === 'turn-done') items.push({ type: 'turn', key, text: ev.text ?? '本轮结束' })
    else items.push({ type: 'detail', key, ev })
  }
  // One processing disclosure owns its thoughts/tools. Answers, errors and
  // actionable permission requests remain outside this collapsible container.
  const sourceEvents = new Map(transcriptEvents.map((event) => [event.id, event]))
  const answers = new Set<string>()
  return items.filter((item) => {
    const source = sourceEvents.get(item.key)
    if (!source?.turnId) return true // Old records have no reliable turn identity.
    const identity = identityOf(source), group = activityGroups.get(identity)
    if (!group || !renderedActivity.has(identity)) return true
    if (item.type === 'thought' || (item.type === 'tool' && item.tool.status !== 'failed')) {
      group.children ??= []
      group.children.push(item)
      return false
    }
    if (item.type === 'agent' && !answers.has(identity)) { item.startsAnswer = true; answers.add(identity) }
    return true
  })
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
  if (isProblemLevel(payload?.type) || payload?.error || payload?.code !== undefined || payload?.status === 'failed' || isProblemLevel(payload?.status) || isProblemLevel(payload?.severity) || isProblemLevel(payload?.level)) return false
  if (event.kind === 'config') return true
  if (event.kind === 'diagnostic') return isNativeToolsInformation(event) || event.text === 'Runtime 更新'
  if (event.kind !== 'session-status') return false
  if (payload?.observation) return true // Actual observations remain visible in StartupGroup.
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
  for (const ev of live) if (!byId.has(ev.id)) byId.set(ev.id, ev)
  return [...byId.values()].sort((a, b) => a.ts - b.ts)
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
