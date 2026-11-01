import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { ChevronDown, FilePlus2, Files, Folder, LockKeyhole, MessageSquare, MoreHorizontal, PanelLeft, Plus, RefreshCw, UserRound } from 'lucide-react'
import type { Conversation, ConversationContext } from '@shared/private-conversations'
import { Button, Dropdown, DropdownHeader, DropdownItem } from '../my/ui'
import { useSidebarWidthStyle } from '../my/layout/SidebarResizeHandle'
import { useMy } from '../my/store'
import { useApp } from '../store'
import { useHifox } from '../hifox/store'
import { CreateCreationDialog } from '../creations/CreationDialogs'
import { openCreation } from '../creations/navigation'
import { useEscLayer } from '../utils/use-esc-layer'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { ConversationArchive } from './Archive'
import { PrivateConversation } from './Conversation'
import { ConversationFiles } from './Files'
import { ConversationHistory } from './History'
import { ConversationKnowledgeMenu } from './KnowledgeMenu'
import { ConversationWorkspaceHeader } from '../acp/ConversationWorkspaceHeader'
import { ConversationPreviewLayout } from '../acp/ConversationPreviewLayout'
import { ConversationPreviewTabs } from '../acp/ConversationPreviewTabs'
import { usePiWebPreviewShelf } from '../acp/PiWebPreviewShelf'
import { CodePreviewProvider, type OpenCodePreview } from '../components/CodePreviewContext'
import { DocumentSourceProvider } from '../reader/document-source'
import { ConnectionNotice } from '../acp/ConnectionNotice'
import { isPrivateEntrySelected, usePrivateDocumentSource } from './source'
import { conversationClient, conversationError, conversationValue } from './client'
import { addFiles, baseScopeKey, changeContext, contextKey, controlConversation, ensureScope, newDraft, readConversation, reclassifyConversation, refreshWorkspace, scopeKey, selectConversation, selectProjectScope, useConversations, type ConversationKind, type WorkspaceEntry } from './workspace'
import '../acp/workspace.css'
import './workspace.css'

export function PrivateWorkspace(): JSX.Element {
  const context = useConversations((state) => state.context), contexts = useConversations((state) => state.contexts)
  const selected = useConversations((state) => state.selected), entries = useConversations((state) => state.entries), projects = useConversations((state) => state.projects)
  const projectScopes = useConversations((state) => state.projectScopes), storageError = useConversations((state) => state.storageError)
  const requirementSource = useHifox((state) => state.workspaceContext)
  const archives = useConversations((state) => state.archives)
  const shellView = useMy((state) => state.shellView), collapsed = useMy((state) => state.sidebarCollapsed)
  const style = useSidebarWidthStyle(), active = useInteractionActive(), canInteract = useInteractionGuard()
  const kind: ConversationKind = shellView === 'development' ? 'code' : 'work', projectId = projectScopes[baseScopeKey(context, kind)] ?? undefined, scope = scopeKey(context, kind, projectId)
  const selection = selected[scope] ?? '', current = entries[selection], archiveId = selection.startsWith('archive:') ? selection.slice(8) : null
  const [mobileHistory, setMobileHistory] = useState(false), [fileOwner, setFileOwner] = useState<string | null>(null)
  const [newPending, setNewPending] = useState(false), [error, setError] = useState('')
  const [requirement, setRequirement] = useState<{ selection: string; workspaceKey: string; actorId: string; epoch?: string } | null>(null)
  const [requirementLoading, setRequirementLoading] = useState(false)
  const historyButton = useRef<HTMLButtonElement>(null), wasActive = useRef(false)
  const operationOwner = JSON.stringify([scope, selection]), currentOperationOwner = useRef(operationOwner)
  currentOperationOwner.current = operationOwner
  const documentSource = usePrivateDocumentSource(selection)
  const preview = usePiWebPreviewShelf({ root: current?.conversation?.workspace.root ?? '', session: current?.locked ? null : current?.session ?? null, events: current?.events ?? [], enabled: active && !archiveId && !current?.locked, isCurrent: documentSource.isCurrent, onAutoOpen: () => setMobileHistory(false) })
  useEscLayer(mobileHistory, { kind: 'overlay', id: 'private-history', onClose: () => setMobileHistory(false), returnFocusRef: historyButton })
  useLayoutEffect(() => { ensureScope(context, kind, projectId) }, [scope])
  useEffect(() => { setMobileHistory(false); setFileOwner(null); setRequirement(null); setError('') }, [scope, selection])
  useEffect(() => {
    if (active && !wasActive.current) void refreshWorkspace()
    wasActive.current = active
  }, [active])
  const contextName = contexts.find((choice) => contextKey(choice.context) === contextKey(context))?.name ?? (context.kind === 'personal' ? '个人' : '原团队空间')
  const title = archiveId ? archives.find((item) => item.id === archiveId)?.title ?? '旧问答归档' : current?.locked ? '原会话当前不可访问' : current?.conversation?.title ?? '新对话'
  const currentProjects = projects.filter((project) => contextKey(project.context) === contextKey(context))
  const openFiles = (): void => { if (canInteract()) setFileOwner(selection) }
  const canImportFiles = (value: WorkspaceEntry | undefined): boolean => {
    const client = conversationClient()
    return Boolean(client && typeof client.pickFiles === 'function' && typeof client.createDraft === 'function' && value?.loaded && !value.locked && !value.action && !value.session?.archivedAt && !['transcript', 'legacy'].includes(value.session?.historyKind ?? '') && (value.kind !== 'code' || value.directory || value.conversation?.workspace.kind === 'directory'))
  }
  const importFiles = (): void => {
    if (!canInteract() || !isPrivateEntrySelected(selection) || !canImportFiles(useConversations.getState().entries[selection])) return
    void addFiles(selection)
  }
  const startNew = async (destinationProjectId = projectId): Promise<void> => {
    if (!canInteract() || newPending) return
    if (kind === 'work') { newDraft(context, kind, destinationProjectId); setMobileHistory(false); return }
    const client = conversationClient()
    if (!client) { newDraft(context, kind, destinationProjectId); return }
    setNewPending(true); setError('')
    try {
      const directory = conversationValue(await client.pickDirectory())
      if (!directory || !canInteract() || useConversations.getState().selected[scope] !== selection || contextKey(useConversations.getState().context) !== contextKey(context) || useMy.getState().shellView !== shellView) return
      newDraft(context, kind, destinationProjectId, directory); setMobileHistory(false)
    } catch (cause) { if (canInteract() && currentOperationOwner.current === operationOwner) setError(conversationError(cause)) }
    finally { if (canInteract()) setNewPending(false) }
  }
  const choose = (conversation: Conversation): void => {
    if (!canInteract()) return
    selectConversation(conversation); useMy.getState().setShellView(conversation.kind === 'code' ? 'development' : 'collaboration'); setMobileHistory(false)
  }
  const openRequirement = async (): Promise<void> => {
    if (!canInteract() || requirementLoading) return
    setRequirementLoading(true); setError('')
    try {
      if (!useHifox.getState().workspaceContext.actorId) await useHifox.getState().bootstrap()
      if (!canInteract() || useConversations.getState().selected[scope] !== selection || contextKey(useConversations.getState().context) !== contextKey(context)) return
      const hifox = useHifox.getState(), source = hifox.workspaceContext
      if (!source.actorId || source.state === 'access-revoked') throw new Error('需求工作区尚未就绪，请稍后重试。')
      if (context.kind === 'team') {
        const space = hifox.snapshot?.spaces.find((item) => item.id === context.spaceId && !item.archived)
        if (source.key !== context.workspaceKey || !space) throw new Error('请先切回此会话关联的团队工作区，再创建需求。')
        hifox.setModule('tasks'); hifox.setCurrentSpace(context.spaceId); hifox.beginCreateTask({ spaceId: context.spaceId }); useApp.getState().setPage('hifox')
      } else setRequirement({ selection, workspaceKey: source.key, actorId: source.actorId, epoch: source.epoch })
    } catch (cause) { if (canInteract() && currentOperationOwner.current === operationOwner) setError(conversationError(cause)) }
    finally { if (canInteract()) setRequirementLoading(false) }
  }
  return <DocumentSourceProvider client={documentSource}><section className={`acp-workspace${collapsed && !mobileHistory ? ' is-sidebar-collapsed' : ''}`} style={style} aria-label="私人助手工作区" onKeyDown={(event) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || !canInteract()) return
    if ((event.ctrlKey || event.metaKey) && event.key === '.' && current) { event.preventDefault(); event.stopPropagation(); void controlConversation(current.key, 'cancel') }
  }}>
    <div className={`acp-navigation-host flex min-h-0 shrink-0${collapsed && !mobileHistory ? ' is-collapsed' : ''}`}><ConversationHistory context={context} kind={kind} selected={selection} projectId={projectId} open={mobileHistory} onProject={(id) => selectProjectScope(context, kind, id)} onSelect={choose} onNew={(id) => void startNew(id)} onClose={() => setMobileHistory(false)} /></div>
    <ConversationPreviewLayout ownerKey={preview.ownerKey} expanded={preview.expanded} onExpandedChange={preview.setExpanded} collapsed={preview.collapsed} previewCount={preview.tabs.length} onCollapsedChange={(value) => value ? preview.closeWebPreview() : preview.setCollapsed(false)} preview={preview.tabs.length > 0 && current?.session && !current.locked ? <ConversationPreviewTabs key={preview.ownerKey} shelf={preview} session={current.session} /> : null}>
    <WorkspaceCodePreview enabled={!archiveId} openCodePreview={preview.openCodePreview}>
    <main className="acp-main my-conversation-frame">
      <ConversationWorkspaceHeader leading={<button type="button" ref={historyButton} className={`my-control my-control-sm my-button-ghost acp-mobile-only acp-sidebar-toggle${collapsed ? ' is-visible' : ''}`} aria-label="展开对话历史" title="展开对话历史" onClick={() => { if (matchMedia('(max-width: 900px)').matches) setMobileHistory(true); else useMy.getState().toggleSidebar() }}><PanelLeft size={16} /></button>} identity={<><MessageSquare size={16} className="shrink-0 text-my-icon-secondary" /><strong title={title}>{title}</strong></>} actions={<>
        <Dropdown placement="bottom" width={280} trigger={({ open, toggle }) => <button type="button" className="acp-composer-context my-composer-control my-composer-control-label max-w-40" aria-expanded={open} onClick={toggle} aria-label={`对话上下文：${contextName}，仅你可见`} title={`${contextName} · 仅你可见`}>{context.kind === 'personal' ? <UserRound size={14} /> : <LockKeyhole size={14} />}<span>{contextName}</span><ChevronDown size={12} /></button>}>
          {(close) => <><DropdownHeader>对话上下文</DropdownHeader>{contexts.map((choice) => <DropdownItem key={contextKey(choice.context)} selected={contextKey(context) === contextKey(choice.context)} onClick={() => { changeContext(choice.context); close() }}><span className="my-item-title block">{choice.name}</span><span className="my-item-description block">仅你可见</span></DropdownItem>)}</>}
        </Dropdown>
        <ConversationKnowledgeMenu canAddFiles={active && !archiveId && canImportFiles(current)} onAddFiles={importFiles} /><button type="button" className="my-icon-control" aria-label={context.kind === 'team' ? '新建需求' : '新建个人需求材料'} title={context.kind === 'team' ? '新建需求' : '新建个人需求材料'} disabled={requirementLoading} onClick={() => void openRequirement()}><FilePlus2 size={16} /></button>{!archiveId && <button type="button" className="my-icon-control" aria-label="查看会话文件" title="会话文件" onClick={openFiles}><Files size={16} /></button>}<button type="button" className="my-icon-control" disabled={newPending} aria-label="新对话" title="新对话" onClick={() => void startNew()}><Plus size={16} /></button>
          {!archiveId && current && !current.locked && <Dropdown placement="bottom" align="right" width={256} trigger={({ open, toggle }) => <button type="button" className="my-icon-control" onClick={toggle} aria-expanded={open} aria-label="更多会话操作"><MoreHorizontal size={17} /></button>}>
            {(close) => <><DropdownItem icon={<RefreshCw size={14} />} onClick={() => { close(); if (current.conversation) void readConversation(current.key) }}>刷新此对话</DropdownItem><DropdownHeader>{context.kind === 'personal' ? '归入项目' : '归入专项'}</DropdownHeader><DropdownItem selected={!current.projectId} disabled={Boolean(current.action)} onClick={() => { close(); void reclassifyConversation(current.key, null) }}>未分组</DropdownItem>{currentProjects.map((project) => <DropdownItem key={project.id} icon={<Folder size={14} />} selected={current.projectId === project.id} disabled={Boolean(current.action)} onClick={() => { close(); void reclassifyConversation(current.key, project.id) }}>{project.name}</DropdownItem>)}{current.session?.connectionOwned && <DropdownItem disabled={Boolean(current.action)} onClick={() => { close(); void controlConversation(current.key, 'end') }}>结束连接</DropdownItem>}</>}
          </Dropdown>}
        </>} />
      {error && <div className="acp-history-note"><ConnectionNotice message={error} /><Button size="sm" variant="ghost" onClick={() => setError('')}>收起</Button></div>}
      {storageError && <ConnectionNotice message={storageError} />}
      {archiveId ? <ConversationArchive key={archiveId} id={archiveId} /> : selection ? <PrivateConversation entryKey={selection} onFiles={openFiles} onNew={() => void startNew()} onOpenWebPreview={preview.openWebPreview} /> : <div className="acp-empty" role="status">正在准备输入区…</div>}
    </main>
    </WorkspaceCodePreview>
    </ConversationPreviewLayout>
    {fileOwner === selection && !archiveId && <ConversationFiles key={selection} entryKey={selection} onClose={() => setFileOwner(null)} />}
    {requirement && requirement.selection === selection && requirementSource.key === requirement.workspaceKey && requirementSource.actorId === requirement.actorId && requirementSource.epoch === requirement.epoch && <CreateCreationDialog scope="personal" initialDraft={{ title: '', kind: 'document', body: '' }} onClose={() => setRequirement(null)} onCreated={(creationId) => {
      const source = useHifox.getState().workspaceContext
      if (!canInteract() || source.key !== requirement.workspaceKey || source.actorId !== requirement.actorId || source.epoch !== requirement.epoch) return
      setRequirement(null); openCreation({ workspaceKey: requirement.workspaceKey, actorId: requirement.actorId, creationId, scope: 'personal' })
    }} />}
  </section></DocumentSourceProvider>
}

function WorkspaceCodePreview({ enabled, openCodePreview, children }: { enabled: boolean; openCodePreview: OpenCodePreview; children: ReactNode }): JSX.Element {
  return enabled ? <CodePreviewProvider openCodePreview={openCodePreview}>{children}</CodePreviewProvider> : <>{children}</>
}
