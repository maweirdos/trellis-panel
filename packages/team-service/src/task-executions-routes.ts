import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { teamIdSchema } from '../../../src/shared/team-platform'
import { teamTaskProgressResourceIdSchema } from '../../../src/shared/team-task-progress'
import { teamExecutionCommandSchema, teamExecutionReadQuerySchema } from '../../../src/shared/team-task-execution'
import type { TeamAuthentication } from './auth'
import type { TeamStore } from './store-client'
import { TeamServiceError } from './errors'
import { executionInputCommandSchema, executionInputReadQuerySchema, executionInputSelectionIdSchema } from '../../../src/shared/team-execution-input'

const paramsSchema = z.object({ projectId: teamIdSchema, taskId: teamTaskProgressResourceIdSchema }).strict()
const path = '/api/projects/:projectId/crux/tasks/:taskId/executions'
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
  const inputParams = paramsSchema.extend({ executionId: teamIdSchema }).strict()
  api.get(path + '/:executionId/artifacts/:versionId', async request => {
    const { executionId, versionId, ...params } = inputParams.extend({ versionId: teamIdSchema }).strict().parse(request.params)
    const { contractVersion: _version, ...scope } = teamExecutionReadQuerySchema.parse(request.query)
    return { ok: true, value: await store.call('taskExecutionArtifact', { actor: auth.principal(request).actor, executionId, versionId, task: { ...params, ...scope } }) }
  })
  const inputPath = path + '/:executionId/inputs'
  for (const [suffix, operation] of [['/commands', 'executionInputCommand'], ['/reconcile', 'executionInputReconcile']] as const) {
    api.post(inputPath + suffix, async request => {
      const params = inputParams.parse(request.params); version(request.body)
      const command = executionInputCommandSchema.parse(request.body)
      if (command.task.projectId !== params.projectId || command.task.taskId !== params.taskId || command.expectedExecutionId !== params.executionId) throw new TeamServiceError('EXECUTION_SCOPE_CONFLICT', 'Route and original captured input differ', 409)
      return { ok: true, value: await store.call(operation, { actor: auth.principal(request).actor, body: command }) }
    })
  }
  api.get(inputPath, async request => {
    const { executionId, ...params } = inputParams.parse(request.params), { purpose, contractVersion: _version, ...scope } = executionInputReadQuerySchema.parse(request.query)
    return { ok: true, value: await store.call('executionInputRead', { actor: auth.principal(request).actor, executionId, task: { ...params, ...scope }, purpose }) }
  })
  api.get(inputPath + '/resources/:selectionId', async request => {
    const { executionId, selectionId, ...params } = inputParams.extend({ selectionId: executionInputSelectionIdSchema }).strict().parse(request.params)
    const { purpose, contractVersion: _version, ...scope } = executionInputReadQuerySchema.parse(request.query)
    return { ok: true, value: await store.call('executionInputResource', { actor: auth.principal(request).actor, executionId, selectionId, task: { ...params, ...scope }, purpose }) }
  })
}
