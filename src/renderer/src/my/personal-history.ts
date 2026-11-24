import { useSyncExternalStore } from 'react'
import { useApp } from '../store'
import { projectRootKey } from './navigation'

export interface PersonalVisit {
  kind: 'task' | 'document'
  target: string
  title: string
  archived?: boolean
  at: number
}
type VisitInput = Omit<PersonalVisit, 'at'>
const EMPTY: PersonalVisit[] = []
const cache = new Map<string, PersonalVisit[]>()
const listeners = new Set<() => void>()
const keyFor = (root: string | null | undefined, developer?: string | null): string | null => {
  const normalized = projectRootKey(root)
  return normalized ? `tpanel.my.history.v1:${encodeURIComponent(normalized)}:${encodeURIComponent(developer || 'local')}` : null
}
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function load(key: string | null): PersonalVisit[] {
  if (!key) return EMPTY
  const known = cache.get(key)
  if (known) return known
  let entries: PersonalVisit[] = []
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '[]')
    if (Array.isArray(value)) entries = value.filter((item): item is PersonalVisit => Boolean(item && typeof item === 'object' && (item.kind === 'task' || item.kind === 'document') && typeof item.target === 'string' && typeof item.title === 'string' && typeof item.at === 'number' && Number.isFinite(item.at) && (item.archived === undefined || typeof item.archived === 'boolean'))).slice(0, 60)
  } catch { /* Local history can be unavailable without affecting the workspace. */ }
  cache.set(key, entries)
  return entries
}
/** Local explicit opens only; no content, file-mtime inference or team identity claims. */
export function rememberVisit(visit: VisitInput): void {
  const snapshot = useApp.getState().snapshot
  const key = keyFor(snapshot?.meta.root, snapshot?.meta.developer)
  if (!key) return
  const entries = [{ ...visit, at: Date.now() }, ...load(key).filter((item) => item.kind !== visit.kind || item.target !== visit.target || Boolean(item.archived) !== Boolean(visit.archived))].slice(0, 60)
  cache.set(key, entries)
  try { localStorage.setItem(key, JSON.stringify(entries)) } catch { /* Keep the in-memory history. */ }
  for (const listener of listeners) listener()
}
export function usePersonalHistory(): PersonalVisit[] {
  const root = useApp((state) => state.snapshot?.meta.root)
  const developer = useApp((state) => state.snapshot?.meta.developer)
  const key = keyFor(root, developer)
  return useSyncExternalStore(subscribe, () => load(key), () => EMPTY)
}
export function clearPersonalHistory(): void {
  const snapshot = useApp.getState().snapshot
  const key = keyFor(snapshot?.meta.root, snapshot?.meta.developer)
  if (!key) return
  cache.set(key, [])
  try { localStorage.removeItem(key) } catch { /* The memory copy is cleared too. */ }
  for (const listener of listeners) listener()
}
