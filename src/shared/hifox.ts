import type { HifoxWorkspaceContext } from './hifox-remote'
import type { TeamRole } from './team-platform'
import type { z } from 'zod'
import type { RecordTaskDeliveryInput } from './task-delivery'
import type {
  hifoxTaskWorkKindSchema, hifoxTaskStageSchema, hifoxTaskActionSchema,
  hifoxTaskWorkflowArtifactSchema, hifoxTaskWorkflowEventSchema, hifoxTaskWorkflowSchema,
  hifoxTransitionTaskInputSchema, hifoxVersionDeliverySchema, hifoxRecordVersionDeliveryInputSchema,
  hifoxMilestoneSchema, hifoxSaveMilestoneInputSchema, hifoxMilestoneCommandInputSchema, hifoxInitialTaskTypeSchema
} from './hifox-schema'

export type HifoxInitialTaskType = z.infer<typeof hifoxInitialTaskTypeSchema>
export type HifoxTaskWorkKind = z.infer<typeof hifoxTaskWorkKindSchema>
export type HifoxTaskStage = z.infer<typeof hifoxTaskStageSchema>
export type HifoxTaskAction = z.infer<typeof hifoxTaskActionSchema>
export type HifoxTaskWorkflowArtifact = z.infer<typeof hifoxTaskWorkflowArtifactSchema>
export type HifoxTaskWorkflowEvent = z.infer<typeof hifoxTaskWorkflowEventSchema>
export type HifoxTaskWorkflow = z.infer<typeof hifoxTaskWorkflowSchema>
export type HifoxTransitionTaskInput = z.infer<typeof hifoxTransitionTaskInputSchema>
export type HifoxVersionDelivery = z.infer<typeof hifoxVersionDeliverySchema>
export type HifoxRecordVersionDeliveryInput = z.infer<typeof hifoxRecordVersionDeliveryInputSchema>
export type HifoxMilestone = z.infer<typeof hifoxMilestoneSchema>
export type HifoxSaveMilestoneInput = z.infer<typeof hifoxSaveMilestoneInputSchema>
export type HifoxMilestoneCommandInput = z.infer<typeof hifoxMilestoneCommandInputSchema>
export type {
  AdoptTaskDeliveryProtocol, RequirementBaseline, RequirementBaselineInput, TaskDelivery, TaskDeliveryInput,
  TaskDeliveryState, TaskDeliveryRoles, TaskTestRun, TaskTestRunInput, TaskMaterialReference,
  TaskDeliveryEventLinks, TaskDeliveryDependencies, RecordTaskDeliveryInput
} from './task-delivery'

/**
 * 本机与共享协作域契约；桌面、浏览器和服务端复用同一套领域规则。
 * 参考 docs/prd-hifox 的任务、空间与 Agent 配置约束。
 * Agent 指派只记录排队或等待运行环境，不代表已启动实际执行。
 */

/* ---------------- 基础 ---------------- */

export type HifoxID = string

export type HifoxRole = 'owner' | 'admin' | 'member'

export type HifoxPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none'

/** 状态类别：与 PRD 3.2/4.4 的七类状态一一对应；Agent 仅在 todo / in_progress 等待 Runtime 执行 */
export type HifoxStatusCategory =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'blocked'
  | 'cancelled'

/** 任务关联类型（PRD 4.5） */
export type HifoxTaskRelationKind = 'blocks' | 'related' | 'duplicate'

/** 处理人执行槽：Agent / 小队单独占一个槽，不进入人员集合（PRD 3.2） */
export interface HifoxExecutorRef {
  kind: 'agent' | 'crew'
  id: HifoxID
  name: string
}

/** 任务对 Agent 的派发状态（PRD 2.2 的边界内实现：到「等待 Runtime」为止） */
export interface HifoxDispatchState {
  status: 'queued' | 'waiting_runtime'
  since: string
  note?: string
}

/* ---------------- 空间与成员 ---------------- */

export interface HifoxSpace {
  id: HifoxID
  name: string
  /** 任务 ID 前缀，如 ENG */
  key: string
  description?: string
  /** Missing visibility preserves existing organization-public spaces. */
  visibility?: 'public' | 'private'
  ownerId?: HifoxID
  archived?: boolean
  /** 多人处理人开关（PRD 3.2：开启后一条任务可有多名人员处理人） */
  multiAssignee: boolean
  memberIds: HifoxID[]
  /** 任务编号自增游标 */
  taskSeq: number
  createdAt: string
}

export interface HifoxMember {
  id: HifoxID
  name: string
  email?: string
  title?: string
  role: HifoxRole
  /** Authenticated project responsibilities, projected by the team service. */
  projectRoles?: TeamRole[]
  avatarHue: number
  joinedAt: string
}

/* ---------------- 任务配置（类型/状态/标签） ---------------- */

export interface HifoxTaskType {
  id: HifoxID
  spaceId: HifoxID
  name: string
  /** 需要补充的提示字段，如 Bug 需要复现步骤 */
  requiredHints?: string[]
  /** 类型可用状态（两层模型，PRD 4.4 规则1）：未设置时沿用空间全部状态 */
  statusIds?: HifoxID[]
  isDefault?: boolean
}

export interface HifoxTaskStatus {
  id: HifoxID
  spaceId: HifoxID
  name: string
  category: HifoxStatusCategory
  order: number
}

export interface HifoxTaskLabel {
  id: HifoxID
  /** 空间标签归属空间；组织标签 spaceId 为空、所有空间可用（PRD 4.3 规则4） */
  spaceId?: HifoxID
  name: string
  color: string
  archived?: boolean
}

/* ---------------- 任务 / 评论 / 活动 / 关联 ---------------- */

export interface HifoxTaskRelation {
  kind: HifoxTaskRelationKind
  taskId: HifoxID
}

export interface HifoxTask {
  id: HifoxID
  spaceId: HifoxID
  title: string
  description?: string
  typeId?: HifoxID
  statusId: HifoxID
  priority: HifoxPriority
  /** 人员处理人集合：multiAssignee 关闭时最多 1 人 */
  assigneeIds: HifoxID[]
  /** 执行槽：Agent 或小队（单选） */
  executor?: HifoxExecutorRef
  creatorId: HifoxID
  labelIds: HifoxID[]
  projectId?: HifoxID
  iterationIds: HifoxID[]
  parentTaskId?: HifoxID
  relations: HifoxTaskRelation[]
  followerIds: HifoxID[]
  dispatch?: HifoxDispatchState
  triagePending?: boolean
  workKind?: HifoxTaskWorkKind
  acceptanceCriteria?: string[]
  workflow?: HifoxTaskWorkflow
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface HifoxComment {
  id: HifoxID
  taskId: HifoxID
  /** 作者：成员 id 或 `agent:<id>` */
  authorId: string
  body: string
  mentions: HifoxID[]
  createdAt: string
  resolved?: boolean
  parentId?: HifoxID
}

export interface HifoxActivity {
  id: HifoxID
  taskId: HifoxID
  /** 字段变更 / 状态流转 / 派发 / 评论 等 */
  kind: string
  text: string
  at: string
}

/* ---------------- 专项 / 迭代 / 视图 / 分拣台 ---------------- */

export interface HifoxProject {
  id: HifoxID
  spaceId: HifoxID
  name: string
  goal?: string
  status: 'active' | 'done' | 'archived'
  ownerIds: HifoxID[]
  createdAt: string
}

export interface HifoxIteration {
  id: HifoxID
  spaceId: HifoxID
  name: string
  goal?: string
  startDate: string
  endDate: string
  status: 'pending' | 'active' | 'completed'
  taskIds: HifoxID[]
  predecessorId?: HifoxID
}

export interface HifoxViewFilter {
  keyword?: string
  statusIds?: HifoxID[]
  typeIds?: HifoxID[]
  labelIds?: HifoxID[]
  assigneeIds?: HifoxID[]
  priorities?: HifoxPriority[]
  iterationId?: HifoxID
  projectId?: HifoxID
}

export interface HifoxView {
  id: HifoxID
  spaceId: HifoxID
  name: string
  filter: HifoxViewFilter
  groupBy: 'status' | 'assignee' | 'type' | 'priority'
  pinned?: boolean
}

/** 分拣台处置动作（PRD 3.7：优先级判定后四种处置） */
export type HifoxTriageDisposition =
  | 'assign'        // 指派处理人推进
  | 'iterate'       // 放入迭代
  | 'park'          // 暂回 Backlog 待定
  | 'close'         // 关闭不再处理

export interface HifoxTriageDecision {
  taskId: HifoxID
  disposition: HifoxTriageDisposition
  at: string
  actorId?: HifoxID
  note?: string
}

/* ---------------- 自动化（PRD 3.8；Agent 动作到「等待 Runtime」为止） ---------------- */

export type HifoxAutomationTriggerKind =
  | 'schedule'      // 定时：cron 简化表达 {timeOfDay, days[]}
  | 'task_status'   // 任务进入某状态
  | 'task_created'  // 新任务创建
  | 'comment'       // 评论包含关键词

export interface HifoxAutomationTrigger {
  kind: HifoxAutomationTriggerKind
  /** schedule: "09:00"；task_status: 状态 id；comment: 关键词 */
  value?: string
  /** schedule 限定星期（1-7），空为每天 */
  days?: number[]
}

export interface HifoxAutomationTarget {
  kind: 'agent' | 'crew' | 'member' | 'none'
  id?: HifoxID
  name?: string
}

export interface HifoxAutomationRun {
  id: HifoxID
  at: string
  trigger: string
  outcome: 'done' | 'waiting_runtime' | 'skipped'
  detail?: string
}

export interface HifoxAutomation {
  id: HifoxID
  spaceId: HifoxID
  name: string
  creatorId?: HifoxID
  enabled: boolean
  lastScheduledDate?: string
  trigger: HifoxAutomationTrigger
  target: HifoxAutomationTarget
  instruction?: string
  projectId?: HifoxID
  lastRunAt?: string
  runs: HifoxAutomationRun[]
}

/* ---------------- 收件箱（PRD 2.6 + REA 实测校准） ---------------- */

/** 事件类型：决定进入「重要」还是「其他」（REA 实测：执行异常/@提及/被指派 → 重要） */
export type HifoxInboxKind =
  | 'assign'         // 任务指派给你或处理人变化
  | 'mention'        // 评论 @ 你
  | 'status'         // 关注任务的状态/优先级变化
  | 'dispatch'       // Agent 派发状态（等待 Runtime / 执行异常）
  | 'automation'     // 自动化或汇报结果
  | 'triage'         // 分拣台责任提醒（「此任务需要你分拣」）

export type HifoxInboxSection = 'important' | 'other'

export interface HifoxInboxItem {
  id: HifoxID
  section: HifoxInboxSection
  kind: HifoxInboxKind
  title: string
  body?: string
  /** 同一任务的通知在 UI 上聚合为一行（任务级提醒） */
  taskId?: HifoxID
  /** Space scope also applies to automation reminders without a task. */
  spaceId?: HifoxID
  at: string
  read: boolean
  recipientIds?: HifoxID[]
  /** 稍后处理：到时回对应分区；期间从活跃列表隐藏 */
  snoozedUntil?: string
  /** 已清理：可恢复，清理不删除任务/评论/活动 */
  cleared?: boolean
}

/* ---------------- Agent / 技能 / 小队（配置层，PRD 2.1/2.9/2.10） ---------------- */

/** Runtime 仅作为配置引用，不建立连接（Runtime 模块另行接入） */
export type HifoxRuntimeKind = 'claude-code' | 'codex' | 'custom'

export type HifoxWorkingDirectoryMode = 'repo' | 'temp'

export interface HifoxAgent {
  id: HifoxID
  spaceId: HifoxID
  name: string
  description?: string
  /** 职责与工作方式指令 */
  instructions: string
  skillIds: HifoxID[]
  /** 代码库引用（名称级，连接由 runtime 模块负责） */
  repositories: Array<{ name: string; url?: string }>
  runtimeKind: HifoxRuntimeKind
  workingDirectory: HifoxWorkingDirectoryMode
  enabled: boolean
  archived?: boolean
  /** 独占使用该 Agent 的小队；由小队成员配置维护 */
  exclusiveCrewId?: HifoxID
  createdAt: string
}

export interface HifoxSkill {
  id: HifoxID
  spaceId?: HifoxID
  name: string
  description?: string
  /** 技能内容：动手前检查 / 改后验证 / 汇报格式 */
  content: string
  createdAt: string
}

export interface HifoxCrewMemberRef {
  kind: 'agent' | 'member'
  id: HifoxID
  name: string
}

export interface HifoxCrew {
  id: HifoxID
  spaceId: HifoxID
  name: string
  description?: string
  instructions?: string
  /** 本地名册中的负责人，不代表认证或权限授权 */
  ownerId?: HifoxID
  archived?: boolean
  captain: HifoxCrewMemberRef
  members: HifoxCrewMemberRef[]
  createdAt: string
}

/* ---------------- 快照与输入 ---------------- */

export interface HifoxSnapshot {
  spaces: HifoxSpace[]
  members: HifoxMember[]
  taskTypes: HifoxTaskType[]
  taskStatuses: HifoxTaskStatus[]
  taskLabels: HifoxTaskLabel[]
  tasks: HifoxTask[]
  comments: HifoxComment[]
  activities: HifoxActivity[]
  projects: HifoxProject[]
  iterations: HifoxIteration[]
  versionDeliveries?: HifoxVersionDelivery[]
  milestones?: HifoxMilestone[]
  views: HifoxView[]
  triageDecisions: HifoxTriageDecision[]
  automations: HifoxAutomation[]
  inbox: HifoxInboxItem[]
  agents: HifoxAgent[]
  skills: HifoxSkill[]
  crews: HifoxCrew[]
}

export interface HifoxTaskInput {
  spaceId: HifoxID
  creatorId?: HifoxID
  title: string
  description?: string
  typeId?: HifoxID
  statusId?: HifoxID
  priority?: HifoxPriority
  assigneeIds?: HifoxID[]
  executor?: HifoxExecutorRef | null
  labelIds?: HifoxID[]
  projectId?: HifoxID | null
  iterationIds?: HifoxID[]
  parentTaskId?: HifoxID | null
  triagePending?: boolean
  workKind?: HifoxTaskWorkKind
  acceptanceCriteria?: string[]
}

export interface HifoxTaskPatchInput {
  workKind?: HifoxTaskWorkKind
  acceptanceCriteria?: string[]
  title?: string
  description?: string
  typeId?: HifoxID | null
  statusId?: HifoxID
  priority?: HifoxPriority
  assigneeIds?: HifoxID[]
  executor?: HifoxExecutorRef | null
  labelIds?: HifoxID[]
  projectId?: HifoxID | null
  iterationIds?: HifoxID[]
  followerToggle?: HifoxID
  parentTaskId?: HifoxID | null
}

export interface HifoxAgentInput {
  spaceId: HifoxID
  name: string
  description?: string
  instructions: string
  skillIds?: HifoxID[]
  repositories?: Array<{ name: string; url?: string }>
  runtimeKind?: HifoxRuntimeKind
  workingDirectory?: HifoxWorkingDirectoryMode
  enabled?: boolean
  archived?: boolean
}

export interface HifoxCrewInput {
  id?: HifoxID
  spaceId: HifoxID
  name: string
  description?: string
  instructions?: string
  ownerId?: HifoxID | null
  captainAgentId?: HifoxID
  captainMemberId?: HifoxID
  memberRefs: Array<{ kind: 'agent' | 'member'; id: HifoxID }>
  exclusiveAgentIds?: HifoxID[]
  archived?: boolean
}

export interface HifoxAutomationInput {
  spaceId: HifoxID
  name: string
  enabled?: boolean
  trigger: HifoxAutomationTrigger
  target: HifoxAutomationTarget
  instruction?: string
  projectId?: HifoxID
}

/* ---------------- 渲染层 API 契约（preload satisfies） ---------------- */

export interface HifoxFailure { ok: false; error: string; context?: HifoxWorkspaceContext; code?: string; outcomeUnknown?: boolean; pending?: boolean }
export interface HifoxPendingCommand { commandId: string; operation: string; state: string; outcomeUnknown: boolean; errorCode: string | null; createdAt: number }

export interface HifoxApi {
  workspacePending: () => Promise<{ ok: true; data: HifoxPendingCommand[] } | HifoxFailure>
  discardWorkspaceCommand: (input: { commandId: string }) => Promise<{ ok: true; context: HifoxWorkspaceContext } | HifoxFailure>
  workspaceStatus: () => Promise<{ ok: true; context: HifoxWorkspaceContext } | HifoxFailure>
  selectWorkspace: (input: { connectionId: string | null }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  retryWorkspaceCommand: (input: { commandId: string }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  onWorkspaceChanged: (callback: (context: HifoxWorkspaceContext) => void) => () => void

  snapshot: () => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>

  /** 分拣台待办队列（含优先级建议） */
  triageQueue: (spaceId: HifoxID) => Promise<{ ok: true; data: Array<{ task: HifoxTask; suggested: 'urgent' | 'high' | 'medium' | 'low'; reason: string }> } | HifoxFailure>

  createSpace: (input: { name: string; key: string; description?: string; visibility?: 'public' | 'private'; initialTaskTypes?: HifoxInitialTaskType[] }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  updateSpace: (input: { id: HifoxID; name?: string; description?: string; multiAssignee?: boolean; visibility?: 'public' | 'private'; archived?: boolean }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  joinSpace: (input: { spaceId: HifoxID; memberId?: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>

  inviteMember: (input: { name: string; email?: string; title?: string; role?: HifoxRole; spaceId?: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  updateMember: (input: { id: HifoxID; name?: string; email?: string; title?: string; role?: HifoxRole }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  removeMember: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  setSpaceMembers: (input: { spaceId: HifoxID; memberIds: HifoxID[] }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>

  createTaskType: (input: { spaceId: HifoxID; name: string; requiredHints?: string[]; statusIds?: HifoxID[] }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  updateTaskType: (input: { id: HifoxID; name?: string; statusIds?: HifoxID[] }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  removeTaskType: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  createTaskStatus: (input: { spaceId: HifoxID; name: string; category: HifoxStatusCategory }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  removeTaskStatus: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  createLabel: (input: { spaceId?: HifoxID; name: string; color?: string }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  archiveLabel: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>

  createTask: (input: HifoxTaskInput) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext; taskId: HifoxID } | HifoxFailure>
  updateTask: (input: { id: HifoxID; patch: HifoxTaskPatchInput }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  transitionTask: (input: HifoxTransitionTaskInput) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  recordTaskDelivery: (input: RecordTaskDeliveryInput) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  removeTask: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  addRelation: (input: { taskId: HifoxID; relation: HifoxTaskRelation }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  removeRelation: (input: { taskId: HifoxID; targetTaskId: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>

  addComment: (input: { taskId: HifoxID; body: string; authorId: string; parentId?: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  resolveComment: (input: { id: HifoxID; resolved: boolean }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>

  createProject: (input: { spaceId: HifoxID; name: string; goal?: string; ownerIds?: HifoxID[] }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  updateProject: (input: { id: HifoxID; name?: string; goal?: string; ownerIds?: HifoxID[]; status?: HifoxProject['status'] }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>

  createIteration: (input: { spaceId: HifoxID; name: string; goal?: string; startDate: string; endDate: string; taskIds?: HifoxID[]; predecessorId?: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  updateIteration: (input: { id: HifoxID; name?: string; goal?: string; startDate?: string; endDate?: string; status?: HifoxIteration['status']; taskIds?: HifoxID[]; predecessorId?: HifoxID | null }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  /** Reject unfinished scope; carryOver is accepted for old callers and never moves work. */
  completeIteration: (input: { id: HifoxID; carryOver?: 'backlog' | 'next' }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  recordVersionDelivery: (input: HifoxRecordVersionDeliveryInput) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  saveMilestone: (input: HifoxSaveMilestoneInput) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  completeMilestone: (input: HifoxMilestoneCommandInput) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  removeMilestone: (input: HifoxMilestoneCommandInput) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>

  saveView: (input: { id?: HifoxID; spaceId: HifoxID; name: string; filter: HifoxViewFilter; groupBy: HifoxView['groupBy'] }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  removeView: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>

  triage: (input: Omit<HifoxTriageDecision, 'at'> & { assigneeIds?: HifoxID[]; iterationId?: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>

  saveAutomation: (input: HifoxAutomationInput & { id?: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  toggleAutomation: (input: { id: HifoxID; enabled: boolean }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  removeAutomation: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  /** 手动触发一次（用于验证规则；Agent 目标只登记等待 Runtime） */
  runAutomation: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>

  markInboxRead: (input: { ids?: HifoxID[]; all?: boolean; section?: HifoxInboxSection }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  /** 稍后处理（REA 实测选项：20 分钟 / 2 小时 / 明天 / 下周） */
  snoozeInbox: (input: { id: HifoxID; option: '20m' | '2h' | 'tomorrow' | 'nextweek' }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  /** 清理通知：移入「已清理」，可恢复；不删除任务/评论/活动 */
  clearInbox: (input: { ids?: HifoxID[]; all?: boolean; section?: HifoxInboxSection }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  restoreInbox: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>

  saveAgent: (input: HifoxAgentInput & { id?: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  /** 归档 Agent，保留历史引用；saveAgent({ archived:false, ... }) 恢复。 */
  removeAgent: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>

  saveSkill: (input: { id?: HifoxID; name: string; description?: string; content: string; spaceId?: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  removeSkill: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>

  saveCrew: (input: HifoxCrewInput) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
  /** 归档小队，保留名册和历史引用；saveCrew({ archived:false, ... }) 恢复。 */
  removeCrew: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>

  /** 重置演示数据 */
  resetDemo: () => Promise<{ ok: true; data: HifoxSnapshot; context?: HifoxWorkspaceContext } | HifoxFailure>
}
