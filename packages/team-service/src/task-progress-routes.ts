import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { teamCommandIdSchema, teamIdSchema } from '../../../src/shared/team-platform'
import { teamTaskProgressResourceIdSchema } from '../../../src/shared/team-task-progress'
import type { TeamAuthentication } from './auth'
import type { TeamStore } from './store-client'

const paramsSchema = z.object({ projectId: teamIdSchema, taskId: teamTaskProgressResourceIdSchema }).strict()
const path = '/api/projects/:projectId/crux/tasks/:taskId/progress'

/** Register inside the existing session/device authentication and browser CSRF scope. */
export async function registerTaskProgressRoutes(api: FastifyInstance, store: TeamStore, auth: TeamAuthentication): Promise<void> {
  api.get(path, async (request) => ({ ok: true, value: await store.call('taskProgressRead', { actor: auth.principal(request).actor, ...paramsSchema.parse(request.params) }) }))
  api.post(path + '/commands', async (request) => ({ ok: true, value: await store.call('taskProgressCommand', { actor: auth.principal(request).actor, ...paramsSchema.parse(request.params), body: request.body }) }))
  api.get(path + '/commands/:commandId', async (request) => ({ ok: true, value: await store.call('taskProgressReceipt', { actor: auth.principal(request).actor, ...paramsSchema.extend({ commandId: teamCommandIdSchema }).strict().parse(request.params) }) }))
}
