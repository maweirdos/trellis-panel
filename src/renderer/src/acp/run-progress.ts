import type { TimelineEvent } from '../../../shared/types'
import type { RenderItem } from './timeline'

type Activity = Extract<RenderItem, { type: 'activity' }>
export interface RunProgressStep {
  id: string
  label: string
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  startedAt?: number
  endedAt?: number
}

/** Show only reached stages. A reported start is not proof of completion. */
export function projectRunProgress(item: Activity, events: TimelineEvent[], running: boolean, activeLabel: string): RunProgressStep[] {
  const scoped = events.filter((event) => event.source === 'acp' && event.turnId === item.turnId && event.connectionGeneration === item.connectionGeneration && event.payload?.activityScope !== 'connection')
  const observation = (name: string): TimelineEvent | undefined => scoped.find((event) => {
    const value = event.payload?.observation
    return value !== null && typeof value === 'object' && 'label' in value && value.label === name
  })
  const started = observation('开始处理')
  const sent = observation('指令已发送至引擎') ?? scoped.find((event) => event.kind === 'message' && event.payload?.role === 'user')
  // Legacy first-response observations included metadata; use actual content
  // instead when the new model-response marker is absent.
  const response = observation('收到首次模型响应') ?? scoped.find((event) => ((event.kind === 'message' && event.payload?.role !== 'user') || event.kind === 'thought') && Boolean(event.text?.trim()) || event.kind === 'tool-call' || event.kind === 'plan')
  const terminal = item.outcome
  const unfinishedState = (): RunProgressStep['state'] => terminal === 'failed' ? 'failed' : terminal === 'cancelled' ? 'cancelled' : running ? 'running' : 'unknown'
  const steps: RunProgressStep[] = []
  if (started || sent) steps.push({ id: 'dispatch', label: sent ? '指令已发送' : terminal === 'failed' ? '发送指令 · 未完成' : terminal === 'cancelled' ? '发送指令 · 已中止' : running ? '正在发送指令' : '指令发送记录', state: sent ? 'completed' : unfinishedState(), startedAt: started?.ts, endedAt: sent?.ts ?? item.endedAt })
  if (sent || response) steps.push({ id: 'response', label: response ? '已收到模型响应' : terminal === 'failed' ? '等待模型响应 · 未完成' : terminal === 'cancelled' ? '等待模型响应 · 已中止' : running ? '等待模型响应' : '模型响应未记录', state: response ? 'completed' : unfinishedState(), startedAt: sent?.ts, endedAt: response?.ts ?? item.endedAt })
  if (response) steps.push({ id: 'generation', label: terminal === 'completed' ? '本次回复已完成' : terminal === 'failed' ? '本次回复未完成' : terminal === 'cancelled' ? '本次回复已中止' : running ? activeLabel : '处理记录 · 结束状态未记录', state: terminal === 'completed' ? 'completed' : unfinishedState(), startedAt: response.ts, endedAt: item.endedAt })
  return steps
}
