import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { ExternalLink, File, FolderOpen, RefreshCw } from 'lucide-react'
import { CONVERSATION_IMAGE_PREVIEW_MAX_BYTES, type Conversation, type ConversationFile } from '@shared/private-conversations'
import { Select } from '../components/Select'
import { ArtifactDelivery } from '../conversations/ArtifactDelivery'
import { conversationClient, conversationError, conversationValue } from '../conversations/client'
import { useHifox } from '../hifox/store'
import { Button } from '../my/ui'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { ConversationTablePreview } from './ConversationTablePreview'
import { ConversationImagePreview } from './ConversationImagePreview'
import { PdfPreviewBoundary } from './PdfPreviewBoundary'

function contextIdentity(): string {
  const context = useHifox.getState().workspaceContext
  return JSON.stringify([context.key, context.actorId, context.epoch, context.authorizationRevision, context.state])
}

function fileType(name: string): string {
  const extension = /\.([^.]+)$/.exec(name)?.[1]
  return extension ? extension.toUpperCase() : '文件'
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Mount in the personal library only. The desktop service owns conversation authorization. */
export function ConversationArtifacts(): JSX.Element {
  const context = useHifox(state => state.workspaceContext)
  const active = useInteractionActive()
  const generation = useRef(0)
  const [version, setVersion] = useState(0)
  const identity = JSON.stringify([context.key, context.actorId, context.epoch, context.authorizationRevision, context.state])
  useLayoutEffect(() => {
    let previous = contextIdentity()
    return useHifox.subscribe(() => {
      const next = contextIdentity()
      if (next !== previous) {
        previous = next
        generation.current += 1
        setVersion(value => value + 1)
      }
    })
  }, [])
  return <ConversationArtifactsContent key={`${identity}:${version}:${active}`} generation={generation} owner={generation.current} active={active} />
}

function ConversationArtifactsContent({ generation, owner, active }: {
  generation: { current: number }; owner: number; active: boolean
}): JSX.Element {
  const client = conversationClient()
  const canInteract = useInteractionGuard()
  const signal = useInteractionSignal()
  const mounted = useRef(false)
  const request = useRef(0)
  const selectedRef = useRef('')
  const previewOpener = useRef<HTMLElement | null>(null)
  const pendingPreviewFocus = useRef<{ opener: HTMLElement; ticket: number; conversationId: string } | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [catalogError, setCatalogError] = useState('')
  const [selected, setSelected] = useState('')
  const [files, setFiles] = useState<ConversationFile[]>([])
  const [fileState, setFileState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [delivery, setDelivery] = useState<{ conversation: Conversation; file: ConversationFile } | null>(null)
  const [table, setTable] = useState<{ conversation: Conversation; file: ConversationFile } | null>(null)
  const [image, setImage] = useState<{ conversation: Conversation; file: ConversationFile } | null>(null)
  const [pdf, setPdf] = useState<{ conversation: Conversation; file: ConversationFile } | null>(null)
  const [docx, setDocx] = useState<{ conversation: Conversation; file: ConversationFile } | null>(null)
  const [ConversationPdfPreview, setPdfPreviewComponent] = useState(() => lazy(() => import('./ConversationPdfPreview')))
  const [ConversationDocxPreview, setDocxPreviewComponent] = useState(() => lazy(() => import('./ConversationDocxPreview')))
  const valid = (ticket: number): boolean => mounted.current && active && !signal?.aborted && canInteract() && generation.current === owner && request.current === ticket

  const loadCatalog = async (): Promise<void> => {
    if (!client || !mounted.current || !active || !canInteract() || generation.current !== owner) return
    const ticket = ++request.current
    selectedRef.current = ''
    setSelected(''); setFiles([]); setFileState('idle'); setDelivery(null); setTable(null); setImage(null); setPdf(null); setDocx(null); setBusy(false)
    setCatalogState('loading'); setCatalogError(''); setError('')
    try {
      const list = conversationValue(await client.list({ archive: 'active' }))
      if (!valid(ticket)) return
      setConversations(list.filter(item => item.archivedAt === undefined)); setCatalogState('ready')
    } catch (cause) {
      if (valid(ticket)) { setCatalogError(conversationError(cause)); setCatalogState('error') }
    }
  }

  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current += 1 }
  }, [])
  useEffect(() => { if (client && active) void loadCatalog() }, [client, active])

  // Recheck the selected active conversation before each operation. IDs are never
  // substituted if it has since been archived, removed or become inaccessible.
  const currentConversation = async (id: string, ticket: number): Promise<Conversation | null> => {
    if (!client) return null
    const list = conversationValue(await client.list({ archive: 'active' }))
    if (!valid(ticket) || selectedRef.current !== id) return null
    const conversation = list.find(item => item.id === id && item.archivedAt === undefined)
    if (!conversation) throw new Error('原会话已归档或不可用，请刷新会话列表。')
    const original = conversations.find(item => item.id === id)
    if (!original || original.creatorId !== conversation.creatorId || original.workspace.root !== conversation.workspace.root || original.workspace.kind !== conversation.workspace.kind || original.kind !== conversation.kind) {
      throw new Error('原会话来源已变化，请刷新会话列表后重新选择。')
    }
    return conversation
  }

  const loadFiles = async (id: string): Promise<void> => {
    if (!client || !canInteract() || generation.current !== owner) return
    const ticket = ++request.current
    selectedRef.current = id
    setSelected(id); setFiles([]); setDelivery(null); setTable(null); setImage(null); setPdf(null); setDocx(null); setError(''); setBusy(false)
    if (!id) { setFileState('idle'); return }
    setFileState('loading')
    try {
      const conversation = await currentConversation(id, ticket)
      if (!conversation || !valid(ticket)) return
      const result = conversationValue(await client.files(id))
      if (valid(ticket) && selectedRef.current === id) { setFiles(result); setFileState('ready') }
    } catch (cause) {
      if (valid(ticket)) { setError(conversationError(cause)); setFileState('error') }
    }
  }

  const act = async (file: ConversationFile, action: 'open' | 'reveal' | 'deliver' | 'preview' | 'preview-image' | 'preview-pdf' | 'preview-docx', opener?: HTMLElement): Promise<void> => {
    const id = selectedRef.current
    if (!client || !id || busy || !canInteract() || generation.current !== owner) return
    if (opener && (action === 'preview' || action === 'preview-image' || action === 'preview-pdf' || action === 'preview-docx')) previewOpener.current = opener
    const ticket = ++request.current
    setBusy(true); setError('')
    try {
      const conversation = await currentConversation(id, ticket)
      if (!conversation || !valid(ticket)) return
      if (!file.sourceIdentity) throw new Error('无法核实原会话来源，请刷新文件。')
      if (action === 'deliver') { setTable(null); setImage(null); setPdf(null); setDocx(null); setDelivery({ conversation, file }) }
      else if (action === 'preview') { setImage(null); setPdf(null); setDocx(null); setTable({ conversation, file }) }
      else if (action === 'preview-image') { setTable(null); setPdf(null); setDocx(null); setImage({ conversation, file }) }
      else if (action === 'preview-pdf') { setPdfPreviewComponent(() => lazy(() => import('./ConversationPdfPreview'))); setTable(null); setImage(null); setDocx(null); setPdf({ conversation, file }) }
      else if (action === 'preview-docx') { setDocxPreviewComponent(() => lazy(() => import('./ConversationDocxPreview'))); setTable(null); setImage(null); setPdf(null); setDocx({ conversation, file }) }
      else conversationValue(await client.openFile(id, { fileId: file.id, action, expectedRevision: file.revision, expectedSourceIdentity: file.sourceIdentity }))
    } catch (cause) {
      if (valid(ticket)) setError(conversationError(cause))
    } finally {
      if (valid(ticket)) setBusy(false)
    }
  }

  const shouldFocusPreviewError = (): boolean => {
    const focused = document.activeElement
    return mounted.current && active && !signal?.aborted && canInteract() && generation.current === owner
      && (!focused || focused === document.body || focused === document.documentElement || focused === previewOpener.current)
  }

  const restorePreviewFocus = (): void => {
    const pending = pendingPreviewFocus.current
    if (!pending) return
    if (!mounted.current || !active || signal?.aborted || !canInteract() || generation.current !== owner || request.current !== pending.ticket || selectedRef.current !== pending.conversationId || !pending.opener.isConnected) {
      pendingPreviewFocus.current = null
      return
    }
    const focused = document.activeElement
    if (focused && focused !== document.body && focused !== document.documentElement) { pendingPreviewFocus.current = null; return }
    if (pending.opener.matches(':disabled')) return
    pendingPreviewFocus.current = null
    pending.opener.focus()
  }

  const closePreview = (kind: 'table' | 'image' | 'pdf' | 'docx', errorBoundary = false): void => {
    if (kind === 'table') setTable(null)
    else if (kind === 'image') setImage(null)
    else if (kind === 'pdf') setPdf(null)
    else setDocx(null)
    const opener = previewOpener.current
    previewOpener.current = null
    pendingPreviewFocus.current = opener ? { opener, ticket: request.current, conversationId: selectedRef.current } : null
    window.setTimeout(restorePreviewFocus, 0)
    if (!errorBoundary) requestAnimationFrame(restorePreviewFocus)
  }

  useEffect(() => {
    if (!busy && pendingPreviewFocus.current) window.setTimeout(restorePreviewFocus, 0)
  }, [busy])

  const readDocx = async (conversation: Conversation, file: ConversationFile, operationId: string, current: () => boolean) => {
    const validPreview = (): boolean => current() && mounted.current && active && !signal?.aborted && canInteract() && generation.current === owner && selectedRef.current === conversation.id
    if (!client?.previewDocx || !client.cancelDocx || !client.validatePdfLocator || !client.releasePdfLocator || !file.sourceIdentity || !validPreview()) throw new Error('DOCX 预览不可用，请使用系统打开。')
    const result = conversationValue(await client.previewDocx(conversation.id, { fileId: file.id, expectedRevision: file.revision, expectedSourceIdentity: file.sourceIdentity, operationId }))
    if (!validPreview() || !result.locator) {
      if (result.locator) void client.releasePdfLocator(result.locator).catch(() => {})
      throw new Error('原会话来源已变化，请重新选择文件。')
    }
    return result
  }

  const readPdf = async (conversation: Conversation, file: ConversationFile, current: () => boolean) => {
    const validPreview = (): boolean => current() && mounted.current && active && !signal?.aborted && canInteract() && generation.current === owner && selectedRef.current === conversation.id
    if (!client || !file.sourceIdentity || typeof client.previewPdf !== 'function' || !client.validatePdfLocator || !client.releasePdfLocator || !validPreview()) throw new Error('PDF 预览不可用，请使用系统打开。')
    const result = conversationValue(await client.previewPdf(conversation.id, { fileId: file.id, expectedRevision: file.revision, expectedSourceIdentity: file.sourceIdentity }))
    if (!validPreview() || !result.locator) {
      if (result.locator) void client.releasePdfLocator(result.locator).catch(() => {})
      throw new Error('原会话来源已变化或 PDF 预览不可用，请重新选择文件。')
    }
    return { ...result, locator: result.locator }
  }

  const validatePdf = async (conversation: Conversation, locator: string, current: () => boolean): Promise<void> => {
    const validPreview = (): boolean => current() && mounted.current && active && !signal?.aborted && canInteract() && generation.current === owner && selectedRef.current === conversation.id
    if (!client?.validatePdfLocator || !validPreview()) throw new Error('原会话来源已变化，请重新选择文件。')
    conversationValue(await client.validatePdfLocator(locator))
    if (!validPreview()) throw new Error('原会话来源已变化，请重新选择文件。')
  }

  const readImage = async (conversation: Conversation, file: ConversationFile, current: () => boolean) => {
    const validPreview = (): boolean => current() && mounted.current && active && !signal?.aborted && canInteract() && generation.current === owner && selectedRef.current === conversation.id
    const checkConversation = async (): Promise<void> => {
      if (!client || !validPreview()) throw new Error('原会话来源已变化，请重新选择文件。')
      const list = conversationValue(await client.list({ archive: 'active' }))
      if (!validPreview()) throw new Error('原会话来源已变化，请重新选择文件。')
      const live = list.find(item => item.id === conversation.id && item.archivedAt === undefined)
      if (!live || live.creatorId !== conversation.creatorId || live.workspace.root !== conversation.workspace.root || live.workspace.kind !== conversation.workspace.kind || live.kind !== conversation.kind) throw new Error('原会话来源已变化或不可用，请刷新文件后重新选择。')
    }
    if (!client || !file.sourceIdentity || typeof client.previewImage !== 'function') throw new Error('图片预览不可用，请刷新文件或使用系统打开。')
    await checkConversation()
    if (file.bytes > CONVERSATION_IMAGE_PREVIEW_MAX_BYTES) throw new Error('图片超过 10 MiB 预览上限，请使用系统打开。')
    const result = conversationValue(await client.previewImage(conversation.id, { fileId: file.id, expectedRevision: file.revision, expectedSourceIdentity: file.sourceIdentity }))
    if (!validPreview()) throw new Error('原会话来源已变化，请重新选择文件。')
    await checkConversation()
    if (result.revision !== file.revision || result.name !== file.name) throw new Error('原文件已变化，请刷新文件后重新选择。')
    return result
  }

  const readTable = async (conversation: Conversation, file: ConversationFile, current: () => boolean): Promise<string> => {
    const validPreview = (): boolean => current() && mounted.current && active && !signal?.aborted && canInteract() && generation.current === owner && selectedRef.current === conversation.id
    const checkConversation = async (): Promise<void> => {
      if (!client || !validPreview()) throw new Error('原会话来源已变化，请重新选择文件。')
      const list = conversationValue(await client.list({ archive: 'active' }))
      if (!validPreview()) throw new Error('原会话来源已变化，请重新选择文件。')
      const live = list.find(item => item.id === conversation.id && item.archivedAt === undefined)
      if (!live || live.creatorId !== conversation.creatorId || live.workspace.root !== conversation.workspace.root || live.workspace.kind !== conversation.workspace.kind || live.kind !== conversation.kind) {
        throw new Error('原会话来源已变化或不可用，请刷新文件后重新选择。')
      }
    }
    if (!client || !file.sourceIdentity) throw new Error('无法核实原会话来源，请刷新文件后重新选择。')
    await checkConversation()
    const result = conversationValue(await client.readFile(conversation.id, { fileId: file.id, expectedRevision: file.revision, expectedSourceIdentity: file.sourceIdentity }))
    if (!validPreview()) throw new Error('原会话来源已变化，请重新选择文件。')
    await checkConversation()
    if (result.revision !== file.revision || result.name !== file.name) throw new Error('原文件已变化，请刷新文件后重新选择。')
    return result.body
  }

  if (!client) return <p className="my-item-description">会话文件仅在桌面应用中可用。</p>
  if (!active) return <></>
  return <section className="space-y-3" aria-label="发现会话文件">
    <div className="flex flex-wrap items-center gap-2">
      <Select size="sm" ariaLabel="选择会话" value={selected} onChange={value => void loadFiles(value)} disabled={catalogState !== 'ready'}
        placeholder="选择会话" options={[{ value: '', label: '选择会话' }, ...conversations.map(item => ({ value: item.id, label: `${item.title} · ${item.kind === 'work' ? 'Work' : 'Code'}` }))]} />
      <Button size="sm" variant="ghost" onClick={() => void loadCatalog()} disabled={catalogState === 'loading'} aria-label="刷新会话列表"><RefreshCw size={14} /></Button>
      {selected && <Button size="sm" variant="ghost" onClick={() => void loadFiles(selected)} disabled={fileState === 'loading'}><RefreshCw size={14} />刷新文件</Button>}
    </div>
    {catalogState === 'loading' && <p className="my-item-description" role="status">正在读取会话…</p>}
    {catalogState === 'error' && <div role="alert" className="flex flex-wrap items-center gap-2 text-my-sm text-my-danger-text">{catalogError}<Button size="sm" onClick={() => void loadCatalog()}>重试</Button></div>}
    {catalogState === 'ready' && conversations.length === 0 && <p className="my-item-description">没有可选择的未归档会话。</p>}
    {catalogState === 'ready' && conversations.length > 0 && !selected && <p className="my-item-description">选择会话后读取其工作目录中的文件。</p>}
    {fileState === 'loading' && <p className="my-item-description" role="status">正在读取所选会话的文件…</p>}
    {error && <div role="alert" className="flex flex-wrap items-center gap-2 text-my-sm text-my-danger-text">{error}{fileState === 'error' && <Button size="sm" onClick={() => void loadFiles(selected)}>重试</Button>}</div>}
    {fileState === 'ready' && <>
      <p className="my-item-description">仅显示所选会话授权目录中可发现的文件；扫描范围有限，列表可能不完整。</p>
      {files.length === 0 ? <p className="my-item-description">未发现可展示的文件。</p> : <ul className="divide-y divide-my-line">
        {files.map(file => <li key={file.id} className="flex flex-wrap items-center gap-3 py-3">
          <File size={16} className="shrink-0 text-my-tertiary" aria-hidden="true" />
          <div className="min-w-0 flex-1"><div className="my-item-title break-all">{file.name}</div><div className="my-item-description break-all">{file.relativePath} · {file.kind === 'input' ? '选入会话' : '发现于工作目录'} · {fileType(file.name)} · {fileSize(file.bytes)} · 修改于 {new Date(file.modifiedAt).toLocaleString()}</div></div>
          <div className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(file, 'open')} aria-label={`打开 ${file.name}`}><ExternalLink size={14} />打开</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(file, 'reveal')} aria-label={`在文件夹中显示 ${file.name}`}><FolderOpen size={14} />定位</Button>
            {/\.(csv|tsv)$/i.test(file.name) && <Button size="sm" variant="outline" disabled={busy} onClick={(event) => void act(file, 'preview', event.currentTarget)} aria-label={`预览表格 ${file.name}`}>预览表格</Button>}
            {/\.(png|jpe?g|webp|gif)$/i.test(file.name) && <Button size="sm" variant="outline" disabled={busy} onClick={(event) => void act(file, 'preview-image', event.currentTarget)} aria-label={`预览图片 ${file.name}`}>预览图片</Button>}
            {/\.pdf$/i.test(file.name) && <Button size="sm" variant="outline" disabled={busy} onClick={(event) => void act(file, 'preview-pdf', event.currentTarget)} aria-label={`预览 PDF ${file.name}`}>预览 PDF</Button>}
            {/\.docx$/i.test(file.name) && <Button size="sm" variant="outline" disabled={busy} onClick={(event) => void act(file, 'preview-docx', event.currentTarget)} aria-label={`预览 DOCX ${file.name}`}>内容预览</Button>}
            {/\.(md|txt|html|htm)$/i.test(file.name) && file.bytes <= 256 * 1024 && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(file, 'deliver')}>整理为创作</Button>}
          </div>
        </li>)}
      </ul>}
    </>}
    {table && <ConversationTablePreview key={`${table.conversation.id}:${table.file.id}:${table.file.revision}:${table.file.sourceIdentity}`} file={table.file}
      load={current => readTable(table.conversation, table.file, current)} onClose={() => closePreview('table')} />}
    {image && <ConversationImagePreview key={`${image.conversation.id}:${image.file.id}:${image.file.revision}:${image.file.sourceIdentity}`} file={image.file}
      load={current => readImage(image.conversation, image.file, current)} onClose={() => closePreview('image')} onOpen={() => void act(image.file, 'open')} />}
    {docx && <PdfPreviewBoundary key={`${docx.conversation.id}:${docx.file.id}:${docx.file.revision}:${docx.file.sourceIdentity}`} label="DOCX" shouldFocus={shouldFocusPreviewError} onClose={() => closePreview('docx', true)} onOpen={() => void act(docx.file, 'open')}><Suspense fallback={<p role="status" className="my-item-description">正在加载预览…</p>}><ConversationDocxPreview file={docx.file}
      load={(operationId, current) => readDocx(docx.conversation, docx.file, operationId, current)} validate={(locator, current) => validatePdf(docx.conversation, locator, current)}
      cancel={operationId => { void client.cancelDocx?.(operationId).catch(() => {}) }} release={locator => { void client.releasePdfLocator?.(locator).catch(() => {}) }}
      onClose={() => closePreview('docx')} onOpen={() => void act(docx.file, 'open')} /></Suspense></PdfPreviewBoundary>}
    {pdf && <PdfPreviewBoundary key={`${pdf.conversation.id}:${pdf.file.id}:${pdf.file.revision}:${pdf.file.sourceIdentity}`} shouldFocus={shouldFocusPreviewError} onClose={() => closePreview('pdf', true)} onOpen={() => void act(pdf.file, 'open')}><Suspense fallback={<p className="my-item-description" role="status">正在准备 PDF 预览…</p>}><ConversationPdfPreview file={pdf.file}
      load={current => readPdf(pdf.conversation, pdf.file, current)} validate={(locator, current) => validatePdf(pdf.conversation, locator, current)} release={locator => { void client.releasePdfLocator?.(locator).catch(() => {}) }} onClose={() => closePreview('pdf')} onOpen={() => void act(pdf.file, 'open')} /></Suspense></PdfPreviewBoundary>}
    {delivery && <ArtifactDelivery key={`${delivery.conversation.id}:${delivery.file.id}:${delivery.file.revision}`} conversation={delivery.conversation} file={delivery.file} onClose={() => setDelivery(null)} />}
  </section>
}

export default ConversationArtifacts
