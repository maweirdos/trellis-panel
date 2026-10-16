/** Page-owned ACP profiles and explicitly started project conversations. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ArrowDown, Bot, CircleStop, GitBranch, History, Loader2, Plus, RefreshCw, Send, Settings2, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useApp } from '../store'
import { api, hasIpc } from '../api'
import { Button, Modal } from '../my/ui'
import { projectRootKey } from '../my/navigation'
import { ObservationPanel } from '../observation/ObservationPanel'
import { ProfileEditor } from './ProfileEditor'
import { RuntimePanel, runtimeHealthLabel } from './RuntimePanel'
import { EventRow } from './TranscriptRow'
import { SessionDetails, StartupGroup } from './SessionDetails'
import { JiraPickerModal } from './JiraPicker'
import { compileItems, isLiveStatus, mergeEvents, SESSION_LABEL } from './timeline'
import { readActiveSession, readSessionView, writeActiveSession, writeSessionView } from './view-state'
import type { ActivityEventInput } from '../../../shared/observability/activity'
import type { AcpAgentProfile, AcpAgentStatus, AcpPermissionPayload, AcpSessionRecord, AcpStartupObservation, AcpStateEvent, TimelineEvent } from '../../../shared/types'

const STATUS_COLOR: Record<string, string> = {
  starting: 'text-my-warning-text', ready: 'text-my-success-text', busy: 'text-my-info-text',
  awaiting_permission: 'text-my-warning-text', cancelling: 'text-my-warning-text',
  error: 'text-my-danger-text', closed: 'text-my-tertiary', disconnected: 'text-my-tertiary', legacy: 'text-my-tertiary'
}
const FILE_KINDS: ReadonlySet<string> = new Set(['doc-created', 'spec-updated'])
const failureText = (error: unknown): string => error instanceof Error ? error.message : '请求失败，请重试'
const canSend = (session: AcpSessionRecord): boolean => session.status === 'ready' || (session.status === 'disconnected' && session.restorePending === true)

export function AcpConsolePage(): JSX.Element {
  const snapshot = useApp((state) => state.snapshot)
  const pushToast = useApp((state) => state.pushToast)
  const setPage = useApp((state) => state.setPage)
  const showTask = useApp((state) => state.showTask)
  const openArtifact = useApp((state) => state.openArtifact)
  const root = snapshot?.meta.root ?? ''
  const [agents, setAgents] = useState<AcpAgentStatus[]>([])
  const [profiles, setProfiles] = useState<AcpAgentProfile[]>([])
  const [sessions, setSessions] = useState<AcpSessionRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [events, setEvents] = useState<Record<string, TimelineEvent[]>>({})
  const [view, setView] = useState<'agents' | 'conversation'>('agents')
  const [input, setInput] = useState('')
  const [creating, setCreating] = useState(false)
  const [sending, setSending] = useState<Record<string, boolean>>({})
  const [operations, setOperations] = useState<Record<string, string>>({})
  const [feedback, setFeedback] = useState<Record<string, { error: boolean; text: string }>>({})
  const [permissionPending, setPermissionPending] = useState<Record<string, boolean>>({})
  const [permissionErrors, setPermissionErrors] = useState<Record<string, string>>({})
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(false)
  const [editor, setEditor] = useState<AcpAgentProfile | null>(null)
  const [runtimeOpen, setRuntimeOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [jiraOpen, setJiraOpen] = useState(false)
  const [taskDir, setTaskDir] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const streamRef = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const followRef = useRef(true)
  const draftsRef = useRef<Record<string, string>>({})
  const scope = useMemo(() => ({
    root, live: true, sessionIds: new Set<string>(), states: new Map<string, AcpStateEvent>(),
    reloadSerial: 0, createPending: false, sends: new Set<string>(), permissions: new Set<string>(), actions: new Set<string>()
  }), [root])
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const isCurrent = useCallback((): boolean => scope.live && scopeRef.current === scope && (useApp.getState().snapshot?.meta.root ?? '') === root, [root, scope])
  const projectSessions = useMemo(() => sessions.filter((session) => root && projectRootKey(session.projectRoot) === projectRootKey(root)), [sessions, root])
  const sessionsRef = useRef(projectSessions)
  sessionsRef.current = projectSessions
  const activeSession = projectSessions.find((session) => session.sessionId === activeId) ?? null
  const activeEvents = useMemo(() => activeSession ? events[activeSession.sessionId] ?? [] : [], [events, activeSession])
  const items = useMemo(() => compileItems(activeEvents), [activeEvents])
  const pendingPerm = useMemo(() => {
    const pending: Record<string, AcpPermissionPayload> = {}
    for (const session of projectSessions) {
      if (!isLiveStatus(session.status) || session.historyKind === 'legacy' || session.historyKind === 'transcript') continue
      for (const event of events[session.sessionId] ?? []) {
        if (event.kind !== 'permission' || !event.payload?.requestId) continue
        const requestId = String(event.payload.requestId)
        const permission = event.payload.permission as AcpPermissionPayload | undefined
        if (event.payload.pending === true && permission?.sessionId === session.sessionId && (!permission.connectionGeneration || !session.connectionGeneration || permission.connectionGeneration === session.connectionGeneration)) pending[requestId] = permission
        else delete pending[requestId]
      }
    }
    return pending
  }, [projectSessions, events])
  const boundTask = activeSession?.taskDir ? snapshot?.tasks.find((task) => task.dirName === activeSession.taskDir) ?? null : null
  const activityEvents = useMemo<ActivityEventInput[]>(() => activeEvents.slice(-40).filter((event) => event.kind !== 'message' && event.kind !== 'thought').map((event) => ({
    id: event.id, atMs: event.ts, source: event.source === 'trellis' && FILE_KINDS.has(event.kind) ? 'file' : 'timeline',
    text: event.text ?? event.kind, taskDir: event.taskDir ?? (typeof event.payload?.taskDir === 'string' ? event.payload.taskDir : null)
  })), [activeEvents])

  const reloadSessions = useCallback(async (): Promise<void> => {
    if (!hasIpc || !root || !isCurrent()) return
    const serial = ++scope.reloadSerial
    try {
      const response = await api.acpSessions()
      if (!isCurrent() || serial !== scope.reloadSerial) return
      if (!response.ok || !response.sessions) { setLoadError(response.error ?? '会话列表加载失败'); return }
      const records = response.sessions.filter((record) => projectRootKey(record.projectRoot) === projectRootKey(root)).map((record) => {
        const state = scope.states.get(record.sessionId)
        return state ? { ...record, ...state.session, status: state.status, error: state.error } : record
      })
      for (const record of records) scope.sessionIds.add(record.sessionId)
      setSessions(records)
      setEvents((previous) => {
        const next: Record<string, TimelineEvent[]> = {}
        for (const record of records) next[record.sessionId] = mergeEvents(record.events ?? [], previous[record.sessionId] ?? [])
        for (const id of scope.sessionIds) if (!next[id] && previous[id]) next[id] = previous[id]
        return next
      })
      setActiveId((current) => records.some((record) => record.sessionId === current) ? current : records[0]?.sessionId ?? null)
      setLoadError('')
    } catch (error) { if (isCurrent() && serial === scope.reloadSerial) setLoadError(failureText(error)) }
  }, [root, scope, isCurrent])

  const reloadCatalogue = useCallback(async (): Promise<void> => {
    if (!hasIpc || !root || !isCurrent()) return
    setLoading(true)
    try {
      const results = await Promise.allSettled([api.acpAgents(), api.acpProfiles()])
      if (!isCurrent()) return
      const [runtimeResult, profileResult] = results
      const errors: string[] = []
      if (runtimeResult.status === 'fulfilled' && runtimeResult.value.ok && runtimeResult.value.agents) setAgents(runtimeResult.value.agents)
      else errors.push(runtimeResult.status === 'rejected' ? failureText(runtimeResult.reason) : runtimeResult.value.error ?? 'Runtime 列表加载失败')
      if (profileResult.status === 'fulfilled' && profileResult.value.ok && profileResult.value.profiles) setProfiles(profileResult.value.profiles)
      else errors.push(profileResult.status === 'rejected' ? failureText(profileResult.reason) : profileResult.value.error ?? 'Agent 列表加载失败')
      if (errors.length) setLoadError(errors.join('；'))
    } finally { if (isCurrent()) setLoading(false) }
  }, [root, isCurrent])

  const updateSession = useCallback((record: AcpSessionRecord): void => {
    if (!isCurrent() || projectRootKey(record.projectRoot) !== projectRootKey(root)) return
    scope.sessionIds.add(record.sessionId)
    setSessions((previous) => previous.some((item) => item.sessionId === record.sessionId) ? previous.map((item) => item.sessionId === record.sessionId ? record : item) : [record, ...previous])
    setEvents((previous) => ({ ...previous, [record.sessionId]: mergeEvents(record.events ?? [], previous[record.sessionId] ?? []) }))
  }, [root, scope, isCurrent])

  useEffect(() => {
    scope.live = true
    setSessions([]); setProfiles([]); setAgents([]); setEvents({}); setActiveId(readActiveSession(root)); setInput('')
    setCreating(false); setSending({}); setOperations({}); setFeedback({}); setPermissionPending({}); setPermissionErrors({}); setLoadError('')
    setJiraOpen(false); setEditor(null); setRuntimeOpen(false); setDetailOpen(false); setHistoryOpen(false); setTaskDir('')
    setView(readActiveSession(root) ? 'conversation' : 'agents')
    draftsRef.current = {}; composing.current = false
    if (!hasIpc || !root) return () => { scope.live = false }
    const offOut = api.onAcpOutput((event) => {
      if (!isCurrent() || projectRootKey(event.projectRoot) !== projectRootKey(root)) return
      if (!event.sessionId) {
        setEvents((previous) => {
          const next = { ...previous }
          for (const session of sessionsRef.current) {
            if (!isLiveStatus(session.status) || (event.taskDir && event.taskDir !== session.taskDir)) continue
            next[session.sessionId] = mergeEvents(next[session.sessionId] ?? [], [event])
          }
          return next
        })
        return
      }
      const id = event.sessionId
      const knownGeneration = scope.states.get(id)?.connectionGeneration ?? sessionsRef.current.find((session) => session.sessionId === id)?.connectionGeneration
      if (knownGeneration && event.connectionGeneration && knownGeneration !== event.connectionGeneration) return
      scope.sessionIds.add(id)
      setEvents((previous) => ({ ...previous, [id]: mergeEvents(previous[id] ?? [], [event]) }))
      const observation = event.payload?.observation as AcpStartupObservation | undefined
      if (event.kind === 'session-status' && observation && typeof observation.label === 'string' && typeof observation.atMs === 'number') {
        setSessions((previous) => previous.map((session) => session.sessionId === id && !(session.startup ?? []).some((item) => item.atMs === observation.atMs && item.label === observation.label)
          ? { ...session, startup: [...(session.startup ?? []), observation] } : session))
      }
    })
    const offState = api.onAcpState((state) => {
      if (!isCurrent() || projectRootKey(state.projectRoot) !== projectRootKey(root)) return
      scope.sessionIds.add(state.sessionId); scope.states.set(state.sessionId, state)
      if (state.session) updateSession(state.session)
      else setSessions((previous) => previous.map((session) => session.sessionId === state.sessionId ? { ...session, status: state.status, error: state.error, connectionGeneration: state.connectionGeneration ?? session.connectionGeneration } : session))
    })
    const offDone = api.onAcpDone((event) => {
      if (!isCurrent()) return
      if (event.projectRoot && projectRootKey(event.projectRoot) !== projectRootKey(root)) return
      const known = scope.states.get(event.sessionId)
      if (known?.connectionGeneration && event.connectionGeneration && known.connectionGeneration !== event.connectionGeneration) return
      if (event.session) updateSession(event.session)
      scope.states.set(event.sessionId, { ...known, ...event, projectRoot: root, session: event.session ?? (known?.session ? { ...known.session, status: event.status, error: event.error } : undefined) })
      if (scope.states.size > 64) { const oldest = scope.states.keys().next().value; if (oldest) scope.states.delete(oldest) }
      if (!scope.sessionIds.has(event.sessionId)) return
      setSessions((previous) => previous.map((session) => session.sessionId === event.sessionId ? { ...session, status: event.status, error: event.error } : session))
    })
    void reloadCatalogue(); void reloadSessions()
    return () => { scope.live = false; offOut(); offState(); offDone() }
  }, [root, scope, isCurrent, reloadCatalogue, reloadSessions, updateSession])

  useLayoutEffect(() => {
    if (!activeId || !isCurrent()) return
    const saved = readSessionView(root, activeId)
    setInput(draftsRef.current[activeId] ?? saved.draft)
    followRef.current = saved.follow; setAtBottom(saved.follow)
    const element = streamRef.current
    if (element) element.scrollTop = saved.follow ? element.scrollHeight : saved.scrollTop
    writeActiveSession(root, activeId)
  }, [root, activeId, view, isCurrent])
  useLayoutEffect(() => {
    const element = streamRef.current
    if (element && followRef.current) element.scrollTop = element.scrollHeight
  }, [activeEvents, activeSession?.startup])
  const selectSession = (id: string): void => {
    const element = streamRef.current
    if (activeId && element) writeSessionView(root, activeId, { scrollTop: element.scrollTop, follow: followRef.current })
    setActiveId(id); setView('conversation'); setHistoryOpen(false)
  }
  const changeDraft = (text: string): void => {
    setInput(text)
    if (!activeId) return
    draftsRef.current[activeId] = text; writeSessionView(root, activeId, { draft: text })
  }
  const newSession = useCallback(async (agentId: string, selectedTask?: string, profileId?: string): Promise<void> => {
    if (!root || !isCurrent() || scope.createPending) return
    scope.createPending = true; setCreating(true)
    try {
      const response = await api.acpSessionNew({ agentId, taskDir: selectedTask, profileId })
      if (!isCurrent()) return
      if (response.ok && response.sessionId) {
        scope.sessionIds.add(response.sessionId); setActiveId(response.sessionId); setView('conversation'); setHistoryOpen(false)
        await reloadSessions()
      } else pushToast({ kind: 'error', title: '会话创建失败', body: response.error ?? '' })
    } catch (error) { if (isCurrent()) pushToast({ kind: 'error', title: '会话创建失败', body: failureText(error) }) }
    finally { scope.createPending = false; if (isCurrent()) setCreating(false) }
  }, [root, scope, isCurrent, pushToast, reloadSessions])

  const send = useCallback(async (): Promise<void> => {
    if (!isCurrent() || !activeSession || !activeId || !canSend(activeSession) || scope.sends.has(activeId) || !input.trim()) return
    const id = activeId, text = input.trim(), submittedDraft = input
    scope.sends.add(id); setSending((previous) => ({ ...previous, [id]: true })); setFeedback((previous) => ({ ...previous, [id]: { error: false, text: '请求确认中，草稿暂时保留。' } }))
    try {
      const response = await api.acpSessionPrompt(id, text)
      if (!isCurrent()) return
      if (response.ok) {
        const latestDraft = draftsRef.current[id] ?? readSessionView(root, id).draft
        if (latestDraft === submittedDraft) {
          draftsRef.current[id] = ''; writeSessionView(root, id, { draft: '' })
          if (readActiveSession(root) === id) setInput('')
        }
        setFeedback((previous) => ({ ...previous, [id]: { error: false, text: 'Runtime 已接受请求。回合结束不代表任务验收通过。' } }))
      } else setFeedback((previous) => ({ ...previous, [id]: { error: true, text: response.error ?? '发送被拒绝，草稿已保留。' } }))
    } catch (error) { if (isCurrent()) setFeedback((previous) => ({ ...previous, [id]: { error: true, text: failureText(error) } })) }
    finally { scope.sends.delete(id); if (isCurrent()) setSending((previous) => ({ ...previous, [id]: false })) }
  }, [input, activeId, activeSession, root, scope, isCurrent])

  const sessionAction = async (action: 'cancel' | 'kill' | 'resume'): Promise<void> => {
    if (!activeSession || !isCurrent() || scope.actions.has(activeSession.sessionId)) return
    const id = activeSession.sessionId
    scope.actions.add(id); setOperations((previous) => ({ ...previous, [id]: action }))
    setFeedback((previous) => ({ ...previous, [id]: { error: false, text: action === 'resume' ? '正在载入历史会话…' : '正在请求停止…' } }))
    try {
      const response = await (action === 'cancel' ? api.acpSessionCancel(id) : action === 'kill' ? api.acpSessionKill(id) : api.acpSessionResume(id))
      if (!isCurrent()) return
      setFeedback((previous) => ({ ...previous, [id]: { error: !response.ok, text: response.ok ? action === 'resume' ? '已载入历史，发送时验证恢复。尚未确认远端连接。' : action === 'kill' ? '会话停止已确认。' : '中止请求已提交，等待 Runtime 停止本轮。' : response.error ?? '操作失败，可以重试。' } }))
      if (response.ok) await reloadSessions()
    } catch (error) { if (isCurrent()) setFeedback((previous) => ({ ...previous, [id]: { error: true, text: failureText(error) } })) }
    finally { scope.actions.delete(id); if (isCurrent()) setOperations((previous) => ({ ...previous, [id]: '' })) }
  }

  const respondPerm = useCallback(async (requestId: string, optionId: string): Promise<void> => {
    const permission = pendingPerm[requestId]
    if (!isCurrent() || !permission || scope.permissions.has(requestId) || !permission.options.some((option) => option.optionId === optionId)) return
    scope.permissions.add(requestId); setPermissionPending((previous) => ({ ...previous, [requestId]: true })); setPermissionErrors((previous) => ({ ...previous, [requestId]: '' }))
    try {
      const response = await api.acpPermissionRespond(requestId, optionId)
      if (isCurrent() && !response.ok) setPermissionErrors((previous) => ({ ...previous, [requestId]: response.error ?? '响应失败，请重新选择。' }))
      if (isCurrent() && response.ok) await reloadSessions()
    } catch (error) { if (isCurrent()) setPermissionErrors((previous) => ({ ...previous, [requestId]: failureText(error) })) }
    finally { scope.permissions.delete(requestId); if (isCurrent()) setPermissionPending((previous) => ({ ...previous, [requestId]: false })) }
  }, [pendingPerm, scope, isCurrent, reloadSessions])

  const availableAgents = agents.filter((agent) => agent.enabled && agent.available)
  const sessionList = <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
    {projectSessions.length === 0 && <p className="px-2 py-6 text-my-xs text-my-tertiary">当前项目尚无会话。</p>}
    {projectSessions.map((session) => <button key={session.sessionId} data-acp-session={session.sessionId} onClick={() => selectSession(session.sessionId)} className={clsx('mb-1 w-full rounded-my-md px-2.5 py-2 text-left', session.sessionId === activeId && view === 'conversation' ? 'bg-my-layer-1-selected text-my-primary' : 'text-my-secondary hover:bg-my-layer-1')}>
      <div className="flex items-start gap-2"><span className="min-w-0 flex-1 truncate text-my-xs font-medium">{session.title ?? session.profileSnapshot?.name ?? `${session.agentName} 会话`}</span><span className={clsx('shrink-0 text-my-2xs', STATUS_COLOR[session.status])}>{session.restorePending ? '发送时验证恢复' : SESSION_LABEL[session.status]}</span></div>
      <p className="mt-1 truncate text-my-2xs text-my-tertiary">{session.profileSnapshot?.name ?? session.agentName}{session.taskDir ? ` · ${session.taskDir}` : ''}</p>
      <p className="mt-1 text-my-2xs text-my-tertiary">{new Date(session.startedAt).toLocaleString()}{!isLiveStatus(session.status) ? ' · 历史记录' : ''}</p>
    </button>)}
  </div>

  if (!root) return <div className="flex h-full items-center justify-center text-my-sm text-my-tertiary">请先打开项目，再查看该项目的 Agent 会话。</div>
  return <div className="flex h-full min-h-0 flex-col gap-3 p-3">
    <header className="flex flex-wrap items-center gap-2">
      <Bot size={18} className="text-my-accent-text" /><h1 className="text-my-md font-semibold text-my-primary">Agent 工作台</h1>
      <Button size="sm" variant={view === 'agents' ? 'neutral' : 'ghost'} onClick={() => setView('agents')}>全部 Agent</Button>
      <Button size="sm" variant={view === 'conversation' ? 'neutral' : 'ghost'} onClick={() => { setView('conversation'); setHistoryOpen(true) }}><History size={13} /> 最近会话</Button>
      <div className="flex-1" />
      <Button size="sm" variant="outline" onClick={() => setRuntimeOpen(true)}><Settings2 size={13} /> Runtime 设置</Button>
      <Button size="sm" variant="ghost" title="刷新" onClick={() => { void reloadSessions(); void reloadCatalogue() }}><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></Button>
    </header>
    {loadError && <div role="alert" className="rounded-my-md border border-my-line-danger bg-my-danger-subtle px-3 py-2 text-my-xs text-my-danger-text">{loadError}<button className="ml-3 underline" onClick={() => { void reloadCatalogue(); void reloadSessions() }}>重试加载</button></div>}
    <div className="flex min-h-0 flex-1 gap-3">
      <aside className="my-card hidden w-56 shrink-0 flex-col min-[1100px]:flex">
        <div className="border-b border-my-line p-3 text-my-xs font-medium text-my-secondary">当前项目 · 最近会话</div>
        {sessionList}
        <div className="border-t border-my-line p-2"><Button size="sm" variant="ghost" onClick={() => setJiraOpen(true)}><GitBranch size={13} /> 从 Jira 选工单开始</Button></div>
      </aside>
      {view === 'agents' ? <section className="my-card my-scrollbar min-w-0 flex-1 overflow-y-auto p-5">
        <div className="mb-5 flex flex-wrap items-center gap-3"><div className="flex-1"><h2 className="text-my-md font-medium text-my-primary">可复用的 Agent</h2><p className="mt-1 text-my-xs text-my-tertiary">配置角色与指令，再显式开始会话。Runtime 负责在本机执行。</p></div>
          <Button variant="primary" size="sm" disabled={agents.length === 0 || !hasIpc} onClick={() => setEditor({ id: crypto.randomUUID(), name: '', description: '', instructions: '', runtimeId: agents[0]?.runtimeId ?? agents[0]?.id ?? '', maxTurnMinutes: 30 })}><Plus size={13} /> 创建 Agent</Button>
        </div>
        <label className="mb-5 block text-my-xs text-my-secondary">新会话关联任务<select aria-label="新会话关联任务" className="my-input ml-2 max-w-full" value={taskDir} onChange={(event) => setTaskDir(event.target.value)}><option value="">不关联任务</option>{snapshot?.tasks.map((task) => <option key={task.dirName} value={task.dirName}>{task.record?.title ?? task.dirName}</option>)}</select></label>
        <div className="grid gap-3 min-[1300px]:grid-cols-2">{profiles.map((profile) => {
          const runtime = agents.find((agent) => (agent.runtimeId ?? agent.id) === profile.runtimeId)
          const recent = projectSessions.filter((session) => session.profileSnapshot?.id === profile.id)
          return <article key={profile.id} className="rounded-my-lg border border-my-line bg-my-surface-1 p-4">
            <div className="flex items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-my-lg bg-my-accent-subtle text-my-accent-text"><Bot size={22} /></div><div className="min-w-0 flex-1"><h3 className="truncate text-my-md font-medium text-my-primary">{profile.name}</h3><p className="mt-1 line-clamp-2 text-my-xs text-my-secondary">{profile.description || '尚未填写说明'}</p></div><Button variant="ghost" size="sm" title={`配置 ${profile.name}`} onClick={() => setEditor(profile)}><Settings2 size={14} /></Button></div>
            <p className="mt-3 text-my-2xs text-my-tertiary">{runtime?.name ?? profile.runtimeId} · {runtimeHealthLabel(runtime)}</p>
            <p className="mt-1 truncate font-mono text-my-2xs text-my-tertiary" title={profile.cwd || root}>{profile.cwd || root}</p>
            <div className="mt-4 flex flex-wrap items-center gap-2"><Button size="sm" variant="primary" disabled={creating || !runtime?.enabled || !runtime.available} onClick={() => void newSession(runtime?.id ?? profile.runtimeId, taskDir || undefined, profile.id)}>{creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} 开始会话</Button>{(!runtime?.available || !runtime.enabled) && <Button size="sm" variant="outline" onClick={() => setRuntimeOpen(true)}>检查 Runtime</Button>}{recent[0] && <Button size="sm" variant="ghost" onClick={() => selectSession(recent[0].sessionId)}>最近对话</Button>}</div>
          </article>
        })}</div>
        {profiles.length === 0 && <div className="rounded-my-lg border border-my-line p-5 text-my-xs text-my-secondary">{loading ? '正在加载 Agent 配置…' : '暂无 Agent 配置。先检查 Runtime，再创建一个 Agent。'}<div className="mt-3"><Button size="sm" variant="outline" onClick={() => setRuntimeOpen(true)}>检查 Runtime</Button></div></div>}
        <details className="mt-6 border-t border-my-line pt-4 text-my-xs text-my-secondary"><summary className="cursor-pointer">直接选择 Runtime 开始 · 兼容已有自定义命令</summary><div className="mt-3 flex flex-wrap gap-2"><select aria-label="新会话 Runtime" className="my-input min-w-0 max-w-full" value="" disabled={creating || availableAgents.length === 0} onChange={(event) => { if (event.target.value) void newSession(event.target.value, taskDir || undefined) }}><option value="">{creating ? '创建中…' : '选择 Runtime 开始新会话'}</option>{availableAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><Button size="sm" variant="ghost" onClick={() => setJiraOpen(true)}><GitBranch size={13} /> 从 Jira 选工单开始</Button></div></details>
        <p className="mt-6 text-my-2xs text-my-tertiary">任务分配、评论、编辑 Agent 或切换项目均不会自动执行。Agent 回合结束不改变 Trellis/Jira 验收状态。</p>
      </section> : <section className="my-card flex min-w-0 flex-1 flex-col overflow-hidden">
        {!activeSession ? <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-my-sm text-my-tertiary"><Bot size={28} /><p>选择最近会话，或选择 Agent 开始。</p><Button variant="outline" onClick={() => setView('agents')}>查看全部 Agent</Button></div> : <>
          <header className="flex flex-wrap items-center gap-2 border-b border-my-line px-4 py-3">
            <span className="min-w-0 flex-1 truncate text-my-sm font-medium text-my-primary">{activeSession.title ?? activeSession.profileSnapshot?.name ?? activeSession.agentName}</span><span className={clsx('text-my-2xs', STATUS_COLOR[activeSession.status])}>{activeSession.restorePending ? '发送时验证恢复' : SESSION_LABEL[activeSession.status]}</span>
            <Button variant="ghost" size="sm" title="会话配置与材料" onClick={() => setDetailOpen(true)}><Settings2 size={14} /></Button>
            {['busy', 'awaiting_permission', 'cancelling'].includes(activeSession.status) && <Button variant="outline" size="sm" disabled={Boolean(operations[activeSession.sessionId]) || activeSession.status === 'cancelling'} onClick={() => void sessionAction('cancel')}><CircleStop size={13} />{activeSession.status === 'cancelling' ? '中止中…' : '中止本轮'}</Button>}
            {(activeSession.historyKind === 'live' || isLiveStatus(activeSession.status) || activeSession.restorePending) && <Button variant="ghost" size="sm" className="text-my-danger-text" disabled={Boolean(operations[activeSession.sessionId])} onClick={() => void sessionAction('kill')} title="停止当前会话及其拥有的进程"><X size={13} /> 结束</Button>}
            {!isLiveStatus(activeSession.status) && !activeSession.restorePending && <><Button size="sm" variant="outline" disabled={!activeSession.canResume || Boolean(operations[activeSession.sessionId])} title={activeSession.canResume ? '载入历史；发送时验证原生恢复' : '此记录不支持原生恢复，可创建新的独立会话'} onClick={() => void sessionAction('resume')}>{operations[activeSession.sessionId] === 'resume' && <Loader2 size={12} className="animate-spin" />}恢复原会话</Button><Button size="sm" variant="ghost" disabled={creating} onClick={() => void newSession(activeSession.agentId, activeSession.taskDir, activeSession.profileSnapshot?.id)}><Plus size={12} /> 新会话</Button></>}
          </header>
          <div className="flex flex-wrap gap-x-3 gap-y-1 border-b border-my-line px-4 py-2 text-my-2xs text-my-tertiary"><span>本机 · {activeSession.runtimeSnapshot?.name ?? activeSession.agentName}</span><span className="min-w-0 truncate font-mono" title={activeSession.cwd ?? root}>{activeSession.cwd ?? root}</span>{boundTask && <button className="text-my-info-text underline underline-offset-2" onClick={() => { setPage('tasks'); showTask(boundTask.dirName) }}>{boundTask.dirName} · {boundTask.record?.status ?? '状态未知'} · {boundTask.phase}</button>}</div>
          <div ref={streamRef} className="my-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 [scrollbar-gutter:stable]" onScroll={(event) => {
            const element = event.currentTarget, follow = element.scrollHeight - element.scrollTop - element.clientHeight < 48
            followRef.current = follow; setAtBottom(follow)
            writeSessionView(root, activeSession.sessionId, { scrollTop: element.scrollTop, follow })
          }}>
            <StartupGroup session={activeSession} />
            {activeSession.error && <p role="alert" className="rounded-my-md border border-my-line-danger bg-my-danger-subtle px-3 py-2 text-my-xs text-my-danger-text">{activeSession.error}</p>}
            {activeSession.directoryLeaseReason && <p className="rounded-my-md bg-my-warning-subtle px-3 py-2 text-my-xs text-my-warning-text">目录占用：{activeSession.directoryLeaseReason}</p>}
            {!isLiveStatus(activeSession.status) && <p className="rounded-my-md bg-my-layer-1 px-3 py-2 text-my-xs text-my-secondary">{activeSession.restorePending ? '已载入历史，发送时验证恢复。尚未确认远端连接；恢复失败会保留历史。' : activeSession.historyKind === 'legacy' || activeSession.status === 'legacy' ? '旧版会话只有本地记录，不能恢复远端身份。' : activeSession.canResume ? '当前为历史阅读。选择恢复原会话后，发送时验证原生连接。' : '当前为只读历史；该 Runtime 未提供可用的原生恢复。新会话不会自动重放历史。'}</p>}
            {items.map((item) => <EventRow key={item.key} item={item} pendingPerm={pendingPerm} permissionPending={permissionPending} permissionErrors={permissionErrors} onRespond={respondPerm} onOpenTask={(directory) => { setPage('tasks'); showTask(directory) }} onOpenArtifact={openArtifact} onOpenSpec={() => setPage('spec')} onOpenJira={() => setPage('jira')} />)}
            {items.length === 0 && <p className="py-10 text-center text-my-xs text-my-tertiary">{activeSession.status === 'starting' ? '正在准备环境，请等待会话就绪。' : '尚无消息。指令和材料会在显式发送时交给 Agent。'}</p>}
          </div>
          {!atBottom && <div className="flex justify-center py-1"><Button size="sm" variant="outline" onClick={() => { const element = streamRef.current; followRef.current = true; setAtBottom(true); if (element) element.scrollTop = element.scrollHeight; writeSessionView(root, activeSession.sessionId, { follow: true }) }}><ArrowDown size={12} /> 回到最新</Button></div>}
          <footer className="border-t border-my-line p-3">
            {feedback[activeSession.sessionId] && <p role={feedback[activeSession.sessionId].error ? 'alert' : 'status'} className={clsx('mb-2 break-words text-my-2xs', feedback[activeSession.sessionId].error ? 'text-my-danger-text' : 'text-my-tertiary')}>{feedback[activeSession.sessionId].text}</p>}
            <div className="flex items-end gap-2"><textarea aria-label="Agent 指令" className="min-h-[58px] min-w-0 flex-1 resize-none rounded-my-md border border-my-line bg-my-surface-1 px-3 py-2 text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent disabled:opacity-50" rows={2} value={input} disabled={!isLiveStatus(activeSession.status) && !activeSession.restorePending} placeholder={canSend(activeSession) ? activeSession.restorePending ? '输入指令，发送时验证原会话恢复' : '输入指令，Enter 发送 / Shift+Enter 换行' : isLiveStatus(activeSession.status) ? '可先写下一条草稿，就绪后手动发送；不会自动排队' : '只读历史，可恢复原会话或创建新会话'} onChange={(event) => changeDraft(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send() }
            }} /><Button variant="primary" title="发送指令" disabled={!canSend(activeSession) || Boolean(sending[activeSession.sessionId]) || !input.trim()} onClick={() => void send()}>{sending[activeSession.sessionId] ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}</Button></div>
            {!canSend(activeSession) && isLiveStatus(activeSession.status) && <p className="mt-1 text-my-2xs text-my-tertiary">草稿仅保存在当前会话；等待就绪后手动发送。</p>}
          </footer>
        </>}
      </section>}
      {view === 'conversation' && activeSession && <aside className="my-card my-scrollbar hidden w-64 shrink-0 space-y-4 overflow-y-auto p-4 min-[1500px]:block"><SessionDetails key={activeSession.sessionId} session={activeSession} isCurrent={isCurrent} onUpdated={updateSession} /><ObservationPanel workspaceId={root} variant="compact" activity={{ taskRecord: boundTask ? { status: boundTask.record?.status ?? null, updatedAtMs: null } : null, events: activityEvents, archive: { archived: false, repoRelativeDir: null }, taskDir: boundTask?.dirName ?? null }} /></aside>}
    </div>
    <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} width={520}><div role="dialog" aria-modal="true" aria-label="最近会话" className="flex max-h-[70vh] max-w-[92vw] flex-col"><header className="flex items-center border-b border-my-line p-3"><span className="flex-1 text-my-sm text-my-primary">当前项目的最近会话</span><Button size="sm" variant="ghost" title="关闭最近会话" onClick={() => setHistoryOpen(false)}><X size={14} /></Button></header>{sessionList}</div></Modal>
    <Modal open={runtimeOpen} onClose={() => setRuntimeOpen(false)} width={660}><div role="dialog" aria-modal="true" aria-label="Runtime 设置" className="my-scrollbar max-h-[70vh] max-w-[92vw] space-y-4 overflow-y-auto p-4"><div className="flex justify-end"><Button variant="ghost" size="sm" title="关闭 Runtime 设置" onClick={() => setRuntimeOpen(false)}><X size={14} /></Button></div><RuntimePanel agents={agents} onChange={setAgents} isCurrent={isCurrent} /><Button size="sm" variant="ghost" onClick={() => { setRuntimeOpen(false); setPage('settings') }}>管理自定义 Runtime 命令</Button></div></Modal>
    <Modal open={detailOpen && activeSession !== null} onClose={() => setDetailOpen(false)} width={560}><div role="dialog" aria-modal="true" aria-label="会话配置与材料" className="my-scrollbar max-h-[70vh] max-w-[92vw] overflow-y-auto p-4"><div className="mb-3 flex justify-end"><Button variant="ghost" size="sm" title="关闭会话配置" onClick={() => setDetailOpen(false)}><X size={14} /></Button></div>{activeSession && <SessionDetails key={activeSession.sessionId} session={activeSession} isCurrent={isCurrent} onUpdated={updateSession} />}</div></Modal>
    {editor && <ProfileEditor key={editor.id} initial={editor} isNew={!profiles.some((profile) => profile.id === editor.id)} agents={agents} root={root} isCurrent={isCurrent} onClose={() => setEditor(null)} onSaved={(profile) => { setProfiles((previous) => [...previous.filter((item) => item.id !== profile.id), profile]); setEditor(null); pushToast({ kind: 'success', title: 'Agent 配置已保存' }) }} onDeleted={(id) => { setProfiles((previous) => previous.filter((item) => item.id !== id)); setEditor(null) }} />}
    {jiraOpen && <JiraPickerModal isCurrent={isCurrent} onClose={() => setJiraOpen(false)} onStarted={(id) => { if (!isCurrent()) return; scope.sessionIds.add(id); setJiraOpen(false); selectSession(id); void reloadSessions() }} />}
  </div>
}
