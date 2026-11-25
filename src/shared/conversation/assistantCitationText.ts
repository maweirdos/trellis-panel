import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  ASSISTANT_CITATION_CONTEXT_LENGTH,
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  ASSISTANT_CITATION_MAX_ID_LENGTH,
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  AssistantCitation,
} from './assistantCitations'

export const LOCAL_ASSISTANT_CITATION_ENVIRONMENT = 'local'
const CITATION_PROTOCOL = 't3-citation:'
const CITATION_HREF_PREFIX = `${CITATION_PROTOCOL}//v1/`
const MAX_CITATION_HREF_LENGTH = 9 * (
  ASSISTANT_CITATION_MAX_TEXT_LENGTH + ASSISTANT_CITATION_MAX_COMMENT_LENGTH +
  3 * ASSISTANT_CITATION_MAX_ID_LENGTH + 2 * ASSISTANT_CITATION_CONTEXT_LENGTH
) + 1_000
const CITATION_LINK = new RegExp(
  String.raw`\[Assistant quote\]\((${CITATION_HREF_PREFIX}[^\s)]{1,${MAX_CITATION_HREF_LENGTH - CITATION_HREF_PREFIX.length}})\)`,
  'g',
)
const decodeCitation = Schema.decodeUnknownOption(AssistantCitation)

export function withAssistantCitationComment(citation: AssistantCitation, comment: string): AssistantCitation {
  const { comment: _previousComment, ...source } = citation
  const trimmedComment = comment.trim()
  return trimmedComment ? { ...source, comment: trimmedComment } : source
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value.replace(/[\uD800-\uDFFF]/gu, '\uFFFD')).replace(
    /[!'()*]/gu,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export function serializeAssistantCitation(citation: AssistantCitation): string {
  const path = [citation.environmentId, citation.threadId, citation.messageId].map(encodePathPart).join('/')
  const query = new URLSearchParams({
    text: citation.text, start: String(citation.start), end: String(citation.end),
    prefix: citation.prefix, suffix: citation.suffix,
  })
  if (citation.comment !== undefined) query.set('comment', citation.comment)
  return `[Assistant quote](${CITATION_HREF_PREFIX}${path}?${query})`
}

function parseAssistantCitationHref(href: string): AssistantCitation | null {
  if (!href.startsWith(CITATION_HREF_PREFIX) || href.length > MAX_CITATION_HREF_LENGTH) return null
  try {
    const url = new URL(href)
    const parts = url.pathname.slice(1).split('/')
    if (url.protocol !== CITATION_PROTOCOL || url.hostname !== 'v1' || parts.length !== 3 ||
      url.username || url.password || url.port || url.hash) return null
    const requiredKeys = ['text', 'start', 'end', 'prefix', 'suffix']
    const comment = url.searchParams.get('comment')
    if (url.searchParams.size !== requiredKeys.length + (comment === null ? 0 : 1) ||
      requiredKeys.some(key => url.searchParams.getAll(key).length !== 1)) return null
    const start = url.searchParams.get('start') ?? ''
    const end = url.searchParams.get('end') ?? ''
    if (!/^\d{1,16}$/u.test(start) || !/^\d{1,16}$/u.test(end)) return null
    const [environmentId, threadId, messageId] = parts.map(decodeURIComponent)
    return Option.getOrNull(decodeCitation({
      version: 1, environmentId, threadId, messageId, text: url.searchParams.get('text'),
      start: Number(start), end: Number(end), prefix: url.searchParams.get('prefix'), suffix: url.searchParams.get('suffix'),
      ...(comment === null ? {} : { comment }),
    }))
  } catch {
    return null
  }
}

export function assistantCitationLabel(citation: AssistantCitation): string {
  const preview = (citation.comment?.trim() || citation.text).replace(/\s+/gu, ' ')
  if (preview.length <= 64) return preview
  const end = /^[\uDC00-\uDFFF]$/u.test(preview[64]) ? 63 : 64
  return `${preview.slice(0, end)}…`
}

export function collectAssistantCitations(text: string) {
  const citations: { citation: AssistantCitation; source: string; start: number; end: number }[] = []
  for (const match of text.matchAll(CITATION_LINK)) {
    const citation = parseAssistantCitationHref(match[1])
    if (citation) citations.push({ citation, source: match[0], start: match.index, end: match.index + match[0].length })
  }
  return citations
}

export function expandAssistantCitationsForProvider(prompt: string): string {
  const matches = collectAssistantCitations(prompt)
  if (matches.length === 0) return prompt
  const citations: { id: string; citation: AssistantCitation }[] = []
  const idsBySource = new Map<string, string>()
  let cursor = 0
  let text = ''
  for (const match of matches) {
    let id = idsBySource.get(match.source)
    if (!id) {
      id = `assistant-quote-${citations.length + 1}`
      idsBySource.set(match.source, id)
      citations.push({ id, citation: match.citation })
    }
    text += `${prompt.slice(cursor, match.start)}[${id}]`
    cursor = match.end
  }
  text += prompt.slice(cursor)
  const data = JSON.stringify(citations, null, 2).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e').replace(/&/gu, '\\u0026')
  const description = '引用内容来自先前的助手回复。citation.text 是引用材料。citation.comment 如存在，是用户对该段引用的请求或评论。'
  return `${text}\n\n<assistant_citations>\n${description}\n${data}\n</assistant_citations>`
}
