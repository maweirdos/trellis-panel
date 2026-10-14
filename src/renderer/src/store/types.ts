import type {
  InboxItem,
  ProjectSnapshot,
  Settings,
  ToastEvent,
  TodoItem,
  ChatImage,
  ChatMessageView,
  ChatSessionMeta,
  ChatToolOp,
  ThinkingLevel
} from '../../../shared/types'
import type {
  ObservationCursor,
  ObservationItem,
  ObservationStatusResult
} from '../../../shared/observability/store'
import type { api } from '../api'
import type { StateCreator } from 'zustand'
import type { ReadingSessionState, ReadingVersion } from '../reader/reading-session'
import type { ReaderWidthPref } from '../reader/reader-prefs'

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
  | 'acp'
  | 'gateway'
  | 'settings'
  | 'analytics'

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

/** TaskDetail 预览「展开为完整工作区」的来源记录（AC1：返回时回到原页面与位置）。 */
export interface TaskExpandOrigin {
  fromPage: Page
  taskDir: string
  archived: boolean
  scrollTop: number
}

export interface UiSlice {
  page: Page
  capsuleMode: boolean
  quickTodoMode: boolean
  sidebarCollapsed: boolean
  intakeOpen: boolean
  /** 非空 = 当前任务工作区是由快速预览展开进入的（Esc 返回预览而非关闭）。 */
  taskExpandOrigin: TaskExpandOrigin | null
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setPage: (p: Page) => void
  setIntakeOpen: (on: boolean) => void
  /** 预览 → 完整工作区（记录来源页面与滚动位置）。 */
  expandTaskWorkspace: (origin: TaskExpandOrigin) => void
  /** 工作区 → 返回来源页面的预览抽屉（恢复任务选中与滚动位置由调用方 rAF 处理）。 */
  returnFromWorkspace: () => TaskExpandOrigin | null
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

/**
 * 阅读会话域（S0 G2，design §6.2）：base/displayed/latest 三态由纯函数迁移
 * （reader/reading-session.ts），本切片只做登记与持久化边界——
 * 会话快照只在内存（关闭即丢、不进 localStorage）；宽度偏好持久化到本地设置。
 */
export interface ReaderSlice {
  /** 每个打开文档一个阅读会话（key = readingSessionKey(scope, relativePath)）。 */
  readingSessions: Record<string, ReadingSessionState>
  /** 阅读最大宽度偏好（680/760/880）。 */
  readerWidthPref: ReaderWidthPref
  /** 文档打开/重开：首次成功加载建立会话基线。 */
  readerOpenSession: (key: string, firstLoad: ReadingVersion) => void
  /** 文档关闭：丢弃会话快照（无跨重启）。 */
  readerCloseSession: (key: string) => void
  /** 外部变化只更新 latest 标记（不自动切换展示版）。 */
  readerExternalChange: (key: string, candidate: ReadingVersion) => void
  /** 「阅读新版」：替换 displayed，不改首次基线。 */
  readerReadNewVersion: (key: string) => void
  /** 「以当前为本次基线」：base := displayed。 */
  readerRebaseToCurrent: (key: string) => void
  /** 项目切换/关闭：清空全部会话快照（主进程同步清空变更信号桥监听）。 */
  readerClearAllSessions: () => void
  setReaderWidthPref: (pref: ReaderWidthPref) => void
}

/** 流式中的消息：runId 关联，增量由 chat:output 事件累积 */
export interface ChatStreamState {
  runId: string
  content: string
  /** 思考流增量单独累积（TPD-014） */
  reasoning: string
  /** agent 工具行（TPD-020） */
  toolOps: ChatToolOp[]
}

export interface PendingPermission {
  permId: string
  toolName: string
  argsSummary: string
  timeoutSec: number
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
  /** 待决策工具权限卡（TPD-020） */
  chatPendingPermission: PendingPermission | null
  /** 初始化事件订阅（App 挂载时调用一次，返回反注册函数） */
  chatAttachEvents: () => () => void
  chatLoadSessions: () => Promise<void>
  chatOpenSession: (id: string) => Promise<void>
  chatNewSession: (binding?: { providerId?: string; modelId?: string }) => Promise<ChatSessionMeta | null>
  chatDeleteSession: (id: string) => Promise<void>
  chatRenameSession: (id: string, title: string) => Promise<void>
  chatSend: (
    content: string,
    binding?: {
      providerId?: string
      modelId?: string
      thinkingLevel?: ThinkingLevel
      images?: string[]
      agent?: boolean
      taskDir?: string | null
    }
  ) => Promise<void>
  chatAbort: () => Promise<void>
  chatResolvePermission: (permId: string, decision: 'allow-once' | 'allow-session' | 'deny') => Promise<void>
  chatSteer: (content: string) => Promise<void>
  chatRegenerate: () => Promise<void>
  chatEditResend: (messageId: string, content: string) => Promise<void>
  chatBranch: (messageId: string) => Promise<void>
}

/** 观测 scope 缓冲键（workspaceId::taskRef；见 slices/observation.ts）。 */
export type ObservationScopeKey = string

/** 单个观察 scope 的内存缓冲（S0 G3 第二片，design §5.1/§5.2）。 */
export interface ObservationScopeState {
  workspaceId: string
  taskRef?: string
  events: ObservationItem[]
  cursor: ObservationCursor | null
  /** connecting=订阅建立中；live=增量到达；closed=未绑定/已停读（中性）；error=请求级失败。 */
  status: 'connecting' | 'live' | 'closed' | 'error'
  error: string | null
  /** 最近一次 epoch reset（清理/重建）时间；用于诚实提示「记录已重置」。 */
  lastResetAtMs: number | null
}

/**
 * 观测域（S0 G3 第二片）：回执/活动事件缓冲与健康状态。
 * 事件只在内存（eventId 去重、上限截断、不进 localStorage）；
 * 订阅/退订与轮询降频的编排在使用方 hook（observation/use-observation-scope）。
 */
export interface ObservationSlice {
  observationScopes: Record<ObservationScopeKey, ObservationScopeState>
  /** 最近一次 observation:health 结果（绑定 workspaceId / 启用态 / 存储事实）。 */
  observationStatus: ObservationStatusResult | null
  observationScopeConnecting: (key: ObservationScopeKey, scope: { workspaceId: string; taskRef?: string }) => void
  /** 未绑定/组件停读（中性态，非错误）。 */
  observationScopeClosed: (key: ObservationScopeKey) => void
  observationScopeError: (key: ObservationScopeKey, error: string) => void
  observationEventsIngest: (key: ObservationScopeKey, items: ObservationItem[], cursor: ObservationCursor) => void
  observationScopeReset: (key: ObservationScopeKey, atMs: number) => void
  observationRemoveScope: (key: ObservationScopeKey) => void
  observationSetStatus: (status: ObservationStatusResult | null) => void
  /** 项目切换/关闭：清空全部 scope 缓冲与健康状态。 */
  observationClearAllScopes: () => void
}

export type AppState = SessionSlice &
  UiSlice &
  ToastSlice &
  ViewerSlice &
  TodosSlice &
  InboxSlice &
  ChatSlice &
  ReaderSlice &
  ObservationSlice

export type AppSlice<T> = StateCreator<AppState, [], [], T>
