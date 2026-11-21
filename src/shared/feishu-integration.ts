import { z } from 'zod'
import { ipcFail, IpcErrorCode, type IpcFail } from './ipc-errors'

const id = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/)
const uuid = z.string().uuid()
export const feishuAppIdSchema = z.string().regex(/^cli_[0-9a-fA-F]{16}$/)
const revision = z.number().int().positive().safe()
const kind = z.enum(['organization', 'assistant', 'agent'])
const scope = z.object({ expectedRoot: z.string().min(1).max(4096).nullable() }).strict()
const selectedTeam = { selectedScopeKey: z.string().regex(/^[a-f0-9]{64}$/).optional() }
const connection = scope.extend({ id: uuid, revision, ...selectedTeam })
const attempt = scope.extend({ attemptId: uuid })
const modelFields = { providerId: id.optional(), modelId: id.optional() }
const runtimeId = z.literal('pi')
const runtime = z.object({ id: runtimeId, name: id, deviceName: id }).strict()
const chatIds = z.array(z.string().regex(/^oc_[A-Za-z0-9_-]{1,120}$/)).max(50)

export const feishuReceiptSchema = z.object({
  commandId: uuid, sourceMessageId: z.string().regex(/^om_[A-Za-z0-9_-]{1,120}$/),
  at: z.number().int().nonnegative().safe(),
  phase: z.enum(['accepted', 'completed', 'failed', 'unknown']),
  reply: z.enum(['none', 'dispatching', 'sent', 'failed', 'unknown'])
}).strict()

export const feishuConnectionSchema = z.object({
  id: uuid, revision, kind, name: z.string().min(1).max(120), appId: id,
  spaceId: id.nullable(), agentId: id.nullable(), scopeKey: id.nullable(),
  allowedChatIds: chatIds, enabled: z.boolean(),
  state: z.enum(['verified', 'connecting', 'connected', 'blocked', 'failed', 'stopped']),
  detail: z.string().max(400), providerId: id.nullable(), modelId: id.nullable(), runtimeId: runtimeId.optional(),
  lastOperation: feishuReceiptSchema.optional(),
  pendingOperations: z.array(feishuReceiptSchema).max(20).optional()
}).strict()

export const feishuAttemptSchema = z.object({
  id: uuid, status: z.enum(['starting', 'pending', 'connected', 'failed', 'expired', 'cancelled', 'unknown']),
  url: z.string().url().max(4096).nullable(),
  expiresAt: z.number().int().nonnegative().safe().nullable(), detail: z.string().max(400)
}).strict()

export const feishuAccountSchema = z.object({
  state: z.enum(['unlinked', 'linked']), displayName: z.string().max(256)
}).strict()

export const feishuRequests = {
  snapshot: scope.extend(selectedTeam),
  connectOrganization: scope.extend({ appId: feishuAppIdSchema, appSecret: z.string().min(1).max(512) }),
  beginRegistration: scope.extend({
    kind: z.enum(['assistant', 'agent']), spaceId: id, agentId: id.nullable(), name: z.string().trim().min(1).max(120),
    scopeKey: z.string().min(1).max(1024).optional(), runtimeId: runtimeId.optional(), ...modelFields
  }),
  registrationStatus: attempt.extend(selectedTeam), cancelRegistration: attempt.extend({ ...selectedTeam, discardUnconfirmed: z.boolean().optional() }),
  configure: connection.extend({ allowedChatIds: chatIds, enabled: z.boolean(), ...modelFields }),
  retry: connection, disconnect: connection, chats: connection, reconcile: connection.extend({ originalCommandId: uuid }),
  beginAccount: scope, accountStatus: attempt, cancelAccount: attempt, unlinkAccount: scope
} as const

export const feishuResults = {
  snapshot: z.object({
    organization: feishuConnectionSchema.nullable(), account: feishuAccountSchema.nullable(), accountAvailable: z.boolean(),
    connections: z.array(feishuConnectionSchema).max(50), runtimes: z.array(runtime).max(1).optional()
  }).strict(),
  connectOrganization: feishuConnectionSchema, beginRegistration: feishuAttemptSchema, registrationStatus: feishuAttemptSchema,
  cancelRegistration: feishuAttemptSchema, configure: feishuConnectionSchema, retry: feishuConnectionSchema, disconnect: z.null(),
  chats: z.array(z.object({ id: chatIds.element, name: z.string().min(1).max(256) }).strict()).max(100),
  reconcile: z.object({ confirmed: z.boolean(), detail: z.string().max(1000) }).strict(),
  beginAccount: feishuAttemptSchema, accountStatus: feishuAttemptSchema, cancelAccount: feishuAttemptSchema, unlinkAccount: z.null()
} as const

export type FeishuConnection = z.infer<typeof feishuConnectionSchema>
export type FeishuAttempt = z.infer<typeof feishuAttemptSchema>
export type FeishuMethod = keyof typeof feishuRequests
export type FeishuInput<M extends FeishuMethod> = z.infer<(typeof feishuRequests)[M]>
export type FeishuOutput<M extends FeishuMethod> = z.infer<(typeof feishuResults)[M]>
export type FeishuResult<T> = { ok: true; data: T } | IpcFail
export type FeishuActions = { [M in FeishuMethod]: (input: FeishuInput<M>) => Promise<FeishuOutput<M>> }
export type FeishuApi = { version: 1 } & { [M in FeishuMethod]: (input: FeishuInput<M>) => Promise<FeishuResult<FeishuOutput<M>>> }

const methods = Object.keys(feishuRequests) as FeishuMethod[]
export const FEISHU_IPC = Object.fromEntries(methods.map(method => [method, `feishu:${method}`])) as {
  [M in FeishuMethod]: `feishu:${M}`
}
export const FEISHU_DAEMON = Object.fromEntries(methods.map(method => [method, `feishu.workspace.${method}`])) as {
  [M in FeishuMethod]: `feishu.workspace.${M}`
}

export function hasFeishuApi(value: unknown): value is FeishuApi {
  if (!value || typeof value !== 'object') return false
  const api = value as Record<string, unknown>
  return api.version === 1 && methods.every(method => typeof api[method] === 'function')
}

export function createFeishuBridge(invoke: (channel: string, input: unknown) => Promise<unknown>): FeishuApi {
  const fail = (code: IpcErrorCode, detail: string) => ipcFail(code, detail)
  async function call<M extends FeishuMethod>(method: M, input: FeishuInput<M>): Promise<FeishuResult<FeishuOutput<M>>> {
    const request = feishuRequests[method].safeParse(input)
    if (!request.success) return fail(IpcErrorCode.InvalidArg, '飞书请求参数无效。')
    let raw: unknown
    try { raw = await invoke(FEISHU_IPC[method], request.data) }
    catch (error) {
      if (error instanceof Error && /No handler registered/i.test(error.message)) return fail(IpcErrorCode.Unavailable, '桌面应用尚未加载飞书集成，请完整重启。')
      return fail(IpcErrorCode.Unknown, '飞书后台响应中断，请核对原连接状态。')
    }
    const failure = z.object({ ok: z.literal(false), code: z.nativeEnum(IpcErrorCode), error: z.string() }).safeParse(raw)
    if (failure.success) return failure.data
    const envelope = z.object({ ok: z.literal(true), data: z.unknown() }).safeParse(raw)
    const result = feishuResults[method].safeParse(envelope.success ? envelope.data.data : undefined)
    return result.success ? { ok: true, data: result.data as FeishuOutput<M> } : fail(IpcErrorCode.Unknown, '飞书后台响应无效。')
  }
  return {
    version: 1, snapshot: input => call('snapshot', input),
    connectOrganization: input => call('connectOrganization', input),
    beginRegistration: input => call('beginRegistration', input), registrationStatus: input => call('registrationStatus', input),
    cancelRegistration: input => call('cancelRegistration', input), configure: input => call('configure', input),
    retry: input => call('retry', input), disconnect: input => call('disconnect', input),
    chats: input => call('chats', input), reconcile: input => call('reconcile', input),
    beginAccount: input => call('beginAccount', input), accountStatus: input => call('accountStatus', input),
    cancelAccount: input => call('cancelAccount', input), unlinkAccount: input => call('unlinkAccount', input)
  }
}
