import { useEffect, useRef, useState, type JSX } from 'react'
import { X } from 'lucide-react'
import { AnnotationMode, getDocument, PDFWorker, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url&no-inline'
import { CONVERSATION_PDF_PREVIEW_MAX_BYTES, type ConversationFile } from '@shared/private-conversations'
import { Button } from '../my/ui'
import { offlinePdfResources } from './pdf-offline-resources'
import './conversation-table-preview.css'
import './conversation-pdf-preview.css'

const MAX_PAGES = 500
const MAX_IMAGE_PIXELS = 16_000_000
const MAX_CANVAS_PIXELS = 4_000_000
const MAX_CANVAS_SIDE = 2048
const MAX_PAGE_SIDE = 20_000
const MAX_TEXT_CHARS = 20_000
const MAX_TEXT_ITEMS = 2_000
const TIMEOUT_MS = 15_000
const MIN_ZOOM = 0.01
const ZOOM_STEP = 1.25

export type ConversationPdfPreviewData = { name: string; revision: string; data: Uint8Array; locator: string }
export interface ConversationPdfPreviewProps {
  file: ConversationFile
  load: (current: () => boolean) => Promise<ConversationPdfPreviewData>
  validate: (locator: string, current: () => boolean) => Promise<void>
  release: (locator: string) => Promise<void> | void
  onClose: () => void
  onOpen: () => void
}
type State = { kind: 'loading' } | { kind: 'ready'; data: Uint8Array; fail: (message: string) => void } | { kind: 'error'; message: string }

export default function ConversationPdfPreview({ file, load, validate, release, onClose, onOpen }: ConversationPdfPreviewProps): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const loadRef = useRef(load), validateRef = useRef(validate), releaseRef = useRef(release)
  const heading = useRef<HTMLHeadingElement>(null), opener = useRef<HTMLElement | null>(null)
  loadRef.current = load; validateRef.current = validate; releaseRef.current = release
  useEffect(() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; heading.current?.focus() }, [])
  useEffect(() => {
    let live = true, checking = false, released = false, validationTimeout = 0, interval = 0, timeout = 0
    let locator: string | undefined
    const loadOwned = loadRef.current, validateOwned = validateRef.current, releaseOwned = releaseRef.current
    const current = (): boolean => live
    const releaseOnce = (value: string): void => {
      if (released) return
      released = true
      try { void Promise.resolve(releaseOwned(value)).catch(() => {}) } catch { /* The original page may already be gone. */ }
    }
    const stop = (): void => {
      live = false
      window.clearTimeout(timeout); window.clearTimeout(validationTimeout); window.clearInterval(interval)
      if (locator) releaseOnce(locator)
    }
    const fail = (message: string): void => { if (live) { stop(); setState({ kind: 'error', message }) } }
    setState({ kind: 'loading' })
    timeout = window.setTimeout(() => fail('读取 PDF 超时，请重试或使用系统打开。'), TIMEOUT_MS)
    void Promise.resolve().then(() => live ? loadOwned(current) : null).then(value => {
      if (!value) return
      if (!live) { if (typeof value.locator === 'string' && value.locator) releaseOnce(value.locator); return }
      if (typeof value.locator !== 'string' || !value.locator) throw new Error('无法核实 PDF 来源，请刷新后重新选择。')
      locator = value.locator
      window.clearTimeout(timeout)
      if (!(value.data instanceof Uint8Array) || !value.data.length || value.data.length > CONVERSATION_PDF_PREVIEW_MAX_BYTES || value.name !== file.name || value.revision !== file.revision) throw new Error('文件内容或版本无效，请刷新后重新选择。')
      setState({ kind: 'ready', data: value.data, fail })
    }).catch(error => fail(error instanceof Error ? error.message : '无法读取 PDF。'))
    interval = window.setInterval(() => {
      if (!live || checking || !locator) return
      const admittedLocator = locator
      checking = true
      validationTimeout = window.setTimeout(() => {
        if (live && checking && locator === admittedLocator) fail('无法及时核实原文件，请刷新后重新选择。')
      }, TIMEOUT_MS)
      void Promise.resolve().then(() => validateOwned(admittedLocator, current)).catch(error => {
        if (live && locator === admittedLocator) fail(error instanceof Error ? error.message : '原文件或会话已不可用。')
      }).finally(() => { checking = false; window.clearTimeout(validationTimeout) })
    }, 30_000)
    return stop
  }, [file.id, file.revision, file.sourceIdentity, attempt])
  const close = (): void => { onClose(); if (opener.current?.isConnected) opener.current.focus() }
  return <section className="conversation-table-preview" aria-labelledby="conversation-pdf-preview-heading">
    <div className="flex flex-wrap items-center gap-2"><h2 ref={heading} id="conversation-pdf-preview-heading" tabIndex={-1} className="my-item-title min-w-0 flex-1 break-all">{file.name}</h2>
      <Button size="sm" variant="ghost" onClick={close} aria-label="关闭 PDF 预览"><X size={14} />关闭</Button></div>
    {state.kind === 'loading' && <p role="status" className="my-item-description">正在读取 PDF…</p>}
    {state.kind === 'error' && <div role="alert" className="flex flex-wrap items-center gap-2 text-my-sm text-my-danger-text"><span>{state.message}</span><Button size="sm" onClick={() => setAttempt(n => n + 1)}>重试</Button><Button size="sm" variant="ghost" onClick={onOpen}>系统打开</Button></div>}
    {state.kind === 'ready' && <PdfReader bytes={state.data} onFailure={state.fail} />}
  </section>
}

function PdfReader({ bytes, onFailure }: { bytes: Uint8Array; onFailure: (message: string) => void }): JSX.Element {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1.5)
  const [geometry, setGeometry] = useState<{ page: number; maxScale: number } | null>(null)
  const [rendered, setRendered] = useState<{ page: number; zoom: number; scale: number } | null>(null)
  const [status, setStatus] = useState('正在打开 PDF…')
  const [text, setText] = useState('')
  const [textStatus, setTextStatus] = useState('')
  const host = useRef<HTMLDivElement>(null)
  const failRef = useRef(onFailure); failRef.current = onFailure
  const failDocument = useRef<(message: string) => void>(() => {})
  useEffect(() => {
    let live = true, failed = false, disposed = false
    const abort = new AbortController()
    let native: Worker | undefined, pdfWorker: PDFWorker | undefined, task: ReturnType<typeof getDocument> | undefined
    let timer = 0
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      window.clearTimeout(timer); abort.abort()
      if (task) void task.destroy().catch(() => {})
      pdfWorker?.destroy(); native?.terminate()
    }
    const fail = (message: string): void => { if (!live || failed) return; failed = true; dispose(); failRef.current(message) }
    failDocument.current = fail
    try {
      // Supplying a real Worker port prevents PDF.js from falling back to its main-thread worker.
      native = new Worker(workerUrl, { type: 'module' })
      native.addEventListener('error', () => fail('PDF 预览进程启动失败，请重试或使用系统打开。'))
      pdfWorker = PDFWorker.create({ port: native })
      const Base = offlinePdfResources(abort.signal)
      class Resources extends Base {
        async fetch(request: { kind: string; filename: string }): Promise<Uint8Array> {
          try { return await super.fetch(request) } catch (error) { if (!abort.signal.aborted) fail('离线字体或字符映射资源不可用，请重试或使用系统打开。'); throw error }
        }
      }
      task = getDocument({ data: bytes.slice(), worker: pdfWorker, enableXfa: false, stopAtErrors: true, useWorkerFetch: false,
        BinaryDataFactory: Resources, cMapPacked: true, useWasm: false, maxImageSize: MAX_IMAGE_PIXELS,
        isOffscreenCanvasSupported: false, isImageDecoderSupported: false, useSystemFonts: true })
      timer = window.setTimeout(() => fail('打开 PDF 超时，请重试或使用系统打开。'), TIMEOUT_MS)
      void task.promise.then(value => {
        if (!live || failed) return
        window.clearTimeout(timer)
        if (value.numPages < 1 || value.numPages > MAX_PAGES) { fail(`PDF 页数超过 ${MAX_PAGES} 页预览上限，请使用系统打开。`); return }
        setDoc(value); setStatus('')
      }).catch(error => fail(error instanceof Error && error.name === 'PasswordException' ? '此 PDF 已加密，暂不支持输入密码。' : '无法打开 PDF，文件可能损坏或不受支持。'))
    } catch { fail('无法启动 PDF 预览，请重试或使用系统打开。') }
    return () => { live = false; dispose() }
  }, [bytes])
  useEffect(() => {
    if (!doc || !host.current) return
    let live = true, render: RenderTask | undefined
    let reader: ReadableStreamDefaultReader | undefined
    const container = host.current, canvas = document.createElement('canvas')
    canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `PDF 第 ${page} 页，共 ${doc.numPages} 页`)
    container.replaceChildren(canvas); setRendered(null); setStatus('正在渲染…'); setText(''); setTextStatus('正在读取文本…')
    const timer = window.setTimeout(() => { if (live) failDocument.current('页面处理超时，请重试或使用系统打开。') }, TIMEOUT_MS)
    void (async () => {
      let pdfPage: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | undefined
      try {
        pdfPage = await doc.getPage(page)
        if (!live) return
        const viewport = pdfPage.getViewport({ scale: 1 })
        if (![viewport.width, viewport.height].every(n => Number.isFinite(n) && n > 0 && n <= MAX_PAGE_SIDE)) throw new Error('oversize')
        const maxScale = Math.min(MAX_CANVAS_SIDE / viewport.width, MAX_CANVAS_SIDE / viewport.height, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)))
        const scale = Math.min(zoom, maxScale)
        setGeometry({ page, maxScale })
        const scaled = pdfPage.getViewport({ scale })
        canvas.width = Math.max(1, Math.floor(scaled.width)); canvas.height = Math.max(1, Math.floor(scaled.height))
        const context = canvas.getContext('2d', { alpha: false }); if (!context) throw new Error('canvas')
        render = pdfPage.render({ canvas, canvasContext: context, viewport: scaled, annotationMode: AnnotationMode.DISABLE })
        reader = pdfPage.streamTextContent({ disableNormalization: true }).getReader()
        const extract = async (): Promise<void> => {
          let value = '', items = 0, truncated = false
          while (live) {
            const part = await reader?.read(); if (!part || part.done) break
            for (const item of part.value.items) {
              if (++items > MAX_TEXT_ITEMS) { truncated = true; break }
              if ('str' in item) {
                const fragment = item.str + (item.hasEOL ? '\n' : ' '), remaining = MAX_TEXT_CHARS - value.length
                if (fragment.length > remaining) { value += fragment.slice(0, remaining); truncated = true; break }
                value += fragment
              }
            }
            if (truncated) { void reader?.cancel().catch(() => {}); break }
          }
          if (live) { setText(value.trim()); setTextStatus(truncated ? '本页文本超过预览上限，已截断。' : value.trim() ? '' : '此页没有可提取文本，图片文字不会自动识别。') }
        }
        await Promise.all([render.promise, extract()])
        if (live) { window.clearTimeout(timer); setRendered({ page, zoom, scale }); setStatus('') }
      } catch (error) {
        render?.cancel(); void reader?.cancel().catch(() => {})
        if (live) { window.clearTimeout(timer); container.replaceChildren(); setStatus(error instanceof Error && error.message === 'oversize' ? '页面尺寸过大，无法预览。' : '此页无法渲染或读取，请切换页面或重新打开。') }
      } finally { try { pdfPage?.cleanup() } catch { /* A cancelled render may still be releasing its page. */ } }
    })()
    return () => { live = false; window.clearTimeout(timer); render?.cancel(); void reader?.cancel().catch(() => {}); canvas.remove(); canvas.width = 0; canvas.height = 0 }
  }, [doc, page, zoom])
  const pageGeometry = geometry?.page === page ? geometry : null
  const appliedScale = pageGeometry ? Math.min(zoom, pageGeometry.maxScale) : null
  const actualScale = rendered?.page === page && rendered.zoom === zoom ? rendered.scale : null
  const percent = actualScale === null ? '—' : `${(actualScale * 100).toFixed(1).replace(/\.0$/, '')}%`
  return <div className="min-w-0 space-y-2">
    {doc && <div className="conversation-pdf-toolbar" role="group" aria-label="PDF 预览控制">
      <div className="conversation-pdf-toolbar" role="group" aria-label="页码控制"><Button size="sm" disabled={page <= 1} onClick={() => setPage(n => n - 1)}>上一页</Button><span aria-live="polite">第 {page} 页 / 共 {doc.numPages} 页</span><Button size="sm" disabled={page >= doc.numPages} onClick={() => setPage(n => n + 1)}>下一页</Button></div>
      <div className="conversation-pdf-toolbar" role="group" aria-label="缩放控制"><Button size="sm" aria-label="缩小 PDF" disabled={appliedScale === null || appliedScale <= MIN_ZOOM} onClick={() => { if (pageGeometry) setZoom(n => Math.max(MIN_ZOOM, Math.min(n, pageGeometry.maxScale) / ZOOM_STEP)) }}>缩小</Button>
        <span aria-label={`实际缩放 ${percent}`} aria-live="polite">{percent}</span>
        <Button size="sm" aria-label="放大 PDF" disabled={appliedScale === null || !pageGeometry || appliedScale >= pageGeometry.maxScale} onClick={() => { if (pageGeometry) setZoom(n => Math.min(pageGeometry.maxScale, Math.min(n, pageGeometry.maxScale) * ZOOM_STEP)) }}>放大</Button></div>
    </div>}
    <p role="status" className="my-item-description">{status}</p>
    {doc && <><p className="my-item-description">为限制资源，超大或不支持解码的内嵌图片可能被省略，页面可能显示不完整。</p><div className="conversation-pdf-page" ref={host} tabIndex={0} aria-label="PDF 页面" />
      <details><summary>查看本页文本</summary><p className="my-item-description">文本按 PDF 提取顺序显示，可能与视觉阅读顺序不同；图片文字不会自动识别。</p><p role="status">{textStatus}</p><pre className="conversation-pdf-text" tabIndex={0} aria-label={`第 ${page} 页提取文本`}>{text}</pre></details></>}
  </div>
}
