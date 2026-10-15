// 钉住的文档浮层：与任务弹窗同构的面板内浮层（可多开、标题栏拖动、点击置顶）。
// 内容为打开时刻的只读快照——文档由 CLI/IDE 维护，关开即最新。
import { useEffect, useRef, useState, type JSX } from 'react'
import { clsx } from 'clsx'
import { FileText, X } from 'lucide-react'
import { api } from '../../api'
import { useMy } from '../store'
import { MarkdownView } from '../../components/MarkdownView'
import type { PinnedDoc } from '../store'

const PANEL_W = 520
const PANEL_H_RATIO = 0.62

export function PinnedDocPanels(): JSX.Element {
  const docs = useMy((s) => s.pinnedDocs)
  if (docs.length === 0) return <></>
  return (
    <>
      {docs.map((d) => (
        <PinnedDocPanel key={d.key} doc={d} />
      ))}
    </>
  )
}

function PinnedDocPanel({ doc }: { doc: PinnedDoc }): JSX.Element {
  const closeDoc = useMy((s) => s.closePinnedDoc)
  const moveDoc = useMy((s) => s.movePinnedDoc)
  const bringToFront = useMy((s) => s.bringDocToFront)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const maxZ = useMy((s) => s.zTop)

  useEffect(() => {
    void api.docRead(doc.path).then((r: { ok: boolean; content?: string; error?: string }) => {
      if (r.ok && typeof r.content === 'string') setContent(r.content)
      else setError(r.error ?? '读取失败')
    })
  }, [doc.path])

  // 拖动：标题栏按下 → 窗口跟随 → 松开落位
  useEffect(() => {
    if (!dragRef.current) return
    const onMove = (e: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      moveDoc(doc.key, Math.max(8, e.clientX - d.dx), Math.max(8, e.clientY - d.dy))
    }
    const onUp = (): void => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [doc.key, doc.x, doc.y, moveDoc])

  const startDrag = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    bringToFront(doc.key)
    dragRef.current = { dx: e.clientX - doc.x, dy: e.clientY - doc.y }
    const onMove = (ev: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      moveDoc(doc.key, Math.max(8, ev.clientX - d.dx), Math.max(8, ev.clientY - d.dy))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const style = {
    left: pos?.x ?? doc.x,
    top: pos?.y ?? doc.y,
    width: PANEL_W,
    height: Math.round(window.innerHeight * PANEL_H_RATIO),
    zIndex: 60 + doc.z
  }

  return (
    <div
      role="dialog"
      aria-label={`文档 ${doc.title}`}
      style={style}
      onMouseDown={() => bringToFront(doc.key)}
      className="p-fade fixed flex flex-col overflow-hidden rounded-my-xl border border-my-line bg-my-layer-2 shadow-[var(--my-shadow-overlay-200)]"
    >
      {/* 标题栏：拖动区 */}
      <div
        onMouseDown={startDrag}
        className="flex h-9 shrink-0 cursor-grab items-center gap-2 border-b border-my-line bg-my-layer-1 px-3 active:cursor-grabbing"
      >
        <FileText size={12} className="shrink-0 text-my-icon-secondary" />
        <span className="min-w-0 flex-1 truncate text-my-sm text-my-secondary" title={doc.title}>
          {doc.title}
        </span>
        <button
          type="button"
          title="取消钉住并关闭"
          onClick={() => closeDoc(doc.key)}
          className="flex h-6 w-6 items-center justify-center rounded text-my-icon-secondary hover:bg-my-layer-1-hover hover:text-my-primary"
        >
          <X size={13} />
        </button>
      </div>
      {/* 正文 */}
      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error ? (
          <div className="text-my-sm text-my-danger-text">{error}</div>
        ) : content === null ? (
          <div className="text-my-sm text-my-tertiary">加载中…</div>
        ) : (
          <MarkdownView content={content} />
        )}
      </div>
      {/* 钉住角标 */}
      <span
        title="已钉住"
        className={clsx(
          'absolute right-3 top-9 flex h-5 w-5 items-center justify-center rounded-my-sm',
          'bg-my-success-subtle text-my-success-text'
        )}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1.5 L14.5 7 L11 7 L11 11 L5 11 L5 7 L1.5 7 Z" />
        </svg>
      </span>
    </div>
  )
}
