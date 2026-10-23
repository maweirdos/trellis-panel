import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { api } from '../../../api'
import { useApp } from '../../../store'
import { projectRootKey } from '../../navigation'
import type { IntegrationResult, IntegrationSnapshot } from '../../../../../shared/integrations'
import { integrationBridgeMessage, integrationBridgeState, missingIntegrationHandler } from './bridge'
import { useInteractionGuard, useInteractionSignal } from '../../../utils/interaction-scope'
import type { IntegrationResource } from './IntegrationSections'

/** UI liveness only; never cancels admitted commands or native permission requests. */
export function useIntegrationOwner(key = '') {
  const root = useApp((state) => state.snapshot?.meta.root ?? null)
  const signal = useInteractionSignal()
  const canInteract = useInteractionGuard()
  const [generation, setGeneration] = useState(0)
  const owner = useMemo(() => ({ live: true, invalidated: false }), [root, key, signal, generation])
  const latest = useRef(owner)
  latest.current = owner
  useLayoutEffect(() => {
    owner.live = true
    const unsubscribe = useApp.subscribe((state, previous) => {
      if (projectRootKey(state.snapshot?.meta.root) !== projectRootKey(previous.snapshot?.meta.root) || state.page !== previous.page) {
        owner.invalidated = true
        setGeneration((value) => value + 1)
      }
    })
    return () => { owner.live = false; unsubscribe() }
  }, [owner])
  const current = useCallback(() => owner.live && !owner.invalidated && latest.current === owner && canInteract() && !signal?.aborted && projectRootKey(useApp.getState().snapshot?.meta.root) === projectRootKey(root), [owner, root, signal, canInteract])
  return { root, current }
}

/** Only transient reads receive this signal. Jobs use explicit native commands. */
export function useIntegrationRead<T>(key: string, load: (signal: AbortSignal) => Promise<IntegrationResource<T>>) {
  const { current } = useIntegrationOwner(key)
  const scopeSignal = useInteractionSignal()
  const [state, setState] = useState<{ owner: () => boolean; resource: IntegrationResource<T> }>(() => ({ owner: current, resource: { state: 'loading' } }))
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!current()) return
    const controller = new AbortController()
    const cancel = (): void => controller.abort()
    scopeSignal?.addEventListener('abort', cancel, { once: true })
    setState({ owner: current, resource: { state: 'loading' } })
    void (async () => {
      try {
        const result = await load(controller.signal)
        if (current() && !controller.signal.aborted) setState({ owner: current, resource: result })
      } catch {
        if (current() && !controller.signal.aborted) setState({ owner: current, resource: { state: 'error', detail: '读取失败，请重试。' } })
      }
    })()
    return () => { scopeSignal?.removeEventListener('abort', cancel); controller.abort() }
  }, [key, load, current, scopeSignal, revision])
  const resource: IntegrationResource<T> = state.owner === current && current() ? state.resource : { state: 'loading' }
  return { resource, refresh: useCallback(() => setRevision((value) => value + 1), []) }
}

export function useAlive(): MutableRefObject<boolean> {
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  return alive
}
export function useIntegrationSnapshot() {
  const { root, current } = useIntegrationOwner()
  const [data, setData] = useState<IntegrationSnapshot | null>(null)
  const dataOwner = useRef<(() => boolean) | null>(null)
  const [error, setError] = useState('')
  const errorOwner = useRef<(() => boolean) | null>(null)
  const [loading, setLoading] = useState(false)
  const [mainOutdated, setMainOutdated] = useState(false)
  const sequence = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    if (!current()) return
    const token = ++sequence.current
    const bridge = integrationBridgeState()
    if (bridge !== 'ready') { errorOwner.current = current; setError(integrationBridgeMessage(bridge)); setLoading(false); return }
    setLoading(true)
    try {
      const result = await api.integrations.list()
      if (token !== sequence.current || !current()) return
      errorOwner.current = current
      setMainOutdated(false)
      if (result.ok) { dataOwner.current = current; setData(result.data); setError('') } else setError(result.error)
    } catch (error) {
      if (token === sequence.current && current()) {
        errorOwner.current = current
        const outdated = missingIntegrationHandler(error)
        setMainOutdated(outdated)
        setError(outdated ? '窗口已加载新接口，但主进程仍是旧版本。请完整退出并重新打开桌面应用；刷新页面不能加载新主进程。' : '无法读取集成配置，请重新打开此页面')
      }
    }
    finally { if (token === sequence.current && current()) setLoading(false) }
  }, [current])
  useEffect(() => { setData(null); void refresh(); return () => { sequence.current++ } }, [refresh])
  useEffect(() => {
    if (integrationBridgeState() !== 'ready') return
    return api.integrations.onChanged(() => { void refresh() })
  }, [refresh])
  const visibleData = dataOwner.current === current && current() && projectRootKey(data?.root) === projectRootKey(root) ? data : null
  const ownsError = errorOwner.current === current
  return { root, data: visibleData, error: ownsError ? error : '', loading, mainOutdated: ownsError && mainOutdated, refresh }
}
export function useIntegrationAction(ownerKey = '') {
  const alive = useAlive()
  const { current } = useIntegrationOwner(ownerKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = useRef<object | null>(null)
  useEffect(() => { running.current = null; setBusy(false); setError('') }, [current])
  const run = async <T,>(action: () => Promise<IntegrationResult<T>>): Promise<T | undefined> => {
    if (running.current || !current()) return undefined
    const ticket = {}
    running.current = ticket; setBusy(true); setError('')
    try {
      const result = await action()
      if (!alive.current || !current() || running.current !== ticket) return undefined
      if (!result.ok) { setError(result.error); return undefined }
      return result.data
    } catch (error) { if (alive.current && current() && running.current === ticket) setError(missingIntegrationHandler(error) ? '当前主进程尚未加载集成服务，请完整退出并重新打开应用后保存连接。' : '操作未完成，请刷新后核实结果') }
    finally { if (running.current === ticket) { running.current = null; if (alive.current && current()) setBusy(false) } }
    return undefined
  }
  return { busy, error, run, setError, current }
}
