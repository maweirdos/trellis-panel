import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Code2, FileText, Link2, Loader2, LockKeyhole, MessageSquare, Monitor, MousePointer2, Pencil, Plus, RefreshCw, Save, Search, X } from 'lucide-react'
import { creationTargetSchema, type CreationComment, type CreationSummary, type CreationView } from '@shared/creations'
import { creationTargetToPreviewTarget, previewTargetToCreationTarget, type PreviewAnchorStatus, type PreviewTarget } from '@shared/creation-preview'
import { Button, Dropdown, DropdownHeader, DropdownItem, EmptyState, Tabs } from '../my/ui'
import { PageBody, PageHeader, PageLayout, PageToolbar } from '../my/layout/PageLayout'
import { useHifox } from '../hifox/store'
import { ConnectionPanel } from '../hifox/ConnectionPanel'
import { hasIpc } from '../api'
import { useApp } from '../store'
import { PrototypePreview } from './PrototypePreview'
import { AdoptCreationDialog, CreateCreationDialog, OperationError, PublishCreationDialog } from './CreationDialogs'
import { GenerationPanel } from './GenerationPanel'
import { ReviewPanel } from './ReviewPanel'
import { ScenarioEditor } from './ScenarioEditor'
import { bodySize, draftFromView, readRetainedDraft, retainDraft, sameDraftContents, validateDraft, type CreationDraft, type CreationTarget } from './creation-state'
import { creationApi, useCreationCommands, useCreationList, useCreationOwner, useCreationView } from './hooks'
import { clearCreationTarget, openCreation, useCreationNavigation, type CreationLocation } from './navigation'
import './creation-workspace.css'

type WorkspaceTab = 'edit' | 'preview' | 'review'

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
  if (!view) return <PageLayout variant="full" className="creation-workspace"><PageHeader><Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={15} />创作</Button></PageHeader><PageBody>
    {query.error ? <div className="creation-error" role="alert"><span className="creation-grow">{query.error.error}</span><Button onClick={() => void query.refresh()}>重试</Button></div> : <Loading>正在读取创作…</Loading>}
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
    <PageHeader><Button variant="ghost" size="sm" aria-label="返回创作列表" onClick={onBack}><ArrowLeft size={16} /></Button>
      <div className="creation-title"><h1>{view.summary.title}</h1><span className="creation-meta">{view.summary.home === 'personal' ? <LockKeyhole size={12} /> : <Monitor size={12} />}{view.summary.home === 'personal' ? '个人创作' : '团队创作'}{view.selected.published ? ` · 评审版 R${view.selected.number}` : ' · 草稿'}</span></div>
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
    {item.kind === 'prototype' ? <Monitor size={18} /> : <FileText size={18} />}
    <span className="creation-list-title"><strong>{item.title}</strong><span className="creation-meta">{members?.find((person) => person.id === item.ownerId)?.name ?? item.ownerId}</span></span>
    <span className="creation-meta">{item.latestPublished ? `R${item.latestPublished.number}` : '草稿'}</span>
    <span className="creation-meta">{new Date(item.updatedAt).toLocaleDateString()}</span>
    <ArrowUpRight size={14} />
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
  const [search, setSearch] = useState('')
  const identity = JSON.stringify([context.key, context.actorId, context.epoch, context.authorizationRevision, context.state, activeScope, spaceId])
  const query = useCreationList({ scope: activeScope, spaceId, enabled: !matching })
  useEffect(() => { if (!useHifox.getState().snapshot) void bootstrap() }, [bootstrap])
  useLayoutEffect(() => { setCreating(false); setSearch('') }, [identity])
  const selectedSpace = snapshot?.spaces.find((space) => space.id === spaceId)
  const canCreate = Boolean(context.actorId && creationApi() && context.state !== 'access-revoked' && (activeScope === 'personal' || (selectedSpace && !selectedSpace.archived && selectedSpace.memberIds.includes(context.actorId))))
  const open = (item: Pick<CreationSummary, 'creationId' | 'canEdit' | 'latestPublished'>): void => {
    if (!context.actorId) return
    openCreation({ workspaceKey: context.key, actorId: context.actorId, creationId: item.creationId, ...(item.canEdit ? {} : { revisionId: item.latestPublished?.revisionId }), scope: activeScope, ...(spaceId ? { spaceId } : {}) })
  }
  if (matching) return <CreationDetail key={`${identity}:${matching.creationId}`} location={matching} onBack={clearCreationTarget} onRevision={(revisionId) => useCreationNavigation.setState({ target: { ...matching, revisionId } })} />
  const items = query.data?.items.filter((item) => item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? []
  return <PageLayout variant="full" className="creation-workspace">
    <PageHeader><h1 className="creation-page-title">创作</h1>{activeScope === 'personal' && hasIpc && <div className="min-w-0 max-w-64" role="group" aria-label="创作来源"><ConnectionPanel /></div>}{activeScope === 'team' && selectedSpace && <span className="creation-meta">{selectedSpace.name}</span>}<span className="creation-grow" /><Button size="sm" variant="primary" disabled={!canCreate} onClick={() => setCreating(true)}><Plus size={15} />新建创作</Button></PageHeader>
    <PageToolbar><label className="creation-search"><Search size={15} /><input className="my-input" aria-label="筛选已加载的创作" placeholder="筛选创作…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><span className="creation-grow" /><Button size="sm" variant="ghost" aria-label="刷新创作列表" disabled={query.busy} onClick={() => void query.refresh()}><RefreshCw size={15} /></Button></PageToolbar>
    <PageBody className="creation-list-body">
      {!context.actorId && <div className="creation-notice" role="status">{loadError ?? '正在读取工作区身份…'}{loadError && <Button size="sm" onClick={() => void bootstrap()}>重试</Button>}</div>}
      {activeScope === 'team' && !spaceId && <EmptyState title="请选择一个空间" />}
      {query.error && <div className="creation-error" role="alert"><span className="creation-grow">{query.error.error}</span><Button size="sm" onClick={() => void query.refresh()}>重试</Button></div>}
      {query.busy && !query.data ? <Loading>正在读取创作…</Loading> : query.data && <>
        {items.length === 0 && <EmptyState title={search ? '已加载的创作中没有匹配项' : '还没有创作'} description={search ? undefined : '创建交互原型或文档'} />}
        <div className="creation-list">{items.map((item) => <CreationListRow key={item.creationId} item={item} onOpen={() => open(item)} />)}</div>
        {query.data.hasMore && <div className="creation-list-more"><Button disabled={query.busy} onClick={() => void query.loadMore()}>{query.busy ? '正在加载…' : '加载更多创作'}</Button></div>}
      </>}
    </PageBody>
    {creating && <CreateCreationDialog key={identity} scope={activeScope} spaceId={spaceId} onClose={() => setCreating(false)} onCreated={(creationId) => { setCreating(false); open({ creationId, canEdit: true, latestPublished: null }) }} />}
  </PageLayout>
}

export default CreationWorkspace
