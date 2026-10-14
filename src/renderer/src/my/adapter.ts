// 快照 → 外壳视图模型适配层。无快照时回退内置示例数据（仅 ?my=1 预览路径使用）。
import type { ProjectSnapshot, TaskInfo } from '../../../shared/types'
import { createDemoDataset } from './data'
import type { Issue, IssueActivity, Member, MyDataset, Priority, WorkItemState } from './types'

export const TRELLIS_PROJECT_ID = 'trellis'

export const MY_STATES: WorkItemState[] = [
  { id: 'st-backlog', name: '未规划', color: '#A3A3A3', group: 'backlog', sequence: 15000 },
  { id: 'st-planning', name: '规划中', color: '#3A3A3A', group: 'unstarted', sequence: 25000 },
  { id: 'st-progress', name: '进行中', color: '#F59E0B', group: 'started', sequence: 35000 },
  { id: 'st-review', name: '评审中', color: '#3F76FF', group: 'started', sequence: 40000 },
  { id: 'st-done', name: '已完成', color: '#16A34A', group: 'completed', sequence: 45000 }
]

export function statusToStateId(status: string | null | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'planning':
      return 'st-planning'
    case 'in_progress':
      return 'st-progress'
    case 'review':
      return 'st-review'
    case 'completed':
    case 'done':
      return 'st-done'
    default:
      return 'st-backlog'
  }
}

export function priorityFromTask(taskPriority: string | null | undefined): Priority {
  switch (taskPriority) {
    case 'P0':
      return 'urgent'
    case 'P1':
      return 'high'
    case 'P2':
      return 'medium'
    case 'P3':
      return 'low'
    default:
      return 'none'
  }
}

export function priorityToTaskPriority(priority: Priority): string | null {
  switch (priority) {
    case 'urgent':
      return 'P0'
    case 'high':
      return 'P1'
    case 'medium':
      return 'P2'
    case 'low':
      return 'P3'
    default:
      return null
  }
}

const AVATAR_COLORS = ['#006399', '#7e22ce', '#c2410c', '#15803d', '#b91c1c', '#0f766e', '#a16207', '#2563eb']

function colorFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

function isoDay(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function daysAgoIso(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function buildTaskIssue(task: TaskInfo, byDir: Map<string, TaskInfo>): Issue {
  const record = task.record
  const title = record?.title ?? task.dirName
  const createdAt = isoDay(record?.createdAt ?? task.date) ?? daysAgoIso(0)
  const completedAt = record?.completedAt ? isoDay(record.completedAt) : null
  const activity: IssueActivity[] = [{ id: `${task.dirName}-a1`, actorId: record?.creator || '未署名', verb: '创建了工作项', at: createdAt }]
  if (completedAt) {
    activity.push({ id: `${task.dirName}-a2`, actorId: record?.assignee || record?.creator || '未署名', verb: '完成了工作项', at: completedAt })
  }
  const subIssueIds = (record?.children ?? []).filter((dir) => byDir.has(dir))
  const issue: Issue = {
    id: task.dirName,
    projectId: TRELLIS_PROJECT_ID,
    sequenceId: 0,
    name: title,
    description: record?.description ?? '',
    stateId: statusToStateId(record?.status ?? null),
    priority: priorityFromTask(record?.priority ?? null),
    assigneeId: record?.assignee || null,
    labelIds: [],
    cycleId: null,
    moduleId: null,
    startDate: createdAt,
    dueDate: null,
    createdAt,
    parentId: record?.parent && byDir.has(record.parent) ? record.parent : null,
    subIssueIds,
    activity,
    comments: [],
    completedAt
  }
  return issue
}

function collectMembers(tasks: TaskInfo[], developer: string | null): Member[] {
  const names = new Set<string>()
  if (developer) names.add(developer)
  for (const task of tasks) {
    if (task.record?.assignee) names.add(task.record.assignee)
    if (task.record?.creator) names.add(task.record.creator)
  }
  return Array.from(names).map((name) => ({
    id: name,
    name,
    avatarColor: colorFor(name),
    role: name === developer ? ('Admin' as const) : ('Member' as const)
  }))
}

/** 从真实快照派生视图模型；调用方需在快照变化时重新调用并写入 store。 */
export function deriveDataset(snapshot: ProjectSnapshot | null): MyDataset {
  if (!snapshot) return createDemoDataset()
  const tasks = snapshot.tasks
  const byDir = new Map(tasks.map((t) => [t.dirName, t]))
  const members = collectMembers(tasks, snapshot.meta.developer)
  const issues = tasks.map((t, index) => {
    const issue = buildTaskIssue(t, byDir)
    issue.sequenceId = index + 1
    return issue
  })
  const createdCount = issues.length
  return {
    workspace: {
      name: snapshot.meta.name || 'Trellis 项目',
      slug: 'trellis',
      memberId: snapshot.meta.developer ?? members[0]?.id ?? '我'
    },
    members: members.length > 0 ? members : [{ id: '我', name: '我', avatarColor: '#059669', role: 'Admin' }],
    projects: [
      {
        id: TRELLIS_PROJECT_ID,
        name: snapshot.meta.name || 'Trellis 项目',
        icon: (snapshot.meta.name || 'T').slice(0, 1),
        color: '#059669',
        description: `${createdCount} 个工作项 · ${snapshot.archived.length} 个已归档`,
        cycleEnabled: false,
        moduleEnabled: false,
        pagesEnabled: true,
        intakeEnabled: true,
        memberIds: members.map((m) => m.id),
        leadId: snapshot.meta.developer ?? members[0]?.id ?? '我',
        favorite: true,
        createdAt: daysAgoIso(0)
      }
    ],
    states: MY_STATES,
    labels: [],
    issues,
    cycles: [],
    modules: [],
    views: [],
    pages: [],
    intake: [],
    notifications: []
  }
}

export function issueToTaskPatch(issue: Issue): { status?: string; priority?: string; title?: string; description?: string } {
  const patch: { status?: string; priority?: string; title?: string; description?: string } = {}
  const state = MY_STATES.find((s) => s.id === issue.stateId)
  if (state) {
    const statusByState: Record<string, string> = {
      'st-planning': 'planning',
      'st-progress': 'in_progress',
      'st-review': 'review',
      'st-done': 'completed',
      'st-backlog': 'planning'
    }
    patch.status = statusByState[state.id]
  }
  const taskPriority = priorityToTaskPriority(issue.priority)
  if (taskPriority) patch.priority = taskPriority
  patch.title = issue.name
  patch.description = issue.description
  return patch
}

export function todayIso(): string {
  return daysAgoIso(0)
}
