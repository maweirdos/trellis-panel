import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { teamIdSchema } from '../../../src/shared/team-platform'
import { teamCodeResourceScopeIdSchema } from '../../../src/shared/team-code-resources'
import type { TeamAuthentication } from './auth'
import type { TeamStore } from './store-client'

export async function registerCodeResourceRoutes(api: FastifyInstance, store: TeamStore, auth: TeamAuthentication): Promise<void> {
  const project = z.object({ projectId: teamIdSchema }).strict()
  const path = '/api/projects/:projectId/code-resources'
  api.get(path, async (request) => ({ ok: true, value: await store.call('codeResourceList', { actor: auth.principal(request).actor, ...project.parse(request.params), query: request.query }) }))
  api.post(path + '/commands', async (request) => ({ ok: true, value: await store.call('codeResourceCommand', { actor: auth.principal(request).actor, ...project.parse(request.params), body: request.body }) }))
  api.get('/api/projects/:projectId/crux/tasks/:taskId/code-resource', async (request) => ({ ok: true, value: await store.call('taskCodeResourceRead', { actor: auth.principal(request).actor, ...project.extend({ taskId: teamCodeResourceScopeIdSchema }).strict().parse(request.params) }) }))
}
