import { useId, useLayoutEffect, useRef, type JSX, type KeyboardEvent } from 'react'
import { Code2, Globe, PanelRightClose, X } from 'lucide-react'
import type { AcpSessionRecord } from '../../../shared/types'
import { Button } from '../my/ui'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import type { PiWebPreviewShelf } from './PiWebPreviewShelf'
import { PiWebPreview } from './PiWebPreview'
import { CodePreviewPane } from './CodePreviewPane'
import './conversation-preview.css'

export interface ConversationPreviewTabsProps {
  shelf: PiWebPreviewShelf
  session: AcpSessionRecord
}

/** Keep this host mounted while collapsed; never key it to the active tab. */
export function ConversationPreviewTabs({ shelf, session }: ConversationPreviewTabsProps): JSX.Element {
  const id = useId()
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const { tabs, activeTabId } = shelf
  useLayoutEffect(() => {
    if (!activeTabId || shelf.collapsed || !canInteract()) return
    const tab = buttons.current.get(activeTabId)?.parentElement
    const list = tab?.parentElement
    if (!tab || !list) return
    const item = tab.getBoundingClientRect(), viewport = list.getBoundingClientRect()
    if (item.left < viewport.left) list.scrollLeft -= viewport.left - item.left
    else if (item.right > viewport.right) list.scrollLeft += item.right - viewport.right
  }, [activeTabId, shelf.collapsed, canInteract])
  const close = (tabId: string): void => {
    if (!canInteract()) return
    const index = tabs.findIndex(tab => tab.id === tabId)
    const current = buttons.current.get(tabId)?.parentElement
    const ownsFocus = current?.contains(document.activeElement)
    const remaining = tabs.filter(tab => tab.id !== tabId)
    const next = tabId === activeTabId ? remaining[Math.min(index, remaining.length - 1)] : remaining.find(tab => tab.id === activeTabId)
    if (ownsFocus) {
      if (next) buttons.current.get(next.id)?.focus({ preventScroll: true })
      else current?.closest('.acp-conversation-preview-layout')?.querySelector<HTMLElement>('.acp-conversation-preview-main')?.focus({ preventScroll: true })
    }
    shelf.closeTab(tabId)
  }
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || !canInteract()) return
    if (event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); close(tabs[index].id); return }
    const target = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
    if (target === null) return
    event.preventDefault(); event.stopPropagation()
    shelf.selectTab(tabs[target].id)
    buttons.current.get(tabs[target].id)?.focus({ preventScroll: true })
  }
  return <section className="acp-preview-tabs" aria-label="会话产物预览">
    <header className="acp-preview-tab-header">
      <div role="tablist" aria-label="产物标签页" className="acp-preview-tab-list my-scrollbar">
        {tabs.map((tab, index) => <div key={tab.id} role="presentation" className="acp-preview-tab" data-selected={tab.id === activeTabId} ref={element => {
          const button = element?.querySelector<HTMLButtonElement>('[role="tab"]')
          if (button) buttons.current.set(tab.id, button)
          else buttons.current.delete(tab.id)
        }}>
          <Button size="sm" variant="ghost" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`} aria-selected={tab.id === activeTabId} tabIndex={tab.id === activeTabId ? 0 : -1} disabled={!interactive} className="acp-preview-tab-select" title={tab.kind === 'file' ? tab.selection.artifact.path : tab.title} onKeyDown={event => navigate(event, index)} onClick={() => shelf.selectTab(tab.id)}>
            {tab.kind === 'file' ? <Globe size={14} aria-hidden="true" /> : <Code2 size={14} aria-hidden="true" />}<span>{tab.title}</span>
          </Button>
          <Button size="sm" variant="ghost" className="acp-preview-tab-close" aria-label={`关闭标签页：${tab.title}`} title={`关闭标签页：${tab.title}`} disabled={!interactive} tabIndex={tab.id === activeTabId ? 0 : -1} onClick={() => close(tab.id)}><X size={13} /></Button>
        </div>)}
      </div>
      <Button size="sm" variant="ghost" className="acp-preview-icon-button" aria-label="收起预览栏" title="收起预览栏" disabled={!interactive} onClick={() => shelf.setCollapsed(true)}><PanelRightClose size={16} /></Button>
    </header>
    {shelf.notice && <p className="acp-preview-notice" role="alert">{shelf.notice}</p>}
    <div className="acp-preview-tab-panels">
    {tabs.map((tab, index) => <div key={JSON.stringify([shelf.ownerKey, session.connectionGeneration, tab.id])} role="tabpanel" id={`${id}-panel-${index}`} aria-labelledby={`${id}-tab-${index}`} hidden={tab.id !== activeTabId} aria-hidden={tab.id !== activeTabId} {...{ inert: tab.id !== activeTabId ? '' : undefined }} className="acp-preview-tab-panel">
      {tab.kind === 'file'
        ? <PiWebPreview artifact={tab.selection.artifact} session={session} active={tab.id === activeTabId && !shelf.collapsed} expanded={shelf.expanded} onToggleExpanded={() => shelf.setExpanded(!shelf.expanded)} />
        : <CodePreviewPane source={tab.snippet.source} language={tab.snippet.language} error={tab.snippet.error} expanded={shelf.expanded} onToggleExpanded={() => shelf.setExpanded(!shelf.expanded)} />}
    </div>)}
    </div>
  </section>
}
