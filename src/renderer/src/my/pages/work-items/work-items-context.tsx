import { createContext, useContext, type ReactNode } from 'react'
import type { MyStore } from '../../store'
import type { Issue, Label, Member } from '../../types'

export type WorkItemsTab = MyStore['workItemsTab']

/** The presentation consumes these fields without owning either backing store. */
export type WorkItemsStore = Pick<MyStore,
  | 'data' | 'layout' | 'groupBy' | 'orderBy' | 'filters' | 'display'
  | 'workItemsView' | 'workItemsTab' | 'setWorkItemsTab'
  | 'setLayout' | 'setGroupBy' | 'setOrderBy' | 'toggleFilter' | 'clearFilters' | 'setDisplay'
  | 'openIssue' | 'updateIssue' | 'setCreateIssueOpen'
  | 'favorites' | 'toggleFavorite' | 'saveView'
>

export interface WorkItemsSource {
  key: string
  kind: 'native' | 'collaboration'
  store: WorkItemsStore
  /** null displays all authorized projects; omission retains the native first project. */
  projectId?: string | null
  capabilities: {
    editableFields: readonly (keyof Issue)[]
    create: boolean
    favorites: boolean
    saveView: boolean
  }
  presentation?: {
    title?: string
    tabs?: Array<{ id: WorkItemsTab; label: string }>
    matchesTab?: (issue: Issue, tab: WorkItemsTab) => boolean
    identifier?: (issue: Issue) => string
    cycleMode?: 'week' | 'version'
    cycleIds?: (issue: Issue) => readonly string[]
    assigneeIds?: (issue: Issue) => readonly string[]
    assigneeOptions?: (issueId: string) => Member[]
    multiAssignee?: (issueId: string) => boolean
    stateIds?: (issueId: string) => readonly string[]
    labelColor?: (label: Label) => string
    renderLabel?: (label: Label) => ReactNode
    renderBoardReview?: (issue: Issue) => ReactNode
    filterContent?: ReactNode
    additionalFilterCount?: number
    startDateLabel?: string
    dueDateLabel?: string
  }
  setAssignees?: (issueId: string, ids: string[]) => Promise<void>
  canEditIssue?: (issueId: string, field: keyof Issue) => boolean
}

const WorkItemsContext = createContext<WorkItemsSource | null>(null)

export const WorkItemsProvider = WorkItemsContext.Provider

export function useWorkItemsSource(): WorkItemsSource {
  const source = useContext(WorkItemsContext)
  if (!source) throw new Error('WorkItemsPage requires its data source provider')
  return source
}

export function useWorkItems(): WorkItemsStore {
  return useWorkItemsSource().store
}

export function issueAssigneeIds(source: WorkItemsSource, issue: Issue): readonly string[] {
  return source.presentation?.assigneeIds?.(issue) ?? (issue.assigneeId ? [issue.assigneeId] : [])
}

export function issueCycleIds(source: WorkItemsSource, issue: Issue): readonly string[] {
  return source.presentation?.cycleIds?.(issue) ?? (issue.cycle ? [issue.cycle] : [])
}

export function issueIdentifier(source: WorkItemsSource, issue: Issue, ident: string): string {
  return source.presentation?.identifier?.(issue) ?? `${ident}-${issue.sequenceId}`
}

export function canEditWorkItem(source: WorkItemsSource, field: keyof Issue, issueId?: string): boolean {
  return source.capabilities.editableFields.includes(field) && (!issueId || source.canEditIssue?.(issueId, field) !== false)
}
