import type { CruxID, CruxSnapshot, CruxTask } from '../crux'
import { isCruxTriageManager } from './workflow'

const intakeActions = new Set(['accept', 'arrange', 'reassign', 'begin_development'])

export function hasOnlyIntakeHistory(task: CruxTask): boolean {
  const flow = task.workflow
  return Boolean(flow && ['accepted', 'dev_ready', 'planning'].includes(flow.stage) && !flow.deliveryState && !flow.resumeStage && !flow.resumeAssigneeId &&
    flow.history.every(event => intakeActions.has(event.action) && !event.deliveryLinks) && flow.artifacts.every(item => (item.kind === 'requirements' || item.kind === 'plan') && !item.deliveryLinks))
}

export function canRestoreLightweightTask(task: CruxTask): boolean {
  return !task.executor && task.lightweightSource === 'conversation' && hasOnlyIntakeHistory(task)
}

export function getCruxLightweightTaskCapabilities(snapshot: CruxSnapshot, task: CruxTask, actorId?: CruxID) {
  const space = snapshot.spaces.find(entry => entry.id === task.spaceId)
  const writable = Boolean(actorId && space && !space.archived && space.memberIds.includes(actorId))
  const lightweight = !task.workflow
  const canRestore = Boolean(writable && actorId && canRestoreLightweightTask(task) &&
    (actorId === task.creatorId || actorId === task.workflow?.handlerId || isCruxTriageManager(snapshot, task.spaceId, actorId)))
  const canEdit = writable && !task.triagePending && (lightweight || canRestore)
  const allowed = snapshot.taskTypes.find(type => type.id === task.typeId && type.spaceId === task.spaceId)?.statusIds
  const statusOptions = snapshot.taskStatuses.filter(status => status.spaceId === task.spaceId && (!allowed?.length || allowed.includes(status.id))).sort((a, b) => a.order - b.order)
  return { lightweight, canEditStatus: canEdit, canAssign: canEdit, statusOptions, canRestore }
}
