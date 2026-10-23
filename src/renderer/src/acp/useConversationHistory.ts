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
  const [selectedSession, setSelectedSession] = useState<AcpHistorySummary | null>(null)
  const [events, setEvents] = useState<Record<string, TimelineEvent[]>>({})
  const [query, setQuery] = useState('')
  const [archive, setArchive] = useState<ConversationArchive>('active')
  const [mutationBusy, setMutationBusy] = useState<Record<string, boolean>>({})
  const [mutationErrors, setMutationErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [error, setError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [page, setPage] = useState<AcpHistoryEventPage | null>(null)
  const [selectionLoading, setSelectionLoading] = useState(false)
  const [selectionResolved, setSelectionResolved] = useState(false)
  const [selectionRevision, setSelectionRevision] = useState(0)
  const [selectionKey, setSelectionKey] = useState('')
  const requestedSelectionKey = `${root}\0${activeId ?? ''}\0${selectionRevision}`
  const reloadSelected = useCallback((): void => setSelectionRevision((revision) => revision + 1), [])
  const scope = useMemo(() => ({ root, live: true, listSerial: 0, selectionSerial: 0, managementRevision: 0, cursor: null as string | null, pages: new Map<string, AcpHistoryEventPage>(), managed: new Map<string, { revision: number; session: AcpHistorySummary }>(), mutations: new Set<string>(), listBusy: false, earlierBusy: false }), [root])
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
  const pageQueue = useRef<Promise<void>>(Promise.resolve())
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
    setKnownSessions((previous) => ({ ...previous, ...Object.fromEntries(records.map((session) => [session.sessionId, session])) }))
    return records
  }, [root, scope])
  const hydratePage = useCallback((id: string, input: { before?: string }, valid: () => boolean) => {
    const request = pageQueue.current.then(() => valid() ? api.acpHistoryEvents(id, input) : null)
    pageQueue.current = request.then(() => {}, () => {})
    return request
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (!hasIpc || !api.acpHistoryList || !root || !isCurrent()) return
    const serial = ++scope.listSerial
    const requestedQuery = search.current
    const requestedArchive = archiveRef.current
    const requestedRevision = scope.managementRevision
    setLoading(true)
    try {
      const result = await api.acpHistoryList({ query: requestedQuery, archive: requestedArchive })
      if (!isCurrent() || serial !== scope.listSerial || requestedQuery !== search.current || requestedArchive !== archiveRef.current) return
      if (!result.ok) { setError(result.error); return }
      setSessions(remember(result.sessions, requestedRevision))
      scope.cursor = result.nextCursor; setHasMore(result.hasMore)
      setError(result.diagnostics.length ? result.diagnostics.map((item) => item.message).join('；') : '')
    } catch (reason) { if (isCurrent() && serial === scope.listSerial) setError(String(reason)) }
    finally { if (isCurrent() && serial === scope.listSerial) setLoading(false) }
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
      setSelectedSession((previous) => previous?.sessionId === id ? { ...previous, ...conversationManagement(result.session) } : previous)
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
      if (!result.ok) { setError(result.error); return }
      const combined = { ...result, afterCursor: previous.afterCursor, hasLater: previous.hasLater }
      scope.pages.set(id, combined); setPage(combined)
      setEvents((currentEvents) => ({ ...currentEvents, [id]: merge(currentEvents[id] ?? [], result.events, true) }))
    } catch (reason) { if (isCurrent() && selection.current === id) setError(String(reason)) }
    finally { scope.earlierBusy = false; if (isCurrent()) setLoadingEarlier(false) }
  }, [scope, isCurrent, hydratePage])

  useEffect(() => {
    scope.live = true
    setSessions([]); setKnownSessions({}); setSelectedSession(null); setEvents({}); setPage(null); setError(''); setHasMore(false)
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
    setSelectedSession((previous) => previous?.sessionId === id && sameRoot(root, previous.projectRoot) ? previous : null)
    setPage(id ? scope.pages.get(id) ?? null : null)
    setSelectionResolved(false)
    setSelectionLoading(!!id)
    if (!id || !hasIpc || !api.acpHistorySession || !isCurrent()) { setSelectionLoading(false); setSelectionResolved(true); return }
    void (async () => {
      // Serialize selection requests: never hydrate two large image pages concurrently.
      const summaryRevision = scope.managementRevision
      const summary = await api.acpHistorySession(id)
      if (!isCurrent() || selection.current !== id || serial !== scope.selectionSerial) return
      if (summary.ok) setSelectedSession(remember([summary.session], summaryRevision)[0] ?? null)
      else { setError(summary.error); return }
      const pageRevision = scope.managementRevision
      const result = await hydratePage(id, {}, () => isCurrent() && selection.current === id && serial === scope.selectionSerial)
      if (!isCurrent() || selection.current !== id || serial !== scope.selectionSerial) return
      if (!result) return
      if (!result.ok) { setError(result.error); return }
      const previous = scope.pages.get(id)
      const combined = previous?.hasEarlier === false ? { ...result, beforeCursor: null, hasEarlier: false } : previous ? { ...result, beforeCursor: previous.beforeCursor, hasEarlier: previous.hasEarlier, startsMidTurn: previous.startsMidTurn } : result
      scope.pages.set(id, combined); setPage(combined); setSelectedSession(remember([result.session], pageRevision)[0] ?? null)
      setEvents((currentEvents) => ({ ...currentEvents, [id]: merge(currentEvents[id] ?? [], result.events) }))
    })().catch((reason) => { if (isCurrent() && selection.current === id && serial === scope.selectionSerial) setError(String(reason)) })
      .finally(() => { if (isCurrent() && selection.current === id && serial === scope.selectionSerial) { setSelectionLoading(false); setSelectionResolved(true) } })
  }, [root, activeId, scope, isCurrent, hydratePage, selectionRevision, remember])
  useEffect(() => {
    if (!hasIpc || !api.acpHistoryList || !root) return
    let pending: ReturnType<typeof setTimeout> | undefined
    const statuses = new Map<string, string>()
    const schedule = (): void => { if (pending) clearTimeout(pending); pending = setTimeout(() => { pending = undefined; void refresh() }, 200) }
    const offState = api.onAcpState((state) => {
      if (!isCurrent() || !sameRoot(root, state.projectRoot)) return
      if (statuses.get(state.sessionId) !== state.status) { statuses.set(state.sessionId, state.status); schedule() }
      if (selection.current === state.sessionId && state.session) setSelectedSession((previous) => previous ? { ...previous, ...state.session, ...conversationManagement(scope.managed.get(state.sessionId)?.session ?? previous), pendingPermissions: state.pendingPermissions ?? state.session?.pendingPermissions ?? [], stateRevision: state.stateRevision ?? previous.stateRevision } : previous)
    })
    const offDone = api.onAcpDone((state) => { if (isCurrent() && (!state.projectRoot || sameRoot(root, state.projectRoot))) schedule() })
    const bridge = api as typeof api & { onDaemonRuntimeReset?: (callback: (event: { projectRoot: string }) => void) => () => void }
    const offReset = bridge.onDaemonRuntimeReset?.(event => { if (isCurrent() && sameRoot(root, event.projectRoot)) { schedule(); reloadSelected() } })
    return () => { offState(); offDone(); offReset?.(); if (pending) clearTimeout(pending) }
  }, [root, scope, isCurrent, refresh, reloadSelected])
  const coverage: AcpHistoryCoverage | null = page?.coverage ?? selectedSession?.historyCoverage ?? null
  return { sessions, knownSessions, selectedSession, events, query, setQuery, archive, setArchive, update, mutationBusy, mutationErrors,
    canManage: hasIpc && typeof api.acpHistoryUpdate === 'function', loading, loadingMore, loadingEarlier, error, hasMore,
    hasEarlier: page?.hasEarlier ?? false, coverage, startsMidTurn: page?.startsMidTurn ?? false, refresh, loadMore, loadEarlier,
    selectionLoading: !!activeId && (selectionKey !== requestedSelectionKey || selectionLoading),
    selectionResolved: selectionKey === requestedSelectionKey && selectionResolved, reloadSelected }
}
