import { useLayoutEffect, useRef, useState } from 'react'
import { useHifox } from '../store'
import { useInteractionGuard } from '../../utils/interaction-scope'
import { cockpitActor } from './model'

function identity(state: ReturnType<typeof useHifox.getState>, spaceScoped: boolean): string {
  const context = state.workspaceContext
  return JSON.stringify([context.key, context.instanceId, context.epoch, context.actorId,
    state.snapshot ? cockpitActor(state.snapshot, context) : null, Boolean(state.snapshot),
    context.state === 'access-revoked', state.module, spaceScoped ? state.currentSpaceId : null])
}

export function useCockpitGeneration(spaceScoped: boolean): number {
  const [generation, setGeneration] = useState(0)
  useLayoutEffect(() => useHifox.subscribe((next, previous) => {
    if (identity(next, spaceScoped) !== identity(previous, spaceScoped)) setGeneration((value) => value + 1)
  }), [spaceScoped])
  return generation
}

/** A source transition permanently invalidates retained callbacks, including batched A → B → A. */
export function useCockpitOwner(spaceScoped: boolean): () => boolean {
  const [origin] = useState(() => identity(useHifox.getState(), spaceScoped))
  const owner = useRef({ mounted: false, invalidated: false })
  const canInteract = useInteractionGuard()
  useLayoutEffect(() => {
    owner.current.mounted = true
    const inspect = (): void => { if (identity(useHifox.getState(), spaceScoped) !== origin) owner.current.invalidated = true }
    inspect()
    const unsubscribe = useHifox.subscribe(inspect)
    return () => { owner.current.mounted = false; unsubscribe() }
  }, [origin, spaceScoped])
  return () => owner.current.mounted && !owner.current.invalidated && canInteract() && identity(useHifox.getState(), spaceScoped) === origin
}
