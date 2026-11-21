import type { JSX } from 'react'
import { Code2, Palette, Pencil } from 'lucide-react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import { api } from '../../api'
import { Button } from '../../my/ui'
import { useTaskMutation, type TaskSourceOwner } from '../pages/task-detail/use-task-source'

export function hasAssignedNextStep(task: CruxTask): boolean {
  return !task.triagePending && (!task.workflow || task.workflow.stage === 'accepted') &&
    Boolean(task.workflow?.handlerId ?? task.assigneeIds[0])
}

export function AssignedTaskNextStep({ task, source, disabled, onCompleted, designFirst }: {
  task: CruxTask; source: TaskSourceOwner; disabled: boolean; onCompleted(snapshot: CruxSnapshot): void; designFirst: boolean
}): JSX.Element {
  const handler = task.workflow?.handlerId ?? task.assigneeIds[0]
  const { mutate, pending, error } = useTaskMutation(source)
  const general = task.workKind === 'general'
  const label = general ? '处理任务' : designFirst ? '准备设计' : '准备开发'
  const Icon = general ? Pencil : designFirst ? Palette : Code2
  async function advance() {
    if (!handler || !source.canWrite() || pending || disabled) return
    const result = await mutate(label, () => api.crux.transitionTask({
      taskId: task.id, action: 'arrange', assigneeId: handler, expectedStage: task.workflow?.stage, expectedUpdatedAt: task.updatedAt,
      ...(task.workflow?.deliveryState && { expectedDeliveryRevision: task.workflow.deliveryState.revision }),
      ...(general ? {} : { nextStage: designFirst ? 'design_ready' : 'dev_ready' })
    }))
    if (result) onCompleted(result.data)
  }
  return <>
    <Button size="sm" variant="primary" disabled={disabled || pending} onClick={() => void advance()}><Icon size={14} />{label}</Button>
    {error && <p role="alert" className="collab-inline-error">{error}</p>}
  </>
}
