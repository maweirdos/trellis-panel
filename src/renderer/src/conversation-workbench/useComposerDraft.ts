import { useCallback, useSyncExternalStore } from 'react'
import { projectRootKey } from '../my/navigation'
import type { StagedConversationAttachment } from '../../../shared/conversation/attachments'
import type { ComposerDraft } from './useComposerSend'

export const CONVERSATION_TEXT_LIMIT = 120_000

const storagePrefix = 'crux.conversation-draft.v1:'
const maxStoredDrafts = 32
export interface ComposerReference {
  readonly id: string
  readonly label: string
  readonly text: string
}

export interface ComposerDraftContent {
  readonly text: string
  readonly attachments: readonly StagedConversationAttachment[]
  readonly references: readonly ComposerReference[]
}

export const emptyDraftContent: ComposerDraftContent = { text: '', attachments: [], references: [] }

export function hasComposerDraftContent(draft: ComposerDraftContent): boolean {
  return Boolean(draft.text || draft.attachments.length || draft.references.length)
}

const emptyDraft: ComposerDraft = { ...emptyDraftContent, draftId: null, state: { phase: 'idle' }, model: null, stash: null }
const entries = new Map<string, { serialized: string | null; draft: ComposerDraft; inMemory?: boolean }>()
const listeners = new Map<string, Set<() => void>>()

export function composerDraftKey(root: string, threadId: string | null, scopeKey?: string): string {
  return `${storagePrefix}${JSON.stringify([scopeKey ?? 'local', projectRootKey(root) ?? root, threadId])}`
}

function storageValue(key: string): string | null | undefined {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return undefined
  }
}

function readStoredDraft(serialized: string | null): ComposerDraft {
  if (!serialized) return emptyDraft
  try {
    const value = JSON.parse(serialized) as ComposerDraft
    if (typeof value.text !== 'string' || !value.state || !('model' in value) || !('stash' in value)) return emptyDraft
    const draft: ComposerDraft = {
      ...emptyDraft, ...value,
      stash: typeof value.stash === 'string' ? { ...emptyDraftContent, text: value.stash } : value.stash,
    }
    if (draft.state.phase === 'submitting') {
      const reason = '窗口关闭前未取得受理回执。'
      return { ...draft, state: { phase: 'unknown', submission: draft.state.submission, reason, checking: false } }
    }
    if (draft.state.phase === 'unknown' && draft.state.checking) {
      return { ...draft, state: { ...draft.state, checking: false } }
    }
    return draft
  } catch {
    return emptyDraft
  }
}

export function readComposerDraft(key: string): ComposerDraft {
  const cached = entries.get(key)
  if (cached) return cached.draft
  const serialized = storageValue(key) ?? null
  const draft = readStoredDraft(serialized)
  if (serialized !== null) entries.set(key, { serialized, draft })
  return draft
}

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener()
}

function persistDraft(key: string, serialized: string | null): boolean {
  try {
    const storage = window.localStorage
    if (serialized === null) {
      storage.removeItem(key)
      return true
    }
    const needsSlot = storage.getItem(key) === null
    storage.setItem(key, serialized)
    if (!needsSlot) return true
    const storedKeys = Object.keys(storage).filter((entry) => entry.startsWith(storagePrefix))
    let excess = storedKeys.length - maxStoredDrafts
    for (const candidate of storedKeys) {
      if (excess <= 0) break
      if (candidate === key || listeners.has(candidate)) continue
      const draft = readStoredDraft(storage.getItem(candidate))
      if (hasComposerDraftContent(draft) || draft.stash || draft.state.phase !== 'idle') continue
      storage.removeItem(candidate)
      entries.delete(candidate)
      excess--
    }
    return true
  } catch { return false }
}

function reconcileStoredDraft(key: string, serialized: string | null): void {
  const local = entries.get(key)
  if (local?.serialized === serialized || local?.inMemory) return
  const stored = readStoredDraft(serialized)
  if (local?.draft.state.phase === 'submitting' ||
    (local?.draft.state.phase === 'unknown' && local.draft.state.checking)) {
    entries.set(key, { serialized, draft: { ...stored, state: local.draft.state } })
  } else if (serialized === null) {
    entries.delete(key)
  } else {
    entries.set(key, { serialized, draft: stored })
  }
}

export function updateComposerDraft(key: string, update: (current: ComposerDraft) => ComposerDraft): ComposerDraft {
  const cached = entries.get(key)?.draft
  const stored = storageValue(key)
  if (stored !== undefined) reconcileStoredDraft(key, stored)
  const current = readComposerDraft(key)
  const draft = update(current)
  if (draft === current) {
    if (cached && cached !== current) notify(key)
    return current
  }
  const serialized = hasComposerDraftContent(draft) || draft.draftId || draft.model || draft.stash || draft.state.phase !== 'idle'
    ? JSON.stringify(draft)
    : null
  if (serialized === null) entries.delete(key)
  else entries.set(key, { serialized, draft })
  if (!persistDraft(key, serialized)) entries.set(key, { serialized, draft, inMemory: true })
  notify(key)
  return draft
}

function onStorage(event: StorageEvent): void {
  if (!event.key?.startsWith(storagePrefix)) return
  const serialized = storageValue(event.key)
  if (serialized === undefined || entries.get(event.key)?.serialized === serialized) return
  reconcileStoredDraft(event.key, serialized)
  notify(event.key)
}

if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)

export function useComposerDraft(key: string): ComposerDraft {
  const subscribe = useCallback((listener: () => void) => {
    const group = listeners.get(key) ?? new Set()
    group.add(listener)
    listeners.set(key, group)
    return () => {
      group.delete(listener)
      if (!group.size) listeners.delete(key)
    }
  }, [key])
  const read = useCallback(() => readComposerDraft(key), [key])
  return useSyncExternalStore(subscribe, read, () => emptyDraft)
}
