import { useEffect, useRef, type JSX, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { Button } from '../my/ui'

export interface ThreadFindBarProps {
  readonly open: boolean
  readonly query: string
  readonly matchCount: number
  readonly activeMatchIndex: number
  readonly onQueryChange: (query: string) => void
  readonly onNext: () => void
  readonly onPrev: () => void
  readonly onClose: () => void
}

/**
 * 当前会话内的快捷查找浮条（Ctrl+F）：
 * 对标 t3code 单会话查找交互，保持轻量中性表面与 tabular-nums 计数器，支持中文输入法防误触发。
 */
export function ThreadFindBar({
  open,
  query,
  matchCount,
  activeMatchIndex,
  onQueryChange,
  onNext,
  onPrev,
  onClose,
}: ThreadFindBarProps): JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)

  useEffect(() => {
    composingRef.current = false
    if (!open) return
    const timer = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(timer)
  }, [open])

  if (!open) return null

  const counterText = query.trim()
    ? (matchCount > 0 ? `${activeMatchIndex + 1} / ${matchCount}` : '0 / 0')
    : ''

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) {
      if (event.key === 'Escape') event.stopPropagation()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) onPrev()
      else onNext()
    }
  }

  return (
    <div className="conversation-find-bar" role="search" aria-label="在当前对话中查找">
      <Search size={14} className="conversation-find-bar-icon" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        className="conversation-find-bar-input"
        value={query}
        placeholder="在当前对话中查找…"
        aria-label="在当前对话中查找"
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        onKeyDown={handleKeyDown}
        onChange={event => onQueryChange(event.target.value.slice(0, 160))}
      />
      {counterText && (
        <span className="conversation-find-bar-counter" aria-live="polite">
          {counterText}
        </span>
      )}
      <div className="conversation-find-bar-actions">
        <Button
          size="sm"
          variant="ghost"
          type="button"
          title="上一条匹配 (Shift+Enter)"
          aria-label="上一条匹配"
          disabled={matchCount === 0}
          onClick={onPrev}
        >
          <ChevronUp size={14} aria-hidden="true" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          title="下一条匹配 (Enter)"
          aria-label="下一条匹配"
          disabled={matchCount === 0}
          onClick={onNext}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          title="关闭查找 (Esc)"
          aria-label="关闭查找"
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
