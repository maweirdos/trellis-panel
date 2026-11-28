import { useLayoutEffect, useState, type JSX } from 'react'
import { AlarmClock, ArchiveRestore, ArrowLeft, Check, CheckCheck, Eraser, Inbox } from 'lucide-react'
import type { CruxInboxItem, CruxInboxKind } from '@shared/crux'
import { api } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { Button, Dropdown, DropdownItem, EmptyState, Tabs, Tooltip, useNow } from '../../my/ui'
import { inboxGroups, statusOf, useCrux } from '../store'
import { formatCollaborationTime, PageHeader, StatusBadge } from '../ui'
import { EmbeddedTaskPost } from './TaskDetailDrawer'

type InboxTab = 'important' | 'other' | 'snoozed' | 'cleared'

const KIND_LABEL: Record<CruxInboxKind, string> = {
  assign: '任务指派',
  mention: '@提及',
  status: '状态更新',
  dispatch: '派发动态',
  automation: '自动化结果',
  triage: '待分拣提醒'
}

export function InboxPage(): JSX.Element | null {
  const snapshot = useCrux((s) => s.snapshot)
  const currentSpaceId = useCrux((s) => s.currentSpaceId)
  const openTask = useCrux((s) => s.openTask)
  const run = useCrux((s) => s.run)
  const busy = useCrux((s) => s.busy)
  const owner = useCrux((s) => JSON.stringify([s.workspaceContext.key, s.workspaceContext.actorId, s.workspaceContext.epoch]))

  const now = useNow()
  const [tab, setTab] = useState<InboxTab>('important')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useLayoutEffect(() => {
    setSelectedId(null)
  }, [owner])

  if (!snapshot) return null

  const taskMap = new Map(snapshot.tasks.map((task) => [task.id, task]))
  const scopedItems = snapshot.inbox.filter((item) => {
    if (!currentSpaceId) return true
    if (item.spaceId) return item.spaceId === currentSpaceId
    if (item.taskId) return taskMap.get(item.taskId)?.spaceId === currentSpaceId
    return true
  })

  const groups = inboxGroups(scopedItems, now)
  const currentItems: CruxInboxItem[] = groups[tab]
  const selectedItem = currentItems.find((item) => item.id === selectedId) ?? currentItems[0] ?? null
  const selectedTask = selectedItem?.taskId ? taskMap.get(selectedItem.taskId) ?? null : null

  const activeSection = tab === 'important' || tab === 'other' ? tab : null
  const totalUnread = groups.unread.important + groups.unread.other

  const markAllRead = async (): Promise<void> => {
    if (!activeSection) return
    await run('全部标为已读', () => api.crux.markInboxRead({ all: true, section: activeSection }))
  }

  const clearSection = async (): Promise<void> => {
    if (!activeSection || !currentItems.length) return
    const ok = await confirmDialog({
      title: `清理「${activeSection === 'important' ? '重要通知' : '其他动态'}」？`,
      message: `将 ${currentItems.length} 条通知移入「已清理」，不会删除任何任务或评论记录，需要时可随时恢复。`,
      confirmText: '移入已清理'
    })
    if (!ok) return
    await run('批量清理通知', () => api.crux.clearInbox({ all: true, section: activeSection }))
  }

  const snooze = (id: string, option: '20m' | '2h' | 'tomorrow' | 'nextweek'): void => {
    void run('延后处理通知', () => api.crux.snoozeInbox({ id, option }))
  }

  const markRead = (id: string): void => {
    void run('标记已读', () => api.crux.markInboxRead({ ids: [id] }))
  }

  const clearOne = (id: string): void => {
    void run('清理通知', () => api.crux.clearInbox({ ids: [id] }))
  }

  const restoreOne = (id: string): void => {
    void run('恢复通知', () => api.crux.restoreInbox({ id }))
  }

  const tabOptions: Array<{ id: InboxTab; label: string; count: number }> = [
    { id: 'important', label: '重要', count: groups.important.length },
    { id: 'other', label: '其他', count: groups.other.length },
    { id: 'snoozed', label: '稍后', count: groups.snoozed.length },
    { id: 'cleared', label: '已清理', count: groups.cleared.length }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="收件箱"
        description={totalUnread > 0 ? `${totalUnread} 条未读提醒，按重要程度自动分区。` : '所有重要提醒均已查看。'}
        actions={
          activeSection && currentItems.length > 0 ? (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void markAllRead()}>
                <CheckCheck size={14} />
                <span>全部已读</span>
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void clearSection()}>
                <Eraser size={14} />
                <span>全部清理</span>
              </Button>
            </div>
          ) : undefined
        }
      />

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <Tabs tabs={tabOptions} active={tab} onChange={setTab} ariaLabel="收件箱分类" />
        {activeSection && groups.unread[activeSection] > 0 && (
          <span className="text-my-xs tabular-nums text-my-tertiary">未读 {groups.unread[activeSection]} 条</span>
        )}
      </div>

      {currentItems.length === 0 ? (
        <EmptyState
          icon={<Inbox size={28} />}
          title={
            tab === 'important'
              ? '暂无重要通知'
              : tab === 'other'
                ? '暂无其他动态'
                : tab === 'snoozed'
                  ? '暂无稍后处理项'
                  : '暂无已清理记录'
          }
          description="与当前空间相关的任务指派、@提及、状态变更及自动化运行提醒会集中展示在这里。"
        />
      ) : (
        <div key={tab} data-detail-open={Boolean(selectedId)} className="my-subview-stage collab-inbox-split min-h-0 flex-1">
          <div className="collab-inbox-pane collab-inbox-list-pane my-card my-scrollbar min-h-0 overflow-y-auto p-1.5">
            <ul className="space-y-1">
              {currentItems.map((item) => {
                const task = item.taskId ? taskMap.get(item.taskId) : undefined
                const taskStatus = task ? statusOf(snapshot, task.statusId) : undefined
                const active = selectedItem?.id === item.id
                return (
                  <li key={item.id}>
                    <div
                      className={`group rounded-my-base border px-3 py-2.5 transition-colors duration-150 ease-out ${
                        active
                          ? 'border-my-line-strong bg-my-layer-2'
                          : 'border-transparent hover:bg-my-layer-1'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(item.id)
                          if (!item.read) markRead(item.id)
                        }}
                        className="flex w-full flex-col gap-1.5 text-left"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              item.read ? 'bg-transparent' : 'bg-my-accent'
                            }`}
                          />
                          <span className="rounded-my-sm bg-my-layer-1 px-1.5 py-0.5 text-my-2xs text-my-secondary">
                            {KIND_LABEL[item.kind]}
                          </span>
                          {task && <span className="font-mono text-my-2xs text-my-tertiary">{task.id}</span>}
                          <span className="ml-auto shrink-0 text-my-2xs tabular-nums text-my-tertiary">
                            {formatCollaborationTime(item.at)}
                          </span>
                        </div>
                        <div className="my-item-title truncate text-my-sm font-medium text-my-primary">{item.title}</div>
                        {item.body && <p className="line-clamp-2 text-my-xs text-my-secondary">{item.body}</p>}
                      </button>

                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div>{taskStatus && <StatusBadge status={taskStatus} />}</div>
                        <div className="flex items-center gap-1 opacity-85 transition-opacity group-hover:opacity-100">
                          {tab !== 'cleared' ? (
                            <>
                              {!item.read && (
                                <Tooltip label="标记已读">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label="标记已读"
                                    disabled={busy}
                                    onClick={() => markRead(item.id)}
                                  >
                                    <Check size={13} />
                                  </Button>
                                </Tooltip>
                              )}
                              <Dropdown
                                align="right"
                                width={140}
                                trigger={({ toggle, open }) => (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label="稍后提醒"
                                    aria-expanded={open}
                                    disabled={busy}
                                    onClick={toggle}
                                  >
                                    <AlarmClock size={13} />
                                  </Button>
                                )}
                              >
                                {(close) => (
                                  <>
                                    <DropdownItem onClick={() => { snooze(item.id, '20m'); close() }}>20 分钟后</DropdownItem>
                                    <DropdownItem onClick={() => { snooze(item.id, '2h'); close() }}>2 小时后</DropdownItem>
                                    <DropdownItem onClick={() => { snooze(item.id, 'tomorrow'); close() }}>明天 09:00</DropdownItem>
                                    <DropdownItem onClick={() => { snooze(item.id, 'nextweek'); close() }}>下周一 09:00</DropdownItem>
                                  </>
                                )}
                              </Dropdown>
                              <Tooltip label="清理此条">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  aria-label="清理此条"
                                  disabled={busy}
                                  onClick={() => clearOne(item.id)}
                                >
                                  <Eraser size={13} />
                                </Button>
                              </Tooltip>
                            </>
                          ) : (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => restoreOne(item.id)}>
                              <ArchiveRestore size={13} />
                              <span>恢复</span>
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>

          <section className="collab-inbox-pane collab-inbox-detail-pane my-card flex min-h-0 flex-col overflow-hidden">
            {selectedTask ? (
              <EmbeddedTaskPost
                key={selectedTask.id}
                taskId={selectedTask.id}
                onClose={() => setSelectedId(null)}
              />
            ) : selectedItem ? (
              <div className="my-scrollbar flex flex-1 flex-col gap-3 overflow-y-auto p-5">
                <div className="flex items-center gap-2 text-my-xs text-my-tertiary">
                  <Button size="sm" variant="ghost" onClick={() => setSelectedId(null)} className="shrink-0">
                    <ArrowLeft size={13} />
                    <span>返回列表</span>
                  </Button>
                  <span className="rounded-my-sm bg-my-layer-1 px-1.5 py-0.5 text-my-secondary">
                    {KIND_LABEL[selectedItem.kind]}
                  </span>
                  <span className="tabular-nums">{formatCollaborationTime(selectedItem.at)}</span>
                </div>
                <h2 className="text-my-base font-medium text-my-primary">{selectedItem.title}</h2>
                {selectedItem.body && (
                  <p className="whitespace-pre-wrap text-my-sm leading-relaxed text-my-secondary">
                    {selectedItem.body}
                  </p>
                )}
                {selectedItem.taskId && (
                  <div className="pt-2">
                    <Button size="sm" variant="outline" onClick={() => openTask(selectedItem.taskId!)}>
                      打开关联任务
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <EmptyState icon={<Inbox size={24} />} title="选择一条通知查看详情" description="左侧点击任意通知即可在此就地阅读并直接处理关联任务。" />
            )}
          </section>
        </div>
      )}
    </div>
  )
}
