import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Bold, CheckSquare, ChevronDown, Code2, FileText, Italic, List, ListOrdered, MoreHorizontal, Quote, Redo2, Sparkles, Table2, Undo2 } from 'lucide-react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Extension, getSchema, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import { Table, TableKit, renderTableToMarkdown } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { closeHistory } from '@tiptap/pm/history'
import { EditorState, Plugin, TextSelection } from '@tiptap/pm/state'
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Button, Dropdown, DropdownItem } from '../../my/ui'
import { useInteractionActive, useInteractionGuard } from '../../utils/interaction-scope'
import { useCopyFeedback } from '../../utils/use-copy-feedback'
import './editor.css'

export interface DocumentEditorSelection {
  text: string
  from: number
  to: number
  /** Rich positions belong to ProseMirror, never to the serialized Markdown string. */
  positionKind: 'prosemirror' | 'markdown'
  /** UTF-16 offsets in the exact current Markdown; omitted if the mapping cannot be proved. */
  markdownAnchor?: { kind: 'markdown'; from: number; to: number }
  documentKey?: string
  docRevision?: string
  bodyRevision?: string
  editorVersion: number
}
export interface DocumentEditorProps {
  value: string
  onChange(value: string): void
  disabled?: boolean
  readOnly?: boolean
  documentKey?: string
  docRevision?: string
  bodyRevision?: string
  ariaLabel?: string
  placeholder?: string
  onQuote?(selection: DocumentEditorSelection): void
  onPolish?(selection: DocumentEditorSelection): void
  /** Generate replacement text for exactly this selection; never modify the document. */
  onSelectionEdit?(selection: DocumentEditorSelection): Promise<string>
  /** Resolve only after the applied document's original operation receipt is verified. */
  onSelectionApplied?(selection: DocumentEditorSelection, replacement: string, body: string): Promise<void>
  onBlur?(): void
}

// Use the library table serializer, escaping cell text before it adds column separators.
const MarkdownTable = Table.extend({
  renderMarkdown(node, helpers) {
    return renderTableToMarkdown(node, { ...helpers, renderChildren: (...args) => helpers.renderChildren(...args).replace(/(\\*)\|/g, (match: string, slashes: string) => slashes.length % 2 ? match : `${slashes}\\|`) })
  }
})
const extensions = [StarterKit.configure({ link: { openOnClick: false, autolink: false }, trailingNode: false }), TableKit.configure({ table: false }), MarkdownTable, TaskList, TaskItem.configure({ nested: true })]
const markdown = new MarkdownManager({ extensions }), schema = getSchema(extensions)
const emptyDocument: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }
function preservesContent(document: ProseMirrorNode, text: string): boolean {
  const restored = document.type.schema.nodeFromJSON(markdown.parse(text))
  if (document.eq(restored)) return true
  // Markdown table cells normalize surrounding whitespace. Code whitespace remains exact.
  const code = (node: ProseMirrorNode): string => {
    const values: unknown[] = []
    node.descendants(child => {
      if (child.type.name === 'codeBlock') { values.push([child.attrs.language, child.textContent]); return false }
      if (child.isText && child.marks.some(mark => mark.type.name === 'code')) values.push(child.text)
      return true
    })
    return JSON.stringify(values)
  }
  return document.textContent.replace(/\s/g, '') === restored.textContent.replace(/\s/g, '') && code(document) === code(restored)
}
function readRich(value: string): { content: JSONContent; issue?: string } {
  try {
    if (!value.trim()) return { content: emptyDocument }
    let unsupported = /^---\r?\n/.test(value) || /^\s*(?:\[\^[^\]]+\]:|:::)/m.test(value)
    markdown.instance.walkTokens(markdown.instance.lexer(value), token => { if (token.type === 'html' || token.type === 'image') unsupported = true })
    if (unsupported) return { content: emptyDocument, issue: '此文档包含复杂格式，使用源码可保留原文。' }
    const content = markdown.parse(value), serialized = markdown.serialize(content)
    if (!schema.nodeFromJSON(content).eq(schema.nodeFromJSON(markdown.parse(serialized)))) return { content: emptyDocument, issue: '此文档需使用源码保留完整格式。' }
    return { content }
  } catch { return { content: emptyDocument, issue: '此文档暂不能以富文档编辑，原文已保留在源码中。' } }
}
function sourceOffset(value: string, position: number): number {
  let offset = 0, normalized = 0
  while (offset < value.length && normalized < position) {
    if (value[offset] === '\r' && value[offset + 1] === '\n') offset++
    offset++; normalized++
  }
  return offset
}
interface ToolbarState { bold: boolean; italic: boolean; bullet: boolean; ordered: boolean; task: boolean; code: boolean; heading: number; undo: boolean; redo: boolean; empty: boolean }
const emptyToolbar: ToolbarState = { bold: false, italic: false, bullet: false, ordered: false, task: false, code: false, heading: 0, undo: false, redo: false, empty: true }
interface SelectionReview {
  selection: DocumentEditorSelection
  baseline: string
  document: ProseMirrorNode | null
  phase: 'running' | 'review' | 'error' | 'receipt-pending' | 'receipt-error'
  candidate: string
  error: string
}
interface DocumentHistory {
  state: EditorState
  markdown: string
  original: { markdown: string; content: JSONContent }
}

function selectionIsSimple(document: ProseMirrorNode, selection: DocumentEditorSelection): boolean {
  if (selection.positionKind !== 'prosemirror' || selection.from < 0 || selection.to > document.content.size || selection.from >= selection.to) return false
  const from = document.resolve(selection.from), to = document.resolve(selection.to)
  if (!from.sameParent(to) || !from.parent.isTextblock || document.textBetween(selection.from, selection.to, '\n') !== selection.text) return false
  let textNodes = 0, complex = false
  document.nodesBetween(selection.from, selection.to, node => {
    if (node.isInline) { if (node.isText) textNodes++; else complex = true }
  })
  return !complex && textNodes === 1
}

function validMarkdownAnchor(body: string, text: string, from: number, to: number): boolean {
  const splitPair = (offset: number): boolean => offset > 0 && offset < body.length && /[\uD800-\uDBFF]/.test(body[offset - 1]) && /[\uDC00-\uDFFF]/.test(body[offset])
  return Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < to && to <= body.length && to <= 200_000 &&
    body.slice(from, to) === text && !splitPair(from) && !splitPair(to)
}

function markdownAnchor(body: string, selection: DocumentEditorSelection, document?: ProseMirrorNode): DocumentEditorSelection['markdownAnchor'] {
  if (selection.positionKind === 'markdown') return validMarkdownAnchor(body, selection.text, selection.from, selection.to) ? { kind: 'markdown', from: selection.from, to: selection.to } : undefined
  if (!document || !selectionIsSimple(document, selection)) return undefined
  try {
    const paragraph = document.childCount === 1 ? document.firstChild : null
    if (paragraph?.type.name === 'paragraph' && paragraph.childCount === 1 && paragraph.firstChild?.isText && paragraph.firstChild.marks.length === 0 &&
      body.startsWith(paragraph.textContent) && /^(?:\r?\n)*$/.test(body.slice(paragraph.textContent.length))) {
      const from = selection.from - 1, to = selection.to - 1
      if (validMarkdownAnchor(body, selection.text, from, to)) return { kind: 'markdown', from, to }
    }
    // A unique sentinel is placed in the selected ProseMirror range. Only a serialization
    // that reconstructs the exact current Markdown proves where that range came from.
    let marker = 'TrellisSelectionMarker0End', index = 0
    while (body.includes(marker) && index < 100) marker = `TrellisSelectionMarker${++index}End`
    if (body.includes(marker)) return undefined
    const marks = document.resolve(selection.from).nodeAfter?.marks ?? []
    const marked = document.replace(selection.from, selection.to, new Slice(Fragment.from(document.type.schema.text(marker, marks)), 0, 0))
    const serialized = markdown.serialize(marked.toJSON()), from = serialized.indexOf(marker)
    if (from < 0 || serialized.indexOf(marker, from + marker.length) !== -1 || serialized.slice(0, from) + selection.text + serialized.slice(from + marker.length) !== body) return undefined
    const to = from + selection.text.length
    return validMarkdownAnchor(body, selection.text, from, to) ? { kind: 'markdown', from, to } : undefined
  } catch { return undefined }
}

function diffText(original: string, candidate: string): { prefix: string; removed: string; added: string; suffix: string } {
  const before = Array.from(original), after = Array.from(candidate)
  let start = 0, end = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++
  return { prefix: before.slice(0, start).join(''), removed: before.slice(start, before.length - end).join(''), added: after.slice(start, after.length - end).join(''), suffix: end ? before.slice(-end).join('') : '' }
}

export function DocumentEditor(props: DocumentEditorProps): JSX.Element {
  const active = useInteractionActive(), canInteract = useInteractionGuard(), id = useId()
  const latest = useRef(props); latest.current = props
  const host = useRef<HTMLDivElement>(null), source = useRef<HTMLTextAreaElement>(null), mounted = useRef(true)
  const bubble = useRef<HTMLDivElement>(null), more = useRef<HTMLDivElement>(null)
  const dragging = useRef(false), dismissed = useRef('')
  const bubbleKey = `requirement-selection-${id}`
  const [initial] = useState(() => readRich(props.value))
  const [mode, setMode] = useState<'rich' | 'source'>(initial.issue ? 'source' : 'rich')
  const modeRef = useRef(mode); modeRef.current = mode
  const [raw, setRaw] = useState(props.value), current = useRef(props.value), emitted = useRef(props.value)
  const [issue, setIssue] = useState(initial.issue ?? ''), [selection, setSelection] = useState<DocumentEditorSelection | null>(null)
  const selected = useRef<DocumentEditorSelection | null>(null), [toolbar, setToolbar] = useState(emptyToolbar)
  const [review, setReview] = useState<SelectionReview | null>(null), reviewRef = useRef<SelectionReview | null>(null)
  const reviewToken = useRef(0), reviewRegion = useRef<HTMLDivElement>(null)
  const copyFeedback = useCopyFeedback(props.documentKey)
  const applying = useRef(false), ready = useRef(false), version = useRef(0), composing = useRef(false), blurPending = useRef(false)
  const selectionReplacement = useRef<{ document: ProseMirrorNode; body: string } | null>(null)
  const identity = useRef(props.documentKey), seenRevision = useRef([props.docRevision, props.bodyRevision])
  const original = useRef({ markdown: props.value, content: initial.content })
  const histories = useRef(new Map<string, DocumentHistory>())
  const disabled = Boolean(props.disabled || props.readOnly || !active)
  const updateReview = (next: SelectionReview | null): void => { reviewRef.current = next; setReview(next) }
  const selectionValue = (text: string, from: number, to: number, positionKind: DocumentEditorSelection['positionKind']): DocumentEditorSelection => ({ text, from, to, positionKind, documentKey: latest.current.documentKey, docRevision: latest.current.docRevision, bodyRevision: latest.current.bodyRevision, editorVersion: version.current })
  const updateSelection = (value: DocumentEditorSelection | null): void => { selected.current = value; setSelection(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value) }
  const updateToolbar = (editor: Editor): void => {
    const next: ToolbarState = { bold: editor.isActive('bold'), italic: editor.isActive('italic'), bullet: editor.isActive('bulletList'), ordered: editor.isActive('orderedList'), task: editor.isActive('taskList'), code: editor.isActive('codeBlock'), heading: editor.isActive('heading') ? Number(editor.getAttributes('heading').level) : 0, undo: editor.can().undo(), redo: editor.can().redo(), empty: editor.isEmpty }
    setToolbar(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
    if (modeRef.current !== 'rich') return
    const { from, to, empty } = editor.state.selection
    updateSelection(empty ? null : selectionValue(editor.state.doc.textBetween(from, to, '\n'), from, to, 'prosemirror'))
  }
  const publish = (value: string): void => {
    current.current = value; setRaw(value)
    if (value === emitted.current) return
    emitted.current = value; latest.current.onChange(value)
  }
  const [guard] = useState(() => Extension.create({
    name: 'requirementMarkdownGuard',
    addProseMirrorPlugins: () => [new Plugin({ filterTransaction(transaction) {
      if (!transaction.docChanged || applying.current || !ready.current) return true
      try {
        const text = markdown.serialize(transaction.doc.toJSON())
        if (preservesContent(transaction.doc, text)) return true
      } catch { /* Keep the last good document instead of admitting an unrepresentable edit. */ }
      queueMicrotask(() => { if (mounted.current) setIssue('此格式暂不能完整保存，已保留原文；可切换源码编辑。') })
      return false
    } })]
  }))
  const editor = useEditor({
    extensions: [...extensions, Markdown, guard], content: initial.content,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'requirement-document-content', role: 'textbox', 'aria-label': props.ariaLabel ?? '需求文档正文', 'aria-multiline': 'true', 'data-placeholder': props.placeholder ?? '开始记录需求…' },
      handleClick: (_view, _position, event) => { if ((event.target as Element | null)?.closest('a')) { event.preventDefault(); return true } return false }
    },
    onCreate: ({ editor }) => { ready.current = true; updateToolbar(editor) },
    onTransaction: ({ editor }) => { if (mounted.current) updateToolbar(editor) },
    onUpdate: ({ editor }) => {
      if (!ready.current || applying.current || modeRef.current !== 'rich' || !mounted.current) return
      version.current++
      if (reviewRef.current) setReview({ ...reviewRef.current })
      const content = editor.getJSON()
      // Undoing back to an unedited loaded document restores its exact original bytes.
      const text = selectionReplacement.current?.document.eq(editor.state.doc) ? selectionReplacement.current.body : editor.state.doc.eq(editor.schema.nodeFromJSON(original.current.content)) ? original.current.markdown : markdown.serialize(content)
      try {
        if (!preservesContent(editor.state.doc, text)) { setIssue('当前格式暂不能完整保存，请撤销本次格式操作或切换源码。'); return }
      } catch { setIssue('当前格式暂不能完整保存，请撤销本次格式操作。'); return }
      setIssue(''); publish(text); updateToolbar(editor)
    }
  }, [])
  const ownsFocus = useCallback((node: Node | null): boolean => Boolean(node && (
    host.current?.contains(node) || bubble.current?.contains(node) ||
    (node instanceof Element && node.closest('[data-requirement-editor-menu]')?.getAttribute('data-requirement-editor-menu') === id)
  )), [id])
  const selectionSignature = useCallback((editor: Editor): string => JSON.stringify([
    latest.current.documentKey, latest.current.docRevision, latest.current.bodyRevision,
    version.current, editor.state.selection.from, editor.state.selection.to
  ]), [])
  const shouldShowBubble = useCallback(({ editor, from, to }: { editor: Editor; from: number; to: number }): boolean => {
    return modeRef.current === 'rich' && !latest.current.disabled && !latest.current.readOnly && canInteract() &&
      !composing.current && !dragging.current && dismissed.current !== selectionSignature(editor) &&
      from !== to && Boolean(editor.state.doc.textBetween(from, to).trim()) &&
      (editor.view.hasFocus() || ownsFocus(document.activeElement))
  }, [canInteract, ownsFocus, selectionSignature])
  // Keep the menu in the owning theme root, alongside shared Dropdown portals.
  const appendBubble = useCallback(() => host.current?.closest<HTMLElement>('.my-root') ?? host.current ?? document.body, [])
  const bubbleOptions = useMemo(() => ({ strategy: 'fixed' as const, placement: 'top' as const, flip: true, shift: { padding: 8 } }), [])
  useEffect(() => {
    if (!editor || disabled || mode !== 'rich') return
    let settle: ReturnType<typeof setTimeout> | undefined
    const hide = (): void => { editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, 'hide')) }
    const down = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || !editor.view.dom.contains(event.target)) return
      dragging.current = true
      clearTimeout(settle)
      hide()
    }
    const up = (): void => {
      if (!dragging.current) return
      dragging.current = false
      // A pause during a drag must never summon a menu beneath the pointer.
      settle = setTimeout(() => {
        if (!mounted.current || editor.isDestroyed) return
        const { from, to } = editor.state.selection
        if (!shouldShowBubble({ editor, from, to })) return
        editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, 'show'))
        editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, 'updatePosition'))
      }, 180)
    }
    const focus = (event: FocusEvent): void => { if (!ownsFocus(event.target as Node | null)) hide() }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', up, true)
    document.addEventListener('focusin', focus)
    return () => {
      clearTimeout(settle)
      dragging.current = false
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', up, true)
      document.removeEventListener('focusin', focus)
    }
  }, [editor, disabled, mode, bubbleKey, ownsFocus, shouldShowBubble])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    return () => { reviewToken.current++; reviewRef.current = null }
  }, [props.documentKey])
  useEffect(() => {
    if (review && review.selection.documentKey !== props.documentKey) updateReview(null)
  }, [props.documentKey, review])
  useEffect(() => { editor?.setEditable(!disabled && mode === 'rich', false) }, [editor, disabled, mode])
  useLayoutEffect(() => {
    if (!editor) return
    const differentDocument = identity.current !== props.documentKey
    const revisionChanged = seenRevision.current[0] !== props.docRevision || seenRevision.current[1] !== props.bodyRevision
    if (differentDocument && identity.current) {
      // Source edits do not have ProseMirror positions or history; never attach its stale rich state.
      histories.current.delete(identity.current)
      if (modeRef.current === 'rich') {
        try {
          if (editor.state.doc.eq(editor.schema.nodeFromJSON(markdown.parse(current.current)))) {
            const state = editor.state.apply(closeHistory(editor.state.tr))
            histories.current.set(identity.current, { state, markdown: current.current, original: original.current })
            if (histories.current.size > 8) {
              const oldest = histories.current.keys().next().value
              if (oldest !== undefined) histories.current.delete(oldest)
            }
          }
        } catch { /* An unverified rich state must not be restored. */ }
      }
    }
    identity.current = props.documentKey; seenRevision.current = [props.docRevision, props.bodyRevision]
    if (differentDocument || revisionChanged && props.value !== current.current) updateSelection(null)
    else if (revisionChanged && selected.current && selected.current.editorVersion === version.current) {
      updateSelection({ ...selected.current, docRevision: props.docRevision, bodyRevision: props.bodyRevision })
    }
    if (!differentDocument && props.value === current.current) return
    const next = readRich(props.value), sourceSelection = source.current ? [source.current.selectionStart, source.current.selectionEnd] : null
    applying.current = true
    try {
      const nextDoc = editor.schema.nodeFromJSON(next.content)
      if (differentDocument) {
        const saved = props.documentKey ? histories.current.get(props.documentKey) : undefined
        if (props.documentKey) histories.current.delete(props.documentKey)
        // Restore only this document's exact text, using the editor's current plugin instances.
        if (saved && !next.issue && saved.markdown === props.value) {
          editor.view.updateState(saved.state.reconfigure({ plugins: editor.state.plugins }))
          original.current = saved.original
        } else {
          editor.view.updateState(EditorState.create({ schema: editor.schema, doc: nextDoc, selection: TextSelection.atStart(nextDoc), plugins: editor.state.plugins }))
          original.current = { markdown: props.value, content: next.content }
        }
      } else if (!next.issue) {
        const start = editor.state.doc.content.findDiffStart(nextDoc.content), end = editor.state.doc.content.findDiffEnd(nextDoc.content)
        if (start !== null && end) {
          const overlap = Math.max(0, start - Math.min(end.a, end.b))
          const transaction = editor.state.tr.replace(start, end.a + overlap, nextDoc.slice(start, end.b + overlap))
          editor.view.dispatch(closeHistory(transaction))
          // The next user edit must not merge into the adopted document's undo event.
          editor.view.dispatch(closeHistory(editor.state.tr))
        }
      }
      current.current = props.value; emitted.current = props.value; setRaw(props.value)
      if (!differentDocument) original.current = { markdown: props.value, content: next.content }
      version.current++
      if (next.issue) { modeRef.current = 'source'; setMode('source') }
      setIssue(next.issue ?? ''); updateToolbar(editor)
      if (sourceSelection && source.current) { const length = props.value.length; source.current.setSelectionRange(Math.min(sourceSelection[0], length), Math.min(sourceSelection[1], length)) }
    } catch { modeRef.current = 'source'; setMode('source'); current.current = props.value; emitted.current = props.value; setRaw(props.value); setIssue('原文已保留，请使用源码继续编辑。') }
    finally { applying.current = false }
  }, [editor, props.value, props.documentKey, props.docRevision, props.bodyRevision])
  const switchMode = (nextMode: 'rich' | 'source'): void => {
    if (!editor || !canInteract() || composing.current || nextMode === mode) return
    if (nextMode === 'rich') {
      const next = readRich(current.current)
      if (next.issue) { setIssue(next.issue); return }
      applying.current = true
      try {
        if (!editor.state.doc.eq(editor.schema.nodeFromJSON(next.content))) editor.commands.setContent(next.content, { emitUpdate: false })
        updateToolbar(editor)
      }
      finally { applying.current = false }
    }
    updateSelection(null); modeRef.current = nextMode; setMode(nextMode); setIssue('')
  }
  const run = (action: (editor: Editor) => void): void => { if (editor && !disabled && canInteract() && !composing.current) action(editor) }
  const quote = (polish: boolean): void => {
    const value = selected.current
    if (!value || !value.text.trim() || value.editorVersion !== version.current || value.documentKey !== latest.current.documentKey || current.current !== latest.current.value || disabled || !canInteract() || composing.current) return
    const anchor = markdownAnchor(current.current, value, editor?.state.doc)
    const refreshed = { ...value, docRevision: latest.current.docRevision, bodyRevision: latest.current.bodyRevision, markdownAnchor: anchor }
    if (polish && latest.current.onSelectionEdit) { startReview(refreshed); return }
    ;(polish ? latest.current.onPolish : latest.current.onQuote)?.(refreshed)
  }
  const reviewSnapshotCurrent = (item: SelectionReview): boolean => Boolean(
    item.selection.documentKey === latest.current.documentKey && item.selection.editorVersion === version.current &&
    item.baseline === current.current && item.baseline === latest.current.value &&
    (item.selection.positionKind === 'markdown'
      ? item.baseline.slice(item.selection.from, item.selection.to) === item.selection.text
      : editor && !editor.isDestroyed && item.document && item.document.eq(editor.state.doc))
  )
  const startReview = (value: DocumentEditorSelection, prior?: SelectionReview): void => {
    const generate = latest.current.onSelectionEdit
    if (!generate || disabled || !canInteract() || composing.current) return
    if (prior && !reviewSnapshotCurrent(prior)) return
    const refreshed = { ...value, docRevision: latest.current.docRevision, bodyRevision: latest.current.bodyRevision }
    const snapshot: SelectionReview = prior ? { ...prior, selection: refreshed } : { selection: refreshed, baseline: current.current, document: value.positionKind === 'prosemirror' && editor ? editor.state.doc : null, phase: 'running', candidate: '', error: '' }
    const token = ++reviewToken.current
    updateReview({ ...snapshot, phase: 'running', error: '' })
    if (editor && mode === 'rich') editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, 'hide'))
    requestAnimationFrame(() => { if (token === reviewToken.current && canInteract()) reviewRegion.current?.focus() })
    Promise.resolve().then(() => generate(refreshed)).then(candidate => {
      if (!mounted.current || token !== reviewToken.current || latest.current.documentKey !== value.documentKey) return
      if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('未返回有效的候选文本。')
      updateReview({ ...snapshot, phase: 'review', candidate, error: '' })
    }).catch(error => {
      if (!mounted.current || token !== reviewToken.current || latest.current.documentKey !== value.documentKey) return
      updateReview({ ...snapshot, phase: 'error', error: error instanceof Error ? error.message : '生成失败，请重试。' })
    })
  }
  const closeReview = (): void => {
    if (reviewRef.current?.phase === 'running') setIssue('已关闭审阅；生成可能仍在进行，可在文档菜单中检查原操作。')
    reviewToken.current++; updateReview(null)
    if (modeRef.current === 'rich' && editor && !editor.isDestroyed) editor.view.focus()
    else source.current?.focus()
  }
  const replacementTransaction = (target: Editor, item: SelectionReview) => {
    const { from, to } = item.selection, marks = target.state.doc.resolve(from).nodeAfter?.marks ?? []
    return target.state.tr.replaceWith(from, to, target.schema.text(item.candidate, marks))
  }
  const canApplyReview = (item: SelectionReview): boolean => {
    if (!editor || editor.isDestroyed || disabled || !canInteract() || composing.current || modeRef.current !== 'rich' ||
      !latest.current.onSelectionApplied || item.phase !== 'review' || item.candidate === item.selection.text || /[\r\n]/.test(item.candidate) ||
      !reviewSnapshotCurrent(item) || !item.document || !selectionIsSimple(editor.state.doc, item.selection)) return false
    const anchor = item.selection.markdownAnchor
    if (!anchor || !validMarkdownAnchor(item.baseline, item.selection.text, anchor.from, anchor.to)) return false
    try {
      const body = item.baseline.slice(0, anchor.from) + item.candidate + item.baseline.slice(anchor.to)
      return replacementTransaction(editor, item).doc.eq(editor.schema.nodeFromJSON(markdown.parse(body)))
    } catch { return false }
  }
  const applyReview = (): void => {
    const item = reviewRef.current, recordApplied = latest.current.onSelectionApplied
    if (!item || !editor || !recordApplied || !item.selection.markdownAnchor || !canApplyReview(item)) return
    const transaction = replacementTransaction(editor, item)
    const anchor = item.selection.markdownAnchor
    const body = item.baseline.slice(0, anchor.from) + item.candidate + item.baseline.slice(anchor.to)
    const beforeVersion = version.current
    selectionReplacement.current = { document: transaction.doc, body }
    try { editor.view.dispatch(closeHistory(transaction)) }
    finally { selectionReplacement.current = null }
    if (!editor.state.doc.eq(transaction.doc) || current.current !== body || version.current !== beforeVersion + 1) { setIssue('无法确认候选已安全应用，请检查文档后继续。'); return }
    editor.view.dispatch(closeHistory(editor.state.tr))
    const token = ++reviewToken.current
    updateReview({ ...item, phase: 'receipt-pending', error: '' })
    Promise.resolve().then(() => recordApplied(item.selection, item.candidate, body)).then(() => {
      if (!mounted.current || token !== reviewToken.current || latest.current.documentKey !== item.selection.documentKey) return
      if (reviewRegion.current?.contains(document.activeElement)) closeReview()
      else { reviewToken.current++; updateReview(null) }
    }).catch(error => {
      if (!mounted.current || token !== reviewToken.current || latest.current.documentKey !== item.selection.documentKey) return
      updateReview({ ...item, phase: 'receipt-error', error: error instanceof Error ? error.message : '回执尚未确认。' })
    })
  }
  const copyCandidate = (): void => {
    const candidate = reviewRef.current?.candidate
    if (candidate) void copyFeedback.copy(candidate)
  }
  const readSourceSelection = (): void => {
    const field = source.current
    if (!field || field.selectionStart === field.selectionEnd) { updateSelection(null); return }
    const from = sourceOffset(current.current, field.selectionStart), to = sourceOffset(current.current, field.selectionEnd)
    updateSelection(selectionValue(current.current.slice(from, to), from, to, 'markdown'))
  }
  const formatItems = (close: () => void): JSX.Element => <div data-requirement-editor-menu={id}>
    <DropdownItem selected={!toolbar.heading} onClick={() => { run(editor => { editor.chain().focus().setParagraph().run() }); close() }}>正文</DropdownItem>
    {([1, 2, 3] as const).map(level => <DropdownItem key={level} selected={toolbar.heading === level} onClick={() => { run(editor => { editor.chain().focus().toggleHeading({ level }).run() }); close() }}>标题 {level}</DropdownItem>)}
    <DropdownItem selected={toolbar.bullet} icon={<List size={14} />} onClick={() => { run(editor => { editor.chain().focus().toggleBulletList().run() }); close() }}>无序列表</DropdownItem>
    <DropdownItem selected={toolbar.ordered} icon={<ListOrdered size={14} />} onClick={() => { run(editor => { editor.chain().focus().toggleOrderedList().run() }); close() }}>有序列表</DropdownItem>
    <DropdownItem selected={toolbar.task} icon={<CheckSquare size={14} />} onClick={() => { run(editor => { editor.chain().focus().toggleTaskList().run() }); close() }}>待办列表</DropdownItem>
    <DropdownItem selected={toolbar.code} icon={<Code2 size={14} />} onClick={() => { run(editor => { editor.chain().focus().toggleCodeBlock().run() }); close() }}>代码块</DropdownItem>
    <DropdownItem icon={<Table2 size={14} />} onClick={() => { run(editor => { editor.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run() }); close() }}>插入表格</DropdownItem>
  </div>
  const quoteItems = (close: () => void): JSX.Element => <>
    {props.onQuote && <DropdownItem disabled={disabled || !selection?.text.trim()} icon={<Quote size={14} />} onClick={() => { quote(false); close() }}>引用选中文字</DropdownItem>}
    {(props.onPolish || props.onSelectionEdit) && <DropdownItem disabled={disabled || !selection?.text.trim() || Boolean(review)} icon={<Sparkles size={14} />} onClick={() => { quote(true); close() }}>润色选中文字</DropdownItem>}
  </>
  return <div ref={host} className="requirement-document-editor" data-empty={!disabled && toolbar.empty || undefined}
    onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || composing.current || !canInteract()) return
      if (event.altKey && event.key === 'F10') { event.preventDefault(); const trigger = more.current?.querySelector<HTMLButtonElement>('[data-editor-more]'); trigger?.focus({ preventScroll: true }); if (trigger?.getAttribute('aria-expanded') !== 'true') trigger?.click() }
      else if (event.key === 'Escape' && editor && bubble.current?.isConnected && !(event.target as Element).closest('.my-menu-item')) {
        event.preventDefault(); event.stopPropagation(); dismissed.current = selectionSignature(editor)
        editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, 'hide'))
        if (mode === 'rich') editor.view.focus()
      }
    }}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; if (blurPending.current) { blurPending.current = false; if (canInteract() && !latest.current.disabled && !latest.current.readOnly) latest.current.onBlur?.() } }} onBlurCapture={event => {
      if (ownsFocus(event.relatedTarget as Node | null)) return
      if (composing.current) blurPending.current = true
      else if (canInteract() && !latest.current.disabled && !latest.current.readOnly) latest.current.onBlur?.()
    }}>
    <div ref={more} className="requirement-editor-controls" role="group" aria-label="文档视图与格式">
      <Button size="sm" variant={mode === 'rich' ? 'neutral' : 'ghost'} aria-pressed={mode === 'rich'} disabled={!active} onClick={() => switchMode('rich')}><FileText size={13} />文档</Button>
      <Button size="sm" variant={mode === 'source' ? 'neutral' : 'ghost'} aria-pressed={mode === 'source'} disabled={!active} onClick={() => switchMode('source')}><Code2 size={13} />源码</Button>
      <Dropdown align="right" disabled={disabled} trigger={({ toggle, open }) => <Button data-editor-more size="sm" variant="ghost" disabled={disabled} aria-label="更多文档操作" title="更多文档操作 (Alt+F10)" aria-haspopup="true" aria-expanded={open} onClick={toggle}><MoreHorizontal size={14} /></Button>}>{close => <div data-requirement-editor-menu={id}>
        {mode === 'rich' && <>
          <DropdownItem selected={toolbar.bold} icon={<Bold size={14} />} onClick={() => { run(editor => { editor.chain().focus().toggleBold().run() }); close() }}>加粗</DropdownItem>
          <DropdownItem selected={toolbar.italic} icon={<Italic size={14} />} onClick={() => { run(editor => { editor.chain().focus().toggleItalic().run() }); close() }}>斜体</DropdownItem>
          {formatItems(close)}
          <DropdownItem disabled={!toolbar.undo} icon={<Undo2 size={14} />} onClick={() => { run(editor => { editor.chain().focus().undo().run() }); close() }}>撤销</DropdownItem>
          <DropdownItem disabled={!toolbar.redo} icon={<Redo2 size={14} />} onClick={() => { run(editor => { editor.chain().focus().redo().run() }); close() }}>重做</DropdownItem>
        </>}
        {quoteItems(close)}
      </div>}</Dropdown>
    </div>
    {issue && <p id={`${id}-issue`} className="requirement-editor-notice my-item-description" role="status">{issue}</p>}
    {review && review.selection.documentKey === props.documentKey && <section ref={reviewRegion} tabIndex={-1} className="requirement-editor-review" aria-label="选区润色审阅" onKeyDown={event => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (review.phase !== 'receipt-pending') closeReview() }
    }}>
      <div className="requirement-editor-review-header"><strong className="my-item-title">选区润色</strong><span role="status" className="my-item-description">{review.phase === 'running' ? '正在生成候选…' : review.phase === 'error' ? '生成失败' : review.phase === 'receipt-pending' ? '已应用，正在核对回执…' : review.phase === 'receipt-error' ? '已应用，回执待核对' : '请审阅差异'}</span></div>
      {review.phase === 'error' && <p className="my-item-description" role="alert">{review.error}</p>}
      {review.phase === 'receipt-error' && <p className="my-item-description" role="alert">本地修改已保留。{review.error} 请在文档菜单中检查原操作，勿重复应用。</p>}
      {review.phase === 'review' && <>
        <div className="requirement-editor-review-diff" aria-label="原文与候选差异">{(() => { const diff = diffText(review.selection.text, review.candidate); return <>{diff.prefix}<del>{diff.removed}</del><ins>{diff.added}</ins>{diff.suffix}</> })()}</div>
        <div className="requirement-editor-review-candidate"><span className="my-item-title">候选文本</span><div>{review.candidate}</div></div>
        {copyFeedback.status === 'copied' && <p className="my-item-description" role="status">候选文本已复制。</p>}
        {copyFeedback.status === 'error' && <p className="my-item-description" role="alert">复制失败，请手动选择候选文本复制。</p>}
        {!canApplyReview(review) && <p className="my-item-description">{review.candidate === review.selection.text ? '候选与原文相同。' : !props.onSelectionApplied ? '暂无法登记应用回执，请比较或复制候选。' : '无法确认原选区可安全替换，请比较或复制候选。'}</p>}
      </>}
      <div className="requirement-editor-review-actions">
        {(review.phase === 'review' || review.phase === 'error') && <Button size="sm" variant="ghost" disabled={disabled || !reviewSnapshotCurrent(review)} onClick={() => startReview(review.selection, review)}>重试</Button>}
        {review.phase === 'review' && <Button size="sm" variant="ghost" disabled={!active || copyFeedback.status === 'copying'} onClick={copyCandidate}>复制候选</Button>}
        {review.phase !== 'receipt-pending' && <Button size="sm" variant="ghost" onClick={closeReview}>{review.phase === 'running' || review.phase === 'receipt-error' ? '关闭审阅' : '放弃'}</Button>}
        {review.phase === 'review' && <Button size="sm" variant="neutral" disabled={!canApplyReview(review)} onClick={applyReview}>应用</Button>}
      </div>
    </section>}
    <div className="requirement-editor-rich my-scrollbar" hidden={mode !== 'rich'} onScroll={() => { if (editor && bubble.current?.isConnected) editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, 'updatePosition')) }} onMouseDown={event => {
      if (event.button === 0 && !disabled && canInteract() && !composing.current && (event.target === event.currentTarget || (event.target as Element).classList.contains('requirement-editor-page'))) {
        event.preventDefault(); editor?.commands.focus('end')
      }
    }}><EditorContent className="requirement-editor-page" editor={editor} /></div>
    {editor && mode === 'rich' && !disabled && <BubbleMenu ref={bubble} editor={editor} pluginKey={bubbleKey} updateDelay={180} appendTo={appendBubble} options={bubbleOptions} shouldShow={shouldShowBubble} className="requirement-editor-bubble my-menu" role="toolbar" aria-label="选中文字操作" onMouseDown={event => { if (event.button === 0) event.preventDefault() }}>
      <Dropdown disabled={disabled} trigger={({ toggle, open }) => <Button size="sm" variant="ghost" aria-label="段落样式" aria-haspopup="true" aria-expanded={open} onClick={toggle}>{toolbar.heading ? `标题 ${toolbar.heading}` : toolbar.bullet ? '无序列表' : toolbar.ordered ? '有序列表' : toolbar.task ? '待办列表' : toolbar.code ? '代码块' : '正文'}<ChevronDown size={12} /></Button>}>{formatItems}</Dropdown>
      <Button size="sm" variant="ghost" title="加粗" aria-label="加粗" aria-pressed={toolbar.bold} onClick={() => run(editor => { editor.chain().focus().toggleBold().run() })}><Bold size={14} /></Button>
      <Button size="sm" variant="ghost" title="斜体" aria-label="斜体" aria-pressed={toolbar.italic} onClick={() => run(editor => { editor.chain().focus().toggleItalic().run() })}><Italic size={14} /></Button>
      {(props.onQuote || props.onPolish || props.onSelectionEdit) && <span className="requirement-editor-menu-divider" aria-hidden="true" />}
      {props.onQuote && <Button size="sm" variant="ghost" onClick={() => quote(false)}><Quote size={13} />引用</Button>}
      {(props.onPolish || props.onSelectionEdit) && <Button size="sm" variant="ghost" disabled={Boolean(review)} onClick={() => quote(true)}><Sparkles size={13} />润色</Button>}
    </BubbleMenu>}
    <textarea ref={source} hidden={mode !== 'source'} className="requirement-editor-source my-scrollbar" value={raw} placeholder={props.placeholder ?? '开始记录需求…'} aria-label={`${props.ariaLabel ?? '需求文档正文'}源码`} aria-describedby={issue ? `${id}-issue` : undefined} readOnly={disabled} spellCheck={false} onChange={event => { if (disabled || !canInteract()) return; version.current++; publish(event.target.value); readSourceSelection() }} onSelect={readSourceSelection} onKeyUp={readSourceSelection} onPointerUp={readSourceSelection} />
  </div>
}

export default DocumentEditor
