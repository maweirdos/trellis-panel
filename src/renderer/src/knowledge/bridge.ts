import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, hasIpc } from '../api'
import { useApp } from '../store'
import { projectRootKey } from '../my/navigation'
import type { KnowledgeApi, KnowledgeContext, KnowledgeResult, KnowledgeStatus } from '../../../shared/knowledge-access'

const scopeListeners = new Set<(root: string, sessionId?: string) => void>()
export function notifyKnowledgeScope(root: string, sessionId?: string): void { for (const listener of scopeListeners) listener(root, sessionId) }
export function onKnowledgeScope(listener: (root: string, sessionId?: string) => void): () => void { scopeListeners.add(listener); return () => { scopeListeners.delete(listener) } }

function hasMethods<K extends keyof KnowledgeApi>(candidate: Partial<KnowledgeApi>, methods: readonly K[]): candidate is Pick<KnowledgeApi, K> {
  return methods.every((method) => typeof candidate[method] === 'function')
}

export function knowledgeBridge(): Pick<KnowledgeApi, 'context'> | null
export function knowledgeBridge<K extends keyof KnowledgeApi>(methods: readonly K[]): Pick<KnowledgeApi, K> | null
export function knowledgeBridge(methods: readonly (keyof KnowledgeApi)[] = ['context']): Partial<KnowledgeApi> | null {
  const candidate = hasIpc ? (api as typeof api & { knowledgeAccess?: Partial<KnowledgeApi> }).knowledgeAccess : undefined
  return candidate && hasMethods(candidate, methods) ? candidate : null
}

export const knowledgeUnavailableFor = (feature: string): string => `${feature}尚未加载，请完整退出并重新打开桌面应用。`
export const knowledgeUnavailable = knowledgeUnavailableFor('项目知识服务')
export const knowledgeStatusLabel: Record<KnowledgeStatus, string> = { ok: '可用', empty: '无命中', partial: '部分结果', not_configured: '未配置', denied: '访问被拒绝', unavailable: '服务不可用', cancelled: '已取消' }
export function knowledgeError(error: unknown, feature = '此项知识功能'): string {
  const message = error instanceof Error ? error.message : '请求未完成，请刷新后核实状态'
  return /No handler registered|not a function|knowledgeAccess/i.test(message) ? knowledgeUnavailableFor(feature) : message
}
export function requireKnowledge<T>(result: KnowledgeResult<T>): T {
  if (!result.ok) throw new Error(`${result.error}${result.code ? ` (${result.code})` : ''}`)
  return result.data
}

/** A synchronous root transition invalidates even a batched A -> B -> A response. */
export function useKnowledgeOwner(root: string, sessionId?: string) {
  const [epoch, setEpoch] = useState(0)
  const owner = useMemo(() => ({ live: true, invalidated: false }), [root, sessionId, epoch])
  const currentOwner = useRef(owner)
  currentOwner.current = owner
  useEffect(() => {
    owner.live = true
    const unsubscribe = useApp.subscribe((state, previous) => {
      if (projectRootKey(state.snapshot?.meta.root) !== projectRootKey(previous.snapshot?.meta.root)) { owner.invalidated = true; setEpoch((value) => value + 1) }
    })
    return () => { owner.live = false; unsubscribe() }
  }, [owner])
  const current = useCallback(() => owner.live && !owner.invalidated && currentOwner.current === owner && projectRootKey(useApp.getState().snapshot?.meta.root) === projectRootKey(root), [owner, root])
  return { current, input: useMemo(() => ({ expectedRoot: root, ...(sessionId ? { sessionId } : {}) }), [root, sessionId]) }
}

export function useProjectKnowledge(root: string, sessionId?: string) {
  const { current, input } = useKnowledgeOwner(root, sessionId)
  const [context, setContext] = useState<KnowledgeContext | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const sequence = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    const token = ++sequence.current
    if (!root || !current()) return
    const bridge = knowledgeBridge(['context'])
    if (!bridge) { setContext(null); setError(knowledgeUnavailable); return }
    setLoading(true)
    try {
      const result = requireKnowledge(await bridge.context(input))
      if (!current() || token !== sequence.current) return
      setContext(result); setError('')
    } catch (failure) {
      if (current() && token === sequence.current) { setContext(null); setError(knowledgeError(failure)) }
    } finally { if (current() && token === sequence.current) setLoading(false) }
  }, [root, current, input])
  useEffect(() => { setContext(null); setError(''); void refresh(); return () => { sequence.current++ } }, [refresh])
  useEffect(() => {
    if (typeof api?.integrations?.onChanged !== 'function') return
    return api.integrations.onChanged(() => { void refresh() })
  }, [refresh])
  useEffect(() => onKnowledgeScope((changedRoot, changedSession) => {
    if (projectRootKey(changedRoot) === projectRootKey(root) && changedSession === sessionId) void refresh()
  }), [root, sessionId, refresh])
  return { context, error, loading, refresh, current, input }
}
