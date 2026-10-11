/**
 * 稳定 heading ID 生成（S0 G2，design §6.2「按稳定标题锚点定位」的数据层）：
 * 从 markdown 源文本解析标题（ATX `#` 与 setext 下划线，跳过围栏代码块），
 * 生成内容稳定的 slug 锚点，重复标题以 -1/-2 去重（GitHub 风格）。
 *
 * 稳定性：ID 只由标题文本与出现顺序决定——同一文档重渲染、同文本的不同文档段落
 * 产生相同锚点；渲染端 MarkdownView 按 hast position.line 关联（见 headingAnchorsByLine），
 * 为第三片的「应用新版后按锚点恢复阅读位置」铺路。
 */

export interface HeadingAnchor {
  /** 1-6。setext 下划线映射 1（=）/2（-）。 */
  level: number
  /** 标题纯文本（去标记、去首尾空白）。 */
  text: string
  /** 稳定锚点 ID（同文本去重后唯一）。 */
  id: string
  /** 标题行在源文本中的 1-based 行号（ATX=井号行；setext=文本行）。 */
  line: number
}

/** slug：小写、空白→'-'、去非 [字母数字中文连字符]，空结果回退 'section'。 */
export function headingSlug(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
  return slug.length > 0 ? slug : 'section'
}

const ATX_RE = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/
const SETEXT_EQ_RE = /^[ \t]*=+[ \t]*$/
const SETEXT_DASH_RE = /^[ \t]*-{2,}[ \t]*$/
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/
const LIST_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/

/** 解析 markdown 源的标题锚点（纯函数）。 */
export function computeHeadingAnchors(markdown: string): HeadingAnchor[] {
  const lines = markdown.split('\n')
  const anchors: HeadingAnchor[] = []
  const seen = new Map<string, number>()

  const push = (level: number, text: string, line: number): void => {
    const base = headingSlug(text)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    anchors.push({ level, text, id: n === 0 ? base : `${base}-${n}`, line })
  }

  let fenceChar = '' // '' = 不在围栏内；否则记录 ` 或 ~
  let fenceLen = 0
  let paraStart = -1 // 当前可被 setext 下划线捕获的段落首行（-1 = 无）

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (fenceChar !== '') {
      const close = line.match(FENCE_RE)
      if (close !== null && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        fenceChar = ''
        fenceLen = 0
      }
      paraStart = -1
      continue
    }

    const open = line.match(FENCE_RE)
    if (open !== null) {
      fenceChar = open[1][0]
      fenceLen = open[1].length
      paraStart = -1
      continue
    }

    const atx = line.match(ATX_RE)
    if (atx !== null) {
      const text = (atx[2] ?? '').trim()
      if (text.length > 0) push(atx[1].length, text, i + 1)
      paraStart = -1
      continue
    }

    if (paraStart >= 0 && SETEXT_EQ_RE.test(line)) {
      const text = lines[paraStart].trim()
      if (text.length > 0) push(1, text, paraStart + 1)
      paraStart = -1
      continue
    }
    if (paraStart >= 0 && SETEXT_DASH_RE.test(line)) {
      const text = lines[paraStart].trim()
      if (text.length > 0) push(2, text, paraStart + 1)
      paraStart = -1
      continue
    }

    // 空行结束段落；非空非列表行开启可捕获段落；列表/thematic break 不作 setext 文本
    if (line.trim().length === 0) {
      paraStart = -1
    } else if (!LIST_RE.test(line) && !SETEXT_DASH_RE.test(line)) {
      if (paraStart < 0) paraStart = i
    } else {
      paraStart = -1
    }
  }

  return anchors
}

/** 行号 → 锚点 ID 的查找表（MarkdownView 按 hast position.line 关联用）。 */
export function headingAnchorsByLine(markdown: string): Map<number, string> {
  const map = new Map<number, string>()
  for (const a of computeHeadingAnchors(markdown)) map.set(a.line, a.id)
  return map
}
