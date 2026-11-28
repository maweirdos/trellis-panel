import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { ArrowLeft, Check, ChevronDown, Clock, Cpu, FolderOpen, History, ListFilter, Lock, MessageSquarePlus, MoreHorizontal, PanelLeft, PanelRight, Pencil, Plus, RotateCcw, Search, Settings2, Sparkles, SquarePen, Tag, Trash2, X } from 'lucide-react'
import {
  displayConversationThreadTitle,
  resolveConversationThreadAgent,
  type ConversationAggregatedThread,
  type ConversationKnownAgent,
} from '../../../shared/conversation/agent-binding'
import { conversationThreadCommandSchema, type ConversationThreadCommand } from '../../../shared/conversation/command-runtime'
import type { ComposerCodeTaskSelection } from '../../../shared/conversation/code-task-action'
import type { OrchestrationV2AppThread } from '../../../shared/conversation/contracts'
import { conversationProjectRoleSchema, type ConversationProjectRole } from '../../../shared/conversation/project-role'
import type { ConversationTaskScope } from '../../../shared/conversation/task-scope'
import type { ProviderInteractionMode, RuntimeMode } from '../../../shared/conversation/providerPolicy'
import { ConversationListRow } from '../acp/ConversationListRow'
import { ConversationSidebar } from '../acp/ConversationSidebar'
import { ConversationWorkspaceHeader } from '../acp/ConversationWorkspaceHeader'
import { ManagedWorkflowRecovery } from '../acp/workflow/ManagedWorkflowRecovery'
import { api, hasIpc } from '../api'
import { ApplicationPanel } from '../applications/ApplicationPanel'
import { AgentAvatar } from '../crux/AgentAvatar'
import { useCrux } from '../crux/store'
import { buildCruxAgentContext, listChatEligibleAgents, matchCatalogModelForRuntime, useAgentChatBridge } from '../crux/agent-chat-bridge'
import { runtimeKindLabel, useLocalExecutionSlot } from '../crux/local-execution-slot'
import { GitBranchControl } from '../git-workspace/GitBranchControl'
import { closeGitWorkspace } from '../git-workspace/useGitWorkspace'
import { ProjectConversationIntake } from '../knowledge/ProjectConversationIntake'
import { FeedbackNotice, isDaemonOutdatedError, summarizeFeedbackMessage } from '../my/FeedbackNotice'
import { ContextRegion } from '../my/layout/ContextRegion'
import { ModuleLinks } from '../my/layout/ModuleLinks'
import { useSidebarWidthStyle } from '../my/layout/SidebarResizeHandle'
import { projectChoices, projectNameFromPath, projectRootKey } from '../my/navigation'
import { useMy } from '../my/store'
import { Button, Dropdown, DropdownDivider, DropdownHeader, DropdownItem, Modal, SearchInput, Tooltip } from '../my/ui'
import { useApp } from '../store'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { useEscLayer } from '../utils/use-esc-layer'
import {
  applyOptimisticUserMessagesAction,
  emptyOptimisticUserMessages,
  reconcileOptimisticUserMessages,
  type OptimisticUserMessage,
} from './optimisticUserMessages'
import { ArtifactIntentBanner, ArtifactWakeBanner } from './ArtifactIntentBanner'
import { ConversationComposer } from './ConversationComposer'
import { OpenArtifactFrame } from '../open-artifact/OpenArtifactFrame'
import { useConversationOpenArtifact } from './useConversationOpenArtifact'
import { insertAssistantCitationIntoDraft, type CitationDraftHandle } from './assistantCitationDraft'
import { ChatView } from './ChatView'
import { ChatProjectFileLinks, type ChatProjectFile } from './chatProjectFileLinks'
import { ChildThreadApprovals } from './ChildThreadApprovals'
import { ConversationActivityControls } from './ConversationActivityControls'
import { ConversationCheckpointsPanel } from './ConversationCheckpointsPanel'
import { ConversationProjectSurfaces } from './ConversationProjectSurfaces'
import { ConversationQueue } from './ConversationQueue'
import { ConversationQuickSearchModal } from './ConversationQuickSearchModal'
import { ConversationRelations, ConversationSubagentBar } from './ConversationRelations'
import { ConversationRightPanel, useNarrowConversationPanel } from './ConversationRightPanel'
import { ConversationRuntimeRequests } from './ConversationRuntimeRequests'
import { ConversationSidebarList, isThreadUnread, visibleThreadTags, type ConversationSidebarStatusFilter } from './ConversationSidebarList'
import { ConversationSideThreadComposer, sideThreadDraftScope } from './ConversationSideThreadComposer'
import { ConversationTimeline, type ConversationCitationNavigation } from './ConversationTimeline'
import { ThreadFindBar } from './ThreadFindBar'
import { ThreadTagsSnoozeModal, formatSnoozeLabel } from './ThreadTagsSnoozeModal'
import { deriveNextPromptSuggestion } from './promptSuggestion'
import { useConversationNavigation } from './conversation-navigation-store'
import { conversationArtifactSurface, conversationCheckpointsSurface, conversationFileSurface, conversationPanelKey, conversationPanelScope, conversationThreadSurface, useConversationRightPanel, type ConversationArtifactSurface, type ConversationRightPanelSurface, type ConversationThreadSurface } from './conversationRightPanelStore'
import { SideThreadPane } from './SideThreadPane'
import { CONVERSATION_TEXT_LIMIT, composerDraftKey, readComposerDraft, hasComposerDraftContent, updateComposerDraft } from './useComposerDraft'
import { conversationError, useComposerSend, type ComposerReceipt, type ComposerWorkTaskSelection } from './useComposerSend'
import { useConversationModelCatalog } from './useConversationModelCatalog'
import { modelPickerKey, readModelPickerPreferences } from './modelPickerPreferences'
import type { ComposerPromptEditorHandle } from './ComposerPromptEditorTiptap'
import type { AssistantCitation } from '../../../shared/conversation/assistantCitations'
import { LOCAL_ASSISTANT_CITATION_ENVIRONMENT } from '../../../shared/conversation/assistantCitationText'
import { useCodeTaskActions } from './useCodeTaskActions'
import { closeUnusedSideThread, useSideChat } from './useSideChat'
import { useWorkTaskActions } from './useWorkTaskActions'
import {
  isActiveRun, prefetchConversationThread, queuedRunsWithText, runStartIso, useConversationThread,
  type ConversationApplyResult, type ConversationTimelineRow, type ThreadReadTarget,
} from './useConversationThread'
import { useThreadRecoveryActions } from './useThreadRecoveryActions'
import '../acp/workspace.css'
import './conversation-workbench.css'

type ThreadChange = Extract<ConversationThreadCommand, { type: `thread.${string}` }>
type ThreadChangeIntent = ThreadChange extends infer Change ? Change extends ThreadChange ? Omit<Change, 'commandId'> : never : never
interface SideCleanupRequest { threadId: string; commandId: string; reason: string }

interface CitationRouteRequest {
  readonly citation: AssistantCitation
  readonly target: ThreadReadTarget
  readonly sideThreadId?: string
  readonly resolve: (found: boolean) => void
  phase: 'parent' | 'side' | 'revealing'
}

const THREAD_LIST_STORAGE_PREFIX = 'crux.conversation.threadList.v1:'
const THREAD_LIST_TTL_MS = 24 * 60 * 60_000
const retainedThreadLists = new Map<string, readonly OrchestrationV2AppThread[]>()

function readCachedThreadList(scopeKey: string): readonly OrchestrationV2AppThread[] | undefined {
  const inMem = retainedThreadLists.get(scopeKey)
  if (inMem) return inMem
  try {
    const raw = localStorage.getItem(THREAD_LIST_STORAGE_PREFIX + scopeKey)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as { cachedAt?: number; threads?: OrchestrationV2AppThread[] } | null
    if (!parsed || typeof parsed.cachedAt !== 'number' || Date.now() - parsed.cachedAt >= THREAD_LIST_TTL_MS || !Array.isArray(parsed.threads)) {
      return undefined
    }
    retainedThreadLists.set(scopeKey, parsed.threads)
    return parsed.threads
  } catch {
    return undefined
  }
}

function writeCachedThreadList(scopeKey: string, threads: readonly OrchestrationV2AppThread[]): void {
  retainedThreadLists.set(scopeKey, threads)
  while (retainedThreadLists.size > 24) {
    const oldest = retainedThreadLists.keys().next().value
    if (oldest === undefined) break
    retainedThreadLists.delete(oldest)
  }
  try {
    localStorage.setItem(THREAD_LIST_STORAGE_PREFIX + scopeKey, JSON.stringify({
      cachedAt: Date.now(),
      threads: threads.slice(0, 60),
    }))
  } catch { /* ignore quota */ }
}

function clearCachedThreadList(scopeKey: string): void {
  retainedThreadLists.delete(scopeKey)
  try { localStorage.removeItem(THREAD_LIST_STORAGE_PREFIX + scopeKey) } catch { /* ignore */ }
}

function savedThread(key: string): string | null {
  try { return localStorage.getItem(`crux.conversation.selected:${key}`) } catch { return null }
}

function rememberThread(key: string, threadId: string | null): void {
  try {
    if (threadId) localStorage.setItem(`crux.conversation.selected:${key}`, threadId)
    else localStorage.removeItem(`crux.conversation.selected:${key}`)
  } catch {}
}

function savedProjectRole(key: string): ConversationProjectRole | undefined {
  try {
    const role = conversationProjectRoleSchema.safeParse(JSON.parse(localStorage.getItem(`crux.conversation.project-role:${key}`) ?? 'null'))
    if (role.success) return role.data
  } catch {}
}

function rememberProjectRole(key: string, role: ConversationProjectRole | undefined): void {
  try {
    const storageKey = `crux.conversation.project-role:${key}`
    if (role) localStorage.setItem(storageKey, JSON.stringify(role))
    else localStorage.removeItem(storageKey)
  } catch {}
}

interface PendingThreadChangeRecord {
  readonly cwd?: string
  readonly command: ThreadChange
}

function readPendingThreadChange(key: string): PendingThreadChangeRecord | undefined {
  try {
    const saved = localStorage.getItem(`crux.conversation.pendingThreadChange:${key}`)
    if (!saved) return undefined
    const parsedJson = JSON.parse(saved) as { cwd?: unknown; command?: unknown } | null
    if (parsedJson && typeof parsedJson === 'object' && 'command' in parsedJson) {
      const parsed = conversationThreadCommandSchema.safeParse(parsedJson.command)
      if (parsed.success && parsed.data.type.startsWith('thread.')) {
        return {
          cwd: typeof parsedJson.cwd === 'string' && parsedJson.cwd.trim() ? parsedJson.cwd : undefined,
          command: parsed.data as ThreadChange,
        }
      }
    }
    const legacy = conversationThreadCommandSchema.safeParse(parsedJson)
    if (legacy.success && legacy.data.type.startsWith('thread.')) return { command: legacy.data as ThreadChange }
  } catch {}
}

function savePendingThreadChange(key: string, record?: PendingThreadChangeRecord): void {
  try {
    const scope = `crux.conversation.pendingThreadChange:${key}`
    if (record) localStorage.setItem(scope, JSON.stringify(record))
    else localStorage.removeItem(scope)
  } catch {}
}

function pendingSideCleanup(owner: string | null): SideCleanupRequest | undefined {
  if (!owner) return
  try {
    const saved: SideCleanupRequest | null = JSON.parse(localStorage.getItem(`crux.conversation.side-cleanup:${owner}`) ?? 'null')
    if (saved && typeof saved.reason === 'string' && conversationThreadCommandSchema.safeParse({
      threadId: saved.threadId, commandId: saved.commandId, type: 'thread.delete', onlyIfUnused: true,
    }).success) return saved
  } catch {}
}

function rememberSideCleanup(owner: string, request?: SideCleanupRequest): void {
  try {
    const key = `crux.conversation.side-cleanup:${owner}`
    if (request) localStorage.setItem(key, JSON.stringify(request))
    else localStorage.removeItem(key)
  } catch {}
}

function threadUpdatedAt(value: OrchestrationV2AppThread['updatedAt']): number | undefined {
  const time = typeof value === 'string' ? Date.parse(value) : value?.epochMilliseconds
  return Number.isFinite(time) ? time : undefined
}

function ConversationIssue({ title, reason, actions, uncertain = false, variant = 'bar' }: {
  title: string
  reason?: string
  actions?: ReactNode
  uncertain?: boolean
  variant?: 'bar' | 'bar-compact' | 'inline'
}): JSX.Element {
  return <FeedbackNotice variant={variant} title={title} description={reason}
    tone={uncertain ? 'warning' : 'error'} actions={actions} />
}

export interface EmbeddedCruxChatConfig {
  onClose: () => void
  onOpenSettings?: (agentId: string) => void
}

interface ConversationWorkbenchProps {
  root: string
  source?: 'code' | 'native' | 'work' | 'task'
  taskScope?: ConversationTaskScope
  onBackToTask?: () => void
  initialThreadId?: string
  projectIntake?: boolean
  compact?: boolean
  projectRoleRequest?: ConversationProjectRole
  onProjectRoleOpened?: () => void
  embeddedCrux?: EmbeddedCruxChatConfig
}

export function ConversationWorkbench({ root, source = 'native', taskScope, onBackToTask, initialThreadId,
  projectIntake = false, compact = false, projectRoleRequest, onProjectRoleOpened, embeddedCrux }: ConversationWorkbenchProps): JSX.Element {
  const sidebarWidth = useSidebarWidthStyle()
  const collapsed = useMy((state) => state.sidebarCollapsed)
  const agentView = useMy((state) => state.agentTarget)
  const workspaceContext = useCrux(state => state.workspaceContext)
  const cruxSnapshot = useCrux(state => state.snapshot)
  const selectedAgentId = useAgentChatBridge(state => state.selectedAgentId)
  const selectChatAgent = useAgentChatBridge(state => state.selectAgent)
  const startChatNonce = useAgentChatBridge(state => state.startNonce)
  const lastHandledStartNonce = useRef(startChatNonce)
  const chatEligibleAgents = useMemo(() => listChatEligibleAgents(cruxSnapshot), [cruxSnapshot])
  const knownAgents = useMemo<readonly ConversationKnownAgent[]>(() => {
    if (!cruxSnapshot) return []
    const spaceMap = new Map(cruxSnapshot.spaces.map((space) => [space.id, space]))
    return cruxSnapshot.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      spaceId: agent.spaceId,
      spaceName: spaceMap.get(agent.spaceId)?.name,
      avatarId: agent.avatarId,
    }))
  }, [cruxSnapshot])
  const activeAgentContext = useMemo(
    () => (source === 'work' || source === 'code') && !taskScope && !compact ? buildCruxAgentContext(cruxSnapshot, selectedAgentId) : null,
    [source, taskScope, compact, cruxSnapshot, selectedAgentId]
  )
  const activeAgentAvatarId = activeAgentContext
    ? cruxSnapshot?.agents.find((agent) => agent.id === activeAgentContext.id)?.avatarId
    : undefined
  const task = taskScope?.locator
  const rootKey = taskScope ? JSON.stringify([
    source, taskScope.actorId, taskScope.spaceId, taskScope.locator, taskScope.binding.assigneeGeneration,
    taskScope.materialRevision, projectRootKey(root) ?? root,
  ]) : `${source}:${projectRootKey(root) ?? root}`
  const code = source === 'code'
  const aggregatedMode = (source === 'work' || source === 'code') && !taskScope && !compact && !embeddedCrux
  const supportsProjectRole = code && !taskScope && !compact
  const workspaceLabel = taskScope ? '任务对话' : source === 'work' ? 'Work 对话' : code ? 'Code 对话' : '原生对话'
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const writable = interactive && hasIpc && taskScope?.canSend !== false
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [quickSearchOpen, setQuickSearchOpen] = useState(false)
  const [statusFilter, setStatusFilter] = useState<ConversationSidebarStatusFilter>('all')
  const [threadFindOpen, setThreadFindOpen] = useState(false)
  const [threadFindQuery, setThreadFindQuery] = useState('')
  const [threadFindIndex, setThreadFindIndex] = useState(0)
  const [scrollToRowRequest, setScrollToRowRequest] = useState<{ readonly rowId: string; readonly nonce: number } | null>(null)
  const pendingJumpFindRef = useRef<{ readonly threadId: string; readonly query: string } | null>(null)
  const lastVisitedMarkRef = useRef<string | null>(null)
  const groupMode = useConversationNavigation((state) => state.groupMode)
  const setGroupMode = useConversationNavigation((state) => state.setGroupMode)
  const scopeFilter = useConversationNavigation((state) => state.scopeFilter)
  const setScopeFilter = useConversationNavigation((state) => state.setScopeFilter)
  const collapsedGroups = useConversationNavigation((state) => state.collapsedGroups)
  const toggleGroupCollapsed = useConversationNavigation((state) => state.toggleGroupCollapsed)
  const aggregatedThreads = useConversationNavigation((state) => state.aggregatedThreads)
  const setAggregatedThreads = useConversationNavigation((state) => state.setAggregatedThreads)
  const pendingOpen = useConversationNavigation((state) => state.pendingOpen)
  const [threadsByRoot, setThreadsByRoot] = useState<{ rootKey: string; items: readonly OrchestrationV2AppThread[] | undefined }>(() => ({
    rootKey,
    items: readCachedThreadList(rootKey),
  }))
  const threads = threadsByRoot.rootKey === rootKey ? threadsByRoot.items : readCachedThreadList(rootKey)
  const [query, setQuery] = useState('')
  const [listError, setListError] = useState('')
  const [listRevision, setListRevision] = useState(0)
  const [management, setManagement] = useState<{ thread: OrchestrationV2AppThread; cwd: string; action: 'rename' | 'delete'; title: string }>()
  const [pendingChange, setPendingChange] = useState(() => readPendingThreadChange(rootKey))
  const [managementError, setManagementError] = useState('')
  const [cleanupPending, setCleanupPending] = useState(false)
  const [controlFailure, setControlFailure] = useState<Extract<ConversationApplyResult, { ok: false }>>()
  const [queueEdit, setQueueEdit] = useState<{ threadId: string; runId: string; text: string }>()
  const [tagsSnoozeOpen, setTagsSnoozeOpen] = useState(false)
  const [dismissedRollbackUnrestoredId, setDismissedRollbackUnrestoredId] = useState<string | null>(null)
  const [implementingPlan, setImplementingPlan] = useState(false)
  const [rollbackDialog, setRollbackDialog] = useState<{
    readonly threadId: string
    readonly targetRunId: string
    readonly boundary: 'before' | 'after'
    readonly restoreFiles: boolean
    readonly pending: boolean
    readonly error?: string
  }>()
  const [editRerunDialog, setEditRerunDialog] = useState<{
    readonly threadId: string
    readonly targetRunId: string
    readonly messageId: string
    readonly text: string
    readonly restoreFiles: boolean
    readonly pending: boolean
    readonly error?: string
  }>()
  const changingThread = useRef(false)
  const [target, setTarget] = useState<ThreadReadTarget | null>(() => {
    const pending = useConversationNavigation.getState().pendingOpen
    if (
      pending &&
      Date.now() - pending.issuedAt < 15_000 &&
      pending.source === source &&
      (projectRootKey(pending.cwd) ?? pending.cwd) === (projectRootKey(root) ?? root)
    ) {
      useConversationNavigation.getState().consumePendingOpen()
      rememberThread(rootKey, pending.threadId)
      return { threadId: pending.threadId }
    }
    const threadId = source === 'work' && initialThreadId ? initialThreadId : savedThread(rootKey)
    return threadId ? { threadId } : null
  })
  const [projectRole, setProjectRole] = useState(() => supportsProjectRole ? savedProjectRole(rootKey) : undefined)
  const draftRole = supportsProjectRole && !target ? projectRole : undefined
  const [optimistic, setOptimistic] = useState(() => emptyOptimisticUserMessages(''))
  const targetRef = useRef(target)
  const composerRef = useRef<ComposerPromptEditorHandle>(null)
  const citationRef = useRef<ConversationCitationNavigation>(null)
  const sideCitationRef = useRef<ConversationCitationNavigation>(null)
  const sideCitationDraftRef = useRef<CitationDraftHandle>(null)
  const citationRouteGeneration = useRef(0)
  const currentCitationRoute = useRef<CitationRouteRequest | null>(null)
  const [citationRoute, setCitationRoute] = useState<CitationRouteRequest | null>(null)
  const panelTrigger = useRef<HTMLButtonElement>(null)
  const panelReturnFocus = useRef<HTMLElement | null>(null)
  const panelId = useId()
  const mounted = useRef(false)
  const [panelExpanded, setPanelExpanded] = useState(false)
  const expandedSidebarRestore = useRef<boolean | null>(null)
  const appRoot = useApp((state) => state.snapshot?.meta.root ?? null)
  const recentProjects = useApp((state) => state.settings?.recentProjects ?? [])
  const canOpenLocalProject = useMy((state) => state.canOpenLocalProject)

  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => () => { if (code) closeGitWorkspace() }, [code])

  const panelScopeKey = taskScope ? rootKey : JSON.stringify([
    rootKey, workspaceContext.key, workspaceContext.actorId, workspaceContext.instanceId, workspaceContext.epoch,
  ])
  const readScopeKey = JSON.stringify([conversationPanelScope(panelScopeKey), workspaceContext.authorizationRevision ?? 0])
  const finishCitationRoute = useCallback((request: CitationRouteRequest, found: boolean): void => {
    if (currentCitationRoute.current !== request) return
    currentCitationRoute.current = null
    request.resolve(found)
    setCitationRoute(null)
  }, [])
  useLayoutEffect(() => () => {
    citationRouteGeneration.current += 1
    currentCitationRoute.current?.resolve(false)
    currentCitationRoute.current = null
  }, [interactive, readScopeKey])
  const controller = useConversationThread(root, target, interactive && hasIpc, readScopeKey, task)
  const { active: read, reload, loadEarlier, loadingEarlier, stop, queue } = controller
  const projection = read?.projection
  const hostThreadId = target?.threadId
  const panelStorage = !read?.error && projection?.cursor?.threadId === hostThreadId ? projection?.cursor?.storageId : undefined
  const panelKey = hostThreadId && panelStorage ? conversationPanelKey(panelScopeKey, root, hostThreadId, panelStorage) : null
  const sideCleanupKey = hostThreadId ? JSON.stringify([panelScopeKey, root, hostThreadId]) : null
  const relatedThreads = new Set<string>()
  if (!read?.error && projection?.thread.id === hostThreadId) {
    for (const relation of projection?.relations.children ?? []) {
      if (relation.parentThreadId === hostThreadId && relation.childThreadId) relatedThreads.add(relation.childThreadId)
    }
  }
  const panel = useConversationRightPanel(panelKey, hostThreadId ?? null, relatedThreads)
  const narrowWindow = useNarrowConversationPanel()
  const narrowPanel = compact || narrowWindow
  const expandedActive = panelExpanded && Boolean(panel.active) && !narrowPanel
  useEffect(() => {
    if (expandedActive) {
      if (expandedSidebarRestore.current === null) expandedSidebarRestore.current = useMy.getState().sidebarCollapsed
      useMy.getState().setSidebarCollapsed(true, false)
    } else if (expandedSidebarRestore.current !== null) {
      const restore = expandedSidebarRestore.current
      expandedSidebarRestore.current = null
      useMy.getState().setSidebarCollapsed(restore, false)
    }
  }, [expandedActive])
  useEffect(() => () => {
    if (expandedSidebarRestore.current !== null) {
      const restore = expandedSidebarRestore.current
      expandedSidebarRestore.current = null
      useMy.getState().setSidebarCollapsed(restore, false)
    }
  }, [])
  useEffect(() => { if (!panel.active) setPanelExpanded(false) }, [panel.active])
  const projectAvailable = hasIpc && typeof api.conversationProjectWorkbench === 'function'
  const openPanel = panel.open
  const fileLinkRoot = projectAvailable && projection ? projection.thread.worktreePath ?? root : undefined
  const openProjectFile = useCallback((file: ChatProjectFile): void => {
    if (!interactive || !canInteract() || !hostThreadId || targetRef.current?.threadId !== hostThreadId) return
    if (document.activeElement instanceof HTMLElement && !document.activeElement.closest('.conversation-right-surface')) {
      panelReturnFocus.current = document.activeElement
    }
    openPanel(conversationFileSurface(file.path, file.line))
  }, [canInteract, hostThreadId, interactive, openPanel])
  const fileLinks = useMemo(() => fileLinkRoot ? { root: fileLinkRoot, open: openProjectFile } : null, [fileLinkRoot, openProjectFile])
  const run = target?.runId
    ? projection?.runs.find((item) => item.id === target.runId)
    : projection?.runs.at(-1)
  const selectedThread = projection?.thread ?? threads?.find((item) => item.id === target?.threadId)
  const archivedThread = Boolean(selectedThread?.archivedAt)
  const [draftRuntimeMode, setDraftRuntimeMode] = useState<RuntimeMode>('approval-required')
  const [draftInteractionMode, setDraftInteractionMode] = useState<ProviderInteractionMode>('default')
  const isDelegatedThread = projection?.relations.parent?.kind === 'delegated'
  const supportsPersonalModes = !taskScope && !isDelegatedThread && !archivedThread
  const effectiveRuntimeMode: RuntimeMode = projection ? (projection.thread.runtimeMode ?? 'approval-required') : draftRuntimeMode
  const effectiveInteractionMode: ProviderInteractionMode = projection ? (projection.thread.interactionMode ?? 'default') : draftInteractionMode
  const activeRun = projection?.runs.slice().reverse().find(item => item.status !== 'queued' && isActiveRun(item))
  const catalog = useConversationModelCatalog(root, writable, rootKey, task)
  const instanceId = selectedThread?.modelSelection.instanceId
  const instance = catalog.instances.find(item => item.instanceId === instanceId)
  const descriptor = instance?.read?.status === 'ready' ? instance.read.descriptor : undefined
  const canSteer = Boolean(activeRun && descriptor?.actions.steer?.state === 'verified')
  const [sideCleanup, setSideCleanup] = useState<{ owner: string; threadId: string; commandId: string; reason: string }>()
  const [sideInputFailure, setSideInputFailure] = useState<{ owner: string; reason: string }>()
  const cleaningSide = useRef(false)
  const currentPanelOwner = useRef(panelKey)
  currentPanelOwner.current = panelKey
  const comparisonModels = catalog.models.filter(model => model.instanceId === 'codex')

  async function loadComparisonModels(): Promise<void> {
    if (!writable || !canInteract() || !panelKey || comparisonModels.length >= 2) return
    const codex = catalog.instances.find(item => item.instanceId === 'codex')
    if (catalog.status === 'ready' && !codex) return
    if (catalog.status !== 'ready') await catalog.refresh()
    if (mounted.current && canInteract() && currentPanelOwner.current === panelKey && targetRef.current?.threadId === hostThreadId) {
      await catalog.ensure('codex', codex?.read?.status === 'failed')
    }
  }

  function openRelatedThread(surface: ConversationThreadSurface): void {
    if (!interactive || !canInteract() || !hostThreadId || targetRef.current?.threadId !== hostThreadId) return
    if (!panel.active && document.activeElement instanceof HTMLElement) panelReturnFocus.current = document.activeElement
    panel.open(surface)
  }

  const sideChat = useSideChat({ controller, root, task, threadId: hostThreadId,
    enabled: writable && Boolean(projection) && !archivedThread, onOpenRelatedThread: openRelatedThread })

  function hidePanel(restoreFocus = true): void {
    panel.hide()
    if (restoreFocus) requestAnimationFrame(() => {
      if (currentPanelOwner.current !== panelKey || !canInteract()) return
      const previous = panelReturnFocus.current
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true })
      else panelTrigger.current?.focus({ preventScroll: true })
    })
  }

  useEscLayer(interactive && Boolean(projection && panel.active) && !narrowPanel, {
    kind: 'overlay', id: panelId, onClose: hidePanel, deferWhenInputFocused: true,
  })

  async function settleSideCleanup(threadId: string, commandId: string, check = false): Promise<void> {
    if (!panelKey || !sideCleanupKey || !writable || !canInteract() || cleaningSide.current) return
    cleaningSide.current = true
    const pending = pendingSideCleanup(sideCleanupKey) ?? { threadId, commandId, reason: '侧聊清理尚无确定回执。' }
    rememberSideCleanup(sideCleanupKey, pending)
    try {
      const result = await closeUnusedSideThread({ root, task, threadId, commandId, check })
      const unresolved = result.ok
        ? result.receipt.dispatch !== 'completed' ? pending : undefined
        : result.uncertain ? { ...pending, reason: result.reason } : undefined
      rememberSideCleanup(sideCleanupKey, unresolved)
      if (mounted.current && canInteract() && currentPanelOwner.current === panelKey) {
        setSideCleanup(unresolved && { owner: panelKey, ...unresolved })
        if (result.ok && !unresolved) reload()
      }
    } catch (error) {
      const unresolved = { ...pending, reason: conversationError(error) }
      rememberSideCleanup(sideCleanupKey, unresolved)
      if (mounted.current && canInteract() && currentPanelOwner.current === panelKey) {
        setSideCleanup({ owner: panelKey, ...unresolved })
      }
    } finally { cleaningSide.current = false }
  }

  function closePanelTab(surface: ConversationRightPanelSurface): void {
    if (surface.kind !== 'thread' || !hostThreadId || !panelKey || sideCleanup?.owner === panelKey || pendingSideCleanup(sideCleanupKey)) return
    const relation = projection?.relations.children.find(item => item.childThreadId === surface.threadId)
    if (relation?.kind !== 'side-chat') return
    const draft = readComposerDraft(composerDraftKey(root, surface.threadId, sideThreadDraftScope(panelScopeKey, root, hostThreadId)))
    if (hasComposerDraftContent(draft) || draft.state.phase !== 'idle' || draft.stash) return
    void settleSideCleanup(surface.threadId, crypto.randomUUID())
  }

  useEffect(() => {
    if (interactive && (source === 'work' || source === 'code') && !cruxSnapshot) {
      void useCrux.getState().bootstrap()
    }
  }, [cruxSnapshot, interactive, source])

  useEffect(() => {
    if (!interactive || !hasIpc) return
    let cancelled = false
    const currentNormalizedRoot = projectRootKey(root) ?? root
    async function list(): Promise<void> {
      try {
        if (aggregatedMode && typeof api.conversationListAll === 'function') {
          const result = await api.conversationListAll()
          if (cancelled) return
          if (!result.ok) throw new Error(result.error)
          setAggregatedThreads(result.items)
          const currentThreads = result.items
            .filter((item) => item.source === source && (projectRootKey(item.cwd) ?? item.cwd) === currentNormalizedRoot)
            .map((item) => item.thread)
          setThreadsByRoot({ rootKey, items: currentThreads })
          writeCachedThreadList(rootKey, currentThreads)
          const warmIds = new Set<string>()
          if (targetRef.current?.threadId) warmIds.add(targetRef.current.threadId)
          for (const item of currentThreads.slice(0, 2)) warmIds.add(item.id)
          for (const warmId of warmIds) {
            void prefetchConversationThread(root, warmId, readScopeKey)
          }
          setListError('')
          return
        }
        const result = await api.conversationList(root, { query, ...(task && { task }) })
        if (cancelled) return
        if (!result.ok) throw new Error(result.error)
        setThreadsByRoot({ rootKey, items: result.threads })
        if (!query) {
          writeCachedThreadList(rootKey, result.threads)
          const warmIds = new Set<string>()
          if (targetRef.current?.threadId) warmIds.add(targetRef.current.threadId)
          for (const item of result.threads.slice(0, 2)) warmIds.add(item.id)
          for (const warmId of warmIds) {
            void prefetchConversationThread(root, warmId, readScopeKey, taskScope?.locator)
          }
        }
        setListError('')
      } catch (error) {
        if (!cancelled) {
          if (!query && !aggregatedMode) {
            clearCachedThreadList(rootKey)
            setThreadsByRoot({ rootKey, items: undefined })
          }
          setListError(conversationError(error))
        }
      }
    }
    if (aggregatedMode || !query) {
      void list()
      return () => { cancelled = true }
    }
    const timer = window.setTimeout(() => void list(), 160)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [aggregatedMode, interactive, listRevision, query, readScopeKey, recentProjects, root, rootKey, setAggregatedThreads, source, task, taskScope?.locator])

  function select(next: ThreadReadTarget | null): void {
    citationRouteGeneration.current += 1
    if (currentCitationRoute.current) finishCitationRoute(currentCitationRoute.current, false)
    rememberThread(rootKey, next?.threadId ?? null)
    targetRef.current = next
    setTarget(next)
    setControlFailure(undefined)
    setQueueEdit(undefined)
    setRollbackDialog(undefined)
    setEditRerunDialog(undefined)
    setTagsSnoozeOpen(false)
    setDismissedRollbackUnrestoredId(null)
    const pendingFind = pendingJumpFindRef.current
    if (pendingFind && next?.threadId === pendingFind.threadId) {
      pendingJumpFindRef.current = null
      setThreadFindQuery(pendingFind.query)
      setThreadFindIndex(0)
      setThreadFindOpen(true)
    } else {
      pendingJumpFindRef.current = null
      setThreadFindOpen(false)
      setThreadFindQuery('')
      setThreadFindIndex(0)
      setScrollToRowRequest(null)
    }
    setSidebarOpen(false)
  }

  useEffect(() => {
    if (!pendingOpen || Date.now() - pendingOpen.issuedAt >= 15_000) return
    if (pendingOpen.source !== source || (projectRootKey(pendingOpen.cwd) ?? pendingOpen.cwd) !== (projectRootKey(root) ?? root)) return
    useConversationNavigation.getState().consumePendingOpen()
    if (targetRef.current?.threadId !== pendingOpen.threadId) {
      select({ threadId: pendingOpen.threadId })
    }
  }, [pendingOpen, root, source])

  async function openAssistantCitation(citation: AssistantCitation): Promise<boolean> {
    if (!interactive || !hasIpc || !canInteract() || citation.environmentId !== LOCAL_ASSISTANT_CITATION_ENVIRONMENT) return false
    const generation = ++citationRouteGeneration.current
    if (currentCitationRoute.current) finishCitationRoute(currentCitationRoute.current, false)
    const origin = targetRef.current
    if (origin?.threadId === citation.threadId) {
      if (narrowPanel && panel.active) hidePanel(false)
      return citationRef.current?.open(citation) ?? false
    }
    const canContinue = () => mounted.current && canInteract() && citationRouteGeneration.current === generation
    try {
      const sourceRead = await api.conversationRead(citation.threadId, root, task)
      if (!canContinue() || !sourceRead.ok || sourceRead.thread.id !== citation.threadId ||
        sourceRead.cursor.threadId !== citation.threadId) return false
      const relation = sourceRead.relations?.parent
      const sideThreadId = relation?.kind === 'side-chat' && relation.childThreadId === citation.threadId
        ? citation.threadId : undefined
      const parentId = sideThreadId && relation ? relation.parentThreadId : citation.threadId
      if (sideThreadId && parentId === sideThreadId) return false
      if (sideThreadId && parentId !== origin?.threadId) {
        const parentRead = await api.conversationRead(parentId, root, task)
        if (!canContinue() || !parentRead.ok || parentRead.thread.id !== parentId ||
          parentRead.cursor.threadId !== parentId || !parentRead.relations?.children.some(child =>
            child.kind === 'side-chat' && child.parentThreadId === parentId && child.childThreadId === sideThreadId)) return false
      }
      const next = origin?.threadId === parentId ? origin : { threadId: parentId }
      if (next !== origin) select(next)
      return new Promise<boolean>(resolve => {
        const request: CitationRouteRequest = { citation, target: next, sideThreadId, resolve, phase: 'parent' }
        currentCitationRoute.current = request
        setCitationRoute(request)
      })
    } catch {
      return false
    }
  }

  const revealSideCitation = useCallback((threadId: string, readable: boolean): void => {
    if (!citationRoute || currentCitationRoute.current !== citationRoute || citationRoute.sideThreadId !== threadId ||
      citationRoute.target !== targetRef.current || citationRoute.phase === 'revealing') return
    queueMicrotask(() => {
      if (currentCitationRoute.current !== citationRoute || citationRoute.phase !== 'side') return
      const timeline = sideCitationRef.current
      if (!readable || !canInteract() || !timeline) {
        finishCitationRoute(citationRoute, false)
        return
      }
      citationRoute.phase = 'revealing'
      void timeline.open(citationRoute.citation).then(
        found => finishCitationRoute(citationRoute, found),
        () => finishCitationRoute(citationRoute, false),
      )
    })
  }, [canInteract, citationRoute, finishCitationRoute])

  useEffect(() => {
    if (!citationRoute || currentCitationRoute.current !== citationRoute) return
    if (!interactive || citationRoute.target !== targetRef.current || read?.error) {
      finishCitationRoute(citationRoute, false)
      return
    }
    if (!projection || projection.thread.id !== citationRoute.target.threadId) return
    if (citationRoute.sideThreadId) {
      const surface = conversationThreadSurface(citationRoute.sideThreadId)
      if (!panelKey || !projection.relations.children.some(child => child.kind === 'side-chat' &&
        child.parentThreadId === projection.thread.id && child.childThreadId === citationRoute.sideThreadId)) {
        finishCitationRoute(citationRoute, false)
        return
      }
      if (citationRoute.phase === 'parent') {
        citationRoute.phase = 'side'
        openPanel(surface)
      } else if (panel.active?.id !== surface.id) {
        finishCitationRoute(citationRoute, false)
      }
      return
    }
    if (citationRoute.phase === 'revealing') return
    if (narrowPanel && panel.active) panel.hide()
    citationRoute.phase = 'revealing'
    queueMicrotask(() => {
      if (currentCitationRoute.current !== citationRoute) return
      const lookup = citationRef.current?.open(citationRoute.citation) ?? Promise.resolve(false)
      void lookup.then(found => finishCitationRoute(citationRoute, found), () => finishCitationRoute(citationRoute, false))
    })
  }, [citationRoute, finishCitationRoute, interactive, narrowPanel, openPanel, panel.active, panel.hide, panelKey, projection, read?.error])

  function changeConfirmed(command: ThreadChange): void {
    savePendingThreadChange(rootKey)
    setPendingChange(undefined)
    setCleanupPending(false)
    setManagement(undefined)
    setManagementError('')
    if (targetRef.current?.threadId === command.threadId) {
      if (command.type === 'thread.delete' || command.type === 'thread.archive' && command.archived) select(null)
      else reload()
    }
    setListRevision(value => value + 1)
  }

  async function applyThreadChange(command: ThreadChange, targetCwd = root): Promise<void> {
    if (changingThread.current || !writable || !canInteract()) return
    const alreadyAdmitted = cleanupPending && pendingChange?.command.commandId === command.commandId
    changingThread.current = true
    const record: PendingThreadChangeRecord = { cwd: targetCwd, command }
    savePendingThreadChange(rootKey, record)
    setPendingChange(record)
    setManagementError('')
    try {
      const result = await api.conversationApply({ cwd: targetCwd, command, ...(task && { task }) })
      if (!mounted.current || !canInteract()) return
      if (result.ok) {
        if (result.receipt.dispatch === 'completed') changeConfirmed(command)
        else {
          setCleanupPending(command.type === 'thread.delete' && result.receipt.dispatch === 'pending-reconciliation')
          setManagementError(result.receipt.detail ?? '原操作尚未确认完成。')
        }
      } else {
        setManagementError(result.error)
        if (!alreadyAdmitted && 'outcome' in result && result.outcome === 'not-admitted') {
          savePendingThreadChange(rootKey)
          setPendingChange(undefined)
          setCleanupPending(false)
        }
      }
    } catch (error) {
      if (mounted.current && canInteract()) setManagementError(conversationError(error))
    } finally { changingThread.current = false }
  }

  function changeThread(intent: ThreadChangeIntent, targetCwd = root): void {
    if (!pendingChange) void applyThreadChange({ ...intent, commandId: crypto.randomUUID() }, targetCwd)
  }

  async function checkThreadChange(): Promise<void> {
    if (!pendingChange || changingThread.current || !canInteract()) return
    const { command, cwd: targetCwd = root } = pendingChange
    changingThread.current = true
    try {
      const result = await api.conversationThreadCommand({ cwd: targetCwd, threadId: command.threadId, commandId: command.commandId, ...(task && { task }) })
      if (!mounted.current || !canInteract()) return
      if (result.ok && result.receipt?.dispatch === 'completed') changeConfirmed(command)
      else {
        if (result.ok && command.type === 'thread.delete' && result.receipt?.dispatch === 'pending-reconciliation') {
          setCleanupPending(true)
        }
        setManagementError(result.ok ? result.receipt?.detail ?? '原操作尚无已完成的回执。' : result.error)
      }
    } catch (error) {
      if (mounted.current && canInteract()) setManagementError(conversationError(error))
    } finally { changingThread.current = false }
  }

  function onAccepted(receipt: ComposerReceipt, message: OptimisticUserMessage, workTaskSelection?: ComposerWorkTaskSelection,
    codeTaskSelection?: ComposerCodeTaskSelection): void {
    const openThreadId = targetRef.current?.threadId
    if (!openThreadId || openThreadId === receipt.threadId) {
      setOptimistic(current => applyOptimisticUserMessagesAction(
        current.threadId === receipt.threadId ? current : emptyOptimisticUserMessages(receipt.threadId),
        receipt.threadId,
        existing => [...existing, message],
      ))
      if (openThreadId) reload()
      else {
        if (source === 'work' && workTaskSelection) workTask.bindAfterSend(receipt.threadId, workTaskSelection)
        if (code && codeTaskSelection) codeTask.bindAfterSend(receipt.threadId, codeTaskSelection)
        if (draftRole) {
          rememberProjectRole(rootKey, undefined)
          setProjectRole(undefined)
        }
        select({ threadId: receipt.threadId })
      }
    }
    setListRevision((value) => value + 1)
  }

  useLayoutEffect(() => {
    if (!supportsProjectRole || !writable || !projectRoleRequest) return
    openDraft('', projectRoleRequest)
    onProjectRoleOpened?.()
  }, [onProjectRoleOpened, projectRoleRequest, supportsProjectRole, writable])

  const composer = useComposerSend({
    root, threadId: target?.threadId ?? null, scopeKey: rootKey, interactive: writable, task,
    role: draftRole,
    runtimeMode: supportsPersonalModes && !target ? draftRuntimeMode : undefined,
    interactionMode: supportsPersonalModes && !target ? draftInteractionMode : undefined,
    agentContext: activeAgentContext,
    running: Boolean(activeRun), canSteer, onAccepted,
    onSideChat: projection && !archivedThread ? input => { setSideInputFailure(undefined); return sideChat.open(input) } : undefined,
    onSideChatError: reason => { if (panelKey) setSideInputFailure({ owner: panelKey, reason }) },
  })
  const [draftArtifact, setDraftArtifact] = useState<ConversationArtifactSurface | null>(null)
  useEffect(() => {
    if (hostThreadId) setDraftArtifact(null)
  }, [hostThreadId])
  const openArtifactSurface = useCallback((surface: ConversationArtifactSurface): void => {
    if (panelKey) openPanel(surface)
    else setDraftArtifact(surface)
  }, [openPanel, panelKey])
  const focusComposerStable = useCallback((): void => {
    const threadId = targetRef.current?.threadId
    requestAnimationFrame(() => {
      if (targetRef.current?.threadId === threadId && canInteract()) composerRef.current?.focus()
    })
  }, [canInteract])
  const handlePromptFromArtifact = useCallback((prompt: string): void => {
    composer.setDraft(prompt)
    focusComposerStable()
  }, [composer.setDraft, focusComposerStable])
  const openArtifact = useConversationOpenArtifact({
    interactive,
    writable,
    root,
    source,
    threadId: hostThreadId,
    agentName: activeAgentContext?.name,
    agentRole: activeAgentContext?.description ?? draftRole?.name,
    draft: composer.draft,
    onOpenArtifactSurface: openArtifactSurface,
    onSetDraft: composer.setDraft,
    onFocusComposer: focusComposerStable
  })
  const artifactBanner = (openArtifact.pendingWake || openArtifact.suggestion) ? (
    <div className="flex flex-col gap-2">
      {openArtifact.pendingWake && (
        <ArtifactWakeBanner
          wake={openArtifact.pendingWake}
          onApplyToDraft={openArtifact.applyWakeToDraft}
          onDismiss={openArtifact.dismissWake}
        />
      )}
      {openArtifact.suggestion && (
        <ArtifactIntentBanner
          suggestion={openArtifact.suggestion}
          busy={openArtifact.enabling}
          onAccept={() => { void openArtifact.acceptSuggestion() }}
          onDismiss={openArtifact.dismissSuggestion}
          onOpenExisting={(item) => { void openArtifact.openExisting(item) }}
        />
      )}
    </div>
  ) : undefined
  // 当从工作台点「小助手」或从 Agent 卡片点「发起对话」进入时，自动清草稿开新会话
  useEffect(() => {
    if (startChatNonce === lastHandledStartNonce.current) return
    lastHandledStartNonce.current = startChatNonce
    if ((source === 'work' || source === 'code') && !taskScope && !compact) {
      select(null)
      requestAnimationFrame(() => {
        if (!targetRef.current && canInteract()) composerRef.current?.focus()
      })
    }
  }, [startChatNonce, source, taskScope, compact, canInteract])

  // 选定空间 Agent 后，自动根据其本机执行槽偏好匹配对应真实 Runtime 实例模型
  const appliedAgentModelRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeAgentContext || target || catalog.models.length === 0) return
    const key = `${activeAgentContext.id}:${activeAgentContext.runtimeKind}:${activeAgentContext.preferredModel}`
    if (appliedAgentModelRef.current === key) return
    const matched = matchCatalogModelForRuntime(catalog, activeAgentContext.runtimeKind, activeAgentContext.preferredModel)
    if (matched) {
      appliedAgentModelRef.current = key
      composer.setModel(matched)
    }
  }, [activeAgentContext, target, catalog, composer])

  // 进入对话工作台立即主动预热驱动目录与默认/最近使用的驱动进程（对标 t3code 进界面即用），
  // 而不是等到用户点开模型选择器或点击发送时才首次拉起 Runtime。
  const catalogRefresh = catalog.refresh
  const catalogEnsure = catalog.ensure
  useEffect(() => {
    if (!writable) return
    void catalogRefresh()
  }, [writable, rootKey, catalogRefresh])

  useEffect(() => {
    if (!writable || catalog.instances.length === 0) return
    const preferredInstances = new Set<string>()
    if (instanceId) preferredInstances.add(instanceId)
    const normalizedRoot = projectRootKey(root)
    if (normalizedRoot) {
      const prefs = readModelPickerPreferences(normalizedRoot)
      const latestRecent = prefs.recent[0]?.split('\u0000', 1)[0]
      if (latestRecent) preferredInstances.add(latestRecent)
    }
    if (preferredInstances.size === 0) {
      const codexInstance = catalog.instances.find(item => item.instanceId === 'codex')
      const fallback = codexInstance ?? catalog.instances[0]
      if (fallback) preferredInstances.add(fallback.instanceId)
    }
    for (const targetInstance of preferredInstances) {
      if (catalog.instances.some(item => item.instanceId === targetInstance)) {
        void catalogEnsure(targetInstance)
      }
    }
  }, [writable, root, instanceId, catalog.instances, catalogEnsure])

  // 新建草稿尚未选模型时，自动回填当前项目最近使用或默认模型，让用户进界面即可直接输入发送；
  // 若首次回填来自静态兜底目录而未能命中用户偏好模型，待真实目录到达且用户未改选时自动升级回偏好模型。
  const autoSelectedDraftRef = useRef<{ scopeToken: string; pendingRecentUpgrade: boolean; selectedKey: string } | null>(null)
  useEffect(() => {
    if (!writable || target || activeAgentContext || catalog.models.length === 0) return
    const scopeToken = `${rootKey}:${composer.draftKey}`
    const prevAuto = autoSelectedDraftRef.current
    const currentKey = composer.model ? modelPickerKey(composer.model.instanceId, composer.model.id) : null
    if (composer.model && (!prevAuto || prevAuto.scopeToken !== scopeToken || !prevAuto.pendingRecentUpgrade || prevAuto.selectedKey !== currentKey)) {
      return
    }
    if (!composer.model && prevAuto?.scopeToken === scopeToken && !prevAuto.pendingRecentUpgrade) return

    const normalizedRoot = projectRootKey(root)
    const prefs = normalizedRoot ? readModelPickerPreferences(normalizedRoot) : undefined
    const matchedRecent = prefs?.recent
      .map(entry => catalog.models.find(model => modelPickerKey(model.instanceId, model.id) === entry))
      .find((item): item is NonNullable<typeof item> => Boolean(item))
    const hasProvisionalRead = catalog.instances.some(item => item.read?.status === 'ready' && item.read.descriptor.provisional)
    const chosen = matchedRecent
      ?? catalog.models.find(model => model.instanceId === 'codex' && model.isDefault)
      ?? catalog.models.find(model => model.isDefault)
      ?? catalog.models[0]
    if (chosen) {
      const nextKey = modelPickerKey(chosen.instanceId, chosen.id)
      autoSelectedDraftRef.current = {
        scopeToken,
        pendingRecentUpgrade: Boolean(!matchedRecent && prefs?.recent.length && hasProvisionalRead),
        selectedKey: nextKey,
      }
      if (nextKey !== currentKey) {
        composer.setModel({ instanceId: chosen.instanceId, id: chosen.id, displayName: chosen.displayName })
      }
    }
  }, [writable, target, composer.model, composer.draftKey, composer.setModel, activeAgentContext, catalog.instances, catalog.models, root, rootKey])
  const canPreselectTask = composer.state.phase === 'idle' || (composer.state.phase === 'rejected' && composer.state.restored)
  const workTask = useWorkTaskActions({
    root, threadId: hostThreadId, isWork: source === 'work', enabled: source === 'work' && writable && !archivedThread && (!target || Boolean(projection)),
    draftKey: composer.draftKey, draftSelection: composer.workTask,
    canPreselect: canPreselectTask,
  })
  const codeTask = useCodeTaskActions({
    root, threadId: code ? hostThreadId : undefined,
    enabled: code && writable && !archivedThread && (!target || Boolean(projection)),
    draftKey: composer.draftKey,
    draftSelection: code ? composer.codeTask : undefined,
    canPreselect: code && canPreselectTask,
    onPreselect: selection => updateComposerDraft(composer.draftKey, current =>
      current.state.phase === 'idle' || current.state.phase === 'rejected' && current.state.restored
        ? { ...current, codeTask: selection } : current),
    onClearSelection: () => updateComposerDraft(composer.draftKey, current =>
      current.state.phase === 'idle' || current.state.phase === 'rejected' && current.state.restored
        ? { ...current, codeTask: undefined } : current),
  })
  const selectedModel = composer.model ?? (selectedThread ? {
    instanceId: selectedThread.modelSelection.instanceId,
    id: selectedThread.modelSelection.model,
    options: selectedThread.modelSelection.options,
    displayName: catalog.models.find(model => model.instanceId === selectedThread.modelSelection.instanceId
      && model.id === selectedThread.modelSelection.model)?.displayName ?? selectedThread.modelSelection.model,
  } : null)
  const submission = composer.state.phase === 'idle' ? undefined : composer.state.submission
  const submitting = composer.state.phase === 'submitting' || composer.state.phase === 'accepted'
  const outcomeUnknown = composer.state.phase === 'unknown'
  const draftMessage = submitting || outcomeUnknown ? submission?.message : undefined
  const visibleThreadId = target?.threadId ?? ''
  const acknowledgedIds = new Set<string>(projection?.messages.map((message) => message.id))
  const reconciled = reconcileOptimisticUserMessages(optimistic, visibleThreadId, acknowledgedIds)
  if (reconciled !== optimistic) setOptimistic(reconciled)

  const queued = projection ? queuedRunsWithText(projection.queuedRuns, projection.messages) : []
  const queuedMessageIds = new Set<string>(queued.map(({ run }) => run.userMessageId))
  const rows: ConversationTimelineRow[] = (projection?.rows ?? []).filter(row => !queuedMessageIds.has(row.id))
  const optimisticMessages = [...reconciled.messages]
  if (draftMessage && !acknowledgedIds.has(draftMessage.id) && !optimisticMessages.some(message => message.id === draftMessage.id)) {
    optimisticMessages.push(draftMessage)
  }
  for (const message of optimisticMessages) {
    rows.push({ kind: 'message', id: message.id, message: { ...message, runId: null, streaming: false } })
  }
  const normalizedFindQuery = threadFindOpen ? threadFindQuery.trim().toLowerCase() : ''
  const matchedFindRowIds = useMemo(() => {
    if (!normalizedFindQuery) return [] as string[]
    const matchesText = (row: ConversationTimelineRow): string => {
      if (row.kind === 'message') return row.message.text
      if (row.kind === 'reasoning') return row.text
      if (row.kind === 'plan') {
        return row.item.type === 'proposed_plan'
          ? row.item.markdown
          : row.item.steps.map(step => step.text).join('\n')
      }
      if (row.kind === 'work') return `${row.text} ${row.detail ?? ''} ${row.output ?? ''}`
      if (row.kind === 'work-group') return row.entries.map(e => `${e.text} ${e.detail ?? ''} ${e.output ?? ''}`).join('\n')
      if (row.kind === 'work-fold') return row.entries.map(e => e.kind === 'message' ? e.message.text : e.kind === 'work' ? `${e.text} ${e.detail ?? ''}` : '').join('\n')
      return ''
    }
    return rows.filter(row => matchesText(row).toLowerCase().includes(normalizedFindQuery)).map(row => row.id)
  }, [normalizedFindQuery, rows])
  const matchedFindRowSet = useMemo(() => new Set(matchedFindRowIds), [matchedFindRowIds])
  const clampedFindIndex = matchedFindRowIds.length ? Math.min(threadFindIndex, matchedFindRowIds.length - 1) : 0
  const highlightedFindRowId = matchedFindRowIds[clampedFindIndex] ?? null

  const jumpToFindIndex = useCallback((nextIndex: number) => {
    if (!matchedFindRowIds.length) return
    const wrapped = (nextIndex + matchedFindRowIds.length) % matchedFindRowIds.length
    setThreadFindIndex(wrapped)
    setScrollToRowRequest(prev => ({ rowId: matchedFindRowIds[wrapped], nonce: (prev?.nonce ?? 0) + 1 }))
  }, [matchedFindRowIds])

  useEffect(() => {
    if (matchedFindRowIds.length && threadFindOpen && normalizedFindQuery) {
      setScrollToRowRequest(prev => ({ rowId: matchedFindRowIds[0], nonce: (prev?.nonce ?? 0) + 1 }))
    }
  }, [matchedFindRowIds, normalizedFindQuery, threadFindOpen])

  useEffect(() => {
    if (!interactive || !writable || !projection || read?.error || taskScope || isDelegatedThread) return
    if (!isThreadUnread(projection.thread)) return
    const sequence = projection.cursor?.sequence ?? 0
    const token = `${projection.thread.id}:${sequence}:${String(projection.thread.updatedAt)}`
    if (lastVisitedMarkRef.current === token) return
    lastVisitedMarkRef.current = token
    void controller.markVisited(sequence).then(result => {
      if (result.ok) setListRevision(value => value + 1)
    })
  }, [controller, interactive, isDelegatedThread, projection, read?.error, taskScope, writable])

  const runPending = Boolean(run && isActiveRun(run))
  const runningProvider = catalog.instances.find(item => item.instanceId === activeRun?.modelSelection.instanceId)?.driverKind
  const loadingThread = Boolean(target && !projection && !read?.error)
  const draftIsEmpty = !target && !rows.length && composer.state.phase === 'idle'

  const modelLabel = (id: string): string => catalog.models.find(model => model.instanceId === instanceId && model.id === id)?.displayName ?? id

  function openDraft(text = '', role?: ConversationProjectRole): void {
    if (supportsProjectRole) {
      rememberProjectRole(rootKey, role)
      setProjectRole(role)
    }
    select(null)
    if (text) updateComposerDraft(composerDraftKey(root, null, rootKey), current => ({ ...current, text: current.text || text }))
    requestAnimationFrame(() => {
      if (!targetRef.current && canInteract()) composerRef.current?.focus()
    })
  }

  function appendIntake(text: string, newConversation: boolean): boolean {
    if (!writable || !canInteract()) return false
    const threadId = newConversation ? null : targetRef.current?.threadId ?? null
    if (!newConversation && (!threadId || projection?.thread.id !== threadId || archivedThread)) return false
    let appended = false
    updateComposerDraft(composerDraftKey(root, threadId, rootKey), current => {
      if (current.state.phase !== 'idle' && (current.state.phase !== 'rejected' || !current.state.restored)) return current
      const next = [current.text, text].filter(part => part.trim()).join('\n\n')
      if (next.length > CONVERSATION_TEXT_LIMIT) return current
      appended = true
      return { ...current, text: next }
    })
    if (appended) {
      if (newConversation) openDraft()
      else focusComposer()
    }
    return appended
  }

  const runModel = run && modelLabel(run.modelSelection.model)
  const previousPrompt = projection
    ? [...projection.messages].reverse().find((message) => message.role === 'user')
    : undefined
  const deleteRun = management?.action === 'delete' && management.thread.id === visibleThreadId ? activeRun : undefined

  function focusComposer(): void {
    const threadId = targetRef.current?.threadId
    requestAnimationFrame(() => {
      if (targetRef.current?.threadId === threadId && canInteract()) composerRef.current?.focus()
    })
  }

  function insertAssistantCitation(citation: AssistantCitation): void {
    const origin = targetRef.current
    if (!writable || !canInteract() || origin?.threadId !== citation.threadId || !projection || projection.thread.id !== citation.threadId ||
      !projection.messages.some(message => message.id === citation.messageId && message.role === 'assistant' && !message.streaming)) return
    insertAssistantCitationIntoDraft(citation, composer, composerRef, () => canInteract() && targetRef.current === origin)
  }

  function applyControl(operation: ReturnType<typeof stop>): void {
    const originalThread = targetRef.current?.threadId
    void operation.then(result => {
      if (!mounted.current || !canInteract() || targetRef.current?.threadId !== originalThread) return
      setControlFailure(result.ok ? undefined : result)
      if (result.ok && result.source === 'reconcile') setQueueEdit(undefined)
    })
  }

  const handleImplementPlan = useCallback((_planMarkdown: string): void => {
    const threadId = targetRef.current?.threadId
    if (!threadId || !writable || !canInteract() || implementingPlan || !projection || activeRun) return
    const dispatchPrompt = '请按上述方案开始实施。'
    if (!selectedModel) {
      composer.setDraft(dispatchPrompt)
      focusComposerStable()
      return
    }
    setImplementingPlan(true)
    void (async () => {
      try {
        if (supportsPersonalModes && effectiveInteractionMode === 'plan') {
          await controller.setInteractionMode('default')
        }
        const result = await controller.apply({
          type: 'message.dispatch',
          commandId: crypto.randomUUID(),
          threadId,
          messageId: `msg_${crypto.randomUUID()}`,
          text: dispatchPrompt,
          instanceId: selectedModel.instanceId,
          model: selectedModel.id,
          ...(selectedModel.options?.length ? { options: selectedModel.options.map(option => ({ id: option.id, value: option.value })) } : {}),
        })
        if (!mounted.current || targetRef.current?.threadId !== threadId) return
        setControlFailure(result.ok ? undefined : result)
        if (result.ok) {
          reload()
          setListRevision(value => value + 1)
        }
      } finally {
        if (mounted.current) setImplementingPlan(false)
      }
    })()
  }, [activeRun, canInteract, composer, controller, effectiveInteractionMode, focusComposerStable, implementingPlan, projection, reload, selectedModel, supportsPersonalModes, writable])

  const {
    resumableRunId,
    hasHeldQueuedRuns,
    canResume,
    resumeLabel,
    isResuming,
    recoveringRunId,
    isForceStopping,
    stoppingSubagentId,
    usageLimitRecovery,
    usageLimitRemainingSeconds,
    usageLimitActionPending,
    failedRunIssue,
    handleResume,
    handleForceStop,
    handleStopSubagent,
    handleCancelUsageLimitRecovery,
    handleRetryUsageLimitRecoveryNow,
    handleFailedRunAction,
  } = useThreadRecoveryActions({
    controller,
    projection,
    visibleThreadId,
    selectedModel,
    latestRun: run,
    latestRunModelLabel: runModel,
    previousPrompt,
    writable,
    submitting,
    archivedThread,
    isTaskThread: Boolean(task),
    outcomeUnknown,
    controlFailureUncertain: Boolean(controlFailure?.uncertain),
    mountedRef: mounted,
    targetRef,
    onApplyControl: applyControl,
    onClearControlFailure: () => setControlFailure(undefined),
    onBumpListRevision: () => setListRevision(value => value + 1),
    onReload: reload,
  })

  const controlNotice = controlFailure && <ConversationIssue
    title={controlFailure.uncertain ? '操作结果待核对' : '会话操作未完成'}
    reason={controlFailure.reason} uncertain={controlFailure.uncertain}
    actions={controlFailure.uncertain && <Button size="sm" variant="outline"
      disabled={controller.pendingCommands.has(controlFailure.commandId)}
      onClick={() => applyControl(controller.checkCommand(controlFailure.commandId))}>查询回执</Button>}
  />
  const threadChangeActions = pendingChange && <>
    <Button type="button" size="sm" variant="outline" onClick={() => void checkThreadChange()}>查询回执</Button>
    {cleanupPending && writable && <Button type="button" size="sm" variant="outline"
      onClick={() => void applyThreadChange(pendingChange.command, pendingChange.cwd ?? root)}>继续清理</Button>}
  </>
  const sidebarAggregatedItems = useMemo<readonly ConversationAggregatedThread[]>(() => {
    if (aggregatedThreads) return aggregatedThreads
    const fallbackSource: 'work' | 'code' = source === 'code' ? 'code' : 'work'
    const fallbackProjectName = fallbackSource === 'code' ? projectNameFromPath(root) : '托管目录'
    return (threads ?? []).map((thread) => ({
      thread,
      cwd: root,
      source: fallbackSource,
      projectName: fallbackProjectName,
    }))
  }, [aggregatedThreads, root, source, threads])

  const openAggregatedThread = useCallback((item: ConversationAggregatedThread): void => {
    const sameRoot = item.source === source && (projectRootKey(item.cwd) ?? item.cwd) === (projectRootKey(root) ?? root)
    if (sameRoot) {
      if (item.thread.id === targetRef.current?.threadId) setSidebarOpen(false)
      else select({ threadId: item.thread.id })
      return
    }
    const nextRootKey = `${item.source}:${projectRootKey(item.cwd) ?? item.cwd}`
    rememberThread(nextRootKey, item.thread.id)
    useConversationNavigation.getState().setPendingOpen({
      cwd: item.cwd,
      source: item.source,
      threadId: item.thread.id,
      issuedAt: Date.now(),
    })
    setSidebarOpen(false)
    if (item.source === 'work') {
      useMy.getState().setChatWorkdirMode('default')
      return
    }
    const needSwitchProject = projectRootKey(item.cwd) !== projectRootKey(appRoot)
    if (needSwitchProject) {
      void useApp.getState().openProjectPath(item.cwd, { keepPage: true }).then(() => {
        if (projectRootKey(useApp.getState().snapshot?.meta.root) === projectRootKey(item.cwd)) {
          useMy.getState().setChatWorkdirMode('directory')
        }
      })
    } else {
      useMy.getState().setChatWorkdirMode('directory')
    }
  }, [appRoot, root, source])

  const startNewConversation = useCallback((agentId?: string | null): void => {
    if (agentId !== undefined) {
      selectChatAgent(agentId)
      appliedAgentModelRef.current = null
      if (agentId && cruxSnapshot) {
        const agent = cruxSnapshot.agents.find((item) => item.id === agentId)
        if (agent) {
          const { slot } = useLocalExecutionSlot.getState().resolveAgentSlot(agent.id, {
            runtimeKind: agent.runtimeKind,
            workingDirectory: agent.workingDirectory,
          })
          if (slot.workingDirectory === 'repo' && appRoot && source !== 'code') {
            rememberThread(`code:${projectRootKey(appRoot) ?? appRoot}`, null)
            useConversationNavigation.getState().setPendingOpen(null)
            setSidebarOpen(false)
            useMy.getState().setChatWorkdirMode('directory')
            return
          }
          if (slot.workingDirectory === 'temp' && source === 'code') {
            const workRootCached = localStorage.getItem('crux.conversation.workRoot.v1')
            if (workRootCached) rememberThread(`work:${projectRootKey(workRootCached) ?? workRootCached}`, null)
            useConversationNavigation.getState().setPendingOpen(null)
            setSidebarOpen(false)
            useMy.getState().setChatWorkdirMode('default')
            return
          }
        }
      }
    }
    openDraft()
  }, [appRoot, cruxSnapshot, selectChatAgent, source])

  const openLocalDirectoryForNewChat = useCallback((): void => {
    if (!canOpenLocalProject) return
    void useApp.getState().pickAndOpen({ keepPage: true }).then(() => {
      const openedRoot = useApp.getState().snapshot?.meta.root
      if (!openedRoot) return
      rememberThread(`code:${projectRootKey(openedRoot) ?? openedRoot}`, null)
      useConversationNavigation.getState().setPendingOpen(null)
      if (source === 'code' && projectRootKey(openedRoot) === projectRootKey(root)) {
        openDraft()
      } else {
        useMy.getState().setChatWorkdirMode('directory')
      }
    })
  }, [canOpenLocalProject, root, source])

  const searchRemoteAggregated = useCallback(async (searchQuery: string): Promise<readonly ConversationAggregatedThread[] | null> => {
    if (!hasIpc || typeof api.conversationListAll !== 'function') return null
    const result = await api.conversationListAll({ query: searchQuery })
    return result.ok ? result.items : null
  }, [])

  const searchContentAggregated = useCallback(async (searchQuery: string): Promise<readonly import('../../../shared/conversation/desktop').ConversationAggregatedSearchMatch[] | null> => {
    if (!hasIpc) return null
    if (aggregatedMode && typeof api.conversationSearchAll === 'function') {
      const result = await api.conversationSearchAll({ query: searchQuery, limit: 25 })
      return result.ok ? result.matches : null
    }
    if (typeof api.conversationSearch === 'function') {
      const result = await api.conversationSearch(root, { query: searchQuery, limit: 25, ...(task && { task }) })
      if (!result.ok) return null
      return result.matches.map(match => ({
        ...match,
        cwd: root,
        source: source === 'code' ? 'code' : 'work',
        projectName: projectNameFromPath(root),
      }))
    }
    return null
  }, [aggregatedMode, root, source, task])

  useEffect(() => {
    if (!interactive) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey) return
      const mod = event.ctrlKey || event.metaKey
      if (!mod) return
      const targetEl = event.target instanceof HTMLElement ? event.target : null
      const inEditor = Boolean(targetEl && (targetEl.isContentEditable || targetEl.closest('input, textarea, select, [role="textbox"]')))
      const key = event.key.toLowerCase()
      if (key === 'f' && !event.shiftKey) {
        if (projection && !quickSearchOpen && !management && !queueEdit && !rollbackDialog && !editRerunDialog) {
          event.preventDefault()
          setThreadFindOpen(true)
          return
        }
        if (aggregatedMode && !inEditor) {
          event.preventDefault()
          setQuickSearchOpen(true)
          return
        }
      }
      if (aggregatedMode && ((key === 'f' && event.shiftKey) || (key === 'k' && event.shiftKey))) {
        event.preventDefault()
        setQuickSearchOpen(true)
        return
      }
      if (aggregatedMode && key === 'n' && !event.shiftKey && writable && !management && !queueEdit) {
        event.preventDefault()
        setQuickSearchOpen(false)
        startNewConversation()
        return
      }
      if (aggregatedMode && key === 'o' && !event.shiftKey && canOpenLocalProject && (quickSearchOpen || (!inEditor && !management && !queueEdit))) {
        event.preventDefault()
        setQuickSearchOpen(false)
        openLocalDirectoryForNewChat()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [aggregatedMode, canOpenLocalProject, editRerunDialog, interactive, management, openLocalDirectoryForNewChat, projection, queueEdit, quickSearchOpen, rollbackDialog, startNewConversation, writable])

  const selectedThreadAgent = useMemo(
    () => (selectedThread ? resolveConversationThreadAgent(selectedThread, knownAgents) : null),
    [knownAgents, selectedThread],
  )
  const selectedThreadTitle = useMemo(
    () => (selectedThread ? displayConversationThreadTitle(selectedThread, selectedThreadAgent) : undefined),
    [selectedThread, selectedThreadAgent],
  )
  const embeddedFilteredThreads = useMemo(() => {
    const list = threads ?? []
    if (!embeddedCrux) return list
    if (activeAgentContext) {
      const matched = list.filter((thread) => resolveConversationThreadAgent(thread, knownAgents)?.id === activeAgentContext.id)
      return matched.length > 0 || query.trim() ? matched : list
    }
    return list.filter((thread) => !resolveConversationThreadAgent(thread, knownAgents))
  }, [activeAgentContext, embeddedCrux, knownAgents, query, threads])

  const relatedWork = <ConversationRelations
    relations={projection?.relations}
    onOpenRelatedThread={openRelatedThread}
    onStopSubagent={writable ? handleStopSubagent : undefined}
    stoppingChildThreadId={stoppingSubagentId} />
  const agentPickerControl = (source === 'work' || source === 'code') && !taskScope && !compact && !target ? (
    <Dropdown width={300} trigger={({ open, toggle }) => (
      <button type="button" className="my-control my-control-ghost inline-flex max-w-52 shrink-0 items-center gap-1.5 text-my-xs text-my-primary"
        aria-label="选择对话对象" aria-expanded={open} onClick={toggle}>
        {activeAgentContext ? <AgentAvatar avatarId={activeAgentAvatarId} size={18} /> : <Sparkles size={14} aria-hidden="true" />}
        <span className="truncate font-medium">{activeAgentContext ? activeAgentContext.name : '小助手'}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
    )}>
      {(close) => (
        <div className="flex flex-col gap-0.5 p-1">
          <DropdownHeader>选择对话对象</DropdownHeader>
          <button type="button" onClick={() => { selectChatAgent(null); appliedAgentModelRef.current = null; close() }}
            className="flex min-h-8 w-full items-center gap-2 rounded-my-base px-2.5 py-1.5 text-left text-my-sm text-my-secondary hover:bg-my-layer-1-hover hover:text-my-primary">
            <Sparkles size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">小助手（通用自由对话）</span>
            {!activeAgentContext && <Check size={14} className="shrink-0 text-my-icon-accent" />}
          </button>
          {chatEligibleAgents.length > 0 && <div className="my-menu-divider" role="separator" />}
          {chatEligibleAgents.length > 0 && <DropdownHeader>空间 Agent（自动注入指令与技能）</DropdownHeader>}
          {chatEligibleAgents.map(({ agent, spaceName }) => {
            const selected = activeAgentContext?.id === agent.id
            return (
              <button key={agent.id} type="button" onClick={() => { selectChatAgent(agent.id); appliedAgentModelRef.current = null; close() }}
                className="flex min-h-9 w-full items-center gap-2 rounded-my-base px-2.5 py-1.5 text-left text-my-sm text-my-secondary hover:bg-my-layer-1-hover hover:text-my-primary">
                <AgentAvatar avatarId={agent.avatarId} size={20} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-my-primary">{agent.name}</span>
                  <span className="block truncate text-my-2xs text-my-tertiary">{spaceName} · {agent.skillIds.length} 项技能</span>
                </span>
                {selected && <Check size={14} className="shrink-0 text-my-icon-accent" />}
              </button>
            )
          })}
          {chatEligibleAgents.length === 0 && (
            <p className="px-2.5 py-1.5 text-my-xs text-my-tertiary">尚未创建空间 Agent，可前往工作台创建专属岗位。</p>
          )}
        </div>
      )}
    </Dropdown>
  ) : null

  const directoryChoices = projectChoices(appRoot, recentProjects)
  const workdirControl = (source === 'work' || source === 'code') && !taskScope && !compact ? (
    target ? (
      <Tooltip side="bottom" label="对话进行中，工作目录已固定。新建对话可切换其他目录。">
        <span tabIndex={0} className="my-chip inline-flex max-w-44 shrink-0 items-center gap-1 text-my-xs text-my-secondary">
          <Lock size={12} aria-hidden="true" />
          <span className="truncate">{code ? projectNameFromPath(root) : '托管目录'}</span>
        </span>
      </Tooltip>
    ) : (
      <Dropdown width={300} trigger={({ open, toggle }) => (
        <button type="button" className="my-control my-control-ghost inline-flex max-w-48 shrink-0 items-center gap-1.5 text-my-xs text-my-secondary hover:text-my-primary"
          aria-label="选择工作目录" aria-expanded={open} onClick={toggle}>
          <FolderOpen size={13} aria-hidden="true" />
          <span className="truncate">{code ? projectNameFromPath(root) : '默认托管目录'}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      )}>
        {(close) => (
          <div className="flex flex-col gap-0.5 p-1">
            <DropdownHeader>新建对话工作目录</DropdownHeader>
            <button type="button" onClick={() => { useMy.getState().setChatWorkdirMode('default'); close() }}
              className="flex min-h-8 w-full items-center gap-2 rounded-my-base px-2.5 py-1.5 text-left text-my-sm text-my-secondary hover:bg-my-layer-1-hover hover:text-my-primary">
              <FolderOpen size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">默认托管目录（无仓库门槛）</span>
              {!code && <Check size={14} className="shrink-0 text-my-icon-accent" />}
            </button>
            {directoryChoices.map((path) => {
              const selected = code && projectRootKey(path) === projectRootKey(root)
              return (
                <button key={projectRootKey(path)} type="button" disabled={!canOpenLocalProject}
                  onClick={() => {
                    close()
                    if (projectRootKey(path) !== projectRootKey(appRoot)) void useApp.getState().openProjectPath(path, { keepPage: true })
                    useMy.getState().setChatWorkdirMode('directory')
                  }}
                  className="flex min-h-8 w-full items-center gap-2 rounded-my-base px-2.5 py-1.5 text-left text-my-sm text-my-secondary hover:bg-my-layer-1-hover hover:text-my-primary disabled:text-my-disabled">
                  <FolderOpen size={14} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate" title={path}>{projectNameFromPath(path)}</span>
                  {selected && <Check size={14} className="shrink-0 text-my-icon-accent" />}
                </button>
              )
            })}
            <div className="my-menu-divider" role="separator" />
            <button type="button" disabled={!canOpenLocalProject}
              onClick={() => {
                close()
                openLocalDirectoryForNewChat()
              }}
              className="flex min-h-8 w-full items-center gap-2 rounded-my-base px-2.5 py-1.5 text-left text-my-sm text-my-secondary hover:bg-my-layer-1-hover hover:text-my-primary disabled:text-my-disabled">
              <FolderOpen size={14} className="shrink-0" />
              <span>选择本机目录…</span>
            </button>
          </div>
        )}
      </Dropdown>
    )
  ) : null
  const currentCleanup = sideCleanup?.owner === panelKey ? sideCleanup : pendingSideCleanup(sideCleanupKey)
  const chatLinks = useMemo(() => (
    fileLinks || openArtifact.artifactLinkHandler
      ? { ...(fileLinks ?? {}), ...(openArtifact.artifactLinkHandler ? { artifact: openArtifact.artifactLinkHandler } : {}) }
      : null
  ), [fileLinks, openArtifact.artifactLinkHandler])

  return <ChatProjectFileLinks.Provider value={chatLinks}><div className="acp-workspace conversation-workbench" style={sidebarWidth}>
    {workTask.dialog}
    {code && codeTask.dialog}
    {aggregatedMode && (
      <ConversationQuickSearchModal
        open={quickSearchOpen}
        onClose={() => setQuickSearchOpen(false)}
        items={sidebarAggregatedItems}
        activeThreadId={target?.threadId}
        writable={writable}
        canOpenLocalProject={canOpenLocalProject}
        knownAgents={knownAgents}
        onSelectThread={openAggregatedThread}
        onNewConversation={(agentId) => startNewConversation(agentId)}
        onOpenLocalDirectory={openLocalDirectoryForNewChat}
        onSearchRemote={searchRemoteAggregated}
        onSearchContent={searchContentAggregated}
        onSelectContentMatch={(match, findQuery) => {
          const existing = sidebarAggregatedItems.find(item => item.thread.id === match.threadId)
          pendingJumpFindRef.current = { threadId: match.threadId, query: findQuery }
          if (existing) {
            openAggregatedThread(existing)
          } else {
            const matchThreadId = match.threadId as OrchestrationV2AppThread['id']
            openAggregatedThread({
              thread: {
                createdBy: 'user',
                creationSource: 'web',
                id: matchThreadId,
                projectId: match.cwd as never,
                title: match.threadTitle,
                providerInstanceId: 'codex' as never,
                modelSelection: { instanceId: 'codex', model: 'codex' } as never,
                runtimeMode: 'approval-required',
                interactionMode: 'default',
                branch: null,
                worktreePath: null,
                activeProviderThreadId: null,
                lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: matchThreadId },
                forkedFrom: null,
                createdAt: match.updatedAt as never,
                updatedAt: match.updatedAt as never,
                archivedAt: null,
                settledAt: null,
                settledOverride: null,
                lastVisitedAt: null,
                deletedAt: null,
              },
              cwd: match.cwd,
              source: match.source,
              projectName: match.projectName,
            })
          }
        }}
      />
    )}
    <Modal open={Boolean(queueEdit)} onClose={() => setQueueEdit(undefined)} ariaLabel="编辑排队消息" width={500}>
      {queueEdit && <form className="space-y-4 p-4" onSubmit={event => {
        event.preventDefault()
        if (!queueEdit.text.trim() || targetRef.current?.threadId !== queueEdit.threadId || controller.pendingCommands.size || controlFailure?.uncertain) return
        const edit = queueEdit
        applyControl(queue.edit(edit.runId, edit.text).then(result => {
          if (result.ok && mounted.current) setQueueEdit(current => current === edit ? undefined : current)
          return result
        }))
      }}>
        <h2 className="text-my-lg font-medium">编辑排队消息</h2>
        <textarea className="my-input w-full" rows={5} aria-label="排队消息" maxLength={CONVERSATION_TEXT_LIMIT} value={queueEdit.text}
          onChange={event => setQueueEdit({ ...queueEdit, text: event.target.value })} />
        {controlNotice}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setQueueEdit(undefined)}>取消</Button>
          <Button type="submit" variant="primary"
            disabled={!queueEdit.text.trim() || Boolean(controller.pendingCommands.size) || controlFailure?.uncertain}>保存</Button>
        </div>
      </form>}
    </Modal>
    <Modal open={Boolean(rollbackDialog)} onClose={() => { if (!rollbackDialog?.pending) setRollbackDialog(undefined) }}
      ariaLabel="回滚会话到指定轮次" width={480}>
      {rollbackDialog && (() => {
        const matchedCheckpoint = projection?.checkpoints.find(
          item => item.runId === rollbackDialog.targetRunId && item.phase === rollbackDialog.boundary && item.status === 'captured',
        )
        const changeCount = (matchedCheckpoint?.dirtyFileCount ?? 0) + (matchedCheckpoint?.untrackedCount ?? 0)
        return <form className="space-y-4 p-4" onSubmit={event => {
          event.preventDefault()
          if (rollbackDialog.pending || targetRef.current?.threadId !== rollbackDialog.threadId) return
          const snapshotDialog = rollbackDialog
          setRollbackDialog(current => current ? { ...current, pending: true, error: undefined } : undefined)
          void controller.rollbackCheckpoint({
            targetRunId: snapshotDialog.targetRunId,
            boundary: snapshotDialog.boundary,
            restoreFiles: Boolean(matchedCheckpoint && snapshotDialog.restoreFiles),
          }).then(result => {
            if (!mounted.current) return
            if (result.ok) {
              setRollbackDialog(undefined)
              setListRevision(value => value + 1)
            } else {
              setRollbackDialog(current => current ? { ...current, pending: false, error: result.reason } : undefined)
            }
          })
        }}>
          <h2 className="text-my-lg font-medium">{rollbackDialog.boundary === 'before' ? '回滚到此消息之前' : '回滚到此回合结果'}</h2>
          <p className="my-item-description">
            {rollbackDialog.boundary === 'before'
              ? '将移除这条消息及其之后的所有对话轮次、工具记录与工作项，操作不可撤销。'
              : '将保留这一回合的回复，并移除其之后的所有对话轮次、工具记录与工作项，操作不可撤销。'}
          </p>
          {matchedCheckpoint ? (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-my-base border border-my-line bg-my-panel p-3 text-my-sm text-my-primary">
              <input type="checkbox" className="mt-0.5" checked={rollbackDialog.restoreFiles}
                disabled={rollbackDialog.pending}
                onChange={event => setRollbackDialog(current => current ? { ...current, restoreFiles: event.target.checked } : undefined)} />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block font-normal">同时还原工作区文件到此检查点</span>
                <span className="block text-my-xs text-my-tertiary tabular-nums">
                  {changeCount > 0 ? `快照当时记录 ${changeCount} 项工作区变更；还原会覆盖其后未提交修改。` : '快照当时工作区干净；还原将清除其后新建或修改的文件。'}
                </span>
              </span>
            </label>
          ) : (
            <p className="rounded-my-base border border-my-line bg-my-panel p-3 text-my-xs text-my-tertiary">
              此回合未捕获可用的 Git 文件检查点，本次仅回退对话历史，不改动磁盘文件。
            </p>
          )}
          {rollbackDialog.error && <FeedbackNotice variant="bar-compact" tone="error" title="无法完成回滚" description={rollbackDialog.error} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={rollbackDialog.pending} onClick={() => setRollbackDialog(undefined)}>取消</Button>
            <Button type="submit" variant="danger" disabled={rollbackDialog.pending}>
              {rollbackDialog.pending ? '正在回滚…' : '确认回滚'}
            </Button>
          </div>
        </form>
      })()}
    </Modal>
    <Modal open={Boolean(editRerunDialog)} onClose={() => { if (!editRerunDialog?.pending) setEditRerunDialog(undefined) }}
      ariaLabel="编辑历史消息并重跑" width={540}>
      {editRerunDialog && (() => {
        const matchedCheckpoint = projection?.checkpoints.find(
          item => item.runId === editRerunDialog.targetRunId && item.phase === 'before' && item.status === 'captured',
        )
        const targetModel = selectedModel ?? (projection ? {
          instanceId: projection.thread.modelSelection.instanceId,
          id: projection.thread.modelSelection.model,
          displayName: projection.thread.modelSelection.model,
          options: projection.thread.modelSelection.options,
        } : null)
        return <form className="space-y-4 p-4" onSubmit={event => {
          event.preventDefault()
          if (editRerunDialog.pending || !editRerunDialog.text.trim() || !targetModel || targetRef.current?.threadId !== editRerunDialog.threadId) return
          const snapshotDialog = editRerunDialog
          setEditRerunDialog(current => current ? { ...current, pending: true, error: undefined } : undefined)
          void controller.editAndRerun({
            targetRunId: snapshotDialog.targetRunId,
            messageId: snapshotDialog.messageId,
            text: snapshotDialog.text,
            restoreFiles: Boolean(matchedCheckpoint && snapshotDialog.restoreFiles),
            instanceId: targetModel.instanceId,
            model: targetModel.id,
            ...(targetModel.options?.length ? { options: targetModel.options } : {}),
          }).then(result => {
            if (!mounted.current) return
            if (result.ok) {
              setEditRerunDialog(undefined)
              setListRevision(value => value + 1)
            } else {
              setEditRerunDialog(current => current ? { ...current, pending: false, error: result.reason } : undefined)
            }
          })
        }}>
          <h2 className="text-my-lg font-medium">编辑历史消息并重跑</h2>
          <p className="my-item-description">将从这条消息起重新生成回复，原后续对话轮次将被替换。</p>
          <textarea className="my-input w-full" rows={5} aria-label="编辑后的消息内容" maxLength={CONVERSATION_TEXT_LIMIT}
            disabled={editRerunDialog.pending} value={editRerunDialog.text}
            onChange={event => setEditRerunDialog(current => current ? { ...current, text: event.target.value } : undefined)} />
          {matchedCheckpoint ? (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-my-base border border-my-line bg-my-panel p-3 text-my-sm text-my-primary">
              <input type="checkbox" className="mt-0.5" checked={editRerunDialog.restoreFiles}
                disabled={editRerunDialog.pending}
                onChange={event => setEditRerunDialog(current => current ? { ...current, restoreFiles: event.target.checked } : undefined)} />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block font-normal">同时还原工作区文件到此轮执行前</span>
                <span className="block text-my-xs text-my-tertiary">取消勾选则保留当前工作区文件，仅修改提示词重跑对话。</span>
              </span>
            </label>
          ) : (
            <p className="rounded-my-base border border-my-line bg-my-panel p-3 text-my-xs text-my-tertiary">
              此轮未记录执行前 Git 检查点，将保留当前文件并重跑对话。
            </p>
          )}
          {editRerunDialog.error && <FeedbackNotice variant="bar-compact" tone="error" title="无法重跑" description={editRerunDialog.error} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={editRerunDialog.pending} onClick={() => setEditRerunDialog(undefined)}>取消</Button>
            <Button type="submit" variant="primary"
              disabled={editRerunDialog.pending || !editRerunDialog.text.trim() || !targetModel}>
              {editRerunDialog.pending ? '正在重跑…' : '保存并重跑'}
            </Button>
          </div>
        </form>
      })()}
    </Modal>
    <Modal open={Boolean(management)} onClose={() => setManagement(undefined)} ariaLabel={management?.action === 'delete' ? '删除会话' : '重命名会话'} width={420}>
      {management && <form className="space-y-4 p-4" onSubmit={event => {
        event.preventDefault()
        const threadId = management.thread.id
        if (management.action === 'rename') {
          if (management.title.trim()) void changeThread({ type: 'thread.rename', threadId, title: management.title }, management.cwd)
        } else void changeThread({ type: 'thread.delete', threadId }, management.cwd)
      }}>
        <h2 className="text-my-lg font-medium">{management.action === 'delete' ? '删除会话' : '重命名会话'}</h2>
        {management.action === 'rename' ? <input className="my-input w-full" aria-label="会话名称" maxLength={500} value={management.title}
          onChange={event => setManagement({ ...management, title: event.target.value })} />
          : <p className="my-item-description">删除「{management.title}」及其消息记录。</p>}
        {managementError && <ConversationIssue title={pendingChange ? '操作结果待核对' : '未能更新会话'} reason={managementError}
          actions={pendingChange
            ? threadChangeActions
            : management.action === 'delete' && <Button type="button" size="sm" variant="outline" onClick={() => {
              const threadId = management.thread.id
              setManagement(undefined)
              if (targetRef.current?.threadId !== threadId) {
                const matched = sidebarAggregatedItems.find((entry) => entry.thread.id === threadId)
                if (matched && aggregatedMode) openAggregatedThread(matched)
                else select({ threadId })
              }
              else if (deleteRun) applyControl(stop(deleteRun.id))
            }}>{deleteRun ? '停止原回合' : '查看原会话'}</Button>} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setManagement(undefined)}>取消</Button>
          <Button type="submit" variant={management.action === 'delete' ? 'danger' : 'primary'}
            disabled={Boolean(pendingChange) || management.action === 'rename' && !management.title.trim()}>{management.action === 'delete' ? '删除' : '保存'}</Button>
        </div>
      </form>}
    </Modal>
    {projection && writable && !archivedThread && (
      <ThreadTagsSnoozeModal
        open={tagsSnoozeOpen}
        onClose={() => setTagsSnoozeOpen(false)}
        currentTags={projection.thread.tags ?? []}
        snoozedUntil={typeof projection.thread.snoozedUntil === 'string'
          ? projection.thread.snoozedUntil
          : projection.thread.snoozedUntil
            ? new Date(projection.thread.snoozedUntil.epochMilliseconds).toISOString()
            : null}
        onSaveTags={async (nextTags) => {
          const result = await controller.setTags(nextTags)
          if (result.ok) setListRevision((value) => value + 1)
          return result.ok ? { ok: true } : { ok: false, reason: result.reason }
        }}
        onSaveSnooze={async (nextSnooze) => {
          const result = await controller.snoozeThread(nextSnooze)
          if (result.ok) setListRevision((value) => value + 1)
          return result.ok ? { ok: true } : { ok: false, reason: result.reason }
        }}
      />
    )}
    {!embeddedCrux && <ContextRegion collapsed={collapsed && !sidebarOpen}><div className="acp-navigation-host flex min-h-0 shrink-0">
    <ConversationSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} ariaLabel={`${workspaceLabel}历史`} resizable={!compact}
      title={taskScope ? <strong className="my-item-title truncate" title={taskScope.title}>{taskScope.title}</strong>
        : projectIntake ? <Dropdown trigger={({ open, toggle }) => <button type="button" className="acp-module-switch" aria-label="切换对话模块" aria-expanded={open} onClick={toggle}>
        <strong>{source === 'native' ? '原生对话' : '对话'}</strong><ChevronDown size={13} aria-hidden="true" />
      </button>}>{(close) => <div onClick={close}><ModuleLinks domain="agents" agentView={agentView === 'native' ? 'native' : 'conversation'} /></div>}</Dropdown>
        : <strong>对话</strong>}
      actions={aggregatedMode ? (
        <div className="conversation-sidebar-toolbar">
          <Dropdown
            align="right"
            width={184}
            trigger={({ open, toggle }) => (
              <Tooltip side="bottom" label="分组与范围">
                <button
                  type="button"
                  className={open || groupMode !== 'auto' || scopeFilter !== 'all' || statusFilter !== 'all' ? 'conversation-sidebar-tool-btn my-icon-control is-active' : 'conversation-sidebar-tool-btn my-icon-control'}
                  aria-label="分组与显示范围"
                  aria-expanded={open}
                  onClick={toggle}
                >
                  <ListFilter size={15} aria-hidden="true" />
                </button>
              </Tooltip>
            )}
          >
            {(close) => (
              <>
                <DropdownHeader>分组方式</DropdownHeader>
                <DropdownItem selected={groupMode === 'auto'} onClick={() => { setGroupMode('auto'); close() }}>自动分组</DropdownItem>
                <DropdownItem selected={groupMode === 'agent'} onClick={() => { setGroupMode('agent'); close() }}>按智能体分组</DropdownItem>
                <DropdownItem selected={groupMode === 'time'} onClick={() => { setGroupMode('time'); close() }}>按时间排序</DropdownItem>
                <DropdownDivider />
                <DropdownHeader>目录范围</DropdownHeader>
                <DropdownItem selected={scopeFilter === 'all'} onClick={() => { setScopeFilter('all'); close() }}>全部目录</DropdownItem>
                <DropdownItem selected={scopeFilter === 'current'} onClick={() => { setScopeFilter('current'); close() }}>仅当前目录</DropdownItem>
                <DropdownDivider />
                <DropdownHeader>会话状态</DropdownHeader>
                <DropdownItem selected={statusFilter === 'all'} onClick={() => { setStatusFilter('all'); close() }}>全部状态</DropdownItem>
                <DropdownItem selected={statusFilter === 'unread'} onClick={() => { setStatusFilter('unread'); close() }}>仅未读</DropdownItem>
                <DropdownItem selected={statusFilter === 'running'} onClick={() => { setStatusFilter('running'); close() }}>运行中</DropdownItem>
              </>
            )}
          </Dropdown>
        </div>
      ) : undefined}
      primaryAction={aggregatedMode ? (
        <>
          {writable && (
            <button
              type="button"
              className="my-nav-item conversation-sidebar-action"
              onClick={() => startNewConversation()}
            >
              <SquarePen size={15} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">新建对话</span>
              <kbd className="my-kbd">Ctrl N</kbd>
            </button>
          )}
          <button
            type="button"
            className="my-nav-item conversation-sidebar-action"
            onClick={() => setQuickSearchOpen(true)}
          >
            <Search size={15} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">搜索对话</span>
            <kbd className="my-kbd">Ctrl ⇧F</kbd>
          </button>
        </>
      ) : <div className="grid gap-2">{writable && <button type="button" className="my-nav-item" onClick={() => openDraft()}><Plus size={15} aria-hidden="true" />新建对话</button>}
        <SearchInput value={query} onChange={value => setQuery(value.slice(0, 160))} size="sm" placeholder="搜索对话" /></div>}>
      {(() => {
        const listMatchesMainReadError = Boolean(
          listError && read?.error && summarizeFeedbackMessage(listError).summary === summarizeFeedbackMessage(read.error).summary,
        )
        const showSidebarListError = Boolean(listError) && !listMatchesMainReadError
        const showSidebarManageError = !management && Boolean(managementError || pendingChange)
        if (!showSidebarListError && !showSidebarManageError) return null
        return <div className="mb-3 space-y-2">
          {showSidebarListError && <ConversationIssue variant="bar-compact"
            title={sidebarAggregatedItems.length > 0 ? '未能刷新会话列表' : '无法读取会话列表'}
            reason={listError}
            actions={<>
              {isDaemonOutdatedError(listError) && <Button size="sm" variant="outline" onClick={() => useApp.getState().setPage('machines')}>运行状态</Button>}
              <Button size="sm" variant="outline" onClick={() => setListRevision((value) => value + 1)}>重试</Button>
            </>} />}
          {showSidebarManageError && <ConversationIssue variant="bar-compact" title={pendingChange ? '操作结果待核对' : '未能更新会话'} reason={managementError}
            actions={threadChangeActions} />}
        </div>
      })()}
      {aggregatedMode ? (
        <ConversationSidebarList
          items={sidebarAggregatedItems}
          knownAgents={knownAgents}
          activeThreadId={target?.threadId}
          activeRunThreadId={activeRun ? hostThreadId : undefined}
          currentRoot={root}
          currentSource={source === 'code' ? 'code' : 'work'}
          groupMode={groupMode}
          scopeFilter={scopeFilter}
          statusFilter={statusFilter}
          collapsedGroups={collapsedGroups}
          writable={writable}
          onToggleGroup={toggleGroupCollapsed}
          onResetScopeFilter={() => { setScopeFilter('all'); setStatusFilter('all') }}
          onSelectItem={openAggregatedThread}
          onNewWithAgent={(agentId) => startNewConversation(agentId)}
          onTogglePin={(item) => void changeThread({ type: 'thread.pin', threadId: item.thread.id, pinned: !item.thread.pinnedAt }, item.cwd)}
          onToggleArchive={(item) => void changeThread({ type: 'thread.archive', threadId: item.thread.id, archived: !item.thread.archivedAt }, item.cwd)}
          onRename={(item) => {
            const binding = resolveConversationThreadAgent(item.thread, knownAgents)
            setManagement({ thread: item.thread, cwd: item.cwd, action: 'rename', title: displayConversationThreadTitle(item.thread, binding) })
          }}
          onDelete={(item) => {
            const binding = resolveConversationThreadAgent(item.thread, knownAgents)
            setManagement({ thread: item.thread, cwd: item.cwd, action: 'delete', title: displayConversationThreadTitle(item.thread, binding) })
          }}
          onRegenerateTitle={(item) => void changeThread({ type: 'thread.title.regenerate', threadId: item.thread.id }, item.cwd)}
          onToggleUnread={(item, unread) => void changeThread(unread ? { type: 'thread.mark-unread', threadId: item.thread.id } : { type: 'thread.visit', threadId: item.thread.id }, item.cwd)}
        />
      ) : (
        <>
          {query.trim() && threads?.length === 0 && <p className="my-item-description p-2">没有匹配的会话</p>}
          {(threads ?? []).map(thread => {
            const cleanTitle = displayConversationThreadTitle(thread, null)
            const unread = isThreadUnread(thread)
            const tags = visibleThreadTags(thread.tags)
            return <ConversationListRow key={thread.id} id={thread.id} title={cleanTitle}
            selected={thread.id === target?.threadId} pinned={Boolean(thread.pinnedAt)}
            archived={Boolean(thread.archivedAt)} unread={unread} tags={tags} time={threadUpdatedAt(thread.updatedAt)}
            busy={thread.id === hostThreadId && Boolean(activeRun)}
            onSelect={() => thread.id === targetRef.current?.threadId ? setSidebarOpen(false) : select({ threadId: thread.id })}
            onTogglePin={writable ? () => void changeThread({ type: 'thread.pin', threadId: thread.id, pinned: !thread.pinnedAt }) : undefined}
            onToggleArchive={writable ? () => void changeThread({ type: 'thread.archive', threadId: thread.id, archived: !thread.archivedAt }) : undefined}
            actions={writable && <Dropdown trigger={({ open, toggle }) => <button type="button" className="acp-recent-action-btn my-icon-control"
              aria-label={`${cleanTitle}的更多操作`} aria-expanded={open} onClick={toggle}><MoreHorizontal size={16} aria-hidden="true" /></button>}>
              {close => <>
                <DropdownItem icon={<Sparkles size={14} aria-hidden="true" />} onClick={() => { close(); void changeThread({ type: 'thread.title.regenerate', threadId: thread.id }) }}>重新生成标题</DropdownItem>
                <DropdownItem icon={<Check size={14} aria-hidden="true" />} onClick={() => { close(); void changeThread(unread ? { type: 'thread.visit', threadId: thread.id } : { type: 'thread.mark-unread', threadId: thread.id }) }}>{unread ? '标为已读' : '标为未读'}</DropdownItem>
                <DropdownItem icon={<Pencil size={14} aria-hidden="true" />} onClick={() => { close(); setManagement({ thread, cwd: root, action: 'rename', title: cleanTitle }) }}>重命名</DropdownItem>
                <DropdownItem danger icon={<Trash2 size={14} aria-hidden="true" />} onClick={() => { close(); setManagement({ thread, cwd: root, action: 'delete', title: cleanTitle }) }}>删除</DropdownItem>
              </>}
            </Dropdown>} />
          })}
        </>
      )}
    </ConversationSidebar>
    </div></ContextRegion>}
    <ChatView label={workspaceLabel} draftHero={draftIsEmpty}
      header={embeddedCrux ? <ConversationWorkspaceHeader
        leading={<>
          <button type="button" className="my-icon-control" title="关闭对话" aria-label="关闭对话" onClick={embeddedCrux.onClose}>
            <X size={15} aria-hidden="true" />
          </button>
          <span className="mx-0.5 h-3.5 w-px bg-my-line" aria-hidden="true" />
        </>}
        identity={<div className="flex min-w-0 items-center gap-1.5">
          {agentPickerControl ?? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              {selectedThreadAgent ? <AgentAvatar avatarId={selectedThreadAgent.avatarId} size={18} /> : activeAgentContext ? <AgentAvatar avatarId={activeAgentAvatarId} size={18} /> : null}
              <strong className="truncate">{selectedThreadAgent?.name ?? activeAgentContext?.name ?? '小助手'}</strong>
            </span>
          )}
          {selectedThreadTitle && (
            <>
              <span className="text-my-tertiary">/</span>
              <span className="max-w-[260px] truncate text-my-sm text-my-secondary">{selectedThreadTitle}</span>
            </>
          )}
          {writable && (
            <button type="button" className="my-icon-control ml-0.5" title="新建对话" aria-label="新建对话" onClick={() => openDraft()}>
              <RotateCcw size={13} aria-hidden="true" />
            </button>
          )}
        </div>}
        actions={<>
          <Dropdown
            align="right"
            width={280}
            trigger={({ open, toggle }) => (
              <button type="button" className="my-icon-control" title="对话历史" aria-label="对话历史" aria-expanded={open} onClick={toggle}>
                <History size={15} aria-hidden="true" />
              </button>
            )}
          >
            {(close) => (
              <div className="flex flex-col gap-1.5 p-1">
                <div className="flex items-center justify-between px-2 pt-1 pb-0.5">
                  <span className="text-my-xs font-medium text-my-secondary">
                    {activeAgentContext ? `${activeAgentContext.name} 的对话历史` : '对话历史'}
                  </span>
                  {writable && (
                    <button type="button" className="text-my-2xs text-my-secondary hover:text-my-primary" onClick={() => { close(); openDraft() }}>
                      + 新建
                    </button>
                  )}
                </div>
                <SearchInput value={query} onChange={value => setQuery(value.slice(0, 160))} size="sm" placeholder="搜索历史对话" />
                <div className="collab-scroll max-h-64 space-y-0.5">
                  {embeddedFilteredThreads.length === 0 ? (
                    <div className="py-5 text-center text-my-xs text-my-tertiary">暂无历史会话</div>
                  ) : (
                    embeddedFilteredThreads.slice(0, 20).map((thread) => {
                      const binding = resolveConversationThreadAgent(thread, knownAgents)
                      const cleanTitle = displayConversationThreadTitle(thread, binding)
                      return (
                        <button
                          key={thread.id}
                          type="button"
                          data-selected={thread.id === target?.threadId || undefined}
                          onClick={() => { close(); select({ threadId: thread.id }) }}
                          className="my-menu-item justify-between"
                        >
                          <span className="min-w-0 flex-1 truncate">{cleanTitle}</span>
                          {thread.id === target?.threadId && <Check size={13} className="shrink-0 text-my-success-text" />}
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            )}
          </Dropdown>
          {activeAgentContext && embeddedCrux.onOpenSettings && (
            <button
              type="button"
              onClick={() => embeddedCrux.onOpenSettings?.(activeAgentContext.id)}
              className="inline-flex items-center gap-1.5 rounded-my-base px-2 py-1 text-my-xs text-my-secondary transition-colors hover:bg-my-layer-1 hover:text-my-primary"
            >
              <Settings2 size={14} aria-hidden="true" />
              <span>设置</span>
            </button>
          )}
          {projection && <button type="button" className="my-icon-control"
            title="在当前对话中查找 (Ctrl+F)" aria-label="在当前对话中查找" aria-pressed={threadFindOpen}
            onClick={() => setThreadFindOpen(value => !value)}><Search size={15} aria-hidden="true" /></button>}
          {projection && (projectAvailable || projection.relations.children.length > 0 || panel.state.surfaces.length > 0) && <button type="button" ref={panelTrigger} className="my-icon-control"
            title="会话工作台" aria-label="会话工作台" aria-expanded={Boolean(panel.active)}
            onClick={() => {
              if (!canInteract()) return
              if (panel.active) hidePanel()
              else { panelReturnFocus.current = panelTrigger.current; panel.show() }
            }}><PanelRight size={16} aria-hidden="true" /></button>}
        </>} />
      : <ConversationWorkspaceHeader leading={<>
        {onBackToTask && <button type="button" className="my-icon-control" title="返回任务" aria-label="返回任务" onClick={onBackToTask}>
          <ArrowLeft size={16} aria-hidden="true" />
        </button>}
        <button type="button" className="my-icon-control acp-mobile-only"
          aria-label="打开会话导航" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><PanelLeft size={16} aria-hidden="true" /></button>
      </>}
        identity={<div className="flex min-w-0 items-center gap-2">
          {agentPickerControl ?? (
            selectedThreadAgent ? (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <AgentAvatar avatarId={selectedThreadAgent.avatarId} size={18} />
                <span className="shrink-0 text-my-sm font-medium text-my-secondary">{selectedThreadAgent.name}</span>
                <span className="shrink-0 text-my-tertiary" aria-hidden="true">/</span>
                <strong className="truncate">{selectedThreadTitle}</strong>
              </span>
            ) : (
              <strong className="truncate">{selectedThreadTitle ?? taskScope?.title ?? (target ? '会话' : draftRole?.name ?? '新建对话')}</strong>
            )
          )}
          {projection && (
            (() => {
              const snoozeIso = typeof projection.thread.snoozedUntil === 'string'
                ? projection.thread.snoozedUntil
                : projection.thread.snoozedUntil
                  ? new Date(projection.thread.snoozedUntil.epochMilliseconds).toISOString()
                  : null
              const snoozeLabel = formatSnoozeLabel(snoozeIso)
              return snoozeLabel ? (
                <button
                  type="button"
                  className="conversation-snooze-chip"
                  title="调整或清除置后提醒"
                  onClick={() => setTagsSnoozeOpen(true)}
                >
                  <Clock size={11} aria-hidden="true" />
                  <span>{snoozeLabel}</span>
                </button>
              ) : null
            })()
          )}
          {workdirControl}
        </div>}
        actions={<>
          {interactive && code && !compact && !taskScope && <><GitBranchControl /><ApplicationPanel /></>}
          {interactive && code && !compact && <ManagedWorkflowRecovery key={rootKey} root={root} />}
          {selectedThread && <span className="my-item-description conversation-model-name" title={selectedThread.modelSelection.model}>{modelLabel(selectedThread.modelSelection.model)}</span>}
          {projection && writable && !archivedThread && <button type="button" className="my-icon-control"
            title="标签与置后提醒" aria-label="标签与置后提醒"
            onClick={() => setTagsSnoozeOpen(true)}><Tag size={15} aria-hidden="true" /></button>}
          {projection && projection.checkpoints.length > 0 && <button type="button" className="my-icon-control"
            title="查看检查点与文件差异" aria-label="查看检查点与文件差异"
            aria-pressed={panel.active?.kind === 'checkpoints'}
            onClick={() => {
              if (!canInteract()) return
              if (panel.active?.kind === 'checkpoints') hidePanel()
              else {
                if (!panel.active && document.activeElement instanceof HTMLElement) panelReturnFocus.current = document.activeElement
                panel.open(conversationCheckpointsSurface())
              }
            }}><History size={15} aria-hidden="true" /></button>}
          {projection && <button type="button" className="my-icon-control"
            title="在当前对话中查找 (Ctrl+F)" aria-label="在当前对话中查找" aria-pressed={threadFindOpen}
            onClick={() => setThreadFindOpen(value => !value)}><Search size={15} aria-hidden="true" /></button>}
          {projection && (projectAvailable || projection.relations.children.length > 0 || projection.checkpoints.length > 0 || panel.state.surfaces.length > 0) && <button type="button" ref={panelTrigger} className="my-icon-control"
            title="会话工作台" aria-label="会话工作台" aria-expanded={Boolean(panel.active)}
            onClick={() => {
              if (!canInteract()) return
              if (panel.active) hidePanel()
              else { panelReturnFocus.current = panelTrigger.current; panel.show() }
            }}><PanelRight size={17} aria-hidden="true" /></button>}
        </>} />}
      projectIntake={projectIntake && <ProjectConversationIntake root={root} enabled={writable}
        canAppend={Boolean(projection && !archivedThread)} onAppend={appendIntake}
        canAddReference={(!hostThreadId || projection?.thread.id === hostThreadId) && !archivedThread &&
          composer.attachmentIntake.available && composer.attachmentIntake.canEdit && !composer.attachmentIntake.state.pending}
        onAddReference={async (knowledge, isCurrent) => {
          const originalThread = targetRef.current?.threadId
          const added = await composer.attachmentIntake.addKnowledge(knowledge,
            () => isCurrent() && targetRef.current?.threadId === originalThread)
          if (added) focusComposer()
          return added
        }} />}>
        {projection && (
          <ThreadFindBar
            open={threadFindOpen}
            query={threadFindQuery}
            matchCount={matchedFindRowIds.length}
            activeMatchIndex={clampedFindIndex}
            onQueryChange={(next) => {
              setThreadFindQuery(next)
              setThreadFindIndex(0)
            }}
            onNext={() => jumpToFindIndex(clampedFindIndex + 1)}
            onPrev={() => jumpToFindIndex(clampedFindIndex - 1)}
            onClose={() => setThreadFindOpen(false)}
          />
        )}
        <ConversationTimeline key={`timeline:${visibleThreadId}`} threadId={`${rootKey}:${visibleThreadId}`} rows={rows}
          findQuery={threadFindOpen ? threadFindQuery : ''}
          highlightedRowId={highlightedFindRowId}
          matchedRowIds={matchedFindRowSet}
          scrollToRowRequest={scrollToRowRequest}
          onImplementPlan={writable && projection && !archivedThread && !activeRun && !read?.error ? handleImplementPlan : undefined}
          implementingPlan={implementingPlan}
          sourceThreadId={projection?.thread.id} citationRef={citationRef} onCite={writable && projection ? insertAssistantCitation : undefined}
          onOpenCitation={openAssistantCitation}
          onOpenRelatedThread={openRelatedThread}
          onStopSubagent={writable ? handleStopSubagent : undefined}
          stoppingChildThreadId={stoppingSubagentId}
          onForkFromRun={writable && projection && !archivedThread ? runId => {
            void sideChat.open({ sourcePoint: { type: 'run', runId } })
          } : undefined}
          onRollbackRun={supportsPersonalModes && projection && !activeRun && writable && !read?.error
            ? (runId, boundary) => {
                setRollbackDialog({ threadId: projection.thread.id, targetRunId: runId, boundary, restoreFiles: false, pending: false })
              }
            : undefined}
          onEditAndRerun={supportsPersonalModes && projection && !activeRun && writable && !read?.error
            ? message => {
                if (!message.runId) return
                setEditRerunDialog({
                  threadId: projection.thread.id,
                  targetRunId: message.runId,
                  messageId: message.id,
                  text: message.text,
                  restoreFiles: false,
                  pending: false,
                })
              }
            : undefined}
          working={submitting || loadingThread || runPending && !read?.error}
          workingLabel={loadingThread ? '正在读取会话…' : submitting && !target ? '正在发送给 Crux…'
            : run?.status === 'queued' || run?.status === 'preparing' ? '已受理，等待模型…'
              : activeRun?.nativeTurnId || activeRun?.engineAcceptedAt ? '模型已接收，正在回复…'
                : activeRun?.status === 'starting' ? (runningProvider === 'codex' ? '正在启动 Codex…' : '正在启动模型…')
                  : '正在连接并发送给模型…'}
          workingStartedAt={runStartIso(activeRun)}
          workingUserMessageId={activeRun?.userMessageId}
          hasOlderHistory={Boolean(projection?.hasOlderHistory)} loadingEarlier={loadingEarlier}
          onLoadEarlier={loadEarlier}
          onQuote={writable && projection ? (message, text) => {
            composer.addReference({
              id: crypto.randomUUID(),
              label: message.role === 'user' ? '引用你的消息' : '引用会话回复',
              text,
            })
            focusComposer()
          } : undefined}
          onEdit={writable && projection ? message => {
            if (composer.hasContent) {
              composer.addReference({ id: `edit:${message.id}`, label: '引用原消息', text: message.text })
            } else composer.setDraft(message.text)
            focusComposer()
          } : undefined}
          emptyTitle={target ? '暂无消息' : activeAgentContext ? `与 ${activeAgentContext.name} 开始对话` : undefined}
          hideEmptyState={Boolean(read?.error)}
          footer={draftIsEmpty && activeAgentContext ? (
            <div className="mx-auto mb-3 flex w-full max-w-xl flex-col gap-2 rounded-my-base border border-my-line bg-my-panel p-3 text-my-xs text-my-secondary">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-medium text-my-primary">
                  <AgentAvatar avatarId={activeAgentAvatarId} size={18} />
                  {activeAgentContext.name} · {activeAgentContext.spaceName}
                </span>
                <span className="inline-flex items-center gap-1 text-my-2xs text-my-tertiary">
                  <Cpu size={12} aria-hidden="true" />本机偏好：{runtimeKindLabel(activeAgentContext.runtimeKind)}
                </span>
              </div>
              {activeAgentContext.description && <p className="m-0 text-my-xs text-my-secondary">{activeAgentContext.description}</p>}
              <div className="flex flex-wrap items-center gap-1.5 text-my-2xs text-my-tertiary">
                <span>首轮发送将自动携带岗位指令</span>
                {activeAgentContext.skills.length > 0 && <span>· 附带 {activeAgentContext.skills.length} 项绑定技能（{activeAgentContext.skills.map((s) => s.name).join('、')}）</span>}
              </div>
            </div>
          ) : undefined} />
        <div className="my-conversation-column conversation-controls">
          {projection && <>
            {projection.thread.rollbackUnrestored
              && projection.thread.rollbackUnrestored.repositories.length > 0
              && dismissedRollbackUnrestoredId !== projection.thread.rollbackUnrestored.requestId && (
                <FeedbackNotice
                  variant="bar-compact"
                  tone="warning"
                  title="部分工作区文件未能还原"
                  description={`以下目录在目标回合缺少可用快照，仅回退了对话记录：${projection.thread.rollbackUnrestored.repositories.join('、')}`}
                  actions={
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDismissedRollbackUnrestoredId(projection.thread.rollbackUnrestored?.requestId ?? null)}
                    >
                      知道了
                    </Button>
                  }
                />
              )}
            <ConversationSubagentBar
              relations={projection.relations}
              onOpenRelatedThread={openRelatedThread}
              onStopSubagent={writable ? handleStopSubagent : undefined}
              stoppingChildThreadId={stoppingSubagentId}
            />
            <ChildThreadApprovals
              cwd={root}
              relations={projection.relations}
              task={task}
              disabled={!writable}
              onOpenRelatedThread={openRelatedThread}
              onResponded={reload}
            />
            <ConversationRuntimeRequests controller={controller} requests={projection.runtimeRequests} disabled={!writable}
              cwd={root} threadId={projection.thread.id} task={task} />
            <ConversationQueue controller={controller} queued={queued} queuePaused={projection.queuePaused}
              activeRunId={activeRun?.id ?? null} canSteer={canSteer} disabled={!writable}
              onEditRequested={controlFailure?.uncertain ? undefined : (queuedRun, text) => {
                setControlFailure(undefined)
                setQueueEdit({ threadId: visibleThreadId, runId: queuedRun.id, text })
              }} />
          </>}
          {!hasIpc && <ConversationIssue title="请在 Crux 桌面端使用原生对话" />}
          {read?.error && <ConversationIssue title="无法读取会话" reason={read.error}
            actions={<>
              {isDaemonOutdatedError(read.error) && <Button size="sm" variant="outline" onClick={() => useApp.getState().setPage('machines')}>运行状态</Button>}
              <Button size="sm" variant="outline" onClick={reload}>重新读取</Button>
            </>} />}
          {usageLimitRecovery && <FeedbackNotice
            variant="bar"
            tone="warning"
            title={`${runModel} 触发限流`}
            description={usageLimitRemainingSeconds !== null && usageLimitRemainingSeconds > 0
              ? `将于 ${usageLimitRemainingSeconds} 秒后自动重试（第 ${usageLimitRecovery.attempt}/${usageLimitRecovery.maxAttempts} 次）`
              : '限流冷却已结束，正在准备或可立即重试。'}
            actions={<>
              <Button size="sm" variant="outline" disabled={!writable || usageLimitActionPending}
                onClick={handleRetryUsageLimitRecoveryNow}>
                {usageLimitActionPending ? '处理中…' : '立即重试'}
              </Button>
              <Button size="sm" variant="outline" disabled={!writable || usageLimitActionPending}
                onClick={handleCancelUsageLimitRecovery}>
                取消自动重试
              </Button>
            </>} />}
          {run && failedRunIssue && <ConversationIssue
            title={failedRunIssue.title}
            reason={failedRunIssue.reason}
            uncertain={failedRunIssue.uncertain}
            actions={failedRunIssue.actionKind !== 'none' && failedRunIssue.actionLabel && <Button
              size="sm"
              variant="outline"
              disabled={recoveringRunId === run.id}
              onClick={() => handleFailedRunAction(run.id)}>
              {recoveringRunId === run.id
                ? (failedRunIssue.actionKind === 'handoff' ? '正在接力…' : '正在重试…')
                : failedRunIssue.actionLabel}
            </Button>} />}
          {sideChat.failure && <ConversationIssue title={sideChat.failure.uncertain ? '侧聊结果待核对' : '无法开启侧聊'}
            reason={sideChat.failure.reason} uncertain={sideChat.failure.uncertain}
            actions={sideChat.failure.uncertain && <Button size="sm" variant="outline" disabled={sideChat.pending}
              onClick={() => void sideChat.check()}>查询回执</Button>} />}
          {sideInputFailure?.owner === panelKey && <ConversationIssue title="无法从当前草稿开启侧聊" reason={sideInputFailure.reason} />}
          {currentCleanup && <ConversationIssue title="侧聊清理结果待核对" reason={currentCleanup.reason} uncertain
            actions={<Button size="sm" variant="outline"
              onClick={() => void settleSideCleanup(currentCleanup.threadId, currentCleanup.commandId, true)}>查询回执</Button>} />}
          {!queueEdit && controlNotice}
        </div>
        {taskScope?.canSend === false ? <div className="my-conversation-column acp-composer-region">
          <p className="my-item-description">{taskScope.reason ?? '当前任务会话仅供阅读。'}</p>
        </div> : <ConversationComposer
          interactive={writable && !read?.error} send={composer} catalog={catalog} model={selectedModel}
          root={root}
          onModelChange={composer.setModel} lockedInstanceId={instanceId}
          running={Boolean(activeRun)} activeRunId={activeRun?.id ?? null}
          canStop={Boolean(activeRun) && descriptor?.actions.cancel.state !== 'unsupported'}
          onStop={() => { if (activeRun) applyControl(stop(activeRun.id)) }}
          onForceStop={activeRun ? () => handleForceStop(activeRun.id) : undefined}
          forceStopping={isForceStopping}
          stopUnconfirmed={Boolean(activeRun?.lifecycle?.stopRequested)}
          canResume={canResume} resuming={isResuming} resumeLabel={resumeLabel}
          onResume={hasHeldQueuedRuns || resumableRunId !== null ? handleResume : undefined}
          queuePaused={Boolean(projection?.queuePaused)}
          canSteer={canSteer && activeRun?.modelSelection.model === selectedModel?.id}
          leadingControls={projection && !archivedThread && <button type="button" className="my-icon-control"
            aria-label="开启侧聊" title="开启侧聊" disabled={!writable || sideChat.pending || sideChat.failure?.uncertain}
            onClick={() => { setSideInputFailure(undefined); void sideChat.open() }}><MessageSquarePlus size={16} aria-hidden="true" /></button>}
          contextControl={projection ? <ConversationActivityControls controller={controller} projection={projection} disabled={!writable}
            compactAvailable={descriptor?.actions.compact.state === 'verified' ||
              (instance?.driverKind === 'codex' || !instance && instanceId === 'codex') && descriptor?.actions.compact.state !== 'unsupported'}
            modelOptions={catalog.models}
            onHandoffAccepted={() => setListRevision(value => value + 1)}
            onProviderSwitched={nextModel => {
              composer.setModel(nextModel)
              setListRevision(value => value + 1)
            }}
            comparisonModels={comparisonModels} onLoadComparisonModels={loadComparisonModels}
            onCompareModels={sideChat.compare} /> : undefined}
          taskSection={code ? codeTask.taskSection : source === 'work' ? {
            label: workTask.linkedTask ? `查看关联任务 · ${workTask.linkedTask.title}` : '当前会话',
            ...(workTask.linkedTask ? { onView: () => workTask.view() } : { actions: [
              { label: '关联已有团队任务…', icon: 'link', onSelect: () => workTask.open('bind'), disabledReason: workTask.linkedReason ?? workTask.bindReason },
              { label: '从此对话创建任务…', icon: 'create', onSelect: () => workTask.open('create'), disabledReason: workTask.linkedReason ?? workTask.createReason },
              ...(workTask.pendingTitle ? [{
                label: `取消待关联 · ${workTask.pendingTitle}`, icon: 'link' as const, onSelect: workTask.clearPending, disabledReason: workTask.bindReason,
              }] : workTask.needsReselection ? [{
                label: '清除原预选', icon: 'link' as const, onSelect: workTask.clearPending,
                description: '团队授权或原任务有变化，需重新选择。',
              }] : []),
            ] }),
          } : undefined}
          placeholder={read?.error ? '当前会话暂不可用，请先处理上方提示' : undefined}
          disabledReason={target && !projection && !read?.error ? '正在读取原会话…' : undefined}
          editorRef={composerRef} previousPrompt={previousPrompt?.text}
          promptHistoryMessages={projection?.messages}
          promptSuggestion={projection && !archivedThread && !read?.error ? deriveNextPromptSuggestion({
            threadId: projection.thread.id,
            runs: projection.runs,
            messages: projection.messages,
            turnItems: projection.turnItems,
            interactionMode: effectiveInteractionMode,
          }) : null}
          onOpenCitation={openAssistantCitation}
          projectPaths={code && projectAvailable && projection ? { cwd: root, threadId: projection.thread.id, task } : undefined}
          artifactBanner={artifactBanner}
          mentionableThreads={(threads ?? []).filter(thread => thread.id !== visibleThreadId)
            .map(({ id, title }) => ({ id, title }))}
          runtimeMode={supportsPersonalModes ? effectiveRuntimeMode : undefined}
          interactionMode={supportsPersonalModes ? effectiveInteractionMode : undefined}
          onRuntimeModeChange={supportsPersonalModes ? (next) => {
            if (projection) applyControl(controller.setRuntimeMode(next))
            else setDraftRuntimeMode(next)
          } : undefined}
          onInteractionModeChange={supportsPersonalModes ? (next) => {
            if (projection) applyControl(controller.setInteractionMode(next))
            else setDraftInteractionMode(next)
          } : undefined}
          modesDisabled={!writable || Boolean(read?.error)}
        />}
    </ChatView>
    {interactive && !read?.error && hostThreadId && projection?.thread.id === hostThreadId &&
      <ConversationRightPanel key={panelKey} panel={panel} narrow={narrowPanel} projectAvailable={projectAvailable} expanded={panelExpanded} onToggleExpand={() => setPanelExpanded((value) => !value)} onHide={hidePanel} onCloseTab={closePanelTab}
        threadTitle={threadId => projection.relations.children.find(item => item.childThreadId === threadId)?.title}>
        {(surface, selected) => surface.kind === 'checkpoints' ? (
          <ConversationCheckpointsPanel
            cwd={root}
            threadId={hostThreadId}
            task={task}
            runs={projection.runs}
            messages={projection.messages}
            checkpoints={projection.checkpoints}
            initialRunId={surface.focusRunId}
            projectAvailable={projectAvailable}
            canRollback={supportsPersonalModes && !activeRun && writable && !read?.error}
            onOpenSurface={panel.open}
            onRollbackRun={(runId, boundary) => {
              setRollbackDialog({ threadId: projection.thread.id, targetRunId: runId, boundary, restoreFiles: false, pending: false })
            }}
          />
        ) : surface.kind === 'artifact' ? <OpenArtifactFrame
          artifactId={surface.artifactId}
          title={surface.title}
          artifactType={surface.artifactType}
          viewUrl={surface.viewUrl}
          threadId={hostThreadId}
          onResolved={(info) => openArtifactSurface(conversationArtifactSurface(info))}
          onPromptFromPage={handlePromptFromArtifact}
        /> : surface.kind === 'thread' ? selected && <SideThreadPane
          root={root} scopeKey={readScopeKey} hostThreadId={hostThreadId}
          threadId={surface.threadId} task={task} interactive={interactive && hasIpc} writable={writable}
          citationRef={sideCitationRef} onOpenCitation={openAssistantCitation}
          onCitationReady={citationRoute?.sideThreadId === surface.threadId ? revealSideCitation : undefined}
          onCite={writable && !archivedThread ? citation => {
            if (currentPanelOwner.current !== panelKey || targetRef.current?.threadId !== hostThreadId ||
              citation.threadId !== surface.threadId || !canInteract()) return
            sideCitationDraftRef.current?.insert(citation)
          } : undefined}
          onOpenParent={() => hidePanel()}
          onMergeBackToParent={writable && !archivedThread && supportsPersonalModes
            ? async ({ sourceThreadId }) => {
              const result = await controller.mergeBackThread({ sourceThreadId })
              if (result.ok) setListRevision(value => value + 1)
              return result
            }
            : undefined}
          onAddToParentDraft={writable ? reference => {
            if (currentPanelOwner.current !== panelKey || targetRef.current?.threadId !== hostThreadId || !canInteract()) return
            composer.addReference({ ...reference, id: JSON.stringify([reference.threadId, reference.messageIds ?? []]) })
            if (narrowPanel) hidePanel(false)
            focusComposer()
          } : undefined}
          renderComposer={({ threadId, controller: childController }) => <ConversationSideThreadComposer root={root}
            scopeKey={sideThreadDraftScope(panelScopeKey, root, hostThreadId)} task={task} threadId={threadId}
            citationDraftRef={sideCitationDraftRef} onOpenCitation={openAssistantCitation}
            controller={childController} catalog={catalog} writable={writable} />} />
          : projectAvailable ? <ConversationProjectSurfaces selected={selected}
            target={{ cwd: root, threadId: hostThreadId, ...(task && { task }) }} surface={surface} open={panel.open}
            activeRun={Boolean(activeRun)} writable={writable && !archivedThread}>{relatedWork}</ConversationProjectSurfaces>
            : relatedWork}
      </ConversationRightPanel>}
    {interactive && !hostThreadId && draftArtifact && (
      <aside className="conversation-right-surface" aria-label="产物画布">
        <OpenArtifactFrame
          artifactId={draftArtifact.artifactId}
          title={draftArtifact.title}
          artifactType={draftArtifact.artifactType}
          viewUrl={draftArtifact.viewUrl}
          showBack
          onBack={() => setDraftArtifact(null)}
          onResolved={(info) => setDraftArtifact(conversationArtifactSurface(info))}
          onPromptFromPage={handlePromptFromArtifact}
        />
      </aside>
    )}
  </div></ChatProjectFileLinks.Provider>
}
