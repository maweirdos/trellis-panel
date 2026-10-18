import { useMemo, useState, type JSX } from 'react'
import { ArrowUpRight, BookOpen, Bot, Clock3, ListTodo, MessageSquare, Star } from 'lucide-react'
import { useApp } from '../../store'
import { hasIpc } from '../../api'
import { relTime } from '../../utils/format'
import { relativePathUnderRoot } from '../../reader/reader-paths'
import { useMy } from '../store'
import { Avatar, Button, EmptyState, formatDate } from '../ui'
import { PriorityIcon, StateGroupIcon } from '../icons'
import { clearPersonalHistory, rememberVisit, usePersonalHistory, type PersonalVisit } from '../personal-history'
import type { Issue, Member, WorkItemState } from '../types'
import { PAGE_LAYOUTS, PageBody, PageContent, PageLayout } from '../layout/PageLayout'

type HomeView = 'recent' | 'favorites' | 'assigned' | 'created'
const VISIT_LABELS = { task: '任务', document: '文档', agent: '对话', chat: '问答' }
const VISIT_ICONS = { task: ListTodo, document: BookOpen, agent: Bot, chat: MessageSquare }

function isIssueOpen(issue: Issue, states: Map<string, WorkItemState>): boolean {
  const group = states.get(issue.stateId)?.group
  return group !== 'completed' && group !== 'cancelled'
}

function IssueRow({ issue, members, states, updatedAt, onOpen }: {
  issue: Issue
  members: Map<string, Member>
  states: Map<string, WorkItemState>
  updatedAt?: number
  onOpen: (id: string) => void
}): JSX.Element {
  const state = states.get(issue.stateId)
  const assignee = issue.assigneeId ? members.get(issue.assigneeId) : undefined
  const due = formatDate(issue.dueDate)
  return (
    <button
      type="button"
      onClick={() => onOpen(issue.id)}
      className="group flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-my-layer-1-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-my-line-accent"
    >
      {state && <StateGroupIcon stateGroup={state.group} color={state.color} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-my-md font-medium text-my-primary">{issue.name}</span>
        <span className="mt-0.5 block truncate text-my-xs text-my-secondary">
          {state?.name ?? '状态未记录'}{assignee ? ` · ${assignee.name}` : ' · 未分配'}
        </span>
      </span>
      <PriorityIcon priority={issue.priority} size={13} />
      <span className="hidden shrink-0 text-my-xs text-my-secondary sm:block">
        {updatedAt ? `更新于 ${relTime(updatedAt)}` : due}
      </span>
      {assignee && <Avatar name={assignee.name} color={assignee.avatarColor} size={20} />}
      <ArrowUpRight size={13} className="shrink-0 text-my-icon-tertiary group-hover:text-my-icon-accent" />
    </button>
  )
}

/** Personal records are explicit local opens, scoped by project and developer. */
export function YourWorkPage(): JSX.Element {
  const { data, openIssue, favorites, setAgentSessionTarget } = useMy()
  const snapshot = useApp((state) => state.snapshot)
  const history = usePersonalHistory()
  const [view, setView] = useState<HomeView>('recent')
  const members = useMemo(() => new Map(data.members.map((member) => [member.id, member])), [data.members])
  const states = useMemo(() => new Map(data.states.map((state) => [state.id, state])), [data.states])
  const tasks = useMemo(() => new Map(snapshot?.tasks.map((task) => [task.dirName, task]) ?? []), [snapshot?.tasks])
  const me = snapshot?.meta.developer
  const recent = history.filter((entry) => {
    if (entry.kind === 'task') return (entry.archived ? snapshot?.archived : snapshot?.tasks)?.some((task) => task.dirName === entry.target || task.path === entry.target)
    if (entry.kind === 'document') {
      const relative = relativePathUnderRoot(snapshot?.meta.root ?? '', entry.target)
      return relative !== null && !relative.split('/').includes('..')
    }
    return true
  })
  const queues = {
    favorites: data.issues.filter((issue) => favorites.includes(issue.id)),
    assigned: data.issues.filter((issue) => me && issue.assigneeId === me && isIssueOpen(issue, states)),
    created: data.issues.filter((issue) => me && tasks.get(issue.id)?.record?.creator === me)
  }
  const openVisit = (entry: PersonalVisit): void => {
    const app = useApp.getState()
    if (entry.kind === 'task') {
      if (entry.archived) app.showTask(entry.target, true)
      else openIssue(entry.target)
    } else if (entry.kind === 'document') app.openSpecDocument(entry.target)
    else if (entry.kind === 'agent') { useMy.getState().requestAgentView(null); setAgentSessionTarget(entry.target); app.setPage('acp') }
    else if (hasIpc) {
      void app.chatOpenSession(entry.target).then(() => {
        if (useApp.getState().snapshot?.meta.root !== snapshot?.meta.root || useApp.getState().page !== 'dashboard' || useApp.getState().openTaskDir) return
        if (useApp.getState().chatActiveId !== entry.target) { useApp.getState().pushToast({ kind: 'error', title: '该问答已不可用' }); return }
        useApp.getState().setPage('chat')
      }).catch(() => { if (useApp.getState().page === 'dashboard') useApp.getState().pushToast({ kind: 'error', title: '问答打开失败' }) })
    }
    rememberVisit(entry)
  }
  const views: Array<{ id: HomeView; label: string; count: number; description: string; empty: string }> = [
    { id: 'recent', label: '最近', count: recent.length, description: '本机在当前项目中打开的任务、文档和对话，按访问时间排列。', empty: '还没有访问记录' },
    { id: 'favorites', label: '收藏', count: queues.favorites.length, description: '你在当前项目收藏的任务。', empty: '还没有收藏' },
    { id: 'assigned', label: '我负责', count: queues.assigned.length, description: '当前项目分配给你的未结束任务。', empty: me ? '没有分配给你的未结束任务' : '当前项目未设置开发者身份' },
    { id: 'created', label: '我创建', count: queues.created.length, description: '任务创建者字段与你的当前开发者身份一致的记录。', empty: me ? '还没有由你创建的任务' : '当前项目未设置开发者身份' }
  ]
  const selected = views.find((item) => item.id === view) ?? views[0]
  const last = recent[0]
  return <PageLayout variant={PAGE_LAYOUTS.dashboard}><PageBody><PageContent>
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-my-xl font-semibold text-my-primary">首页</h1><p className="mt-1 text-my-sm text-my-secondary">{me ? `${me}，从上次停下的地方继续。` : '你的访问记录与收藏。'}</p></div>
      <span className="text-my-xs text-my-secondary">{new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</span>
    </header>
    {last && <button type="button" onClick={() => openVisit(last)} className="my-card mb-6 flex w-full items-center gap-3 p-4 text-left hover:bg-my-layer-1-hover">
      <Clock3 size={18} className="shrink-0 text-my-icon-secondary" /><span className="min-w-0 flex-1"><span className="block text-my-xs text-my-tertiary">继续 · {VISIT_LABELS[last.kind]}</span><span className="mt-1 block truncate text-my-md font-medium text-my-primary" title={last.title}>{last.title}</span></span><ArrowUpRight size={16} className="text-my-icon-tertiary" />
    </button>}
    <div className="mb-4 flex flex-wrap items-center gap-1 border-b border-my-line" role="tablist" aria-label="个人记录">
      {views.map((item) => <button key={item.id} id={`home-${item.id}`} type="button" role="tab" aria-selected={view === item.id} aria-controls="home-records" onClick={() => setView(item.id)} className={`flex items-center gap-2 border-b-2 px-3 py-2.5 text-my-sm font-medium ${view === item.id ? 'border-my-line-accent text-my-primary' : 'border-transparent text-my-secondary hover:bg-my-layer-1-hover'}`}>
        {item.id === 'favorites' && <Star size={13} />}{item.label}<span className="text-my-xs tabular-nums text-my-tertiary">{item.count}</span>
      </button>)}
    </div>
    <div className="mb-3 flex items-center justify-between gap-3"><p className="text-my-xs text-my-secondary">{selected.description}</p>{view === 'recent' && recent.length > 0 && <Button variant="ghost" size="sm" onClick={clearPersonalHistory}>清空记录</Button>}</div>
    <section id="home-records" role="tabpanel" aria-labelledby={`home-${view}`} className="overflow-hidden rounded-my-lg border border-my-line bg-my-surface-1">
      {selected.count === 0 ? <EmptyState title={selected.empty} description={view === 'recent' ? '记录从本次使用开始积累，仅保存在本机，不回填项目文件的历史更新时间。' : undefined} /> : <div className="divide-y divide-my-line">
        {view === 'recent' ? recent.map((entry) => {
          const Icon = VISIT_ICONS[entry.kind]
          return <button key={`${entry.kind}:${entry.target}:${Boolean(entry.archived)}`} type="button" onClick={() => openVisit(entry)} className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left hover:bg-my-layer-1-hover"><Icon size={16} className="shrink-0 text-my-icon-secondary" /><span className="min-w-0 flex-1"><span className="block truncate text-my-sm font-medium text-my-primary" title={entry.title}>{entry.title}</span><span className="text-my-xs text-my-tertiary">{VISIT_LABELS[entry.kind]}{entry.archived ? ' · 已归档' : ''}</span></span><span className="shrink-0 text-my-xs text-my-tertiary">{relTime(entry.at)}</span><ArrowUpRight size={13} className="text-my-icon-tertiary" /></button>
        }) : queues[view].map((issue) => <IssueRow key={issue.id} issue={issue} members={members} states={states} updatedAt={tasks.get(issue.id)?.updatedAt} onOpen={openIssue} />)}
      </div>}
    </section>
  </PageContent></PageBody></PageLayout>
}
