import { useEffect, useRef, useState, type JSX } from 'react'
import { AppWindow, ArrowUpRight, FileText, Loader2, Monitor, PanelsTopLeft, Plus } from 'lucide-react'
import type { DesignConversationSummary, DesignDocument, DesignSummary } from '@shared/design-workspace'
import { conversationValue } from '../conversations/client'
import { Button } from '../my/ui'
import { designClient } from './client'
import { DesignPreview } from './DesignPreview'
import './design-workspace.css'
import './design-library.css'

export function DesignNewTypes({ busy, onStart, onDocument, documentDisabled = false }: { busy: boolean; onStart(kind: 'web' | 'app' | 'prototype'): void; onDocument(): void; documentDisabled?: boolean }): JSX.Element {
  return <section className="design-new-types" aria-label="新建产物类型">{[
    { kind: 'web' as const, title: '网页设计', description: '从一句要求开始', icon: <Monitor size={22} /> },
    { kind: 'app' as const, title: 'App 设计', description: '设计应用界面', icon: <AppWindow size={22} /> },
    { kind: 'prototype' as const, title: '交互原型', description: '串联页面与交互', icon: <PanelsTopLeft size={22} /> }
  ].map(type => <button type="button" className="design-new-type" key={type.kind} disabled={busy} onClick={() => onStart(type.kind)}><span className="design-new-icon" aria-hidden="true">{busy ? <Loader2 size={22} className="design-spinner" /> : type.icon}</span><span className="design-new-copy"><span className="my-item-title">{type.title}</span><span className="my-item-description">{type.description}</span></span><Plus className="design-new-action" size={14} aria-hidden="true" /></button>)}<button type="button" className="design-new-type" disabled={documentDisabled} onClick={onDocument}><span className="design-new-icon" aria-hidden="true"><FileText size={22} /></span><span className="design-new-copy"><span className="my-item-title">文档 / HTML</span><span className="my-item-description">写作或导入已有内容</span></span><Plus className="design-new-action" size={14} aria-hidden="true" /></button></section>
}

/** Cover bytes are read only when a real authorized document enters the viewport. */
export function DesignLibraryCard({ item, layout, onOpen }: { item: DesignSummary; layout: 'grid' | 'list'; onOpen(): void }): JSX.Element {
  const [cover, setCover] = useState<{ document: Pick<DesignDocument, 'id' | 'revision'>; page: DesignDocument['pages'][number]; routes: { id: string; title: string }[] } | null>(null), node = useRef<HTMLElement>(null)
  useEffect(() => {
    setCover(null)
    if (layout !== 'grid') return
    let disposed = false, visible = false, generation = 0
    const observer = new IntersectionObserver(entries => {
      const next = entries.some(entry => entry.isIntersecting)
      if (next === visible) return
      visible = next
      const ticket = ++generation
      setCover(null)
      const client = designClient()
      if (visible && client) void client.get({ documentId: item.id }).then(conversationValue).then(document => {
        if (!disposed && visible && ticket === generation && document.revision === item.revision) setCover({ document: { id: document.id, revision: document.revision }, page: document.pages[0], routes: document.pages.map(page => ({ id: page.id, title: page.title })) })
      }).catch(() => { if (!disposed && ticket === generation) setCover(null) })
    }, { rootMargin: '160px' })
    if (node.current) observer.observe(node.current)
    return () => { disposed = true; generation++; observer.disconnect() }
  }, [item.id, item.revision, layout])
  if (layout === 'list') return <button type="button" className="creation-list-row design-library-row" onClick={onOpen}><span className="creation-list-icon"><PanelsTopLeft size={18} /></span><span className="creation-list-title"><span className="my-item-title creation-truncate">{item.title}</span><span className="my-item-description">设计 · {item.pageCount} 页</span></span><span className="creation-list-kind creation-meta">本机设计</span><span className="creation-list-revision creation-meta">当前稿</span><span className="creation-list-date creation-meta">更新于 {new Date(item.updatedAt).toLocaleDateString()}</span><ArrowUpRight size={14} aria-hidden="true" /></button>
  return <article ref={node} className="design-library-card">
    {cover ? <DesignCover document={cover.document} page={cover.page} routes={cover.routes} /> : <div className="design-card-placeholder" aria-hidden="true"><PanelsTopLeft size={28} /></div>}
    <button type="button" className="design-library-open" onClick={onOpen} aria-label={`打开设计 ${item.title}，${item.pageCount} 页`}><span className="design-library-caption"><PanelsTopLeft size={16} aria-hidden="true" /><span><span className="my-item-title">{item.title}</span><span className="my-item-description">{item.pageCount} 页 · {new Date(item.updatedAt).toLocaleDateString()}</span></span><ArrowUpRight size={14} aria-hidden="true" /></span></button>
  </article>
}

function DesignCover({ document, page, routes }: { document: Pick<DesignDocument, 'id' | 'revision'>; page: DesignDocument['pages'][number]; routes: { id: string; title: string }[] }): JSX.Element {
  const root = useRef<HTMLDivElement>(null), [width, setWidth] = useState(256)
  useEffect(() => { const element = root.current; if (!element) return; const observer = new ResizeObserver(() => setWidth(element.clientWidth)); observer.observe(element); return () => observer.disconnect() }, [])
  return <div ref={root} className="design-library-cover" aria-hidden="true" {...{ inert: '' }}><div className="design-preview" style={{ width: page.width, height: page.height, transform: `scale(${width / page.width})` }}><DesignPreview documentId={document.id} revision={document.revision} frameId={`cover-${page.id}`} page={page} pages={routes} mode="read" /></div></div>
}

export function ConversationDesignCards({ documents, error, onOpen, onRefresh }: { documents: DesignConversationSummary[]; error: string; onOpen(id: string, candidateId?: string): void; onRefresh(): void }): JSX.Element | null {
  if (!error && !documents.length) return null
  return <div className="design-result-cards" aria-label="会话设计产物">
    {error && <div className="my-activity-note" role="alert">{error}<Button size="sm" variant="ghost" onClick={onRefresh}>重新核对设计</Button></div>}
    {documents.map(document => {
      const candidate = document.candidates.at(-1)
      return <div key={document.id} className="design-result-card"><PanelsTopLeft size={18} aria-hidden="true" /><div><span className="my-item-title">{document.title}</span><span className="my-item-description">{document.pageCount} 页{document.candidates.length ? ` · ${document.candidates.length} 个修改候选` : ''}</span></div>{candidate && <Button size="sm" onClick={() => onOpen(document.id, candidate.id)}>查看候选</Button>}<Button size="sm" onClick={() => onOpen(document.id)}>打开画布</Button></div>
    })}
  </div>
}
