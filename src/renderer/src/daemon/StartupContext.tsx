import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react'

/** Renderer presentation only; this never grants native readiness/attachment. */
export interface StartupContentSlot { commits: Set<symbol> }
export interface StartupPresentation {
  initialTheme: 'light' | 'dark'
  register(slot: StartupContentSlot): () => void
  changed(): void
}

export const StartupContext = createContext<StartupPresentation | null>(null)
const ContentSlotContext = createContext<StartupContentSlot | null>(null)

/** Register visible content even while its Suspense primary branch is pending.
 * Changing identity replaces the receipt without remounting retained pages. */
export function StartupContentRegion({ identity, active = true, children }: {
  identity: string; active?: boolean; children: ReactNode
}): JSX.Element {
  const startup = useContext(StartupContext)
  const slot = useMemo<StartupContentSlot>(() => ({ commits: new Set() }), [identity])
  useLayoutEffect(() => {
    if (!active) return
    return startup?.register(slot)
  }, [startup, slot, active])
  return <ContentSlotContext.Provider value={slot}>{children}</ContentSlotContext.Provider>
}

/** Put only inside a real Suspense primary branch or terminal error fallback.
 * Suspense hiding, route replacement and unmount revoke its pending frames. */
export function StartupContentCommit({ active = true }: { active?: boolean }): null {
  const startup = useContext(StartupContext)
  const region = useContext(ContentSlotContext)
  const ownSlot = useMemo<StartupContentSlot>(() => ({ commits: new Set() }), [])
  const receipt = useMemo(() => Symbol('startup-content'), [])
  const slot = region ?? ownSlot
  useLayoutEffect(() => {
    if (!startup || !active) return
    slot.commits.add(receipt)
    const unregister = region ? undefined : startup.register(slot)
    startup.changed()
    return () => {
      slot.commits.delete(receipt)
      unregister?.()
      startup.changed()
    }
  }, [startup, region, slot, receipt, active])
  return null
}
