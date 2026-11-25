import { Extension, Node, type Editor, type JSONContent } from '@tiptap/core'
import { closeHistory, isHistoryTransaction } from '@tiptap/pm/history'
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, TextSelection, type Transaction } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { FileText } from 'lucide-react'
import { createContext, useContext, useImperativeHandle, useLayoutEffect, useRef, type ClipboardEventHandler, type RefObject } from 'react'
import type { ConversationDriverSkill } from '../../../shared/conversation/driverCatalog'
import type { AssistantCitation } from '../../../shared/conversation/assistantCitations'
import { collectAssistantCitations, serializeAssistantCitation, withAssistantCitationComment } from '../../../shared/conversation/assistantCitationText'
import { AssistantCitationChip, type OpenAssistantCitation } from './AssistantCitationChip'
import { ChatProjectFileLinks, resolveChatProjectFile } from './chatProjectFileLinks'
import { formatProviderSkillDisplayName } from './inlineSkills'
import './composer-prompt-editor.css'

const COMPOSER_UNDO_GROUP_DELAY = 1000
const CLIPBOARD_EDIT_META = 'composerClipboardEdit'

export interface ComposerPromptSelection {
  readonly start: number
  readonly end: number
}

export interface ComposerPromptSnapshot {
  readonly value: string
  readonly selection: ComposerPromptSelection
}

export interface ComposerPromptEditorHandle {
  readonly element: HTMLElement
  focus: () => void
  readSnapshot: () => ComposerPromptSnapshot
  setSelectionRange: (start: number, end: number) => void
}

interface ComposerPromptEditorProps {
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>
  readonly anchorRef: RefObject<HTMLDivElement>
  readonly draftKey: string
  readonly value: string
  readonly skills: readonly ConversationDriverSkill[]
  readonly disabled: boolean
  readonly placeholder: string
  readonly describedBy?: string
  readonly invalid?: boolean
  readonly suggestionListId?: string
  readonly activeSuggestionId?: string
  readonly onOpenCitation?: OpenAssistantCitation
  readonly onChange: (snapshot: ComposerPromptSnapshot, textChanged: boolean) => void
  readonly onFocus: (snapshot: ComposerPromptSnapshot) => void
  readonly onBlur: () => void
  readonly onCommandKeyDown: (event: KeyboardEvent) => void
  readonly onPaste: ClipboardEventHandler<HTMLDivElement>
}

type ComposerChangeKind = 'insert' | 'delete' | 'other'

function changeKindOf(transaction: Transaction): ComposerChangeKind | null {
  if (!transaction.docChanged) return null
  const uiEvent = transaction.getMeta('uiEvent')
  if (uiEvent === 'paste' || uiEvent === 'drop' || uiEvent === 'cut' || transaction.getMeta(CLIPBOARD_EDIT_META)) return 'other'
  if (transaction.getMeta('composition') != null) return 'insert'
  let kind: ComposerChangeKind | null = null
  for (const step of transaction.steps) {
    if (!(step instanceof ReplaceStep)) return 'other'
    const inserts = step.slice.size > 0
    const deletes = step.to > step.from
    const stepKind = inserts && !deletes ? 'insert' : deletes && !inserts ? 'delete' : 'other'
    if (kind !== null && kind !== stepKind) return 'other'
    kind = stepKind
  }
  return kind
}

const ComposerUndoGroupingExtension = Extension.create({
  name: 'composerUndoGrouping',
  addProseMirrorPlugins() {
    let previous: ComposerChangeKind | null = null
    return [new Plugin({
      filterTransaction(transaction) {
        if (transaction.getMeta('addToHistory') === false) return true
        if (isHistoryTransaction(transaction)) previous = 'other'
        else {
          const kind = changeKindOf(transaction)
          if (kind !== null) {
            if (previous !== null && (kind !== previous || kind === 'other')) closeHistory(transaction)
            previous = kind
          }
        }
        return true
      },
    })]
  },
})

const ComposerSkillExtension = Node.create({
  name: 'composer-skill',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { source: { default: '' }, label: { default: '' } }
  },
  renderHTML({ node }) {
    return ['span', {
      'data-slot': 'context-chip',
      'data-kind': 'skill',
      contenteditable: 'false',
      title: node.attrs.source,
    }, ['span', { 'data-slot': 'context-chip-label' }, node.attrs.label]]
  },
  renderText({ node }) {
    return node.attrs.source
  },
})

const CitationSourceContext = createContext<OpenAssistantCitation | undefined>(undefined)

function ComposerCitationNodeView({ node, updateAttributes }: NodeViewProps) {
  const onOpenSource = useContext(CitationSourceContext)
  const citation = node.attrs.citation as AssistantCitation
  return (
    <NodeViewWrapper as="span" className="conversation-citation-node" contentEditable={false}
      data-slot="context-chip" data-kind="citation">
      <AssistantCitationChip citation={citation} onOpenSource={onOpenSource} onSave={comment => {
        const updated = withAssistantCitationComment(citation, comment)
        updateAttributes({ citation: updated, source: serializeAssistantCitation(updated) })
      }} />
    </NodeViewWrapper>
  )
}

const ComposerCitationExtension = Node.create({
  name: 'composer-citation',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { source: { default: '' }, citation: { default: null } }
  },
  renderHTML({ node }) {
    return ['span', { contenteditable: 'false' }, node.attrs.source]
  },
  renderText({ node }) {
    return node.attrs.source
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerCitationNodeView, {
      stopEvent: ({ event }) => event.target instanceof Element && event.target.closest('button') !== null,
    })
  },
})

function ComposerFileNodeView({ node }: NodeViewProps) {
  const links = useContext(ChatProjectFileLinks)
  const file = links && resolveChatProjectFile(node.attrs.href, links.root)
  const label = <><FileText size={14} aria-hidden="true" /><span data-slot="context-chip-label">{node.attrs.label}</span></>
  return <NodeViewWrapper as="span" contentEditable={false} data-slot="context-chip" data-kind="file">
    {links && file ? <button className="conversation-composer-file-chip" type="button" title={file.path}
      onMouseDown={event => event.preventDefault()} onClick={() => links.open(file)}>{label}</button>
      : <span className="conversation-composer-file-chip">{label}</span>}
  </NodeViewWrapper>
}

const ComposerFileExtension = Node.create({
  name: 'composer-file',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { source: { default: '' }, href: { default: '' }, label: { default: '' } }
  },
  renderHTML({ node }) { return ['span', { contenteditable: 'false' }, node.attrs.source] },
  renderText({ node }) { return node.attrs.source },
  addNodeView() { return ReactNodeViewRenderer(ComposerFileNodeView) },
})

const PLAIN_TEXT_EXTENSIONS = [
  StarterKit.configure({
    blockquote: false,
    bulletList: false,
    codeBlock: false,
    heading: false,
    horizontalRule: false,
    listItem: false,
    link: false,
    orderedList: false,
    underline: false,
    dropcursor: false,
    gapcursor: false,
    trailingNode: false,
    code: false,
    listKeymap: false,
    undoRedo: { newGroupDelay: COMPOSER_UNDO_GROUP_DELAY },
    italic: false,
    bold: false,
    strike: false,
  }),
  ComposerUndoGroupingExtension,
  ComposerSkillExtension,
  ComposerCitationExtension,
  ComposerFileExtension,
]

function buildDocJson(value: string, skills: readonly ConversationDriverSkill[]): JSONContent {
  const labels = new Map(skills.map(skill => [skill.name, formatProviderSkillDisplayName(skill)]))
  return { type: 'doc', content: value.split('\n').map(line => {
    const content: JSONContent[] = []
    const pushText = (text: string) => { if (text) content.push({ type: 'text', text }) }
    const pushTextAndFiles = (text: string): void => {
      let offset = 0
      for (const match of text.matchAll(/\[((?:\\.|[^\]\\]){1,512})\]\((\.\/[^)\s]+)\)/gu)) {
        try {
          const label = match[1].replace(/\\(.)/gu, '$1')
          const href = match[2]
          if (decodeURIComponent(href).split('/').at(-1) !== label) continue
          pushText(text.slice(offset, match.index))
          content.push({ type: 'composer-file', attrs: { source: match[0], href, label } })
          offset = match.index + match[0].length
        } catch { continue }
      }
      pushText(text.slice(offset))
    }
    const pushTextAndSkills = (text: string): void => {
      let offset = 0
      for (const match of text.matchAll(/(?<!\S)\$([a-zA-Z0-9][a-zA-Z0-9:_-]{0,127})(?=\s|$)/gu)) {
        const label = labels.get(match[1])
        if (!label) continue
        pushTextAndFiles(text.slice(offset, match.index))
        content.push({ type: 'composer-skill', attrs: { source: match[0], label } })
        offset = match.index + match[0].length
      }
      pushTextAndFiles(text.slice(offset))
    }
    let offset = 0
    for (const match of collectAssistantCitations(line)) {
      pushTextAndSkills(line.slice(offset, match.start))
      content.push({ type: 'composer-citation', attrs: { source: match.source, citation: match.citation } })
      offset = match.end
    }
    pushTextAndSkills(line.slice(offset))
    return { type: 'paragraph', content }
  }) }
}

interface ComposerDocRun {
  readonly pmStart: number
  readonly pmEnd: number
  readonly source: string
}

function serializeEditorDoc(doc: ProseMirrorNode) {
  const runs: ComposerDocRun[] = []
  doc.forEach((paragraph, blockOffset, index) => {
    if (index !== 0) runs.push({ pmStart: blockOffset - 1, pmEnd: blockOffset + 1, source: '\n' })
    paragraph.forEach((node, childOffset) => {
      const pmStart = blockOffset + 1 + childOffset
      const source = node.isText ? node.text ?? '' : node.type.name === 'hardBreak' ? '\n' : node.attrs.source
      if (typeof source === 'string' && source) runs.push({ pmStart, pmEnd: pmStart + node.nodeSize, source })
    })
  })
  return { value: runs.map(run => run.source).join(''), runs }
}

function pmToSource(runs: readonly ComposerDocRun[], position: number): number {
  let offset = 0
  for (const { pmStart, pmEnd, source } of runs) {
    if (position <= pmStart) return offset
    if (position < pmEnd) return offset + Math.min(position - pmStart, source.length)
    offset += source.length
  }
  return offset
}

function sourceToPm(runs: readonly ComposerDocRun[], position: number): number {
  let offset = 0
  for (const { pmStart, pmEnd, source } of runs) {
    if (position <= offset) return pmStart
    if (position < offset + source.length) return Math.min(pmStart + position - offset, pmEnd)
    offset += source.length
  }
  return runs.at(-1)?.pmEnd ?? 1
}

function readSnapshot(editor: Editor): ComposerPromptSnapshot {
  const { value, runs } = serializeEditorDoc(editor.state.doc)
  const { from, to } = editor.state.selection
  return { value, selection: { start: pmToSource(runs, from), end: pmToSource(runs, to) } }
}

export function ComposerPromptEditorTiptap(props: ComposerPromptEditorProps) {
  const latest = useRef(props)
  latest.current = props
  const applying = useRef(false)
  const owner = useRef(props.draftKey)
  const pendingSelection = useRef<{ owner: string; value: string; start: number; end: number }>()
  const editorAttributes: Record<string, string> = {
    class: 'composer-tiptap my-scrollbar',
    'data-testid': 'composer-editor',
    'aria-label': '消息',
    'aria-multiline': 'true',
    'aria-readonly': String(props.disabled),
    role: 'textbox',
  }
  if (props.describedBy) editorAttributes['aria-describedby'] = props.describedBy
  if (props.invalid) editorAttributes['aria-invalid'] = 'true'
  if (props.suggestionListId) Object.assign(editorAttributes, {
    'aria-autocomplete': 'list', 'aria-controls': props.suggestionListId,
    ...(props.activeSuggestionId ? { 'aria-activedescendant': props.activeSuggestionId } : {}),
  })

  const editor = useEditor({
    extensions: PLAIN_TEXT_EXTENSIONS,
    content: buildDocJson(props.value, props.skills),
    editable: !props.disabled,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: editorAttributes,
      handleKeyDown(view, event) {
        if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229 || view.composing)) {
          event.stopPropagation()
          return true
        }
        latest.current.onCommandKeyDown(event)
        if (event.defaultPrevented || view.composing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
          return event.defaultPrevented
        }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false
        const { selection } = view.state
        const direction = event.key === 'ArrowLeft' ? -1 : 1
        const adjacent = direction === -1 ? selection.$from.nodeBefore : selection.$from.nodeAfter
        if (!selection.empty || !adjacent?.type.name.startsWith('composer-')) return false
        event.preventDefault()
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, selection.from + direction)))
        return true
      },
      handlePaste(view, event) {
        const content = event.clipboardData?.getData('text/plain')
        if (content === undefined) return false
        event.preventDefault()
        if (content) {
          const { schema } = view.state
          const paragraphs = buildDocJson(content.replace(/\r\n?/gu, '\n'), latest.current.skills).content ?? []
          const slice = new Slice(Fragment.fromArray(paragraphs.map(paragraph => schema.nodeFromJSON(paragraph))), 1, 1)
          view.dispatch(view.state.tr.replaceSelection(slice).setMeta(CLIPBOARD_EDIT_META, 'paste').scrollIntoView())
        }
        return true
      },
      clipboardTextSerializer(_slice, view) {
        const { value, runs } = serializeEditorDoc(view.state.doc)
        return value.slice(pmToSource(runs, view.state.selection.from), pmToSource(runs, view.state.selection.to))
      },
    },
    onUpdate: ({ editor: updated }) => {
      if (!applying.current) latest.current.onChange(readSnapshot(updated), true)
    },
    onSelectionUpdate: ({ editor: updated, transaction }) => {
      if (!applying.current && !transaction.docChanged) latest.current.onChange(readSnapshot(updated), false)
    },
    onFocus: ({ editor: focused }) => latest.current.onFocus(readSnapshot(focused)),
    onBlur: () => latest.current.onBlur(),
  }, [props.draftKey])

  useLayoutEffect(() => {
    if (!editor || !editor.isInitialized) return
    editor.view.setProps({ attributes: editorAttributes })
  })

  useLayoutEffect(() => {
    if (editor && editor.isEditable === props.disabled) editor.setEditable(!props.disabled, false)
  }, [editor, props.disabled])

  useLayoutEffect(() => {
    if (!editor) return
    let current = true
    queueMicrotask(() => {
      if (!current || editor.isDestroyed) return
      const ownerChanged = owner.current !== props.draftKey
      owner.current = props.draftKey
      const pending = pendingSelection.current
      pendingSelection.current = undefined
      const preferred = pending?.owner === props.draftKey && pending.value === props.value ? pending : undefined
      const snapshot = readSnapshot(editor)
      if (!ownerChanged && snapshot.value === props.value && !preferred) return
      applying.current = true
      try {
        const transaction = editor.state.tr
        if (snapshot.value !== props.value) {
          const next = editor.state.schema.nodeFromJSON(buildDocJson(props.value, props.skills))
          transaction.replaceWith(0, editor.state.doc.content.size, next.content)
        }
        const runs = serializeEditorDoc(transaction.doc).runs
        const target = ownerChanged ? props.value.length : Math.min(snapshot.selection.start, props.value.length)
        transaction.setSelection(TextSelection.create(
          transaction.doc, sourceToPm(runs, preferred?.start ?? target), sourceToPm(runs, preferred?.end ?? target),
        ))
        const history = transaction.docChanged && !ownerChanged && Boolean(props.value)
        editor.view.dispatch(closeHistory(transaction.setMeta('addToHistory', history)))
      } finally {
        applying.current = false
      }
    })
    return () => { current = false }
  }, [editor, props.draftKey, props.skills, props.value])

  useImperativeHandle(props.editorRef, () => editor ? {
    get element() { return editor.view.dom },
    focus: () => editor.view.dom.focus({ preventScroll: true }),
    readSnapshot: () => readSnapshot(editor),
    setSelectionRange(start, end) {
      const { state, view } = editor
      const { value, runs } = serializeEditorDoc(state.doc)
      if (latest.current.value !== value) {
        pendingSelection.current = { owner: latest.current.draftKey, value: latest.current.value, start, end }
        return
      }
      const selection = TextSelection.create(state.doc, sourceToPm(runs, start), sourceToPm(runs, end))
      if (!selection.eq(state.selection)) view.dispatch(state.tr.setSelection(selection))
    },
  } : null, [editor])

  return (
    <CitationSourceContext.Provider value={props.onOpenCitation}>
      <div ref={props.anchorRef} className="conversation-composer-prompt">
        <EditorContent editor={editor} className="conversation-composer-editor" onPasteCapture={props.onPaste} />
        {!props.value && <div className="conversation-composer-placeholder" aria-hidden="true">{props.placeholder}</div>}
      </div>
    </CitationSourceContext.Provider>
  )
}
