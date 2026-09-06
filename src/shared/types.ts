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
}

export interface ChannelSummary {
  name: string
  bucket: string
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
}

export interface JiraTransition {
  id: string
  name: string
}

/* ---------- Settings ---------- */

export interface Settings {
  recentProjects: string[]
  theme: 'dark' | 'light'
  cliCommand: string
  jira: JiraConfig
  /** random per-install token; deep links & MCP/HTTP must carry it */
  bridgeToken: string
  httpApi: { enabled: boolean; port: number; lanAccess: boolean; webBoard: boolean }
  mcp: { enabled: boolean }
  desktop: { autoStart: boolean; globalShortcut: string; autoUpdate: boolean }
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
  codexConfig: string
  claudeConfig: string
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
  copyToClipboard: (text: string) => Promise<void>
  setCapsuleMode: (on: boolean) => void
  setCapsuleOnTop: (on: boolean) => Promise<void>
  launchAiApp: (app: 'codex' | 'zcode' | 'claude', taskDir: string | null) => Promise<{ ok: boolean; error?: string }>
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

  /* --- window --- */
  windowMinimize: () => void
  windowMaximize: () => void
  windowClose: () => void
  onWindowMaximized: (cb: (maximized: boolean) => void) => () => void
}
