import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Code2, FileText, Grid2X2, LineChart, Link2, List, Loader2, LockKeyhole, MessageSquare, Monitor, MousePointer2, Pencil, RefreshCw, Save, Search, X } from 'lucide-react'
import { creationTargetSchema, type CreationComment, type CreationSummary, type CreationView } from '@shared/creations'
import { WHITEBOARD_V2_CAPABILITIES } from '@shared/creation-whiteboard-v2'
import { creationTargetToPreviewTarget, previewTargetToCreationTarget, type PreviewAnchorStatus, type PreviewTarget } from '@shared/creation-preview'
import { Button, Dropdown, DropdownHeader, DropdownItem, EmptyState, Tabs } from '../my/ui'
import { Select } from '../components/Select'
import { CreationSource } from './CreationSource'
import { PageBody, PageHeader, PageLayout, PageToolbar } from '../my/layout/PageLayout'
import { useCrux } from '../crux/store'
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
import { DesignLibraryCard, DesignNewTypes, formatRelativeTime } from '../designs/DesignLibrary'
import { useDesignLibrary } from '../designs/hooks'
import { closeDesign, openDesign, useDesignNavigation } from '../designs/navigation'
import { designClient } from '../designs/client'
import { DesignTurnDialog, type DesignMedium } from '../designs/DesignTurnDialog'
import './creation-workspace.css'

type WorkspaceTab = 'edit' | 'preview' | 'review'
type CreationCategory = 'all' | 'design' | 'document' | 'slides' | 'chart' | 'whiteboard' | 'table' | 'image'

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
    <div className="creation-row creation-comparison-toolbar"><span className="my-item-title">修订对比 · {side === 'candidate' ? 'AI 候选' : '当前草稿'}</span><span className="creation-grow" /><Button variant="ghost" size="sm" onClick={onClose}><X size={14} />收起比较</Button></div>
    {view.candidate && view.draft && view.candidate.baseDraftRevision !== view.draft.serial && <div className="creation-notice">候选生成后草稿已变化，请核对后重新生成</div>}
    {query.error && <div className="creation-error" role="alert"><span className="creation-grow">{query.error.error}</span><Button size="sm" onClick={() => void query.refresh()}>重试</Button></div>}
    {query.busy && !content ? <Loading>正在读取{side === 'candidate' ? '候选' : '草稿'}…</Loading> : content && <div className="creation-comparison-stage"><div className="creation-preview-frame">{view.summary.kind === 'prototype' ? <PrototypePreview body={content.body} mode="browse" selectedTarget={null} markers={[]} onSelect={() => undefined} /> : <TextPreview body={content.body} />}</div><div className="my-floating-stage-bar" role="group" aria-label="比较版本切换"><button type="button" aria-pressed={side === 'original'} onClick={() => setSide('original')}>当前草稿</button><button type="button" aria-pressed={side === 'candidate'} onClick={() => setSide('candidate')}>AI 候选</button></div></div>}
  </section>
}

function Loading({ children }: { children: ReactNode }): JSX.Element {
  return <div className="creation-loading" role="status"><Loader2 size={18} className="creation-spinner" /><span className="my-shimmer-text">{children}</span></div>
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
        {view.summary.adoptions.length > 0 && <details className="creation-adoptions"><summary><Link2 size={13} />已被 {new Set(view.summary.adoptions.map((entry) => entry.taskId)).size} 个任务采用</summary>{view.summary.adoptions.map((adoption) => <div className="creation-row" key={adoption.adoptionId}><Button size="sm" variant="ghost" onClick={() => { useCrux.getState().setModule('tasks'); useCrux.getState().openTask(adoption.taskId); useApp.getState().setPage('crux') }}>{useCrux.getState().snapshot?.tasks.find((task) => task.id === adoption.taskId)?.title ?? adoption.taskId}</Button><span className="my-chip">R{adoption.revisionNumber}</span><span className="creation-meta">{adoption.confirmedRules.length} 条规则</span></div>)}</details>}
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

function CreationSummaryCard({
  item,
  onOpen,
  workspaceName = 'local'
}: {
  item: CreationSummary
  onOpen(): void
  workspaceName?: string
}): JSX.Element {
  const relativeTime = formatRelativeTime(item.updatedAt)
  const isDoc = item.kind === 'document'

  return (
    <article
      className="design-library-card"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <div className="design-library-artboard-wrapper">
        <div className="design-library-artboard-sheet">
          <div className="design-card-placeholder" aria-hidden="true">
            <div className="design-mock-wireframe">
              <div className="design-mock-header">
                <div className="design-mock-dot" />
                <div className="design-mock-bar" />
              </div>
              <div className="design-mock-body">
                <div className="design-mock-line design-mock-line--lg" />
                <div className="design-mock-line design-mock-line--sm" />
                <div className="design-mock-card-row">
                  <div className="design-mock-box" />
                  <div className="design-mock-box" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="design-library-caption">
        <div
          className={`creation-icon-badge ${
            isDoc ? 'creation-icon-badge--document' : 'creation-icon-badge--chart'
          }`}
          aria-hidden="true"
        >
          {isDoc ? <FileText size={14} /> : <LineChart size={14} />}
        </div>
        <div className="design-library-caption-text">
          <div className="my-item-title creation-truncate">{item.title}</div>
          <div className="my-item-description creation-truncate">{`${workspaceName} · ${relativeTime}`}</div>
        </div>
      </div>
    </article>
  )
}

function CreationListRow({
  item,
  onOpen,
  workspaceName = 'local'
}: {
  item: CreationSummary
  onOpen: () => void
  workspaceName?: string
}): JSX.Element {
  const relativeTime = formatRelativeTime(item.updatedAt)
  const isDoc = item.kind === 'document'

  return (
    <button type="button" className="creation-list-row" onClick={onOpen}>
      <div
        className={`creation-icon-badge ${
          isDoc ? 'creation-icon-badge--document' : 'creation-icon-badge--chart'
        }`}
        aria-hidden="true"
      >
        {isDoc ? <FileText size={14} /> : <LineChart size={14} />}
      </div>
      <span className="creation-list-title">
        <span className="my-item-title creation-truncate">{item.title}</span>
        <span className="my-item-description creation-truncate">{`${workspaceName} · ${relativeTime}`}</span>
      </span>
      <span className="creation-list-kind creation-meta">
        {item.kind === 'prototype' ? '交互原型' : '文档'} · {item.home === 'personal' ? '个人' : '空间'}
      </span>
      <span className="creation-list-revision creation-meta">
        {item.latestPublished ? `已发布 R${item.latestPublished.number}` : '未发布'}
      </span>
      <span className="creation-list-date creation-meta">
        更新于 {new Date(item.updatedAt).toLocaleDateString()}
      </span>
      <ArrowUpRight className="creation-list-arrow" size={14} aria-hidden="true" />
    </button>
  )
}

export function CreationWorkspace({ scope = 'personal' }: { scope?: 'personal' | 'team' }): JSX.Element {
  const context = useCrux((state) => state.workspaceContext)
  const snapshot = useCrux((state) => state.snapshot)
  const bootstrap = useCrux((state) => state.bootstrap)
  const loadError = useCrux((state) => state.loadError)
  const currentSpaceId = useCrux((state) => state.currentSpaceId)
  const target = useCreationNavigation((state) => state.target)
  const matching = target && target.workspaceKey === context.key && target.actorId === context.actorId && target.scope === scope && (scope === 'personal' || target.spaceId === currentSpaceId) ? target : null
  const activeScope = matching?.scope ?? scope
  const spaceId = activeScope === 'team' ? matching?.spaceId ?? currentSpaceId ?? undefined : undefined
  const [creating, setCreating] = useState(false)
  const [resuming, setResuming] = useState<{ identity: CreationFormIdentity; creationId: string } | null>(null)
  useSyncExternalStore(subscribeCreationForms, creationFormsVersion)
  const [search, setSearch] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [category, setCategory] = useState<CreationCategory>('all')
  const [sort, setSort] = useState<'updated' | 'name'>('updated')
  const [layout, setLayout] = useState<'grid' | 'list'>('grid')
  const [showWhiteboard, setShowWhiteboard] = useState(false)
  const [accessDenied, setAccessDenied] = useState(false)
  const [newDesign, setNewDesign] = useState<DesignMedium>()
  const designDocumentId = useDesignNavigation(state => state.documentId)
  const designVersion = useDesignNavigation(state => state.versionRequest)
  const designs = useDesignLibrary(scope === 'personal' && !designDocumentId)
  const listScroll = useRef(0)
  const listMarker = useRef<HTMLDivElement>(null)
  const identity = JSON.stringify([context.key, context.actorId, context.epoch, context.authorizationRevision, context.state, activeScope, spaceId])
  const showingDesign = scope === 'personal' && Boolean(designDocumentId)
  const query = useCreationList({ scope: activeScope, spaceId, query: searchQuery, sort, enabled: !matching && !showingDesign })
  useEffect(() => { if (!showingDesign && !useCrux.getState().snapshot) void bootstrap() }, [bootstrap, showingDesign])
  useEffect(() => { const timer = setTimeout(() => setSearchQuery(search.trim()), 250); return () => clearTimeout(timer) }, [search])
  useLayoutEffect(() => { setCreating(false); setResuming(null); setSearch(''); setSearchQuery(''); setCategory('all'); setSort('updated'); setAccessDenied(false); setShowWhiteboard(false); listScroll.current = 0 }, [identity])
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
  if (scope === 'personal' && designDocumentId) return <DesignWorkspace key={designDocumentId} documentId={designDocumentId} versionRequest={designVersion} onClose={closeDesign} />
  if (matching) return <CreationDetail key={`${identity}:${matching.creationId}`} location={matching} onBack={clearCreationTarget} onRevision={(revisionId) => useCreationNavigation.setState({ target: { ...matching, revisionId } })} />
  const whiteboardAvailable = Boolean(WHITEBOARD_V2_CAPABILITIES.read && WHITEBOARD_V2_CAPABILITIES.create && hasIpc && api?.whiteboardV2 && activeScope === 'personal' && context.state === 'local' && context.actorId && snapshot)
  if (showWhiteboard && whiteboardAvailable) return <Suspense fallback={<Loading>正在加载白板…</Loading>}><WhiteboardEntry onBack={() => setShowWhiteboard(false)} /></Suspense>
  const data = accessLost ? null : query.data
  const pendingSearch = search.trim() !== searchQuery
  const loaded = data?.items ?? []
  const items = pendingSearch ? [] : query.mode === 'fallback'
    ? loaded.filter((item) => item.title.toLocaleLowerCase().includes(searchQuery.toLocaleLowerCase()))
      .sort((a, b) => sort === 'name' ? a.title.localeCompare(b.title, 'zh-CN') || b.updatedAt - a.updatedAt : b.updatedAt - a.updatedAt || a.title.localeCompare(b.title, 'zh-CN'))
    : loaded
  const filtered = Boolean(searchQuery || category !== 'all')
  const designItems = activeScope === 'personal' && !pendingSearch ? designs.items.filter(item => item.title.toLocaleLowerCase().includes(searchQuery.toLocaleLowerCase())) : []
  const combined = [...items.map(item => ({ type: 'creation' as const, item })), ...designItems.map(item => ({ type: 'design' as const, item }))]
    .sort((a, b) => sort === 'name' ? a.item.title.localeCompare(b.item.title, 'zh-CN') || b.item.updatedAt - a.item.updatedAt : b.item.updatedAt - a.item.updatedAt || a.item.title.localeCompare(b.item.title, 'zh-CN'))

  // Filter according to selected category
  const displayedCombined = combined.filter((entry) => {
    if (category === 'all') return true
    if (category === 'design') return entry.type === 'design'
    if (category === 'document') return entry.type === 'creation' && entry.item.kind === 'document'
    if (category === 'chart') return entry.type === 'creation' && entry.item.kind === 'prototype'
    return false
  })

  // Dynamic counts for category pills
  const countAll = loaded.length + designItems.length
  const countDesign = designItems.length
  const countDoc = loaded.filter(i => i.kind === 'document').length
  const countChart = loaded.filter(i => i.kind === 'prototype').length

  const categoryTabs: { id: CreationCategory; label: string; count: number }[] = [
    { id: 'all', label: '全部', count: countAll },
    { id: 'design', label: '设计稿', count: countDesign },
    { id: 'document', label: '文档', count: countDoc },
    { id: 'slides', label: '幻灯片', count: 0 },
    { id: 'chart', label: '图表', count: countChart },
    { id: 'whiteboard', label: '白板', count: 0 },
    { id: 'table', label: '表格', count: 0 },
    { id: 'image', label: '图片', count: 0 }
  ]

  const initiallyLoading = pendingSearch || (!combined.length && ((query.busy && !data) || (activeScope === 'personal' && designs.busy && !designs.items.length)))
  const workspaceName = context.key || 'local'

  return (
    <PageLayout variant="full" className="creation-workspace">
      <PageHeader>
        <span className="my-item-title">产物</span>
        <span className="creation-grow" />
        <Button
          size="sm"
          variant="ghost"
          aria-label="刷新产物列表"
          disabled={query.busy || designs.busy}
          onClick={() => {
            void query.refresh()
            void designs.refresh()
          }}
        >
          <RefreshCw size={14} />
        </Button>
      </PageHeader>

      <PageBody
        className="creation-list-body"
        onScroll={(event) => {
          listScroll.current = event.currentTarget.scrollTop
        }}
      >
        <div ref={listMarker} hidden />
        <div className="creation-container">
          <div className="creation-hero">
            <h1 className="creation-hero-title">产物</h1>
            <p className="creation-hero-description">
              在各个项目和会话里做出的设计稿、文档、幻灯片和白板，点开即可查看、修改或回到会话继续。
            </p>
          </div>

          {/* Single-line compact toolbar matching Fig 2 benchmark */}
          <div className="creation-list-toolbar">
            <label className="creation-search">
              <Search size={14} aria-hidden="true" />
              <input
                className="my-input"
                type="search"
                maxLength={200}
                aria-label="搜索产物名称"
                placeholder="搜索产物"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <Select
              size="sm"
              ariaLabel="项目筛选"
              value={activeScope}
              onChange={() => {}}
              options={[
                { value: 'personal', label: '全部项目' },
                ...(snapshot?.spaces.map((s) => ({ value: s.id, label: s.name })) ?? [])
              ]}
            />
            <Select
              size="sm"
              ariaLabel="产物排序"
              value={sort}
              onChange={setSort}
              options={[
                { value: 'updated', label: '最近编辑' },
                { value: 'name', label: '名称' }
              ]}
            />
            <div className="creation-view-switch" role="group" aria-label="产物视图">
              <button
                type="button"
                aria-label="网格视图"
                aria-pressed={layout === 'grid'}
                onClick={() => setLayout('grid')}
              >
                <Grid2X2 size={14} />
              </button>
              <button
                type="button"
                aria-label="列表视图"
                aria-pressed={layout === 'list'}
                onClick={() => setLayout('list')}
              >
                <List size={14} />
              </button>
            </div>
          </div>

          {/* New types 5-card row */}
          {activeScope === 'personal' && designClient() && (
            <DesignNewTypes
              busy={Boolean(newDesign)}
              onStartDesign={() => setNewDesign('web')}
              onDocument={() => setCreating(true)}
              onSlides={() => setCreating(true)}
              onChart={() => setCreating(true)}
              onWhiteboard={() => setShowWhiteboard(true)}
              documentDisabled={!canCreate}
            />
          )}

          {/* Category Tabs */}
          <div className="creation-category-pills my-fade-scroll-x">
            <Tabs<CreationCategory>
              tabs={categoryTabs}
              active={category}
              onChange={setCategory}
              ariaLabel="产物分类筛选"
            />
          </div>

          {retainedForms.length > 0 && (
            <details className="mb-4">
              <summary>继续未完成 · {retainedForms.length}</summary>
              <div className="creation-list creation-list--list">
                {retainedForms.map((form) => (
                  <button
                    type="button"
                    className="creation-list-row"
                    key={form.creationId}
                    onClick={() => setResuming({ identity: form.identity, creationId: form.creationId })}
                  >
                    <div className="creation-icon-badge creation-icon-badge--document" aria-hidden="true">
                      <FileText size={14} />
                    </div>
                    <span className="creation-list-title">
                      <span className="my-item-title creation-truncate">{form.title || '未命名表单'}</span>
                      <span className="my-item-description creation-truncate">
                        {form.identity.source
                          ? `${form.identity.source.fileName} · ${form.identity.source.revision.slice(0, 10)}`
                          : '新建产物'}
                      </span>
                    </span>
                    <span className="creation-meta">
                      {form.receipt ? '已创建' : form.pending ? '结果待确认' : '未提交'}
                    </span>
                    <ArrowUpRight className="creation-list-arrow" size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </details>
          )}

          {!context.actorId && (
            <div className="creation-notice" role="status">
              {loadError ?? '正在读取工作区身份…'}
              {loadError && <Button size="sm" onClick={() => void bootstrap()}>重试</Button>}
            </div>
          )}

          {context.state === 'access-revoked' && (
            <div className="creation-error" role="alert">当前工作区访问权限已失效</div>
          )}

          {activeScope === 'team' && !spaceId && <EmptyState title="请选择一个空间" />}

          {query.error && (
            <div className="creation-error" role="alert">
              <span className="creation-grow">
                {query.mode === 'fallback' && query.error.code === query.queryError?.code && data
                  ? '完整查询不可用，筛选与排序仅针对已加载产物。'
                  : `${query.error.error}${data ? ' · 显示上次已加载的结果' : ''}`}
              </span>
              <Button size="sm" onClick={() => void query.refresh()}>重试</Button>
            </div>
          )}

          {activeScope === 'personal' && designs.error && (
            <div className="creation-error" role="alert">
              <span className="creation-grow">{designs.error}</span>
              <Button size="sm" onClick={() => void designs.refresh()}>重新读取设计</Button>
            </div>
          )}

          {initiallyLoading ? (
            <Loading>正在读取产物…</Loading>
          ) : (
            (data || activeScope === 'personal') && (
              <>
                {displayedCombined.length === 0 && !designs.error && (
                  <EmptyState
                    title={filtered ? '没有找到匹配的产物' : '还没有产物'}
                    description={filtered ? '试试其他筛选条件' : '从新建设计开始，或导入文档与 HTML'}
                  />
                )}
                {displayedCombined.length > 0 && (
                  <div className={`creation-list creation-list--${layout}`}>
                    {displayedCombined.map((entry) =>
                      entry.type === 'design' ? (
                        <DesignLibraryCard
                          key={entry.item.id}
                          item={entry.item}
                          layout={layout}
                          workspaceName={workspaceName}
                          onOpen={() => {
                            clearCreationTarget()
                            openDesign(entry.item.id)
                          }}
                        />
                      ) : layout === 'grid' ? (
                        <CreationSummaryCard
                          key={entry.item.creationId}
                          item={entry.item}
                          workspaceName={workspaceName}
                          onOpen={() => open(entry.item)}
                        />
                      ) : (
                        <CreationListRow
                          key={entry.item.creationId}
                          item={entry.item}
                          workspaceName={workspaceName}
                          onOpen={() => open(entry.item)}
                        />
                      )
                    )}
                  </div>
                )}
                {data?.hasMore && (
                  <div className="creation-list-more">
                    <Button disabled={query.busy} onClick={() => void query.loadMore()}>
                      {query.busy ? '正在加载…' : '加载更多创作'}
                    </Button>
                  </div>
                )}
              </>
            )
          )}
        </div>
      </PageBody>

      {newDesign && <DesignTurnDialog medium={newDesign} onClose={() => setNewDesign(undefined)} />}
      {creating && (
        <CreateCreationDialog
          key={identity}
          scope={activeScope}
          spaceId={spaceId}
          onClose={() => setCreating(false)}
          onCreated={(creationId) => {
            setCreating(false)
            open({ creationId, canEdit: true, latestPublished: null })
          }}
        />
      )}

      {resuming && canResume && (
        <CreateCreationDialog
          key={`resume:${resuming.creationId}:${identity}`}
          scope={activeScope}
          spaceId={spaceId}
          resume={resuming}
          onClose={() => setResuming(null)}
          onCreated={(creationId) => {
            setResuming(null)
            open({ creationId, canEdit: true, latestPublished: null })
          }}
        />
      )}
    </PageLayout>
  )
}

export default CreationWorkspace
