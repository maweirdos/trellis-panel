import { z } from 'zod'
import { cruxRemoteSnapshotSchema } from './crux-remote'
import { taskInputReadSchema } from './team-task-inputs'
import { teamTaskCodeResourceDtoSchema } from './team-code-resources'
import { creationListSchema } from './creations'

/** One fresh, main-consumable read; it grants no execution or input adoption. */
export const teamTaskDevelopmentContextSchema = z.object({
  version: z.literal(1),
  snapshot: cruxRemoteSnapshotSchema,
  inputs: taskInputReadSchema,
  codeResource: teamTaskCodeResourceDtoSchema,
  creations: creationListSchema
}).strict().superRefine((value, ctx) => {
  const { snapshot, inputs, codeResource, creations } = value
  const issue = (path: (string | number)[], message: string): void => { ctx.addIssue({ code: 'custom', path, message }) }
  for (const [key, part] of [['inputs', inputs], ['codeResource', codeResource]] as const) {
    if (part.projectId !== snapshot.projectId || part.instanceId !== snapshot.instanceId || part.epoch !== snapshot.epoch
      || part.authorizationRevision !== snapshot.authorizationRevision) issue([key], 'Development context service or project identity differs')
  }
  const task = snapshot.snapshot.tasks.find(item => item.id === inputs.taskId)
  if (!task || task.spaceId !== inputs.spaceId || task.createdAt !== inputs.taskCreatedAt
    || snapshot.taskId !== undefined && snapshot.taskId !== inputs.taskId) issue(['inputs'], 'Development context task identity differs')
  if (codeResource.taskId !== inputs.taskId || codeResource.spaceId !== inputs.spaceId || codeResource.taskCreatedAt !== inputs.taskCreatedAt
    || task && codeResource.taskUpdatedAt !== task.updatedAt) issue(['codeResource'], 'Development context resource task identity differs')
  const space = snapshot.snapshot.spaces.find(item => item.id === inputs.spaceId)
  const member = snapshot.snapshot.members.find(item => item.id === snapshot.actor.id)
  if (!member || member.role !== snapshot.actor.role || !space?.memberIds.includes(snapshot.actor.id)
    || !task || (task.workflow?.handlerId ?? task.assigneeIds[0]) !== snapshot.actor.id) issue(['snapshot', 'actor'], 'Development context requires the current task handler and space member')
  const bundle = inputs.current
  if (bundle && (bundle.projectId !== inputs.projectId || bundle.taskId !== inputs.taskId || bundle.spaceId !== inputs.spaceId
    || bundle.taskCreatedAt !== inputs.taskCreatedAt)) issue(['inputs', 'current'], 'Development context input bundle task identity differs')
  const selection = codeResource.selection
  if (selection && (selection.taskId !== inputs.taskId || selection.spaceId !== inputs.spaceId || selection.taskCreatedAt !== inputs.taskCreatedAt)) issue(['codeResource', 'selection'], 'Development context resource selection identity differs')
  for (const key of ['resource', 'defaultResource'] as const) {
    if (codeResource[key] && codeResource[key].projectId !== snapshot.projectId) issue(['codeResource', key], 'Development context code resource project differs')
  }
  creations.items.forEach((item, index) => {
    if (item.projectId !== snapshot.projectId || item.spaceId !== inputs.spaceId || item.home !== 'team') issue(['creations', 'items', index], 'Development context creation scope differs')
  })
})

export type TeamTaskDevelopmentContext = z.infer<typeof teamTaskDevelopmentContextSchema>
