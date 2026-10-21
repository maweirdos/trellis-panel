// 置顶文档小窗：主进程拉起的 OS 级独立阅读窗（可拖出主窗口、always-on-top、多开）。
// 样式与任务弹窗同源（my 令牌）；文档为打开时刻的只读快照，重开即最新。
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Copy, FileText, Minus, Pin, PinOff, Square, X } from 'lucide-react'
import { api } from '../../api'
import { MarkdownView } from '../../components/MarkdownView'
import { PageContent } from '../layout/PageLayout'
import type { DocumentWindowBootstrap } from '../../../../shared/document-windows'
import { DocumentReaderSurface } from '../../reader/DocumentReader'
import { useDocumentReader } from '../../reader/use-document-reader'
import { attachDocumentChangedSource } from '../../reader/document-session-hub'
import { computeHeadingAnchors } from '../../reader/heading-anchors'
import { dispatchEscKey } from '../../utils/esc-layer'
import { Button } from '../ui'
import { projectRootKey } from '../navigation'
import { PublishWorkflowVersionButton } from '../../team/PublishWorkflowVersionButton'

export function DocWindowApp(): JSX.Element {
  return new URLSearchParams(window.location.search).has('viewId') ? <RegisteredDocWindow /> : <LegacyDocWindowApp />
}

function RegisteredDocWindow(): JSX.Element {
  const [bootstrap, setBootstrap] = useState<DocumentWindowBootstrap | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    attachDocumentChangedSource((cb) => api.onDocumentChanged(cb))
    void api.documentWindowBootstrap().then((result) => { if (alive) { if (result.ok) setBootstrap(result); else setError(result.error) } }).catch((cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : '固定版本不可用') })
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !event.defaultPrevented && dispatchEscKey()) { event.preventDefault(); event.stopImmediatePropagation() } }
    window.addEventListener('keydown', onKey)
    return () => { alive = false; window.removeEventListener('keydown', onKey) }
  }, [])
  if (!bootstrap) return <div className="flex h-full flex-col"><header className="drag-region flex h-my-header items-center justify-between border-b border-my-line px-4"><span>文档阅读</span><Button className="no-drag" onClick={() => api.windowClose()}>关闭</Button></header><p role="status" className="p-4 text-my-sm text-my-secondary">{error ?? '正在装载固定版本…'}</p></div>
  return <RegisteredDocBody bootstrap={bootstrap} />
}

function RegisteredDocBody({ bootstrap }: { bootstrap: DocumentWindowBootstrap }): JSX.Element {
  const projectLabel = bootstrap.projectRoot.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '来源项目'
  const taskLabel = /(?:^|\/)\.trellis\/tasks\/(?:archive\/\d{4}-\d{2}\/)?([^/]+)\//.exec(bootstrap.version.relativePath)?.[1]
  const kindLabels = { 'product-requirement': '产品需求', 'trellis-prd': '开发 PRD', design: '技术设计', spec: '规范', code: '代码', feedback: '反馈', other: '文档' }
  const sourceCaption = [projectLabel, taskLabel, kindLabels[bootstrap.version.kind]].filter(Boolean).join(' · ')
  const sourceDetail = `${bootstrap.projectRoot}\n${bootstrap.version.relativePath}\n版本 ${bootstrap.version.revision}\nSHA-256 ${bootstrap.version.digest}`
  const transport = useMemo(() => ({ documentRead: api.documentWindowRead, documentWatch: api.documentWindowWatch, documentUnwatch: api.documentWindowUnwatch, documentDiff: api.documentWindowDiff }), [])
  const reader = useDocumentReader({ workspaceId: bootstrap.document.source.workspaceId, taskRef: bootstrap.document.source.taskRef ?? undefined, relativePath: bootstrap.document.source.relativePath, initialDocument: bootstrap.document, transport })
  const [pinned, setPinned] = useState(bootstrap.pinned)
  const [pinBusy, setPinBusy] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [sourceActive, setSourceActive] = useState(bootstrap.sourceActive)
  const [sourceStateUnavailable, setSourceStateUnavailable] = useState(false)
  const sourceInactive = useRef(!bootstrap.sourceActive)
  const sourceStateTicket = useRef(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [outline, setOutline] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const headings = useMemo(() => computeHeadingAnchors(reader.displayedText ?? ''), [reader.displayedText])
  useEffect(() => api.onWindowMaximized(setMaximized), [])
  useEffect(() => {
    let alive = true
    const check = (snapshot?: { meta: { root: string } }): void => {
      if (sourceInactive.current) return
      if (typeof api.documentWindowSourceState !== 'function') {
        // Older preload compatibility only; current main verifies actual roots.
        if (snapshot && projectRootKey(snapshot.meta.root) !== projectRootKey(bootstrap.projectRoot)) { sourceInactive.current = true; setSourceActive(false) }
        return
      }
      const ticket = ++sourceStateTicket.current
      void api.documentWindowSourceState().then((result) => {
        if (!alive || ticket !== sourceStateTicket.current || sourceInactive.current) return
        if (!result.ok) throw Error(result.error)
        if (!result.sourceActive) sourceInactive.current = true
        setSourceActive(result.sourceActive); setSourceStateUnavailable(false)
      }).catch(() => { if (alive && ticket === sourceStateTicket.current && !sourceInactive.current) { setSourceActive(false); setSourceStateUnavailable(true) } })
    }
    const off = api.onSnapshotUpdated((snapshot) => check(snapshot))
    check() // Covers a project event between bootstrap delivery and subscription.
    return () => { alive = false; sourceStateTicket.current++; off() }
  }, [bootstrap.projectRoot, bootstrap.viewId])
  const pin = async (): Promise<void> => {
    setPinBusy(true)
    try { const result = await api.docSetPin(!pinned); if (result.ok && typeof result.pinned === 'boolean') setPinned(result.pinned); else setNotice(result.error ?? '置顶状态未确认') }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : '置顶失败') }
    finally { setPinBusy(false) }
  }
  return <div className="flex h-full min-h-0 flex-col bg-my-canvas text-my-primary">
    <header className="drag-region flex h-my-header shrink-0 items-center gap-2 border-b border-my-line bg-my-layer-1 px-3">
      <FileText size={14} className="text-my-accent-text" /><span className="min-w-0 flex-1 truncate text-my-sm" title={bootstrap.projectRoot}>{bootstrap.version.title}</span>
      <Button className="no-drag" size="sm" variant="ghost" title="返回原会话或任务" onClick={() => { void api.documentWindowReturn().then((r) => { if (!r.ok) setNotice(r.error) }).catch(() => setNotice('返回来源失败')) }}>返回来源</Button>
      <Button className="no-drag" size="sm" variant="ghost" title="最小化" onClick={() => api.windowMinimize()}><Minus size={13} /></Button>
      <Button className="no-drag" size="sm" variant="ghost" title={maximized ? '还原' : '最大化'} onClick={() => api.windowMaximize()}>{maximized ? <Copy size={12} /> : <Square size={12} />}</Button>
      <Button className="no-drag" size="sm" variant="ghost" disabled={pinBusy} title={pinned ? '取消置顶' : '置顶'} onClick={() => void pin()}>{pinned ? <Pin size={13} className="text-my-accent-text" /> : <PinOff size={13} />}</Button>
      <Button className="no-drag" size="sm" variant="ghost" title="关闭" onClick={() => api.windowClose()}><X size={14} /></Button>
    </header>
    <div className="my-page-toolbar-row shrink-0"><Button size="sm" variant="ghost" disabled={headings.length === 0} onClick={() => setOutline((v) => !v)}>目录</Button><span className="min-w-0 truncate text-my-xs text-my-secondary" title={sourceDetail}>{sourceCaption}</span>{sourceActive && reader.doc?.fixedVersion && <PublishWorkflowVersionButton expectedRoot={bootstrap.projectRoot} source={{ kind: 'fixed-document', token: reader.doc.fixedVersion.token }} title={reader.doc.fixedVersion.title} />}</div>
    {!sourceActive && <p role="status" className="px-4 py-2 text-my-xs text-my-secondary">{sourceStateUnavailable ? '来源状态暂不能确认，固定版本保持可读；核对来源后再发布。' : '来源项目已切换，固定版本保持可读。返回来源后重新打开可恢复文件跟踪。'}</p>}
    {notice && <p role="status" className="px-4 py-2 text-my-xs text-my-secondary">{notice}</p>}
    {outline && <nav aria-label="文档目录" className="max-h-48 shrink-0 overflow-auto border-b border-my-line px-4 py-2">{headings.map((h) => <button key={h.id} type="button" className="block w-full truncate py-1 text-left text-my-xs text-my-secondary hover:text-my-accent-text" style={{ paddingLeft: `${Math.min(h.level - 1, 3) * 12}px` }} onClick={() => { const target = [...(body.current?.querySelectorAll<HTMLElement>('[id]') ?? [])].find((node) => node.id === h.id); if (target) target.scrollIntoView({ block: 'start' }); else setNotice('请切回渲染视图后定位章节') }}>{h.text}</button>)}</nav>}
    <div ref={body} className="my-scrollbar min-h-0 flex-1 overflow-auto" style={{ fontSize: 'var(--my-text-document)', lineHeight: 'var(--my-line-document)' }}><PageContent variant="full"><DocumentReaderSurface reader={reader} relativePath={bootstrap.document.source.relativePath} showOutline={false} origin={bootstrap.origin ?? undefined} /></PageContent></div>
  </div>
}

function LegacyDocWindowApp(): JSX.Element {
  const [params] = useState(() => new URLSearchParams(window.location.search))
  const path = params.get('path') ?? ''
  const taskTitle = params.get('title') ?? '文档'
  const docName = path.split(/[\\/]/).pop() ?? '文档'
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pinned, setPinned] = useState(true)
  const [maximized, setMaximized] = useState(false)

  // 最大化状态由主进程广播（按钮切换与拖动区双击原生切换都走这里）
  useEffect(() => {
    const off = api.onWindowMaximized(setMaximized)
    return () => {
      off()
    }
  }, [])

  useEffect(() => {
    if (!path) {
      setError('缺少文档路径')
      return
    }
    void api.docRead(path).then((r: { ok: boolean; content?: string; error?: string }) => {
      if (r.ok && typeof r.content === 'string') setContent(r.content)
      else setError(r.error ?? '读取失败')
    })
  }, [path])

  return (
    <div className="flex h-full w-full flex-col bg-my-canvas text-my-md text-my-primary">
      {/* 标题栏：拖动区 + 文档名 + 置顶/关闭 */}
      <header className="drag-region flex h-my-header shrink-0 items-center gap-2 border-b border-my-line bg-my-layer-1 px-3">
        <FileText size={13} className="shrink-0 text-my-icon-secondary" />
        <span className="min-w-0 flex-1 truncate text-my-sm text-my-secondary" title={taskTitle}>
          {taskTitle}
        </span>
        <span className="shrink-0 rounded-my-sm bg-my-layer-3 px-1.5 py-0.5 text-my-2xs text-my-tertiary">{docName}</span>
        <button
          type="button"
          title="最小化"
          onClick={() => api.windowMinimize()}
          className="no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-my-md text-my-icon-secondary hover:bg-my-layer-1-hover hover:text-my-primary"
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          title={maximized ? '还原' : '最大化'}
          onClick={() => api.windowMaximize()}
          className="no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-my-md text-my-icon-secondary hover:bg-my-layer-1-hover hover:text-my-primary"
        >
          {maximized ? <Copy size={11} /> : <Square size={11} />}
        </button>
        <button
          type="button"
          title={pinned ? '取消置顶' : '置顶'}
          onClick={() => {
            const next = !pinned
            setPinned(next)
            void api.docSetPin(next)
          }}
          className="no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-my-md text-my-icon-secondary hover:bg-my-layer-1-hover hover:text-my-primary"
        >
          {pinned ? <Pin size={13} className="fill-current text-my-accent-text" /> : <PinOff size={13} />}
        </button>
        <button
          type="button"
          title="关闭"
          onClick={() => window.close()}
          className="no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-my-md text-my-icon-secondary hover:bg-my-layer-1-hover hover:text-my-primary"
        >
          <X size={14} />
        </button>
      </header>
      {/* 正文 */}
      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto">
        <PageContent variant="centered">
        {error ? (
          <div className="text-my-sm text-my-danger-text">{error}</div>
        ) : content === null ? (
          <div className="text-my-sm text-my-tertiary">加载中…</div>
        ) : (
          <MarkdownView content={content} />
        )}
        </PageContent>
      </div>
    </div>
  )
}
