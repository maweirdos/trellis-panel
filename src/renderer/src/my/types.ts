// 外壳领域类型。

export type ThemeMode = 'light' | 'dark'

export type StateGroup = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'

export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none'

export type WorkItemLayout = 'list' | 'board' | 'spreadsheet' | 'gantt' | 'calendar'

export type GroupBy = 'state' | 'priority' | 'assignee' | 'labels' | 'package' | 'none'
export type OrderBy = 'priority' | 'due_date' | 'created_at' | 'manual'

export interface Member {
  id: string
  name: string
  avatarColor: string
  role: 'Admin' | 'Member' | 'Guest'
}

export interface WorkItemState {
  id: string
  name: string
  color: string
  group: StateGroup
  sequence: number
}

export interface Label {
  id: string
  name: string
  color: string // label 色系: indigo|emerald|grey|crimson|yellow|orange|pink|purple
}

export type CycleStatus = 'draft' | 'upcoming' | 'active' | 'completed'

export interface Cycle {
  id: string
  projectId: string
  name: string
  status: CycleStatus
  startDate: string // YYYY-MM-DD
  endDate: string
  issueIds: string[]
}

export interface Module {
  id: string
  projectId: string
  name: string
  description: string
  status: 'planned' | 'in-progress' | 'completed' | 'paused'
  leadId: string
  memberIds: string[]
  startDate: string
  endDate: string
  issueIds: string[]
}

export interface SavedView {
  id: string
  projectId: string
  name: string
  description: string
  filters: { priority?: Priority[]; stateGroup?: StateGroup[]; assigneeIds?: string[]; labelIds?: string[] }
  ownedById: string
}

export interface PageDoc {
  id: string
  projectId: string
  emoji: string
  title: string
  content: string
  updatedAt: string
}

export type IntakeStatus = 'pending' | 'accepted' | 'declined' | 'duplicate' | 'snoozed'

export interface IntakeIssue {
  id: string
  projectId: string
  title: string
  description: string
  status: IntakeStatus
  submittedBy: string
  createdAt: string
}

export interface Project {
  id: string
  name: string
  icon: string // 首字母或 emoji
  color: string
  description: string
  cycleEnabled: boolean
  moduleEnabled: boolean
  pagesEnabled: boolean
  intakeEnabled: boolean
  memberIds: string[]
  leadId: string
  favorite: boolean
  createdAt: string
}

export interface IssueActivity {
  id: string
  actorId: string
  verb: string
  detail?: string
  at: string
}

export interface IssueComment {
  id: string
  actorId: string
  body: string
  at: string
}

export interface Issue {
  id: string
  projectId: string
  sequenceId: number
  name: string
  description: string
  stateId: string
  priority: Priority
  assigneeId: string | null
  labelIds: string[]
  cycleId: string | null
  moduleId: string | null
  /** task.json 既有字段：模块（package）/ 范围（scope），仅用于分组与统计维度 */
  pkg: string | null
  scope: string | null
  startDate: string | null
  dueDate: string | null
  createdAt: string
  parentId: string | null
  subIssueIds: string[]
  activity: IssueActivity[]
  comments: IssueComment[]
  completedAt: string | null
}

export interface Workspace {
  name: string
  slug: string
  memberId: string // 当前用户
}

export interface NotificationItem {
  id: string
  kind: 'assigned' | 'created' | 'subscribed' | 'mention'
  title: string
  body: string
  at: string
  read: boolean
  projectId: string
  issueId: string
}

/** 视图数据集（内存态，可被操作变更） */
export interface MyDataset {
  workspace: Workspace
  members: Member[]
  projects: Project[]
  states: WorkItemState[] // 全项目共用一套默认状态
  labels: Label[]
  issues: Issue[]
  cycles: Cycle[]
  modules: Module[]
  views: SavedView[]
  pages: PageDoc[]
  intake: IntakeIssue[]
  notifications: NotificationItem[]
}

/** 模块内导航 */
export type MyPage =
  | 'your-work'
  | 'inbox'
  | 'analytics'
  | 'projects'
  | 'workspace-settings'
  | 'profile'
  | 'work-items'
  | 'cycles'
  | 'modules'
  | 'views'
  | 'pages'
  | 'intake'
  | 'project-settings'

export type IssueFilters = {
  priority: Priority[]
  stateGroup: StateGroup[]
  assigneeIds: string[]
  labelIds: string[]
}
