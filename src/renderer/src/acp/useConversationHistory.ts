import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, hasIpc } from '../api'
import { useApp } from '../store'
import { projectRootKey } from '../my/navigation'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { orderTimelineEvents } from './event-order'
import type { AcpHistoryCoverage, AcpHistoryEventPage, AcpHistorySummary } from '@shared/acp-history'
import type { AcpSessionMeta, TimelineEvent } from '@shared/types'

export type ConversationArchive = 'active' | 'archived'
export type ConversationUpdate = Parameters<typeof api.acpHistoryUpdate>[1]
export function compareConversationSessions(left: AcpSessionMeta & { lastActivityAt?: number }, right: AcpSessionMeta & { lastActivityAt?: number }): number {
  return Number(right.pinnedAt !== undefined) - Number(left.pinnedAt !== undefined) || (right.lastActivityAt ?? right.startedAt) - (left.lastActivityAt ?? left.startedAt) || right.sessionId.localeCompare(left.sessionId)
}
function sameRoot(left: string, right: string): boolean { return projectRootKey(left) === projectRootKey(right) }
/** Runtime state never owns these independently persisted management fields. */
export function conversationManagement(session: AcpSessionMeta): Pick<AcpSessionMeta, 'title' | 'customTitle' | 'pinnedAt' | 'archivedAt'> {
  return { title: session.title, customTitle: session.customTitle, pinnedAt: session.pinnedAt, archivedAt: session.archivedAt }
}
function merge(previous: TimelineEvent[], incoming: TimelineEvent[], prepend = false): TimelineEvent[] {
  const byId = new Map(previous.map((event) => [event.id, event]))
  for (const event of incoming) byId.set(event.id, event)
  return orderTimelineEvents(byId, prepend ? [incoming, previous] : [previous, incoming])
}
/** Paged history is independent from drafts, current connection and actionable permissions. */
export function useConversationHistory(root: string, activeId: string | null) {
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const interactionSignal = useInteractionSignal()
  const [sessions, setSessions] = useState<AcpHistorySummary[]>([])
  const [knownSessions, setKnownSessions] = useState<Record<string, AcpHistorySummary>>({})
  const [events, setEvents] = useState<Record<string, TimelineEvent[]>>({})
  const [query, setQuery] = useState('')
  const [archive, setArchive] = useState<ConversationArchive>('active')
  const [mutationBusy, setMutationBusy] = useState<Record<string, boolean>>({})
  const [mutationErrors, setMutationErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [error, setError] = useState('')
  const [selectionErrors, setSelectionErrors] = useState<Record<string, string>>({})
  const [hasMore, setHasMore] = useState(false)
  const [page, setPage] = useState<AcpHistoryEventPage | null>(null)
  const [selectionLoading, setSelectionLoading] = useState(false)
  const [selectionResolved, setSelectionResolved] = useState(false)
  const [selectionRevision, setSelectionRevision] = useState(0)
  const [selectionKey, setSelectionKey] = useState('')
  const requestedSelectionKey = `${root}\0${activeId ?? ''}\0${selectionRevision}`
  const reloadSelected = useCallback((): void => setSelectionRevision((revision) => revision + 1), [])
  const scope = useMemo(() => ({ root, live: true, listSerial: 0, selectionSerial: 0, reads: new Map<string, number>(), managementRevision: 0, cursor: null as string | null, pages: new Map<string, AcpHistoryEventPage>(), managed: new Map<string, { revision: number; session: AcpHistorySummary }>(), mutations: new Set<string>(), listBusy: false, earlierBusy: false, refreshing: null as Promise<void> | null, refreshAgain: false }), [root])
  const current = useRef(scope)
  current.current = scope
  const selection = useRef(activeId)
  selection.current = activeId
  const search = useRef(query)
  search.current = query
  const archiveRef = useRef(archive)
  archiveRef.current = archive
  const owner = useMemo(() => ({ root, activeId, interactive, interactionSignal }), [root, activeId, interactive, interactionSignal])
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const isCurrent = useCallback(() => current.current === scope && scope.live && sameRoot(useApp.getState().snapshot?.meta.root ?? '', root), [scope, root])
  const remember = useCallback((incoming: AcpHistorySummary[], requestedRevision: number): AcpHistorySummary[] => {
    const records = incoming.filter((session) => sameRoot(root, session.projectRoot)).map((session) => {
      const managed = scope.managed.get(session.sessionId)
      if (managed && managed.revision > requestedRevision) return { ...session, ...conversationManagement(managed.session) }
      // Reads issued after an acknowledgement are authoritative, including a
      // save that completed while its original UI owner was suspended.
      if (managed) scope.managed.set(session.sessionId, { revision: managed.revision, session })
      return session
    })
    setKnownSessions((previous) => {
      const next = { ...previous }
      for (const session of records) {
        const saved = previous[session.sessionId]
        // A page/list requested before a live state must not revive ready (or
        // an old connection) when its slower history read eventually returns.
        next[session.sessionId] = saved && (saved.stateRevision ?? 0) > (session.stateRevision ?? 0)
          ? { ...session, ...saved, ...conversationManagement(session) } : session
      }
      return next
    })
    return records
  }, [root, scope])
  const hydratePage = useCallback((id: string, input: { before?: string }, valid: () => boolean) => {
    return valid() ? api.acpHistoryEvents(id, input) : Promise.resolve(null)
  }, [])
  const hydrateSession = useCallback((id: string, valid: () => boolean) => {
    return valid() ? api.acpHistorySession(id) : Promise.resolve(null)
  }, [])
  const refreshSession = useCallback(async (id: string): Promise<AcpHistorySummary | null> => {
    if (!hasIpc || !isCurrent()) return null
    const revision = scope.managementRevision
    const result = await hydrateSession(id, isCurrent)
    if (!result || !isCurrent()) return null
    if (!result.ok) { setSelectionErrors((errors) => ({ ...errors, [id]: result.error })); throw Error(result.error) }
    if (result.session.sessionId !== id || !sameRoot(root, result.session.projectRoot)) throw Error('历史会话不匹配，请重试。')
    const [record] = remember([result.session], revision)
    setSelectionErrors((errors) => ({ ...errors, [id]: '' }))
    return record
  }, [scope, root, isCurrent, hydrateSession, remember])

  const refresh = useCallback(async (): Promise<void> => {
    if (!hasIpc || !api.acpHistoryList || !root || !isCurrent()) return
    // Invalidation is a latest-state read intent, not another concurrent RPC.
    // Keep one in-flight list and one trailing refresh with the latest filters.
    scope.listSerial++
    scope.refreshAgain = true
    if (scope.refreshing) return scope.refreshing
    setLoading(true)
    const pending = Promise.resolve().then(async (): Promise<void> => {
      try {
        while (scope.refreshAgain && isCurrent()) {
          scope.refreshAgain = false
          const serial = scope.listSerial
          const requestedQuery = search.current
          const requestedArchive = archiveRef.current
          const requestedRevision = scope.managementRevision
          try {
            const result = await api.acpHistoryList({ query: requestedQuery, archive: requestedArchive })
            if (!isCurrent() || serial !== scope.listSerial || requestedQuery !== search.current || requestedArchive !== archiveRef.current) continue
            if (!result.ok) { setError(result.error); continue }
            setSessions(remember(result.sessions, requestedRevision))
            scope.cursor = result.nextCursor; setHasMore(result.hasMore)
            setError(result.diagnostics.length ? result.diagnostics.map((item) => item.message).join('；') : '')
          } catch (reason) { if (isCurrent() && serial === scope.listSerial) setError(String(reason)) }
        }
      } finally {
        // Release with the last drain: a later invalidation starts a new read.
        scope.refreshing = null
        if (isCurrent()) setLoading(false)
      }
    })
    scope.refreshing = pending
    return pending
  }, [root, scope, isCurrent, remember])

  const update = useCallback(async (id: string, patch: ConversationUpdate): Promise<AcpHistorySummary | null> => {
    if (!hasIpc || typeof api.acpHistoryUpdate !== 'function' || !isCurrent() || !canInteract() || scope.mutations.has(id)) return null
    const requestedOwner = ownerRef.current
    const valid = (): boolean => isCurrent() && canInteract() && !requestedOwner.interactionSignal?.aborted && ownerRef.current === requestedOwner
    scope.mutations.add(id)
    setMutationBusy((previous) => ({ ...previous, [id]: true }))
    setMutationErrors((previous) => ({ ...previous, [id]: '' }))
    try {
      const result = await api.acpHistoryUpdate(id, patch)
      if (!valid()) {
        // Reject the old interaction's result. A fresh root-owned read can
        // reconcile persisted changes without reopening a dialog or navigating.
        if (isCurrent()) { void refresh(); reloadSelected() }
        return null
      }
      if (!result.ok) { setMutationErrors((previous) => ({ ...previous, [id]: result.error })); return null }
      if (result.session.sessionId !== id || !sameRoot(root, result.session.projectRoot)) return null
      scope.managed.set(id, { revision: ++scope.managementRevision, session: result.session })
      remember([result.session], scope.managementRevision)
      setSessions((previous) => previous.map((session) => session.sessionId === id ? result.session : session)
        .filter((session) => archiveRef.current === 'archived' ? !!session.archivedAt : !session.archivedAt).sort(compareConversationSessions))
      // Invalidate a list requested before this acknowledgement. Drafts and event pages stay intact.
      void refresh()
      return result.session
    } catch (reason) {
      if (valid()) setMutationErrors((previous) => ({ ...previous, [id]: reason instanceof Error ? reason.message : '操作失败，请重试。' }))
      return null
    } finally {
      scope.mutations.delete(id)
      if (isCurrent()) setMutationBusy((previous) => ({ ...previous, [id]: false }))
    }
  }, [root, scope, isCurrent, canInteract, remember, refresh, reloadSelected])

  const loadMore = useCallback(async (): Promise<void> => {
    if (!hasIpc || !api.acpHistoryList || !scope.cursor || scope.listBusy || !isCurrent()) return
    const cursor = scope.cursor
    const serial = scope.listSerial
    const requestedQuery = search.current
    const requestedArchive = archiveRef.current
    const requestedRevision = scope.managementRevision
    scope.listBusy = true; setLoadingMore(true)
    try {
      const result = await api.acpHistoryList({ query: requestedQuery, cursor, archive: requestedArchive })
      if (!isCurrent() || serial !== scope.listSerial || requestedQuery !== search.current || requestedArchive !== archiveRef.current) return
      if (!result.ok) {
        if (result.code === 'E_CONFLICT') await refresh()
        else setError(result.error)
        return
      }
      const incoming = remember(result.sessions, requestedRevision)
      setSessions((previous) => { const known = new Set(previous.map((session) => session.sessionId)); return [...previous, ...incoming.filter((session) => !known.has(session.sessionId))] })
      scope.cursor = result.nextCursor; setHasMore(result.hasMore)
    } catch (reason) { if (isCurrent()) setError(String(reason)) }
    finally { scope.listBusy = false; if (isCurrent()) setLoadingMore(false) }
  }, [root, scope, isCurrent, refresh, remember])

  const loadEarlier = useCallback(async (): Promise<void> => {
    const id = selection.current
    const previous = id ? scope.pages.get(id) : undefined
    if (!id || !previous?.beforeCursor || scope.earlierBusy || !isCurrent()) return
    const serial = scope.selectionSerial
    scope.earlierBusy = true; setLoadingEarlier(true)
    try {
      const result = await hydratePage(id, { before: previous.beforeCursor }, () => isCurrent() && selection.current === id && serial === scope.selectionSerial)
      if (!isCurrent() || selection.current !== id || serial !== scope.selectionSerial) return
      if (!result) return
      if (!result.ok) { setSelectionErrors((errors) => ({ ...errors, [id]: result.error })); return }
      const combined = { ...result, afterCursor: previous.afterCursor, hasLater: previous.hasLater }
      scope.pages.set(id, combined); setPage(combined)
      setEvents((currentEvents) => ({ ...currentEvents, [id]: merge(currentEvents[id] ?? [], result.events, true) }))
      setSelectionErrors((errors) => ({ ...errors, [id]: '' }))
    } catch (reason) { if (isCurrent() && selection.current === id) setSelectionErrors((errors) => ({ ...errors, [id]: String(reason) })) }
    finally { scope.earlierBusy = false; if (isCurrent()) setLoadingEarlier(false) }
  }, [scope, isCurrent, hydratePage])

  useEffect(() => {
    scope.live = true
    setSessions([]); setKnownSessions({}); setEvents({}); setPage(null); setError(''); setSelectionErrors({}); setHasMore(false)
    setMutationBusy({}); setMutationErrors({}); setArchive('active')
    setLoadingMore(false); setLoadingEarlier(false)
    return () => { scope.live = false }
  }, [scope])
  useEffect(() => { scope.cursor = null; setHasMore(false); setSessions([]); void refresh() }, [query, archive, refresh, scope])
  useEffect(() => { if (interactive) { void refresh(); reloadSelected() } }, [interactive, refresh, reloadSelected])
  useEffect(() => {
    const id = activeId
    const serial = ++scope.selectionSerial
    setSelectionKey(`${root}\0${id ?? ''}\0${selectionRevision}`)
    setPage(id ? scope.pages.get(id) ?? null : null)
    setSelectionResolved(false)
    setSelectionLoading(!!id)
    if (!id || !hasIpc || !api.acpHistorySession || !isCurrent()) { setSelectionLoading(false); setSelectionResolved(true); return }
    // Reads belong to the conversation, not the selected view. Different IDs
    // hydrate independently; a later read of the same ID supersedes an old one.
    const read = (scope.reads.get(id) ?? 0) + 1
    scope.reads.set(id, read)
    setSelectionErrors((errors) => ({ ...errors, [id]: '' }))
    const valid = (): boolean => isCurrent() && scope.reads.get(id) === read
    const revision = scope.managementRevision
    const failed = (reason: string): void => { if (valid()) setSelectionErrors((errors) => ({ ...errors, [id]: reason })) }
    void Promise.allSettled([
      hydrateSession(id, valid).then((result) => {
        if (!valid() || !result) return
        if (!result.ok) { failed(result.error); return }
        if (result.session.sessionId !== id) { failed('历史会话不匹配，请重试。'); return }
        remember([result.session], revision)
      }),
      hydratePage(id, {}, valid).then((result) => {
        if (!valid() || !result) return
        if (!result.ok) { failed(result.error); return }
        if (result.session.sessionId !== id || !sameRoot(root, result.session.projectRoot)) { failed('历史会话不匹配，请重试。'); return }
        const previous = scope.pages.get(id)
        const combined = previous?.hasEarlier === false ? { ...result, beforeCursor: null, hasEarlier: false } : previous ? { ...result, beforeCursor: previous.beforeCursor, hasEarlier: previous.hasEarlier, startsMidTurn: previous.startsMidTurn } : result
        scope.pages.set(id, combined)
        if (selection.current === id) setPage(combined)
        remember([result.session], revision)
        setEvents((currentEvents) => ({ ...currentEvents, [id]: merge(currentEvents[id] ?? [], result.events) }))
      })
    ]).then((results) => {
      if (!valid()) return
      for (const result of results) if (result.status === 'rejected') failed(String(result.reason))
    })
      .finally(() => { if (isCurrent() && selection.current === id && serial === scope.selectionSerial) { setSelectionLoading(false); setSelectionResolved(true) } })
  }, [root, activeId, scope, isCurrent, hydratePage, hydrateSession, selectionRevision, remember])
  useEffect(() => {
    if (!hasIpc || !api.acpHistoryList || !root) return
    let pending: ReturnType<typeof setTimeout> | undefined
    const statuses = new Map<string, string>()
    const schedule = (): void => { if (pending) clearTimeout(pending); pending = setTimeout(() => { pending = undefined; void refresh() }, 200) }
    const offState = api.onAcpState((state) => {
      if (!isCurrent() || !sameRoot(root, state.projectRoot)) return
      if (statuses.get(state.sessionId) !== state.status) { statuses.set(state.sessionId, state.status); schedule() }
      setKnownSessions((previous) => {
        const saved = previous[state.sessionId]
        if (!saved || (saved.stateRevision ?? 0) > (state.stateRevision ?? 0)) return previous
        return { ...previous, [state.sessionId]: { ...saved, ...state.session, status: state.status, error: state.error,
          connectionGeneration: state.connectionGeneration ?? state.session?.connectionGeneration ?? saved.connectionGeneration,
          turnId: state.turnId ?? state.session?.turnId ?? saved.turnId,
          ...conversationManagement(scope.managed.get(state.sessionId)?.session ?? saved), pendingPermissions: state.pendingPermissions ?? state.session?.pendingPermissions ?? [], stateRevision: state.stateRevision ?? saved.stateRevision } }
      })
    })
    const offDone = api.onAcpDone((state) => { if (isCurrent() && (!state.projectRoot || sameRoot(root, state.projectRoot))) schedule() })
    const bridge = api as typeof api & { onDaemonRuntimeReset?: (callback: (event: { projectRoot: string }) => void) => () => void }
    const offReset = bridge.onDaemonRuntimeReset?.(event => { if (isCurrent() && sameRoot(root, event.projectRoot)) { schedule(); reloadSelected() } })
    return () => { offState(); offDone(); offReset?.(); if (pending) clearTimeout(pending) }
  }, [root, scope, isCurrent, refresh, reloadSelected])
  const selectedSession = activeId ? knownSessions[activeId] ?? null : null
  const selectedPage = activeId ? scope.pages.get(activeId) ?? (page?.session.sessionId === activeId ? page : null) : null
  const coverage: AcpHistoryCoverage | null = selectedPage?.coverage ?? selectedSession?.historyCoverage ?? null
  return { sessions, knownSessions, selectedSession, events, query, setQuery, archive, setArchive, update, mutationBusy, mutationErrors,
    canManage: hasIpc && typeof api.acpHistoryUpdate === 'function', loading, loadingMore, loadingEarlier, error, hasMore,
    selectionError: activeId ? selectionErrors[activeId] ?? '' : '',
    hasEarlier: selectedPage?.hasEarlier ?? false, coverage, startsMidTurn: selectedPage?.startsMidTurn ?? false, refresh, refreshSession, loadMore, loadEarlier,
    selectionLoading: !!activeId && (selectionKey !== requestedSelectionKey || selectionLoading),
    selectionResolved: selectionKey === requestedSelectionKey && selectionResolved, reloadSelected }
}
