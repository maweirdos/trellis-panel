import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { Bot, ChevronDown, History, MessageSquare, Plus, Search, X } from 'lucide-react'
import { clsx } from 'clsx'
import { Button } from '../my/ui'
import { SidebarResizeHandle } from '../my/layout/SidebarResizeHandle'
import { useEscLayer } from '../utils/use-esc-layer'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { conversationSummary, isDiagnosticConversation } from './conversation-selection'
import type { AcpSessionRecord } from '../../../shared/types'
import type { WorkspaceView } from './view-state'

interface HoverPreview { session: AcpSessionRecord; left: number; top: number; host: Element }

export function ConversationNavigation({ sessions, activeId, view, onView, onSelect, onNew, open, onClose, collapsed = false }: {
  sessions: AcpSessionRecord[]; activeId: string | null; view: WorkspaceView
  onView: (view: WorkspaceView) => void; onSelect: (sessionId: string) => void; onNew: () => void
  open: boolean; onClose: () => void
  collapsed?: boolean
}): JSX.Element {
  const [query, setQuery] = useState('')
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [preview, setPreview] = useState<HoverPreview | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hovered = useRef<string | null>(null)
  const tooltipId = useId()
  const dismiss = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null; hovered.current = null; setPreview(null)
  }
  useEscLayer(preview !== null && (!collapsed || open), { kind: 'modal', id: `acp-hover-${tooltipId}`, onClose: dismiss })
  useEffect(() => {
    window.addEventListener('scroll', dismiss, true); window.addEventListener('resize', dismiss)
    return () => { if (timer.current) clearTimeout(timer.current); window.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss) }
  }, [])
  useEffect(dismiss, [activeId, view, open, interactive, collapsed])
  const schedule = (session: AcpSessionRecord, element: HTMLButtonElement): void => {
    if (!canInteract() || (collapsed && !open)) return
    dismiss(); hovered.current = session.sessionId
    const rect = element.getBoundingClientRect(), host = element.closest('.my-root') ?? document.body
    timer.current = setTimeout(() => {
      if (!canInteract() || (collapsed && !open) || hovered.current !== session.sessionId || !element.isConnected) return
      const width = 260, height = 110, gap = 10
      const left = rect.right + gap + width <= window.innerWidth - gap ? rect.right + gap : Math.max(gap, rect.left - width - gap)
      setPreview({ session, left, top: Math.max(gap, Math.min(rect.top - 4, window.innerHeight - height - gap)), host })
    }, 350)
  }
  const filtered = sessions.filter((session) => `${session.title ?? ''} ${session.profileSnapshot?.name ?? session.agentName} ${session.taskDir ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  const recent = filtered.filter((session) => !isDiagnosticConversation(session) && session.historyKind !== 'legacy')
  const old = filtered.filter((session) => !recent.includes(session))
  const row = (session: AcpSessionRecord): JSX.Element => <button key={session.sessionId} data-acp-session={session.sessionId} className={clsx('acp-recent-row', activeId === session.sessionId && view === 'conversation' && 'is-selected')} aria-describedby={preview?.session.sessionId === session.sessionId ? tooltipId : undefined} onMouseEnter={(event) => schedule(session, event.currentTarget)} onMouseLeave={dismiss} onFocus={(event) => schedule(session, event.currentTarget)} onBlur={dismiss} onClick={() => { dismiss(); onSelect(session.sessionId) }}>
    <MessageSquare size={14} /><span>{session.title ?? session.profileSnapshot?.name ?? `${session.agentName} 会话`}</span>
  </button>
  return <>
    {open && <button className="acp-sidebar-scrim" aria-label="关闭会话导航" onClick={onClose} />}
    <aside className={clsx('my-context-sidebar acp-navigation', open && 'is-open')} aria-label="角色与会话导航">
      <div className="acp-navigation-title"><strong>Agent 工作台</strong><Button size="sm" variant="ghost" title="新建会话" onClick={onNew}><Plus size={15} /></Button><Button size="sm" variant="ghost" className="acp-mobile-only" title="关闭会话导航" onClick={onClose}><X size={14} /></Button></div>
      <div className="acp-navigation-primary"><button className={view === 'agents' ? 'is-selected' : ''} onClick={() => { dismiss(); onView('agents') }}><Bot size={15} />我的 Agent 角色</button><button onClick={onNew}><Plus size={15} />新建会话</button></div>
      <div className="acp-navigation-label"><span>最近会话</span><span className="text-my-sm text-my-tertiary">{recent.length}</span></div>
      <label className="acp-navigation-search"><Search size={13} /><input aria-label="搜索已加载的会话" value={query} onChange={(event) => { dismiss(); setQuery(event.target.value) }} placeholder="搜索最近会话" /></label>
      <div className="acp-navigation-scroll my-scrollbar" onScroll={dismiss}>{recent.map(row)}{recent.length === 0 && <p className="px-3 py-3 text-my-sm text-my-tertiary">暂无匹配的会话</p>}
        {(historyExpanded || view === 'history') && <div className="acp-secondary-history"><div className="acp-navigation-label">历史与诊断记录</div>{old.map(row)}{old.length === 0 && <p className="px-3 py-3 text-my-sm text-my-tertiary">暂无旧版记录</p>}</div>}
      </div>
      <div className="acp-navigation-bottom"><button onClick={() => { dismiss(); setHistoryExpanded((current) => !current); onView('history') }}><History size={14} />历史与诊断<ChevronDown size={13} /></button><p>仅当前项目 · 已加载范围</p></div>
      <SidebarResizeHandle label="调整会话侧栏宽度" />
    </aside>
    {preview && interactive && (!collapsed || open) && createPortal(<div role="tooltip" id={tooltipId} className="acp-recent-tooltip" style={{ left: preview.left, top: preview.top }}><div><strong>{preview.session.title ?? preview.session.agentName}</strong><time>{new Date(preview.session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{conversationSummary(preview.session)}</p><small>{preview.session.profileSnapshot?.name ?? preview.session.agentName}{preview.session.taskDir ? ` · ${preview.session.taskDir}` : ' · 未关联任务'}</small></div>, preview.host)}
  </>
}
