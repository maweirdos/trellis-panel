import { useState, type JSX, type ReactNode } from 'react'
import { Check, Copy, TriangleAlert, WrapText } from 'lucide-react'
import { useCopyFeedback } from '../utils/use-copy-feedback'

/**
 * Ported from t3code@28c58b1 apps/web/src/components/chat/MarkdownCodeBlock.tsx:
 * a bordered secondary frame whose header carries the language and icon-only
 * wrap/copy actions. Copy keeps Crux's guarded clipboard feedback.
 */
export function ChatCodeBlock({ code, language, children }: {
  readonly code: string
  readonly language?: string
  readonly children: ReactNode
}): JSX.Element {
  const copy = useCopyFeedback(code)
  const [wrapped, setWrapped] = useState(false)
  const copyLabel = copy.status === 'error' ? '重试复制代码' : '复制代码'
  return (
    <div className="chat-markdown-codeblock" data-language={language ?? undefined} data-wrap={wrapped ? 'true' : 'false'}>
      <div className="chat-markdown-codeblock-header">
        <span className="chat-markdown-codeblock-language">{language ?? 'text'}</span>
        <span className="chat-markdown-codeblock-actions" role="toolbar" aria-label="代码块操作">
          {wrapped || code.split('\n').some(line => line.length > 80)
            ? <button type="button" className="my-icon-control" aria-pressed={wrapped} aria-label="自动换行" title="自动换行"
              onClick={() => setWrapped(value => !value)}><WrapText size={12} aria-hidden="true" /></button>
            : null}
          <button type="button" className="my-icon-control" aria-label={copyLabel} title={copyLabel}
            aria-disabled={copy.status === 'copying'}
            onClick={() => { if (copy.status !== 'copying') void copy.copy(code) }}>
            {copy.status === 'copied' ? <Check size={12} aria-hidden="true" />
              : copy.status === 'error' ? <TriangleAlert size={12} aria-hidden="true" />
                : <Copy size={12} aria-hidden="true" />}
          </button>
        </span>
      </div>
      <pre>{children}</pre>
      <span role="status" className={copy.status === 'error' ? 'chat-markdown-codeblock-error' : 'conversation-sr-only'}>
        {copy.status === 'error' ? '复制失败，请重试或选择代码复制' : copy.status === 'copied' ? '代码已复制' : ''}
      </span>
    </div>
  )
}
