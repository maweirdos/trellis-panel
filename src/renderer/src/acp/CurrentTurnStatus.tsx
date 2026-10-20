import type { JSX } from 'react'
import { Loader2, ShieldQuestion } from 'lucide-react'
import type { CurrentTurnActivity } from './current-turn-activity'

/** One ephemeral body-tail affordance, independent of transcript segments. */
export function CurrentTurnStatus({ activity }: { activity: CurrentTurnActivity | null }): JSX.Element | null {
  if (!activity) return null
  return <div role="status" aria-label="当前回合状态" aria-live="polite" aria-atomic="true" data-phase={activity.phase} className="acp-current-turn-status">
    {activity.spinning ? <Loader2 size={14} className="acp-current-turn-spinner acp-progress-spinner" aria-hidden="true" /> : <ShieldQuestion size={14} aria-hidden="true" />}
    <span>{activity.label}</span>
    {activity.detail && <span className="acp-knowledge-operation-query" title={activity.detail}>{activity.detail}</span>}
  </div>
}
