import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { teamIdSchema } from '../../../src/shared/team-platform'
import { hifoxRemoteSnapshotSchema } from '../../../src/shared/hifox-remote'
import type { TeamAuthentication } from './auth'
import type { TeamStore } from './store-client'
import { TeamServiceError } from './errors'

const MAX_WAIT_MS = 10_000
const RECHECK_INTERVAL_MS = 150
const querySchema = z.object({ afterRevision: z.coerce.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).optional(), waitMs: z.coerce.number().int().min(0).max(MAX_WAIT_MS).default(0) }).strict()

/** Register inside registerTeamRoutes' existing authenticated/CSRF-protected scope. */
export async function registerHifoxWorkspaceRoutes(api: FastifyInstance, store: TeamStore, auth: TeamAuthentication): Promise<void> {
  const stopping = new AbortController()
  api.addHook('preClose', async () => { stopping.abort() })
  api.get('/api/projects/:projectId/hifox/snapshot', async (request, reply) => {
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
      while (true) {
        if (signal.aborted) throw new TeamServiceError('REQUEST_CANCELLED', 'Workspace subscription closed', 503)
        // Authentication, project membership and device binding are rechecked by every writer read.
        const value = hifoxRemoteSnapshotSchema.parse(await store.call('hifoxSnapshot', { actor, projectId }))
        if (query.afterRevision === undefined || value.revision !== query.afterRevision || performance.now() >= deadline) return { ok: true, value }
        try { await delay(Math.min(RECHECK_INTERVAL_MS, Math.max(1, deadline - performance.now())), undefined, { signal }) }
        catch (error) { if (!signal.aborted) throw error }
      }
    } finally {
      request.raw.off('aborted', closed)
      reply.raw.off('close', closed)
    }
  })
  api.post('/api/projects/:projectId/hifox/commands', async (request) => {
    const { projectId } = z.object({ projectId: teamIdSchema }).strict().parse(request.params)
    return { ok: true, value: await store.call('hifoxCommand', { actor: auth.principal(request).actor, projectId, body: request.body }) }
  })
}
