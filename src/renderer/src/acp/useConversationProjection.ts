import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, hasIpc } from '../api'
import { useApp } from '../store'
import { projectRootKey } from '../my/navigation'
import type { IpcFail } from '../../../shared/ipc-errors'
import type {
  AcpConversationDetailSnapshot,
  AcpConversationListSnapshot,
} from '../../../shared/acp-projections'

const DETAIL_CACHE_LIMIT = 24
const EVENT_REFRESH_PAGE_LIMIT = 100

type ProjectionSnapshot = {
  details: Map<string, AcpConversationDetailSnapshot>
  loading: Set<string>
  errors: Map<string, string>
  root: string
}

function isIpcFail(value: unknown): value is IpcFail {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false
}

function sameRoot(left: string, right: string): boolean {
  return projectRootKey(left) === projectRootKey(right)
}

/**
 * Root-scoped read model cache. Projection calls never enter runtime control paths.
 */
export function useConversationProjection(root: string, activeId: string | null) {
  const [snapshot] = useState<ProjectionSnapshot>(() => ({
    details: new Map<string, AcpConversationDetailSnapshot>(),
    loading: new Set<string>(),
    errors: new Map<string, string>(),
    root: '',
  }))
  const [version, notifySnapshotChange] = useState(0)
  const scope = useMemo(() => ({ root, live: true }), [root])
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const isCurrent = useCallback((): boolean => {
    return scopeRef.current === scope && scope.live && sameRoot(useApp.getState().snapshot?.meta.root ?? '', root)
  }, [scope, root])

  const refreshList = useCallback(async (): Promise<AcpConversationListSnapshot | null> => {
    if (!hasIpc || typeof api.acpConversationListSnapshot !== 'function' || !root || !isCurrent()) return null
    const result = await api.acpConversationListSnapshot()
    if (!isCurrent() || !result.ok) return null
    return result
  }, [root, isCurrent])

  const refreshDetail = useCallback(async (sessionId: string): Promise<void> => {
    if (!hasIpc || typeof api.acpConversationDetailSnapshot !== 'function' || !root || !isCurrent()) return
    if (snapshot.loading.has(sessionId)) return
    snapshot.loading.add(sessionId); snapshot.errors.delete(sessionId)
    notifySnapshotChange(value => value + 1)
    try {
      const result = await api.acpConversationDetailSnapshot(sessionId)
      if (!isCurrent()) return
      if (result.ok && sameRoot(root, result.conversation.root) && result.conversation.sourceSessionId === sessionId) {
        snapshot.details.set(sessionId, result)
        while (snapshot.details.size > DETAIL_CACHE_LIMIT) {
          const oldest = [...snapshot.details.keys()].find(key => key !== sessionId)
          if (!oldest) break
          snapshot.details.delete(oldest)
        }
      } else if (isIpcFail(result)) {
        snapshot.errors.set(sessionId, result.error)
      } else {
        snapshot.errors.set(sessionId, '投影会话不匹配，请重试。')
      }
    } catch (error) {
      if (isCurrent()) snapshot.errors.set(sessionId, error instanceof Error ? error.message : '会话投影读取失败。')
    } finally {
      snapshot.loading.delete(sessionId)
      if (isCurrent()) notifySnapshotChange(value => value + 1)
    }
  }, [root, scope, isCurrent, snapshot])

  const refreshEvents = useCallback(async (sessionId: string): Promise<void> => {
    if (!hasIpc || typeof api.acpConversationEvents !== 'function' || !root || !isCurrent()) return
    const cached = snapshot.details.get(sessionId)
    if (!cached) return
    try {
      let after = cached.snapshotSequence
      let readComplete = false
      while (!readComplete) {
        const result = await api.acpConversationEvents(sessionId, { after, limit: EVENT_REFRESH_PAGE_LIMIT })
        if (!isCurrent()) return
        if (!result.ok) {
          await refreshDetail(sessionId)
          return
        }
        if (result.hasMore && result.nextCursor === after) {
          snapshot.errors.set(sessionId, '事件分页游标没有前进，已停止刷新。')
          return
        }
        after = result.nextCursor
        readComplete = !result.hasMore
      }
      await refreshDetail(sessionId)
    } catch {
      await refreshDetail(sessionId)
    }
  }, [root, isCurrent, snapshot, refreshDetail])

  useEffect(() => {
    scope.live = true
    return () => { scope.live = false }
  }, [scope])

  useEffect(() => {
    if (projectRootKey(snapshot.root) === projectRootKey(scope.root)) return
    snapshot.root = scope.root
    snapshot.details.clear(); snapshot.loading.clear(); snapshot.errors.clear()
    notifySnapshotChange(value => value + 1)
  }, [scope, snapshot])

  useEffect(() => {
    if (!activeId) return
    if (snapshot.details.has(activeId)) void refreshEvents(activeId)
    else void refreshDetail(activeId)
  }, [activeId, snapshot, refreshEvents, refreshDetail])

  return {
    details: snapshot.details,
    version,
    detail: activeId ? snapshot.details.get(activeId) ?? null : null,
    loading: activeId ? snapshot.loading.has(activeId) : false,
    error: activeId ? snapshot.errors.get(activeId) ?? '' : '',
    refreshList,
    refreshDetail,
  }
}
