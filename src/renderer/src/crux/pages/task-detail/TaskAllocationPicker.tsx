import { clsx } from 'clsx'
import { ChevronDown } from 'lucide-react'
import type { JSX } from 'react'
import type { CruxExecutorRef, CruxSnapshot } from '@shared/crux'
import { Dropdown, DropdownHeader, DropdownItem, Tooltip } from '../../../my/ui'
import { AgentAvatar } from '../../AgentAvatar'
import { availableExecutionTargets } from '../../store'

export interface TaskAllocation {
  assigneeIds: string[]
  executor: CruxExecutorRef | null
}

interface TaskAllocationPickerProps {
  snapshot: CruxSnapshot
  spaceId: string
  value: TaskAllocation
  onChange: (value: TaskAllocation) => void
  fallbackActorId?: string
  disabled?: boolean
  managed?: boolean
}

export function TaskAllocationPicker({ snapshot, spaceId, value, onChange, fallbackActorId, disabled, managed }: TaskAllocationPickerProps): JSX.Element {
  const space = snapshot.spaces.find((candidate) => candidate.id === spaceId)
  const members = snapshot.members.filter((member) => space?.memberIds.includes(member.id) || value.assigneeIds.includes(member.id))
  const { agents, crews } = availableExecutionTargets(snapshot, spaceId)
  const names = value.assigneeIds.map((id) => snapshot.members.find((member) => member.id === id)?.name ?? '成员不可用')
  const label = [...names, value.executor ? `${value.executor.kind === 'agent' ? 'Agent' : '小队'} · ${value.executor.name}` : ''].filter(Boolean).join('、') || '未分配'
  const chooseExecutor = (executor: CruxExecutorRef | null): void => {
    if (disabled || managed) return
    const assigneeIds = executor && !value.assigneeIds.length && fallbackActorId && space?.memberIds.includes(fallbackActorId)
      ? [fallbackActorId] : value.assigneeIds
    onChange({ assigneeIds, executor })
  }
  const empty = names.length === 0 && !value.executor
  const triggerButton = (open?: boolean, onClick?: () => void): JSX.Element => (
    <button
      type="button"
      disabled={disabled || managed}
      aria-label={`分工：${label}`}
      aria-expanded={open}
      aria-haspopup={managed ? undefined : 'true'}
      onClick={onClick}
      className="my-select-trigger w-full"
    >
      <span className={clsx('my-select-value truncate', empty && 'text-my-placeholder')}>{label}</span>
      <ChevronDown size={14} className={clsx('my-select-chevron shrink-0 transition-transform', open && 'rotate-180')} aria-hidden="true" />
    </button>
  )
  if (managed) return <div className="grid min-w-0 grid-cols-1"><Tooltip label="通过详情中的阶段操作交接处理人和执行者" wrap>{triggerButton()}</Tooltip></div>
  return <Dropdown width={260} className="w-full" trigger={({ toggle, open }) => triggerButton(open, toggle)}>
    {(close) => <div className="my-scrollbar max-h-80 overflow-y-auto">
      <DropdownHeader>{value.executor ? '兜底处理人' : '处理人'}</DropdownHeader>
      {members.map((member) => <DropdownItem key={member.id} selected={value.assigneeIds.includes(member.id)} disabled={disabled || !space?.memberIds.includes(member.id) && !value.assigneeIds.includes(member.id)} onClick={() => {
        if (disabled) return
        const selected = value.assigneeIds.includes(member.id)
        const multi = space?.multiAssignee || value.assigneeIds.length > 1
        onChange({ ...value, assigneeIds: selected ? value.assigneeIds.filter((id) => id !== member.id) : multi ? [...value.assigneeIds, member.id] : [member.id] })
        close()
      }}>{member.name}{!space?.memberIds.includes(member.id) ? '（已离开空间）' : ''}</DropdownItem>)}
      <DropdownItem disabled={disabled || !value.assigneeIds.length} onClick={() => { if (!disabled) onChange({ ...value, assigneeIds: [] }); close() }}>取消人员分工</DropdownItem>
      <DropdownHeader>执行者</DropdownHeader>
      <DropdownItem selected={!value.executor} disabled={disabled} onClick={() => { chooseExecutor(null); close() }}>人工执行</DropdownItem>
      {value.executor && !(value.executor.kind === 'agent' ? agents : crews).some((target) => target.id === value.executor?.id) && <DropdownItem disabled selected>{value.executor.name}（当前不可用）</DropdownItem>}
      {agents.map((agent) => <DropdownItem key={agent.id} icon={<AgentAvatar avatarId={agent.avatarId} size={16} />} disabled={disabled} selected={value.executor?.kind === 'agent' && value.executor.id === agent.id} onClick={() => { chooseExecutor({ kind: 'agent', id: agent.id, name: agent.name }); close() }}>Agent · {agent.name}</DropdownItem>)}
      {crews.map((crew) => <DropdownItem key={crew.id} disabled={disabled} selected={value.executor?.kind === 'crew' && value.executor.id === crew.id} onClick={() => { chooseExecutor({ kind: 'crew', id: crew.id, name: crew.name }); close() }}>小队 · {crew.name}</DropdownItem>)}
    </div>}
  </Dropdown>
}
