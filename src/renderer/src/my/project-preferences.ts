import { projectRootKey } from './navigation'
import type { GroupBy, IssueFilters } from './types'

export interface SavedView {
  id: string
  name: string
  filters: IssueFilters
  groupBy: GroupBy
  createdAt: number
}

export interface ProjectPreferences {
  favorites: string[]
  savedViews: SavedView[]
}

interface PreferenceStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const GROUPS: readonly GroupBy[] = ['state', 'priority', 'assignee', 'labels', 'package', 'cycle', 'none']

function preferenceKey(root: string | null): string | null {
  const scope = projectRootKey(root)
  return scope ? `tpanel.my.project.${encodeURIComponent(scope)}` : null
}

function isSavedView(value: unknown): value is SavedView {
  if (!value || typeof value !== 'object') return false
  const view = value as Partial<SavedView>
  if (typeof view.id !== 'string' || typeof view.name !== 'string' || typeof view.createdAt !== 'number' || !view.groupBy || !GROUPS.includes(view.groupBy)) return false
  const filters = view.filters
  return Boolean(filters && ['priority', 'stateGroup', 'assigneeIds', 'labelIds'].every((key) =>
    Array.isArray(filters[key as keyof IssueFilters]) && filters[key as keyof IssueFilters].every((item) => typeof item === 'string')
  ))
}

/** Legacy unscoped keys remain untouched: their project ownership cannot be inferred safely. */
export function loadProjectPreferences(root: string | null, storage?: PreferenceStorage): ProjectPreferences {
  const empty: ProjectPreferences = { favorites: [], savedViews: [] }
  const key = preferenceKey(root)
  if (!key) return empty
  try {
    const raw = (storage ?? localStorage).getItem(key)
    if (!raw) return empty
    const value = JSON.parse(raw) as Partial<ProjectPreferences> | null
    return {
      favorites: Array.isArray(value?.favorites) ? value.favorites.filter((id): id is string => typeof id === 'string').slice(0, 50) : [],
      savedViews: Array.isArray(value?.savedViews) ? value.savedViews.filter(isSavedView).slice(0, 30) : []
    }
  } catch {
    return empty
  }
}

export function saveProjectPreferences(root: string | null, prefs: ProjectPreferences, storage?: PreferenceStorage): void {
  const key = preferenceKey(root)
  if (!key) return
  try {
    (storage ?? localStorage).setItem(key, JSON.stringify({ favorites: prefs.favorites.slice(0, 50), savedViews: prefs.savedViews.slice(0, 30) }))
  } catch {
    // Preferences remain usable in memory when storage is unavailable.
  }
}
