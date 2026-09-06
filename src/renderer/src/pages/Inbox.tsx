import { useMemo } from 'react'
import { Inbox as InboxIcon, Check, Clock, X, CheckCheck, Sparkles, FileText } from 'lucide-react'
import { useApp } from '../store'
import { clsx } from 'clsx'
import type { JSX } from 'react'

/**
 * 收件箱 —— 任务分诊（视觉优先）：
 * AI / 协作者新建的任务以卡片形式到达，一屏之内用三个大按钮完成分诊：
 * 接受（进入看板工作流）/ 稍后（snooze）/ 退回（忽略）。
 */
export function InboxPage(): JSX.Element {
  const inbox = useApp((s) => s.inbox)
  const inboxSetState = useApp((s) => s.inboxSetState)
  const inboxAcceptAll = useApp((s) => s.inboxAcceptAll)
  const showTask = useApp((s) => s.showTask)
  const setPage = useApp((s) => s.setPage)
  const setIntakeOpen = useApp((s) => s.setIntakeOpen)

  const entries = useMemo(() => Object.values(inbox).sort((a, b) => b.ts - a.ts), [inbox])
  const pending = entries.filter((e) => e.state === 'pending')
  const snoozed = entries.filter((e) => e.state === 'snoozed')
  const accepted = entries.filter((e) => e.state === 'accepted')
  const dismissed = entries.filter((e) => e.state === 'dismissed')

  const openTask = (dirName: string): void => {
    setPage('tasks')
    showTask(dirName)
  }

  return (
    <div className="flex h-full min-w-0 animate-fade-in flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 bg-ink-850/40 px-5 py-2.5">
        <InboxIcon size={15} className="text-leaf" />
        <h1 className="text-base font-semibold text-mist-50">收件箱</h1>
        <span className="chip border border-amber-400/30 bg-amber-500/15 text-amber-300">
          {pending.length} 待分诊
        </span>
        <div className="ml-auto flex gap-1.5">
          <button onClick={() => setIntakeOpen(true)} className="btn-outline">
            <Sparkles size={12} /> 发起需求
          </button>
          {pending.length > 0 && (
            <button onClick={inboxAcceptAll} className="btn-primary">
              <CheckCheck size={12} /> 全部接受
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {entries.length === 0 && (
          <div className="grid place-items-center gap-3 py-24 text-mist-600">
            <InboxIcon size={36} strokeWidth={1.2} />
            <div className="text-sm">收件箱为空</div>
            <div className="max-w-sm text-center text-[11.5px] leading-5">
              当 AI 工具（zcode / codex / claude）在项目里新建任务，或协作者导入 Jira 任务时，
              任务会以卡片形式出现在这里，等你分诊后进入看板。
            </div>
          </div>
        )}

        {/* 待分诊 */}
        {pending.length > 0 && (
          <>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-mist-500">待分诊</div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {pending.map((e) => (
                <InboxCard key={e.dirName} entry={e} onOpen={openTask} onSet={inboxSetState} highlight />
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
                <InboxCard key={e.dirName} entry={e} onOpen={openTask} onSet={inboxSetState} />
              ))}
            </div>
          </>
        )}

        {/* 已接受 / 已退回 —— 折叠摘要 */}
        {(accepted.length > 0 || dismissed.length > 0) && (
          <div className="mt-6 flex flex-wrap gap-2">
            {accepted.length > 0 && (
              <span className="chip border border-emerald-400/25 bg-emerald-500/10 text-emerald-300">
                <Check size={11} /> 已接受 {accepted.length} · 已在看板中
              </span>
            )}
            {dismissed.length > 0 && (
              <span className="chip border border-ink-500 text-mist-500">
                <X size={11} /> 已退回 {dismissed.length}
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
  onOpen,
  onSet,
  highlight
}: {
  entry: { dirName: string; title: string; creator: string; ts: number }
  onOpen: (dir: string) => void
  onSet: (dir: string, state: 'accepted' | 'snoozed' | 'dismissed') => void
  highlight?: boolean
}): JSX.Element {
  const time = new Date(entry.ts)
  const timeLabel = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
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
        <div className="mt-1 text-[10.5px] text-mist-500">创建者 {entry.creator || '未知'}</div>
      </button>
      <div className="mt-3 grid grid-cols-3 gap-1.5">
        <button
          onClick={() => onSet(entry.dirName, 'accepted')}
          className="btn-primary justify-center"
          title="接受任务并进入看板"
        >
          <Check size={13} /> 接受
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
          <X size={13} /> 退回
        </button>
      </div>
    </div>
  )
}
