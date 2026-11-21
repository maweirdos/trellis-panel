import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { ChevronRight, Clock3, ShieldQuestion, Sparkles, Wrench } from 'lucide-react'
import { clsx } from 'clsx'
import { EventRow, type EventRowProps } from './TranscriptRow'
import { TranscriptProcessLeaf } from './TranscriptProcessLeaf'
import { asObject, formatDuration, type RenderItem } from './timeline'
import { isTranscriptEventIssue, isTranscriptRetryFailure, isTranscriptTurnActive, projectConversationTranscript, sameTranscriptOwner, segmentTranscriptEntries, transcriptProblemMessage, type TranscriptEntry, type TranscriptOwner, type TranscriptSegment, type TranscriptTurn } from './conversation-transcript'
import { InteractionScope, useInteractionActive } from '../utils/interaction-scope'
import type { CurrentTurnActivity } from './current-turn-activity'
import { projectRootKey } from '../my/navigation'
import { AgentActivityMark } from './AgentActivityMark'
import { FeedbackNotice } from '../my/FeedbackNotice'
import { describeConnectionError } from './ConnectionNotice'

export interface TranscriptActiveSegment {
  owner: TranscriptOwner
  turnKey: string
  segmentKey: string
  activity: CurrentTurnActivity
}

export type ConversationTranscriptProps = Omit<EventRowProps, 'item' | 'messagePresentation' | 'compact'> & {
  items: readonly RenderItem[]
  renderTurnArtifacts?: (owner: TranscriptOwner) => ReactNode
  /** The same activity used by CurrentTurnStatus; no second activity projector. */
  currentActivity?: CurrentTurnActivity | null
  /** Only an actual owned tail segment can take over tool/thought/knowledge feedback. */
  onActiveSegmentChange?: (segment: TranscriptActiveSegment | null) => void
  /** Host-owned conversion receipts hide only their exact internal turn. */
  suppressedTaskTurns?: readonly TranscriptOwner[]
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

function logKind(entry: TranscriptEntry, pendingPerm: EventRowProps['pendingPerm']): 'permission' | 'retry' | undefined {
  const item = entry.item
  if (item.type === 'perm' && !pendingPerm[String(item.ev.payload?.requestId ?? '')]) return 'permission'
  if (item.type === 'detail' && item.ev.payload?.tag === 'pi_retry' && !isTranscriptRetryFailure(entry)) return 'retry'
  return undefined
}

function RetryFailure({ entry }: { entry: TranscriptEntry }): JSX.Element | null {
  const reason = diagnosticMessage(entry)
  return <div data-acp-item={entry.item.key}><FeedbackNotice title="重试失败" diagnostic={reason} variant="inline" announcement={false} /></div>
}

function diagnosticMessage(entry: TranscriptEntry): string {
  return entry.item.type === 'detail' ? transcriptProblemMessage(entry.item.ev) : ''
}

function TurnFailure({ turn, entries, current, children }: { turn: TranscriptTurn; entries: readonly TranscriptEntry[]; current: boolean; children: ReactNode }): JSX.Element {
  const terminal = entries.find(entry => entry.item.key === turn.terminalId)
  const message = terminal ? diagnosticMessage(terminal) : ''
  const description = message && describeConnectionError(message)
  const diagnostic = entries.map(entry => [
    `事件：${entry.item.key}`,
    entry.item.type === 'detail' ? `来源：${entry.item.ev.source}` : `类型：${entry.item.type}`,
    diagnosticMessage(entry) || '执行引擎未返回进一步原因。'
  ].join('\n')).join('\n\n')
  return <div data-acp-item={turn.terminalId}><FeedbackNotice
    title={description && description.title !== '本次请求未完成' ? description.title : '本轮处理失败'}
    diagnostic={diagnostic}
    details={children}
    variant="inline"
    announcement={current}
  /></div>
}

function LogGroup({ entries, kind, render }: { entries: TranscriptEntry[]; kind: 'permission' | 'retry'; render: (entry: TranscriptEntry) => JSX.Element }): JSX.Element {
  return <details className="acp-process-leaf acp-log-group">
    <summary className="acp-turn-process-toggle">{kind === 'permission' ? <ShieldQuestion aria-hidden="true" /> : <Clock3 aria-hidden="true" />}<span>{kind === 'permission' ? `历史授权记录 · ${entries.length} 条` : '重试记录'}</span><ChevronRight className="acp-turn-process-chevron" aria-hidden="true" /></summary>
    <div className="acp-process-leaf-body">{entries.map(entry => kind === 'permission' ? render(entry) : entry.item.type === 'detail' ? <p data-acp-item={entry.item.key} key={entry.item.key} className="acp-retry-detail">{entry.item.ev.text ?? '重试状态更新'}</p> : null)}</div>
  </details>
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
      {activity?.spinning ? <AgentActivityMark phase={activity.phase} /> : tools ? <Wrench aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
      <span title={activity?.detail}>{label}</span><ChevronRight className={clsx('acp-turn-process-chevron', expanded && 'is-open')} aria-hidden="true" />
    </button>
    {activity && <span role="status" aria-label="当前回合状态" aria-live="polite" className="sr-only">{activity.label}</span>}
    <div id={regionId} className="acp-process-segment-body my-scrollbar" hidden={!expanded} tabIndex={expanded ? 0 : undefined} aria-label="过程详情">
      <InteractionScope active={expanded}>{expanded && segment.entries.map(entry => render(entry, true))}</InteractionScope>
    </div>
  </section>
}

function ProcessTurn({ turn, activeSegment, artifacts, ...props }: Omit<EventRowProps, 'item'> & { turn: TranscriptTurn; activeSegment: TranscriptActiveSegment | null; artifacts?: ReactNode }): JSX.Element {
  const regionId = useId()
  const [choice, setChoice] = useState<{ terminalId?: string; expanded: boolean } | null>(null)
  const ended = Boolean(turn.terminalId)
  const running = isTranscriptTurnActive(turn, props.session)
  const interactive = useInteractionActive()
  const ranHere = useRef(false)
  useLayoutEffect(() => { if (running && interactive) ranHere.current = true }, [interactive, running])
  const expanded = choice && choice.terminalId === turn.terminalId ? choice.expanded : !ended
  const pendingPermission = (entry: TranscriptEntry): boolean => entry.item.type === 'perm' && Boolean(props.pendingPerm[String(entry.item.ev.payload?.requestId ?? '')])
  const process = turn.process
  const visibleIssue = (entry: TranscriptEntry): boolean => entry.item.type === 'tool' && entry.item.tool.status === 'failed'
    || entry.item.type === 'detail' && (entry.item.ev.kind === 'turn-done' || isTranscriptEventIssue(entry.item.ev)) || isTranscriptRetryFailure(entry)
  const deliveryKeys = new Set(turn.delivery.map(entry => entry.item.key))
  const persistent = (entry: TranscriptEntry): boolean => visibleIssue(entry) || pendingPermission(entry) || deliveryKeys.has(entry.item.key)
  const details = turn.entries.filter(entry => !persistent(entry))
  const parts = ended ? details.map(entry => ({ type: 'entry' as const, key: entry.item.key, entry })) : segmentTranscriptEntries(turn.entries)
  const hasDetails = details.length > 0
  const failed = turn.outcome === 'failed'
  const hasIndependentPersistent = turn.failure && turn.entries.some(entry => entry.item.key !== turn.terminalId && persistent(entry))
  const foldProcess = Boolean(turn.failure && hasDetails && !hasIndependentPersistent)
  const durationLabel = turn.durationMs !== undefined ? `用时 ${formatDuration(turn.durationMs)}` : undefined
  const label = !failed && durationLabel ? durationLabel : '处理过程'
  const status = turn.outcome === 'cancelled' ? '已中止' : undefined
  const showProcess = failed
    ? hasDetails && !foldProcess
    : process.length > 0 || (!ended && turn.entries.length > 0) || durationLabel || status || (running && turn.startedAt !== undefined)
  const render = (entry: TranscriptEntry, thoughtBody = false): JSX.Element => <TranscriptProcessLeaf
    {...props} key={entry.item.key} item={entry.item}
    suppressWorkingIndicator thoughtBody={thoughtBody} messagePresentation={entry.presentation} announceFailure={running && interactive}
  />
  const renderedParts: JSX.Element[] = []
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (part.type === 'segment') {
      renderedParts.push(<ProcessSegment key={part.key} segment={part} current={running && index === parts.length - 1 && part.entries.at(-1)?.item.key === turn.lastItemKey} activity={activeSegment?.turnKey === turn.key && activeSegment.segmentKey === part.key ? activeSegment.activity : undefined} render={render} />)
      continue
    }
    const entry = part.entry
    const kind = logKind(entry, props.pendingPerm)
    if (!kind) { renderedParts.push(render(entry)); continue }
    const group = [entry]
    while (index + 1 < parts.length) {
      const next = parts[index + 1]
      if (next.type !== 'entry' || logKind(next.entry, props.pendingPerm) !== kind) break
      group.push(next.entry); index++
    }
    renderedParts.push(<LogGroup key={part.key} entries={group} kind={kind} render={render} />)
  }
  return <section className={clsx('acp-transcript-turn', ended && 'is-ended')} data-acp-turn={turn.key}>
    {showProcess && <div className="acp-turn-process">
      {running && turn.startedAt !== undefined && <div className="acp-turn-elapsed"><Clock3 aria-hidden="true" /><RunningElapsed startedAt={turn.startedAt} /></div>}
      {(!running || ended) && <button type="button" className="acp-turn-process-toggle" disabled={!hasDetails} aria-label={`${label}${status ? ` · ${status}` : ''}`} aria-expanded={hasDetails ? expanded : undefined} aria-controls={hasDetails ? regionId : undefined} onClick={() => setChoice({ terminalId: turn.terminalId, expanded: !expanded })}>
        <Clock3 aria-hidden="true" />
        <span>{label}</span>{status && <span className="acp-turn-process-outcome">{status}</span>}{hasDetails && <ChevronRight className={clsx('acp-turn-process-chevron', expanded && 'is-open')} aria-hidden="true" />}
      </button>}
      <div id={regionId} className="acp-turn-process-body my-scrollbar" hidden={!expanded}><InteractionScope active={expanded}>{expanded && renderedParts}</InteractionScope></div>
    </div>}
    {ended && <div className="acp-turn-delivery">
      {turn.entries.filter(persistent).map(entry => {
        if (turn.failure && entry.item.key === turn.terminalId) {
          return <TurnFailure key={entry.item.key} turn={turn} entries={turn.failure} current={interactive && ranHere.current}>
            {durationLabel && <p className="acp-turn-duration-detail">{durationLabel}</p>}
            {foldProcess && renderedParts}
          </TurnFailure>
        }
        return isTranscriptRetryFailure(entry) ? <RetryFailure key={entry.item.key} entry={entry} /> : render(entry)
      })}
    </div>}
    {artifacts}
  </section>
}

/** The host keeps admission/wait/retry/permission/cancel feedback when no segment owns it. */
export function ConversationTranscript({ items, currentActivity, onActiveSegmentChange, renderTurnArtifacts, suppressedTaskTurns, ...props }: ConversationTranscriptProps): JSX.Element {
  const interactive = useInteractionActive()
  const nodes = useMemo(() => projectConversationTranscript(items, props.events ?? []), [items, props.events])
  const visibleNodes = useMemo(() => suppressedTaskTurns?.length
    ? nodes.filter(node => node.type !== 'turn' || !suppressedTaskTurns.some(owner => sameTranscriptOwner(owner, node.owner)))
    : nodes, [nodes, suppressedTaskTurns])
  const tail = visibleNodes.at(-1)
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
  const renderRow = (entry: TranscriptEntry): JSX.Element => entry.item.type === 'user' || entry.item.type === 'agent'
    ? <EventRow {...props} key={entry.item.key} item={entry.item} messagePresentation={entry.presentation} />
    : <TranscriptProcessLeaf {...props} key={entry.item.key} item={entry.item} messagePresentation={entry.presentation} />
  const rendered: JSX.Element[] = []
  for (let index = 0; index < visibleNodes.length; index++) {
    const node = visibleNodes[index]
    if (node.type === 'turn') { const later = visibleNodes.slice(index + 1).some(next => next.type === 'turn' && sameTranscriptOwner(next.owner, node.owner)); rendered.push(<ProcessTurn {...props} key={node.key} turn={node} activeSegment={activeSegment} artifacts={!later ? renderTurnArtifacts?.(node.owner) : undefined} />); continue }
    if (isTranscriptRetryFailure(node.entry)) { rendered.push(<RetryFailure key={node.key} entry={node.entry} />); continue }
    const kind = logKind(node.entry, props.pendingPerm)
    if (!kind || !('ev' in node.entry.item)) { rendered.push(renderRow(node.entry)); continue }
    const event = node.entry.item.ev
    const group = [node.entry]
    while (index + 1 < nodes.length) {
      const next = nodes[index + 1]
      if (next.type !== 'row' || logKind(next.entry, props.pendingPerm) !== kind || !('ev' in next.entry.item)) break
      const other = next.entry.item.ev
      if (other.source !== event.source || projectRootKey(other.projectRoot) !== projectRootKey(event.projectRoot) || other.sessionId !== event.sessionId || other.connectionGeneration !== event.connectionGeneration || other.turnId !== event.turnId) break
      group.push(next.entry); index++
    }
    rendered.push(<LogGroup key={node.key} entries={group} kind={kind} render={renderRow} />)
  }
  return <>{rendered}</>
}
