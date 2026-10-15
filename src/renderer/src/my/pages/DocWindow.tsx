// 独立置顶文档小窗：由主进程以 ?mode=doc&path=&title= 拉起的只读阅读窗。
// 支持多开（每个文档一个窗口）、置顶切换（默认钉住）、无边框拖动。
import { useEffect, useState, type JSX } from 'react'
import { FileText, Pin, PinOff, X } from 'lucide-react'
import { api } from '../../api'
import { MarkdownView } from '../../components/MarkdownView'

export function DocWindowApp(): JSX.Element {
  const [params] = useState(() => new URLSearchParams(window.location.search))
  const path = params.get('path') ?? ''
  const taskTitle = params.get('title') ?? '文档'
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pinned, setPinned] = useState(true)

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

  const togglePin = (): void => {
    const next = !pinned
    setPinned(next)
    void api.docSetPin(next)
  }

  const docName = path.split(/[\\/]/).pop() ?? '文档'

  return (
    <div data-my-theme="dark" className="my-root flex h-full w-full flex-col bg-my-canvas text-[13px] text-my-primary">
      {/* 标题栏：拖动区 + 置顶/关闭 */}
      <header className="drag-region flex h-9 shrink-0 items-center gap-2 border-b border-my-line bg-my-layer-1 px-3">
        <FileText size={12} className="shrink-0 text-my-icon-secondary" />
        <span className="min-w-0 flex-1 truncate text-my-sm text-my-secondary" title={taskTitle}>
          {taskTitle}
        </span>
        <span className="shrink-0 rounded-my-sm bg-my-layer-3 px-1 text-[10px] text-my-tertiary">{docName}</span>
        <button
          type="button"
          title={pinned ? '取消置顶' : '置顶'}
          onClick={() => {
            const next = !pinned
            setPinned(next)
            void api.docSetPin(next)
          }}
          className="no-drag flex h-6 w-6 items-center justify-center rounded text-my-icon-secondary hover:bg-my-layer-1-hover hover:text-my-primary"
        >
          {pinned ? <Pin size={12} className="fill-current text-my-accent-text" /> : <PinOff size={12} />}
        </button>
        <button
          type="button"
          title="关闭"
          onClick={() => window.close()}
          className="no-drag flex h-6 w-6 items-center justify-center rounded text-my-icon-secondary hover:bg-my-layer-1-hover hover:text-my-primary"
        >
          <X size={13} />
        </button>
      </header>
      {/* 正文 */}
      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="px-5 py-4 text-my-sm text-my-danger-text">{error}</div>
        ) : content === null ? (
          <div className="px-5 py-4 text-my-sm text-my-tertiary">加载中…</div>
        ) : (
          <div className="mx-auto max-w-[760px] px-6 py-5">
            <MarkdownView content={content} />
          </div>
        )}
      </div>
    </div>
  )
}
