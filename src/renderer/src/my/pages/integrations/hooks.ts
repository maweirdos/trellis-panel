import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { api } from '../../../api'
import { useApp } from '../../../store'
import { projectRootKey } from '../../navigation'
import type { IntegrationResult, IntegrationSnapshot } from '../../../../../shared/integrations'
import { integrationBridgeMessage, integrationBridgeState, missingIntegrationHandler } from './bridge'

export function useAlive(): MutableRefObject<boolean> {
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  return alive
}
export function useIntegrationSnapshot() {
  const root = useApp((s) => s.snapshot?.meta.root ?? null)
  const [data, setData] = useState<IntegrationSnapshot | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [mainOutdated, setMainOutdated] = useState(false)
  const sequence = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    const token = ++sequence.current
    const bridge = integrationBridgeState()
    if (bridge !== 'ready') { setError(integrationBridgeMessage(bridge)); setLoading(false); return }
    setLoading(true)
    try {
      const result = await api.integrations.list()
      if (token !== sequence.current || projectRootKey(useApp.getState().snapshot?.meta.root) !== projectRootKey(root)) return
      setMainOutdated(false)
      if (result.ok) { setData(result.data); setError('') } else setError(result.error)
    } catch (error) {
      if (token === sequence.current) {
        const outdated = missingIntegrationHandler(error)
        setMainOutdated(outdated)
        setError(outdated ? '窗口已加载新接口，但主进程仍是旧版本。请完整退出并重新打开桌面应用；刷新页面不能加载新主进程。' : '无法读取集成配置，请重新打开此页面')
      }
    }
    finally { if (token === sequence.current) setLoading(false) }
  }, [root])
  useEffect(() => { setData(null); void refresh(); return () => { sequence.current++ } }, [refresh])
  useEffect(() => {
    if (integrationBridgeState() !== 'ready') return
    return api.integrations.onChanged(() => { void refresh() })
  }, [refresh])
  return { root, data, error, loading, mainOutdated, refresh }
}
export function useIntegrationAction() {
  const alive = useAlive()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)
  const run = async <T,>(action: () => Promise<IntegrationResult<T>>): Promise<T | undefined> => {
    if (running.current) return undefined
    running.current = true; setBusy(true); setError('')
    try {
      const result = await action()
      if (!alive.current) return undefined
      if (!result.ok) { setError(result.error); return undefined }
      return result.data
    } catch (error) { if (alive.current) setError(missingIntegrationHandler(error) ? '当前主进程尚未加载集成服务，请完整退出并重新打开应用后保存连接。' : '操作未完成，请刷新后核实结果') }
    finally { running.current = false; if (alive.current) setBusy(false) }
    return undefined
  }
  return { busy, error, run, setError }
}
