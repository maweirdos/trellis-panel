import { useLayoutEffect, useRef, useState } from 'react'
import { useCrux } from '../store'
import { useInteractionGuard } from '../../utils/interaction-scope'
import { cockpitActor } from './model'

function identity(state: ReturnType<typeof useCrux.getState>, spaceScoped: boolean): string {
  const context = state.workspaceContext
  return JSON.stringify([context.key, context.instanceId, context.epoch, context.actorId,
    state.snapshot ? cockpitActor(state.snapshot, context) : null, Boolean(state.snapshot),
    context.state === 'access-revoked', state.module, spaceScoped ? state.currentSpaceId : null])
}

export function useCockpitGeneration(spaceScoped: boolean): number {
  const [generation, setGeneration] = useState(0)
  useLayoutEffect(() => useCrux.subscribe((next, previous) => {
    if (identity(next, spaceScoped) !== identity(previous, spaceScoped)) setGeneration((value) => value + 1)
  }), [spaceScoped])
  return generation
}

/** A source transition permanently invalidates retained callbacks, including batched A → B → A. */
export function useCockpitOwner(spaceScoped: boolean): () => boolean {
  const [origin] = useState(() => identity(useCrux.getState(), spaceScoped))
  const owner = useRef({ mounted: false, invalidated: false })
  const canInteract = useInteractionGuard()
  useLayoutEffect(() => {
    owner.current.mounted = true
    const inspect = (): void => { if (identity(useCrux.getState(), spaceScoped) !== origin) owner.current.invalidated = true }
    inspect()
    const unsubscribe = useCrux.subscribe(inspect)
    return () => { owner.current.mounted = false; unsubscribe() }
  }, [origin, spaceScoped])
  return () => owner.current.mounted && !owner.current.invalidated && canInteract() && identity(useCrux.getState(), spaceScoped) === origin
}
