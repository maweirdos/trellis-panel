import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { teamDigestSchema, teamIdSchema } from '../../../src/shared/team-platform'
import { teamTaskProgressResourceIdSchema } from '../../../src/shared/team-task-progress'
import { cutoverCommandSchema, cutoverReadQuerySchema, cutoverTaskQuerySchema } from '../../../src/shared/team-cutover'
import type { TeamAuthentication } from './auth'
import type { TeamStore } from './store-client'
import { TeamServiceError } from './errors'

const params = z.object({ projectId: teamIdSchema }).strict()
const base = '/api/projects/:projectId/cutovers'
export async function registerCutoverRoutes(api: FastifyInstance, store: TeamStore, auth: TeamAuthentication): Promise<void> {
  for (const [suffix, operation] of [['/commands', 'cutoverCommand'], ['/reconcile', 'cutoverReconcile']] as const) api.post(base + suffix, async request => {
    const route = params.parse(request.params), body = cutoverCommandSchema.parse(request.body)
    if (route.projectId !== body.projectId) throw new TeamServiceError('CUTOVER_SCOPE_CONFLICT', 'Original cutover project differs from its route', 409)
    return { ok: true, value: await store.call(operation, { actor: auth.principal(request).actor, body }) }
  })
  api.get(base + '/workcopies/:workcopyDigest', async request => ({ ok: true, value: await store.call('cutoverRead', { actor: auth.principal(request).actor,
    ...params.extend({ workcopyDigest: teamDigestSchema }).strict().parse(request.params), query: cutoverReadQuerySchema.parse(request.query) }) }))
  api.get(base + '/tasks/:taskId', async request => ({ ok: true, value: await store.call('cutoverTask', { actor: auth.principal(request).actor,
    ...params.extend({ taskId: teamTaskProgressResourceIdSchema }).strict().parse(request.params), query: cutoverTaskQuerySchema.parse(request.query) }) }))
}
