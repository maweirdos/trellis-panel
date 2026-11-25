import {
  ASSISTANT_CITATION_CONTEXT_LENGTH, ASSISTANT_CITATION_MAX_TEXT_LENGTH, type AssistantCitation,
} from '../../../shared/conversation/assistantCitations'
import { LOCAL_ASSISTANT_CITATION_ENVIRONMENT } from '../../../shared/conversation/assistantCitationText'
import { EnvironmentId, MessageId, ThreadId } from '../../../shared/conversation/baseSchemas'

const SOURCE_SELECTOR = '[data-assistant-citation-source]'
const EXCLUDED_SELECTOR = 'button:not(.chat-project-file-link), input, textarea, [hidden], [aria-hidden=true], script, style, svg'
const BLOCK_SELECTOR = 'article, blockquote, div, h1, h2, h3, h4, h5, h6, li, ol, p, pre, table, td, th, tr, ul'

interface TextChunk {
  readonly node: Text
  readonly start: number
  readonly end: number
}

function readAssistantText(root: HTMLElement) {
  const parts: string[] = []
  const chunks: TextChunk[] = []
  let length = 0
  let separator = false
  const visit = (node: globalThis.Node): void => {
    if (node instanceof Text && node.length > 0) {
      if (separator && length > 0) { parts.push('\n'); length++ }
      separator = false
      chunks.push({ node, start: length, end: length + node.length })
      parts.push(node.data)
      length += node.length
      return
    }
    if (!(node instanceof Element) || node.matches(EXCLUDED_SELECTOR)) return
    const block = node.matches(BLOCK_SELECTOR)
    if (block || node.tagName === 'BR') separator = true
    for (const child of node.childNodes) visit(child)
    if (block) separator = true
  }
  visit(root)
  return { text: parts.join(''), chunks }
}

function selectedChunks(root: HTMLElement, range: Range) {
  const { text, chunks } = readAssistantText(root)
  const selected = chunks.filter(chunk => range.intersectsNode(chunk.node))
  const first = selected[0]
  const last = selected.at(-1)
  if (!first || !last) return null
  const start = first.start + (range.startContainer === first.node ? range.startOffset : 0)
  const end = last.start + (range.endContainer === last.node ? range.endOffset : last.node.length)
  return { text, start, end }
}

export function captureAssistantCitation(source: HTMLElement, threadId: string, range: Range): AssistantCitation | null {
  const messageId = source.dataset.assistantCitationSource
  if (!messageId || range.collapsed || !source.contains(range.startContainer) || !source.contains(range.endContainer)) return null
  const selected = selectedChunks(source, range)
  if (!selected) return null
  const raw = selected.text.slice(selected.start, selected.end)
  const excerpt = raw.trim().slice(0, ASSISTANT_CITATION_MAX_TEXT_LENGTH).replace(/[\uD800-\uDFFF]/gu, '\uFFFD')
  if (!excerpt) return null
  const start = selected.start + raw.length - raw.trimStart().length
  const end = start + excerpt.length
  return {
    version: 1, environmentId: EnvironmentId.make(LOCAL_ASSISTANT_CITATION_ENVIRONMENT),
    threadId: ThreadId.make(threadId), messageId: MessageId.make(messageId),
    text: excerpt, start, end,
    prefix: selected.text.slice(Math.max(0, start - ASSISTANT_CITATION_CONTEXT_LENGTH), start),
    suffix: selected.text.slice(end, end + ASSISTANT_CITATION_CONTEXT_LENGTH),
  }
}

export function captureAssistantTextSelection(viewport: HTMLElement, threadId: string, selection: Selection | null) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const source = element?.closest<HTMLElement>(SOURCE_SELECTOR)
  if (!source || !viewport.contains(source)) return null
  const citation = captureAssistantCitation(source, threadId, range)
  return citation ? { citation, range } : null
}

export function resolveAssistantCitationRange(source: HTMLElement, citation: AssistantCitation): Range | null {
  const { text, chunks } = readAssistantText(source)
  let start = citation.start
  if (text.slice(start, citation.end) !== citation.text) {
    let match = text.indexOf(citation.text)
    start = -1
    while (match !== -1) {
      const end = match + citation.text.length
      if (text.slice(0, match).endsWith(citation.prefix) && text.slice(end).startsWith(citation.suffix)) {
        if (start !== -1) return null
        start = match
      }
      match = text.indexOf(citation.text, match + 1)
    }
    if (start === -1) return null
  }
  const end = start + citation.text.length
  const first = chunks.find(chunk => start >= chunk.start && start < chunk.end)
  const last = chunks.find(chunk => end > chunk.start && end <= chunk.end)
  if (!first || !last) return null
  const range = source.ownerDocument.createRange()
  range.setStart(first.node, start - first.start)
  range.setEnd(last.node, end - last.start)
  return range
}
