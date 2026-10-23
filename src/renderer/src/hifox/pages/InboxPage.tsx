/**
 * 收件箱：全部/重要/其他 + 稍后 + 已清理（REA 实测分区模型），
 * 任务级聚合展示、分区未读数、分区级全部已读/全部清理、稍后选项。
 */
import { useState } from 'react'
import { AlarmClock, ArchiveRestore, Check, Eraser } from 'lucide-react'
import { api } from '../../api'
import { useHifox, inboxGroups } from '../store'
import { PageHeader, StatusBadge, inputClass } from '../ui'
import { Button, EmptyState, Tabs } from '../../my/ui'
import { useNow, formatDate } from '../../my/ui'
import type { HifoxInboxItem, HifoxInboxKind } from '@shared/hifox'

const KIND_LABEL: Record<HifoxInboxKind, string> = {
  assign: '被指派', mention: '提及', status: '状态', dispatch: '派发', automation: '自动化', triage: '分拣'
}

export function InboxPage(): JSX.Element {
  const snapshot = useHifox((s) => s.snapshot)!
  const run = useHifox((s) => s.run)
  const openTask = useHifox((s) => s.openTask)
  const setModule = useHifox((s) => s.setModule)
  const [tab, setTab] = useState<'all' | 'important' | 'other' | 'snoozed' | 'cleared'>('all')
  const [keyword, setKeyword] = useState('')
  const now = useNow()

  const groups = inboxGroups(snapshot.inbox, now)
  const rawList: HifoxInboxItem[] =
    tab === 'all' ? [...groups.important, ...groups.other]
    : tab === 'snoozed' ? groups.snoozed
    : tab === 'cleared' ? groups.cleared
    : groups[tab]
  // PRD 2.6：按任务标题/评论正文搜索（客户端过滤，聚合前生效）
  const lowerKeyword = keyword.trim().toLowerCase()
  const list = lowerKeyword
    ? rawList.filter((i) => `${i.title} ${i.body ?? ''} ${i.taskId ?? ''}`.toLowerCase().includes(lowerKeyword))
    : rawList

  // 任务级聚合：同一任务合并一行，角标显示条数（REA 实测）
  const aggregated = new Map<string, { first: HifoxInboxItem; count: number; unread: boolean }>()
  for (const item of list) {
    const key = item.taskId ?? item.id
    const existing = aggregated.get(key)
    if (existing) { existing.count += 1; existing.unread = existing.unread || !item.read }
    else aggregated.set(key, { first: item, count: 1, unread: !item.read })
  }

  const markRead = (ids?: string[]) => void run('标记已读', () => api.hifox.markInboxRead(ids ? { ids } : tab === 'important' || tab === 'other' ? { section: tab } : { all: true }))
  const openTaskFromItem = (item: HifoxInboxItem) => {
    if (!item.read) void run('标记已读', () => api.hifox.markInboxRead({ ids: [item.id] }))
    if (item.taskId) { openTask(item.taskId); setModule('tasks') }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title="收件箱"
        description="与你相关的提醒按任务聚合；重要=被指派/@提及/执行异常，其他=状态与自动化更新"
        actions={
          <div className="flex items-center gap-2">
            {tab !== 'cleared' && tab !== 'snoozed' && (
              <>
                <Button variant="ghost" size="sm" onClick={() => markRead()}><Check size={13} />全部已读</Button>
                <Button variant="ghost" size="sm" onClick={() => void run('清理通知', () => api.hifox.clearInbox(tab === 'important' || tab === 'other' ? { section: tab } : { all: true }))}>
                  <Eraser size={13} />全部清理
                </Button>
              </>
            )}
          </div>
        }
      />
      <Tabs
        active={tab}
        onChange={(id) => setTab(id as typeof tab)}
        tabs={[
          { id: 'all', label: '全部' },
          { id: 'important', label: '重要', count: groups.unread.important },
          { id: 'other', label: '其他', count: groups.unread.other },
          { id: 'snoozed', label: '稍后', count: groups.snoozed.length },
          { id: 'cleared', label: '已清理', count: groups.cleared.length }
        ]}
      />
      <input
        className={`${inputClass} w-64 shrink-0`}
        placeholder="搜索任务标题 / 评论正文 / 任务号"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
      />
      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto rounded-my-md border border-my-line bg-my-layer/40">
        {aggregated.size === 0
          ? <EmptyState title="这里很安静" description={tab === 'snoozed' ? '没有稍后处理的通知' : tab === 'cleared' ? '没有已清理的通知' : '没有待处理的通知'} />
          : (
            <ul className="divide-y divide-my-line/60">
              {[...aggregated.values()].map(({ first, count, unread }) => (
                <li key={first.taskId ?? first.id} className={`group flex items-start gap-3 px-3 py-2.5 ${first.cleared ? 'opacity-55' : ''}`}>
                  <button type="button" className="mt-1 h-2 w-2 shrink-0 rounded-full" aria-label={unread ? '未读' : '已读'}
                    style={{ backgroundColor: unread ? (first.section === 'important' ? '#ef4444' : '#3b82f6') : 'transparent', border: unread ? 'none' : '1px solid var(--my-line, #444)' }}
                    onClick={() => markRead([first.id])} />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openTaskFromItem(first)}>
                    <p className={`truncate text-my-sm ${unread ? 'font-medium text-my-primary' : 'text-my-secondary'}`}>{first.title}</p>
                    <p className="mt-0.5 flex items-center gap-2 text-my-xs text-my-tertiary">
                      <span className="rounded-my-sm bg-my-layer px-1 py-0.5 text-[10px]">{KIND_LABEL[first.kind]}</span>
                      {first.taskId && <span className="font-mono text-[10px]">{first.taskId}</span>}
                      {first.body && <span className="min-w-0 flex-1 truncate">{first.body}</span>}
                      {count > 1 && <span className="shrink-0 rounded-full bg-my-layer-active px-1.5 text-[10px]">+{count - 1}</span>}
                      <span className="shrink-0">{formatDate(first.at)}</span>
                      {first.snoozedUntil && !first.cleared && Date.parse(first.snoozedUntil) > now && (
                        <span className="shrink-0 text-amber-500">稍后至 {new Date(first.snoozedUntil).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      )}
                    </p>
                  </button>
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    {first.cleared
                      ? <Button variant="ghost" size="sm" title="恢复" onClick={() => void run('恢复通知', () => api.hifox.restoreInbox({ id: first.id }))}><ArchiveRestore size={13} /></Button>
                      : (
                        <>
                          <Button variant="ghost" size="sm" title="标记已读" onClick={() => markRead([first.id])}><Check size={13} /></Button>
                          <div className="relative">
                            <details className="group/snooze">
                              <summary className="grid h-7 w-7 cursor-pointer place-items-center rounded-my-md text-my-icon-secondary hover:bg-my-layer-transparent-hover" title="稍后处理">
                                <AlarmClock size={13} />
                              </summary>
                              <div className="absolute right-0 top-8 z-10 w-28 rounded-my-md border border-my-line bg-my-canvas p-1 shadow-xl">
                                {([['20m', '20 分钟后'], ['2h', '2 小时后'], ['tomorrow', '明天'], ['nextweek', '下周']] as const).map(([option, label]) => (
                                  <button key={option} type="button" className="w-full rounded-my-sm px-2 py-1 text-left text-my-xs text-my-secondary hover:bg-my-layer"
                                    onClick={() => void run('稍后处理', () => api.hifox.snoozeInbox({ id: first.id, option }))}>
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </details>
                          </div>
                          <Button variant="ghost" size="sm" title="清理" onClick={() => void run('清理通知', () => api.hifox.clearInbox({ ids: [first.id] }))}><Eraser size={13} /></Button>
                        </>
                      )}
                  </div>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  )
}
