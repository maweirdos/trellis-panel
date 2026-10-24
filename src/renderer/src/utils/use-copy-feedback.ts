import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from './interaction-scope'

type CopyStatus = 'idle' | 'copying' | 'copied' | 'error'
const COPY_FEEDBACK_MS = 2500

/** Pass a stable identity for the displayed source; leaving it revokes local feedback, not the OS write. */
export function useCopyFeedback(ownerKey: unknown): { status: CopyStatus; copy: (text: string) => Promise<void> } {
  const active = useInteractionActive()
  const signal = useInteractionSignal()
  const canInteract = useInteractionGuard()
  const [status, setStatus] = useState<CopyStatus>('idle')
  const generation = useRef(0)
  const mounted = useRef(false)
  const pending = useRef(false)
  const timer = useRef<number | null>(null)

  const clearTimer = useCallback((): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }, [])

  useLayoutEffect(() => {
    mounted.current = true
    const invalidate = (): void => {
      generation.current++
      pending.current = false
      clearTimer()
      setStatus('idle')
    }
    invalidate()
    signal?.addEventListener('abort', invalidate, { once: true })
    return () => {
      mounted.current = false
      generation.current++
      pending.current = false
      clearTimer()
      signal?.removeEventListener('abort', invalidate)
    }
  }, [ownerKey, active, signal, clearTimer])

  const copy = useCallback(async (text: string): Promise<void> => {
    if (!mounted.current || !canInteract() || pending.current) return
    const ticket = ++generation.current
    const isCurrent = (): boolean => mounted.current && generation.current === ticket && canInteract() && !signal?.aborted
    pending.current = true
    clearTimer()
    setStatus('copying')
    try {
      if (typeof api?.copyToClipboard === 'function') await api.copyToClipboard(text)
      else await navigator.clipboard.writeText(text)
      if (!isCurrent()) return
      pending.current = false
      setStatus('copied')
      timer.current = window.setTimeout(() => {
        timer.current = null
        if (isCurrent()) setStatus('idle')
      }, COPY_FEEDBACK_MS)
    } catch {
      if (!isCurrent()) return
      pending.current = false
      setStatus('error')
    }
  }, [ownerKey, signal, canInteract, clearTimer])

  return { status, copy }
}
