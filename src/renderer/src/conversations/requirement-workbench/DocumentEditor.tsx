import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
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
  placeholder?: string
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
  const applying = useRef(false), ready = useRef(false), version = useRef(0), composing = useRef(false), blurPending = useRef(false)
  const identity = useRef(props.documentKey), seenRevision = useRef([props.docRevision, props.bodyRevision])
  const original = useRef({ markdown: props.value, content: initial.content })
  const disabled = Boolean(props.disabled || props.readOnly || !active)
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
      const content = editor.getJSON()
      // Undoing back to an unedited loaded document restores its exact original bytes.
      const text = editor.state.doc.eq(editor.schema.nodeFromJSON(original.current.content)) ? original.current.markdown : markdown.serialize(content)
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
          // The next user edit must not merge into the adopted document's undo event.
          editor.view.dispatch(closeHistory(editor.state.tr))
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
    if (!value || !value.text.trim() || value.editorVersion !== version.current || value.documentKey !== latest.current.documentKey || value.docRevision !== latest.current.docRevision || value.bodyRevision !== latest.current.bodyRevision || disabled || !canInteract() || composing.current) return
    ;(polish ? latest.current.onPolish : latest.current.onQuote)?.(value)
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
    {props.onPolish && <DropdownItem disabled={disabled || !selection?.text.trim()} icon={<Sparkles size={14} />} onClick={() => { quote(true); close() }}>润色选中文字</DropdownItem>}
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
    <div className="requirement-editor-rich my-scrollbar" hidden={mode !== 'rich'} onScroll={() => { if (editor && bubble.current?.isConnected) editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, 'updatePosition')) }} onMouseDown={event => {
      if (event.button === 0 && !disabled && canInteract() && !composing.current && (event.target === event.currentTarget || (event.target as Element).classList.contains('requirement-editor-page'))) {
        event.preventDefault(); editor?.commands.focus('end')
      }
    }}><EditorContent className="requirement-editor-page" editor={editor} /></div>
    {editor && mode === 'rich' && !disabled && <BubbleMenu ref={bubble} editor={editor} pluginKey={bubbleKey} updateDelay={180} appendTo={appendBubble} options={bubbleOptions} shouldShow={shouldShowBubble} className="requirement-editor-bubble my-menu" role="toolbar" aria-label="选中文字操作" onMouseDown={event => { if (event.button === 0) event.preventDefault() }}>
      <Dropdown disabled={disabled} trigger={({ toggle, open }) => <Button size="sm" variant="ghost" aria-label="段落样式" aria-haspopup="true" aria-expanded={open} onClick={toggle}>{toolbar.heading ? `标题 ${toolbar.heading}` : toolbar.bullet ? '无序列表' : toolbar.ordered ? '有序列表' : toolbar.task ? '待办列表' : toolbar.code ? '代码块' : '正文'}<ChevronDown size={12} /></Button>}>{formatItems}</Dropdown>
      <Button size="sm" variant="ghost" title="加粗" aria-label="加粗" aria-pressed={toolbar.bold} onClick={() => run(editor => { editor.chain().focus().toggleBold().run() })}><Bold size={14} /></Button>
      <Button size="sm" variant="ghost" title="斜体" aria-label="斜体" aria-pressed={toolbar.italic} onClick={() => run(editor => { editor.chain().focus().toggleItalic().run() })}><Italic size={14} /></Button>
      {(props.onQuote || props.onPolish) && <span className="requirement-editor-menu-divider" aria-hidden="true" />}
      {props.onQuote && <Button size="sm" variant="ghost" onClick={() => quote(false)}><Quote size={13} />引用</Button>}
      {props.onPolish && <Button size="sm" variant="ghost" onClick={() => quote(true)}><Sparkles size={13} />润色</Button>}
    </BubbleMenu>}
    <textarea ref={source} hidden={mode !== 'source'} className="requirement-editor-source my-scrollbar" value={raw} placeholder={props.placeholder ?? '开始记录需求…'} aria-label={`${props.ariaLabel ?? '需求文档正文'}源码`} aria-describedby={issue ? `${id}-issue` : undefined} readOnly={disabled} spellCheck={false} onChange={event => { if (disabled || !canInteract()) return; version.current++; publish(event.target.value); readSourceSelection() }} onSelect={readSourceSelection} onKeyUp={readSourceSelection} onPointerUp={readSourceSelection} />
  </div>
}

export default DocumentEditor
