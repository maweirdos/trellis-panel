import type { ChatMessageView } from '../../../shared/types'

/**
 * 转录区展示管道（TPD-013）：原始消息数组 → 稳定展示条目。
 * 纯函数、无副作用；流式增量不属于落库消息，由页面单独渲染流式气泡。
 */

export type ChatEntry =
  | {
      kind: 'user'
      key: string
      /** 节点 id：编辑重发/分支切换的定位符 */
      id?: string
      content: string
      siblingCount?: number
      siblingIndex?: number
      siblingIds?: string[]
    }
  | {
      kind: 'assistant'
      key: string
      id?: string
      content: string
      reasoning?: string
      siblingCount?: number
      siblingIndex?: number
      siblingIds?: string[]
    }

/** 连续 assistant 消息合并为一个回合条目，减少视觉碎片 */
export function buildEntries(messages: ChatMessageView[]): ChatEntry[] {
  const out: ChatEntry[] = []
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]
    const key = `m-${i}`
    if (m.role === 'user') {
      out.push({
        kind: 'user',
        key,
        id: m.id,
        content: m.content,
        siblingCount: m.siblingCount,
        siblingIndex: m.siblingIndex,
        siblingIds: m.siblingIds
      })
      continue
    }
    // assistant（含 system 落入对话历史的兜底）：向后合并连续 assistant
    let content = m.content
    let reasoning = m.reasoning
    let lastId = m.id
    let siblingCount = m.siblingCount
    let siblingIndex = m.siblingIndex
    let siblingIds = m.siblingIds
    while (i + 1 < messages.length && messages[i + 1].role === 'assistant') {
      i += 1
      content += `\n\n${messages[i].content}`
      if (messages[i].reasoning) reasoning = [reasoning, messages[i].reasoning].filter(Boolean).join('\n\n')
      lastId = messages[i].id
      siblingCount = messages[i].siblingCount
      siblingIndex = messages[i].siblingIndex
      siblingIds = messages[i].siblingIds
    }
    out.push({
      kind: 'assistant',
      key,
      id: lastId,
      content,
      ...(reasoning ? { reasoning } : {}),
      siblingCount,
      siblingIndex,
      siblingIds
    })
  }
  return out
}

/**
 * 引用复用（渲染契约，TPD-017）：next 与 prev 在同位置"全等"的条目直接复用 prev 的对象引用，
 * 使下游 React.memo 组件在流式更新时跳过未变条目的重渲染。
 * 全等判定：key、role、content、reasoning、sibling 三元组逐一相等。
 */
export function reuseEntries(prev: ChatEntry[] | undefined, next: ChatEntry[]): ChatEntry[] {
  if (!prev || prev.length === 0) return next
  return next.map((entry, i) => {
    const old = prev[i]
    if (!old || old.kind !== entry.kind || old.key !== entry.key) return entry
    if (old.content !== entry.content) return entry
    if (((old as { reasoning?: string }).reasoning ?? '') !== ((entry as { reasoning?: string }).reasoning ?? '')) return entry
    if ((old.siblingCount ?? 0) !== (entry.siblingCount ?? 0)) return entry
    if ((old.siblingIndex ?? 0) !== (entry.siblingIndex ?? 0)) return entry
    const oldIds = old.siblingIds
    const newIds = entry.siblingIds
    if (oldIds && newIds) {
      if (oldIds.length !== newIds.length || oldIds.some((id, j) => id !== newIds[j])) return entry
    } else if (oldIds !== newIds) {
      return entry
    }
    return old
  })
}
