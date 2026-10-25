import { z } from 'zod'
import { runtimeWireSchema } from './daemon-runtime'
import { IpcErrorCode } from './ipc-errors'
import {
  authorizationRequestSchema, bindingRequestSchema, connectionRequestSchema, deliveryReceiptSchema,
  externalObjectSchema, integrationBindingSchema, integrationConnectionSchema, pageRequestSchema,
  projectContextSchema, providerIdSchema, saveBindingSchema, saveConnectionSchema
} from './integrations'

/** Native-only compatibility facade. The existing preload API remains feature-specific. */
export const integrationNativeRequests = { 'integration.execute': runtimeWireSchema } as const
export const integrationNativeResults = { 'integration.execute': runtimeWireSchema } as const
export const integrationNativeMutations = ['integration.execute'] as const

const task = projectContextSchema.extend({ taskDir: z.string().min(1).max(4096) })
const boundTask = bindingRequestSchema.extend({ taskDir: z.string().min(1).max(4096) })
const issue = bindingRequestSchema.extend({ key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*-\d+$/) })
const cancellation = z.object({ requestId: z.string().uuid() })
const preview = z.object({ title: z.string().max(200), body: z.string().max(2000), taskRef: z.string().max(1000), destination: z.string().max(100) })

/** Native-only team identity and profile owner; neither grants a local workspace. */
export const verifiedGitlabIdentitySchema = z.object({
  provider: z.literal('gitlab'), issuer: z.string().url().max(2048), subject: z.string().min(1).max(1024),
  baseUrl: z.string().url().max(2048), clientId: z.string().trim().min(1).max(1024),
  username: z.string().min(1).max(200).optional()
})
export const teamGitlabOwnerSchema = z.object({
  connectionId: z.string().min(1).max(128), origin: z.string().url().max(2048),
  ownerId: z.string().min(1).max(256), deviceId: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256), clientRevision: z.number().int().nonnegative().safe()
})
export const teamGitlabStatusSchema = z.object({
  connectionId: z.string().nullable(), state: z.enum(['connected', 'authorization-required', 'mismatch', 'failed']), detail: z.string()
})
export const teamGitlabConnectSchema = z.object({ requestId: z.string().uuid(), identity: verifiedGitlabIdentitySchema, owner: teamGitlabOwnerSchema, retry: z.boolean() }).strict()

export const legacyIntegrationRequests = {
  list: z.object({}).strict(),
  saveConnection: saveConnectionSchema,
  removeConnection: connectionRequestSchema,
  inspect: connectionRequestSchema,
  authorize: authorizationRequestSchema,
  cancelAuthorization: cancellation,
  cancelRead: cancellation,
  teamGitlabConnect: teamGitlabConnectSchema,
  teamGitlabCheck: cancellation,
  teamGitlabConfirm: cancellation.extend({ challengeId: z.string().uuid() }).strict(),
  saveBinding: saveBindingSchema,
  removeBinding: bindingRequestSchema,
  repositories: pageRequestSchema,
  pullRequests: bindingRequestSchema.extend({ page: z.number().int().min(1).max(200).default(1) }),
  links: task,
  attach: boundTask.extend({ object: externalObjectSchema }),
  unlink: task.extend({ linkId: z.number().int().positive() }),
  previewNotification: boundTask,
  sendNotification: boundTask.extend({ requestId: z.string().uuid(), preview }),
  jiraContext: projectContextSchema,
  jiraSearch: bindingRequestSchema.extend({ jql: z.string().max(4000), requestId: z.string().uuid() }),
  jiraTransitions: issue,
  jiraTransition: issue.extend({ transitionId: z.string().min(1).max(100), expectedToStatus: z.string().min(1).max(200) }),
  jiraComment: issue.extend({ body: z.string().trim().min(1).max(10000) })
} as const
export type LegacyIntegrationOperation = keyof typeof legacyIntegrationRequests
export type LegacyIntegrationInput<M extends LegacyIntegrationOperation> = z.input<(typeof legacyIntegrationRequests)[M]>

function operation<M extends LegacyIntegrationOperation>(method: M) {
  return z.object({ ownerId: z.string().uuid(), operation: z.literal(method), input: legacyIntegrationRequests[method] }).strict()
}
/** An explicit operation allowlist; no object-path lookup or provider reflection. */
export const legacyIntegrationRequestSchema = z.discriminatedUnion('operation', [
  operation('list'), operation('saveConnection'), operation('removeConnection'), operation('inspect'),
  operation('authorize'), operation('cancelAuthorization'), operation('cancelRead'), operation('saveBinding'),
  operation('teamGitlabConnect'), operation('teamGitlabCheck'), operation('teamGitlabConfirm'),
  operation('removeBinding'), operation('repositories'), operation('pullRequests'), operation('links'),
  operation('attach'), operation('unlink'), operation('previewNotification'), operation('sendNotification'),
  operation('jiraContext'), operation('jiraSearch'), operation('jiraTransitions'), operation('jiraTransition'), operation('jiraComment')
])
export type LegacyIntegrationRequest = z.infer<typeof legacyIntegrationRequestSchema>

/** The outer method always carries a command ID. Only these business operations
 * need write-ahead receipts; inventory and cancellation must not fill that ledger. */
export const LEGACY_INTEGRATION_MUTATIONS: readonly LegacyIntegrationOperation[] = [
  'authorize', 'teamGitlabConnect', 'saveConnection', 'removeConnection', 'inspect', 'saveBinding', 'removeBinding',
  'attach', 'unlink', 'sendNotification', 'jiraTransition', 'jiraComment'
]
const field = z.object({ key: z.string(), label: z.string(), secret: z.boolean().optional(), required: z.boolean().optional(), placeholder: z.string().optional(), defaultValue: z.string().optional(), multiline: z.boolean().optional() })
const authentication = z.object({ id: z.enum(['token', 'oauth2']), name: z.string(), fields: z.array(field), oauth: z.object({ registrationPath: z.string(), redirectUri: z.string(), scopes: z.array(z.string()) }).optional() })
const manifest = z.object({ id: providerIdSchema, name: z.string(), category: z.enum(['tasks', 'repositories', 'messaging', 'knowledge']), description: z.string(), capabilities: z.array(z.enum(['task.search', 'task.import', 'task.comment', 'task.transition', 'repository.read', 'notification.send', 'knowledge.read', 'knowledge.publish'])), fields: z.array(field), instanceUrl: z.string().optional(), authentication: z.array(authentication).optional() })
const repository = z.object({ id: z.string(), name: z.string(), fullName: z.string(), url: z.string() })
const links = z.array(z.object({ id: z.number().int().positive(), object: externalObjectSchema, createdAt: z.number() })).max(100)
const jiraContext = bindingRequestSchema.extend({ name: z.string(), baseUrl: z.string(), instanceId: z.string(), jql: z.string(), statusMap: z.record(z.string(), z.string()), legacy: z.boolean() })
const jiraIssue = z.object({
  key: z.string(), summary: z.string(), status: z.string(), statusCategory: z.string(), priority: z.string(), issueType: z.string(), updated: z.string(), url: z.string(), assignee: z.string(), fixVersions: z.array(z.string()),
  issueId: z.number().int().nullable(), issueTypeId: z.string(), issueTypeName: z.string(), fixVersionDetails: z.array(z.object({ id: z.string(), name: z.string() })), description: z.string().nullable(), updatedAtMs: z.number().nullable()
})
const searchMeta = z.object({ jql: z.string(), paginationKind: z.enum(['startAt_total', 'nextPageToken', 'unknown']), pagesFetched: z.number(), serverTotal: z.number().nullable(), retrievedCount: z.number(), duplicateCount: z.number(), sample: z.boolean(), incompleteReason: z.enum(['max_pages', 'page_failed', 'cancelled']).nullable(), cancelled: z.boolean(), changedDuringCollection: z.boolean().nullable(), startedAtMs: z.number(), endedAtMs: z.number() })
export const legacyIntegrationResults = {
  list: z.object({ catalog: z.array(manifest), authorizationProviders: z.array(providerIdSchema), connections: z.array(integrationConnectionSchema), bindings: z.array(integrationBindingSchema), receipts: z.array(deliveryReceiptSchema), root: z.string().nullable() }),
  saveConnection: integrationConnectionSchema, removeConnection: z.null(), inspect: integrationConnectionSchema,
  authorize: integrationConnectionSchema, cancelAuthorization: z.null(), cancelRead: z.null(),
  teamGitlabConnect: z.object({ status: teamGitlabStatusSchema, revision: z.number().int().positive().nullable() }).strict(),
  teamGitlabCheck: z.object({ challengeId: z.string().uuid().nullable(), done: z.boolean() }).strict(),
  teamGitlabConfirm: z.null(),
  saveBinding: integrationBindingSchema, removeBinding: z.null(),
  repositories: z.object({ items: z.array(repository), page: z.number(), hasMore: z.boolean() }),
  pullRequests: z.object({ items: z.array(externalObjectSchema), page: z.number(), hasMore: z.boolean() }),
  links, attach: links, unlink: links, previewNotification: preview, sendNotification: deliveryReceiptSchema,
  jiraContext: jiraContext.nullable(), jiraSearch: z.object({ issues: z.array(jiraIssue), total: z.number(), meta: searchMeta }),
  jiraTransitions: z.array(z.object({ id: z.string(), name: z.string(), toStatusName: z.string().optional() })),
  jiraTransition: z.object({ detail: z.string() }), jiraComment: z.null()
} as const
export type LegacyIntegrationData<M extends LegacyIntegrationOperation> = z.infer<(typeof legacyIntegrationResults)[M]>
export const legacyIntegrationFailureSchema = z.object({ ok: z.literal(false), code: z.enum(Object.values(IpcErrorCode)), error: z.string() }).strict()
export const legacyIntegrationResultSchema = z.union([z.object({ ok: z.literal(true), data: z.unknown() }).strict(), legacyIntegrationFailureSchema])
