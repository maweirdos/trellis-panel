/** Page-owned ACP profiles and explicitly started project conversations. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ArrowDown, Bot, ChevronRight, CircleStop, Ellipsis, FileText, Folder, GitBranch, History, ImagePlus, Loader2, Menu, MessageSquare, Plus, RefreshCw, Search, Send, Settings2, ShieldCheck, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useApp } from '../store'
import { api, hasIpc } from '../api'
import { Button, Dropdown, DropdownItem } from '../my/ui'
import { useMy } from '../my/store'
import { useSidebarWidthStyle } from '../my/layout/SidebarResizeHandle'
import { PageContent } from '../my/layout/PageLayout'
import { projectRootKey } from '../my/navigation'
import { sameRelativeDocumentPath } from '../reader/reader-paths'
import { confirmDialog } from '../components/Dialogs'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { ConversationNavigation } from './ConversationNavigation'
import { WorkspaceInspector, type InspectorTab } from './WorkspaceInspector'
import { isDiagnosticConversation, resolveWorkspaceEntry } from './conversation-selection'
import { ConversationArtifactCard } from './ConversationArtifactCard'
import { ConversationDocumentPane } from './ConversationDocumentPane'
import { projectConversationArtifacts, type ConversationArtifact } from './artifacts'
import { ProfileEditor } from './ProfileEditor'
import { RuntimePanel, runtimeHealthLabel } from './RuntimePanel'
import { AgentRoleDetails, type RoleDetailsSection } from './AgentRoleDetails'
import { NewConversationPicker } from './NewConversationPicker'
import { isStarterRole, rolesForDisplay } from './role-presentation'
import { EventRow } from './TranscriptRow'
import { ComposerModelPicker } from './ComposerModelPicker'
import { ComposerUsageIndicator } from './ComposerUsageIndicator'
import { ImageAttachments } from './ImageAttachments'
import { useComposerImages } from './useComposerImages'
import { ConnectionNotice } from './ConnectionNotice'
import { JiraPickerModal } from './JiraPicker'
import { compileItems, isLiveStatus, mergeEvents, SESSION_LABEL } from './timeline'
import { readActiveSession, readSessionView, readWorkspaceView, writeWorkspaceView, writeActiveSession, writeSessionView, type WorkspaceView, type DraftIntent } from './view-state'
import type { AcpAgentProfile, AcpAgentStatus, AcpMaterialChange, AcpPermissionPayload, AcpSessionRecord, AcpSourceReference, AcpStartupObservation, AcpStateEvent, TimelineEvent } from '../../../shared/types'
import './workspace.css'

const STATUS_COLOR: Record<string, string> = {
  starting: 'text-my-warning-text', ready: 'text-my-tertiary', busy: 'text-my-info-text',
  awaiting_permission: 'text-my-warning-text', cancelling: 'text-my-warning-text',
  error: 'text-my-danger-text', closed: 'text-my-tertiary', disconnected: 'text-my-tertiary', legacy: 'text-my-tertiary'
}
const failureText = (error: unknown): string => error instanceof Error ? error.message : '请求失败，请重试'
const canSend = (session: AcpSessionRecord): boolean => session.status === 'ready'

export function AcpConsolePage(): JSX.Element {
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
  const [agents, setAgents] = useState<AcpAgentStatus[]>([])
  const [profiles, setProfiles] = useState<AcpAgentProfile[]>([])
  const [sessions, setSessions] = useState<AcpSessionRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [events, setEvents] = useState<Record<string, TimelineEvent[]>>({})
  const [view, setView] = useState<WorkspaceView>('agents')
  const [input, setInput] = useState('')
  const [creating, setCreating] = useState(false)
  const [sending, setSending] = useState<Record<string, boolean>>({})
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
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [inspectedProfileId, setInspectedProfileId] = useState<string | null>(null)
  const [inspectedSessionId, setInspectedSessionId] = useState<string | null>(null)
  const [roleSection, setRoleSection] = useState<RoleDetailsSection>('overview')
  const [inspectedTaskDir, setInspectedTaskDir] = useState<string | null>(null)
  const [libraryQuery, setLibraryQuery] = useState('')
  const [references, setReferences] = useState<AcpSourceReference[]>([])
  const [draftIntent, setDraftIntent] = useState<DraftIntent>('plain')
  const [draftBackup, setDraftBackup] = useState('')
  const [binding, setBinding] = useState(false)
  const [materialChanges, setMaterialChanges] = useState<AcpMaterialChange[]>([])
  const [documentTarget, setDocumentTarget] = useState<{ artifact: ConversationArtifact; sessionId: string; connectionGeneration?: string } | null>(null)
  const [documentExpanded, setDocumentExpanded] = useState(false)
  const [readableReferences, setReadableReferences] = useState<Record<string, AcpSourceReference>>({})
  const [lightweightPlan, setLightweightPlan] = useState(false)
  const [jiraOpen, setJiraOpen] = useState(false)
  const [taskDir, setTaskDir] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const streamRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const navigationRef = useRef<HTMLDivElement>(null)
  const inspectorReturnFocus = useRef<HTMLElement | null>(null)
  const documentReturnTab = useRef<InspectorTab | null>(null)
  const draftReferencesRef = useRef<Record<string, AcpSourceReference[]>>({})
  const composing = useRef(false)
  const followRef = useRef(true)
  const draftsRef = useRef<Record<string, string>>({})
  const scope = useMemo(() => ({
    root, live: true, sessionIds: new Set<string>(), states: new Map<string, AcpStateEvent>(),
    reloadSerial: 0, createPending: false, entryResolved: false, sends: new Set<string>(), permissions: new Set<string>(), actions: new Set<string>(), autoResumes: new Set<string>()
  }), [root])
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const isCurrent = useCallback((): boolean => scope.live && scopeRef.current === scope && (useApp.getState().snapshot?.meta.root ?? '') === root, [root, scope])
  const projectSessions = useMemo(() => sessions.filter((session) => root && projectRootKey(session.projectRoot) === projectRootKey(root)), [sessions, root])
  const sessionsRef = useRef(projectSessions)
  sessionsRef.current = projectSessions
  const activeSession = projectSessions.find((session) => session.sessionId === activeId) ?? null
  useLayoutEffect(() => {
    const field = composerRef.current
    if (!interactive || view !== 'conversation' || !field) return
    const resize = (): void => {
      field.style.height = 'auto'
      field.style.height = `${field.scrollHeight}px`
    }
    resize()
    let width = field.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const nextWidth = field.getBoundingClientRect().width
      if (nextWidth === width) return
      width = nextWidth
      resize()
    })
    observer.observe(field)
    return () => observer.disconnect()
  }, [input, activeId, activeSession?.status, view, interactive, fontSize])
  const composerImages = useComposerImages({ root, sessionId: view === 'conversation' ? activeId ?? undefined : undefined, generation: activeSession?.connectionGeneration, isCurrent })
  const activeSelection = useRef({ id: activeId, generation: activeSession?.connectionGeneration, view })
  activeSelection.current = { id: activeId, generation: activeSession?.connectionGeneration, view }
  const activeEvents = useMemo(() => activeSession ? events[activeSession.sessionId] ?? [] : [], [events, activeSession])
  const items = useMemo(() => compileItems(activeEvents), [activeEvents])
  const pendingPerm = useMemo(() => {
    const pending: Record<string, AcpPermissionPayload> = {}
    for (const session of projectSessions) {
      if (!isLiveStatus(session.status) || session.historyKind === 'legacy' || session.historyKind === 'transcript') continue
      for (const event of events[session.sessionId] ?? []) {
        if (event.kind !== 'permission' || !event.payload?.requestId) continue
        const requestId = String(event.payload.requestId)
        const permission = event.payload.permission as AcpPermissionPayload | undefined
        if (event.payload.pending === true && permission?.sessionId === session.sessionId && (!permission.connectionGeneration || !session.connectionGeneration || permission.connectionGeneration === session.connectionGeneration)) pending[requestId] = permission
        else delete pending[requestId]
      }
    }
    return pending
  }, [projectSessions, events])
  const boundTask = activeSession?.taskDir ? [...(snapshot?.tasks ?? []), ...(snapshot?.archived ?? [])].find((task) => task.dirName === activeSession.taskDir) ?? null : null
  const inspectorTask = inspectedTaskDir ? [...(snapshot?.tasks ?? []), ...(snapshot?.archived ?? [])].find((task) => task.dirName === inspectedTaskDir) ?? null : boundTask
  const conversationArtifacts = useMemo(() => activeSession?.taskDir ? projectConversationArtifacts({ projectRoot: root, taskDir: activeSession.taskDir, artifacts: boundTask?.artifacts ?? [], changes: materialChanges, events: activeEvents }) : [], [root, activeSession?.taskDir, boundTask, materialChanges, activeEvents])
  const inspectorArtifacts = useMemo(() => inspectorTask ? projectConversationArtifacts({ projectRoot: root, taskDir: inspectorTask.dirName, artifacts: inspectorTask.artifacts, changes: materialChanges, events: activeEvents }) : [], [root, inspectorTask, materialChanges, activeEvents])
  const projectArtifacts = useMemo(() => (snapshot?.tasks ?? []).flatMap((task) => projectConversationArtifacts({ projectRoot: root, taskDir: task.dirName, artifacts: task.artifacts, changes: materialChanges })).slice(0, 60), [root, snapshot?.tasks, materialChanges])

  const reloadSessions = useCallback(async (): Promise<void> => {
    if (!hasIpc || !root || !isCurrent()) return
    const serial = ++scope.reloadSerial
    try {
      const response = await api.acpSessions()
      if (!isCurrent() || serial !== scope.reloadSerial) return
      if (!response.ok || !response.sessions) { setLoadError(response.error ?? '会话列表加载失败'); return }
      const records = response.sessions.filter((record) => projectRootKey(record.projectRoot) === projectRootKey(root)).map((record) => {
        const state = scope.states.get(record.sessionId)
        return state ? { ...record, ...state.session, status: state.status, error: state.error } : record
      })
      for (const record of records) scope.sessionIds.add(record.sessionId)
      setSessions(records)
      setEvents((previous) => {
        const next: Record<string, TimelineEvent[]> = {}
        for (const record of records) next[record.sessionId] = mergeEvents(record.events ?? [], previous[record.sessionId] ?? [])
        for (const id of scope.sessionIds) if (!next[id] && previous[id]) next[id] = previous[id]
        return next
      })
      if (!scope.entryResolved) {
        scope.entryResolved = true
        const entry = resolveWorkspaceEntry(readWorkspaceView(root), readActiveSession(root), records)
        setActiveId(entry.activeId); setView(entry.view)
      } else setActiveId((current) => records.some((record) => record.sessionId === current) || (current && scope.sessionIds.has(current)) ? current : null)
      setLoadError('')
    } catch (error) { if (isCurrent() && serial === scope.reloadSerial) setLoadError(failureText(error)) }
  }, [root, scope, isCurrent])

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
    scope.states.set(record.sessionId, { sessionId: record.sessionId, projectRoot: record.projectRoot, status: record.status, error: record.error, connectionGeneration: record.connectionGeneration, session: record })
    setSessions((previous) => previous.some((item) => item.sessionId === record.sessionId) ? previous.map((item) => item.sessionId === record.sessionId ? record : item) : [record, ...previous])
    setEvents((previous) => ({ ...previous, [record.sessionId]: mergeEvents(record.events ?? [], previous[record.sessionId] ?? []) }))
  }, [root, scope, isCurrent])

  useEffect(() => {
    scope.live = true
    setSessions([]); setProfiles([]); setAgents([]); setEvents({}); setActiveId(readActiveSession(root)); setInput('')
    setCreating(false); setSending({}); setOperations({}); setFeedback({}); setPermissionPending({}); setPermissionErrors({}); setLoadError('')
    setJiraOpen(false); setEditor(null); setEngineSetupOpen(false); setNewConversation(null); setNewConversationError(''); setReturnToPicker(false); setInspectedSessionId(null); setRoleSection('overview'); setInspectorOpen(false); setSidebarOpen(false); setTaskDir('')
    setView('agents'); setReferences([]); setDraftIntent('plain'); setDraftBackup(''); setInspectedProfileId(null); setInspectedTaskDir(null)
    setMaterialChanges([]); setDocumentTarget(null); setDocumentExpanded(false); setReadableReferences({}); setLightweightPlan(false)
    draftsRef.current = {}; draftReferencesRef.current = {}; composing.current = false
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
      scope.sessionIds.add(state.sessionId); scope.states.set(state.sessionId, state)
      if (state.session) updateSession(state.session)
      else setSessions((previous) => previous.map((session) => session.sessionId === state.sessionId ? { ...session, status: state.status, error: state.error, connectionGeneration: state.connectionGeneration ?? session.connectionGeneration } : session))
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
      if (known?.connectionGeneration && event.connectionGeneration && known.connectionGeneration !== event.connectionGeneration) return
      if (event.session) updateSession(event.session)
      scope.states.set(event.sessionId, { ...known, ...event, projectRoot: root, session: event.session ?? (known?.session ? { ...known.session, status: event.status, error: event.error } : undefined) })
      if (scope.states.size > 64) { const oldest = scope.states.keys().next().value; if (oldest) scope.states.delete(oldest) }
      if (!scope.sessionIds.has(event.sessionId)) return
      setSessions((previous) => previous.map((session) => session.sessionId === event.sessionId ? { ...session, status: event.status, error: event.error } : session))
    })
    void reloadCatalogue(); void reloadSessions()
    return () => { scope.live = false; offOut(); offState(); offDone(); offMaterials() }
  }, [root, scope, isCurrent, reloadCatalogue, reloadSessions, updateSession])

  useLayoutEffect(() => {
    if (!activeId || !isCurrent()) return
    const saved = readSessionView(root, activeId)
    setInput(draftsRef.current[activeId] ?? saved.draft)
    setReferences(draftReferencesRef.current[activeId] ?? saved.sourceReferences ?? [])
    setDraftIntent(saved.intent ?? 'plain'); setDraftBackup(saved.draftBackup ?? '')
    followRef.current = saved.follow; setAtBottom(saved.follow)
    const element = streamRef.current
    if (element) element.scrollTop = saved.follow ? element.scrollHeight : saved.scrollTop
    writeActiveSession(root, activeId)
  }, [root, activeId, view, isCurrent])
  useLayoutEffect(() => {
    const element = streamRef.current
    if (interactive && element && followRef.current) element.scrollTop = element.scrollHeight
  }, [activeEvents, activeSession?.startup, interactive])
  const selectSession = (id: string): void => {
    const element = streamRef.current
    if (activeId && element) writeSessionView(root, activeId, { scrollTop: element.scrollTop, follow: followRef.current })
    scope.entryResolved = true
    setActiveId(id); setView('conversation'); setSidebarOpen(false); setInspectorOpen(false); setEditor(null)
    setDocumentTarget(null); setDocumentExpanded(false); setReadableReferences({})
    writeActiveSession(root, id); writeWorkspaceView(root, 'conversation')
  }
  const changeDraft = (text: string): void => {
    setInput(text)
    if (!activeId) return
    draftsRef.current[activeId] = text; writeSessionView(root, activeId, { draft: text })
  }
  const newSession = useCallback(async (agentId: string, selectedTask?: string, profileId?: string, _selectModel = false): Promise<void> => {
    if (!root || !isCurrent() || scope.createPending) return
    scope.createPending = true; setCreating(true); setNewConversationError('')
    try {
      const response = await api.acpSessionNew({ agentId, taskDir: selectedTask, profileId })
      if (!isCurrent()) return
      if (response.ok && response.sessionId) {
        scope.entryResolved = true
        scope.sessionIds.add(response.sessionId); setActiveId(response.sessionId); setView('conversation'); setSidebarOpen(false); setInspectorOpen(false); setNewConversation(null)
        setInspectorTab('agent'); setInspectedSessionId(null); setInspectedProfileId(profileId ?? null); setRoleSection('overview')
        setDocumentTarget(null); setDocumentExpanded(false); setReadableReferences({})
        writeActiveSession(root, response.sessionId); writeWorkspaceView(root, 'conversation')
        await reloadSessions()
      } else { setNewConversationError(response.error ?? '创建失败，请检查执行引擎状态。'); pushToast({ kind: 'error', title: '会话创建失败', body: response.error ?? '' }) }
    } catch (error) { if (isCurrent()) { setNewConversationError(failureText(error)); pushToast({ kind: 'error', title: '会话创建失败', body: failureText(error) }) } }
    finally { scope.createPending = false; if (isCurrent()) setCreating(false) }
  }, [root, scope, isCurrent, pushToast, reloadSessions])

  const send = useCallback(async (): Promise<void> => {
    if (!isCurrent() || !canInteract() || !activeSession || !activeId || !canSend(activeSession) || scope.sends.has(activeId) || composerImages.pending || (!input.trim() && !composerImages.images.length)) return
    const id = activeId, text = input.trim(), submittedDraft = input
    const submittedReferences = references
    const submittedImages = composerImages.images
    if (submittedImages.length && activeSession.capabilities?.promptCapabilities?.image !== true) {
      setFeedback((previous) => ({ ...previous, [id]: { error: true, text: '当前执行引擎未声明支持图片输入。草稿已保留，请切换支持图片的会话。' } })); return
    }
    if (submittedReferences.some((source) => projectRootKey(source.projectRoot) !== projectRootKey(root) || source.targetSessionId !== id || source.taskDir !== activeSession.taskDir || source.targetConnectionGeneration !== activeSession.connectionGeneration)) {
      setFeedback((previous) => ({ ...previous, [id]: { error: true, text: '引用的项目、任务或会话已变化。草稿已保留，请重新阅读并引用来源。' } })); return
    }
    scope.sends.add(id); setSending((previous) => ({ ...previous, [id]: true })); setFeedback((previous) => ({ ...previous, [id]: { error: false, text: '请求确认中，草稿暂时保留。' } }))
    try {
      const response = await api.acpSessionPrompt(id, text, { expectedConnectionGeneration: activeSession.connectionGeneration, sourceReferences: submittedReferences, images: submittedImages })
      if (!isCurrent()) return
      if (response.ok) {
        composerImages.consume(id, submittedImages)
        const latestDraft = draftsRef.current[id] ?? readSessionView(root, id).draft
        const latestReferences = draftReferencesRef.current[id] ?? readSessionView(root, id).sourceReferences ?? []
        if (latestDraft === submittedDraft && JSON.stringify(latestReferences) === JSON.stringify(submittedReferences)) {
          draftsRef.current[id] = ''; draftReferencesRef.current[id] = []; writeSessionView(root, id, { draft: '', sourceReferences: [], intent: 'plain' })
          if (readActiveSession(root) === id) { setInput(''); setReferences([]); setDraftIntent('plain') }
        }
        setFeedback((previous) => ({ ...previous, [id]: { error: false, text: '' } }))
      } else setFeedback((previous) => ({ ...previous, [id]: { error: true, text: response.reason === 'SOURCE_CHANGED' ? `引用文件已变化，尚未发送。草稿与原版本引用已保留，请查看变化后重新引用。${response.sources?.map((source) => ` ${source.relativePath}`).join('') ?? ''}` : response.error ?? '发送被拒绝，草稿已保留。' } }))
    } catch (error) { if (isCurrent()) setFeedback((previous) => ({ ...previous, [id]: { error: true, text: failureText(error) } })) }
    finally { scope.sends.delete(id); if (isCurrent()) setSending((previous) => ({ ...previous, [id]: false })) }
  }, [input, activeId, activeSession, references, root, scope, isCurrent, canInteract, composerImages])

  const sessionAction = async (action: 'cancel' | 'kill' | 'resume'): Promise<void> => {
    if (!activeSession || !isCurrent() || scope.actions.has(activeSession.sessionId)) return
    const id = activeSession.sessionId
    if (action === 'resume') scope.autoResumes.add(id)
    scope.actions.add(id); setOperations((previous) => ({ ...previous, [id]: action }))
    setFeedback((previous) => ({ ...previous, [id]: { error: false, text: action === 'resume' ? '正在连接原会话…' : '正在请求停止…' } }))
    try {
      const response = await (action === 'cancel' ? api.acpSessionCancel(id) : action === 'kill' ? api.acpSessionKill(id) : api.acpSessionResume(id))
      if (!isCurrent()) return
      setFeedback((previous) => ({ ...previous, [id]: { error: !response.ok, text: response.ok ? action === 'resume' ? '' : action === 'kill' ? '会话已停止。' : '正在中止本轮…' : response.error ?? '操作失败，可以重试。' } }))
      if (response.ok) await reloadSessions()
    } catch (error) { if (isCurrent()) setFeedback((previous) => ({ ...previous, [id]: { error: true, text: failureText(error) } })) }
    finally { scope.actions.delete(id); if (isCurrent()) setOperations((previous) => ({ ...previous, [id]: '' })) }
  }

  useEffect(() => {
    if (view !== 'conversation') return
    if (!interactive || !canInteract() || !isCurrent() || !activeSession) return
    if (scope.autoResumes.has(activeSession.sessionId)) return
    // A view switch is not retry authority. Failed loads need the visible
    // retry action; a ready owner and an explicit Stop are never restarted.
    scope.autoResumes.add(activeSession.sessionId)
    if (activeSession.canResume && !isLiveStatus(activeSession.status) && activeSession.status !== 'error') void sessionAction('resume')
  }, [interactive, view, activeSession?.sessionId, activeSession?.status, activeSession?.canResume, isCurrent, canInteract])

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
    scope.entryResolved = true; setView(next); writeWorkspaceView(root, next); setSidebarOpen(false)
    if (next !== 'conversation') setInspectorOpen(false)
  }
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
      const confirmed = await confirmDialog({ title: intent === 'implementation' ? '切换为实施授权草稿？' : intent === 'planning' ? '切换为仅规划草稿？' : '切换为文档反馈草稿？', message: '本次意图与现有草稿分开。原草稿及引用会保留，可随时恢复。此操作不会发送消息。', confirmText: '保留原稿并切换' }, interactionSignal)
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
  const inspectorSession = inspectedSessionId ? projectSessions.find((session) => session.sessionId === inspectedSessionId) : undefined
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
  const isReadOnly = Boolean(activeSession && !isLiveStatus(activeSession.status) && !activeSession.canResume)
  const historyRecords = projectSessions.filter((session) => isDiagnosticConversation(session) || session.historyKind === 'legacy')
  const customRoles = filteredProfiles.filter((item) => !isStarterRole(item))
  const starterRoles = filteredProfiles.filter(isStarterRole)
  const renderRole = (item: AcpAgentProfile): JSX.Element => {
    const engine = agents.find((agent) => (agent.runtimeId ?? agent.id) === item.runtimeId)
    return <button key={item.id} className={clsx('acp-agent-card', inspectorOpen && inspectedProfileId === item.id && !inspectedSessionId && 'is-selected')} onClick={() => openAgent(item.id)}><span className="acp-avatar"><Bot size={20} /></span><div><strong>{item.name}</strong><p>{item.description || (isStarterRole(item) ? '预置起点，可补充你的角色职责与指令' : '自定义工作角色')}</p><small>执行引擎：{engine?.name ?? item.runtimeId} · {runtimeHealthLabel(engine)}</small><small className="mt-1 block">本机私有 · 当前项目</small></div></button>
  }

  if (!root) return <div className="acp-empty text-my-sm">请先打开项目，再查看该项目的 Agent 会话。</div>
  return <div className={clsx('acp-workspace', sidebarCollapsed && !sidebarOpen && 'is-sidebar-collapsed')} style={sidebarWidthStyle}>
    <div ref={navigationRef} className={clsx('acp-navigation-host flex min-h-0 shrink-0', sidebarCollapsed && !sidebarOpen && 'is-collapsed')}><ConversationNavigation sessions={projectSessions} activeId={activeId} view={view} onView={showView} onSelect={selectSession} onNew={() => openNewConversation()} onChannels={() => setPage('channels')} collapsed={sidebarCollapsed} open={sidebarOpen} onClose={() => setSidebarOpen(false)} /></div>
    <main ref={mainRef} className="acp-main my-conversation-frame">
      <header className="acp-workspace-header">
        <Button size="sm" variant="ghost" className={clsx('acp-mobile-only acp-sidebar-toggle', sidebarCollapsed && 'is-visible')} title="展开会话侧栏" onClick={() => { if (window.innerWidth > 900) useMy.getState().toggleSidebar(); else setSidebarOpen(true) }}><Menu size={16} /></Button>
        <div className="acp-header-identity">{view === 'conversation' && activeSession ? <><MessageSquare size={16} className="shrink-0 text-my-icon-secondary" aria-hidden="true" /><strong>{activeSession.title ?? activeSession.profileSnapshot?.name ?? activeSession.agentName}</strong></> : <strong>{view === 'history' ? '历史与诊断' : '我的 Agent 角色'}</strong>}</div>
        <div className="acp-header-actions">
          {view === 'conversation' && activeSession && <>
            <span role="status" className={clsx('acp-session-status inline-flex items-center gap-1 text-my-sm', STATUS_COLOR[activeSession.status])}>{(activeSession.status === 'starting' || operations[activeSession.sessionId] === 'resume') && <Loader2 size={14} className="acp-progress-spinner" aria-hidden="true" />}{operations[activeSession.sessionId] === 'resume' ? '正在连接…' : SESSION_LABEL[activeSession.status]}</span>
            {['busy', 'awaiting_permission', 'cancelling'].includes(activeSession.status) && <Button variant="ghost" size="sm" title={activeSession.status === 'cancelling' ? '正在中止本轮' : '中止本轮'} disabled={Boolean(operations[activeSession.sessionId]) || activeSession.status === 'cancelling'} onClick={() => void sessionAction('cancel')}><CircleStop size={14} /></Button>}
          </>}
          {view === 'conversation' && activeSession && <><button type="button" className="acp-header-task my-icon-control" title={boundTask?.record?.title ?? activeSession.taskDir ?? '查看任务与材料'} aria-label="查看任务与材料" onClick={() => openTask()}><Folder size={16} /></button><button type="button" className="my-icon-control" title="会话配置与材料" aria-label="会话配置与材料" onClick={() => openAgent()}><Settings2 size={16} /></button></>}
          {view !== 'conversation' && <Button size="sm" variant="ghost" title="执行引擎与本机环境" onClick={() => { showView('agents'); setEngineSetupOpen((current) => !current) }}><Settings2 size={15} /></Button>}
          <Dropdown align="right" trigger={({ open, toggle }) => <button type="button" className="my-icon-control" aria-label="更多会话操作" aria-expanded={open} onClick={toggle}><Ellipsis size={17} /></button>}>
            {(close) => <>
              <DropdownItem icon={<RefreshCw size={14} className={loading ? 'animate-spin' : ''} />} onClick={() => { close(); void reloadSessions(); void reloadCatalogue() }}>刷新</DropdownItem>
              {view === 'conversation' && activeSession && (isLiveStatus(activeSession.status) || activeSession.restorePending) && <DropdownItem danger icon={<X size={14} />} disabled={Boolean(operations[activeSession.sessionId])} onClick={() => { close(); void sessionAction('kill') }}>结束当前会话</DropdownItem>}
            </>}
          </Dropdown>
        </div>
      </header>
      {loadError && <div role="alert" className="acp-notice">{loadError}<button className="ml-3 underline" onClick={() => { void reloadCatalogue(); void reloadSessions() }}>重试加载</button></div>}
      {view === 'agents' ? <section className="acp-catalogue my-scrollbar"><PageContent variant="centered">
        <div className="acp-catalogue-heading"><div><h1>我的 Agent 角色</h1><p className="mt-1 text-my-sm text-my-secondary">定义产品助手、研发助手等工作角色，再选择 Codex 或 Claude Code 为它执行。</p></div><Button size="sm" variant="outline" onClick={() => openNewConversation()}><MessageSquare size={14} />新建会话</Button><Button size="sm" variant="primary" disabled={!hasIpc} onClick={() => createProfile()}><Plus size={14} />创建角色</Button></div>
        <ol className="acp-onboarding" aria-label="开始使用 Agent"><li><button onClick={() => setEngineSetupOpen(true)}><span>1</span><strong>配置执行引擎</strong><small>安装、登录与本机环境</small></button></li><li><button onClick={() => createProfile()}><span>2</span><strong>创建工作角色</strong><small>名称、职责与工作指令</small></button></li><li><button onClick={() => openNewConversation()}><span>3</span><strong>选择角色开始会话</strong><small>明确连接后再选择模型</small></button></li></ol>
        {engineSetupOpen && <section className="acp-library-engines"><div className="mb-3 flex items-center gap-2"><h2 className="min-w-0 flex-1 text-my-sm font-medium text-my-primary">执行引擎与本机环境</h2><Button size="sm" variant="ghost" title="收起本机环境" onClick={() => setEngineSetupOpen(false)}><X size={14} /></Button></div><RuntimePanel agents={agents} onChange={setAgents} isCurrent={isCurrent} /><Button size="sm" variant="ghost" className="mt-3" onClick={() => setPage('settings')}>管理自定义执行命令</Button></section>}
        <div className="acp-catalogue-tools"><span>本机私有 · 当前项目 · {profiles.filter((item) => !isStarterRole(item)).length} 个自定义角色</span><div className="flex-1" /><label className="flex min-w-0 items-center gap-2"><Search size={14} /><input className="my-input min-w-0 max-w-44" aria-label="搜索已加载的角色" value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="搜索角色名称或职责" /></label></div>
        <div className="acp-agent-grid">{customRoles.map(renderRole)}</div>
        {customRoles.length === 0 && <div className="acp-role-empty"><Bot size={24} /><div><strong>{loading ? '正在加载角色…' : libraryQuery ? '没有匹配的自定义角色' : '创建属于你的第一个角色'}</strong><p>{libraryQuery ? '可以修改搜索内容，或查看下方的预置起点。' : '执行引擎只负责运行。把角色的职责、工作边界与输出要求保存在这里，下次可以直接复用。'}</p></div><Button size="sm" variant="primary" disabled={!hasIpc} onClick={() => createProfile()}>创建角色</Button></div>}
        {starterRoles.length > 0 && <details className="acp-starter-roles" open={customRoles.length === 0}><summary>预置起点 · 保留已有配置和历史会话</summary><p className="mb-3 mt-2 text-my-sm text-my-tertiary">这些是原有的预置角色，可继续使用，也可编辑名称和指令形成自己的工作角色。</p><div className="acp-agent-grid">{starterRoles.map(renderRole)}</div></details>}
        <details className="mt-8 border-t border-my-line pt-4 text-my-sm text-my-tertiary"><summary className="cursor-pointer">Jira 工单与已有对话</summary><div className="mt-3 flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={() => openNewConversation()}>选择角色新建会话</Button><Button size="sm" variant="ghost" onClick={() => setJiraOpen(true)}><GitBranch size={13} />从 Jira 选工单开始</Button></div></details>
      </PageContent></section> : view === 'history' ? <section className="acp-catalogue my-scrollbar"><PageContent variant="centered"><h1>历史与诊断记录</h1><p className="mb-5 mt-2 text-my-sm text-my-secondary">旧版与开发诊断记录保留供阅读。打开记录不会启动执行引擎。</p>{historyRecords.map((session) => <button className="acp-recent-row" key={session.sessionId} data-acp-session={session.sessionId} onClick={() => selectSession(session.sessionId)}><History size={14} /><span>{session.title ?? `${session.agentName} 会话`}</span></button>)}{historyRecords.length === 0 && <p className="text-my-sm text-my-tertiary">暂无旧版或诊断记录</p>}</PageContent></section> : !activeSession ? <div className="acp-empty"><MessageSquare size={25} className="mx-auto" /><p>选择最近会话，或选择 Agent 开始新对话。</p><Button variant="outline" onClick={() => openNewConversation()}>选择角色新建会话</Button></div> : <section className="acp-content">
        <div ref={streamRef} className="acp-transcript my-scrollbar" onScroll={(event) => {
          const element = event.currentTarget, follow = element.scrollHeight - element.scrollTop - element.clientHeight < 48
          followRef.current = follow; setAtBottom(follow); writeSessionView(root, activeSession.sessionId, { scrollTop: element.scrollTop, follow })
        }}><div className="acp-transcript-content my-conversation-column acp-chat-copy">
          {activeSession.directoryLeaseReason && <p className="rounded-my-md bg-my-warning-subtle px-3 py-2 text-my-sm text-my-warning-text">目录占用：{activeSession.directoryLeaseReason}</p>}
          {isReadOnly && <div className="acp-history-note"><p>此记录没有可恢复的远端会话，仅供阅读。</p><Button size="sm" variant="ghost" onClick={() => openNewConversation()}>新建会话</Button>{activeSession.error && <ConnectionNotice message={activeSession.error} />}</div>}
          {items.map((item) => <EventRow key={item.key} item={item} session={activeSession} events={activeEvents} pendingPerm={pendingPerm} permissionPending={permissionPending} permissionErrors={permissionErrors} onRespond={respondPerm} onOpenTask={(directory) => openTask(directory)} onOpenArtifact={(file) => {
            const artifact = [...conversationArtifacts, ...projectArtifacts].find((candidate) => projectRootKey(`${root}/${candidate.relativePath}`) === projectRootKey(file.path))
            if (artifact) openDocument(artifact)
            else pushToast({ kind: 'info', title: '正在核对任务材料', body: '该路径尚未出现在当前任务的可验证材料清单，请刷新后从任务详情阅读。' })
          }} onOpenSpec={() => setPage('spec')} onOpenJira={() => setPage('jira')} />)}
          {conversationArtifacts.length > 0 && <section className="acp-material-shelf" aria-label="当前任务材料"><p className="mb-3 text-my-sm text-my-tertiary">任务材料 · 当前文件，文件变化不代表任务已验收</p><div className="space-y-2">{conversationArtifacts.slice(0, 6).map((artifact) => <ConversationArtifactCard key={artifact.relativePath} artifact={artifact} onOpen={openDocument} selected={documentTarget?.artifact.relativePath === artifact.relativePath && inspectorTab === 'document' && inspectorOpen} />)}</div><div className="mt-4 flex flex-wrap items-center gap-3 text-my-sm text-my-tertiary"><button onClick={preparePlanning}>继续完善方案<ChevronRight size={12} className="ml-1 inline" /></button><button onClick={() => openTask()}>复核规划材料<ChevronRight size={12} className="ml-1 inline" /></button></div></section>}
          {items.length === 0 && !isReadOnly && <div className="acp-empty"><Bot size={25} className="mx-auto" /><p>{activeSession.status === 'starting' ? '正在准备环境，就绪后可以下达指令。' : '从一条清晰的指令开始。'}</p></div>}
        </div></div>
        {!atBottom && <div className="flex justify-center"><Button size="sm" variant="outline" onClick={() => { const element = streamRef.current; followRef.current = true; setAtBottom(true); if (element) element.scrollTop = element.scrollHeight; writeSessionView(root, activeSession.sessionId, { follow: true }) }}><ArrowDown size={12} />回到最新</Button></div>}
        {!isReadOnly && <footer className="acp-composer-region my-conversation-column">
          {(feedback[activeSession.sessionId]?.error || activeSession.error) && <ConnectionNotice message={feedback[activeSession.sessionId]?.error ? feedback[activeSession.sessionId].text : activeSession.error ?? ''} />}
          {activeSession.canResume && !isLiveStatus(activeSession.status) && operations[activeSession.sessionId] !== 'resume' && <div className="acp-reconnect-status" role="status">连接尚未就绪<Button size="sm" variant="ghost" onClick={() => void sessionAction('resume')}>重试连接</Button></div>}
          <div className={clsx('acp-composer', composerImages.dragging && 'acp-composer-dragging')} {...composerImages.dragHandlers} onPaste={composerImages.onPaste}>
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
            <textarea ref={composerRef} aria-label="Agent 指令" title="Enter 发送 · Shift Enter 换行" rows={2} value={input} placeholder={canSend(activeSession) ? '告诉我你的想法，或引用文档中的内容…' : '可先准备下一条草稿，就绪后手动发送'} onChange={(event) => changeDraft(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send() } }} />
            <div className="acp-composer-toolbar"><ComposerModelPicker key={`${activeSession.sessionId}:${activeSession.connectionGeneration}`} session={activeSession} isCurrent={() => isCurrent() && canInteract() && activeSelection.current.view === 'conversation' && activeSelection.current.id === activeSession.sessionId && activeSelection.current.generation === activeSession.connectionGeneration} onUpdated={updateSession} contextActions={(close) => <><button type="button" className="acp-add-action" onClick={() => { close(); composerImages.choose() }}><ImagePlus size={14} /><span>添加图片</span></button><button type="button" className="acp-add-action" onClick={() => { close(); openTask() }}><Folder size={14} /><span>{activeSession.taskDir ? '查看关联任务与材料' : '关联任务'}</span></button></>} usage={<ComposerUsageIndicator session={activeSession} events={activeEvents} />} sendAction={<Button variant="primary" size="sm" title="发送指令" disabled={!canSend(activeSession) || Boolean(sending[activeSession.sessionId]) || composerImages.pending || (!input.trim() && !composerImages.images.length)} onClick={() => void send()}>{sending[activeSession.sessionId] ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}</Button>} /></div>
          </div>
        </footer>}
        {activeSession.historyKind === 'live' && activeSession.status === 'error' && <div className="px-6 pb-4"><Button variant="outline" size="sm" title="停止当前会话及其拥有的进程" disabled={Boolean(operations[activeSession.sessionId])} onClick={() => void sessionAction('kill')}>停止会话进程</Button></div>}
      </section>}
    </main>
    <WorkspaceInspector open={inspectorOpen} tab={inspectorTab} onTab={setInspectorTab} onClose={inspectorTab === 'document' ? closeDocument : closeInspector} expanded={documentExpanded && inspectorTab === 'document'} hasDocument={documentTarget !== null} returnFocusRef={inspectorReturnFocus} backgroundRefs={[mainRef, navigationRef]}>
      <div hidden={inspectorTab !== 'agent'} className="acp-inspector-body my-scrollbar">
        {editor ? <ProfileEditor inline key={editor.id} initial={editor} isNew={!profiles.some((item) => item.id === editor.id)} agents={agents} root={root} isCurrent={isCurrent} onAgentsChange={setAgents} onClose={() => { setEditor(null); if (returnToPicker) { setReturnToPicker(false); openNewConversation() } }} onSaved={(saved) => {
          setProfiles((previous) => [...previous.filter((item) => item.id !== saved.id), saved]); setEditor(null); setInspectedProfileId(saved.id); setInspectedSessionId(null)
          pushToast({ kind: 'success', title: '角色已保存', body: '角色默认配置仅保存在本机，新会话会使用这份配置。' })
          if (returnToPicker) { setReturnToPicker(false); openNewConversation(saved.id) }
        }} onDeleted={(id) => { setProfiles((previous) => previous.filter((item) => item.id !== id)); setEditor(null); setInspectorOpen(false); setReturnToPicker(false) }} /> : <AgentRoleDetails profile={profile} currentProfile={currentProfile} session={inspectorSession} recentSession={profileSessions[0]} agents={agents} root={root} section={roleSection} onSection={setRoleSection} isCurrent={isCurrent} onAgentsChange={setAgents} onUpdated={updateSession} onNew={openNewConversation} onContinue={(id) => {
          if (id === activeSession?.sessionId && view === 'conversation') { setInspectorOpen(false); requestAnimationFrame(() => { if (canInteract()) composerRef.current?.focus() }) }
          else selectSession(id)
        }} onEdit={(selected) => editProfile(selected)} onKnowledge={() => setPage('knowledge')} onSpec={() => setPage('spec')} />}
      </div>
      <div hidden={inspectorTab !== 'task'} className="acp-inspector-body my-scrollbar"><h2 data-inspector-focus tabIndex={-1}>{inspectorTask?.record?.title ?? inspectedTaskDir ?? activeSession?.taskDir ?? '任务上下文'}</h2><p className="acp-inspector-description">任务关联用于后续材料组装。历史消息和材料保留原始归属。</p>
        {activeSession && <><label className="block text-my-sm text-my-secondary">选择当前项目任务<select aria-label="会话关联任务" className="my-input mt-2 w-full" value={taskDir} onChange={(event) => setTaskDir(event.target.value)}><option value="">不关联任务</option>{snapshot?.tasks.map((task) => <option value={task.dirName} key={task.dirName}>{task.record?.title ?? task.dirName}</option>)}</select></label><Button size="sm" variant="outline" className="mt-3" disabled={binding || activeSession.status !== 'ready' || !activeSession.connectionGeneration || taskDir === (activeSession.taskDir ?? '')} onClick={() => void bindTask()}>{binding ? '关联中…' : '明确关联此任务'}</Button>{activeSession.status !== 'ready' && <p className="mt-2 text-my-sm text-my-tertiary">需要就绪的空闲会话，运行期间不会排队修改关联。</p>}</>}
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
    {jiraOpen && <JiraPickerModal isCurrent={isCurrent} onClose={() => setJiraOpen(false)} onStarted={(id) => { if (!isCurrent()) return; scope.sessionIds.add(id); setJiraOpen(false); selectSession(id); void reloadSessions() }} />}
  </div>
}
