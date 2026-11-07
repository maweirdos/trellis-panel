import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowUp, Bot, CircleStop, Loader2, RefreshCw, Send } from 'lucide-react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import type { CruxProgressApi } from '@shared/crux-task-progress'
import type { AcpHistoryEventPage } from '@shared/acp-history'
import type { AcpPermissionPayload, AcpSessionRecord, TimelineEvent } from '@shared/types'
import { api } from '../api'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { Button } from '../my/ui'
import { projectRootKey } from '../my/navigation'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { ConversationTranscript } from '../acp/ConversationTranscript'
import { compileItems, mergeEvents, SESSION_LABEL } from '../acp/timeline'
import { ownsTaskConversation, returnToConversationTask, type TaskConversationTarget } from './task-conversation'
import { useCrux } from './store'
import { useTaskDraft, useTaskDraftField } from './pages/task-detail/task-drafts'
import '../acp/workspace.css'

/** The ordinary Agent route can also own one task-bound session without a code root. */
export function TaskConversationWorkspace({ target }: { target: TaskConversationTarget }): JSX.Element {
  const snapshot = useCrux((state) => state.snapshot)
  const task = snapshot?.tasks.find((item) => item.id === target.taskId && item.createdAt === target.taskCreatedAt)
  if (!snapshot || !task || !ownsTaskConversation(target)) return <div className="flex h-full flex-col items-center justify-center gap-3 text-my-sm text-my-secondary"><p>原任务会话当前不可用。</p><Button variant="outline" onClick={() => { useMy.getState().setTaskConversationTarget(null); useApp.getState().setPage('crux') }}>返回团队</Button></div>
  return <BoundConversation target={target} snapshot={snapshot} task={task} />
}

function BoundConversation({ target, snapshot, task }: { target: TaskConversationTarget; snapshot: CruxSnapshot; task: CruxTask }): JSX.Element {
  const context = useCrux((state) => state.workspaceContext)
  const active = useInteractionActive(), canInteract = useInteractionGuard(), signal = useInteractionSignal()
  const client: CruxProgressApi | undefined = api && Object.hasOwn(api, 'cruxProgress') ? api.cruxProgress : undefined
  const [session, setSession] = useState<AcpSessionRecord | null>(null)
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [page, setPage] = useState<AcpHistoryEventPage | null>(null)
  const [loading, setLoading] = useState(false), [earlier, setEarlier] = useState(false)
  const [operation, setOperation] = useState(''), [error, setError] = useState('')
  const [permissionPending, setPermissionPending] = useState<Record<string, boolean>>({})
  const [permissionErrors, setPermissionErrors] = useState<Record<string, string>>({})
  const [refresh, setRefresh] = useState(0), [now, setNow] = useState(Date.now)
  const draft = useTaskDraft(snapshot, context, { kind: 'conversation', spaceId: task.spaceId, task, creationContext: [target.session.sessionId] })
  const [input, setInput] = useTaskDraftField(draft, 'message', '')
  const currentSession = useRef(session); currentSession.current = session
  const stream = useRef<HTMLDivElement>(null), following = useRef(true)
  const mounted = useRef(false), pending = useRef(false), reads = useRef(0)
  const query = { workspaceKey: target.workspaceKey, taskId: target.taskId }
  const valid = (): boolean => mounted.current && canInteract() && !signal?.aborted && useMy.getState().taskConversationTarget === target && ownsTaskConversation(target)
  const matches = (record: { sessionId?: string; projectRoot?: string }): boolean => record.sessionId === target.session.sessionId && projectRootKey(record.projectRoot) === projectRootKey(target.session.projectRoot)
  const accept = (record: AcpSessionRecord): void => {
    if (!valid() || !matches(record)) return
    setSession((previous) => previous && (previous.stateRevision ?? 0) > (record.stateRevision ?? 0) ? previous : record)
  }
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; reads.current++ } }, [])
  useEffect(() => {
    if (!active || !client?.conversation) return
    let live = true, reading = false, lastRead = 0
    const read = async (force = false): Promise<void> => {
      if (!live || reading || !valid() || document.hidden) return
      const frequent = ['starting', 'busy', 'awaiting_permission', 'cancelling'].includes(currentSession.current?.status ?? 'starting')
      if (!force && Date.now() - lastRead < (frequent ? 1500 : 15_000)) return
      lastRead = Date.now()
      reading = true; const ticket = ++reads.current; setLoading(true)
      try {
        const result = await client.conversation?.(query)
        if (!live || ticket !== reads.current || !valid()) return
        if (!result?.ok) throw Error(result?.error ?? '会话当前不可用。')
        if (!matches(result.session)) throw Error('任务的主要会话已改变，请返回任务重新核对。')
        accept(result.session)
        if (!client.events) setEvents((previous) => mergeEvents(previous, result.session.events))
        else {
          const history = await client.events({ ...query, limit: 120 })
          if (!live || ticket !== reads.current || !valid()) return
          if (!history.ok) throw Error(history.error)
          if (!matches(history.session)) throw Error('会话历史来源不匹配。')
          setPage((previous) => previous?.beforeCursor ? { ...history, beforeCursor: previous.beforeCursor, hasEarlier: previous.hasEarlier } : history)
          setEvents((previous) => mergeEvents(history.events, previous))
        }
        setError(''); setNow(Date.now())
      } catch (cause) { if (live && ticket === reads.current && valid()) setError(cause instanceof Error ? cause.message : '读取会话失败。') }
      finally { reading = false; if (live && ticket === reads.current && valid()) setLoading(false) }
    }
    void read(true)
    const offOutput = api.onAcpOutput((event) => { if (valid() && matches(event) && event.connectionGeneration === currentSession.current?.connectionGeneration) setEvents((previous) => mergeEvents(previous, [event])) })
    const offState = api.onAcpState((state) => {
      if (!valid() || !matches(state)) return
      if (state.session) accept(state.session)
      else setSession((previous) => previous && (previous.stateRevision ?? 0) <= (state.stateRevision ?? 0) ? { ...previous, status: state.status, connectionGeneration: state.connectionGeneration ?? previous.connectionGeneration, pendingPermissions: state.pendingPermissions ?? [], error: state.error, stateRevision: state.stateRevision } : previous)
    })
    const offDone = api.onAcpDone((event) => { if (valid() && matches(event)) void read(true) })
    const visible = (): void => { if (!document.hidden) void read(true) }
    document.addEventListener('visibilitychange', visible)
    // Managed general work may have no globally observed project root. Read its
    // actual task bridge while active, without depending on ordinary root events.
    const timer = setInterval(() => { setNow(Date.now()); void read() }, 1500)
    return () => { live = false; reads.current++; offOutput(); offState(); offDone(); clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
    // Immutable target owns all asynchronous work; layout switches never replace it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, active, signal, client, refresh])
  useLayoutEffect(() => { if (following.current && stream.current) stream.current.scrollTop = stream.current.scrollHeight }, [events, session?.status])
  const items = useMemo(() => compileItems(events), [events])
  const pendingPerm = useMemo(() => Object.fromEntries((target.readOnly ? [] : session?.pendingPermissions ?? []).filter((permission) => matches(permission) && permission.connectionGeneration === session?.connectionGeneration && (permission.expiresAt === undefined || permission.expiresAt > now)).map((permission) => [permission.requestId, permission])), [session, now, target.readOnly])
  const perform = async (kind: string, call: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
    if (!valid() || pending.current || target.readOnly) return false
    pending.current = true; setOperation(kind); setError('')
    try { const reply = await call(); if (!valid()) return false; if (!reply.ok) throw Error(reply.error ?? '操作未确认。'); return true }
    catch (cause) { if (valid()) setError(cause instanceof Error ? cause.message : '操作失败。'); return false }
    finally { pending.current = false; if (valid()) { setOperation(''); setRefresh((value) => value + 1) } }
  }
  const send = async (): Promise<void> => {
    const current = currentSession.current
    if (!client?.send || !current?.connectionGeneration || !input.trim() || current.status !== 'ready') return
    const acknowledge = draft.acknowledge(['message'])
    if (await perform('send', () => client.send?.({ ...query, text: input.trim(), expectedConnectionGeneration: current.connectionGeneration ?? '' }) ?? Promise.resolve({ ok: false }))) { acknowledge(); following.current = true }
  }
  const respond = async (requestId: string, optionId: string): Promise<void> => {
    const permission: AcpPermissionPayload | undefined = pendingPerm[requestId]
    if (!client?.respond || target.readOnly || !valid() || permissionPending[requestId] || !permission || !permission.options.some((option) => option.optionId === optionId) || !session?.connectionGeneration) return
    setPermissionPending((previous) => ({ ...previous, [requestId]: true }))
    try {
      const result = await client.respond({ ...query, requestId, optionId, expectedConnectionGeneration: session.connectionGeneration })
      if (!valid()) return
      if (!result.ok) throw Error(result.error)
      setSession((previous) => previous ? { ...previous, pendingPermissions: previous.pendingPermissions?.filter((item) => item.requestId !== requestId) } : previous)
      setRefresh((value) => value + 1)
    } catch (cause) { if (valid()) setPermissionErrors((previous) => ({ ...previous, [requestId]: cause instanceof Error ? cause.message : '授权未确认。' })) }
    finally { if (valid()) setPermissionPending((previous) => ({ ...previous, [requestId]: false })) }
  }
  const loadEarlier = async (): Promise<void> => {
    if (!client?.events || !page?.beforeCursor || earlier || !valid()) return
    const element = stream.current, height = element?.scrollHeight ?? 0, top = element?.scrollTop ?? 0
    following.current = false; setEarlier(true)
    try {
      const result = await client.events({ ...query, before: page.beforeCursor, limit: 120 })
      if (!valid()) return
      if (!result.ok) throw Error(result.error)
      if (!matches(result.session)) throw Error('会话历史来源已变化。')
      setPage(result); setEvents((previous) => mergeEvents(result.events, previous))
      requestAnimationFrame(() => { if (valid() && element) element.scrollTop = top + element.scrollHeight - height })
    } catch (cause) { if (valid()) setError(cause instanceof Error ? cause.message : '历史读取失败。') }
    finally { if (valid()) setEarlier(false) }
  }
  const running = Boolean(session && ['busy', 'awaiting_permission', 'cancelling'].includes(session.status))
  const unavailableAction = (): void => setError('此记录请返回任务，在已核对的任务材料中查看。')
  return <div className="acp-workspace"><main className="acp-main my-conversation-frame">
    <header className="acp-workspace-header"><Button size="sm" variant="ghost" onClick={() => returnToConversationTask(target)}><ArrowLeft size={14} />返回任务</Button><Bot size={16} className="text-my-icon-secondary" /><strong className="min-w-0 flex-1 truncate text-my-sm" title={task.title}>{task.title}</strong><span className="my-chip text-my-secondary">{target.session.engine === 'pi' ? 'Pi' : 'ACP'}</span><span role="status" className="text-my-xs text-my-tertiary">{session ? SESSION_LABEL[session.status] : '核对会话中'}</span><Button size="sm" variant="ghost" disabled={loading} aria-label="核对任务会话" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></Button></header>
    <div ref={stream} className="acp-transcript my-scrollbar" onScroll={() => { const element = stream.current; if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48 }}><div className="my-conversation-column acp-transcript-content">
      {page?.hasEarlier && <Button size="sm" variant="ghost" disabled={earlier} onClick={() => void loadEarlier()}>{earlier ? <Loader2 size={13} className="animate-spin" /> : <ArrowUp size={13} />}加载更早消息</Button>}
      {(page?.startsMidTurn || page?.coverage.state === 'partial' || page?.coverage.state === 'unknown') && <p className="my-activity-note">{page?.coverage.state === 'unknown' ? '会话历史范围尚未确认' : '当前显示部分会话记录'}</p>}
      {session && <ConversationTranscript session={session} events={events} items={items} pendingPerm={pendingPerm} permissionPending={permissionPending} permissionErrors={permissionErrors} onRespond={(requestId, optionId) => void respond(requestId, optionId)} onOpenTask={() => returnToConversationTask(target)} onOpenArtifact={unavailableAction} onOpenSpec={unavailableAction} onOpenJira={unavailableAction} />}
      {!events.length && <p className="my-activity-note">{loading ? '正在读取原会话…' : '此会话尚无可显示的消息'}</p>}
      {Object.values(pendingPerm).filter((permission) => !items.some((item) => item.type === 'perm' && item.ev.payload?.requestId === permission.requestId)).map((permission) => <section key={permission.requestId} className="my-activity-note"><span>{permission.toolCall?.title ?? '等待权限确认'}</span>{permission.options.map((option) => <Button key={option.optionId} size="sm" variant="outline" disabled={permissionPending[permission.requestId]} onClick={() => void respond(permission.requestId, option.optionId)}>{option.name}</Button>)}{permissionErrors[permission.requestId] && <p role="alert">{permissionErrors[permission.requestId]}</p>}</section>)}
    </div></div>
    <footer className="acp-composer-region my-conversation-column"><div className="acp-composer">{error && <p role="alert" className="p-3 text-my-xs text-my-danger-text">{error}</p>}<textarea className="acp-input" aria-label="任务会话指令" placeholder="继续处理当前任务…" value={input} disabled={target.readOnly || !client?.send} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} /><div className="flex flex-wrap items-center gap-2 px-3 pb-3"><span className="min-w-0 flex-1 truncate text-my-xs text-my-tertiary" title={target.session.cwd}>{task.workKind === 'general' ? '任务工作目录' : '代码任务'} · 主要会话</span>{session && ['closed', 'disconnected', 'error'].includes(session.status) && !target.readOnly && client?.resume && <Button size="sm" variant="outline" disabled={Boolean(operation)} onClick={() => void perform('resume', () => client.resume?.(query) ?? Promise.resolve({ ok: false }))}>连接原会话</Button>}{running && !target.readOnly && client?.cancel ? <Button size="sm" variant="outline" title={operation === 'cancel' || session?.status === 'cancelling' ? '正在停止…' : '停止当前回合'} aria-label={operation === 'cancel' || session?.status === 'cancelling' ? '正在停止' : '停止当前回合'} disabled={Boolean(operation) || session?.status === 'cancelling'} onClick={() => void perform('cancel', () => client.cancel?.(query) ?? Promise.resolve({ ok: false }))}><CircleStop size={14} aria-hidden="true" /></Button> : <Button size="sm" variant="primary" disabled={target.readOnly || !client?.send || Boolean(operation) || session?.status !== 'ready' || !input.trim()} onClick={() => void send()}>{operation === 'send' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}发送</Button>}</div></div></footer>
  </main></div>
}
