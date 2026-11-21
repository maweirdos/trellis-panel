import { useEffect, useState, type JSX } from 'react'
import { Clock3, ShieldQuestion } from 'lucide-react'
import { AgentActivityMark } from './AgentActivityMark'
import { useInteractionActive } from '../utils/interaction-scope'
import type { CurrentTurnActivity } from './current-turn-activity'

/** One ephemeral body-tail affordance, independent of transcript segments. */
export function CurrentTurnStatus({ activity }: { activity: CurrentTurnActivity | null }): JSX.Element | null {
  const interactive = useInteractionActive()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!interactive || !activity || !['waiting', 'thinking'].includes(activity.phase) || !activity.waitingSince) return
    const tick = (): void => { if (!document.hidden) setNow(Date.now()) }
    tick()
    const timer = setTimeout(tick, Math.max(0, 15_000 - (Date.now() - activity.waitingSince)))
    document.addEventListener('visibilitychange', tick)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', tick) }
  }, [interactive, activity?.phase, activity?.waitingSince])
  if (!activity || !interactive) return null
  const elapsed = activity.waitingSince ? Math.max(0, Math.floor((now - activity.waitingSince) / 1000)) : 0
  return <div role="status" aria-label="当前回合状态" aria-live="polite" aria-atomic="true" data-phase={activity.phase} className="acp-current-turn-status">
    {activity.spinning ? <AgentActivityMark phase={activity.phase} /> : activity.phase === 'retrying' ? <Clock3 size={14} aria-hidden="true" /> : <ShieldQuestion size={14} aria-hidden="true" />}
    <span>{activity.label}</span>
    {['waiting', 'thinking'].includes(activity.phase) && elapsed >= 15 && !activity.detail && <span className="my-item-description">{activity.phase === 'thinking' ? '尚未返回新的可展示内容，可继续等待或停止' : '尚未返回可展示内容，可继续等待或停止'}</span>}
    {activity.detail && <span className="acp-knowledge-operation-query" title={activity.detail}>{activity.detail}</span>}
  </div>
}
