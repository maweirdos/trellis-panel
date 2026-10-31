import type { AppState, Page } from '../store'
import { getPageNavigation, PAGE_NAVIGATION, projectRootKey, SETTINGS_VIEWS, type NavigationDomain } from './navigation'
import type { MyStore } from './store'

type ViewState = Pick<MyStore, 'workItemsView' | 'workItemsTab' | 'teamView' | 'toolView' | 'knowledgeView' | 'settingsView'>
export type NavigationLocation = ViewState & Pick<AppState, 'personalTaskSource'> & { page: Page; modulePages: Partial<Record<NavigationDomain, Page>> }
const keyFor = (root: string, developer?: string | null): string => `tpanel.my.navigation.v1:${encodeURIComponent(projectRootKey(root) || root)}:${encodeURIComponent(developer || 'local')}`
const isPage = (value: unknown): value is Page => typeof value === 'string' && Object.prototype.hasOwnProperty.call(PAGE_NAVIGATION, value)
const isOneOf = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === 'string' && values.includes(value as T)
export function loadNavigationLocation(root: string, developer?: string | null): NavigationLocation | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(keyFor(root, developer)) || 'null')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const value = raw as Record<string, unknown>
    if (!isPage(value.page) || !isOneOf(value.workItemsView, ['items', 'iterations'] as const) || !isOneOf(value.workItemsTab, ['all', 'active', 'backlog'] as const) || !isOneOf(value.teamView, ['overview', 'members', 'activity', 'reports'] as const) || !isOneOf(value.toolView, ['git', 'run', 'architecture', 'studio'] as const) || !isOneOf(value.knowledgeView, ['materials', 'company'] as const) || !isOneOf(value.settingsView, SETTINGS_VIEWS)) return null
    const personalTaskSource = isOneOf(value.personalTaskSource, ['team', 'local'] as const)
      ? value.personalTaskSource
      : value.workItemsView === 'iterations' ? 'local' : 'team'
    const modulePages: NavigationLocation['modulePages'] = {}
    if (value.modulePages && typeof value.modulePages === 'object' && !Array.isArray(value.modulePages)) {
      for (const [domain, page] of Object.entries(value.modulePages)) {
        if (isPage(page) && getPageNavigation(page).domain === domain) modulePages[getPageNavigation(page).domain] = page
      }
    }
    return { page: value.page, personalTaskSource, workItemsView: value.workItemsView, workItemsTab: value.workItemsTab, teamView: value.teamView, toolView: value.toolView, knowledgeView: value.knowledgeView, settingsView: value.settingsView, modulePages }
  } catch { return null }
}
export function saveNavigationLocation(root: string, developer: string | null | undefined, page: Page, state: MyStore, personalTaskSource: AppState['personalTaskSource']): void {
  const { workItemsView, workItemsTab, teamView, toolView, knowledgeView, settingsView, modulePages } = state
  try { localStorage.setItem(keyFor(root, developer), JSON.stringify({ page, personalTaskSource, workItemsView, workItemsTab, teamView, toolView, knowledgeView, settingsView, modulePages })) } catch { /* Navigation remains usable without storage. */ }
}
