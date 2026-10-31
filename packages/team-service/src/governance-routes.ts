import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { teamCommandIdSchema, teamIdSchema } from '../../../src/shared/team-platform'
import { teamTaskProgressResourceIdSchema } from '../../../src/shared/team-task-progress'
import type { TeamAuthentication } from './auth'
import type { TeamStore } from './store-client'
import type { StoreOperation } from './store-types'

export async function registerGovernanceRoutes(api: FastifyInstance, store: TeamStore, auth: TeamAuthentication): Promise<void> {
  const space = '/api/projects/:projectId/hifox/spaces/:spaceId/governance'
  const task = '/api/projects/:projectId/hifox/tasks/:taskId/inputs'
  const spaceParams = z.object({ projectId: teamIdSchema, spaceId: teamTaskProgressResourceIdSchema }).strict()
  const taskParams = z.object({ projectId: teamIdSchema, taskId: teamTaskProgressResourceIdSchema }).strict()
  const get = (path: string, operation: StoreOperation, schema: z.ZodType): void => {
    api.get(path, async request => ({ ok: true, value: await store.call(operation, { actor: auth.principal(request).actor, ...z.record(z.string(), z.unknown()).parse(schema.parse(request.params)), query: request.query }) }))
  }
  get(space, 'governanceList', spaceParams)
  get(space + '/commands/:commandId', 'governanceReceipt', spaceParams.extend({ commandId: teamCommandIdSchema }).strict())
  get(space + '/:packageId', 'governanceRead', spaceParams.extend({ packageId: teamIdSchema }).strict())
  api.post(space + '/commands', async request => ({ ok: true, value: await store.call('governanceCommand', { actor: auth.principal(request).actor, ...spaceParams.parse(request.params), body: request.body }) }))
  get(task, 'taskInputRead', taskParams)
  get(task + '/candidates', 'taskInputCandidates', taskParams)
  get(task + '/revisions/:revision', 'taskInputRevision', taskParams.extend({ revision: z.coerce.number().int().positive().safe() }).strict())
  get(task + '/documents/:documentId/versions/:versionId', 'taskInputReadDocument', taskParams.extend({ documentId: teamIdSchema, versionId: teamIdSchema }).strict())
  get(task + '/commands/:commandId', 'taskInputReceipt', taskParams.extend({ commandId: teamCommandIdSchema }).strict())
  api.post(task + '/commands', async request => ({ ok: true, value: await store.call('taskInputCommand', { actor: auth.principal(request).actor, ...taskParams.parse(request.params), body: request.body }) }))
}
