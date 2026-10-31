import type { HifoxWorkLocal } from '@shared/hifox-work'
import type { Page } from '../../store'
import type { TaskPatch } from '@shared/types'
import type { TaskMaterialGroup } from '../../reader/task-materials'
import type { GroupBy, OrderBy, StateGroup, WorkItemLayout } from '../../my/types'
import type { HifoxModule, HifoxTaskFilterState } from '../store'

export interface ScrollPosition { top: number; left: number }
export interface TaskListLocation {
  layout: WorkItemLayout
  groupBy: GroupBy
  orderBy: OrderBy
  display: { showEmptyGroups: boolean; showSubIssues: boolean }
  tab: 'all' | 'active' | 'backlog'
  stateGroups: StateGroup[]
  sourceFilter: HifoxTaskFilterState
  favorites: string[]
  relation: 'assigned' | 'created' | 'involved' | 'followed'
  personalSpaceId: string | null
  scrollPositions: ScrollPosition[]
}
export interface WorkPageSnapshot {
  fromPage: Page
  personalTaskSource: 'team' | 'local'
  module: HifoxModule
  currentSpaceId: string | null
  taskFilter: HifoxTaskFilterState
  activeViewId: string | null
  listLocations: Record<string, TaskListLocation>
  scrollPositions: ScrollPosition[]
}
export interface WorkReturnContext {
  workspaceKey: string
  actorId: string | null
  epoch?: string
  instanceId?: string
  sourceKey: string
  taskId: string
  taskCreatedAt: string
  spaceId: string
  handlerId: string | undefined
  taskTitle: string
  projectRoot: string
  taskDir: string
  local: HifoxWorkLocal
  page: WorkPageSnapshot
  developmentPosition: DevelopmentPosition
}
export interface DevelopmentPanelPosition {
  selection: string | null
  materialGroup: TaskMaterialGroup
  contextOpen: boolean
  pending: TaskPatch
  showDiff: boolean
  openedMtime?: number
}
export interface DevelopmentPosition {
  materialPath: string | null
  scrollPositions: ScrollPosition[]
  panel?: DevelopmentPanelPosition
}
