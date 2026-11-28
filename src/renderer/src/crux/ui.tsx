/**
 * Crux 模块内共享 UI 基件：沿用 my 设计令牌与组件，补充域内徽章/抽屉。
 */
import { cloneElement, isValidElement, useId, type ReactNode } from 'react'
import { Info, X } from 'lucide-react'
import { Button, Modal, Tooltip } from '../my/ui'
import { PriorityIcon as MyPriorityIcon, StateGroupIcon } from '../my/icons'
import { Select, type SelectOption } from '../components/Select'
import { FlowIcon } from './icons'
import type { FlowIconName } from './icons'
import type {
  CruxMember,
  CruxPriority,
  CruxSnapshot,
  CruxTaskLabel,
  CruxTaskStatus
} from '@shared/crux'
import { PRIORITY_ICON_CLASS, PRIORITY_LABEL, statusDisplayName } from './store'
import { CRUX_STATE_GROUPS, cruxStatusColor } from './task-workspace-adapter'

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }): JSX.Element {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-my-line pb-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h1 className="truncate text-my-lg font-medium text-my-primary">{title}</h1>
        {description && <Tooltip label={description} side="bottom" wrap><button type="button" aria-label={`关于${title}`} className="my-icon-control shrink-0 text-my-icon-tertiary"><Info size={14} /></button></Tooltip>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}

export function MemberChip({ member, size = 'md' }: { member?: CruxMember; size?: 'sm' | 'md' }): JSX.Element | null {
  if (!member) return null
  const dim = size === 'sm' ? 'h-5 w-5 text-my-2xs' : 'h-6 w-6 text-my-xs'
  const hue = typeof member.avatarHue === 'number' && Number.isFinite(member.avatarHue)
    ? member.avatarHue
    : ((member.name.charCodeAt(0) || 4) * 53) % 360
  return (
    <span className="inline-flex items-center gap-1.5" title={member.title ? `${member.name} · ${member.title}` : member.name}>
      <span
        className={`grid ${dim} shrink-0 place-items-center rounded-full font-medium text-my-on-color`}
        style={{ backgroundColor: `hsl(${hue} 26% 38%)` }}
      >
        {member.name.slice(0, 1)}
      </span>
      {size === 'md' && <span className="my-item-title truncate">{member.name}</span>}
    </span>
  )
}

export function StatusBadge({ status }: { status?: CruxTaskStatus }): JSX.Element {
  if (!status) return <span className="rounded-my-base bg-my-layer-1 px-1.5 py-0.5 text-my-xs text-my-tertiary">—</span>
  return (
    <span className="inline-flex items-center gap-1.5 rounded-my-base bg-my-layer-1 px-1.5 py-0.5 text-my-xs font-normal text-my-secondary">
      <StateGroupIcon stateGroup={CRUX_STATE_GROUPS[status.category]} size={13} color={cruxStatusColor(status.category)} />
      {statusDisplayName(status)}
    </span>
  )
}

export function PriorityBadge({ priority }: { priority: CruxPriority }): JSX.Element {
  return (
    <span data-priority={priority} className="inline-flex items-center gap-1.5 rounded-my-base bg-my-layer-1 px-1.5 py-0.5 text-my-xs font-normal text-my-secondary">
      <MyPriorityIcon priority={priority} size={13} className={PRIORITY_ICON_CLASS[priority]} />
      {PRIORITY_LABEL[priority]}
    </span>
  )
}

export function LabelChip({ label }: { label: CruxTaskLabel }): JSX.Element {
  return (
    <span className="inline-flex items-center rounded-my-base px-1.5 py-0.5 text-my-xs" style={{ backgroundColor: `color-mix(in srgb, ${label.color} 13%, transparent)`, color: label.color }}>
      {label.name}
    </span>
  )
}

export function ExecutorBadge({ executor, dispatchNote }: { executor: { kind: 'agent' | 'crew'; id: string; name: string } | undefined; dispatchNote?: string }): JSX.Element | null {
  if (!executor) return null
  return (
    <span
      className="inline-flex items-center gap-1 rounded-my-base bg-my-layer-1 px-1.5 py-0.5 text-my-xs font-normal text-my-secondary"
      title={dispatchNote ?? `执行槽：${executor.name}（${executor.kind === 'agent' ? 'Agent' : '小队'}）`}
    >
      <FlowIcon name={executor.kind === 'agent' ? 'agents' : 'crews'} size={14} />{executor.name}
    </span>
  )
}

export function DispatchNote({ dispatch }: { dispatch?: { status: string; since: string; note?: string } }): JSX.Element | null {
  if (!dispatch) return null
  const waiting = dispatch.status === 'waiting_runtime'
  return (
    <Tooltip label={dispatch.note ?? (waiting ? '实际执行等待运行环境接入' : '任务已进入待安排队列')} side="bottom" wrap><span tabIndex={0} className="inline-flex items-center gap-1.5 rounded-my-base bg-my-layer-1 px-2.5 py-1.5 text-my-xs text-my-secondary"><FlowIcon name={waiting ? 'agents' : 'backlog'} size={14} /><span>{waiting ? '等待运行环境' : '待安排'}</span></span></Tooltip>
  )
}

/** Task details share the canonical modal's focus, Escape and viewport ownership. */
export function Drawer({ open, title, onClose, children, width = 520 }: { open: boolean; title: string; onClose: () => void; children: ReactNode; width?: number }): JSX.Element | null {
  return (
    <Modal open={open} onClose={onClose} width={width} ariaLabel={title}>
      <div className="relative flex max-h-[var(--my-modal-max-height)] flex-col bg-my-canvas">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-my-line px-5">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-my-primary">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭详情">
            <X size={16} />
          </Button>
        </header>
        <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </Modal>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }): JSX.Element {
  const generatedId = useId()
  const direct = isValidElement<{ id?: string; 'aria-describedby'?: string }>(children) && (children.type === Select || (typeof children.type === 'string' && ['input', 'select', 'textarea'].includes(children.type)))
  const controlId = direct ? children.props.id ?? generatedId : undefined
  const labelId = `${generatedId}-label`
  const hintId = `${generatedId}-hint`
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-my-sm text-my-secondary" role={direct ? undefined : 'group'} aria-labelledby={direct ? undefined : labelId}>
      <label id={labelId} htmlFor={controlId} className="pl-0.5 text-my-xs font-normal text-my-secondary">{label}</label>
      {direct ? cloneElement(children, { id: controlId, 'aria-describedby': hint ? [children.props['aria-describedby'], hintId].filter(Boolean).join(' ') : children.props['aria-describedby'] }) : children}
      {hint && <span id={hintId} className="my-item-description pl-0.5">{hint}</span>}
    </div>
  )
}

export { Select, type SelectOption }

export const inputClass = 'my-input w-full'
export const compactInputClass = inputClass.replace('w-full', 'w-auto')
export const textareaClass = 'my-input my-scrollbar h-auto w-full min-w-0 resize-none whitespace-pre-wrap break-words'

export function formatCollaborationTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

export function selectSnapshotCount(snapshot: CruxSnapshot, spaceId: string | null): { tasks: number; done: number; blocked: number; agents: number; members: number } {
  const tasks = spaceId ? snapshot.tasks.filter((t) => t.spaceId === spaceId) : snapshot.tasks
  const statuses = new Map(snapshot.taskStatuses.map((s) => [s.id, s]))
  return {
    tasks: tasks.length,
    done: tasks.filter((t) => statuses.get(t.statusId)?.category === 'done').length,
    blocked: tasks.filter((t) => statuses.get(t.statusId)?.category === 'blocked').length,
    agents: spaceId ? snapshot.agents.filter((a) => a.spaceId === spaceId).length : snapshot.agents.length,
    members: spaceId ? snapshot.spaces.find((s) => s.id === spaceId)?.memberIds.length ?? 0 : snapshot.members.length
  }
}
