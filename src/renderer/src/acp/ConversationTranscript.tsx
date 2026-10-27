import { useEffect, useId, useLayoutEffect, useMemo, useState, type JSX } from 'react'
import { ChevronRight, CircleAlert, Clock3, Loader2, Sparkles, Wrench } from 'lucide-react'
import { clsx } from 'clsx'
import { EventRow, type EventRowProps } from './TranscriptRow'
import { TranscriptProcessLeaf } from './TranscriptProcessLeaf'
import { formatDuration, type RenderItem } from './timeline'
import { isTranscriptTurnActive, projectConversationTranscript, segmentTranscriptEntries, type TranscriptEntry, type TranscriptOwner, type TranscriptSegment, type TranscriptTurn } from './conversation-transcript'
import { InteractionScope, useInteractionActive } from '../utils/interaction-scope'
import type { CurrentTurnActivity } from './current-turn-activity'
import { projectRootKey } from '../my/navigation'

export interface TranscriptActiveSegment {
  owner: TranscriptOwner
  turnKey: string
  segmentKey: string
  activity: CurrentTurnActivity
}

export type ConversationTranscriptProps = Omit<EventRowProps, 'item' | 'messagePresentation' | 'compact'> & {
  items: readonly RenderItem[]
  /** The same activity used by CurrentTurnStatus; no second activity projector. */
  currentActivity?: CurrentTurnActivity | null
  /** Only an actual owned tail segment can take over tool/thought/knowledge feedback. */
  onActiveSegmentChange?: (segment: TranscriptActiveSegment | null) => void
}

/** A timestamp must come from this turn's recorded start, never its first loaded token. */
function RunningElapsed({ startedAt }: { startedAt: number }): JSX.Element {
  const interactive = useInteractionActive()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!interactive) return
    let timer: number | undefined
    const refresh = (): void => {
      window.clearInterval(timer)
      if (document.hidden) return
      setNow(Date.now())
      timer = window.setInterval(() => setNow(Date.now()), 1000)
    }
    refresh()
    document.addEventListener('visibilitychange', refresh)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [interactive, startedAt])
  return <span>已处理 {formatDuration(Math.max(0, now - startedAt))}</span>
}

function segmentLabel(segment: TranscriptSegment): string {
  const tools = segment.entries.filter(entry => entry.item.type === 'tool' || entry.item.type === 'knowledge-operation').length
  const thoughts = segment.entries.some(entry => entry.item.type === 'thought')
  if (tools) return `${thoughts ? '思考与工具' : '工具调用'} · ${tools} 项`
  return thoughts ? '思考' : '处理记录'
}

function ProcessSegment({ segment, current, activity, render }: {
  segment: TranscriptSegment
  current: boolean
  activity?: CurrentTurnActivity
  render: (entry: TranscriptEntry, thoughtBody?: boolean) => JSX.Element
}): JSX.Element {
  const regionId = useId()
  // A later body closes the preceding section once; reopening a past section is local.
  const epoch = current
  const [choice, setChoice] = useState<{ epoch: boolean; expanded: boolean } | null>(null)
  const expanded = choice?.epoch === epoch ? choice.expanded : false
  const label = activity?.label ?? segmentLabel(segment)
  const tools = segment.entries.some(entry => entry.item.type === 'tool' || entry.item.type === 'knowledge-operation')
  return <section className="acp-process-segment" data-acp-segment={segment.key} data-state={current ? 'current' : 'past'}>
    <button type="button" className="acp-turn-process-toggle" aria-expanded={expanded} aria-controls={regionId} onClick={() => setChoice({ epoch, expanded: !expanded })}>
      {activity?.spinning ? <Loader2 className="acp-progress-spinner" aria-hidden="true" /> : tools ? <Wrench aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
      <span title={activity?.detail}>{label}</span><ChevronRight className={clsx('acp-turn-process-chevron', expanded && 'is-open')} aria-hidden="true" />
    </button>
    {activity && <span role="status" aria-label="当前回合状态" aria-live="polite" className="sr-only">{activity.label}</span>}
    <div id={regionId} className="acp-process-segment-body my-scrollbar" hidden={!expanded} tabIndex={expanded ? 0 : undefined} aria-label="过程详情">
      <InteractionScope active={expanded}>{expanded && segment.entries.map(entry => render(entry, true))}</InteractionScope>
    </div>
  </section>
}

function ProcessTurn({ turn, activeSegment, ...props }: Omit<EventRowProps, 'item'> & { turn: TranscriptTurn; activeSegment: TranscriptActiveSegment | null }): JSX.Element {
  const regionId = useId()
  const [choice, setChoice] = useState<{ terminalId?: string; expanded: boolean } | null>(null)
  const ended = Boolean(turn.terminalId)
  const running = isTranscriptTurnActive(turn, props.session)
  const expanded = choice && choice.terminalId === turn.terminalId ? choice.expanded : !ended
  const pendingPermission = (entry: TranscriptEntry): boolean => entry.item.type === 'perm' && Boolean(props.pendingPerm[String(entry.item.ev.payload?.requestId ?? '')])
  const process = turn.process
  const parts = segmentTranscriptEntries(process)
  const permissions = turn.process.filter(pendingPermission)
  const hasDetails = process.some(entry => !pendingPermission(entry))
  const label = turn.durationMs !== undefined ? `用时 ${formatDuration(turn.durationMs)}` : '处理过程'
  const problem = turn.outcome === 'failed'
  const status = problem ? '处理失败' : turn.outcome === 'cancelled' ? '已中止' : undefined
  const render = (entry: TranscriptEntry, thoughtBody = false): JSX.Element => <TranscriptProcessLeaf
    {...props} key={entry.item.key} item={entry.item}
    suppressWorkingIndicator thoughtBody={thoughtBody} messagePresentation={entry.presentation}
  />
  return <section className={clsx('acp-transcript-turn', ended && 'is-ended')} data-acp-turn={turn.key}>
    {(process.length > 0 || turn.durationMs !== undefined || status || running && turn.startedAt !== undefined) && <div className={clsx('acp-turn-process', problem && 'has-issues')}>
      {running && turn.startedAt !== undefined && <div className="acp-turn-elapsed"><Clock3 aria-hidden="true" /><RunningElapsed startedAt={turn.startedAt} /></div>}
      {(!running || ended) && <button type="button" className="acp-turn-process-toggle" disabled={!hasDetails} aria-label={`${label}${status ? ` · ${status}` : ''}`} aria-expanded={hasDetails ? expanded : undefined} aria-controls={hasDetails ? regionId : undefined} onClick={() => setChoice({ terminalId: turn.terminalId, expanded: !expanded })}>
        {problem ? <CircleAlert aria-hidden="true" /> : <Clock3 aria-hidden="true" />}
        <span>{label}</span>{status && <span className="acp-turn-process-outcome">{status}</span>}{hasDetails && <ChevronRight className={clsx('acp-turn-process-chevron', expanded && 'is-open')} aria-hidden="true" />}
      </button>}
      <div id={regionId} className="acp-turn-process-body my-scrollbar" hidden={!expanded}><InteractionScope active={expanded}>{ended
        ? process.filter(entry => !pendingPermission(entry)).map(entry => render(entry))
        : parts.map((part, index) => part.type === 'segment'
          ? <ProcessSegment key={part.key} segment={part} current={running && index === parts.length - 1 && part.entries.at(-1)?.item.key === turn.lastItemKey} activity={activeSegment?.turnKey === turn.key && activeSegment.segmentKey === part.key ? activeSegment.activity : undefined} render={render} />
          : pendingPermission(part.entry) ? null : render(part.entry))}</InteractionScope></div>
    </div>}
    {permissions.map(entry => render(entry))}
    {turn.delivery.length > 0 && <div className="acp-turn-delivery">{turn.delivery.map(entry => render(entry))}</div>}
  </section>
}

/** The host keeps admission/wait/retry/permission/cancel feedback when no segment owns it. */
export function ConversationTranscript({ items, currentActivity, onActiveSegmentChange, ...props }: ConversationTranscriptProps): JSX.Element {
  const interactive = useInteractionActive()
  const nodes = useMemo(() => projectConversationTranscript(items, props.events ?? []), [items, props.events])
  const tail = nodes.at(-1)
  const lastPart = tail?.type === 'turn' ? segmentTranscriptEntries(tail.process).at(-1) : undefined
  const lastItem = lastPart?.type === 'segment' ? lastPart.entries.at(-1)?.item : undefined
  // A new thinking-start without a body belongs to the host, not an old thought.
  const lastThoughtSignal = lastItem?.type === 'thought' && tail?.type === 'turn' ? [...(props.events ?? [])].reverse().find(event =>
    event.source === tail.owner.source && projectRootKey(event.projectRoot) === projectRootKey(tail.owner.projectRoot)
    && event.sessionId === tail.owner.sessionId && event.connectionGeneration === tail.owner.connectionGeneration && event.turnId === tail.owner.turnId
    && (event.kind === 'thought' || event.payload?.tag === 'pi_thinking' || event.payload?.tag === 'pi_thinking_empty')) : undefined
  const matchesActivity = currentActivity?.phase === 'thinking' && lastItem?.type === 'thought' && lastThoughtSignal?.kind === 'thought' && Boolean(lastThoughtSignal.text?.trim())
    || currentActivity?.phase === 'tool' && lastItem?.type === 'tool' && !['completed', 'failed', 'cancelled'].includes(lastItem.tool.status)
    || currentActivity?.phase === 'knowledge' && lastItem?.type === 'knowledge-operation' && lastItem.operation.phase === 'running'
  const segmentKey = interactive && currentActivity && matchesActivity
    && tail?.type === 'turn' && isTranscriptTurnActive(tail, props.session) && lastPart?.type === 'segment' && lastPart.entries.at(-1)?.item.key === tail.lastItemKey ? lastPart.key : undefined
  const turnKey = segmentKey && tail?.type === 'turn' ? tail.key : undefined
  const owner = tail?.type === 'turn' ? tail.owner : undefined
  const activeSegment = useMemo<TranscriptActiveSegment | null>(() => segmentKey && turnKey && owner && currentActivity
    ? { owner, turnKey, segmentKey, activity: currentActivity } : null,
  [segmentKey, turnKey, owner?.source, owner?.projectRoot, owner?.sessionId, owner?.connectionGeneration, owner?.turnId, currentActivity])
  useLayoutEffect(() => { onActiveSegmentChange?.(activeSegment) }, [activeSegment, onActiveSegmentChange])
  useLayoutEffect(() => () => { onActiveSegmentChange?.(null) }, [onActiveSegmentChange])
  return <>{nodes.map(node => node.type === 'turn'
    ? <ProcessTurn {...props} key={node.key} turn={node} activeSegment={activeSegment} />
    : node.entry.item.type === 'user' || node.entry.item.type === 'agent'
      ? <EventRow {...props} key={node.key} item={node.entry.item} messagePresentation={node.entry.presentation} />
      : <TranscriptProcessLeaf {...props} key={node.key} item={node.entry.item} messagePresentation={node.entry.presentation} />)}</>
}
