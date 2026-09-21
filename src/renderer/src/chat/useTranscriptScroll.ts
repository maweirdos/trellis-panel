import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 转录区滚动状态机（TPD-013）：
 * - 仅当用户本就停留在底部（±48px）时才跟随新内容滚动；
 * - 用户上滑回看时不拽人，只显示"回到底部"提示；
 * - 内容增长（流式 delta）与条目数量增长共用同一判定。
 */
export function useTranscriptScroll(contentLength: number): {
  containerRef: React.RefObject<HTMLDivElement>
  atBottom: boolean
  scrollToBottom: (behavior?: ScrollBehavior) => void
} {
  const containerRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = containerRef.current
    if (!el) return
    atBottomRef.current = true
    setAtBottom(true)
    el.scrollTo({ top: el.scrollHeight, behavior })
  }, [])

  const onScroll = useCallback((): void => {
    const el = containerRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const nowBottom = distance < 48
    if (nowBottom !== atBottomRef.current) {
      atBottomRef.current = nowBottom
      setAtBottom(nowBottom)
    }
  }, [])

  // 内容增长时：仅在底部才跟随
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentLength])

  return { containerRef, atBottom, scrollToBottom }
}

/** 长会话窗口化：默认只渲染尾部 N 条，向上翻页扩大窗口 */
const WINDOW_STEP = 40

export function useTranscriptWindow(total: number, resetKey: string): {
  visibleCount: number
  showOlder: () => void
  hasOlder: boolean
  hiddenCount: number
} {
  const [visibleCount, setVisibleCount] = useState(WINDOW_STEP)
  useEffect(() => {
    setVisibleCount(WINDOW_STEP)
  }, [resetKey])
  const showOlder = useCallback((): void => {
    setVisibleCount((c) => Math.min(c + WINDOW_STEP, total))
  }, [total])
  const hiddenCount = Math.max(0, total - visibleCount)
  return { visibleCount: Math.min(visibleCount, total), showOlder, hasOlder: hiddenCount > 0, hiddenCount }
}
