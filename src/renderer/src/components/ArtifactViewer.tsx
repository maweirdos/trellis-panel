import { useEffect, useState } from 'react'
import { X, FileText, Copy, FileWarning, Code2, BookOpen } from 'lucide-react'
import { api } from '../api'
import { clsx } from 'clsx'
import { MarkdownView } from './MarkdownView'
import { fmtBytes } from '../utils/format'
import type { JSX } from 'react'
import type { FileEntry } from '../../../shared/types'

/**
 * 全屏产物查看器：占满整个内容区，大空间阅读，支持 Markdown / Mermaid / ASCII /
 * JSON / JSONL / 代码高亮预览、原文与渲染切换、一键复制。
 */
export function ArtifactViewer({
  file,
  projectName,
  onClose
}: {
  file: FileEntry
  projectName: string
  onClose: () => void
}): JSX.Element {
  const [state, setState] = useState<{ loading: boolean; content?: string; error?: string }>({ loading: true })
  const [raw, setRaw] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    setState({ loading: true })
    setRaw(false)
    api.readTextFile(file.path).then((res) => {
      if (!alive) return
      if (res.ok) setState({ loading: false, content: res.content })
      else setState({ loading: false, error: res.error })
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      alive = false
      window.removeEventListener('keydown', onKey)
    }
  }, [file.path, onClose])

  const isMd = /\.(md|markdown)$/i.test(file.name)
  const isCode = /\.(json|jsonl|ya?ml|toml|py|ts|tsx|js|log|txt)$/i.test(file.name)
  const hasMermaid = (state.content ?? '').includes('```mermaid')

  const copy = async (): Promise<void> => {
    await api.copyToClipboard(state.content ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="absolute inset-0 z-40 flex animate-fade-in flex-col bg-ink-900">
      <div className="flex shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-850 px-4 py-2.5">
        <FileText size={14} className="shrink-0 text-leaf" />
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-mist-100">{file.name}</div>
          <div className="truncate font-mono text-[10px] text-mist-500" title={file.path}>
            {projectName} / 产物 · {fmtBytes(file.size)}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {(isMd || hasMermaid) && (
            <button
              onClick={() => setRaw((r) => !r)}
              className={clsx('btn-outline', raw && 'border-leaf-dim/50 text-leaf-soft')}
              title="切换 原文 / 渲染 视图"
            >
              {raw ? <BookOpen size={12} /> : <Code2 size={12} />}
              {raw ? '渲染视图' : '原文视图'}
            </button>
          )}
          <button onClick={() => void copy()} className="btn-outline">
            <Copy size={12} /> {copied ? '已复制' : '复制'}
          </button>
          <button onClick={onClose} className="btn-ghost px-2 py-1.5" title="关闭 (Esc)">
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {state.loading && <div className="p-6 text-xs text-mist-500">加载中…</div>}
        {state.error && (
          <div className="flex items-center gap-2 p-6 text-xs text-rose-300">
            <FileWarning size={14} /> {state.error}
          </div>
        )}
        {!state.loading && !state.error && (
          <div className="mx-auto max-w-5xl px-8 py-6">
            {raw || (!isMd && !isCode) ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-mist-300">
                {state.content}
              </pre>
            ) : isMd ? (
              <MarkdownView content={state.content ?? ''} />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-mist-300">
                {prettyMaybeJson(state.content ?? '', file.name)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function prettyMaybeJson(content: string, name: string): string {
  if (/\.json$/i.test(name) && !/\.jsonl$/i.test(name)) {
    try {
      return JSON.stringify(JSON.parse(content), null, 2)
    } catch {
      return content
    }
  }
  return content
}
