import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { ChevronDown, Files, Folder, MessageSquare, MoreHorizontal, MousePointer2, RefreshCw, X } from 'lucide-react'
import type { Conversation } from '@shared/private-conversations'
import type { PiWebPreviewArtifact } from '@shared/pi-web-preview'
import { Button, Dropdown, DropdownHeader, DropdownItem } from '../my/ui'
import { useSidebarWidthStyle } from '../my/layout/SidebarResizeHandle'
import { ContextRegion } from '../my/layout/ContextRegion'
import { useMy } from '../my/store'
import { useApp } from '../store'
import { useEscLayer } from '../utils/use-esc-layer'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
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
import type { RequirementBuildChoice } from './requirement-workbench/BuildPreparation'
import { DocumentSourceProvider } from '../reader/document-source'
import { ConnectionNotice } from '../acp/ConnectionNotice'
import { isPrivateEntrySelected, usePrivateDocumentSource } from './source'
import { conversationClient, conversationError, conversationValue } from './client'
import { addFiles, baseScopeKey, controlConversation, ensureScope, newDraft, readConversation, reclassifyConversation, refreshWorkspace, requestComposerFocus, scopeKey, selectConversation, selectProjectScope, useConversations, type ConversationKind, type WorkspaceEntry } from './workspace'
import '../acp/workspace.css'
import './workspace.css'

const loadRequirementWorkbench = () => import('./requirement-workbench/Workbench')
const RequirementWorkbench = lazy(loadRequirementWorkbench)
const RequirementExecutionFlow = lazy(() => import('./requirement-workbench/ExecutionFlow').then(module => ({ default: module.RequirementExecutionFlow })))
const BuildPreparation = lazy(() => import('./requirement-workbench/BuildPreparation').then(module => ({ default: module.BuildPreparation })))
type RequirementSelection = { id?: string; commandId: string }
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
  const [requirement, setRequirement] = useState<{ entryKey: string; id?: string; commandId: string } | null>(null)
  const currentRequirement = useRef(requirement)
  currentRequirement.current = requirement
  const [execution, setExecution] = useState<{ entryKey: string; draftId: string; agentId?: string } | null>(null)
  const [buildPreparation, setBuildPreparation] = useState<{ entryKey: string; request: RequirementBuildPreparation; creatorId: string; conversationId: string } | null>(null)
  const buildCompletion = useRef<{ resolve(value: RequirementBuildChoice | null): void; reject(reason: Error): void } | null>(null)
  const [requirementOpening, setRequirementOpening] = useState(false)
  const requirementRequest = useRef<symbol | null>(null)
  const requirementSummaries = useRequirementSummaries(current, active && !archiveId && !current?.locked)
  const historyButton = useRef<HTMLButtonElement>(null), wasActive = useRef(false)
  const directoryRequest = useRef<symbol | null>(null)
  const operationOwner = JSON.stringify([scope, selection]), currentOperationOwner = useRef(operationOwner)
  currentOperationOwner.current = operationOwner
  const documentSource = usePrivateDocumentSource(selection)
  const preview = usePiWebPreviewShelf({ root: current?.conversation?.workspace.root ?? '', session: current?.locked ? null : current?.session ?? null, events: current?.events ?? [], enabled: active && !archiveId && !current?.locked, isCurrent: documentSource.isCurrent, onAutoOpen: () => setMobileHistory(false) })
  const designs = useConversationDesigns(current, active && !archiveId && !current?.locked)
  const [designReference, setDesignReference] = useState<{ owner: string; reference: DesignConversationReference } | null>(null)
  const [designRestore, setDesignRestore] = useState<{ owner: string; selection: DesignSelection } | null>(null)
  const designTarget = useDesignNavigation(state => state.conversationTarget)
  const consumedDesignTarget = useRef('')
  const currentDesignReference = designReference?.owner === designs.ownerKey ? designReference.reference : null
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
    setRequirement(null); preview.closeWebPreview(); designs.open(document.id)
    if (designTarget.selection) setDesignRestore({ owner: designs.ownerKey, selection: designTarget.selection })
    else setDesignReference({ owner: designs.ownerKey, reference: { documentId: document.id, revision: document.revision, title: document.title } })
    useDesignNavigation.setState({ conversationTarget: null })
  }, [active, current?.conversation?.id, designTarget, designs.documents])
  useEscLayer(mobileHistory, { kind: 'overlay', id: 'private-history', onClose: () => setMobileHistory(false), returnFocusRef: historyButton })
  useLayoutEffect(() => { ensureScope(kind, projectId) }, [scope])
  useEffect(() => { buildCompletion.current?.resolve(null); buildCompletion.current = null; setBuildPreparation(null); setMobileHistory(false); setFileOwner(null); setExecution(null); setError('') }, [scope, selection])
  useEffect(() => () => { buildCompletion.current?.resolve(null); buildCompletion.current = null }, [])
  const requirementOwner = JSON.stringify([current?.owner, selection])
  useEffect(() => {
    const saved = retainedRequirements.get(requirementOwner)
    setRequirement(saved ? { entryKey: selection, ...saved } : null)
  }, [requirementOwner])
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
  const openRequirement = (id?: string): void => {
    if (!canInteract() || requirementRequest.current || !current || current.locked || current.conversation?.archivedAt !== undefined || current.kind === 'code' && !current.conversation && !current.directory || !isPrivateEntrySelected(selection)) return
    const ticket = Symbol('requirement')
    requirementRequest.current = ticket; setRequirementOpening(true)
    void loadRequirementWorkbench().then(() => {
      if (!canInteract() || !isPrivateEntrySelected(selection) || currentOperationOwner.current !== operationOwner) return
      const previous = retainedRequirements.get(requirementOwner)
      const next = previous && previous.id === id ? previous : { id, commandId: crypto.randomUUID() }
      if (!retainedRequirements.has(requirementOwner) && retainedRequirements.size >= 32) {
        const oldest = retainedRequirements.keys().next().value
        if (oldest) retainedRequirements.delete(oldest)
      }
      retainedRequirements.set(requirementOwner, next)
      setRequirement({ entryKey: selection, ...next })
    }).catch(cause => { if (canInteract() && currentOperationOwner.current === operationOwner) setError(conversationError(cause)) }).finally(() => {
      if (requirementRequest.current === ticket) { requirementRequest.current = null; setRequirementOpening(false) }
    })
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
    setRequirement(null); designs.close(); requirementSummaries.refresh(); preview.openWebPreview(artifact, eventId)
  }
  const showCodePreview: OpenCodePreview = (text, language) => {
    if (!canInteract() || !isPrivateEntrySelected(selection)) return
    setRequirement(null); designs.close(); requirementSummaries.refresh(); preview.openCodePreview(text, language)
  }
  const showDesign = (id: string, candidateId?: string): void => { if (canInteract() && isPrivateEntrySelected(selection)) { setRequirement(null); setMobileHistory(false); preview.closeWebPreview(); designs.open(id, candidateId) } }
  const takeDesignReference = (reference: DesignConversationReference): void => { if (canInteract() && isPrivateEntrySelected(selection)) { setDesignReference({ owner: designs.ownerKey, reference }); setDesignRestore(null); requestComposerFocus(selection) } }
  const selectedProject = projects.find((project) => project.id === current?.projectId)
  const composerContext = <>
    {kind === 'work' && projects.length > 0 && current && <Dropdown placement="top" width={256} trigger={({ open, toggle }) => <Button variant="ghost" size="sm" className="acp-context-action" aria-label="整理到分组" aria-expanded={open} disabled={Boolean(current.action)} onClick={toggle}><Folder size={14} aria-hidden="true" /><span>{selectedProject?.name ?? '未分组'}</span><ChevronDown size={12} aria-hidden="true" /></Button>}>
      {(close) => <><DropdownHeader>整理到分组</DropdownHeader><DropdownItem selected={!current.projectId} onClick={() => { close(); void reclassifyConversation(current.key, null) }}>未分组</DropdownItem>{projects.map((project) => <DropdownItem key={project.id} selected={current.projectId === project.id} onClick={() => { close(); void reclassifyConversation(current.key, project.id) }}>{project.name}</DropdownItem>)}</>}
    </Dropdown>}
    <ConversationKnowledgeMenu canAddFiles={active && !archiveId && canImportFiles(current)} onAddFiles={importFiles} />
    <ConversationRequirementMenu records={requirementSummaries.records} error={requirementSummaries.error} loading={requirementSummaries.loading} disabled={requirementOpening || !current?.loaded || Boolean(current?.action) || kind === 'code' && !current?.conversation && !current?.directory} onOpen={openRequirement} onRefresh={requirementSummaries.refresh} />
  </>
  return <DocumentSourceProvider client={documentSource}><section className={`acp-workspace${collapsed && !mobileHistory ? ' is-sidebar-collapsed' : ''}`} style={style} aria-label="对话工作区" onKeyDown={(event) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || !canInteract()) return
    if ((event.ctrlKey || event.metaKey) && event.key === '.' && current) { event.preventDefault(); event.stopPropagation(); void controlConversation(current.key, 'cancel') }
  }}>
    <ContextRegion collapsed={collapsed && !mobileHistory}><div className="acp-navigation-host flex min-h-0 shrink-0"><ConversationHistory kind={kind} selected={selection} projectId={projectId} open={mobileHistory} onProject={(id) => selectProjectScope(kind, id)} onSelect={choose} onNew={startNew} onClose={() => setMobileHistory(false)} /></div></ContextRegion>
    {activeRequirement ? <main className="private-requirement-host"><Suspense fallback={<div className="acp-empty" role="status">正在打开需求工作台…</div>}><RequirementWorkbench key={`${selection}:${activeRequirement.id ?? activeRequirement.commandId}`} entryKey={selection} requirementId={activeRequirement.id} createCommandId={activeRequirement.commandId} onClose={closeRequirement} onOpenTask={({ snapshot, taskDir }) => {
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
    }} /></Suspense></main> : <ConversationPreviewLayout ownerKey={previewKind === 'design' ? designs.ownerKey : preview.ownerKey} expanded={previewKind === 'design' ? designs.expanded : preview.expanded} onExpandedChange={previewKind === 'design' ? designs.setExpanded : preview.setExpanded} collapsed={previewKind === 'design' ? designs.collapsed : preview.collapsed} onCollapsedChange={setPreviewCollapsed} preview={previewKind ? <div className="acp-preview-tab-panels">
      {canShowWeb && current?.session && <div key={preview.ownerKey} className="acp-preview-tab-panel" hidden={previewKind !== 'web'} aria-hidden={previewKind !== 'web'} {...{ inert: previewKind !== 'web' ? '' : undefined }}>
        <ConversationPreviewTabs shelf={{ ...preview, collapsed: preview.collapsed || previewKind !== 'web' }} session={current.session} />
      </div>}
      {previewKind === 'design' && activeDesign && <div className="acp-preview-tab-panel"><DesignWorkspace key={`${designs.ownerKey}:${activeDesign.id}`} documentId={activeDesign.id} versionRequest={designs.versionRequest} embedded onClose={designs.close} onReference={takeDesignReference} restoreSelection={designRestore?.owner === designs.ownerKey ? designRestore.selection : undefined} /></div>}
    </div> : null}>
    <WorkspaceCodePreview enabled={!archiveId} openCodePreview={showCodePreview}>
    <main className="acp-main my-conversation-frame">
      <ConversationWorkspaceHeader
        identity={<><MessageSquare size={16} className="shrink-0 text-my-icon-secondary" /><strong title={title}>{title}</strong></>}
        actions={!archiveId && current && !current.locked && current.conversation ? <Dropdown placement="bottom" align="right" width={224} trigger={({ open, toggle }) => <button type="button" className="my-icon-control" onClick={toggle} aria-expanded={open} aria-label="更多会话操作"><MoreHorizontal size={17} /></button>}>
          {(close) => <>
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
      {error && <div className="acp-history-note"><ConnectionNotice message={error} /><Button size="sm" variant="ghost" onClick={() => setError('')}>收起</Button></div>}
      {storageError && <ConnectionNotice message={storageError} />}
      {archiveId ? <ConversationArchive key={archiveId} id={archiveId} /> : selection ? <PrivateConversation entryKey={selection} onFiles={openFiles} onNew={() => startNew()} onNewDirectory={() => void startCodeDirectory()} directoryPending={newPending} directoryFixed={requirementSummaries.records.length > 0 || Boolean(activeRequirement)} composerContext={composerContext} quickActions={<ConversationHomeActions entryKey={selection} requirements={requirementSummaries.records} requirementsError={requirementSummaries.error} requirementsLoading={requirementSummaries.loading} onRefreshRequirements={requirementSummaries.refresh} canAddFiles={active && canImportFiles(current)} onFiles={importFiles} onSelect={choose} onRequirement={openRequirement} />} onOpenWebPreview={showWebPreview}
        transcriptFooter={<ConversationDesignCards documents={designs.documents} error={designs.error} onOpen={showDesign} onRefresh={designs.refresh} />}
        composerReferences={sendReference ? <div className="design-composer-reference my-activity-note"><MousePointer2 size={13} aria-hidden="true" /><span title={pendingDesignSend ? pendingDesignSend.text : sendReference.selection?.selector}>{pendingDesignSend ? current?.action === 'sending' ? '正在发送设计修改…' : `发送结果待核对 · ${pendingDesignSend.text.slice(0, 48)}` : `${sendReference.title}${sendReference.selection ? ` · ${sendReference.selection.tagName} · ${sendReference.selection.text?.slice(0, 48) ?? ''}` : ' · 整个设计'}`}</span>{pendingDesignSend ? <Button size="sm" disabled={Boolean(current?.action)} onClick={() => { void sendDesignMessage(selection, pendingDesignSend.reference).then(accepted => { if (accepted) { setDesignReference(value => value?.owner === designs.ownerKey ? null : value); designs.refresh() } }).catch(cause => { if (isPrivateEntrySelected(selection)) setError(conversationError(cause)) }) }}>核对原发送</Button> : <Button size="sm" variant="ghost" aria-label="移除设计引用" onClick={() => setDesignReference(null)}><X size={13} /></Button>}</div> : undefined}
        onSendMessage={sendReference ? async () => { if (await sendDesignMessage(selection, sendReference)) { setDesignReference(value => value?.owner === designs.ownerKey ? null : value); designs.refresh() } } : undefined}
      /> : <div className="acp-empty" role="status">正在准备输入区…</div>}
    </main>
    </WorkspaceCodePreview>
    </ConversationPreviewLayout>}
    {fileOwner === selection && !archiveId && <ConversationFiles key={selection} entryKey={selection} onClose={() => setFileOwner(null)} />}
    {buildPreparation?.entryKey === selection && active && activeRequirement && <Suspense fallback={<div className="acp-empty" role="status">正在打开构建准备…</div>}><BuildPreparation entryKey={selection} request={buildPreparation.request} initialAgentId={readBuildAgent(buildPreparation.creatorId, buildPreparation.conversationId, buildPreparation.request.draftId, buildPreparation.request.expectedPlanRevision)} onResolve={finishBuildPreparation} /></Suspense>}
    {execution?.entryKey === selection && active && activeRequirement && <Suspense fallback={null}><RequirementExecutionFlow entryKey={selection} draftId={execution.draftId} preferredAgentId={execution.agentId} onClose={() => setExecution(null)} /></Suspense>}
  </section></DocumentSourceProvider>
}

function WorkspaceCodePreview({ enabled, openCodePreview, children }: { enabled: boolean; openCodePreview: OpenCodePreview; children: ReactNode }): JSX.Element {
  return enabled ? <CodePreviewProvider openCodePreview={openCodePreview}>{children}</CodePreviewProvider> : <>{children}</>
}
