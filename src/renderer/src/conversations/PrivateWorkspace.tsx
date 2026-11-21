import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { ChevronDown, Files, Folder, MessageSquare, MoreHorizontal, MousePointer2, RefreshCw, Loader2, Users, X } from 'lucide-react'
import type { RequirementDocument, RequirementView } from '@shared/conversation-requirements'
import type { CruxTask } from '@shared/crux'
import { lastRequirementId } from './requirement-workbench/reading-position'
import { NewTaskModal, type NewTaskModalProps } from '../crux/pages/TaskCreateModal'
import { ConversationTaskAction, ConversationTaskReceipt } from './ConversationTaskAction'
import { useTaskSuggestionPort } from './useTaskSuggestionPort'
import { ConversationTaskLayout, type TaskPane } from './ConversationTaskLayout'
import type { TeamHandoffFeedback } from './requirement-workbench/Workbench'
import { canReadTaskSpace } from '../crux/pages/task-detail/use-task-source'
import { readTaskHandoffRecovery } from '../crux/pages/task-detail/task-handoff-source'
import { consumeTaskConversationIntent, useTaskConversationIntent } from './task-navigation'
import { conversationTeamHandoff } from './team-handoff'
import { shareRequirementVersion } from './requirement-workbench/task-sharing'
import type { Conversation } from '@shared/private-conversations'
import type { PiWebPreviewArtifact } from '@shared/pi-web-preview'
import { Button, Dropdown, DropdownHeader, DropdownItem, Modal } from '../my/ui'
import { useSidebarWidthStyle } from '../my/layout/SidebarResizeHandle'
import { ContextRegion } from '../my/layout/ContextRegion'
import { useMy } from '../my/store'
import { useCrux } from '../crux/store'
import { useApp } from '../store'
import { useEscLayer } from '../utils/use-esc-layer'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { sameTranscriptOwner } from '../acp/conversation-transcript'
import { ConversationArchive } from './Archive'
import { PrivateConversation } from './Conversation'
import { ConversationFiles } from './Files'
import { ConversationHistory } from './History'
import { ConversationKnowledgeMenu } from './KnowledgeMenu'
import { ConversationHomeActions } from './HomeActions'
import { ConversationRequirementMenu, useRequirementSummaries } from './RequirementMenu'
import { ConversationWorkspaceHeader } from '../acp/ConversationWorkspaceHeader'
import { ConversationPreviewLayout } from '../acp/ConversationPreviewLayout'
import { ConversationPreviewTabs } from '../acp/ConversationPreviewTabs'
import { usePiWebPreviewShelf } from '../acp/PiWebPreviewShelf'
import { CodePreviewProvider, type OpenCodePreview } from '../components/CodePreviewContext'
import { DesignWorkspace } from '../designs/DesignWorkspace'
import { ConversationDesignCards } from '../designs/DesignLibrary'
import { useConversationDesigns } from '../designs/hooks'
import { sendDesignMessage, usePendingDesignSend, type DesignConversationReference } from '../designs/conversation'
import { useDesignNavigation } from '../designs/navigation'
import type { DesignSelection } from '@shared/design-workspace'
import type { RequirementBuildPreparation } from './requirement-workbench/useRequirementWorkbench'
import { requirementIntent, requirementIntentCommandId, type RequirementSeed } from './requirement-intent'
import type { RequirementBuildChoice } from './requirement-workbench/BuildPreparation'
import { DocumentSourceProvider } from '../reader/document-source'
import { MarkdownView } from '../components/MarkdownView'
import { ConnectionNotice } from '../acp/ConnectionNotice'
import { isPrivateEntrySelected, usePrivateDocumentSource, type PrivateDocumentPreview } from './source'
import { conversationClient, conversationError, conversationValue } from './client'
import { addFiles, sendMessage, sendTaskWorkRequest, ensureConversation, baseScopeKey, controlConversation, ensureScope, newDraft, readConversation, reclassifyConversation, refreshFiles, refreshWorkspace, requestComposerFocus, scopeKey, selectConversation, selectProjectScope, useConversations, type ConversationKind, type WorkspaceEntry } from './workspace'
import '../acp/workspace.css'
import './workspace.css'

const loadRequirementWorkbench = () => import('./requirement-workbench/Workbench')
const RequirementWorkbench = lazy(loadRequirementWorkbench)
const EmbeddedTaskPost = lazy(() => import('../crux/pages/TaskDetailDrawer').then(module => ({ default: module.EmbeddedTaskPost })))
const RequirementExecutionFlow = lazy(() => import('./requirement-workbench/ExecutionFlow').then(module => ({ default: module.RequirementExecutionFlow })))
const BuildPreparation = lazy(() => import('./requirement-workbench/BuildPreparation').then(module => ({ default: module.BuildPreparation })))
type RequirementSelection = { id?: string; commandId: string; seed?: RequirementSeed; document?: RequirementDocument }
const retainedRequirements = new Map<string, RequirementSelection>()
const buildAgentKey = (creatorId: string, conversationId: string, draftId: string): string => `tpanel.requirement-build-agent.v1.${encodeURIComponent(creatorId)}.${conversationId}.${draftId}`
function readBuildAgent(creatorId: string, conversationId: string, draftId: string, planRevision?: string): string | undefined {
  try {
    const raw = localStorage.getItem(buildAgentKey(creatorId, conversationId, draftId))
    const value: unknown = raw ? JSON.parse(raw) : null
    if (!value || typeof value !== 'object' || !('agentId' in value) || !('planRevision' in value)) return undefined
    return typeof value.agentId === 'string' && /^[\w.-]{1,100}$/.test(value.agentId) && value.planRevision === planRevision ? value.agentId : undefined
  } catch { return undefined }
}

export function PrivateWorkspace(): JSX.Element {
  const selected = useConversations((state) => state.selected), entries = useConversations((state) => state.entries), projects = useConversations((state) => state.projects)
  const projectScopes = useConversations((state) => state.projectScopes), storageError = useConversations((state) => state.storageError)
  const archives = useConversations((state) => state.archives)
  const shellView = useMy((state) => state.shellView), collapsed = useMy((state) => state.sidebarCollapsed)
  const style = useSidebarWidthStyle(), active = useInteractionActive(), canInteract = useInteractionGuard()
  const kind: ConversationKind = shellView === 'development' ? 'code' : 'work', projectId = projectScopes[baseScopeKey(kind)] ?? undefined, scope = scopeKey(kind, projectId)
  const selection = selected[scope] ?? '', current = entries[selection], archiveId = selection.startsWith('archive:') ? selection.slice(8) : null
  const [mobileHistory, setMobileHistory] = useState(false), [fileOwner, setFileOwner] = useState<string | null>(null)
  const [newPending, setNewPending] = useState(false), [error, setError] = useState('')
  const [requirement, setRequirement] = useState<RequirementSelection & { entryKey: string } | null>(null)
  const currentRequirement = useRef(requirement)
  currentRequirement.current = requirement
  const [execution, setExecution] = useState<{ entryKey: string; draftId: string; agentId?: string } | null>(null)
  const [buildPreparation, setBuildPreparation] = useState<{ entryKey: string; request: RequirementBuildPreparation; creatorId: string; conversationId: string } | null>(null)
  const buildCompletion = useRef<{ resolve(value: RequirementBuildChoice | null): void; reject(reason: Error): void } | null>(null)
  const [requirementOpening, setRequirementOpening] = useState(false)
  const requirementRequest = useRef<symbol | null>(null)
  const [documentsOwner, setDocumentsOwner] = useState('')
  const documentsOpen = Boolean(selection && documentsOwner === selection)
  const [taskAction, setTaskAction] = useState<{ owner: string; mode: 'create' | 'bind' }>()
  const [receiptRevision, refreshReceipt] = useState(0)
  const requirementSummaries = useRequirementSummaries(current, active && !archiveId && !current?.locked)
  const historyButton = useRef<HTMLButtonElement>(null), wasActive = useRef(false)
  const directoryRequest = useRef<symbol | null>(null)
  const operationOwner = JSON.stringify([scope, selection]), currentOperationOwner = useRef(operationOwner)
  currentOperationOwner.current = operationOwner
  const teamContext = useCrux(state => state.workspaceContext)
  const teamOwner = JSON.stringify([operationOwner, teamContext.key, teamContext.actorId, teamContext.instanceId, teamContext.epoch, current?.owner, current?.conversation?.creatorId, current?.conversation?.id, current?.conversation?.workspace.root])
  const currentTeamOwner = useRef(teamOwner); currentTeamOwner.current = teamOwner
  const boundTask = useCrux(state => (current?.conversation && !current.locked
    ? state.snapshot?.tasks.find(task =>
      canReadTaskSpace(state.snapshot!, state.workspaceContext, task.spaceId) &&
      task.conversations?.some(link => link.id === current.conversation?.id && link.actorId === state.workspaceContext.actorId))
    : undefined) ?? null)
  const taskOwner = JSON.stringify([teamOwner, teamContext.key, teamContext.actorId, teamContext.instanceId, teamContext.epoch, teamContext.authorizationRevision, boundTask?.spaceId, boundTask?.id, boundTask?.createdAt])
  const receiptOwner = JSON.stringify([teamOwner, teamContext.key, teamContext.actorId, teamContext.instanceId, teamContext.epoch])
  const taskIntent = useTaskConversationIntent()
  const [reader, setReader] = useState<{ owner: string; activation: number; origin?: NonNullable<typeof taskIntent> }>()
  const [pane, setPane] = useState<TaskPane>('task')
  const readerTrigger = useRef<HTMLElement | null>(null)
  const readerOpen = Boolean(active && !archiveId && boundTask && reader?.owner === taskOwner)
  const openBoundTask = (taskId: string) => {
    if (taskId !== boundTask?.id || !canInteract() || !isPrivateEntrySelected(selection)) return
    readerTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPane('task')
    setReader(last => ({ owner: taskOwner, origin: last?.owner === taskOwner ? last.origin : undefined, activation: (last?.activation ?? 0) + 1 }))
  }
  const closeBoundTask = () => {
    setReader(undefined)
    const target = readerTrigger.current
    requestAnimationFrame(() => {
      if (!canInteract() || !isPrivateEntrySelected(selection)) return
      if (target?.isConnected) target.focus({ preventScroll: true })
      else requestComposerFocus(selection)
    })
  }
  const [documentPreview, setDocumentPreview] = useState<PrivateDocumentPreview | null>(null)
  const returnToTask = readerOpen && reader?.origin && reader.origin.originPage !== 'chat' ? () => {
    const origin = reader.origin!
    if (!canInteract() || !isPrivateEntrySelected(selection)) return
    setReader(undefined)
    useMy.getState().setShellView(origin.originShell)
    useCrux.getState().openTask(origin.taskId)
    useApp.getState().setPage(origin.originPage)
  } : undefined
  const documentSource = usePrivateDocumentSource(selection, document => { setFileOwner(null); setDocumentPreview(document) })
  useEffect(() => { setDocumentPreview(null) }, [selection, current?.owner, current?.session?.connectionGeneration, active])
  const preview = usePiWebPreviewShelf({ root: current?.conversation?.workspace.root ?? '', session: current?.locked ? null : current?.session ?? null, events: current?.events ?? [], enabled: active && !archiveId && !current?.locked, isCurrent: documentSource.isCurrent, onAutoOpen: () => setMobileHistory(false) })
  const designs = useConversationDesigns(current, active && !archiveId && !current?.locked)
  const [designReference, setDesignReference] = useState<{ owner: string; reference: DesignConversationReference } | null>(null)
  const [designRestore, setDesignRestore] = useState<{ owner: string; selection: DesignSelection } | null>(null)
  const designTarget = useDesignNavigation(state => state.conversationTarget)
  const consumedDesignTarget = useRef('')
  const currentDesignReference = designReference?.owner === designs.ownerKey ? designReference.reference : null
  const [teamHandoff, setTeamHandoff] = useState<{ owner: string; value: NonNullable<NewTaskModalProps['handoff']> }>()
  const [teamHandoffFeedback, setTeamHandoffFeedback] = useState<{ owner: string; value: TeamHandoffFeedback } | null>(null)
  const teamHandoffRequest = useRef<symbol>()
  const teamHandoffFocus = useRef<{ owner: string; element: HTMLElement | null }>()
  const conversationMore = useRef<HTMLButtonElement>(null)
  const pendingDesignSend = usePendingDesignSend(selection, current?.owner)
  const sendReference = pendingDesignSend?.reference ?? currentDesignReference
  const activeDesign = designs.documents.find(document => document.id === designs.selectedId)
  const canShowDesign = Boolean(activeDesign && !current?.locked)
  const canShowWeb = Boolean(preview.tabs.length > 0 && current?.session && !current.locked)
  const previewOwner = JSON.stringify([designs.ownerKey, preview.ownerKey])
  const lastPreview = useRef(new Map<string, 'design' | 'web'>())
  const previewKind = canShowDesign && !designs.collapsed ? 'design'
    : canShowWeb && !preview.collapsed ? 'web'
      : lastPreview.current.get(previewOwner) === 'web' && canShowWeb ? 'web'
        : canShowDesign ? 'design' : canShowWeb ? 'web' : null
  useLayoutEffect(() => {
    if (previewKind && (previewKind === 'design' ? !designs.collapsed : !preview.collapsed)) {
      lastPreview.current.set(previewOwner, previewKind)
    }
  }, [previewOwner, previewKind, designs.collapsed, preview.collapsed])
  const setPreviewCollapsed = (value: boolean): void => {
    if (previewKind === 'design') {
      designs.setCollapsed(value)
      // A new design can arrive while a web preview is already open behind it.
      if (value && canShowWeb && !preview.collapsed) preview.closeWebPreview()
    } else if (previewKind === 'web') preview.setCollapsed(value)
  }
  useEffect(() => {
    if (!active || !designTarget || current?.conversation?.id !== designTarget.conversationId || consumedDesignTarget.current === designTarget.token) return
    const document = designs.documents.find(document => document.id === designTarget.documentId)
    if (!document) return
    consumedDesignTarget.current = designTarget.token
    setReader(undefined); setRequirement(null); setTeamHandoffFeedback(null)
    preview.closeWebPreview(); designs.open(document.id, designTarget.candidateId)
    if (designTarget.selection) setDesignRestore({ owner: designs.ownerKey, selection: designTarget.selection })
    else if (!designTarget.candidateId) setDesignReference({ owner: designs.ownerKey, reference: { documentId: document.id, revision: document.revision, title: document.title } })
    useDesignNavigation.setState({ conversationTarget: null })
  }, [active, current?.conversation?.id, designTarget, designs.documents])
  useEscLayer(mobileHistory, { kind: 'overlay', id: 'private-history', onClose: () => setMobileHistory(false), returnFocusRef: historyButton })
  useLayoutEffect(() => { ensureScope(kind, projectId) }, [scope])
  useEffect(() => { buildCompletion.current?.resolve(null); buildCompletion.current = null; setBuildPreparation(null); setMobileHistory(false); setFileOwner(null); setExecution(null); setError('') }, [scope, selection])
  useEffect(() => () => { buildCompletion.current?.resolve(null); buildCompletion.current = null }, [])
  const requirementOwner = JSON.stringify([current?.owner, selection])
  useEffect(() => {
    setRequirement(null); setDocumentsOwner(''); setTaskAction(undefined); setReader(undefined); setTeamHandoffFeedback(null)
  }, [requirementOwner])
  useEffect(() => {
    if (!active || !taskIntent || current?.conversation?.id !== taskIntent.conversationId ||
      boundTask?.id !== taskIntent.taskId || boundTask?.createdAt !== taskIntent.taskCreatedAt ||
      teamContext.key !== taskIntent.workspaceKey || teamContext.actorId !== taskIntent.teamActorId ||
      !consumeTaskConversationIntent(taskIntent.token)) return
    setRequirement(null)
    setPane('chat')
    if (taskIntent.canvas) {
      setReader(undefined)
      useDesignNavigation.setState({ conversationTarget: { conversationId: taskIntent.conversationId, token: taskIntent.token, ...taskIntent.canvas } })
      return
    }
    setReader({ owner: taskOwner, activation: 0, origin: taskIntent })
    requestComposerFocus(selection)
    if (taskIntent.request) {
      const stillSelected = () => canInteract() && useApp.getState().page === 'chat' && currentTeamOwner.current === teamOwner && isPrivateEntrySelected(selection)
      void sendTaskWorkRequest(selection, taskIntent.request, {
        workspaceKey: taskIntent.workspaceKey, spaceId: taskIntent.spaceId, taskId: taskIntent.taskId,
        taskCreatedAt: taskIntent.taskCreatedAt, expectedUpdatedAt: taskIntent.expectedUpdatedAt, actorId: taskIntent.teamActorId,
        epoch: teamContext.epoch, design: taskIntent.design
      }, stillSelected).catch(cause => { if (stillSelected()) setError(conversationError(cause)) })
    }
  }, [active, taskIntent, taskOwner, current?.conversation?.id, boundTask, selection])
  useEffect(() => {
    if (active && current?.conversation && !useCrux.getState().snapshot) void useCrux.getState().bootstrap()
  }, [active, current?.conversation?.id])
  useEffect(() => {
    if (active && !wasActive.current) void refreshWorkspace()
    wasActive.current = active
  }, [active])
  const title = archiveId ? archives.find((item) => item.id === archiveId)?.title ?? '旧问答归档' : current?.locked ? '原会话当前不可访问' : current?.conversation?.title ?? '新对话'
  const openFiles = (): void => { if (canInteract()) setFileOwner(selection) }
  const canImportFiles = (value: WorkspaceEntry | undefined): boolean => {
    const client = conversationClient()
    return Boolean(client && typeof client.pickFiles === 'function' && typeof client.createDraft === 'function' && value?.loaded && !value.locked && !value.action && value.conversation?.archivedAt === undefined && !['transcript', 'legacy'].includes(value.session?.historyKind ?? '') && (value.kind !== 'code' || value.directory || value.conversation?.workspace.kind === 'directory'))
  }
  const importFiles = (): void => {
    if (!canInteract() || !isPrivateEntrySelected(selection) || !canImportFiles(useConversations.getState().entries[selection])) return
    void addFiles(selection)
  }
  const startNew = (destinationProjectId = projectId): void => {
    if (!canInteract() || newPending) return
    newDraft(kind, destinationProjectId); setMobileHistory(false)
  }
  const startCodeDirectory = async (): Promise<void> => {
    if (!canInteract() || directoryRequest.current || kind !== 'code') return
    const client = conversationClient()
    if (!client) return
    const ticket = Symbol('directory')
    directoryRequest.current = ticket
    setNewPending(true); setError('')
    try {
      const directory = conversationValue(await client.pickDirectory())
      const state = useConversations.getState()
      if (!directory || !canInteract() || currentOperationOwner.current !== operationOwner || state.selected[scope] !== selection || (state.projectScopes[baseScopeKey(kind)] ?? undefined) !== projectId || state.entries[selection]?.owner !== current?.owner || useMy.getState().shellView !== shellView) return
      newDraft('code', projectId, directory); setMobileHistory(false)
    } catch (cause) { if (canInteract() && currentOperationOwner.current === operationOwner) setError(conversationError(cause)) }
    finally { if (directoryRequest.current === ticket) { directoryRequest.current = null; setNewPending(false) } }
  }
  const choose = (conversation: Conversation): void => {
    if (!canInteract()) return
    selectConversation(conversation); useMy.getState().setShellView(conversation.kind === 'code' ? 'development' : 'collaboration'); setMobileHistory(false)
  }
  const shareDocument = async (requirement: RequirementView, trigger?: HTMLButtonElement, task?: CruxTask): Promise<void> => {
    if (!canInteract() || !current?.conversation || !isPrivateEntrySelected(selection) || teamHandoffRequest.current) return
    const ticket = Symbol('team-handoff'), owner = currentTeamOwner.current, key = selection
    teamHandoffRequest.current = ticket
    teamHandoffFocus.current = { owner, element: trigger ?? conversationMore.current }
    try {
      setTeamHandoffFeedback({ owner, value: { state: 'working', message: task ? `正在共享到〈${task.id}〉…` : '正在共享团队任务…' } })
      const seed = await conversationTeamHandoff(current, requirement)
      if (!canInteract() || currentTeamOwner.current !== owner || !isPrivateEntrySelected(key)) return
      const recovery = readTaskHandoffRecovery(seed)
      if (task?.handoff && recovery?.intent && recovery.source.id === task.handoff.id && recovery.authorityIdentity === teamContext.actorId) {
        setTeamHandoffFeedback(null)
        setTeamHandoff({ owner, value: recovery.source })
        return
      }
      if (task) {
        const result = await shareRequirementVersion(current, requirement, { task, conversationId: current.conversation.id, creatorId: current.conversation.creatorId })
        if (!canInteract() || currentTeamOwner.current !== owner || !isPrivateEntrySelected(key)) return
        setTeamHandoffFeedback({
          owner,
          value: result.state === 'created' ? { state: 'created', taskId: result.taskId, message: `已共享到 ${result.taskId} · ${requirement.draft.title}` } : result
        })
        return
      }
      setTeamHandoffFeedback(null)
      if (canInteract() && currentTeamOwner.current === owner && isPrivateEntrySelected(key)) setTeamHandoff({ owner, value: seed })
    } catch (cause) {
      if (canInteract() && currentTeamOwner.current === owner) {
        if (task) setTeamHandoffFeedback({ owner, value: { state: 'failed', message: conversationError(cause) } })
        else setError(conversationError(cause))
      }
    }
    finally { if (teamHandoffRequest.current === ticket) { teamHandoffRequest.current = undefined } }
  }
  const closeTeamHandoff = (): void => {
    setTeamHandoff(undefined)
    requestAnimationFrame(() => {
      const target = teamHandoffFocus.current
      if (canInteract() && target?.owner === currentTeamOwner.current && target.element?.isConnected) target.element.focus({ preventScroll: true })
    })
  }
  const openRequirement = (id?: string, seed?: RequirementSeed, document?: RequirementDocument): void => {
    if (!canInteract() || requirementRequest.current || !current || current.locked || current.conversation?.archivedAt !== undefined || current.kind === 'code' && !current.conversation && !current.directory || !isPrivateEntrySelected(selection)) return
    const ticket = Symbol('requirement')
    requirementRequest.current = ticket; setRequirementOpening(true)
    void loadRequirementWorkbench().then(async () => {
      if (!canInteract() || !isPrivateEntrySelected(selection) || currentOperationOwner.current !== operationOwner) return
      const originalConversation = seed ? await ensureConversation(selection) : undefined
      if (seed && originalConversation) {
        await refreshFiles(selection)
        const latest = useConversations.getState().entries[selection]
        if (!latest || latest.owner !== current.owner || !canInteract() || !isPrivateEntrySelected(selection)) return
        if (latest.fileError) throw new Error(latest.fileError)
        const refreshed = requirementIntent(latest), initialDocument = seed.initialDocument
        if (refreshed) seed = { ...refreshed, ...(initialDocument ? { initialDocument, references: [...refreshed.references.filter(item => item.fileId !== initialDocument.fileId), initialDocument] } : {}) }
      }
      const commandId = seed && originalConversation ? await requirementIntentCommandId(current.owner ?? '', originalConversation.id, seed) : crypto.randomUUID()
      const latest = useConversations.getState().entries[selection]
      if (!canInteract() || !isPrivateEntrySelected(selection) || latest?.owner !== current.owner || originalConversation && latest?.conversation?.id !== originalConversation.id) return
      const previous = retainedRequirements.get(requirementOwner)
      const next = previous && previous.id === id && (!seed || previous.seed?.sourceKey === seed.sourceKey) ? { ...previous, document } : { id, commandId, seed, document }
      if (!retainedRequirements.has(requirementOwner) && retainedRequirements.size >= 32) {
        const oldest = retainedRequirements.keys().next().value
        if (oldest) retainedRequirements.delete(oldest)
      }
      retainedRequirements.set(requirementOwner, { ...next, document: undefined })
      setRequirement({ entryKey: selection, ...next })
    }).catch(cause => { if (canInteract() && isPrivateEntrySelected(selection) && useConversations.getState().entries[selection]?.owner === current.owner) setError(conversationError(cause)) }).finally(() => {
      if (requirementRequest.current === ticket) { requirementRequest.current = null; setRequirementOpening(false) }
    })
  }
  const closeDocumentPreview = (): void => { documentSource.cancelRead(); setDocumentPreview(null) }
  const adoptDocumentPreview = (): void => {
    if (!documentPreview || documentPreview.pending || documentPreview.error || !current || !canInteract() || !isPrivateEntrySelected(selection)) return
    const seed = requirementIntent(current) ?? { sourceKey: documentPreview.file.id, text: '将已保存的文档整理为需求初稿', references: current.files.filter(file => file.kind === 'input').map(file => ({ fileId: file.id, revision: file.revision })) }
    const reference = { fileId: documentPreview.file.id, revision: documentPreview.file.revision }
    openRequirement(undefined, { ...seed, initialDocument: reference, references: [...seed.references.filter(item => item.fileId !== reference.fileId), reference] })
    setDocumentPreview(null)
  }
  const activeRequirement = requirement?.entryKey === selection && !archiveId && current && !current.locked ? requirement : null
  useEffect(() => {
    if (active && activeRequirement) return
    buildCompletion.current?.resolve(null); buildCompletion.current = null; setBuildPreparation(null)
  }, [active, Boolean(activeRequirement)])
  const closeRequirement = (): void => {
    buildCompletion.current?.resolve(null); buildCompletion.current = null; setBuildPreparation(null)
    retainedRequirements.delete(requirementOwner); setRequirement(null); setExecution(null); requirementSummaries.refresh()
  }
  const prepareBuild = (request: RequirementBuildPreparation): Promise<RequirementBuildChoice | null> => {
    const conversation = current?.conversation
    if (!conversation || !canInteract() || !isPrivateEntrySelected(selection) || buildCompletion.current) return Promise.resolve(null)
    return new Promise((resolve, reject) => { buildCompletion.current = { resolve, reject }; setBuildPreparation({ entryKey: selection, request, creatorId: conversation.creatorId, conversationId: conversation.id }) })
  }
  const finishBuildPreparation = (choice: RequirementBuildChoice | null): void => {
    const pending = buildCompletion.current, selected = buildPreparation
    if (!pending || !selected) return
    buildCompletion.current = null; setBuildPreparation(null)
    if (!choice || !canInteract() || !isPrivateEntrySelected(selected.entryKey) || current?.conversation?.id !== selected.conversationId || current.conversation.creatorId !== selected.creatorId) { pending.resolve(null); return }
    try { localStorage.setItem(buildAgentKey(selected.creatorId, selected.conversationId, selected.request.draftId), JSON.stringify({ agentId: choice.agentId, planRevision: selected.request.expectedPlanRevision })) }
    catch { pending.reject(new Error('执行引擎选择无法保存；未创建任务，请检查本地存储。')); return }
    pending.resolve(choice)
  }
  const showWebPreview = (artifact: PiWebPreviewArtifact, eventId: string): void => {
    if (!canInteract() || !isPrivateEntrySelected(selection)) return
    setReader(undefined); setRequirement(null); setTeamHandoffFeedback(null); designs.close(); requirementSummaries.refresh(); preview.openWebPreview(artifact, eventId)
  }
  const showCodePreview: OpenCodePreview = (text, language) => {
    if (!canInteract() || !isPrivateEntrySelected(selection)) return
    setReader(undefined); setRequirement(null); setTeamHandoffFeedback(null); designs.close(); requirementSummaries.refresh(); preview.openCodePreview(text, language)
  }
  const showDesign = (id: string, candidateId?: string): void => { if (canInteract() && isPrivateEntrySelected(selection)) { setReader(undefined); setRequirement(null); setTeamHandoffFeedback(null); setMobileHistory(false); preview.closeWebPreview(); designs.open(id, candidateId) } }
  const takeDesignReference = (reference: DesignConversationReference): void => { if (canInteract() && isPrivateEntrySelected(selection)) { setDesignReference({ owner: designs.ownerKey, reference }); setDesignRestore(null); requestComposerFocus(selection) } }
  const taskSnapshot = useCrux(state => state.snapshot)
  const taskSuggestion = useTaskSuggestionPort({ snapshot: taskSnapshot, task: boundTask, conversationId: current?.conversation?.id,
    entryKey: selection, canStart: readerOpen && !sendReference && !current?.action })
  const selectedProject = projects.find((project) => project.id === current?.projectId)
  const taskActor = teamContext.actorId
  const taskDesign = readerOpen ? reader?.origin?.design : undefined
  const askAboutTask = active && boundTask && taskActor ? () => sendMessage(selection, undefined, {
    workspaceKey: teamContext.key, actorId: taskActor, epoch: teamContext.epoch,
    spaceId: boundTask.spaceId, taskId: boundTask.id, taskCreatedAt: boundTask.createdAt, design: taskDesign
  }) : undefined
  const taskPost = readerOpen && boundTask && <Suspense fallback={<p role="status" className="my-activity-note">正在打开任务…</p>}>
    <EmbeddedTaskPost key={taskOwner} taskId={boundTask.id} onClose={closeBoundTask} onContinue={() => {
      if (canInteract() && isPrivateEntrySelected(selection)) { setPane('chat'); requestComposerFocus(selection) }
    }} reviewSlot={taskSuggestion.reviewSlot} editorDecoration={taskSuggestion.editorDecoration} onQuote={selected => {
      if (!canInteract() || !isPrivateEntrySelected(selection) || !taskSuggestion.selectQuote({ ...selected, taskId: boundTask.id, taskCreatedAt: boundTask.createdAt })) return false
      setPane('chat'); requestComposerFocus(selection); return true
    }} onPolish={selected => {
      if (!canInteract() || !isPrivateEntrySelected(selection)) return false
      return taskSuggestion.selectPolish(selected)
    }} />
  </Suspense>
  const composerContext = <>
    {taskDesign && <Button size="sm" variant="ghost" aria-label={`移除设计参考：${taskDesign.title}`} onClick={() => setReader(value => value?.origin ? { ...value, origin: { ...value.origin, design: undefined } } : value)}>{taskDesign.title}<X size={12} /></Button>}
    {kind === 'work' && projects.length > 0 && current && <Dropdown placement="top" width={256} trigger={({ open, toggle }) => <Button variant="ghost" size="sm" className="acp-context-action" aria-label="整理到分组" aria-expanded={open} disabled={Boolean(current.action)} onClick={toggle}><Folder size={14} aria-hidden="true" /><span>{selectedProject?.name ?? '未分组'}</span><ChevronDown size={12} aria-hidden="true" /></Button>}>
      {(close) => <><DropdownHeader>整理到分组</DropdownHeader><DropdownItem selected={!current.projectId} onClick={() => { close(); void reclassifyConversation(current.key, null) }}>未分组</DropdownItem>{projects.map((project) => <DropdownItem key={project.id} selected={current.projectId === project.id} onClick={() => { close(); void reclassifyConversation(current.key, project.id) }}>{project.name}</DropdownItem>)}</>}
    </Dropdown>}
    <ConversationKnowledgeMenu canAddFiles={active && !archiveId && canImportFiles(current)} onAddFiles={importFiles} />

  </>
  return <DocumentSourceProvider client={documentSource}><section className={`acp-workspace${collapsed && !mobileHistory ? ' is-sidebar-collapsed' : ''}`} style={style} aria-label="对话工作区" onKeyDown={(event) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || !canInteract()) return
    if ((event.ctrlKey || event.metaKey) && event.key === '.' && current) { event.preventDefault(); event.stopPropagation(); void controlConversation(current.key, 'cancel') }
  }}>
    <ContextRegion collapsed={collapsed && !mobileHistory}><div className="acp-navigation-host flex min-h-0 shrink-0"><ConversationHistory kind={kind} selected={selection} projectId={projectId} open={mobileHistory} onProject={(id) => selectProjectScope(kind, id)} onSelect={choose} onNew={startNew} onClose={() => setMobileHistory(false)} /></div></ContextRegion>
    {activeRequirement ? <main className="private-requirement-host"><Suspense fallback={<div className="acp-empty" role="status">正在打开需求工作台…</div>}><RequirementWorkbench key={`${selection}:${activeRequirement.id ?? activeRequirement.commandId}:${activeRequirement.document ?? ''}`} entryKey={selection} requirementId={activeRequirement.id} createCommandId={activeRequirement.commandId} initialSource={activeRequirement.seed} initialDocument={activeRequirement.document} boundTask={boundTask ?? undefined} arrangement={teamHandoff?.owner === teamOwner && active && !current?.locked && <NewTaskModal open triagePending handoff={teamHandoff.value} onCreated={receipt => {
      if (currentTeamOwner.current !== teamOwner || !canInteract()) return
      setTeamHandoffFeedback({ owner: teamOwner, value: { state: 'created', taskId: receipt.taskId, message: `已创建 ${receipt.taskId} · ${teamHandoff.value.title}` } })
      refreshReceipt(n => n + 1)
    }} onClose={closeTeamHandoff} />} onViewTeamTask={taskId => { if (taskId === boundTask?.id) { closeRequirement(); openBoundTask(taskId) } }} teamHandoffFeedback={teamHandoffFeedback?.owner === teamOwner ? teamHandoffFeedback.value : null} onTeamHandoff={(view, trigger, task) => void shareDocument(view, trigger, task)} onClose={closeRequirement} onOpenTask={({ snapshot, taskDir }) => {
      if (!canInteract() || !isPrivateEntrySelected(selection)) return
      useApp.getState().setSnapshot(snapshot)
      useApp.getState().expandTaskWorkspace({ fromPage: 'chat', taskDir, archived: false, scrollTop: 0 }, `.trellis/tasks/${taskDir}/prd.md`)
    }} onPrepareBuild={prepareBuild} onOpenSuccessor={({ draftId, commandId }) => {
      const latest = useConversations.getState().entries[selection]
      const displayed = currentRequirement.current
      if (!current?.conversation || !canInteract() || !isPrivateEntrySelected(selection) || latest?.owner !== current.owner || latest?.conversation?.id !== current.conversation.id || latest.conversation.creatorId !== current.conversation.creatorId || currentOperationOwner.current !== operationOwner || displayed?.entryKey !== selection || displayed.id !== activeRequirement.id || displayed.commandId !== activeRequirement.commandId) return
      const next = { id: draftId, commandId }
      retainedRequirements.set(requirementOwner, next)
      setExecution(null); setRequirement({ entryKey: selection, ...next }); requirementSummaries.refresh()
    }} onStartTrellis={({ snapshot, draftId, agentId, planRevision }) => {
      if (!canInteract() || !isPrivateEntrySelected(selection)) return
      useApp.setState(state => ({ navigationRevision: state.navigationRevision + 1 }))
      useApp.getState().setSnapshot(snapshot)
      const selectedAgent = agentId ?? (current?.conversation ? readBuildAgent(current.conversation.creatorId, current.conversation.id, draftId, planRevision) : undefined)
      setExecution({ entryKey: selection, draftId, agentId: selectedAgent })
    }} /></Suspense></main> : <ConversationTaskLayout task={taskPost} pane={pane} onPaneChange={setPane} activation={readerOpen ? reader!.activation : 0}><ConversationPreviewLayout ownerKey={previewKind === 'design' ? designs.ownerKey : preview.ownerKey} expanded={previewKind === 'design' ? designs.expanded : preview.expanded} onExpandedChange={previewKind === 'design' ? designs.setExpanded : preview.setExpanded} collapsed={previewKind === 'design' ? designs.collapsed : preview.collapsed} onCollapsedChange={setPreviewCollapsed} preview={!readerOpen && previewKind ? <div className="acp-preview-tab-panels">
      {canShowWeb && current?.session && <div key={preview.ownerKey} className="acp-preview-tab-panel" hidden={previewKind !== 'web'} aria-hidden={previewKind !== 'web'} {...{ inert: previewKind !== 'web' ? '' : undefined }}>
        <ConversationPreviewTabs shelf={{ ...preview, collapsed: preview.collapsed || previewKind !== 'web' }} session={current.session} />
      </div>}
      {previewKind === 'design' && activeDesign && <div className="acp-preview-tab-panel"><DesignWorkspace key={`${designs.ownerKey}:${activeDesign.id}`} documentId={activeDesign.id} versionRequest={designs.versionRequest} embedded onClose={designs.close} onReference={takeDesignReference} restoreSelection={designRestore?.owner === designs.ownerKey ? designRestore.selection : undefined} /></div>}
    </div> : null}>
    <WorkspaceCodePreview enabled={!archiveId} openCodePreview={showCodePreview}>
    <main className="acp-main my-conversation-frame">
      <ConversationWorkspaceHeader
        identity={<><MessageSquare size={16} className="shrink-0 text-my-icon-secondary" />{returnToTask && <Button size="sm" variant="ghost" onClick={returnToTask}>返回任务</Button>}{boundTask && !archiveId && <Button size="sm" variant="ghost" aria-label={`查看任务 ${boundTask.id}`} onClick={() => openBoundTask(boundTask.id)}>{boundTask.id}</Button>}<strong title={title}>{title}</strong></>}
        actions={!archiveId && current && !current.locked && current.conversation ? <Dropdown placement="bottom" align="right" width={224} trigger={({ open, toggle }) => <button type="button" className="my-icon-control" ref={conversationMore} onClick={toggle} aria-expanded={open} aria-label="更多会话操作"><MoreHorizontal size={17} /></button>}>
          {(close) => <>
            {boundTask ? <DropdownItem icon={<Folder size={14} />} onClick={() => { close(); openBoundTask(boundTask.id) }}>查看任务 {boundTask.id}</DropdownItem> : <>
              <DropdownItem icon={<Users size={14} />} onClick={() => { close(); setTaskAction({ owner: teamOwner, mode: 'create' }) }}>将此对话转为任务</DropdownItem>
              <DropdownItem icon={<Folder size={14} />} onClick={() => { close(); setTaskAction({ owner: teamOwner, mode: 'bind' }) }}>将此对话绑定到已有任务</DropdownItem>
            </>}
            <DropdownItem icon={<Files size={14} />} onClick={() => { close(); setDocumentsOwner(selection) }}>会话文档</DropdownItem>
            <DropdownItem icon={<RefreshCw size={14} />} onClick={() => { close(); void readConversation(current.key) }}>刷新此对话</DropdownItem>
            <DropdownItem icon={<Files size={14} />} onClick={() => { close(); openFiles() }}>会话文件</DropdownItem>
            {kind === 'code' && projects.length > 0 && <>
              <DropdownHeader>整理到分组</DropdownHeader>
              <DropdownItem selected={!current.projectId} disabled={Boolean(current.action)} onClick={() => { close(); void reclassifyConversation(current.key, null) }}>未分组</DropdownItem>
              {projects.map((project) => <DropdownItem key={project.id} selected={current.projectId === project.id} disabled={Boolean(current.action)} onClick={() => { close(); void reclassifyConversation(current.key, project.id) }}>{project.name}</DropdownItem>)}
            </>}
            {current.session?.connectionOwned && <DropdownItem disabled={Boolean(current.action)} onClick={() => { close(); void controlConversation(current.key, 'end') }}>结束连接</DropdownItem>}
          </>}
        </Dropdown> : null}
      />
      {taskAction?.owner === teamOwner && current?.conversation && active && !archiveId && <ConversationTaskAction key={`${receiptOwner}:${taskAction.mode}`} id={current.conversation.id} entryKey={selection} mode={taskAction.mode} anchorRef={conversationMore} close={() => setTaskAction(undefined)} onCompleted={() => { setTaskAction(undefined); refreshReceipt(n => n + 1) }} />}
      {error && <div className="acp-history-note"><ConnectionNotice message={error} /><Button size="sm" variant="ghost" onClick={() => setError('')}>收起</Button></div>}
      {storageError && <ConnectionNotice message={storageError} />}
      {archiveId ? <ConversationArchive key={archiveId} id={archiveId} /> : selection ? <PrivateConversation entryKey={selection} onFiles={openFiles} onNew={() => startNew()} onNewDirectory={() => void startCodeDirectory()} directoryPending={newPending} directoryFixed={requirementSummaries.records.length > 0 || Boolean(activeRequirement)} composerContext={composerContext} quickActions={<ConversationHomeActions entryKey={selection} canAddFiles={active && canImportFiles(current)} onFiles={importFiles} onSelect={choose} />} onOpenWebPreview={showWebPreview}
        transcriptHeader={designs.documents.some(document => !designs.origins.some(receipt => receipt.documentId === document.id)) ? <section aria-label="已保存的历史设计"><span className="my-item-description">已保存的设计</span><ConversationDesignCards documents={designs.documents.filter(document => !designs.origins.some(receipt => receipt.documentId === document.id))} error="" onOpen={showDesign} onRefresh={designs.refresh} /></section> : undefined}
        renderTurnArtifacts={owner => { const ids = new Set(designs.origins.filter(receipt => sameTranscriptOwner(receipt.origin, owner)).map(receipt => receipt.documentId)); return <ConversationDesignCards documents={designs.documents.filter(document => ids.has(document.id))} error="" onOpen={showDesign} onRefresh={designs.refresh} /> }}
        transcriptFooter={<>{active && current?.conversation && !current.locked && <ConversationTaskReceipt key={receiptOwner} conversationId={current.conversation.id} refreshKey={receiptRevision} onOpenTask={openBoundTask} />}<ConversationDesignCards documents={[]} error={designs.error} busy={designs.busy} notice={designs.notice} onOpen={showDesign} onRefresh={designs.refresh} /></>}
        composerReferences={taskSuggestion.composerReference ?? (sendReference ? <div className="design-composer-reference my-activity-note"><MousePointer2 size={13} aria-hidden="true" /><span title={pendingDesignSend ? pendingDesignSend.text : sendReference.selection?.selector}>{pendingDesignSend ? current?.action === 'sending' ? '正在发送设计修改…' : `发送结果待核对 · ${pendingDesignSend.text.slice(0, 48)}` : `${sendReference.title}${sendReference.selection ? ` · ${sendReference.selection.tagName} · ${sendReference.selection.text?.slice(0, 48) ?? ''}` : ' · 整个设计'}`}</span>{pendingDesignSend ? <Button size="sm" disabled={Boolean(current?.action)} onClick={() => { void sendDesignMessage(selection, pendingDesignSend.reference).then(accepted => { if (accepted) { setDesignReference(value => value?.owner === designs.ownerKey ? null : value); designs.refresh() } }).catch(cause => { if (isPrivateEntrySelected(selection)) setError(conversationError(cause)) }) }}>核对原发送</Button> : <Button size="sm" variant="ghost" aria-label="移除设计引用" onClick={() => setDesignReference(null)}><X size={13} /></Button>}</div> : undefined)}
        onSendMessage={taskSuggestion.onSendMessage ?? (sendReference ? async () => { if (await sendDesignMessage(selection, sendReference)) { setDesignReference(value => value?.owner === designs.ownerKey ? null : value); designs.refresh() } } : askAboutTask)}
      /> : <div className="acp-empty" role="status">正在准备输入区…</div>}
    </main>
    </WorkspaceCodePreview>
    </ConversationPreviewLayout></ConversationTaskLayout>}
    {documentPreview && documentPreview.conversationId === current?.conversation?.id && documentPreview.ownerKey === JSON.stringify([selection, current?.owner, current?.conversation?.id, current?.conversation?.workspace.root, current?.session?.connectionGeneration, current?.locked]) && !current?.locked && active && <Modal open ariaLabel="会话文档" width={900} onClose={closeDocumentPreview}><section><header className="private-files-heading"><strong className="my-item-title min-w-0 flex-1 break-words">{documentPreview.file.name}</strong><Button size="sm" variant="ghost" disabled={requirementOpening || Boolean(current.action) || documentPreview.pending || Boolean(documentPreview.error)} onClick={adoptDocumentPreview}>整理为需求</Button><Button size="sm" variant="ghost" aria-label="关闭会话文档" onClick={closeDocumentPreview}><X size={14} /></Button></header><div className="private-files-body my-scrollbar my-chat-prose">{documentPreview.pending ? <p className="my-activity-note" role="status"><Loader2 size={14} className="animate-spin" />正在读取文档…</p> : documentPreview.error ? <div role="alert"><p>{documentPreview.error}</p><Button size="sm" variant="ghost" onClick={() => void documentSource.openDocument(documentPreview.file.relativePath).catch(cause => setError(conversationError(cause)))}>重新读取文档</Button></div> : <MarkdownView content={documentPreview.body} />}</div></section></Modal>}
    {documentsOpen && active && !archiveId && current && !current.locked && <Modal open ariaLabel="会话文档" onClose={() => setDocumentsOwner('')}><section className="flex flex-col gap-3 p-4"><h2 className="my-item-title">会话文档</h2><ConversationRequirementMenu records={requirementSummaries.records} error={requirementSummaries.error} loading={requirementSummaries.loading} disabled={requirementOpening || !current?.loaded || Boolean(current?.action) || kind === 'code' && !current?.conversation && !current?.directory} preferredId={lastRequirementId(current?.conversation)} onOpen={(id, document) => { setDocumentsOwner(''); openRequirement(id, undefined, document) }} onRefresh={requirementSummaries.refresh} /></section></Modal>}
    {fileOwner === selection && !archiveId && <ConversationFiles key={selection} entryKey={selection} onClose={() => setFileOwner(null)} />}
    {buildPreparation?.entryKey === selection && active && activeRequirement && <Suspense fallback={<div className="acp-empty" role="status">正在打开构建准备…</div>}><BuildPreparation entryKey={selection} request={buildPreparation.request} initialAgentId={readBuildAgent(buildPreparation.creatorId, buildPreparation.conversationId, buildPreparation.request.draftId, buildPreparation.request.expectedPlanRevision)} onResolve={finishBuildPreparation} /></Suspense>}
    {execution?.entryKey === selection && active && activeRequirement && <Suspense fallback={null}><RequirementExecutionFlow entryKey={selection} draftId={execution.draftId} preferredAgentId={execution.agentId} onClose={() => setExecution(null)} /></Suspense>}
  </section></DocumentSourceProvider>
}

function WorkspaceCodePreview({ enabled, openCodePreview, children }: { enabled: boolean; openCodePreview: OpenCodePreview; children: ReactNode }): JSX.Element {
  return enabled ? <CodePreviewProvider openCodePreview={openCodePreview}>{children}</CodePreviewProvider> : <>{children}</>
}
