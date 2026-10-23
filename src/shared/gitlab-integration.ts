import { z } from 'zod'
import { IpcErrorCode, ipcFail, type IpcFail } from './ipc-errors'
import { integrationAccountSchema, integrationJobSchema, integrationSourceSchema, syncPlanSchema } from './integration-work'

export const GITLAB_WORKSPACE_VERSION = 1 as const
export const GITLAB_WRITE_SCOPES = ['api'] as const
export const GITLAB_PAGE_SIZE = 30
const id = z.string().min(1).max(128)
const numeric = z.string().regex(/^[1-9]\d*$/).max(20)
const revision = z.number().int().positive().safe()
const date = z.string().datetime({ offset: true })
const url = z.string().url().max(4096).refine((value) => { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash }, 'Invalid source URL')
export const gitlabContextSchema = z.object({ expectedRoot: z.string().min(1).max(4096), connectionId: id, connectionRevision: revision, requestId: z.string().uuid().optional() }).strict()
export const gitlabOwnerSchema = z.object({ workspaceId: id, grantId: z.string().uuid(), grantRevision: revision }).strict()
export const gitlabUserSchema = z.object({ id: numeric, username: z.string().min(1).max(256), name: z.string().max(256), state: z.string().max(40) }).strict()
export const gitlabProjectSchema = z.object({ id: numeric, path: z.string().min(1).max(1024), name: z.string().min(1).max(256), url, issuesEnabled: z.boolean(), accessLevel: z.number().int().nonnegative().nullable() }).strict()
export const gitlabIssueIdentitySchema = z.object({ instanceId: id, projectId: numeric, id: numeric, iid: z.number().int().positive().safe() }).strict()
export const gitlabFieldsSchema = z.object({ title: z.string().min(1).max(1000), description: z.string().max(100000), state: z.enum(['opened', 'closed']), labels: z.array(z.string().max(255)).max(100), assignees: z.array(numeric).max(20) }).strict()
export const gitlabIssueSchema = gitlabIssueIdentitySchema.extend({ kind: z.literal('issue'), url, updatedAt: date, fields: gitlabFieldsSchema, references: z.object({ issueType: z.string().max(80), milestoneId: numeric.nullable(), weight: z.number().nullable(), dueDate: z.string().nullable(), parent: z.string().nullable() }).strict() }).strict()
export const gitlabNoteSchema = z.object({ id: numeric, body: z.string().max(100000), authorId: numeric, createdAt: date, updatedAt: date, system: z.boolean() }).strict()
export const gitlabFieldSchema = z.enum(['title', 'description', 'state', 'labels', 'assignees'])
export const gitlabMappingSchema = z.object({ revision, fields: z.array(gitlabFieldSchema).min(1).max(5), statuses: z.array(z.object({ remote: z.enum(['opened', 'closed']), local: z.string().min(1).max(80) }).strict()).max(2), members: z.array(z.object({ remote: numeric, local: id }).strict()).max(200), comments: z.boolean() }).strict().superRefine((mapping, ctx) => {
  for (const values of [mapping.fields, mapping.statuses.map((v) => v.remote), mapping.statuses.map((v) => v.local), mapping.members.map((v) => v.remote), mapping.members.map((v) => v.local)]) {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mapping must be unambiguous; duplicate source or target' })
  }
  if (mapping.fields.includes('state') && mapping.statuses.length !== 2) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Both opened and closed require a status mapping' })
})
export const gitlabBindingSchema = z.object({ plan: syncPlanSchema, owner: gitlabOwnerSchema, project: gitlabProjectSchema, mapping: gitlabMappingSchema, createMissing: z.boolean(), history: z.boolean(), lastSuccessAt: date.nullable(), lastFullScanAt: date.nullable(), continuation: z.string().max(1024).nullable(), lastError: z.string().max(400).nullable(), nextPollAt: z.number().int().nonnegative(), failures: z.number().int().nonnegative(), hook: z.object({ state: z.enum(['absent', 'pending', 'registered', 'receiving', 'failed', 'unknown']), remoteId: numeric.nullable(), lastEventAt: date.nullable(), detail: z.string().max(400) }).strict() }).strict()
export const gitlabPermissionSchema = z.object({ read: z.enum(['verified', 'denied', 'unknown']), write: z.enum(['granted', 'denied', 'unknown']), hooks: z.enum(['granted', 'denied', 'unknown']), scopes: z.array(z.string().max(80)).max(30), evidence: z.string().max(400), user: gitlabUserSchema.nullable(), checkedAt: date }).strict()
export const gitlabConflictSchema = z.object({ id: id, bindingId: id, issue: gitlabIssueIdentitySchema, taskRef: z.string().min(1).max(1000), field: gitlabFieldSchema, base: z.unknown(), local: z.unknown(), remote: z.unknown(), state: z.enum(['open', 'resolved']), resolution: z.enum(['local', 'remote']).nullable(), createdAt: date }).strict()
export const gitlabPreviewSchema = z.object({ id: z.string().uuid(), source: integrationSourceSchema, bindingRevision: revision, digest: z.string().length(64), count: z.number().int().nonnegative(), hasMore: z.boolean(), createdAt: date, expiresAt: date, issues: z.array(gitlabIssueSchema).max(100), warnings: z.array(z.string().max(400)).max(20) }).strict()
export const gitlabSnapshotSchema = z.object({ nativeVersion: z.literal(1), accounts: z.array(integrationAccountSchema).max(100), bindings: z.array(gitlabBindingSchema).max(100), conflicts: z.array(gitlabConflictSchema).max(100), permission: gitlabPermissionSchema.nullable(), localMembers: z.array(z.object({ id, name: z.string().max(256) }).strict()).max(200), localStatuses: z.array(z.object({ id, name: z.string().max(80) }).strict()).max(100), receiverAvailable: z.boolean() }).strict()
const bound = gitlabContextSchema.extend({ bindingId: id, bindingRevision: revision })
export const gitlabRequests = {
  snapshot: gitlabContextSchema,
  projects: gitlabContextSchema.extend({ page: z.number().int().min(1).max(200), query: z.string().max(200) }).strict(),
  members: gitlabContextSchema.extend({ projectId: numeric, page: z.number().int().min(1).max(200) }).strict(),
  inspect: gitlabContextSchema.extend({ projectId: numeric.optional() }).strict(),
  linkAccount: gitlabContextSchema,
  unlinkAccount: gitlabContextSchema.extend({ accountId: id, revision }).strict(),
  savePlan: gitlabContextSchema.extend({ bindingId: id.optional(), bindingRevision: revision.optional(), projectId: numeric, direction: z.enum(['inbound', 'bidirectional']), mapping: gitlabMappingSchema, createMissing: z.boolean(), history: z.boolean(), transport: z.enum(['polling', 'webhook']) }).strict(),
  setPlanState: bound.extend({ state: z.enum(['active', 'paused']) }).strict(),
  previewImport: bound.extend({ page: z.number().int().min(1).max(200), state: z.enum(['all', 'opened', 'closed']) }).strict(),
  startImport: bound.extend({ commandId: z.string().uuid(), previewId: z.string().uuid(), previewDigest: z.string().length(64) }).strict(),
  catchUp: bound.extend({ commandId: z.string().uuid() }).strict(),
  jobs: gitlabContextSchema.extend({ after: z.string().uuid().nullable() }).strict(),
  cancelJob: gitlabContextSchema.extend({ jobId: z.string().uuid(), revision, commandId: z.string().uuid() }).strict(),
  reconcileJob: gitlabContextSchema.extend({ jobId: z.string().uuid(), revision }).strict(),
  resolveConflict: bound.extend({ conflictId: id, resolution: z.enum(['local', 'remote']) }).strict(),
  authorizeWrites: gitlabContextSchema.extend({ requestId: z.string().uuid(), acknowledgeApiScope: z.literal(true) }).strict(),
  cancelAuthorization: z.object({ requestId: z.string().uuid() }).strict(),
  cancelRead: z.object({ requestId: z.string().uuid() }).strict(),
  recoverHook: bound.extend({ commandId: z.string().uuid(), acknowledgeRegistration: z.literal(true) }).strict(),
  createIssue: bound.extend({ commandId: z.string().uuid(), taskRef: z.string().min(1).max(1000), localRevision: z.string().length(64), acknowledgeWrite: z.literal(true) }).strict(),
  addComment: bound.extend({ commandId: z.string().uuid(), issueId: numeric, body: z.string().trim().min(1).max(10000), acknowledgeWrite: z.literal(true) }).strict(),
  issueDetail: bound.extend({ iid: z.number().int().positive().safe(), notesPage: z.number().int().min(1).max(200) }).strict(),
  localTasks: gitlabContextSchema.extend({ page: z.number().int().min(1).max(200) }).strict()
} as const
const jobPage = z.object({ items: z.array(integrationJobSchema).max(50), next: z.string().uuid().nullable(), failures: z.array(z.object({ jobId: z.string().uuid(), issueId: numeric, detail: z.string().max(400), at: date }).strict()).max(100), hasMoreFailures: z.boolean() }).strict()
export const gitlabResults = {
  snapshot: gitlabSnapshotSchema,
  projects: z.object({ items: z.array(gitlabProjectSchema).max(30), hasMore: z.boolean() }),
  members: z.object({ items: z.array(gitlabUserSchema).max(30), hasMore: z.boolean() }),
  inspect: gitlabPermissionSchema, linkAccount: integrationAccountSchema, unlinkAccount: z.null(),
  savePlan: gitlabBindingSchema, setPlanState: gitlabBindingSchema, previewImport: gitlabPreviewSchema,
  startImport: integrationJobSchema, catchUp: integrationJobSchema, jobs: jobPage, cancelJob: integrationJobSchema,
  reconcileJob: z.object({ resolved: z.boolean(), evidenceRef: z.string().nullable() }), resolveConflict: z.null(),
  authorizeWrites: z.object({ connectionRevision: revision, detail: z.string().max(400) }), cancelAuthorization: z.null(), cancelRead: z.null(), recoverHook: integrationJobSchema,
  createIssue: integrationJobSchema, addComment: integrationJobSchema,
  issueDetail: z.object({ issue: gitlabIssueSchema, notes: z.array(gitlabNoteSchema).max(30), hasMore: z.boolean() }).strict(),
  localTasks: z.object({ items: z.array(z.object({ taskRef: z.string().max(1000), title: z.string().max(1000), revision: z.string().length(64), hasSource: z.boolean() }).strict()).max(30), hasMore: z.boolean() }).strict()
} as const
export type GitlabMethod = keyof typeof gitlabRequests
export type GitlabInput<M extends GitlabMethod> = z.infer<(typeof gitlabRequests)[M]>
export type GitlabOutput<M extends GitlabMethod> = z.infer<(typeof gitlabResults)[M]>
export type GitlabResult<T> = { ok: true; data: T } | IpcFail
export type GitlabWorkspaceApi = { version: 1 } & { [M in GitlabMethod]: (input: GitlabInput<M>) => Promise<GitlabResult<GitlabOutput<M>>> }
/** Main must add these literal channels to ipc-channels before registering. */
export const GITLAB_IPC = {
  snapshot: 'gitlabIntegration:snapshot', projects: 'gitlabIntegration:projects', members: 'gitlabIntegration:members', inspect: 'gitlabIntegration:inspect', linkAccount: 'gitlabIntegration:linkAccount', unlinkAccount: 'gitlabIntegration:unlinkAccount', savePlan: 'gitlabIntegration:savePlan', setPlanState: 'gitlabIntegration:setPlanState', previewImport: 'gitlabIntegration:previewImport', startImport: 'gitlabIntegration:startImport', catchUp: 'gitlabIntegration:catchUp', jobs: 'gitlabIntegration:jobs', cancelJob: 'gitlabIntegration:cancelJob', reconcileJob: 'gitlabIntegration:reconcileJob', resolveConflict: 'gitlabIntegration:resolveConflict', authorizeWrites: 'gitlabIntegration:authorizeWrites', cancelAuthorization: 'gitlabIntegration:cancelAuthorization', cancelRead: 'gitlabIntegration:cancelRead', recoverHook: 'gitlabIntegration:recoverHook', createIssue: 'gitlabIntegration:createIssue', addComment: 'gitlabIntegration:addComment', issueDetail: 'gitlabIntegration:issueDetail', localTasks: 'gitlabIntegration:localTasks'
} as const satisfies Record<GitlabMethod, string>
/** Central protocol owner adopts these literal method/schema pairs. Authorization
 * UI/cancellation stay GUI-native; credential commit uses its native broker. */
export const GITLAB_DAEMON = {
  authorizeWrites: 'gitlab.workspace.authorizeWrites',
  snapshot: 'gitlab.workspace.snapshot', projects: 'gitlab.workspace.projects', members: 'gitlab.workspace.members', inspect: 'gitlab.workspace.inspect',
  linkAccount: 'gitlab.workspace.linkAccount', unlinkAccount: 'gitlab.workspace.unlinkAccount', savePlan: 'gitlab.workspace.savePlan', setPlanState: 'gitlab.workspace.setPlanState',
  previewImport: 'gitlab.workspace.previewImport', startImport: 'gitlab.workspace.startImport', catchUp: 'gitlab.workspace.catchUp', jobs: 'gitlab.workspace.jobs',
  cancelJob: 'gitlab.workspace.cancelJob', reconcileJob: 'gitlab.workspace.reconcileJob', resolveConflict: 'gitlab.workspace.resolveConflict', recoverHook: 'gitlab.workspace.recoverHook',
  createIssue: 'gitlab.workspace.createIssue', addComment: 'gitlab.workspace.addComment', issueDetail: 'gitlab.workspace.issueDetail', localTasks: 'gitlab.workspace.localTasks'
} as const satisfies Record<Exclude<GitlabMethod, 'cancelAuthorization' | 'cancelRead'>, string>
export function hasGitlabWorkspaceApi(value: unknown): value is GitlabWorkspaceApi {
  if (!value || typeof value !== 'object') return false
  const api = value as Record<string, unknown>
  return api.version === GITLAB_WORKSPACE_VERSION && Object.keys(GITLAB_IPC).every((method) => typeof api[method] === 'function')
}
/** Preload installs this as window.trellis.gitlabWorkspace. The returned object
 * exposes only these named methods, never the injected invoke function. */
export function createGitlabWorkspaceBridge(invoke: (channel: string, input: unknown) => Promise<unknown>): GitlabWorkspaceApi {
  async function call<M extends GitlabMethod>(method: M, input: GitlabInput<M>): Promise<GitlabResult<GitlabOutput<M>>> {
    const request = gitlabRequests[method].parse(input)
    let value: unknown
    try { value = await invoke(GITLAB_IPC[method], request) }
    catch (error) {
      if (error instanceof Error && /No handler registered|handler.*not.*registered/i.test(error.message)) return ipcFail(IpcErrorCode.Unavailable, '当前主进程尚未加载 GitLab Issues 接口，请完整重启应用。')
      const reads: readonly GitlabMethod[] = ['snapshot', 'projects', 'members', 'jobs', 'issueDetail', 'localTasks', 'cancelRead', 'cancelAuthorization']
      return ipcFail(reads.includes(method) ? IpcErrorCode.Unavailable : IpcErrorCode.Unknown, reads.includes(method) ? 'GitLab 后台连接不可用，请检查后台服务后重试读取。' : 'GitLab 后台响应中断；请查看原作业或配置结果，勿重复提交未知写入。')
    }
    const failure = z.object({ ok: z.literal(false), code: z.nativeEnum(IpcErrorCode), error: z.string() }).safeParse(value)
    if (failure.success) return failure.data
    const success = z.object({ ok: z.literal(true), data: z.unknown() }).parse(value)
    return { ok: true, data: gitlabResults[method].parse(success.data) as GitlabOutput<M> }
  }
  return { version: 1, snapshot: (i) => call('snapshot', i), projects: (i) => call('projects', i), members: (i) => call('members', i), inspect: (i) => call('inspect', i), linkAccount: (i) => call('linkAccount', i), unlinkAccount: (i) => call('unlinkAccount', i), savePlan: (i) => call('savePlan', i), setPlanState: (i) => call('setPlanState', i), previewImport: (i) => call('previewImport', i), startImport: (i) => call('startImport', i), catchUp: (i) => call('catchUp', i), jobs: (i) => call('jobs', i), cancelJob: (i) => call('cancelJob', i), reconcileJob: (i) => call('reconcileJob', i), resolveConflict: (i) => call('resolveConflict', i), authorizeWrites: (i) => call('authorizeWrites', i), cancelAuthorization: (i) => call('cancelAuthorization', i), cancelRead: (i) => call('cancelRead', i), recoverHook: (i) => call('recoverHook', i), createIssue: (i) => call('createIssue', i), addComment: (i) => call('addComment', i), issueDetail: (i) => call('issueDetail', i), localTasks: (i) => call('localTasks', i) }
}
export type GitlabIssue = z.infer<typeof gitlabIssueSchema>
export type GitlabFields = z.infer<typeof gitlabFieldsSchema>
export type GitlabField = z.infer<typeof gitlabFieldSchema>
export type GitlabMapping = z.infer<typeof gitlabMappingSchema>
export type GitlabBinding = z.infer<typeof gitlabBindingSchema>
export type GitlabUser = z.infer<typeof gitlabUserSchema>
export type GitlabProject = z.infer<typeof gitlabProjectSchema>
export type GitlabPermission = z.infer<typeof gitlabPermissionSchema>
export type GitlabPreview = z.infer<typeof gitlabPreviewSchema>
export type GitlabConflict = z.infer<typeof gitlabConflictSchema>
export type GitlabNote = z.infer<typeof gitlabNoteSchema>
