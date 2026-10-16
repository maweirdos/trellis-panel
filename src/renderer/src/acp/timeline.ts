import type { AcpSessionStatus, TimelineEvent } from '../../../shared/types'

export interface ToolItemState {
  toolCallId: string
  title: string
  status: string
  payload: Record<string, unknown>
}

export type RenderItem =
  | { type: 'user' | 'agent' | 'thought'; key: string; text: string }
  | { type: 'tool'; key: string; tool: ToolItemState }
  | { type: 'activity'; key: string; events: TimelineEvent[] }
  | { type: 'perm' | 'trellis' | 'detail'; key: string; ev: TimelineEvent }
  | { type: 'turn'; key: string; text: string }

/** Projection only: protocol ownership and partial-update validation live in the runtime. */
export function compileItems(events: TimelineEvent[]): RenderItem[] {
  const items: RenderItem[] = []
  const toolIndex = new Map<string, number>()
  const activityGroups = new Map<string, Extract<RenderItem, { type: 'activity' }>>()
  for (const ev of events) {
    const key = ev.id
    if (ev.source === 'trellis') {
      items.push({ type: 'trellis', key, ev })
      continue
    }
    if (isRoutineRuntimeEvent(ev)) {
      const identity = `${ev.connectionGeneration ?? ''}:${ev.turnId ?? ''}`
      const existing = activityGroups.get(identity)
      if (existing) existing.events.push(ev)
      else {
        const group: Extract<RenderItem, { type: 'activity' }> = { type: 'activity', key: `activity:${key}`, events: [ev] }
        activityGroups.set(identity, group)
        items.push(group)
      }
      continue
    }
    if (ev.kind === 'message' || ev.kind === 'thought') {
      const type = ev.kind === 'thought' ? 'thought' : ev.payload?.role === 'user' ? 'user' : 'agent'
      const last = items[items.length - 1]
      if (type !== 'user' && last?.type === type) last.text += ev.text ?? ''
      else items.push({ type, key, text: ev.text ?? '' })
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
  return items
}

/** Keep explicit errors and unknown diagnostics visible; collapse routine runtime metadata only. */
function isRoutineRuntimeEvent(event: TimelineEvent): boolean {
  const payload = event.payload
  if (payload?.type === 'error' || payload?.error || payload?.status === 'failed' || payload?.status === 'error' || payload?.severity === 'error' || payload?.severity === 'warning' || payload?.level === 'error' || payload?.level === 'warn') return false
  if (event.kind === 'config') return true
  if (event.kind === 'diagnostic') return event.text === 'Runtime 更新'
  if (event.kind !== 'session-status') return false
  if (payload?.observation) return true // Actual observations remain visible in StartupGroup.
  const tag = payload?.tag
  return tag === 'usage_update' || tag === 'session_info_update' || tag === 'available_commands_update' || tag === 'current_mode_update' || tag === 'config_option_update' || tag === 'update'
    || event.text === 'session updated' || event.text?.startsWith('usage updated') === true
}

export function runtimeActivityLabel(event: TimelineEvent): string {
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
