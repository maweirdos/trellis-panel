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
  /** MM-DD part when the dir follows the dated convention; null for 00-* system tasks. */
  date: string | null
  record: TaskRecord | null
  parseError?: string
  phase: TaskPhase
  artifacts: FileEntry[]
  updatedAt: number
  archived?: boolean
}

export interface SpecNode {
  name: string
  path: string
  type: 'dir' | 'file'
  size?: number
  mtime?: number
  children?: SpecNode[]
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

export interface JiraConfig {
  enabled: boolean
  baseUrl: string
  user: string
  password: string
  /** Extra JQL filter ANDed with the default assignee query; empty = default. */
  jql: string
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

export interface Settings {
  recentProjects: string[]
  theme: 'dark' | 'light'
  cliCommand: string
  jira: JiraConfig
}

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

/** Toast notification pushed from main → any window. */
export interface ToastEvent {
  kind: 'info' | 'success' | 'warn' | 'error'
  title: string
  body?: string
}

/** Event fired when an AI tool (codex/zcode/hooks) touches a task. */
export interface BridgeEvent {
  type: 'task-event' | 'notify' | 'open-task'
  taskDir?: string | null
  text?: string
  source?: string
}

/** APIs exposed to the renderer via contextBridge. */
export interface TrellisApi {
  pickProject: () => Promise<string | null>
  openProject: (root: string) => Promise<{ ok: boolean; error?: string; snapshot?: ProjectSnapshot }>
  getSnapshot: () => Promise<ProjectSnapshot | null>
  closeProject: () => Promise<void>
  onSnapshotUpdated: (cb: (s: ProjectSnapshot) => void) => () => void

  updateTask: (taskDir: string, patch: TaskPatch) => Promise<{ ok: boolean; error?: string }>
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
  readTextFile: (absPath: string) => Promise<{ ok: boolean; error?: string; content?: string }>
  revealInExplorer: (absPath: string) => Promise<void>
  openInEditor: (absPath: string) => Promise<void>
  openExternal: (url: string) => Promise<void>

  getSettings: () => Promise<Settings>
  setSettings: (patch: Partial<Settings>) => Promise<Settings>

  runCli: (args: string[]) => Promise<number>
  abortCli: (runId: number) => Promise<void>
  onCliOutput: (cb: (e: RunEvent) => void) => () => void
  onCliDone: (cb: (e: RunDoneEvent) => void) => () => void

  /* --- AI bridge (codex / zcode / hooks) --- */
  installTpanel: () => Promise<{ ok: boolean; error?: string; path?: string }>
  installTrellisHooks: () => Promise<{ ok: boolean; error?: string; message?: string }>
  copyToClipboard: (text: string) => Promise<void>
  setCapsuleMode: (on: boolean) => Promise<void>
  setCapsuleOnTop: (on: boolean) => Promise<void>
  launchAiApp: (app: 'codex' | 'zcode' | 'claude', taskDir: string | null) => Promise<{ ok: boolean; error?: string }>
  onToast: (cb: (e: ToastEvent) => void) => () => void
  onBridgeTaskFocus: (cb: (taskDir: string) => void) => () => void

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
