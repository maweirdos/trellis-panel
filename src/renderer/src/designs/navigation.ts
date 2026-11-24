import { create } from 'zustand'
import { useApp } from '../store'
import { clearCreationTarget } from '../creations/navigation'

interface DesignNavigation {
  documentId: string | null
  versionRequest: { version: string; token: string } | null
}
export const useDesignNavigation = create<DesignNavigation>(() => ({ documentId: null, versionRequest: null }))
export function openDesign(documentId: string, candidateId?: string): void {
  clearCreationTarget()
  useDesignNavigation.setState({ documentId, versionRequest: {
    version: candidateId ? `candidate:${candidateId}` : 'current', token: crypto.randomUUID(),
  } })
  useApp.getState().setPage('creations')
}
export function closeDesign(): void { useDesignNavigation.setState({ documentId: null, versionRequest: null }) }
