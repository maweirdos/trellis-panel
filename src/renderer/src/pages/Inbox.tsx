import { useMemo } from 'react'
import { Inbox as InboxIcon, Check, Clock, X, CheckCheck, Sparkles, FileText, Trash2 } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import type { JSX } from 'react'
import type { TaskInfo } from '../../../shared/types'

/**
 * 待处理 —— 新任务确认：
 * AI / 协作者 / Jira 新建的任务以卡片形式到达，确认状态只记录面板侧的处理进度，
 * 不改变任务是否出现在看板中。
 */
export function InboxPage(): JSX.Element {
  const inbox = useApp((s) => s.inbox)
  const inboxSetState = useApp((s) => s.inboxSetState)
  const inboxAcceptAll = useApp((s) => s.inboxAcceptAll)
  const showTask = useApp((s) => s.showTask)
  const setPage = useApp((s) => s.setPage)
  const setIntakeOpen = useApp((s) => s.setIntakeOpen)
  const snapshot = useApp((s) => s.snapshot)
  const inboxRemove = useApp((s) => s.inboxRemove)
  const pushToast = useApp((s) => s.pushToast)

  const entries = useMemo(() => Object.values(inbox).sort((a, b) => b.ts - a.ts), [inbox])
  const pending = entries.filter((e) => e.state === 'pending')
  const snoozed = entries.filter((e) => e.state === 'snoozed')
  const accepted = entries.filter((e) => e.state === 'accepted')
  const dismissed = entries.filter((e) => e.state === 'dismissed')

  const openTask = (dirName: string): void => {
    setPage('tasks')
    showTask(dirName)
  }

  const deleteTodo = async (dirName: string): Promise<void> => {
    const task = snapshot?.tasks.find((t) => t.dirName === dirName)
    if (!task?.record) return
    if (!window.confirm(`确定删除待办“${task.record.title}”吗？\n只会删除本地 Trellis 待办，不会删除 Jira 问题。`)) return
    const res = await api.deleteTask(task.path, task.taskJsonMtime)
    if (res.ok) {
      inboxRemove(dirName)
      pushToast({ kind: 'success', title: '待办已删除', body: dirName })
    } else {
      pushToast({ kind: res.conflict ? 'warn' : 'error', title: res.conflict ? '删除冲突' : '删除待办失败', body: res.error })
    }
  }

  return (
    <div className="flex h-full min-w-0 animate-fade-in flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 bg-ink-850/40 px-5 py-2.5">
        <InboxIcon size={15} className="text-leaf" />
        <h1 className="text-base font-semibold text-mist-50">待处理任务</h1>
        <span className="chip border border-amber-400/30 bg-amber-500/15 text-amber-300">
          {pending.length} 待确认
        </span>
        <div className="ml-auto flex gap-1.5">
            <button onClick={() => setIntakeOpen(true)} className="btn-outline">
            <Sparkles size={12} /> 新建待办
            </button>
          {pending.length > 0 && (
            <button onClick={inboxAcceptAll} className="btn-primary">
              <CheckCheck size={12} /> 全部确认
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {entries.length === 0 && (
          <div className="grid place-items-center gap-3 py-24 text-mist-600">
            <InboxIcon size={36} strokeWidth={1.2} />
            <div className="text-sm">没有待处理任务</div>
            <div className="max-w-sm text-center text-[11.5px] leading-5">
              当 AI 工具、协作者或 Jira 导入新任务时，任务会以卡片形式出现在这里，
              等你确认来源和内容。确认不会改变任务在看板中的状态。
            </div>
          </div>
        )}

        {/* 待确认 */}
        {pending.length > 0 && (
          <>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-mist-500">待确认</div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {pending.map((e) => (
              <InboxCard key={e.dirName} entry={e} task={snapshot?.tasks.find((t) => t.dirName === e.dirName)} onOpen={openTask} onSet={inboxSetState} onDelete={deleteTodo} highlight />
              ))}
            </div>
          </>
        )}

        {/* 稍后 */}
        {snoozed.length > 0 && (
          <>
            <div className="mb-2 mt-6 text-[11px] font-medium uppercase tracking-wide text-mist-500">
              稍后处理 ({snoozed.length})
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {snoozed.map((e) => (
                <InboxCard key={e.dirName} entry={e} task={snapshot?.tasks.find((t) => t.dirName === e.dirName)} onOpen={openTask} onSet={inboxSetState} onDelete={deleteTodo} />
              ))}
            </div>
          </>
        )}

        {/* 已确认 / 已忽略 —— 折叠摘要 */}
        {(accepted.length > 0 || dismissed.length > 0) && (
          <div className="mt-6 flex flex-wrap gap-2">
            {accepted.length > 0 && (
              <span className="chip border border-emerald-400/25 bg-emerald-500/10 text-emerald-300">
                <Check size={11} /> 已确认 {accepted.length} · 仍在看板中
              </span>
            )}
            {dismissed.length > 0 && (
              <span className="chip border border-ink-500 text-mist-500">
                <X size={11} /> 已忽略 {dismissed.length}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function InboxCard({
  entry,
  task,
  onOpen,
  onSet,
  onDelete,
  highlight
}: {
  entry: { dirName: string; title: string; creator: string; ts: number }
  task?: TaskInfo
  onOpen: (dir: string) => void
  onSet: (dir: string, state: 'accepted' | 'snoozed' | 'dismissed') => void
  onDelete: (dir: string) => void
  highlight?: boolean
}): JSX.Element {
  const time = new Date(entry.ts)
  const timeLabel = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  const jiraKey = typeof task?.record?.meta?.jiraKey === 'string' ? task.record.meta.jiraKey : null
  const origin = jiraKey ? `Jira ${jiraKey}` : task?.record?.meta?.origin === 'panel' ? '面板待办' : 'AI / 外部'
  return (
    <div
      className={clsx(
        'flex flex-col rounded-xl border bg-ink-800 p-3.5 transition-all',
        highlight ? 'border-amber-400/30 shadow-[0_0_0_1px_rgba(251,191,36,0.08)]' : 'border-ink-700'
      )}
    >
      <button onClick={() => onOpen(entry.dirName)} className="group text-left" title="打开任务详情">
        <div className="mb-1 flex items-center gap-2 text-[10.5px] text-mist-500">
          <FileText size={10} className="text-leaf" />
          <span className="font-mono">{entry.dirName}</span>
          <span className="ml-auto font-mono">{timeLabel}</span>
        </div>
        <div className="line-clamp-2 text-xs font-medium leading-5 text-mist-100 group-hover:text-leaf-soft">
          {entry.title}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10.5px] text-mist-500">
          <span>来源 {origin}</span>
          <span>创建者 {entry.creator || '未知'}</span>
        </div>
      </button>
      <div className="mt-3 grid grid-cols-4 gap-1.5">
        <button
          onClick={() => onSet(entry.dirName, 'accepted')}
          className="btn-primary justify-center"
          title="确认已看到；任务仍在看板中"
        >
          <Check size={13} /> 确认
        </button>
        <button
          onClick={() => onSet(entry.dirName, 'snoozed')}
          className="btn-outline justify-center"
          title="稍后处理"
        >
          <Clock size={13} /> 稍后
        </button>
        <button
          onClick={() => onSet(entry.dirName, 'dismissed')}
          className="btn bg-ink-700/60 justify-center text-mist-300 hover:bg-ink-700"
          title="退回 / 忽略"
        >
          <X size={13} /> 忽略
        </button>
        {task?.record?.status === 'planning' && (
          <button
            onClick={() => onDelete(entry.dirName)}
            className="btn bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
            title="删除本地待办，不影响 Jira 问题"
          >
            <Trash2 size={13} /> 删除
          </button>
        )}
      </div>
    </div>
  )
}
