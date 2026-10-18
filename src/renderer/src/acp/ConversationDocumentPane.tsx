import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Copy, ExternalLink, FileText, List, Maximize2, Minimize2, Quote, X } from 'lucide-react'
import type { AcpSourceReference } from '../../../shared/types'
import { api } from '../api'
import { useApp } from '../store'
import { Button } from '../my/ui'
import { PageContent } from '../my/layout/PageLayout'
import { projectRootKey } from '../my/navigation'
import { DocumentReaderSurface } from '../reader/DocumentReader'
import { useDocumentReader } from '../reader/use-document-reader'
import { computeHeadingAnchors } from '../reader/heading-anchors'
import { relativePathUnderRoot } from '../reader/reader-paths'
import { captureDocumentReference, isTaskMaterialPath } from './artifacts'
import { useInteractionGuard } from '../utils/interaction-scope'

export interface ConversationDocumentPaneProps {
  projectRoot: string
  sessionId: string
  connectionGeneration?: string
  taskDir: string
  relativePath: string
  expanded: boolean
  onToggleExpanded: () => void
  onClose: () => void
  onReference: (reference: AcpSourceReference) => void
  /** Current displayed bytes, not an approval. Null while a newer/unreadable source awaits review. */
  onDisplayedReference?: (reference: AcpSourceReference | null) => void
}

/** Keep this host mounted while its enclosing inspector changes side/expanded presentation. */
export function ConversationDocumentPane(props: ConversationDocumentPaneProps): JSX.Element {
  const canInteract = useInteractionGuard()
  const { projectRoot, taskDir, relativePath, sessionId, connectionGeneration, expanded, onToggleExpanded, onClose, onReference } = props
  const validPath = isTaskMaterialPath(taskDir, relativePath)
  const reader = useDocumentReader({ workspaceId: projectRoot, taskRef: taskDir, relativePath: validPath ? relativePath : null, projectRoot })
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const selectedText = useRef('')
  const [notice, setNotice] = useState<string | null>(null)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const currentRoot = useApp((state) => state.snapshot?.meta.root ?? '')
  const displayed = reader.session?.displayed ?? null
  const reference = useMemo(() => captureDocumentReference({ projectRoot, taskDir, relativePath, sessionId, connectionGeneration, displayed }),
    [projectRoot, taskDir, relativePath, sessionId, connectionGeneration, displayed])
  const headings = useMemo(() => computeHeadingAnchors(reader.displayedText ?? ''), [reader.displayedText])
  const onDisplayed = useRef(props.onDisplayedReference)
  onDisplayed.current = props.onDisplayedReference
  const hasCurrentRoot = (): boolean => projectRootKey(useApp.getState().snapshot?.meta.root ?? '') === projectRootKey(projectRoot)
  const isCurrentAvailable = projectRootKey(currentRoot) === projectRootKey(projectRoot) && reference !== null && !reader.pendingUpdate && reader.requestError === null && reader.unreadableNotice === null

  useEffect(() => {
    selectedText.current = ''
    setNotice(null)
    if (canInteract()) headingRef.current?.focus({ preventScroll: true })
  }, [projectRoot, taskDir, relativePath, sessionId, connectionGeneration])

  useEffect(() => {
    onDisplayed.current?.(isCurrentAvailable ? reference : null)
  }, [reference, isCurrentAvailable])

  useEffect(() => () => onDisplayed.current?.(null), [])

  const captureSelection = (): void => {
    const selection = window.getSelection()
    if (selection && selection.rangeCount > 0 && bodyRef.current?.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      const text = selection.toString().trim()
      // Source provenance is exact plain text. Rich text selections with normalized whitespace
      // remain ordinary feedback rather than a fabricated quotation of source bytes.
      selectedText.current = reader.displayedText?.includes(text) ? text.slice(0, 4000) : ''
    }
  }

  const quote = (sectionAnchor?: string): void => {
    if (!hasCurrentRoot()) { setNotice('项目已切换，无法向此会话添加引用'); return }
    const source = captureDocumentReference({ projectRoot, taskDir, relativePath, sessionId, connectionGeneration, displayed,
      ...(selectedText.current ? { quote: selectedText.current } : {}), ...(sectionAnchor ? { sectionAnchor } : {}) })
    if (source !== null) { onReference(source); setNotice('已加入会话草稿，发送前仍可编辑') }
  }

  const openEditor = (): void => {
    const canonical = reader.doc?.source.canonicalPath
    if (!canonical || !hasCurrentRoot() || relativePathUnderRoot(projectRoot, canonical) === null) { setNotice('当前文档来源不可用，请先重新读取'); return }
    void api.openInEditor(canonical).catch((error: unknown) => setNotice(error instanceof Error ? error.message : '无法打开外部编辑器'))
  }

  return (
    <section className="acp-document flex h-full min-h-0 min-w-0 flex-col bg-my-layer-2" aria-label="任务文档阅读器">
      <header className="my-page-toolbar-row">
        <FileText size={16} className="shrink-0 text-my-accent-text" />
        <div className="min-w-0 flex-1">
          <h2 ref={headingRef} tabIndex={-1} className="truncate text-my-sm font-semibold text-my-primary">{relativePath.split('/').pop()}</h2>
          <p className="mt-0.5 truncate text-my-xs text-my-secondary" title={relativePath}>{taskDir} · 当前文件</p>
        </div>
        <Button size="sm" variant="ghost" title={expanded ? '返回会话布局' : '展开阅读'} onClick={onToggleExpanded}>
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </Button>
        <Button size="sm" variant="ghost" title="关闭文档" onClick={onClose}><X size={15} /></Button>
      </header>
      <div className="my-page-toolbar-row">
        <Button size="sm" variant="ghost" onClick={() => setOutlineOpen((value) => !value)} disabled={headings.length === 0}><List size={13} /> 目录</Button>
        <Button size="sm" variant="ghost" disabled={reader.displayedText === null} onClick={() => {
          if (reader.displayedText === null) return
          void navigator.clipboard.writeText(reader.displayedText).then(() => setNotice('已复制当前展示版本')).catch(() => setNotice('复制失败，请手动选择正文复制'))
        }}><Copy size={13} /> 复制</Button>
        <Button size="sm" variant="ghost" disabled={reader.doc === null} onClick={openEditor}><ExternalLink size={13} /> 编辑器</Button>
        <Button size="sm" variant="ghost" disabled={reference === null} onClick={() => quote()}><Quote size={13} /> 引用到草稿</Button>
      </div>
      {notice !== null && <p role="status" className="shrink-0 border-b border-my-line bg-my-layer-1 px-4 py-2 text-my-xs text-my-secondary">{notice}</p>}
      {outlineOpen && <nav aria-label="文档目录" className="max-h-48 shrink-0 overflow-y-auto border-b border-my-line bg-my-layer-1 px-3 py-2">
        {headings.map((heading) => <div key={heading.id} className="flex items-center gap-1">
          <button type="button" className="min-w-0 flex-1 truncate rounded-my-sm py-1 text-left text-my-xs text-my-secondary hover:bg-my-layer-1-hover" style={{ paddingLeft: `${Math.min(heading.level - 1, 3) * 10 + 4}px` }} onClick={() => {
            const target = [...(bodyRef.current?.querySelectorAll<HTMLElement>('[id]') ?? [])].find((element) => element.id === heading.id)
            if (target) { target.scrollIntoView({ block: 'start' }); target.tabIndex = -1; target.focus({ preventScroll: true }) }
            else setNotice('当前为原文或对比视图，请切回正文后定位章节')
          }}>{heading.text}</button>
          <Button size="sm" variant="ghost" title={`引用章节：${heading.text}`} onClick={() => { selectedText.current = ''; quote(heading.id) }}><Quote size={11} /></Button>
        </div>)}
      </nav>}
      <div ref={bodyRef} onMouseUp={captureSelection} onKeyUp={captureSelection} className="acp-document__body my-scrollbar min-h-0 flex-1 overflow-auto" style={{ fontSize: 'var(--my-text-document)', lineHeight: 'var(--my-line-document)' }}>
        <PageContent variant={expanded ? 'centered' : 'full'}>
        {!validPath ? <p role="alert" className="text-my-sm text-my-danger-text">此路径不属于当前任务，已拒绝读取。</p> :
          <DocumentReaderSurface reader={reader} relativePath={relativePath} variant="compact" />}
        </PageContent>
      </div>
    </section>
  )
}
