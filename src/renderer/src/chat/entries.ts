import type { ChatMessage } from '../../../shared/types'

/**
 * 转录区展示管道（TPD-013）：原始消息数组 → 稳定展示条目。
 * 纯函数、无副作用；流式增量不属于落库消息，由页面单独渲染流式气泡。
 */

export type ChatEntry =
  | { kind: 'user'; key: string; content: string }
  | { kind: 'assistant'; key: string; content: string; reasoning?: string }

/** 连续 assistant 消息合并为一个回合条目，减少视觉碎片 */
export function buildEntries(messages: ChatMessage[]): ChatEntry[] {
  const out: ChatEntry[] = []
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]
    const key = `m-${i}`
    if (m.role === 'user') {
      out.push({ kind: 'user', key, content: m.content })
      continue
    }
    // assistant（含 system 落入对话历史的兜底）：向后合并连续 assistant
    let content = m.content
    while (i + 1 < messages.length && messages[i + 1].role === 'assistant') {
      i += 1
      content += `\n\n${messages[i].content}`
    }
    out.push({ kind: 'assistant', key, content })
  }
  return out
}
