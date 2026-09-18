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

/* ---------- Inbox (task triage) ---------- */

export interface InboxItem {
  dirName: string
  title: string
  creator: string
  ts: number
}

export interface InboxNewEvent {
  projectRoot: string
  items: InboxItem[]
}

/* ---------- Settings ---------- */

export interface AiConfig {
  enabled: boolean
  /** OpenAI 兼容 baseUrl，填到 /v1 即可；以 # 结尾则原样使用 */
  baseUrl: string
  /** stored encrypted via safeStorage when available */
  apiKey: string
  apiKeyEncrypted?: boolean
  model: string
  temperature: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
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
  /** random per-install token; deep links must carry it */
  bridgeToken: string
  httpApi: { enabled: boolean; port: number; lanAccess: boolean; webBoard: boolean }
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
  onToast: (cb: (e: ToastEvent) => void) => () => void
  onBridgeTaskFocus: (cb: (taskDir: string) => void) => () => void
  getMcpInfo: () => Promise<McpInfo>
  toggleHttpApi: (on: boolean) => Promise<{ ok: boolean; error?: string }>

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

  /* --- AI（baseUrl 自定义模型） --- */
  aiChat: (messages: ChatMessage[]) => Promise<AiChatResult>
  aiTest: (cfg: AiConfig) => Promise<AiChatResult>
  aiPrdDraft: (dirName: string) => Promise<AiChatResult>
  aiSummary: (dirName: string) => Promise<AiChatResult>
  aiPlan: (input: { title: string; description: string; jiraKey?: string; jiraUrl?: string }) => Promise<PlanResult>
  taskCreateFromPlan: (input: TaskPlan & { jiraKey?: string; jiraUrl?: string }) => Promise<{ ok: boolean; error?: string; dirName?: string }>
  planHandoff: (dirName: string) => Promise<HandoffText[]>
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

  /* --- window --- */
  windowMinimize: () => void
  windowMaximize: () => void
  windowClose: () => void
  onWindowMaximized: (cb: (maximized: boolean) => void) => () => void
}
