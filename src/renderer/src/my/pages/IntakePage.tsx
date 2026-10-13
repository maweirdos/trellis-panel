// 接收（Intake）页：左侧工单列表（状态徽标 / 提交者 / 时间）+ 右侧详情；
// 详情提供 接受/拒绝/标记重复/挂起 状态操作；已接受后可一键转为工作项并打开 peek。
import { useState, type JSX } from 'react'
import { clsx } from 'clsx'
import { useMy } from '../store'
import { Avatar, Button, EmptyState, formatDate } from '../ui'
import { NavIcon, WorkspaceMark } from '../icons'
import type { IntakeIssue, IntakeStatus, Member } from '../types'

/* ---------------- 常量 ---------------- */

const STATUS_META: Record<IntakeStatus, { label: string; className: string }> = {
  pending: { label: '待接受', className: 'bg-my-warning-subtle text-my-warning-text' },
  accepted: { label: '已接受', className: 'bg-my-success-subtle text-my-success-text' },
  declined: { label: '已拒绝', className: 'bg-my-danger-subtle text-my-danger-text' },
  duplicate: { label: '重复', className: 'bg-my-layer-3 text-my-tertiary' },
  snoozed: { label: '已挂起', className: 'bg-my-info-subtle text-my-info-text' }
}

/* ---------------- 小件 ---------------- */

function StatusBadge({ status }: { status: IntakeStatus }): JSX.Element {
  const meta = STATUS_META[status]
  return (
    <span
      className={clsx(
        'inline-flex h-[20px] shrink-0 items-center rounded-[4px] px-1.5 text-[11px] font-medium',
        meta.className
      )}
    >
      {meta.label}
    </span>
  )
}

/* ---------------- 左侧列表项 ---------------- */

function IntakeListItem({
  item,
  submitter,
  selected,
  onSelect
}: {
  item: IntakeIssue
  submitter: Member | null
  selected: boolean
  onSelect: (id: string) => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className={clsx(
        'block w-full border-b border-my-line p-3 text-left transition-colors',
        selected ? 'bg-my-layer-1' : 'hover:bg-my-layer-1'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-my-primary">{item.title}</span>
        <StatusBadge status={item.status} />
      </div>
      <p className="mt-1 truncate text-[12px] text-my-tertiary">{item.description}</p>
      <div className="mt-2 flex min-w-0 items-center gap-1.5">
        {submitter ? <Avatar name={submitter.name} color={submitter.avatarColor} size={16} /> : null}
        <span className="min-w-0 truncate text-[11px] text-my-tertiary">
          {submitter ? submitter.name : '未知用户'} · {formatDate(item.createdAt)}
        </span>
      </div>
    </button>
  )
}

/* ---------------- 右侧详情 ---------------- */

function IntakeDetail({
  item,
  submitter,
  projectName
}: {
  item: IntakeIssue
  submitter: Member | null
  projectName: string
}): JSX.Element {
  const setIntakeStatus = useMy((s) => s.setIntakeStatus)
  const createIssue = useMy((s) => s.createIssue)
  const openIssue = useMy((s) => s.openIssue)

  /** 已接受的工单一键转为正式工作项，并打开 peek 详情 */
  const convertToIssue = (): void => {
    const newId = createIssue({
      projectId: item.projectId,
      name: item.title,
      priority: 'medium',
      description: item.description
    })
    openIssue(newId)
  }

  return (
    <div className="p-6">
      {/* 标题与状态 */}
      <div className="flex items-start justify-between gap-4">
        <h2 className="min-w-0 text-[16px] font-semibold leading-6 text-my-primary">{item.title}</h2>
        <StatusBadge status={item.status} />
      </div>

      {/* 描述 */}
      <p className="mt-3 whitespace-pre-wrap text-[13px] leading-6 text-my-secondary">{item.description}</p>

      {/* 提交信息 */}
      <div className="mt-5 flex items-center gap-2 rounded-lg border border-my-line bg-my-layer-1 p-3">
        {submitter ? <Avatar name={submitter.name} color={submitter.avatarColor} size={20} /> : null}
        <span className="text-[12px] text-my-secondary">{submitter ? submitter.name : '未知用户'}</span>
        <span className="text-[12px] text-my-tertiary">
          提交于 {formatDate(item.createdAt)} · 所属项目 {projectName}
        </span>
      </div>

      {/* 状态操作行 */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => setIntakeStatus(item.id, 'accepted')}>
          接受
        </Button>
        <Button onClick={() => setIntakeStatus(item.id, 'declined')}>拒绝</Button>
        <Button onClick={() => setIntakeStatus(item.id, 'duplicate')}>标记重复</Button>
        <Button onClick={() => setIntakeStatus(item.id, 'snoozed')}>挂起</Button>
        {item.status === 'accepted' && (
          <Button variant="primary" onClick={() => convertToIssue()} title="创建同名工作项并打开详情">
            转为工作项
          </Button>
        )}
      </div>
      <p className="mt-2 text-[11px] text-my-disabled">演示模式：状态操作仅修改内存数据。</p>
    </div>
  )
}

/* ---------------- 页面入口 ---------------- */

export function IntakePage(): JSX.Element {
  const data = useMy((s) => s.data)
  const activeProjectId = useMy((s) => s.activeProjectId)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const project = data.projects.find((p) => p.id === activeProjectId) ?? data.projects[0]
  const items = data.intake.filter((i) => i.projectId === project.id)
  const pendingCount = items.filter((i) => i.status === 'pending').length
  // 默认选中第一条；点击后以本地 state 为准
  const selected = items.find((i) => i.id === selectedId) ?? items[0] ?? null
  const submitterOf = (item: IntakeIssue): Member | null =>
    data.members.find((m) => m.id === item.submittedBy) ?? null

  return (
    <div className="flex h-full min-h-0 flex-col bg-my-canvas">
      {/* 顶栏 52px：面包屑 + 待处理计数 */}
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-my-line bg-my-canvas px-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <WorkspaceMark color={project.color} letter={project.icon} size={16} />
          <span className="truncate text-[13px] font-medium text-my-primary">{project.name}</span>
          <span className="text-my-disabled">/</span>
          <NavIcon name="intake" size={14} className="text-my-icon-tertiary" />
          <span className="shrink-0 text-[13px] text-my-tertiary">Intake</span>
        </div>
        <span className="ml-auto shrink-0 text-[12px] text-my-tertiary">{pendingCount} 条待接受</span>
      </header>

      {/* 两栏主体 */}
      <div className="flex min-h-0 flex-1">
        {/* 左列表 */}
        <aside className="flex w-[360px] shrink-0 flex-col border-r border-my-line">
          <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <EmptyState title="暂无接收工单" description="该项目还没有用户提交的工单。" />
            ) : (
              items.map((item) => (
                <IntakeListItem
                  key={item.id}
                  item={item}
                  submitter={submitterOf(item)}
                  selected={selected !== null && selected.id === item.id}
                  onSelect={(id) => setSelectedId(id)}
                />
              ))
            )}
          </div>
        </aside>

        {/* 右详情 */}
        <section className="my-scrollbar min-h-0 flex-1 overflow-y-auto">
          {selected === null ? (
            <EmptyState title="选择一条接收工单" description="从左侧列表选择工单查看详情并处理。" />
          ) : (
            <IntakeDetail
              key={selected.id}
              item={selected}
              submitter={submitterOf(selected)}
              projectName={project.name}
            />
          )}
        </section>
      </div>
    </div>
  )
}
