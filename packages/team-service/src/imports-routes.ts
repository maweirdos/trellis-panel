import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { teamIdSchema } from '../../../src/shared/team-platform'
import { importCommandSchema, importListQuerySchema } from '../../../src/shared/team-import'
import type { TeamAuthentication } from './auth'
import type { TeamStore } from './store-client'
import { TeamServiceError } from './errors'

const params = z.object({ projectId: teamIdSchema }).strict()
const base = '/api/projects/:projectId/imports'
export async function registerImportRoutes(api: FastifyInstance, store: TeamStore, auth: TeamAuthentication): Promise<void> {
  for (const [suffix, operation] of [['/commands', 'importCommand'], ['/reconcile', 'importReconcile']] as const) api.post(base + suffix, async request => {
    const route = params.parse(request.params), body = importCommandSchema.parse(request.body)
    if (body.projectId !== route.projectId) throw new TeamServiceError('IMPORT_SCOPE_CONFLICT', 'Original import project differs from its route', 409)
    return { ok: true, value: await store.call(operation, { actor: auth.principal(request).actor, body }) }
  })
  for (const [suffix, operation] of [['/namespaces', 'importNamespaces'], ['/items', 'importItems']] as const) api.get(base + suffix, async request => ({ ok: true, value: await store.call(operation, { actor: auth.principal(request).actor, ...params.parse(request.params), query: importListQuerySchema.parse(request.query) }) }))
  api.get(base + '/items/:candidateId', async request => ({ ok: true, value: await store.call('importRead', { actor: auth.principal(request).actor, ...params.extend({ candidateId: teamIdSchema }).parse(request.params) }) }))
  api.get(base + '/batches/:importId', async request => ({ ok: true, value: await store.call('importBatch', { actor: auth.principal(request).actor, ...params.extend({ importId: teamIdSchema }).parse(request.params), query: importListQuerySchema.parse(request.query) }) }))
}
