import { useId, useLayoutEffect, useRef, useSyncExternalStore, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import { FileCode, FolderOpen, GitCompare, ListTree, MessageSquare, PanelRightClose, Play, Plus, Terminal, X } from 'lucide-react'
import { Dropdown, DropdownItem, Modal } from '../my/ui'
import type { ConversationRightPanelSurface, useConversationRightPanel } from './conversationRightPanelStore'
import './conversation-right-panel.css'

const narrowWindow = '(max-width: 1100px)'

function subscribeWidth(notify: () => void): () => void {
  const query = window.matchMedia(narrowWindow)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}

const surfaceTypes = {
  project: { label: '工程', icon: FolderOpen },
  files: { label: '文件', icon: ListTree },
  file: { label: '文件', icon: FileCode },
  diff: { label: '分支比较', icon: GitCompare },
  changes: { label: '改动', icon: GitCompare },
  scripts: { label: '脚本', icon: Play },
  terminal: { label: '终端', icon: Terminal },
  thread: { label: '子会话', icon: MessageSquare },
}

type Panel = ReturnType<typeof useConversationRightPanel>

export function useNarrowConversationPanel(): boolean {
  return useSyncExternalStore(subscribeWidth, () => window.matchMedia(narrowWindow).matches, () => false)
}

export function ConversationRightPanel({ panel, projectAvailable, onHide, onCloseTab, threadTitle, children }: {
  panel: Panel
  projectAvailable: boolean
  onHide(): void
  onCloseTab?(surface: ConversationRightPanelSurface): void
  threadTitle(threadId: string): string | undefined
  children(surface: ConversationRightPanelSurface, selected: boolean): ReactNode
}): JSX.Element | null {
  const narrow = useNarrowConversationPanel()
  const id = useId()
  const tabs = useRef(new Map<string, HTMLButtonElement>())
  const focusTabs = useRef(true)
  const movingTab = useRef<string>()
  const body = useRef<HTMLDivElement>(null)
  const positions = useRef(new Map<string, number>())
  const { state, active } = panel

  useLayoutEffect(() => {
    if (!active) return
    const tab = tabs.current.get(active.id)
    if (focusTabs.current) {
      if (tab) {
        tab.focus({ preventScroll: true })
        focusTabs.current = false
      } else {
        const frame = requestAnimationFrame(() => {
          tabs.current.get(active.id)?.focus({ preventScroll: true })
          focusTabs.current = false
        })
        return () => cancelAnimationFrame(frame)
      }
    }
    tab?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [active, narrow, state.surfaces])

  useLayoutEffect(() => {
    if (!active) return
    const saved = positions.current.get(active.id)
    const destination = body.current
    if (destination && saved !== undefined) destination.scrollTop = saved
  }, [active, narrow])

  if (!active) return null

  const tabId = (surface: ConversationRightPanelSurface): string => `${id}-${encodeURIComponent(surface.id)}`
  const activate = (surfaceId: string): void => {
    if (surfaceId === active.id) {
      tabs.current.get(surfaceId)?.focus({ preventScroll: true })
      return
    }
    focusTabs.current = true
    panel.activate(surfaceId)
  }
  const close = (surface: ConversationRightPanelSurface): void => {
    if (state.surfaces.length === 1) onHide()
    else if (surface.id === active.id) focusTabs.current = true
    panel.close(surface.id)
    positions.current.delete(surface.id)
    onCloseTab?.(surface)
  }
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, surface: ConversationRightPanelSurface, index: number): void => {
    const last = state.surfaces.length - 1
    const next = event.key === 'ArrowRight' ? (index + 1) % (last + 1)
      : event.key === 'ArrowLeft' ? (index + last) % (last + 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? last : null
    if (event.key === 'Delete') {
      event.preventDefault()
      close(surface)
    } else if (next !== null) {
      event.preventDefault()
      if (event.altKey && event.shiftKey && next !== index) {
        focusTabs.current = true
        panel.move(surface.id, next)
      } else if (!event.altKey && next !== index) activate(state.surfaces[next].id)
    }
  }

  const content = <div className="conversation-right-surface">
    <div className="conversation-right-toolbar">
      <div className="conversation-right-tabs my-scrollbar" role="tablist" aria-label="工作台标签">
        {state.surfaces.map((surface, index) => {
          const { label, icon: Icon } = surfaceTypes[surface.kind]
          const title = surface.kind === 'file' ? surface.path : surface.kind === 'thread' ? threadTitle(surface.threadId) ?? label : label
          const selected = surface.id === active.id
          return <div key={surface.id} role="presentation" className="conversation-right-tab" data-selected={selected} draggable
            onDragStart={event => {
              movingTab.current = surface.id
              event.dataTransfer.setData('application/x-crux-workbench-tab', surface.id)
              event.dataTransfer.effectAllowed = 'move'
            }}
            onDragEnd={() => { movingTab.current = undefined }}
            onDragOver={event => { if (movingTab.current) event.preventDefault() }}
            onDrop={event => {
              if (!movingTab.current) return
              event.preventDefault()
              panel.move(movingTab.current, index)
              movingTab.current = undefined
            }}>
            <button type="button" role="tab" id={tabId(surface)} title={title} aria-selected={selected}
              aria-controls={`${tabId(surface)}-body`} tabIndex={selected ? 0 : -1}
              ref={button => { if (button) tabs.current.set(surface.id, button); else tabs.current.delete(surface.id) }}
              onClick={() => panel.activate(surface.id)} onKeyDown={event => onKey(event, surface, index)}>
              <Icon size={14} aria-hidden="true" /><span>{title}</span>
            </button>
            <button type="button" className="my-icon-control conversation-right-tab-close" tabIndex={selected ? 0 : -1}
              aria-label={`关闭标签：${title}`} onClick={() => close(surface)}><X size={13} aria-hidden="true" /></button>
          </div>
        })}
      </div>
      {projectAvailable && <Dropdown trigger={({ open, toggle }) => <button type="button" className="my-icon-control"
        aria-label="打开工作台标签" aria-expanded={open} onClick={toggle}><Plus size={16} aria-hidden="true" /></button>}>
        {dismiss => (['project', 'files', 'changes', 'diff', 'scripts', 'terminal'] as const).map(kind =>
          <DropdownItem key={kind} onClick={() => {
            dismiss()
            if (active.id === kind) activate(kind)
            else { focusTabs.current = true; panel.open({ id: kind, kind }) }
          }}>{surfaceTypes[kind].label}</DropdownItem>)}
      </Dropdown>}
      <button type="button" className="my-icon-control" title="收起工作台" aria-label="收起工作台" onClick={onHide}>
        <PanelRightClose size={16} aria-hidden="true" />
      </button>
    </div>
    {state.surfaces.map(surface => {
      const selected = surface.id === active.id
      return <div key={surface.id} ref={selected ? body : undefined} id={`${tabId(surface)}-body`}
        role="tabpanel" aria-labelledby={tabId(surface)} data-surface-kind={surface.kind} hidden={!selected}
        onScroll={event => { if (selected) positions.current.set(surface.id, event.currentTarget.scrollTop) }}
        className="conversation-right-body my-scrollbar" tabIndex={selected ? 0 : -1}>{children(surface, selected)}</div>
    })}
  </div>

  return narrow ? <Modal open onClose={onHide} ariaLabel="会话工作台" placement="center" width="min(100%, var(--my-inspector-width-wide))">
    {content}
  </Modal> : <aside className="conversation-right-panel" aria-label="会话工作台">{content}</aside>
}
