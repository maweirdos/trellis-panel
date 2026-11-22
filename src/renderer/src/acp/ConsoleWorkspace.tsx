import { isConversationRuntimeEvent } from './runtime-events'
import { rememberVisit } from '../my/personal-history'
/** Page-owned ACP profiles and explicitly started project conversations. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Activity, ArrowDown, ArrowRightLeft, ArrowUp, Bot, ChevronRight, Ellipsis, FileText, Folder, GitBranch, ImagePlus, Loader2, Menu, MessageSquare, Plus, RefreshCw, Search, Settings2, ShieldCheck, Square, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useApp } from '../store'
import { api, hasIpc } from '../api'
import { Button, Dropdown, DropdownItem, Modal } from '../my/ui'
import { useMy } from '../my/store'
import { useSidebarWidthStyle } from '../my/layout/SidebarResizeHandle'
import { PageContent } from '../my/layout/PageLayout'
import { projectRootKey } from '../my/navigation'
import { sameRelativeDocumentPath } from '../reader/reader-paths'
import { confirmDialog } from '../components/Dialogs'
import { Select } from '../components/Select'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { ConversationNavigation } from './ConversationNavigation'
import { ConversationWorkspaceHeader } from './ConversationWorkspaceHeader'
import { HistoryBoundary } from './ConversationHistoryBoundary'
import { useComposerAutoSize } from './useComposerAutoSize'
import { WorkspaceInspector, type InspectorTab } from './WorkspaceInspector'
import { ConversationPreviewLayout } from './ConversationPreviewLayout'
import { ConversationPreviewTabs } from './ConversationPreviewTabs'
import { usePiWebPreviewShelf } from './PiWebPreviewShelf'
import { CodePreviewProvider, type OpenCodePreview } from '../components/CodePreviewContext'
import type { PiWebPreviewArtifact } from '../../../shared/pi-web-preview'
import { isDiagnosticConversation, resolveWorkspaceEntry } from './conversation-selection'
import { canSubmitConversation, connectConversationForSend, conversationConnectionStatus, rebindSubmittedReferences, type ConversationReferenceOwner } from './conversation-switching'
import { ConversationArtifactCard } from './ConversationArtifactCard'
import { ConversationDocumentPane } from './ConversationDocumentPane'
import { WorkflowPanel } from './workflow/WorkflowPanel'
import { WorkflowRecovery } from './workflow/WorkflowRecovery'
import { useManagedWorkflow } from './workflow/use-managed-workflow'
import { projectConversationArtifacts, type ConversationArtifact } from './artifacts'
import { ProfileEditor } from './ProfileEditor'
import { RuntimePanel, runtimeHealthLabel } from './RuntimePanel'
import { AgentRoleDetails, type RoleDetailsSection } from './AgentRoleDetails'
import { NewConversationPicker } from './NewConversationPicker'
import { isStarterRole, rolesForDisplay } from './role-presentation'
import { EventRow } from './TranscriptRow'
import { ConversationTranscript, type TranscriptActiveSegment } from './ConversationTranscript'
import { CurrentTurnStatus } from './CurrentTurnStatus'
import { ownsCurrentTurnRequest, projectCurrentTurnActivity, type CurrentTurnIdentity, type CurrentTurnRequest } from './current-turn-activity'
import { ComposerModelPicker } from './ComposerModelPicker'
import { ComposerUsageIndicator } from './ComposerUsageIndicator'
import { ImageAttachments } from './ImageAttachments'
import { useComposerImages } from './useComposerImages'
import { ConnectionNotice, ConnectionRecovery } from './ConnectionNotice'
import { isRecordedTurnFailure } from './conversation-transcript'
import { compareConversationSessions, conversationManagement, useConversationHistory, type ConversationUpdate } from './useConversationHistory'
import { useConversationProjection } from './useConversationProjection'
import { captureTranscriptAnchor, restoreTranscriptAnchor, type TranscriptScrollAnchor } from './transcript-scroll'
import { JiraPickerModal } from './JiraPicker'
import { compileItems, isLiveStatus, mergeEvents, SESSION_LABEL } from './timeline'
import { requirementsDraftText, useKnowledgeRequest } from '../knowledge/request-intake'
import { ConversationKnowledgePanel } from './ConversationKnowledgePanel'
import { KnowledgeReferencePicker } from './KnowledgeReferencePicker'
import { knowledgeBridge, knowledgeError, requireKnowledge } from '../knowledge/bridge'
import { forgetKnowledgeReferences, knowledgeDraftReference, readKnowledgeReferences, useKnowledgeReferenceHandoff, writeKnowledgeReferences, type KnowledgeDraftReference } from './knowledge-reference-handoff'
import { RuntimeHandoffDialog } from './RuntimeHandoffDialog'
import { ConversationHandoff } from './ConversationHandoff'
import { handoffRequest, runtimeHandoffUnavailableReason } from './runtime-handoff-state'
import { useRuntimeHandoffStatus } from './use-runtime-handoff-status'
import { partitionConversationEvents } from './conversation-convenience'
import { readActiveSession, readSessionView, readWorkspaceView, writeWorkspaceView, writeActiveSession, writeSessionView, forgetSessionView, type WorkspaceView, type DraftIntent } from './view-state'
import type { AcpAgentProfile, AcpAgentStatus, AcpMaterialChange, AcpPermissionPayload, AcpSessionRecord, AcpSourceReference, AcpStartupObservation, AcpStateEvent, TimelineEvent } from '../../../shared/types'
import type { AcpHandoffOperation } from '../../../shared/acp-handoff'
import type { AcpImageAttachment } from '../../../shared/acp-images'
import './workspace.css'
import { TaskConversationWorkspace } from '../crux/TaskConversationWorkspace'

const STATUS_COLOR: Record<string, string> = {
  starting: 'text-my-tertiary', ready: 'text-my-tertiary', busy: 'text-my-info-text',
  awaiting_permission: 'text-my-warning-text', cancelling: 'text-my-warning-text',
  error: 'text-my-danger-text', closed: 'text-my-tertiary', disconnected: 'text-my-tertiary', legacy: 'text-my-tertiary'
}
const failureText = (error: unknown): string => error instanceof Error ? error.message : '请求失败，请重试'
const supportsPagedHistory = (): boolean => typeof api?.acpHistoryList === 'function' && typeof api?.acpHistorySession === 'function' && typeof api?.acpHistoryEvents === 'function'

export function AcpConsolePage(props: { compact?: boolean } = {}): JSX.Element {
  const target = useMy((state) => state.taskConversationTarget)
  return target ? <TaskConversationWorkspace key={`${target.sourceKey}:${target.taskId}:${target.session.sessionId}`} target={target} /> : <ProjectConsoleWorkspace {...props} />
}

function ProjectConsoleWorkspace({ compact = false }: { compact?: boolean } = {}): JSX.Element {
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const interactionSignal = useInteractionSignal()
  const sidebarWidthStyle = useSidebarWidthStyle()
  const sidebarCollapsed = useMy((state) => state.sidebarCollapsed)
  const fontSize = useMy((state) => state.fontSize)
  const snapshot = useApp((state) => state.snapshot)
  const pushToast = useApp((state) => state.pushToast)
  const setPage = useApp((state) => state.setPage)
  const showTask = useApp((state) => state.showTask)
  const root = snapshot?.meta.root ?? ''
  const incomingRequest = useKnowledgeRequest((state) => state.draft)
  const incomingKnowledge = useKnowledgeReferenceHandoff((state) => state.pending)
  const [agents, setAgents] = useState<AcpAgentStatus[]>([])
  const [profiles, setProfiles] = useState<AcpAgentProfile[]>([])
  const [sessions, setSessions] = useState<AcpSessionRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const history = useConversationHistory(root, activeId)
  const projection = useConversationProjection(root, activeId)
  const projectionCache = projection.details
  const [events, setEvents] = useState<Record<string, TimelineEvent[]>>({})
  const [view, setView] = useState<WorkspaceView>('agents')
  const [input, setInput] = useState('')
  const [creating, setCreating] = useState(false)
  const [sending, setSending] = useState<Record<string, boolean>>({})
  const [pendingSends, setPendingSends] = useState<Record<string, { requestId: string; turnId?: string; event: TimelineEvent }>>({})
  const [failedSends, setFailedSends] = useState<Record<string, { draft: string; references: AcpSourceReference[]; knowledge: KnowledgeDraftReference[]; images: AcpImageAttachment[]; intent: DraftIntent }>>({})
  const pendingSendsRef = useRef(pendingSends)
  pendingSendsRef.current = pendingSends
  const [turnRequests, setTurnRequests] = useState<Record<string, CurrentTurnRequest>>({})
  const turnRequestsRef = useRef(turnRequests)
  const [terminalTurns, setTerminalTurns] = useState<CurrentTurnIdentity[]>([])
  const [activeTranscriptSegment, setActiveTranscriptSegment] = useState<TranscriptActiveSegment | null>(null)
  const changeTurnRequest = useCallback((id: string, update: (current: CurrentTurnRequest | undefined) => CurrentTurnRequest | undefined): void => {
    const current = turnRequestsRef.current[id]
    const next = update(current)
    if (next === current) return
    const requests = { ...turnRequestsRef.current }
    if (next) requests[id] = next
    else delete requests[id]
    turnRequestsRef.current = requests
    setTurnRequests(requests)
  }, [])
  const [operations, setOperations] = useState<Record<string, string>>({})
  const [feedback, setFeedback] = useState<Record<string, { error: boolean; text: string }>>({})
  const [permissionPending, setPermissionPending] = useState<Record<string, boolean>>({})
  const [permissionErrors, setPermissionErrors] = useState<Record<string, string>>({})
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(false)
  const [editor, setEditor] = useState<AcpAgentProfile | null>(null)
  const [engineSetupOpen, setEngineSetupOpen] = useState(false)
  const [newConversation, setNewConversation] = useState<{ key: string; profileId?: string; taskDir?: string } | null>(null)
  const [newConversationError, setNewConversationError] = useState('')
  const [returnToPicker, setReturnToPicker] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('agent')
  const [inspectorOpen, setInspectorVisible] = useState(false)
  const [inspectedProfileId, setInspectedProfileId] = useState<string | null>(null)
  const [inspectedSessionId, setInspectedSessionId] = useState<string | null>(null)
  const [roleSection, setRoleSection] = useState<RoleDetailsSection>('overview')
  const [inspectedTaskDir, setInspectedTaskDir] = useState<string | null>(null)
  const [libraryQuery, setLibraryQuery] = useState('')
  const [references, setReferences] = useState<AcpSourceReference[]>([])
  const [knowledgeReferences, setKnowledgeReferences] = useState<KnowledgeDraftReference[]>([])
  const [knowledgeReferenceErrors, setKnowledgeReferenceErrors] = useState<Record<string, string>>({})
  const [draftIntent, setDraftIntent] = useState<DraftIntent>('plain')
  const [draftBackup, setDraftBackup] = useState('')
  const [binding, setBinding] = useState(false)
  const [materialChanges, setMaterialChanges] = useState<AcpMaterialChange[]>([])
  const [documentTarget, setDocumentTarget] = useState<{ artifact: ConversationArtifact; sessionId: string; connectionGeneration?: string } | null>(null)
  const [documentExpanded, setDocumentExpanded] = useState(false)
  const [readableReferences, setReadableReferences] = useState<Record<string, AcpSourceReference>>({})
  const [lightweightPlan, setLightweightPlan] = useState(false)
  const [jiraOpen, setJiraOpen] = useState(false)
  const [knowledgePanel, setKnowledgePanel] = useState<{ root: string; sessionId: string } | null>(null)
  const [knowledgePicker, setKnowledgePicker] = useState<{ root: string; sessionId: string; generation: string | undefined } | null>(null)
  const knowledgePickerRef = useRef(knowledgePicker)
  knowledgePickerRef.current = knowledgePicker
  const [projectActivityOwner, setProjectActivityOwner] = useState<{ root: string; sessionId: string } | null>(null)
  const [handoffOwner, setHandoffOwner] = useState<{ root: string; sessionId: string } | null>(null)
  const [taskDir, setTaskDir] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const streamRef = useRef<HTMLDivElement>(null)
  const earlierAnchor = useRef<{ sessionId: string; snapshot: TranscriptScrollAnchor } | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const modelTrigger = useRef<HTMLButtonElement>(null)
  const newComposerFocus = useRef<{ root: string; sessionId: string; generation?: string; signal?: AbortSignal } | null>(null)
  const mainRef = useRef<HTMLElement>(null)
  const navigationRef = useRef<HTMLDivElement>(null)
  const inspectorReturnFocus = useRef<HTMLElement | null>(null)
  const webPreviewReturnFocus = useRef<{ ownerKey: string; target: HTMLElement } | null>(null)
  const documentReturnTab = useRef<InspectorTab | null>(null)
  const draftReferencesRef = useRef<Record<string, AcpSourceReference[]>>({})
  const composing = useRef(false)
  const followRef = useRef(true)
  const draftsRef = useRef<Record<string, string>>({})
  const scope = useMemo(() => ({
    root, live: true, initialized: false, sessionIds: new Set<string>(), states: new Map<string, AcpStateEvent>(), deletedUi: new Set<string>(),
    reloadSerial: 0, createPending: false, entryResolved: false, sends: new Set<string>(), sendControllers: new Map<string, AbortController>(), referenceOwners: new Map<string, ConversationReferenceOwner>(), permissions: new Set<string>(), actions: new Set<string>(), actionTokens: new Map<string, symbol>()
  }), [root])
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const isCurrent = useCallback((): boolean => scope.live && scopeRef.current === scope && (useApp.getState().snapshot?.meta.root ?? '') === root, [root, scope])
  const projectSessions = useMemo(() => {
    const records = new Map<string, AcpSessionRecord>(Object.values(history.knownSessions).map((session) => [session.sessionId, { ...session, events: [] }]))
    if (history.selectedSession) records.set(history.selectedSession.sessionId, { ...history.selectedSession, events: [] })
    for (const session of sessions) {
      const archived = records.get(session.sessionId)
      const latest = archived && (archived.stateRevision ?? 0) > (session.stateRevision ?? 0) ? { ...session, ...archived, events: session.events } : { ...archived, ...session }
      records.set(session.sessionId, latest)
    }
    return [...records.values()].filter((session) => root && !history.deletedIds.has(session.sessionId) && projectRootKey(session.projectRoot) === projectRootKey(root)).map((session) => {
      const status = conversationConnectionStatus(session)
      if (status !== session.status) session = { ...session, status, restorePending: false, pendingPermissions: [] }
      const summary = history.knownSessions[session.sessionId]
      return summary ? { ...session, ...conversationManagement(summary), lastActivityAt: summary.lastActivityAt } : session
    }).sort(compareConversationSessions)
  }, [sessions, history.sessions, history.knownSessions, history.selectedSession, history.deletedIds, root])
  const sessionsRef = useRef(projectSessions)
  sessionsRef.current = projectSessions
  const activeSession = projectSessions.find((session) => session.sessionId === activeId) ?? null
  useEffect(() => {
    if (!isCurrent()) return
    const removed = [...history.deletedIds].filter(id => !scope.deletedUi.has(id))
    for (const id of removed) {
      scope.deletedUi.add(id); scope.sessionIds.delete(id); scope.states.delete(id)
      delete draftsRef.current[id]; delete draftReferencesRef.current[id]
      forgetKnowledgeReferences(root, id)
      forgetSessionView(root, id)
    }
    if (removed.length) {
      setSessions(previous => previous.filter(session => !history.deletedIds.has(session.sessionId)))
      setEvents(previous => { const next = { ...previous }; for (const id of removed) delete next[id]; return next })
    }
    if (!activeId || !history.deletedIds.has(activeId)) return
    const next = projectSessions.find(session => !session.archivedAt && !isDiagnosticConversation(session))
    earlierAnchor.current = null
    setInput(''); setReferences([]); setKnowledgeReferences([]); setDraftIntent('plain'); setDraftBackup('')
    setDocumentTarget(null); setDocumentExpanded(false); setReadableReferences({})
    setKnowledgePanel(null); setProjectActivityOwner(null); setHandoffOwner(null)
    setInspectorVisible(false); setEditor(null); setSidebarOpen(false)
    scope.entryResolved = true
    setActiveId(next?.sessionId ?? null); setView(next ? 'conversation' : 'agents')
    writeActiveSession(root, next?.sessionId ?? null); writeWorkspaceView(root, next ? 'conversation' : 'agents')
  }, [history.deletedIds, activeId, root, scope, isCurrent, projectSessions])
  const handoffStatus = useRuntimeHandoffStatus(root, activeSession, interactive && view === 'conversation', isCurrent)
  const handoffComposerBlocked = handoffStatus.blocked
  const handoffEnded = Boolean(activeSession?.handoff && handoffStatus.operation && ['failed', 'cancelled'].includes(handoffStatus.operation.state))
  const workflow = useManagedWorkflow({ root, taskDir: activeSession?.taskDir, sessionId: activeSession?.sessionId, generation: activeSession?.connectionGeneration, enabled: view === 'conversation' && Boolean(root && activeSession?.taskDir) })
  const managedComposerBlocked = Boolean(workflow.available && activeSession?.taskDir && (workflow.loading || workflow.snapshot?.composer.target === 'managed' || workflow.snapshot?.recoveryRequired))
  const selectedArchiveKnown = !supportsPagedHistory() || !!history.knownSessions[activeId ?? ''] || scope.states.has(activeId ?? '')
  useComposerAutoSize({ textareaRef: composerRef, value: input, active: interactive && view === 'conversation', ownerKey: activeId, status: activeSession?.status, fontSize })
  const composerImages = useComposerImages({ root, sessionId: view === 'conversation' ? activeId ?? undefined : undefined, generation: activeSession?.connectionGeneration, isCurrent })
  const activeSelection = useRef({ id: activeId, generation: activeSession?.connectionGeneration, view })
  activeSelection.current = { id: activeId, generation: activeSession?.connectionGeneration, view }
  const projectionEvents = useMemo(() => {
    const result: Record<string, TimelineEvent[]> = {}
    for (const [sessionId, detail] of projectionCache) {
      result[sessionId] = detail.turnItems.map((entry) => {
        const occurredAt = entry.occurredAt
        const payload = entry.item.kind === 'user-message' || entry.item.kind === 'assistant-message' || entry.item.kind === 'reasoning' || entry.item.kind === 'plan' || entry.item.kind === 'status' || entry.item.kind === 'diagnostic' || entry.item.kind === 'system-marker' || entry.item.kind === 'usage'
          ? { text: entry.item.text }
          : entry.item.kind === 'tool-call' || entry.item.kind === 'permission'
            ? { title: entry.item.title, ...(entry.item.kind === 'permission' ? { pending: entry.item.pending } : {}) }
            : { count: entry.item.count }
        return {
          id: entry.sourceEventId,
          ts: occurredAt,
          source: detail.conversation.sourceEngine,
          sessionId,
          projectRoot: detail.conversation.root,
          kind: entry.item.kind === 'user-message' || entry.item.kind === 'assistant-message'
            ? 'message'
            : entry.item.kind === 'reasoning' ? 'thought' : entry.item.kind === 'tool-call' ? 'tool-call' : entry.item.kind === 'permission' ? 'permission' : entry.item.kind === 'plan' ? 'plan' : entry.item.kind === 'image' ? 'message' : 'session-status',
          text: entry.item.kind === 'user-message' || entry.item.kind === 'assistant-message' || entry.item.kind === 'reasoning' || entry.item.kind === 'plan' || entry.item.kind === 'status' || entry.item.kind === 'diagnostic' || entry.item.kind === 'system-marker' || entry.item.kind === 'usage' ? entry.item.text : entry.item.kind === 'tool-call' || entry.item.kind === 'permission' ? entry.item.title : `${entry.item.count} 张图片`,
          payload: { ...(entry.item.kind === 'user-message' ? { role: 'user' } : entry.item.kind === 'assistant-message' ? { role: 'assistant' } : {}), ...payload },
          turnId: entry.turnId,
        }
      })
    }
    return result
  }, [projectionCache, projection.version])
  useLayoutEffect(() => {
    const intent = newComposerFocus.current
    if (!intent) return
    if (!interactive || intent.signal?.aborted || intent.root !== root || intent.sessionId !== activeId || view !== 'conversation' || inspectorOpen || editor || knowledgePanel || jiraOpen) { newComposerFocus.current = null; return }
    if (!activeSession || newConversation) return
    if (intent.generation && intent.generation !== activeSession.connectionGeneration) { newComposerFocus.current = null; return }
    intent.generation = activeSession.connectionGeneration
    if (activeSession.status !== 'ready' || !composerRef.current) return
    const frame = requestAnimationFrame(() => {
      const field = composerRef.current
      const focused = document.activeElement
      if (newComposerFocus.current !== intent || !isCurrent() || !canInteract() || intent.signal?.aborted || activeSelection.current.id !== intent.sessionId || activeSelection.current.generation !== intent.generation || !field?.isConnected || !field.checkVisibility() || document.querySelector('[role="dialog"]')) return
      newComposerFocus.current = null
      if (focused instanceof HTMLElement && focused !== field && (focused.matches('input,textarea,[contenteditable="true"]') || focused.closest('.acp-inspector,.acp-transcript'))) return
      field.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [root, activeId, activeSession, view, interactive, newConversation, inspectorOpen, editor, knowledgePanel, jiraOpen, isCurrent, canInteract])
  useEffect(() => {
    const cancelFocus = (): void => { newComposerFocus.current = null }
    document.addEventListener('pointerdown', cancelFocus, true)
    document.addEventListener('keydown', cancelFocus, true)
    return () => { document.removeEventListener('pointerdown', cancelFocus, true); document.removeEventListener('keydown', cancelFocus, true) }
  }, [])
  const activeEvents = useMemo(() => {
    const pending = activeSession ? pendingSends[activeSession.sessionId] : undefined
    const cached = activeSession ? projectionEvents[activeSession.sessionId] ?? [] : []
    const recorded = activeSession ? mergeEvents(history.events[activeSession.sessionId] ?? [], cached) : []
    return activeSession ? mergeEvents(recorded, [...(events[activeSession.sessionId] ?? []), ...(pending ? [pending.event] : [])]) : []
  }, [events, history.events, activeSession, pendingSends, projectionEvents])
  const projectedEvents = useMemo(() => activeSession ? partitionConversationEvents(activeEvents, activeSession) : { transcript: [], background: [] }, [activeEvents, activeSession])
  const items = useMemo(() => compileItems(projectedEvents.transcript), [projectedEvents.transcript])
  const revealWebPreview = useCallback((): void => { setInspectorVisible(false) }, [])
  const webPreview = usePiWebPreviewShelf({ root, session: activeSession, events: activeEvents, enabled: interactive && view === 'conversation', onAutoOpen: revealWebPreview })
  const setInspectorOpen = (open: boolean): void => {
    if (open) webPreview.closeWebPreview()
    setInspectorVisible(open)
  }
  const openWebPreview = (artifact: PiWebPreviewArtifact, eventId: string): void => {
    if (document.activeElement instanceof HTMLElement) webPreviewReturnFocus.current = { ownerKey: webPreview.ownerKey, target: document.activeElement }
    webPreview.openWebPreview(artifact, eventId)
  }
  const openCodePreview: OpenCodePreview = (source, language) => {
    if (document.activeElement instanceof HTMLElement) webPreviewReturnFocus.current = { ownerKey: webPreview.ownerKey, target: document.activeElement }
    webPreview.openCodePreview(source, language)
  }
  const closeWebPreview = (): void => {
    const focused = document.activeElement instanceof HTMLElement && document.activeElement.closest('.acp-web-preview-pane')
    webPreview.closeWebPreview()
    if (!focused) return
    const id = activeId, ownerKey = webPreview.ownerKey
    requestAnimationFrame(() => {
      if (!isCurrent() || !canInteract() || activeSelection.current.id !== id || activeSelection.current.view !== 'conversation') return
      const saved = webPreviewReturnFocus.current
      if (saved?.ownerKey === ownerKey && saved.target.isConnected && saved.target.checkVisibility()) saved.target.focus({ preventScroll: true })
      else composerRef.current?.focus({ preventScroll: true })
    })
  }
  const currentTurnRequest = ownsCurrentTurnRequest(turnRequests[activeId ?? ''], activeSession, root) ? turnRequests[activeId ?? ''] : undefined
  const currentRuntimeRetry = activeSession ? scope.states.get(activeSession.sessionId)?.runtimeRetry : undefined
  const currentTurnActivity = useMemo(() => projectCurrentTurnActivity({ root, session: activeSession, events: activeEvents, request: currentTurnRequest, retry: currentRuntimeRetry, terminalTurns, interactive: interactive && view === 'conversation' }), [root, activeSession, activeEvents, currentTurnRequest, currentRuntimeRetry, terminalTurns, interactive, view])
  const segmentOwnsActivity = Boolean(currentTurnActivity && activeSession && activeTranscriptSegment && activeTranscriptSegment.activity === currentTurnActivity
    && ['thinking', 'tool', 'processing', 'knowledge'].includes(currentTurnActivity.phase)
    && ['busy', 'awaiting_permission', 'cancelling'].includes(activeSession.status)
    && activeTranscriptSegment.owner.source === (activeSession.engine === 'pi' ? 'pi' : 'acp')
    && projectRootKey(activeTranscriptSegment.owner.projectRoot) === projectRootKey(root)
    && activeTranscriptSegment.owner.sessionId === activeSession.sessionId
    && activeTranscriptSegment.owner.connectionGeneration === activeSession.connectionGeneration
    && activeTranscriptSegment.owner.turnId === (currentTurnRequest?.turnId ?? activeSession.turnId))
  useLayoutEffect(() => {
    for (const [id, request] of Object.entries(turnRequestsRef.current)) {
      const owner = sessionsRef.current.find((session) => session.sessionId === id) ?? null
      const ended = request.turnId && terminalTurns.some((fact) => fact.turnId === request.turnId && fact.sessionId === request.sessionId && fact.connectionGeneration === request.connectionGeneration && projectRootKey(fact.projectRoot) === projectRootKey(request.projectRoot))
      const disconnected = owner && ['error', 'closed', 'disconnected'].includes(owner.status)
      if (!ownsCurrentTurnRequest(request, owner, root) || ended || disconnected) changeTurnRequest(id, () => undefined)
    }
  }, [root, projectSessions, turnRequests, terminalTurns, changeTurnRequest])
  const recordTurnFact = useCallback((fact: { projectRoot: string; sessionId: string; connectionGeneration?: string; turnId?: string; status?: string }, terminal = false): void => {
    if (terminal && fact.turnId && fact.connectionGeneration) {
      const identity = { projectRoot: fact.projectRoot, sessionId: fact.sessionId, connectionGeneration: fact.connectionGeneration, turnId: fact.turnId }
      setTerminalTurns((previous) => previous.some((item) => projectRootKey(item.projectRoot) === projectRootKey(identity.projectRoot) && item.sessionId === identity.sessionId && item.connectionGeneration === identity.connectionGeneration && item.turnId === identity.turnId) ? previous : [...previous, identity])
    }
    changeTurnRequest(fact.sessionId, (request) => {
      if (!request || projectRootKey(request.projectRoot) !== projectRootKey(fact.projectRoot) || request.connectionGeneration !== fact.connectionGeneration) return request
      if (fact.status && ['error', 'closed', 'disconnected'].includes(fact.status)) return undefined
      if (!fact.turnId || fact.turnId === request.previousTurnId || (request.turnId && fact.turnId !== request.turnId)) return request
      if (!request.turnId && !fact.status) return request
      if (fact.status === 'ready' && request.turnId !== fact.turnId) return request
      if (terminal) return undefined
      // A ready snapshot with a different old ID is not admission of this request.
      if (fact.status && !['busy', 'awaiting_permission', 'cancelling'].includes(fact.status)) return request
      return request.turnId === fact.turnId ? request : { ...request, turnId: fact.turnId }
    })
  }, [changeTurnRequest])
  useEffect(() => { setKnowledgePanel(null); setProjectActivityOwner(null); setHandoffOwner(null) }, [root, activeId, view, interactive])
  useEffect(() => { setKnowledgePicker(null) }, [root, activeId, activeSession?.connectionGeneration, view, interactive])
  const pendingPerm = useMemo(() => {
    const pending: Record<string, AcpPermissionPayload> = {}
    for (const session of projectSessions) {
      if (!isLiveStatus(session.status) || session.historyKind === 'legacy' || session.historyKind === 'transcript') continue
      const livePermissions = session.pendingPermissions ?? scope.states.get(session.sessionId)?.pendingPermissions ?? []
      for (const permission of livePermissions) if (permission.sessionId === session.sessionId && (!permission.connectionGeneration || !session.connectionGeneration || permission.connectionGeneration === session.connectionGeneration) && (!permission.turnId || permission.turnId === session.turnId)) pending[permission.requestId] = permission
    }
    return pending
  }, [projectSessions, scope])
  const boundTask = activeSession?.taskDir ? [...(snapshot?.tasks ?? []), ...(snapshot?.archived ?? [])].find((task) => task.dirName === activeSession.taskDir) ?? null : null
  const inspectorTask = inspectedTaskDir ? [...(snapshot?.tasks ?? []), ...(snapshot?.archived ?? [])].find((task) => task.dirName === inspectedTaskDir) ?? null : boundTask
  const conversationArtifacts = useMemo(() => activeSession?.taskDir ? projectConversationArtifacts({ projectRoot: root, taskDir: activeSession.taskDir, artifacts: boundTask?.artifacts ?? [], changes: materialChanges, events: activeEvents }) : [], [root, activeSession?.taskDir, boundTask, materialChanges, activeEvents])
  const inspectorArtifacts = useMemo(() => inspectorTask ? projectConversationArtifacts({ projectRoot: root, taskDir: inspectorTask.dirName, artifacts: inspectorTask.artifacts, changes: materialChanges, events: activeEvents }) : [], [root, inspectorTask, materialChanges, activeEvents])
  const projectArtifacts = useMemo(() => (snapshot?.tasks ?? []).flatMap((task) => projectConversationArtifacts({ projectRoot: root, taskDir: task.dirName, artifacts: task.artifacts, changes: materialChanges })).slice(0, 60), [root, snapshot?.tasks, materialChanges])

  const reloadSessions = useCallback(async (): Promise<void> => {
    if (!hasIpc || !root || !isCurrent()) return
    // Versioned history is metadata-first. The legacy catalogue is a full
    // transcript snapshot and must remain a compatibility fallback only.
    if (supportsPagedHistory()) {
      await history.refresh()
      if (isCurrent()) history.reloadSelected()
      return
    }
    const serial = ++scope.reloadSerial
    try {
      const response = await api.acpSessions()
      if (!isCurrent() || serial !== scope.reloadSerial) return
      if (!response.ok || !response.sessions) { setLoadError(response.error ?? '会话列表加载失败'); return }
      const records = response.sessions.filter((record) => projectRootKey(record.projectRoot) === projectRootKey(root)).map((record) => {
        const state = scope.states.get(record.sessionId)
        return state && (state.stateRevision ?? 0) >= (record.stateRevision ?? 0) ? { ...record, ...state.session, status: state.status, error: state.error, pendingPermissions: state.pendingPermissions ?? state.session?.pendingPermissions ?? record.pendingPermissions, stateRevision: state.stateRevision ?? state.session?.stateRevision ?? record.stateRevision } : record
      })
      for (const record of records) scope.sessionIds.add(record.sessionId)
      setSessions(records)
      setEvents((previous) => {
        const next: Record<string, TimelineEvent[]> = {}
        for (const record of records) next[record.sessionId] = mergeEvents(record.events ?? [], previous[record.sessionId] ?? [])
        for (const id of scope.sessionIds) if (!next[id] && previous[id]) next[id] = previous[id]
        return next
      })
      if (!scope.entryResolved && (!readActiveSession(root) || records.some((record) => record.sessionId === readActiveSession(root)) || typeof api.acpHistorySession !== 'function')) {
        scope.entryResolved = true
        const entry = resolveWorkspaceEntry(readWorkspaceView(root), readActiveSession(root), records.filter((session) => !session.archivedAt))
        setActiveId(entry.activeId); setView(entry.view)
      } else if (scope.entryResolved) setActiveId((current) => records.some((record) => record.sessionId === current) || (current && (scope.sessionIds.has(current) || current === readActiveSession(root))) ? current : null)
      setLoadError('')
    } catch (error) { if (isCurrent() && serial === scope.reloadSerial) setLoadError(failureText(error)) }
  }, [root, scope, isCurrent, history.refresh, history.reloadSelected])

  useEffect(() => {
    if (!supportsPagedHistory() || !isCurrent() || scope.entryResolved || history.loading) return
    const entry = resolveWorkspaceEntry(readWorkspaceView(root), readActiveSession(root), projectSessions.filter((session) => !session.archivedAt))
    if (readActiveSession(root) && !projectSessions.some((session) => session.sessionId === readActiveSession(root)) && !history.selectionResolved) return
    scope.entryResolved = true
    setActiveId(entry.activeId); setView(entry.view)
  }, [root, scope, isCurrent, history.loading, history.selectionResolved, history.sessions, projectSessions])

  const reloadCatalogue = useCallback(async (): Promise<void> => {
    if (!hasIpc || !root || !isCurrent()) return
    setLoading(true)
    try {
      const results = await Promise.allSettled([api.acpAgents(), api.acpProfiles()])
      if (!isCurrent()) return
      const [runtimeResult, profileResult] = results
      const errors: string[] = []
      if (runtimeResult.status === 'fulfilled' && runtimeResult.value.ok && runtimeResult.value.agents) setAgents(runtimeResult.value.agents)
      else errors.push(runtimeResult.status === 'rejected' ? failureText(runtimeResult.reason) : runtimeResult.value.error ?? 'Runtime 列表加载失败')
      if (profileResult.status === 'fulfilled' && profileResult.value.ok && profileResult.value.profiles) setProfiles(profileResult.value.profiles)
      else errors.push(profileResult.status === 'rejected' ? failureText(profileResult.reason) : profileResult.value.error ?? 'Agent 列表加载失败')
      if (errors.length) setLoadError(errors.join('；'))
    } finally { if (isCurrent()) setLoading(false) }
  }, [root, isCurrent])

  const updateSession = useCallback((record: AcpSessionRecord): void => {
    if (!isCurrent() || projectRootKey(record.projectRoot) !== projectRootKey(root)) return
    scope.sessionIds.add(record.sessionId)
    recordTurnFact(record, record.status === 'ready')
    scope.states.set(record.sessionId, { sessionId: record.sessionId, projectRoot: record.projectRoot, status: record.status, error: record.error, connectionGeneration: record.connectionGeneration, pendingPermissions: record.pendingPermissions, stateRevision: record.stateRevision, session: record })
    setSessions((previous) => previous.some((item) => item.sessionId === record.sessionId) ? previous.map((item) => item.sessionId === record.sessionId ? record : item) : [record, ...previous])
    // Resume/state snapshots are bounded tails and may begin inside an older
    // answer. Modern history owns saved content; onAcpOutput owns live content.
    if (!supportsPagedHistory()) setEvents((previous) => ({ ...previous, [record.sessionId]: mergeEvents(record.events ?? [], previous[record.sessionId] ?? []) }))
  }, [root, scope, isCurrent, recordTurnFact])

  useEffect(() => {
    scope.live = true
    earlierAnchor.current = null
    setSessions([]); setProfiles([]); setAgents([]); setEvents({}); setActiveId(readActiveSession(root)); setInput('')
    scope.initialized = true
    setCreating(false); setSending({}); setOperations({}); setFeedback({}); setPermissionPending({}); setPermissionErrors({}); setLoadError('')
    turnRequestsRef.current = {}; setTurnRequests({}); setTerminalTurns([]); setActiveTranscriptSegment(null)
    setJiraOpen(false); setEditor(null); setEngineSetupOpen(false); setNewConversation(null); setNewConversationError(''); setReturnToPicker(false); setInspectedSessionId(null); setRoleSection('overview'); setInspectorOpen(false); setSidebarOpen(false); setTaskDir('')
    setView('agents'); setReferences([]); setKnowledgeReferences([]); setDraftIntent('plain'); setDraftBackup(''); setInspectedProfileId(null); setInspectedTaskDir(null)
    setMaterialChanges([]); setDocumentTarget(null); setDocumentExpanded(false); setReadableReferences({}); setLightweightPlan(false)
    draftsRef.current = {}; draftReferencesRef.current = {}; composing.current = false; newComposerFocus.current = null
    if (!hasIpc || !root) return () => { scope.live = false }
    const offOut = api.onAcpOutput((event) => {
      if (!isCurrent() || projectRootKey(event.projectRoot) !== projectRootKey(root)) return
      if (!event.sessionId) {
        setEvents((previous) => {
          const next = { ...previous }
          for (const session of sessionsRef.current) {
            if (!isLiveStatus(session.status) || (event.taskDir && event.taskDir !== session.taskDir)) continue
            next[session.sessionId] = mergeEvents(next[session.sessionId] ?? [], [event])
          }
          return next
        })
        return
      }
      const id = event.sessionId
      const knownGeneration = scope.states.get(id)?.connectionGeneration ?? sessionsRef.current.find((session) => session.sessionId === id)?.connectionGeneration
      if (knownGeneration && event.connectionGeneration && knownGeneration !== event.connectionGeneration) return
      if (event.kind === 'message' && event.payload?.role === 'user' && event.turnId && event.connectionGeneration) {
        const pending = pendingSendsRef.current[id]
        if (pending && (!pending.turnId || pending.turnId === event.turnId) && pending.event.connectionGeneration === event.connectionGeneration) {
          pendingSendsRef.current = { ...pendingSendsRef.current }; delete pendingSendsRef.current[id]; setPendingSends(pendingSendsRef.current)
        }
      }
      if (isConversationRuntimeEvent(event)) recordTurnFact({ ...event, sessionId: id }, event.kind === 'turn-done')
      scope.sessionIds.add(id)
      setEvents((previous) => ({ ...previous, [id]: mergeEvents(previous[id] ?? [], [event]) }))
      const observation = event.payload?.observation as AcpStartupObservation | undefined
      if (event.kind === 'session-status' && observation && typeof observation.label === 'string' && typeof observation.atMs === 'number') {
        setSessions((previous) => previous.map((session) => session.sessionId === id && !(session.startup ?? []).some((item) => item.atMs === observation.atMs && item.label === observation.label)
          ? { ...session, startup: [...(session.startup ?? []), observation] } : session))
      }
    })
    const offState = api.onAcpState((state) => {
      if (!isCurrent() || projectRootKey(state.projectRoot) !== projectRootKey(root)) return
      const known = scope.states.get(state.sessionId)
      if (known?.stateRevision !== undefined && state.stateRevision !== undefined && state.stateRevision < known.stateRevision) return
      recordTurnFact(state, state.status === 'ready')
      scope.sessionIds.add(state.sessionId); scope.states.set(state.sessionId, state)
      if (state.session) updateSession(state.session)
      else setSessions((previous) => previous.map((session) => session.sessionId === state.sessionId ? { ...session, status: state.status, error: state.error, connectionGeneration: state.connectionGeneration ?? session.connectionGeneration, turnId: state.turnId ?? session.turnId, pendingPermissions: state.pendingPermissions ?? [], stateRevision: state.stateRevision, historyPersistence: state.historyPersistence ?? session.historyPersistence } : session))
    })
    const offMaterials = api.onMaterialUpdated((event) => {
      if (!isCurrent() || !event.projectRoot || projectRootKey(event.projectRoot) !== projectRootKey(root) || !event.changes) return
      const verified = event.changes.filter((change) => projectRootKey(change.projectRoot) === projectRootKey(root) && change.projectGeneration === event.projectGeneration)
      if (verified.length) {
        setMaterialChanges((previous) => [...previous, ...verified].slice(-200))
        setReadableReferences((previous) => Object.fromEntries(Object.entries(previous).filter(([path, reference]) => !verified.some((change) => change.relativePath === path && (change.revision !== reference.displayedRevision || change.availability !== 'readable')))))
      }
    })
    const offDone = api.onAcpDone((event) => {
      if (!isCurrent()) return
      if (event.projectRoot && projectRootKey(event.projectRoot) !== projectRootKey(root)) return
      const known = scope.states.get(event.sessionId)
      const record = sessionsRef.current.find((session) => session.sessionId === event.sessionId)
      const generation = known?.connectionGeneration ?? record?.connectionGeneration
      if (generation && event.connectionGeneration && generation !== event.connectionGeneration) return
      const request = turnRequestsRef.current[event.sessionId]
      if (request && (!event.projectRoot || event.connectionGeneration !== request.connectionGeneration)) return
      const currentTurnId = request?.turnId ?? known?.turnId ?? known?.session?.turnId ?? record?.turnId
      if (event.projectRoot && event.turnId) recordTurnFact({ projectRoot: event.projectRoot, sessionId: event.sessionId, connectionGeneration: event.connectionGeneration, turnId: event.turnId }, true)
      // A delayed terminal callback belongs to its original turn, even when the
      // next submission is still bridging an old ready metadata snapshot.
      if (request && (!request.turnId || event.turnId !== request.turnId)) return
      if (currentTurnId && event.turnId !== currentTurnId) return
      if (event.session) updateSession(event.session)
      scope.states.set(event.sessionId, { ...known, ...event, projectRoot: root, session: event.session ?? (known?.session ? { ...known.session, status: event.status, error: event.error } : undefined) })
      if (scope.states.size > 64) { const oldest = scope.states.keys().next().value; if (oldest) scope.states.delete(oldest) }
      if (!scope.sessionIds.has(event.sessionId)) return
      setSessions((previous) => previous.map((session) => session.sessionId === event.sessionId ? { ...session, status: event.status, error: event.error } : session))
    })
    void reloadCatalogue(); void reloadSessions()
    return () => { scope.live = false; for (const controller of scope.sendControllers.values()) controller.abort(); offOut(); offState(); offDone(); offMaterials() }
  }, [root, scope, isCurrent, reloadCatalogue, reloadSessions, updateSession, recordTurnFact])

  useLayoutEffect(() => {
    if (!activeId || !isCurrent() || !scope.initialized) return
    const saved = readSessionView(root, activeId)
    setInput(draftsRef.current[activeId] ?? saved.draft)
    setReferences(draftReferencesRef.current[activeId] ?? saved.sourceReferences ?? [])
    setKnowledgeReferences(readKnowledgeReferences(root, activeId))
    setDraftIntent(saved.intent ?? 'plain'); setDraftBackup(saved.draftBackup ?? '')
    followRef.current = saved.follow; setAtBottom(saved.follow)
    const element = streamRef.current
    if (element) element.scrollTop = saved.follow ? element.scrollHeight : saved.scrollTop
    writeActiveSession(root, activeId)
  }, [root, activeId, view, scope, isCurrent])
  useLayoutEffect(() => {
    const element = streamRef.current
    const anchor = earlierAnchor.current
    if (element && anchor && anchor.sessionId === activeId && !history.loadingEarlier) {
      earlierAnchor.current = null
      restoreTranscriptAnchor(element, anchor.snapshot)
      writeSessionView(root, anchor.sessionId, { scrollTop: element.scrollTop, follow: false })
      return
    }
    if (interactive && element && followRef.current) element.scrollTop = element.scrollHeight
  }, [activeEvents, activeSession?.startup, activeId, history.loadingEarlier, interactive, currentTurnActivity?.phase])
  const loadEarlier = (): void => {
    const stream = streamRef.current
    if (!stream || !activeId || history.loadingEarlier) return
    earlierAnchor.current = { sessionId: activeId, snapshot: captureTranscriptAnchor(stream) }
    followRef.current = false; setAtBottom(false)
    void history.loadEarlier()
  }
  const selectSession = (id: string): void => {
    newComposerFocus.current = null
    earlierAnchor.current = null
    const record = projectSessions.find((item) => item.sessionId === id)
    if (record) rememberVisit({ kind: 'agent', target: id, title: record.title || record.profileSnapshot?.name || record.agentName })
    const element = streamRef.current
    if (activeId && element) writeSessionView(root, activeId, { scrollTop: element.scrollTop, follow: followRef.current })
    scope.entryResolved = true
    setActiveId(id); setView('conversation'); setSidebarOpen(false); setInspectorOpen(false); setEditor(null)
    setDocumentTarget(null); setDocumentExpanded(false); setReadableReferences({})
    writeActiveSession(root, id); writeWorkspaceView(root, 'conversation')
  }
  const openWorkflowHistory = (id: string): void => {
    if (!isCurrent() || !canInteract()) return
    selectSession(id)
  }
  const updateConversation = async (id: string, patch: ConversationUpdate) => {
    const requestedSelection = activeSelection.current
    const result = await history.update(id, patch)
    if (!result || !isCurrent() || !canInteract() || interactionSignal?.aborted || activeSelection.current.id !== requestedSelection.id || activeSelection.current.view !== requestedSelection.view) return null
    if (patch.archived === true && requestedSelection.id === id) {
      const next = sessionsRef.current.find((session) => session.sessionId !== id && !session.archivedAt && !isDiagnosticConversation(session))
      if (next) selectSession(next.sessionId)
      else {
        earlierAnchor.current = null
        if (streamRef.current) writeSessionView(root, id, { scrollTop: streamRef.current.scrollTop, follow: followRef.current })
        scope.entryResolved = true
        setActiveId(null); setView('agents'); setSidebarOpen(false); setInspectorOpen(false); setEditor(null)
        setDocumentTarget(null); setDocumentExpanded(false); setReadableReferences({})
        writeActiveSession(root, null); writeWorkspaceView(root, 'agents')
      }
    }
    if (patch.archived === false) history.setArchive('active')
    return result
  }
  const agentTarget = useMy((state) => state.agentTarget)
  const agentSessionTarget = useMy((state) => state.agentSessionTarget)
  const legacyTargetCatalogue = typeof api?.acpHistorySession === 'function' ? null : projectSessions
  useEffect(() => {
    if (!hasIpc || !agentSessionTarget || agentTarget === 'roles' || !interactive || !isCurrent() || (typeof api.acpHistorySession !== 'function' && !scope.entryResolved)) return
    let live = true
    const target = agentSessionTarget
    const current = (): boolean => live && isCurrent() && canInteract() && !interactionSignal?.aborted && useMy.getState().agentSessionTarget === target
    const select = (record: AcpSessionRecord): void => {
      if (!current()) return
      if (record.sessionId !== target || projectRootKey(record.projectRoot) !== projectRootKey(root)) throw Error('来源对话不属于当前项目，未切换到其他会话。')
      updateSession(record)
      selectSession(target)
      useMy.getState().setAgentSessionTarget(null)
    }
    const known = projectSessions.find((item) => item.sessionId === target)
    if (known) select(known)
    else if (typeof api.acpHistorySession === 'function') {
      // An exact source target can predate the first asynchronous catalogue, or
      // belong to a later page. Resolve its actual metadata instead of waiting
      // on mutable entryResolved or guessing a neighbouring conversation.
      void api.acpHistorySession(target).then((result) => {
        if (!current()) return
        if (!result.ok) throw Error(result.error)
        select({ ...result.session, events: [] })
      }).catch((error) => {
        if (!current()) return
        pushToast({ kind: 'error', title: '来源对话暂不可读取', body: failureText(error) })
        useMy.getState().setAgentSessionTarget(null)
      })
    } else {
      pushToast({ kind: 'error', title: '该对话已不可用', body: '可从最近对话中重新选择。' })
      useMy.getState().setAgentSessionTarget(null)
    }
    return () => { live = false }
    // A one-shot exact target; only metadata/history reads, never native startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentTarget, agentSessionTarget, legacyTargetCatalogue, interactive, scope, interactionSignal])
  const changeDraft = (text: string): void => {
    setInput(text)
    if (!activeId) return
    draftsRef.current[activeId] = text; writeSessionView(root, activeId, { draft: text })
  }
  const newSession = useCallback(async (agentId: string, selectedTask?: string, profileId?: string, _selectModel = false): Promise<void> => {
    if (!root || !isCurrent() || scope.createPending) return
    const requestedDraft = useKnowledgeRequest.getState().draft
    scope.createPending = true; setCreating(true); setNewConversationError('')
    try {
      const response = await api.acpSessionNew({ agentId, taskDir: selectedTask, profileId })
      if (!isCurrent()) return
      if (response.ok && response.sessionId) {
        if (canInteract() && !interactionSignal?.aborted) newComposerFocus.current = { root, sessionId: response.sessionId, signal: interactionSignal }
        const request = useKnowledgeRequest.getState().draft
        if (request && request.id === requestedDraft?.id && projectRootKey(request.root) === projectRootKey(root)) {
          const draft = requirementsDraftText(requestedDraft)
          draftsRef.current[response.sessionId] = draft
          writeSessionView(root, response.sessionId, { draft, intent: request.intent === 'discussion' ? 'plain' : 'planning', sourceReferences: [] })
          useKnowledgeRequest.getState().clear(request.id)
        }
        scope.entryResolved = true
        scope.sessionIds.add(response.sessionId); setActiveId(response.sessionId); setView('conversation'); setSidebarOpen(false); setInspectorOpen(false); setNewConversation(null)
        setInspectorTab('agent'); setInspectedSessionId(null); setInspectedProfileId(profileId ?? null); setRoleSection('overview')
        setDocumentTarget(null); setDocumentExpanded(false); setReadableReferences({})
        writeActiveSession(root, response.sessionId); writeWorkspaceView(root, 'conversation')
        await reloadSessions()
        if (isCurrent()) rememberVisit({ kind: 'agent', target: response.sessionId, title: '新对话' })
      } else { setNewConversationError(response.error ?? '创建失败，请检查执行引擎状态。'); pushToast({ kind: 'error', title: '会话创建失败', body: response.error ?? '' }) }
    } catch (error) { if (isCurrent()) { setNewConversationError(failureText(error)); pushToast({ kind: 'error', title: '会话创建失败', body: failureText(error) }) } }
    finally { scope.createPending = false; if (isCurrent()) setCreating(false) }
  }, [root, scope, isCurrent, canInteract, interactionSignal, pushToast, reloadSessions])

  const send = useCallback(async (): Promise<void> => {
    if (!isCurrent() || !canInteract() || managedComposerBlocked || handoffComposerBlocked || !activeSession || !activeId || !selectedArchiveKnown || !canSubmitConversation(activeSession) || scope.actions.has(activeId) || scope.sends.has(activeId) || ownsCurrentTurnRequest(turnRequestsRef.current[activeId], activeSession, root) || composerImages.pending || (!input.trim() && !composerImages.images.length)) return
    const id = activeId, text = input.trim(), submittedDraft = input
    const submittedReferences = references
    const submittedKnowledge = readKnowledgeReferences(root, id)
    const submittedImages = composerImages.images
    const referenceOwner = (source: AcpSourceReference): ConversationReferenceOwner => {
      if (source.targetConnectionGeneration === activeSession.connectionGeneration) return activeSession
      const known = scope.referenceOwners.get(`${id}\0${source.targetConnectionGeneration ?? ''}`)
      if (!known) throw Error('引用的会话连接已变化，无法核对原身份。草稿与原版本引用已保留。')
      return known
    }
    try {
      for (const source of submittedReferences) {
        const owner = referenceOwner(source)
        rebindSubmittedReferences(owner, activeSession, [source])
        // A failed write keeps the original draft generation. Remember only
        // identities actually captured by Send so a later explicit retry can
        // prove the same native target without rewriting that saved draft.
        scope.referenceOwners.set(`${id}\0${owner.connectionGeneration ?? ''}`, { sessionId: owner.sessionId, projectRoot: owner.projectRoot, taskDir: owner.taskDir, backendSessionId: owner.backendSessionId, agentSessionId: owner.agentSessionId, connectionGeneration: owner.connectionGeneration })
      }
    } catch (error) { setFeedback((previous) => ({ ...previous, [id]: { error: true, text: failureText(error) } })); return }
    const request: CurrentTurnRequest = { requestId: crypto.randomUUID(), projectRoot: root, sessionId: id, connectionGeneration: activeSession.connectionGeneration, previousTurnId: activeSession.turnId, phase: 'submitting' }
    const submissionId = `optimistic:${request.requestId}`
    const submissionAt = Date.now()
    const optimisticEvent: TimelineEvent = { id: submissionId, ts: submissionAt, source: activeSession.engine ?? 'acp', sessionId: id, projectRoot: root, kind: 'message', text, payload: { role: 'user', delivery: 'preparing', promptRequestId: request.requestId, ...(submittedImages.length ? { images: submittedImages } : {}) } }
    pendingSendsRef.current = { ...pendingSendsRef.current, [id]: { requestId: request.requestId, event: optimisticEvent } }
    setPendingSends(pendingSendsRef.current)
    setFailedSends(previous => { const next = { ...previous }; delete next[id]; return next })
    draftsRef.current[id] = ''; draftReferencesRef.current[id] = []
    writeSessionView(root, id, { draft: '', sourceReferences: [], intent: 'plain' })
    writeKnowledgeReferences(root, id, [])
    composerImages.removeSubmitted(id, submittedImages)
    if (activeSelection.current.id === id) { setInput(''); setReferences([]); setKnowledgeReferences([]); setDraftIntent('plain') }
    const controller = new AbortController()
    scope.sendControllers.set(id, controller)
    const valid = (): boolean => isCurrent() && !controller.signal.aborted && scope.sendControllers.get(id) === controller
    const clearRequest = (): void => changeTurnRequest(id, (current) => current?.requestId === request.requestId ? undefined : current)
    // Explicit submission returns to the current turn. Later passive updates
    // still obey onScroll if the reader chooses to leave the bottom again.
    earlierAnchor.current = null; followRef.current = true; setAtBottom(true)
    writeSessionView(root, id, { follow: true })
    scope.sends.add(id); setSending((previous) => ({ ...previous, [id]: true })); setFeedback((previous) => ({ ...previous, [id]: { error: false, text: '正在提交指令…' } }))
    setOperations((previous) => ({ ...previous, [id]: 'prepare-send' }))
    try {
      // Preparation owns one composer status until a verified live generation
      // hands off to the current turn. Selection never enters this path.
      let target = await connectConversationForSend(activeSession, controller.signal, () => {
        const record = sessionsRef.current.find((session) => session.sessionId === id)
        const state = scope.states.get(id)
        return record && state ? { ...record, ...state.session, status: state.status, error: state.error, connectionGeneration: state.connectionGeneration ?? record.connectionGeneration, turnId: state.turnId ?? record.turnId, stateRevision: state.stateRevision ?? record.stateRevision } : record
      })
      if (!valid()) return
      if (submittedReferences.some((source) => source.targetConnectionGeneration !== target.connectionGeneration)) {
        // Rebinding requires fresh native identity, not inherited fields from a
        // partial status event or an old cached ready record.
        if (typeof api.acpHistorySession !== 'function') throw Error('无法核对原会话身份。草稿与原版本引用已保留。')
        const fresh = await api.acpHistorySession(id)
        if (!valid()) return
        if (!fresh.ok) throw Error(fresh.error)
        if (fresh.session.connectionGeneration !== target.connectionGeneration || fresh.session.status !== 'ready' || fresh.session.cleanupRequired || fresh.session.archivedAt) throw Error('会话连接或状态已变化。草稿与原版本引用已保留。')
        target = { ...fresh.session, events: [] }
      }
      const deliveryReferences = submittedReferences.flatMap((source) => rebindSubmittedReferences(referenceOwner(source), target, [source]))
      const observed = scope.states.get(id)
      const observedIsLatest = observed && (observed.stateRevision === undefined || target.stateRevision === undefined || observed.stateRevision >= target.stateRevision)
      if (observedIsLatest && (observed.connectionGeneration !== target.connectionGeneration || observed.status !== 'ready')) throw Error('会话连接或状态已变化，草稿已保留。')
      updateSession(target)
      request.connectionGeneration = target.connectionGeneration
      request.previousTurnId = target.turnId
      changeTurnRequest(id, () => request)
      setOperations((previous) => previous[id] === 'prepare-send' ? { ...previous, [id]: '' } : previous)
      // View/Settings changes do not revoke an explicit Send. Root, connection,
      // End and Cancel still fence the actual dispatch; main checks admission.
      if (!valid()) return
      const latest = scope.states.get(id)
      if (latest && (latest.connectionGeneration !== request.connectionGeneration || latest.status !== 'ready')) throw Error('会话状态已变化，尚未发送。草稿已保留。')
      if (submittedImages.length && target.capabilities?.promptCapabilities?.image !== true) throw Error('当前执行引擎未声明支持图片输入。草稿与图片已保留。')
      let knowledgeOptions: Pick<import('../../../shared/types').AcpPromptOptions, 'knowledgeReferences' | 'expectedProjectGeneration' | 'expectedKnowledgeScopeToken'> = {}
      if (submittedKnowledge.length) {
        const capability = (api as typeof api & { acpKnowledgeReferenceCapability?: () => Promise<{ supported: boolean }> }).acpKnowledgeReferenceCapability
        if (typeof capability !== 'function' || !(await capability()).supported) throw Error('知识引用发送能力尚未加载，请完整退出并重新打开应用。草稿和引用已保留。')
        if (!valid()) return
        const selectionToken = submittedKnowledge[0].selectionToken, projectGeneration = submittedKnowledge[0].projectGeneration
        if (!selectionToken || projectGeneration === undefined || submittedKnowledge.some((item) => item.selectionToken !== selectionToken || item.projectGeneration !== projectGeneration || item.targetSessionId !== id || item.connectionGeneration !== target.connectionGeneration || (item.kind !== 'project' && item.sessionId !== id))) throw Error('知识范围或会话连接已变化，请重新选择来源。草稿已保留。')
        knowledgeOptions = { expectedProjectGeneration: projectGeneration, expectedKnowledgeScopeToken: selectionToken, knowledgeReferences: submittedKnowledge.map((item) => item.kind === 'project' ? { kind: 'project', relativePath: item.relativePath, displayedRevision: item.displayedRevision } : { kind: 'source', sourceId: item.id, contentHash: item.contentHash }) }
      }
      if (!valid()) return
      const response = await api.acpSessionPrompt(id, text, { expectedConnectionGeneration: target.connectionGeneration, sourceReferences: deliveryReferences, images: submittedImages, ...knowledgeOptions })
      if (!isCurrent()) return
      const generation = scope.states.get(id)?.connectionGeneration ?? sessionsRef.current.find((session) => session.sessionId === id)?.connectionGeneration
      if (generation !== request.connectionGeneration) { clearRequest(); return }
      if (response.ok) {
        const pending = pendingSendsRef.current[id]
        if (pending?.requestId === request.requestId) {
          pendingSendsRef.current = { ...pendingSendsRef.current, [id]: { requestId: request.requestId, turnId: response.turnId, event: { ...pending.event, turnId: response.turnId, connectionGeneration: request.connectionGeneration, payload: { ...pending.event.payload, delivery: 'sent' } } } }
          setPendingSends(pendingSendsRef.current)
        }
        changeTurnRequest(id, (current) => {
          if (current?.requestId !== request.requestId) return current
          const turnId = current.turnId ?? response.turnId
          return turnId ? { ...current, phase: 'accepted', turnId } : undefined
        })
        composerImages.consume(id, submittedImages)
        setFeedback((previous) => ({ ...previous, [id]: { error: false, text: '' } }))
      } else {
        clearRequest()
        const restoreExact = draftsRef.current[id] === '' && JSON.stringify(readKnowledgeReferences(root, id)) === '[]' && (draftReferencesRef.current[id] === undefined || draftReferencesRef.current[id].length === 0)
        if (restoreExact) {
          draftsRef.current[id] = submittedDraft; draftReferencesRef.current[id] = submittedReferences
          writeSessionView(root, id, { draft: submittedDraft, sourceReferences: submittedReferences, intent: draftIntent })
          writeKnowledgeReferences(root, id, submittedKnowledge)
          if (activeSelection.current.id === id) { setInput(submittedDraft); setReferences(submittedReferences); setKnowledgeReferences(submittedKnowledge); setDraftIntent(draftIntent) }
          composerImages.replace(id, submittedImages)
        } else setFailedSends(previous => ({ ...previous, [id]: { draft: submittedDraft, references: submittedReferences, knowledge: submittedKnowledge, images: submittedImages, intent: draftIntent } }))
        pendingSendsRef.current = { ...pendingSendsRef.current }; delete pendingSendsRef.current[id]; setPendingSends(pendingSendsRef.current)
        setFeedback((previous) => ({ ...previous, [id]: { error: true, text: response.reason === 'SOURCE_CHANGED' ? `引用文件已变化，尚未发送。${restoreExact ? '草稿与原版本引用已恢复。' : '新草稿已保留，未发送内容可恢复。'}${response.sources?.map((source) => ` ${source.relativePath}`).join('') ?? ''}` : `${response.error ?? '发送被拒绝。'}${restoreExact ? '原草稿已恢复。' : '新草稿已保留，未发送内容可恢复。'}` } }))
      }
    } catch (error) {
      if (isCurrent()) {
        clearRequest()
        if (controller.signal.aborted) setFeedback((previous) => ({ ...previous, [id]: { error: true, text: '发送已中止，当前状态未知。已保留待确认消息，不会自动重发。' } }))
        else {
          const restoreExact = draftsRef.current[id] === '' && JSON.stringify(readKnowledgeReferences(root, id)) === '[]' && (draftReferencesRef.current[id] === undefined || draftReferencesRef.current[id].length === 0)
          if (restoreExact) {
            draftsRef.current[id] = submittedDraft; draftReferencesRef.current[id] = submittedReferences
            writeSessionView(root, id, { draft: submittedDraft, sourceReferences: submittedReferences, intent: draftIntent })
            writeKnowledgeReferences(root, id, submittedKnowledge)
            if (activeSelection.current.id === id) { setInput(submittedDraft); setReferences(submittedReferences); setKnowledgeReferences(submittedKnowledge); setDraftIntent(draftIntent) }
            composerImages.replace(id, submittedImages)
          } else setFailedSends(previous => ({ ...previous, [id]: { draft: submittedDraft, references: submittedReferences, knowledge: submittedKnowledge, images: submittedImages, intent: draftIntent } }))
          pendingSendsRef.current = { ...pendingSendsRef.current }; delete pendingSendsRef.current[id]; setPendingSends(pendingSendsRef.current)
          setFeedback((previous) => ({ ...previous, [id]: { error: true, text: `${failureText(error)}${restoreExact ? '原草稿已恢复。' : '新草稿已保留，未发送内容可恢复。'}` } }))
        }
      }
    }
    finally {
      if (scope.sendControllers.get(id) === controller) scope.sendControllers.delete(id)
      scope.sends.delete(id)
      if (isCurrent()) { setSending((previous) => ({ ...previous, [id]: false })); setOperations((previous) => previous[id] === 'prepare-send' ? { ...previous, [id]: '' } : previous) }
    }
  }, [input, activeId, activeSession, selectedArchiveKnown, references, knowledgeReferences, root, scope, isCurrent, canInteract, composerImages, changeTurnRequest, managedComposerBlocked, handoffComposerBlocked, updateSession])

  const sessionAction = async (action: 'cancel' | 'kill' | 'resume'): Promise<void> => {
    if (!activeSession || !isCurrent() || !canInteract() || (scope.actions.has(activeSession.sessionId) && (action !== 'kill' || scope.actionTokens.get(activeSession.sessionId)?.description === 'kill'))) return
    if (action === 'resume' && (handoffComposerBlocked || activeSession.archivedAt || !selectedArchiveKnown)) return
    const id = activeSession.sessionId
    const operationToken = Symbol(action)
    scope.actionTokens.set(id, operationToken)
    if (action !== 'resume') { scope.sendControllers.get(id)?.abort(); changeTurnRequest(id, () => undefined) }
    scope.actions.add(id); setOperations((previous) => ({ ...previous, [id]: action }))
    setFeedback((previous) => ({ ...previous, [id]: { error: false, text: action === 'resume' ? '正在连接原会话…' : '正在请求停止…' } }))
    try {
      const response = await (action === 'cancel' ? api.acpSessionCancel(id) : action === 'kill' ? api.acpSessionKill(id) : api.acpSessionResume(id))
      if (!isCurrent() || scope.actionTokens.get(id) !== operationToken) return
      setFeedback((previous) => ({ ...previous, [id]: { error: !response.ok, text: response.ok ? action === 'resume' ? '' : action === 'kill' ? '会话已停止。' : '正在中止本轮…' : response.error ?? '操作失败，可以重试。' } }))
      if (response.ok) await reloadSessions()
    } catch (error) { if (isCurrent() && scope.actionTokens.get(id) === operationToken) setFeedback((previous) => ({ ...previous, [id]: { error: true, text: failureText(error) } })) }
    finally { if (scope.actionTokens.get(id) === operationToken) { scope.actionTokens.delete(id); scope.actions.delete(id); if (isCurrent()) setOperations((previous) => ({ ...previous, [id]: '' })) } }
  }

  const acquireConfiguration = (): (() => void) | undefined => {
    if (!hasIpc || !activeSession || !selectedArchiveKnown || !isCurrent() || !canInteract() || managedComposerBlocked || handoffComposerBlocked) return undefined
    const id = activeSession.sessionId
    const state = scope.states.get(id)
    const owner = state?.session ?? sessionsRef.current.find((session) => session.sessionId === id)
    if (!owner || (state?.status ?? owner.status) !== 'ready' || !owner.connectionGeneration || (state?.connectionGeneration ?? owner.connectionGeneration) !== activeSession.connectionGeneration || owner.restorePending || owner.archivedAt || owner.cleanupRequired || scope.actions.has(id) || scope.sends.has(id) || ownsCurrentTurnRequest(turnRequestsRef.current[id], owner, root)) return undefined
    const token = Symbol('configure')
    scope.actions.add(id); scope.actionTokens.set(id, token)
    setOperations((previous) => ({ ...previous, [id]: 'configure' }))
    return () => {
      if (scope.actionTokens.get(id) !== token) return
      scope.actions.delete(id); scope.actionTokens.delete(id)
      if (isCurrent()) setOperations((previous) => ({ ...previous, [id]: '' }))
    }
  }

  const recoverModel = async (modelId: string): Promise<boolean> => {
    if (!activeSession?.connectionGeneration || !selectedArchiveKnown || activeSession.archivedAt || !isCurrent() || !canInteract() || scope.actions.has(activeSession.sessionId)) return false
    const id = activeSession.sessionId, operationToken = Symbol('recover-model')
    scope.actions.add(id); scope.actionTokens.set(id, operationToken)
    setOperations((previous) => ({ ...previous, [id]: 'recover-model' })); setFeedback((previous) => ({ ...previous, [id]: { error: false, text: '' } }))
    try {
      const response = await api.acpSessionRecoverModel(id, { modelId, expectedConnectionGeneration: activeSession.connectionGeneration })
      if (!isCurrent() || scope.actionTokens.get(id) !== operationToken) return false
      if (response.session) updateSession(response.session)
      setFeedback((previous) => ({ ...previous, [id]: { error: !response.ok, text: response.ok ? '' : response.error ?? '执行引擎未确认恢复，请查看连接详情。' } }))
      if (response.ok) await reloadSessions()
      return response.ok && response.modelConfirmed
    } catch (error) { if (isCurrent() && scope.actionTokens.get(id) === operationToken) setFeedback((previous) => ({ ...previous, [id]: { error: true, text: failureText(error) } })) }
    finally { if (scope.actionTokens.get(id) === operationToken) { scope.actionTokens.delete(id); scope.actions.delete(id); if (isCurrent()) setOperations((previous) => ({ ...previous, [id]: '' })) } }
    return false
  }

  const retryHistory = async (): Promise<void> => {
    if (!activeSession || !isCurrent() || !canInteract()) return
    const id = activeSession.sessionId
    try {
      const result = await api.acpHistoryRetry(id)
      if (!isCurrent()) return
      if (result.ok) { updateSession({ ...activeSession, historyPersistence: result.historyPersistence }); setFeedback((previous) => ({ ...previous, [id]: { error: false, text: '' } })); history.reloadSelected() }
      else setFeedback((previous) => ({ ...previous, [id]: { error: true, text: result.error } }))
    } catch (error) { if (isCurrent()) setFeedback((previous) => ({ ...previous, [id]: { error: true, text: failureText(error) } })) }
  }

  const respondPerm = useCallback(async (requestId: string, optionId: string): Promise<void> => {
    const permission = pendingPerm[requestId]
    if (!isCurrent() || !permission || scope.permissions.has(requestId) || !permission.options.some((option) => option.optionId === optionId)) return
    scope.permissions.add(requestId); setPermissionPending((previous) => ({ ...previous, [requestId]: true })); setPermissionErrors((previous) => ({ ...previous, [requestId]: '' }))
    try {
      const response = await api.acpPermissionRespond(requestId, optionId)
      if (isCurrent() && !response.ok) setPermissionErrors((previous) => ({ ...previous, [requestId]: response.error ?? '响应失败，请重新选择。' }))
      if (isCurrent() && response.ok) await reloadSessions()
    } catch (error) { if (isCurrent()) setPermissionErrors((previous) => ({ ...previous, [requestId]: failureText(error) })) }
    finally { scope.permissions.delete(requestId); if (isCurrent()) setPermissionPending((previous) => ({ ...previous, [requestId]: false })) }
  }, [pendingPerm, scope, isCurrent, reloadSessions])

  const showView = (next: WorkspaceView): void => {
    if (next === 'history') next = 'conversation'
    useMy.getState().requestAgentView(null)
    scope.entryResolved = true; setView(next); writeWorkspaceView(root, next); setSidebarOpen(false)
    if (next !== 'conversation') setInspectorOpen(false)
  }
  useEffect(() => {
    if (!agentTarget || !interactive || !isCurrent() || !canInteract()) return
    const next = agentTarget === 'roles' ? 'agents' : 'conversation'
    // Explicit navigation wins both delayed entry restoration and an older
    // exact-session request retained behind Settings.
    if (agentTarget === 'roles') useMy.getState().setAgentSessionTarget(null)
    scope.entryResolved = true
    setView(next); writeWorkspaceView(root, next); setSidebarOpen(false); setInspectorOpen(false)
    useMy.getState().requestAgentView(null)
  }, [agentTarget, interactive, root, scope, isCurrent, canInteract])
  const returnInspectorFocus = (): void => { requestAnimationFrame(() => { if (!canInteract()) return; const target = inspectorReturnFocus.current; if (target?.isConnected && target.getClientRects().length > 0) target.focus(); else composerRef.current?.focus() }) }
  const closeInspector = (): void => { setInspectorOpen(false); setDocumentTarget(null); setDocumentExpanded(false); returnInspectorFocus() }
  const closeDocument = (): void => {
    setDocumentTarget(null); setDocumentExpanded(false)
    if (documentReturnTab.current) { setInspectorTab(documentReturnTab.current); setInspectorOpen(true); returnInspectorFocus() }
    else closeInspector()
  }
  const openAgent = (profileId?: string, section: RoleDetailsSection = 'overview'): void => {
    inspectorReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setInspectedSessionId(profileId ? null : activeSession?.sessionId ?? null); setRoleSection(section)
    setInspectedProfileId(profileId ?? activeSession?.profileSnapshot?.id ?? null); setInspectorTab('agent'); setInspectorOpen(true); setEditor(null)
  }
  const openNewConversation = (profileId?: string): void => {
    if (!canInteract() || !isCurrent()) return
    setNewConversationError(''); setNewConversation({ key: crypto.randomUUID(), profileId, taskDir: (activeSession?.taskDir ?? taskDir) || undefined }); setSidebarOpen(false)
  }
  const openTask = (requestedTaskDir?: string): void => {
    inspectorReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setInspectorTab('task'); setInspectorOpen(true); setInspectedTaskDir(requestedTaskDir ?? activeSession?.taskDir ?? null); setTaskDir(activeSession?.taskDir ?? '')
  }
  const openDocument = (artifact: ConversationArtifact): void => {
    if (!activeSession || !isCurrent() || projectRootKey(artifact.projectRoot) !== projectRootKey(root)) return
    inspectorReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    documentReturnTab.current = inspectorOpen && inspectorTab !== 'document' ? inspectorTab : null
    setDocumentTarget({ artifact, sessionId: activeSession.sessionId, connectionGeneration: activeSession.connectionGeneration })
    setInspectorTab('document'); setInspectorOpen(true)
  }
  const recordDisplayedReference = useCallback((reference: AcpSourceReference | null): void => {
    if (!documentTarget || !isCurrent()) return
    const path = documentTarget.artifact.relativePath
    setReadableReferences((previous) => {
      if (reference === null) {
        if (!previous[path]) return previous
        const next = { ...previous }; delete next[path]; return next
      }
      if (reference.targetSessionId !== documentTarget.sessionId || projectRootKey(reference.projectRoot) !== projectRootKey(root)) return previous
      if (JSON.stringify(previous[path]) === JSON.stringify(reference)) return previous
      return { ...previous, [path]: reference }
    })
  }, [documentTarget, root, isCurrent])
  const focusComposer = (): void => {
    if (!canInteract()) return
    setDocumentExpanded(false)
    if (window.innerWidth < 1280) setInspectorOpen(false)
    requestAnimationFrame(() => { if (canInteract()) composerRef.current?.focus() })
  }
  const installDraft = async (text: string, sourceReferences: AcpSourceReference[], intent: DraftIntent): Promise<void> => {
    if (!activeSession || !isCurrent()) return
    const id = activeSession.sessionId, generation = activeSession.connectionGeneration
    const previous = draftsRef.current[id] ?? readSessionView(root, id).draft
    const mustReplace = Boolean(previous.trim()) && intent !== draftIntent && (intent === 'planning' || intent === 'implementation' || draftIntent === 'planning' || draftIntent === 'implementation')
    if (mustReplace) {
      const confirmed = await confirmDialog({ title: intent === 'implementation' ? '切换为实施授权草稿？' : intent === 'planning' ? '切换为仅规划草稿？' : intent === 'plain' ? '切换为普通讨论草稿？' : '切换为文档反馈草稿？', message: '本次意图与现有草稿分开。原草稿及引用会保留，可随时恢复。此操作不会发送消息。', confirmText: '保留原稿并切换' }, interactionSignal)
      if (!confirmed) return
    }
    if (!canInteract() || interactionSignal?.aborted || !isCurrent() || readActiveSession(root) !== id || sessionsRef.current.find((session) => session.sessionId === id)?.connectionGeneration !== generation) return
    const backup = mustReplace ? { draftBackup: previous, backupReferences: references, backupIntent: draftIntent } : {}
    draftsRef.current[id] = text; draftReferencesRef.current[id] = sourceReferences
    writeSessionView(root, id, { draft: text, sourceReferences, intent, ...backup })
    setInput(text); setReferences(sourceReferences); setDraftIntent(intent)
    if (mustReplace) setDraftBackup(previous)
    focusComposer()
  }
  const addKnowledgeReference = async (reference: KnowledgeDraftReference, shouldCommit: () => boolean = () => true, stagedScope?: { selectionToken: string; projectGeneration: number }): Promise<boolean> => {
    if (!activeSession || !isCurrent() || !canInteract() || activeSelection.current.id !== activeSession.sessionId) return false
    const sessionId = activeSession.sessionId, generation = activeSession.connectionGeneration
    if (!generation) { setKnowledgeReferenceErrors((old) => ({ ...old, [sessionId]: '请先连接当前会话，再加入知识来源。' })); return false }
    const previous = readKnowledgeReferences(root, activeSession.sessionId)
    if (previous.length >= 4 && !previous.some((item) => item.id === reference.id)) {
      setKnowledgeReferenceErrors((old) => ({ ...old, [activeSession.sessionId]: '知识引用最多保留 4 项，请先移除不需要的来源。' }))
      return false
    }
    const bridge = knowledgeBridge(['context'])
    if (!bridge) { setKnowledgeReferenceErrors((old) => ({ ...old, [sessionId]: '知识引用校验服务未加载，请完整退出并重新打开应用。' })); return false }
    try {
      if (stagedScope) {
        const stagedContext = requireKnowledge(await bridge.context({ expectedRoot: root }))
        if (!isCurrent() || !canInteract() || !shouldCommit() || activeSelection.current.id !== sessionId || activeSelection.current.generation !== generation) return false
        if (stagedContext.selectionToken !== stagedScope.selectionToken || stagedContext.scope.projectGeneration !== stagedScope.projectGeneration) throw Error('知识页的选择范围已变化，请重新选择来源。')
      }
      const context = requireKnowledge(await bridge.context({ expectedRoot: root, sessionId }))
      if (!isCurrent() || !canInteract() || !shouldCommit() || activeSelection.current.id !== sessionId || activeSelection.current.generation !== generation) return false
      if (!context.selectionToken || context.scope.sessionId !== sessionId) throw Error('知识范围已变化，请重新检索并选择来源。')
      let selected = reference
      if (reference.kind !== 'project' && reference.sessionId !== sessionId) {
        const rebind = knowledgeBridge(['rebindSource'])
        if (!rebind || !generation) throw Error('知识来源交接服务未加载或会话尚未连接，请重试。')
        const rebound = requireKnowledge(await rebind.rebindSource({ expectedRoot: root, sessionId, sourceId: reference.id, contentHash: reference.contentHash, expectedConnectionGeneration: generation, expectedProjectGeneration: context.scope.projectGeneration }))
        if (!isCurrent() || !canInteract() || !shouldCommit() || activeSelection.current.id !== sessionId || activeSelection.current.generation !== generation) return false
        if (rebound.selectionToken !== context.selectionToken || rebound.source.sessionId !== sessionId || rebound.source.contentHash !== reference.contentHash) throw Error('知识来源或会话范围已变化，请重新选择。')
        selected = knowledgeDraftReference(rebound.source)
      }
      if (selected.kind !== 'project' && context.scope.revision !== selected.scopeRevision) throw Error('知识范围已变化，请重新检索并选择来源。')
      if (stagedScope) {
        const currentStaged = requireKnowledge(await bridge.context({ expectedRoot: root }))
        if (!isCurrent() || !canInteract() || !shouldCommit() || activeSelection.current.id !== sessionId || activeSelection.current.generation !== generation) return false
        if (currentStaged.selectionToken !== stagedScope.selectionToken || currentStaged.scope.projectGeneration !== stagedScope.projectGeneration) throw Error('知识页的选择范围已变化，请重新选择来源。')
      }
      const current = readKnowledgeReferences(root, sessionId)
      if (current.some((item) => item.selectionToken !== context.selectionToken || item.projectGeneration !== context.scope.projectGeneration || item.targetSessionId !== sessionId || item.connectionGeneration !== generation)) throw Error('已有知识引用的范围或会话连接已变化，请移除后重新选择。')
      if (current.length >= 4 && !current.some((item) => item.id === selected.id)) throw Error('知识引用最多保留 4 项，请先移除不需要的来源。')
      const next = [...current.filter((item) => item.id !== selected.id), { ...selected, selectionToken: context.selectionToken, projectGeneration: context.scope.projectGeneration, targetSessionId: sessionId, connectionGeneration: generation }]
      writeKnowledgeReferences(root, sessionId, next); setKnowledgeReferences(next)
      setKnowledgeReferenceErrors((old) => ({ ...old, [sessionId]: '' }))
      return true
    } catch (error) { if (isCurrent()) setKnowledgeReferenceErrors((old) => ({ ...old, [sessionId]: knowledgeError(error, '知识引用校验') })); return false }
  }
  const quoteDocument = (reference: AcpSourceReference): void => {
    if (!activeSession || !isCurrent() || reference.targetSessionId !== activeSession.sessionId || projectRootKey(reference.projectRoot) !== projectRootKey(root) || reference.targetConnectionGeneration !== activeSession.connectionGeneration || reference.taskDir !== activeSession.taskDir) {
      const sameSession = activeSession && reference.targetSessionId === activeSession.sessionId && projectRootKey(reference.projectRoot) === projectRootKey(root)
      if (sameSession && reference.taskDir === activeSession.taskDir && reference.targetConnectionGeneration !== activeSession.connectionGeneration) {
        pushToast({ kind: 'error', title: '会话连接已更新', body: '旧草稿与引用已保留。请在文档中更新引用目标，再引用到当前会话草稿。' })
        setInspectorTab('document'); setInspectorOpen(true)
      } else {
        pushToast({ kind: 'error', title: '先明确关联文档所属任务', body: '当前草稿的会话或任务与文档来源不同。请先在任务详情中关联正确任务，再引用。' })
        if (sameSession) { setTaskDir(reference.taskDir); setInspectedTaskDir(reference.taskDir); setInspectorTab('task'); setInspectorOpen(true) }
      }
      return
    }
    const sourceText = `关于 ${reference.relativePath}${reference.sectionAnchor ? `（${reference.sectionAnchor}）` : ''}：${reference.quote ? `\n> ${reference.quote.replace(/\n/g, '\n> ')}\n` : '\n'}请反馈或修改：`
    const replace = draftIntent === 'planning' || draftIntent === 'implementation'
    const nextText = replace || !input.trim() ? sourceText : `${input}\n\n${sourceText}`
    const nextReferences = [...(replace ? [] : references).filter((source) => source.relativePath !== reference.relativePath), reference]
    void installDraft(nextText, nextReferences, 'feedback')
  }
  const preparePlanning = (): void => {
    if (!activeSession?.taskDir) { openTask(); return }
    const sources = Object.values(readableReferences).filter((source) => source.taskDir === activeSession.taskDir && source.targetSessionId === activeSession.sessionId && source.targetConnectionGeneration === activeSession.connectionGeneration)
    void installDraft(`请继续完善任务 ${activeSession.taskDir} 的设计和实施计划，暂不开始实现。请根据当前需求澄清范围和风险，保留 Trellis 工作流中的规划审查步骤。`, sources, 'planning')
  }
  const reviewedMaterials = Object.values(readableReferences).filter((source) => source.taskDir === activeSession?.taskDir && source.targetSessionId === activeSession?.sessionId && source.targetConnectionGeneration === activeSession?.connectionGeneration)
  const requiredPlanningFiles = lightweightPlan ? ['prd.md'] : ['prd.md', 'design.md', 'implement.md']
  const planningPath = (name: string): string => `.trellis/tasks/${activeSession?.taskDir ?? ''}/${name}`
  const missingReviewed = requiredPlanningFiles.filter((name) => !reviewedMaterials.some((source) => sameRelativeDocumentPath(root, source.relativePath, planningPath(name))))
  const prepareImplementation = (): void => {
    if (!activeSession?.taskDir || missingReviewed.length) return
    const sources = reviewedMaterials.filter((source) => requiredPlanningFiles.some((name) => sameRelativeDocumentPath(root, source.relativePath, planningPath(name))))
    const instruction = boundTask?.record?.status === 'in_progress' ? '按已审阅的修订方案继续实施' : '确认已审阅的计划并进入实施'
    void installDraft(`我已审阅任务 ${activeSession.taskDir} 的以下当前规划材料：\n${sources.map((source) => `- ${source.relativePath}（已展示版本 ${source.displayedRevision}）`).join('\n')}\n\n请${instruction}，遵循项目实际 Trellis 工作流与任务范围。若文件版本、范围或前置检查有变化，先指出变化；不要将本条消息直接视为任务状态已更新或验收完成。`, sources, 'implementation')
  }
  const bindTask = async (): Promise<void> => {
    if (!activeSession || !activeSession.connectionGeneration || activeSession.status !== 'ready' || binding || !isCurrent()) return
    const sessionId = activeSession.sessionId
    if (scope.actions.has(sessionId)) return
    scope.actions.add(sessionId); setBinding(true)
    try {
      const result = await api.acpSessionBindTask(sessionId, { taskDir: taskDir || null, expectedConnectionGeneration: activeSession.connectionGeneration })
      if (!isCurrent()) return
      if (result.ok && result.session) { updateSession(result.session); setFeedback((previous) => ({ ...previous, [sessionId]: { error: false, text: '已更新后续消息的任务上下文。先前对话和引用保持原始归属。' } })) }
      else setFeedback((previous) => ({ ...previous, [sessionId]: { error: true, text: result.error ?? '关联失败，原任务和草稿已保留。' } }))
    } catch (error) { if (isCurrent()) setFeedback((previous) => ({ ...previous, [sessionId]: { error: true, text: failureText(error) } })) }
    finally { scope.actions.delete(sessionId); if (isCurrent()) setBinding(false) }
  }
  const inspectedSession = inspectedSessionId ? projectSessions.find((session) => session.sessionId === inspectedSessionId) : undefined
  const inspectorSession = useMemo(() => inspectedSession ? { ...inspectedSession, events: mergeEvents(history.events[inspectedSession.sessionId] ?? [], events[inspectedSession.sessionId] ?? []) } : undefined, [inspectedSession, events, history.events])
  const currentProfile = profiles.find((item) => item.id === (inspectorSession?.profileSnapshot?.id ?? inspectedProfileId))
  const profile = inspectorSession?.profileSnapshot ?? currentProfile
  const profileSessions = profile ? projectSessions.filter((session) => session.profileSnapshot?.id === profile.id && !isDiagnosticConversation(session)) : []
  const filteredProfiles = rolesForDisplay(profiles.filter((item) => `${item.name} ${item.description} ${item.runtimeId}`.toLowerCase().includes(libraryQuery.toLowerCase())))
  const createProfile = (resumePicker = false): void => {
    const supportedEngines = agents.filter((agent) => agent.id === 'codex' || agent.id === 'claude')
    const readyEngine = supportedEngines.find((agent) => agent.enabled && agent.available) ?? supportedEngines[0] ?? agents[0]
    const draft: AcpAgentProfile = { id: crypto.randomUUID(), name: '', description: '', instructions: '', runtimeId: readyEngine?.runtimeId ?? readyEngine?.id ?? '', maxTurnMinutes: 30 }
    setNewConversation(null); setReturnToPicker(resumePicker); setInspectedSessionId(null); setEditor(draft); setInspectedProfileId(draft.id); setInspectorTab('agent'); setInspectorOpen(true)
  }
  const editProfile = (selected: AcpAgentProfile, resumePicker = false): void => {
    setNewConversation(null); setReturnToPicker(resumePicker); setInspectedSessionId(null); setInspectedProfileId(selected.id); setEditor(selected); setInspectorTab('agent'); setInspectorOpen(true)
  }
  const isReadOnly = Boolean(activeSession && (activeSession.archivedAt || (!isLiveStatus(activeSession.status) && !activeSession.canResume && !activeSession.cleanupRequired)))
  const canEndSession = view === 'conversation' && activeSession && (sending[activeSession.sessionId] || isLiveStatus(activeSession.status) || activeSession.restorePending || activeSession.connectionOwned || activeSession.cleanupRequired)
  const visiblePermissions = Object.values(pendingPerm).filter((permission) => permission.sessionId === activeId && !items.some((item) => item.type === 'perm' && item.ev.payload?.requestId === permission.requestId))
  const handoffAvailable = typeof api?.acpSessionHandoffPreview === 'function' && typeof api?.acpSessionHandoffCreate === 'function' && typeof api?.acpSessionHandoffStatus === 'function' && typeof api?.acpSessionHandoffCancel === 'function'
  const handoffSourceIssue = !handoffAvailable ? '接续功能需要更新桌面连接，请完整重启应用。' : activeSession ? runtimeHandoffUnavailableReason({ ...activeSession, events: activeEvents }, !selectedArchiveKnown || Boolean(sending[activeSession.sessionId] || operations[activeSession.sessionId] || currentTurnRequest || managedComposerBlocked || Object.values(pendingPerm).some((permission) => permission.sessionId === activeSession.sessionId))) : undefined
  const ownsHandoffSource = (): boolean => isCurrent() && canInteract() && !interactionSignal?.aborted && activeSelection.current.view === 'conversation' && activeSelection.current.id === activeSession?.sessionId
  const openRuntimeHandoff = (): void => {
    if (!activeSession || !ownsHandoffSource()) return
    newComposerFocus.current = null
    setHandoffOwner({ root, sessionId: activeSession.sessionId })
  }
  const openHandoffTarget = async (operation: AcpHandoffOperation): Promise<void> => {
    if (!activeSession || !ownsHandoffSource() || operation.sourceSessionId !== activeSession.sessionId || !operation.targetSessionId || !['ready', 'sent'].includes(operation.state)) return
    const [targetResult, sourceResult] = await Promise.allSettled([handoffRequest(history.refreshSession(operation.targetSessionId)), handoffRequest(history.refreshSession(operation.sourceSessionId))])
    if (!ownsHandoffSource()) return
    if (sourceResult.status === 'fulfilled' && sourceResult.value) updateSession({ ...sourceResult.value, events: [] })
    else if (sourceResult.status === 'rejected') pushToast({ kind: 'warn', title: '来源对话状态暂未刷新', body: failureText(sourceResult.reason) })
    if (targetResult.status === 'rejected') throw targetResult.reason
    const target = targetResult.value
    if (!target || target.sessionId !== operation.targetSessionId || projectRootKey(target.projectRoot) !== projectRootKey(root)) throw Error('接续对话暂不可读取，请检查状态后重试。')
    if ((target.runtimeSnapshot?.id ?? target.agentId) !== operation.targetRuntimeId || target.handoff?.operationId !== operation.id || target.handoff.sourceSessionId !== operation.sourceSessionId) throw Error('接续对话的来源或 Runtime 不一致，请检查状态。')
    updateSession({ ...target, events: [] })
    history.setArchive('active')
    selectSession(operation.targetSessionId)
    setHandoffOwner(null)
  }
  const openKnowledge = (): void => {
    if (!activeSession || !isCurrent() || !canInteract() || activeSelection.current.view !== 'conversation' || activeSelection.current.id !== activeSession.sessionId) return
    setKnowledgePanel({ root, sessionId: activeSession.sessionId })
  }
  const openKnowledgePicker = (): void => {
    if (!activeSession || !isCurrent() || !canInteract() || activeSelection.current.view !== 'conversation' || activeSelection.current.id !== activeSession.sessionId) return
    setKnowledgePicker({ root, sessionId: activeSession.sessionId, generation: activeSession.connectionGeneration })
  }
  const openProjectActivity = (): void => {
    if (!activeSession || !isCurrent() || !canInteract() || activeSelection.current.view !== 'conversation' || activeSelection.current.id !== activeSession.sessionId) return
    setProjectActivityOwner({ root, sessionId: activeSession.sessionId })
  }
  const openRecordedArtifact = (file: { path: string }): void => {
    if (!isCurrent() || !canInteract()) return
    const artifact = [...conversationArtifacts, ...projectArtifacts].find((candidate) => projectRootKey(`${root}/${candidate.relativePath}`) === projectRootKey(file.path))
    if (artifact) { setProjectActivityOwner(null); openDocument(artifact) }
    else pushToast({ kind: 'info', title: '正在核对任务材料', body: '该路径尚未出现在当前任务的可验证材料清单，请刷新后从任务详情阅读。' })
  }
  const customRoles = filteredProfiles.filter((item) => !isStarterRole(item))
  const starterRoles = filteredProfiles.filter(isStarterRole)
  const renderRole = (item: AcpAgentProfile): JSX.Element => {
    const engine = agents.find((agent) => (agent.runtimeId ?? agent.id) === item.runtimeId)
    return <button key={item.id} className={clsx('acp-agent-card', inspectorOpen && inspectedProfileId === item.id && !inspectedSessionId && 'is-selected')} onClick={() => openAgent(item.id)}><span className="acp-avatar"><Bot size={20} /></span><div><strong>{item.name}</strong><p>{item.description || (isStarterRole(item) ? '预置起点，可补充你的角色职责与指令' : '自定义工作角色')}</p><small>执行引擎：{engine?.name ?? item.runtimeId} · {runtimeHealthLabel(engine)}</small><small className="mt-1 block">本机私有 · 当前项目</small></div></button>
  }

  if (!root) return <div className="acp-empty">请先打开项目，再查看该项目的 Agent 会话。</div>
  if (!hasIpc) return <div className="acp-workspace" style={sidebarWidthStyle}><main className="acp-main my-conversation-frame">
    <header className="acp-workspace-header"><strong>Agent 会话</strong><Button size="sm" variant="ghost" disabled aria-label="刷新会话"><RefreshCw size={14} aria-hidden="true" />刷新</Button></header>
    <section className="acp-empty" aria-label="会话连接不可用"><Bot size={25} className="mx-auto" aria-hidden="true" /><p role="status">会话功能需要桌面连接，当前无法读取角色与历史会话。</p><Button variant="outline" disabled>新建会话</Button></section>
  </main></div>
  return <div className={clsx('acp-workspace', sidebarCollapsed && !sidebarOpen && 'is-sidebar-collapsed')} style={sidebarWidthStyle}>
    <div ref={navigationRef} className={clsx('acp-navigation-host flex min-h-0 shrink-0', sidebarCollapsed && !sidebarOpen && 'is-collapsed')}><ConversationNavigation sessions={projectSessions} activeId={activeId} view={view} onView={showView} onSelect={selectSession} onNew={() => openNewConversation()} query={history.query} onQuery={history.setQuery} archive={history.archive} onArchive={history.setArchive} canManage={history.canManage} mutationBusy={history.mutationBusy} mutationErrors={history.mutationErrors} onUpdate={updateConversation} onDelete={history.remove} onRegenerateTitle={history.regenerateTitle} hasMore={history.hasMore} loadingMore={history.loadingMore} onLoadMore={() => void history.loadMore()} collapsed={sidebarCollapsed} open={sidebarOpen} onClose={() => setSidebarOpen(false)} /></div>
    <ConversationPreviewLayout ownerKey={webPreview.ownerKey} expanded={webPreview.expanded} onExpandedChange={webPreview.setExpanded} collapsed={webPreview.collapsed} previewCount={webPreview.tabs.length} onCollapsedChange={collapsed => collapsed ? closeWebPreview() : webPreview.setCollapsed(false)} preview={webPreview.tabs.length > 0 && activeSession ? <ConversationPreviewTabs key={webPreview.ownerKey} shelf={{ ...webPreview, setCollapsed: collapsed => collapsed ? closeWebPreview() : webPreview.setCollapsed(false), closeWebPreview }} session={activeSession} /> : null}>
    <CodePreviewProvider openCodePreview={openCodePreview}>
    <main ref={mainRef} className="acp-main my-conversation-frame">
      <ConversationWorkspaceHeader
        leading={<Button size="sm" variant="ghost" className={clsx('acp-mobile-only acp-sidebar-toggle', sidebarCollapsed && 'is-visible')} title="展开会话侧栏" onClick={() => { if (!compact && window.innerWidth > 900) useMy.getState().toggleSidebar(); else setSidebarOpen(true) }}><Menu size={16} /></Button>}
        identity={view === 'conversation' && activeSession ? <><MessageSquare size={16} className="shrink-0 text-my-icon-secondary" aria-hidden="true" /><strong>{activeSession.title ?? activeSession.profileSnapshot?.name ?? activeSession.agentName}</strong></> : <strong>{view === 'agents' ? '角色' : '对话'}</strong>}
        actions={<>
          {!(view === 'conversation' && activeSession) && <WorkflowRecovery root={root} run={null} originKey={JSON.stringify([projectRootKey(root), 'project-recovery'])} onOpenHistory={openWorkflowHistory} />}
          {view === 'conversation' && activeSession && activeSession.status !== 'starting' && !['prepare-send', 'resume', 'recover-model'].includes(operations[activeSession.sessionId]) && <span role="status" className={clsx('acp-session-status inline-flex items-center gap-1 text-my-sm', STATUS_COLOR[activeSession.status])}>{activeSession.status === 'error' ? '当前未连接' : SESSION_LABEL[activeSession.status]}</span>}
          {view === 'conversation' && activeSession && <><button type="button" className="acp-header-task my-icon-control" title={boundTask?.record?.title ?? activeSession.taskDir ?? '查看任务与材料'} aria-label="查看任务与材料" onClick={() => openTask()}><Folder size={16} /></button><button type="button" className="my-icon-control" title="会话配置与材料" aria-label="会话配置与材料" onClick={() => openAgent()}><Settings2 size={16} /></button></>}
          {view !== 'conversation' && <Button size="sm" variant="ghost" title="执行引擎与本机环境" onClick={() => { showView('agents'); setEngineSetupOpen((current) => !current) }}><Settings2 size={15} /></Button>}
          {!canEndSession && !(view === 'conversation' && activeSession) ? <Button size="sm" variant="ghost" className="acp-refresh-control" aria-label="刷新会话" title="刷新会话" onClick={() => { void reloadSessions(); void history.refresh(); history.reloadSelected(); void reloadCatalogue() }}><RefreshCw size={14} className={loading || history.loading ? 'animate-spin' : ''} />刷新</Button> : activeSession && <Dropdown align="right" width={256} trigger={({ open, toggle }) => <button type="button" className="my-icon-control" aria-label="更多会话操作" aria-expanded={open} onClick={toggle}><Ellipsis size={17} /></button>}>{(close) => <><DropdownItem icon={<RefreshCw size={14} className={loading ? 'animate-spin' : ''} />} onClick={() => { close(); void reloadSessions(); void history.refresh(); history.reloadSelected(); void reloadCatalogue() }}>刷新</DropdownItem><DropdownItem icon={<ArrowRightLeft size={14} />} onClick={() => { close(); openRuntimeHandoff() }}>用另一个 Runtime 接续</DropdownItem><DropdownItem icon={<FileText size={14} />} onClick={() => { close(); openKnowledge() }}>项目知识与来源</DropdownItem><DropdownItem icon={<Activity size={14} />} onClick={() => { close(); openProjectActivity() }}>项目活动</DropdownItem>{canEndSession && <DropdownItem danger icon={<X size={14} />} disabled={managedComposerBlocked || operations[activeSession.sessionId] === 'kill' || operations[activeSession.sessionId] === 'cancel'} onClick={() => { close(); void sessionAction('kill') }}>结束当前会话</DropdownItem>}</>}</Dropdown>}
        </>}
      />
      {(loadError || history.error) && <div role="alert" className="acp-notice">{loadError || history.error}<button className="ml-3 underline" onClick={() => { void reloadCatalogue(); void reloadSessions(); void history.refresh(); history.reloadSelected() }}>重试加载</button></div>}
      {incomingRequest && projectRootKey(incomingRequest.root) === projectRootKey(root) && <section aria-label={incomingRequest.intent === 'discussion' ? '待讨论问题' : '待梳理需求'} className="shrink-0 space-y-2 border-b border-my-line bg-my-layer-1 px-4 py-3"><p className="text-my-sm font-medium">{incomingRequest.intent === 'discussion' ? '讨论' : '需求'}：{incomingRequest.title}</p><p className="text-my-xs text-my-tertiary">{incomingRequest.source.kind === 'jira' ? `Jira ${incomingRequest.source.key} · ${incomingRequest.source.url}` : incomingRequest.intent === 'discussion' ? '项目知识讨论' : '手动需求'} · 将作为可编辑草稿，尚未发送或创建任务。</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" onClick={() => openNewConversation()}>选择引擎并新建会话</Button>{activeSession && !isReadOnly && <Button size="sm" variant="outline" onClick={() => {
        const id = activeSession.sessionId
        const request = incomingRequest
        const draft = [input, requirementsDraftText(request)].filter((part) => part.trim()).join('\n\n')
        void installDraft(draft, references, request.intent === 'discussion' ? 'plain' : 'planning').then(() => { if (isCurrent() && draftsRef.current[id] === draft) useKnowledgeRequest.getState().clear(request.id) })
      }}>追加到当前会话草稿</Button>}<Button size="sm" variant="ghost" onClick={() => useKnowledgeRequest.getState().clear(incomingRequest.id)}>取消本次入口</Button></div></section>}
      {incomingKnowledge && projectRootKey(incomingKnowledge.root) === projectRootKey(root) && (view !== 'conversation' || !activeSession || isReadOnly) && <section aria-label="待加入的知识来源" className="shrink-0 space-y-2 border-b border-my-line bg-my-layer-1 px-4 py-3"><p className="text-my-sm font-medium">待加入：{incomingKnowledge.source.title}</p><p className="text-my-xs text-my-secondary">选择可继续的对话或新建会话，再明确加入草稿。</p><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => openNewConversation()}>新建会话</Button><Button size="sm" variant="ghost" onClick={() => useKnowledgeReferenceHandoff.getState().clear(incomingKnowledge.id)}>取消待加入</Button></div></section>}
      {view === 'agents' ? <section className="acp-catalogue my-scrollbar"><PageContent variant="centered">
        <div className="acp-catalogue-heading"><div><h1>角色</h1><p className="mt-1 text-my-sm text-my-secondary">定义产品助手、研发助手等工作角色，再选择 Codex 或 Claude Code 为它执行。</p></div><Button size="sm" variant="outline" onClick={() => openNewConversation()}><MessageSquare size={14} />新建会话</Button><Button size="sm" variant="primary" disabled={!hasIpc} onClick={() => createProfile()}><Plus size={14} />创建角色</Button></div>
        <ol className="acp-onboarding" aria-label="开始使用 Agent"><li><button onClick={() => setEngineSetupOpen(true)}><span>1</span><strong>配置执行引擎</strong><small>安装、登录与本机环境</small></button></li><li><button onClick={() => createProfile()}><span>2</span><strong>创建工作角色</strong><small>名称、职责与工作指令</small></button></li><li><button onClick={() => openNewConversation()}><span>3</span><strong>选择角色开始会话</strong><small>明确连接后再选择模型</small></button></li></ol>
        {engineSetupOpen && <section className="acp-library-engines"><div className="mb-3 flex items-center gap-2"><h2 className="min-w-0 flex-1 text-my-sm font-medium text-my-primary">执行引擎与本机环境</h2><Button size="sm" variant="ghost" title="收起本机环境" onClick={() => setEngineSetupOpen(false)}><X size={14} /></Button></div><RuntimePanel agents={agents} onChange={setAgents} isCurrent={isCurrent} /><Button size="sm" variant="ghost" className="mt-3" onClick={() => { useMy.getState().setSettingsView('engines'); setPage('settings') }}>管理自定义执行命令</Button></section>}
        <div className="acp-catalogue-tools"><span>本机私有 · 当前项目 · {profiles.filter((item) => !isStarterRole(item)).length} 个自定义角色</span><div className="flex-1" /><label className="flex min-w-0 items-center gap-2"><Search size={14} /><input className="my-input min-w-0 max-w-44" aria-label="搜索已加载的角色" value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="搜索角色名称或职责" /></label></div>
        <div className="acp-agent-grid">{customRoles.map(renderRole)}</div>
        {customRoles.length === 0 && <div className="acp-role-empty"><Bot size={24} /><div><strong>{loading ? '正在加载角色…' : libraryQuery ? '没有匹配的自定义角色' : '创建属于你的第一个角色'}</strong><p>{libraryQuery ? '可以修改搜索内容，或查看下方的预置起点。' : '执行引擎只负责运行。把角色的职责、工作边界与输出要求保存在这里，下次可以直接复用。'}</p></div><Button size="sm" variant="primary" disabled={!hasIpc} onClick={() => createProfile()}>创建角色</Button></div>}
        {starterRoles.length > 0 && <details className="acp-starter-roles" open={customRoles.length === 0}><summary>预置起点 · 保留已有配置和历史会话</summary><p className="mb-3 mt-2 text-my-sm text-my-tertiary">这些是原有的预置角色，可继续使用，也可编辑名称和指令形成自己的工作角色。</p><div className="acp-agent-grid">{starterRoles.map(renderRole)}</div></details>}
        <details className="mt-8 border-t border-my-line pt-4 text-my-sm text-my-tertiary"><summary className="cursor-pointer">Jira 工单与已有对话</summary><div className="mt-3 flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={() => openNewConversation()}>选择角色新建会话</Button><Button size="sm" variant="ghost" onClick={() => setJiraOpen(true)}><GitBranch size={13} />从 Jira 选工单开始</Button></div></details>
      </PageContent></section> : !activeSession ? <div className="acp-empty"><MessageSquare size={25} className="mx-auto" /><p>选择最近会话，或选择 Agent 开始新对话。</p><Button variant="outline" onClick={() => openNewConversation()}>选择角色新建会话</Button></div> : <section className="acp-content">
        <div ref={streamRef} className="acp-transcript my-scrollbar" role="region" aria-label="会话消息" tabIndex={0} onScroll={(event) => {
          const element = event.currentTarget, follow = element.scrollHeight - element.scrollTop - element.clientHeight < 48
          if (history.loadingEarlier && earlierAnchor.current?.sessionId === activeSession.sessionId) earlierAnchor.current.snapshot = captureTranscriptAnchor(element)
          followRef.current = follow; setAtBottom(follow); writeSessionView(root, activeSession.sessionId, { scrollTop: element.scrollTop, follow })
        }}><div className="acp-transcript-content my-conversation-column acp-chat-copy">
          <ConversationHandoff key={`handoff:${root}:${activeSession.sessionId}`} root={root} session={activeSession} agents={agents} operation={handoffStatus.operation} checking={handoffStatus.loading} statusError={handoffStatus.error} isCurrent={ownsHandoffSource} onSelect={(id) => useMy.getState().setAgentSessionTarget(id)} onCheck={() => void handoffStatus.refresh()} onOperation={handoffStatus.accept} onChanged={() => void reloadSessions()} onCancelled={(id) => useMy.getState().setAgentSessionTarget(id)} />
          {history.selectionError && <div role="alert" className="acp-history-note"><p>历史消息暂时无法加载，已加载内容仍保留。</p><details><summary>错误详情</summary><pre>{history.selectionError}</pre></details><Button size="sm" variant="ghost" disabled={history.selectionLoading} onClick={history.reloadSelected}>重试加载历史</Button></div>}
          {(history.hasEarlier || history.startsMidTurn || history.coverage?.state === 'partial' || history.coverage?.state === 'unknown') && <HistoryBoundary key={`history:${root}:${activeSession.sessionId}`} hasEarlier={history.hasEarlier} startsMidTurn={history.startsMidTurn} coverage={history.coverage?.state} loading={history.loadingEarlier} onLoadEarlier={loadEarlier} />}
          {activeSession.directoryLeaseReason && <p className="rounded-my-md bg-my-warning-subtle px-3 py-2 text-my-sm text-my-warning-text">目录占用：{activeSession.directoryLeaseReason}</p>}
          {isReadOnly && <div className="acp-history-note"><p>{activeSession.archivedAt ? '此会话已归档，取消归档后可继续。' : '此记录没有可恢复的远端会话，仅供阅读。'}</p><Button size="sm" variant="ghost" onClick={() => openNewConversation()}>新建会话</Button>{activeSession.error && <ConnectionNotice message={activeSession.error} />}</div>}
          <ConversationTranscript items={items} currentActivity={currentTurnActivity} onActiveSegmentChange={setActiveTranscriptSegment} suppressWorkingIndicator={Boolean(currentTurnActivity)} session={activeSession} events={activeEvents} pendingPerm={pendingPerm} permissionPending={permissionPending} permissionErrors={permissionErrors} onRespond={respondPerm} onOpenTask={(directory) => openTask(directory)} onOpenArtifact={openRecordedArtifact} onOpenSpec={() => setPage('spec')} onOpenJira={() => setPage('jira')} onOpenWebPreview={openWebPreview} />
          {failedSends[activeSession.sessionId] && <div className="acp-history-note" role="status"><p>有一条消息未发送，新草稿已保留。</p><button className="underline" onClick={() => {
            const failed = failedSends[activeSession.sessionId]
            const current = draftsRef.current[activeSession.sessionId] ?? ''
            if (current.trim()) {
              setDraftBackup(current)
              writeSessionView(root, activeSession.sessionId, { draftBackup: current, backupReferences: draftReferencesRef.current[activeSession.sessionId] ?? [], backupIntent: draftIntent })
            }
            else setDraftBackup('')
            draftsRef.current[activeSession.sessionId] = failed.draft; draftReferencesRef.current[activeSession.sessionId] = failed.references
            writeSessionView(root, activeSession.sessionId, { draft: failed.draft, sourceReferences: failed.references, intent: failed.intent })
            writeKnowledgeReferences(root, activeSession.sessionId, failed.knowledge)
            setInput(failed.draft); setReferences(failed.references); setKnowledgeReferences(failed.knowledge); setDraftIntent(failed.intent)
            composerImages.replace(activeSession.sessionId, failed.images)
            setFailedSends(previous => { const next = { ...previous }; delete next[activeSession.sessionId]; return next })
          }}>恢复未发送内容</button></div>}
          {visiblePermissions.map((permission) => <EventRow key={`current-permission:${permission.requestId}`} item={{ type: 'perm', key: `current-permission:${permission.requestId}`, ev: { id: `current-permission:${permission.requestId}`, ts: 0, source: 'acp', kind: 'permission', sessionId: activeSession.sessionId, projectRoot: root, text: permission.toolCall?.title ?? '等待你的授权', payload: { requestId: permission.requestId } } }} session={activeSession} events={activeEvents} pendingPerm={pendingPerm} permissionPending={permissionPending} permissionErrors={permissionErrors} onRespond={respondPerm} onOpenTask={openTask} onOpenArtifact={() => {}} onOpenSpec={() => setPage('spec')} onOpenJira={() => setPage('jira')} />)}
          {conversationArtifacts.length > 0 && <section className="acp-material-shelf" aria-label="当前任务材料"><p className="mb-3 text-my-sm text-my-tertiary">任务材料 · 当前文件，文件变化不代表任务已验收</p><div className="space-y-2">{conversationArtifacts.slice(0, 6).map((artifact) => <ConversationArtifactCard key={artifact.relativePath} artifact={artifact} onOpen={openDocument} selected={documentTarget?.artifact.relativePath === artifact.relativePath && inspectorTab === 'document' && inspectorOpen} />)}</div><div className="mt-4 flex flex-wrap items-center gap-3 text-my-sm text-my-tertiary"><button onClick={preparePlanning}>继续完善方案<ChevronRight size={12} className="ml-1 inline" /></button><button onClick={() => openTask()}>复核规划材料<ChevronRight size={12} className="ml-1 inline" /></button></div></section>}
          {items.length === 0 && !activeSession.handoff && !isReadOnly && !currentTurnActivity && !sending[activeSession.sessionId] && activeSession.status !== 'starting' && !history.selectionError && !projection.detail && <div className="acp-empty"><Bot size={25} className="mx-auto" /><p>{history.selectionLoading || projection.loading ? '正在加载历史消息…' : '从一条清晰的指令开始。'}</p></div>}
          <CurrentTurnStatus activity={segmentOwnsActivity ? null : currentTurnActivity} />
        </div></div>
        {!atBottom && <div className="acp-scroll-to-bottom-container"><Button size="sm" variant="outline" className="acp-scroll-to-bottom-btn" onClick={(event) => { const element = streamRef.current; earlierAnchor.current = null; followRef.current = true; if (element) { if (document.activeElement === event.currentTarget) element.focus({ preventScroll: true }); element.scrollTop = element.scrollHeight }; setAtBottom(true); writeSessionView(root, activeSession.sessionId, { follow: true }) }}><ArrowDown size={12} aria-hidden="true" />回到最新</Button></div>}
        {(!isReadOnly || activeSession.historyPersistence?.state === 'degraded' || (workflow.available && activeSession.taskDir)) && <footer className="acp-composer-region my-conversation-column">
          <WorkflowPanel root={root} taskDir={activeSession.taskDir ?? ''} session={activeSession} controller={workflow} onOpenHistory={openWorkflowHistory} />
          {(!handoffEnded || activeSession.cleanupRequired || activeSession.historyPersistence?.state === 'degraded') && <ConnectionRecovery
            session={activeSession}
            message={feedback[activeSession.sessionId]?.error ? feedback[activeSession.sessionId].text : activeSession.error}
            reportedByTurn={!feedback[activeSession.sessionId]?.error && isRecordedTurnFailure(activeEvents, activeSession, activeSession.error)}
            pending={operations[activeSession.sessionId]}
            onRetry={() => void sessionAction('resume')}
            onCleanup={() => void sessionAction('kill')}
            onRetryHistory={() => void retryHistory()}
            onNew={() => openNewConversation()}
            onEnvironment={() => { showView('agents'); setEngineSetupOpen(true) }}
            onChooseModel={isReadOnly || handoffComposerBlocked || managedComposerBlocked ? undefined : () => {
              const trigger = modelTrigger.current
              if (canInteract() && trigger?.getAttribute('aria-expanded') === 'false') trigger.click()
            }}
          />}
          {!isReadOnly && <div className={clsx('acp-composer', composerImages.dragging && 'acp-composer-dragging')} {...composerImages.dragHandlers} onPaste={composerImages.onPaste}>
            {composerImages.fileInput}
            {composerImages.dragging && <div className="acp-image-drop-hint" aria-hidden="true"><ImagePlus size={22} /><span>松开以添加图片</span></div>}
            <ImageAttachments key={`${activeSession.sessionId}:${activeSession.connectionGeneration}`} images={composerImages.images} onRemove={composerImages.remove} />
            {composerImages.pending && <p className="acp-image-status" role="status"><Loader2 size={12} className="animate-spin" />正在添加图片…</p>}
            {composerImages.error && <p className="acp-image-status text-my-danger-text" role="alert">{composerImages.error}</p>}
            {composerImages.images.length > 0 && !composerImages.pending && !composerImages.error && activeSession.capabilities?.promptCapabilities?.image !== true && <p className="acp-image-status text-my-warning-text" role="status">{activeSession.status === 'starting' ? '连接就绪后确认图片输入支持' : '当前执行引擎未声明支持图片输入，图片草稿已保留'}</p>}
            {draftIntent !== 'plain' && <p className={clsx('px-3 pt-3 text-my-sm', draftIntent === 'implementation' ? 'text-my-warning-text' : 'text-my-secondary')}>{draftIntent === 'implementation' ? '实施授权草稿 · 审阅后手动发送' : draftIntent === 'planning' ? '仅完善方案 · 暂不开始实现' : '文档反馈 · 引用版本将在发送前校验'}</p>}
            {draftBackup && <p className="px-3 pt-2 text-my-sm text-my-tertiary">原草稿已保留。<button className="ml-2 underline" onClick={() => {
              const saved = readSessionView(root, activeSession.sessionId), restoredReferences = saved.backupReferences ?? []
              changeDraft(draftBackup); setReferences(restoredReferences); draftReferencesRef.current[activeSession.sessionId] = restoredReferences; setDraftIntent(saved.backupIntent ?? 'plain'); setDraftBackup('')
              writeSessionView(root, activeSession.sessionId, { draft: draftBackup, sourceReferences: restoredReferences, intent: saved.backupIntent ?? 'plain', draftBackup: '', backupReferences: [] })
            }}>恢复原稿</button></p>}
            {references.length > 0 && <div className="acp-source-references">{references.map((source) => <div className="acp-source-chip" key={`${source.relativePath}:${source.displayedRevision}`}><FileText size={12} /><span title={`${source.relativePath} · ${source.displayedRevision}`}>{source.relativePath.split('/').at(-1)} · {source.displayedRevision.slice(0, 8)}</span><button aria-label={`移除引用 ${source.relativePath}`} onClick={() => { const next = references.filter((item) => item !== source); setReferences(next); draftReferencesRef.current[activeSession.sessionId] = next; writeSessionView(root, activeSession.sessionId, { sourceReferences: next }) }}><X size={11} /></button></div>)}</div>}
            {incomingKnowledge && projectRootKey(incomingKnowledge.root) === projectRootKey(root) && <div className="px-3 pt-2 text-my-xs text-my-secondary" role="status">待加入：{incomingKnowledge.source.title} <button className="ml-2 underline" onClick={() => { void addKnowledgeReference(incomingKnowledge.source, () => useKnowledgeReferenceHandoff.getState().pending?.id === incomingKnowledge.id, incomingKnowledge).then((added) => { if (added) useKnowledgeReferenceHandoff.getState().clear(incomingKnowledge.id) }) }}>加入当前草稿</button><button className="ml-2 underline" onClick={() => useKnowledgeReferenceHandoff.getState().clear(incomingKnowledge.id)}>取消</button></div>}
            {knowledgeReferenceErrors[activeSession.sessionId] && <p role="alert" className="px-3 pt-2 text-my-xs text-my-warning-text">{knowledgeReferenceErrors[activeSession.sessionId]}</p>}
            {knowledgeReferences.length > 0 && <div className="acp-source-references">{knowledgeReferences.map((source) => <div className="acp-source-chip" key={source.id}><FileText size={12} /><span title={source.kind === 'project' ? `${source.relativePath} · ${source.displayedRevision}` : `${source.kind === 'local' ? source.relativePath : `${source.instanceId ?? ''} · ${source.collectionId ?? ''} · ${source.documentId}`} · ${source.contentHash} · ${new Date(source.fetchedAt).toLocaleString()}`}>{source.title} · {source.kind === 'project' ? `文件 · ${source.displayedRevision.slice(0, 8)}` : `${source.mode === 'full' ? '正文' : '摘录'}${source.truncated ? ' · 已截断' : ''} · ${source.contentHash.slice(0, 8)}`}</span><button aria-label={`移除知识引用 ${source.title}`} onClick={() => { const next = readKnowledgeReferences(root, activeSession.sessionId).filter((item) => item.id !== source.id); writeKnowledgeReferences(root, activeSession.sessionId, next); setKnowledgeReferences(next) }}><X size={11} /></button></div>)}</div>}
            <textarea ref={composerRef} aria-label="Agent 指令" title={managedComposerBlocked ? '受管任务执行期间保留草稿；请等待或停止任务后再发送普通指令' : 'Enter 发送 · Shift Enter 换行'} readOnly={managedComposerBlocked} rows={2} value={input} placeholder="说说你的想法…" onChange={(event) => changeDraft(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send() } }} />
            <div className="acp-composer-toolbar">
              <ComposerModelPicker
                key={`${activeSession.sessionId}:${activeSession.connectionGeneration}`}
                session={activeSession}
                message={feedback[activeSession.sessionId]?.error ? feedback[activeSession.sessionId].text : activeSession.error}
                operationPending={Boolean(operations[activeSession.sessionId]) || Boolean(sending[activeSession.sessionId]) || !selectedArchiveKnown || managedComposerBlocked || handoffComposerBlocked}
                acquireConfiguration={acquireConfiguration}
                configureSession={(configuration) => api.acpSessionConfigure(activeSession.sessionId, configuration)}
                isCurrent={() => isCurrent() && canInteract() && activeSelection.current.view === 'conversation' && activeSelection.current.id === activeSession.sessionId && activeSelection.current.generation === activeSession.connectionGeneration}
                onUpdated={updateSession}
                onRecoverModel={recoverModel}
                onReconnect={() => sessionAction('resume')}
                triggerRef={modelTrigger}
                onOpenModelSettings={() => useApp.getState().setPage('models')}
                onOpenRuntimeSettings={() => { showView('agents'); setEngineSetupOpen(true) }}
                contextActions={(close) => <>
                  <button type="button" className="acp-add-action my-menu-item" onClick={() => { close(); composerImages.choose() }}><ImagePlus size={14} /><span>添加图片</span></button>
                  <button type="button" className="acp-add-action my-menu-item" onClick={() => { close(); openTask() }}><Folder size={14} /><span>{activeSession.taskDir ? '查看关联任务与材料' : '关联任务'}</span></button>
                  <button type="button" className="acp-add-action my-menu-item" onClick={() => { close(); openKnowledgePicker() }}><Search size={14} /><span>查找项目知识</span></button>
                  <button type="button" className="acp-add-action my-menu-item" onClick={() => { close(); openKnowledge() }}><FileText size={14} /><span>项目知识与来源</span></button>
                  <button type="button" className="acp-add-action my-menu-item" onClick={() => { close(); openProjectActivity() }}><Activity size={14} /><span>项目活动</span></button>
                </>}
                usage={<ComposerUsageIndicator session={activeSession} events={activeEvents} />}
                sendAction={managedComposerBlocked ? <button type="button" className="acp-composer-action acp-composer-stop" title={workflow.operation === 'stop' ? '请求停止…' : workflow.snapshot?.composer.target === 'managed' ? '停止受管任务' : '核对任务状态'} aria-label={workflow.operation === 'stop' ? '请求停止' : workflow.snapshot?.composer.target === 'managed' ? '停止受管任务' : '核对任务状态'} disabled={Boolean(workflow.operation) || workflow.snapshot?.composer.target !== 'managed'} onClick={() => void workflow.stop()}><Square size={11} fill="currentColor" strokeWidth={0} aria-hidden="true" /></button> : (sending[activeSession.sessionId] || ['busy', 'awaiting_permission', 'cancelling'].includes(activeSession.status)) ? <button type="button" className="acp-composer-action acp-composer-stop" title={activeSession.status === 'cancelling' || operations[activeSession.sessionId] === 'cancel' ? '正在停止…' : '停止当前回合'} aria-label="停止当前回合" disabled={['kill', 'cancel'].includes(operations[activeSession.sessionId]) || activeSession.status === 'cancelling'} onClick={() => void sessionAction('cancel')}><Square size={11} fill="currentColor" strokeWidth={0} aria-hidden="true" /></button> : <button type="button" className="acp-composer-action acp-composer-send" title="发送指令" aria-label="发送指令" disabled={handoffComposerBlocked || !selectedArchiveKnown || !canSubmitConversation(activeSession) || Boolean(operations[activeSession.sessionId]) || Boolean(currentTurnRequest) || composerImages.pending || (!input.trim() && !composerImages.images.length)} onClick={() => void send()}><ArrowUp size={18} aria-hidden="true" /></button>}
              />
            </div>
          </div>}
        </footer>}
      </section>}
    </main>
    </CodePreviewProvider>
    </ConversationPreviewLayout>
    <WorkspaceInspector open={inspectorOpen} tab={inspectorTab} onTab={setInspectorTab} onClose={inspectorTab === 'document' ? closeDocument : closeInspector} expanded={documentExpanded && inspectorTab === 'document'} hasDocument={documentTarget !== null} returnFocusRef={inspectorReturnFocus} backgroundRefs={[mainRef, navigationRef]}>
      <div hidden={inspectorTab !== 'agent'} className="acp-inspector-body my-scrollbar">
        {editor ? <ProfileEditor inline key={editor.id} initial={editor} isNew={!profiles.some((item) => item.id === editor.id)} agents={agents} root={root} isCurrent={isCurrent} onAgentsChange={setAgents} onClose={() => { setEditor(null); if (returnToPicker) { setReturnToPicker(false); openNewConversation() } }} onSaved={(saved) => {
          setProfiles((previous) => [...previous.filter((item) => item.id !== saved.id), saved]); setEditor(null); setInspectedProfileId(saved.id); setInspectedSessionId(null)
          pushToast({ kind: 'success', title: '角色已保存', body: '角色默认配置仅保存在本机，新会话会使用这份配置。' })
          if (returnToPicker) { setReturnToPicker(false); openNewConversation(saved.id) }
        }} onDeleted={(id) => { setProfiles((previous) => previous.filter((item) => item.id !== id)); setEditor(null); setInspectorOpen(false); setReturnToPicker(false) }} /> : <AgentRoleDetails profile={profile} currentProfile={currentProfile} session={inspectorSession} recentSession={profileSessions[0]} agents={agents} root={root} section={roleSection} onSection={setRoleSection} isCurrent={isCurrent} onAgentsChange={setAgents} onUpdated={updateSession} onProfileChange={(saved) => setProfiles((previous) => [...previous.filter((item) => item.id !== saved.id), saved])} onNew={openNewConversation} onContinue={(id) => {
          if (id === activeSession?.sessionId && view === 'conversation') { setInspectorOpen(false); requestAnimationFrame(() => { if (canInteract()) composerRef.current?.focus() }) }
          else selectSession(id)
        }} onEdit={(selected) => editProfile(selected)} onKnowledge={() => setPage('knowledge')} onSpec={() => setPage('spec')} />}
      </div>
      <div hidden={inspectorTab !== 'task'} className="acp-inspector-body my-scrollbar"><h2 data-inspector-focus tabIndex={-1}>{inspectorTask?.record?.title ?? inspectedTaskDir ?? activeSession?.taskDir ?? '任务上下文'}</h2><p className="acp-inspector-description">任务关联用于后续材料组装。历史消息和材料保留原始归属。</p>
        {activeSession && <><label className="block text-my-sm text-my-secondary">选择当前项目任务<Select ariaLabel="会话关联任务" className="mt-2 w-full" value={taskDir} onChange={setTaskDir} options={[{ value: '', label: '不关联任务' }, ...(snapshot?.tasks ?? []).map((task) => ({ value: task.dirName, label: task.record?.title ?? task.dirName }))]} /></label><Button size="sm" variant="outline" className="mt-3" disabled={binding || activeSession.status !== 'ready' || !activeSession.connectionGeneration || taskDir === (activeSession.taskDir ?? '')} onClick={() => void bindTask()}>{binding ? '关联中…' : '明确关联此任务'}</Button>{activeSession.status !== 'ready' && <p className="mt-2 text-my-sm text-my-tertiary">需要就绪的空闲会话，运行期间不会排队修改关联。</p>}</>}
        {inspectorTask && <><div className="mt-5 border-t border-my-line pt-4 text-my-sm text-my-secondary"><p>任务状态：{inspectorTask.record?.status ?? '未知'} · {inspectorTask.phase}</p><p className="mb-3 mt-2">当前文件清单来自实际任务目录。</p><div className="space-y-2">{inspectorArtifacts.map((artifact) => <ConversationArtifactCard key={artifact.relativePath} artifact={artifact} onOpen={openDocument} />)}</div></div>{inspectorTask.dirName === activeSession?.taskDir && <div className="mt-5 space-y-3 border-t border-my-line pt-4"><Button size="sm" variant="outline" onClick={preparePlanning}>继续完善方案</Button><p className="text-my-sm leading-relaxed text-my-secondary">阅读当前规划材料后，可以准备独立的实施授权草稿。已展示版本是来源记录，不是审批记录。</p><label className="flex items-start gap-2 text-my-sm text-my-secondary"><input type="checkbox" checked={lightweightPlan} onChange={(event) => setLightweightPlan(event.target.checked)} /><span>本任务为轻量工作，项目流程仅需要 PRD；复杂任务需 PRD、设计和实施计划。</span></label><p className="text-my-sm text-my-tertiary">{missingReviewed.length ? `待阅读当前版本：${missingReviewed.join('、')}` : '所需材料当前版本已展示，可准备草稿。'}</p><Button size="sm" variant="outline" disabled={missingReviewed.length > 0 || isReadOnly} onClick={prepareImplementation}><ShieldCheck size={13} />{inspectorTask.record?.status === 'in_progress' ? '按修订方案继续实施' : '确认计划并进入实施'}</Button></div>}<Button size="sm" variant="ghost" className="mt-4" onClick={() => { setPage('tasks'); showTask(inspectorTask.dirName) }}>在任务工作台打开<ChevronRight size={12} /></Button></>}
        {!inspectorTask && activeSession && <div className="mt-5 border-t border-my-line pt-4"><p className="mb-3 text-my-sm text-my-secondary">项目材料发现 · 尚未归属到当前会话。阅读不会自动关联任务。</p><div className="space-y-2">{projectArtifacts.slice(0, 8).map((artifact) => <ConversationArtifactCard key={artifact.relativePath} artifact={artifact} onOpen={openDocument} />)}</div></div>}
        <p className="mt-6 text-my-sm leading-relaxed text-my-tertiary">Agent 回合结束不代表规划、检查或业务验收通过。操作不会直接更新 Trellis/Jira 状态。</p>
      </div>
      <div hidden={inspectorTab !== 'document'} className="acp-document-host">
        {documentTarget && activeSession?.sessionId === documentTarget.sessionId && activeSession.connectionGeneration !== documentTarget.connectionGeneration && <div role="status" className="shrink-0 border-b border-my-line-warning bg-my-warning-subtle px-4 py-3 text-my-sm text-my-warning-text">
          <p>会话连接已更新，旧草稿和引用仍保留原始目标。请更新文档引用目标，再点击“引用到草稿”。发送时仍会核对文件版本。</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => {
            if (isCurrent() && activeSession.sessionId === documentTarget.sessionId) setDocumentTarget({ ...documentTarget, connectionGeneration: activeSession.connectionGeneration })
          }}>更新文档引用目标</Button>
        </div>}
        {documentTarget && <ConversationDocumentPane projectRoot={documentTarget.artifact.projectRoot} sessionId={documentTarget.sessionId} connectionGeneration={documentTarget.connectionGeneration} taskDir={documentTarget.artifact.taskDir} relativePath={documentTarget.artifact.relativePath} expanded={documentExpanded} onToggleExpanded={() => setDocumentExpanded((current) => !current)} onClose={closeDocument} onReference={quoteDocument} onDisplayedReference={recordDisplayedReference} />}
      </div>
    </WorkspaceInspector>
    {newConversation && <NewConversationPicker key={newConversation.key} profiles={profiles} agents={agents} initialProfileId={newConversation.profileId} initialTaskDir={newConversation.taskDir} root={root} tasks={snapshot?.tasks ?? []} starting={creating} error={newConversationError} isCurrent={isCurrent} onAgentsChange={setAgents} onClose={() => setNewConversation(null)} onCreateRole={() => createProfile(true)} onEditRole={(selected) => editProfile(selected, true)} onStart={(selected, selectedTask, selectModel) => {
      const engine = agents.find((agent) => (agent.runtimeId ?? agent.id) === selected.runtimeId)
      if (!engine?.enabled || !engine.available) { setNewConversationError('执行引擎尚未就绪，请先完成本机环境配置。'); return }
      void newSession(engine.id, selectedTask, selected.id, selectModel)
    }} />}
    {jiraOpen && <JiraPickerModal isCurrent={isCurrent} onClose={() => setJiraOpen(false)} onSelected={() => { if (isCurrent()) setJiraOpen(false) }} />}
    {interactive && view === 'conversation' && activeSession && handoffOwner?.root === root && handoffOwner.sessionId === activeSession.sessionId && <RuntimeHandoffDialog key={`handoff-dialog:${root}:${activeSession.sessionId}`} root={root} source={activeSession} agents={agents} sourceIssue={handoffSourceIssue} isCurrent={ownsHandoffSource} onRefreshAgents={() => void reloadCatalogue()} onChanged={() => void reloadSessions()} onReady={openHandoffTarget} onClose={() => setHandoffOwner(null)} />}
    {interactive && view === 'conversation' && activeSession && knowledgePicker?.root === root && knowledgePicker.sessionId === activeSession.sessionId && knowledgePicker.generation === activeSession.connectionGeneration && <KnowledgeReferencePicker key={`${root}:${activeSession.sessionId}:${activeSession.connectionGeneration}`} root={root} sessionId={activeSession.sessionId} isCurrent={() => isCurrent() && activeSelection.current.view === 'conversation' && activeSelection.current.id === knowledgePicker.sessionId && activeSelection.current.generation === knowledgePicker.generation} onClose={() => { knowledgePickerRef.current = null; setKnowledgePicker(null) }} onSelect={(source) => source.sessionId === activeSession.sessionId ? addKnowledgeReference(knowledgeDraftReference(source), () => knowledgePickerRef.current === knowledgePicker) : Promise.resolve(false)} />}
    {interactive && view === 'conversation' && activeSession && knowledgePanel?.root === root && knowledgePanel.sessionId === activeSession.sessionId && <ConversationKnowledgePanel key={`${root}:${activeSession.sessionId}`} root={root} session={activeSession} events={activeEvents} onClose={() => setKnowledgePanel(null)} />}
    {interactive && view === 'conversation' && activeSession && projectActivityOwner?.root === root && projectActivityOwner.sessionId === activeSession.sessionId && <Modal open ariaLabel="项目活动" width={760} onClose={() => setProjectActivityOwner(null)}>
      <header className="flex items-center gap-3 border-b border-my-line px-4 py-3"><h2 className="min-w-0 flex-1 text-my-md font-semibold">项目活动</h2><Button size="sm" variant="ghost" aria-label="关闭项目活动" onClick={() => setProjectActivityOwner(null)}><X size={16} /></Button></header>
      <div className="my-scrollbar max-h-[70vh] space-y-3 overflow-y-auto p-4"><p className="text-my-xs text-my-tertiary">项目文件的后台记录，未归属到当前对话的任务或轮次。</p>{projectedEvents.background.length === 0 && <p className="text-my-sm text-my-secondary">当前已加载记录中没有独立的后台活动。</p>}{projectedEvents.background.map((event) => <EventRow key={event.id} item={{ type: 'trellis', key: event.id, ev: event }} pendingPerm={{}} permissionPending={{}} permissionErrors={{}} onRespond={() => {}} onOpenTask={(directory) => { setProjectActivityOwner(null); openTask(directory) }} onOpenArtifact={openRecordedArtifact} onOpenSpec={() => { setProjectActivityOwner(null); setPage('spec') }} onOpenJira={() => { setProjectActivityOwner(null); setPage('jira') }} />)}</div>
    </Modal>}
  </div>
}
