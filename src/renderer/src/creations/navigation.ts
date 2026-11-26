import { create } from 'zustand'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { useCrux } from '../crux/store'

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
  const context = useCrux.getState().workspaceContext
  if (context.key !== target.workspaceKey || context.actorId !== target.actorId || context.state === 'access-revoked') return
  useCreationNavigation.setState((state) => ({ target, sequence: state.sequence + 1 }))
  if (navigate) navigate(target)
  else if (target.scope === 'team') {
    if (target.spaceId && useCrux.getState().currentSpaceId !== target.spaceId) useCrux.getState().setCurrentSpace(target.spaceId)
    const inKnowledgeSpaceDocs = useApp.getState().page === 'knowledge' && useMy.getState().knowledgeView === 'team'
    if (!inKnowledgeSpaceDocs) {
      useCrux.getState().setModule('creations')
      useApp.getState().setPage('crux')
    }
  } else {
    const inKnowledgePersonal = useApp.getState().page === 'knowledge' && useMy.getState().knowledgeView === 'personal'
    if (!inKnowledgePersonal) useApp.getState().setPage('creations')
  }
}

export function clearCreationTarget(): void {
  useCreationNavigation.setState({ target: null })
}
