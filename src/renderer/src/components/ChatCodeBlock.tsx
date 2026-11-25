import { Fragment, useEffect, useState, type JSX, type ReactNode } from 'react'
import { Check, Copy, TriangleAlert, WrapText } from 'lucide-react'
import type { highlightChatCode } from '../conversation-workbench/highlightChatCode'
import { useMy } from '../my/store'
import { useCopyFeedback } from '../utils/use-copy-feedback'

/**
 * Ported from t3code@28c58b1 apps/web/src/components/chat/MarkdownCodeBlock.tsx:
 * a bordered secondary frame whose header carries the language and icon-only
 * wrap/copy actions. Copy keeps Crux's guarded clipboard feedback.
 */
export function ChatCodeBlock({ code, language, streaming, children }: {
  readonly code: string
  readonly language?: string
  readonly streaming?: boolean
  readonly children: ReactNode
}): JSX.Element {
  const copy = useCopyFeedback(code)
  const [wrapped, setWrapped] = useState(true)
  const appearance = useMy(state => state.theme)
  const [highlight, setHighlight] = useState<{
    code: string
    language: string
    appearance: 'light' | 'dark'
    tokens: Awaited<ReturnType<typeof highlightChatCode>>
  }>()
  useEffect(() => {
    if (!language || streaming || !code.trim() || code.length > 40_000) return
    let current = true
    void import('../conversation-workbench/highlightChatCode')
      .then(module => current ? module.highlightChatCode(code, language, appearance) : undefined)
      .then(tokens => {
        if (current && tokens) setHighlight({ code, language, appearance, tokens })
      }).catch(() => undefined)
    return () => { current = false }
  }, [appearance, code, language, streaming])
  const tokens = !streaming && highlight?.code === code && highlight.language === language &&
    highlight.appearance === appearance ? highlight.tokens : undefined
  const copyLabel = copy.status === 'error' ? '重试复制代码' : '复制代码'
  const wrapLabel = wrapped ? '关闭自动换行' : '自动换行'
  return (
    <div dir="ltr" className="chat-markdown-codeblock" data-language={language ?? undefined} data-wrap={wrapped ? 'true' : 'false'}>
      <div className="chat-markdown-codeblock-header">
        <span className="chat-markdown-codeblock-language">{language ?? 'text'}</span>
        <span className="chat-markdown-codeblock-actions" role="toolbar" aria-label="代码块操作">
          <button type="button" className="my-icon-control" aria-pressed={wrapped} aria-label={wrapLabel} title={wrapLabel}
            onClick={() => setWrapped(value => !value)}><WrapText size={12} aria-hidden="true" /></button>
          <button type="button" className="my-icon-control" aria-label={copyLabel} title={copyLabel}
            aria-disabled={copy.status === 'copying'}
            onClick={() => { if (copy.status !== 'copying') void copy.copy(code) }}>
            {copy.status === 'copied' ? <Check size={12} aria-hidden="true" />
              : copy.status === 'error' ? <TriangleAlert size={12} aria-hidden="true" />
                : <Copy size={12} aria-hidden="true" />}
          </button>
        </span>
      </div>
      <pre>{tokens ? <code data-chat-syntax-highlighted>{tokens.map((line, lineIndex) =>
        <Fragment key={lineIndex}>
          {line.map((token, tokenIndex) => <span key={tokenIndex} style={{ color: token.color }}>{token.content}</span>)}
          {lineIndex < tokens.length - 1 ? '\n' : null}
        </Fragment>,
      )}</code> : children}</pre>
      <span role="status" className={copy.status === 'error' ? 'chat-markdown-codeblock-error' : 'conversation-sr-only'}>
        {copy.status === 'error' ? '复制失败，请重试或选择代码复制' : copy.status === 'copied' ? '代码已复制' : ''}
      </span>
    </div>
  )
}
