import type { JSX } from 'react'
import { CircleDot, Ellipsis, ListFilter, UserRound } from 'lucide-react'
import type { CruxPriority, CruxSnapshot, CruxTask } from '@shared/crux'
import { getCruxTaskActions, getCruxTaskStageMetadata, isCruxTriageManager } from '@shared/crux-domain/workflow'
import { getCruxLightweightTaskCapabilities } from '@shared/crux-domain/lightweight'
import { api } from '../../../api'
import { Button, Dropdown, DropdownItem } from '../../../my/ui'
import { memberOf, PRIORITY_LABEL, statusOf } from '../../store'
import type { TaskMutation } from './use-task-source'

export function updatePostAssignmentOrStatus(task: CruxTask, patch: { statusId: string } | { assigneeIds: string[] }) {
  return task.workflow
    ? api.crux.restoreLightweightTask({ taskId: task.id, expectedUpdatedAt: task.updatedAt, ...patch })
    : api.crux.updateTask({ id: task.id, patch })
}

export function TaskPostControls({ snapshot, task, actor, disabled, mutate, onProperties, onWorkflow }: {
  snapshot: CruxSnapshot; task: CruxTask; actor?: string; disabled: boolean; mutate: TaskMutation; onProperties(): void; onWorkflow(): void
}): JSX.Element {
  const space = snapshot.spaces.find(item => item.id === task.spaceId)
  const flow = getCruxLightweightTaskCapabilities(snapshot, task, actor)
  const simple = flow.lightweight || flow.canRestore
  const handler = task.workflow?.handlerId ?? task.assigneeIds[0]
  const state = statusOf(snapshot, task.statusId)
  const closed = state?.category === 'done' || state?.category === 'cancelled'
  const triage = task.triagePending && getCruxTaskActions(task).includes('accept')
  const canAssign = Boolean(actor && space?.memberIds.includes(actor) && !disabled && !closed &&
    (flow.canRestore || actor === task.creatorId || handler === actor ||
      (getCruxTaskActions(task).includes('reassign') || triage) && isCruxTriageManager(snapshot, task.spaceId, actor)))
  const canChooseStatus = !disabled && (flow.canEditStatus || flow.canRestore)
  const stage = task.triagePending ? '待分拣' : !simple && task.workflow && !closed ? getCruxTaskStageMetadata(task.workflow.stage).label : state?.name ?? '状态'
  return <>
    <Dropdown disabled={!canAssign} trigger={({ toggle, open }) => <Button size="sm" variant="ghost" disabled={!canAssign}
      aria-label="分配负责人" aria-expanded={open} onClick={toggle}><UserRound size={14} />{memberOf(snapshot, handler)?.name ?? '待分配'}</Button>}>
      {close => snapshot.members.filter(member => space?.memberIds.includes(member.id)).map(member =>
        <DropdownItem key={member.id} selected={member.id === handler} onClick={() => {
          close()
          if (member.id === handler && !triage) return
          void mutate('分配负责人', () => triage
            ? api.crux.triage({ taskId: task.id, actorId: actor, disposition: 'assign', assigneeIds: [member.id], expectedUpdatedAt: task.updatedAt })
            : task.workflow
              ? api.crux.transitionTask({ taskId: task.id, action: 'reassign', assigneeId: member.id, expectedStage: task.workflow?.stage,
                expectedUpdatedAt: task.updatedAt, ...(task.workflow?.deliveryState ? { expectedDeliveryRevision: task.workflow.deliveryState.revision } : {}) })
              : updatePostAssignmentOrStatus(task, { assigneeIds: [member.id, ...task.assigneeIds.filter(id => id !== handler && id !== member.id)] }))
        }}>{member.name}</DropdownItem>)}
    </Dropdown>
    {simple ? <Dropdown disabled={!canChooseStatus} trigger={({ toggle, open }) => <Button size="sm" variant="ghost" disabled={!canChooseStatus} aria-label={`更改状态，当前${stage}`} aria-expanded={open} onClick={toggle}><CircleDot size={14} />{stage}</Button>}>
      {close => flow.statusOptions.map(status => <DropdownItem key={status.id} selected={status.id === task.statusId} onClick={() => {
        close()
        if (status.id !== task.statusId) void mutate('更新任务状态', () => updatePostAssignmentOrStatus(task, { statusId: status.id }))
      }}>{status.name}</DropdownItem>)}
    </Dropdown> : <Button size="sm" variant="ghost" onClick={onWorkflow}><CircleDot size={14} />{stage}</Button>}
    <Dropdown disabled={disabled} trigger={({ toggle, open }) => <Button size="sm" variant="ghost" disabled={disabled}
      aria-label="更改优先级" aria-expanded={open} onClick={toggle}><ListFilter size={14} />{task.priority === 'none' ? '优先级' : PRIORITY_LABEL[task.priority]}</Button>}>
      {close => (Object.keys(PRIORITY_LABEL) as CruxPriority[]).map(priority => <DropdownItem key={priority} selected={priority === task.priority} onClick={() => {
        close(); if (priority !== task.priority) void mutate('更新优先级', () => api.crux.updateTask({ id: task.id, patch: { priority } }))
      }}>{PRIORITY_LABEL[priority]}</DropdownItem>)}
    </Dropdown>
    <Button size="sm" variant="ghost" aria-label="更多属性" onClick={onProperties}><Ellipsis size={15} /></Button>
  </>
}
