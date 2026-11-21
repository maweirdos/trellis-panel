import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sourcePartQuery } from '../../../src/shared/task-source-files'
import { teamCommandIdSchema, teamIdSchema } from '../../../src/shared/team-platform'
import { teamTaskProgressResourceIdSchema } from '../../../src/shared/team-task-progress'
import type { TeamAuthentication } from './auth'
import type { TeamStore } from './store-client'
import type { StoreOperation } from './store-types'

const params = z.object({ projectId: teamIdSchema, taskId: teamTaskProgressResourceIdSchema }).strict()
const path = '/api/projects/:projectId/crux/tasks/:taskId/materials'

/** Shares the existing browser CSRF/device authentication scope. */
export async function registerTaskMaterialRoutes(api: FastifyInstance, store: TeamStore, auth: TeamAuthentication): Promise<void> {
  const get = (suffix: string, operation: StoreOperation, schema: z.ZodType): void => {
    api.get(path + suffix, async (request) => ({ ok: true, value: await store.call(operation, {
      actor: auth.principal(request).actor, ...z.record(z.string(), z.unknown()).parse(schema.parse(request.params)), query: request.query
    }) }))
  }
  get('', 'taskMaterialList', params)
  const partPath = '/source/:sourceId/:revision/:part'
  const sourceParams = params.extend(sourcePartQuery.shape).strict()
  get(partPath, 'taskSourcePartRead', sourceParams)
  api.post(path + partPath, async request => ({ ok: true, value: await store.call('taskSourcePartPut', {
    actor: auth.principal(request).actor, ...sourceParams.parse(request.params), query: request.query, body: request.body
  }) }))
  get('/commands/:commandId', 'taskMaterialReceipt', params.extend({ commandId: teamCommandIdSchema }).strict())
  get('/:documentId', 'taskMaterialRead', params.extend({ documentId: teamIdSchema }).strict())
  get('/:documentId/versions', 'taskMaterialVersions', params.extend({ documentId: teamIdSchema }).strict())
  get('/:documentId/submissions', 'taskMaterialSubmissions', params.extend({ documentId: teamIdSchema }).strict())
  api.post(path + '/commands', async (request) => ({ ok: true, value: await store.call('taskMaterialCommand', {
    actor: auth.principal(request).actor, ...params.parse(request.params), body: request.body
  }) }))
}
