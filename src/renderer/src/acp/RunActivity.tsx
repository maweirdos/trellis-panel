import { useEffect, useId, useMemo, useState, type JSX, type ReactNode } from 'react'
import { CheckCircle2, ChevronRight, CircleAlert, CircleDashed, Loader2 } from 'lucide-react'
import { useInteractionActive } from '../utils/interaction-scope'
import { asObject, formatDuration, isConnectionTimelineEvent, type RenderItem } from './timeline'
import { projectRunProgress } from './run-progress'
import type { AcpSessionRecord, TimelineEvent } from '../../../shared/types'

type ActivityItem = Extract<RenderItem, { type: 'activity' }>
type Step = { key: string; label: string; duration?: number; failed: boolean; detail?: string; informational?: boolean; count?: number }

function activitySteps(events: TimelineEvent[]): Step[] {
  const steps = new Map<string, Step>()
  for (const event of events) {
    const observation = asObject(event.payload?.observation)
    if (observation && typeof observation.label === 'string') {
      const labels: Record<string, string> = {
        '启动 Runtime': '开始连接执行引擎', 'Runtime 进程已启动': '执行引擎已启动',
        'ACP 会话已就绪': '协议与会话已就绪', '收到首次响应': '已收到引擎响应',
        '收到首次模型响应': '收到首次模型响应',
        '原会话已连接，可以继续对话': '原会话已连接'
      }
      const label = labels[observation.label] ?? observation.label
      steps.set(`observation:${label}`, { key: `observation:${label}`, label, duration: typeof observation.durationMs === 'number' ? observation.durationMs : undefined, failed: observation.status === 'failed' })
      continue
    }
    const payload = event.payload
    const tag = String(payload?.tag ?? '')
    if (tag === 'usage_update' || event.text?.startsWith('usage updated')) continue // Occupancy belongs by the model picker.
    const input = asObject(payload?.input)
    let label = '', detail = ''
    if (tag === 'session_info_update') { label = '会话信息'; detail = '已同步' }
    else if (tag === 'available_commands_update') { label = '可用命令'; detail = '已更新' }
    else if (tag === 'current_mode_update') { label = '运行模式'; detail = typeof payload?.currentModeId === 'string' ? payload.currentModeId : '已同步' }
    else if (tag === 'config_option_update' || event.kind === 'config') {
      label = '会话配置'
      detail = input ? [input.kind, input.id, input.value].filter((value) => typeof value === 'string').join(' · ') : '已同步模型与运行参数'
    } else if (payload?.toolExecution === 'adapter-native') { label = '工具执行方式'; detail = '使用执行引擎的原生工具' }
    else { label = '引擎状态'; detail = event.text ?? '已更新' }
    const prior = steps.get(label)
    steps.set(label, { key: label, label, detail, informational: true, failed: false, count: (prior?.count ?? 0) + 1 })
  }
  return [...steps.values()]
}

export function RunActivity({ item, session, events, renderDetail }: { item: ActivityItem; session: AcpSessionRecord; events: TimelineEvent[]; renderDetail?: (item: RenderItem) => ReactNode }): JSX.Element {
  const interactive = useInteractionActive()
  const regionId = useId()
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const [now, setNow] = useState(Date.now)
  const currentGeneration = !item.connectionGeneration || item.connectionGeneration === session.connectionGeneration
  const currentTurn = Boolean(item.turnId && item.turnId === session.turnId && currentGeneration)
  const connecting = !item.turnId && currentGeneration && session.status === 'starting'
  const processing = !item.outcome && currentTurn && ['busy', 'awaiting_permission', 'cancelling'].includes(session.status)
  const running = connecting || processing
  const turnEvents = useMemo(() => events.filter((event) => event.source === 'acp' && event.turnId === item.turnId && event.connectionGeneration === item.connectionGeneration), [events, item.turnId, item.connectionGeneration])
  const preparationEvents = useMemo(() => {
    const sameConnection = events.filter((event) => event.source === 'acp' && event.connectionGeneration === item.connectionGeneration)
    const firstUser = sameConnection.find((event) => event.kind === 'message' && event.payload?.role === 'user')
    // Actual setup is context for the first real turn on this connection, not
    // a new transcript entry created merely by opening/restoring the page.
    const preparation = item.turnId && firstUser && firstUser.turnId === item.turnId
      ? sameConnection.filter((event) => event.ts <= firstUser.ts && isConnectionTimelineEvent(event)) : []
    return preparation
  }, [events, item.events, item.turnId, item.connectionGeneration])
  const connectionSteps = useMemo(() => activitySteps(preparationEvents), [preparationEvents])
  const connectionReady = !item.turnId && item.events.some((event) => /ACP 会话已就绪|原会话已连接/.test(String(asObject(event.payload?.observation)?.label ?? '')))
  const failed = item.outcome === 'failed'
  const completed = item.outcome === 'completed' || connectionReady
  const waitingPermission = currentTurn && session.status === 'awaiting_permission' && !item.outcome
  const cancelling = currentTurn && session.status === 'cancelling' && !item.outcome
  const hasReply = turnEvents.some((event) => event.kind === 'message' && event.payload?.role !== 'user')
  const hasThought = turnEvents.some((event) => event.kind === 'thought')
  const toolStates = new Map<string, string>()
  for (const event of turnEvents) {
    if (event.kind !== 'tool-call') continue
    const id = String(event.payload?.toolCallId ?? event.id)
    if (typeof event.payload?.status === 'string') toolStates.set(id, event.payload.status)
    else if (!toolStates.has(id)) toolStates.set(id, 'pending')
  }
  const toolRunning = [...toolStates.values()].some((status) => !['completed', 'failed'].includes(status))
  const activeLabel = connecting ? '正在连接执行引擎' : waitingPermission ? '等待你的授权' : cancelling ? '正在中止本次处理' : toolRunning ? '正在使用工具处理' : hasReply ? '正在生成回复' : hasThought ? '正在思考' : '等待模型回复'
  const progress = useMemo(() => projectRunProgress(item, turnEvents, running, activeLabel), [item, turnEvents, running, activeLabel])
  const label = running ? activeLabel
    : failed ? '本次处理未完成' : item.outcome === 'cancelled' ? '已中止' : completed ? item.turnId ? '用时' : '环境已就绪' : item.turnId ? '处理记录' : '连接记录'
  const start = item.startedAt
  const end = item.endedAt ?? (connectionReady ? item.events.filter((event) => event.payload?.observation).at(-1)?.ts : undefined)
  const duration = typeof start === 'number' && (typeof end === 'number' || running) ? Math.max(0, (end ?? Math.max(now, start)) - start) : undefined
  const hasDetails = progress.length > 0 || connectionSteps.length > 0 || (item.children?.length ?? 0) > 0
  const open = hasDetails && (expanded ?? running)

  useEffect(() => {
    if (!running || !interactive) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running, interactive, item.key])

  if (!hasDetails) return <></>
  const connectionDuration = [...connectionSteps].reverse().find((step) => /会话.*就绪|原会话已连接/.test(step.label))?.duration
  return <section className={`acp-run-activity${running ? ' is-running' : ''}${failed ? ' is-failed' : ''}`} aria-label={item.turnId ? '本次处理进度' : '连接进度'}>
    <button type="button" className={`acp-run-heading${hasDetails ? '' : ' is-static'}`} disabled={!hasDetails} aria-expanded={hasDetails ? open : undefined} aria-controls={hasDetails ? regionId : undefined} onClick={() => setExpanded(!open)}>
      {running && !waitingPermission && !open ? <Loader2 size={14} className="acp-progress-spinner" aria-hidden="true" /> : failed ? <CircleAlert size={14} /> : null}
      <span>{label}</span>{duration !== undefined && <span className="acp-run-duration">{duration < 1000 ? formatDuration(duration) : `${Math.floor(duration / 1000)} 秒`}</span>}{hasDetails && <ChevronRight size={12} className={`acp-run-chevron${open ? ' is-open' : ''}`} />}
    </button>
    <div id={regionId} hidden={!open} className="acp-run-body">
      {connectionSteps.length > 0 && <details className="acp-connection-context"><summary><CheckCircle2 size={14} /><span>连接已就绪</span>{connectionDuration !== undefined && <small>{formatDuration(connectionDuration)}</small>}<ChevronRight size={12} /></summary><div className="acp-connection-history"><p>此次连接在发送前已完成</p><ol>{connectionSteps.filter((step) => !step.informational).map((step) => <li key={step.key}><span className="acp-context-dot" aria-hidden="true" /><span>{step.label}</span>{step.duration !== undefined && <small>{formatDuration(step.duration)}</small>}</li>)}</ol>{connectionSteps.filter((step) => step.informational).map((step) => <p key={step.key}>{step.label} · {step.detail}</p>)}</div></details>}
      <ol className="acp-run-steps acp-run-steps-flat" aria-label="实际处理记录">
        {progress.map((step) => <li key={step.id} className={step.state === 'failed' ? 'is-failed' : step.state === 'running' ? 'is-current' : ''}>{step.state === 'completed' ? <CheckCircle2 size={14} /> : step.state === 'failed' ? <CircleAlert size={14} /> : step.state === 'running' && !waitingPermission ? <Loader2 size={14} className="acp-progress-spinner" /> : <CircleDashed size={14} />}<span>{step.label}</span>{step.startedAt !== undefined && (step.endedAt !== undefined || step.state === 'running') && <small>{formatDuration(Math.max(0, (step.endedAt ?? Math.max(now, step.startedAt)) - step.startedAt))}</small>}</li>)}
      </ol>
      {item.children && renderDetail && <div className="acp-run-children">{item.children.map((child) => renderDetail(child))}</div>}
    </div>
  </section>
}
