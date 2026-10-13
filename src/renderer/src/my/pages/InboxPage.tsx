// 收件箱页（R14 演示入口）：全部 / 未读 / 提及 三个页签 + 通知列表。
import { useState, type JSX } from 'react'
import { AtSign, Eye, PlusCircle, User, type LucideIcon } from 'lucide-react'
import { useMy } from '../store'
import { EmptyState, Tabs, formatDate } from '../ui'
import { WorkspaceMark } from '../icons'
import type { NotificationItem, Project } from '../types'

type InboxTab = 'all' | 'unread' | 'mention'

/** 通知类型 → 图标 */
const KIND_ICONS: Record<NotificationItem['kind'], LucideIcon> = {
  assigned: User,
  mention: AtSign,
  created: PlusCircle,
  subscribed: Eye
}

/* ---------------- 通知行 ---------------- */

function InboxRow({
  item,
  project,
  onOpen
}: {
  item: NotificationItem
  project: Project | undefined
  onOpen: () => void
}): JSX.Element {
  const Icon = KIND_ICONS[item.kind]
  return (
    <div
      onClick={onOpen}
      role="button"
      className="flex w-full cursor-pointer items-start gap-3 p-3.5 hover:bg-my-layer-1"
    >
      {/* 未读圆点（已读则透明占位） */}
      <span
        className={
          item.read
            ? 'mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-transparent'
            : 'mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-my-accent'
        }
      />
      {/* 类型图标 */}
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-my-line bg-my-layer-2 text-my-icon-secondary">
        <Icon size={14} />
      </span>
      {/* 标题 / 摘要 / 元信息 */}
      <span className="min-w-0 flex-1">
        <span
          className={
            item.read
              ? 'block truncate text-[13px] text-my-secondary'
              : 'block truncate text-[13px] font-medium text-my-primary'
          }
        >
          {item.title}
        </span>
        <span className="mt-0.5 block truncate text-[12px] text-my-tertiary">{item.body}</span>
        <span className="mt-1 block text-[11px] text-my-tertiary">
          {project ? project.name : '未知项目'} · {formatDate(item.at)}
        </span>
      </span>
      {/* 右侧项目标记 */}
      {project && <WorkspaceMark color={project.color} letter={project.icon.slice(0, 1)} size={18} />}
    </div>
  )
}

/* ---------------- 页面 ---------------- */

export function InboxPage(): JSX.Element {
  const { data, markNotificationRead, navigateProject, openIssue } = useMy()
  const [tab, setTab] = useState<InboxTab>('all')

  const unreadCount = data.notifications.filter((n) => !n.read).length
  const list = data.notifications.filter((n) => {
    if (tab === 'unread') return !n.read
    if (tab === 'mention') return n.kind === 'mention'
    return true
  })

  // 打开通知：标记已读 → 跳到对应项目 → 打开工作项详情
  const openNotification = (n: NotificationItem): void => {
    markNotificationRead(n.id)
    navigateProject(n.projectId)
    openIssue(n.issueId)
  }

  return (
    <div>
      {/* 顶栏 + 页签 */}
      <header className="px-8 pb-4 pt-6">
        <h1 className="text-[20px] font-semibold text-my-primary">Inbox</h1>
        <div className="mt-3">
          <Tabs<InboxTab>
            tabs={[
              { id: 'all', label: '全部' },
              { id: 'unread', label: '未读', count: unreadCount },
              { id: 'mention', label: '提及' }
            ]}
            active={tab}
            onChange={(t) => setTab(t)}
          />
        </div>
      </header>

      {/* 通知列表 */}
      <div className="mx-auto max-w-[720px] pb-16">
        <div className="divide-y divide-my-line">
          {list.map((n) => {
            const project = data.projects.find((p) => p.id === n.projectId)
            return (
              <InboxRow key={n.id} item={n} project={project} onOpen={() => openNotification(n)} />
            )
          })}
        </div>
        {list.length === 0 && (
          <EmptyState title="暂无通知" description="指派、提及与关注的工作项动态会出现在这里。" />
        )}
      </div>
    </div>
  )
}
