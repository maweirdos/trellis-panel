/**
 * HiFox 协作域共享类型 —— 主进程服务与渲染层的唯一契约。
 *
 * 对应需求文档：docs/prd-hifox/（第1~4、6章 + 第2章 Agent 配置层）。
 * 明确排除（Runtime 与集成进行中，另行接入）：
 *  - 第2章的电脑/Runtime 连接、Agent 实际执行、与 Agent 对话（执行依赖 Runtime）；
 *  - 第5章 导入与集成、第7章 CLI（Runtime/电脑连接工具）。
 * 任务指派给 Agent 后只推进到「排队中（等待 Runtime）」，执行边界由 runtime 模块接入后打通。
 */

/* ---------------- 基础 ---------------- */

export type HifoxID = string

export type HifoxRole = 'owner' | 'admin' | 'member'

export type HifoxPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none'

/** 状态类别：与 PRD 3.2/4.4 的七类状态一一对应；Agent 仅在 todo 及之后的类别下执行 */
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
}

export interface HifoxViewFilter {
  keyword?: string
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
  enabled: boolean
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
  at: string
  read: boolean
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
  captain: { kind: 'agent'; id: HifoxID; name: string }
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
}

export interface HifoxTaskPatchInput {
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

export interface HifoxApi {
  snapshot: () => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>

  /** 分拣台待办队列（含优先级建议） */
  triageQueue: (spaceId: HifoxID) => Promise<{ ok: true; data: Array<{ task: HifoxTask; suggested: 'urgent' | 'high' | 'medium' | 'low'; reason: string }> } | { ok: false; error: string }>

  createSpace: (input: { name: string; key: string; description?: string }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  updateSpace: (input: { id: HifoxID; name?: string; description?: string; multiAssignee?: boolean }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>

  inviteMember: (input: { name: string; email?: string; title?: string; role?: HifoxRole; spaceId?: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  updateMember: (input: { id: HifoxID; name?: string; title?: string; role?: HifoxRole }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  removeMember: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  setSpaceMembers: (input: { spaceId: HifoxID; memberIds: HifoxID[] }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>

  createTaskType: (input: { spaceId: HifoxID; name: string; requiredHints?: string[]; statusIds?: HifoxID[] }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  updateTaskType: (input: { id: HifoxID; name?: string; statusIds?: HifoxID[] }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  removeTaskType: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  createTaskStatus: (input: { spaceId: HifoxID; name: string; category: HifoxStatusCategory }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  removeTaskStatus: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  createLabel: (input: { spaceId?: HifoxID; name: string; color?: string }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  archiveLabel: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>

  createTask: (input: HifoxTaskInput) => Promise<{ ok: true; data: HifoxSnapshot; taskId: HifoxID } | { ok: false; error: string }>
  updateTask: (input: { id: HifoxID; patch: HifoxTaskPatchInput }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  removeTask: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  addRelation: (input: { taskId: HifoxID; relation: HifoxTaskRelation }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  removeRelation: (input: { taskId: HifoxID; targetTaskId: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>

  addComment: (input: { taskId: HifoxID; body: string; authorId: string }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  resolveComment: (input: { id: HifoxID; resolved: boolean }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>

  createProject: (input: { spaceId: HifoxID; name: string; goal?: string; ownerIds?: HifoxID[] }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  updateProject: (input: { id: HifoxID; name?: string; goal?: string; status?: HifoxProject['status'] }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>

  createIteration: (input: { spaceId: HifoxID; name: string; goal?: string; startDate: string; endDate: string; taskIds?: HifoxID[] }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  updateIteration: (input: { id: HifoxID; name?: string; goal?: string; status?: HifoxIteration['status']; taskIds?: HifoxID[] }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  /** 结束迭代：未完成任务顺延（PRD 3.6） */
  completeIteration: (input: { id: HifoxID; carryOver: 'backlog' | 'next' }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>

  saveView: (input: { spaceId: HifoxID; name: string; filter: HifoxViewFilter; groupBy: HifoxView['groupBy'] }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  removeView: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>

  triage: (input: Omit<HifoxTriageDecision, 'at'> & { assigneeIds?: HifoxID[]; iterationId?: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>

  saveAutomation: (input: HifoxAutomationInput & { id?: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  toggleAutomation: (input: { id: HifoxID; enabled: boolean }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  removeAutomation: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  /** 手动触发一次（用于验证规则；Agent 目标只登记等待 Runtime） */
  runAutomation: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>

  markInboxRead: (input: { ids?: HifoxID[]; all?: boolean; section?: HifoxInboxSection }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  /** 稍后处理（REA 实测选项：20 分钟 / 2 小时 / 明天 / 下周） */
  snoozeInbox: (input: { id: HifoxID; option: '20m' | '2h' | 'tomorrow' | 'nextweek' }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  /** 清理通知：移入「已清理」，可恢复；不删除任务/评论/活动 */
  clearInbox: (input: { ids?: HifoxID[]; all?: boolean; section?: HifoxInboxSection }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  restoreInbox: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>

  saveAgent: (input: HifoxAgentInput & { id?: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  removeAgent: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>

  saveSkill: (input: { id?: HifoxID; name: string; description?: string; content: string; spaceId?: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  removeSkill: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>

  saveCrew: (input: { id?: HifoxID; spaceId: HifoxID; name: string; description?: string; captainAgentId: HifoxID; memberRefs: Array<{ kind: 'agent' | 'member'; id: HifoxID }> }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
  removeCrew: (input: { id: HifoxID }) => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>

  /** 重置演示数据 */
  resetDemo: () => Promise<{ ok: true; data: HifoxSnapshot } | { ok: false; error: string }>
}
