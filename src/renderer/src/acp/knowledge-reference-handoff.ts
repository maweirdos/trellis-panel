import { create } from 'zustand'
import { projectRootKey } from '../my/navigation'
import { useApp } from '../store'
import type { KnowledgeSource } from '../../../shared/knowledge-access'
import type { ConversationKnowledgeReference } from '../../../shared/conversation/knowledge-reference'

interface Handoff { id: string; root: string; title: string; knowledge: ConversationKnowledgeReference }
interface HandoffState { pending: Handoff | null; clear: (id: string) => void }
export const useKnowledgeReferenceHandoff = create<HandoffState>((set, get) => ({
  pending: null,
  clear: (id) => { if (get().pending?.id === id) set({ pending: null }) }
}))
useApp.subscribe((state, previous) => {
  if (projectRootKey(state.snapshot?.meta.root) !== projectRootKey(previous.snapshot?.meta.root)) {
    const pending = useKnowledgeReferenceHandoff.getState().pending
    if (pending) useKnowledgeReferenceHandoff.getState().clear(pending.id)
  }
})

/** Stage one observed knowledge snapshot without selecting a conversation or sending. */
export function stageKnowledgeReferenceHandoff(input: ({ root: string; source: KnowledgeSource } | { root: string; document: { title: string; relativePath: string; displayedRevision: string } }) & { selectionToken?: string; projectGeneration?: number }): boolean {
  if (!input.root || projectRootKey(input.root) !== projectRootKey(useApp.getState().snapshot?.meta.root) || useKnowledgeReferenceHandoff.getState().pending || !input.selectionToken || !/^[a-f0-9]{64}$/.test(input.selectionToken) || !Number.isInteger(input.projectGeneration) || input.projectGeneration === undefined || input.projectGeneration < 0) return false
  let title: string
  let reference: ConversationKnowledgeReference['reference']
  if ('source' in input) {
    if (!input.source.id || !input.source.sourceHandle || !input.source.contentHash) return false
    title = input.source.title
    reference = { kind: 'source', sourceId: input.source.id, contentHash: input.source.contentHash }
  } else {
    const { title: name, relativePath, displayedRevision } = input.document
    if (!name || !relativePath || !/^[a-f0-9]{16}$/.test(displayedRevision)) return false
    title = name
    reference = { kind: 'project', relativePath, displayedRevision }
  }
  useKnowledgeReferenceHandoff.setState({ pending: { id: crypto.randomUUID(), root: input.root, title,
    knowledge: { reference, selectionToken: input.selectionToken, projectGeneration: input.projectGeneration },
  } })
  return true
}
