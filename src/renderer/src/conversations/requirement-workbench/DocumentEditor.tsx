import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { Bold, CheckSquare, ChevronDown, Code2, FileText, Italic, List, ListOrdered, Quote, Redo2, Sparkles, Table2, Undo2 } from 'lucide-react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { Extension, getSchema, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import { Table, TableKit, renderTableToMarkdown } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { closeHistory } from '@tiptap/pm/history'
import { EditorState, Plugin, TextSelection } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Button, Dropdown, DropdownItem } from '../../my/ui'
import { useInteractionActive, useInteractionGuard } from '../../utils/interaction-scope'
import './editor.css'

export interface DocumentEditorSelection {
  text: string
  from: number
  to: number
  /** Rich positions belong to ProseMirror, never to the serialized Markdown string. */
  positionKind: 'prosemirror' | 'markdown'
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
  onQuote?(selection: DocumentEditorSelection): void
  onPolish?(selection: DocumentEditorSelection): void
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
interface ToolbarState { bold: boolean; italic: boolean; bullet: boolean; ordered: boolean; task: boolean; code: boolean; heading: number; undo: boolean; redo: boolean }
const emptyToolbar: ToolbarState = { bold: false, italic: false, bullet: false, ordered: false, task: false, code: false, heading: 0, undo: false, redo: false }

export function DocumentEditor(props: DocumentEditorProps): JSX.Element {
  const active = useInteractionActive(), canInteract = useInteractionGuard(), id = useId()
  const latest = useRef(props); latest.current = props
  const host = useRef<HTMLDivElement>(null), source = useRef<HTMLTextAreaElement>(null), mounted = useRef(true)
  const [initial] = useState(() => readRich(props.value))
  const [mode, setMode] = useState<'rich' | 'source'>(initial.issue ? 'source' : 'rich')
  const modeRef = useRef(mode); modeRef.current = mode
  const [raw, setRaw] = useState(props.value), current = useRef(props.value), emitted = useRef(props.value)
  const [issue, setIssue] = useState(initial.issue ?? ''), [selection, setSelection] = useState<DocumentEditorSelection | null>(null)
  const selected = useRef<DocumentEditorSelection | null>(null), [toolbar, setToolbar] = useState(emptyToolbar)
  const applying = useRef(false), ready = useRef(false), version = useRef(0), composing = useRef(false), blurPending = useRef(false)
  const identity = useRef(props.documentKey), seenRevision = useRef([props.docRevision, props.bodyRevision])
  const original = useRef({ markdown: props.value, content: initial.content })
  const disabled = Boolean(props.disabled || props.readOnly || !active)
  const selectionValue = (text: string, from: number, to: number, positionKind: DocumentEditorSelection['positionKind']): DocumentEditorSelection => ({ text, from, to, positionKind, documentKey: latest.current.documentKey, docRevision: latest.current.docRevision, bodyRevision: latest.current.bodyRevision, editorVersion: version.current })
  const updateSelection = (value: DocumentEditorSelection | null): void => { selected.current = value; setSelection(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value) }
  const updateToolbar = (editor: Editor): void => {
    const next: ToolbarState = { bold: editor.isActive('bold'), italic: editor.isActive('italic'), bullet: editor.isActive('bulletList'), ordered: editor.isActive('orderedList'), task: editor.isActive('taskList'), code: editor.isActive('codeBlock'), heading: editor.isActive('heading') ? Number(editor.getAttributes('heading').level) : 0, undo: editor.can().undo(), redo: editor.can().redo() }
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
      attributes: { class: 'requirement-document-content', role: 'textbox', 'aria-label': props.ariaLabel ?? '需求文档正文', 'aria-multiline': 'true' },
      handleClick: (_view, _position, event) => { if ((event.target as Element | null)?.closest('a')) { event.preventDefault(); return true } return false }
    },
    onCreate: ({ editor }) => { ready.current = true; updateToolbar(editor) },
    onTransaction: ({ editor }) => { if (mounted.current) updateToolbar(editor) },
    onUpdate: ({ editor }) => {
      if (!ready.current || applying.current || modeRef.current !== 'rich' || !mounted.current) return
      version.current++
      const content = editor.getJSON()
      // Undoing back to an unedited loaded document restores its exact original bytes.
      const text = editor.state.doc.eq(editor.schema.nodeFromJSON(original.current.content)) ? original.current.markdown : markdown.serialize(content)
      try {
        if (!preservesContent(editor.state.doc, text)) { setIssue('当前格式暂不能完整保存，请撤销本次格式操作或切换源码。'); return }
      } catch { setIssue('当前格式暂不能完整保存，请撤销本次格式操作。'); return }
      setIssue(''); publish(text); updateToolbar(editor)
    }
  }, [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { editor?.setEditable(!disabled && mode === 'rich', false) }, [editor, disabled, mode])
  useEffect(() => {
    if (!editor) return
    const differentDocument = identity.current !== props.documentKey
    const revisionChanged = seenRevision.current[0] !== props.docRevision || seenRevision.current[1] !== props.bodyRevision
    identity.current = props.documentKey; seenRevision.current = [props.docRevision, props.bodyRevision]
    if (revisionChanged || differentDocument) updateSelection(null)
    if (!differentDocument && props.value === current.current) return
    const next = readRich(props.value), sourceSelection = source.current ? [source.current.selectionStart, source.current.selectionEnd] : null
    applying.current = true
    try {
      const nextDoc = editor.schema.nodeFromJSON(next.content)
      if (differentDocument) {
        // A different file owns a separate undo history; document changes do not inherit it.
        editor.view.updateState(EditorState.create({ schema: editor.schema, doc: nextDoc, selection: TextSelection.atStart(nextDoc), plugins: editor.state.plugins }))
      } else if (!next.issue) {
        const start = editor.state.doc.content.findDiffStart(nextDoc.content), end = editor.state.doc.content.findDiffEnd(nextDoc.content)
        if (start !== null && end) {
          const overlap = Math.max(0, start - Math.min(end.a, end.b))
          const transaction = editor.state.tr.replace(start, end.a + overlap, nextDoc.slice(start, end.b + overlap))
          editor.view.dispatch(closeHistory(transaction))
        }
      }
      current.current = props.value; emitted.current = props.value; setRaw(props.value)
      original.current = { markdown: props.value, content: next.content }; version.current++
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
      try { editor.commands.setContent(next.content, { emitUpdate: false }); updateToolbar(editor) }
      finally { applying.current = false }
    }
    updateSelection(null); modeRef.current = nextMode; setMode(nextMode); setIssue('')
  }
  const run = (action: (editor: Editor) => void): void => { if (editor && !disabled && canInteract() && !composing.current) action(editor) }
  const quote = (polish: boolean): void => {
    const value = selected.current
    if (!value || !value.text.trim() || value.editorVersion !== version.current || disabled || !canInteract() || composing.current) return
    ;(polish ? latest.current.onPolish : latest.current.onQuote)?.(value)
  }
  const readSourceSelection = (): void => {
    const field = source.current
    if (!field || field.selectionStart === field.selectionEnd) { updateSelection(null); return }
    const from = sourceOffset(current.current, field.selectionStart), to = sourceOffset(current.current, field.selectionEnd)
    updateSelection(selectionValue(current.current.slice(from, to), from, to, 'markdown'))
  }
  return <div ref={host} className="requirement-document-editor" onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; if (blurPending.current) { blurPending.current = false; if (canInteract() && !latest.current.disabled && !latest.current.readOnly) latest.current.onBlur?.() } }} onBlurCapture={event => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    if (composing.current) blurPending.current = true
    else if (canInteract() && !latest.current.disabled && !latest.current.readOnly) latest.current.onBlur?.()
  }}>
    <div className="requirement-editor-toolbar" role="toolbar" aria-label="文档编辑">
      <div className="requirement-editor-modes" role="group" aria-label="编辑方式"><Button size="sm" variant={mode === 'rich' ? 'neutral' : 'ghost'} aria-pressed={mode === 'rich'} disabled={!active} onClick={() => switchMode('rich')}><FileText size={13} />文档</Button><Button size="sm" variant={mode === 'source' ? 'neutral' : 'ghost'} aria-pressed={mode === 'source'} disabled={!active} onClick={() => switchMode('source')}><Code2 size={13} />源码</Button></div>
      {mode === 'rich' && <>
        <Dropdown disabled={disabled} trigger={({ toggle, open }) => <Button size="sm" variant="ghost" disabled={disabled} aria-expanded={open} aria-label="段落样式" onClick={toggle}>{toolbar.heading ? `标题 ${toolbar.heading}` : '正文'}<ChevronDown size={12} /></Button>}>{close => <><DropdownItem selected={!toolbar.heading} onClick={() => { run(editor => { editor.chain().focus().setParagraph().run() }); close() }}>正文</DropdownItem>{([1, 2, 3] as const).map(level => <DropdownItem key={level} selected={toolbar.heading === level} onClick={() => { run(editor => { editor.chain().focus().toggleHeading({ level }).run() }); close() }}>标题 {level}</DropdownItem>)}</>}</Dropdown>
        <Button size="sm" variant="ghost" title="加粗" aria-label="加粗" aria-pressed={toolbar.bold} disabled={disabled} onClick={() => run(editor => { editor.chain().focus().toggleBold().run() })}><Bold size={14} /></Button>
        <Button size="sm" variant="ghost" title="斜体" aria-label="斜体" aria-pressed={toolbar.italic} disabled={disabled} onClick={() => run(editor => { editor.chain().focus().toggleItalic().run() })}><Italic size={14} /></Button>
        <Dropdown disabled={disabled} trigger={({ toggle, open }) => <Button size="sm" variant="ghost" aria-label="列表与区块" title="列表与区块" aria-expanded={open} disabled={disabled} onClick={toggle}><List size={14} /><ChevronDown size={12} /></Button>}>{close => <>
          <DropdownItem selected={toolbar.bullet} icon={<List size={14} />} onClick={() => { run(editor => { editor.chain().focus().toggleBulletList().run() }); close() }}>无序列表</DropdownItem><DropdownItem selected={toolbar.ordered} icon={<ListOrdered size={14} />} onClick={() => { run(editor => { editor.chain().focus().toggleOrderedList().run() }); close() }}>有序列表</DropdownItem><DropdownItem selected={toolbar.task} icon={<CheckSquare size={14} />} onClick={() => { run(editor => { editor.chain().focus().toggleTaskList().run() }); close() }}>待办列表</DropdownItem><DropdownItem selected={toolbar.code} icon={<Code2 size={14} />} onClick={() => { run(editor => { editor.chain().focus().toggleCodeBlock().run() }); close() }}>代码块</DropdownItem><DropdownItem icon={<Table2 size={14} />} onClick={() => { run(editor => { editor.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run() }); close() }}>插入表格</DropdownItem>
        </>}</Dropdown>
        <Button size="sm" variant="ghost" aria-label="撤销" title="撤销" disabled={disabled || !toolbar.undo} onClick={() => run(editor => { editor.chain().focus().undo().run() })}><Undo2 size={14} /></Button><Button size="sm" variant="ghost" aria-label="重做" title="重做" disabled={disabled || !toolbar.redo} onClick={() => run(editor => { editor.chain().focus().redo().run() })}><Redo2 size={14} /></Button>
      </>}
      {selection?.text.trim() && <div className="requirement-editor-selection-actions" aria-label="选中文字操作">{props.onQuote && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => quote(false)}><Quote size={13} />引用</Button>}{props.onPolish && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => quote(true)}><Sparkles size={13} />润色</Button>}</div>}
    </div>
    {issue && <p id={`${id}-issue`} className="requirement-editor-notice my-item-description" role="status">{issue}</p>}
    <div className="requirement-editor-rich my-scrollbar" hidden={mode !== 'rich'}><EditorContent editor={editor} /></div>
    <textarea ref={source} hidden={mode !== 'source'} className="requirement-editor-source my-input my-scrollbar" value={raw} aria-label={`${props.ariaLabel ?? '需求文档正文'}源码`} aria-describedby={issue ? `${id}-issue` : undefined} readOnly={disabled} spellCheck={false} onChange={event => { if (disabled || !canInteract()) return; version.current++; publish(event.target.value); readSourceSelection() }} onSelect={readSourceSelection} />
  </div>
}

export default DocumentEditor
