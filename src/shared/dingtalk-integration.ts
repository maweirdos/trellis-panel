import { z } from 'zod'
import { ipcFail, IpcErrorCode, type IpcFail } from './ipc-errors'
import type { WorkspaceGrant } from './daemon'

export const DINGTALK_WORKSPACE_VERSION = 1 as const
export const DINGTALK_STREAM_VERSION = '2.1.5' as const
export const dingId = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/)
const revision = z.number().int().nonnegative().safe()
const time = z.number().int().nonnegative().safe()
const uuid = z.string().uuid()
/** Native-only grant projection. Kept transport-neutral so daemon protocol can
 * import the feature maps without a runtime circular dependency. */
export const dingWorkspaceGrantSchema: z.ZodType<WorkspaceGrant> = z.object({ workspaceId: z.string().min(1).max(128), root: z.string().min(1).max(4096), grantId: uuid, revision: z.number().int().positive().safe() }).strict()
export const dingAppSchema = z.object({
  id: uuid, revision: revision, name: z.string().min(1).max(120), appKey: dingId,
  corpId: dingId, robotCode: dingId, hasSecret: z.boolean(),
  state: z.enum(['unverified', 'credentials-verified', 'degraded', 'revoked']),
  checkedAt: time.nullable(), observedCorpId: dingId.nullable(), detail: z.string().max(400)
}).strict()
export const dingAccountSchema = z.object({
  id: uuid, appId: uuid, appRevision: revision, revision, nativeSubject: dingId,
  unionId: dingId, staffId: dingId, corpId: dingId, displayName: z.string().max(256),
  state: z.enum(['linked', 'revoked']), linkedAt: time, serviceBinding: dingId
}).strict()
export const dingPolicySchema = z.object({
  allowedSenders: z.array(dingId).min(1).max(100), allowedGroups: z.array(dingId).max(100),
  allowDirect: z.boolean(), execution: z.enum(['tasks-only', 'manual', 'native-approvals']),
  runtimeId: dingId, profileId: dingId, maxTurnMinutes: z.number().int().min(1).max(120),
  allowTaskUpdates: z.boolean(), replyEnabled: z.boolean()
}).strict()
export const dingAssistantSchema = z.object({
  id: uuid, revision, appId: uuid, appRevision: revision, name: z.string().min(1).max(120),
  workspace: dingWorkspaceGrantSchema, policy: dingPolicySchema, enabled: z.boolean(),
  state: z.enum(['stopped', 'connecting', 'registered', 'retrying', 'blocked', 'degraded']),
  detail: z.string().max(400), lastConnectedAt: time.nullable(), lastMessageAt: time.nullable()
}).strict()
export const dingExecutionSchema = z.object({
  state: z.enum(['pending', 'denied', 'admitted', 'unknown', 'completed', 'cancelled', 'failed']),
  commandId: uuid, sessionId: dingId.nullable(), turnId: dingId.nullable(),
  connectionGeneration: z.string().min(1).max(200).nullable(), detail: z.string().max(400)
}).strict().superRefine((v, ctx) => {
  if (['admitted', 'completed'].includes(v.state) && (!v.sessionId || !v.turnId || v.connectionGeneration === null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Native session, turn and generation evidence is required' })
})
export const dingInboxSchema = z.object({
  id: uuid, assistantId: uuid, assistantRevision: revision, appId: uuid, appRevision: revision,
  originalMessageId: dingId, senderStaffId: dingId, conversationId: dingId, receivedAt: time,
  state: z.enum(['received', 'denied', 'processing', 'task-created', 'completed', 'pending', 'unknown', 'failed']),
  taskRef: dingId.nullable(), taskDir: z.string().max(256).nullable(),
  execution: dingExecutionSchema.nullable(), detail: z.string().max(400),
  reply: z.enum(['disabled', 'pending', 'dispatching', 'delivered', 'failed', 'unknown'])
}).strict()
export const dingNotificationSchema = z.object({
  appId: uuid, revision, enabled: z.boolean(),
  state: z.enum(['disabled', 'needs-account', 'configured', 'degraded']), detail: z.string().max(400)
}).strict()
export const dingDeliverySchema = z.object({
  id: uuid, appId: uuid, accountId: uuid, commandId: uuid, digest: z.string().length(64),
  state: z.enum(['prepared', 'dispatching', 'accepted', 'delivered', 'failed', 'unknown']),
  processQueryKey: dingId.nullable(), createdAt: time, detail: z.string().max(400)
}).strict()
export const dingPersonalSetupSchema = z.object({
  available: z.boolean(), serviceBinding: dingId.nullable(),
  linkPreview: z.enum(['unavailable', 'needs-setup', 'ready']), detail: z.string().max(400)
}).strict()
export const dingSnapshotSchema = z.object({
  version: z.literal(1), nativeSubject: dingId, workspace: dingWorkspaceGrantSchema.nullable(),
  apps: z.array(dingAppSchema).max(50), accounts: z.array(dingAccountSchema).max(100),
  assistants: z.array(dingAssistantSchema).max(100), notifications: z.array(dingNotificationSchema).max(50),
  personal: dingPersonalSetupSchema, executionAvailable: z.boolean(), streamAvailable: z.boolean()
}).strict()
const scope = z.object({ expectedRoot: z.string().min(1).max(4096).nullable() }).strict()
const app = scope.extend({ appId: uuid, revision })
const assistant = scope.extend({ assistantId: uuid, revision })
const secret = z.discriminatedUnion('op', [z.object({ op: z.literal('keep') }).strict(), z.object({ op: z.literal('replace'), value: z.string().min(1).max(4096) }).strict(), z.object({ op: z.literal('clear') }).strict()])
export const dingPreviewSchema = z.object({
  id: uuid, appId: uuid, appRevision: revision, accountId: uuid, accountRevision: revision,
  title: z.string().min(1).max(120), body: z.string().min(1).max(4000), digest: z.string().length(64), expiresAt: time
}).strict()
export const dingtalkRequests = {
  snapshot: scope,
  saveApp: scope.extend({ id: uuid.nullable(), revision, name: z.string().min(1).max(120), appKey: dingId, corpId: dingId, robotCode: dingId, secret }),
  verifyApp: app, revokeApp: app,
  authorizeAccount: app.extend({ requestId: uuid }),
  claimAccount: app.extend({ authorizationId: uuid }),
  unlinkAccount: scope.extend({ accountId: uuid, revision }),
  saveAssistant: scope.extend({ id: uuid.nullable(), revision, appId: uuid, appRevision: revision, name: z.string().min(1).max(120), policy: dingPolicySchema }),
  setAssistant: assistant.extend({ enabled: z.boolean() }), retryAssistant: assistant,
  setNotifications: app.extend({ expectedRevision: revision, enabled: z.boolean() }),
  previewNotification: app.extend({ accountId: uuid, title: z.string().min(1).max(120), body: z.string().min(1).max(4000) }),
  sendNotification: scope.extend({ commandId: uuid, preview: dingPreviewSchema }),
  deliveries: scope.extend({ appId: uuid, after: uuid.nullable(), limit: z.number().int().min(1).max(50) }),
  reconcileDelivery: scope.extend({ deliveryId: uuid }),
  inbox: scope.extend({ assistantId: uuid, after: uuid.nullable(), limit: z.number().int().min(1).max(50) }),
  execute: scope.extend({ receiptId: uuid, assistantRevision: revision }),
  queryExecution: scope.extend({ receiptId: uuid }), cancelExecution: scope.extend({ receiptId: uuid }),
  cancelRead: z.object({ requestId: uuid }).strict()
} as const
export const dingtalkResults = {
  snapshot: dingSnapshotSchema, saveApp: dingAppSchema, verifyApp: dingAppSchema, revokeApp: dingAppSchema,
  authorizeAccount: z.object({ authorizationId: uuid, expiresAt: time }).strict(), claimAccount: dingAccountSchema, unlinkAccount: z.null(),
  saveAssistant: dingAssistantSchema, setAssistant: dingAssistantSchema, retryAssistant: dingAssistantSchema,
  setNotifications: dingNotificationSchema, previewNotification: dingPreviewSchema, sendNotification: dingDeliverySchema,
  deliveries: z.object({ items: z.array(dingDeliverySchema).max(50), next: uuid.nullable() }).strict(), reconcileDelivery: dingDeliverySchema,
  inbox: z.object({ items: z.array(dingInboxSchema).max(50), next: uuid.nullable() }).strict(),
  execute: dingInboxSchema, queryExecution: dingInboxSchema, cancelExecution: dingInboxSchema, cancelRead: z.null()
} as const
export type DingMethod = keyof typeof dingtalkRequests
export type DingInput<M extends DingMethod> = z.infer<(typeof dingtalkRequests)[M]>
export type DingOutput<M extends DingMethod> = z.infer<(typeof dingtalkResults)[M]>
export type DingResult<T> = { ok: true; data: T } | IpcFail
export type DingTalkApi = { version: 1 } & { [M in DingMethod]: (input: DingInput<M>) => Promise<DingResult<DingOutput<M>>> }
export const DINGTALK_IPC = {
  snapshot: 'dingtalk:snapshot', saveApp: 'dingtalk:saveApp', verifyApp: 'dingtalk:verifyApp', revokeApp: 'dingtalk:revokeApp',
  authorizeAccount: 'dingtalk:authorizeAccount', claimAccount: 'dingtalk:claimAccount', unlinkAccount: 'dingtalk:unlinkAccount',
  saveAssistant: 'dingtalk:saveAssistant', setAssistant: 'dingtalk:setAssistant', retryAssistant: 'dingtalk:retryAssistant',
  setNotifications: 'dingtalk:setNotifications', previewNotification: 'dingtalk:previewNotification', sendNotification: 'dingtalk:sendNotification',
  deliveries: 'dingtalk:deliveries', reconcileDelivery: 'dingtalk:reconcileDelivery', inbox: 'dingtalk:inbox',
  execute: 'dingtalk:execute', queryExecution: 'dingtalk:queryExecution', cancelExecution: 'dingtalk:cancelExecution', cancelRead: 'dingtalk:cancelRead'
} as const satisfies Record<DingMethod, string>
/** Main mounts these in its explicit authenticated daemon method allowlist. */
export const DINGTALK_DAEMON = {
  snapshot: 'dingtalk.workspace.snapshot', saveApp: 'dingtalk.workspace.saveApp', verifyApp: 'dingtalk.workspace.verifyApp', revokeApp: 'dingtalk.workspace.revokeApp',
  authorizeAccount: 'dingtalk.workspace.authorizeAccount', claimAccount: 'dingtalk.workspace.claimAccount', unlinkAccount: 'dingtalk.workspace.unlinkAccount',
  saveAssistant: 'dingtalk.workspace.saveAssistant', setAssistant: 'dingtalk.workspace.setAssistant', retryAssistant: 'dingtalk.workspace.retryAssistant',
  setNotifications: 'dingtalk.workspace.setNotifications', previewNotification: 'dingtalk.workspace.previewNotification', sendNotification: 'dingtalk.workspace.sendNotification',
  deliveries: 'dingtalk.workspace.deliveries', reconcileDelivery: 'dingtalk.workspace.reconcileDelivery', inbox: 'dingtalk.workspace.inbox',
  execute: 'dingtalk.workspace.execute', queryExecution: 'dingtalk.workspace.queryExecution', cancelExecution: 'dingtalk.workspace.cancelExecution'
} as const satisfies Record<Exclude<DingMethod, 'cancelRead'>, string>
export const DINGTALK_RPC_REQUESTS = {
  'dingtalk.workspace.snapshot': dingtalkRequests.snapshot, 'dingtalk.workspace.saveApp': dingtalkRequests.saveApp,
  'dingtalk.workspace.verifyApp': dingtalkRequests.verifyApp, 'dingtalk.workspace.revokeApp': dingtalkRequests.revokeApp,
  'dingtalk.workspace.authorizeAccount': dingtalkRequests.authorizeAccount, 'dingtalk.workspace.claimAccount': dingtalkRequests.claimAccount,
  'dingtalk.workspace.unlinkAccount': dingtalkRequests.unlinkAccount, 'dingtalk.workspace.saveAssistant': dingtalkRequests.saveAssistant,
  'dingtalk.workspace.setAssistant': dingtalkRequests.setAssistant, 'dingtalk.workspace.retryAssistant': dingtalkRequests.retryAssistant,
  'dingtalk.workspace.setNotifications': dingtalkRequests.setNotifications, 'dingtalk.workspace.previewNotification': dingtalkRequests.previewNotification,
  'dingtalk.workspace.sendNotification': dingtalkRequests.sendNotification, 'dingtalk.workspace.deliveries': dingtalkRequests.deliveries,
  'dingtalk.workspace.reconcileDelivery': dingtalkRequests.reconcileDelivery, 'dingtalk.workspace.inbox': dingtalkRequests.inbox,
  'dingtalk.workspace.execute': dingtalkRequests.execute, 'dingtalk.workspace.queryExecution': dingtalkRequests.queryExecution,
  'dingtalk.workspace.cancelExecution': dingtalkRequests.cancelExecution
} as const
export const DINGTALK_RPC_RESULTS = {
  'dingtalk.workspace.snapshot': dingtalkResults.snapshot, 'dingtalk.workspace.saveApp': dingtalkResults.saveApp,
  'dingtalk.workspace.verifyApp': dingtalkResults.verifyApp, 'dingtalk.workspace.revokeApp': dingtalkResults.revokeApp,
  'dingtalk.workspace.authorizeAccount': dingtalkResults.authorizeAccount, 'dingtalk.workspace.claimAccount': dingtalkResults.claimAccount,
  'dingtalk.workspace.unlinkAccount': dingtalkResults.unlinkAccount, 'dingtalk.workspace.saveAssistant': dingtalkResults.saveAssistant,
  'dingtalk.workspace.setAssistant': dingtalkResults.setAssistant, 'dingtalk.workspace.retryAssistant': dingtalkResults.retryAssistant,
  'dingtalk.workspace.setNotifications': dingtalkResults.setNotifications, 'dingtalk.workspace.previewNotification': dingtalkResults.previewNotification,
  'dingtalk.workspace.sendNotification': dingtalkResults.sendNotification, 'dingtalk.workspace.deliveries': dingtalkResults.deliveries,
  'dingtalk.workspace.reconcileDelivery': dingtalkResults.reconcileDelivery, 'dingtalk.workspace.inbox': dingtalkResults.inbox,
  'dingtalk.workspace.execute': dingtalkResults.execute, 'dingtalk.workspace.queryExecution': dingtalkResults.queryExecution,
  'dingtalk.workspace.cancelExecution': dingtalkResults.cancelExecution
} as const satisfies Record<keyof typeof DINGTALK_RPC_REQUESTS, z.ZodTypeAny>
export function hasDingTalkApi(value: unknown): value is DingTalkApi {
  if (!value || typeof value !== 'object') return false
  const api = value as Record<string, unknown>
  return api.version === 1 && Object.keys(DINGTALK_IPC).every((key) => typeof api[key] === 'function')
}
export function createDingTalkBridge(invoke: (channel: string, input: unknown) => Promise<unknown>): DingTalkApi {
  async function call<M extends DingMethod>(method: M, input: DingInput<M>): Promise<DingResult<DingOutput<M>>> {
    const parsed = dingtalkRequests[method].parse(input)
    let reply: unknown
    try { reply = await invoke(DINGTALK_IPC[method], parsed) }
    catch (error) {
      if (error instanceof Error && /No handler registered|handler.*not.*registered/i.test(error.message)) return ipcFail(IpcErrorCode.Unavailable, '主进程尚未加载钉钉工作区接口，请完整重启应用。')
      return ipcFail(IpcErrorCode.Unknown, '钉钉后台响应中断，请读取原记录核实结果。')
    }
    const failure = z.object({ ok: z.literal(false), code: z.nativeEnum(IpcErrorCode), error: z.string() }).safeParse(reply)
    if (failure.success) return failure.data
    const data = z.object({ ok: z.literal(true), data: z.unknown() }).parse(reply).data
    return { ok: true, data: dingtalkResults[method].parse(data) as DingOutput<M> }
  }
  return { version: 1, snapshot: i => call('snapshot', i), saveApp: i => call('saveApp', i), verifyApp: i => call('verifyApp', i), revokeApp: i => call('revokeApp', i), authorizeAccount: i => call('authorizeAccount', i), claimAccount: i => call('claimAccount', i), unlinkAccount: i => call('unlinkAccount', i), saveAssistant: i => call('saveAssistant', i), setAssistant: i => call('setAssistant', i), retryAssistant: i => call('retryAssistant', i), setNotifications: i => call('setNotifications', i), previewNotification: i => call('previewNotification', i), sendNotification: i => call('sendNotification', i), deliveries: i => call('deliveries', i), reconcileDelivery: i => call('reconcileDelivery', i), inbox: i => call('inbox', i), execute: i => call('execute', i), queryExecution: i => call('queryExecution', i), cancelExecution: i => call('cancelExecution', i), cancelRead: i => call('cancelRead', i) }
}
export type DingApp = z.infer<typeof dingAppSchema>
export type DingAccount = z.infer<typeof dingAccountSchema>
export type DingAssistant = z.infer<typeof dingAssistantSchema>
export type DingPolicy = z.infer<typeof dingPolicySchema>
export type DingInbox = z.infer<typeof dingInboxSchema>
export type DingExecution = z.infer<typeof dingExecutionSchema>
export type DingDelivery = z.infer<typeof dingDeliverySchema>
export type DingPreview = z.infer<typeof dingPreviewSchema>
