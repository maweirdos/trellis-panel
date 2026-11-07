import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { teamIdSchema } from '../../../src/shared/team-platform'
import { cruxRemoteSnapshotSchema } from '../../../src/shared/crux-remote'
import { teamTaskDevelopmentContextSchema } from '../../../src/shared/team-task-development'
import { teamTaskProgressResourceIdSchema } from '../../../src/shared/team-task-progress'
import type { TeamAuthentication } from './auth'
import type { TeamStore } from './store-client'
import { TeamServiceError } from './errors'

const MAX_WAIT_MS = 10_000
const RECHECK_INTERVAL_MS = 150
const querySchema = z.object({ afterRevision: z.coerce.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).optional(), waitMs: z.coerce.number().int().min(0).max(MAX_WAIT_MS).default(0) }).strict()

/** Register inside registerTeamRoutes' existing authenticated/CSRF-protected scope. */
export async function registerCruxWorkspaceRoutes(api: FastifyInstance, store: TeamStore, auth: TeamAuthentication): Promise<void> {
  const stopping = new AbortController()
  api.addHook('preClose', async () => { stopping.abort() })
  api.get('/api/projects/:projectId/crux/tasks/:taskId/development-context', async (request, reply) => {
    const params = z.object({ projectId: teamIdSchema, taskId: teamTaskProgressResourceIdSchema }).strict().parse(request.params)
    z.object({}).strict().parse(request.query ?? {})
    reply.header('Cache-Control', 'no-store')
    return { ok: true, value: teamTaskDevelopmentContextSchema.parse(await store.call('taskDevelopmentContext', { actor: auth.principal(request).actor, ...params })) }
  })
  api.get('/api/projects/:projectId/crux/snapshot', async (request, reply) => {
    const { projectId } = z.object({ projectId: teamIdSchema }).strict().parse(request.params)
    const query = querySchema.parse(request.query)
    const actor = auth.principal(request).actor
    const deadline = performance.now() + query.waitMs
    const disconnected = new AbortController()
    const closed = (): void => { disconnected.abort() }
    request.raw.once('aborted', closed)
    reply.raw.once('close', closed)
    const signal = AbortSignal.any([stopping.signal, disconnected.signal])
    reply.header('Cache-Control', 'no-store')
    try {
      let authorizationRevision: number | undefined
      while (true) {
        if (signal.aborted) throw new TeamServiceError('REQUEST_CANCELLED', 'Workspace subscription closed', 503)
        // Every lightweight writer read rechecks account, team/project and device authority.
        // Build the authorized projection only when the wait completes or its authority changes.
        const head = await store.call<{ revision: number; authorizationRevision: number }>('cruxHead', { actor, projectId })
        if (query.afterRevision === undefined || head.revision !== query.afterRevision || (authorizationRevision !== undefined && head.authorizationRevision !== authorizationRevision) || performance.now() >= deadline) {
          return { ok: true, value: cruxRemoteSnapshotSchema.parse(await store.call('cruxSnapshot', { actor, projectId })) }
        }
        authorizationRevision = head.authorizationRevision
        try { await delay(Math.min(RECHECK_INTERVAL_MS, Math.max(1, deadline - performance.now())), undefined, { signal }) }
        catch (error) { if (!signal.aborted) throw error }
      }
    } finally {
      request.raw.off('aborted', closed)
      reply.raw.off('close', closed)
    }
  })
  api.post('/api/projects/:projectId/crux/commands', async (request) => {
    const { projectId } = z.object({ projectId: teamIdSchema }).strict().parse(request.params)
    return { ok: true, value: await store.call('cruxCommand', { actor: auth.principal(request).actor, projectId, body: request.body }) }
  })
}
