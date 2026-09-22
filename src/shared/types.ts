/**
 * Shared IPC contract between the Electron main process and the renderer.
 * Mirrors the canonical Trellis task.json schema (24 fields, see
 * @mindfoldhq/trellis-core task/schema).
 */

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
  meta: Record<string, unknown>
}

/** Editable fields exposed by the task editor. */
export type TaskEditableField =
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
  /** auto sync every 10 minutes */
  autoSync: boolean
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

export interface JiraTransition {
  id: string
  name: string
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
  desktop: { autoStart: boolean; globalShortcut: string; autoUpdate: boolean }
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

/* ---------- Knowledge（知识库：需求 / 规范 / Wiki / 归档） ---------- */

export type KbLibrary = 'requirements' | 'spec' | 'wiki' | 'archive'

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

export interface HandoffText {
  platform: string
  text: string
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
export interface TrellisApi {
  pickProject: () => Promise<string | null>
  openProject: (root: string) => Promise<{ ok: boolean; error?: string; snapshot?: ProjectSnapshot }>
  getSnapshot: () => Promise<ProjectSnapshot | null>
  closeProject: () => Promise<void>
  onSnapshotUpdated: (cb: (s: ProjectSnapshot) => void) => () => void

  /** expectedMtime enables optimistic conflict detection */
  updateTask: (
    taskDir: string,
    patch: TaskPatch,
    expectedMtime?: number
  ) => Promise<{ ok: boolean; error?: string; conflict?: boolean }>
  deleteTask: (taskDir: string, expectedMtime?: number) => Promise<{ ok: boolean; error?: string; conflict?: boolean }>
  createTaskFromJira: (input: {
    dirName: string
    title: string
    description: string
    status: string
    priority: string
    assignee: string
    jiraKey: string
    jiraUrl: string
  }) => Promise<{ ok: boolean; error?: string; dirName?: string }>
  readTextFile: (absPath: string) => Promise<{ ok: boolean; error?: string; content?: string; mtime?: number }>
  /** write restricted to .trellis/spec/** (spec editor) */
  writeSpecFile: (absPath: string, content: string, expectedMtime?: number) => Promise<{ ok: boolean; error?: string; conflict?: boolean }>
  specBacklinks: () => Promise<{ ok: boolean; error?: string; counts?: Record<string, number> }>
  revealInExplorer: (absPath: string) => Promise<void>
  openInEditor: (absPath: string) => Promise<void>
  openExternal: (url: string) => Promise<void>

  getSettings: () => Promise<Settings>
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
  setCapsuleOnTop: (on: boolean) => Promise<void>
  setCapsuleShape: (shape: 'pill' | 'card') => Promise<void>
  closeCapsule: () => Promise<void>
  resizeCapsule: (width: number, height: number) => Promise<void>
  onToast: (cb: (e: ToastEvent) => void) => () => void
  onBridgeTaskFocus: (cb: (taskDir: string) => void) => () => void
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
  jiraTransitions: (cfg: JiraConfig, key: string) => Promise<{ ok: boolean; error?: string; transitions?: JiraTransition[] }>
  jiraTransition: (cfg: JiraConfig, key: string, transitionId: string) => Promise<{ ok: boolean; error?: string }>
  jiraComment: (cfg: JiraConfig, key: string, body: string) => Promise<{ ok: boolean; error?: string }>

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
  taskCreateFromPlan: (input: TaskPlan & { jiraKey?: string; jiraUrl?: string }) => Promise<{ ok: boolean; error?: string; dirName?: string }>
  planHandoff: (dirName: string) => Promise<HandoffText[]>
  aiSplitEpic: (dirName: string) => Promise<{ ok: boolean; error?: string; created?: string[] }>
  aiCommitMsg: (dirName: string) => Promise<AiChatResult>
  aiPrDesc: (dirName: string) => Promise<AiChatResult>
  taskArchive: (dirName: string) => Promise<{ ok: boolean; error?: string; dirName?: string }>
  taskWriteArtifact: (dirName: string, fileName: string, content: string) => Promise<{ ok: boolean; error?: string; path?: string }>

  /* --- KB-MCP --- */
  kbMcpInstall: () => Promise<KbMcpInstallResult>
  kbMcpStatus: () => Promise<KbMcpStatus>

  /* --- Studio 跨平台同步 --- */
  studioSyncExtension: (sourcePath: string, targets: string[]) => Promise<SyncExtensionResult>

  /* --- Channel 动作（create/rm/kill/interrupt/wait/spawn） --- */
  channelAction: (args: string[]) => Promise<{ ok: boolean; error?: string; output?: string }>

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
