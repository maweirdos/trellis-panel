import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, hasIpc } from '../api'
import { useApp } from '../store'
import { projectRootKey } from '../my/navigation'
import { applyConversationEventPage, type AcpConversationDetailSnapshot } from '@shared/acp-projections'

const DETAIL_CACHE_LIMIT = 24
const EVENT_REFRESH_PAGE_LIMIT = 100

function sameRoot(left: string, right: string): boolean {
  return projectRootKey(left) === projectRootKey(right)
}

export function useConversationProjection(root: string, activeId: string | null) {
  const [, notifySnapshotChange] = useState(0)
  const scope = useMemo(() => ({
    live: true,
    details: new Map<string, AcpConversationDetailSnapshot>(),
    loading: new Set<string>(),
    refreshing: new Set<string>(),
  }), [root])
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const isCurrent = useCallback((): boolean => {
    return scopeRef.current === scope && scope.live && sameRoot(useApp.getState().snapshot?.meta.root ?? '', root)
  }, [scope, root])

  const refreshDetail = useCallback(async (sessionId: string): Promise<void> => {
    if (!hasIpc || typeof api.acpConversationDetailSnapshot !== 'function' || !root || !isCurrent()) return
    if (scope.loading.has(sessionId)) return
    scope.loading.add(sessionId)
    notifySnapshotChange(value => value + 1)
    try {
      const result = await api.acpConversationDetailSnapshot(sessionId)
      if (!isCurrent()) return
      if (result.ok && sameRoot(root, result.conversation.root) && result.conversation.sourceSessionId === sessionId) {
        scope.details.delete(sessionId)
        scope.details.set(sessionId, result)
        if (scope.details.size > DETAIL_CACHE_LIMIT) {
          const oldest = scope.details.keys().next().value
          if (oldest !== undefined) scope.details.delete(oldest)
        }
      }
    } catch {
      return
    } finally {
      scope.loading.delete(sessionId)
      if (isCurrent()) notifySnapshotChange(value => value + 1)
    }
  }, [root, scope, isCurrent])

  const refreshEvents = useCallback(async (sessionId: string): Promise<void> => {
    if (!hasIpc || typeof api.acpConversationEvents !== 'function' || !root || !isCurrent()) return
    const cached = scope.details.get(sessionId)
    if (!cached || scope.refreshing.has(sessionId)) return
    scope.refreshing.add(sessionId)
    scope.details.delete(sessionId)
    scope.details.set(sessionId, cached)
    try {
      let current = cached
      for (;;) {
        const result = await api.acpConversationEvents(sessionId, { after: current.snapshotSequence, limit: EVENT_REFRESH_PAGE_LIMIT })
        if (!isCurrent() || scope.details.get(sessionId) !== current) return
        if (!result.ok) {
          if ('resetRequired' in result || ('code' in result && result.code === 'E_CONFLICT')) {
            await refreshDetail(sessionId)
          }
          return
        }
        const next = applyConversationEventPage(current, result)
        if (next === undefined || (result.hasMore && result.nextCursor <= current.snapshotSequence)) return
        scope.details.set(sessionId, next)
        current = next
        if (!result.hasMore) return
      }
    } catch {
      return
    } finally {
      scope.refreshing.delete(sessionId)
      if (isCurrent()) notifySnapshotChange(value => value + 1)
    }
  }, [root, isCurrent, scope, refreshDetail])

  useEffect(() => {
    scope.live = true
    return () => { scope.live = false }
  }, [scope])

  useEffect(() => {
    if (!activeId) return
    if (scope.details.has(activeId)) void refreshEvents(activeId)
    else void refreshDetail(activeId)
  }, [activeId, scope, refreshEvents, refreshDetail])

  return {
    detail: activeId ? scope.details.get(activeId) ?? null : null,
    loading: activeId ? scope.loading.has(activeId) : false,
  }
}
