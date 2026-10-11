import { computeHeadingAnchors, type HeadingAnchor } from './heading-anchors'

/**
 * 阅读位置恢复（S0 G2 第三片，design §6.2"按稳定标题锚点+段内偏移定位"）：
 * 「阅读新版」替换正文后，不能只复原数字 scrollTop（在新文档中已失效）——
 * 先按稳定标题锚点定位章节，再叠加段内像素偏移；锚点消失时定位到最近存活章节
 * 并提示；无任何存活锚点时按旧 scrollTop 截断到新滚动范围。
 *
 * 纯核心 resolveScrollRestore 可冒烟；DOM 捕获/应用是薄封装。
 */

export interface CapturedScroll {
  /** 捕获时所在章节的稳定锚点 ID；null = 捕获时不在任何章节内（顶部区域）。 */
  anchorId: string | null
  /** 章节内像素偏移（scrollTop - 章节顶边）。anchorId=null 时为 0。 */
  offsetPx: number
  /** 捕获时的绝对 scrollTop（无锚点恢复时的截断基准）。 */
  scrollTopPx: number
}

export interface ScrollRestorePlan {
  /** 恢复目标锚点；null = 无锚点可用，按 scrollTopPx 截断恢复。 */
  targetAnchorId: string | null
  /** true = 原锚点已消失，回退到最近存活章节（调用方须给出提示）。 */
  fallbackUsed: boolean
  /** 目标锚点章节内偏移（targetAnchorId=null 时为 scrollTopPx 的截断值）。 */
  offsetPx: number
  /** 截断恢复时的绝对目标（targetAnchorId 非 null 时为 null）。 */
  absolutePx: number | null
}

/**
 * 纯核心：计算恢复计划。
 * - 锚点在新文档存活 → 原锚点 + 原偏移，不提示。
 * - 锚点消失 → 旧文档中该锚点之前最近的存活锚点；之前没有则取其后最近的存活
 *   锚点（文档被整体前移时仍给读者一个落点）；回退须提示。
 * - 无存活锚点（或捕获时本就无锚点）→ 截断恢复旧 scrollTop。
 */
export function resolveScrollRestore(params: {
  captured: CapturedScroll
  oldText: string
  newText: string
}): ScrollRestorePlan {
  const { captured, oldText, newText } = params
  const oldAnchors = computeHeadingAnchors(oldText)
  const newAnchors = computeHeadingAnchors(newText)
  const newIds = new Set(newAnchors.map((a) => a.id))

  if (captured.anchorId === null) {
    return { targetAnchorId: null, fallbackUsed: false, offsetPx: 0, absolutePx: captured.scrollTopPx }
  }
  if (newIds.has(captured.anchorId)) {
    return { targetAnchorId: captured.anchorId, fallbackUsed: false, offsetPx: captured.offsetPx, absolutePx: null }
  }

  const idx = oldAnchors.findIndex((a) => a.id === captured.anchorId)
  let fallback: HeadingAnchor | undefined
  if (idx >= 0) {
    for (let i = idx - 1; i >= 0 && fallback === undefined; i--) {
      if (newIds.has(oldAnchors[i].id)) fallback = oldAnchors[i]
    }
    for (let i = idx + 1; i < oldAnchors.length && fallback === undefined; i++) {
      if (newIds.has(oldAnchors[i].id)) fallback = oldAnchors[i]
    }
  }
  if (fallback === undefined) {
    return { targetAnchorId: null, fallbackUsed: true, offsetPx: 0, absolutePx: captured.scrollTopPx }
  }
  return { targetAnchorId: fallback.id, fallbackUsed: true, offsetPx: 0, absolutePx: null }
}

/* ---------------- DOM 薄封装（渲染层使用） ---------------- */

/** 向上找最近的可滚动祖先（阅读区滚动容器由各入口持有，不假设 reader 自身滚动）。 */
export function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  let cur = el
  while (cur !== null && cur !== document.body) {
    const style = window.getComputedStyle(cur)
    const overflowY = style.overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight) return cur
    cur = cur.parentElement
  }
  return null
}

const HEADING_SELECTOR = 'h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'

/** 从容器捕获当前阅读位置（最后滚过的标题锚点 + 段内偏移）。 */
export function captureScrollPosition(container: HTMLElement): CapturedScroll {
  const scroller = findScrollContainer(container) ?? container
  const scrollTop = scroller.scrollTop
  const scrollerTop = scroller.getBoundingClientRect().top
  let anchorId: string | null = null
  let anchorTop = 0
  for (const h of Array.from(scroller.querySelectorAll<HTMLElement>(HEADING_SELECTOR))) {
    const top = h.getBoundingClientRect().top - scrollerTop + scrollTop
    if (top <= scrollTop + 1) {
      anchorId = h.id
      anchorTop = top
    } else {
      break
    }
  }
  return {
    anchorId,
    offsetPx: anchorId === null ? 0 : Math.max(0, scrollTop - anchorTop),
    scrollTopPx: scrollTop
  }
}

/** 应用恢复计划（rAF 后调用；目标截断到新滚动范围）。 */
export function applyScrollPlan(container: HTMLElement, plan: ScrollRestorePlan): void {
  const scroller = findScrollContainer(container) ?? container
  let target: number
  if (plan.targetAnchorId === null) {
    target = plan.absolutePx ?? 0
  } else {
    const el = scroller.querySelector<HTMLElement>(`[id="${cssEscape(plan.targetAnchorId)}"]`)
    if (el === null) {
      target = plan.absolutePx ?? 0
    } else {
      const scrollerTop = scroller.getBoundingClientRect().top
      target = el.getBoundingClientRect().top - scrollerTop + scroller.scrollTop + plan.offsetPx
    }
  }
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  scroller.scrollTop = Math.min(Math.max(0, target), max)
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value
}
