import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type JSX, type KeyboardEvent } from 'react'
import { BubbleMenu } from '@tiptap/react/menus'
import { TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/core'
import { Bold, Check, ChevronDown, CodeXml, Italic, Link2, List, Quote, RemoveFormatting, Sparkles, SquareCode, Strikethrough, TextQuote, Underline, Unlink2, type LucideIcon } from 'lucide-react'
import { externalHttpUrl } from '@shared/external-url'
import { Button, DropdownItem } from '../../../my/ui'
import './TaskPostSelectionToolbar.css'

type Panel = 'style' | 'list' | 'link'
interface Props {
  editor: Editor
  editable: boolean
  onQuote?(): void
  onPolish?(): void
}

export function TaskPostSelectionToolbar({ editor, editable, onQuote, onPolish }: Props): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const linkField = useRef<HTMLInputElement>(null)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [href, setHref] = useState('')
  const [invalidLink, setInvalidLink] = useState(false)
  const panelId = useId()
  const pluginKey = `task-post-selection-${panelId}`
  const view = editor.view
  const options = useMemo(() => ({
    strategy: 'fixed' as const, placement: 'top' as const, offset: 6, shift: { padding: 8 }, flip: { padding: 8 },
    scrollTarget: view.dom.closest<HTMLElement>('.collab-task-detail-scroll') ?? window,
    onHide: () => setPanel(null)
  }), [view])
  const appendTo = useCallback(() => view.dom.closest<HTMLElement>('.my-root') ?? document.body, [view])
  const shouldShow = useCallback<NonNullable<ComponentProps<typeof BubbleMenu>['shouldShow']>>(({ view, state }) =>
    view.editable && !view.composing && state.selection instanceof TextSelection && !state.selection.empty &&
    (view.hasFocus() || Boolean(root.current?.contains(document.activeElement))), [])
  const canFormat = () => editable && editor.isEditable && !editor.isDestroyed && !view.composing && !editor.state.selection.empty
  useEffect(() => {
    const closePanel = () => setPanel(null)
    const keyboardEntry = (event: globalThis.KeyboardEvent) => {
      if (event.altKey && event.key === 'F10' && !editor.state.selection.empty) {
        event.preventDefault()
        editor.commands.setMeta(pluginKey, 'show')
        root.current?.querySelector<HTMLButtonElement>('button')?.focus()
      }
      if (event.key === 'Escape' && root.current?.isConnected) {
        editor.commands.setMeta(pluginKey, 'hide')
        event.stopPropagation()
      }
    }
    editor.on('selectionUpdate', closePanel)
    view.dom.addEventListener('keydown', keyboardEntry)
    return () => { editor.off('selectionUpdate', closePanel); view.dom.removeEventListener('keydown', keyboardEntry) }
  }, [editor, pluginKey, view])
  useEffect(() => {
    if (panel === 'link') { linkField.current?.focus(); linkField.current?.select() }
    else if (panel) root.current?.querySelector<HTMLButtonElement>('[role="menu"] button')?.focus()
  }, [panel])
  const togglePanel = (next: Panel) => {
    if (!canFormat()) return
    if (next === 'link') {
      setHref(editor.getAttributes('link').href ?? '')
      setInvalidLink(false)
    }
    setPanel(panel === next ? null : next)
  }
  const run = (command: () => void) => {
    if (!canFormat()) return
    setPanel(null)
    command()
  }
  const navigate = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      setPanel(null)
      editor.commands.focus(undefined, { scrollIntoView: false })
      if (!panel) editor.commands.setMeta(pluginKey, 'hide')
    } else if (event.target instanceof HTMLButtonElement) {
      const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      const index = choices.indexOf(event.target)
      const menu = event.currentTarget.getAttribute('role') === 'menu'
      const delta = event.key === (menu ? 'ArrowDown' : 'ArrowRight') ? 1 : event.key === (menu ? 'ArrowUp' : 'ArrowLeft') ? -1 : 0
      if (index >= 0 && delta) { event.preventDefault(); choices[(index + delta + choices.length) % choices.length].focus() }
    }
  }
  const action = (label: string, Icon: LucideIcon, click: () => void, pressed?: boolean) =>
    <Button size="sm" variant="ghost" className="task-post-selection-action" title={label} aria-label={label}
      aria-pressed={pressed} onClick={() => run(click)}><Icon size={16} /></Button>
  const chain = () => editor.chain().focus(undefined, { scrollIntoView: false })
  const labels = { style: '段落样式', list: '列表', link: '链接' }
  const trigger = (name: Panel, glyph: JSX.Element) =>
    <Button size="sm" variant="ghost" className={name === 'link' ? 'task-post-selection-action' : 'task-post-selection-styles'}
      title={labels[name]} aria-label={labels[name]} aria-expanded={panel === name} aria-controls={panel === name ? panelId : undefined}
      aria-haspopup={name === 'link' ? 'dialog' : 'menu'} onClick={() => togglePanel(name)}>
      {glyph}{name !== 'link' && <ChevronDown size={11} />}</Button>
  return <BubbleMenu editor={editor} ref={root} pluginKey={pluginKey} appendTo={appendTo} options={options} updateDelay={90}
    shouldShow={shouldShow}
    data-task-post-owner={view.dom.id} className="task-post-selection-toolbar" role="toolbar" aria-label="选中文字操作">
    <div className="task-post-selection-row" onKeyDown={navigate} onMouseDown={event => event.preventDefault()}>
      {trigger('style', <span className="task-post-selection-aa">Aa</span>)}
      {action('加粗', Bold, () => chain().toggleBold().run(), editor.isActive('bold'))}
      {action('斜体', Italic, () => chain().toggleItalic().run(), editor.isActive('italic'))}
      {action('删除线', Strikethrough, () => chain().toggleStrike().run(), editor.isActive('strike'))}
      {action('下划线', Underline, () => chain().toggleUnderline().run(), editor.isActive('underline'))}
      {trigger('link', <Link2 size={16} />)}
      {action('引用段落', Quote, () => chain().toggleBlockquote().run(), editor.isActive('blockquote'))}
      {action('清除格式', RemoveFormatting, () => chain().unsetAllMarks().clearNodes().run())}
      {action('行内代码', CodeXml, () => chain().toggleCode().run(), editor.isActive('code'))}
      {action('代码块', SquareCode, () => chain().toggleCodeBlock().run(), editor.isActive('codeBlock'))}
      {trigger('list', <List size={16} />)}
      {(onPolish || onQuote) && <span aria-hidden="true" className="task-post-selection-divider" />}
      {onPolish && action('润色', Sparkles, onPolish)}
      {onQuote && action('引用到对话', TextQuote, onQuote)}
    </div>
    {panel === 'link' ? <form id={panelId} role="dialog" aria-label="编辑链接" data-panel="link" className="task-post-selection-panel"
      onKeyDown={navigate} onSubmit={event => {
        event.preventDefault()
        const url = externalHttpUrl(href.trim())
        if (!url) { setInvalidLink(true); linkField.current?.focus(); return }
        run(() => chain().setLink({ href: url }).run())
      }}>
      <input className="my-input task-post-selection-link-field" ref={linkField} aria-label="链接地址" aria-invalid={invalidLink}
        placeholder="https://…" value={href} onChange={event => { setHref(event.target.value); setInvalidLink(false) }} />
      <Button size="sm" variant="ghost" type="submit" aria-label="应用链接" title="应用链接"><Check size={16} /></Button>
      {editor.isActive('link') && action('移除链接', Unlink2, () => chain().unsetLink().run())}
      {invalidLink && <span role="alert" className="task-post-issue">请输入完整的 HTTP 或 HTTPS 地址</span>}
    </form> : panel && <div id={panelId} role="menu" aria-label={labels[panel]} data-panel="menu" data-list={panel === 'list' || undefined}
      className="task-post-selection-panel" onKeyDown={navigate} onMouseDown={event => event.preventDefault()}>
      {panel === 'style' ? <>
        <DropdownItem selected={editor.isActive('paragraph')} onClick={() => run(() => chain().setParagraph().run())}>正文</DropdownItem>
        {([1, 2, 3] as const).map(level => <DropdownItem key={level} selected={editor.isActive('heading', { level })}
          onClick={() => run(() => chain().setHeading({ level }).run())}>标题 {level}</DropdownItem>)}
      </> : <>
        <DropdownItem selected={editor.isActive('bulletList')} onClick={() => run(() => chain().toggleBulletList().run())}>无序列表</DropdownItem>
        <DropdownItem selected={editor.isActive('orderedList')} onClick={() => run(() => chain().toggleOrderedList().run())}>有序列表</DropdownItem>
        <DropdownItem selected={editor.isActive('taskList')} onClick={() => run(() => chain().toggleTaskList().run())}>待办列表</DropdownItem>
      </>}
    </div>}
  </BubbleMenu>
}
