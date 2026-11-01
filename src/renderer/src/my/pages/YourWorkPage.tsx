import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type JSX } from 'react'
import { ArrowUpRight, BookOpen, Bot, Check, CheckCircle2, Clock3, FileText, GitBranch, Inbox, ListTodo, Loader2, MessageSquare, MoreHorizontal, Plus, RefreshCw, Star, Terminal, Users, X, type LucideIcon } from 'lucide-react'
import { useApp } from '../../store'
import { api, hasIpc } from '../../api'
import { Select } from '../../components/Select'
import { relTime } from '../../utils/format'
import { relativePathUnderRoot } from '../../reader/reader-paths'
import { priorityFromTask, statusToStateId } from '../adapter'
import { useMy } from '../store'
import { Button, Dropdown, DropdownItem, Modal, SearchInput } from '../ui'
import { PriorityIcon, StateGroupIcon } from '../icons'
import { clearPersonalHistory, rememberVisit, usePersonalHistory, type PersonalVisit } from '../personal-history'
import type { Priority, WorkItemState } from '../types'
import { PAGE_LAYOUTS, PageBody, PageContent, PageLayout } from '../layout/PageLayout'
import type { FileEntry, TaskInfo } from '../../../../shared/types'
import { errorMessage } from '../../../../shared/errors'
import { TaskConversationEntry } from '../components/TaskConversationEntry'
import { TaskConversationAssociationModal } from '../components/TaskConversationAssociationModal'
import { TaskContinuationModal } from '../components/TaskContinuationModal'
import { TASK_CONVERSATION_SOURCE_LABELS, taskConversationDirectory, useTaskConversations, type TaskConversationController } from '../use-task-conversations'
import { useInteractionActive, useInteractionGuard } from '../../utils/interaction-scope'
import { changeContext, newDraft, PERSONAL, readArchive, selectArchive, useConversations } from '../../conversations/workspace'

type HomeView = 'assigned' | 'created' | 'favorites' | 'completed'
type StatusFilter = 'open' | 'all' | 'ready' | 'active' | 'review' | 'completed'
type TaskOrder = 'priority' | 'updated'
type StatusTone = 'neutral' | 'info' | 'warning' | 'success'

export interface HomeTask {
  id: string
  title: string
  description: string
  path: string | null
  stateId: string
  priority: Priority
  assignee: string | null
  creator: string | null
  updatedAt: number | null
  completedAt: string | null
  archived: boolean
  jiraKey: string | null
  pkg: string | null
  scope: string | null
  branch: string | null
  artifacts: FileEntry[]
}

const TASK_LIMIT = 8
const PRIORITY_ORDER: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }
const PRIORITY_LABELS: Record<Priority, string> = { urgent: '紧急', high: '高', medium: '中', low: '低', none: '无' }
const VISIT_LABELS = { task: '任务', document: '文档', agent: '对话', chat: '问答' }
const VISIT_ICONS = { task: ListTodo, document: BookOpen, agent: Bot, chat: MessageSquare }
const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'open', label: '未结束' },
  { value: 'all', label: '全部状态' },
  { value: 'ready', label: '待推进' },
  { value: 'active', label: '进行中' },
  { value: 'review', label: '待评审' },
  { value: 'completed', label: '已完成' }
]

function buildHomeTask(task: TaskInfo, archived: boolean): HomeTask {
  return {
    id: task.dirName,
    title: task.record?.title || task.dirName,
    description: task.record?.description || '',
    path: task.path,
    stateId: statusToStateId(task.record?.status),
    priority: priorityFromTask(task.record?.priority),
    assignee: task.record?.assignee || null,
    creator: task.record?.creator || null,
    updatedAt: task.updatedAt,
    completedAt: task.record?.completedAt || null,
    archived,
    jiraKey: task.jiraKey ?? null,
    pkg: task.record?.package ?? null,
    scope: task.record?.scope ?? null,
    branch: task.record?.branch ?? null,
    artifacts: task.artifacts ?? []
  }
}

function matchesStatus(task: HomeTask, filter: StatusFilter, states: Map<string, WorkItemState>): boolean {
  const group = states.get(task.stateId)?.group
  switch (filter) {
    case 'all': return true
    case 'open': return !task.archived && group !== 'completed' && group !== 'cancelled'
    case 'ready': return !task.archived && (group === 'backlog' || group === 'unstarted' || group === undefined)
    case 'active': return !task.archived && group === 'started' && task.stateId !== 'st-review'
    case 'review': return !task.archived && task.stateId === 'st-review'
    case 'completed': return group === 'completed'
  }
}

function taskStatus(task: HomeTask, state?: WorkItemState): { label: string; tone: StatusTone } {
  if (task.archived) return { label: '已归档', tone: 'neutral' }
  const tone = state?.group === 'completed' ? 'success'
    : task.stateId === 'st-review' ? 'warning'
      : state?.group === 'started' ? 'info' : 'neutral'
  return { label: state?.name ?? '状态未记录', tone }
}

function completedInWeek(task: HomeTask, now: Date, states: Map<string, WorkItemState>): boolean {
  if (!task.completedAt || !matchesStatus(task, 'completed', states)) return false
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(task.completedAt)
  const completed = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime() : new Date(task.completedAt).getTime()
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime()
  return Number.isFinite(completed) && completed >= weekStart && completed <= now.getTime()
}

function greetingByHour(hour: number): string {
  if (hour < 6) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

function SummaryCard({ label, value, unit, note, icon: Icon }: {
  label: string; value: number; unit: string; note: string; icon: LucideIcon
}): JSX.Element {
  return <article className="my-home-pulse-card">
    <div className="my-home-pulse-top"><h2 className="my-home-pulse-label">{label}</h2><Icon size={14} className="text-my-icon-tertiary" /></div>
    <div className="my-home-pulse-value-row"><span className="my-home-pulse-value">{value}</span><span className="my-home-pulse-unit">{unit}</span></div>
    <p className="my-home-pulse-hint">{note}</p>
  </article>
}

/** One task to return to. The banner never filters or advances a workflow. */
function ContinueTaskBar({ task, source, state, onInspect }: {
  task: HomeTask; source: 'binding' | 'history'; state?: WorkItemState; onInspect: (task: HomeTask) => void
}): JSX.Element {
  const status = taskStatus(task, state)
  return <section className="my-home-spotlight" aria-label="继续任务">
    <div className="my-home-spotlight-identity">
      <span className="my-home-spotlight-tag">{source === 'binding' ? '当前绑定' : '上次访问'}</span>
      <h2 className="my-home-spotlight-title" title={task.title}>{task.title}</h2>
      <span className="my-home-status-pill" data-tone={status.tone}>{status.label}</span>
    </div>
    <Button variant="neutral" size="sm" onClick={() => onInspect(task)}>打开任务<ArrowUpRight size={13} /></Button>
  </section>
}

/** The open and favorite actions are sibling buttons, including for keyboard users. */
function CleanTaskRow({ task, state, favorite, onInspect, onToggleFavorite, conversations, projectRoot, onInstructions }: {
  task: HomeTask; state?: WorkItemState; favorite: boolean; onInspect: (task: HomeTask) => void; onToggleFavorite: (id: string) => void
  conversations: TaskConversationController; projectRoot: string; onInstructions: (task: HomeTask) => void
}): JSX.Element {
  const status = taskStatus(task, state)
  const scope = task.scope || task.pkg || task.jiraKey
  const completed = task.completedAt ? new Date(task.completedAt) : null
  const showCompletion = (task.archived || state?.group === 'completed') && completed && Number.isFinite(completed.getTime())
  const updatedAt = task.updatedAt && Number.isFinite(task.updatedAt) ? task.updatedAt : null
  const timeText = showCompletion && completed ? completed.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : updatedAt ? relTime(updatedAt) : '—'
  const timeTitle = showCompletion ? `完成于 ${task.completedAt}` : updatedAt ? `文件更新于 ${new Date(updatedAt).toLocaleString('zh-CN')}` : '暂无更新时间'
  const bindings = conversations.bindingsFor(task.path)
  const primaries = bindings.filter((item) => item.primary)
  const binding = primaries.length === 1 ? primaries[0] : undefined
  const conversation = binding?.conversation
  const ready = conversations.available && Boolean(task.path)
  const historyOnly = task.archived || state?.group === 'completed'
  const searching = conversations.available && Boolean(task.path) && bindings.length === 0 && (conversations.loading || conversations.data?.indexing === true && !conversations.error)
  const title = conversation?.title ?? (historyOnly ? '查看交接与历史' : searching ? '查找原会话…' : '接续此任务')
  const sourceStatus = conversation?.unavailableReason ?? (searching ? '正在检索原会话，仍可复制当前任务的说明。' : conversations.error ?? (!binding ? '尚未恢复旧会话历史。' : undefined))
  const actionDescription = binding && conversation?.capability !== 'unavailable'
    ? historyOnly
      ? conversation?.capability === 'workspace' ? '仅请求打开工作区，未恢复精确旧会话；不会复制接续说明或重新执行任务。' : '仅打开原会话查看历史，不复制接续说明或重新执行任务。'
      : conversation?.capability === 'workspace' ? '复制当前任务的接续说明并请求打开工作区，未恢复精确旧会话；请粘贴并发送后继续。' : '复制当前任务的接续说明并请求打开原会话；请粘贴并发送后继续。'
    : historyOnly ? '查看当前任务的交接与历史资料。' : '查看并复制当前任务的接续说明，在外部编辑器中粘贴并发送。'
  const pending = conversations.pendingTaskDir !== null && taskConversationDirectory(projectRoot, conversations.pendingTaskDir) === taskConversationDirectory(projectRoot, task.path)

  return <li className="my-home-task-row">
    <button type="button" className="my-home-task-open" onClick={() => onInspect(task)}>
      <span className="my-home-task-left">
        <span title={`优先级：${PRIORITY_LABELS[task.priority]}`} className="flex shrink-0 items-center"><PriorityIcon priority={task.priority} size={13} /></span>
        {state && <StateGroupIcon stateGroup={state.group} color={state.color} size={13} />}
        <span className="my-home-task-title" title={task.title}>{task.title}</span>
        {scope && <span className="my-home-task-scope" title={scope}>{scope}</span>}
      </span>
    </button>
    <TaskConversationEntry title={title} source={conversation?.source ?? 'unbound'} sourceLabel={conversation ? TASK_CONVERSATION_SOURCE_LABELS[conversation.source] : '任务资料'}
      capability={conversation?.capability ?? 'associate'} destinationLabel={conversation?.destinationLabel}
      actionDescription={actionDescription} unavailableReason={sourceStatus}
      pending={pending} disabled={!ready || conversations.pendingTaskDir !== null && !pending}
      onOpen={() => {
        if (!task.path) return
        if (binding && conversation?.capability !== 'unavailable') {
          if (historyOnly) void conversations.open(task.path, binding.id)
          else void conversations.continueTask(task.path, binding.id).then((result) => { if (result?.openError) onInstructions(task) })
        } else onInstructions(task)
      }} />
    <span className="my-home-task-status"><span className="my-home-status-pill" data-tone={status.tone}>{status.label}</span></span>
    <span className="my-home-task-time" title={timeTitle}>{timeText}</span>
    <button type="button" className="my-home-star-btn" data-starred={favorite} aria-pressed={favorite} aria-label={favorite ? '取消收藏' : '收藏任务'} onClick={() => onToggleFavorite(task.id)}>
      <Star size={13} fill={favorite ? 'currentColor' : 'none'} />
    </button>
  </li>
}

function HomeQuickPeekModal({ task, state, onClose, onRepair }: { task: HomeTask | null; state?: WorkItemState; onClose: () => void; onRepair: (task: HomeTask) => void }): JSX.Element | null {
  if (!task) return null
  const status = taskStatus(task, state)
  const docNames = task.artifacts.filter((file) => file.kind === 'file').map((file) => file.name)
  return <Modal open onClose={onClose} width={520}>
    <div className="my-modal-content my-home-task-preview flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2"><span className="my-home-status-pill" data-tone={status.tone}>{status.label}</span>{task.completedAt && <span className="text-my-xs text-my-tertiary">完成于 {task.completedAt}</span>}</div>
          <h3 className="text-my-lg font-semibold text-my-primary">{task.title}</h3>
        </div>
        <div className="flex items-center gap-1">
          <Dropdown align="right" trigger={({ open, toggle }) => <Button variant="ghost" size="sm" aria-label="任务更多操作" aria-expanded={open} onClick={toggle}><MoreHorizontal size={15} /></Button>}>
            {(close) => <DropdownItem disabled={!task.path} onClick={() => { close(); onRepair(task) }}>修复执行入口</DropdownItem>}
          </Dropdown>
          <Button variant="ghost" size="sm" aria-label="关闭任务预览" onClick={onClose}><X size={15} /></Button>
        </div>
      </div>
      <p className="whitespace-pre-wrap break-words text-my-sm leading-relaxed text-my-secondary">{task.description || '暂无任务描述'}</p>
      {docNames.length > 0 && <div className="flex flex-wrap items-center gap-1.5"><span className="text-my-xs text-my-tertiary">任务材料</span>{docNames.slice(0, 5).map((name, index) => <span key={`${name}:${index}`} className="my-chip bg-my-layer-1 text-my-secondary"><FileText size={11} />{name}</span>)}</div>}
      <div className="flex justify-end gap-2 border-t border-my-line pt-3">
        <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
        {task.path && <Button variant="neutral" size="sm" onClick={() => { if (!task.path) return; onClose(); useApp.getState().showTask(task.path, task.archived) }}>查看完整任务<ArrowUpRight size={13} /></Button>}
      </div>
    </div>
  </Modal>
}

/** Real work summaries, one task filter, and project-scoped continuation records. */
export function YourWorkPage(): JSX.Element {
  const data = useMy((state) => state.data)
  const favorites = useMy((state) => state.favorites)
  const toggleFavorite = useMy((state) => state.toggleFavorite)
  const snapshot = useApp((state) => state.snapshot)
  const todos = useApp((state) => state.todos)
  const history = usePersonalHistory()
  const [view, setView] = useState<HomeView>('assigned')
  const [status, setStatus] = useState<StatusFilter>('open')
  const [order, setOrder] = useState<TaskOrder>('priority')
  const [searchQuery, setSearchQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [quickTodoText, setQuickTodoText] = useState('')
  const [savingTodo, setSavingTodo] = useState(false)
  const [todoFeedback, setTodoFeedback] = useState<{ error: boolean; message: string } | null>(null)
  const [inspectedTask, setInspectedTask] = useState<HomeTask | null>(null)
  const [association, setAssociation] = useState<{ root: string; task: HomeTask } | null>(null)
  const [continuation, setContinuation] = useState<{ root: string; task: HomeTask } | null>(null)
  const [now, setNow] = useState(() => new Date())
  const todoSaveLock = useRef(false)
  const todoComposing = useRef(false)
  const todoMounted = useRef(false)
  const todoOwner = useRef(0)
  const todoDraftRevision = useRef(0)
  const todoInput = useRef<HTMLInputElement>(null)
  const feedbackTimerRef = useRef<number | null>(null)
  const projectRoot = snapshot?.meta.root
  const conversations = useTaskConversations(projectRoot)
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const me = snapshot?.meta.developer ?? null
  const states = useMemo(() => new Map(data.states.map((state) => [state.id, state])), [data.states])
  const sourceTasks = useMemo(() => new Map(snapshot?.tasks.map((task) => [task.dirName, task]) ?? []), [snapshot?.tasks])
  const currentTasks = useMemo<HomeTask[]>(() => data.issues.map((issue) => {
    const task = sourceTasks.get(issue.id)
    return task ? buildHomeTask(task, false) : {
      id: issue.id, title: issue.name, description: issue.description, path: null,
      stateId: issue.stateId, priority: issue.priority, assignee: issue.assigneeId, creator: null,
      updatedAt: null, completedAt: issue.completedAt, archived: false,
      jiraKey: null, pkg: issue.pkg, scope: issue.scope, branch: null, artifacts: []
    }
  }), [data.issues, sourceTasks])
  const allTasks = useMemo(() => [...currentTasks, ...(snapshot?.archived.map((task) => buildHomeTask(task, true)) ?? [])], [currentTasks, snapshot?.archived])
  const personalTasks = me ? currentTasks.filter((task) => task.assignee === me) : currentTasks
  const completedTasks = allTasks.filter((task) => (!me || task.assignee === me) && completedInWeek(task, now, states))
  const pendingTodos = todos.filter((todo) => todo.status === 'pending')
  const recent = useMemo(() => history.filter((entry) => {
    if (entry.kind === 'task') return (entry.archived ? snapshot?.archived : snapshot?.tasks)?.some((task) => task.dirName === entry.target || task.path === entry.target)
    if (entry.kind === 'document') {
      const relative = relativePathUnderRoot(projectRoot ?? '', entry.target)
      return relative !== null && !relative.split('/').includes('..')
    }
    return true
  }), [history, snapshot?.archived, snapshot?.tasks, projectRoot])
  const continueTask = useMemo<{ task: HomeTask; source: 'binding' | 'history' } | null>(() => {
    const binding = snapshot?.meta.currentTask?.replace(/\\/g, '/')
    if (binding) {
      const task = currentTasks.find((item) => item.id === binding || item.path?.replace(/\\/g, '/') === binding || item.path?.replace(/\\/g, '/').endsWith(`/${binding}`))
      if (task) return { task, source: 'binding' }
    }
    const entry = recent.find((item) => item.kind === 'task')
    if (!entry) return null
    const task = allTasks.find((item) => item.archived === Boolean(entry.archived) && (item.id === entry.target || item.path === entry.target))
    return task ? { task, source: 'history' } : null
  }, [snapshot?.meta.currentTask, currentTasks, allTasks, recent])

  useEffect(() => {
    let timer: number | null = null
    const update = (): void => {
      if (timer !== null) window.clearInterval(timer)
      timer = null
      if (!interactive || document.visibilityState === 'hidden') return
      setNow(new Date())
      timer = window.setInterval(() => setNow(new Date()), 60000)
    }
    update()
    document.addEventListener('visibilitychange', update)
    return () => {
      if (timer !== null) window.clearInterval(timer)
      document.removeEventListener('visibilitychange', update)
      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current)
    }
  }, [interactive])
  useLayoutEffect(() => {
    todoMounted.current = true
    const off = useApp.subscribe((next, previous) => {
      if (next.snapshot?.meta.root !== previous.snapshot?.meta.root || next.page !== previous.page) {
        todoOwner.current += 1
        todoComposing.current = false
      }
    })
    return () => { todoMounted.current = false; todoOwner.current += 1; off() }
  }, [])
  useEffect(() => {
    const clearFeedback = (): void => {
      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current)
      feedbackTimerRef.current = null
      setTodoFeedback(null)
      todoComposing.current = false
    }
    const hidden = (): void => { if (document.visibilityState === 'hidden') clearFeedback() }
    if (!interactive) clearFeedback()
    document.addEventListener('visibilitychange', hidden)
    return () => document.removeEventListener('visibilitychange', hidden)
  }, [interactive])
  useEffect(() => {
    setView('assigned')
    setStatus('open')
    setSearchQuery('')
    setExpanded(false)
    setInspectedTask(null)
    setAssociation(null)
    setContinuation(null)
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current)
      feedbackTimerRef.current = null
    }
    setTodoFeedback(null)
  }, [projectRoot, me])
  useEffect(() => { if (!interactive) { setAssociation(null); setContinuation(null); setInspectedTask(null) } }, [interactive])

  const viewTasks = view === 'assigned' ? personalTasks
    : view === 'created' ? currentTasks.filter((task) => me && task.creator === me)
      : view === 'favorites' ? allTasks.filter((task) => favorites.includes(task.id)) : completedTasks
  const query = searchQuery.trim().toLowerCase()
  const filteredTasks = viewTasks.filter((task) => matchesStatus(task, status, states))
    .filter((task) => !query || task.title.toLowerCase().includes(query) || task.id.toLowerCase().includes(query))
    .sort((a, b) => {
      if (order === 'priority') {
        const priority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
        if (priority) return priority
      }
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.title.localeCompare(b.title, 'zh-CN')
    })
  const visibleTasks = expanded ? filteredTasks : filteredTasks.slice(0, TASK_LIMIT)
  const manageConversations = (task: HomeTask): void => {
    if (projectRoot && task.path && conversations.available && canInteract()) { setInspectedTask(null); setAssociation({ root: projectRoot, task }) }
  }
  const showInstructions = (task: HomeTask): void => {
    if (projectRoot && task.path && conversations.available && canInteract() && useApp.getState().snapshot?.meta.root === projectRoot) setContinuation({ root: projectRoot, task })
  }
  const inspectTask = (task: HomeTask): void => {
    setInspectedTask(task)
    rememberVisit({ kind: 'task', target: task.id, title: task.title, archived: task.archived })
  }
  const startAgentConversation = (): void => {
    useMy.getState().setShellView('collaboration')
    changeContext(PERSONAL)
    newDraft(PERSONAL, 'work')
    useApp.getState().setPage('chat')
  }
  const openVisit = (entry: PersonalVisit): void => {
    const app = useApp.getState()
    if (app.snapshot?.meta.root !== projectRoot) return
    if (entry.kind === 'task') {
      const found = allTasks.find((task) => task.archived === Boolean(entry.archived) && (task.id === entry.target || task.path === entry.target))
      if (found) inspectTask(found)
      return
    }
    if (entry.kind === 'document') app.openSpecDocument(entry.target)
    else if (entry.kind === 'agent') {
      useMy.getState().requestAgentView(null)
      useMy.getState().setAgentSessionTarget(entry.target)
      app.setPage('acp')
    } else if (hasIpc) {
      const navigation = app.navigationRevision
      void readArchive(entry.target).then(() => {
        const current = useApp.getState()
        if (current.navigationRevision !== navigation || current.snapshot?.meta.root !== projectRoot || current.page !== 'dashboard' || current.openTaskDir || !canInteract()) return
        if (!useConversations.getState().archiveReads[entry.target]?.value) { current.pushToast({ kind: 'error', title: '该问答已不可用' }); return }
        useMy.getState().setShellView('collaboration')
        changeContext(PERSONAL)
        selectArchive(entry.target, PERSONAL, 'work')
        current.setPage('chat')
        rememberVisit(entry)
      }).catch(() => {
        const current = useApp.getState()
        if (current.snapshot?.meta.root === projectRoot && current.page === 'dashboard') current.pushToast({ kind: 'error', title: '问答打开失败' })
      })
      return
    } else return
    rememberVisit(entry)
  }
  const submitQuickTodo = async (): Promise<void> => {
    const text = quickTodoText.trim()
    if (!text || !hasIpc || !projectRoot || todoSaveLock.current || todoComposing.current || !canInteract()) return
    const targetRoot = projectRoot
    if (useApp.getState().snapshot?.meta.root !== targetRoot) return
    const owner = todoOwner.current
    const revision = todoDraftRevision.current
    const ownsDraft = (): boolean => todoMounted.current && todoOwner.current === owner && useApp.getState().snapshot?.meta.root === targetRoot
    const visible = (): boolean => ownsDraft() && canInteract() && document.visibilityState !== 'hidden' && todoDraftRevision.current === revision
    const focusOwner = document.activeElement
    todoSaveLock.current = true
    setSavingTodo(true)
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current)
      feedbackTimerRef.current = null
    }
    setTodoFeedback(null)
    try {
      const saved = await api.todoSave({ title: text, description: '' })
      if (!ownsDraft()) return
      if (!saved.ok) throw new Error(saved.error || '保存失败，内容已保留，请重试。')
      if (todoDraftRevision.current === revision) setQuickTodoText('')
      if (visible()) {
        setTodoFeedback({ error: false, message: '已保存到收件箱' })
        feedbackTimerRef.current = window.setTimeout(() => {
          setTodoFeedback(null)
          feedbackTimerRef.current = null
        }, 2500)
      }
      // Persistence has succeeded. A read failure must never invite saving it again.
      try {
        const refreshed = await api.todoList()
        if (!ownsDraft()) return
        if (!refreshed.ok || !refreshed.todos) throw new Error(refreshed.error || '列表刷新失败')
        useApp.setState({ todos: refreshed.todos })
      } catch {
        if (visible()) {
          if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current)
          feedbackTimerRef.current = null
          setTodoFeedback({ error: true, message: '待办已保存，列表刷新失败，请前往收件箱刷新。' })
        }
      }
    } catch (cause) {
      if (visible()) setTodoFeedback({ error: true, message: `保存失败：${errorMessage(cause)}` })
    } finally {
      todoSaveLock.current = false
      if (todoMounted.current) setSavingTodo(false)
      if (visible() && (document.activeElement === focusOwner || document.activeElement === document.body)) todoInput.current?.focus({ preventScroll: true })
    }
  }
  const onQuickTodoSubmit = (event: FormEvent): void => {
    event.preventDefault()
    if (todoComposing.current) return
    void submitQuickTodo()
  }
  const taskScope = me ? '我负责' : '项目任务'
  const projectName = snapshot?.meta.name || data.workspace.name || '当前项目'
  const branch = continueTask?.task.branch
  const activeCount = personalTasks.filter((task) => matchesStatus(task, 'active', states)).length
  const reviewCount = personalTasks.filter((task) => matchesStatus(task, 'review', states)).length
  const openCount = personalTasks.filter((task) => matchesStatus(task, 'open', states)).length
  const conversationFeedback = conversations.feedback?.error ? conversations.feedback
    : conversations.error ? { error: true, message: conversations.error } : conversations.feedback
  const tabs: Array<{ id: HomeView; label: string; count: number; disabled?: boolean }> = [
    { id: 'assigned', label: taskScope, count: personalTasks.length },
    { id: 'created', label: '我创建', count: currentTasks.filter((task) => me && task.creator === me).length, disabled: !me },
    { id: 'favorites', label: '收藏', count: allTasks.filter((task) => favorites.includes(task.id)).length },
    { id: 'completed', label: '近 7 天完成', count: completedTasks.length }
  ]

  return <PageLayout variant={PAGE_LAYOUTS.dashboard}>
    <PageBody className="my-home-body">
      <PageContent>
        <div className="my-home-shell">
          <header className="my-home-header">
            <div className="my-home-header-main">
              <div className="my-home-eyebrow">
                <span>{now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</span>
                <span className="my-home-eyebrow-dot" /><span>{projectName}</span>
                {branch && <span className="my-home-branch-pill" title="继续任务中记录的分支"><GitBranch size={11} />{branch}</span>}
              </div>
              <h1 className="my-home-greeting">{greetingByHour(now.getHours())}，{me || '开发者'}</h1>
            </div>
            <div className="my-home-header-actions">
              <Button variant="neutral" size="sm" onClick={startAgentConversation}><Bot size={14} />打开对话</Button>
              <Button variant="primary" size="sm" onClick={() => useMy.getState().setCreateIssueOpen(true)}><Plus size={14} />新建任务</Button>
            </div>
          </header>

          <section className="my-home-pulse-grid" aria-label="当前项目的工作概况">
            <SummaryCard label="进行中工作" value={activeCount} unit="项正推进" note={`${taskScope} · 未结束共 ${openCount} 项`} icon={Clock3} />
            <SummaryCard label="待办收件箱" value={pendingTodos.length} unit="项待处理" note="当前项目中的待办记录" icon={Inbox} />
            <SummaryCard label="待评审" value={reviewCount} unit="项待确认" note={`${taskScope} · 等待评审的任务`} icon={CheckCircle2} />
            <SummaryCard label="近 7 天完成" value={completedTasks.length} unit="项已完成" note={`${taskScope} · 包含已归档任务`} icon={Check} />
          </section>

          <div className="my-home-workspace">
            <div className="my-home-main-col">
              {continueTask && <ContinueTaskBar task={continueTask.task} source={continueTask.source} state={states.get(continueTask.task.stateId)} onInspect={inspectTask} />}
              <section className="my-home-list-panel" aria-label="个人工作项列表">
                <header className="my-home-list-toolbar">
                  <div className="my-home-tabs" role="group" aria-label="任务来源">
                    {tabs.map((tab) => <button key={tab.id} type="button" aria-pressed={view === tab.id} disabled={tab.disabled} data-active={view === tab.id} className="my-home-tab" title={tab.disabled ? '当前项目尚未设置开发者身份' : undefined} onClick={() => { setView(tab.id); setStatus(tab.id === 'assigned' ? 'open' : 'all'); setExpanded(false) }}>
                      <span>{tab.label}</span><span className="my-home-tab-count">{tab.count}</span>
                    </button>)}
                  </div>
                  <div className="my-home-list-controls">
                    <SearchInput value={searchQuery} onChange={(next) => { setSearchQuery(next); setExpanded(false) }} placeholder="筛选当前列表…" ariaLabel="按标题或任务编号筛选当前列表" size="sm" className="my-home-search" />
                    {view !== 'completed' && <Select<StatusFilter> value={status} onChange={(next) => { setStatus(next); setExpanded(false) }} options={STATUS_OPTIONS} size="sm" ariaLabel="任务状态" />}
                    <Select<TaskOrder> value={order} onChange={setOrder} options={[{ value: 'priority', label: '按优先级' }, { value: 'updated', label: '按更新时间' }]} size="sm" ariaLabel="排序方式" />
                  </div>
                </header>
                {!me && <p className="my-home-scope-note">当前项目未设置开发者身份，暂展示项目任务。</p>}
                {filteredTasks.length > 0 ? <ul className="my-home-task-rows my-scrollbar" aria-label="筛选后的任务" aria-description="窄窗口中可左右滚动查看全部字段" tabIndex={0}>
                  {visibleTasks.map((task) => <CleanTaskRow key={`${task.archived ? 'arch' : 'act'}:${task.path ?? task.id}`} task={task} state={states.get(task.stateId)} favorite={favorites.includes(task.id)} onInspect={inspectTask} onToggleFavorite={toggleFavorite} conversations={conversations} projectRoot={projectRoot ?? ''} onInstructions={showInstructions} />)}
                </ul> : <div className="my-home-empty" role="status">
                  <ListTodo size={18} /><span>当前筛选条件下暂无任务</span>
                  {(status !== 'all' || searchQuery) && <Button variant="ghost" size="sm" onClick={() => { setStatus('all'); setSearchQuery(''); setExpanded(false) }}>重置筛选条件</Button>}
                </div>}
                <footer className="my-home-list-footer">
                  <div className="my-home-conversation-refresh">
                    <span>显示 {visibleTasks.length} / {filteredTasks.length} 项</span>
                    {conversations.data && <time dateTime={new Date(conversations.data.refreshedAt).toISOString()}>会话读取于 {new Date(conversations.data.refreshedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>}
                    <Button variant="ghost" size="sm" aria-label="刷新任务会话" disabled={!conversations.available || conversations.loading || conversations.refreshing || conversations.pendingTaskDir !== null} onClick={() => { void conversations.refresh() }}><RefreshCw size={12} />{conversations.loading || conversations.refreshing ? '读取中…' : '刷新'}</Button>
                  </div>
                  <div className="flex items-center gap-2">
                    {filteredTasks.length > TASK_LIMIT && <Button variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>{expanded ? '收起列表' : `展开全部 (${filteredTasks.length})`}</Button>}
                    <Button variant="ghost" size="sm" onClick={() => { useMy.getState().setWorkItemsView('items'); useApp.getState().setPage('tasks') }}>全部工作项<ArrowUpRight size={12} /></Button>
                  </div>
                </footer>
                {conversationFeedback && <p className={`my-home-conversation-feedback ${conversationFeedback.error ? 'text-my-danger-text' : 'text-my-secondary'}`} role={conversationFeedback.error ? 'alert' : 'status'}>{conversationFeedback.message}</p>}
              </section>
            </div>

            <aside className="my-home-side-col my-scrollbar" aria-label="待办与最近访问">
              <section className="my-home-side-card" aria-labelledby="home-inbox-title">
                <header className="my-home-side-header">
                  <div className="flex items-center gap-2"><h2 id="home-inbox-title" className="my-home-side-title">待办收件箱</h2><span className="my-home-tab-count">{pendingTodos.length}</span></div>
                  <Button variant="ghost" size="sm" onClick={() => useApp.getState().setPage('inbox')}>查看全部<ArrowUpRight size={12} /></Button>
                </header>
                {pendingTodos.length > 0 ? <ul className="my-home-side-list">{pendingTodos.slice(0, 3).map((todo) => <li key={todo.id}>
                  <button type="button" className="my-home-signal-row" onClick={() => useApp.getState().setPage('inbox')}>
                    <span className="my-home-signal-left"><PriorityIcon priority={priorityFromTask(todo.priority)} size={13} /><span className="my-home-signal-text" title={todo.title}>{todo.title}</span></span><ArrowUpRight size={12} className="shrink-0 text-my-icon-tertiary" />
                  </button>
                </li>)}</ul> : <p className="my-home-side-empty">暂无待处理待办</p>}
                {pendingTodos.length > 3 && <Button variant="ghost" size="sm" className="my-home-more-todos" onClick={() => useApp.getState().setPage('inbox')}>查看其余 {pendingTodos.length - 3} 条<ArrowUpRight size={12} /></Button>}
                <form className="my-home-quick-todo-form" onSubmit={onQuickTodoSubmit} aria-label="快速记录待办" aria-busy={savingTodo}>
                  <Plus size={13} className="shrink-0 text-my-icon-tertiary" />
                  <input
                    ref={todoInput}
                    type="text"
                    value={quickTodoText}
                    disabled={!hasIpc || !projectRoot}
                    onChange={(event) => {
                      todoDraftRevision.current += 1
                      setQuickTodoText(event.target.value)
                      setTodoFeedback(null)
                      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current)
                      feedbackTimerRef.current = null
                    }}
                    onCompositionStart={() => { todoComposing.current = true }}
                    onCompositionEnd={() => { todoComposing.current = false }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (todoComposing.current || event.nativeEvent.isComposing || event.keyCode === 229)) {
                        event.preventDefault()
                        return
                      }
                    }}
                    placeholder={hasIpc && projectRoot ? '记一条待办，回车保存…' : '打开项目后记录待办'}
                    aria-label="待办内容"
                    aria-describedby={todoFeedback ? 'home-todo-feedback' : undefined}
                    className="my-home-quick-todo-input"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="my-home-quick-todo-save"
                    disabled={savingTodo || !quickTodoText.trim() || !hasIpc || !projectRoot}
                    onClick={() => void submitQuickTodo()}
                  >
                    {savingTodo ? <><Loader2 size={12} className="animate-spin motion-reduce:animate-none mr-1 inline" aria-hidden="true" />保存中…</> : '保存'}
                  </Button>
                </form>
                {todoFeedback && <p id="home-todo-feedback" className={`my-home-todo-feedback ${todoFeedback.error ? 'text-my-danger-text' : 'text-my-success-text'}`} role={todoFeedback.error ? 'alert' : 'status'}>{todoFeedback.message}</p>}
              </section>

              <section className="my-home-side-card" aria-labelledby="home-recent-title">
                <header className="my-home-side-header"><h2 id="home-recent-title" className="my-home-side-title">最近访问</h2>{recent.length > 0 && <Button variant="ghost" size="sm" onClick={clearPersonalHistory}>清空</Button>}</header>
                {recent.length > 0 ? <ul className="my-home-side-list">{recent.slice(0, 3).map((entry) => {
                  const Icon = VISIT_ICONS[entry.kind]
                  return <li key={`${entry.kind}:${entry.target}:${Boolean(entry.archived)}`}><button type="button" className="my-home-signal-row" onClick={() => openVisit(entry)}>
                    <span className="my-home-signal-left"><Icon size={13} className="shrink-0 text-my-icon-tertiary" /><span className="my-home-signal-text" title={entry.title}>{entry.title}</span></span>
                    <span className="my-home-visit-time">{VISIT_LABELS[entry.kind]} · {relTime(entry.at)}</span>
                  </button></li>
                })}</ul> : <p className="my-home-side-empty">暂无近期访问记录</p>}
                <nav className="my-home-shortcuts-grid" aria-label="常用模块入口">
                  <button type="button" className="my-home-shortcut-btn" onClick={() => { useMy.getState().requestAgentView('roles'); useApp.getState().setPage('acp') }}><Bot size={14} /><span>岗位智能体</span></button>
                  <button type="button" className="my-home-shortcut-btn" onClick={() => useApp.getState().setPage('spec')}><BookOpen size={14} /><span>项目规范库</span></button>
                  <button type="button" className="my-home-shortcut-btn" onClick={() => { useMy.getState().setTeamView('overview'); useApp.getState().setPage('team') }}><Users size={14} /><span>团队与周报</span></button>
                  <button type="button" className="my-home-shortcut-btn" onClick={() => { useMy.getState().setToolView('git'); useApp.getState().setPage('devtools') }}><Terminal size={14} /><span>工程与运行</span></button>
                </nav>
              </section>
            </aside>
          </div>
          <HomeQuickPeekModal task={inspectedTask} state={inspectedTask ? states.get(inspectedTask.stateId) : undefined} onClose={() => setInspectedTask(null)} onRepair={manageConversations} />
          {continuation && continuation.root === projectRoot && continuation.task.path && interactive && <TaskContinuationModal key={`${continuation.root}:${continuation.task.path}`} projectRoot={continuation.root} taskDir={continuation.task.path} taskTitle={continuation.task.title} historyOnly={continuation.task.archived || states.get(continuation.task.stateId)?.group === 'completed'} reason={conversations.bindingsFor(continuation.task.path).find((binding) => binding.primary)?.conversation.unavailableReason} controller={conversations} onClose={() => setContinuation(null)} />}
          {association && association.root === projectRoot && association.task.path && interactive && <TaskConversationAssociationModal key={`${association.root}:${association.task.path}`} taskDir={association.task.path} taskTitle={association.task.title} controller={conversations} onClose={() => setAssociation(null)} />}
        </div>
      </PageContent>
    </PageBody>
  </PageLayout>
}
