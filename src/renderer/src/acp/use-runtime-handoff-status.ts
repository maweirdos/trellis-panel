import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { handoffRequest } from './runtime-handoff-state'
import type { AcpSessionRecord } from '../../../shared/types'
import type { AcpHandoffOperation } from '../../../shared/acp-handoff'

/** A target's delivery receipt alone cannot distinguish a retryable prompt from a cancelled handoff. */
export function useRuntimeHandoffStatus(root: string, session: AcpSessionRecord | null, enabled: boolean, isCurrent: () => boolean) {
  const signal = useInteractionSignal()
  const canInteract = useInteractionGuard()
  const sessionId = session?.sessionId
  const origin = session?.handoff
  const owner = useMemo(() => ({ root, sessionId, operationId: origin?.operationId, sourceId: origin?.sourceSessionId, signal, enabled }), [root, sessionId, origin?.operationId, origin?.sourceSessionId, signal, enabled])
  const latest = useRef({ owner, isCurrent })
  latest.current = { owner, isCurrent }
  const [result, setResult] = useState<{ owner: typeof owner; operation: AcpHandoffOperation | null; error: string; loading: boolean } | null>(null)
  const serial = useRef(0)
  const valid = useCallback(() => latest.current.owner === owner && owner.enabled && !owner.signal?.aborted && latest.current.isCurrent() && canInteract(), [owner, canInteract])
  const accept = useCallback((operation: AcpHandoffOperation): void => {
    if (!valid()) return
    if (operation.id !== owner.operationId || operation.sourceSessionId !== owner.sourceId || operation.targetSessionId !== owner.sessionId) throw Error('接续状态与当前对话不一致，请重新检查。')
    serial.current++
    setResult({ owner, operation, error: '', loading: false })
  }, [owner, valid])
  const refresh = useCallback(async (): Promise<void> => {
    if (!owner.operationId || !owner.sourceId || !valid()) return
    const ticket = ++serial.current
    setResult((old) => ({ owner, operation: old?.owner === owner ? old.operation : null, error: '', loading: true }))
    try {
      const response = await handoffRequest(api.acpSessionHandoffStatus(owner.sourceId, owner.operationId))
      if (!valid() || serial.current !== ticket) return
      if (!response.ok) throw Error(response.error)
      accept(response.operation)
    } catch (error) {
      if (valid() && serial.current === ticket) setResult({ owner, operation: null, error: error instanceof Error ? error.message : '接续状态暂不可读取，请重试。', loading: false })
    }
  }, [owner, valid, accept])
  useEffect(() => {
    if (origin?.delivery !== 'sent') void refresh()
    return () => { serial.current++ }
  }, [refresh, origin?.delivery, session?.stateRevision])
  const current = result?.owner === owner ? result : null
  const operation = current?.operation ?? null
  return { operation, loading: current?.loading ?? Boolean(origin && origin.delivery !== 'sent' && enabled), error: current?.error ?? '', refresh, accept,
    blocked: Boolean(origin && origin.delivery !== 'sent' && (!operation || !['ready', 'sent'].includes(operation.state))) }
}
