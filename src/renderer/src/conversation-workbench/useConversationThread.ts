import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ConversationRuntimeRequest,
  ConversationThreadCommand,
  ConversationThreadCommandState,
  ConversationThreadHistoryCursor,
  ConversationThreadHistoryPage,
  ConversationThreadSnapshot,
} from '../../../shared/conversation/command-runtime'
import { CONVERSATION_READ_PAGE_LIMIT } from '../../../shared/conversation/desktop'
import type { ProviderInteractionMode, RuntimeMode } from '../../../shared/conversation/providerPolicy'
import { IpcErrorCode } from '../../../shared/ipc-errors'
import type { ConversationTaskLocator } from '../../../shared/conversation/task-scope'
import { api } from '../api'
import { conversationError } from './useComposerSend'
import {
  applyEventPage,
  canResumeThread,
  commandResult,
  deriveResumableRunId,
  deriveTimelineRows,
  historyPageCursor,
  isActiveRun,
  isQueuedRun,
  losesReadAccess,
  prependHistory,
  projectionCacheKey,
  queuedRunsWithText,
  runStartIso,
  sameReadIdentity,
  snapshotProjection,
  wasNotAdmitted,
  type ConversationApplyResult,
  type ConversationMessage,
  type ConversationRun,
  type ConversationThread,
  type ConversationThreadProjection,
  type ConversationTimelineReasoningEntry,
  type ConversationTimelineRow,
  type ConversationTimelineWorkEntry,
  type ThreadReadTarget,
} from './threadProjectionModel'

export {
  applyEventPage,
  canResumeThread,
  commandResult,
  deriveResumableRunId,
  deriveTimelineRows,
  isActiveRun,
  isQueuedRun,
  queuedRunsWithText,
  runStartIso,
  type ConversationApplyResult,
  type ConversationMessage,
  type ConversationRun,
  type ConversationThread,
  type ConversationThreadProjection,
  type ConversationTimelineReasoningEntry,
  type ConversationTimelineRow,
  type ConversationTimelineWorkEntry,
  type ThreadReadTarget,
}

const POLL_DELAY_MS = 450
/** An open idle thread still re-reads deltas, so work started in another window shows up. */
const IDLE_POLL_DELAY_MS = 5_000
const READ_RETRY_MS = 1_800
const CACHE_LIMIT = 32

interface CachedProjection {
  readonly projection: ConversationThreadProjection
}

const projectionCache = new Map<string, CachedProjection>()

function cacheKey(scopeKey: string, root: string, threadId: string, task?: ConversationTaskLocator): string {
  return projectionCacheKey(scopeKey, root, threadId, task)
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
  readonly loadEarlier: () => Promise<boolean>
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
  readonly forceStop: (runId?: string) => Promise<ConversationApplyResult>
  readonly stopSubagent: (childThreadId: string, force?: boolean) => Promise<ConversationApplyResult>
  readonly cancelUsageLimitRecovery: () => Promise<ConversationApplyResult>
  readonly retryUsageLimitRecoveryNow: () => Promise<ConversationApplyResult>
  readonly setRuntimeMode: (runtimeMode: RuntimeMode) => Promise<ConversationApplyResult>
  readonly setInteractionMode: (interactionMode: ProviderInteractionMode) => Promise<ConversationApplyResult>
  readonly rollbackCheckpoint: (input: {
    readonly targetRunId: string
    readonly boundary: 'before' | 'after'
    readonly restoreFiles: boolean
  }) => Promise<ConversationApplyResult>
  readonly editAndRerun: (input: {
    readonly targetRunId: string
    readonly messageId: string
    readonly text: string
    readonly restoreFiles: boolean
    readonly instanceId: string
    readonly model: string
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
  }) => Promise<ConversationApplyResult>
  readonly switchProvider: (input: {
    readonly instanceId: string
    readonly model: string
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
  }) => Promise<ConversationApplyResult>
  readonly mergeBackThread: (input: {
    readonly sourceThreadId: string
    readonly summary?: string
    readonly messageIds?: readonly string[]
  }) => Promise<ConversationApplyResult>
  readonly resume: (input?: {
    readonly sourceRunId: string
    readonly instanceId: string
    readonly model: string
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
  }) => Promise<ConversationApplyResult>
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
    case 'thread.stop': return command.runId ? `force-stop:${command.runId}` : 'force-stop'
    case 'subagent.stop': return `subagent-stop:${command.childThreadId}`
    case 'usage-limit-recovery.cancel': return 'usage-limit-recovery.cancel'
    case 'usage-limit-recovery.retry-now': return 'usage-limit-recovery.retry-now'
    case 'thread.runtime-mode.set': return 'runtime-mode'
    case 'thread.interaction-mode.set': return 'interaction-mode'
    case 'checkpoint.rollback': return 'checkpoint.rollback'
    case 'message.edit-and-rerun': return 'message.edit-and-rerun'
    case 'provider.switch': return 'provider.switch'
    case 'thread.merge_back': return 'thread.merge_back'
    case 'runtime-request.respond': return `respond:${command.requestId}:${command.generation}`
    default: return `command:${command.commandId}`
  }
}

function retainsCommand(result: ConversationApplyResult, command: TrackedCommand): boolean {
  return result.uncertain || (
    result.ok && command.waitForTerminal && result.receipt.dispatch !== 'completed'
  )
}

const inflightPrefetches = new Map<string, Promise<void>>()

/**
 * 对标 t3code ShellSnapshot 预热：后台提前读取指定会话快照并写入 projectionCache，
 * 用户点击进对话或切换最近会话时 0ms 直接命中内存投影，无需等待跨进程读取。
 */
export function prefetchConversationThread(
  root: string,
  threadId: string,
  scopeKey = '',
  task?: ConversationTaskLocator,
): Promise<void> {
  if (!root || !threadId) return Promise.resolve()
  const locator = task?.workspaceKey && task.taskId && task.taskCreatedAt
    ? { workspaceKey: task.workspaceKey, taskId: task.taskId, taskCreatedAt: task.taskCreatedAt, ...(task.scopeKey && { scopeKey: task.scopeKey }) }
    : undefined
  const key = cacheKey(scopeKey, root, threadId, locator)
  if (projectionCache.has(key)) return Promise.resolve()
  const existing = inflightPrefetches.get(key)
  if (existing) return existing
  const work = api.conversationRead(threadId, root, locator).then(result => {
    if (!result.ok || result.thread.id !== threadId || result.cursor.threadId !== threadId) return
    if (!projectionCache.has(key)) remember(key, snapshotProjection(result))
  }).catch(() => undefined).finally(() => {
    if (inflightPrefetches.get(key) === work) inflightPrefetches.delete(key)
  })
  inflightPrefetches.set(key, work)
  return work
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
  const [state, setState] = useState<ReadState | undefined>(() => {
    if (!target || !interactive) return undefined
    const cached = projectionCache.get(scope)?.projection
    return cached ? { target, scope, result: { projection: cached } } : undefined
  })
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

  const active = useMemo(() => {
    if (!interactive || !target) return undefined
    if (state?.scope === scope && state.target === target) return state.result
    const cached = projectionCache.get(scope)?.projection
    return cached ? { projection: cached } : undefined
  }, [interactive, scope, state, target])

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

  const forceStop = useCallback(
    (runId?: string) =>
      threadId
        ? applyRemembered(runId ? `force-stop:${runId}` : 'force-stop', () => ({
          type: 'thread.stop',
          threadId,
          ...(runId ? { runId } : {}),
          commandId: crypto.randomUUID(),
        }))
        : Promise.resolve(NO_THREAD_RESULT),
    [applyRemembered, threadId],
  )

  const stopSubagent = useCallback(
    (childThreadId: string, force?: boolean) =>
      threadId
        ? applyRemembered(`subagent-stop:${childThreadId}`, () => ({
          type: 'subagent.stop',
          threadId,
          childThreadId,
          ...(force ? { force: true } : {}),
          commandId: crypto.randomUUID(),
        }))
        : Promise.resolve(NO_THREAD_RESULT),
    [applyRemembered, threadId],
  )

  const cancelUsageLimitRecovery = useCallback(
    () =>
      threadId
        ? applyRemembered('usage-limit-recovery.cancel', () => ({
          type: 'usage-limit-recovery.cancel',
          threadId,
          commandId: crypto.randomUUID(),
        }))
        : Promise.resolve(NO_THREAD_RESULT),
    [applyRemembered, threadId],
  )

  const retryUsageLimitRecoveryNow = useCallback(
    () =>
      threadId
        ? applyRemembered('usage-limit-recovery.retry-now', () => ({
          type: 'usage-limit-recovery.retry-now',
          threadId,
          commandId: crypto.randomUUID(),
        }))
        : Promise.resolve(NO_THREAD_RESULT),
    [applyRemembered, threadId],
  )

  const setRuntimeMode = useCallback(
    (runtimeMode: RuntimeMode) =>
      threadId
        ? applyRemembered('runtime-mode', () => ({
          type: 'thread.runtime-mode.set',
          threadId,
          runtimeMode,
          commandId: crypto.randomUUID(),
        }))
        : Promise.resolve(NO_THREAD_RESULT),
    [applyRemembered, threadId],
  )

  const setInteractionMode = useCallback(
    (interactionMode: ProviderInteractionMode) =>
      threadId
        ? applyRemembered('interaction-mode', () => ({
          type: 'thread.interaction-mode.set',
          threadId,
          interactionMode,
          commandId: crypto.randomUUID(),
        }))
        : Promise.resolve(NO_THREAD_RESULT),
    [applyRemembered, threadId],
  )

  const rollbackCheckpoint = useCallback(
    (input: {
      readonly targetRunId: string
      readonly boundary: 'before' | 'after'
      readonly restoreFiles: boolean
    }) =>
      threadId
        ? applyRemembered('checkpoint.rollback', () => ({
          type: 'checkpoint.rollback',
          threadId,
          targetRunId: input.targetRunId,
          boundary: input.boundary,
          restoreFiles: input.restoreFiles,
          commandId: crypto.randomUUID(),
        })).then(result => {
          if (result.ok) reload()
          return result
        })
        : Promise.resolve(NO_THREAD_RESULT),
    [applyRemembered, reload, threadId],
  )

  const editAndRerun = useCallback(
    (input: {
      readonly targetRunId: string
      readonly messageId: string
      readonly text: string
      readonly restoreFiles: boolean
      readonly instanceId: string
      readonly model: string
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    }) =>
      threadId
        ? applyRemembered('message.edit-and-rerun', () => ({
          type: 'message.edit-and-rerun',
          threadId,
          targetRunId: input.targetRunId,
          messageId: input.messageId,
          text: input.text,
          restoreFiles: input.restoreFiles,
          instanceId: input.instanceId,
          model: input.model,
          ...(input.options?.length ? { options: input.options.map(option => ({ id: option.id, value: option.value })) } : {}),
          commandId: crypto.randomUUID(),
        })).then(result => {
          if (result.ok) reload()
          return result
        })
        : Promise.resolve(NO_THREAD_RESULT),
    [applyRemembered, reload, threadId],
  )

  const switchProvider = useCallback(
    (input: {
      readonly instanceId: string
      readonly model: string
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    }) =>
      threadId
        ? applyRemembered('provider.switch', () => ({
          type: 'provider.switch',
          threadId,
          instanceId: input.instanceId,
          model: input.model,
          ...(input.options?.length ? { options: input.options.map(option => ({ id: option.id, value: option.value })) } : {}),
          commandId: crypto.randomUUID(),
        })).then(result => {
          if (result.ok) reload()
          return result
        })
        : Promise.resolve(NO_THREAD_RESULT),
    [applyRemembered, reload, threadId],
  )

  const mergeBackThread = useCallback(
    (input: {
      readonly sourceThreadId: string
      readonly summary?: string
      readonly messageIds?: readonly string[]
    }) =>
      threadId
        ? applyRemembered('thread.merge_back', () => ({
          type: 'thread.merge_back',
          threadId,
          sourceThreadId: input.sourceThreadId,
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.messageIds?.length ? { messageIds: [...input.messageIds] } : {}),
          commandId: crypto.randomUUID(),
        })).then(result => {
          if (result.ok) reload()
          return result
        })
        : Promise.resolve(NO_THREAD_RESULT),
    [applyRemembered, reload, threadId],
  )

  const resume = useCallback(
    (input?: {
      readonly sourceRunId: string
      readonly instanceId: string
      readonly model: string
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    }) => {
      if (!threadId) return Promise.resolve(NO_THREAD_RESULT)
      if (!input) return queue.resume()
      return applyRemembered(`continue:${input.sourceRunId}`, () => ({
        type: 'message.dispatch',
        threadId,
        commandId: crypto.randomUUID(),
        messageId: `msg_${crypto.randomUUID()}`,
        text: '',
        instanceId: input.instanceId,
        model: input.model,
        ...(input.options?.length ? { options: input.options.map(option => ({ id: option.id, value: option.value })) } : {}),
        manualContinuationOfRunId: input.sourceRunId,
      }))
    },
    [applyRemembered, queue, threadId],
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

  const loadEarlier = useCallback(async (): Promise<boolean> => {
    if (!target || currentScope.current !== scope || historyReads.current.has(scope)) return false
    const selection = target
    const key = scope
    const current = projectionCache.get(key)?.projection
    const historyCursor = current?.historyCursor
    if (!current || !historyCursor) return false
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
      if (currentScope.current !== key) return false
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code })
      const page: ConversationThreadHistoryPage = result.page
      const latest = projectionCache.get(key)?.projection
      if (!latest || !sameReadIdentity(latest.historyCursor, historyCursor) ||
        latest.historyCursor?.beforeRunOrdinal !== historyCursor.beforeRunOrdinal) return false
      historyPageCursor(page, historyCursor)
      const merged = prependHistory(latest, [page])
      remember(key, merged)
      setState((value) => (value?.scope === key && value.target === selection ? { ...value, result: { projection: merged } } : value))
      return true
    } catch (error) {
      if (currentScope.current !== key) return false
      const code = (error as { code?: unknown }).code
      if (code === IpcErrorCode.ResetRequired) {
        projectionCache.delete(key)
        setState(undefined)
        reload()
        return false
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
      return false
    } finally {
      historyReads.current.delete(key)
      setLoadingEarlierScopes(new Set(historyReads.current))
    }
  }, [locator, reload, root, scope, target])

  const pendingCommands = pendingByScope.get(scope) ?? EMPTY_COMMANDS
  const loadingEarlier = loadingEarlierScopes.has(scope)
  const commandFailure = interactive && commandIssue?.scope === scope ? commandIssue.failure : undefined
  return useMemo<ConversationThreadController>(
    () => ({
      scope, active, reload, loadEarlier, loadingEarlier, apply, queue, stop, forceStop, stopSubagent,
      cancelUsageLimitRecovery, retryUsageLimitRecoveryNow, setRuntimeMode, setInteractionMode,
      rollbackCheckpoint, editAndRerun, switchProvider, mergeBackThread,
      resume, respond, reconcile, checkCommand, pendingCommands, commandFailure,
    }),
    [
      scope, active, reload, loadEarlier, loadingEarlier, apply, queue, stop, forceStop, stopSubagent,
      cancelUsageLimitRecovery, retryUsageLimitRecoveryNow, setRuntimeMode, setInteractionMode,
      rollbackCheckpoint, editAndRerun, switchProvider, mergeBackThread,
      resume, respond, reconcile, checkCommand, pendingCommands, commandFailure,
    ],
  )
}

type ConversationRuntimeRequestDecision =
  Extract<ConversationThreadCommand, { readonly type: 'runtime-request.respond' }>['decision']
