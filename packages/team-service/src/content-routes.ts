import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { teamIdSchema, teamCommandIdSchema } from '../../../src/shared/team-platform'
import { teamContentScopeIdSchema, teamContentJobSchema } from '../../../src/shared/team-content'
import type { TeamAuthentication } from './auth'
import type { TeamStore } from './store-client'
import type { StoreOperation } from './store-types'
import { TeamContentRuntime } from './content-runtime'

export async function registerContentRoutes(api: FastifyInstance, store: TeamStore, auth: TeamAuthentication): Promise<void> {
  const runtime = await TeamContentRuntime.open(store, () => { api.log.warn('Content reconciliation requires inspection; provider diagnostics are withheld') })
  api.addHook('preClose', async () => { await runtime.close() })
  const team = z.object({ teamId: teamIdSchema }).strict()
  const task = z.object({ projectId: teamIdSchema, taskId: teamContentScopeIdSchema }).strict()
  const adminPath = '/api/teams/:teamId/content', taskPath = '/api/projects/:projectId/hifox/tasks/:taskId/content'
  const get = (path: string, operation: StoreOperation, params: z.ZodType): void => {
    api.get(path, async (request) => ({ ok: true, value: await store.call(operation, {
      actor: auth.principal(request).actor, ...z.record(z.string(), z.unknown()).parse(params.parse(request.params)), query: request.query
    }) }))
  }
  get('/api/projects/:projectId/content/capabilities', 'contentCapabilities', z.object({ projectId: teamIdSchema }).strict())
  get(adminPath + '/config', 'contentConfigRead', team)
  api.post(adminPath + '/config', async (request) => ({ ok: true, value: await store.call('contentConfigure', { actor: auth.principal(request).actor, ...team.parse(request.params), body: request.body }) }))
  api.post(adminPath + '/probe', async (request) => ({ ok: true, value: await runtime.submit(auth.principal(request).actor, team.parse(request.params), request.body, true) }))
  get(adminPath + '/budget', 'contentBudget', team)
  const accounting = team.extend({ jobId: teamIdSchema }).strict()
  get(adminPath + '/jobs/:jobId/accounting', 'contentAccounting', accounting)
  api.post(adminPath + '/jobs/:jobId/reconcile', async (request) => ({ ok: true, value: await store.call('contentReconcile', { actor: auth.principal(request).actor, ...accounting.parse(request.params), body: request.body }) }))
  api.post(taskPath + '/jobs', async (request) => ({ ok: true, value: await runtime.submit(auth.principal(request).actor, task.parse(request.params), request.body) }))
  get(taskPath + '/jobs/:jobId', 'contentJob', task.extend({ jobId: teamIdSchema }).strict())
  get(taskPath + '/commands/:commandId', 'contentReceipt', task.extend({ commandId: teamCommandIdSchema }).strict())
  api.post(taskPath + '/jobs/:jobId/cancel', async (request) => {
    const job = teamContentJobSchema.parse(await store.call('contentCancel', {
      actor: auth.principal(request).actor, ...task.extend({ jobId: teamIdSchema }).strict().parse(request.params), body: request.body
    }))
    if (job.cancelRequested) runtime.cancel(job.jobId)
    return { ok: true, value: job }
  })
}
