import type { TimelineEvent } from '../../../shared/types'

const PAGE_BYTES = 2 * 1024 * 1024

/** Body-free projection shared by SQLite and the bounded snapshot reader. */
export interface HistoryEventMetadata {
  seq: number
  bytes: number
  source: TimelineEvent['source']
  kind: TimelineEvent['kind']
  projectRoot: string | null
  sessionId: string | null
  connectionGeneration: string | null
  turnId: string | null
  role: string | null
  activityScope: string | null
}
interface TurnRange {
  first: number
  last: number
  count: number
  bytes: number
  identity: string
  scope: string
  generation: string | null
  hasUser: boolean
  hasConversation: boolean
}
export class HistoryTurnBoundaryError extends Error {}

function rootKey(root: string): string {
  const normalized = root.replace(/\\/g, '/').replace(/\/$/, '')
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
}

/** Contiguous occurrences, never a global map keyed only by a reusable turn ID. */
function* turns(rows: Iterable<HistoryEventMetadata>, root: string, sessionId: string): Generator<TurnRange> {
  let current: TurnRange | undefined
  for (const row of rows) {
    const connection = row.activityScope === 'connection'
    const scope = JSON.stringify([rootKey(row.projectRoot ?? root), row.sessionId ?? sessionId])
    const identity = JSON.stringify([scope,
      row.connectionGeneration, connection ? 'connection' : 'turn', connection ? null : row.turnId || null])
    const user = !connection && row.source === 'acp' && row.kind === 'message' && row.role === 'user'
    const conversation = !connection && row.source === 'acp' && ['message', 'thought', 'tool-call', 'permission', 'plan', 'turn-done'].includes(row.kind)
    // Explicit preparation/engine output may precede promptStarted's user message.
    // Legacy records have no such correlation: a user message starts a new turn.
    // Uncorrelated rail/connection observations within a turn are transparent.
    // In particular restore verification can occur between preparation and user.
    const observation = !conversation && (!row.turnId || connection) && current?.scope === scope &&
      (current.generation === row.connectionGeneration || (row.source === 'trellis' && row.connectionGeneration === null))
    if (current && ((!observation && current.identity !== identity) || (user && (current.hasUser || (!row.turnId && current.hasConversation))))) {
      yield current
      current = undefined
    }
    if (!current) current = { first: row.seq, last: row.seq, count: 0, bytes: 0, identity, scope, generation: row.connectionGeneration, hasUser: false, hasConversation: false }
    current.last = row.seq
    current.count += 1
    current.bytes += row.bytes
    current.hasUser ||= user
    current.hasConversation ||= conversation
    if (!connection && row.source === 'acp' && row.kind === 'turn-done') {
      yield current
      current = undefined
    }
  }
  if (current) yield current // The persisted prefix of a running turn stays open.
}

/** Select whole ranges without retaining or loading neighbouring event bodies. */
export function selectHistoryTurns(rows: Iterable<HistoryEventMetadata>, options: {
  root: string; sessionId: string; after: boolean; bound?: number; limit?: number
}): { first?: number; last?: number; startsMidTurn: boolean; oversized: boolean } {
  const limit = options.limit ?? 200
  const selected: TurnRange[] = []
  let bytes = 0
  let count = 0
  let conversations = 0
  let matched = options.bound === undefined
  for (const turn of turns(rows, options.root, options.sessionId)) {
    if (options.bound !== undefined && !matched) {
      if (turn.last < options.bound) {
        if (options.after) continue
      } else {
        const edge = options.after ? turn.last : turn.first
        if (edge !== options.bound) throw new HistoryTurnBoundaryError('Transcript cursor no longer falls between turns; refresh required')
        matched = true
        if (!options.after) break
        continue
      }
    }
    if (options.after && conversations && (count + turn.count > limit || bytes + turn.bytes > PAGE_BYTES)) break
    selected.push(turn)
    count += turn.count
    bytes += turn.bytes
    if (turn.hasConversation) conversations += 1
    // Keep the newest contiguous suffix for latest/before. A single turn may
    // exceed either soft target, including a >200-fragment or image-heavy turn.
    if (!options.after) {
      while (selected.length > 1 && (count > limit || bytes > PAGE_BYTES)) {
        // Trailing observations cannot displace the newest actual turn.
        if (selected[0].hasConversation && conversations === 1) break
        const removed = selected.shift()
        if (removed) { count -= removed.count; bytes -= removed.bytes; if (removed.hasConversation) conversations -= 1 }
      }
    }
  }
  if (!matched) throw new HistoryTurnBoundaryError('Transcript cursor event is missing; refresh required')
  return { first: selected[0]?.first, last: selected.at(-1)?.last,
    startsMidTurn: selected.find((turn) => turn.hasConversation)?.hasUser === false,
    oversized: count > limit || bytes > PAGE_BYTES }
}

export function historyEventMetadata(event: TimelineEvent, seq: number): HistoryEventMetadata {
  return { seq, bytes: Buffer.byteLength(JSON.stringify(event)), source: event.source, kind: event.kind,
    projectRoot: event.projectRoot, sessionId: event.sessionId ?? null, connectionGeneration: event.connectionGeneration ?? null,
    turnId: event.turnId ?? null, role: typeof event.payload?.role === 'string' ? event.payload.role : null,
    activityScope: typeof event.payload?.activityScope === 'string' ? event.payload.activityScope : null }
}

export function historicalEvent(event: TimelineEvent): TimelineEvent {
  return event.kind === 'permission' ? { ...event, payload: { ...event.payload, pending: false } } : event
}
