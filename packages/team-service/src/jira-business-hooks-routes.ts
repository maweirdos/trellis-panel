import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  jiraBusinessEffectQuerySchema,
  jiraBusinessRouteCommandSchema,
  jiraBusinessDispatchReceiptSchema,
  jiraBusinessEventCommandSchema,
  jiraBusinessIntakeCommandSchema,
  jiraBusinessMappingCommandSchema,
  jiraBusinessMappingQuerySchema
} from '../../../src/shared/jira-business-hooks'
import { teamIdSchema } from '../../../src/shared/team-platform'
import type { TeamAuthentication } from './auth'
import { TeamServiceError } from './errors'
import type { TeamStore } from './store-client'

const projectParamsSchema = z.object({ projectId: teamIdSchema }).strict()
const project = (request: { params: unknown }): string => projectParamsSchema.parse(request.params).projectId

function assertProject(routeProjectId: string, bodyProjectId: string): void {
  if (routeProjectId !== bodyProjectId) throw new TeamServiceError('JIRA_TASK_SCOPE_CONFLICT', 'Route and original Jira business command project differ', 409)
}

export async function registerJiraBusinessHookRoutes(api: FastifyInstance, store: TeamStore, auth: TeamAuthentication): Promise<void> {
  const mappingPath = '/api/projects/:projectId/crux/jira/mappings'
  api.get(mappingPath, async request => {
    const projectId = project(request)
    const query = jiraBusinessMappingQuerySchema.omit({ projectId: true }).parse(request.query)
    return { ok: true, value: await store.call('jiraBusinessMappingRead', { actor: auth.principal(request).actor, projectId, ...query }) }
  })
  api.post(mappingPath + '/commands', async request => {
    const projectId = project(request)
    const body = jiraBusinessMappingCommandSchema.parse(request.body)
    assertProject(projectId, body.projectId)
    return { ok: true, value: await store.call('jiraBusinessMappingCommand', { actor: auth.principal(request).actor, body }) }
  })
  api.post('/api/projects/:projectId/crux/jira/intake/commands', async request => {
    const projectId = project(request)
    const body = jiraBusinessIntakeCommandSchema.parse(request.body)
    assertProject(projectId, body.projectId)
    return { ok: true, value: await store.call('jiraBusinessIntakeCommand', { actor: auth.principal(request).actor, body }) }
  })

  const dispatchPath = '/api/projects/:projectId/crux/jira/business-dispatches'
  api.post('/api/projects/:projectId/crux/jira/business-routes/commands', async request => {
    const body = jiraBusinessRouteCommandSchema.parse(request.body)
    assertProject(project(request), body.route.projectId)
    return { ok: true, value: await store.call('jiraBusinessRouteCommand', { actor: auth.principal(request).actor, body }) }
  })
  api.get(dispatchPath, async request => {
    const routeId = z.object({ routeId: teamIdSchema }).strict().parse(request.query).routeId
    return { ok: true, value: await store.call('jiraBusinessDispatchPending', { actor: auth.principal(request).actor, projectId: project(request), routeId }) }
  })
  api.get(dispatchPath + '/:effectId', async request => {
    const query = jiraBusinessEffectQuerySchema.parse(request.params)
    return { ok: true, value: await store.call('jiraBusinessDispatchRead', { actor: auth.principal(request).actor, ...query }) }
  })
  api.post(dispatchPath + '/receipts', async request => {
    const body = jiraBusinessDispatchReceiptSchema.parse(request.body)
    assertProject(project(request), body.projectId)
    return { ok: true, value: await store.call('jiraBusinessDispatchReceipt', { actor: auth.principal(request).actor, body }) }
  })
  const effectPath = '/api/projects/:projectId/crux/jira/business-effects'
  api.get(effectPath + '/:effectId', async request => {
    const query = jiraBusinessEffectQuerySchema.parse(request.params)
    return { ok: true, value: await store.call('jiraBusinessEffectRead', { actor: auth.principal(request).actor, ...query }) }
  })
  api.post(effectPath + '/commands', async request => {
    const projectId = project(request)
    const body = jiraBusinessEventCommandSchema.parse(request.body)
    assertProject(projectId, body.projectId)
    return { ok: true, value: await store.call('jiraBusinessEventCommand', { actor: auth.principal(request).actor, body }) }
  })
}

