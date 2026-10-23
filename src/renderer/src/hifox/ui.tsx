/**
 * HiFox 模块内共享 UI 基件：沿用 my 设计令牌与组件，补充域内徽章/抽屉。
 */
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from '../my/ui'
import type {
  HifoxMember,
  HifoxPriority,
  HifoxSnapshot,
  HifoxTaskLabel,
  HifoxTaskStatus
} from '@shared/hifox'
import { PRIORITY_CLASS, PRIORITY_LABEL, STATUS_CATEGORY_CLASS } from './store'

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }): JSX.Element {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-my-line pb-3">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold text-my-primary">{title}</h1>
        {description && <p className="mt-0.5 text-my-xs leading-relaxed text-my-tertiary">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}

export function MemberChip({ member, size = 'md' }: { member?: HifoxMember; size?: 'sm' | 'md' }): JSX.Element | null {
  if (!member) return null
  const dim = size === 'sm' ? 'h-5 w-5 text-[10px]' : 'h-6 w-6 text-my-xs'
  return (
    <span className="inline-flex items-center gap-1.5" title={member.title ? `${member.name} · ${member.title}` : member.name}>
      <span
        className={`grid ${dim} shrink-0 place-items-center rounded-full font-medium text-white`}
        style={{ backgroundColor: `hsl(${member.avatarHue} 55% 45%)` }}
      >
        {member.name.slice(0, 1)}
      </span>
      {size === 'md' && <span className="truncate text-my-sm text-my-secondary">{member.name}</span>}
    </span>
  )
}

export function StatusBadge({ status }: { status?: HifoxTaskStatus }): JSX.Element {
  if (!status) return <span className="rounded-my-sm bg-my-layer px-1.5 py-0.5 text-my-xs text-my-tertiary">—</span>
  return (
    <span className={`inline-flex items-center rounded-my-sm px-1.5 py-0.5 text-my-xs font-medium ${STATUS_CATEGORY_CLASS[status.category] ?? 'bg-my-layer text-my-tertiary'}`}>
      {status.name}
    </span>
  )
}

export function PriorityBadge({ priority }: { priority: HifoxPriority }): JSX.Element {
  return (
    <span className={`inline-flex items-center rounded-my-sm px-1.5 py-0.5 text-my-xs font-medium ${PRIORITY_CLASS[priority]}`}>
      {PRIORITY_LABEL[priority]}
    </span>
  )
}

export function LabelChip({ label }: { label: HifoxTaskLabel }): JSX.Element {
  return (
    <span className="inline-flex items-center rounded-my-sm px-1.5 py-0.5 text-my-xs" style={{ backgroundColor: `${label.color}22`, color: label.color }}>
      {label.name}
    </span>
  )
}

export function ExecutorBadge({ executor, dispatchNote }: { executor: { kind: 'agent' | 'crew'; id: string; name: string } | undefined; dispatchNote?: string }): JSX.Element | null {
  if (!executor) return null
  return (
    <span
      className="inline-flex items-center gap-1 rounded-my-sm bg-indigo-500/15 px-1.5 py-0.5 text-my-xs font-medium text-indigo-400"
      title={dispatchNote ?? `执行槽：${executor.name}（${executor.kind === 'agent' ? 'Agent' : '小队'}）`}
    >
      {(executor.kind === 'agent' ? 'Ⓐ ' : 'Ⓒ ') + executor.name}
    </span>
  )
}

export function DispatchNote({ dispatch }: { dispatch?: { status: string; since: string; note?: string } }): JSX.Element | null {
  if (!dispatch) return null
  const waiting = dispatch.status === 'waiting_runtime'
  return (
    <p className={`flex items-start gap-1.5 rounded-my-md border px-2.5 py-2 text-my-xs leading-relaxed ${waiting ? 'border-amber-500/30 bg-amber-500/10 text-amber-500' : 'border-my-line bg-my-layer text-my-tertiary'}`}>
      <span>{waiting ? '⏳' : '🅿'}</span>
      <span>
        {dispatch.note}
        {waiting && <span className="ml-1 text-my-tertiary">（Runtime 未接入：执行链路在 Runtime 模块接入后打通）</span>}
      </span>
    </p>
  )
}

/** 右侧抽屉：任务详情等大面板 */
export function Drawer({ open, title, onClose, children, width = 520 }: { open: boolean; title: string; onClose: () => void; children: ReactNode; width?: number }): JSX.Element | null {
  if (!open) return null
  return (
    <div className="absolute inset-0 z-20 flex justify-end" role="dialog" aria-label={title}>
      <button type="button" aria-label="关闭" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative flex h-full flex-col border-l border-my-line bg-my-canvas shadow-2xl" style={{ width }}>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-my-line px-4">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-my-primary">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭详情">
            <X size={16} />
          </Button>
        </header>
        <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-my-xs text-my-tertiary">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-my-tertiary/80">{hint}</span>}
    </label>
  )
}

export const inputClass = 'my-control w-full rounded-my-md border border-my-line bg-my-layer px-2.5 py-1.5 text-my-sm text-my-primary placeholder:text-my-tertiary focus:border-my-brand focus:outline-none'

export function selectSnapshotCount(snapshot: HifoxSnapshot, spaceId: string | null): { tasks: number; done: number; blocked: number; agents: number; members: number } {
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
