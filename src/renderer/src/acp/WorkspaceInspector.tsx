import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'
import { clsx } from 'clsx'
import { Button } from '../my/ui'
import { useEscLayer } from '../utils/use-esc-layer'
import { useInteractionActive } from '../utils/interaction-scope'

export type InspectorTab = 'agent' | 'task' | 'document'

/** One responsive host. Its reader child is never replaced to change presentation. */
export function WorkspaceInspector({ open, tab, onTab, onClose, expanded, hasDocument, children, returnFocusRef, backgroundRefs }: {
  open: boolean; tab: InspectorTab; onTab: (tab: InspectorTab) => void; onClose: () => void
  expanded: boolean; hasDocument: boolean; children: ReactNode
  returnFocusRef: RefObject<HTMLElement | null>; backgroundRefs: Array<RefObject<HTMLElement | null>>
}): JSX.Element {
  const panelRef = useRef<HTMLElement>(null)
  const interactive = useInteractionActive()
  const wasInteractive = useRef(interactive)
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1280)
  const overlay = interactive && open && (narrow || expanded)
  useEscLayer(open, { kind: 'preview', id: 'acp-workspace-inspector', onClose, returnFocusRef })
  useLayoutEffect(() => {
    if (panelRef.current) panelRef.current.inert = !open || !interactive
  }, [open, interactive])
  useEffect(() => {
    const resize = (): void => setNarrow(window.innerWidth < 1280)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useLayoutEffect(() => {
    for (const reference of backgroundRefs) if (reference.current) reference.current.inert = overlay
    return () => { for (const reference of backgroundRefs) if (reference.current) reference.current.inert = false }
  }, [overlay])
  useEffect(() => {
    const resumed = interactive && !wasInteractive.current
    wasInteractive.current = interactive
    if (!interactive || !open || !panelRef.current) return
    // The retained source owns return focus. Reactivation alone is not a new
    // inspector-open/tab action and must not override it (or an outside opener).
    if (resumed) return
    const target = [...panelRef.current.querySelectorAll<HTMLElement>('[data-inspector-focus],.acp-document h2[tabindex="-1"]')].find((element) => !element.closest('[hidden]') && element.getClientRects().length > 0)
    target?.focus()
  }, [open, tab, interactive])
  return <>
    {overlay && <button className="acp-inspector-scrim" aria-label="返回对话" onClick={onClose} />}
    <aside ref={panelRef} className={clsx('acp-inspector', open && 'is-open', expanded && 'is-expanded')} aria-label="Agent、任务与文档详情" aria-hidden={!open} onKeyDown={(event) => {
      if (!overlay || event.key !== 'Tab' || !panelRef.current) return
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')].filter((element) => element.getClientRects().length > 0 && !element.closest('[hidden],[inert]'))
      const first = focusable[0], last = focusable.at(-1)
      if (!first || !last) { event.preventDefault(); panelRef.current.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !panelRef.current.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !panelRef.current.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }}>
      <header className="acp-inspector-header"><nav aria-label="详情分类">{(['agent', 'task', 'document'] as const).map((value) => <button key={value} className={tab === value ? 'is-selected' : ''} disabled={value === 'document' && !hasDocument} onClick={() => onTab(value)}>{value === 'agent' ? 'Agent' : value === 'task' ? '任务' : '文档'}</button>)}</nav><Button variant="ghost" size="sm" title="关闭详情" onClick={onClose}><X size={15} /></Button></header>
      {children}
    </aside>
  </>
}
