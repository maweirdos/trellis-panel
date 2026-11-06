import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Code2, FileText, Grid2X2, Link2, List, Loader2, LockKeyhole, MessageSquare, Monitor, MousePointer2, Pencil, Plus, RefreshCw, Save, Search, X } from 'lucide-react'
import { creationTargetSchema, type CreationComment, type CreationSummary, type CreationView } from '@shared/creations'
import { WHITEBOARD_V2_CAPABILITIES } from '@shared/creation-whiteboard-v2'
import { creationTargetToPreviewTarget, previewTargetToCreationTarget, type PreviewAnchorStatus, type PreviewTarget } from '@shared/creation-preview'
import { Button, Dropdown, DropdownHeader, DropdownItem, EmptyState, Tabs } from '../my/ui'
import { Select } from '../components/Select'
import { CreationSource } from './CreationSource'
import { ConversationArtifacts } from './ConversationArtifacts'
import { PageBody, PageHeader, PageLayout, PageToolbar } from '../my/layout/PageLayout'
import { useHifox } from '../hifox/store'
import { ConnectionPanel } from '../hifox/ConnectionPanel'
import { api, hasIpc } from '../api'
import { useApp } from '../store'
import { PrototypePreview } from './PrototypePreview'
import { AdoptCreationDialog, CreateCreationDialog, OperationError, PublishCreationDialog } from './CreationDialogs'
import { GenerationPanel } from './GenerationPanel'
import { ReviewPanel } from './ReviewPanel'
import { ScenarioEditor } from './ScenarioEditor'
import { bodySize, draftFromView, readRetainedDraft, retainDraft, sameDraftContents, validateDraft, type CreationDraft, type CreationTarget } from './creation-state'
import { canAccessCreationForms, creationFormsVersion, listCreationForms, subscribeCreationForms, type CreationFormIdentity } from './creation-form-memory'
import { creationApi, useCreationCommands, useCreationList, useCreationOwner, useCreationView } from './hooks'
import { clearCreationTarget, openCreation, useCreationNavigation, type CreationLocation } from './navigation'
import { DesignWorkspace } from '../designs/DesignWorkspace'
import { DesignLibraryCard, DesignNewTypes } from '../designs/DesignLibrary'
import { useDesignLibrary } from '../designs/hooks'
import { closeDesign, openDesign, useDesignNavigation } from '../designs/navigation'
import { designClient, startDesignConversation } from '../designs/client'
import './creation-workspace.css'

type WorkspaceTab = 'edit' | 'preview' | 'review'
const WhiteboardEntry = lazy(() => import('./WhiteboardEntry').then((module) => ({ default: module.WhiteboardEntry })))

function RevisionPicker({ view, onChange, disabled }: { view: CreationView; onChange: (revisionId?: string) => void; disabled?: boolean }): JSX.Element {
  return <Dropdown trigger={({ toggle, open }) => <Button size="sm" onClick={toggle} disabled={disabled} aria-expanded={open}>{view.selected.published ? `R${view.selected.number}` : '当前草稿'}<ChevronDown size={13} /></Button>}>
    {(close) => <><DropdownHeader>修订</DropdownHeader>
      {view.draft && <DropdownItem selected={view.selected.revisionId === view.draft.revisionId} icon={<Pencil size={14} />} onClick={() => { onChange(); close() }}>当前草稿</DropdownItem>}
      {[...view.revisions].reverse().map((revision) => <DropdownItem key={revision.revisionId} selected={revision.revisionId === view.selected.revisionId} onClick={() => { onChange(revision.revisionId); close() }}>R{revision.number} · {revision.title}</DropdownItem>)}
    </>}
  </Dropdown>
}

function TextPreview({ body, annotate, onSelect }: { body: string; annotate?: boolean; onSelect?: (target: CreationTarget) => void }): JSX.Element {
  const content = useRef<HTMLDivElement>(null)
  const select = (): void => {
    if (!annotate || !onSelect || !content.current) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return
    const range = selection.getRangeAt(0)
    if (!content.current.contains(range.startContainer) || !content.current.contains(range.endContainer)) return
    const prefix = range.cloneRange()
    prefix.selectNodeContents(content.current)
    prefix.setEnd(range.startContainer, range.startOffset)
    const start = prefix.toString().length
    const quote = range.toString().slice(0, 1000)
    if (quote && body.slice(start, start + quote.length) === quote) onSelect({ kind: 'text', start, end: start + quote.length, quote })
  }
  return <div ref={content} className="creation-document" tabIndex={0} aria-label={annotate ? '文档正文，选择文字添加批注' : '文档正文'} onMouseUp={select} onKeyUp={select}>{body || <span className="creation-meta">暂无正文</span>}</div>
}

function CandidateComparison({ view, onClose }: { view: CreationView; onClose: () => void }): JSX.Element {
  const [side, setSide] = useState<'original' | 'candidate'>('candidate')
  const revisionId = side === 'candidate' ? view.candidate?.candidateId : view.draft?.revisionId
  const query = useCreationView(view.summary.creationId, revisionId)
  const content = query.view?.selected
  return <section className="creation-comparison">
    <div className="creation-row creation-comparison-toolbar"><Tabs tabs={[{ id: 'original', label: '当前草稿' }, { id: 'candidate', label: 'AI 候选' }]} active={side} onChange={setSide} /><span className="creation-grow" /><Button variant="ghost" size="sm" onClick={onClose}><X size={14} />收起比较</Button></div>
    {view.candidate && view.draft && view.candidate.baseDraftRevision !== view.draft.serial && <div className="creation-notice">候选生成后草稿已变化，请核对后重新生成</div>}
    {query.error && <div className="creation-error" role="alert"><span className="creation-grow">{query.error.error}</span><Button size="sm" onClick={() => void query.refresh()}>重试</Button></div>}
    {query.busy && !content ? <Loading>正在读取{side === 'candidate' ? '候选' : '草稿'}…</Loading> : content && <div className="creation-preview-frame">{view.summary.kind === 'prototype' ? <PrototypePreview body={content.body} mode="browse" selectedTarget={null} markers={[]} onSelect={() => undefined} /> : <TextPreview body={content.body} />}</div>}
  </section>
}

function Loading({ children }: { children: ReactNode }): JSX.Element {
  return <div className="creation-loading" role="status"><Loader2 size={18} className="creation-spinner" />{children}</div>
}

function CreationDetail({ location, onBack, onRevision }: { location: CreationLocation; onBack: () => void; onRevision: (revisionId?: string) => void }): JSX.Element {
  const { principalKey, capture, actorId } = useCreationOwner(`editor:${location.creationId}:${location.revisionId ?? 'draft'}`)
  const query = useCreationView(location.creationId, location.revisionId)
  const view = query.view
  const commands = useCreationCommands(location.creationId, view?.summary.revision ?? null, view?.selected.revisionId ?? location.revisionId ?? 'draft')
  const draftKey = `${principalKey}:${location.creationId}`
  const [draft, setDraft] = useState<CreationDraft | null>(() => readRetainedDraft(draftKey) ?? null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const [tab, setTab] = useState<WorkspaceTab>('preview')
  const initialTabChosen = useRef(false)
  const [annotationTarget, setAnnotationTarget] = useState<CreationTarget | null>(null)
  const [selectedTarget, setSelectedTarget] = useState<CreationTarget | null>(null)
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [missingAnchors, setMissingAnchors] = useState<Set<string>>(new Set())
  const [previewBody, setPreviewBody] = useState<string | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)
  const [adoptOpen, setAdoptOpen] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [validation, setValidation] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const selectedRevision = view?.selected.revisionId
  useEffect(() => {
    if (!view) return
    if (!initialTabChosen.current) {
      initialTabChosen.current = true
      setTab(view.summary.kind === 'document' && view.summary.canEdit && view.draft?.revisionId === view.selected.revisionId ? 'edit' : 'preview')
    }
    const incoming = draftFromView(view)
    if (incoming) setDraft((current) => current?.dirty && !sameDraftContents(current, incoming) ? current : incoming)
  }, [view])
  useEffect(() => { if (draft) retainDraft(draftKey, draft) }, [draftKey, draft])
  useLayoutEffect(() => {
    setAnnotationTarget(null); setSelectedTarget(null); setActiveCommentId(null); setSelectedIds([]); setMissingAnchors(new Set()); setPreviewBody(null); setComparing(false)
  }, [selectedRevision])
  useEffect(() => {
    if (view?.selected.published || (view && !view.summary.canEdit)) setTab((current) => current === 'edit' ? 'preview' : current)
  }, [view?.selected.published, view?.summary.canEdit])
  useEffect(() => {
    if (!view) return
    setMissingAnchors((current) => {
      const next = new Set(current)
      for (const comment of view.comments) {
        const target = comment.target
        if (target.kind === 'text') {
          if (view.selected.body.slice(target.start, target.end) !== target.quote) next.add(comment.commentId)
          else next.delete(comment.commentId)
        } else if (target.kind === 'scenario') {
          if (!view.selected.scenarios.some((scenario) => scenario.id === target.scenarioId)) next.add(comment.commentId)
          else next.delete(comment.commentId)
        }
      }
      return next
    })
  }, [view?.comments, view?.selected.body, view?.selected.scenarios])
  const changeDraft = (patch: Partial<CreationDraft>): void => { setSaved(false); setDraft((current) => current ? { ...current, ...patch, dirty: true } : current) }
  const reload = useCallback(async (): Promise<void> => { await query.refresh() }, [query.refresh])
  const selectTarget = (target: CreationTarget): void => { setSelectedTarget(target); setAnnotationTarget(target); setActiveCommentId(null) }
  const save = async (): Promise<void> => {
    const submitted = draftRef.current
    if (!submitted || !view) return
    const issue = validateDraft(submitted)
    if (issue) { setValidation(issue); return }
    if (submitted.baseSerial !== view.draft?.serial) { setValidation('草稿已更新，请先刷新并核对'); return }
    const valid = capture()
    setValidation(''); setSaving(true)
    const savedInput = { ...submitted, title: submitted.title.trim(), scenarios: submitted.scenarios.map((scenario) => ({ ...scenario, preconditions: scenario.preconditions.filter((line) => line.trim()) })) }
    const result = await commands.run({ action: 'saveDraft', title: savedInput.title, body: savedInput.body, scenarios: savedInput.scenarios,
      ...(view.summary.ownerId === actorId && submitted.privateNotes !== undefined ? { privateNotes: submitted.privateNotes } : {}) })
    if (!valid()) return
    if (result) {
      const fresh = await query.refresh()
      if (!valid()) return
      const incoming = fresh ? draftFromView(fresh) : null
      const exact = incoming && sameDraftContents(incoming, savedInput)
      if (incoming && exact) setDraft((current) => current === submitted ? incoming : current ? { ...current, baseSerial: incoming.baseSerial, baseRevisionId: incoming.baseRevisionId } : incoming)
      setSaved(Boolean(exact))
    }
    setSaving(false)
  }
  // The parent command owns the selected revision and refresh; child input clears only after commit.
  const reviewCommand: typeof commands.run = async (payload) => {
    const result = await commands.run(payload)
    if (result) await query.refresh()
    return result
  }
  const markers = useMemo(() => view?.comments.flatMap((comment, index) => {
    const target = creationTargetToPreviewTarget(comment.target)
    return target ? [{ id: comment.commentId, label: String(index + 1), target }] : []
  }) ?? [], [view?.comments])
  if (!view) return <PageLayout variant="full" className="creation-workspace"><PageHeader><Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={15} />产物</Button></PageHeader><PageBody>
    {query.error ? <div className="creation-error" role="alert"><span className="creation-grow">{query.error.error}</span><Button onClick={() => void query.refresh()}>重试</Button></div> : <Loading>正在读取产物…</Loading>}
  </PageBody></PageLayout>
  const selectedDraft = view.draft?.revisionId === view.selected.revisionId
  const editable = selectedDraft && view.summary.canEdit
  const canAnnotate = (selectedDraft && view.summary.canEdit) || (view.selected.published && (view.summary.canManageReview || view.revisions.find((revision) => revision.revisionId === view.selected.revisionId)?.reviewerIds.includes(actorId ?? '') === true))
  const conflict = Boolean(draft?.dirty && view.draft && draft.baseSerial !== view.draft.serial)
  const blocked = commands.busy || commands.recoveryRequired || saving || generating
  const dirty = Boolean(draft?.dirty)
  const body = tab === 'edit' ? previewBody ?? view.selected.body : view.selected.body
  const noteOwner = actorId === view.summary.ownerId && view.privateNotes !== undefined
  const takeTarget = (value: PreviewTarget): void => {
    const parsed = creationTargetSchema.safeParse(previewTargetToCreationTarget(value))
    if (parsed.success) selectTarget(parsed.data)
  }
  const selectComment = (comment: CreationComment): void => {
    setActiveCommentId(comment.commentId); setSelectedTarget(comment.target); setAnnotationTarget(null)
    document.getElementById(`creation-comment-${comment.commentId}`)?.scrollIntoView({ block: 'nearest' })
  }
  const readAnchorStatus = (status: PreviewAnchorStatus): void => {
    if (!activeCommentId) return
    setMissingAnchors((current) => {
      const next = new Set(current)
      if (status === 'missing' || status === 'ambiguous') next.add(activeCommentId)
      else next.delete(activeCommentId)
      return next
    })
  }
  return <PageLayout variant="full" className="creation-workspace" data-creation-id={location.creationId}>
    <PageHeader><Button variant="ghost" size="sm" aria-label="返回产物列表" onClick={onBack}><ArrowLeft size={16} /></Button>
      <div className="creation-title"><h1>{view.selected.title}</h1><span className="creation-meta">{view.summary.home === 'personal' ? <LockKeyhole size={12} /> : <Monitor size={12} />}{view.summary.home === 'personal' ? '个人产物' : '团队产物'}{view.selected.published ? ` · 评审版 R${view.selected.number}` : ' · 草稿'}</span></div>
      <span className="creation-grow" /><span className="creation-save-state" role="status">{saving ? <><Loader2 size={13} className="creation-spinner" />正在保存…</> : dirty ? '未保存' : saved ? <><Check size={13} />已保存</> : null}</span>
      {view.summary.canEdit && <>{editable && <Button size="sm" disabled={blocked || !dirty || conflict || query.changed} onClick={() => void save()}><Save size={14} />保存</Button>}<Button size="sm" variant="primary" disabled={blocked || dirty || !view.draft || query.changed} onClick={() => setPublishOpen(true)}><ArrowUpRight size={14} />发布评审版</Button></>}
    </PageHeader>
    <PageToolbar><Tabs<WorkspaceTab> tabs={[...(view.summary.canEdit ? [{ id: 'edit' as const, label: view.summary.kind === 'prototype' ? '源码' : '编辑' }] : []), { id: 'preview', label: '预览' }, { id: 'review', label: '评审' }]} active={tab} onChange={(next) => {
      if (next === 'edit' && !selectedDraft) { onRevision(); setTab('edit') } else setTab(next)
    }} /><span className="creation-grow" /><RevisionPicker view={view} onChange={onRevision} disabled={blocked} />
      {view.selected.published && view.summary.canManageReview && <Button size="sm" disabled={blocked || query.changed} onClick={() => setAdoptOpen(true)}><Link2 size={14} />采纳到任务</Button>}
      {tab === 'review' && <span className="creation-meta"><MessageSquare size={13} />{canAnnotate ? '选择页面元素添加批注' : '只读评审'}</span>}
    </PageToolbar>
    {(query.changed || conflict) && <div className="creation-notice" role="status"><RefreshCw size={14} /><span className="creation-grow">{conflict ? '服务端草稿已更新，本地输入已保留' : '创作有更新'}</span><Button size="sm" disabled={blocked || query.busy} onClick={() => void query.refresh()}>刷新</Button>
      {conflict && draft && view.draft && <Button size="sm" disabled={blocked} onClick={() => changeDraft({ baseSerial: view.draft?.serial ?? draft.baseSerial, baseRevisionId: view.draft?.revisionId ?? draft.baseRevisionId })}>用本地内容继续编辑</Button>}
    </div>}
    {query.error && <div className="creation-error" role="alert"><span className="creation-grow">{query.error.error}</span><Button size="sm" onClick={() => void query.refresh()}>重试</Button></div>}
    {!publishOpen && !adoptOpen && <OperationError commands={commands} onRecovered={() => void query.refresh()} onRefresh={() => { commands.clearError(); void query.refresh() }} />}
    {validation && <div className="creation-error" role="alert"><span className="creation-grow">{validation}</span><Button size="sm" variant="ghost" aria-label="收起提示" onClick={() => setValidation('')}><X size={14} /></Button></div>}
    <PageBody className="creation-detail-body"><div className="creation-detail-grid">
      <main className="creation-content my-scrollbar">
        {view.privateSource && <CreationSource key={`${location.creationId}:${view.privateSource.conversationId}:${view.privateSource.fileId}`} source={view.privateSource} disabled={dirty || blocked} />}
        {comparing && view.candidate ? <CandidateComparison view={view} onClose={() => setComparing(false)} /> : <>
          {tab === 'edit' && draft && editable && <div className="creation-source-editor">
            <label>标题<input className="my-input" aria-label="创作标题" value={draft.title} maxLength={200} onChange={(event) => changeDraft({ title: event.target.value })} /></label>
            <div className="creation-section-heading"><h2><Code2 size={15} />{view.summary.kind === 'prototype' ? 'HTML 源码' : '文档正文'}</h2><span className="creation-meta">{bodySize(draft.body)}</span><Button size="sm" variant="ghost" onClick={() => setPreviewBody(draft.body)}><RefreshCw size={13} />刷新预览</Button></div>
            <textarea className={`my-input creation-source ${view.summary.kind === 'prototype' ? 'creation-code' : ''}`} aria-label={view.summary.kind === 'prototype' ? 'HTML 源码' : '文档正文'} spellCheck={view.summary.kind !== 'prototype'} value={draft.body} onChange={(event) => changeDraft({ body: event.target.value })} />
            {noteOwner && <details className="creation-private-notes"><summary><LockKeyhole size={12} />私人备注</summary><textarea className="my-input" aria-label="私人备注，仅自己可见" placeholder="仅自己可见" value={draft.privateNotes ?? ''} maxLength={4000} rows={3} onChange={(event) => changeDraft({ privateNotes: event.target.value })} /></details>}
          </div>}
          <div className="creation-preview-caption"><span><Monitor size={13} />{tab === 'edit' ? '草稿预览' : view.selected.published ? `评审版 R${view.selected.number}` : '草稿预览'}</span><span><MousePointer2 size={12} />{tab === 'review' && canAnnotate ? view.summary.kind === 'prototype' ? '批注模式' : '选择文字添加批注' : view.summary.kind === 'prototype' ? '可交互预览' : '文档'}</span></div>
          <div className="creation-preview-frame">{view.summary.kind === 'prototype' ? <PrototypePreview body={body} mode={tab === 'review' && canAnnotate ? 'annotate' : 'browse'} selectedTarget={selectedTarget ? creationTargetToPreviewTarget(selectedTarget) : null}
            markers={markers} onSelect={takeTarget} onMarkerClick={(id) => { const comment = view.comments.find((entry) => entry.commentId === id); if (comment) selectComment(comment) }} onAnchorStatus={readAnchorStatus} onExitAnnotate={() => setTab('preview')} />
            : <TextPreview body={body} annotate={tab === 'review' && canAnnotate} onSelect={selectTarget} />}</div>
          <ScenarioEditor scenarios={tab === 'edit' && draft && editable ? draft.scenarios : view.selected.scenarios} editable={tab === 'edit' && editable} onChange={(scenarios) => changeDraft({ scenarios })} onAnnotate={canAnnotate ? (scenarioId) => { setTab('review'); selectTarget({ kind: 'scenario', scenarioId }) } : undefined} />
        </>}
        {view.summary.adoptions.length > 0 && <details className="creation-adoptions"><summary><Link2 size={13} />已被 {new Set(view.summary.adoptions.map((entry) => entry.taskId)).size} 个任务采用</summary>{view.summary.adoptions.map((adoption) => <div className="creation-row" key={adoption.adoptionId}><Button size="sm" variant="ghost" onClick={() => { useHifox.getState().setModule('tasks'); useHifox.getState().openTask(adoption.taskId); useApp.getState().setPage('hifox') }}>{useHifox.getState().snapshot?.tasks.find((task) => task.id === adoption.taskId)?.title ?? adoption.taskId}</Button><span className="my-chip">R{adoption.revisionNumber}</span><span className="creation-meta">{adoption.confirmedRules.length} 条规则</span></div>)}</details>}
      </main>
      <div className="creation-review-column">
        <ReviewPanel key={`review:${view.selected.revisionId}`} view={view} target={annotationTarget} activeCommentId={activeCommentId} missingAnchors={missingAnchors} canAnnotate={canAnnotate && !query.changed} busy={blocked || query.changed} selectedIds={selectedIds} loadingMore={query.loadingMore}
          onTarget={(target) => { setAnnotationTarget(target); if (target) { setSelectedTarget(target); setActiveCommentId(null) } }} onSelectComment={selectComment} onSelection={setSelectedIds} onCommand={reviewCommand} onLoadMore={query.loadMore} onOpenOrigin={onRevision} />
        {view.summary.canEdit && <GenerationPanel key={`generation:${view.selected.revisionId}`} view={view} selectedIds={selectedIds} dirty={dirty || query.changed} commands={commands} onUpdated={reload} onCompare={() => setComparing(true)} onBusyChange={setGenerating} />}
      </div>
    </div></PageBody>
    {publishOpen && <PublishCreationDialog view={view} commands={commands} onClose={() => setPublishOpen(false)} onPublished={(revisionId) => { setPublishOpen(false); setTab('review'); onRevision(revisionId) }} onRefresh={() => { commands.clearError(); void query.refresh() }} />}
    {adoptOpen && <AdoptCreationDialog view={view} commands={commands} onClose={() => setAdoptOpen(false)} onAdopted={() => { setAdoptOpen(false); void query.refresh() }} onLoadMore={query.loadMore} loadingMore={query.loadingMore} onRefresh={() => { commands.clearError(); void query.refresh() }} />}
  </PageLayout>
}

function CreationListRow({ item, onOpen }: { item: CreationSummary; onOpen: () => void }): JSX.Element {
  const members = useHifox((state) => state.snapshot?.members)
  return <button type="button" className="creation-list-row" onClick={onOpen}>
    <span className="creation-list-icon" aria-hidden="true">{item.kind === 'prototype' ? <Monitor size={18} /> : <FileText size={18} />}</span>
    <span className="creation-list-title"><span className="my-item-title creation-truncate">{item.title}</span><span className="my-item-description creation-truncate">{members?.find((person) => person.id === item.ownerId)?.name ?? item.ownerId}</span></span>
    <span className="creation-list-kind creation-meta">{item.kind === 'prototype' ? '交互原型' : '文档'} · {item.home === 'personal' ? '个人' : '空间'}</span>
    <span className="creation-list-revision creation-meta">{item.latestPublished ? `已发布 R${item.latestPublished.number}` : '未发布'}</span>
    <span className="creation-list-date creation-meta">更新于 {new Date(item.updatedAt).toLocaleDateString()}</span>
    <ArrowUpRight className="creation-list-arrow" size={14} aria-hidden="true" />
  </button>
}

export function CreationWorkspace({ scope = 'personal' }: { scope?: 'personal' | 'team' }): JSX.Element {
  const context = useHifox((state) => state.workspaceContext)
  const snapshot = useHifox((state) => state.snapshot)
  const bootstrap = useHifox((state) => state.bootstrap)
  const loadError = useHifox((state) => state.loadError)
  const currentSpaceId = useHifox((state) => state.currentSpaceId)
  const target = useCreationNavigation((state) => state.target)
  const matching = target && target.workspaceKey === context.key && target.actorId === context.actorId && target.scope === scope && (scope === 'personal' || target.spaceId === currentSpaceId) ? target : null
  const activeScope = matching?.scope ?? scope
  const spaceId = activeScope === 'team' ? matching?.spaceId ?? currentSpaceId ?? undefined : undefined
  const [creating, setCreating] = useState(false)
  const [resuming, setResuming] = useState<{ identity: CreationFormIdentity; creationId: string } | null>(null)
  useSyncExternalStore(subscribeCreationForms, creationFormsVersion)
  const [search, setSearch] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [kind, setKind] = useState<'all' | 'design' | 'document' | 'prototype'>('all')
  const [sort, setSort] = useState<'updated' | 'name'>('updated')
  const [layout, setLayout] = useState<'grid' | 'list'>('grid')
  const [showFiles, setShowFiles] = useState(false)
  const [showWhiteboard, setShowWhiteboard] = useState(false)
  const [accessDenied, setAccessDenied] = useState(false)
  const [designStarting, setDesignStarting] = useState(false), [designError, setDesignError] = useState('')
  const designDocumentId = useDesignNavigation(state => state.documentId)
  const designs = useDesignLibrary(scope === 'personal' && (kind === 'all' || kind === 'design') && !designDocumentId)
  const listScroll = useRef(0)
  const listMarker = useRef<HTMLDivElement>(null)
  const identity = JSON.stringify([context.key, context.actorId, context.epoch, context.authorizationRevision, context.state, activeScope, spaceId])
  const showingDesign = scope === 'personal' && Boolean(designDocumentId)
  const query = useCreationList({ scope: activeScope, spaceId, query: searchQuery, ...(kind === 'all' || kind === 'design' ? {} : { kind }), sort, enabled: !matching && kind !== 'design' && !showingDesign })
  useEffect(() => { if (!showingDesign && kind !== 'design' && !useHifox.getState().snapshot) void bootstrap() }, [bootstrap, showingDesign, kind])
  useEffect(() => { const timer = setTimeout(() => setSearchQuery(search.trim()), 250); return () => clearTimeout(timer) }, [search])
  useLayoutEffect(() => { setCreating(false); setResuming(null); setSearch(''); setSearchQuery(''); setKind('all'); setSort('updated'); setAccessDenied(false); setShowFiles(false); setShowWhiteboard(false); listScroll.current = 0 }, [identity])
  useLayoutEffect(() => { if (!matching && !showWhiteboard && listMarker.current?.parentElement) listMarker.current.parentElement.scrollTop = listScroll.current }, [Boolean(matching), showWhiteboard])
  const deniedByQuery = Boolean(query.error && /FORBIDDEN|REVOKED|UNAUTHORIZED/.test(query.error.code))
  useEffect(() => {
    if (deniedByQuery) setAccessDenied(true)
    else if (!query.busy && !query.error && query.data) setAccessDenied(false)
  }, [deniedByQuery, query.busy, query.error, query.data])
  const selectedSpace = snapshot?.spaces.find((space) => space.id === spaceId)
  const accessLost = context.state === 'access-revoked' || deniedByQuery || accessDenied
  const canCreate = Boolean(context.actorId && creationApi() && !accessLost && (activeScope === 'personal' || (selectedSpace && !selectedSpace.archived && selectedSpace.memberIds.includes(context.actorId))))
  const canResume = canAccessCreationForms({ state: context.state, actorId: context.actorId, epoch: context.epoch, hasAccess: canCreate,
    listAuthorized: Boolean(query.data && (!query.error || (query.mode === 'fallback' && query.error.code === query.queryError?.code))) })
  const retainedForms = canResume && context.actorId ? listCreationForms({ workspaceKey: context.key, actorId: context.actorId,
    epoch: context.epoch ?? null, scope: activeScope, spaceId: activeScope === 'team' ? spaceId ?? null : null }) : []
  const open = (item: Pick<CreationSummary, 'creationId' | 'canEdit' | 'latestPublished'>): void => {
    if (!context.actorId) return
    openCreation({ workspaceKey: context.key, actorId: context.actorId, creationId: item.creationId, ...(item.canEdit ? {} : { revisionId: item.latestPublished?.revisionId }), scope: activeScope, ...(spaceId ? { spaceId } : {}) })
  }
  if (scope === 'personal' && designDocumentId) return <DesignWorkspace key={designDocumentId} documentId={designDocumentId} onClose={closeDesign} />
  if (matching) return <CreationDetail key={`${identity}:${matching.creationId}`} location={matching} onBack={clearCreationTarget} onRevision={(revisionId) => useCreationNavigation.setState({ target: { ...matching, revisionId } })} />
  const whiteboardAvailable = Boolean(WHITEBOARD_V2_CAPABILITIES.read && WHITEBOARD_V2_CAPABILITIES.create && hasIpc && api?.whiteboardV2 && activeScope === 'personal' && context.state === 'local' && context.actorId && snapshot)
  if (showWhiteboard && whiteboardAvailable) return <Suspense fallback={<Loading>正在加载白板…</Loading>}><WhiteboardEntry onBack={() => setShowWhiteboard(false)} /></Suspense>
  const data = accessLost ? null : query.data
  const pendingSearch = search.trim() !== searchQuery
  const loaded = data?.items ?? []
  const items = pendingSearch || kind === 'design' ? [] : query.mode === 'fallback'
    ? loaded.filter((item) => (kind === 'all' || item.kind === kind) && item.title.toLocaleLowerCase().includes(searchQuery.toLocaleLowerCase()))
      .sort((a, b) => sort === 'name' ? a.title.localeCompare(b.title, 'zh-CN') || b.updatedAt - a.updatedAt : b.updatedAt - a.updatedAt || a.title.localeCompare(b.title, 'zh-CN'))
    : loaded
  const filtered = Boolean(searchQuery || kind !== 'all')
  const designItems = activeScope === 'personal' && !pendingSearch && (kind === 'all' || kind === 'design') ? designs.items.filter(item => item.title.toLocaleLowerCase().includes(searchQuery.toLocaleLowerCase())) : []
  const combined = [...items.map(item => ({ type: 'creation' as const, item })), ...designItems.map(item => ({ type: 'design' as const, item }))]
    .sort((a, b) => sort === 'name' ? a.item.title.localeCompare(b.item.title, 'zh-CN') || b.item.updatedAt - a.item.updatedAt : b.item.updatedAt - a.item.updatedAt || a.item.title.localeCompare(b.item.title, 'zh-CN'))
  const initiallyLoading = pendingSearch || !combined.length && (kind !== 'design' && query.busy && !data || activeScope === 'personal' && (kind === 'all' || kind === 'design') && designs.busy && !designs.items.length)
  const startDesign = async (kind: 'web' | 'app' | 'prototype'): Promise<void> => {
    if (designStarting) return
    setDesignStarting(true); setDesignError('')
    try { await startDesignConversation({ kind, text: kind === 'app' ? '设计一个应用界面：' : kind === 'prototype' ? '设计一个可交互原型：' : '设计一个网页：' }) }
    catch (cause) { setDesignError(cause instanceof Error ? cause.message : '新建设计未完成，请重试。') }
    finally { setDesignStarting(false) }
  }
  return <PageLayout variant="full" className="creation-workspace">
    <PageHeader><h1 className="creation-page-title">产物</h1><span className="creation-meta">{activeScope === 'personal' ? '个人产物' : selectedSpace ? `空间产物 · ${selectedSpace.name}` : '空间产物'}</span>{activeScope === 'personal' && hasIpc && <div className="min-w-0 max-w-64" role="group" aria-label="产物来源"><ConnectionPanel /></div>}<span className="creation-grow" />{whiteboardAvailable && <Button size="sm" onClick={() => setShowWhiteboard(true)}><Grid2X2 size={15} />本机白板</Button>}<Button size="sm" variant="primary" disabled={!canCreate} onClick={() => setCreating(true)}><Plus size={15} />新建产物</Button></PageHeader>
    {activeScope === 'personal' && designClient() && <DesignNewTypes busy={designStarting} onStart={kind => void startDesign(kind)} onDocument={() => setCreating(true)} documentDisabled={!canCreate} />}
    {designError && <div className="creation-error" role="alert">{designError}<Button size="sm" variant="ghost" aria-label="收起新建设计错误" onClick={() => setDesignError('')}><X size={14} /></Button></div>}
    <PageToolbar className="creation-list-toolbar"><Select size="sm" ariaLabel="产物类型" value={kind} onChange={setKind} options={[{ value: 'all', label: '全部类型' }, ...(activeScope === 'personal' ? [{ value: 'design' as const, label: '设计' }] : []), { value: 'document', label: '文档' }, { value: 'prototype', label: '交互原型' }]} /><label className="creation-search"><Search size={15} aria-hidden="true" /><input className="my-input" type="search" maxLength={200} aria-label="搜索产物名称" placeholder="搜索产物名称…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><span className="creation-grow" /><Select size="sm" ariaLabel="产物排序" value={sort} onChange={setSort} options={[{ value: 'updated', label: '最近编辑' }, { value: 'name', label: '名称' }]} /><div className="creation-view-switch" role="group" aria-label="产物视图"><Button size="sm" variant="ghost" aria-label="网格视图" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><Grid2X2 size={15} /></Button><Button size="sm" variant="ghost" aria-label="列表视图" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><List size={15} /></Button></div><Button size="sm" variant="ghost" aria-label="刷新产物列表" disabled={query.busy || designs.busy} onClick={() => { void query.refresh(); void designs.refresh() }}><RefreshCw size={15} /></Button></PageToolbar>
    <PageBody className="creation-list-body" onScroll={(event) => { listScroll.current = event.currentTarget.scrollTop }}>
      <div ref={listMarker} hidden />
      {retainedForms.length > 0 && <details className="mb-4"><summary>继续未完成 · {retainedForms.length}</summary>
        <div className="creation-list creation-list--list">{retainedForms.map((form) => <button type="button" className="creation-list-row" key={form.creationId} onClick={() => setResuming({ identity: form.identity, creationId: form.creationId })}>
          <span className="creation-list-icon" aria-hidden="true"><FileText size={18} /></span>
          <span className="creation-list-title"><span className="my-item-title creation-truncate">{form.title || '未命名表单'}</span><span className="my-item-description creation-truncate">{form.identity.source ? `${form.identity.source.fileName} · ${form.identity.source.revision.slice(0, 10)}` : '新建产物'}</span></span>
          <span className="creation-meta">{form.receipt ? '已创建' : form.pending ? '结果待确认' : '未提交'}</span>
          <ArrowUpRight className="creation-list-arrow" size={14} aria-hidden="true" />
        </button>)}</div>
      </details>}
      {activeScope === 'personal' && kind !== 'design' && hasIpc && !accessLost && context.actorId && <section className="mb-4">
        <Button size="sm" variant="ghost" aria-expanded={showFiles} onClick={() => setShowFiles((value) => !value)}><FileText size={14} />会话文件<ChevronDown size={14} /></Button>
        {showFiles && <div className="mt-3"><ConversationArtifacts /></div>}
      </section>}
      {kind !== 'design' && !context.actorId && <div className="creation-notice" role="status">{loadError ?? '正在读取工作区身份…'}{loadError && <Button size="sm" onClick={() => void bootstrap()}>重试</Button>}</div>}
      {kind !== 'design' && context.state === 'access-revoked' && <div className="creation-error" role="alert">当前工作区访问权限已失效</div>}
      {activeScope === 'team' && !spaceId && <EmptyState title="请选择一个空间" />}
      {kind !== 'design' && query.error && <div className="creation-error" role="alert"><span className="creation-grow">{query.mode === 'fallback' && query.error.code === query.queryError?.code && data ? '完整查询不可用，筛选与排序仅针对已加载产物。' : `${query.error.error}${data ? ' · 显示上次已加载的结果' : ''}`}</span><Button size="sm" onClick={() => void query.refresh()}>重试</Button></div>}
      {activeScope === 'personal' && designs.error && <div className="creation-error" role="alert"><span className="creation-grow">{designs.error}</span><Button size="sm" onClick={() => void designs.refresh()}>重新读取设计</Button></div>}
      {initiallyLoading ? <Loading>正在读取产物…</Loading> : (data || activeScope === 'personal') && <>
        <div className="creation-list-heading"><strong>{activeScope === 'personal' ? '个人产物' : '空间产物'}</strong><span className="creation-meta" role="status">{query.mode === 'fallback' && kind !== 'design' ? `已加载 ${loaded.length + designItems.length} 项 · 显示 ${combined.length} 项${data?.hasMore ? ' · 还有更多' : ''}` : data?.hasMore && kind !== 'design' ? `已加载 ${combined.length} 项 · 还有更多` : `显示 ${combined.length} 项`}</span></div>
        {combined.length === 0 && (kind === 'design' || !query.error) && !designs.error && <EmptyState title={filtered ? query.mode === 'fallback' && kind !== 'design' ? '已加载的产物中没有匹配项' : '没有找到匹配的产物' : '还没有产物'} description={data?.hasMore && query.mode === 'fallback' && kind !== 'design' ? '可继续加载更多产物' : filtered ? '试试其他筛选条件' : '从新建设计开始，或导入文档与 HTML'} />}
        {combined.length > 0 && <div className={`creation-list creation-list--${layout}`}>{combined.map(entry => entry.type === 'design' ? <DesignLibraryCard key={entry.item.id} item={entry.item} layout={layout} onOpen={() => { clearCreationTarget(); openDesign(entry.item.id) }} /> : <CreationListRow key={entry.item.creationId} item={entry.item} onOpen={() => open(entry.item)} />)}</div>}
        {kind !== 'design' && data?.hasMore && <div className="creation-list-more"><Button disabled={query.busy} onClick={() => void query.loadMore()}>{query.busy ? '正在加载…' : '加载更多创作'}</Button></div>}
      </>}
    </PageBody>
    {creating && <CreateCreationDialog key={identity} scope={activeScope} spaceId={spaceId} onClose={() => setCreating(false)} onCreated={(creationId) => { setCreating(false); open({ creationId, canEdit: true, latestPublished: null }) }} />}
    {resuming && canResume && <CreateCreationDialog key={`resume:${resuming.creationId}:${identity}`} scope={activeScope} spaceId={spaceId} resume={resuming} onClose={() => setResuming(null)} onCreated={(creationId) => { setResuming(null); open({ creationId, canEdit: true, latestPublished: null }) }} />}
  </PageLayout>
}

export default CreationWorkspace
