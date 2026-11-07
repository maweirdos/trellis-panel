import type { CruxWorkspaceContext } from './crux-remote'
import type { TeamRole } from './team-platform'
import type { z } from 'zod'
import type { RecordTaskDeliveryInput } from './task-delivery'
import type {
  cruxTaskWorkKindSchema, cruxTaskStageSchema, cruxTaskActionSchema,
  cruxTaskWorkflowArtifactSchema, cruxTaskWorkflowEventSchema, cruxTaskWorkflowSchema,
  cruxTransitionTaskInputSchema, cruxVersionDeliverySchema, cruxRecordVersionDeliveryInputSchema,
  cruxMilestoneSchema, cruxSaveMilestoneInputSchema, cruxMilestoneCommandInputSchema, cruxInitialTaskTypeSchema
} from './crux-schema'

export type CruxInitialTaskType = z.infer<typeof cruxInitialTaskTypeSchema>
export type CruxTaskWorkKind = z.infer<typeof cruxTaskWorkKindSchema>
export type CruxTaskStage = z.infer<typeof cruxTaskStageSchema>
export type CruxTaskAction = z.infer<typeof cruxTaskActionSchema>
export type CruxTaskWorkflowArtifact = z.infer<typeof cruxTaskWorkflowArtifactSchema>
export type CruxTaskWorkflowEvent = z.infer<typeof cruxTaskWorkflowEventSchema>
export type CruxTaskWorkflow = z.infer<typeof cruxTaskWorkflowSchema>
export type CruxTransitionTaskInput = z.infer<typeof cruxTransitionTaskInputSchema>
export type CruxVersionDelivery = z.infer<typeof cruxVersionDeliverySchema>
export type CruxRecordVersionDeliveryInput = z.infer<typeof cruxRecordVersionDeliveryInputSchema>
export type CruxMilestone = z.infer<typeof cruxMilestoneSchema>
export type CruxSaveMilestoneInput = z.infer<typeof cruxSaveMilestoneInputSchema>
export type CruxMilestoneCommandInput = z.infer<typeof cruxMilestoneCommandInputSchema>
export type {
  AdoptTaskDeliveryProtocol, RequirementBaseline, RequirementBaselineInput, TaskDelivery, TaskDeliveryInput,
  TaskDeliveryState, TaskDeliveryRoles, TaskTestRun, TaskTestRunInput, TaskMaterialReference,
  TaskDeliveryEventLinks, TaskDeliveryDependencies, RecordTaskDeliveryInput
} from './task-delivery'

/**
 * 本机与共享协作域契约；桌面、浏览器和服务端复用同一套领域规则。
 * 参考 docs/prd-crux 的任务、空间与 Agent 配置约束。
 * Agent 指派只记录排队或等待运行环境，不代表已启动实际执行。
 */

/* ---------------- 基础 ---------------- */

export type CruxID = string

export type CruxRole = 'owner' | 'admin' | 'member'

export type CruxPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none'

/** 状态类别：与 PRD 3.2/4.4 的七类状态一一对应；Agent 仅在 todo / in_progress 等待 Runtime 执行 */
export type CruxStatusCategory =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'blocked'
  | 'cancelled'

/** 任务关联类型（PRD 4.5） */
export type CruxTaskRelationKind = 'blocks' | 'related' | 'duplicate'

/** 处理人执行槽：Agent / 小队单独占一个槽，不进入人员集合（PRD 3.2） */
export interface CruxExecutorRef {
  kind: 'agent' | 'crew'
  id: CruxID
  name: string
}

/** 任务对 Agent 的派发状态（PRD 2.2 的边界内实现：到「等待 Runtime」为止） */
export interface CruxDispatchState {
  status: 'queued' | 'waiting_runtime'
  since: string
  note?: string
}

/* ---------------- 空间与成员 ---------------- */

export interface CruxSpace {
  id: CruxID
  name: string
  /** 任务 ID 前缀，如 ENG */
  key: string
  description?: string
  /** Missing visibility preserves existing organization-public spaces. */
  visibility?: 'public' | 'private'
  ownerId?: CruxID
  archived?: boolean
  /** 多人处理人开关（PRD 3.2：开启后一条任务可有多名人员处理人） */
  multiAssignee: boolean
  memberIds: CruxID[]
  /** 任务编号自增游标 */
  taskSeq: number
  createdAt: string
}

export interface CruxMember {
  id: CruxID
  name: string
  email?: string
  title?: string
  role: CruxRole
  /** Authenticated project responsibilities, projected by the team service. */
  projectRoles?: TeamRole[]
  avatarHue: number
  joinedAt: string
}

/* ---------------- 任务配置（类型/状态/标签） ---------------- */

export interface CruxTaskType {
  id: CruxID
  spaceId: CruxID
  name: string
  /** 需要补充的提示字段，如 Bug 需要复现步骤 */
  requiredHints?: string[]
  /** 类型可用状态（两层模型，PRD 4.4 规则1）：未设置时沿用空间全部状态 */
  statusIds?: CruxID[]
  isDefault?: boolean
}

export interface CruxTaskStatus {
  id: CruxID
  spaceId: CruxID
  name: string
  category: CruxStatusCategory
  order: number
}

export interface CruxTaskLabel {
  id: CruxID
  /** 空间标签归属空间；组织标签 spaceId 为空、所有空间可用（PRD 4.3 规则4） */
  spaceId?: CruxID
  name: string
  color: string
  archived?: boolean
}

/* ---------------- 任务 / 评论 / 活动 / 关联 ---------------- */

export interface CruxTaskRelation {
  kind: CruxTaskRelationKind
  taskId: CruxID
}

export interface CruxTask {
  id: CruxID
  spaceId: CruxID
  title: string
  description?: string
  typeId?: CruxID
  statusId: CruxID
  priority: CruxPriority
  /** 人员处理人集合：multiAssignee 关闭时最多 1 人 */
  assigneeIds: CruxID[]
  /** 执行槽：Agent 或小队（单选） */
  executor?: CruxExecutorRef
  creatorId: CruxID
  labelIds: CruxID[]
  projectId?: CruxID
  iterationIds: CruxID[]
  parentTaskId?: CruxID
  relations: CruxTaskRelation[]
  followerIds: CruxID[]
  dispatch?: CruxDispatchState
  triagePending?: boolean
  workKind?: CruxTaskWorkKind
  acceptanceCriteria?: string[]
  workflow?: CruxTaskWorkflow
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface CruxComment {
  id: CruxID
  taskId: CruxID
  /** 作者：成员 id 或 `agent:<id>` */
  authorId: string
  body: string
  mentions: CruxID[]
  createdAt: string
  resolved?: boolean
  parentId?: CruxID
}

export interface CruxActivity {
  id: CruxID
  taskId: CruxID
  /** 字段变更 / 状态流转 / 派发 / 评论 等 */
  kind: string
  text: string
  at: string
}

/* ---------------- 专项 / 迭代 / 视图 / 分拣台 ---------------- */

export interface CruxProject {
  id: CruxID
  spaceId: CruxID
  name: string
  goal?: string
  status: 'active' | 'done' | 'archived'
  ownerIds: CruxID[]
  createdAt: string
}

export interface CruxIteration {
  id: CruxID
  spaceId: CruxID
  name: string
  goal?: string
  startDate: string
  endDate: string
  status: 'pending' | 'active' | 'completed'
  taskIds: CruxID[]
  predecessorId?: CruxID
}

export interface CruxViewFilter {
  keyword?: string
  statusIds?: CruxID[]
  typeIds?: CruxID[]
  labelIds?: CruxID[]
  assigneeIds?: CruxID[]
  priorities?: CruxPriority[]
  iterationId?: CruxID
  projectId?: CruxID
}

export interface CruxView {
  id: CruxID
  spaceId: CruxID
  name: string
  filter: CruxViewFilter
  groupBy: 'status' | 'assignee' | 'type' | 'priority'
  pinned?: boolean
}

/** 分拣台处置动作（PRD 3.7：优先级判定后四种处置） */
export type CruxTriageDisposition =
  | 'assign'        // 指派处理人推进
  | 'iterate'       // 放入迭代
  | 'park'          // 暂回 Backlog 待定
  | 'close'         // 关闭不再处理

export interface CruxTriageDecision {
  taskId: CruxID
  disposition: CruxTriageDisposition
  at: string
  actorId?: CruxID
  note?: string
}

/* ---------------- 自动化（PRD 3.8；Agent 动作到「等待 Runtime」为止） ---------------- */

export type CruxAutomationTriggerKind =
  | 'schedule'      // 定时：cron 简化表达 {timeOfDay, days[]}
  | 'task_status'   // 任务进入某状态
  | 'task_created'  // 新任务创建
  | 'comment'       // 评论包含关键词

export interface CruxAutomationTrigger {
  kind: CruxAutomationTriggerKind
  /** schedule: "09:00"；task_status: 状态 id；comment: 关键词 */
  value?: string
  /** schedule 限定星期（1-7），空为每天 */
  days?: number[]
}

export interface CruxAutomationTarget {
  kind: 'agent' | 'crew' | 'member' | 'none'
  id?: CruxID
  name?: string
}

export interface CruxAutomationRun {
  id: CruxID
  at: string
  trigger: string
  outcome: 'done' | 'waiting_runtime' | 'skipped'
  detail?: string
}

export interface CruxAutomation {
  id: CruxID
  spaceId: CruxID
  name: string
  creatorId?: CruxID
  enabled: boolean
  lastScheduledDate?: string
  trigger: CruxAutomationTrigger
  target: CruxAutomationTarget
  instruction?: string
  projectId?: CruxID
  lastRunAt?: string
  runs: CruxAutomationRun[]
}

/* ---------------- 收件箱（PRD 2.6 + REA 实测校准） ---------------- */

/** 事件类型：决定进入「重要」还是「其他」（REA 实测：执行异常/@提及/被指派 → 重要） */
export type CruxInboxKind =
  | 'assign'         // 任务指派给你或处理人变化
  | 'mention'        // 评论 @ 你
  | 'status'         // 关注任务的状态/优先级变化
  | 'dispatch'       // Agent 派发状态（等待 Runtime / 执行异常）
  | 'automation'     // 自动化或汇报结果
  | 'triage'         // 分拣台责任提醒（「此任务需要你分拣」）

export type CruxInboxSection = 'important' | 'other'

export interface CruxInboxItem {
  id: CruxID
  section: CruxInboxSection
  kind: CruxInboxKind
  title: string
  body?: string
  /** 同一任务的通知在 UI 上聚合为一行（任务级提醒） */
  taskId?: CruxID
  /** Space scope also applies to automation reminders without a task. */
  spaceId?: CruxID
  at: string
  read: boolean
  recipientIds?: CruxID[]
  /** 稍后处理：到时回对应分区；期间从活跃列表隐藏 */
  snoozedUntil?: string
  /** 已清理：可恢复，清理不删除任务/评论/活动 */
  cleared?: boolean
}

/* ---------------- Agent / 技能 / 小队（配置层，PRD 2.1/2.9/2.10） ---------------- */

/** Runtime 仅作为配置引用，不建立连接（Runtime 模块另行接入） */
export type CruxRuntimeKind = 'claude-code' | 'codex' | 'custom'

export type CruxWorkingDirectoryMode = 'repo' | 'temp'

export interface CruxAgent {
  id: CruxID
  spaceId: CruxID
  name: string
  description?: string
  /** 职责与工作方式指令 */
  instructions: string
  skillIds: CruxID[]
  /** 代码库引用（名称级，连接由 runtime 模块负责） */
  repositories: Array<{ name: string; url?: string }>
  runtimeKind: CruxRuntimeKind
  workingDirectory: CruxWorkingDirectoryMode
  enabled: boolean
  archived?: boolean
  /** 独占使用该 Agent 的小队；由小队成员配置维护 */
  exclusiveCrewId?: CruxID
  createdAt: string
}

export interface CruxSkill {
  id: CruxID
  spaceId?: CruxID
  name: string
  description?: string
  /** 技能内容：动手前检查 / 改后验证 / 汇报格式 */
  content: string
  createdAt: string
}

export interface CruxCrewMemberRef {
  kind: 'agent' | 'member'
  id: CruxID
  name: string
}

export interface CruxCrew {
  id: CruxID
  spaceId: CruxID
  name: string
  description?: string
  instructions?: string
  /** 本地名册中的负责人，不代表认证或权限授权 */
  ownerId?: CruxID
  archived?: boolean
  captain: CruxCrewMemberRef
  members: CruxCrewMemberRef[]
  createdAt: string
}

/* ---------------- 快照与输入 ---------------- */

export interface CruxSnapshot {
  spaces: CruxSpace[]
  members: CruxMember[]
  taskTypes: CruxTaskType[]
  taskStatuses: CruxTaskStatus[]
  taskLabels: CruxTaskLabel[]
  tasks: CruxTask[]
  comments: CruxComment[]
  activities: CruxActivity[]
  projects: CruxProject[]
  iterations: CruxIteration[]
  versionDeliveries?: CruxVersionDelivery[]
  milestones?: CruxMilestone[]
  views: CruxView[]
  triageDecisions: CruxTriageDecision[]
  automations: CruxAutomation[]
  inbox: CruxInboxItem[]
  agents: CruxAgent[]
  skills: CruxSkill[]
  crews: CruxCrew[]
}

export interface CruxTaskInput {
  spaceId: CruxID
  creatorId?: CruxID
  title: string
  description?: string
  typeId?: CruxID
  statusId?: CruxID
  priority?: CruxPriority
  assigneeIds?: CruxID[]
  executor?: CruxExecutorRef | null
  labelIds?: CruxID[]
  projectId?: CruxID | null
  iterationIds?: CruxID[]
  parentTaskId?: CruxID | null
  triagePending?: boolean
  workKind?: CruxTaskWorkKind
  acceptanceCriteria?: string[]
}

export interface CruxTaskPatchInput {
  workKind?: CruxTaskWorkKind
  acceptanceCriteria?: string[]
  title?: string
  description?: string
  typeId?: CruxID | null
  statusId?: CruxID
  priority?: CruxPriority
  assigneeIds?: CruxID[]
  executor?: CruxExecutorRef | null
  labelIds?: CruxID[]
  projectId?: CruxID | null
  iterationIds?: CruxID[]
  followerToggle?: CruxID
  parentTaskId?: CruxID | null
}

export interface CruxAgentInput {
  spaceId: CruxID
  name: string
  description?: string
  instructions: string
  skillIds?: CruxID[]
  repositories?: Array<{ name: string; url?: string }>
  runtimeKind?: CruxRuntimeKind
  workingDirectory?: CruxWorkingDirectoryMode
  enabled?: boolean
  archived?: boolean
}

export interface CruxCrewInput {
  id?: CruxID
  spaceId: CruxID
  name: string
  description?: string
  instructions?: string
  ownerId?: CruxID | null
  captainAgentId?: CruxID
  captainMemberId?: CruxID
  memberRefs: Array<{ kind: 'agent' | 'member'; id: CruxID }>
  exclusiveAgentIds?: CruxID[]
  archived?: boolean
}

export interface CruxAutomationInput {
  spaceId: CruxID
  name: string
  enabled?: boolean
  trigger: CruxAutomationTrigger
  target: CruxAutomationTarget
  instruction?: string
  projectId?: CruxID
}

/* ---------------- 渲染层 API 契约（preload satisfies） ---------------- */

export interface CruxFailure { ok: false; error: string; context?: CruxWorkspaceContext; code?: string; outcomeUnknown?: boolean; pending?: boolean }
export interface CruxPendingCommand { commandId: string; operation: string; state: string; outcomeUnknown: boolean; errorCode: string | null; createdAt: number }

export interface CruxApi {
  workspacePending: () => Promise<{ ok: true; data: CruxPendingCommand[] } | CruxFailure>
  discardWorkspaceCommand: (input: { commandId: string }) => Promise<{ ok: true; context: CruxWorkspaceContext } | CruxFailure>
  workspaceStatus: () => Promise<{ ok: true; context: CruxWorkspaceContext } | CruxFailure>
  selectWorkspace: (input: { connectionId: string | null }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  retryWorkspaceCommand: (input: { commandId: string }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  onWorkspaceChanged: (callback: (context: CruxWorkspaceContext) => void) => () => void

  snapshot: () => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>

  /** 分拣台待办队列（含优先级建议） */
  triageQueue: (spaceId: CruxID) => Promise<{ ok: true; data: Array<{ task: CruxTask; suggested: 'urgent' | 'high' | 'medium' | 'low'; reason: string }> } | CruxFailure>

  createSpace: (input: { name: string; key: string; description?: string; visibility?: 'public' | 'private'; initialTaskTypes?: CruxInitialTaskType[] }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  updateSpace: (input: { id: CruxID; name?: string; description?: string; multiAssignee?: boolean; visibility?: 'public' | 'private'; archived?: boolean }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  joinSpace: (input: { spaceId: CruxID; memberId?: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>

  inviteMember: (input: { name: string; email?: string; title?: string; role?: CruxRole; spaceId?: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  updateMember: (input: { id: CruxID; name?: string; email?: string; title?: string; role?: CruxRole }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  removeMember: (input: { id: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  setSpaceMembers: (input: { spaceId: CruxID; memberIds: CruxID[] }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>

  createTaskType: (input: { spaceId: CruxID; name: string; requiredHints?: string[]; statusIds?: CruxID[] }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  updateTaskType: (input: { id: CruxID; name?: string; statusIds?: CruxID[] }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  removeTaskType: (input: { id: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  createTaskStatus: (input: { spaceId: CruxID; name: string; category: CruxStatusCategory }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  removeTaskStatus: (input: { id: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  createLabel: (input: { spaceId?: CruxID; name: string; color?: string }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  archiveLabel: (input: { id: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>

  createTask: (input: CruxTaskInput) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext; taskId: CruxID } | CruxFailure>
  updateTask: (input: { id: CruxID; patch: CruxTaskPatchInput }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  transitionTask: (input: CruxTransitionTaskInput) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  recordTaskDelivery: (input: RecordTaskDeliveryInput) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  removeTask: (input: { id: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  addRelation: (input: { taskId: CruxID; relation: CruxTaskRelation }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  removeRelation: (input: { taskId: CruxID; targetTaskId: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>

  addComment: (input: { taskId: CruxID; body: string; authorId: string; parentId?: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  resolveComment: (input: { id: CruxID; resolved: boolean }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>

  createProject: (input: { spaceId: CruxID; name: string; goal?: string; ownerIds?: CruxID[] }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  updateProject: (input: { id: CruxID; name?: string; goal?: string; ownerIds?: CruxID[]; status?: CruxProject['status'] }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>

  createIteration: (input: { spaceId: CruxID; name: string; goal?: string; startDate: string; endDate: string; taskIds?: CruxID[]; predecessorId?: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  updateIteration: (input: { id: CruxID; name?: string; goal?: string; startDate?: string; endDate?: string; status?: CruxIteration['status']; taskIds?: CruxID[]; predecessorId?: CruxID | null }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  /** Reject unfinished scope; carryOver is accepted for old callers and never moves work. */
  completeIteration: (input: { id: CruxID; carryOver?: 'backlog' | 'next' }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  recordVersionDelivery: (input: CruxRecordVersionDeliveryInput) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  saveMilestone: (input: CruxSaveMilestoneInput) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  completeMilestone: (input: CruxMilestoneCommandInput) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  removeMilestone: (input: CruxMilestoneCommandInput) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>

  saveView: (input: { id?: CruxID; spaceId: CruxID; name: string; filter: CruxViewFilter; groupBy: CruxView['groupBy'] }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  removeView: (input: { id: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>

  triage: (input: Omit<CruxTriageDecision, 'at'> & { assigneeIds?: CruxID[]; iterationId?: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>

  saveAutomation: (input: CruxAutomationInput & { id?: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  toggleAutomation: (input: { id: CruxID; enabled: boolean }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  removeAutomation: (input: { id: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  /** 手动触发一次（用于验证规则；Agent 目标只登记等待 Runtime） */
  runAutomation: (input: { id: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>

  markInboxRead: (input: { ids?: CruxID[]; all?: boolean; section?: CruxInboxSection }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  /** 稍后处理（REA 实测选项：20 分钟 / 2 小时 / 明天 / 下周） */
  snoozeInbox: (input: { id: CruxID; option: '20m' | '2h' | 'tomorrow' | 'nextweek' }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  /** 清理通知：移入「已清理」，可恢复；不删除任务/评论/活动 */
  clearInbox: (input: { ids?: CruxID[]; all?: boolean; section?: CruxInboxSection }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  restoreInbox: (input: { id: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>

  saveAgent: (input: CruxAgentInput & { id?: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  /** 归档 Agent，保留历史引用；saveAgent({ archived:false, ... }) 恢复。 */
  removeAgent: (input: { id: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>

  saveSkill: (input: { id?: CruxID; name: string; description?: string; content: string; spaceId?: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  removeSkill: (input: { id: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>

  saveCrew: (input: CruxCrewInput) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
  /** 归档小队，保留名册和历史引用；saveCrew({ archived:false, ... }) 恢复。 */
  removeCrew: (input: { id: CruxID }) => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>

  /** 重置演示数据 */
  resetDemo: () => Promise<{ ok: true; data: CruxSnapshot; context?: CruxWorkspaceContext } | CruxFailure>
}
