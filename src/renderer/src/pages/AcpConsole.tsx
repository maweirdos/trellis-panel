/**
 * ACP Agent 控制台（10-09-acp-agent-console）。
 *
 * 双轨混排：agent 轨道（回复流 / 思考折叠 / 工具卡 / 权限卡）与 trellis 轨道
 * （任务流转 / 文档创建 / spec 注入·更新 / Jira 同步卡片）在同一时间线渲染。
 * 工单人工审查流：「从 Jira 选工单」→ 查询列表 → 点选导入（jiraKey 防重）→
 * 以该任务开新会话；全程人工点选，无自动触发。
 * 卡片信号只信主进程第一方 TimelineEvent，不解析 agent 输出语义。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  CircleStop,
  FileText,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  ShieldQuestion,
  Sparkles,
  Workflow,
  X
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import type {
  AcpAgentStatus,
  AcpPermissionPayload,
  AcpSessionRecord,
  JiraIssue,
  TimelineEvent
} from '../../../shared/types'
import type { JSX } from 'react'

/* ---------------- 渲染条目编译：连续 message/thought 合并、tool_call 就地更新 ---------------- */

interface ToolItemState {
  toolCallId: string
  title: string
  status: string
  preview?: string
}

type RenderItem =
  | { type: 'user'; key: string; text: string }
  | { type: 'agent'; key: string; text: string }
  | { type: 'thought'; key: string; text: string }
  | { type: 'tool'; key: string; tool: ToolItemState }
  | { type: 'perm'; key: string; ev: TimelineEvent }
  | { type: 'status'; key: string; text: string }
  | { type: 'turn'; key: string; text: string }
  | { type: 'trellis'; key: string; ev: TimelineEvent }

function compileItems(events: TimelineEvent[]): RenderItem[] {
  const items: RenderItem[] = []
  const toolIndex = new Map<string, number>()
  for (const ev of events) {
    const key = ev.id
    if (ev.source === 'trellis') {
      items.push({ type: 'trellis', key, ev })
      continue
    }
    switch (ev.kind) {
      case 'message': {
        const role = String(ev.payload?.role ?? '')
        const last = items[items.length - 1]
        if (role === 'user') {
          items.push({ type: 'user', key, text: ev.text ?? '' })
        } else if (last?.type === 'agent') {
          last.text += ev.text ?? ''
        } else {
          items.push({ type: 'agent', key, text: ev.text ?? '' })
        }
        break
      }
      case 'thought': {
        const last = items[items.length - 1]
        if (last?.type === 'thought') last.text += ev.text ?? ''
        else items.push({ type: 'thought', key, text: ev.text ?? '' })
        break
      }
      case 'tool-call': {
        const toolCallId = String(ev.payload?.toolCallId ?? key)
        const state: ToolItemState = {
          toolCallId,
          title: ev.text ?? '工具调用',
          status: String(ev.payload?.status ?? ''),
          preview: typeof ev.payload?.preview === 'string' ? ev.payload.preview : undefined
        }
        const at = toolIndex.get(toolCallId)
        if (at !== undefined && items[at]?.type === 'tool') items[at].tool = state
        else {
          toolIndex.set(toolCallId, items.length)
          items.push({ type: 'tool', key, tool: state })
        }
        break
      }
      case 'permission':
        items.push({ type: 'perm', key, ev })
        break
      case 'turn-done':
        items.push({ type: 'turn', key, text: ev.text ?? '' })
        break
      default:
        // session-status 等
        items.push({ type: 'status', key, text: ev.text ?? '' })
    }
  }
  return items
}

/* ---------------- 页面 ---------------- */

const TRELLIS_ICON: Record<string, JSX.Element> = {
  'task-status': <Workflow size={13} />,
  'doc-created': <FileText size={13} />,
  'spec-injected': <Sparkles size={13} />,
  'spec-updated': <Sparkles size={13} />,
  'jira-sync': <GitBranch size={13} />
}

const STATUS_COLOR: Record<string, string> = {
  starting: 'text-amber-300',
  ready: 'text-leaf',
  busy: 'text-sky-300',
  error: 'text-rose-300',
  closed: 'text-mist-500'
}

export function AcpConsolePage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const pushToast = useApp((s) => s.pushToast)
  const setPage = useApp((s) => s.setPage)
  const showTask = useApp((s) => s.showTask)
  const openArtifact = useApp((s) => s.openArtifact)

  const [agents, setAgents] = useState<AcpAgentStatus[]>([])
  const [sessions, setSessions] = useState<AcpSessionRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [events, setEvents] = useState<Record<string, TimelineEvent[]>>({})
  const [pendingPerm, setPendingPerm] = useState<Record<string, AcpPermissionPayload>>({})
  const [input, setInput] = useState('')
  const [creating, setCreating] = useState(false)
  const [jiraOpen, setJiraOpen] = useState(false)

  const streamRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef(true)
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const root = snapshot?.meta.root ?? ''

  const activeSession = useMemo(() => sessions.find((s) => s.sessionId === activeId) ?? null, [sessions, activeId])
  const activeEvents = useMemo(() => (activeId ? events[activeId] ?? [] : []), [events, activeId])
  const items = useMemo(() => compileItems(activeEvents), [activeEvents])

  const reloadSessions = useCallback(async (): Promise<void> => {
    const res = await api.acpSessions()
    if (res.ok && res.sessions) {
      setSessions(res.sessions)
      setEvents((prev) => {
        const next = { ...prev }
        for (const s of res.sessions!) {
          // 活跃会话以内存事件为准（liveEvents 已包含），仅恢复历史会话时灌入记录
          if (next[s.sessionId]) continue
          next[s.sessionId] = s.events ?? []
        }
        return next
      })
      setActiveId((cur) => cur ?? res.sessions!.find((s) => s.status !== 'closed' && s.status !== 'error')?.sessionId ?? res.sessions![0]?.sessionId ?? null)
    }
  }, [])

  useEffect(() => {
    void api.acpAgents().then((res) => {
      if (res.ok && res.agents) setAgents(res.agents)
    })
    void reloadSessions()
  }, [reloadSessions])

  useEffect(() => {
    const offOut = api.onAcpOutput((ev) => {
      if (!root || ev.projectRoot !== root) return
      if (!ev.sessionId) {
        // trellis 轨道（无 sessionId）：追加进所有本项目未结束会话视图
        setEvents((prev) => {
          const next = { ...prev }
          for (const s of sessionsRef.current) {
            if (s.status === 'closed' || s.status === 'error') continue
            next[s.sessionId] = [...(next[s.sessionId] ?? []), ev]
          }
          return next
        })
        return
      }
      const sid = ev.sessionId
      setEvents((prev) => ({ ...prev, [sid]: [...(prev[sid] ?? []), ev] }))
    })
    const offPerm = api.onAcpPermission((p) => setPendingPerm((prev) => ({ ...prev, [p.requestId]: p })))
    const offDone = api.onAcpDone((e) => {
      setSessions((prev) => prev.map((s) => (s.sessionId === e.sessionId ? { ...s, status: e.status, error: e.error } : s)))
    })
    return () => {
      offOut()
      offPerm()
      offDone()
    }
  }, [root])

  // 流式自动滚动（用户上翻时暂停）
  useEffect(() => {
    const el = streamRef.current
    if (el && liveRef.current) el.scrollTop = el.scrollHeight
  }, [items.length])

  const newSession = useCallback(
    async (agentId: string, taskDir?: string): Promise<void> => {
      setCreating(true)
      try {
        const res = await api.acpSessionNew({ agentId, taskDir })
        if (res.ok && res.sessionId) {
          setEvents((prev) => ({ ...prev, [res.sessionId!]: [] }))
          setActiveId(res.sessionId)
          await reloadSessions()
        } else {
          pushToast({ kind: 'error', title: '会话创建失败', body: res.error ?? '' })
        }
      } finally {
        setCreating(false)
      }
    },
    [pushToast, reloadSessions]
  )

  const send = useCallback(async (): Promise<void> => {
    if (!activeId || !input.trim() || !activeSession) return
    if (activeSession.status !== 'ready' && activeSession.status !== 'busy') return
    const text = input.trim()
    setInput('')
    const res = await api.acpSessionPrompt(activeId, text)
    if (!res.ok) pushToast({ kind: 'error', title: '发送失败', body: res.error ?? '' })
  }, [activeId, input, activeSession, pushToast])

  const respondPerm = useCallback(
    async (requestId: string, optionId: string): Promise<void> => {
      const res = await api.acpPermissionRespond(requestId, optionId)
      if (!res.ok) pushToast({ kind: 'error', title: '权限响应失败', body: res.error ?? '' })
    },
    [pushToast]
  )

  const boundTask = useMemo(
    () => (activeSession?.taskDir ? snapshot?.tasks.find((t) => t.dirName === activeSession.taskDir) ?? null : null),
    [activeSession, snapshot]
  )

  /* ---------------- 渲染 ---------------- */

  const availableAgents = agents.filter((a) => a.enabled && a.available)

  return (
    <div className="flex h-full min-h-0 gap-3 p-3">
      {/* 会话列表 */}
      <aside className="card flex w-60 shrink-0 flex-col overflow-hidden">
        <div className="border-b border-mist-700/40 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-mist-300">
            <Bot size={14} /> Agent 会话
          </div>
          <div className="mt-2 flex gap-1.5">
            <select
              className="field flex-1 text-xs"
              defaultValue=""
              disabled={creating || availableAgents.length === 0}
              onChange={(e) => {
                if (e.target.value) void newSession(e.target.value)
                e.currentTarget.selectedIndex = 0
              }}
            >
              <option value="">{creating ? '创建中…' : availableAgents.length === 0 ? '无可用 agent（设置页配置）' : '＋ 新会话…'}</option>
              {availableAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button className="btn-ghost px-2 py-1" title="刷新" onClick={() => void reloadSessions()}>
              <RefreshCw size={13} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {sessions.length === 0 && <div className="px-2 py-6 text-center text-xs text-mist-500">尚无会话。右上选择 agent 开始。</div>}
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              onClick={() => setActiveId(s.sessionId)}
              className={clsx(
                'mb-1 w-full rounded-md px-2.5 py-2 text-left transition-colors',
                s.sessionId === activeId ? 'bg-leaf/15 text-mist-100' : 'text-mist-300 hover:bg-mist-700/30'
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-xs font-medium">{s.title ?? `${s.agentName} 会话`}</span>
                <span className={clsx('shrink-0 text-[10px]', STATUS_COLOR[s.status])}>{s.status}</span>
              </div>
              <div className="mt-0.5 truncate text-[10px] text-mist-500">
                {s.agentName}
                {s.taskDir ? ` · ${s.taskDir}` : ''}
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* 会话主体 */}
      <section className="card flex min-w-0 flex-1 flex-col overflow-hidden">
        {!activeSession ? (
          <div className="flex flex-1 items-center justify-center text-sm text-mist-500">
            选择左侧会话，或从 Jira 选一个工单开始
          </div>
        ) : (
          <>
            <header className="flex items-center gap-2 border-b border-mist-700/40 px-4 py-2.5">
              <span className="truncate text-sm font-medium">{activeSession.title ?? activeSession.agentName}</span>
              <span className={clsx('rounded px-1.5 py-0.5 text-[10px]', STATUS_COLOR[activeSession.status])}>
                {activeSession.status}
              </span>
              {boundTask && (
                <button
                  className="chip border border-sky-400/40 bg-sky-500/10 text-sky-300"
                  onClick={() => {
                    setPage('tasks')
                    showTask(boundTask.dirName)
                  }}
                  title="在任务看板打开"
                >
                  📌 {boundTask.dirName} · {boundTask.record?.status ?? boundTask.phase}
                </button>
              )}
              <div className="flex-1" />
              {activeSession.status === 'busy' && (
                <button className="btn-ghost text-xs" onClick={() => void api.acpSessionCancel(activeSession.sessionId)}>
                  <CircleStop size={13} /> 中止本轮
                </button>
              )}
              {(activeSession.status === 'error' || activeSession.status === 'closed') && (
                <button
                  className="btn-ghost text-xs"
                  onClick={() => void newSession(activeSession.agentId, activeSession.taskDir)}
                  title="同 agent 重开会话"
                >
                  <Plus size={13} /> 重开
                </button>
              )}
              {activeSession.status !== 'closed' && activeSession.status !== 'error' && (
                <button
                  className="btn-ghost text-xs text-rose-300"
                  onClick={() => void api.acpSessionKill(activeSession.sessionId)}
                  title="结束进程树"
                >
                  <X size={13} /> 结束
                </button>
              )}
            </header>

            <div
              ref={streamRef}
              className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3"
              onScroll={(e) => {
                const el = e.currentTarget
                liveRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
              }}
            >
              {activeSession.error && (
                <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                  ⚠ {activeSession.error}
                </div>
              )}
              {items.map((item) => (
                <EventRow key={item.key} item={item} pendingPerm={pendingPerm} onRespond={respondPerm} onOpenTask={(d) => { setPage('tasks'); showTask(d) }} onOpenArtifact={openArtifact} onOpenSpec={() => setPage('spec')} onOpenJira={() => setPage('jira')} />
              ))}
              {items.length === 0 && (
                <div className="py-10 text-center text-xs text-mist-500">
                  会话已就绪。发一条指令试试，例如「按 .trellis/workflow.md 推进当前任务」。
                </div>
              )}
            </div>

            <footer className="border-t border-mist-700/40 p-2.5">
              <div className="flex items-end gap-2">
                <textarea
                  className="field min-h-[42px] flex-1 resize-none text-sm"
                  rows={2}
                  placeholder={activeSession.status === 'busy' ? '运行中…可先输入，回合结束后发送' : '输入指令，Enter 发送 / Shift+Enter 换行'}
                  value={input}
                  disabled={activeSession.status !== 'ready'}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                <button className="btn-primary" disabled={activeSession.status !== 'ready' || !input.trim()} onClick={() => void send()}>
                  {activeSession.status === 'busy' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                </button>
              </div>
            </footer>
          </>
        )}
      </section>

      {/* 工单人工审查流入口 */}
      <aside className="flex w-44 shrink-0 flex-col gap-2">
        <button className="card flex items-center gap-2 px-3 py-3 text-left text-xs text-mist-200 hover:border-sky-400/40" onClick={() => setJiraOpen(true)}>
          <GitBranch size={15} className="text-sky-300" />
          <span>从 Jira 选工单开始</span>
        </button>
        <div className="card px-3 py-2.5 text-[10px] leading-relaxed text-mist-500">
          人工审查流：查询工单 → 点选导入（jiraKey 防重）→ 以该任务开新会话。无自动触发。
          <br />
          trellis 卡片（任务流转 / 文档 / spec / Jira）会实时混排在对话流里。
        </div>
      </aside>

      {jiraOpen && (
        <JiraPickerModal
          onClose={() => setJiraOpen(false)}
          onStarted={(sessionId) => {
            setJiraOpen(false)
            setActiveId(sessionId)
          }}
        />
      )}
    </div>
  )
}

/* ---------------- 单条事件渲染 ---------------- */

function EventRow(props: {
  item: RenderItem
  pendingPerm: Record<string, AcpPermissionPayload>
  onRespond: (requestId: string, optionId: string) => void
  onOpenTask: (dirName: string) => void
  onOpenArtifact: (f: { name: string; path: string; kind: 'file'; size: number; mtime: number; ext: string }) => void
  onOpenSpec: () => void
  onOpenJira: () => void
}): JSX.Element {
  const { item, pendingPerm, onRespond, onOpenTask, onOpenArtifact, onOpenSpec, onOpenJira } = props
  if (item.type === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-leaf/20 px-3 py-2 text-sm text-mist-100">{item.text}</div>
      </div>
    )
  }
  if (item.type === 'agent') {
    return (
      <div className="max-w-[92%] whitespace-pre-wrap rounded-lg bg-mist-700/30 px-3 py-2 text-sm leading-relaxed text-mist-100">{item.text}</div>
    )
  }
  if (item.type === 'thought') {
    return (
      <details className="max-w-[92%] rounded-md border border-mist-700/40 px-3 py-1.5 text-xs text-mist-400">
        <summary className="cursor-pointer select-none opacity-70">💭 思考过程</summary>
        <div className="mt-1 whitespace-pre-wrap">{item.text}</div>
      </details>
    )
  }
  if (item.type === 'tool') {
    const st = item.tool.status
    return (
      <div className="flex items-center gap-2 rounded-md border border-mist-700/40 bg-mist-800/30 px-3 py-1.5 font-mono text-xs text-mist-300">
        {st === 'completed' ? <span className="text-leaf">✓</span> : st === 'failed' ? <span className="text-rose-300">✗</span> : <Loader2 size={12} className="animate-spin" />}
        <span className="truncate">🔧 {item.tool.title}</span>
        <span className="shrink-0 text-[10px] text-mist-500">{st}</span>
        {item.tool.preview && <span className="truncate text-[10px] text-mist-500">{item.tool.preview}</span>}
      </div>
    )
  }
  if (item.type === 'perm') {
    const requestId = String(item.ev.payload?.requestId ?? '')
    const pending = requestId ? pendingPerm[requestId] : undefined
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
        <div className="flex items-center gap-1.5 font-medium text-amber-200">
          <ShieldQuestion size={13} /> {pending?.toolCall?.title ?? item.ev.text ?? '权限请求'}
        </div>
        {pending ? (
          <div className="mt-2 flex gap-1.5">
            {pending.options.map((o) => (
              <button
                key={o.optionId}
                className={clsx(
                  'rounded px-2 py-1 text-[11px] transition-colors',
                  o.kind === 'reject_once' ? 'border border-rose-400/40 text-rose-300 hover:bg-rose-500/20' : 'border border-leaf/40 text-leaf hover:bg-leaf/20'
                )}
                onClick={() => onRespond(pending.requestId, o.optionId)}
              >
                {o.name}
              </button>
            ))}
            <span className="self-center text-[10px] text-mist-500">120s 超时自动拒绝</span>
          </div>
        ) : (
          <div className="mt-1 text-mist-400">{item.ev.text}</div>
        )}
      </div>
    )
  }
  if (item.type === 'status') {
    return <div className="px-1 font-mono text-[10px] text-mist-500">{item.text}</div>
  }
  if (item.type === 'turn') {
    return <div className="flex items-center gap-2 px-1 py-1 text-[10px] text-mist-600"><span className="h-px flex-1 bg-mist-700/40" />{item.text}<span className="h-px flex-1 bg-mist-700/40" /></div>
  }
  // trellis 卡片
  const ev = item.ev
  const icon = TRELLIS_ICON[ev.kind] ?? <Sparkles size={13} />
  const taskDir = ev.taskDir ?? (ev.payload?.taskDir as string | undefined)
  const filePath = ev.payload?.path as string | undefined
  return (
    <div className="flex w-fit max-w-full items-center gap-2 rounded-md border border-sky-400/25 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-200">
      {icon}
      <span className="truncate">{ev.text}</span>
      {ev.kind === 'task-status' && taskDir && (
        <button className="shrink-0 text-[10px] text-sky-300 underline underline-offset-2" onClick={() => onOpenTask(taskDir)}>
          查看任务
        </button>
      )}
      {ev.kind === 'doc-created' && filePath && (
        <button
          className="shrink-0 text-[10px] text-sky-300 underline underline-offset-2"
          onClick={() =>
            onOpenArtifact({
              name: String(ev.payload?.file ?? 'artifact.md'),
              path: filePath,
              kind: 'file',
              size: 0,
              mtime: ev.ts,
              ext: (String(ev.payload?.file ?? '.md').split('.').pop() ?? 'md').toLowerCase()
            })
          }
        >
          阅读
        </button>
      )}
      {(ev.kind === 'spec-injected' || ev.kind === 'spec-updated') && (
        <button className="shrink-0 text-[10px] text-sky-300 underline underline-offset-2" onClick={onOpenSpec}>
          规范页
        </button>
      )}
      {ev.kind === 'jira-sync' && (
        <button className="shrink-0 text-[10px] text-sky-300 underline underline-offset-2" onClick={onOpenJira}>
          Jira
        </button>
      )}
    </div>
  )
}

/* ---------------- 工单选择器（人工审查流） ---------------- */

const JQL_PRESETS = [
  { label: '我的待办', jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC' },
  { label: '近期更新', jql: 'ORDER BY updated DESC' }
]

function JiraPickerModal(props: { onClose: () => void; onStarted: (sessionId: string) => void }): JSX.Element {
  const { onClose, onStarted } = props
  const snapshot = useApp((s) => s.snapshot)
  const settings = useApp((s) => s.settings)
  const pushToast = useApp((s) => s.pushToast)
  const [issues, setIssues] = useState<JiraIssue[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState<string | null>(null)
  const [agentId, setAgentId] = useState('')
  const [agents, setAgents] = useState<AcpAgentStatus[]>([])

  useEffect(() => {
    void api.acpAgents().then((res) => {
      if (res.ok && res.agents) {
        const ok = res.agents.filter((a) => a.enabled && a.available)
        setAgents(ok)
        setAgentId((cur) => cur || ok[0]?.id || '')
      }
    })
  }, [])

  const search = useCallback(
    async (jql: string): Promise<void> => {
      const cfg = settings?.jira
      if (!cfg?.baseUrl) {
        pushToast({ kind: 'error', title: '未配置 Jira', body: '设置页先完成 Jira 连接' })
        return
      }
      setLoading(true)
      try {
        const res = await api.jiraSearch(cfg, jql)
        if (res.ok && res.issues) setIssues(res.issues.slice(0, 20))
        else pushToast({ kind: 'error', title: '工单查询失败', body: res.error ?? '' })
      } finally {
        setLoading(false)
      }
    },
    [settings, pushToast]
  )

  useEffect(() => {
    void search(JQL_PRESETS[0].jql)
  }, [search])

  const startWith = useCallback(
    async (issue: JiraIssue): Promise<void> => {
      if (!agentId) {
        pushToast({ kind: 'error', title: '无可用 agent', body: '设置页启用一个 ACP agent' })
        return
      }
      setImporting(issue.key)
      try {
        // ① 导入为 Trellis 任务（jiraKey 防重；已存在时直接复用）
        let dirName: string | null = null
        const existing = snapshot?.tasks.find((t) => String(t.record?.meta?.jiraKey ?? '').toUpperCase() === issue.key.toUpperCase())
        if (existing) {
          dirName = existing.dirName
        } else {
          const res = await api.createTaskFromJira({
            dirName: `${issue.key.toLowerCase()}-${issue.summary.slice(0, 20).replace(/[^\w\u4e00-\u9fa5-]+/g, '-')}`,
            title: `[${issue.key}] ${issue.summary}`,
            description: `${issue.summary}\n\n来源：${issue.url}`,
            status: 'planning',
            priority: issue.priority || 'P2',
            assignee: snapshot?.meta.developer ?? '',
            jiraKey: issue.key,
            jiraUrl: issue.url
          })
          if (res.ok && res.dirName) dirName = res.dirName
          else {
            // jiraKey 防重命中时 error 文案含「已关联」
            pushToast({ kind: (res.error ?? '').includes('已关联') ? 'info' : 'error', title: '导入结果', body: res.error ?? '' })
            return
          }
        }
        // ② 以该任务开新 ACP 会话（人工下达推进指令，无自动派发）
        const s = await api.acpSessionNew({ agentId, taskDir: dirName ?? undefined })
        if (s.ok && s.sessionId) {
          pushToast({ kind: 'success', title: '已就绪', body: `任务 ${dirName} 会话已建立，请下达指令` })
          onStarted(s.sessionId)
        } else {
          pushToast({ kind: 'error', title: '会话创建失败', body: s.error ?? '' })
        }
      } finally {
        setImporting(null)
      }
    },
    [agentId, snapshot, pushToast, onStarted]
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div className="card max-h-[80vh] w-[640px] max-w-full overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-mist-700/40 px-4 py-3">
          <GitBranch size={15} className="text-sky-300" />
          <span className="text-sm font-medium">从 Jira 选工单开始</span>
          <div className="flex-1" />
          <select className="field w-44 text-xs" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button className="btn-ghost px-2 py-1" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="flex gap-1.5 border-b border-mist-700/40 px-4 py-2">
          {JQL_PRESETS.map((p) => (
            <button key={p.label} className="chip border border-mist-600/40 text-mist-300 hover:border-sky-400/40" disabled={loading} onClick={() => void search(p.jql)}>
              {p.label}
            </button>
          ))}
          {loading && <Loader2 size={13} className="animate-spin self-center text-mist-400" />}
        </div>
        <div className="max-h-[52vh] overflow-y-auto p-2">
          {issues.length === 0 && !loading && <div className="py-8 text-center text-xs text-mist-500">无工单</div>}
          {issues.map((it) => (
            <button
              key={it.key}
              disabled={importing !== null}
              onClick={() => void startWith(it)}
              className="mb-1 flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-mist-700/30 disabled:opacity-50"
            >
              <span className="shrink-0 font-mono text-xs text-sky-300">{it.key}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-mist-100">{it.summary}</span>
              <span className="shrink-0 text-[10px] text-mist-500">{it.status}</span>
              {importing === it.key && <Loader2 size={12} className="animate-spin" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
