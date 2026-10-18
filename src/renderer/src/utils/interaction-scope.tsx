import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, type ReactNode, type JSX } from 'react'

interface InteractionState { active: boolean; signal?: AbortSignal }
const InteractionContext = createContext<InteractionState>({ active: true })

/** A retained source keeps data/watch ownership, but lends no interactive surfaces to its destination. */
export function InteractionScope({ active, children }: { active: boolean; children: ReactNode }): JSX.Element {
  const parent = useContext(InteractionContext)
  const enabled = parent.active && active
  const controller = useMemo(() => new AbortController(), [enabled, parent.signal])
  const mounted = useRef(false)
  const currentController = useRef(controller)
  currentController.current = controller
  useLayoutEffect(() => {
    mounted.current = true
    if (!enabled || parent.signal?.aborted) controller.abort()
    const abort = (): void => controller.abort()
    parent.signal?.addEventListener('abort', abort, { once: true })
    return () => {
      parent.signal?.removeEventListener('abort', abort)
      mounted.current = false
      // StrictMode replays effects on the same controller; only a real detach or
      // controller replacement aborts its outstanding source-owned dialogs.
      queueMicrotask(() => { if (!mounted.current || currentController.current !== controller) controller.abort() })
    }
  }, [enabled, controller, parent.signal])
  const value = useMemo(() => ({ active: enabled, signal: controller.signal }), [enabled, controller])
  return <InteractionContext.Provider value={value}>{children}</InteractionContext.Provider>
}

export function useInteractionActive(): boolean { return useContext(InteractionContext).active }
export function useInteractionSignal(): AbortSignal | undefined { return useContext(InteractionContext).signal }

/** Async completions/animation frames must check the current scope, not their original render. */
export function useInteractionGuard(): () => boolean {
  const state = useContext(InteractionContext)
  const current = useRef(state)
  current.current = state
  return useCallback(() => current.current.active && !current.current.signal?.aborted, [])
}
