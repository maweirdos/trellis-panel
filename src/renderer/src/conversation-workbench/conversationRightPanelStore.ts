import { useCallback, useRef, useSyncExternalStore } from 'react'
import { projectRootKey } from '../my/navigation'

export type ConversationThreadSurface = { readonly id: `thread:${string}`; readonly kind: 'thread'; readonly threadId: string }
export type ConversationRightPanelSurface =
  | ConversationThreadSurface
  | { readonly id: 'project' | 'files' | 'diff' | 'scripts' | 'terminal' | 'changes'; readonly kind: 'project' | 'files' | 'diff' | 'scripts' | 'terminal' | 'changes' }
  | { readonly id: `file:${string}`; readonly kind: 'file'; readonly path: string }

export interface ConversationRightPanelState {
  readonly isOpen: boolean
  readonly surfaces: readonly ConversationRightPanelSurface[]
  readonly activeSurfaceId: string | null
}

const EMPTY_PANEL: ConversationRightPanelState = { isOpen: false, surfaces: [], activeSurfaceId: null }
const MAX_SURFACES = 24
const STORAGE_PREFIX = 'crux.conversation.right-panel.v2:'
const panels = new Map<string, ConversationRightPanelState>()
const listeners = new Map<string, Set<() => void>>()

export function conversationPanelScope(scopeKey: string): string {
  const fields: unknown = JSON.parse(scopeKey)
  if (!Array.isArray(fields) || fields.length !== 5) return scopeKey
  const [root, workspace, actor, instance, epoch] = fields
  return workspace === 'local' && actor === 'local-owner' && instance === null && epoch === null
    ? JSON.stringify([root, workspace, null, instance, epoch])
    : scopeKey
}

export function conversationPanelKey(scopeKey: string, root: string, hostThreadId: string, storageId: string): string {
  return JSON.stringify([conversationPanelScope(scopeKey), projectRootKey(root) ?? root, hostThreadId, storageId])
}

export function conversationThreadSurface(threadId: string): ConversationThreadSurface {
  return { id: `thread:${threadId}`, kind: 'thread', threadId }
}

export function conversationFileSurface(path: string): Extract<ConversationRightPanelSurface, { kind: 'file' }> {
  return { id: `file:${path}`, kind: 'file', path }
}

function decodeSurface(value: unknown): ConversationRightPanelSurface | undefined {
  if (!value || typeof value !== 'object' || !('kind' in value)) return undefined
  switch (value.kind) {
    case 'project': case 'files': case 'diff': case 'scripts': case 'terminal': case 'changes':
      return { id: value.kind, kind: value.kind }
    case 'thread':
      return 'threadId' in value && typeof value.threadId === 'string' && /^[\w.-]{1,200}$/u.test(value.threadId)
        ? conversationThreadSurface(value.threadId) : undefined
    case 'file':
      return 'path' in value && typeof value.path === 'string' && value.path.length <= 8192 &&
        !/[\0:]/u.test(value.path) && value.path.split(/[\\/]/u).every(part => part && part !== '.' && part !== '..')
        ? conversationFileSurface(value.path) : undefined
  }
}

function read(ownerKey: string | null): ConversationRightPanelState {
  if (ownerKey === null) return EMPTY_PANEL
  const existing = panels.get(ownerKey)
  if (existing) return existing
  let result = EMPTY_PANEL
  try {
    const saved = localStorage.getItem(STORAGE_PREFIX + ownerKey)
    if (saved && saved.length <= 256_000) {
      const parsed: { surfaces?: unknown; activeSurfaceId?: unknown; isOpen?: unknown } = JSON.parse(saved)
      const entries = Array.isArray(parsed?.surfaces) ? parsed.surfaces.slice(0, MAX_SURFACES).map(decodeSurface) : []
      const surfaces = Array.from(new Map(entries.flatMap(surface => surface ? [[surface.id, surface] as const] : [])).values())
      const activeSurface = surfaces.find(surface => surface.id === parsed.activeSurfaceId) ?? surfaces[0]
      result = { surfaces, activeSurfaceId: activeSurface?.id ?? null, isOpen: Boolean(activeSurface && parsed.isOpen === true) }
    }
  } catch {}
  panels.set(ownerKey, result)
  return result
}

function write(ownerKey: string, update: (state: ConversationRightPanelState) => ConversationRightPanelState): void {
  const state = read(ownerKey)
  const next = update(state)
  if (next === state) return
  panels.set(ownerKey, next)
  try { localStorage.setItem(STORAGE_PREFIX + ownerKey, JSON.stringify(next)) } catch {}
  for (const notify of listeners.get(ownerKey) ?? []) notify()
}

export function openConversationSurface(state: ConversationRightPanelState, surface: ConversationRightPanelSurface): ConversationRightPanelState {
  const existing = state.surfaces.find(item => item.id === surface.id)
  const surfaces = existing ? state.surfaces : [...state.surfaces.slice(-(MAX_SURFACES - 1)), surface]
  return { surfaces, activeSurfaceId: surface.id, isOpen: true }
}

export function closeConversationSurface(state: ConversationRightPanelState, surfaceId: string): ConversationRightPanelState {
  const index = state.surfaces.findIndex(surface => surface.id === surfaceId)
  if (index < 0) return state
  const surfaces = state.surfaces.filter(surface => surface.id !== surfaceId)
  const fallback = surfaces[Math.min(index, surfaces.length - 1)]
  return { surfaces, isOpen: surfaces.length > 0 && state.isOpen,
    activeSurfaceId: state.activeSurfaceId === surfaceId ? fallback?.id ?? null : state.activeSurfaceId }
}

function visiblePanel(state: ConversationRightPanelState, relatedThreads: ReadonlySet<string>): ConversationRightPanelState {
  const surfaces = state.surfaces.filter(surface => surface.kind !== 'thread' || relatedThreads.has(surface.threadId))
  if (surfaces.length === state.surfaces.length) return state
  const selected = surfaces.find(surface => surface.id === state.activeSurfaceId) ?? surfaces[0]
  return { surfaces, activeSurfaceId: selected?.id ?? null, isOpen: Boolean(selected && state.isOpen) }
}

export function useConversationRightPanel(ownerKey: string | null, hostThreadId: string | null, relatedThreads: ReadonlySet<string>) {
  const latestOwner = useRef(ownerKey)
  latestOwner.current = ownerKey
  const subscribe = useCallback((notify: () => void) => {
    if (ownerKey === null) return () => {}
    const current = listeners.get(ownerKey) ?? new Set()
    current.add(notify)
    listeners.set(ownerKey, current)
    return () => {
      current.delete(notify)
      if (!current.size) {
        listeners.delete(ownerKey)
        panels.delete(ownerKey)
      }
    }
  }, [ownerKey])
  const snapshot = useCallback(() => read(ownerKey), [ownerKey])
  const stored = useSyncExternalStore(subscribe, snapshot, () => EMPTY_PANEL)
  const state = visiblePanel(stored, relatedThreads)
  const update = useCallback((change: (state: ConversationRightPanelState) => ConversationRightPanelState) => {
    if (ownerKey !== null && latestOwner.current === ownerKey) write(ownerKey, change)
  }, [ownerKey])
  const open = useCallback((surface: ConversationRightPanelSurface) => {
    if (surface.kind === 'thread' && surface.threadId === hostThreadId) return
    update(current => openConversationSurface(current, surface))
  }, [hostThreadId, update])
  const activate = (surfaceId: string): void => {
    update(current => current.surfaces.some(surface => surface.id === surfaceId)
      ? { ...current, activeSurfaceId: surfaceId, isOpen: true } : current)
  }
  const close = (surfaceId: string): void => update(current => closeConversationSurface(current, surfaceId))
  const hide = (): void => update(current => current.isOpen ? { ...current, isOpen: false } : current)
  const show = (): void => update(current => visiblePanel(current, relatedThreads).surfaces.length
    ? { ...current, isOpen: true }
    : openConversationSurface(current, { id: 'project', kind: 'project' }))
  const move = (surfaceId: string, toIndex: number): void => update(current => {
    const target = visiblePanel(current, relatedThreads).surfaces[toIndex]
    const fromIndex = current.surfaces.findIndex(surface => surface.id === surfaceId)
    if (fromIndex < 0 || !target || target.id === surfaceId) return current
    const targetIndex = current.surfaces.findIndex(surface => surface.id === target.id)
    const surfaces = [...current.surfaces]
    surfaces.splice(targetIndex, 0, ...surfaces.splice(fromIndex, 1))
    return { ...current, surfaces }
  })
  const active = state.isOpen ? state.surfaces.find(surface => surface.id === state.activeSurfaceId) : undefined
  return { state, active, open, activate, close, hide, show, move }
}
