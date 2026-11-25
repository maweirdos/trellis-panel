const DOCUMENT_WIDE_SYNTAX = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|:::|\$\$)|\[\^/m
const FENCE_PATTERN = /^ {0,3}(`{3,}(?![^`\n]*`)|~{3,})/
const CONTINUATION_PATTERN = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/
const INSIGHT_OPEN_PATTERN = /^( {0,3})(`?)★ Insight[ \t]+─{3,}\2[ \t]*$/u
const INSIGHT_CLOSE_PATTERN = /^( {0,3})(`?)─{3,}\2[ \t]*$/u
const ATX_HEADING_PATTERN =
  /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const SETEXT_UNDERLINE_PATTERN =
  /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*(?:=+|-+)[ \t]*$/

function githubHeadingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-')
}

export function splitMarkdownBlocks(text: string): string[] | null {
  if (text.startsWith('\ufeff') || text.includes('\r') || DOCUMENT_WIDE_SYNTAX.test(text)) return null
  const blocks: string[] = []
  let blockStart = 0
  let lineStart = 0
  let fence: string | null = null
  let fenceIndent = 0
  let afterBlankLine = false
  let insightIndent: string | null = null
  const headingKeys = new Set<string>()
  const needsWholeHeading = (headingText: string | undefined) => {
    if (headingText === undefined) return false
    if (/[`*_~[\]<&\\!$]|:(?!\s|$)/.test(headingText)) return true
    const key = githubHeadingSlug(headingText)
    if (!key) return false
    if (headingKeys.has(key)) return true
    headingKeys.add(key)
    return false
  }
  const headingNeedsWholeDocument = (line: string, mayUnderline = true) =>
    (mayUnderline && SETEXT_UNDERLINE_PATTERN.test(line)) ||
    needsWholeHeading(ATX_HEADING_PATTERN.exec(line)?.[1])
  let afterContentLine = false
  for (const line of text.split('\n')) {
    const opener = FENCE_PATTERN.exec(line)?.[1]
    const mayUnderline = afterContentLine
    afterContentLine = false
    if (fence !== null) {
      if (/\S/.test(line.slice(0, fenceIndent))) {
        const rest = text.slice(lineStart).split('\n')
        for (const restLine of rest) {
          if (headingNeedsWholeDocument(restLine)) return null
        }
        break
      }
      if (opener && opener[0] === fence[0] && opener.length >= fence.length && line.trim() === opener) {
        fence = null
      }
    } else if (insightIndent !== null && INSIGHT_CLOSE_PATTERN.exec(line)?.[1] === insightIndent) {
      insightIndent = null
      afterBlankLine = false
    } else if (line.trim() === '') {
      afterBlankLine = true
    } else {
      if (headingNeedsWholeDocument(line, mayUnderline)) return null
      afterContentLine = opener === undefined
      if (afterBlankLine && insightIndent === null && lineStart > blockStart && !CONTINUATION_PATTERN.test(line)) {
        blocks.push(text.slice(blockStart, lineStart))
        blockStart = lineStart
      }
      afterBlankLine = false
      if (insightIndent === null) insightIndent = INSIGHT_OPEN_PATTERN.exec(line)?.[1] ?? null
      fence = opener ?? null
      if (opener) fenceIndent = line.indexOf(opener)
    }
    lineStart += line.length + 1
  }
  blocks.push(text.slice(blockStart))
  return blocks
}
