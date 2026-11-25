import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type {
  ConversationLifecycleEvent,
  ConversationCompaction,
  ConversationGoal,
  ConversationHandoff,
  ConversationProjectedWorkItem,
  ConversationRuntimeRequest,
  ConversationThreadCommand,
  ConversationThreadCommandState,
  ConversationThreadEventPage,
  ConversationThreadHistoryCursor,
  ConversationThreadHistoryPage,
  ConversationThreadSnapshot,
  ConversationTurnUsage,
} from '../../../shared/conversation/command-runtime'
import type { ConversationRunEvidence } from '../../../shared/conversation/desktop'
import { IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { CONVERSATION_READ_PAGE_LIMIT } from '../../../shared/conversation/desktop'
import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
} from '../../../shared/conversation/orchestrationV2'
import type { ConversationTaskLocator } from '../../../shared/conversation/task-scope'
import type { ConversationThreadRelations } from '../../../shared/conversation/thread-relations'
import { ModelSelection } from '../../../shared/conversation/modelSelection'
import { api } from '../api'
import { conversationError } from './useComposerSend'

export type ConversationThread = Pick<OrchestrationV2AppThread, 'id' | 'title' | 'modelSelection'> &
  Partial<Pick<OrchestrationV2AppThread, 'archivedAt' | 'worktreePath'>>
export type ConversationMessage = Pick<
  OrchestrationV2ConversationMessage,
  'role' | 'text' | 'runId' | 'streaming'
> & {
  readonly id: string
  readonly createdAt?: OrchestrationV2ConversationMessage['createdAt'] | string
  readonly updatedAt?: OrchestrationV2ConversationMessage['updatedAt'] | string
}
export type ConversationRun = Pick<OrchestrationV2Run, 'id' | 'ordinal' | 'status' | 'modelSelection' | 'userMessageId' | 'startedAt' | 'requestedAt'> & {
  readonly failure?: string
  readonly outcomeUnknown?: boolean
  readonly engineAcceptedAt?: string | null
  readonly nativeTurnId?: string | null
  readonly queuePosition?: number | null
  readonly usage?: ConversationTurnUsage
  readonly compaction?: ConversationCompaction
  readonly handoff?: ConversationHandoff
  readonly lifecycle?: {
    readonly foregroundEnded: boolean
    readonly backgroundRunning: boolean
    readonly stopRequested: boolean
    readonly terminalEvidence?: { readonly status: string; readonly observedAt: string; readonly nativeTurnId?: string }
  }
}

export type ConversationTimelineRow =
  | { readonly kind: 'message'; readonly id: string; readonly message: ConversationMessage; readonly forkRunId?: string }
  | {
      readonly kind: 'work'
      readonly id: string
      readonly text: string
      readonly state: 'running' | 'done' | 'failed' | 'cancelled'
      readonly at?: string
    }
  | { readonly kind: 'plan'; readonly id: string; readonly item: Extract<ConversationProjectedWorkItem, { readonly type: 'proposed_plan' | 'todo_list' }> }
  | { readonly kind: 'file-change'; readonly id: string; readonly item: Extract<ConversationProjectedWorkItem, { readonly type: 'file_change' }> }
  | { readonly kind: 'relation'; readonly id: string; readonly item: ConversationThreadRelations['children'][number] }

export interface ConversationThreadProjection {
  readonly thread: ConversationThread
  readonly messages: readonly ConversationMessage[]
  readonly runs: readonly ConversationRun[]
  readonly rows: readonly ConversationTimelineRow[]
  readonly queuePaused: boolean
  readonly runtimeRequests: readonly ConversationRuntimeRequest[]
  readonly queuedRuns: readonly ConversationRun[]
  readonly activeRun: ConversationRun | undefined
  readonly cursor?: ConversationThreadSnapshot['cursor']
  readonly turnItems?: readonly ConversationProjectedWorkItem[]
  readonly historyCursor: ConversationThreadSnapshot['historyCursor']
  readonly hasOlderHistory: boolean
  readonly relations: ConversationThreadRelations
  readonly goal: ConversationGoal | null
}

export interface ThreadReadTarget {
  readonly threadId: string
  readonly runId?: string
}

export type ConversationApplyResult =
  | {
      readonly ok: true
      readonly uncertain: false
      readonly commandId: string
      readonly receipt: ConversationThreadCommandState
      readonly source: 'apply' | 'reconcile'
    }
  | {
      readonly ok: false
      readonly uncertain: true
      readonly commandId: string
      readonly reason: string
      readonly receipt?: ConversationThreadCommandState
      readonly source: 'apply' | 'reconcile'
    }
  | {
      readonly ok: false
      readonly uncertain: false
      readonly commandId?: string
      readonly reason: string
      readonly receipt?: ConversationThreadCommandState
      readonly source: 'apply' | 'reconcile'
    }

const ACTIVE_RUNS = new Set<ConversationRun['status']>(['preparing', 'queued', 'starting', 'running', 'waiting'])
const POLL_DELAY_MS = 450
/** An open idle thread still re-reads deltas, so work started in another window shows up. */
const IDLE_POLL_DELAY_MS = 5_000
const READ_RETRY_MS = 1_800
const CACHE_LIMIT = 12
const decodeModelSelection = Schema.decodeUnknownOption(ModelSelection)

export function isActiveRun(run: ConversationRun): boolean {
  return !run.outcomeUnknown && ACTIVE_RUNS.has(run.status)
}

export function isQueuedRun(run: ConversationRun): boolean {
  return run.status === 'queued' && !run.outcomeUnknown
}

interface CachedProjection {
  readonly projection: ConversationThreadProjection
}

const projectionCache = new Map<string, CachedProjection>()

/**
 * Cache identity is the caller's scope plus the physical root and thread. A task locator's
 * scopeKey keeps two spaces that happen to hold the same thread id from reading each other.
 */
function cacheKey(scopeKey: string, root: string, threadId: string, task?: ConversationTaskLocator): string {
  return JSON.stringify([scopeKey, root, threadId, task?.workspaceKey, task?.taskId, task?.taskCreatedAt, task?.scopeKey])
}

type ReadIdentity = Pick<ConversationThreadHistoryCursor, 'storageId' | 'threadId'>

function sameReadIdentity(current: ReadIdentity | undefined | null, next: ReadIdentity): boolean {
  return current?.storageId === next.storageId && current.threadId === next.threadId
}

function losesReadAccess(code: unknown): boolean {
  return code === IpcErrorCode.Denied || code === IpcErrorCode.Unauthorized ||
    code === IpcErrorCode.NotFound || code === IpcErrorCode.NoProject
}

function historyPageCursor(page: ConversationThreadHistoryPage, previous: ConversationThreadHistoryCursor): ConversationThreadHistoryCursor | null {
  const next = page.historyCursor
  if (next && (!sameReadIdentity(next, previous) || next.beforeRunOrdinal >= previous.beforeRunOrdinal)) {
    throw Object.assign(new Error('对话历史游标已失效，请刷新快照。'), { code: IpcErrorCode.ResetRequired })
  }
  return next
}

function remember(key: string, projection: ConversationThreadProjection): void {
  const previousStorage = projectionCache.get(key)?.projection.cursor?.storageId
  if (previousStorage && projection.cursor && previousStorage !== projection.cursor.storageId) {
    for (const [cachedKey, entry] of projectionCache) {
      if (entry.projection.cursor?.storageId === previousStorage) projectionCache.delete(cachedKey)
    }
  }
  projectionCache.delete(key)
  projectionCache.set(key, { projection })
  while (projectionCache.size > CACHE_LIMIT) {
    const oldest = projectionCache.keys().next().value
    if (oldest === undefined) break
    projectionCache.delete(oldest)
  }
}

function failureReason(error: unknown): string {
  return conversationError(error)
}

function wasNotAdmitted(failure: IpcFail): boolean {
  return 'outcome' in failure && failure.outcome === 'not-admitted'
}

export function commandResult(
  commandId: string,
  receipt: ConversationThreadCommandState | null,
  source: 'apply' | 'reconcile',
): ConversationApplyResult {
  if (!receipt || receipt.dispatch === 'pending-reconciliation') {
    return {
      ok: false, uncertain: true, commandId, source, ...(receipt && { receipt }),
      reason: receipt?.detail ?? '操作结果待核对。',
    }
  }
  if (receipt.dispatch === 'failed' || receipt.dispatch === 'cancelled') {
    return {
      ok: false, uncertain: false, commandId, receipt, source,
      reason: receipt.detail ?? (receipt.dispatch === 'cancelled' ? '操作已取消。' : '操作未完成。'),
    }
  }
  return { ok: true, uncertain: false, commandId, receipt, source }
}

export async function applyConversationCommand(
  root: string,
  command: ConversationThreadCommand,
  task?: ConversationTaskLocator,
): Promise<ConversationApplyResult> {
  const { commandId, threadId } = command
  const source = 'apply' as const
  try {
    const result = await api.conversationApply({ cwd: root, command, ...(task && { task }) })
    if (result.ok) {
      const receipt = result.receipt?.commandId === commandId && result.receipt.threadId === threadId
        ? result.receipt : null
      return commandResult(commandId, receipt, source)
    }
    return wasNotAdmitted(result)
      ? { ok: false, reason: result.error, uncertain: false, commandId, source }
      : { ok: false, reason: result.error, uncertain: true, commandId, source }
  } catch (error) {
    return { ok: false, reason: failureReason(error), uncertain: true, commandId, source }
  }
}

/** Re-reads the original receipt; null means the daemon has no record of it yet. */
export async function readConversationCommandState(
  root: string,
  threadId: string,
  commandId: string,
  task?: ConversationTaskLocator,
): Promise<ConversationThreadCommandState | null> {
  try {
    const result = await api.conversationThreadCommand({ cwd: root, threadId, commandId, ...(task && { task }) })
    return result.ok && result.receipt?.commandId === commandId && result.receipt.threadId === threadId
      ? result.receipt : null
  } catch {
    return null
  }
}

function upsertMessage(
  messages: readonly ConversationMessage[],
  next: ConversationMessage,
): readonly ConversationMessage[] {
  const index = messages.findIndex((message) => message.id === next.id)
  if (index === -1) return [...messages, next]
  if (messages[index] === next) return messages
  const copy = messages.slice()
  copy[index] = next
  return copy
}

function applyMessageDelta(
  messages: readonly ConversationMessage[],
  messageId: string,
  text: string,
): readonly ConversationMessage[] {
  const index = messages.findIndex((message) => message.id === messageId)
  if (index === -1) return messages
  const existing = messages[index]
  const copy = messages.slice()
  copy[index] = { ...existing, text: existing.text + text, streaming: true }
  return copy
}

function upsertRequest(
  requests: readonly ConversationRuntimeRequest[],
  next: ConversationRuntimeRequest,
): readonly ConversationRuntimeRequest[] {
  const index = requests.findIndex((request) => request.requestId === next.requestId)
  if (index === -1) return [...requests, next]
  const copy = requests.slice()
  copy[index] = next
  return copy
}

/** Projects snapshot + delta into rows; a repeated id replaces its own row instead of duplicating it. */
export function deriveTimelineRows(
  messages: readonly ConversationMessage[],
  runs: readonly ConversationRun[],
  turnItems: readonly ConversationProjectedWorkItem[],
  relations: ConversationThreadRelations['children'] = [],
): readonly ConversationTimelineRow[] {
  const rows: ConversationTimelineRow[] = []
  const place = (row: ConversationTimelineRow): void => {
    const index = rows.findIndex((candidate) => candidate.id === row.id)
    if (index === -1) rows.push(row)
    else rows[index] = row
  }
  const assistantPlaced = new Set<string>()
  const byParentRun = new Map<string, ConversationThreadRelations['children'][number][]>()
  for (const item of relations) {
    if (!item.parentRunId || (item.kind !== 'delegated' && item.kind !== 'native-activity')) continue
    const current = byParentRun.get(item.parentRunId)
    if (current) current.push(item)
    else byParentRun.set(item.parentRunId, [item])
  }
  for (const run of runs) {
    const prompt = messages.find((item) => item.id === run.userMessageId)
    if (prompt) place({ kind: 'message', id: prompt.id, message: prompt })
    const turn: Array<{ row: ConversationTimelineRow; time?: number }> = []
    const append = (row: ConversationTimelineRow, startedAt: string | { readonly epochMilliseconds: number } | null | undefined): void => {
      const time = typeof startedAt === 'string' ? Date.parse(startedAt) : startedAt?.epochMilliseconds
      turn.push({ row, time: time !== undefined && Number.isFinite(time) ? time : undefined })
    }
    for (const item of turnItems) {
      if (item.runId !== run.id) continue
      if (item.type === 'dynamic_tool' && item.title) {
        const status = item.status
        append({
          kind: 'work',
          id: item.id,
          text: item.title,
          state: status === 'failed' ? 'failed' : status === 'completed' ? 'done'
            : status === 'cancelled' || status === 'interrupted' ? 'cancelled' : 'running',
          ...(typeof item.completedAt === 'string' ? { at: item.completedAt } : {}),
        }, item.startedAt)
      } else if (item.type === 'proposed_plan' || item.type === 'todo_list') {
        append({ kind: 'plan', id: item.id, item }, item.startedAt)
      } else if (item.type === 'file_change') {
        append({ kind: 'file-change', id: item.id, item }, item.startedAt)
      }
    }
    for (const item of byParentRun.get(run.id) ?? []) append({ kind: 'relation', id: `relation:${item.id}`, item }, item.createdAt)
    for (const message of messages) {
      if (message.role !== 'assistant' || message.runId !== run.id || assistantPlaced.has(message.id)) continue
      assistantPlaced.add(message.id)
      const stable = !run.outcomeUnknown && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
      append({ kind: 'message', id: message.id, message, ...(stable && { forkRunId: run.id }) }, message.createdAt)
    }
    const dated = turn.flatMap(entry => entry.time === undefined ? [] : [{ row: entry.row, time: entry.time }])
      .sort((left, right) => left.time - right.time)
    let datedIndex = 0
    for (const entry of turn) place(entry.time === undefined ? entry.row : dated[datedIndex++].row)
  }
  const placed = new Set(rows.map((row) => row.id))
  for (const message of messages) {
    if (placed.has(message.id)) continue
    rows.push({ kind: 'message', id: message.id, message })
  }
  return rows
}

export function queuedRunsWithText(
  runs: readonly ConversationRun[],
  messages: readonly ConversationMessage[],
): ReadonlyArray<{ readonly run: ConversationRun; readonly text: string }> {
  return runs
    .filter((run) => isQueuedRun(run))
    .map((run) => ({
      run,
      text: messages.find((message) => message.id === run.userMessageId)?.text ?? '',
    }))
    .sort(
      (left, right) =>
        (left.run.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.run.queuePosition ?? Number.MAX_SAFE_INTEGER),
    )
}

function snapshotProjection(snapshot: ConversationThreadSnapshot): ConversationThreadProjection {
  const { thread, runs, messages, turnItems = [] } = snapshot
  const relations = snapshot.relations ?? { parent: null, children: [] }
  const activeRun = [...runs].reverse().find((run) => isActiveRun(run))
  return {
    thread,
    messages,
    runs,
    turnItems,
    rows: deriveTimelineRows(messages, runs, turnItems, relations.children),
    relations,
    goal: snapshot.goal ?? null,
    queuePaused: snapshot.queuePaused,
    runtimeRequests: snapshot.runtimeRequests,
    queuedRuns: runs.filter((run) => isQueuedRun(run)),
    activeRun,
    cursor: snapshot.cursor,
    historyCursor: snapshot.historyCursor,
    hasOlderHistory: snapshot.historyCursor !== null,
  }
}

function prependHistory(
  projection: ConversationThreadProjection,
  pages: readonly ConversationThreadHistoryPage[],
): ConversationThreadProjection {
  if (!pages.length) return projection
  const mergeById = <Item extends { readonly id: string }>(older: readonly Item[], newer: readonly Item[]): Item[] =>
    [...new Map([...older, ...newer].map(item => [item.id, item])).values()]
  const messages = mergeById(pages.flatMap(page => page.messages), projection.messages)
  const runs = mergeById(pages.flatMap(page => page.runs), projection.runs)
  const turnItems = mergeById(pages.flatMap(page => page.turnItems ?? []), projection.turnItems ?? [])
  const historyCursor = pages[0].historyCursor
  return { ...projection, messages, runs, turnItems, rows: deriveTimelineRows(messages, runs, turnItems, projection.relations.children),
    historyCursor, hasOlderHistory: historyCursor !== null }
}

export function applyEventPage(
  projection: ConversationThreadProjection,
  page: Extract<ConversationThreadEventPage, { readonly kind: 'events' }>,
): { readonly projection: ConversationThreadProjection; readonly cursor: ConversationThreadSnapshot['cursor'] } {
  const previous = projection.cursor
  if (previous && sameReadIdentity(previous, page.cursor) && previous.sequence > page.cursor.sequence) {
    return { projection, cursor: previous }
  }
  const events = page.events.filter(({ sequence }) => sequence > (projection.cursor?.sequence ?? -1))
  if (!events.length && projection.cursor?.sequence === page.cursor.sequence) {
    return { projection, cursor: page.cursor }
  }
  let messages = projection.messages
  let thread = projection.thread
  const runs = [...projection.runs]
  let queuePaused = projection.queuePaused
  let runtimeRequests = projection.runtimeRequests
  let parent = projection.relations?.parent ?? null
  let goal = projection.goal ?? null
  const children = new Map((projection.relations?.children ?? []).map(item => [item.id, item]))
  const items = new Map((projection.turnItems ?? []).map(item => [item.id, item]))
  const updateRun = (id: unknown, update: (run: ConversationRun) => ConversationRun): void => {
    const index = runs.findIndex(run => run.id === id)
    if (index >= 0) runs[index] = update(runs[index])
  }
  for (const entry of events) {
    const event = entry.event as Record<string, unknown> & { readonly type?: string }
    const payload = event.payload as Record<string, unknown> | undefined
    if (event.type === 'crux.lifecycle') {
      if (entry.event.type !== 'crux.lifecycle') continue
      const body = entry.event.payload
      if (body.kind === 'relation') {
        const { relation, removed } = body
        if (event.threadId === projection.thread.id) {
          if (relation.parentThreadId === projection.thread.id) {
            if (removed) children.delete(relation.id)
            else children.set(relation.id, relation)
          } else if (relation.childThreadId === projection.thread.id) {
            if (!removed) parent = relation
            else if (parent?.id === relation.id) parent = null
          }
        }
        continue
      }
      if (body.kind === 'goal') goal = body.goal
      if (body.kind === 'usage') updateRun(event.runId, run => ({ ...run, usage: body.usage }))
      if (body.kind === 'compaction') updateRun(event.runId, run => ({ ...run, compaction: body.compaction }))
      if (body.kind === 'handoff') updateRun(event.runId, run => ({ ...run, handoff: body.handoff }))
      const lifecycle = payload as ConversationLifecycleEvent['payload']
      if (lifecycle.kind === 'queue') queuePaused = lifecycle.paused
      if (lifecycle.kind === 'request') {
        runtimeRequests =
          lifecycle.request.status === 'resolved' || lifecycle.request.status === 'expired'
            ? runtimeRequests.filter((request) => request.requestId !== lifecycle.request.requestId)
            : upsertRequest(runtimeRequests, lifecycle.request)
      }
      if (lifecycle.kind === 'dispatch' && lifecycle.status === 'unknown') {
        updateRun(event.runId, run => ({ ...run, outcomeUnknown: true }))
      }
      if (lifecycle.kind === 'run' || lifecycle.kind === 'terminal-evidence') {
        updateRun(event.runId, run => {
          const previous = run.lifecycle
          const phase = lifecycle.kind === 'run' ? lifecycle.phase : undefined
          const terminalEvidence = lifecycle.kind === 'terminal-evidence' ? lifecycle.evidence : previous?.terminalEvidence
          return { ...run, lifecycle: {
            foregroundEnded: phase === 'foreground-ended' || phase === 'settled' || Boolean(previous?.foregroundEnded),
            backgroundRunning: phase === 'background-running' || (phase !== 'settled' && Boolean(previous?.backgroundRunning)),
            stopRequested: phase === 'stop-requested' || phase === 'stop-unconfirmed' || Boolean(previous?.stopRequested),
            ...(terminalEvidence && { terminalEvidence }),
          } }
        })
      }
      continue
    }
    if (event.type === 'crux.message-delta') {
      if (payload && typeof payload.messageId === 'string' && typeof payload.text === 'string') {
        messages = applyMessageDelta(messages, payload.messageId, payload.text)
      }
      continue
    }
    if (event.type === 'crux.run-evidence') {
      updateRun(event.runId, run => ({ ...run, ...payload as ConversationRunEvidence }))
      continue
    }
    if (event.type === 'message.updated' && payload) {
      const message = payload as unknown as ConversationMessage
      if (typeof message.id === 'string') messages = upsertMessage(messages, message)
      continue
    }
    const wireEvent = entry.event
    if (wireEvent.type === 'thread.metadata-updated' && wireEvent.threadId === thread.id) {
      const { title, modelSelection } = wireEvent.payload
      thread = { ...thread, title, modelSelection: Option.getOrElse(decodeModelSelection(modelSelection), () => thread.modelSelection) }
      continue
    }
    if (wireEvent.type === 'turn-item.updated') {
      const item = wireEvent.payload
      if (item.type === 'dynamic_tool' || item.type === 'proposed_plan' || item.type === 'todo_list' || item.type === 'file_change') items.set(item.id, item)
      continue
    }
    if ((event.type === 'run.created' || event.type === 'run.updated') && payload && typeof payload === 'object') {
      const next = payload as unknown as ConversationRun
      if (typeof next.id === 'string') {
        const index = runs.findIndex((run) => run.id === next.id)
        if (index === -1) runs.push(next)
        else runs[index] = { ...runs[index], ...next }
      }
    }
  }
  const turnItems = [...items.values()]
  const relations = { parent, children: [...children.values()] }
  const activeRun = [...runs].reverse().find((run) => isActiveRun(run))
  const next: ConversationThreadProjection = {
    ...projection,
    thread,
    cursor: page.cursor,
    messages,
    runs,
    queuePaused,
    runtimeRequests,
    turnItems,
    relations,
    goal,
    rows: deriveTimelineRows(messages, runs, turnItems, relations.children),
    queuedRuns: runs.filter((run) => isQueuedRun(run)),
    activeRun,
  }
  return { projection: next, cursor: page.cursor }
}

export interface ConversationThreadReading {
  readonly projection: ConversationThreadProjection
  readonly error?: undefined
}

export interface ConversationThreadReadFailure {
  readonly projection?: ConversationThreadProjection
  readonly error: string
}

export interface ConversationThreadController {
  readonly scope: string
  readonly active: ConversationThreadReading | ConversationThreadReadFailure | undefined
  readonly reload: () => void
  readonly loadEarlier: () => Promise<void>
  readonly loadingEarlier: boolean
  readonly apply: (command: ConversationThreadCommand) => Promise<ConversationApplyResult>
  readonly queue: {
    readonly edit: (runId: string, text: string) => Promise<ConversationApplyResult>
    readonly cancel: (runId: string) => Promise<ConversationApplyResult>
    readonly start: (runId: string) => Promise<ConversationApplyResult>
    readonly reorder: (runId: string, beforeRunId: string | null) => Promise<ConversationApplyResult>
    readonly resume: () => Promise<ConversationApplyResult>
  }
  readonly stop: (runId: string) => Promise<ConversationApplyResult>
  readonly respond: (
    request: ConversationRuntimeRequest,
    response: ConversationRequestAnswer,
  ) => Promise<ConversationApplyResult>
  readonly reconcile: (commandId: string) => Promise<ConversationThreadCommandState | null>
  readonly checkCommand: (commandId: string) => Promise<ConversationApplyResult>
  readonly pendingCommands: ReadonlySet<string>
  readonly commandFailure?: Extract<ConversationApplyResult, { readonly ok: false }>
}

interface ConversationRequestAnswer {
  readonly decision?: string
  readonly answers?: Record<string, string | string[]>
  readonly draftId?: string
  readonly attachmentIds?: string[]
  readonly attachmentQuestionId?: string
}

interface ReadState {
  readonly target: ThreadReadTarget
  readonly scope: string
  readonly result: ConversationThreadReading | ConversationThreadReadFailure
}

interface TrackedCommand {
  readonly commandId: string
  readonly scope: string
  readonly waitForTerminal: boolean
  inFlight?: Promise<ConversationApplyResult>
}

const actionCommands = new Map<string, TrackedCommand>()
const EMPTY_COMMANDS: ReadonlySet<string> = new Set()
const NO_THREAD_RESULT = {
  ok: false, reason: '会话当前不可操作。', uncertain: false, source: 'apply',
} as const satisfies ConversationApplyResult

function commandAction(command: ConversationThreadCommand): string {
  switch (command.type) {
    case 'queue.resume': return 'resume'
    case 'queued-run.edit': return `edit:${command.runId}`
    case 'queued-run.cancel': return `cancel:${command.runId}`
    case 'queued-run.start': return `start:${command.runId}`
    case 'queued-run.reorder': return `reorder:${command.runId}`
    case 'queued-message.promote-to-steer': return `promote:${command.queuedRunId}`
    case 'run.interrupt': return `stop:${command.runId}`
    case 'runtime-request.respond': return `respond:${command.requestId}:${command.generation}`
    default: return `command:${command.commandId}`
  }
}

function retainsCommand(result: ConversationApplyResult, command: TrackedCommand): boolean {
  return result.uncertain || (
    result.ok && command.waitForTerminal && result.receipt.dispatch !== 'completed'
  )
}

export function useConversationThread(
  root: string,
  target: ThreadReadTarget | null,
  interactive: boolean,
  scopeKey = '',
  task?: ConversationTaskLocator,
): ConversationThreadController {
  const threadId = target?.threadId
  const { workspaceKey, taskId, taskCreatedAt, scopeKey: taskScopeKey } = task ?? {}
  const locator = useMemo(() => workspaceKey && taskId && taskCreatedAt
    ? { workspaceKey, taskId, taskCreatedAt, ...(taskScopeKey && { scopeKey: taskScopeKey }) }
    : undefined, [workspaceKey, taskId, taskCreatedAt, taskScopeKey])
  const scope = cacheKey(scopeKey, root, threadId ?? '', locator)
  const currentScope = useRef<string | undefined>()
  const [state, setState] = useState<ReadState>()
  const [attempt, setAttempt] = useState(0)
  const [pendingByScope, setPendingByScope] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map())
  const [commandIssue, setCommandIssue] = useState<{
    readonly scope: string
    readonly failure: Extract<ConversationApplyResult, { readonly ok: false }>
  }>()
  const [loadingEarlierScopes, setLoadingEarlierScopes] = useState<ReadonlySet<string>>(new Set())
  const historyReads = useRef(new Set<string>())

  useLayoutEffect(() => {
    currentScope.current = interactive && threadId ? scope : undefined
    return () => { currentScope.current = undefined }
  }, [interactive, scope, threadId])

  useEffect(() => {
    if (!target || !interactive) return
    const selection: ThreadReadTarget = target
    const key = scope
    let cancelled = false
    let timer: number | undefined
    let failures = 0
    let polling = Boolean(selection.runId)
    const cached = projectionCache.get(key)?.projection
    setState(cached ? { target: selection, scope: key, result: { projection: cached } } : undefined)

    function schedule(delay: number, poll: boolean): void {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void refresh(poll), delay)
    }

    function fail(reason: string, discard = false): void {
      setState((current) => ({
        target: selection,
        scope: key,
        result: {
          ...(!discard && current?.scope === key && current.target === selection && current.result.projection
            ? { projection: current.result.projection }
            : {}),
          error: reason,
        },
      }))
    }

    async function restoreSnapshot(snapshot: ConversationThreadSnapshot): Promise<ConversationThreadProjection | undefined> {
      if (snapshot.thread.id !== selection.threadId || snapshot.cursor.threadId !== selection.threadId) {
        throw Object.assign(new Error('未能读取所选会话。'), { code: IpcErrorCode.NotFound })
      }
      const head = snapshotProjection(snapshot)
      const latest = projectionCache.get(key)?.projection
      if (!latest?.cursor || !sameReadIdentity(latest.cursor, snapshot.cursor)) return head
      if (latest.cursor.sequence > snapshot.cursor.sequence) return latest
      const pages: ConversationThreadHistoryPage[] = []
      let cursor = head.historyCursor
      while (cursor) {
        const previous = projectionCache.get(key)?.projection
        if (!sameReadIdentity(previous?.cursor, snapshot.cursor)) return undefined
        const oldest = previous?.runs[0]?.ordinal
        if (oldest === undefined || cursor.beforeRunOrdinal <= oldest) break
        const result = await api.conversationHistory({
          cwd: root,
          threadId: selection.threadId,
          cursor,
          limit: Math.min(32, cursor.beforeRunOrdinal - oldest),
          ...(locator && { task: locator }),
        })
        if (cancelled || currentScope.current !== key ||
          !sameReadIdentity(projectionCache.get(key)?.projection.cursor, snapshot.cursor)) return undefined
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code })
        pages.unshift(result.page)
        cursor = historyPageCursor(result.page, cursor)
      }
      return prependHistory(head, pages)
    }

    async function refresh(poll: boolean): Promise<void> {
      try {
        const base = projectionCache.get(key)?.projection
        const previous = base?.cursor
        let merged: ConversationThreadProjection | undefined
        let hasMore = false
        if (poll && previous && base) {
          const result = await api.conversationEventDelta({
            cwd: root,
            threadId: selection.threadId,
            cursor: previous,
            limit: CONVERSATION_READ_PAGE_LIMIT,
            ...(locator && { task: locator }),
          })
          if (cancelled || currentScope.current !== key) return
          if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code })
          const latest = projectionCache.get(key)?.projection
          if (!latest?.cursor || !sameReadIdentity(latest.cursor, previous)) {
            schedule(0, Boolean(latest?.cursor))
            return
          }
          if (result.page.kind === 'reset') {
            merged = await restoreSnapshot(result.page.snapshot)
          } else if (sameReadIdentity(result.page.cursor, previous)) {
            merged = applyEventPage(latest, result.page).projection
            hasMore = result.page.hasMore
          } else {
            throw Object.assign(new Error('对话事件游标已失效，请刷新快照。'), { code: IpcErrorCode.ResetRequired })
          }
        } else {
          const result = await api.conversationRead(selection.threadId, root, locator)
          if (cancelled || currentScope.current !== key) return
          if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code })
          merged = await restoreSnapshot(result)
        }
        if (cancelled || currentScope.current !== key) return
        if (!merged) {
          schedule(0, false)
          return
        }
        remember(key, merged)
        setState(current => current?.scope === key && current.target === selection && !current.result.error &&
          current.result.projection === merged ? current : { target: selection, scope: key, result: { projection: merged } })
        failures = 0
        const run = merged.activeRun ?? (selection.runId ? merged.runs.find((item) => item.id === selection.runId) : undefined)
        polling = run ? isActiveRun(run) : Boolean(selection.runId)
        if (hasMore) schedule(0, true)
        else if (polling && (!merged.queuePaused || run?.status !== 'queued')) schedule(POLL_DELAY_MS, true)
        else schedule(IDLE_POLL_DELAY_MS, true)
      } catch (error) {
        if (cancelled || currentScope.current !== key) return
        const code = (error as { code?: unknown }).code
        if (code === IpcErrorCode.ResetRequired) {
          projectionCache.delete(key)
          setState(undefined)
          failures += 1
          schedule(failures === 1 ? 0 : READ_RETRY_MS, false)
          return
        }
        const lostAccess = losesReadAccess(code)
        if (lostAccess) projectionCache.delete(key)
        fail(failureReason(error), lostAccess)
        failures += 1
        if (!lostAccess) schedule(failures < 3 ? READ_RETRY_MS : IDLE_POLL_DELAY_MS, true)
      }
    }

    void refresh(Boolean(cached?.cursor))
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [root, scope, locator, target, interactive, attempt])

  const active = interactive && state?.scope === scope && state.target === target ? state.result : undefined

  const reload = useCallback((): void => {
    setAttempt((value) => value + 1)
  }, [])

  const setCommandBusy = useCallback((commandId: string, busy: boolean): void => {
    setPendingByScope((current) => {
      const scoped = new Set(current.get(scope))
      const next = new Map(current)
      if (busy) scoped.add(commandId)
      else scoped.delete(commandId)
      if (scoped.size) next.set(scope, scoped)
      else next.delete(scope)
      return next
    })
  }, [scope])

  const observeCommand = useCallback(async (commandId: string): Promise<ConversationApplyResult> => {
    if (!threadId || currentScope.current !== scope) return commandResult(commandId, null, 'reconcile')
    const receipt = await readConversationCommandState(root, threadId, commandId, locator)
    if (currentScope.current !== scope) return commandResult(commandId, null, 'reconcile')
    return commandResult(commandId, receipt, 'reconcile')
  }, [locator, root, scope, threadId])

  const trackOperation = useCallback((
    key: string,
    entry: TrackedCommand,
    invoke: () => Promise<ConversationApplyResult>,
  ): Promise<ConversationApplyResult> => {
    if (entry.inFlight) return entry.inFlight
    setCommandBusy(entry.commandId, true)
    entry.inFlight = invoke().then((result) => {
      if (!retainsCommand(result, entry)) actionCommands.delete(key)
      if (currentScope.current === scope) {
        setCommandIssue(result.ok ? undefined : { scope, failure: result })
        if (result.receipt) reload()
      }
      return result
    }).finally(() => {
      entry.inFlight = undefined
      setCommandBusy(entry.commandId, false)
    })
    return entry.inFlight
  }, [reload, scope, setCommandBusy])

  const checkCommand = useCallback((commandId: string): Promise<ConversationApplyResult> => {
    if (currentScope.current !== scope) return Promise.resolve(commandResult(commandId, null, 'reconcile'))
    let trackedOutsideScope = false
    for (const [key, entry] of actionCommands) {
      if (entry.commandId !== commandId) continue
      if (entry.scope !== scope) {
        trackedOutsideScope = true
        continue
      }
      const operation = trackOperation(key, entry, () => observeCommand(commandId))
      return operation.then((result) => result.source === 'reconcile' ? result : { ...result, source: 'reconcile' })
    }
    return trackedOutsideScope ? Promise.resolve(commandResult(commandId, null, 'reconcile')) : observeCommand(commandId)
  }, [observeCommand, scope, trackOperation])

  const reconcile = useCallback(async (commandId: string): Promise<ConversationThreadCommandState | null> => {
    const result = await checkCommand(commandId)
    return result.receipt ?? null
  }, [checkCommand])

  const applyRemembered = useCallback((
    action: string,
    build: () => ConversationThreadCommand,
  ): Promise<ConversationApplyResult> => {
    if (currentScope.current !== scope) return Promise.resolve(NO_THREAD_RESULT)
    const key = JSON.stringify([scope, action])
    const previous = actionCommands.get(key)
    if (previous) return checkCommand(previous.commandId)

    const command = build()
    if (command.threadId !== threadId) return Promise.resolve(NO_THREAD_RESULT)
    const entry: TrackedCommand = {
      commandId: command.commandId, scope,
      waitForTerminal: command.type === 'run.interrupt' || command.type === 'runtime-request.respond' || command.type === 'thread.compact',
    }
    actionCommands.set(key, entry)
    return trackOperation(key, entry, () => applyConversationCommand(root, command, locator))
  }, [checkCommand, locator, root, scope, threadId, trackOperation])

  const apply = useCallback((command: ConversationThreadCommand): Promise<ConversationApplyResult> =>
    command.threadId === threadId
      ? applyRemembered(commandAction(command), () => command)
      : Promise.resolve(NO_THREAD_RESULT), [applyRemembered, threadId])

  const queue = useMemo(
    () => ({
      edit: (runId: string, text: string) =>
        threadId
          ? applyRemembered(`edit:${runId}`, () => ({ type: 'queued-run.edit', threadId, runId, text, commandId: crypto.randomUUID() }))
          : Promise.resolve(NO_THREAD_RESULT),
      cancel: (runId: string) =>
        threadId
          ? applyRemembered(`cancel:${runId}`, () => ({ type: 'queued-run.cancel', threadId, runId, commandId: crypto.randomUUID() }))
          : Promise.resolve(NO_THREAD_RESULT),
      start: (runId: string) =>
        threadId
          ? applyRemembered(`start:${runId}`, () => ({ type: 'queued-run.start', threadId, runId, commandId: crypto.randomUUID() }))
          : Promise.resolve(NO_THREAD_RESULT),
      reorder: (runId: string, beforeRunId: string | null) =>
        threadId
          ? applyRemembered(`reorder:${runId}`, () => ({ type: 'queued-run.reorder', threadId, runId, beforeRunId, commandId: crypto.randomUUID() }))
          : Promise.resolve(NO_THREAD_RESULT),
      resume: () =>
        threadId
          ? applyRemembered('resume', () => ({ type: 'queue.resume', threadId, commandId: crypto.randomUUID() }))
          : Promise.resolve(NO_THREAD_RESULT),
    }),
    [applyRemembered, threadId],
  )

  const stop = useCallback(
    (runId: string) =>
      threadId
        ? applyRemembered(`stop:${runId}`, () => ({ type: 'run.interrupt', threadId, runId, commandId: crypto.randomUUID() }))
        : Promise.resolve(NO_THREAD_RESULT),
    [applyRemembered, threadId],
  )

  const respond = useCallback(
    (
      request: ConversationRuntimeRequest,
      response: ConversationRequestAnswer,
    ): Promise<ConversationApplyResult> => {
      if (!threadId) return Promise.resolve(NO_THREAD_RESULT)
      if (request.status !== 'pending') {
        return Promise.resolve({ ok: false, reason: '此请求已过期或已处理。', uncertain: false, source: 'apply' })
      }
      return applyRemembered(`respond:${request.requestId}:${request.generation}`, () => ({
        type: 'runtime-request.respond',
        threadId,
        requestId: request.requestId,
        generation: request.generation,
        commandId: crypto.randomUUID(),
        ...(response.decision ? { decision: response.decision as ConversationRuntimeRequestDecision } : {}),
        ...(response.answers ? { answers: response.answers } : {}),
        ...(response.draftId && response.attachmentIds?.length ? {
          draftId: response.draftId, attachmentIds: response.attachmentIds,
          attachmentQuestionId: response.attachmentQuestionId,
        } : {}),
      }))
    },
    [applyRemembered, threadId],
  )

  const loadEarlier = useCallback(async (): Promise<void> => {
    if (!target || currentScope.current !== scope || historyReads.current.has(scope)) return
    const selection = target
    const key = scope
    const current = projectionCache.get(key)?.projection
    const historyCursor = current?.historyCursor
    if (!current || !historyCursor) return
    historyReads.current.add(key)
    setLoadingEarlierScopes(new Set(historyReads.current))
    try {
      const result = await api.conversationHistory({
        cwd: root,
        threadId: selection.threadId,
        cursor: historyCursor,
        limit: 32,
        ...(locator && { task: locator }),
      })
      if (currentScope.current !== key) return
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code })
      const page: ConversationThreadHistoryPage = result.page
      const latest = projectionCache.get(key)?.projection
      if (!latest || !sameReadIdentity(latest.historyCursor, historyCursor) ||
        latest.historyCursor?.beforeRunOrdinal !== historyCursor.beforeRunOrdinal) return
      historyPageCursor(page, historyCursor)
      const merged = prependHistory(latest, [page])
      remember(key, merged)
      setState((value) => (value?.scope === key && value.target === selection ? { ...value, result: { projection: merged } } : value))
    } catch (error) {
      if (currentScope.current !== key) return
      const code = (error as { code?: unknown }).code
      if (code === IpcErrorCode.ResetRequired) {
        projectionCache.delete(key)
        setState(undefined)
        reload()
        return
      }
      const lostAccess = losesReadAccess(code)
      if (lostAccess) projectionCache.delete(key)
      setState((current) =>
        current?.scope === key && current.target === selection
          ? {
              ...current,
              result: {
                ...(!lostAccess && current.result.projection ? { projection: current.result.projection } : {}),
                error: failureReason(error),
              },
            }
          : current,
      )
    } finally {
      historyReads.current.delete(key)
      setLoadingEarlierScopes(new Set(historyReads.current))
    }
  }, [locator, reload, root, scope, target])

  const pendingCommands = pendingByScope.get(scope) ?? EMPTY_COMMANDS
  const loadingEarlier = loadingEarlierScopes.has(scope)
  const commandFailure = interactive && commandIssue?.scope === scope ? commandIssue.failure : undefined
  return useMemo<ConversationThreadController>(
    () => ({ scope, active, reload, loadEarlier, loadingEarlier, apply, queue, stop, respond, reconcile, checkCommand, pendingCommands, commandFailure }),
    [scope, active, reload, loadEarlier, loadingEarlier, apply, queue, stop, respond, reconcile, checkCommand, pendingCommands, commandFailure],
  )
}

type ConversationRuntimeRequestDecision =
  Extract<ConversationThreadCommand, { readonly type: 'runtime-request.respond' }>['decision']
