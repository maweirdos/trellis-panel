import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { TeamAuthentication, bearerToken, credentialDigest } from './auth'
import type { TeamServiceConfig } from './config'
import { TeamServiceError } from './errors'
import type { TeamStore } from './store-client'
import type { StoreOperation } from './store-types'
import { teamIdSchema } from '../../../src/shared/team-platform'
import { registerHifoxWorkspaceRoutes } from './hifox-workspace-routes'
import { registerTaskProgressRoutes } from './task-progress-routes'
import { registerTaskExecutionRoutes } from './task-executions-routes'
import { registerCodeResourceRoutes } from './code-resources-routes'
import { registerTaskMaterialRoutes } from './task-materials-routes'
import { registerContentRoutes } from './content-routes'
import { registerGovernanceRoutes } from './governance-routes'
import { registerImportRoutes } from './imports-routes'

const noBrowser = (request: FastifyRequest): void => { if (request.headers.origin !== undefined || request.cookies.tp_team_session) throw new TeamServiceError('FORBIDDEN', 'Device enrollment must be initiated by the local desktop client', 403) }
export async function registerTeamRoutes(app: FastifyInstance, store: TeamStore, auth: TeamAuthentication, config: TeamServiceConfig): Promise<void> {
  app.post('/api/device-pairings', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    noBrowser(request)
    const result = await store.call<{ pairingId: string }>('enrollDevice', request.body)
    return { ok: true, value: { ...result, verificationUri: new URL(`/?pairing=${encodeURIComponent(result.pairingId)}`, config.publicOrigin).href } }
  })
  app.get('/api/device-pairings/:pairingId/status', async (request) => {
    noBrowser(request)
    const params = z.object({ pairingId: teamIdSchema }).strict().parse(request.params)
    return { ok: true, value: await store.call('pairingStatus', { pairingId: params.pairingId, credentialHash: credentialDigest(bearerToken(request)) }) }
  })
  await app.register(async (api) => {
    api.addHook('preHandler', auth.require.bind(auth))
    await registerHifoxWorkspaceRoutes(api, store, auth)
    await registerTaskProgressRoutes(api, store, auth)
    await registerTaskExecutionRoutes(api, store, auth)
    await registerCodeResourceRoutes(api, store, auth)
    await registerTaskMaterialRoutes(api, store, auth)
    await registerContentRoutes(api, store, auth)
    await registerGovernanceRoutes(api, store, auth)
    await registerImportRoutes(api, store, auth)
    api.get('/api/session', async (request) => ({ ok: true, value: auth.session(request) }))
    api.get('/api/identity', async (request) => ({ ok: true, value: await auth.identity(request) }))
    const get = (path: string, operation: StoreOperation, fields: (request: FastifyRequest) => Record<string, unknown> = () => ({})): void => {
      api.get(path, async (request) => ({ ok: true, value: await store.call(operation, { actor: auth.principal(request).actor, ...fields(request) }) }))
    }
    const post = (path: string, operation: StoreOperation, fields: (request: FastifyRequest) => Record<string, unknown> = () => ({})): void => {
      api.post(path, async (request) => ({ ok: true, value: await store.call(operation, { actor: auth.principal(request).actor, body: request.body, ...fields(request) }) }))
    }
    const parameter = (name: string) => (request: FastifyRequest): Record<string, unknown> => z.object({ [name]: teamIdSchema }).strict().parse(request.params)
    const query = (request: FastifyRequest): Record<string, unknown> => ({ query: request.query })
    const parameterQuery = (name: string) => (request: FastifyRequest): Record<string, unknown> => ({ ...parameter(name)(request), query: request.query })
    post('/api/invitations', 'createInvitation')
    get('/api/invitations', 'invitations', query)
    post('/api/invitations/:invitationId/inspect', 'inspectInvitation', parameter('invitationId'))
    post('/api/invitations/:invitationId/accept', 'acceptInvitation', parameter('invitationId'))
    post('/api/invitations/:invitationId/revoke', 'revokeInvitation', parameter('invitationId'))
    get('/api/people', 'people', query)
    post('/api/people/:userId/status', 'setPersonActive', parameter('userId'))
    get('/api/teams', 'teams', query); post('/api/teams', 'createTeam')
    get('/api/teams/:teamId/members', 'teamMembers', parameterQuery('teamId')); post('/api/teams/:teamId/members', 'setTeamMember', parameter('teamId'))
    get('/api/projects', 'projects', query); post('/api/projects', 'createProject')
    get('/api/projects/:projectId/members', 'projectMembers', parameterQuery('projectId')); post('/api/projects/:projectId/members', 'setProjectMember', parameter('projectId'))
    get('/api/projects/:projectId/creations', 'creationList', parameterQuery('projectId'))
    get('/api/projects/:projectId/creations/head', 'creationHead', parameter('projectId'))
    get('/api/projects/:projectId/creations/:creationId', 'creationView', (request) => ({ ...z.object({ projectId: teamIdSchema, creationId: teamIdSchema }).strict().parse(request.params), query: request.query }))
    post('/api/projects/:projectId/creations/commands', 'creationCommand', parameter('projectId'))
    post('/api/materials', 'publish'); get('/api/materials', 'materials', (request) => ({ query: request.query }))
    get('/api/materials/:materialId/versions', 'versions', (request) => ({ ...parameter('materialId')(request), query: request.query }))
    get('/api/materials/:materialId/versions/:version', 'document', (request) => z.object({ materialId: teamIdSchema, version: z.coerce.number().int().positive() }).strict().parse(request.params))
    post('/api/feedback', 'recordFeedback'); get('/api/materials/:materialId/feedback', 'feedback', (request) => {
      const { version, ...query } = z.object({ version: z.coerce.number().int().positive(), cursor: z.string().optional(), limit: z.coerce.number().optional() }).strict().parse(request.query)
      return { ...parameter('materialId')(request), version, query }
    })
    get('/api/events', 'events', (request) => ({ query: request.query }))
    post('/api/collaboration/commands', 'collaborationCommand')
    get('/api/collaboration', 'collaborationList', query)
    get('/api/collaboration/:entityId', 'collaborationGet', parameter('entityId'))
    get('/api/collaboration/:entityId/history', 'collaborationHistory', parameterQuery('entityId'))
    get('/api/collaboration/:entityId/replies', 'collaborationReplies', parameterQuery('entityId'))
    get('/api/collaboration/:entityId/reports', 'collaborationReports', parameterQuery('entityId'))
    get('/api/collaboration/:entityId/dispositions', 'collaborationDispositions', parameterQuery('entityId'))
    get('/api/feedback/:feedbackId/reanchor', 'collaborationReanchor', parameterQuery('feedbackId'))
    get('/api/commands/:commandId', 'command', parameter('commandId'))
    get('/api/device-pairings/:pairingId', 'pairing', parameter('pairingId')); post('/api/device-pairings/:pairingId/approve', 'approveDevice', parameter('pairingId'))
    get('/api/devices', 'devices', query); post('/api/devices/:deviceId/revoke', 'revokeDevice', parameter('deviceId')); post('/api/devices/heartbeat', 'heartbeat')
  })
}
