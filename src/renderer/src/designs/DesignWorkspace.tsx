import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowLeft, ArrowUp, ArrowUpRight, Check, ChevronDown, Code2, Download, Eye, FileText, GitCompareArrows, History, Loader2, Maximize2, MessageSquare, MousePointer2, Pencil, RefreshCw, Save, Send, Trash2, Type, X } from 'lucide-react'
import { designPagesSchema, type DesignAdopt, type DesignDocument, type DesignFrame, type DesignPage, type DesignSave, type DesignSelection } from '@shared/design-workspace'
import { buildDesignPrototype } from '@shared/design-prototype'
import { CREATION_MAX_BODY_BYTES } from '@shared/creations'
import { Button, Dropdown, DropdownHeader, DropdownItem, Tabs } from '../my/ui'
import { Select } from '../components/Select'
import { CreateCreationDialog } from '../creations/CreationDialogs'
import { openCreation } from '../creations/navigation'
import { useHifox } from '../hifox/store'
import { useConversations } from '../conversations/workspace'
import { conversationError, conversationValue } from '../conversations/client'
import { useInteractionGuard } from '../utils/interaction-scope'
import { useApp } from '../store'
import { confirmDialog } from '../components/Dialogs'
import { IpcErrorCode } from '@shared/ipc-errors'
import { notifyDesignChanged, requireDesignClient } from './client'
import { closeDesign, openDesign } from './navigation'
import { openDesignConversation, type DesignConversationReference } from './conversation'
import { useDesignDocument } from './hooks'
import { DesignCanvas } from './DesignCanvas'
import { DesignPublishedPreview } from './DesignPublishedPreview'
import { replaceDesignElementText, sourceSelection, type DesignElementPick } from './preview-bridge'
import type { DesignPreviewPort } from './DesignPreview'
import './design-workspace.css'

interface DesignBuffer { baseRevision: string; pages: DesignPage[]; frames: DesignFrame[]; dirty: boolean; pending?: DesignSave | DesignAdopt & { action: 'adopt' | 'discard' }; error: string }
const retained = new Map<string, DesignBuffer>()
const cleanBuffer = (document: DesignDocument): DesignBuffer => ({ baseRevision: document.revision, pages: document.pages, frames: document.frames, dirty: false, error: '' })
interface Props { documentId: string; versionRequest?: { version: string; token: string } | null; onClose(): void; embedded?: boolean; onReference?(reference: DesignConversationReference): void; restoreSelection?: DesignSelection; onExpandedChange?(): void }

export function DesignWorkspace(props: Props): JSX.Element {
  const query = useDesignDocument(props.documentId)
  const document = query.document
  const canInteract = useInteractionGuard()
  const owner = useConversations(state => state.conversations.find(value => value.id === document?.conversationId)?.creatorId ?? '')
  const bufferKey = `${owner}:${props.documentId}`
  const [buffer, setBuffer] = useState<DesignBuffer | null>(null), [busy, setBusy] = useState(false)
  const [pick, setPick] = useState<DesignElementPick | null>(null), [mode, setMode] = useState<'select' | 'interact'>('select')
  const [version, setVersion] = useState('current'), [comparing, setComparing] = useState(false), [compareSide, setCompareSide] = useState<'current' | 'candidate'>('candidate')
  const [pageId, setPageId] = useState<string | null>(null), [prototype, setPrototype] = useState(false), [sourceOpen, setSourceOpen] = useState(false)
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null)
  const [textEdit, setTextEdit] = useState<{ pick: DesignElementPick; text: string } | null>(null)
  const [issue, setIssue] = useState(''), [saved, setSaved] = useState(false), [publish, setPublish] = useState<{ title: string; body: string } | null>(null)
  const ports = useRef(new Map<string, DesignPreviewPort>()), mounted = useRef(false), live = useRef({ bufferKey, document, buffer })
  const canvasHistory = useRef<Array<string | null>>([])
  const frameGesture = useRef<{ bufferKey: string; buffer: DesignBuffer; frame: DesignFrame; saved: boolean } | null>(null)
  live.current = { bufferKey, document, buffer }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setBuffer(retained.get(bufferKey) ?? null); setPick(null); setSelectedFrameId(null); frameGesture.current = null; setTextEdit(null); setIssue(''); setSaved(false) }, [bufferKey])
  useEffect(() => {
    if (!document) return
    setBuffer(current => current?.dirty || current?.pending ? current : retained.get(bufferKey)?.dirty || retained.get(bufferKey)?.pending ? retained.get(bufferKey) ?? null : cleanBuffer(document))
  }, [document, bufferKey])
  useEffect(() => { if (buffer) { if (retained.size >= 32 && !retained.has(bufferKey)) { const key = [...retained].find(([, value]) => !value.dirty && !value.pending)?.[0]; if (key) retained.delete(key) }; retained.set(bufferKey, buffer) } }, [bufferKey, buffer])
  const consumedVersionRequest = useRef<string | null>(null)
  useEffect(() => {
    const request = props.versionRequest
    if (!document || !request || consumedVersionRequest.current === request.token) return
    if (request.version !== 'current' && !document.candidates.some(candidate => `candidate:${candidate.id}` === request.version)) return
    consumedVersionRequest.current = request.token
    setVersion(request.version); setComparing(false); setPrototype(false); setSourceOpen(false); setPick(null)
  }, [document, props.versionRequest])
  const selectionOwner = `${version}:${compareSide}:${comparing}:${document?.revision}:${mode}:${pageId}:${prototype}`
  useEffect(() => { setPick(null); setTextEdit(null) }, [selectionOwner])
  const candidate = document?.candidates.find(candidate => `candidate:${candidate.id}` === version)
  const historical = document?.history.find(history => `history:${history.revision}` === version)
  const shownCandidate = candidate && (!comparing || compareSide === 'candidate')
  const shownHistory = !candidate && historical, shownLatest = version === 'latest'
  const pages = shownCandidate ? candidate.pages : shownHistory ? historical.pages : shownLatest ? document?.pages ?? [] : buffer?.pages ?? document?.pages ?? []
  const frames = shownCandidate ? candidate.frames : shownHistory ? historical.frames : shownLatest ? document?.frames ?? [] : buffer?.frames ?? document?.frames ?? []
  const revision = shownCandidate ? candidate.revision : shownHistory ? historical.revision : shownLatest ? document?.revision ?? '' : buffer?.baseRevision ?? document?.revision ?? ''
  const sourceReadOnly = Boolean(document?.readOnly)
  const readOnly = sourceReadOnly || version !== 'current' || busy || Boolean(buffer?.pending)
  const conflict = Boolean(document && buffer && document.revision !== buffer.baseRevision && buffer.dirty)
  const currentPage = pages.find(page => page.id === (pageId ?? frames.find(frame => frame.id === selectedFrameId)?.pageId)) ?? pages[0]
  const patch = (update: Partial<DesignBuffer>): void => { if (!readOnly && canInteract()) { setSaved(false); setBuffer(value => value ? { ...value, ...update, dirty: true, error: '' } : value) } }
  const fail = (cause: unknown): void => { if (mounted.current) setIssue(conversationError(cause)) }
  const refresh = async (): Promise<void> => { setIssue(''); await query.refresh() }
  const accept = (next: DesignDocument): void => { query.accept(next); setBuffer(cleanBuffer(next)); setPick(null); setTextEdit(null); setSaved(true); setIssue(''); notifyDesignChanged() }
  const save = async (override?: DesignPage[]): Promise<void> => {
    if (!document || !buffer || version !== 'current' || busy || (conflict || sourceReadOnly) && !buffer.pending || !canInteract()) return
    const pending = buffer.pending
    if (pending && 'action' in pending) return
    const input: DesignSave = pending ?? { documentId: document.id, expectedRevision: buffer.baseRevision, commandId: crypto.randomUUID(), pages: override ?? buffer.pages, frames: buffer.frames }
    const parsed = designPagesSchema.safeParse(input.pages)
    if (!parsed.success) { setIssue(parsed.error.issues[0]?.message ?? '页面内容无效'); return }
    const captured = bufferKey
    const submitted = { ...buffer, pages: input.pages ?? buffer.pages, frames: input.frames ?? buffer.frames, dirty: buffer.dirty || Boolean(override), pending: input }
    setBusy(true); setIssue(''); retained.set(captured, submitted); setBuffer(submitted)
    try {
      const result = await requireDesignClient().save(input)
      if (!result.ok) { if (result.code === IpcErrorCode.InvalidArg || result.code === IpcErrorCode.Conflict) { const old = retained.get(captured); if (old) retained.set(captured, { ...old, pending: undefined }); if (mounted.current && live.current.bufferKey === captured) setBuffer(value => value ? { ...value, pending: undefined } : value) }; throw new Error(result.error) }
      retained.set(captured, cleanBuffer(result.value))
      if (mounted.current && live.current.bufferKey === captured) accept(result.value)
    } catch (cause) { if (mounted.current && live.current.bufferKey === captured) fail(cause) }
    finally { if (mounted.current && live.current.bufferKey === captured) setBusy(false) }
  }
  const resolveCandidate = async (action: 'adopt' | 'discard'): Promise<void> => {
    if (!document || !buffer || !candidate && !buffer.pending || sourceReadOnly && !buffer.pending || buffer.dirty || busy || !canInteract()) return
    const old = buffer.pending
    if (old && (!('action' in old) || old.action !== action)) return
    const input = old && 'action' in old ? old : candidate ? { action, documentId: document.id, candidateId: candidate.id, expectedRevision: document.revision, commandId: crypto.randomUUID() } : null
    if (!input) return
    const { action: operation, ...payload } = input, captured = bufferKey
    setBusy(true); setIssue(''); retained.set(captured, { ...buffer, pending: input }); setBuffer(value => value ? { ...value, pending: input } : value)
    try {
      const result = await requireDesignClient()[operation](payload)
      if (!result.ok) { if (result.code === IpcErrorCode.InvalidArg || result.code === IpcErrorCode.Conflict) { const old = retained.get(captured); if (old) retained.set(captured, { ...old, pending: undefined }); if (mounted.current && live.current.bufferKey === captured) setBuffer(value => value ? { ...value, pending: undefined } : value) }; throw new Error(result.error) }
      retained.set(captured, cleanBuffer(result.value))
      if (mounted.current && live.current.bufferKey === captured) { accept(result.value); setVersion('current'); setComparing(false) }
    } catch (cause) { if (mounted.current && live.current.bufferKey === captured) fail(cause) }
    finally { if (mounted.current && live.current.bufferKey === captured) setBusy(false) }
  }
  const chooseVersion = (key: string): void => { setVersion(key); setComparing(false); setPrototype(false); setSourceOpen(false); setPick(null) }
  const reference = async (): Promise<void> => {
    if (!document || !buffer || version !== 'current' || buffer.dirty || conflict || readOnly || !canInteract()) return
    if (pick && !await ports.current.get(pick.frameId ?? '')?.validate(pick)) { setPick(null); setIssue('页面选区已变化，请重新选择。'); return }
    const target: DesignConversationReference = { documentId: document.id, revision: document.revision, title: document.title, ...(pick ? { selection: sourceSelection(pick), validate: () => ports.current.get(pick.frameId ?? '')?.validate(pick) ?? Promise.resolve(false) } : {}) }
    if (props.onReference) props.onReference(target)
    else { await openDesignConversation(document, pick ? sourceSelection(pick) : undefined) }
  }
  const exporting = async (format: 'source' | 'prototype'): Promise<void> => {
    if (!document || buffer?.dirty || busy || buffer?.pending || !canInteract()) return
    setBusy(true); setIssue('')
    try { conversationValue(await requireDesignClient().export({ documentId: document.id, expectedRevision: document.revision, format })) }
    catch (cause) { fail(cause) } finally { if (mounted.current) setBusy(false) }
  }
  const preparePublish = (): void => {
    if (!document || buffer?.dirty || buffer?.pending) return
    try {
      const body = buildDesignPrototype({ id: document.id, title: document.title, revision: document.revision, pages: document.pages })
      if (new TextEncoder().encode(body).length > CREATION_MAX_BODY_BYTES) { setIssue('完整原型超过 256 KiB 发布上限。请导出原型，或精简内嵌资源后再整理到空间。'); return }
      setPublish({ title: document.title, body })
    } catch (cause) { fail(cause) }
  }
  const libraryContext = useHifox(state => state.workspaceContext)
  if (!document || !buffer) return <section className="design-workspace" aria-label="设计工作台">{!props.embedded && <div className="design-toolbar"><Button size="sm" variant="ghost" onClick={props.onClose}><ArrowLeft size={14} />返回</Button></div>}<div className="design-loading" role={query.error ? 'alert' : 'status'}>{query.error || <><Loader2 size={18} className="design-spinner" />正在读取设计…</>}{query.error && <Button size="sm" onClick={() => void refresh()}>重试</Button>}</div></section>
  const canModify = !readOnly && !conflict && version === 'current'
  const changeFrames = (next: DesignFrame[]): void => {
    if (readOnly || !canInteract()) return
    setSaved(false)
    setBuffer(value => value ? { ...value, frames: next, pages: value.pages.map(page => { const frame = next.find(frame => frame.pageId === page.id); return frame ? { ...page, width: frame.width, height: frame.height } : page }), dirty: true, error: '' } : value)
  }
  const endFrameGesture = (cancelled: boolean): void => {
    const start = frameGesture.current
    frameGesture.current = null
    if (!cancelled || !start || start.bufferKey !== bufferKey) return
    const originalPage = start.buffer.pages.find(page => page.id === start.frame.pageId)
    setBuffer(value => {
      if (!value || value.baseRevision !== start.buffer.baseRevision) return value
      const pages = value.pages.map(page => page.id === start.frame.pageId && originalPage ? { ...page, width: originalPage.width, height: originalPage.height } : page)
      const frames = value.frames.map(frame => frame.id === start.frame.id ? start.frame : frame)
      const otherChanges = JSON.stringify({ pages, frames }) !== JSON.stringify({ pages: start.buffer.pages, frames: start.buffer.frames })
      return { ...value, pages, frames, dirty: start.buffer.dirty || otherChanges, error: start.buffer.error }
    })
    setSaved(start.saved)
  }
  const showPick = (value: DesignElementPick | null): void => {
    if (value && (version !== 'current' || conflict)) { setPick(null); return }
    if (value?.frameId) setSelectedFrameId(value.frameId)
    setPick(value); if (value) setTextEdit(null)
    if (value && props.restoreSelection && value.selector === props.restoreSelection.selector && value.pageId === props.restoreSelection.pageId && value.revision === document.revision && props.onReference) props.onReference({ documentId: document.id, revision: document.revision, title: document.title, selection: sourceSelection(value), validate: () => ports.current.get(value.frameId ?? '')?.validate(value) ?? Promise.resolve(false) })
  }
  const revisionTitle = candidate ? `候选 · ${new Date(candidate.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : historical ? `历史 · ${new Date(historical.createdAt).toLocaleString()}` : shownLatest ? '最新修订' : '当前稿'
  return <section className={`design-workspace${props.embedded ? ' is-embedded' : ''}`} data-design-document={document.id} aria-label="设计工作台">
    <header className="design-workspace-heading"><div className="design-identity"><FileText size={16} /><div><strong className="my-item-title" title={document.title}>{document.title}</strong><span className="my-item-description">{document.pages.length} 页 · {revisionTitle}</span></div></div><span className="design-grow" />
      <span className="design-save-state" role="status">{busy ? <Loader2 size={14} className="design-spinner" /> : buffer.pending ? '待核对' : buffer.dirty ? '未保存' : saved ? <Check size={14} /> : null}</span>
      {version === 'current' && <Button size="sm" variant={buffer.dirty ? 'primary' : 'ghost'} disabled={busy || (conflict || sourceReadOnly) && !buffer.pending || !buffer.dirty && !buffer.pending} onClick={() => void save()}><Save size={14} /><span>{buffer.pending ? '核对保存' : '保存'}</span></Button>}
      <Dropdown align="right" trigger={({ open, toggle }) => <Button size="sm" variant="ghost" aria-label="导出与整理设计" aria-expanded={open} disabled={busy || buffer.dirty || Boolean(buffer.pending)} onClick={toggle}><Download size={15} /><ChevronDown size={12} /></Button>}>{close => <><DropdownHeader>当前修订</DropdownHeader><DropdownItem icon={<Code2 size={14} />} onClick={() => { close(); void exporting('source') }}>导出设计源包</DropdownItem><DropdownItem icon={<Eye size={14} />} onClick={() => { close(); void exporting('prototype') }}>导出可运行原型</DropdownItem><DropdownItem icon={<ArrowUpRight size={14} />} onClick={() => { close(); preparePublish() }}>整理为可发布产物</DropdownItem><DropdownItem icon={<MessageSquare size={14} />} onClick={() => { close(); void openDesignConversation(document).catch(fail) }}>来源会话</DropdownItem></>}</Dropdown>
      {props.embedded && <Button size="sm" variant="ghost" title="全屏打开设计" aria-label="全屏打开设计" onClick={() => openDesign(document.id)}><Maximize2 size={15} /></Button>}
      {!props.embedded && <Button size="sm" variant="ghost" title="返回产物库" aria-label="返回产物库" onClick={props.onClose}><X size={15} /></Button>}
    </header>
    <div className="design-toolbar"><Select size="sm" ariaLabel="画布页面" value={pageId ?? '*'} onChange={value => { canvasHistory.current = []; setPageId(value === '*' ? null : value) }} options={[{ value: '*', label: `全部页面 · ${pages.length}` }, ...pages.map(page => ({ value: page.id, label: page.title }))]} />
      <div className="my-segmented" role="group" aria-label="画布模式"><Button size="sm" variant="ghost" aria-label="选择元素" aria-pressed={!prototype && mode === 'select'} disabled={readOnly} onClick={() => { setPrototype(false); setMode('select') }}><MousePointer2 size={14} /><span>选择</span></Button><Button size="sm" variant="ghost" aria-label="交互页面" aria-pressed={!prototype && mode === 'interact'} onClick={() => { setPrototype(false); setMode('interact') }}><Pencil size={14} /><span>交互</span></Button></div>
      <Button size="sm" variant="ghost" aria-pressed={prototype} onClick={() => { setPrototype(value => !value); setPick(null) }}><Eye size={14} />原型</Button><span className="design-grow" />
      <Dropdown align="right" trigger={({ open, toggle }) => <Button size="sm" onClick={toggle} aria-expanded={open}><History size={14} /><span>{revisionTitle}</span><ChevronDown size={12} /></Button>}>{close => <><DropdownItem selected={version === 'current'} onClick={() => { close(); chooseVersion('current') }}>当前稿</DropdownItem>{document.candidates.length > 0 && <DropdownHeader>AI 候选 · {document.candidates.length}</DropdownHeader>}{[...document.candidates].reverse().map(candidate => <DropdownItem key={candidate.id} selected={version === `candidate:${candidate.id}`} onClick={() => { close(); chooseVersion(`candidate:${candidate.id}`) }}>{new Date(candidate.createdAt).toLocaleString()} · {candidate.title}</DropdownItem>)}{document.history.length > 0 && <DropdownHeader>历史修订</DropdownHeader>}{[...document.history].reverse().map(history => <DropdownItem key={history.revision} selected={version === `history:${history.revision}`} onClick={() => { close(); chooseVersion(`history:${history.revision}`) }}>{new Date(history.createdAt).toLocaleString()} · {history.reason === 'adopt' ? '采用候选' : history.reason === 'save' ? '手动保存' : '页面生成'}</DropdownItem>)}</>}</Dropdown>
      <Button size="sm" variant="ghost" aria-label="刷新设计" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /></Button>
    </div>
    {document.candidates.length > 0 && !candidate && !historical && <div className="design-candidate-strip"><GitCompareArrows size={14} /><span className="design-grow">{document.candidates.length} 个修改候选待查看</span><Button size="sm" onClick={() => chooseVersion(`candidate:${document.candidates.at(-1)?.id}`)}>查看候选</Button></div>}
    {candidate && <div className="design-candidate-strip"><span className="design-grow">{candidate.baseRevision !== document.revision ? '原稿已变化，此候选无法直接采用' : '修改候选'}</span><Button size="sm" variant="ghost" onClick={() => setComparing(value => !value)}><GitCompareArrows size={14} />{comparing ? '收起对比' : '对比原稿'}</Button><Button size="sm" variant="ghost" disabled={busy || buffer.dirty || sourceReadOnly} onClick={() => void resolveCandidate('discard')}><Trash2 size={14} />放弃</Button><Button size="sm" variant="primary" disabled={busy || buffer.dirty || sourceReadOnly || candidate.baseRevision !== document.revision} onClick={() => void resolveCandidate('adopt')}><Check size={14} />采用</Button></div>}
    {candidate && comparing && <div className="design-comparison-tabs"><Tabs tabs={[{ id: 'current', label: '当前稿' }, { id: 'candidate', label: 'AI 候选' }]} active={compareSide} onChange={setCompareSide} /></div>}
    {sourceReadOnly && <div className="design-notice" role="status">{document.sourceError || '此设计当前只读，请检查来源会话。'}</div>}
    {(issue || conflict || query.error || buffer.pending) && <div className="design-notice" role="alert"><span className="design-grow">{issue || query.error || (conflict ? '当前修订已变化，本地修改已保留。请核对后继续。' : '原操作结果待核对，请用原操作重试。')}</span>{buffer.pending && <Button size="sm" disabled={busy} onClick={() => { const pending = buffer.pending; if (pending && 'action' in pending) void resolveCandidate(pending.action); else void save() }}>核对原操作</Button>}<Button size="sm" disabled={busy} onClick={() => void refresh()}>刷新核对</Button>{conflict && !buffer.pending && <><Button size="sm" onClick={() => chooseVersion(shownLatest ? 'current' : 'latest')}>{shownLatest ? '查看本地修改' : '查看最新修订'}</Button><Button size="sm" disabled={sourceReadOnly} onClick={() => { void confirmDialog({ title: '基于最新修订继续本地修改？', message: '本地页面与布局会保留，保存后原修订仍可从历史查看。', confirmText: '继续编辑' }).then(confirmed => { if (confirmed && canInteract() && mounted.current) { setBuffer(value => value ? { ...value, baseRevision: document.revision } : value); chooseVersion('current') } }) }}>继续本地修改</Button></>}{issue && !buffer.pending && <Button size="sm" variant="ghost" aria-label="收起提示" onClick={() => setIssue('')}><X size={13} /></Button>}</div>}
    <div className="design-workspace-body">
      {prototype ? <DesignPublishedPreview key={`${document.id}:${revision}`} bundle={{ version: 1, id: document.id, title: document.title, revision, pages }} /> : <DesignCanvas documentId={document.id} revision={revision} pages={pages} frames={frames} pageId={pageId} selectedFrameId={selectedFrameId ?? undefined} disabled={!canModify} mode={readOnly ? mode === 'interact' ? 'interact' : 'read' : mode} onFrames={changeFrames} onSelectFrame={id => { setSelectedFrameId(id); if (pick?.frameId !== id) { setPick(null); setTextEdit(null) } }} onFrameGestureStart={frame => { frameGesture.current = { bufferKey, buffer, frame, saved } }} onFrameGestureEnd={endFrameGesture} onPick={showPick} onNavigate={id => { if (id !== pageId) { canvasHistory.current.push(pageId); setPageId(id) }; setMode('interact') }} onBack={() => setPageId(canvasHistory.current.pop() ?? null)} previewPorts={ports.current} restoreSelection={props.restoreSelection} />}
      {sourceOpen && currentPage && <section className="design-source-panel"><div className="design-toolbar"><span className="my-item-title">{currentPage.title} · HTML</span><span className="design-grow" /><Button size="sm" variant="ghost" aria-label="关闭源码" onClick={() => setSourceOpen(false)}><X size={14} /></Button></div><textarea className="my-input design-source-editor" aria-label={`${currentPage.title} HTML 源码`} spellCheck={false} readOnly={!canModify} value={currentPage.html} onChange={event => patch({ pages: buffer.pages.map(page => page.id === currentPage.id ? { ...page, html: event.target.value } : page) })} /></section>}
    </div>
    {pick && !readOnly && !prototype && <section className="design-selection" aria-label="所选元素"><div className="design-selection-main"><div className="design-selection-label"><span className="my-item-title">{pick.tagName} · {(pick.text ?? '').trim().slice(0, 70) || '元素'}</span><span className="my-item-description" title={pick.selector}>{pick.path}</span></div><Button size="sm" variant="ghost" title="选择父级 Alt+↑" disabled={!pick.hasParent} onClick={() => ports.current.get(pick.frameId ?? '')?.parent()}><ArrowUp size={14} />父级</Button><Button size="sm" variant="ghost" onClick={() => ports.current.get(pick.frameId ?? '')?.locate()}>定位</Button><Button size="sm" variant="ghost" disabled={!pick.canEditText || buffer.dirty} onClick={() => setTextEdit({ pick, text: pick.text ?? '' })}><Type size={14} />文字</Button><Button size="sm" variant="primary" disabled={buffer.dirty || conflict} onClick={() => void reference().catch(fail)}><Send size={14} />让助手修改</Button><Button size="sm" variant="ghost" aria-label="清除选区" onClick={() => { ports.current.get(pick.frameId ?? '')?.clear(); setPick(null); setTextEdit(null) }}><X size={14} /></Button></div>
      {textEdit && <div className="design-text-editor"><textarea className="my-input" aria-label="元素文字" value={textEdit.text} maxLength={4000} rows={2} onChange={event => setTextEdit({ ...textEdit, text: event.target.value })} /><Button size="sm" variant="primary" disabled={busy || textEdit.text === textEdit.pick.text} onClick={() => { try { const page = buffer.pages.find(page => page.id === textEdit.pick.pageId); if (!page) throw new Error('页面已不存在，请重新选择。'); const next = replaceDesignElementText(page, textEdit.pick, textEdit.text); void save(buffer.pages.map(page => page.id === next.id ? next : page)) } catch (cause) { fail(cause) } }}><Save size={14} />保存文字</Button><Button size="sm" variant="ghost" onClick={() => setTextEdit(null)}>取消</Button></div>}
    </section>}
    <footer className="design-footer"><span className="my-item-description">{version === 'current' ? '当前稿' : candidate ? '候选预览' : '历史预览'} · {pages.length} 页</span><span className="design-grow" /><Button size="sm" variant="ghost" aria-pressed={sourceOpen} onClick={() => setSourceOpen(value => !value)}><Code2 size={14} />源码</Button>{!props.embedded && <Button size="sm" disabled={buffer.dirty || busy} onClick={() => void openDesignConversation(document).catch(fail)}><MessageSquare size={14} />继续会话</Button>}{props.embedded && !pick && <Button size="sm" disabled={!canModify || buffer.dirty} onClick={() => void reference().catch(fail)}>引用整个设计</Button>}</footer>
    {publish && <CreateCreationDialog scope="personal" initialDraft={{ title: publish.title, kind: 'prototype', body: publish.body }} onClose={() => setPublish(null)} onCreated={creationId => { setPublish(null); const context = useHifox.getState().workspaceContext; if (context.actorId && context.key === libraryContext.key && context.actorId === libraryContext.actorId) { closeDesign(); openCreation({ workspaceKey: context.key, actorId: context.actorId, creationId, scope: 'personal' }); useApp.getState().setPage('creations') } }} />}
  </section>
}
