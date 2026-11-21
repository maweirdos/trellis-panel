import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import { Code2, ExternalLink, Quote, Redo2, Sparkles, Undo2 } from 'lucide-react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import type { CruxTask } from '@shared/crux'
import { api } from '../../../api'
import { MarkdownView } from '../../../components/MarkdownView'
import { externalHttpUrl } from '../../../../../shared/external-url'
import { Button } from '../../../my/ui'
import { useInteractionActive, useInteractionGuard } from '../../../utils/interaction-scope'
import { useCrux } from '../../store'
import { useTaskDraftField, type TaskDraft } from './task-drafts'
import type { TaskMutation } from './use-task-source'
import {
  readTaskPostRich, taskPostBodyWithinLimit, taskPostDocumentBody, taskPostExtensions, taskPostMarkdownAnchor,
  taskPostPlainTextAnchor, taskPostPreservesContent
} from './TaskPostMarkdown'
import './TaskPostEditor.css'
import { TaskPostDocumentLinks } from './TaskPostDocumentLinks'
import { TaskPostSelectionToolbar } from './TaskPostSelectionToolbar'

interface TaskPostEditorProps {
  task: CruxTask
  draft: TaskDraft
  disabled: boolean
  mutate: TaskMutation
}

export interface TaskPostSelection {
  text: string
  from: number
  to: number
}

export interface TaskPostBodyProps extends TaskPostEditorProps {
  onQuote?(selection: TaskPostSelection): boolean | void
  onPolish?(selection: TaskPostSelection): boolean | void
  editorDecoration?: ReactNode
}

interface ToolbarState {
  selected: boolean
  undo: boolean
  redo: boolean
  empty: boolean
}

const emptyToolbar: ToolbarState = { selected: false, undo: false, redo: false, empty: true }
const TITLE_DRAFT_FIELDS = ['title', 'baseTitle']
const BODY_DRAFT_FIELDS = ['description', 'baseDescription']
const bodyLimitMessage = '任务正文不能超过 1 MiB；本次输入未写入。'
const titleMaxLength = 300

function taskIdentity(task: CruxTask): string {
  return JSON.stringify([task.spaceId, task.id, task.createdAt])
}

function currentTask(identity: string): CruxTask | undefined {
  return useCrux.getState().snapshot?.tasks.find(task => taskIdentity(task) === identity)
}

function failure(error: string): Promise<{ ok: false; error: string }> {
  return Promise.resolve({ ok: false as const, error })
}

function openEditorLink(event: MouseEvent): boolean {
  const anchor = event.target instanceof Element ? event.target.closest('a') : null
  if (!anchor || !(event.ctrlKey || event.metaKey)) return false
  const url = externalHttpUrl(anchor.getAttribute('href'))
  if (!url) return false
  event.preventDefault()
  void api.openExternal(url).catch(() => undefined)
  return true
}

function taskPostSessionKey(task: CruxTask, draft: TaskDraft): string {
  return JSON.stringify([draft.owner, draft.generation, task.spaceId, task.id, task.createdAt])
}

function updateToolbar(editor: Editor): ToolbarState {
  return {
    selected: !editor.state.selection.empty,
    undo: editor.can().undo(),
    redo: editor.can().redo(),
    empty: editor.isEmpty
  }
}

export function TaskPostTitle(props: TaskPostEditorProps): JSX.Element {
  return <TaskPostTitleSession
    key={taskPostSessionKey(props.task, props.draft)}
    task={props.task}
    draft={props.draft}
    disabled={props.disabled}
    mutate={props.mutate}
  />
}

export function TaskPostBody(props: TaskPostBodyProps): JSX.Element {
  return <TaskPostBodySession
    key={taskPostSessionKey(props.task, props.draft)}
    task={props.task}
    draft={props.draft}
    disabled={props.disabled}
    mutate={props.mutate}
    onQuote={props.onQuote}
    onPolish={props.onPolish}
    editorDecoration={props.editorDecoration}
  />
}

function TaskPostTitleSession({ task, draft, disabled, mutate }: TaskPostEditorProps): JSX.Element {
  const [title, setTitle] = useTaskDraftField(draft, 'title', task.title)
  const [baseTitle, setBaseTitle] = useTaskDraftField(draft, 'baseTitle', task.title)
  const [issue, setIssue] = useState('')
  const [saving, setSaving] = useState(false)
  const titleRef = useRef(title), baseRef = useRef(baseTitle)
  const submitting = useRef(false), composing = useRef(false), blurPending = useRef(false)
  const originIdentity = useRef(taskIdentity(task))
  const originTask = useRef(task)
  titleRef.current = title
  baseRef.current = baseTitle

  useEffect(() => {
    const server = currentTask(originIdentity.current)?.title ?? originTask.current.title
    if (titleRef.current === baseRef.current && titleRef.current !== server) {
      setTitle(server)
      setBaseTitle(server)
    }
  }, [originIdentity, setBaseTitle, setTitle, task.title])

  const change = (value: string): void => {
    setIssue('')
    setTitle(value)
  }

  const commit = async (): Promise<void> => {
    if (submitting.current || disabled || !title.trim()) {
      if (!title.trim()) setIssue('任务标题不能为空。')
      return
    }
    const next = titleRef.current.trim()
    if (next.length > titleMaxLength) {
      setIssue('任务标题不能超过 300 字符。')
      return
    }
    const serverTask = currentTask(originIdentity.current)
    if (!serverTask) return
    if (next === serverTask.title) {
      setBaseTitle(serverTask.title)
      draft.acknowledge(TITLE_DRAFT_FIELDS)()
      return
    }
    if (next === baseRef.current) return
    submitting.current = true
    setSaving(true)
    const acknowledge = draft.acknowledge(TITLE_DRAFT_FIELDS)
    try {
      const result = await mutate('保存任务标题', () => {
        const expected = currentTask(originIdentity.current)
        if (!expected || expected.title !== baseRef.current) return failure('标题已更新，请先核对当前标题。草稿已保留。')
        return api.crux.updateTask({ id: originTask.current.id, patch: { title: next, expectedTitle: baseRef.current } })
      })
      const saved = result?.data.tasks.find(item => taskIdentity(item) === originIdentity.current)
      if (saved?.title === next) {
        acknowledge()
      }
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }

  return <section className="task-post-title" aria-label="任务标题">
    <textarea
      className="task-post-title-input"
      value={title}
      disabled={disabled}
      aria-label="任务标题"
      placeholder="任务标题"
      aria-invalid={Boolean(issue)}
      rows={1}
      spellCheck={false}
      onChange={event => change(event.target.value)}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={() => {
        composing.current = false
        if (blurPending.current) {
          blurPending.current = false
          void commit()
        }
      }}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault()
          event.currentTarget.blur()
        }
      }}
      onBlur={event => {
        if (event.currentTarget.disabled || submitting.current) return
        if (composing.current) blurPending.current = true
        else void commit()
      }}
    />
    {saving && <p className="task-post-saving" role="status">保存中…</p>}
    {issue && <p className="task-post-issue" role="alert">{issue}</p>}
    {baseTitle !== task.title && <div className="task-post-conflict" role="alert">
      <span>标题已更新：{task.title}</span>
      <Button size="sm" disabled={disabled} onClick={() => setBaseTitle(task.title)}>保留草稿</Button>
    </div>}
  </section>
}

function TaskPostBodySession({ task, draft, disabled, mutate, onQuote, onPolish, editorDecoration }: TaskPostBodyProps): JSX.Element {
  const canInteract = useInteractionGuard()
  const interactionActive = useInteractionActive()
  const editable = !disabled && interactionActive
  const [body, setBodyField] = useTaskDraftField(draft, 'description', task.description ?? '')
  const [baseBody, setBaseBodyField] = useTaskDraftField(draft, 'baseDescription', task.description ?? '')
  const [initial] = useState(() => readTaskPostRich(body))
  const [sourceMode, setSourceMode] = useState(false)
  const [richIssue, setRichIssue] = useState(initial.issue ?? '')
  const [issue, setIssue] = useState('')
  const [saving, setSaving] = useState(false)
  const [toolbar, setToolbar] = useState(emptyToolbar)
  const editorId = useId()
  const host = useRef<HTMLDivElement>(null)
  const bodyRef = useRef(body), baseRef = useRef(baseBody), sourceField = useRef<HTMLTextAreaElement>(null)
  const original = useRef({ markdown: body, content: initial.content })
  const applying = useRef(false), ready = useRef(false), composing = useRef(false), blurPending = useRef(false), submitting = useRef(false)
  const identity = taskIdentity(task)
  const originIdentity = useRef(identity)
  const originTask = useRef(task)
  const latest = useRef({ disabled, onQuote, setBodyField, setBaseBodyField })
  latest.current = { disabled, onQuote, setBodyField, setBaseBodyField }
  bodyRef.current = body
  baseRef.current = baseBody

  useEffect(() => {
    if (sourceMode) sourceField.current?.focus({ preventScroll: true })
  }, [sourceMode])

  const [guard] = useState(() => Extension.create({ name: 'taskPostMarkdownGuard' }).extend({
    addProsemirrorPlugins() {
      return [new Plugin({
        filterTransaction(transaction) {
          if (!transaction.docChanged || applying.current || !ready.current) return true
          try {
            const text = taskPostDocumentBody(transaction.doc, original.current)
            if (!taskPostBodyWithinLimit(text)) {
              queueMicrotask(() => setIssue(bodyLimitMessage))
              return false
            }
            if (taskPostPreservesContent(transaction.doc, text)) return true
          } catch {
            queueMicrotask(() => setIssue('此格式暂不能完整保存，已保留原文。'))
            return false
          }
          queueMicrotask(() => setIssue('此格式暂不能完整保存，已保留原文。'))
          return false
        }
      })]
    }
  }))

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [...taskPostExtensions, guard],
    content: initial.content,
    editable,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { id: editorId, class: 'task-post-content', role: 'textbox', 'aria-label': '任务正文', 'aria-multiline': 'true', 'data-placeholder': '补充背景、目标和限制' },
      handleClick: (_view, _position, event) => {
        return openEditorLink(event)
      }
    },
    onCreate: ({ editor }) => {
      ready.current = true
      setToolbar(updateToolbar(editor))
    },
    onTransaction: ({ editor }) => setToolbar(updateToolbar(editor)),
    onUpdate: ({ editor }) => {
      if (!ready.current || applying.current || !editor.isInitialized || editor.isDestroyed) return
      const text = taskPostDocumentBody(editor.state.doc, original.current)
      if (!taskPostBodyWithinLimit(text)) {
        setIssue(bodyLimitMessage)
        return
      }
      try {
        if (!taskPostPreservesContent(editor.state.doc, text)) {
          setIssue('当前格式暂不能完整保存，已保留原文。')
          return
        }
      } catch {
        setIssue('当前格式暂不能完整保存，已保留原文。')
        return
      }
      setIssue('')
      latest.current.setBodyField(text)
    }
  }, [])

  useEffect(() => {
    if (editor) editor.setEditable(!disabled && interactionActive)
  }, [disabled, editor, interactionActive])

  useEffect(() => {
    const serverTask = currentTask(originIdentity.current)
    const server = serverTask?.description ?? originTask.current.description ?? ''
    if (bodyRef.current !== baseRef.current || server === baseRef.current) return
    const rich = readTaskPostRich(server)
    original.current = { markdown: server, content: rich.content }
    setRichIssue(rich.issue ?? '')
    applying.current = true
    try {
      editor?.commands.setContent(rich.content, { emitUpdate: false })
    } finally {
      applying.current = false
    }
    setBodyField(server)
    setBaseBodyField(server)
  }, [editor, identity, setBaseBodyField, setBodyField, task.description])

  const publish = (value: string): void => {
    latest.current.setBodyField(value)
  }

  const commit = async (): Promise<void> => {
    if (submitting.current || latest.current.disabled) return
    const next = bodyRef.current
    const serverTask = currentTask(originIdentity.current)
    if (!serverTask) return
    const server = serverTask.description ?? ''
    if (next === server) {
      setBaseBodyField(server)
      draft.acknowledge(BODY_DRAFT_FIELDS)()
      return
    }
    if (next === baseRef.current) return
    submitting.current = true
    setSaving(true)
    const acknowledge = draft.acknowledge(BODY_DRAFT_FIELDS)
    try {
      const result = await mutate('保存任务正文', () => {
        const expected = currentTask(originIdentity.current)
        if (!expected || (expected.description ?? '') !== baseRef.current) return failure('任务正文已更新，请先核对当前内容。草稿已保留。')
        return api.crux.updateTask({ id: originTask.current.id, patch: { description: next, expectedPostDescription: baseRef.current } })
      })
      const saved = result?.data.tasks.find(item => taskIdentity(item) === originIdentity.current)
      if (saved && (saved.description ?? '') === next) {
        original.current = { markdown: next, content: readTaskPostRich(next).content }
        acknowledge()
      }
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }

  const quoteSelection = (): void => {
    if (!editor || editor.isDestroyed || !editor.isInitialized) return
    const { from, to, empty } = editor.state.selection
    if (empty) return
    const text = editor.state.doc.textBetween(from, to, '\n')
    const anchor = taskPostMarkdownAnchor(bodyRef.current, { text, from, to }, editor.state.doc)
    if (!anchor) {
      setIssue('这段文字在原文中的位置不确定，请缩小选区后重试。')
      return
    }
    setIssue('')
    latest.current.onQuote?.({ text, from: anchor.from, to: anchor.to })
  }

  const quotePlainText = (): void => {
    const selection = window.getSelection()
    const text = selection?.toString() ?? ''
    const anchor = taskPostPlainTextAnchor(bodyRef.current, text)
    if (!selection || !selection.rangeCount || !anchor) {
      setIssue('这段文字在原文中的位置不确定，请缩小选区后重试。')
      return
    }
    setIssue('')
    latest.current.onQuote?.({ text, from: anchor.from, to: anchor.to })
  }

  const selectedText = (): TaskPostSelection | undefined => {
    if (sourceMode) {
      const field = sourceField.current
      if (!field || field.selectionStart === field.selectionEnd) return undefined
      const from = field.selectionStart, to = field.selectionEnd
      const text = bodyRef.current.slice(from, to)
      return text ? { text, from, to } : undefined
    }
    if (richIssue) {
      const selection = window.getSelection()
      const text = selection?.toString() ?? ''
      const anchor = taskPostPlainTextAnchor(bodyRef.current, text)
      return anchor ? { text, ...anchor } : undefined
    }
    if (!editor || editor.isDestroyed || !editor.isInitialized) return undefined
    const { from, to, empty } = editor.state.selection
    if (empty) return undefined
    const text = editor.state.doc.textBetween(from, to, '\n')
    const anchor = taskPostMarkdownAnchor(bodyRef.current, { text, from, to }, editor.state.doc)
    return anchor ? { text, ...anchor } : undefined
  }

  const polishSelection = (): void => {
    if (!onPolish || !editable || !canInteract() || composing.current) return
    const server = currentTask(originIdentity.current)?.description ?? originTask.current.description ?? ''
    if (bodyRef.current !== baseRef.current || baseRef.current !== server) {
      setIssue('请先保存或处理正文冲突，再润色选区。')
      return
    }
    const selection = selectedText()
    if (!selection) {
      setIssue('这段文字在原文中的位置不确定，请缩小选区后重试。')
      return
    }
    setIssue('')
    onPolish(selection)
  }

  const toggleSource = (): void => {
    if (!sourceMode) { setSourceMode(true); return }
    const rich = readTaskPostRich(bodyRef.current)
    original.current = { markdown: bodyRef.current, content: rich.content }
    setRichIssue(rich.issue ?? '')
    applying.current = true
    try { editor?.commands.setContent(rich.content, { emitUpdate: false }) }
    finally { applying.current = false }
    setSourceMode(false)
    void commit()
  }

  const run = (command: (editor: Editor) => void): void => {
    if (!editor || editor.isDestroyed || !editable || !canInteract() || composing.current) return
    command(editor)
  }

  return <section
    ref={host}
    className="task-post-body"
    aria-label="任务正文"
    data-empty={!disabled && toolbar.empty || undefined}
    data-disabled={disabled || !interactionActive || undefined}
    data-selecting={toolbar.selected && !sourceMode && !richIssue || undefined}
    onCompositionStart={() => { composing.current = true }}
    onCompositionEnd={() => {
      composing.current = false
      if (blurPending.current) {
        blurPending.current = false
        void commit()
      }
    }}
    onBlurCapture={event => {
      if (host.current?.contains(event.relatedTarget as Node | null)) return
      if (event.relatedTarget instanceof Element && event.relatedTarget.closest<HTMLElement>('[data-task-post-owner]')?.dataset.taskPostOwner === editorId) return
      if (latest.current.disabled || submitting.current) return
      if (composing.current) blurPending.current = true
      else void commit()
    }}
  >
    {sourceMode
      ? <textarea
        ref={sourceField}
        className="task-post-source my-scrollbar"
        value={body}
        disabled={!editable}
        aria-label="任务正文源码"
        spellCheck={false}
        onChange={event => publish(event.target.value)}

      />
      : richIssue
        ? <div className="task-post-readonly my-chat-prose" role="textbox" aria-label="任务正文" aria-readonly={!editable} tabIndex={editable ? 0 : -1}
          onClick={event => { if (editable && !window.getSelection()?.toString() && !(event.target as Element).closest('a,button')) setSourceMode(true) }}
          onKeyDown={event => { if (editable && event.target === event.currentTarget && ['Enter','F2'].includes(event.key)) { event.preventDefault(); setSourceMode(true) } }}><MarkdownView content={body} /></div>
        : <><EditorContent className="task-post-page" editor={editor} /><TaskPostDocumentLinks editor={editor} body={body} task={task} /></>}
    {editor && !sourceMode && !richIssue && editable && <TaskPostSelectionToolbar
      editor={editor} editable={editable} onQuote={onQuote && quoteSelection} onPolish={onPolish && polishSelection}
    />}
    <div className="task-post-tools" role="group" aria-label="正文操作">
      {!sourceMode && !richIssue && <>
        <Button size="sm" variant="ghost" disabled={!editable || !toolbar.undo} aria-label="撤销" onClick={() => run(item => item.chain().focus().undo().run())}><Undo2 size={14} /></Button>
        <Button size="sm" variant="ghost" disabled={!editable || !toolbar.redo} aria-label="重做" onClick={() => run(item => item.chain().focus().redo().run())}><Redo2 size={14} /></Button>
      </>}
      <Button size="sm" variant="ghost" disabled={!editable} aria-pressed={sourceMode} onClick={toggleSource}><Code2 size={14} />{sourceMode ? '预览' : '源码'}</Button>
      {(sourceMode || richIssue) && onPolish && <Button size="sm" variant="ghost" disabled={!editable} onMouseDown={event => event.preventDefault()} onClick={polishSelection}><Sparkles size={13} />润色</Button>}
      {!sourceMode && richIssue && onQuote && <Button size="sm" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={quotePlainText}><Quote size={13} />引用到对话</Button>}
      {!sourceMode && !richIssue && editor?.isActive('link') && <Button size="sm" variant="ghost" aria-label="打开链接" onClick={() => {
        const url = externalHttpUrl(editor.getAttributes('link').href)
        if (url) void api.openExternal(url).catch(() => undefined)
      }}><ExternalLink size={14} /></Button>}
    </div>
    {editorDecoration}
    {saving && <p className="task-post-saving" role="status">保存中…</p>}
    {(issue || sourceMode && richIssue) && <p className="task-post-issue" role={issue ? 'alert' : 'status'}>{issue || richIssue}</p>}
    {baseBody !== (task.description ?? '') && <div className="task-post-conflict" role="alert">
      <span>任务正文已更新。</span>
      <details>
        <summary>查看当前正文</summary>
        <div className="task-post-conflict-content my-chat-prose"><MarkdownView content={task.description ?? ''} /></div>
      </details>
      <Button size="sm" disabled={disabled} onClick={() => setBaseBodyField(task.description ?? '')}>保留草稿</Button>
    </div>}
  </section>
}
