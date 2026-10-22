/**
 * Shared IPC contract between the Electron main process and the renderer.
 * Mirrors the canonical Trellis task.json schema (24 fields, see
 * @mindfoldhq/trellis-core task/schema).
 */
import type { DocumentWindowApi } from './document-windows'
import type {
  DocumentChangedEvent,
  DocumentDiffOutcome,
  DocumentDiffRequest,
  DocumentReadOutcome,
  DocumentReadRequest,
  DocumentReadScope,
  DocumentWatchOutcome
} from './documents'
import type {
  ObservationCursor,
  ObservationHealth,
  ObservationQueryRequest,
  ObservationQuerySuccess,
  ObservationScope,
  ObservationStatusResult,
  ObservationSubscribeResult,
  ObservationSubscriptionEvent
} from './observability/store'
import type { IpcFail } from './ipc-errors'
import type { ApplicationRuntimeApi } from './app-runtime'
import type { TaskConversationsApi } from './task-conversations'
import type { GitHistoryRequest, GitHistoryResult, GitCommitRequest, GitCommitResult, GitCommitDiffRequest, GitCommitDiffResult } from './git-readonly'

export const TASK_STATUSES = ['planning', 'in_progress', 'review', 'completed'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export type TaskPhase = 'plan' | 'implement' | 'review' | 'completed' | 'unknown'

/** Canonical task.json record. Unknown on-disk fields are preserved by writers. */
export interface TaskRecord {
  id: string
  name: string
  title: string
  description: string
  status: string
  dev_type: string | null
  scope: string | null
  package: string | null
  priority: string
  creator: string
  assignee: string
  createdAt: string
  completedAt: string | null
  branch: string | null
  base_branch: string | null
  worktree_path: string | null
  commit: string | null
  pr_url: string | null
  subtasks: string[]
  children: string[]
  parent: string | null
  relatedFiles: string[]
  notes: string
  /** workflow pin（动态 workflow 切换：task.json 可携带 workflow 字段） */
  workflow?: string | null
  /** 面板自有：自然周周期（ISO 周号，如 2026-W45）。CLI 字段级写回保留未知字段。 */
  cycle?: string | null
  meta: Record<string, unknown>
}

/** Editable fields exposed by the task editor. */
export type TaskEditableField =
  | 'cycle'
  | 'title'
  | 'description'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'notes'
  | 'branch'
  | 'pr_url'
  | 'subtasks'

export type TaskPatch = Partial<Pick<TaskRecord, TaskEditableField>>

/* --- C1–C3：本机开发工具（只读 Git + 有归属的工程运行） --- */

export interface GitStatusEntry {
  path: string
  x: string
  y: string
  origPath?: string
}

export interface GitReadonlyStatus {
  ok: boolean
  error?: string
  isRepo: boolean
  branch: string | null
  head: { short: string; subject: string } | null
  staged: GitStatusEntry[]
  unstaged: GitStatusEntry[]
  untracked: string[]
  scannedAt: number
}

export interface GitReadonlyFileDiff {
  ok: boolean
  error?: string
  path: string
  staged: boolean
  added: number
  removed: number
  binary: boolean
  diff: string
  truncated: boolean
}

export interface DevScriptInfo {
  name: string
  command: string
}

export type DevRunState = import('./app-runtime').ApplicationProcessState | 'killed'

export interface DevRunInfo {
  id: string
  dir: string
  command: string
  script: string
  startedAt: number
  exitedAt: number | null
  state: DevRunState
  exitCode: number | null
  pid: number | null
  output: string
  outputTruncated: boolean
}

export interface FileEntry {
  name: string
  path: string
  kind: 'file' | 'dir'
  size: number
  mtime: number
  ext: string
}

export interface TaskInfo {
  dirName: string
  path: string
  date: string | null
  record: TaskRecord | null
  parseError?: string
  phase: TaskPhase
  artifacts: FileEntry[]
  updatedAt: number
  archived?: boolean
  /** mtime of task.json at scan time — used for optimistic write conflict detection. */
  taskJsonMtime: number
  jiraKey?: string
}

export interface SpecNode {
  name: string
  path: string
  type: 'dir' | 'file'
  size?: number
  mtime?: number
  children?: SpecNode[]
  /** number of references found across tasks/spec (computed on demand) */
  refCount?: number
}

export interface JournalFile {
  name: string
  path: string
  size: number
  mtime: number
}

export interface DeveloperInfo {
  name: string
  path: string
  journals: JournalFile[]
  otherFiles: JournalFile[]
  lastActive: number
}

export interface SessionInfo {
  file: string
  platform: string
  currentTask: string | null
  lastSeen: string | null
  run: string | null
}

/** FR：任务材料更新（主进程按任务防抖合并后广播） */
/** T2：上下文预期诊断条目（预期注入行为，非实际读取回执） */
export interface ContextExpectEntry {
  file: string
  reason: string
  exists: boolean
  size: number
  verdict: 'full' | 'truncate' | 'index' | 'missing'
}

export interface MaterialUpdatedEvent {
  /** Missing on legacy attention signals; those are not verified artifact facts. */
  projectRoot?: string
  projectGeneration?: number
  changes?: AcpMaterialChange[]
  dirName: string
  title: string
  count: number
  files: string[]
  at: number
}

export interface PlatformChip {
  id: string
  name: string
  detected: boolean
}

export interface ProjectMeta {
  root: string
  name: string
  trellisExists: boolean
  version: string | null
  developer: string | null
  developerSince: string | null
  currentTask: string | null
  /** 该绑定来自最近活跃会话的最后记录（.runtime/sessions 的 last_seen_at），非在线心跳 */
  currentTaskAt: string | null
  hasWorkflow: boolean
  workflowTemplate: string | null
  packages: string[]
  platforms: PlatformChip[]
  configExists: boolean
}

export interface ProjectSnapshot {
  meta: ProjectMeta
  tasks: TaskInfo[]
  archived: TaskInfo[]
  spec: SpecNode[]
  developers: DeveloperInfo[]
  sharedWorkspaceFiles: JournalFile[]
  sessions: SessionInfo[]
  scannedAt: number
}

/* ---------- Git integration ---------- */

export interface GitCommitInfo {
  hash: string
  short: string
  author: string
  date: string
  subject: string
}

export interface TaskGitInfo {
  dirName: string
  branchExists: boolean
  currentBranch: string | null
  ahead: number
  behind: number
  merged: boolean
  commits: GitCommitInfo[]
  worktreeDirty: boolean
  error?: string
}

/* ---------- Activity / analytics ---------- */

export interface ActivityEntry {
  ts: number
  dir: string
  title: string
  from: string | null
  to: string
}

export interface AnalyticsResult {
  totalTransitions: number
  /** average days from creation to completion for tasks completed in window */
  avgCycleDays: number | null
  /** tasks in_progress/review with no activity for > 3 days */
  aging: Array<{ dirName: string; title: string; status: string; days: number; assignee: string }>
  /** transitions per day for the last 14 days */
  daily: Array<{ date: string; count: number }>
  /** per-member cycle time */
  memberCycle: Array<{ name: string; avgDays: number | null; completed: number }>
  recent: ActivityEntry[]
}

/* ---------- Reports ---------- */

export interface ReportResult {
  markdown: string
  suggestedFileName: string
}

/* ---------- Channels (trellis multi-agent runtime) ---------- */

export interface ChannelEvent {
  kind: string
  by: string
  text?: string
  seq: number
  ts: string
  /** forum 线程 id / 标题（post 类事件携带） */
  thread?: string
  title?: string
  status?: string
}

export interface ChannelSummary {
  name: string
  bucket: string
  /** channel 归属：当前项目 / 全局（~/.trellis/channels 下的其他 bucket） */
  scope: 'project' | 'global'
  type: string
  eventCount: number
  lastEventAt: string | null
  lastKind: string | null
  participants: string[]
  events: ChannelEvent[]
}

/* ---------- Jira ---------- */

export interface JiraConfig {
  enabled: boolean
  baseUrl: string
  user: string
  /** stored encrypted via safeStorage when available */
  password: string
  passwordEncrypted?: boolean
  /** extra JQL ANDed with the default assignee query; empty = default */
  jql: string
  /** jira status name -> trellis status; fallback: statusCategory mapping */
  statusMap: Record<string, string>
}

export interface JiraIssue {
  key: string
  summary: string
  status: string
  statusCategory: string
  priority: string
  issueType: string
  updated: string
  url: string
  assignee: string
  /** fix version names (usually 0 or 1) */
  fixVersions: string[]
}

/** G4：带稳定 ID 的 fixVersion（JiraIssue.fixVersions 保留纯名字供既有 UI 使用）。 */
export interface JiraFixVersionRef {
  id: string
  name: string
}

/**
 * G4 扩充字段的 Jira issue（design §7.1）：issueId/issueTypeId/fixVersionId/
 * description/updatedAtMs。由分页查询（jiraSearchPaged）产出，经
 * TrellisApi.jiraSearchPaged 供 Jira 页创建链消费。
 */
export interface JiraIssueDetail extends JiraIssue {
  /** Jira 数字稳定 issue id；服务端未返回时为 null */
  issueId: number | null
  issueTypeId: string
  issueTypeName: string
  fixVersionDetails: JiraFixVersionRef[]
  /** 服务端返回的完整描述（wiki 标记/纯文本原样）；未请求到为 null */
  description: string | null
  /** 从 `updated` 显式解析校验出的 Unix 毫秒；缺失/非法为 null */
  updatedAtMs: number | null
}

export interface JiraTransition {
  id: string
  name: string
  /** 该 transition 的目标状态名（Jira `to.name`）；服务端未带则缺省 */
  toStatusName?: string
}

/* ---------- G4：Jira 分页查询与基线口径（design §7.1） ---------- */

export type JiraPaginationKind = 'startAt_total' | 'nextPageToken' | 'unknown'
export type JiraSearchIncompleteReason = 'max_pages' | 'page_failed' | 'cancelled' | null

/** 单次分页查询的完整性口径：不能只看 total==抓取数。 */
export interface JiraPagedSearchMeta {
  jql: string
  paginationKind: JiraPaginationKind
  pagesFetched: number
  /** 服务端报告的总数（startAt 协议）；token 协议可能为 null */
  serverTotal: number | null
  /** 去重后的取回数 */
  retrievedCount: number
  /** 跨页重复（issueId/key 去重掉的条数） */
  duplicateCount: number
  /** 明知不完整（达最大页数/页失败）→ 结果只是样本 */
  sample: boolean
  incompleteReason: JiraSearchIncompleteReason
  cancelled: boolean
  /** 采集期间服务端 total 变化（startAt 协议可观测；token 协议不可验证为 null） */
  changedDuringCollection: boolean | null
  startedAtMs: number
  endedAtMs: number
}

export interface JiraPagedSearchResult {
  ok: boolean
  error?: string
  issues: JiraIssueDetail[]
  meta: JiraPagedSearchMeta
}

/** 单版本类型分布（FR5：按 fixVersion 独立查询计数）。 */
export interface JiraVersionTypeCount {
  issueTypeId: string
  issueTypeName: string
  count: number
}

export interface JiraVersionDistribution {
  versionId: string
  versionName: string
  ok: boolean
  error?: string
  meta: JiraPagedSearchMeta
  /** 该版本内去重后的工单数（多版本工单分别计入各自版本） */
  issueCount: number
  byType: JiraVersionTypeCount[]
}

/** 跨版本汇总另按 issueId/key 去重（design §7.1）。 */
export interface JiraDistributionResult {
  versions: JiraVersionDistribution[]
  crossVersionUniqueCount: number
  crossVersionByType: JiraVersionTypeCount[]
  startedAtMs: number
  endedAtMs: number
}

/* ---------- GitLab connector (pluggable VCS provider) ---------- */

export interface GitLabConfig {
  enabled: boolean
  /** e.g. http://192.168.1.202:8929 */
  baseUrl: string
  user: string
  /** stored encrypted via safeStorage when available */
  password: string
  passwordEncrypted?: boolean
  /** project path with namespace, e.g. huachuang/honsky-lis */
  project: string
}

export interface GitLabMrInfo {
  iid: number
  title: string
  state: string
  webUrl: string
  sourceBranch: string
  targetBranch: string
}

export interface GitLabPipelineInfo {
  id: number
  status: string
  ref: string
  webUrl: string
}

export interface GitLabTaskStatus {
  ok: boolean
  error?: string
  mr: GitLabMrInfo | null
  pipeline: GitLabPipelineInfo | null
}

/* ---------- WeKnora（公司级知识库联动） ---------- */

export interface WeknoraConfig {
  enabled: boolean
  /** WeKnora 部署根地址；带不带 /api/v1 均可 */
  baseUrl: string
  /** X-API-Key（DPAPI 加密存储） */
  apiKey: string
  apiKeyEncrypted?: boolean
  /** 联邦检索 / AI 规划的公司库范围（WeKnora 知识库 ID，可多个） */
  searchKbIds: string[]
  /** spec 同步目标库 ID */
  specKbId: string
  /** 归档沉淀目标库 ID */
  archiveKbId: string
  /** 归档任务时自动沉淀到公司库 */
  autoPushArchive: boolean
  /** .trellis/spec 变更自动同步到公司库（静默期后批量推送） */
  syncSpec: boolean
  /** WeKnora 内置 MCP Server 端点（Streamable HTTP），如 https://host/mcp/ep-xxx */
  mcpUrl: string
  /** 端点令牌（DPAPI 加密存储） */
  mcpToken: string
  mcpTokenEncrypted?: boolean
}

/** 主进程与渲染层共用的 weknora 默认值（旧 settings.json / 新旧主进程混跑时兜底） */
export const WEKNORA_DEFAULTS: WeknoraConfig = {
  enabled: false,
  baseUrl: '',
  apiKey: '',
  searchKbIds: [],
  specKbId: '',
  archiveKbId: '',
  autoPushArchive: true,
  syncSpec: false,
  mcpUrl: '',
  mcpToken: ''
}

export interface WeknoraKbSummary {
  id: string
  name: string
  knowledgeCount: number
}

export interface WeknoraHit {
  knowledgeId: string
  title: string
  filename: string
  /** file / url / manual */
  sourceType: string
  score: number
  /** 命中分块文本 */
  content: string
}

export interface WeknoraSearchResult {
  ok: boolean
  error?: string
  hits: WeknoraHit[]
  elapsedMs: number
}

export interface WeknoraDocSummary {
  id: string
  title: string
  fileName: string
  fileType: string
  parseStatus: string
  createdAt: string
  channel: string
}

export interface WeknoraReadResult {
  ok: boolean
  error?: string
  title?: string
  fileName?: string
  content?: string
}

export interface WeknoraPushResult {
  ok: boolean
  error?: string
  knowledgeId?: string
  /** 服务端按 file_hash 判定重复（409） */
  duplicate?: boolean
}

/* ---------- Inbox (task triage) ---------- */

export interface InboxItem {
  dirName: string
  title: string
  creator: string
  ts: number
}

export interface TodoItem {
  id: string
  title: string
  description: string
  priority: string
  source: 'jira' | 'manual'
  jiraKey?: string
  jiraUrl?: string
  status: 'pending' | 'converted' | 'dismissed'
  createdAt: string
  filePath: string
}

export interface InboxNewEvent {
  projectRoot: string
  items: InboxItem[]
}

/* ---------- Settings ---------- */

export interface ModelItem {
  id: string
  name: string
  contextWindow?: string
  tags?: string[]
  enabled: boolean
  temperature?: number
  maxTokens?: number
  latencyMs?: number
  lastTestedAt?: string
}

export type AiApiFormat = 'openai' | 'response' | 'anthropic' | 'ollama'

export interface ModelProvider {
  id: string
  name: string
  group?: string
  icon?: string
  enabled: boolean
  baseUrl: string
  apiFormat: AiApiFormat
  apiKey: string
  apiKeyEncrypted?: boolean
  models: ModelItem[]
  status?: 'connected' | 'untested' | 'error' | 'disabled'
  latencyMs?: number
  lastTestedAt?: string
}

export interface ModelFetchResult {
  ok: boolean
  error?: string
  models?: ModelItem[]
}

export interface ModelTestResult {
  ok: boolean
  error?: string
  latencyMs?: number
  model?: string
  message?: string
}

export interface AiConfig {
  enabled: boolean
  /** OpenAI 兼容 baseUrl，填到 /v1 即可；以 # 结尾则原样使用 */
  baseUrl: string
  /** stored encrypted via safeStorage when available */
  apiKey: string
  apiKeyEncrypted?: boolean
  model: string
  temperature: number
  /** 当前激活的供应商 ID */
  activeProviderId?: string
  /** API 协议格式 */
  apiFormat?: AiApiFormat
  /** 多模型供应商列表 */
  providers?: ModelProvider[]
}

/** 思考档位：随会话持久化，按协议映射请求参数（TPD-014） */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'
export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high']

/** 图片附件（多模态输入，TPD-019） */
export interface ChatImage {
  mediaType: string
  dataBase64: string
}

/** 工具调用记录（agent 循环，TPD-020） */
export interface ChatToolOp {
  toolName: string
  argsSummary: string
  status: 'success' | 'error' | 'denied'
  elapsedMs: number
  /** 检索类工具命中的来源（回答可引用） */
  sources?: Array<{ title: string; path: string; library?: string }>
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** 思考流（DeepSeek-R1 reasoning_content / anthropic thinking_delta 等），独立于正文 */
  reasoning?: string
  images?: ChatImage[]
  /** agent 循环中的工具调用记录 */
  toolOps?: ChatToolOp[]
}

/* ---------- 对话（Chat 页） ---------- */

/** 会话元信息（列表用，不含消息体） */
export interface ChatSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  providerId: string | null
  modelId: string | null
  thinkingLevel: ThinkingLevel
  /** agent 工具循环开关 */
  agent?: boolean
  /** 会话聚焦的任务目录 */
  taskDir?: string | null
}

/** 会话完整记录（v2 树的活跃路径视图，TPD-016） */
export interface ChatMessageView extends ChatMessage {
  id: string
  /** 同层兄弟数（含自身）；>1 时渲染分支切换器 */
  siblingCount: number
  /** 自身在兄弟中的序号（0 起） */
  siblingIndex: number
  /** 全部兄弟（含自身）的节点 id，供分支切换 */
  siblingIds: string[]
}

export interface ChatSessionView extends ChatSessionMeta {
  messages: ChatMessageView[]
}

/** chat:send 结果：直接开跑或进入会话队列 */
export interface ChatSendResult {
  ok: boolean
  error?: string
  runId: string | null
  queued: boolean
  queueLen?: number
}

/** chat:output 事件负载（runId 关联的流式增量） */
export interface ChatOutputEvent {
  runId: string
  sessionId: string
  /** 正文增量 */
  delta: string
  /** 思考流增量（与 delta 互斥出现） */
  reasoning?: string
  /** 工具行事件（与 delta 互斥出现，TPD-020） */
  toolOp?: ChatToolOp
}

/** chat:done 事件负载（runId 生命周期终结；title 为异步总结结果） */
export interface ChatPermissionEvent {
  runId: string
  sessionId: string
  permId: string
  toolName: string
  argsSummary: string
  timeoutSec: number
}

export interface ChatSteerEvent {
  runId: string
  sessionId: string
  content: string
}

export interface ChatDoneEvent {
  runId: string
  sessionId: string
  kind: 'done' | 'error' | 'aborted'
  error?: string
  title?: string
  message?: ChatMessage
}

export interface AiChatResult {
  ok: boolean
  content?: string
  error?: string
  model?: string
}

export interface Settings {
  recentProjects: string[]
  theme: 'dark' | 'light'
  cliCommand: string
  jira: JiraConfig
  /** pluggable git platform connector (GitLab first) */
  gitlab: GitLabConfig
  /** 应用内 AI 能力（OpenAI 兼容 baseUrl 自定义模型） */
  ai: AiConfig
  /** 公司级知识库联动（WeKnora） */
  weknora: WeknoraConfig
  /** random per-install token; deep links must carry it */
  bridgeToken: string
  httpApi: { enabled: boolean; port: number; lanAccess: boolean; webBoard: boolean }
  /**
   * 本地接入协议（TPAP v1）：外部工具经 127.0.0.1 + Bearer token 读取面板状态/调用网关工具。
   * 始终仅绑定环回，无局域网开关；默认关闭。
   */
  access: { enabled: boolean; port: number }
  /** 全局出网代理（TPD-015）：覆盖 AI/models.dev（undici）与 WeKnora（Chromium）路径 */
  proxy: { enabled: boolean; url: string }
  desktop: { autoStart: boolean; globalShortcut: string; autoUpdate: boolean; quickTodoShortcut: string; explorerContextMenu?: boolean }
  /** T4 派单：codex worker 显式模型（账号默认模型不可用时在此指定；留空用 CLI 默认） */
  dispatch: { codexModel?: string }
  /** ACP agent 注册表（10-09：缺省用内置预置项）；nativePaths 为原生直连 Runtime 的手动 CLI 路径（优先于 PATH 自动检测） */
  acp?: { agents?: AcpAgentConfig[]; nodePath?: string; nativePaths?: Record<string, string> }
}

/* ---------- Studio（定制中心：workflow / 命令 / 子代理 / 技能 / 钩子 / 配置 / 平台） ---------- */

export type ExtKind = 'command' | 'agent' | 'skill'
export type StudioCapability = 'commands' | 'agents' | 'skills' | 'hooks' | 'workflows'

export interface PlatformProfile {
  id: string
  name: string
  /** 项目根下标记平台已安装的目录/文件 */
  marker: string
  installFlag: string
  capabilities: StudioCapability[]
  /** 平台可能在项目根使用的目录（统计用） */
  dirs: string[]
  /** slash 调用形式提示，如 /trellis:{name} */
  invocationHint: string
}

export interface PlatformStatus extends PlatformProfile {
  detected: boolean
  counts: { commands: number; agents: number; skills: number; hooks: number }
}

export interface ExtEntry {
  kind: ExtKind
  platform: string
  platformName: string
  path: string
  name: string
  invocation: string | null
  format: 'md' | 'toml' | 'json' | 'other'
  frontmatter: Record<string, string>
  size: number
  mtime: number
}

export interface HookRegistration {
  platform: string
  platformName: string
  file: string
  event: string
  matcher: string
  command: string
  timeout: number | null
}

export interface LifecycleHook {
  event: 'after_create' | 'after_start' | 'after_finish' | 'after_archive'
  command: string
}

export interface WorkflowPhase {
  title: string
  steps: string[]
}

export interface WorkflowStructure {
  hasPhaseIndex: boolean
  phases: WorkflowPhase[]
  states: string[]
  platforms: string[]
  lineCount: number
}

export interface WorkflowInfo {
  id: string
  name: string
  path: string
  scope: 'global' | 'saved'
  size: number
  mtime: number
  structure: WorkflowStructure
  warnings: string[]
  /** task.json 中 pin 了该 workflow 的任务 */
  pinnedTasks: Array<{ dirName: string; title: string }>
}

export interface WorkflowChain {
  developerName: string | null
  developerWorkflow: string | null
  configDefault: string | null
  globalExists: boolean
}

export interface PackageEntry {
  path?: string
  type?: string
  git?: boolean
}

export interface StudioConfig {
  session_commit_message: string | null
  session_auto_commit: boolean | null
  max_journal_lines: number | null
  default_workflow: string | null
  default_package: string | null
  packages: Record<string, PackageEntry>
  codex_dispatch_mode: string | null
  lifecycleHooks: LifecycleHook[]
  exists: boolean
}

export interface StudioScan {
  platforms: PlatformStatus[]
  extensions: ExtEntry[]
  hookRegistrations: HookRegistration[]
  hookScripts: FileEntry[]
  workflows: WorkflowInfo[]
  chain: WorkflowChain
  config: StudioConfig
  developerRaw: string | null
  scannedAt: number
}

/* ---------- AI 工作流（定制中心 → Flow DSL） ---------- */

/** 工作流步骤：子代理（AI 生成/分析）/ 工具调用 / 确定性门禁 */
export type FlowStep = AgentStep | ToolStep | GateStep

export interface AgentStep {
  kind: 'agent'
  id: string
  /** 展示名（用户在进度里看到的角色，如「资料调研员」） */
  name: string
  /** 子代理人设（system 提示） */
  persona?: string
  /** 任务指令，支持 {{input.x}} / {{vars.x}} 变量插值 */
  instruction: string
  /** 允许调用的网关工具（如 kb_search）；缺省为纯生成不查证 */
  tools?: string[]
  /** 工具循环上限（默认 3） */
  maxRounds?: number
  /** 输出存入变量 vars.<saveOutputAs>，供后续步骤引用 */
  saveOutputAs?: string
}

export interface ToolStep {
  kind: 'tool'
  id: string
  name: string
  /** 网关工具名（kb_search / trellis_list_tasks / weknora_search …） */
  tool: string
  args: Record<string, string>
  saveOutputAs?: string
}

export interface GateStep {
  kind: 'gate'
  id: string
  name: string
  /** 对指定步骤输出做确定性检查 */
  check: { stepId: string; contains?: string; notContains?: string; minLength?: number }
  /** 失败动作：中止 / 继续 / 跳到指定步骤（带反馈重试） */
  onFail: 'abort' | 'continue' | 'goto'
  gotoStepId?: string
  /** 失败时把反馈发给该 agent 步骤重跑（fresh eyes 闭环） */
  feedbackTo?: string
  maxRetries?: number
}

export interface FlowPhase {
  id: string
  /** 阶段名（进度故事：「调研项目背景」「汇总并产出报告」） */
  name: string
  steps: FlowStep[]
}

/** 钩子：在关键时机注入给所有 agent 步骤的附加指令 + 完成动作 */
export interface FlowHooks {
  /** 开始时注入（全局约束：语言、口径） */
  onStart?: string
  /** 指定阶段开始时注入 */
  onPhase?: Record<string, string>
  /** 完成时动作：toast 通知 / 沉淀到我的笔记库 */
  onComplete?: { notify?: boolean; saveNote?: boolean }
}

export interface FlowDef {
  version: 1
  id: string
  name: string
  description: string
  /** 运行时向用户征集的输入（自然语言描述即可） */
  inputs: Array<{ name: string; label: string; description?: string; required?: boolean; default?: string }>
  phases: FlowPhase[]
  hooks?: FlowHooks
  createdAt?: number
  updatedAt?: number
}

export interface FlowSummary {
  id: string
  name: string
  description: string
  phaseCount: number
  stepCount: number
  inputNames: string[]
  updatedAt: number
  path: string
}

/** 运行事件（flow:output，runId 关联） */
export interface FlowRunEvent {
  runId: string
  flowId: string
  kind: 'phase-start' | 'step-start' | 'step-done' | 'step-error' | 'gate-pass' | 'gate-fail' | 'log' | 'phase-done'
  phaseId?: string
  stepId?: string
  /** 简短描述（用户可读） */
  text?: string
  /** 步骤输出摘要（截断） */
  output?: string
  ts: number
}

export interface FlowRunRecord {
  runId: string
  flowId: string
  flowName: string
  status: 'running' | 'completed' | 'aborted' | 'error'
  startedAt: number
  endedAt?: number
  inputs: Record<string, string>
  events: FlowRunEvent[]
  /** 各步骤产物（saveOutputAs 的变量） */
  vars: Record<string, string>
  error?: string
}

export interface FlowRunResult {
  ok: boolean
  runId?: string
  error?: string
}

/* ---------- 知识库（需求 / 规范 / Wiki / 归档） ---------- */

export type KbLibrary = 'requirements' | 'spec' | 'wiki' | 'archive' | 'notes'

/** 知识库问答记录（userData 持久化） */
export interface KbQaEntry {
  id: string
  question: string
  answer: string
  /** 引用来源（标题/路径） */
  sources: Array<{ title: string; path: string; library?: string }>
  createdAt: number
}

export interface KbDoc {
  id: string
  library: KbLibrary
  path: string
  name: string
  /** 分组：spec 子目录 / 任务目录 / docs 子目录 */
  group: string
  title: string
  size: number
  mtime: number
  /** 合成文档（task.json 提炼）在渲染器不可直接读取 */
  synthetic?: boolean
}

export interface KbHit {
  doc: KbDoc
  score: number
  /** 命中上下文，命中词以 \u0000 · \u0001 标记 */
  snippet: string
}

export interface KbSearchResult {
  ok: boolean
  error?: string
  hits: KbHit[]
  docs: KbDoc[]
  totalDocs: number
  elapsedMs: number
}

/* ---------- Docs (全文检索 .trellis 文档) ---------- */

export interface DocSearchHit {
  path: string
  name: string
  group: 'spec' | 'workspace' | 'shared'
  /** match context with the matched range marked by \u0000 · \u0001 */
  snippet: string
  size: number
  mtime: number
}

/* ---------- Bridge ---------- */

export interface RunEvent {
  runId: number
  stream: 'stdout' | 'stderr'
  data: string
}

export interface RunDoneEvent {
  runId: number
  code: number | null
  aborted?: boolean
}

export interface RecentDoc {
  path: string
  name: string
}

export interface ToastEvent {
  kind: 'info' | 'success' | 'warn' | 'error'
  title: string
  body?: string
  /** Optional navigation target, valid only inside its originating project. */
  task?: { projectRoot: string; dirName: string }
}

export interface BridgeEvent {
  type: 'task-event' | 'notify' | 'open-task'
  taskDir?: string | null
  text?: string
  source?: string
}

export interface McpInfo {
  running: boolean
  port: number | null
  webBoardUrl: string | null
}

/* ---------- 规划工作台（Jira/需求 → KB 检索 → AI 计划） ---------- */

export interface PlanSource {
  path: string
  title: string
  library: string
}

export interface TaskPlan {
  title: string
  description: string
  priority: string
  devType: string | null
  scope: string | null
  workflow: string | null
  branch: string | null
  subtasks: string[]
  questions: string[]
}

export interface PlanResult {
  ok: boolean
  error?: string
  plan?: TaskPlan
  sources: PlanSource[]
  contextChars: number
  /** 项目可选 workflow id（.trellis/workflows） */
  workflows: string[]
}

/* ---------- KB-MCP（AI 编码工具的知识库记忆大脑） ---------- */

export interface KbMcpInstallResult {
  ok: boolean
  error?: string
  scriptPath: string
  claudeMcpJson: string | null
  codexWritten: boolean
  codexSnippet: string
  zcodeCommand: string
  genericSnippet: string
}

export interface KbMcpStatus {
  installed: boolean
  scriptPath: string
  mtime: number
  claudeConfigured: boolean
}

export interface SyncExtensionResult {
  ok: boolean
  error?: string
  written: string[]
  skipped: Array<{ platform: string; reason: string }>
}

/** APIs exposed to the renderer via contextBridge. */
export interface TrellisApi extends ApplicationRuntimeApi, DocumentWindowApi, TaskConversationsApi {
  gitWorkspace: import('./git-workspace').GitWorkspaceApi
  knowledgeAccess: import('./knowledge-access').KnowledgeApi
  integrations: import('./integrations').IntegrationApi
  /** 置顶文档小窗：打开/聚焦（支持多开，key 去重）；theme 跟随面板主题 */
  docOpen: (opts: { key: string; title: string; file: string; theme: string }) => Promise<{
    ok: boolean
    focused?: boolean
    error?: string
  }>
  /** 读取项目内文本文件（路径必须位于项目根内） */
  docRead: (path: string) => Promise<{ ok: boolean; content?: string; mtime?: number; error?: string }>
  /** 切换调用方文档窗的置顶状态 */
  docSetPin: (on: boolean) => Promise<{ ok: boolean; pinned?: boolean; error?: string }>
  pickProject: () => Promise<string | null>
  openProject: (root: string) => Promise<{ ok: boolean; error?: string; snapshot?: ProjectSnapshot }>
  getSnapshot: () => Promise<ProjectSnapshot | null>
  closeProject: () => Promise<void>
  onSnapshotUpdated: (cb: (s: ProjectSnapshot) => void) => () => void

  /** expectedMtime enables optimistic conflict detection；ignored 列出白名单外未写入的字段 */
  updateTask: (
    taskDir: string,
    patch: TaskPatch,
    expectedMtime?: number
  ) => Promise<{ ok: boolean; error?: string; conflict?: boolean; ignored?: string[] }>

  /* --- C1–C3：本机开发工具（只读 Git + 有归属的工程运行） --- */
  devtoolsGitStatus: () => Promise<GitReadonlyStatus>
  devtoolsGitFileDiff: (relPath: string, staged: boolean) => Promise<GitReadonlyFileDiff>
  devtoolsGitHistory: (request: GitHistoryRequest) => Promise<GitHistoryResult>
  devtoolsGitCommit: (request: GitCommitRequest) => Promise<GitCommitResult>
  devtoolsGitCommitDiff: (request: GitCommitDiffRequest) => Promise<GitCommitDiffResult>
  devtoolsListScripts: (dir: string) => Promise<{ ok: boolean; error?: string; dir?: string; scripts: DevScriptInfo[] }>
  devRunStart: (dir: string, script: string) => Promise<{ ok: boolean; error?: string; run?: DevRunInfo }>
  devRunStop: (id: string) => Promise<{ ok: boolean; error?: string }>
  devRunStopAll: () => Promise<{ stopped: number }>
  devRunList: () => Promise<{ ok: boolean; runs: DevRunInfo[] }>
  deleteTask: (taskDir: string, expectedMtime?: number) => Promise<{ ok: boolean; error?: string; conflict?: boolean }>
  /**
   * G4：Jira → 本地轻任务（design §7.2 单一创建器 LocalTaskService）。
   * 入参为旧契约超集：issueId/fullDescription/updatedAtMs/allowAdditional 为 G4 新增；
   * 旧调用方（AcpConsole 导入）只传基础字段仍成立。成功响应为超集：
   * created/already 区分本次新建与打开已有；archived 表示已有任务已归档；
   * notes 携带服务侧可见说明（如恢复/保留用户改动）。失败带 serviceCode
   * （control_store/cli_failed/conflict/interrupted/invalid/internal）供 UI 分级。
   */
  createTaskFromJira: (input: {
    integration?: import('./integrations').BindingRequest
    /** 期望的任务 slug（旧字段，兼容既有调用）；缺省由服务按 issueKey+标题派生 */
    dirName?: string
    title: string
    description: string
    status?: string
    priority: string
    assignee: string
    jiraKey: string
    jiraUrl: string
    /** Jira 数字稳定 issue id（服务端未返回可缺省） */
    issueId?: number | null
    /** 服务端返回的完整描述原文（wiki 标记原样） */
    fullDescription?: string | null
    /** 工单更新时间（Unix 毫秒；非法/缺失不写时间标识） */
    updatedAtMs?: number | null
    /** 显式一单多任务新增序号（UI 不提供快捷入口，仅登记） */
    allowAdditional?: boolean
  }) => Promise<{
    ok: boolean
    error?: string
    code?: string
    serviceCode?: string
    dirName?: string
    created?: boolean
    already?: boolean
    archived?: boolean
    notes?: string[]
  }>
  readTextFile: (absPath: string) => Promise<{ ok: boolean; error?: string; content?: string; mtime?: number }>
  /** S0 G2：文档限界读取（design §5.1）——revision=内容摘要；文档级事实（缺失/坏行/超限）走诊断 */
  documentRead: (scope: DocumentReadScope, input: DocumentReadRequest) => Promise<DocumentReadOutcome>
  /** S0 G2：行级版本比较（design §6.2）——基准=会话文本或最近提交；超限/超时/无 Git 基线走降级诊断 */
  documentDiff: (scope: DocumentReadScope, input: DocumentDiffRequest) => Promise<DocumentDiffOutcome>
  /** S0 G2 第三片：注册阅读会话的定向变更监听（返回 canonicalPath 作为解除键） */
  documentWatch: (
    scope: DocumentReadScope,
    input: { relativePath: string; knownRevision: string | null }
  ) => Promise<DocumentWatchOutcome>
  /** 精确解除 watchId；旧路径单参调用安全忽略，监听由项目/窗口清理收口。 */
  documentUnwatch: (canonicalPath: string, watchId?: string) => Promise<void>
  /** 定向文档变更事件（只针对已注册的 canonicalPath） */
  onDocumentChanged: (cb: (e: DocumentChangedEvent) => void) => () => void
  /** S0 G3：观测事件查询（limit≤100；cursor epoch 不符 → resetRequired 全量重拉，design §5.1） */
  observationQuery: (
    scope: ObservationScope,
    request: ObservationQueryRequest
  ) => Promise<ObservationQuerySuccess | IpcFail>
  /** S0 G3：订阅增量（返回快照基准 cursor；增量经 onObservationEvents 推送，按 eventId 去重）。pollMs=轮询请求（可见 1s/后台 5s） */
  observationSubscribe: (
    scope: ObservationScope,
    options?: { afterCursor?: ObservationCursor; pollMs?: number }
  ) => Promise<ObservationSubscribeResult | IpcFail>
  /** 解除订阅（项目切换由主进程 generation 兜底取消） */
  observationUnsubscribe: (subscriptionId: string) => Promise<void>
  /** 订阅增量/复位推送（subscriptionId 关联） */
  onObservationEvents: (
    cb: (e: { subscriptionId: string; event: ObservationSubscriptionEvent }) => void
  ) => () => void
  /** S0 G3 第二片：绑定/健康综合状态（含绑定 workspaceId，供渲染端组 scope） */
  observationHealth: () => Promise<ObservationStatusResult | IpcFail>
  /** G3 走查补全：首次显式绑定当前项目（未绑定分支的唯一入口，design §3.1） */
  observationBind: () => Promise<
    { ok: true; bound: boolean; bindingStatus: string; status: ObservationStatusResult } | IpcFail
  >
  /** S0 G3 第二片：启用/停用采集（需已有绑定；未绑定为中性事实） */
  observationSetEnabled: (enabled: boolean) => Promise<{ ok: true; health: ObservationHealth } | IpcFail>
  /** S0 G3 第二片：清理观测（retention=保留策略清理；all=清空观测记录，epoch 更换） */
  observationCleanup: (
    mode: 'retention' | 'all'
  ) => Promise<{ ok: true; removed: number; resumed: boolean } | { ok: true; storeEpoch: string } | IpcFail>
  /** write restricted to .trellis/spec/** (spec editor) */
  writeSpecFile: (absPath: string, content: string, expectedMtime?: number) => Promise<{ ok: boolean; error?: string; conflict?: boolean }>
  specBacklinks: () => Promise<{ ok: boolean; error?: string; counts?: Record<string, number> }>
  revealInExplorer: (absPath: string) => Promise<void>
  openInEditor: (absPath: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  openLocalDocument: (href: string) => Promise<import('./local-document-link').LocalDocumentOpenResult>

  getSettings: () => Promise<Settings>
  onThemeChanged: (cb: (theme: Settings['theme']) => void) => () => void
  setSettings: (patch: Partial<Settings>) => Promise<Settings>

  runCli: (args: string[]) => Promise<number>
  abortCli: (runId: number) => Promise<void>
  onCliOutput: (cb: (e: RunEvent) => void) => () => void
  onCliDone: (cb: (e: RunDoneEvent) => void) => () => void

  /* --- Git integration --- */
  gitTaskInfo: (dirName: string) => Promise<TaskGitInfo>
  gitCreateBranch: (name: string, fromBase: string) => Promise<{ ok: boolean; error?: string }>

  /* --- Analytics & reports --- */
  getAnalytics: () => Promise<AnalyticsResult>
  generateReport: (scope: 'personal' | 'team') => Promise<ReportResult>
  saveReport: (fileName: string, markdown: string) => Promise<{ ok: boolean; error?: string; path?: string }>

  /* --- Channels runtime --- */
  channelList: () => Promise<{ ok: boolean; error?: string; channels?: ChannelSummary[] }>
  channelSend: (name: string, text: string) => Promise<{ ok: boolean; error?: string }>

  /* --- AI bridge --- */
  installTpanel: () => Promise<{ ok: boolean; error?: string; path?: string }>
  installTrellisHooks: () => Promise<{ ok: boolean; error?: string; message?: string }>
  /** pull (and clear) a queued deep-link focus — used by cold start before listeners attach */
  pullPendingFocus: () => Promise<{ taskDir: string; root: string | null } | null>
  copyToClipboard: (text: string) => Promise<void>
  setCapsuleMode: (on: boolean) => void
  /** Open the main window at a task only while its captured project is current. */
  openMainTask: (projectRoot: string, taskDir: string) => Promise<{ ok: true } | IpcFail>
  setCapsuleOnTop: (on: boolean) => Promise<void>
  setCapsuleShape: (shape: 'pill' | 'card') => Promise<void>
  closeCapsule: () => Promise<void>
  resizeCapsule: (width: number, height: number) => Promise<void>
  /** Show the quick-note window without toggling an already visible window. */
  showQuickTodo: () => Promise<void>
  /** 隐藏速记窗（全局热键呼出的迷你待办速记窗，失焦/Esc 后由渲染层调用） */
  closeQuickTodo: () => Promise<void>
  onQuickTodoShown: (cb: () => void) => () => void
  onToast: (cb: (e: ToastEvent) => void) => () => void
  onBridgeTaskFocus: (cb: (taskDir: string) => void) => () => void
  onMaterialUpdated: (cb: (e: MaterialUpdatedEvent) => void) => () => void
  onFocusLastReading: (cb: () => void) => () => void
  getMcpInfo: () => Promise<McpInfo>
  toggleHttpApi: (on: boolean) => Promise<{ ok: boolean; error?: string }>

  /* --- 对话（Chat 页） --- */
  chatList: () => Promise<{ ok: boolean; error?: string; sessions?: ChatSessionMeta[] }>
  chatOpen: (id: string) => Promise<{ ok: boolean; error?: string; session?: ChatSessionView }>
  chatNew: (binding?: { providerId?: string; modelId?: string; thinkingLevel?: ThinkingLevel }) => Promise<{ ok: boolean; error?: string; session?: ChatSessionView }>
  chatDelete: (id: string) => Promise<{ ok: boolean; error?: string }>
  chatRename: (id: string, title: string) => Promise<{ ok: boolean; error?: string }>
  chatSend: (input: {
    sessionId: string
    content: string
    providerId?: string
    modelId?: string
    thinkingLevel?: ThinkingLevel
    /** dataURL 形式的图片附件（TPD-019） */
    images?: string[]
    /** agent 模式：启用工具调用循环（TPD-020） */
    agent?: boolean
    /** 会话聚焦的任务目录（系统提示词注入任务上下文） */
    taskDir?: string | null
  }) => Promise<ChatSendResult>
  chatRegenerate: (sessionId: string) => Promise<ChatSendResult>
  chatSteer: (sessionId: string, content: string) => Promise<{ ok: boolean; error?: string }>
  chatScreenshot: () => Promise<{ ok: boolean; error?: string; dataUrl?: string }>
  chatResolvePermission: (permId: string, decision: 'allow-once' | 'allow-session' | 'deny') => Promise<{ ok: boolean; error?: string }>
  chatEditResend: (sessionId: string, messageId: string, content: string) => Promise<ChatSendResult>
  chatBranch: (sessionId: string, messageId: string) => Promise<{ ok: boolean; error?: string }>
  chatAbort: (sessionId: string) => Promise<{ ok: boolean; error?: string }>
  /** 对话沉淀：一条 AI 回答 → AI 加工（拟题/打标/整理）→ 存入我的笔记库 */
  chatDistill: (sessionId: string, messageId: string) => Promise<{ ok: boolean; error?: string; fileName?: string; path?: string }>
  onChatPermission: (
    cb: (e: { runId: string; sessionId: string; permId: string; toolName: string; argsSummary: string; timeoutSec: number }) => void
  ) => () => void
  onChatSteer: (cb: (e: { runId: string; sessionId: string; content: string }) => void) => () => void
  onChatOutput: (cb: (e: ChatOutputEvent) => void) => () => void
  onChatDone: (cb: (e: ChatDoneEvent) => void) => () => void

  /* --- TPAP 本地接入协议 --- */
  accessStatus: () => Promise<{
    enabled: boolean
    running: boolean
    port: number | null
    endpoint: string | null
    token: string
  }>
  accessRotateToken: () => Promise<{ ok: boolean; token: string }>

  /* --- Jira --- */
  jiraTest: (cfg: JiraConfig) => Promise<{ ok: boolean; error?: string; displayName?: string }>
  jiraSearch: (cfg: JiraConfig, jql: string) => Promise<{ ok: boolean; error?: string; issues?: JiraIssue[]; total?: number }>
  /** G4 第二片：分页查询（完整字段 issueId/description/updatedAtMs + 完整性口径；sample ≠ 失败） */
  jiraSearchPaged: (
    cfg: JiraConfig,
    jql: string,
    opts?: { maxPages?: number }
  ) => Promise<{
    ok: boolean
    error?: string
    issues?: JiraIssueDetail[]
    /** 服务端报告总数（token 协议不可验证时为已去重条数） */
    total?: number
    meta?: JiraPagedSearchMeta
  }>
  jiraTransitions: (cfg: JiraConfig, key: string) => Promise<{ ok: boolean; error?: string; transitions?: JiraTransition[] }>
  jiraTransition: (cfg: JiraConfig, key: string, transitionId: string) => Promise<{ ok: boolean; error?: string }>
  jiraComment: (cfg: JiraConfig, key: string, body: string) => Promise<{ ok: boolean; error?: string }>

  /* --- ACP Agent 控制台 --- */
  acpAgents: () => Promise<{ ok: boolean; error?: string; agents?: AcpAgentStatus[] }>
  acpSessions: () => Promise<{ ok: boolean; error?: string; sessions?: AcpSessionRecord[] }>
  acpHistoryList: (input?: { limit?: number; cursor?: string; query?: string; filter?: 'all' | 'resumable' | 'transcript'; archive?: 'active' | 'archived' | 'all' }) => Promise<import('./acp-history').AcpHistoryListResult | IpcFail>
  acpHistoryUpdate: (sessionId: string, input: import('./acp-history').AcpHistoryUpdateInput) => Promise<import('./acp-history').AcpHistoryUpdateResult | IpcFail>
  acpHistorySession: (sessionId: string) => Promise<{ ok: true; version: 1; session: import('./acp-history').AcpHistorySummary } | IpcFail>
  acpHistoryEvents: (sessionId: string, input?: { before?: string; after?: string; limit?: number }) => Promise<import('./acp-history').AcpHistoryEventPage | IpcFail>
  acpHistoryRetry: (sessionId: string) => Promise<{ ok: true; historyPersistence: import('./acp-history').AcpHistoryPersistence } | IpcFail>
  acpSessionNew: (input: { agentId: string; profileId?: string; taskDir?: string }) => Promise<{ ok: boolean; error?: string; sessionId?: string }>
  acpSessionPrompt: (sessionId: string, text: string, options?: AcpPromptOptions) => Promise<AcpPromptResult>
  acpSessionBindTask: (sessionId: string, input: AcpBindTaskInput) => Promise<{ ok: boolean; error?: string; code?: string; session?: AcpSessionRecord }>
  acpSessionCancel: (sessionId: string) => Promise<{ ok: boolean; error?: string }>
  acpSessionKill: (sessionId: string) => Promise<{ ok: boolean; error?: string }>
  acpPermissionRespond: (requestId: string, optionId: string) => Promise<{ ok: boolean; error?: string }>
  acpProfiles: () => Promise<{ ok: boolean; error?: string; profiles?: AcpAgentProfile[] }>
  acpProfileSave: (profile: AcpAgentProfile) => Promise<{ ok: boolean; error?: string; profile?: AcpAgentProfile }>
  acpProfileDelete: (id: string) => Promise<{ ok: boolean; error?: string }>
  acpRuntimeRefresh: () => Promise<{ ok: boolean; error?: string; agents?: AcpAgentStatus[] }>
  acpRuntimeSetup: (runtimeId: string) => Promise<{ ok: boolean; error?: string; agents?: AcpAgentStatus[] }>
  acpRuntimeNodePick: () => Promise<{ ok: boolean; error?: string; cancelled?: boolean; nodePath?: string; agents?: AcpAgentStatus[] }>
  /** 测试连接：initialize-only 握手探测，零会话副作用；probe.ok 表示握手是否成功 */
  acpRuntimeTestConnection: (runtimeId: string) => Promise<{ ok: boolean; error?: string; probe?: AcpConnectionProbeResult }>
  /** 配置原生直连 Runtime 的 CLI 路径；取消返回 cancelled，路径无效返回失败且不保存 */
  acpRuntimePathPick: (runtimeId: string) => Promise<{ ok: boolean; error?: string; cancelled?: boolean; agents?: AcpAgentStatus[] }>
  acpSessionResume: (sessionId: string) => Promise<{ ok: boolean; error?: string; sessionId?: string }>
  acpSessionConfigure: (sessionId: string, input: AcpConfigureInput) => Promise<{ ok: boolean; error?: string; session?: AcpSessionRecord }>
  acpSessionRecoverModel: (sessionId: string, input: import('./acp-recovery').AcpRecoverModelInput) => Promise<import('./acp-recovery').AcpRecoverModelResult>
  onAcpState: (cb: (e: AcpStateEvent) => void) => () => void
  onAcpOutput: (cb: (e: TimelineEvent) => void) => () => void
  onAcpPermission: (cb: (e: AcpPermissionPayload) => void) => () => void
  onAcpDone: (cb: (e: AcpDoneEvent) => void) => () => void

  /* --- GitLab connector --- */
  gitlabTest: (cfg: GitLabConfig) => Promise<{ ok: boolean; error?: string; displayName?: string }>
  gitlabTaskStatus: (dirName: string) => Promise<GitLabTaskStatus>
  gitlabCreateMr: (dirName: string) => Promise<{ ok: boolean; error?: string; url?: string }>

  /* --- task intake --- */
  createTask: (input: { title: string; description: string; priority: string }) => Promise<{ ok: boolean; error?: string; dirName?: string }>

  /* --- todos (backlog) --- */
  todoList: () => Promise<{ ok: boolean; error?: string; todos?: TodoItem[] }>
  todoSave: (input: {
    id?: string
    title: string
    description: string
    priority?: string
    source?: 'jira' | 'manual'
    jiraKey?: string
    jiraUrl?: string
    status?: 'pending' | 'converted' | 'dismissed'
  }) => Promise<{ ok: boolean; error?: string; todo?: TodoItem }>
  todoDelete: (id: string) => Promise<{ ok: boolean; error?: string }>

  /* --- inbox --- */
  onInboxNew: (cb: (e: InboxNewEvent) => void) => () => void

  /* --- docs search --- */
  docsSearch: (query: string, group: 'all' | 'spec' | 'workspace') => Promise<{ ok: boolean; error?: string; hits?: DocSearchHit[] }>

  /* --- Studio 定制中心 --- */
  studioScan: () => Promise<{ ok: boolean; error?: string; scan?: StudioScan }>
  studioRead: (absPath: string) => Promise<{ ok: boolean; error?: string; content?: string; mtime?: number }>
  studioWrite: (absPath: string, content: string, expectedMtime?: number) => Promise<{ ok: boolean; error?: string; conflict?: boolean }>
  studioSetConfig: (patch: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
  studioSetDeveloper: (content: string) => Promise<{ ok: boolean; error?: string }>
  studioCreateWorkflow: (id: string) => Promise<{ ok: boolean; error?: string; path?: string }>
  studioCreateExtension: (kind: ExtKind, platform: string, name: string) => Promise<{ ok: boolean; error?: string; path?: string }>
  studioDeleteFile: (absPath: string) => Promise<{ ok: boolean; error?: string }>

  /* --- Knowledge 知识库 --- */
  kbSearch: (library: KbLibrary | 'all', query: string) => Promise<KbSearchResult>
  kbSaveNote: (fileName: string, content: string) => Promise<{ ok: boolean; error?: string; path?: string }>
  kbDeleteNote: (fileName: string) => Promise<{ ok: boolean; error?: string }>
  kbQaHistory: () => Promise<{ ok: boolean; entries?: KbQaEntry[] }>
  kbQaSave: (entry: { question: string; answer: string; sources?: Array<{ title: string; path: string; library?: string }> }) => Promise<{ ok: boolean; error?: string; entries?: KbQaEntry[] }>
  kbQaClear: () => Promise<{ ok: boolean }>

  /* --- AI 工作流（定制中心 Flow） --- */
  managedWorkflow: import('./workflow-desktop').WorkflowDesktopApi
  teamDesktop: import('./team-desktop-bridge').TeamDesktopBridgeApi
  flowList: () => Promise<{ ok: boolean; error?: string; flows?: FlowSummary[] }>
  flowRead: (id: string) => Promise<{ ok: boolean; error?: string; def?: FlowDef }>
  flowSave: (def: FlowDef) => Promise<{ ok: boolean; error?: string; path?: string }>
  flowDelete: (id: string) => Promise<{ ok: boolean; error?: string }>
  flowGenerate: (description: string) => Promise<{ ok: boolean; error?: string; def?: FlowDef }>
  flowTemplates: () => Promise<{ ok: boolean; templates?: FlowDef[] }>
  flowInstallTemplate: (def: FlowDef) => Promise<{ ok: boolean; error?: string }>
  flowRun: (id: string, input: Record<string, string>) => Promise<FlowRunResult>
  flowAbort: (runId: string) => Promise<{ ok: boolean; error?: string }>
  flowRuns: (limit?: number) => Promise<{ ok: boolean; runs?: FlowRunRecord[] }>
  onFlowOutput: (cb: (e: FlowRunEvent) => void) => () => void
  onFlowDone: (cb: (e: { runId: string; flowId: string; status: string; error?: string; flowName?: string }) => void) => () => void

  /* --- WeKnora 公司库联动 --- */
  weknoraTest: (cfg: WeknoraConfig) => Promise<{ ok: boolean; error?: string; kbs?: WeknoraKbSummary[] }>
  weknoraSearch: (query: string, limit?: number) => Promise<WeknoraSearchResult>
  weknoraListDocs: (kbId: string) => Promise<{ ok: boolean; error?: string; docs?: WeknoraDocSummary[] }>
  weknoraRead: (knowledgeId: string) => Promise<WeknoraReadResult>
  weknoraTestMcp: (url: string, token: string) => Promise<{ ok: boolean; error?: string }>

  /* --- AI（baseUrl 自定义模型与多供应商） --- */
  aiChat: (messages: ChatMessage[]) => Promise<AiChatResult>
  aiTest: (cfg: AiConfig) => Promise<AiChatResult>
  aiFetchModels: (provider: ModelProvider) => Promise<ModelFetchResult>
  aiTestModel: (provider: ModelProvider, modelId: string) => Promise<ModelTestResult>
  aiPrdDraft: (dirName: string) => Promise<AiChatResult>
  aiSummary: (dirName: string) => Promise<AiChatResult>
  aiPlan: (input: { title: string; description: string; jiraKey?: string; jiraUrl?: string }) => Promise<PlanResult>
  /** 创建合同：files 为实际落盘文件；warnings 非空时界面不得宣称对应产物已生成 */
  taskCreateFromPlan: (input: TaskPlan & { jiraKey?: string; jiraUrl?: string }) => Promise<{
    ok: boolean
    error?: string
    dirName?: string
    files?: string[]
    warnings?: string[]
  }>
  /** 父子关联唯一权威路径：task.py add/remove-subtask（B3） */
  taskLinkSubtask: (parentDir: string, childDir: string, remove?: boolean) => Promise<{ ok: boolean; error?: string }>
  aiSplitEpic: (dirName: string) => Promise<{ ok: boolean; error?: string; created?: string[] }>
  aiCommitMsg: (dirName: string) => Promise<AiChatResult>
  aiPrDesc: (dirName: string) => Promise<AiChatResult>
  taskWriteArtifact: (dirName: string, fileName: string, content: string) => Promise<{ ok: boolean; error?: string; path?: string }>
  taskResolveClipboardTask: () => Promise<{ ok: true; dirName: string; archived: boolean } | { ok: false; error: string }>
  taskBuildTaskLink: (dirName: string) => Promise<{ ok: true; url: string } | { ok: false; error: string }>
  taskDispatchReview: (dirName: string) => Promise<{
    ok: boolean
    phase?: string
    error?: string
    report?: string
    channel?: string
  }>
  taskDispatchPlan: (input: { title: string; requirement: string }) => Promise<{
    ok: boolean
    phase?: string
    error?: string
    report?: string
    channel?: string
  }>
  taskDispatchAbort: () => Promise<{ ok: boolean }>
  onDispatchPhase: (cb: (p: { key: string; label: string; detail?: string }) => void) => () => void
  taskContextExpect: (dirName: string) => Promise<
    | { ok: false; error: string }
    | {
        ok: true
        implement: { present: boolean; totalBytes: number; entries: ContextExpectEntry[] }
        check: { present: boolean; totalBytes: number; entries: ContextExpectEntry[] }
        caps: { perFile: number; total: number }
      }
  >
  taskHandoffBuild: (dirName: string, intent: string, includePrd: boolean) => Promise<{
    ok: boolean
    error?: string
    text: string
    issues: string[]
    files: string[]
    gitLines: string[]
    checkFiles: string[]
    uncheckedSubtasks: string[]
    openQuestions: string[]
  }>
  desktopSetExplorerMenu: (on: boolean) => Promise<{ ok: boolean; supported: boolean; reason?: string }>

  /* --- KB-MCP --- */
  kbMcpInstall: () => Promise<KbMcpInstallResult>
  kbMcpStatus: () => Promise<KbMcpStatus>

  /* --- Studio 跨平台同步 --- */
  studioSyncExtension: (sourcePath: string, targets: string[]) => Promise<SyncExtensionResult>

  /* --- Channel 动作（create/rm/kill/interrupt/wait/spawn） --- */
  channelAction: (args: string[]) => Promise<{ ok: boolean; error?: string; output?: string }>
  channelDispatch: (input: { taskDir?: string; text?: string; channel?: string }) => Promise<{ ok: boolean; error?: string; channel?: string }>

  /* --- 站会报告 --- */
  generateStandup: () => Promise<ReportResult>

  /* --- Gateway MCP 网关 --- */
  gatewayStatus: () => Promise<GatewayStatus>
  gatewaySearch: (query: string, limit?: number) => Promise<GatewaySearchResult>
  gatewayRecentLogs: () => Promise<GatewayLogEntry[]>
  gatewaySyncSpec: (remoteDocId: string, targetFileName: string) => Promise<{ ok: boolean; error?: string; path?: string }>
  gatewayTestProvider: (providerId: string) => Promise<{ ok: boolean; error?: string; details?: Record<string, unknown> }>
  gatewayTestTool: (toolName: string, args: Record<string, unknown>) => Promise<GatewayTestToolResult>
  gatewayUpdateSecurity: (security: GatewaySecurityConfig) => Promise<{ ok: boolean }>

  /* --- window --- */
  windowMinimize: () => void
  windowMaximize: () => void
  windowClose: () => void
  onWindowMaximized: (cb: (maximized: boolean) => void) => () => void
}

export interface ContextHit {
  id: string
  title: string
  source: string
  sourceLabel: string
  path?: string
  snippet: string
  score: number
  metadata?: Record<string, unknown>
}

export interface GatewayToolDef {
  name: string
  description: string
  upstreamId: string
  parameters: Record<string, { type: string; description: string; required?: boolean; default?: unknown }>
  isReadOnly: boolean
  securityRule?: string
}

export interface GatewayUpstream {
  id: string
  name: string
  category: 'database' | 'knowledge' | 'project' | 'custom'
  description: string
  status: 'connected' | 'disconnected' | 'error' | 'disabled'
  endpoint?: string
  tools: GatewayToolDef[]
  isRemote: boolean
  enabled: boolean
  error?: string
  lastChecked?: number
  config?: Record<string, unknown>
}

export interface GatewaySecurityConfig {
  sqlReadOnly: boolean
  timeoutMs: number
  maxResponseChars: number
}

export interface GatewayLogEntry {
  id: string
  timestamp: number
  toolName: string
  upstreamId: string
  input?: Record<string, unknown>
  status: 'success' | 'blocked' | 'error'
  elapsedMs: number
  responsePreview?: string
  error?: string
  query?: string
  hitsCount?: number
  sources?: Array<{ source: string; label: string; count: number }>
}

export interface GatewayProviderSummary {
  id: string
  name: string
  description: string
  isRemote: boolean
  enabled: boolean
  status: 'connected' | 'disconnected' | 'error' | 'disabled'
  itemCount?: number
  lastChecked?: number
  error?: string
}

export interface GatewayStatus {
  ok: boolean
  running: boolean
  transport: 'stdio' | 'sse' | 'http'
  upstreams: GatewayUpstream[]
  tools: GatewayToolDef[]
  security: GatewaySecurityConfig
  totalQueries: number
  recentLogs: GatewayLogEntry[]
  providers?: GatewayProviderSummary[]
}

export interface GatewayTestToolResult {
  ok: boolean
  elapsedMs: number
  result?: unknown
  error?: string
  blockedBySecurity?: boolean
}

export interface GatewaySearchResult {
  hits: ContextHit[]
  elapsedMs: number
  sources: Array<{ source: string; label: string; count: number }>
}

/* ---------- ACP Agent 控制台（10-09-acp-agent-console） ---------- */

/** 设置页注册表里的一条 ACP agent（任意 NDJSON ACP agent 通用） */
export interface AcpAgentConfig {
  id: string
  name: string
  /** 命令模板（整行交给 shell，如 `codex-acp` / `gemini --acp` / `node scripts/smoke/acp-mock-agent.mjs --serve`） */
  command: string
  enabled: boolean
  /** Frozen launch provenance; Settings overrides are always user-managed. */
  launchKind?: 'managed' | 'custom' | 'native'
  executable?: string
  args?: string[]
}

/** 注册表条目 + 本机可用性探测结果 */
export interface AcpAgentStatus extends AcpAgentConfig {
  available: boolean
  runtimeId?: string
  health?: AcpRuntimeHealth
  diagnostics?: string[]
  adapterVersion?: string
  /** 原生直连条目：npm 注册表 latest 版本；查询失败留空即"未知"，UI 不据此提示升级。 */
  latestVersion?: string
  nodePath?: string
  setupRequired?: boolean
  checkedAt?: number
}

export type AcpRuntimeHealth = 'not_checked' | 'executable_missing' | 'adapter_missing' | 'launch_error' | 'incompatible' | 'auth_required' | 'directory_unavailable' | 'ready'

/** 测试连接（R7）：initialize-only 握手结果；绝不发送 session/new，authMethodIds 非空仅提示需认证，不做认证动作。 */
export interface AcpConnectionProbeResult {
  ok: boolean
  agentInfo?: { name?: string; version?: string }
  protocolVersion?: number
  authMethodIds?: string[]
  /** 精选能力白名单的中文标签（如「图片输入」「会话恢复」「MCP」）；未知能力如实忽略 */
  capabilitiesSummary?: string[]
  error?: string
}

/** 注入 Runtime 子进程的环境变量；仅保存在本机角色配置，不进入历史记录。 */
export interface AcpProfileEnvVar {
  key: string
  value: string
}

/** 追加到 Runtime 启动命令之后的自定义参数。 */
export interface AcpProfileArg {
  name: string
  value: string
}

export interface AcpAgentProfile {
  id: string
  name: string
  description: string
  instructions: string
  runtimeId: string
  cwd?: string
  maxTurnMinutes: number
  env?: AcpProfileEnvVar[]
  args?: AcpProfileArg[]
}

export interface AcpStartupObservation {
  label: string
  atMs: number
  durationMs?: number
  status: 'observed' | 'failed'
}

export interface AcpConfigOption {
  id: string
  name: string
  category?: string
  currentValue: string
  options: Array<{ value: string; name: string }>
}

export type AcpConfigureInput = { kind: 'model' | 'mode' | 'config'; id: string; value?: string }

/** Captured from a modern document read, never from Agent prose. */
export interface AcpSourceReference {
  projectRoot: string
  taskDir: string
  relativePath: string
  displayedRevision: string
  targetSessionId: string
  targetConnectionGeneration?: string
  sectionAnchor?: string
  quote?: string
}

export interface AcpPromptOptions {
  expectedConnectionGeneration?: string
  sourceReferences?: AcpSourceReference[]
  images?: import('./acp-images').AcpImageAttachment[]
}

export interface AcpSourceChange {
  relativePath: string
  expectedRevision: string
  actualRevision: string | null
  available: boolean
}

export interface AcpPromptResult {
  ok: boolean
  error?: string
  code?: string
  reason?: 'SOURCE_CHANGED' | 'SCOPE_CHANGED'
  sources?: AcpSourceChange[]
  turnId?: string
}

export interface AcpBindTaskInput {
  taskDir: string | null
  expectedConnectionGeneration: string
}

export interface AcpMaterialSource {
  relativePath: string
  sourceRevision: string | null
  includedRevision: string | null
  sourceBytes: number | null
  includedBytes: number
  includedChars: number
  included: boolean
  truncated: boolean
  extent: { start: number; end: number; unit: 'utf16-code-units' }
  status: 'included' | 'missing' | 'unreadable' | 'omitted'
  diagnostics?: string[]
}

export interface AcpMaterialChange {
  projectRoot: string
  projectGeneration: number
  taskDir: string
  relativePath: string
  kind: 'add' | 'change' | 'unlink'
  source: 'filesystem-event'
  observedAt: number
  revision: string | null
  availability: 'readable' | 'missing' | 'unreadable'
}
export type AcpSessionStatus = 'starting' | 'ready' | 'busy' | 'awaiting_permission' | 'cancelling' | 'disconnected' | 'legacy' | 'error' | 'closed'

export interface AcpStateEvent {
  sessionId: string
  projectRoot: string
  connectionGeneration?: string
  turnId?: string
  status: AcpSessionStatus
  error?: string
  session?: AcpSessionRecord
  pendingPermissions?: AcpPermissionPayload[]
  stateRevision?: number
  historyPersistence?: import('./acp-history').AcpHistoryPersistence
}

/** Legacy terminal records may lack scope; new service emissions include it. */
export interface AcpDoneEvent {
  sessionId: string
  status: AcpSessionStatus
  error?: string
  projectRoot?: string
  connectionGeneration?: string
  turnId?: string
  session?: AcpSessionRecord
  result?: unknown
}

export interface AcpSessionMeta {
  sessionId: string
  agentId: string
  agentName: string
  projectRoot: string
  /** 会话绑定的 Trellis 任务目录名（可选；绑定后 trellis 轨道卡片按任务归属） */
  taskDir?: string
  status: AcpSessionStatus
  startedAt: number
  endedAt?: number
  error?: string
  /** Effective title; a human customTitle takes precedence over the automatic title. */
  title?: string
  customTitle?: string
  pinnedAt?: number
  archivedAt?: number
  /** Bounded coherent latest-message text for catalogue rows/tooltips. */
  conversationPreview?: string
  conversationPreviewAt?: number
  schemaVersion?: number
  backendSessionId?: string
  agentSessionId?: string
  acpxRecordId?: string
  connectionGeneration?: string
  turnId?: string
  cwd?: string
  profileSnapshot?: AcpAgentProfile
  runtimeSnapshot?: AcpAgentConfig
  startup?: AcpStartupObservation[]
  historyKind?: 'live' | 'resumable' | 'transcript' | 'legacy'
  canResume?: boolean
  restorePending?: boolean
  capabilities?: { controls: string[]; loadSession?: boolean; promptCapabilities?: { image?: boolean }; protocolVersion?: number; agentInfo?: Record<string, unknown>; authMethods?: unknown[] }
  models?: Array<{ modelId: string; name: string }>
  modes?: Array<{ id: string; name: string }>
  currentModelId?: string
  currentModeId?: string
  configOptions?: AcpConfigOption[]
  materialSnapshot?: { taskDir?: string; profileId?: string; instructions: string; files: string[]; capturedAt: number; sources?: AcpMaterialSource[]; sourceReferences?: AcpSourceReference[] }
  directoryLeaseReason?: string
  pendingPermissions?: AcpPermissionPayload[]
  stateRevision?: number
  historyPersistence?: import('./acp-history').AcpHistoryPersistence
  connectionOwned?: boolean
  cleanupRequired?: boolean
  recovery?: import('./acp-recovery').AcpRecoveryState
}

/** 会话持久化记录（userData/acp-sessions/<sessionId>.json，原子写） */
export interface AcpSessionRecord extends AcpSessionMeta {
  events: TimelineEvent[]
}

/** ACP 权限请求的选项（协议原样映射：allow_once / allow_always / reject_once） */
export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export interface AcpPermissionPayload {
  requestId: string
  sessionId: string
  agentName: string
  toolCall?: { toolCallId?: string; title?: string; kind?: string }
  options: AcpPermissionOption[]
  projectRoot?: string
  connectionGeneration?: string
  turnId?: string
  expiresAt?: number
}

/**
 * 双轨统一时间线事件：acp 轨道来自 session/update（对话/思考/工具/回合结束），
 * trellis 轨道来自面板自有信号（watcher / tpanel / jira 第一方动作）。
 * sessionId 对 trellis 轨道事件可空——渲染层按 projectRoot 关联当前会话。
 */
export type TimelineEventKind =
  | 'message'
  | 'thought'
  | 'tool-call'
  | 'turn-done'
  | 'permission'
  | 'session-status'
  | 'task-status'
  | 'doc-created'
  | 'spec-injected'
  | 'spec-updated'
  | 'jira-sync'
  | 'plan'
  | 'diagnostic'
  | 'config'
  | 'material-change'

export interface TimelineEvent {
  id: string
  ts: number
  source: 'acp' | 'trellis'
  sessionId?: string
  projectRoot: string
  taskDir?: string
  kind: TimelineEventKind
  text?: string
  payload?: Record<string, unknown>
  connectionGeneration?: string
  turnId?: string
  /** Archive read projection; excluded from original event identity. */
  historySeq?: number
}
