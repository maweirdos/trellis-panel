import { useEffect, useId, useMemo, useState, type JSX } from 'react'
import { CheckCircle2, ChevronRight, CircleAlert, CircleDashed } from 'lucide-react'
import { AgentActivityMark } from './AgentActivityMark'
import { useInteractionActive } from '../utils/interaction-scope'
import { asObject, formatDuration, type RenderItem } from './timeline'
import { projectRunProgress } from './run-progress'
import type { AcpSessionRecord } from '../../../shared/types'
import { projectRootKey } from '../my/navigation'

type ActivityItem = Extract<RenderItem, { type: 'activity' }>

/** A disclosure owns only adjacent observations, never the rest of a turn. */
export function RunActivity({ item, session }: { item: ActivityItem; session: AcpSessionRecord }): JSX.Element {
  const interactive = useInteractionActive()
  const regionId = useId()
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now)
  const connection = item.scope === 'connection'
  const currentOwner = item.connectionGeneration === session.connectionGeneration && item.sessionId === session.sessionId && projectRootKey(item.projectRoot) === projectRootKey(session.projectRoot)
  const currentTurn = Boolean(item.turnId && item.turnId === session.turnId && currentOwner)
  const running = Boolean(item.active && !item.outcome && (connection ? currentOwner && session.status === 'starting' : currentTurn && ['busy', 'awaiting_permission', 'cancelling'].includes(session.status)))
  const waitingPermission = running && session.status === 'awaiting_permission'
  const latestLabel = String(asObject(item.events.at(-1)?.payload?.observation)?.label ?? '处理记录')
  const activeLabel = connection ? '正在连接执行引擎' : waitingPermission ? '等待你的授权' : session.status === 'cancelling' ? '正在中止本次处理' : latestLabel === '开始处理' ? '正在发送指令' : ['指令已发送至引擎', '供应商响应已建立'].includes(latestLabel) ? '等待模型回复' : ['收到首次模型响应', '收到首个可展示内容'].includes(latestLabel) ? '正在生成回复' : latestLabel
  const activityPhase = !connection && ['指令已发送至引擎', '供应商响应已建立'].includes(latestLabel) ? 'waiting' : undefined
  const progress = useMemo(() => projectRunProgress(item, item.events, running, activeLabel), [item, running, activeLabel])
  const failed = item.outcome === 'failed'
  const label = running ? activeLabel : failed ? connection ? '连接未完成' : '本次处理未完成' : item.outcome === 'cancelled' ? '已中止' : item.outcome === 'completed' ? connection ? '连接已就绪' : '回复已完成' : latestLabel
  const duration = item.startedAt !== undefined && (item.endedAt !== undefined || running)
    ? Math.max(0, (item.endedAt ?? Math.max(now, item.startedAt)) - item.startedAt) : undefined
  const hasDetails = progress.length > 0

  useEffect(() => {
    if (!running || !interactive) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running, interactive, item.key])

  return <section data-acp-item={item.key} className={`acp-run-activity${running ? ' is-running' : ''}${failed ? ' is-failed' : ''}`} aria-label="处理记录">
    <button type="button" className={`acp-run-heading${hasDetails ? '' : ' is-static'}`} disabled={!hasDetails} aria-expanded={hasDetails ? expanded : undefined} aria-controls={hasDetails ? regionId : undefined} onClick={() => setExpanded(!expanded)}>
      {running && !waitingPermission && !expanded ? <AgentActivityMark phase={activityPhase} active={interactive} /> : failed ? <CircleAlert size={14} /> : null}
      <span>{label}</span>{duration !== undefined && <span className="acp-run-duration">{formatDuration(duration)}</span>}{hasDetails && <ChevronRight size={12} className={`acp-run-chevron${expanded ? ' is-open' : ''}`} />}
    </button>
    <div id={regionId} hidden={!expanded} className="acp-run-body">
      <ol className="acp-run-steps acp-run-steps-flat" aria-label="实际处理记录">
        {progress.map((step) => <li key={step.id} className={step.state === 'failed' ? 'is-failed' : step.state === 'running' ? 'is-current' : ''}>{step.state === 'completed' ? <CheckCircle2 size={14} /> : step.state === 'failed' ? <CircleAlert size={14} /> : step.state === 'running' && !waitingPermission ? <AgentActivityMark phase={activityPhase} size={16} active={interactive && expanded} className="acp-run-step-activity" /> : <CircleDashed size={14} />}<span>{step.label}</span>{step.startedAt !== undefined && step.endedAt !== undefined && <small>{formatDuration(Math.max(0, step.endedAt - step.startedAt))}</small>}</li>)}
      </ol>
    </div>
  </section>
}
