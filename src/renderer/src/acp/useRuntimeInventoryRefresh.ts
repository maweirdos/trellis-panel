import { useCallback, useEffect, useRef, useState } from 'react'
import { api, hasIpc } from '../api'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import type { AcpAgentStatus } from '../../../shared/types'

const INVENTORY_INTERVAL_MS = 30_000
const FOCUS_BURST_MS = 1_000

/** Read installation discovery only; connection tests and registry refreshes stay explicit. */
export function useRuntimeInventoryRefresh(options: {
  enabled: boolean
  paused: boolean
  agents: AcpAgentStatus[]
  isCurrent: () => boolean
  onChange: (agents: AcpAgentStatus[]) => void
}): { error: string | null; reading: boolean; invalidate: () => void; clearError: () => void } {
  const active = useInteractionActive()
  const canInteract = useInteractionGuard()
  const latest = useRef(options)
  latest.current = options
  const request = useRef({ pending: false, revision: 0, startedAt: Number.NEGATIVE_INFINITY })
  const wake = useRef<(() => void) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(options.enabled && hasIpc && active)
  useEffect(() => { setError(null) }, [options.agents])
  const invalidate = useCallback(() => { request.current.revision++ }, [])

  useEffect(invalidate, [options.paused, invalidate])

  useEffect(() => {
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
      const source = latest.current.agents
      const current = (): boolean => !disposed && revision === request.current.revision
        && document.visibilityState === 'visible' && canInteract() && !latest.current.paused
        && latest.current.isCurrent() && latest.current.agents === source
      request.current.pending = true
      request.current.startedAt = Date.now()
      setReading(true)
      try {
        const response = await api.acpAgents()
        if (!current()) return
        if (response.ok && response.agents) { latest.current.onChange(response.agents); setError(null) }
        else setError(response.error ?? '引擎状态读取失败，请重新探测。')
      } catch (cause) {
        if (current()) setError(cause instanceof Error ? cause.message : '引擎状态读取失败，请重新探测。')
      } finally {
        request.current.pending = false
        if (!disposed) setReading(false)
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

  return { error, reading, invalidate, clearError: () => setError(null) }
}
