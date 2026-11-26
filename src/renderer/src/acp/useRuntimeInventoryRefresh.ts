import { useCallback, useEffect, useRef, useState } from 'react'
import { api, hasIpc } from '../api'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import type { AcpAgentStatus } from '../../../shared/types'

const INVENTORY_INTERVAL_MS = 30_000
const FOCUS_BURST_MS = 1_000
let inventorySnapshot: AcpAgentStatus[] = []
const inventoryListeners = new Set<(agents: AcpAgentStatus[]) => void>()

function emitInventorySnapshot(agents: AcpAgentStatus[]): void {
  inventorySnapshot = agents
  for (const listener of inventoryListeners) {
    try { listener(agents) } catch { /* 订阅方异常不影响其他监听者 */ }
  }
}

/** Last displayed local inventory; the visible panel still revalidates it on entry. */
export function getRuntimeInventorySnapshot(): AcpAgentStatus[] {
  return inventorySnapshot
}

export function subscribeRuntimeInventory(listener: (agents: AcpAgentStatus[]) => void): () => void {
  inventoryListeners.add(listener)
  return () => { inventoryListeners.delete(listener) }
}

/** Show discovery first, then verify installed engines without blocking the list. */
export function useRuntimeInventoryRefresh(options: {
  enabled: boolean
  paused: boolean
  agents: AcpAgentStatus[]
  isCurrent: () => boolean
  onChange: (agents: AcpAgentStatus[]) => void
  onVerified?: (agent: AcpAgentStatus) => void
}): { error: string | null; reading: boolean; checkingRuntimeId: string | null; invalidate: () => void; clearError: () => void } {
  const active = useInteractionActive()
  const canInteract = useInteractionGuard()
  const latest = useRef(options)
  latest.current = options
  const request = useRef({ pending: false, revision: 0, startedAt: Number.NEGATIVE_INFINITY })
  const wake = useRef<(() => void) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(options.enabled && hasIpc && active)
  const [checkingRuntimeId, setCheckingRuntimeId] = useState<string | null>(null)
  useEffect(() => {
    if (options.enabled) emitInventorySnapshot(options.agents)
    setError(null)
  }, [options.agents, options.enabled])
  const invalidate = useCallback(() => { request.current.revision++ }, [])

  useEffect(() => {
    invalidate()
    if (!options.paused) wake.current?.()
  }, [options.paused, invalidate])

  useEffect(() => {
    setCheckingRuntimeId(null)
    if (!hasIpc || !options.enabled || !active) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const clearTimer = (): void => { clearTimeout(timer); timer = undefined }
    const schedule = (delay = INVENTORY_INTERVAL_MS): void => {
      clearTimer()
      if (!disposed && document.visibilityState === 'visible' && canInteract()) timer = setTimeout(() => void read(), delay)
    }
    const read = async (): Promise<void> => {
      clearTimer()
      if (disposed || document.visibilityState !== 'visible' || !canInteract()) return
      if (latest.current.paused || !latest.current.isCurrent()) { schedule(); return }
      if (request.current.pending) return
      const sinceLastRead = Date.now() - request.current.startedAt
      if (sinceLastRead < FOCUS_BURST_MS) { schedule(FOCUS_BURST_MS - sinceLastRead); return }
      const revision = request.current.revision
      const sources = new Set([latest.current.agents])
      const current = (): boolean => !disposed && revision === request.current.revision
        && document.visibilityState === 'visible' && canInteract() && !latest.current.paused
        && latest.current.isCurrent() && sources.has(latest.current.agents)
      const publish = (agents: AcpAgentStatus[]): void => {
        sources.add(agents)
        emitInventorySnapshot(agents)
        latest.current.onChange(agents)
      }
      request.current.pending = true
      request.current.startedAt = Date.now()
      setReading(true)
      try {
        const response = await api.acpAgents()
        if (!current()) return
        if (!response.ok || !response.agents) { setError(response.error ?? '引擎状态读取失败，请重新探测。'); return }
        let agents = response.agents
        publish(agents)
        setError(null)
        setReading(false)
        for (const candidate of response.agents) {
          if (!current()) return
          const agent = agents.find(item => item.id === candidate.id)
          if (!agent?.enabled || !agent.available || agent.setupRequired || agent.health !== 'not_checked'
            || !['managed', 'native', 'bundled'].includes(agent.launchKind ?? '')) continue
          const id = agent.runtimeId ?? agent.id
          setCheckingRuntimeId(id)
          const checked = await api.acpRuntimeTestConnection(id)
          if (!current()) return
          if (!checked.ok || !checked.agents) { setError(`${agent.name}：${checked.error ?? '连接检测未完成，请重试。'}`); return }
          agents = checked.agents
          publish(agents)
          const verified = agents.find(item => item.id === agent.id)
          if (checked.probe?.ok && verified?.enabled && verified.available && !verified.setupRequired && verified.health === 'ready') latest.current.onVerified?.(verified)
        }
      } catch (cause) {
        if (current()) setError(cause instanceof Error ? cause.message : '引擎状态读取失败，请重新探测。')
      } finally {
        request.current.pending = false
        if (!disposed) { setReading(false); setCheckingRuntimeId(null) }
        // A suspended/replaced scope waits for this read rather than starting an overlapping request.
        if (revision !== request.current.revision) wake.current?.()
        else schedule()
      }
    }
    const resume = (): void => { void read() }
    const visibility = (): void => {
      if (document.visibilityState === 'visible') resume()
      else { invalidate(); clearTimer() }
    }
    wake.current = resume
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', visibility)
    resume()
    return () => {
      disposed = true
      invalidate()
      clearTimer()
      if (wake.current === resume) wake.current = null
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [options.enabled, active, canInteract, invalidate])

  return { error, reading, checkingRuntimeId, invalidate, clearError: () => setError(null) }
}
