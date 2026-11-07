import { z } from 'zod'
import { executionTargetSchema, integrationAccountSchema, integrationJobSchema, integrationSourceSchema, syncPlanSchema } from './integration-work'
import { ipcFail, IpcErrorCode, type IpcFail } from './ipc-errors'

export const JIRA_WORKSPACE_VERSION = 1 as const
export const JIRA_LIMITS = { csvBytes: 192 * 1024, recordBytes: 64 * 1024, previewItems: 500, pageSize: 50, historyPage: 20, policies: 100, evidenceBytes: 64 * 1024 * 1024, previewMs: 30 * 60_000, pollMs: 60_000 } as const
const id = z.string().min(1).max(128)
const revision = z.number().int().positive().safe()
const timestamp = z.number().int().nonnegative().safe()
export const jiraNumericIdSchema = z.string().regex(/^[1-9]\d{0,14}$/).refine((value) => Number.isSafeInteger(Number(value)), 'Numeric Jira identity exceeds the safe integer range')
export const jiraFieldSchema = z.enum(['title', 'description', 'priority', 'status', 'assignee', 'labels', 'type', 'comments'])
export const jiraFieldsSchema = z.object({
  title: z.string().min(1).max(500), description: z.string().max(JIRA_LIMITS.recordBytes).nullable(),
  priority: z.string().max(128), status: z.string().max(128), assignee: z.string().max(200),
  labels: z.array(z.string().max(256)).max(100), type: z.string().max(128),
  comments: z.array(z.object({ id, body: z.string().max(16000), author: z.string().max(200), updatedAt: timestamp.nullable() }).strict()).max(100)
}).strict()
export const jiraIssueSchema = z.object({
  instanceId: id, issueId: jiraNumericIdSchema, key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*-\d+$/).max(64), projectId: jiraNumericIdSchema,
  url: z.string().url().max(2000), updatedAt: timestamp.nullable(), fields: jiraFieldsSchema,
  references: z.object({ parentId: jiraNumericIdSchema.nullable(), attachments: z.array(z.object({ id, name: z.string().max(512) }).strict()).max(100), custom: z.record(z.string(), z.unknown()) }).strict(),
  coverage: z.object({ commentsComplete: z.boolean(), historyComplete: z.boolean(), history: z.array(z.unknown()).max(100), warnings: z.array(z.string().max(300)).max(30) }).strict()
}).strict()
export const jiraMappingSchema = z.object({
  revision, fields: z.array(jiraFieldSchema).min(1).max(8),
  priorities: z.record(z.string(), z.enum(['P0', 'P1', 'P2', 'P3'])),
  statuses: z.record(z.string(), z.string().min(1).max(128)),
  members: z.record(z.string(), z.string().min(1).max(200)),
  types: z.record(z.string(), z.string().min(1).max(128)),
  /** Status targets are actual Jira transition IDs, validated again for the issue. */
  transitions: z.record(z.string(), jiraNumericIdSchema)
}).strict().superRefine((mapping, context) => {
  if (new Set(mapping.fields).size !== mapping.fields.length) context.addIssue({ code: 'custom', message: 'Duplicate mapped field' })
  for (const key of ['priorities', 'statuses', 'members', 'types', 'transitions'] as const) {
    if (Object.keys(mapping[key]).length > 200) context.addIssue({ code: 'custom', message: 'Mapping exceeds 200 entries' })
  }
})
export const jiraPlanSchema = z.object({
  plan: syncPlanSchema, controlRevision: revision, name: z.string().min(1).max(200), jql: z.string().max(4000), mapping: jiraMappingSchema,
  /** Explicit platform Space for Jira intake/status business Hooks. */
  platformSpaceId: id.nullable().optional(),
  rules: z.object({ inboundCreate: z.boolean(), inboundUpdate: z.boolean(), outboundCreate: z.boolean(), outboundUpdate: z.boolean() }).strict(),
  /** Explicit locally selected tasks; a plan never exports the whole workspace implicitly. */
  outboundTaskRefs: z.array(z.string().min(1).max(256)).max(100),
  remoteWritesApproved: z.boolean(), includeHistory: z.boolean(),
  createIssueTypeId: jiraNumericIdSchema.nullable(),
  receiverId: id.nullable(),
  since: timestamp, scanAfterId: jiraNumericIdSchema.nullable(), lastSuccessAt: timestamp.nullable(), nextPollAt: timestamp.nullable(), failures: z.number().int().min(0).max(20),
  detail: z.string().max(400)
}).strict().superRefine((value, context) => {
  if (value.plan.source.providerId !== 'jira' || value.plan.fieldMappingRevision !== value.mapping.revision || !['polling', 'webhook'].includes(value.plan.transport)) context.addIssue({ code: 'custom', message: 'Jira plans require a matching mapping revision and a supported transport' })
  if (value.plan.transport === 'webhook' && !value.receiverId) context.addIssue({ code: 'custom', message: 'Webhook plans require an explicitly configured verified receiver' })
  if ((value.rules.outboundCreate || value.rules.outboundUpdate) && (value.plan.direction !== 'bidirectional' || !value.remoteWritesApproved)) context.addIssue({ code: 'custom', message: 'Remote writes require explicit bidirectional approval' })
  if (value.rules.outboundCreate && !value.createIssueTypeId && !value.mapping.fields.includes('type')) context.addIssue({ code: 'custom', message: 'Outbound creation requires an explicit Jira type or a supported local type mapping' })
})
export const jiraPreviewSchema = z.object({
  id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/), workspaceId: id, source: integrationSourceSchema,
  format: z.enum(['api', 'csv']), createdAt: timestamp, expiresAt: timestamp, mapping: jiraMappingSchema,
  includeHistory: z.boolean(), query: z.string().max(4000), total: z.number().int().nonnegative().nullable(),
  scope: z.enum(['full-query', 'csv-records']), upperIssueId: jiraNumericIdSchema.nullable(),
  count: z.number().int().nonnegative().max(JIRA_LIMITS.previewItems), complete: z.boolean(), warnings: z.array(z.string().max(300)).max(50),
  sample: z.array(jiraIssueSchema).max(5)
}).strict()
export const jiraConflictSchema = z.object({ id: z.string().uuid(), planId: id, instanceId: id, issueId: jiraNumericIdSchema, taskRef: z.string().max(256), field: jiraFieldSchema, base: z.unknown(), local: z.unknown(), remote: z.unknown(), revision, resolved: z.boolean(), resolution: z.enum(['local', 'remote']).nullable(), applied: z.boolean() }).strict()
export const jiraDiagnosticSchema = z.object({ code: z.enum(['permission', 'mapping', 'conflict', 'partial', 'unknown', 'paused', 'transport', 'io']), detail: z.string().max(400), issueId: jiraNumericIdSchema.nullable(), at: timestamp }).strict()
export const jiraMetadataSchema = z.object({
  instanceId: id, authenticatedUser: z.object({ id, name: z.string().max(200), displayName: z.string().max(256) }).strict(),
  version: z.string().max(64), deployment: z.string().max(64),
  projects: z.array(z.object({ id: jiraNumericIdSchema, key: z.string().max(64), name: z.string().max(256) }).strict()).max(500),
  fields: z.array(z.object({ id: z.string().max(128), name: z.string().max(256), custom: z.boolean() }).strict()).max(2000),
  statuses: z.array(z.object({ id, name: z.string().max(128) }).strict()).max(500),
  issueTypes: z.array(z.object({ id, name: z.string().max(128) }).strict()).max(100),
  priorities: z.array(z.object({ id, name: z.string().max(128) }).strict()).max(100),
  members: z.array(z.object({ id, name: z.string().max(200), displayName: z.string().max(256) }).strict()).max(50),
  membersHasMore: z.boolean(), permissions: z.record(z.string(), z.boolean()), warnings: z.array(z.string().max(300)).max(30)
}).strict()
export const jiraItemReceiptSchema = z.object({
  id: z.string().uuid(), jobId: z.string().uuid(), identity: z.string().max(300), issueId: jiraNumericIdSchema.nullable(), key: z.string().max(64),
  taskRef: z.string().max(256).nullable(), operationId: z.string().max(128).nullable(),
  effect: z.enum(['local-create', 'local-update', 'platform-create', 'platform-update', 'remote-create', 'remote-update', 'remote-transition', 'remote-comment', 'rollback']),
  state: z.enum(['intent', 'applied', 'failed', 'conflict', 'unknown', 'skipped', 'rolled-back', 'rollback-blocked']),
  created: z.boolean(), detail: z.string().max(400), at: timestamp
}).strict()
/** Renderer identity is an optional expectation; native capture supplies the actual grant. */
const scope = z.object({ expectedRoot: z.string().min(1).max(4096), workspaceId: id.optional() }).strict()
const sourceScope = scope.extend({ source: integrationSourceSchema })
const jobScope = scope.extend({ jobId: z.string().uuid(), revision, ownerEpoch: z.string().uuid() })
const csvColumns = z.object({ issueId: z.string().min(1).max(200), key: z.string().min(1).max(200), title: z.string().min(1).max(200), description: z.string().max(200), priority: z.string().max(200), status: z.string().max(200), assignee: z.string().max(200), labels: z.string().max(200), type: z.string().max(200), updated: z.string().max(200) }).strict()
/** Main centrally declares these exact channel strings before registerJiraIntegrationIpc. */
export const JIRA_INTEGRATION_CHANNELS = {
  context: 'jira-workspace:context', projects: 'jira-workspace:projects', selectProject: 'jira-workspace:selectProject',
  snapshot: 'jira-workspace:snapshot', discover: 'jira-workspace:discover', bindAccount: 'jira-workspace:bindAccount',
  savePlan: 'jira-workspace:savePlan', planState: 'jira-workspace:planState', catchUp: 'jira-workspace:catchUp',
  previewApi: 'jira-workspace:previewApi', previewCsv: 'jira-workspace:previewCsv', startImport: 'jira-workspace:startImport',
  history: 'jira-workspace:history', jobDetail: 'jira-workspace:jobDetail', cancel: 'jira-workspace:cancel',
  rollback: 'jira-workspace:rollback', resolveConflict: 'jira-workspace:resolveConflict', reconcile: 'jira-workspace:reconcile', localTasks: 'jira-workspace:localTasks',
  resume: 'jira-workspace:resume', receiver: 'jira-workspace:receiver', cancelRead: 'jira-workspace:cancelRead'
} as const
/** Native protocol names to merge by explicit import into the common daemon allowlist. */
export const JIRA_NATIVE_METHODS = {
  context: 'jira.workspace.context', projects: 'jira.workspace.projects', selectProject: 'jira.workspace.selectProject',
  snapshot: 'jira.workspace.snapshot', discover: 'jira.workspace.discover', bindAccount: 'jira.workspace.bindAccount',
  savePlan: 'jira.workspace.savePlan', planState: 'jira.workspace.planState', catchUp: 'jira.workspace.catchUp',
  previewApi: 'jira.workspace.previewApi', previewCsv: 'jira.workspace.previewCsv', startImport: 'jira.workspace.startImport',
  history: 'jira.workspace.history', jobDetail: 'jira.workspace.jobDetail', cancel: 'jira.workspace.cancel',
  resume: 'jira.workspace.resume', rollback: 'jira.workspace.rollback', resolveConflict: 'jira.workspace.resolveConflict',
  reconcile: 'jira.workspace.reconcile', localTasks: 'jira.workspace.localTasks', receiver: 'jira.workspace.receiver', cancelRead: 'jira.workspace.cancelRead'
} as const
export const JIRA_DAEMON = JIRA_NATIVE_METHODS
export const JIRA_IPC = JIRA_INTEGRATION_CHANNELS
export const JIRA_MUTATING_METHODS = ['selectProject', 'bindAccount', 'savePlan', 'planState', 'catchUp', 'startImport', 'cancel', 'resume', 'rollback', 'resolveConflict', 'reconcile', 'receiver'] as const
export const jiraRequests = {
  context: z.object({ expectedRoot: z.string().min(1).max(4096) }).strict(),
  projects: scope.extend({ requestId: z.string().uuid(), connectionId: id, connectionRevision: revision, bindingId: id, bindingRevision: revision }),
  selectProject: scope.extend({ connectionId: id, connectionRevision: revision, bindingId: id, bindingRevision: revision, projectId: jiraNumericIdSchema }),
  snapshot: scope,
  discover: sourceScope.extend({ requestId: z.string().uuid(), memberQuery: z.string().max(200).default('') }),
  bindAccount: sourceScope.extend({ expectedRevision: z.number().int().nonnegative().safe(), unlink: z.boolean(), personalConnection: z.object({ connectionId: id, connectionRevision: revision }).strict().nullable() }),
  savePlan: scope.extend({ expectedRevision: z.number().int().nonnegative().safe(), value: jiraPlanSchema }),
  planState: scope.extend({ planId: id, revision, controlRevision: revision, state: z.enum(['paused', 'active']) }),
  catchUp: scope.extend({ planId: id, revision, commandId: z.string().uuid() }),
  previewApi: sourceScope.extend({ requestId: z.string().uuid(), jql: z.string().max(4000), mapping: jiraMappingSchema, includeHistory: z.boolean(), maxItems: z.number().int().min(1).max(JIRA_LIMITS.previewItems) }),
  previewCsv: sourceScope.extend({ requestId: z.string().uuid(), csv: z.string().max(JIRA_LIMITS.csvBytes), columns: csvColumns, mapping: jiraMappingSchema, includeHistory: z.literal(false) }),
  startImport: scope.extend({ previewId: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/), commandId: z.string().uuid(), acceptPartial: z.boolean() }),
  history: scope.extend({ after: z.string().uuid().nullable(), limit: z.number().int().min(1).max(JIRA_LIMITS.historyPage) }),
  jobDetail: scope.extend({ jobId: z.string().uuid(), after: z.string().uuid().nullable(), limit: z.number().int().min(1).max(50) }),
  cancel: jobScope.extend({ commandId: z.string().uuid() }), rollback: jobScope.extend({ commandId: z.string().uuid() }),
  resolveConflict: scope.extend({ conflictId: z.string().uuid(), revision, choice: z.enum(['local', 'remote']) }),
  reconcile: jobScope, localTasks: scope,
  resume: jobScope.extend({ commandId: z.string().uuid() }), receiver: scope.extend({ planId: id, revision, recover: z.boolean(), commandId: z.string().uuid() }),
  cancelRead: scope.extend({ requestId: z.string().uuid() })
} as const
export const jiraSnapshotSchema = z.object({ accounts: z.array(integrationAccountSchema).max(100), identities: z.array(z.object({ sourceConnectionId: id, personalConnectionId: id.nullable(), remoteUserId: id.nullable(), username: z.string().max(200), mode: z.enum(['personal-connection', 'instance-credential-fallback']), detail: z.string().max(300) }).strict()).max(100), plans: z.array(jiraPlanSchema).max(100), conflicts: z.array(jiraConflictSchema).max(100), diagnostics: z.array(jiraDiagnosticSchema).max(100), scope: z.literal('local-workspace'), capability: z.literal('jira-workspace-v1') }).strict()
export const jiraResults = {
  context: z.object({ workspaceId: id, target: executionTargetSchema, sources: z.array(z.object({ source: integrationSourceSchema, name: z.string().max(256) }).strict()).max(100) }).strict(),
  projects: z.array(z.object({ id: jiraNumericIdSchema, key: z.string().max(64), name: z.string().max(256) }).strict()).max(500),
  selectProject: integrationSourceSchema,
  snapshot: jiraSnapshotSchema, discover: jiraMetadataSchema, bindAccount: integrationAccountSchema.nullable(), savePlan: jiraPlanSchema, planState: jiraPlanSchema,
  catchUp: integrationJobSchema, previewApi: jiraPreviewSchema, previewCsv: jiraPreviewSchema, startImport: integrationJobSchema,
  history: z.object({ items: z.array(integrationJobSchema).max(JIRA_LIMITS.historyPage), next: z.string().uuid().nullable(), rollbacks: z.array(z.object({ jobId: z.string().uuid(), removed: z.number().int().nonnegative(), blocked: z.number().int().nonnegative() }).strict()).max(JIRA_LIMITS.historyPage) }).strict(),
  jobDetail: z.object({ items: z.array(jiraItemReceiptSchema).max(50), next: z.string().uuid().nullable() }).strict(), cancel: integrationJobSchema,
  rollback: z.object({ removed: z.number().int().nonnegative(), blocked: z.number().int().nonnegative(), evidenceRef: z.string().max(256) }).strict(),
  resolveConflict: jiraConflictSchema, reconcile: z.object({ resolved: z.boolean(), evidenceRef: z.string().max(256).nullable() }).strict(),
  localTasks: z.array(z.object({ taskRef: z.string().max(256), title: z.string().max(500) }).strict()).max(100),
  resume: integrationJobSchema, receiver: z.object({ ready: z.boolean(), detail: z.string().max(400), lastVerifiedAt: timestamp.nullable() }).strict(),
  cancelRead: z.object({ cancelled: z.boolean() }).strict()
} as const
/** Central daemon owner merges these literal schema pairs, retaining its authenticated envelope. */
export const JIRA_DAEMON_SCHEMAS = {
  'jira.workspace.context': { request: jiraRequests.context, response: jiraResults.context },
  'jira.workspace.projects': { request: jiraRequests.projects, response: jiraResults.projects },
  'jira.workspace.selectProject': { request: jiraRequests.selectProject, response: jiraResults.selectProject },
  'jira.workspace.snapshot': { request: jiraRequests.snapshot, response: jiraResults.snapshot },
  'jira.workspace.discover': { request: jiraRequests.discover, response: jiraResults.discover },
  'jira.workspace.bindAccount': { request: jiraRequests.bindAccount, response: jiraResults.bindAccount },
  'jira.workspace.savePlan': { request: jiraRequests.savePlan, response: jiraResults.savePlan },
  'jira.workspace.planState': { request: jiraRequests.planState, response: jiraResults.planState },
  'jira.workspace.catchUp': { request: jiraRequests.catchUp, response: jiraResults.catchUp },
  'jira.workspace.previewApi': { request: jiraRequests.previewApi, response: jiraResults.previewApi },
  'jira.workspace.previewCsv': { request: jiraRequests.previewCsv, response: jiraResults.previewCsv },
  'jira.workspace.startImport': { request: jiraRequests.startImport, response: jiraResults.startImport },
  'jira.workspace.history': { request: jiraRequests.history, response: jiraResults.history },
  'jira.workspace.jobDetail': { request: jiraRequests.jobDetail, response: jiraResults.jobDetail },
  'jira.workspace.cancel': { request: jiraRequests.cancel, response: jiraResults.cancel },
  'jira.workspace.resume': { request: jiraRequests.resume, response: jiraResults.resume },
  'jira.workspace.rollback': { request: jiraRequests.rollback, response: jiraResults.rollback },
  'jira.workspace.resolveConflict': { request: jiraRequests.resolveConflict, response: jiraResults.resolveConflict },
  'jira.workspace.reconcile': { request: jiraRequests.reconcile, response: jiraResults.reconcile },
  'jira.workspace.localTasks': { request: jiraRequests.localTasks, response: jiraResults.localTasks },
  'jira.workspace.receiver': { request: jiraRequests.receiver, response: jiraResults.receiver },
  'jira.workspace.cancelRead': { request: jiraRequests.cancelRead, response: jiraResults.cancelRead }
} as const
export type JiraMethod = keyof typeof jiraRequests
export type JiraRequest<M extends JiraMethod> = z.infer<(typeof jiraRequests)[M]>
export type JiraData<M extends JiraMethod> = z.infer<(typeof jiraResults)[M]>
export type JiraResult<T> = { ok: true; data: T } | IpcFail
export type JiraIntegrationApi = { version: 1 } & { [M in JiraMethod]: (input: JiraRequest<M>) => Promise<JiraResult<JiraData<M>>> }
export type JiraFields = z.infer<typeof jiraFieldsSchema>
export type JiraField = z.infer<typeof jiraFieldSchema>
export type JiraIssueRecord = z.infer<typeof jiraIssueSchema>
export type JiraMapping = z.infer<typeof jiraMappingSchema>
export type JiraPlan = z.infer<typeof jiraPlanSchema>
export type JiraPreview = z.infer<typeof jiraPreviewSchema>
export type JiraItemReceipt = z.infer<typeof jiraItemReceiptSchema>
export type JiraConflict = z.infer<typeof jiraConflictSchema>
export type JiraDiagnostic = z.infer<typeof jiraDiagnosticSchema>
export function hasJiraIntegrationApi(value: unknown): value is JiraIntegrationApi {
  if (!value || typeof value !== 'object') return false
  const api = value as Record<string, unknown>
  return api.version === JIRA_WORKSPACE_VERSION && Object.keys(JIRA_INTEGRATION_CHANNELS).every((method) => typeof api[method] === 'function')
}
/** Preload exposes only these methods at window.trellis.jiraIntegration; invoke stays private. */
export function createJiraWorkspaceBridge(invoke: (channel: string, input: unknown) => Promise<unknown>): JiraIntegrationApi {
  async function call<M extends JiraMethod>(method: M, input: JiraRequest<M>): Promise<JiraResult<JiraData<M>>> {
    const request = jiraRequests[method].safeParse(input)
    if (!request.success) return ipcFail('E_INVALID_ARG', request.error.issues[0]?.message ?? 'Invalid Jira request.')
    let response: unknown
    try { response = await invoke(JIRA_IPC[method], request.data) }
    catch { return ipcFail(JIRA_MUTATING_METHODS.some((name) => name === method) ? 'E_UNKNOWN' : 'E_UNAVAILABLE', 'Jira native reply is unavailable. A mutation may already be admitted; read retained state and keep its original command identity before retrying.') }
    const envelope = z.object({ ok: z.boolean(), data: z.unknown().optional(), code: z.string().optional(), error: z.string().max(400).optional() }).safeParse(response)
    if (!envelope.success) return ipcFail('E_UPSTREAM', 'Jira native result did not match its response envelope.')
    if (!envelope.data.ok) {
      const code = envelope.data.code
      if (!code || !Object.values(IpcErrorCode).some((known) => known === code)) return ipcFail('E_UPSTREAM', 'Jira native failure omitted a recognized machine-readable code.')
      return ipcFail(code as IpcFail['code'], envelope.data.error ?? 'Jira native action failed.')
    }
    const data = jiraResults[method].safeParse(envelope.data.data)
    return data.success ? { ok: true, data: data.data as JiraData<M> } : ipcFail('E_UPSTREAM', 'Jira native result failed its feature schema.')
  }
  return {
    version: 1, context: (input) => call('context', input), projects: (input) => call('projects', input), selectProject: (input) => call('selectProject', input),
    snapshot: (input) => call('snapshot', input), discover: (input) => call('discover', input), bindAccount: (input) => call('bindAccount', input),
    savePlan: (input) => call('savePlan', input), planState: (input) => call('planState', input), catchUp: (input) => call('catchUp', input),
    previewApi: (input) => call('previewApi', input), previewCsv: (input) => call('previewCsv', input), startImport: (input) => call('startImport', input),
    history: (input) => call('history', input), jobDetail: (input) => call('jobDetail', input), cancel: (input) => call('cancel', input), resume: (input) => call('resume', input),
    rollback: (input) => call('rollback', input), resolveConflict: (input) => call('resolveConflict', input), reconcile: (input) => call('reconcile', input),
    localTasks: (input) => call('localTasks', input), receiver: (input) => call('receiver', input), cancelRead: (input) => call('cancelRead', input)
  }
}
