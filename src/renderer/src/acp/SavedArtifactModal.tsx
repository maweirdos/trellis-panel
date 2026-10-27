import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ChevronRight, ExternalLink, FileText, X } from 'lucide-react'
import { Button, Modal } from '../my/ui'
import { MarkdownView } from '../components/MarkdownView'
import { ArtifactCopyButton } from '../components/ArtifactCopyButton'
import { computeHeadingAnchors } from '../reader/heading-anchors'
import { useInteractionGuard } from '../utils/interaction-scope'
import { knowledgeBridge, knowledgeError, knowledgeUnavailableFor } from '../knowledge/bridge'
import type { KnowledgeArtifact } from '../../../shared/knowledge-access'
import type { KnowledgeDocumentContext } from '../../../shared/knowledge-document-assets'

export function SavedArtifactModal({ root, sessionId, artifact, isCurrent, onClose }: {
  root: string; sessionId: string; artifact: KnowledgeArtifact; isCurrent: () => boolean; onClose: () => void
}): JSX.Element {
  const canInteract = useInteractionGuard()
  const [raw, setRaw] = useState(false)
  const [outline, setOutline] = useState(false)
  const [info, setInfo] = useState(false)
  const [localOpen, setLocalOpen] = useState<{ phase: 'idle' | 'opening' | 'conflict' | 'opened' | 'failed'; detail: string }>({ phase: 'idle', detail: '' })
  const live = useRef(true)
  const openSequence = useRef(0)
  const opening = useRef(false)
  const outlineId = useId()
  const infoId = useId()
  const scroll = useRef<HTMLDivElement>(null)
  const article = useRef<HTMLElement>(null)
  const positions = useRef({ rendered: 0, raw: 0 })
  const restoreView = useRef(false)
  const headings = useMemo(() => computeHeadingAnchors(artifact.body), [artifact.body])
  const anchors = useMemo(() => new Map(headings.map(heading => [heading.line, heading.id])), [headings])
  const documentContext = useMemo<KnowledgeDocumentContext>(() => ({ expectedRoot: root, sessionId, artifactId: artifact.id, revision: artifact.revision }), [root, sessionId, artifact.id, artifact.revision])
  const current = (): boolean => live.current && isCurrent() && canInteract()
  useEffect(() => { live.current = true; return () => { live.current = false; openSequence.current++ } }, [])
  const openLocal = async (acknowledgeChangedFile = false): Promise<void> => {
    if (!current() || opening.current || acknowledgeChangedFile && localOpen.phase !== 'conflict') return
    const bridge = knowledgeBridge(['artifactOpenLocal'])
    if (!bridge) { setLocalOpen({ phase: 'failed', detail: knowledgeUnavailableFor('本地文档打开') }); return }
    const token = ++openSequence.current
    opening.current = true
    setLocalOpen({ phase: 'opening', detail: '' })
    try {
      const result = await bridge.artifactOpenLocal({ ...documentContext, ...(acknowledgeChangedFile ? { acknowledgeChangedFile: true } : {}) })
      if (!current() || token !== openSequence.current) return
      if (!result.ok) { setLocalOpen({ phase: result.code === 'E_CONFLICT' ? 'conflict' : 'failed', detail: result.error }); return }
      if (!result.data.opened) { setLocalOpen({ phase: 'failed', detail: '尚未确认本地应用已接受打开请求。' }); return }
      setLocalOpen({ phase: 'opened', detail: result.data.differsFromPreview ? '已打开当前项目文件；此弹窗仍保留本次保存的版本。' : '已交由本地应用打开。' })
    } catch (error) { if (current() && token === openSequence.current) setLocalOpen({ phase: 'failed', detail: knowledgeError(error, '本地文档打开') }) }
    finally { if (token === openSequence.current) opening.current = false }
  }
  const changeView = (): void => {
    if (!current()) return
    if (scroll.current) positions.current[raw ? 'raw' : 'rendered'] = scroll.current.scrollTop
    restoreView.current = true
    setRaw(!raw)
  }
  useLayoutEffect(() => {
    if (restoreView.current && current() && scroll.current) scroll.current.scrollTop = positions.current[raw ? 'raw' : 'rendered']
    restoreView.current = false
  }, [raw])
  const goToHeading = (id: string): void => {
    if (!current()) return
    setRaw(false)
    requestAnimationFrame(() => {
      if (!current() || !article.current || !scroll.current) return
      const heading = Array.from(article.current.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]')).find(node => node.id === id)
      if (!heading) return
      scroll.current.scrollTop += heading.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top - 16
      heading.tabIndex = -1
      heading.focus({ preventScroll: true })
    })
  }
  return <Modal open onClose={onClose} width={940} ariaLabel={`需求说明：${artifact.title}`}>
    <section className="acp-saved-document" data-artifact-id={artifact.id} data-artifact-revision={artifact.revision}>
      <header className="acp-saved-document-header"><FileText size={16} aria-hidden="true" /><span className="acp-saved-document-caption" title={artifact.title}>{artifact.title}</span><Button size="sm" variant="ghost" aria-label="关闭阅读" onClick={onClose}><X size={16} /></Button></header>
      <div className="acp-saved-document-toolbar">
        {headings.length > 1 && <Button size="sm" variant="ghost" aria-expanded={outline} aria-controls={outlineId} onClick={() => { if (current()) setOutline(!outline) }}>章节<ChevronRight size={12} className={outline ? 'is-open' : ''} aria-hidden="true" /></Button>}
        <Button size="sm" variant="ghost" aria-expanded={info} aria-controls={infoId} onClick={() => { if (current()) setInfo(!info) }}>文档信息</Button>
        <Button size="sm" variant="ghost" aria-pressed={raw} onClick={changeView}>{raw ? '阅读正文' : 'Markdown 原文'}</Button>
        <ArtifactCopyButton text={artifact.body} ownerKey={JSON.stringify([root, sessionId, artifact.id, artifact.revision])} label="复制文档" isCurrent={current} />
        <Button size="sm" variant="ghost" disabled={localOpen.phase === 'opening'} onClick={() => void openLocal()}><ExternalLink size={13} aria-hidden="true" />在本地打开</Button>
      </div>
      {localOpen.phase !== 'idle' && localOpen.phase !== 'opening' && <div className="acp-saved-document-open-notice" role={localOpen.phase === 'opened' ? 'status' : 'alert'}><p>{localOpen.detail}</p>{localOpen.phase === 'conflict' && <><p>弹窗保留已保存版本。是否仍要打开当前项目文件？</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => void openLocal(true)}>仍打开当前文件</Button><Button size="sm" variant="ghost" onClick={() => setLocalOpen({ phase: 'idle', detail: '' })}>取消</Button></div></>}</div>}
      <nav id={outlineId} className="acp-saved-document-outline my-scrollbar" aria-label="文档章节" hidden={!outline}>{headings.map(heading => <button type="button" key={heading.id} data-heading-level={heading.level} onClick={() => goToHeading(heading.id)}>{heading.text}</button>)}</nav>
      <div id={infoId} className="acp-saved-document-info" hidden={!info}>
        <p>这是本次保存的文档版本，不随当前项目文件变化。</p>
        <dl><dt>项目文件</dt><dd>{artifact.relativePath}</dd><dt>已保存版本</dt><dd>{artifact.revision}</dd><dt>保存时间</dt><dd>{new Date(artifact.createdAt).toLocaleString()}</dd></dl>
        <p>若文档包含项目图片，显示的是当前资源文件，不是历史图片快照。</p>
      </div>
      <div ref={scroll} className="acp-saved-document-scroll my-scrollbar" data-saved-document-scroll>
        <article ref={article} className="acp-saved-document-body" hidden={raw}>
          {!headings.some(heading => heading.level === 1) && <h1>{artifact.title}</h1>}
          <MarkdownView content={artifact.body} headingAnchorsByLine={anchors} documentAssetContext={documentContext} />
        </article>
        <pre hidden={!raw} className="acp-saved-document-raw" data-saved-document-raw><code>{artifact.body}</code></pre>
      </div>
    </section>
  </Modal>
}
