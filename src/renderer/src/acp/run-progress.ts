import { isConversationRuntimeEvent } from './runtime-events'
import type { TimelineEvent } from '../../../shared/types'
import type { RenderItem } from './timeline'
import { projectRootKey } from '../my/navigation'

type Activity = Extract<RenderItem, { type: 'activity' }>
export interface RunProgressStep {
  id: string
  label: string
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  startedAt?: number
  endedAt?: number
}

/** Project recorded observations in this segment only. Later output is not a step here. */
export function projectRunProgress(item: Activity, events: TimelineEvent[], running: boolean, activeLabel: string): RunProgressStep[] {
  const segmentIds = new Set(item.events.map((event) => event.id))
  const scoped = events.filter((event) => segmentIds.has(event.id) && isConversationRuntimeEvent(event) && event.sessionId === item.sessionId && projectRootKey(event.projectRoot) === projectRootKey(item.projectRoot) && (item.scope === 'connection' || event.turnId === item.turnId) && event.connectionGeneration === item.connectionGeneration && (item.scope === 'connection' || event.payload?.activityScope !== 'connection'))
  return scoped.flatMap((event, index): RunProgressStep[] => {
    const observation = event.payload?.observation
    if (!observation || typeof observation !== 'object' || !('label' in observation) || typeof observation.label !== 'string' || !observation.label.trim()) return []
    const failed = 'status' in observation && observation.status === 'failed'
    const reached = ['指令已发送至引擎', '收到首次模型响应', 'ACP 会话已就绪', '原会话已连接，可以继续对话'].includes(observation.label)
    const current = running && index === scoped.length - 1 && !failed
    // A duration is a recorded latency, never a guessed interval between updates.
    const duration = 'durationMs' in observation && typeof observation.durationMs === 'number' && Number.isFinite(observation.durationMs) && observation.durationMs >= 0 ? observation.durationMs : undefined
    return [{ id: event.id, label: current ? activeLabel : observation.label, state: failed ? 'failed' : current ? 'running' : reached ? 'completed' : 'unknown', ...(duration === undefined ? {} : { startedAt: event.ts - duration, endedAt: event.ts }) }]
  })
}
