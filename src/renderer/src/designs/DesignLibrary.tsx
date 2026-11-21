import { useEffect, useRef, useState, type JSX } from 'react'
import {
  ArrowUpRight,
  FileText,
  LayoutGrid,
  LineChart,
  Loader2,
  Palette,
  PanelsTopLeft,
  Presentation
} from 'lucide-react'
import type { DesignConversationSummary, DesignDocument, DesignSummary } from '@shared/design-workspace'
import { conversationValue } from '../conversations/client'
import { Button } from '../my/ui'
import { designClient } from './client'
import { DesignPreview } from './DesignPreview'
import './design-workspace.css'
import './design-library.css'

export function formatRelativeTime(timestamp: number | string | Date): string {
  const time = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime()
  if (isNaN(time) || time <= 0) return '刚刚'
  const diff = Math.max(0, Date.now() - time)
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days >= 30) return new Date(time).toLocaleDateString('zh-CN')
  if (days > 0) return `${days}天前`
  if (hours > 0) return `${hours}小时前`
  if (minutes > 0) return `${minutes}分钟前`
  return '刚刚'
}

export interface DesignNewTypesProps {
  busy?: boolean
  onStartDesign?: () => void
  onDocument?: () => void
  onSlides?: () => void
  onChart?: () => void
  onWhiteboard?: () => void
  documentDisabled?: boolean
}

export function DesignNewTypes({
  busy = false,
  onStartDesign,
  onDocument,
  onSlides,
  onChart,
  onWhiteboard,
  documentDisabled = false
}: DesignNewTypesProps): JSX.Element {
  const types = [
    {
      id: 'design',
      title: '设计稿',
      description: '界面、页面、流程',
      icon: <Palette size={18} />,
      badgeClass: 'design-new-badge--design',
      onClick: onStartDesign,
      disabled: busy
    },
    {
      id: 'document',
      title: '文档',
      description: '方案、报告、说明',
      icon: <FileText size={18} />,
      badgeClass: 'design-new-badge--document',
      onClick: onDocument,
      disabled: documentDisabled
    },
    {
      id: 'slides',
      title: '幻灯片',
      description: '汇报、分享、发布',
      icon: <Presentation size={18} />,
      badgeClass: 'design-new-badge--slides',
      onClick: onSlides ?? onDocument,
      disabled: documentDisabled
    },
    {
      id: 'chart',
      title: '图表',
      description: '指标、趋势、看板',
      icon: <LineChart size={18} />,
      badgeClass: 'design-new-badge--chart',
      onClick: onChart ?? onDocument,
      disabled: documentDisabled
    },
    {
      id: 'whiteboard',
      title: '白板',
      description: '架构图、流程图',
      icon: <LayoutGrid size={18} />,
      badgeClass: 'design-new-badge--whiteboard',
      onClick: onWhiteboard,
      disabled: false
    }
  ]

  return (
    <div className="design-new-section" aria-label="新建产物类型">
      <div className="design-new-heading">新建</div>
      <div className="design-new-grid">
        {types.map((type) => (
          <button
            type="button"
            className="design-new-card"
            key={type.id}
            disabled={type.disabled}
            onClick={type.onClick}
          >
            <div className={`design-new-badge ${type.badgeClass}`} aria-hidden="true">
              {busy && type.id === 'design' ? <Loader2 size={16} className="design-spinner" /> : type.icon}
            </div>
            <div className="design-new-info">
              <span className="design-new-title">{type.title}</span>
              <span className="design-new-desc">{type.description}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Cover bytes are read only when a real authorized document enters the viewport. */
export function DesignLibraryCard({
  item,
  layout,
  onOpen,
  workspaceName = 'local'
}: {
  item: DesignSummary
  layout: 'grid' | 'list'
  onOpen(): void
  workspaceName?: string
}): JSX.Element {
  const [cover, setCover] = useState<{
    document: Pick<DesignDocument, 'id' | 'revision'>
    page: DesignDocument['pages'][number]
    routes: { id: string; title: string }[]
  } | null>(null)
  const node = useRef<HTMLElement>(null)

  useEffect(() => {
    setCover(null)
    if (layout !== 'grid') return
    let disposed = false
    let generation = 0
    const observer = new IntersectionObserver(
      (entries) => {
        const next = entries.some((entry) => entry.isIntersecting)
        if (!next) return
        const ticket = ++generation
        setCover(null)
        const client = designClient()
        if (client) {
          void client
            .get({ documentId: item.id })
            .then(conversationValue)
            .then((document) => {
              if (!disposed && ticket === generation && document.revision === item.revision) {
                setCover({
                  document: { id: document.id, revision: document.revision },
                  page: document.pages[0],
                  routes: document.pages.map((page) => ({ id: page.id, title: page.title }))
                })
              }
            })
            .catch(() => {
              if (!disposed && ticket === generation) setCover(null)
            })
        }
      },
      { rootMargin: '160px' }
    )
    if (node.current) observer.observe(node.current)
    return () => {
      disposed = true
      generation++
      observer.disconnect()
    }
  }, [item.id, item.revision, layout])

  const relativeTime = formatRelativeTime(item.updatedAt)

  if (layout === 'list') {
    return (
      <button type="button" className="creation-list-row design-library-row" onClick={onOpen}>
        <div className="creation-icon-badge creation-icon-badge--design" aria-hidden="true">
          <Palette size={14} />
        </div>
        <span className="creation-list-title">
          <span className="my-item-title creation-truncate">{item.title}</span>
          <span className="my-item-description">{`${workspaceName} · ${relativeTime}`}</span>
        </span>
        <span className="creation-list-kind creation-meta">设计稿 · {item.pageCount} 页</span>
        <span className="creation-list-revision creation-meta">当前稿</span>
        <span className="creation-list-date creation-meta">更新于 {new Date(item.updatedAt).toLocaleDateString()}</span>
        <ArrowUpRight size={14} className="creation-list-arrow" aria-hidden="true" />
      </button>
    )
  }

  return (
    <article
      ref={node}
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
          {cover ? (
            <DesignCover document={cover.document} page={cover.page} routes={cover.routes} />
          ) : (
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
          )}
        </div>
      </div>
      <div className="design-library-caption">
        <div className="creation-icon-badge creation-icon-badge--design" aria-hidden="true">
          <Palette size={14} />
        </div>
        <div className="design-library-caption-text">
          <div className="my-item-title creation-truncate">{item.title}</div>
          <div className="my-item-description creation-truncate">{`${workspaceName} · ${relativeTime}`}</div>
        </div>
      </div>
    </article>
  )
}

function DesignCover({
  document,
  page,
  routes
}: {
  document: Pick<DesignDocument, 'id' | 'revision'>
  page: DesignDocument['pages'][number]
  routes: { id: string; title: string }[]
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(256)

  useEffect(() => {
    const element = root.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const scale = width / Math.max(page.width, 1)

  return (
    <div ref={root} className="design-library-cover" aria-hidden="true">
      <div
        className="design-preview"
        style={{
          width: page.width,
          height: page.height,
          transform: `scale(${scale})`
        }}
      >
        <DesignPreview
          documentId={document.id}
          revision={document.revision}
          frameId={`cover-${page.id}`}
          page={page}
          pages={routes}
          mode="read"
        />
      </div>
    </div>
  )
}

export function ConversationDesignCards({
  documents,
  error,
  onOpen,
  onRefresh,
  busy = false,
  notice = ''
}: {
  documents: DesignConversationSummary[]
  error: string
  busy?: boolean
  notice?: string
  onOpen(id: string, candidateId?: string): void
  onRefresh(): void
}): JSX.Element | null {
  if (!error && !documents.length && !busy && !notice) return null
  return (
    <div className="design-result-cards" aria-label="会话设计产物">
      {(busy || notice) && <div className="my-activity-note" role="status">{busy ? '正在核对设计…' : notice}</div>}
      {error && (
        <div className="my-activity-note" role="alert">
          {error}
          <Button size="sm" variant="ghost" disabled={busy} title="只读取原设计，不重发消息、重新生成或删除内容" onClick={onRefresh}>
            {busy ? '正在核对…' : '核对设计'}
          </Button>
        </div>
      )}
      {documents.map((document) => {
        const candidate = document.candidates.at(-1)
        return (
          <div key={document.id} className="design-result-card">
            <PanelsTopLeft size={18} aria-hidden="true" />
            <div>
              <span className="my-item-title">{document.title}</span>
              <span className="my-item-description">
                {document.pageCount} 页
                {document.candidates.length ? ` · ${document.candidates.length} 个修改候选` : ''}
              </span>
            </div>
            {candidate && (
              <Button size="sm" onClick={() => onOpen(document.id, candidate.id)}>
                查看候选
              </Button>
            )}
            <Button size="sm" onClick={() => onOpen(document.id)}>
              打开画布
            </Button>
          </div>
        )
      })}
    </div>
  )
}
