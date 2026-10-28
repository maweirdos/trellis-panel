import { create } from 'zustand'
import { useApp } from '../store'
import { projectRootKey } from '../my/navigation'

interface KnowledgeDiscussionState {
  root: string | null
  open: boolean
  show: (expectedRoot: string) => boolean
  hide: () => void
  reset: () => void
}

/** Presentation intent only: never creates a session, stages text, or sends. */
export const useKnowledgeDiscussion = create<KnowledgeDiscussionState>((set) => ({
  root: null,
  open: false,
  show: (expectedRoot) => {
    const app = useApp.getState(), root = projectRootKey(expectedRoot)
    if (!root || app.page !== 'knowledge' || root !== projectRootKey(app.snapshot?.meta.root)) return false
    set({ root, open: true })
    return true
  },
  hide: () => set({ open: false }),
  reset: () => set({ root: null, open: false })
}))
