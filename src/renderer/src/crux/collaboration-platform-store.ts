import { create } from 'zustand'
import type { CruxRuntimeKind, CruxSnapshot, CruxTask, CruxWorkingDirectoryMode } from '@shared/crux'

export type IsolationMode = 'worktree' | 'in_place'
export type AgentVisibility = 'space' | 'personal'
export type WorkflowMode = 'simple' | 'strict'
export type EffortEmblemStyle = 'logo' | 'sun' | 'moon' | 'star' | 'crux' | 'eclipse'
export type EffortTrackTone = 'amber' | 'teal' | 'jade' | 'glacier'
const EFFORT_TRACK_TONES: ReadonlySet<EffortTrackTone> = new Set(['amber', 'teal', 'jade', 'glacier'])

const EFFORT_EMBLEM_STYLES: ReadonlySet<EffortEmblemStyle> = new Set(['logo', 'sun', 'moon', 'star', 'crux', 'eclipse'])

export interface EnvPair {
  key: string
  value: string
}

export interface CustomRuntimeConfig {
  id: string
  displayName: string
  base: CruxRuntimeKind | 'acp'
  command: string
  args: string[]
  env: EnvPair[]
  manualModels: string[]
  description: string
  archived: boolean
  createdAt: string
  updatedAt: string
}

export interface RuntimeLaunchConfig {
  args: string[]
  env: EnvPair[]
  manualModels: string[]
  isolationMode: IsolationMode
  /** 当前引擎默认偏好的思考强度档位（例如 'medium' / 'high' / 'xhigh'） */
  defaultReasoningEffort?: string
  /** 按模型 ID 持久化的默认思考强度档位 */
  reasoningEffortByModel?: Record<string, string>
}

export interface MachineCleanupPolicy {
  intervalHours: number
  terminalRetentionDays: number
  minFreeSpaceGiB: number
  repoCacheRetentionDays: number
  maxStorageUsageGiB: number
}

export interface AgentQuickReply {
  id: string
  label: string
  prompt: string
}

export interface AgentInstructionVersion {
  id: string
  instructions: string
  savedAt: string
  note?: string
}

export interface AgentMcpEndpoint {
  id: string
  name: string
  commandOrUrl: string
  enabled: boolean
}

export type GitAuthorMode = 'user_and_agent' | 'user' | 'owner' | 'computer' | 'manual'
export type AgentApprovalMode = 'follow_runtime' | 'ask' | 'auto'
export type AgentCollabMode = 'follow_runtime' | 'autonomous' | 'supervised'

export interface AgentTriggerConfig {
  onAssign: boolean
  onMention: boolean
  onDirectChat: boolean
  onCrewJoin?: boolean
  onWorkflowInvoke?: boolean
  imChannels: string[]
}

export interface AgentExtendedMeta {
  visibility: AgentVisibility
  isolationMode: IsolationMode
  customRuntimeId?: string
  concurrency: number
  approvalMode?: AgentApprovalMode
  collabMode?: AgentCollabMode
  knowledgeEnabled: boolean
  triggers: AgentTriggerConfig
  gitAuthorMode: GitAuthorMode
  gitAuthorName?: string
  gitAuthorEmail?: string
  coAuthoredBy?: boolean
  quickReplies: AgentQuickReply[]
  instructionVersions: AgentInstructionVersion[]
  mcpEndpoints: AgentMcpEndpoint[]
}

export interface TaskTypeWorkflowConfig {
  mode: WorkflowMode
  defaultStatusId?: string
  /** 源状态 ID -> 允许流转的目标状态 ID 列表 */
  transitions: Record<string, string[]>
  updatedAt: string
}

export interface AiTaskAction {
  id: string
  spaceId: string | null
  title: string
  description: string
  prompt: string
  pinned: boolean
  order: number
}

export interface TriageSnoozeEntry {
  until: string
  reason?: string
}

export interface GetStartedState {
  dismissed: boolean
  collapsed: boolean
  skipped: boolean
}

export type FavoriteKind = 'task' | 'space' | 'agent' | 'view'

export interface FavoriteItem {
  kind: FavoriteKind
  id: string
  spaceId?: string
  pinnedAt: string
}

export type EstimationScale = 'none' | 'fibonacci' | 'tshirt' | 'linear'

export interface SpaceExtendedSettings {
  triageOwnerId?: string
  triageAutoAgentId?: string
  triageReminderHours: number
  estimationScale: EstimationScale
}

export interface OrgInviteLinkConfig {
  enabled: boolean
  code: string
  defaultRole: 'member' | 'admin'
  updatedAt: string
}

export interface SkillMarketPreset {
  id: string
  name: string
  category: string
  description: string
  content: string
}

export const SKILL_MARKET_PRESETS: readonly SkillMarketPreset[] = [
  {
    id: 'skill-preset-code-review',
    name: 'PR 代码审查清单',
    category: '质量保障',
    description: '按阻断项、风险项与可维护性三层核查代码改动。',
    content: [
      '1. 核对需求验收标准是否全部覆盖，无遗漏边界条件。',
      '2. 检查空值、并发竞态、异常兜底与向后兼容性。',
      '3. 验证新增接口/状态变更无权限越界或数据污染风险。',
      '4. 输出结构化结论：阻断问题（必改）、风险建议、通过项。'
    ].join('\n')
  },
  {
    id: 'skill-preset-bug-triage',
    name: '缺陷根因定位与复现规范',
    category: '排障定位',
    description: '统一 Bug 排查流程，确保先复现、再定根因、后给最小修复。',
    content: [
      '1. 整理环境信息、前置数据与稳定复现步骤。',
      '2. 沿调用链与状态流定位第一处偏离预期的代码位置。',
      '3. 区分根因修复与临时止血，优先实施最小可行变更。',
      '4. 补充对应回归检查项，防止同类缺陷反复出现。'
    ].join('\n')
  },
  {
    id: 'skill-preset-release-gate',
    name: '版本发布前验收门禁',
    category: '交付发布',
    description: '上线前的构建、类型检查、回滚方案与变更说明核验。',
    content: [
      '1. 确认 typecheck、lint 与生产构建全部通过且无新增告警。',
      '2. 核对数据库/配置/本地存储结构具备向前兼容与回滚路径。',
      '3. 整理本次发布的核心变更点、影响模块与灰度/验证观察项。'
    ].join('\n')
  },
  {
    id: 'skill-preset-prd-spec',
    name: '需求澄清与验收标准撰写',
    category: '产品规划',
    description: '把口头想法转成可交付、可测试的任务描述与验收清单。',
    content: [
      '1. 用一两句话写清楚用户场景和目标收益，并明确非目标范围。',
      '2. 列出 3-6 条可客观验证的验收标准（输入 -> 行为 -> 结果）。',
      '3. 标注依赖方、权限边界与异常状态下的用户提示文案。'
    ].join('\n')
  },
  {
    id: 'skill-preset-ui-check',
    name: '前端交互与视觉走查',
    category: '界面体验',
    description: '覆盖浅/深色主题、三档密度、键盘焦点、空状态与异常态。',
    content: [
      '1. 核对表面层级、语义色与设计令牌，避免硬编码色值或局部圆角。',
      '2. 验证空态、加载态、报错态与窄屏响应式布局无溢出截断。',
      '3. 检查键盘 Tab 焦点顺序、快捷键冲突与减少动态效果模式。'
    ].join('\n')
  }
]

export interface AutomationPreset {
  id: string
  name: string
  description: string
  triggerKind: 'schedule' | 'task_status' | 'task_created' | 'comment'
  triggerValue: string
  days?: number[]
  instruction: string
}

export const AUTOMATION_PRESETS: readonly AutomationPreset[] = [
  {
    id: 'auto-preset-daily-standup',
    name: '每日早间受阻与高优任务汇总',
    description: '工作日 09:30 自动梳理受阻和高优先级任务并提醒负责人。',
    triggerKind: 'schedule',
    triggerValue: '09:30',
    days: [1, 2, 3, 4, 5],
    instruction: '汇总当前空间中处于「受阻」或「高/紧急」优先级的未完成任务，按责任人分组列出下一步建议。'
  },
  {
    id: 'auto-preset-triage-intake',
    name: '新任务自动初检与补全建议',
    description: '每当创建新任务时自动检查验收标准并给出拆解建议。',
    triggerKind: 'task_created',
    triggerValue: '',
    instruction: '读取新创建任务的标题和描述，如缺少验收标准或影响范围说明，自动补充初步拆解清单。'
  },
  {
    id: 'auto-preset-review-notify',
    name: '评论提及 @review 时触发自检',
    description: '讨论中出现 @review 关键词时立即介入核查。',
    triggerKind: 'comment',
    triggerValue: '@review',
    instruction: '结合任务描述与最新评论，对照验收标准输出结构化审查意见与潜在回归点。'
  }
]

export interface AgentMarketTemplate {
  id: string
  name: string
  category: string
  description: string
  runtimeKind: CruxRuntimeKind
  workingDirectory: CruxWorkingDirectoryMode
  isolationMode: IsolationMode
  instructions: string
  quickReplies: Array<{ label: string; prompt: string }>
}

export const AGENT_MARKET_TEMPLATES: readonly AgentMarketTemplate[] = [
  {
    id: 'tpl-fullstack-dev',
    name: '研发实现工程师',
    category: '软件研发',
    description: '承接功能开发与缺陷修复，阅读任务上下文后给出改动、自检与验证结论。',
    runtimeKind: 'codex',
    workingDirectory: 'repo',
    isolationMode: 'worktree',
    instructions: [
      '1. 先阅读任务正文、验收标准与最近评论，确认需求边界和影响范围。',
      '2. 若关键业务规则不明确，先在交互确认中向负责人提问，不要盲目假设。',
      '3. 在独立 worktree 或指定工程目录中实施最小可行改动，复用项目既有规范。',
      '4. 改动完成后执行类型检查与构建验证，汇报改动清单、验证命令结果与遗留风险。'
    ].join('\n'),
    quickReplies: [
      { label: '先给出技术方案', prompt: '先分析受影响的文件并给出实现方案与风险点，确认后再改代码。' },
      { label: '执行完整自检', prompt: '请运行类型检查、代码规范与构建命令，并汇报逐项结果。' }
    ]
  },
  {
    id: 'tpl-code-reviewer',
    name: '代码审查专家',
    category: '质量保障',
    description: '专注审查代码 diff、类型安全、边界条件与回归风险，输出结构化评审意见。',
    runtimeKind: 'claude-code',
    workingDirectory: 'repo',
    isolationMode: 'in_place',
    instructions: [
      '1. 对照任务验收标准与代码改动，按「阻断问题 / 风险建议 / 可选优化」分级输出评审结论。',
      '2. 重点检查竞态条件、空值边界、权限越界、向后兼容性与性能退化。',
      '3. 每条问题给出具体文件位置、根因说明和可执行修复建议。'
    ].join('\n'),
    quickReplies: [
      { label: '检查边界与回归风险', prompt: '重点排查这次改动可能引入的空值、竞态和兼容性回归问题。' },
      { label: '核对验收标准', prompt: '逐条对照任务验收标准，列出已满足项和未覆盖项。' }
    ]
  },
  {
    id: 'tpl-product-analyst',
    name: '产品需求分析师',
    category: '产品规划',
    description: '将模糊想法整理为结构化需求说明、验收标准与可拆分的子任务清单。',
    runtimeKind: 'claude-code',
    workingDirectory: 'temp',
    isolationMode: 'in_place',
    instructions: [
      '1. 梳理核心用户场景、业务目标、非目标边界与异常流程。',
      '2. 输出清晰可测的验收标准（Acceptance Criteria），避免空泛形容词。',
      '3. 若需求规模较大，主动建议拆分为可独立交付的子任务并标明依赖关系。'
    ].join('\n'),
    quickReplies: [
      { label: '补全验收标准', prompt: '请为当前任务补充 3-5 条清晰、可验证的验收标准。' },
      { label: '拆解子任务', prompt: '按研发与测试可独立交付的粒度，将当前任务拆解为子任务列表。' }
    ]
  },
  {
    id: 'tpl-qa-verifier',
    name: '测试验收专家',
    category: '测试验证',
    description: '根据需求与改动设计测试用例、执行回归核验并整理提测/验收证据。',
    runtimeKind: 'codex',
    workingDirectory: 'repo',
    isolationMode: 'in_place',
    instructions: [
      '1. 根据需求说明与代码变更整理主流程、异常路径、边界输入和兼容性测试清单。',
      '2. 执行可自动化的校验脚本并汇总实测结果，区分已验证与待人工确认项。',
      '3. 发现缺陷时给出稳定复现步骤、实际结果、预期结果和定位线索。'
    ].join('\n'),
    quickReplies: [
      { label: '生成回归测试清单', prompt: '基于当前任务内容和改动范围，生成一份核心回归测试用例清单。' }
    ]
  },
  {
    id: 'tpl-doc-writer',
    name: '协作摘要与文档助手',
    category: '文档协作',
    description: '汇总任务讨论、执行进展与交付记录，整理面向团队同步的清晰简报。',
    runtimeKind: 'claude-code',
    workingDirectory: 'temp',
    isolationMode: 'in_place',
    instructions: [
      '1. 阅读任务描述、评论与执行历史，提炼当前结论、阻塞点和下一步责任人。',
      '2. 用简洁大白话输出团队可读的同步文档或变更说明，保留关键事实依据。'
    ].join('\n'),
    quickReplies: [
      { label: '生成进展同步摘要', prompt: '请用简洁要点总结这个任务目前已完成内容、卡点和下一步行动。' }
    ]
  }
]

const DEFAULT_AI_TASK_ACTIONS: AiTaskAction[] = [
  {
    id: 'ai-act-breakdown',
    spaceId: null,
    title: '拆解执行步骤',
    description: '结合任务正文与验收标准拆解为清晰步骤和子任务建议',
    prompt: '请阅读当前任务描述与上下文，将工作拆解为 3-6 个可执行步骤，并指出关键风险与前置依赖。',
    pinned: true,
    order: 0
  },
  {
    id: 'ai-act-plan',
    spaceId: null,
    title: '生成技术方案',
    description: '分析改动影响面、关键数据流与验证计划',
    prompt: '请为当前任务起草简洁可执行的技术方案：包含目标边界、核心改动模块、兼容风险与验证方式。',
    pinned: true,
    order: 1
  },
  {
    id: 'ai-act-review',
    spaceId: null,
    title: '核对验收与风险',
    description: '检查遗漏边界、回归点与待确认问题',
    prompt: '请对照当前任务目标与已有讨论，列出尚未明确的业务问题、潜在回归风险与验收检查项。',
    pinned: true,
    order: 2
  },
  {
    id: 'ai-act-summary',
    spaceId: null,
    title: '总结任务进展',
    description: '将历史评论与执行结果浓缩为一页同步简报',
    prompt: '请总结本任务的当前进展、已确认决策、待决阻塞点以及建议的下一步流转动作。',
    pinned: false,
    order: 3
  }
]

const DEFAULT_CLEANUP_POLICY: MachineCleanupPolicy = {
  intervalHours: 1,
  terminalRetentionDays: 7,
  minFreeSpaceGiB: 10,
  repoCacheRetentionDays: 30,
  maxStorageUsageGiB: 20
}

const DEFAULT_AGENT_META: AgentExtendedMeta = {
  visibility: 'space',
  isolationMode: 'worktree',
  concurrency: 2,
  approvalMode: 'follow_runtime',
  collabMode: 'follow_runtime',
  knowledgeEnabled: true,
  triggers: {
    onAssign: true,
    onMention: true,
    onDirectChat: true,
    onCrewJoin: true,
    onWorkflowInvoke: true,
    imChannels: []
  },
  gitAuthorMode: 'user_and_agent',
  coAuthoredBy: true,
  quickReplies: [],
  instructionVersions: [],
  mcpEndpoints: []
}

const STORAGE_KEY = 'crux.hifox.platform.v1'

const DEFAULT_SPACE_SETTINGS: SpaceExtendedSettings = {
  triageReminderHours: 24,
  estimationScale: 'fibonacci'
}

function randomInviteCode(): string {
  return `crux-${Math.random().toString(36).slice(2, 6)}${Date.now().toString(36).slice(-4)}`
}

interface PersistedPlatformState {
  customRuntimes: CustomRuntimeConfig[]
  runtimeLaunchConfigs: Record<string, RuntimeLaunchConfig>
  cleanupPolicy: MachineCleanupPolicy
  keepAwake: { enabled: boolean; duration: '30m' | '1h' | '2h' | '5h' | 'permanent' }
  agentMeta: Record<string, AgentExtendedMeta>
  typeWorkflows: Record<string, TaskTypeWorkflowConfig>
  aiTaskActions: AiTaskAction[]
  triageSnoozes: Record<string, TriageSnoozeEntry>
  getStarted: GetStartedState
  favorites: FavoriteItem[]
  spaceSettings: Record<string, SpaceExtendedSettings>
  orgInviteLink: OrgInviteLinkConfig
  crewQuickReplies: Record<string, AgentQuickReply[]>
  effortEmblemStyle: EffortEmblemStyle
  effortTrackTone: EffortTrackTone
}

function defaultState(): PersistedPlatformState {
  return {
    customRuntimes: [],
    runtimeLaunchConfigs: {},
    cleanupPolicy: { ...DEFAULT_CLEANUP_POLICY },
    keepAwake: { enabled: false, duration: '1h' },
    agentMeta: {},
    typeWorkflows: {},
    aiTaskActions: [...DEFAULT_AI_TASK_ACTIONS],
    triageSnoozes: {},
    getStarted: { dismissed: false, collapsed: false, skipped: false },
    favorites: [],
    spaceSettings: {},
    orgInviteLink: {
      enabled: true,
      code: randomInviteCode(),
      defaultRole: 'member',
      updatedAt: new Date().toISOString()
    },
    crewQuickReplies: {},
    effortEmblemStyle: 'crux',
    effortTrackTone: 'teal'
  }
}

function loadPlatformState(): PersistedPlatformState {
  const base = defaultState()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return base
    const parsed = JSON.parse(raw) as Partial<PersistedPlatformState>
    return {
      customRuntimes: Array.isArray(parsed.customRuntimes) ? parsed.customRuntimes : base.customRuntimes,
      runtimeLaunchConfigs: parsed.runtimeLaunchConfigs && typeof parsed.runtimeLaunchConfigs === 'object' ? parsed.runtimeLaunchConfigs : base.runtimeLaunchConfigs,
      cleanupPolicy: parsed.cleanupPolicy ? { ...DEFAULT_CLEANUP_POLICY, ...parsed.cleanupPolicy } : base.cleanupPolicy,
      keepAwake: parsed.keepAwake ? { ...base.keepAwake, ...parsed.keepAwake } : base.keepAwake,
      agentMeta: parsed.agentMeta && typeof parsed.agentMeta === 'object' ? parsed.agentMeta : base.agentMeta,
      typeWorkflows: parsed.typeWorkflows && typeof parsed.typeWorkflows === 'object' ? parsed.typeWorkflows : base.typeWorkflows,
      aiTaskActions: Array.isArray(parsed.aiTaskActions) && parsed.aiTaskActions.length > 0 ? parsed.aiTaskActions : base.aiTaskActions,
      triageSnoozes: parsed.triageSnoozes && typeof parsed.triageSnoozes === 'object' ? parsed.triageSnoozes : base.triageSnoozes,
      getStarted: parsed.getStarted ? { ...base.getStarted, ...parsed.getStarted } : base.getStarted,
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : base.favorites,
      spaceSettings: parsed.spaceSettings && typeof parsed.spaceSettings === 'object' ? parsed.spaceSettings : base.spaceSettings,
      orgInviteLink: parsed.orgInviteLink ? { ...base.orgInviteLink, ...parsed.orgInviteLink } : base.orgInviteLink,
      crewQuickReplies: parsed.crewQuickReplies && typeof parsed.crewQuickReplies === 'object' ? parsed.crewQuickReplies : base.crewQuickReplies,
      effortEmblemStyle: parsed.effortEmblemStyle && EFFORT_EMBLEM_STYLES.has(parsed.effortEmblemStyle) ? parsed.effortEmblemStyle : base.effortEmblemStyle,
      effortTrackTone: parsed.effortTrackTone && EFFORT_TRACK_TONES.has(parsed.effortTrackTone) ? parsed.effortTrackTone : base.effortTrackTone
    }
  } catch {
    return base
  }
}

function savePlatformState(state: PersistedPlatformState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      customRuntimes: state.customRuntimes,
      runtimeLaunchConfigs: state.runtimeLaunchConfigs,
      cleanupPolicy: state.cleanupPolicy,
      keepAwake: state.keepAwake,
      agentMeta: state.agentMeta,
      typeWorkflows: state.typeWorkflows,
      aiTaskActions: state.aiTaskActions,
      triageSnoozes: state.triageSnoozes,
      getStarted: state.getStarted,
      favorites: state.favorites,
      spaceSettings: state.spaceSettings,
      orgInviteLink: state.orgInviteLink,
      crewQuickReplies: state.crewQuickReplies,
      effortEmblemStyle: state.effortEmblemStyle,
      effortTrackTone: state.effortTrackTone
    }))
  } catch {
    // 忽略本地存储受限异常
  }
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function workflowKey(spaceId: string, typeId: string): string {
  return `${spaceId}:${typeId}`
}

/** 结合任务类型可用状态和工作流流转规则，解析当前任务可流转的目标状态集合。 */
export function resolveAllowedTargetStatusIds(
  snapshot: CruxSnapshot,
  task: Pick<CruxTask, 'spaceId' | 'typeId' | 'statusId'>,
  typeWorkflows: Record<string, TaskTypeWorkflowConfig>
): Set<string> {
  const spaceStatuses = snapshot.taskStatuses
    .filter((status) => status.spaceId === task.spaceId)
    .sort((a, b) => a.order - b.order)
  const taskType = task.typeId
    ? snapshot.taskTypes.find((entry) => entry.id === task.typeId && entry.spaceId === task.spaceId)
    : snapshot.taskTypes.find((entry) => entry.spaceId === task.spaceId && entry.isDefault)
  const baseIds = new Set(
    taskType?.statusIds?.length
      ? taskType.statusIds
      : spaceStatuses.map((status) => status.id)
  )
  if (!taskType) return baseIds
  const config = typeWorkflows[workflowKey(task.spaceId, taskType.id)]
  if (!config || config.mode !== 'strict') return baseIds
  const targets = config.transitions[task.statusId]
  if (!targets) return baseIds
  const allowed = new Set<string>([task.statusId])
  for (const targetId of targets) {
    if (baseIds.has(targetId)) allowed.add(targetId)
  }
  return allowed
}

interface CollaborationPlatformStore extends PersistedPlatformState {
  upsertCustomRuntime: (input: Omit<CustomRuntimeConfig, 'id' | 'archived' | 'createdAt' | 'updatedAt'> & { id?: string }) => CustomRuntimeConfig
  archiveCustomRuntime: (id: string, archived: boolean) => void
  setRuntimeLaunchConfig: (runtimeId: string, config: Partial<RuntimeLaunchConfig>) => void
  setCleanupPolicy: (patch: Partial<MachineCleanupPolicy>) => void
  setKeepAwake: (patch: Partial<PersistedPlatformState['keepAwake']>) => void
  setEffortEmblemStyle: (style: EffortEmblemStyle) => void
  setEffortTrackTone: (tone: EffortTrackTone) => void
  getAgentMeta: (agentId: string) => AgentExtendedMeta
  updateAgentMeta: (agentId: string, patch: Partial<AgentExtendedMeta>) => void
  recordAgentInstructionVersion: (agentId: string, instructions: string, note?: string) => void
  saveTypeWorkflow: (spaceId: string, typeId: string, config: Omit<TaskTypeWorkflowConfig, 'updatedAt'>) => void
  saveAiTaskAction: (action: Omit<AiTaskAction, 'id' | 'order'> & { id?: string }) => void
  togglePinAiTaskAction: (id: string) => void
  removeAiTaskAction: (id: string) => void
  snoozeTriageTask: (taskId: string, until: string, reason?: string) => void
  clearTriageSnooze: (taskId: string) => void
  setGetStarted: (patch: Partial<GetStartedState>) => void
  toggleFavorite: (kind: FavoriteKind, id: string, spaceId?: string) => void
  isFavorite: (kind: FavoriteKind, id: string) => boolean
  getSpaceSettings: (spaceId: string) => SpaceExtendedSettings
  updateSpaceSettings: (spaceId: string, patch: Partial<SpaceExtendedSettings>) => void
  updateOrgInviteLink: (patch: Partial<OrgInviteLinkConfig>) => void
  regenerateOrgInviteLink: () => void
  getCrewQuickReplies: (crewId: string) => AgentQuickReply[]
  setCrewQuickReplies: (crewId: string, replies: AgentQuickReply[]) => void
}

const initialPlatform = loadPlatformState()

export const useCollaborationPlatform = create<CollaborationPlatformStore>()((set, get) => {
  const commit = (next: PersistedPlatformState): void => {
    savePlatformState(next)
    set(next)
  }
  const snapshotPersisted = (): PersistedPlatformState => {
    const s = get()
    return {
      customRuntimes: s.customRuntimes,
      runtimeLaunchConfigs: s.runtimeLaunchConfigs,
      cleanupPolicy: s.cleanupPolicy,
      keepAwake: s.keepAwake,
      agentMeta: s.agentMeta,
      typeWorkflows: s.typeWorkflows,
      aiTaskActions: s.aiTaskActions,
      triageSnoozes: s.triageSnoozes,
      getStarted: s.getStarted,
      favorites: s.favorites,
      spaceSettings: s.spaceSettings,
      orgInviteLink: s.orgInviteLink,
      crewQuickReplies: s.crewQuickReplies,
      effortEmblemStyle: s.effortEmblemStyle,
      effortTrackTone: s.effortTrackTone
    }
  }

  return {
    ...initialPlatform,

    upsertCustomRuntime: (input) => {
      const now = new Date().toISOString()
      const current = snapshotPersisted()
      const existing = input.id ? current.customRuntimes.find((item) => item.id === input.id) : undefined
      const record: CustomRuntimeConfig = existing
        ? { ...existing, ...input, id: existing.id, updatedAt: now }
        : { ...input, id: uid('rt'), archived: false, createdAt: now, updatedAt: now }
      const customRuntimes = existing
        ? current.customRuntimes.map((item) => item.id === existing.id ? record : item)
        : [...current.customRuntimes, record]
      commit({ ...current, customRuntimes })
      return record
    },

    archiveCustomRuntime: (id, archived) => {
      const current = snapshotPersisted()
      const now = new Date().toISOString()
      commit({
        ...current,
        customRuntimes: current.customRuntimes.map((item) => item.id === id ? { ...item, archived, updatedAt: now } : item)
      })
    },

    setRuntimeLaunchConfig: (runtimeId, patch) => {
      const current = snapshotPersisted()
      const existing = current.runtimeLaunchConfigs[runtimeId] ?? { args: [], env: [], manualModels: [], isolationMode: 'worktree' as IsolationMode }
      commit({
        ...current,
        runtimeLaunchConfigs: {
          ...current.runtimeLaunchConfigs,
          [runtimeId]: { ...existing, ...patch }
        }
      })
    },

    setCleanupPolicy: (patch) => {
      const current = snapshotPersisted()
      commit({ ...current, cleanupPolicy: { ...current.cleanupPolicy, ...patch } })
    },

    setKeepAwake: (patch) => {
      const current = snapshotPersisted()
      commit({ ...current, keepAwake: { ...current.keepAwake, ...patch } })
    },

    setEffortEmblemStyle: (effortEmblemStyle) => {
      const current = snapshotPersisted()
      commit({ ...current, effortEmblemStyle })
    },

    setEffortTrackTone: (effortTrackTone) => {
      const current = snapshotPersisted()
      commit({ ...current, effortTrackTone })
    },

    getAgentMeta: (agentId) => {
      const found = get().agentMeta[agentId]
      if (!found) return { ...DEFAULT_AGENT_META, triggers: { ...DEFAULT_AGENT_META.triggers } }
      return {
        ...DEFAULT_AGENT_META,
        ...found,
        triggers: { ...DEFAULT_AGENT_META.triggers, ...found.triggers }
      }
    },

    updateAgentMeta: (agentId, patch) => {
      const current = snapshotPersisted()
      const prev = current.agentMeta[agentId] ?? { ...DEFAULT_AGENT_META }
      commit({
        ...current,
        agentMeta: {
          ...current.agentMeta,
          [agentId]: { ...prev, ...patch }
        }
      })
    },

    recordAgentInstructionVersion: (agentId, instructions, note) => {
      const trimmed = instructions.trim()
      if (!trimmed) return
      const current = snapshotPersisted()
      const prev = current.agentMeta[agentId] ?? { ...DEFAULT_AGENT_META }
      if (prev.instructionVersions[0]?.instructions === trimmed) return
      const nextVersion: AgentInstructionVersion = {
        id: uid('ver'),
        instructions: trimmed,
        savedAt: new Date().toISOString(),
        note
      }
      commit({
        ...current,
        agentMeta: {
          ...current.agentMeta,
          [agentId]: {
            ...prev,
            instructionVersions: [nextVersion, ...prev.instructionVersions].slice(0, 20)
          }
        }
      })
    },

    saveTypeWorkflow: (spaceId, typeId, config) => {
      const current = snapshotPersisted()
      commit({
        ...current,
        typeWorkflows: {
          ...current.typeWorkflows,
          [workflowKey(spaceId, typeId)]: { ...config, updatedAt: new Date().toISOString() }
        }
      })
    },

    saveAiTaskAction: (action) => {
      const current = snapshotPersisted()
      const existing = action.id ? current.aiTaskActions.find((item) => item.id === action.id) : undefined
      const aiTaskActions = existing
        ? current.aiTaskActions.map((item) => item.id === existing.id ? { ...item, ...action, id: existing.id } : item)
        : [...current.aiTaskActions, { ...action, id: uid('ai-act'), order: current.aiTaskActions.length }]
      commit({ ...current, aiTaskActions })
    },

    togglePinAiTaskAction: (id) => {
      const current = snapshotPersisted()
      commit({
        ...current,
        aiTaskActions: current.aiTaskActions.map((item) => item.id === id ? { ...item, pinned: !item.pinned } : item)
      })
    },

    removeAiTaskAction: (id) => {
      const current = snapshotPersisted()
      commit({
        ...current,
        aiTaskActions: current.aiTaskActions.filter((item) => item.id !== id)
      })
    },

    snoozeTriageTask: (taskId, until, reason) => {
      const current = snapshotPersisted()
      commit({
        ...current,
        triageSnoozes: { ...current.triageSnoozes, [taskId]: { until, reason } }
      })
    },

    clearTriageSnooze: (taskId) => {
      const current = snapshotPersisted()
      const next = { ...current.triageSnoozes }
      delete next[taskId]
      commit({ ...current, triageSnoozes: next })
    },

    setGetStarted: (patch) => {
      const current = snapshotPersisted()
      commit({ ...current, getStarted: { ...current.getStarted, ...patch } })
    },

    toggleFavorite: (kind, id, spaceId) => {
      const current = snapshotPersisted()
      const exists = current.favorites.some((item) => item.kind === kind && item.id === id)
      const favorites = exists
        ? current.favorites.filter((item) => !(item.kind === kind && item.id === id))
        : [{ kind, id, spaceId, pinnedAt: new Date().toISOString() }, ...current.favorites].slice(0, 60)
      commit({ ...current, favorites })
    },

    isFavorite: (kind, id) => get().favorites.some((item) => item.kind === kind && item.id === id),

    getSpaceSettings: (spaceId) => {
      const found = get().spaceSettings[spaceId]
      return found ? { ...DEFAULT_SPACE_SETTINGS, ...found } : { ...DEFAULT_SPACE_SETTINGS }
    },

    updateSpaceSettings: (spaceId, patch) => {
      const current = snapshotPersisted()
      const prev = current.spaceSettings[spaceId] ?? { ...DEFAULT_SPACE_SETTINGS }
      commit({
        ...current,
        spaceSettings: {
          ...current.spaceSettings,
          [spaceId]: { ...prev, ...patch }
        }
      })
    },

    updateOrgInviteLink: (patch) => {
      const current = snapshotPersisted()
      commit({
        ...current,
        orgInviteLink: { ...current.orgInviteLink, ...patch, updatedAt: new Date().toISOString() }
      })
    },

    regenerateOrgInviteLink: () => {
      const current = snapshotPersisted()
      commit({
        ...current,
        orgInviteLink: {
          ...current.orgInviteLink,
          code: randomInviteCode(),
          updatedAt: new Date().toISOString()
        }
      })
    },

    getCrewQuickReplies: (crewId) => get().crewQuickReplies[crewId] ?? [],

    setCrewQuickReplies: (crewId, replies) => {
      const current = snapshotPersisted()
      commit({
        ...current,
        crewQuickReplies: { ...current.crewQuickReplies, [crewId]: replies }
      })
    }
  }
})
