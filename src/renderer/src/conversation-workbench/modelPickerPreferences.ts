/**
 * Ported from t3code@28c58b1 apps/web/src/hooks/useSettings.ts (environment model
 * preferences): favorites and recently used models per project root, so two
 * workspaces never share a picker's history.
 */
const STORAGE_PREFIX = 'crux.conversation.modelPicker.v1:'
const MAX_RECENT = 6

export interface ModelPickerPreferences {
  readonly favorites: readonly string[]
  readonly recent: readonly string[]
}

/** Favorites and recents key a model by instance + id so same-named models stay distinct. */
export function modelPickerKey(instanceId: string, modelId: string): string {
  return `${instanceId}\u0000${modelId}`
}

function storageKey(root: string): string {
  return `${STORAGE_PREFIX}${root}`
}

function read(root: string): ModelPickerPreferences {
  const empty: ModelPickerPreferences = { favorites: [], recent: [] }
  try {
    const raw = window.localStorage.getItem(storageKey(root))
    if (!raw) return empty
    const parsed = JSON.parse(raw) as Partial<ModelPickerPreferences>
    const list = (value: unknown): readonly string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    return { favorites: list(parsed.favorites), recent: list(parsed.recent) }
  } catch {
    return empty
  }
}

function write(root: string, next: ModelPickerPreferences): void {
  try {
    window.localStorage.setItem(storageKey(root), JSON.stringify(next))
  } catch {
    // A full or unavailable storage keeps the in-memory copy only.
  }
}

const cache = new Map<string, ModelPickerPreferences>()
const listeners = new Map<string, Set<() => void>>()

export function readModelPickerPreferences(root: string): ModelPickerPreferences {
  const cached = cache.get(root)
  if (cached) return cached
  const loaded = read(root)
  cache.set(root, loaded)
  return loaded
}

export function toggleModelFavorite(root: string, instanceId: string, modelId: string): void {
  const current = readModelPickerPreferences(root)
  const key = modelPickerKey(instanceId, modelId)
  const favorites = current.favorites.includes(key)
    ? current.favorites.filter(item => item !== key)
    : [...current.favorites, key]
  commit(root, { ...current, favorites })
}

export function recordModelUsed(root: string, instanceId: string, modelId: string): void {
  const current = readModelPickerPreferences(root)
  const key = modelPickerKey(instanceId, modelId)
  if (current.recent[0] === key) return
  const recent = [key, ...current.recent.filter(item => item !== key)].slice(0, MAX_RECENT)
  commit(root, { ...current, recent })
}

function commit(root: string, next: ModelPickerPreferences): void {
  cache.set(root, next)
  write(root, next)
  listeners.get(root)?.forEach(notify => notify())
}

export function subscribeModelPickerPreferences(root: string, notify: () => void): () => void {
  const set = listeners.get(root) ?? new Set()
  set.add(notify)
  listeners.set(root, set)
  return () => {
    set.delete(notify)
    if (set.size === 0) listeners.delete(root)
  }
}
