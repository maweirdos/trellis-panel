import type { InboxItem, ProjectSnapshot, Settings, ToastEvent, TodoItem, ChatMessageView, ChatSessionMeta, ThinkingLevel } from '../../../shared/types'
import type { api } from '../api'
import type { StateCreator } from 'zustand'

/* ---------------- 公共类型（store.ts 原样再导出，页面零改动） ---------------- */

export type Page =
  | 'dashboard'
  | 'inbox'
  | 'tasks'
  | 'knowledge'
  | 'spec'
  | 'archive'
  | 'channels'
  | 'team'
  | 'jira'
  | 'architecture'
  | 'studio'
  | 'models'
  | 'chat'
  | 'gateway'
  | 'settings'

export interface ToastItem extends ToastEvent {
  id: number
}

/** One open tab in the artifact viewer — VS Code style preview vs pinned */
export interface ViewerTab {
  file: { name: string; path: string; kind: 'file' | 'dir'; size: number; mtime: number; ext: string }
  pinned: boolean
}

export type InboxState = 'pending' | 'accepted' | 'snoozed' | 'dismissed'

export interface InboxEntry extends InboxItem {
  state: InboxState
}

/* ---------------- 各切片接口（TPD-006：按域拆分，组合出口不变） ---------------- */

export interface SessionSlice {
  snapshot: ProjectSnapshot | null
  setSnapshot: (snapshot: ProjectSnapshot) => void
  settings: Settings | null
  openError: string | null
  starting: boolean
  /** bootstrap 完成（项目已打开）——之前的桥接聚焦先暂存，避免被 openProjectPath 重置 */
  bootstrapped: boolean
  pendingFocusDir: string | null
  openTaskDir: string | null
  openTaskArchived: boolean
  bootstrap: () => Promise<void>
  openProjectPath: (root: string) => Promise<void>
  pickAndOpen: () => Promise<void>
  closeProject: () => Promise<void>
  refresh: () => Promise<void>
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  toggleTheme: () => void
  showTask: (dirName: string | null, archived?: boolean) => void
}

export interface UiSlice {
  page: Page
  capsuleMode: boolean
  sidebarCollapsed: boolean
  intakeOpen: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setPage: (p: Page) => void
  setIntakeOpen: (on: boolean) => void
}

export interface ToastSlice {
  toasts: ToastItem[]
  pushToast: (t: ToastEvent) => void
  dismissToast: (id: number) => void
}

export interface ViewerSlice {
  /** artifact viewer tabs (multi-file, preview-tab model) */
  viewerTabs: ViewerTab[]
  viewerActive: string | null
  openArtifact: (f: ViewerTab['file'], pinned?: boolean) => void
  closeArtifact: (path: string) => void
  pinArtifact: (path: string, pinned: boolean) => void
  setViewerActive: (path: string) => void
}

export interface TodosSlice {
  todos: TodoItem[]
  loadTodos: () => Promise<void>
  saveTodo: (input: Parameters<typeof api.todoSave>[0]) => Promise<boolean>
  deleteTodo: (id: string) => Promise<boolean>
}

export interface InboxSlice {
  inboxProjectRoot: string | null
  inbox: Record<string, InboxEntry>
  setInboxProject: (projectRoot: string | null) => void
  inboxAdd: (items: InboxItem[]) => void
  inboxSetState: (dirName: string, state: InboxState) => void
  inboxRemove: (dirName: string) => void
  inboxAcceptAll: () => void
}

/** 流式中的消息：runId 关联，增量由 chat:output 事件累积 */
export interface ChatStreamState {
  runId: string
  content: string
  /** 思考流增量单独累积（TPD-014） */
  reasoning: string
}

/** 本地已排队、尚未开跑的消息（runId 由主进程预分配） */
export interface ChatQueuedItem {
  runId: string
  content: string
}

export interface ChatSlice {
  chatSessions: ChatSessionMeta[]
  chatActiveId: string | null
  chatMessages: ChatMessageView[]
  chatStreaming: ChatStreamState | null
  chatPending: ChatQueuedItem[]
  /** 初始化事件订阅（App 挂载时调用一次，返回反注册函数） */
  chatAttachEvents: () => () => void
  chatLoadSessions: () => Promise<void>
  chatOpenSession: (id: string) => Promise<void>
  chatNewSession: (binding?: { providerId?: string; modelId?: string }) => Promise<ChatSessionMeta | null>
  chatDeleteSession: (id: string) => Promise<void>
  chatRenameSession: (id: string, title: string) => Promise<void>
  chatSend: (
    content: string,
    binding?: { providerId?: string; modelId?: string; thinkingLevel?: ThinkingLevel }
  ) => Promise<void>
  chatAbort: () => Promise<void>
  chatRegenerate: () => Promise<void>
  chatEditResend: (messageId: string, content: string) => Promise<void>
  chatBranch: (messageId: string) => Promise<void>
}

export type AppState = SessionSlice & UiSlice & ToastSlice & ViewerSlice & TodosSlice & InboxSlice & ChatSlice

export type AppSlice<T> = StateCreator<AppState, [], [], T>
