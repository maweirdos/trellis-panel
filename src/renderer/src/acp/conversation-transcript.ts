import type { AcpSessionRecord, TimelineEvent } from '../../../shared/types'
import { projectRootKey } from '../my/navigation'
import { asObject, isConnectionTimelineEvent, isRoutineRuntimeEvent, type RenderItem } from './timeline'
import { isConversationRuntimeEvent } from './runtime-events'

export type MessagePresentation = 'process' | 'final'

export interface TranscriptEntry {
  item: RenderItem
  presentation: MessagePresentation
}

export interface TranscriptSegment {
  type: 'segment'
  key: string
  entries: TranscriptEntry[]
}

export type TranscriptPart = TranscriptSegment | { type: 'entry'; key: string; entry: TranscriptEntry }

export interface TranscriptOwner {
  source: TimelineEvent['source']
  projectRoot: string
  sessionId: string
  connectionGeneration: string
  turnId: string
}
export function sameTranscriptOwner(left: TranscriptOwner, right: TranscriptOwner): boolean {
  return left.source === right.source && projectRootKey(left.projectRoot) === projectRootKey(right.projectRoot) && left.sessionId === right.sessionId && left.connectionGeneration === right.connectionGeneration && left.turnId === right.turnId
}

export interface TranscriptTurn {
  type: 'turn'
  key: string
  owner: TranscriptOwner
  entries: TranscriptEntry[]
  process: TranscriptEntry[]
  delivery: TranscriptEntry[]
  lastItemKey?: string
  startedAt?: number
  terminalId?: string
  outcome?: 'completed' | 'cancelled' | 'failed'
  failure?: TranscriptEntry[]
  durationMs?: number
  issues: number
}

export type TranscriptNode = TranscriptTurn | { type: 'row'; key: string; entry: TranscriptEntry }

function owner(event: TimelineEvent): string | undefined {
  if (!event.projectRoot?.trim() || !event.sessionId?.trim() || !event.connectionGeneration?.trim() || !event.turnId?.trim() || event.payload?.activityScope === 'connection') return undefined
  return JSON.stringify([projectRootKey(event.projectRoot), event.sessionId, event.connectionGeneration, event.turnId])
}

function origin(item: RenderItem, byId: ReadonlyMap<string, TimelineEvent>): TimelineEvent | undefined {
  if ('ev' in item) return byId.get(item.key) ?? item.ev
  if ('events' in item) return item.events[0]
  return byId.get(item.key)
}

/** Only declared phase is authoritative. Do not infer phase from answer wording. */
function messagePhase(item: RenderItem, event: TimelineEvent | undefined): string | undefined {
  const projected = asObject(item)
  if (typeof projected?.phase === 'string') return projected.phase
  const compiledPhase = projected?.providerPhase
  // A structured block has already been replayed by compileItems. An absent
  // compiled phase can also be an authoritative removal of its original phase.
  if (typeof compiledPhase === 'string' || asObject(event?.payload?.meta)?.piText !== undefined) return typeof compiledPhase === 'string' ? compiledPhase : undefined
  const phase = asObject(projected?.meta)?.phase ?? asObject(event?.payload?.meta)?.phase
  return typeof phase === 'string' ? phase : undefined
}

/** The old prefix diagnostic was an adapter limitation, not a failed completed turn. */
export function isCompletedHistoricalTextMismatch(event: TimelineEvent, events: readonly TimelineEvent[]): boolean {
  if (event.source !== 'pi' || event.kind !== 'diagnostic' || event.payload?.message !== 'Pi final assistant content differs from its streamed prefix') return false
  const scope = owner(event)
  if (!scope) return false
  for (let index = events.length - 1; index >= 0; index--) {
    const terminal = events[index]
    if (terminal.source === event.source && terminal.kind === 'turn-done' && owner(terminal) === scope) return asObject(terminal.payload?.result)?.status === 'completed'
  }
  return false
}

function hasIssue(item: RenderItem, neutralDiagnostics?: ReadonlySet<string>): boolean {
  if ('ev' in item && neutralDiagnostics?.has(item.ev.id)) return false
  if (item.type === 'tool') return item.tool.status === 'failed'
  if (item.type === 'knowledge-operation') return ['failed', 'uncertain', 'needs_clarification'].includes(item.operation.phase) || item.operation.persistence === 'degraded' || item.operation.status === 'partial'
  if (item.type === 'activity') return item.outcome === 'failed' || item.events.some(isTranscriptEventIssue)
  if (item.type === 'detail' && item.ev.kind === 'diagnostic' && !['pi_thinking_empty', 'pi_compaction'].includes(String(item.ev.payload?.tag))) return true
  return 'ev' in item && isTranscriptEventIssue(item.ev)
}

export function isTranscriptEventIssue(event: TimelineEvent): boolean {
  const payload = event.payload
  const problem = (value: unknown): boolean => typeof value === 'string' && ['failed', 'error', 'warning', 'warn'].includes(value)
  return Boolean(payload?.error || payload?.success === false || payload?.ok === false || [payload?.status, payload?.type, payload?.severity, payload?.level, asObject(payload?.result)?.status, asObject(payload?.observation)?.status].some(problem))
}

export function isTranscriptRetryFailure(entry: TranscriptEntry): boolean {
  if (entry.item.type !== 'detail' || entry.item.ev.payload?.tag !== 'pi_retry') return false
  const payload = entry.item.ev.payload
  return payload.phase === 'failed' || payload.status === 'failed' || Boolean(payload.error) || payload.success === false
}

export function transcriptProblemMessage(event: TimelineEvent): string {
  const payload = event.payload
  const result = asObject(payload?.result)
  return [result?.error, asObject(result?.error)?.message, payload?.error, asObject(payload?.error)?.message,
    result?.message, payload?.message, asObject(payload?.hostPolicyOutcome)?.message, event.text]
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim())) ?? ''
}

function failureReason(message: string): string {
  return message.trim().replace(/\s+/g, ' ').replace(/[.!。！]+$/, '').toLowerCase()
}

export function isRecordedTurnFailure(events: readonly TimelineEvent[], session: AcpSessionRecord | undefined, message: string | undefined): boolean {
  if (!message || !session?.turnId || !session.connectionGeneration) return false
  const reason = failureReason(message)
  if (!reason) return false
  const expected = JSON.stringify([projectRootKey(session.projectRoot), session.sessionId, session.connectionGeneration, session.turnId])
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.kind === 'turn-done' && event.source === (session.engine ?? 'acp') && owner(event) === expected) {
      return terminalOutcome(event) === 'failed' && failureReason(transcriptProblemMessage(event)) === reason
    }
  }
  return false
}

function belongsToTerminalFailure(entry: TranscriptEntry, terminal: TimelineEvent, reason: string): boolean {
  if (entry.item.key === terminal.id) return true
  if (entry.item.type !== 'detail') return false
  const event = entry.item.ev
  return event.source === terminal.source && owner(event) === owner(terminal) && Boolean(reason) && failureReason(transcriptProblemMessage(event)) === reason
    && (isTranscriptRetryFailure(entry) || event.kind === 'diagnostic' && isTranscriptEventIssue(event))
}

function mergeFailure(occurrences: TranscriptTurn[], terminal: TimelineEvent): void {
  let destination = occurrences.at(-1)
  if (!destination) return
  const failure: TranscriptEntry[] = []
  const reason = failureReason(transcriptProblemMessage(terminal))
  for (const turn of occurrences) {
    const grouped = turn.entries.filter(entry => belongsToTerminalFailure(entry, terminal, reason))
    if (!grouped.length) continue
    failure.push(...grouped)
    const keys = new Set(grouped.map(entry => entry.item.key))
    if (keys.has(terminal.id)) destination = turn
    turn.entries = turn.entries.filter(entry => entry.item.key === terminal.id || !keys.has(entry.item.key))
    turn.process = turn.process.filter(entry => !keys.has(entry.item.key))
    turn.delivery = turn.delivery.filter(entry => !keys.has(entry.item.key))
  }
  if (!failure.some(entry => entry.item.key === terminal.id)) {
    const entry: TranscriptEntry = { item: { type: 'detail', key: terminal.id, ev: terminal }, presentation: 'process' }
    failure.push(entry)
    destination.entries.push(entry)
  }
  destination.failure = failure
}

/** Saved protocol facts remain inspectable, but never become a process checklist. */
export function readableTranscriptEntries(entries: readonly TranscriptEntry[], events: readonly TimelineEvent[]): TranscriptEntry[] {
  const byId = new Map(events.map(event => [event.id, event]))
  const result: TranscriptEntry[] = []
  const seen = new Set<string>()
  const append = (entry: TranscriptEntry): void => {
    if (!seen.has(entry.item.key)) { result.push(entry); seen.add(entry.item.key) }
  }
  for (const entry of entries) {
    const item = entry.item
    if (item.type === 'thought' && !item.text.trim()) continue
    if (item.type === 'activity') {
      // Activity aggregates may replay transport observations at turn end.
      // Recover real problems as event leaves; never render the aggregate UI.
      for (const event of item.events) {
        if (event.kind !== 'turn-done' && isTranscriptEventIssue(event)) append({ ...entry, item: { type: 'detail', key: event.id, ev: event } })
      }
      continue
    }
    if (item.type === 'turn') {
      const event = byId.get(item.key)
      const status = terminalOutcome(event)
      if (event && (status === 'failed' || status === 'cancelled')) {
        append({ ...entry, item: { type: 'detail', key: event.id, ev: event } })
      } else if (!/^(回合已结束|本轮结束|回合已取消)$/.test(item.text)) append(entry)
      continue
    }
    if (item.type === 'detail') {
      const event = item.ev
      if (!isTranscriptEventIssue(event) && (isConnectionTimelineEvent(event) || isRoutineRuntimeEvent(event)
        || event.payload?.tag === 'pi_thinking_empty' || isCompletedHistoricalTextMismatch(event, events))) continue
    }
    append(entry)
  }
  return result
}

function terminalOutcome(event: TimelineEvent | undefined): TranscriptTurn['outcome'] {
  if (!event) return undefined
  const status = asObject(event.payload?.result)?.status
  const policy = asObject(event.payload?.hostPolicyOutcome)
  if (status === 'failed') return 'failed'
  if (status === 'cancelled' || event.text === '回合已取消' || policy?.authority === 'host-policy' && policy.status === 'cancelled' && policy.turnId === event.turnId && policy.connectionGeneration === event.connectionGeneration) return 'cancelled'
  return status === 'completed' || event.text === '回合已结束' ? 'completed' : undefined
}

function recordedStart(events: readonly TimelineEvent[], terminal: TimelineEvent | undefined): number | undefined {
  const prefix = terminal ? events.slice(0, events.indexOf(terminal)) : events
  const start = prefix.find((event) => event.kind === 'message' && event.payload?.role === 'user' || asObject(event.payload?.observation)?.label === '开始处理')
  return start && Number.isFinite(start.ts) && start.ts > 0 ? start.ts : undefined
}

/** Session metadata can activate only its exact recorded runtime turn. */
export function isTranscriptTurnActive(turn: TranscriptTurn, session: AcpSessionRecord | undefined): boolean {
  return Boolean(!turn.terminalId && session && session.connectionOwned !== false && session.historyKind !== 'legacy' && session.historyKind !== 'transcript'
    && ['busy', 'awaiting_permission', 'cancelling'].includes(session.status)
    && projectRootKey(turn.owner.projectRoot) === projectRootKey(session.projectRoot)
    && turn.owner.sessionId === session.sessionId && turn.owner.connectionGeneration === session.connectionGeneration
    && turn.owner.turnId === session.turnId && turn.owner.source === (session.engine ?? 'acp'))
}

/** Only adjacent real work forms a segment; narration, issues and permissions stay chronological. */
export function segmentTranscriptEntries(entries: readonly TranscriptEntry[]): TranscriptPart[] {
  const parts: TranscriptPart[] = []
  for (const entry of entries) {
    if (!['tool', 'thought', 'knowledge-operation'].includes(entry.item.type) || isArtifact(entry.item) || hasIssue(entry.item)) {
      parts.push({ type: 'entry', key: entry.item.key, entry })
      continue
    }
    const previous = parts.at(-1)
    if (previous?.type === 'segment') previous.entries.push(entry)
    else parts.push({ type: 'segment', key: entry.item.key, entries: [entry] })
  }
  return parts
}

function isArtifact(item: RenderItem): boolean {
  if (item.type === 'change-group') return true
  if (item.type === 'knowledge-operation') return item.operation.phase === 'completed' && ['save_document', 'publish_document', 'handoff'].includes(item.operation.kind)
  if (item.type === 'trellis') return ['doc-created', 'spec-updated'].includes(item.ev.kind) && !hasIssue(item)
  return item.type === 'agent' && !item.text.trim() && Boolean(item.storedImages?.length || item.webPreview)
}

function interruptsAnswer(item: RenderItem, neutralDiagnostics: ReadonlySet<string>): boolean {
  if (item.type === 'thought' || item.type === 'tool' || item.type === 'perm' || item.type === 'knowledge-operation' && !isArtifact(item)) return true
  return item.type === 'detail' && (item.ev.kind === 'plan' || hasIssue(item, neutralDiagnostics))
}

/**
 * Presentation over compileItems: never recompile text, merge tool patches or
 * infer completion from another question/session status. A paged suffix may
 * contain an end without a start, in which case duration stays absent.
 */
export function projectConversationTranscript(items: readonly RenderItem[], events: readonly TimelineEvent[]): TranscriptNode[] {
  const byId = new Map(events.map(event => [event.id, event]))
  const neutralDiagnostics = new Set(events.filter(event => isCompletedHistoricalTextMismatch(event, events)).map(event => event.id))
  const facts = new Map<string, TimelineEvent[]>()
  const runtimeSources = new Map<string, Set<TimelineEvent['source']>>()
  for (const event of events) {
    const scope = owner(event)
    if (!scope || !isConversationRuntimeEvent(event)) continue
    const key = `${event.source}:${scope}`
    const recorded = facts.get(key) ?? []
    recorded.push(event); facts.set(key, recorded)
    const sources = runtimeSources.get(scope) ?? new Set<TimelineEvent['source']>()
    sources.add(event.source); runtimeSources.set(scope, sources)
  }
  const scopeOf = (item: RenderItem): string | undefined => {
    const event = origin(item, byId)
    if (!event) return undefined
    const scope = owner(event)
    if (!scope) return undefined
    if (isConversationRuntimeEvent(event)) return `${event.source}:${scope}`
    const sources = runtimeSources.get(scope)
    // A project result joins a turn only with one exact runtime owner.
    return sources?.size === 1 ? `${[...sources][0]}:${scope}` : undefined
  }
  const scopes = items.map(scopeOf)
  const finalKeys = new Set<string>()
  const terminals = new Map<string, TimelineEvent>()
  const candidates = new Map<string, RenderItem>()
  const explicitFinalScopes = new Set<string>()
  for (const [scope, recorded] of facts) {
    const terminal = recorded.find(event => event.kind === 'turn-done')
    if (terminal) terminals.set(scope, terminal)
  }
  items.forEach((item, index) => {
    const scope = scopes[index]
    if (item.type === 'agent') {
      const phase = messagePhase(item, origin(item, byId))
      if (phase === 'final_answer') finalKeys.add(item.key)
      if (!scope) return
      if (phase === 'final_answer') explicitFinalScopes.add(scope)
      if (item.text.trim()) {
        if (phase === undefined) candidates.set(scope, item)
        else candidates.delete(scope)
      }
    } else if (scope && interruptsAnswer(item, neutralDiagnostics)) candidates.delete(scope)
  })
  // Explicit commentary never becomes an answer just because a turn ended.
  for (const [scope, candidate] of candidates) {
    if (terminals.has(scope) && !explicitFinalScopes.has(scope)) finalKeys.add(candidate.key)
  }
  const nodes: TranscriptNode[] = []
  const occurrences = new Map<string, number>()
  const turnOccurrences = new Map<string, TranscriptTurn[]>()
  let current: { scope: string; turn: TranscriptTurn } | undefined
  items.forEach((item, index) => {
    const scope = scopes[index]
    const entry: TranscriptEntry = { item, presentation: finalKeys.has(item.key) ? 'final' : 'process' }
    if (!scope) {
      const readable = readableTranscriptEntries([entry], events)
      for (const row of readable) nodes.push({ type: 'row', key: row.item.key, entry: row })
      if (readable.length) current = undefined
      return
    }
    if (item.type === 'user') {
      nodes.push({ type: 'row', key: item.key, entry })
      current = undefined
    }
    if (current?.scope !== scope) {
      const occurrence = occurrences.get(scope) ?? 0
      occurrences.set(scope, occurrence + 1)
      const terminal = terminals.get(scope)
      const outcome = terminalOutcome(terminal)
      const event = origin(item, byId)
      if (!event?.sessionId || !event.connectionGeneration || !event.turnId) return
      const recorded = facts.get(scope) ?? []
      const startedAt = recordedStart(recorded, terminal)
      const durationMs = startedAt !== undefined && terminal && Number.isFinite(terminal.ts) && terminal.ts >= startedAt ? terminal.ts - startedAt : undefined
      const runtime = recorded[0]
      const turn: TranscriptTurn = {
        type: 'turn', key: `transcript:${scope}:${occurrence}`,
        owner: { source: runtime?.source ?? event.source, projectRoot: event.projectRoot, sessionId: event.sessionId, connectionGeneration: event.connectionGeneration, turnId: event.turnId },
        entries: [], process: [], delivery: [], startedAt, terminalId: terminal?.id, outcome, durationMs, issues: 0
      }
      const turns = turnOccurrences.get(scope) ?? []
      turns.push(turn)
      turnOccurrences.set(scope, turns)
      nodes.push(turn); current = { scope, turn }
    }
    if (!current || item.type === 'user') return
    const turn = current.turn
    turn.entries.push(entry)
    turn.lastItemKey = item.key
    if (entry.presentation === 'final' || turn.terminalId && isArtifact(item)) turn.delivery.push(entry)
    else turn.process.push(entry)
    if (hasIssue(item, neutralDiagnostics)) turn.issues++
  })
  for (const node of nodes) {
    if (node.type !== 'turn') continue
    node.entries = readableTranscriptEntries(node.entries, events)
    node.process = readableTranscriptEntries(node.process, events)
    if (node.outcome === 'completed') node.issues = 0
    node.delivery = [...node.delivery.filter(entry => entry.presentation === 'final'), ...node.delivery.filter(entry => entry.presentation !== 'final')]
  }
  for (const [scope, turns] of turnOccurrences) {
    const terminal = terminals.get(scope)
    if (terminal && terminalOutcome(terminal) === 'failed') mergeFailure(turns, terminal)
  }
  return nodes.filter(node => node.type === 'row' || node.outcome !== 'failed' || node.entries.length || node.failure)
}
