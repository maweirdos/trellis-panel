import { formatCollaborationTime } from '../ui'
/**
 * 收件箱（对标 HiFox Master-Detail 双栏布局）：
 * 左侧：全部/重要/其他 + 稍后 + 已清理分区、任务级聚合、Agent 待确认执行提醒与快捷稍后/清理；
 * 右侧：原地嵌入任务详情，无需跳出收件箱即可回复评论、确认 Agent 交互和流转状态。
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { AlarmClock, ArchiveRestore, Bot, Check, Eraser, Inbox } from 'lucide-react'
import { api } from '../../api'
import { inboxGroups, statusOf, useCrux } from '../store'
import { useTaskRuns } from '../task-run-store'
import { PageHeader, inputClass } from '../ui'
import { Button, EmptyState, Tabs } from '../../my/ui'
import { useNow } from '../../my/ui'
import { EmbeddedTaskPost } from './TaskDetailDrawer'
import type { CruxInboxItem, CruxInboxKind } from '@shared/crux'

const KIND_LABEL: Record<CruxInboxKind, string> = {
  assign: '被指派', mention: '提及', status: '状态', dispatch: '派发', automation: '自动化', triage: '分拣'
}

type InboxTab = 'all' | 'important' | 'other' | 'snoozed' | 'cleared'
let lastInbox: { owner: string; tab: InboxTab; keyword: string; scrollTop: number; expanded: Set<string> } | undefined

export function InboxPage(): JSX.Element {
  const owner = useCrux(s => JSON.stringify([s.workspaceContext.key, s.workspaceContext.actorId, s.workspaceContext.epoch]))
  return <InboxContents key={owner} owner={owner} />
}

function InboxContents({ owner }: { owner: string }): JSX.Element {
  const snapshot = useCrux((s) => s.snapshot)
  const run = useCrux((s) => s.run)
  const openTaskId = useCrux((s) => s.openTaskId)
  const openTask = useCrux((s) => s.openTask)
  const runs = useTaskRuns((s) => s.runs)
  const [initial] = useState(() => lastInbox?.owner === owner ? lastInbox : undefined)
  const [tab, setTab] = useState<InboxTab>(initial?.tab ?? 'all')
  const [keyword, setKeyword] = useState(initial?.keyword ?? '')
  const [expanded, setExpanded] = useState<Set<string>>(() => initial?.expanded ?? new Set())
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(openTaskId)
  const listElement = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (listElement.current && lastInbox?.owner === owner) listElement.current.scrollTop = lastInbox.scrollTop
  }, [owner])
  useLayoutEffect(() => {
    lastInbox = { owner, tab, keyword, expanded, scrollTop: lastInbox?.owner === owner ? lastInbox.scrollTop : 0 }
  }, [owner, tab, keyword, expanded])
  const now = useNow()
  if (!snapshot) return <></>

  const groups = inboxGroups(snapshot.inbox, now)
  const rawList: CruxInboxItem[] =
    tab === 'all' ? [...groups.important, ...groups.other]
    : tab === 'snoozed' ? groups.snoozed
    : tab === 'cleared' ? groups.cleared
    : groups[tab]

  const lowerKeyword = keyword.trim().toLowerCase()
  const list = lowerKeyword
    ? rawList.filter((i) => `${i.title} ${i.body ?? ''} ${i.taskId ?? ''}`.toLowerCase().includes(lowerKeyword))
    : rawList

  const requiresAction = (item: CruxInboxItem): boolean => {
    const task = item.taskId ? snapshot.tasks.find((candidate) => candidate.id === item.taskId) : undefined
    const category = task ? statusOf(snapshot, task.statusId)?.category : undefined
    return Boolean(task && !task.completedAt && !['done', 'cancelled'].includes(category ?? '') && ['assign', 'dispatch', 'triage'].includes(item.kind))
  }
  const aggregated = new Map<string, { first: CruxInboxItem; count: number; unread: boolean; needsAction: boolean; ids: string[]; items: CruxInboxItem[] }>()
  for (const item of list) {
    const key = item.taskId ?? item.id
    const existing = aggregated.get(key)
    if (existing) { existing.count += 1; existing.unread = existing.unread || !item.read; existing.needsAction = existing.needsAction || requiresAction(item); existing.ids.push(item.id); existing.items.push(item) }
    else aggregated.set(key, { first: item, count: 1, unread: !item.read, needsAction: requiresAction(item), ids: [item.id], items: [item] })
  }

  const waitingAgentRuns = runs.filter((entry) => (entry.interaction && !entry.interaction.resolvedAt) || entry.status === 'waiting_local_directory')
  const activeTaskId = selectedTaskId && snapshot.tasks.some((t) => t.id === selectedTaskId) ? selectedTaskId : null

  const markRead = (ids?: string[]) => void run('标记已读', () => api.crux.markInboxRead({ ids: ids ?? rawList.map((item) => item.id) }))
  const selectTaskFromItem = (item: CruxInboxItem) => {
    const ids = aggregated.get(item.taskId ?? item.id)?.ids ?? [item.id]
    if (aggregated.get(item.taskId ?? item.id)?.unread) {
      void run('标记已读', () => api.crux.markInboxRead({ ids }))
    }
    if (item.taskId) {
      setSelectedTaskId(item.taskId)
      openTask(item.taskId)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title="收件箱"
        description="左右分栏处理协作提醒与 AI Agent 交互确认；选中提醒后直接在右侧回复讨论和流转状态。"
        actions={
          <div className="flex items-center gap-2">
            {tab !== 'cleared' && tab !== 'snoozed' && (
              <>
                <Button variant="ghost" size="sm" onClick={() => markRead()}><Check size={13} />全部已读</Button>
                <Button variant="ghost" size="sm" onClick={() => void run('清理通知', () => api.crux.clearInbox({ ids: rawList.map((item) => item.id) }))}>
                  <Eraser size={13} />全部清理
                </Button>
              </>
            )}
          </div>
        }
      />

      <div className="collab-inbox-split" data-detail-open={Boolean(activeTaskId) || undefined}>
        <section className="collab-inbox-pane collab-inbox-list-pane" aria-label="通知列表">
          <div className="flex flex-col gap-2 border-b border-my-line p-3">
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
              className={`${inputClass} w-full`}
              aria-label="搜索协作提醒"
              placeholder="搜索任务标题 / 评论正文 / 任务号"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>

          {waitingAgentRuns.length > 0 && tab !== 'cleared' && (
            <div className="flex flex-col gap-1.5 border-b border-my-line bg-my-warning-subtle px-3 py-2">
              <div className="flex items-center gap-1.5 text-my-2xs font-medium text-my-warning-text">
                <Bot size={13} />
                <span>{waitingAgentRuns.length} 个 AI 执行等待你确认</span>
              </div>
              {waitingAgentRuns.slice(0, 3).map((entry) => {
                const taskTitle = snapshot.tasks.find((item) => item.id === entry.taskId)?.title ?? entry.taskId
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => { setSelectedTaskId(entry.taskId); openTask(entry.taskId) }}
                    className="flex items-center justify-between gap-2 rounded-my-base bg-my-panel px-2.5 py-1.5 text-left text-my-xs text-my-primary hover:bg-my-layer-1-hover"
                  >
                    <span className="min-w-0 flex-1 truncate">{entry.executorName} · {taskTitle}</span>
                    <span className="shrink-0 font-mono text-my-2xs text-my-tertiary">{entry.taskId}</span>
                  </button>
                )
              })}
            </div>
          )}

          <div
            ref={listElement}
            onScroll={event => { if (lastInbox?.owner === owner) lastInbox.scrollTop = event.currentTarget.scrollTop }}
            className="my-scrollbar min-h-0 flex-1 overflow-y-auto"
          >
            {aggregated.size === 0
              ? <EmptyState title="这里很安静" description={tab === 'snoozed' ? '没有稍后处理的通知' : tab === 'cleared' ? '没有已清理的通知' : '没有待处理的通知'} />
              : (
                <ul className="divide-y divide-my-line">
                  {[...aggregated.values()].map(({ first, count, unread, needsAction, ids, items }) => {
                    const key = first.taskId ?? first.id
                    const isExpanded = expanded.has(key)
                    const isSelected = Boolean(first.taskId && first.taskId === activeTaskId)
                    return (
                      <li
                        key={key}
                        className={`group flex flex-wrap items-start gap-2.5 px-3 py-2.5 transition-colors ${isSelected ? 'bg-my-navigation-selected' : 'hover:bg-my-layer-1-hover'} ${first.cleared ? 'opacity-55' : ''}`}
                      >
                        <button
                          type="button"
                          className="mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-my-sm hover:bg-my-layer-2"
                          aria-label={unread ? '标记这一组已读' : '已读'}
                          onClick={() => markRead(ids)}
                        >
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: unread ? 'var(--my-collab-blue)' : 'transparent', border: '1px solid var(--my-border-subtle)' }}
                          />
                        </button>
                        <div className="min-w-0 flex-1">
                          <button type="button" aria-label={`打开提醒：${first.title}`} className="block w-full cursor-pointer text-left" onClick={() => selectTaskFromItem(first)}>
                            <div className="flex items-center gap-1.5">
                              {needsAction && <span className="shrink-0 rounded-my-sm bg-my-warning-subtle px-1.5 py-0.5 text-my-2xs text-my-warning-text">待处理</span>}
                              <p className={`min-w-0 flex-1 truncate text-my-sm ${unread ? 'font-medium text-my-primary' : 'text-my-secondary'}`}>{first.title}</p>
                            </div>
                            <p className="mt-0.5 flex items-center gap-1.5 text-my-xs text-my-tertiary">
                              <span className="rounded-my-sm bg-my-layer-1 px-1 py-0.5 text-my-2xs">{KIND_LABEL[first.kind]}</span>
                              {first.taskId && <span className="font-mono text-my-2xs">{first.taskId}</span>}
                              {first.body && <span className="min-w-0 flex-1 truncate">{first.body}</span>}
                              <span className="shrink-0 tabular-nums">{formatCollaborationTime(first.at)}</span>
                            </p>
                          </button>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-my-xs text-my-tertiary">
                            {count > 1 && (
                              <Button variant="ghost" size="sm" className="h-6 px-1.5 text-my-2xs" aria-expanded={isExpanded} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })}>
                                {isExpanded ? '收起记录' : `展开 ${count} 条`}
                              </Button>
                            )}
                            {first.snoozedUntil && !first.cleared && Date.parse(first.snoozedUntil) > now && (
                              <span className="shrink-0 text-my-warning-text">稍后至 {new Date(first.snoozedUntil).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          {first.cleared
                            ? <Button variant="ghost" size="sm" title="恢复" onClick={() => void run('恢复通知', () => api.crux.restoreInbox({ id: first.id }))}><ArchiveRestore size={13} /></Button>
                            : (
                              <>
                                <Button variant="ghost" size="sm" title="标记已读" aria-label="标记这一组提醒已读" onClick={() => markRead(ids)}><Check size={13} /></Button>
                                <div className="relative">
                                  <details className="group/snooze">
                                    <summary className="grid h-7 w-7 cursor-pointer place-items-center rounded-my-base text-my-icon-secondary hover:bg-my-layer-transparent-hover" title="稍后处理">
                                      <AlarmClock size={13} />
                                    </summary>
                                    <div className="absolute right-0 top-8 z-10 w-28 rounded-my-base border border-my-line bg-my-canvas p-1 shadow-xl">
                                      {([['20m', '20 分钟后'], ['2h', '2 小时后'], ['tomorrow', '明天'], ['nextweek', '下周']] as const).map(([option, label]) => (
                                        <button key={option} type="button" className="w-full rounded-my-sm px-2 py-1 text-left text-my-xs text-my-secondary hover:bg-my-layer-1"
                                          onClick={() => void run('稍后处理', () => api.crux.snoozeInbox({ id: first.id, option }))}>
                                          {label}
                                        </button>
                                      ))}
                                    </div>
                                  </details>
                                </div>
                                <Button variant="ghost" size="sm" title="清理" aria-label="清理这一组提醒" onClick={() => void run('清理通知', () => api.crux.clearInbox({ ids }))}><Eraser size={13} /></Button>
                              </>
                            )}
                        </div>
                        {isExpanded && (
                          <div className="basis-full rounded-my-base bg-my-layer-1 px-2.5 py-2 text-my-xs text-my-tertiary" aria-label="任务提醒记录">
                            <ul className="space-y-1.5">
                              {items.map((item) => (
                                <li key={item.id} className="flex items-start gap-2">
                                  <span className="shrink-0 rounded-my-sm bg-my-layer-2 px-1.5 py-0.5 text-my-2xs">{KIND_LABEL[item.kind]}</span>
                                  <span className="min-w-0 flex-1 break-words">{item.body || item.title}</span>
                                  <span className="shrink-0">{item.read ? '已读' : '未读'} · {formatCollaborationTime(item.at)}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
          </div>
        </section>

        <section className="collab-inbox-pane collab-inbox-detail-pane" aria-label="任务详情预览">
          {activeTaskId ? (
            <EmbeddedTaskPost
              taskId={activeTaskId}
              onClose={() => { setSelectedTaskId(null); openTask(null) }}
            />
          ) : (
            <div className="grid h-full place-items-center p-6">
              <EmptyState
                icon={<Inbox size={22} />}
                title="选择一条提醒查看任务详情"
                description="点击左侧任意通知，可直接在此处回复讨论、处理 Agent 确认并推进状态，无需切换页面。"
              />
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
