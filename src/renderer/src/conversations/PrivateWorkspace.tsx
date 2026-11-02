import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { ChevronDown, Files, Folder, MessageSquare, MoreHorizontal, PanelLeft, RefreshCw } from 'lucide-react'
import type { Conversation } from '@shared/private-conversations'
import type { PiWebPreviewArtifact } from '@shared/pi-web-preview'
import { Button, Dropdown, DropdownHeader, DropdownItem } from '../my/ui'
import { useSidebarWidthStyle } from '../my/layout/SidebarResizeHandle'
import { useMy } from '../my/store'
import { useApp } from '../store'
import { useEscLayer } from '../utils/use-esc-layer'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { ConversationArchive } from './Archive'
import { PrivateConversation } from './Conversation'
import { ConversationFiles } from './Files'
import { ConversationHistory } from './History'
import { ConversationKnowledgeMenu } from './KnowledgeMenu'
import { ConversationRequirementPanel } from './RequirementPanel'
import { ConversationHomeActions } from './HomeActions'
import { ConversationRequirementMenu, useRequirementSummaries } from './RequirementMenu'
import { ConversationWorkspaceHeader } from '../acp/ConversationWorkspaceHeader'
import { ConversationPreviewLayout } from '../acp/ConversationPreviewLayout'
import { ConversationPreviewTabs } from '../acp/ConversationPreviewTabs'
import { usePiWebPreviewShelf } from '../acp/PiWebPreviewShelf'
import { CodePreviewProvider, type OpenCodePreview } from '../components/CodePreviewContext'
import { DocumentSourceProvider } from '../reader/document-source'
import { ConnectionNotice } from '../acp/ConnectionNotice'
import { isPrivateEntrySelected, usePrivateDocumentSource } from './source'
import { conversationClient, conversationError, conversationValue } from './client'
import { addFiles, baseScopeKey, controlConversation, ensureScope, newDraft, readConversation, reclassifyConversation, refreshWorkspace, scopeKey, selectConversation, selectProjectScope, useConversations, type ConversationKind, type WorkspaceEntry } from './workspace'
import '../acp/workspace.css'
import './workspace.css'

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
  const [requirementExpanded, setRequirementExpanded] = useState(false)
  const requirementSummaries = useRequirementSummaries(current, active && !archiveId && !current?.locked)
  const historyButton = useRef<HTMLButtonElement>(null), wasActive = useRef(false)
  const directoryRequest = useRef<symbol | null>(null)
  const operationOwner = JSON.stringify([scope, selection]), currentOperationOwner = useRef(operationOwner)
  currentOperationOwner.current = operationOwner
  const documentSource = usePrivateDocumentSource(selection)
  const preview = usePiWebPreviewShelf({ root: current?.conversation?.workspace.root ?? '', session: current?.locked ? null : current?.session ?? null, events: current?.events ?? [], enabled: active && !archiveId && !current?.locked, isCurrent: documentSource.isCurrent, onAutoOpen: () => setMobileHistory(false) })
  useEscLayer(mobileHistory, { kind: 'overlay', id: 'private-history', onClose: () => setMobileHistory(false), returnFocusRef: historyButton })
  useLayoutEffect(() => { ensureScope(kind, projectId) }, [scope])
  useEffect(() => { setMobileHistory(false); setFileOwner(null); setError('') }, [scope, selection])
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
    if (!canInteract() || !current || current.locked || current.conversation?.archivedAt !== undefined || current.kind === 'code' && !current.conversation && !current.directory || !isPrivateEntrySelected(selection)) return
    setRequirement(value => value?.entryKey === selection && value.id === id ? value : { entryKey: selection, id, commandId: crypto.randomUUID() })
    setRequirementExpanded(false)
  }
  const activeRequirement = requirement?.entryKey === selection && !archiveId ? requirement : null
  const showWebPreview = (artifact: PiWebPreviewArtifact, eventId: string): void => {
    if (!canInteract() || !isPrivateEntrySelected(selection)) return
    setRequirement(null); requirementSummaries.refresh(); preview.openWebPreview(artifact, eventId)
  }
  const showCodePreview: OpenCodePreview = (text, language) => {
    if (!canInteract() || !isPrivateEntrySelected(selection)) return
    setRequirement(null); requirementSummaries.refresh(); preview.openCodePreview(text, language)
  }
  const selectedProject = projects.find((project) => project.id === current?.projectId)
  const composerContext = <>
    {kind === 'work' && projects.length > 0 && current && <Dropdown placement="top" width={256} trigger={({ open, toggle }) => <Button variant="ghost" size="sm" className="acp-context-action" aria-label="整理到分组" aria-expanded={open} disabled={Boolean(current.action)} onClick={toggle}><Folder size={14} aria-hidden="true" /><span>{selectedProject?.name ?? '未分组'}</span><ChevronDown size={12} aria-hidden="true" /></Button>}>
      {(close) => <><DropdownHeader>整理到分组</DropdownHeader><DropdownItem selected={!current.projectId} onClick={() => { close(); void reclassifyConversation(current.key, null) }}>未分组</DropdownItem>{projects.map((project) => <DropdownItem key={project.id} selected={current.projectId === project.id} onClick={() => { close(); void reclassifyConversation(current.key, project.id) }}>{project.name}</DropdownItem>)}</>}
    </Dropdown>}
    <ConversationKnowledgeMenu canAddFiles={active && !archiveId && canImportFiles(current)} onAddFiles={importFiles} />
    <ConversationRequirementMenu records={requirementSummaries.records} error={requirementSummaries.error} loading={requirementSummaries.loading} disabled={!current?.loaded || Boolean(current?.action) || kind === 'code' && !current?.conversation && !current?.directory} onOpen={openRequirement} onRefresh={requirementSummaries.refresh} />
  </>
  return <DocumentSourceProvider client={documentSource}><section className={`acp-workspace${collapsed && !mobileHistory ? ' is-sidebar-collapsed' : ''}`} style={style} aria-label="对话工作区" onKeyDown={(event) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || !canInteract()) return
    if ((event.ctrlKey || event.metaKey) && event.key === '.' && current) { event.preventDefault(); event.stopPropagation(); void controlConversation(current.key, 'cancel') }
  }}>
    <div className={`acp-navigation-host flex min-h-0 shrink-0${collapsed && !mobileHistory ? ' is-collapsed' : ''}`}><ConversationHistory kind={kind} selected={selection} projectId={projectId} open={mobileHistory} onProject={(id) => selectProjectScope(kind, id)} onSelect={choose} onNew={startNew} onClose={() => setMobileHistory(false)} /></div>
    <ConversationPreviewLayout ownerKey={activeRequirement ? `requirement:${selection}:${activeRequirement.id ?? activeRequirement.commandId}` : preview.ownerKey} expanded={activeRequirement ? requirementExpanded : preview.expanded} onExpandedChange={activeRequirement ? setRequirementExpanded : preview.setExpanded} collapsed={activeRequirement ? false : preview.collapsed} previewCount={activeRequirement ? 1 : preview.tabs.length} onCollapsedChange={(value) => value ? preview.closeWebPreview() : preview.setCollapsed(false)} preview={activeRequirement ? <ConversationRequirementPanel key={`${selection}:${activeRequirement.id ?? activeRequirement.commandId}`} entryKey={selection} requirementId={activeRequirement.id} createCommandId={activeRequirement.commandId} onClose={() => { setRequirement(null); requirementSummaries.refresh() }} onOpenTask={({ snapshot, taskDir }) => {
      if (!canInteract() || !isPrivateEntrySelected(selection)) return
      useApp.getState().setSnapshot(snapshot)
      useApp.getState().expandTaskWorkspace({ fromPage: 'chat', taskDir, archived: false, scrollTop: 0 }, `.trellis/tasks/${taskDir}/prd.md`)
    }} /> : preview.tabs.length > 0 && current?.session && !current.locked ? <ConversationPreviewTabs key={preview.ownerKey} shelf={preview} session={current.session} /> : null}>
    <WorkspaceCodePreview enabled={!archiveId} openCodePreview={showCodePreview}>
    <main className="acp-main my-conversation-frame">
      <ConversationWorkspaceHeader
        leading={<button type="button" ref={historyButton} className={`my-control my-control-sm my-button-ghost acp-mobile-only acp-sidebar-toggle${collapsed ? ' is-visible' : ''}`} aria-label="展开对话历史" title="展开对话历史" onClick={() => { if (matchMedia('(max-width: 900px)').matches) setMobileHistory(true); else useMy.getState().toggleSidebar() }}><PanelLeft size={16} /></button>}
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
      {archiveId ? <ConversationArchive key={archiveId} id={archiveId} /> : selection ? <PrivateConversation entryKey={selection} onFiles={openFiles} onNew={() => startNew()} onNewDirectory={() => void startCodeDirectory()} directoryPending={newPending} directoryFixed={requirementSummaries.records.length > 0 || Boolean(activeRequirement)} composerContext={composerContext} quickActions={<ConversationHomeActions entryKey={selection} requirements={requirementSummaries.records} requirementsError={requirementSummaries.error} requirementsLoading={requirementSummaries.loading} onRefreshRequirements={requirementSummaries.refresh} canAddFiles={active && canImportFiles(current)} onFiles={importFiles} onSelect={choose} onRequirement={openRequirement} />} onOpenWebPreview={showWebPreview} /> : <div className="acp-empty" role="status">正在准备输入区…</div>}
    </main>
    </WorkspaceCodePreview>
    </ConversationPreviewLayout>
    {fileOwner === selection && !archiveId && <ConversationFiles key={selection} entryKey={selection} onClose={() => setFileOwner(null)} />}
  </section></DocumentSourceProvider>
}

function WorkspaceCodePreview({ enabled, openCodePreview, children }: { enabled: boolean; openCodePreview: OpenCodePreview; children: ReactNode }): JSX.Element {
  return enabled ? <CodePreviewProvider openCodePreview={openCodePreview}>{children}</CodePreviewProvider> : <>{children}</>
}
