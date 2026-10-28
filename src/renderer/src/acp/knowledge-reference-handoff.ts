import { create } from 'zustand'
import { projectRootKey } from '../my/navigation'
import { useApp } from '../store'
import type { KnowledgeSource } from '../../../shared/knowledge-access'

/** Metadata for an exact observed snapshot. Source text remains in the knowledge service. */
export type KnowledgeDraftReference = (Omit<KnowledgeSource, 'text'> | { kind: 'project'; id: string; title: string; relativePath: string; displayedRevision: string }) & { selectionToken?: string; projectGeneration?: number; targetSessionId?: string; connectionGeneration?: string }
export function knowledgeDraftReference(source: KnowledgeSource): KnowledgeDraftReference {
  const { text: _text, ...reference } = source
  return reference
}

interface Handoff { id: string; root: string; source: KnowledgeDraftReference; selectionToken: string; projectGeneration: number }
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
  let source: KnowledgeDraftReference
  if ('source' in input) {
    if (!input.source.id || !input.source.sourceHandle || !input.source.contentHash) return false
    source = knowledgeDraftReference(input.source)
  } else {
    const { title, relativePath, displayedRevision } = input.document
    if (!title || !relativePath || !/^[a-f0-9]{16}$/.test(displayedRevision)) return false
    source = { kind: 'project', id: `project:${relativePath}`, title, relativePath, displayedRevision }
  }
  useKnowledgeReferenceHandoff.setState({ pending: { id: crypto.randomUUID(), root: input.root, source, selectionToken: input.selectionToken, projectGeneration: input.projectGeneration } })
  return true
}

const drafts = new Map<string, KnowledgeDraftReference[]>()
function key(root: string, sessionId: string): string { return `${projectRootKey(root) ?? ''}\0${sessionId}` }
function storageKey(root: string, sessionId: string): string { return `tpanel.acp.knowledge-references.${encodeURIComponent(key(root, sessionId))}` }
export function readKnowledgeReferences(root: string, sessionId: string): KnowledgeDraftReference[] {
  const cacheKey = key(root, sessionId), cached = drafts.get(cacheKey)
  if (cached) return cached
  let references: KnowledgeDraftReference[] = []
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(root, sessionId)) ?? '[]')
    if (Array.isArray(stored)) references = stored.filter((value: unknown): value is KnowledgeDraftReference => {
      if (!value || typeof value !== 'object') return false
      const item = value as Partial<Omit<KnowledgeSource, 'text'>> & { displayedRevision?: unknown }
      if ((value as { kind?: unknown }).kind === 'project') return typeof item.id === 'string' && typeof item.title === 'string' && typeof item.relativePath === 'string' && typeof item.displayedRevision === 'string' && /^[a-f0-9]{16}$/.test(item.displayedRevision)
      return typeof item.id === 'string' && typeof item.sourceHandle === 'string' && typeof item.title === 'string' && typeof item.contentHash === 'string' && typeof item.sessionId === 'string' && typeof item.documentId === 'string' && typeof item.scopeRevision === 'string' && typeof item.fetchedAt === 'number' && (item.kind === 'local' || item.kind === 'weknora') && (item.mode === 'excerpt' || item.mode === 'full')
    }).slice(0, 4).map(({ text: _text, ...item }: KnowledgeDraftReference & { text?: unknown }) => item)
  } catch { /* Keep the current session usable when preferences are unavailable. */ }
  drafts.set(cacheKey, references)
  return references
}
export function writeKnowledgeReferences(root: string, sessionId: string, references: KnowledgeDraftReference[]): void {
  drafts.set(key(root, sessionId), references)
  try { localStorage.setItem(storageKey(root, sessionId), JSON.stringify(references)) } catch { /* Retain the draft in memory. */ }
}
export function forgetKnowledgeReferences(root: string, sessionId: string): void {
  drafts.delete(key(root, sessionId))
  try { localStorage.removeItem(storageKey(root, sessionId)) } catch { /* Ignore unavailable preferences. */ }
}
