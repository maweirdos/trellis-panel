import { useCallback, useEffect, useRef } from 'react'
import type { JiraIntegrationApi } from '@shared/jira-integration'
import { useInteractionSignal } from '../../../../../utils/interaction-scope'

/** Cancels only this view's transient reads; admitted daemon jobs have separate explicit controls. */
export function useJiraReads(api: JiraIntegrationApi, scope: { expectedRoot: string; workspaceId: string } | null) {
  const pending = useRef(new Map<string, { expectedRoot: string; workspaceId: string }>())
  const signal = useInteractionSignal()
  useEffect(() => {
    const cancel = (): void => { for (const [requestId, owner] of pending.current) void api.cancelRead({ ...owner, requestId }).catch(() => undefined); pending.current.clear() }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    return () => { signal?.removeEventListener('abort', cancel); cancel() }
  }, [api, scope?.expectedRoot, scope?.workspaceId, signal])
  return useCallback(async <T,>(read: (requestId: string) => Promise<T>): Promise<T> => {
    if (!scope) throw new Error('Jira read has no captured workspace')
    signal?.throwIfAborted()
    const requestId = crypto.randomUUID(); pending.current.set(requestId, scope)
    try { return await read(requestId) } finally { pending.current.delete(requestId) }
  }, [api, scope?.expectedRoot, scope?.workspaceId, signal])
}
