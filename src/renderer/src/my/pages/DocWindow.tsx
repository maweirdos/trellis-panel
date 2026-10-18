// 置顶文档小窗：主进程拉起的 OS 级独立阅读窗（可拖出主窗口、always-on-top、多开）。
// 样式与任务弹窗同源（my 令牌）；文档为打开时刻的只读快照，重开即最新。
import { useEffect, useState, type JSX } from 'react'
import { Copy, FileText, Minus, Pin, PinOff, Square, X } from 'lucide-react'
import { api } from '../../api'
import { MarkdownView } from '../../components/MarkdownView'

export function DocWindowApp(): JSX.Element {
  const [params] = useState(() => new URLSearchParams(window.location.search))
  const path = params.get('path') ?? ''
  const taskTitle = params.get('title') ?? '文档'
  const theme = params.get('theme') === 'light' ? 'light' : 'dark'
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

  const togglePin = (): void => {
    const next = !pinned
    setPinned(next)
    void api.docSetPin(next)
  }

  return (
    <div data-my-theme={theme} className="my-root flex h-full w-full flex-col bg-my-canvas text-my-md text-my-primary">
      {/* 标题栏：拖动区 + 文档名 + 置顶/关闭 */}
      <header className="drag-region flex h-10 shrink-0 items-center gap-2 border-b border-my-line bg-my-layer-1 px-3">
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
        {error ? (
          <div className="px-7 py-6 text-my-sm text-my-danger-text">{error}</div>
        ) : content === null ? (
          <div className="px-7 py-6 text-my-sm text-my-tertiary">加载中…</div>
        ) : (
          <div className="px-8 py-6 [&_.md]:text-[14px] [&_blockquote]:border-l-2 [&_blockquote]:border-my-line-strong [&_blockquote]:pl-3 [&_blockquote]:text-my-secondary [&_code]:rounded-my-sm [&_code]:bg-my-layer-3 [&_code]:px-1 [&_h1]:mb-2 [&_h1]:mt-5 [&_h1]:text-[17px] [&_h1]:font-semibold [&_h1]:text-my-primary [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-my-md [&_h2]:font-semibold [&_h2]:text-my-primary [&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-my-md [&_h3]:font-medium [&_h3]:text-my-primary [&_li]:leading-6 [&_p]:my-2.5 [&_p]:leading-6 [&_pre]:my-2.5 [&_pre]:overflow-x-auto [&_pre]:rounded-my-md [&_pre]:bg-my-layer-2 [&_pre]:p-3 [&_strong]:text-my-primary">
            <MarkdownView content={content} />
          </div>
        )}
      </div>
    </div>
  )
}
