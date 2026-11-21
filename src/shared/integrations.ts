import { z } from 'zod'
import type { IpcFail } from './ipc-errors'
import type { JiraIssueDetail, JiraPagedSearchMeta, JiraTransition } from './types'

/** TPD-025: public integration contracts never include stored credentials. */
export const providerIdSchema = z.enum(['jira', 'github', 'gitlab', 'gitee', 'dingtalk', 'feishu', 'weknora'])
export type ProviderId = z.infer<typeof providerIdSchema>
export type IntegrationCategory = 'tasks' | 'repositories' | 'messaging' | 'knowledge'
export type Capability = 'task.search' | 'task.import' | 'task.comment' | 'task.transition' | 'repository.read' | 'notification.send' | 'knowledge.read' | 'knowledge.publish'
export interface ConfigField { key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string; defaultValue?: string; multiline?: boolean }
export interface AuthenticationMethod { id: 'basic' | 'token' | 'oauth2'; name: string; fields: ConfigField[]; oauth?: { registrationPath: string; redirectUri: string; scopes: string[] } }
export interface ProviderManifest { id: ProviderId; name: string; category: IntegrationCategory; description: string; capabilities: Capability[]; fields: ConfigField[]; instanceUrl?: string; authentication?: AuthenticationMethod[] }
export const GITLAB_OAUTH_REDIRECT_URI = 'http://127.0.0.1:17654/oauth/callback/gitlab'
export const JIRA_OAUTH_SCOPES = ['READ', 'WRITE'] as const
export const JIRA_OAUTH_CALLBACK_PATH = '/auth/jira/callback'
export const JIRA_OAUTH_REDIRECT_URI = 'http://127.0.0.1:17654/auth/jira/callback'
/** Native and renderer callers must agree on the exact supported callback routes. */
export function classifyJiraOAuthRedirectUri(value: string): 'local' | 'relay' | null {
  if (value === JIRA_OAUTH_REDIRECT_URI) return 'local'
  if (value.length > 2048 || !value.startsWith('https://') || /[\s\\?#@\u0000-\u001f\u007f]/.test(value)
    || value.slice(value.indexOf('/', 8)) !== JIRA_OAUTH_CALLBACK_PATH) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === JIRA_OAUTH_CALLBACK_PATH ? 'relay' : null
  } catch { return null }
}
export const GITLAB_OAUTH_SCOPES = ['read_api', 'read_user'] as const
const baseFields: ConfigField[] = [{ key: 'baseUrl', label: '实例地址', required: true, placeholder: 'https://…' }]
export const INTEGRATION_CATALOG: readonly ProviderManifest[] = [
  { id: 'weknora', name: 'WeKnora', category: 'knowledge', description: '项目知识检索与人工确认成果发布；不启用自动归档或规范同步。', capabilities: ['knowledge.read', 'knowledge.publish'], fields: [...baseFields, { key: 'apiKey', label: 'API Key', secret: true, required: true }] },
  { id: 'jira', name: 'Jira', category: 'tasks', description: '连接 Jira Server / Data Center，查询、导入并回写工单。', capabilities: ['task.search', 'task.import', 'task.comment', 'task.transition'], fields: [...baseFields, { key: 'jql', label: '默认 JQL', multiline: true }, { key: 'statusMap', label: '状态映射（JSON 对象）', placeholder: '{"处理中":"in_progress"}' }], authentication: [
    { id: 'token', name: '个人访问令牌（PAT）', fields: [{ key: 'token', label: '访问令牌（PAT）', secret: true, required: true }] },
    { id: 'oauth2', name: '浏览器授权登录', fields: [{ key: 'clientId', label: 'OAuth Client ID', required: true }, { key: 'clientSecret', label: 'OAuth Client Secret', secret: true, required: true }], oauth: { registrationPath: '/plugins/servlet/applinks/listApplicationLinks', redirectUri: JIRA_OAUTH_REDIRECT_URI, scopes: [...JIRA_OAUTH_SCOPES] } },
    { id: 'basic', name: '用户名和密码', fields: [{ key: 'user', label: '用户名', required: true }, { key: 'password', label: '密码', secret: true, required: true }] }
  ] },
  { id: 'github', name: 'GitHub', category: 'repositories', description: '查询仓库与 Pull Request，关联到本地工作项。', capabilities: ['repository.read'], fields: [{ key: 'baseUrl', label: 'API 地址', placeholder: 'https://api.github.com', defaultValue: 'https://api.github.com' }, { key: 'token', label: '访问令牌', secret: true, required: true }] },
  { id: 'gitlab', name: 'GitLab', category: 'repositories', description: '通过浏览器授权连接自建实例，查询项目与 Merge Request。', capabilities: ['repository.read'], fields: [...baseFields], authentication: [
    { id: 'oauth2', name: '浏览器授权登录', fields: [{ key: 'clientId', label: 'OAuth Application ID', required: true }], oauth: { registrationPath: '/-/user_settings/applications', redirectUri: GITLAB_OAUTH_REDIRECT_URI, scopes: [...GITLAB_OAUTH_SCOPES] } },
    { id: 'token', name: '个人访问令牌（PAT）', fields: [{ key: 'token', label: '访问令牌（PAT）', secret: true, required: true }] }
  ] },
  { id: 'gitee', name: 'Gitee', category: 'repositories', instanceUrl: 'https://gitee.com', description: '查询授权仓库与 Pull Request，并保留来源链接。', capabilities: ['repository.read'], fields: [{ key: 'token', label: '访问令牌', secret: true, required: true }] },
  { id: 'dingtalk', name: '钉钉', category: 'messaging', description: '通过群机器人手动发送工作项摘要，支持加签。', capabilities: ['notification.send'], fields: [{ key: 'webhook', label: '群机器人 Webhook', secret: true, required: true }, { key: 'signingSecret', label: '加签密钥（可选）', secret: true }] },
  { id: 'feishu', name: '飞书', category: 'messaging', description: '通过自定义群机器人手动发送工作项摘要，支持签名校验。', capabilities: ['notification.send'], fields: [{ key: 'webhook', label: '群机器人 Webhook', secret: true, required: true }, { key: 'signingSecret', label: '签名密钥（可选）', secret: true }] }
]
/** Missing methods use provider-dependent legacy defaults; new forms select explicitly. */
export function connectionAuthentication(provider: ProviderManifest, config: Record<string, string>): AuthenticationMethod | undefined {
  return provider.authentication?.find((method) => method.id === (config.authMethod || (provider.id === 'jira' ? 'basic' : 'token')))
}
export function connectionFields(provider: ProviderManifest, config: Record<string, string>): ConfigField[] {
  return [...provider.fields, ...(connectionAuthentication(provider, config)?.fields ?? [])]
}
export const secretPatchSchema = z.discriminatedUnion('op', [z.object({ op: z.literal('keep') }), z.object({ op: z.literal('clear') }), z.object({ op: z.literal('replace'), value: z.string().min(1).max(8192) })])
export const saveConnectionSchema = z.object({
  id: z.string().max(128).optional(), revision: z.number().int().positive().optional(), providerId: providerIdSchema,
  name: z.string().trim().min(1).max(100), enabled: z.boolean(),
  config: z.record(z.string().max(100), z.string().max(8192)), secrets: z.record(z.string().max(100), secretPatchSchema)
})
export type SaveConnectionInput = z.infer<typeof saveConnectionSchema>
export const integrationConnectionSchema = z.object({ id: z.string(), providerId: providerIdSchema, name: z.string(), enabled: z.boolean(), revision: z.number().int().positive(), config: z.record(z.string(), z.string()), hasSecrets: z.array(z.string()), legacy: z.boolean(), checkedAt: z.number().nullable(), check: z.enum(['unverified', 'authenticated', 'configured', 'failed']), detail: z.string() })
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>
export const projectContextSchema = z.object({ expectedRoot: z.string().min(1).max(4096) })
export type ProjectContext = z.infer<typeof projectContextSchema>
export const connectionRequestSchema = z.object({ connectionId: z.string().min(1).max(128), connectionRevision: z.number().int().positive() })
export type ConnectionRequest = z.infer<typeof connectionRequestSchema>
export const authorizationRequestSchema = connectionRequestSchema.extend({ requestId: z.string().uuid() })
export type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>
export const knowledgeBindingSchema = z.object({ defaultCollectionIds: z.array(z.string().trim().min(1).max(256)).max(20).refine((ids) => new Set(ids).size === ids.length, '知识库不能重复') })
export const saveBindingSchema = projectContextSchema.extend({ id: z.string().optional(), revision: z.number().int().positive().optional(), connectionId: z.string().min(1), connectionRevision: z.number().int().positive(), label: z.string().trim().min(1).max(100), scope: z.string().trim().max(4000), enabled: z.boolean(), knowledge: knowledgeBindingSchema.optional() })
export type SaveBindingInput = z.infer<typeof saveBindingSchema>
export const integrationBindingSchema = z.object({ id: z.string(), root: z.string(), connectionId: z.string(), revision: z.number().int().positive(), label: z.string(), scope: z.string(), enabled: z.boolean(), knowledge: knowledgeBindingSchema.optional() })
export type IntegrationBinding = z.infer<typeof integrationBindingSchema>
export const bindingRequestSchema = projectContextSchema.extend({ bindingId: z.string().min(1), bindingRevision: z.number().int().positive(), connectionRevision: z.number().int().positive() })
export type BindingRequest = z.infer<typeof bindingRequestSchema>
export const pageRequestSchema = connectionRequestSchema.merge(projectContextSchema).extend({ page: z.number().int().min(1).max(200).default(1), query: z.string().max(300).default('') })
export type RepositoryRequest = z.input<typeof pageRequestSchema>
export interface RemoteRepository { id: string; name: string; fullName: string; url: string }
export const externalObjectSchema = z.object({ providerId: providerIdSchema, instanceId: z.string().min(1).max(256), repository: z.string().min(1).max(500), kind: z.literal('pull_request'), id: z.string().min(1).max(128), number: z.number().int().positive(), title: z.string().max(1000), state: z.string().max(100), url: z.string().url().max(3000), sourceBranch: z.string().max(500), targetBranch: z.string().max(500) })
export type ExternalObject = z.infer<typeof externalObjectSchema>
export interface PageResult<T> { items: T[]; page: number; hasMore: boolean }
export interface ExternalLink { id: number; object: ExternalObject; createdAt: number }
export const deliveryReceiptSchema = z.object({ requestId: z.string(), connectionId: z.string(), connectionRevision: z.number(), bindingId: z.string(), taskRef: z.string(), destination: z.string(), createdAt: z.number(), state: z.enum(['pending', 'delivered', 'failed', 'uncertain']), detail: z.string() })
export type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>
export interface IntegrationSnapshot { catalog: readonly ProviderManifest[]; authorizationProviders: ProviderId[]; connections: IntegrationConnection[]; bindings: IntegrationBinding[]; receipts: DeliveryReceipt[]; root: string | null }
export type IntegrationResult<T> = { ok: true; data: T } | IpcFail
export interface JiraContext extends BindingRequest { name: string; baseUrl: string; instanceId: string; jql: string; statusMap: Record<string, string>; legacy: boolean }
export interface JiraSearchData { issues: JiraIssueDetail[]; total: number; meta: JiraPagedSearchMeta }
export interface NotificationPreview { title: string; body: string; taskRef: string; destination: string }
export interface IntegrationApi {
  onChanged: (callback: () => void) => () => void
  cancelRead: (requestId: string) => Promise<IntegrationResult<null>>
  list: () => Promise<IntegrationResult<IntegrationSnapshot>>
  saveConnection: (input: SaveConnectionInput) => Promise<IntegrationResult<IntegrationConnection>>
  removeConnection: (input: ConnectionRequest) => Promise<IntegrationResult<null>>
  inspect: (input: ConnectionRequest) => Promise<IntegrationResult<IntegrationConnection>>
  authorize: (input: AuthorizationRequest) => Promise<IntegrationResult<IntegrationConnection>>
  cancelAuthorization: (requestId: string) => Promise<IntegrationResult<null>>
  saveBinding: (input: SaveBindingInput) => Promise<IntegrationResult<IntegrationBinding>>
  removeBinding: (input: BindingRequest) => Promise<IntegrationResult<null>>
  repositories: (input: RepositoryRequest) => Promise<IntegrationResult<PageResult<RemoteRepository>>>
  pullRequests: (input: BindingRequest & { page?: number }) => Promise<IntegrationResult<PageResult<ExternalObject>>>
  links: (input: ProjectContext & { taskDir: string }) => Promise<IntegrationResult<ExternalLink[]>>
  attach: (input: BindingRequest & { taskDir: string; object: ExternalObject }) => Promise<IntegrationResult<ExternalLink[]>>
  unlink: (input: ProjectContext & { taskDir: string; linkId: number }) => Promise<IntegrationResult<ExternalLink[]>>
  previewNotification: (input: BindingRequest & { taskDir: string }) => Promise<IntegrationResult<NotificationPreview>>
  sendNotification: (input: BindingRequest & { taskDir: string; requestId: string; preview: NotificationPreview }) => Promise<IntegrationResult<DeliveryReceipt>>
  jiraContext: (input: ProjectContext) => Promise<IntegrationResult<JiraContext | null>>
  jiraSearch: (input: BindingRequest & { jql: string; requestId: string }) => Promise<IntegrationResult<JiraSearchData>>
  jiraTransitions: (input: BindingRequest & { key: string }) => Promise<IntegrationResult<JiraTransition[]>>
  jiraTransition: (input: BindingRequest & { key: string; transitionId: string; expectedToStatus: string }) => Promise<IntegrationResult<{ detail: string }>>
  jiraComment: (input: BindingRequest & { key: string; body: string }) => Promise<IntegrationResult<null>>
}
