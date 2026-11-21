import { getSchema, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import { Table, TableKit, renderTableToMarkdown } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Fragment, Slice } from '@tiptap/pm/model'
import { Marked, type marked as MarkedFunction } from 'marked'

const MarkdownTable = Table.extend({
  renderMarkdown(node, helpers) {
    return renderTableToMarkdown(node, {
      ...helpers,
      renderChildren: (...args) => helpers.renderChildren(...args).replace(/(\\*)\|/g, (match: string, slashes: string) => slashes.length % 2 ? match : `${slashes}\\|`)
    })
  }
})

const extensions = [
  StarterKit.configure({ link: { openOnClick: false, autolink: true }, trailingNode: false }),
  TableKit.configure({ table: false }),
  MarkdownTable,
  TaskList,
  TaskItem.configure({ nested: true })
]
const taskPostMarked = new Marked() as unknown as typeof MarkedFunction
taskPostMarked.use({
  extensions: [{
    name: 'taskPostPaddedLabel',
    level: 'inline',
    tokenizer(src) {
      // Some generated headings put padding inside the closing **. Treat
      // that padding as syntax, but keep the original Markdown for saving.
      const match = /^\*\*([\p{L}\p{N}][\p{L}\p{N} \t]{0,100}[：:])[ \t]+\*\*(?!\*)/u.exec(src)
      if (match) return { type: 'strong', raw: match[0], text: match[1], tokens: this.lexer.inlineTokens(match[1]) }
      return undefined
    }
  }],
  hooks: {
    emStrongMask(source: string): string {
      // Marked uses this equal-length mask only to classify delimiters.
      // The lexer still reads the original punctuation and spacing.
      return source.replace(/[，。；：！？、）》」』】〉”’](?=(?:\*{1,3}|_{1,3})[\p{L}\p{N}])/gu, 'a')
    }
  }
})
const markdownManager = new MarkdownManager({ marked: taskPostMarked, extensions })
const schema = getSchema(extensions)
const emptyDocument: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }

export interface TaskPostRichDocument {
  content: JSONContent
  issue?: string
}

export interface TaskPostRichSelection {
  text: string
  from: number
  to: number
}

const taskPostExtensions = [...extensions, Markdown]

export function taskPostBodyWithinLimit(value: string): boolean {
  return value.length <= 1_048_576 && new TextEncoder().encode(value).byteLength <= 1_048_576
}

export { taskPostExtensions }

export function readTaskPostRich(value: string): TaskPostRichDocument {
  try {
    if (!value.trim()) return { content: emptyDocument }
    let unsupported = /^---\r?\n/.test(value) || /^\s*(?:\[\^[^\]]+\]:|:::)/m.test(value)
    markdownManager.instance.walkTokens(markdownManager.instance.lexer(value), token => {
      if (token.type === 'html' || token.type === 'image') unsupported = true
    })
    if (unsupported) return { content: emptyDocument, issue: '任务正文包含复杂格式，已保留原文。' }
    const content = markdownManager.parse(value)
    const serialized = markdownManager.serialize(content)
    if (!schema.nodeFromJSON(content).eq(schema.nodeFromJSON(markdownManager.parse(serialized)))) {
      return { content: emptyDocument, issue: '任务正文需保留原始格式，暂不能用富文本编辑。' }
    }
    return { content }
  } catch {
    return { content: emptyDocument, issue: '任务正文暂不能用富文本编辑，原文已保留。' }
  }
}

export function taskPostPreservesContent(document: ProseMirrorNode, text: string): boolean {
  const restored = document.type.schema.nodeFromJSON(markdownManager.parse(text))
  if (document.eq(restored)) return true
  const code = (node: ProseMirrorNode): string => {
    const values: unknown[] = []
    node.descendants(child => {
      if (child.type.name === 'codeBlock') {
        values.push([child.attrs.language, child.textContent])
        return false
      }
      if (child.isText && child.marks.some(mark => mark.type.name === 'code')) values.push(child.text)
      return true
    })
    return JSON.stringify(values)
  }
  return document.textContent.replace(/\s/g, '') === restored.textContent.replace(/\s/g, '') && code(document) === code(restored)
}

export function taskPostDocumentBody(document: ProseMirrorNode, original: { markdown: string; content: JSONContent }): string {
  return document.eq(document.type.schema.nodeFromJSON(original.content)) ? original.markdown : markdownManager.serialize(document.toJSON())
}

function validMarkdownAnchor(body: string, text: string, from: number, to: number): boolean {
  const splitPair = (offset: number): boolean => offset > 0 && offset < body.length &&
    /[\uD800-\uDBFF]/.test(body[offset - 1]) && /[\uDDC0-\uDFFF]/.test(body[offset])
  return Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < to && to <= body.length &&
    body.slice(from, to) === text && !splitPair(from) && !splitPair(to)
}

function selectionIsSimple(document: ProseMirrorNode, selection: TaskPostRichSelection): boolean {
  if (selection.from < 0 || selection.to > document.content.size || selection.from >= selection.to) return false
  const from = document.resolve(selection.from), to = document.resolve(selection.to)
  if (!from.sameParent(to) || !from.parent.isTextblock || document.textBetween(selection.from, selection.to, '\n') !== selection.text) return false
  let textNodes = 0, complex = false
  document.nodesBetween(selection.from, selection.to, node => {
    if (node.isInline) {
      if (node.isText) textNodes++
      else complex = true
    }
  })
  return !complex && textNodes === 1
}

export function taskPostMarkdownAnchor(body: string, selection: TaskPostRichSelection, document?: ProseMirrorNode): { from: number; to: number } | undefined {
  if (!document || !selectionIsSimple(document, selection)) return undefined
  try {
    const paragraph = document.childCount === 1 ? document.firstChild : null
    if (paragraph?.type.name === 'paragraph' && paragraph.childCount === 1 && paragraph.firstChild?.isText && paragraph.firstChild.marks.length === 0 &&
      body.startsWith(paragraph.textContent) && /^(?:\r?\n)*$/.test(body.slice(paragraph.textContent.length))) {
      const from = selection.from - 1, to = selection.to - 1
      if (validMarkdownAnchor(body, selection.text, from, to)) return { from, to }
    }
    let marker = 'TaskPostSelectionMarker0End', index = 0
    while (body.includes(marker) && index < 100) marker = `TaskPostSelectionMarker${++index}End`
    if (body.includes(marker)) return undefined
    marker += selection.text.match(/[，。；：！？、）》」』】〉”’:]$/u)?.[0] ?? ''
    const marks = document.resolve(selection.from).nodeAfter?.marks ?? []
    const marked = document.replace(selection.from, selection.to, new Slice(Fragment.from(document.type.schema.text(marker, marks)), 0, 0))
    let match: number | undefined, start = 0, attempts = 0
    while (attempts++ < 64) {
      const from = body.indexOf(selection.text, start)
      if (from < 0) break
      const to = from + selection.text.length
      if (validMarkdownAnchor(body, selection.text, from, to) &&
        marked.eq(document.type.schema.nodeFromJSON(markdownManager.parse(body.slice(0, from) + marker + body.slice(to))))) {
        if (match !== undefined) return undefined
        match = from
      }
      start = from + 1
    }
    if (body.indexOf(selection.text, start) >= 0 || match === undefined) return undefined
    return { from: match, to: match + selection.text.length }
  } catch {
    return undefined
  }
}

export function taskPostPlainTextAnchor(body: string, text: string): { from: number; to: number } | undefined {
  if (!text.trim()) return undefined
  const from = body.indexOf(text)
  if (from < 0 || body.indexOf(text, from + 1) >= 0) return undefined
  const anchor = { from, to: from + text.length }
  return validMarkdownAnchor(body, text, anchor.from, anchor.to) ? anchor : undefined
}
