import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { teamIdSchema } from '../../../src/shared/team-platform'
import { teamTaskProgressResourceIdSchema } from '../../../src/shared/team-task-progress'
import { teamExecutionCommandSchema, teamExecutionReadQuerySchema } from '../../../src/shared/team-task-execution'
import type { TeamAuthentication } from './auth'
import type { TeamStore } from './store-client'
import { TeamServiceError } from './errors'

const paramsSchema = z.object({ projectId: teamIdSchema, taskId: teamTaskProgressResourceIdSchema }).strict()
const path = '/api/projects/:projectId/hifox/tasks/:taskId/executions'
export async function registerTaskExecutionRoutes(api: FastifyInstance, store: TeamStore, auth: TeamAuthentication): Promise<void> {
  const version = (body: unknown): void => {
    if (body && typeof body === 'object' && 'contractVersion' in body && body.contractVersion !== 2) throw new TeamServiceError('UNSUPPORTED_EXECUTION_VERSION', 'Execution contract version 2 is required', 409)
  }
  api.get(path, async request => {
    if (!request.query || typeof request.query !== 'object' || !('contractVersion' in request.query) || request.query.contractVersion !== '2') throw new TeamServiceError('UNSUPPORTED_EXECUTION_VERSION', 'Execution contract version 2 is required', 409)
    const params = paramsSchema.parse(request.params), query = teamExecutionReadQuerySchema.parse(request.query)
    return { ok: true, value: await store.call('taskExecutionRead', { actor: auth.principal(request).actor, task: { ...params, instanceId: query.instanceId, spaceId: query.spaceId, taskCreatedAt: query.taskCreatedAt } }) }
  })
  for (const [suffix, operation] of [['/commands', 'taskExecutionCommand'], ['/reconcile', 'taskExecutionReconcile']] as const) {
    api.post(path + suffix, async request => {
      const params = paramsSchema.parse(request.params); version(request.body)
      const command = teamExecutionCommandSchema.parse(request.body)
      if (command.task.projectId !== params.projectId || command.task.taskId !== params.taskId) throw new TeamServiceError('EXECUTION_SCOPE_CONFLICT', 'Route and original command target differ', 409)
      return { ok: true, value: await store.call(operation, { actor: auth.principal(request).actor, body: command }) }
    })
  }
  api.get(path + '/:executionId', async request => {
    if (!request.query || typeof request.query !== 'object' || !('contractVersion' in request.query) || request.query.contractVersion !== '2') throw new TeamServiceError('UNSUPPORTED_EXECUTION_VERSION', 'Execution contract version 2 is required', 409)
    const { executionId, ...params } = paramsSchema.extend({ executionId: teamIdSchema }).strict().parse(request.params), query = teamExecutionReadQuerySchema.parse(request.query)
    return { ok: true, value: await store.call('taskExecutionHistory', { actor: auth.principal(request).actor, executionId, task: { ...params, instanceId: query.instanceId, spaceId: query.spaceId, taskCreatedAt: query.taskCreatedAt } }) }
  })
}
