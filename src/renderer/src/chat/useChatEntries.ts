import { useRef } from 'react'
import { buildEntries, reuseEntries, type ChatEntry } from './entries'
import type { ChatMessageView } from '../../../shared/types'

/**
 * 渲染契约入口（TPD-017）：消息数组 → Entry[]，且与上一次结果做引用复用——
 * 流式增量只替换变化的尾条目，前缀条目保持对象身份，
 * 使 MarkdownView（React.memo）等下游只重渲染真正变化的条目。
 */
export function useChatEntries(messages: ChatMessageView[]): ChatEntry[] {
  const prevRef = useRef<ChatEntry[]>([])
  const next = reuseEntries(prevRef.current, buildEntries(messages))
  prevRef.current = next
  return next
}
