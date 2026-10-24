import { useEffect, useRef } from 'react'
import { confirmDialog, type ConfirmDialogOptions } from '../../../../../components/Dialogs'
import { useInteractionSignal } from '../../../../../utils/interaction-scope'

/** A dialog/source replacement also retires its imperative confirmation. */
export function useJiraConfirmation(owner: string): (options: ConfirmDialogOptions) => Promise<boolean> {
  const signal = useInteractionSignal()
  const pending = useRef(new Set<AbortController>())
  useEffect(() => () => { for (const controller of pending.current) controller.abort(); pending.current.clear() }, [owner, signal])
  return async (options) => {
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    pending.current.add(controller)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    try { return await confirmDialog(options, controller.signal) }
    finally { signal?.removeEventListener('abort', abort); pending.current.delete(controller) }
  }
}
