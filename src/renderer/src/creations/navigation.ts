import { create } from 'zustand'
import { useApp } from '../store'
import { useHifox } from '../hifox/store'

export type CreationLocation = {
  workspaceKey: string
  actorId: string
  creationId: string
  revisionId?: string
  scope: 'personal' | 'team'
  spaceId?: string
}

interface CreationNavigation {
  target: CreationLocation | null
  sequence: number
}

export const useCreationNavigation = create<CreationNavigation>()(() => ({ target: null, sequence: 0 }))

let navigate: ((target: CreationLocation) => void) | null = null

/** A host can replace the desktop route without changing reference consumers. */
export function configureCreationNavigation(handler: (target: CreationLocation) => void): () => void {
  navigate = handler
  return () => { if (navigate === handler) navigate = null }
}

export function openCreation(target: CreationLocation): void {
  const context = useHifox.getState().workspaceContext
  if (context.key !== target.workspaceKey || context.actorId !== target.actorId || context.state === 'access-revoked') return
  useCreationNavigation.setState((state) => ({ target, sequence: state.sequence + 1 }))
  if (navigate) navigate(target)
  else if (target.scope === 'team') {
    if (target.spaceId && useHifox.getState().currentSpaceId !== target.spaceId) useHifox.getState().setCurrentSpace(target.spaceId)
    useHifox.getState().setModule('creations')
    useApp.getState().setPage('hifox')
  } else useApp.getState().setPage('creations')
}

export function clearCreationTarget(): void {
  useCreationNavigation.setState({ target: null })
}
