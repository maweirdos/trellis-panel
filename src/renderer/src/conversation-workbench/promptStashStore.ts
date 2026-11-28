import { useSyncExternalStore } from 'react'
import type { ComposerReference } from './useComposerDraft'

export const PROMPT_STASH_STORAGE_KEY = 'crux.conversation.prompt-stash.v1'
export const MAX_STASH_ENTRIES = 20

export interface PromptStashEntry {
  readonly id: string
  readonly createdAt: string
  readonly prompt: string
  readonly references: readonly ComposerReference[]
}

interface PersistedPromptStashPayload {
  readonly version: 1
  readonly entries: readonly PromptStashEntry[]
}

let memoryEntries: readonly PromptStashEntry[] | null = null
const listeners = new Set<() => void>()

function emitChange(): void {
  for (const listener of listeners) listener()
}

function isValidReference(value: unknown): value is ComposerReference {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.label !== 'string') return false
  if (typeof record.text === 'string') return true
  if (typeof record.threadId === 'string') {
    return record.messageIds === undefined || (Array.isArray(record.messageIds) && record.messageIds.every((item) => typeof item === 'string'))
  }
  return false
}

function normalizeEntries(raw: unknown): readonly PromptStashEntry[] {
  if (!Array.isArray(raw)) return []
  const result: PromptStashEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.createdAt !== 'string' || typeof record.prompt !== 'string') continue
    const refs = Array.isArray(record.references) ? record.references.filter(isValidReference) : []
    if (!record.prompt.trim() && refs.length === 0) continue
    result.push({
      id: record.id,
      createdAt: record.createdAt,
      prompt: record.prompt,
      references: refs,
    })
    if (result.length >= MAX_STASH_ENTRIES) break
  }
  return result
}

function readFromStorage(): readonly PromptStashEntry[] {
  if (typeof window === 'undefined') return memoryEntries ?? []
  try {
    const raw = window.localStorage.getItem(PROMPT_STASH_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Partial<PersistedPromptStashPayload> | null
    if (!parsed || !Array.isArray(parsed.entries)) return []
    return normalizeEntries(parsed.entries)
  } catch {
    return memoryEntries ?? []
  }
}

function writeToStorage(entries: readonly PromptStashEntry[]): { readonly written: boolean; readonly durable: boolean } {
  memoryEntries = entries
  if (typeof window === 'undefined') return { written: true, durable: false }
  try {
    const payload: PersistedPromptStashPayload = { version: 1, entries }
    window.localStorage.setItem(PROMPT_STASH_STORAGE_KEY, JSON.stringify(payload))
    return { written: true, durable: true }
  } catch {
    return { written: true, durable: false }
  }
}

export function getPromptStashEntries(): readonly PromptStashEntry[] {
  if (memoryEntries === null) memoryEntries = readFromStorage()
  return memoryEntries
}

export function stashComposerPrompt(input: {
  readonly prompt: string
  readonly references?: readonly ComposerReference[]
  readonly id?: string
  readonly createdAt?: string
}): {
  readonly entry: PromptStashEntry | null
  readonly evicted: PromptStashEntry | null
  readonly durable: boolean
} {
  const prompt = input.prompt
  const references = input.references ? [...input.references] : []
  if (!prompt.trim() && references.length === 0) {
    return { entry: null, evicted: null, durable: true }
  }
  const current = readFromStorage()
  const entry: PromptStashEntry = {
    id: input.id ?? (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `stash_${Date.now()}`),
    createdAt: input.createdAt ?? new Date().toISOString(),
    prompt,
    references,
  }
  const deduped = current.filter(
    (item) => !(item.prompt === entry.prompt && JSON.stringify(item.references) === JSON.stringify(entry.references)),
  )
  const next = [entry, ...deduped]
  const evicted = next.length > MAX_STASH_ENTRIES ? (next.pop() ?? null) : null
  const { durable } = writeToStorage(next)
  emitChange()
  return { entry, evicted, durable }
}

export function takePromptStashEntry(entryId: string): {
  readonly entry: PromptStashEntry | null
  readonly durable: boolean
} {
  const current = readFromStorage()
  const entry = current.find((item) => item.id === entryId) ?? null
  if (!entry) return { entry: null, durable: true }
  const next = current.filter((item) => item.id !== entryId)
  const { durable } = writeToStorage(next)
  emitChange()
  return { entry, durable }
}

export function removePromptStashEntry(entryId: string): void {
  const current = readFromStorage()
  const next = current.filter((item) => item.id !== entryId)
  if (next.length === current.length) return
  writeToStorage(next)
  emitChange()
}

export function clearPromptStash(): void {
  writeToStorage([])
  emitChange()
}

export function resetPromptStashMemoryForTest(): void {
  memoryEntries = null
}

function subscribePromptStash(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== PROMPT_STASH_STORAGE_KEY) return
    memoryEntries = readFromStorage()
    emitChange()
  })
}

export function usePromptStashEntries(): readonly PromptStashEntry[] {
  return useSyncExternalStore(subscribePromptStash, getPromptStashEntries, () => [])
}
