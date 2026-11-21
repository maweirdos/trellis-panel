import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  feishuMemberBindingsSchema, feishuMemberClaimReplySchema, feishuMemberCodeReplySchema,
  feishuMemberCommandReplySchema, feishuMemberReadySchema, feishuMemberReceiptReplySchema, feishuMemberSnapshotReplySchema, feishuMemberSpaceSchema
} from '../../../../src/shared/feishu-member'
import { teamIdSchema } from '../../../../src/shared/team-platform'
import type { TeamAuthentication } from '../auth'
import type { TeamStore } from '../store-client'
import type { FeishuMemberOperation } from './feishu-members'

const base = '/api/projects/:projectId/crux/feishu'
const params = z.object({ projectId: teamIdSchema }).strict()

export function registerFeishuMemberRoutes(api: FastifyInstance, store: TeamStore, auth: TeamAuthentication): void {
  const post = (path: string, operation: FeishuMemberOperation, schema: z.ZodType, max = 60): void => {
    api.post(`${base}/${path}`, { config: { rateLimit: { max, timeWindow: '1 minute' } } }, async request => {
      const { projectId } = params.parse(request.params)
      const value = await store.call(operation, { actor: auth.principal(request).actor, projectId, body: request.body })
      return { ok: true, value: schema.parse(value) }
    })
  }
  post('codes', 'feishuMemberCode', feishuMemberCodeReplySchema, 20)
  post('ready', 'feishuMemberReady', feishuMemberReadySchema, 30)
  post('claim', 'feishuMemberClaim', feishuMemberClaimReplySchema, 30)
  post('snapshot', 'feishuMemberSnapshot', feishuMemberSnapshotReplySchema, 120)
  post('commands', 'feishuMemberCommand', feishuMemberCommandReplySchema, 60)
  post('receipt', 'feishuMemberReceipt', feishuMemberReceiptReplySchema, 60)
  api.get(`${base}/bindings`, { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async request => {
    const { projectId } = params.parse(request.params)
    const body = feishuMemberSpaceSchema.parse(request.query)
    const value = await store.call('feishuMemberBindings', { actor: auth.principal(request).actor, projectId, body })
    return { ok: true, value: feishuMemberBindingsSchema.parse(value) }
  })
  api.post(`${base}/bindings/:bindingId/revoke`, { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => {
    const { projectId, bindingId } = params.extend({ bindingId: teamIdSchema }).parse(request.params)
    const body = { ...feishuMemberSpaceSchema.parse(request.body), bindingId }
    const value = await store.call('feishuMemberRevoke', { actor: auth.principal(request).actor, projectId, body })
    return { ok: true, value: z.null().parse(value) }
  })
}
