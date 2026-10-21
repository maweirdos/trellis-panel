import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BindingRequest, ConnectionRequest, DeliveryReceipt, IntegrationBinding, IntegrationConnection, IntegrationSnapshot, JiraContext, NotificationPreview, SaveBindingInput, SaveConnectionInput } from '../../../shared/integrations'
import { connectionFields, externalObjectSchema } from '../../../shared/integrations'
import type { ExternalLink, ExternalObject } from '../../../shared/integrations'
import { getSnapshot, getProjectRoot } from '../../state'
import { getSettings, setSettings } from '../store'
import { clearGitlabTokenCache, clearGitlabStatusCache } from '../gitlab'
import { jiraInstanceIdFor } from '../jira-instance'
import { LocalControlStore, localRuntimeDirOf, workspaceIdForRoot } from '../local-task'
import { taskRefFor, toRepoRelativeDir } from '../task-identity'
import { integrationRegistry } from './providers'
import { protectSecret, revealSecret } from './credentials'
import { jiraConfig, legacyConnections, resolveLegacy } from './legacy'
import { readIntegrationState, updateIntegrationState, type StoredConnection } from './repository'
import { IntegrationError, type ResolvedConnection } from './types'
import { remoteUrl } from './transport'

export function canonicalRoot(root: string): string { const normalized = resolve(root); return process.platform === 'win32' ? normalized.toLowerCase() : normalized }
export function requireProject(expectedRoot: string): string {
  const root = getProjectRoot()
  if (!root || canonicalRoot(root) !== canonicalRoot(expectedRoot)) throw new IntegrationError('项目已切换，请在当前项目重新操作', 'conflict')
  return root
}
function toPublic(c: StoredConnection): IntegrationConnection {
  return { id: c.id, providerId: c.providerId, name: c.name, enabled: c.enabled, revision: c.revision, config: c.config, hasSecrets: Object.keys(c.secrets), legacy: false, checkedAt: c.checkedAt, check: c.check, detail: c.detail }
}
export function integrationSnapshot(): IntegrationSnapshot {
  const state = readIntegrationState()
  const root = getProjectRoot()
  return { catalog: integrationRegistry.catalog(), authorizationProviders: integrationRegistry.catalog().filter((manifest) => integrationRegistry.get(manifest.id).authorization).map((manifest) => manifest.id), connections: [...legacyConnections(), ...state.connections.filter((c) => !c.deleted).map(toPublic)], bindings: root ? state.bindings.filter((b) => b.root === canonicalRoot(root)) : [], receipts: state.receipts.filter((receipt) => state.bindings.some((b) => b.id === receipt.bindingId && root && b.root === canonicalRoot(root))).map((r): DeliveryReceipt => r.state === 'pending' ? { ...r, state: 'uncertain', detail: '上次发送尚未取得确定结果，请先在目标群核实' } : r), root }
}
export function resolveConnection(input: ConnectionRequest, allowDisabled = false): ResolvedConnection {
  const legacy = legacyConnections().find((c) => c.id === input.connectionId)
  const stored = legacy ? null : readIntegrationState().connections.find((c) => c.id === input.connectionId && !c.deleted)
  const publicConnection = legacy ?? (stored ? toPublic(stored) : null)
  if (!publicConnection) throw new IntegrationError('连接不存在', 'invalid')
  if (publicConnection.revision !== input.connectionRevision) throw new IntegrationError('连接配置已更新，请刷新后重试', 'conflict')
  if (!allowDisabled && !publicConnection.enabled) throw new IntegrationError('连接已停用', 'denied')
  if (legacy) return resolveLegacy(legacy)
  if (!stored) throw new IntegrationError('连接不存在')
  return { public: publicConnection, secrets: Object.fromEntries(Object.entries(stored.secrets).map(([key, value]) => [key, revealSecret(value)])), instanceId: stored.providerId === 'jira' ? jiraInstanceIdFor(stored.config.baseUrl, stored.config.user) : `${stored.providerId}:${stored.config.baseUrl || integrationRegistry.get(stored.providerId).manifest.instanceUrl || stored.id}` }
}
function normalizedConfig(input: SaveConnectionInput, legacy: boolean): Record<string, string> {
  const manifest = integrationRegistry.get(input.providerId).manifest
  if (!legacy && manifest.authentication && input.config.authMethod && !manifest.authentication.some((method) => method.id === input.config.authMethod)) throw new IntegrationError('不支持此认证方式')
  const selectedFields = legacy ? manifest.fields : connectionFields(manifest, input.config)
  const fields = selectedFields.filter((f) => !f.secret).map((f) => f.key)
  if (!legacy && manifest.authentication) fields.push('authMethod')
  if (legacy && input.providerId === 'gitlab') fields.push('user', 'project')
  const config = Object.fromEntries(Object.entries(input.config).filter(([key]) => fields.includes(key)).map(([key, value]) => [key, value.trim()]))
  for (const field of selectedFields) if (!field.secret && !config[field.key] && field.defaultValue) config[field.key] = field.defaultValue
  if (manifest.fields.some((field) => field.key === 'baseUrl')) {
    let url: URL
    try { url = new URL(config.baseUrl) } catch { throw new IntegrationError('请输入有效的实例地址') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new IntegrationError('实例地址只能包含 HTTP(S) 协议、主机和路径')
    config.baseUrl = url.href.replace(/\/+$/, '')
    if (input.providerId === 'weknora') config.baseUrl = config.baseUrl.replace(/\/api\/v1$/i, '')
  }
  if (input.providerId === 'jira' && config.statusMap) {
    try { const map: unknown = JSON.parse(config.statusMap); if (!map || typeof map !== 'object' || Array.isArray(map) || Object.values(map).some((v) => typeof v !== 'string')) throw new Error('map') }
    catch { throw new IntegrationError('状态映射应为状态名到本地状态的 JSON 对象') }
  }
  return config
}
export function saveConnection(input: SaveConnectionInput): IntegrationConnection {
  const legacy = legacyConnections().find((c) => c.id === input.id)
  if (input.id?.startsWith('legacy-') && !legacy) throw new IntegrationError('旧连接不存在，请刷新')
  if (legacy) {
    if (legacy.revision !== input.revision || legacy.providerId !== input.providerId) throw new IntegrationError('旧连接已更新，请刷新后再保存', 'conflict')
    const config = normalizedConfig(input, true)
    if (input.enabled && !config.user) throw new IntegrationError('启用旧连接前请填写用户名')
    const patch = input.secrets.password
    let password: string | undefined
    let passwordEncrypted: boolean | undefined
    if (patch?.op === 'replace') { password = protectSecret(patch.value); passwordEncrypted = true }
    if (patch?.op === 'clear') { password = ''; passwordEncrypted = false }
    if (input.enabled && !(password ?? (legacy.hasSecrets.length ? 'saved' : ''))) throw new IntegrationError('启用连接前请填写密码')
    const secret = password === undefined ? {} : { password, passwordEncrypted }
    try {
      const settings = getSettings()
      if (input.providerId === 'jira') setSettings({ jira: { ...settings.jira, ...config, enabled: input.enabled, statusMap: JSON.parse(config.statusMap || '{}') as Record<string, string>, ...secret } }, true)
      else { setSettings({ gitlab: { ...settings.gitlab, ...config, enabled: input.enabled, ...secret } }, true); clearGitlabTokenCache(); clearGitlabStatusCache() }
    } catch { throw new IntegrationError('旧连接保存失败，原配置已保留', 'io') }
    const next = legacyConnections().find((c) => c.id === legacy.id)
    if (!next) throw new IntegrationError('连接保存后无法读取', 'io')
    return next
  }
  const manifest = integrationRegistry.get(input.providerId).manifest
  const config = normalizedConfig(input, false)
  const fields = connectionFields(manifest, config)
  return updateIntegrationState((state) => {
    const previous = input.id ? state.connections.find((c) => c.id === input.id && !c.deleted) : undefined
    if (input.id && (!previous || previous.revision !== input.revision || previous.providerId !== input.providerId)) throw new IntegrationError('连接已更新或不存在，请刷新', 'conflict')
    const methodChanged = previous && (previous.config.authMethod || 'token') !== (config.authMethod || 'token')
    const secrets: Record<string, string> = methodChanged ? {} : { ...previous?.secrets }
    if (previous && (previous.config.baseUrl !== config.baseUrl || previous.config.clientId !== config.clientId)) delete secrets.oauthTokens
    for (const field of fields.filter((f) => f.secret)) {
      const patch = input.secrets[field.key]
      if (patch?.op === 'replace') secrets[field.key] = protectSecret(patch.value)
      else if (patch?.op === 'clear') delete secrets[field.key]
      if (input.enabled && field.required && !secrets[field.key]) throw new IntegrationError(`请填写${field.label}`)
    }
    for (const field of fields.filter((f) => !f.secret && f.required)) if (input.enabled && !config[field.key]) throw new IntegrationError(`请填写${field.label}`)
    const next: StoredConnection = { id: previous?.id ?? randomUUID(), providerId: input.providerId, name: input.name, enabled: input.enabled, revision: (previous?.revision ?? 0) + 1, config, secrets, check: 'unverified', checkedAt: null, detail: '', deleted: false }
    if (next.enabled) integrationRegistry.get(input.providerId).validate?.({ public: toPublic(next), secrets: Object.fromEntries(Object.entries(secrets).map(([key, value]) => [key, revealSecret(value)])), instanceId: next.id })
    if (previous) state.connections[state.connections.indexOf(previous)] = next
    else state.connections.push(next)
    return toPublic(next)
  })
}
export async function authorizeConnection(input: ConnectionRequest, signal: AbortSignal): Promise<IntegrationConnection> {
  const connection = resolveConnection(input)
  const provider = integrationRegistry.get(connection.public.providerId)
  if (connection.public.legacy || !provider.authorization) throw new IntegrationError('此连接不支持浏览器授权，请新建支持 OAuth 的连接', 'denied')
  const result = await provider.authorization.authorize(connection, signal)
  if (signal.aborted) throw new IntegrationError('授权已取消或超时，未保存此次凭证', 'denied')
  const protectedSecrets = Object.fromEntries(Object.entries(result.secrets).map(([key, value]) => [key, protectSecret(value)]))
  return updateIntegrationState((state) => {
    const stored = state.connections.find((item) => item.id === input.connectionId && !item.deleted)
    if (!stored || !stored.enabled || stored.revision !== input.connectionRevision) throw new IntegrationError('授权期间连接已变更，请刷新后重新登录', 'conflict')
    stored.secrets = { ...stored.secrets, ...protectedSecrets }
    stored.revision++
    stored.checkedAt = Date.now(); stored.check = 'authenticated'; stored.detail = result.detail
    return toPublic(stored)
  })
}
/** Import origin and protected connection commit atomically; the old settings are never edited. */
export function saveImportedKnowledgeConnection(input: SaveConnectionInput): IntegrationConnection {
  if (input.providerId !== 'weknora' || input.id) throw new IntegrationError('只支持导入新的 WeKnora 连接')
  const config = normalizedConfig(input, false)
  const key = input.secrets.apiKey
  if (key?.op !== 'replace') throw new IntegrationError('导入需要可解密的旧凭证', 'denied')
  const secret = protectSecret(key.value)
  return updateIntegrationState((state) => {
    const imported = state.legacyImports['settings.weknora']
    const previous = state.connections.find((connection) => connection.id === imported && !connection.deleted)
    if (previous) return toPublic(previous)
    if (imported) throw new IntegrationError('旧配置已导入且连接已删除，请显式新建连接', 'conflict')
    const connection: StoredConnection = { id: randomUUID(), providerId: 'weknora', name: input.name, enabled: input.enabled, revision: 1, config, secrets: { apiKey: secret }, check: 'unverified', checkedAt: null, detail: '', deleted: false }
    state.connections.push(connection); state.legacyImports['settings.weknora'] = connection.id
    return toPublic(connection)
  })
}
export function removeConnection(input: ConnectionRequest): null {
  const connection = integrationSnapshot().connections.find((c) => c.id === input.connectionId)
  if (!connection || connection.revision !== input.connectionRevision) throw new IntegrationError('连接已更新或不存在', 'conflict')
  if (connection.legacy) throw new IntegrationError('旧连接仍被兼容入口使用，请先停用；不删除历史设置', 'denied')
  return updateIntegrationState((state) => {
    const stored = state.connections.find((c) => c.id === input.connectionId && c.revision === input.connectionRevision)
    if (!stored) throw new IntegrationError('连接已更新', 'conflict')
    stored.deleted = true; stored.enabled = false; stored.revision++; stored.secrets = {}
    state.bindings.filter((b) => b.connectionId === stored.id).forEach((b) => { b.enabled = false; b.revision++ })
    return null
  })
}
export async function inspectConnection(input: ConnectionRequest): Promise<IntegrationConnection> {
  const connection = resolveConnection(input, true)
  const provider = integrationRegistry.get(connection.public.providerId)
  let detail = '群机器人配置已检查；尚未发送消息'
  try {
    if (provider.notification) provider.validate?.(connection)
    else if (provider.repository) detail = await provider.repository.inspect(connection)
    else if (provider.inspect) detail = await provider.inspect(connection)
  } catch (error) {
    if (!connection.public.legacy) updateIntegrationState((state) => {
      const stored = state.connections.find((c) => c.id === input.connectionId && c.revision === input.connectionRevision)
      if (stored) { stored.checkedAt = Date.now(); stored.check = 'failed'; stored.detail = '连接检查失败，请检查认证、权限与网络' }
    })
    throw error
  }
  resolveConnection(input, true)
  if (connection.public.legacy) return { ...connection.public, detail, check: 'authenticated', checkedAt: Date.now() }
  return updateIntegrationState((state) => {
    const stored = state.connections.find((c) => c.id === input.connectionId && c.revision === input.connectionRevision)
    if (!stored) throw new IntegrationError('检查期间连接已更新，请重试', 'conflict')
    stored.detail = detail.slice(0, 300); stored.checkedAt = Date.now(); stored.check = provider.notification ? 'configured' : 'authenticated'
    return toPublic(stored)
  })
}
export function saveBinding(input: SaveBindingInput): IntegrationBinding {
  const root = canonicalRoot(requireProject(input.expectedRoot))
  const connection = resolveConnection(input)
  if (integrationRegistry.get(connection.public.providerId).repository && !input.scope) throw new IntegrationError('请先选择或填写项目绑定的仓库路径')
  if (connection.public.providerId === 'weknora' && (!input.knowledge || (input.enabled && !input.knowledge.defaultCollectionIds.length))) throw new IntegrationError('请选择项目默认知识库；空范围不会检索远端')
  if (connection.public.providerId === 'weknora' && input.scope) throw new IntegrationError('知识绑定使用类型化知识库选择，不接受仓库/JQL 范围')
  if (connection.public.providerId !== 'weknora' && input.knowledge) throw new IntegrationError('此连接不支持知识库绑定')
  return updateIntegrationState((state) => {
    const previous = input.id ? state.bindings.find((b) => b.id === input.id && b.root === root) : undefined
    if (input.id && (!previous || previous.revision !== input.revision)) throw new IntegrationError('项目绑定已更新，请刷新', 'conflict')
    const binding: IntegrationBinding = { id: previous?.id ?? randomUUID(), root, connectionId: input.connectionId, revision: (previous?.revision ?? 0) + 1, label: input.label, scope: input.scope, enabled: input.enabled, ...(input.knowledge ? { knowledge: input.knowledge } : {}) }
    if (connection.public.providerId === 'jira' && binding.enabled) state.bindings.filter((b) => b.root === root && b.id !== binding.id && b.enabled && [...legacyConnections(), ...state.connections.map(toPublic)].some((c) => c.id === b.connectionId && c.providerId === 'jira')).forEach((b) => { b.enabled = false; b.revision++ })
    if (connection.public.providerId === 'weknora' && binding.enabled) state.bindings.filter((b) => b.root === root && b.id !== binding.id && b.enabled && state.connections.some((c) => c.id === b.connectionId && c.providerId === 'weknora')).forEach((b) => { b.enabled = false; b.revision++ })
    if (previous) state.bindings[state.bindings.indexOf(previous)] = binding; else state.bindings.push(binding)
    return binding
  })
}
export function resolveBinding(input: BindingRequest): { root: string; binding: IntegrationBinding; connection: ResolvedConnection } {
  const root = requireProject(input.expectedRoot)
  if (input.bindingId === 'legacy-jira-binding' && hasJiraBindings(root)) throw new IntegrationError('项目已配置独立 Jira 绑定，请刷新来源页面', 'conflict')
  const binding = input.bindingId === 'legacy-jira-binding'
    ? { id: input.bindingId, root: canonicalRoot(root), connectionId: 'legacy-jira', revision: 1, label: 'Jira · 全局兼容配置', scope: '', enabled: true }
    : readIntegrationState().bindings.find((b) => b.id === input.bindingId && b.root === canonicalRoot(root))
  if (!binding || !binding.enabled || binding.revision !== input.bindingRevision) throw new IntegrationError('项目绑定已变更或停用，请刷新', 'conflict')
  return { root, binding, connection: resolveConnection({ connectionId: binding.connectionId, connectionRevision: input.connectionRevision }) }
}
export function removeBinding(input: BindingRequest): null {
  resolveBinding(input)
  return updateIntegrationState((state) => { const binding = state.bindings.find((b) => b.id === input.bindingId); if (binding) { binding.enabled = false; binding.revision++ }; return null })
}
export function currentJiraContext(expectedRoot: string): JiraContext | null {
  const root = requireProject(expectedRoot)
  const snapshot = integrationSnapshot()
  const binding = snapshot.bindings.find((b) => b.enabled && snapshot.connections.some((c) => c.enabled && c.id === b.connectionId && c.providerId === 'jira'))
  const connection = snapshot.connections.find((c) => c.id === (binding?.connectionId ?? 'legacy-jira') && c.enabled)
  if (!binding && hasJiraBindings(root)) return null
  if (!connection) return null
  const cfg = jiraConfig(resolveConnection({ connectionId: connection.id, connectionRevision: connection.revision }))
  return { expectedRoot: root, bindingId: binding?.id ?? 'legacy-jira-binding', bindingRevision: binding?.revision ?? 1, connectionRevision: connection.revision, name: binding?.label ?? 'Jira · 全局兼容配置', baseUrl: cfg.baseUrl, instanceId: jiraInstanceIdFor(cfg.baseUrl, cfg.user), jql: binding?.scope || cfg.jql, statusMap: cfg.statusMap, legacy: !binding }
}
function hasJiraBindings(root: string): boolean {
  const state = readIntegrationState()
  return state.bindings.some((b) => b.root === canonicalRoot(root) && (b.connectionId === 'legacy-jira' || state.connections.some((c) => c.id === b.connectionId && c.providerId === 'jira')))
}
export async function searchJira(input: BindingRequest & { jql: string; signal?: AbortSignal }) {
  const { connection, binding } = resolveBinding(input)
  const port = integrationRegistry.get(connection.public.providerId).tasks
  if (!port) throw new IntegrationError('此连接不支持工单查询')
  const cfg = jiraConfig(connection)
  const base = binding.scope || cfg.jql
  const jql = input.jql.trim() || base || 'assignee = currentUser() ORDER BY updated DESC'
  return port.search(connection, jql, input.signal)
}
export async function getJiraTransitions(input: BindingRequest & { key: string }) {
  const { connection } = resolveBinding(input)
  const port = integrationRegistry.get(connection.public.providerId).tasks
  if (!port) throw new IntegrationError('此连接不支持工单流转')
  return port.transitions(connection, input.key)
}
export async function transitionJira(input: BindingRequest & { key: string; transitionId: string; expectedToStatus: string }) {
  const { connection } = resolveBinding(input)
  const port = integrationRegistry.get(connection.public.providerId).tasks
  if (!port) throw new IntegrationError('此连接不支持工单流转')
  return port.transition(connection, input.key, input.transitionId, input.expectedToStatus)
}
export async function commentJira(input: BindingRequest & { key: string; body: string }): Promise<null> {
  const { connection } = resolveBinding(input)
  const port = integrationRegistry.get(connection.public.providerId).tasks
  if (!port) throw new IntegrationError('此连接不支持工单评论')
  return port.comment(connection, input.key, input.body)
}
function taskContext(expectedRoot: string, taskDir: string) {
  const root = requireProject(expectedRoot)
  const snapshot = getSnapshot()
  const candidates = [...(snapshot?.tasks ?? []), ...(snapshot?.archived ?? [])].filter((task) => task.path === taskDir || task.dirName === taskDir)
  if (candidates.length !== 1) throw new IntegrationError('工作项身份不唯一或已变化，请刷新后重试', 'conflict')
  const task = candidates[0]
  if (!task?.record) throw new IntegrationError('工作项不存在或尚未持久化')
  if (task.record.id && [...(snapshot?.tasks ?? []), ...(snapshot?.archived ?? [])].some((other) => other.path !== task.path && other.record?.id === task.record?.id)) throw new IntegrationError('此项目存在重复的工作项 ID，请先明确身份后再关联', 'conflict')
  const relative = toRepoRelativeDir(root, task.path)
  return { root, task, taskRef: taskRefFor(task.record.id || null, relative), relative, workspaceId: workspaceIdForRoot(root) }
}
export function listLinks(expectedRoot: string, taskDir: string): ExternalLink[] {
  const context = taskContext(expectedRoot, taskDir)
  if (!existsSync(join(localRuntimeDirOf(context.root), 'control.sqlite'))) return []
  const store = new LocalControlStore(localRuntimeDirOf(context.root))
  try {
    store.open()
    return store.listIntegrationLinks(context.workspaceId, context.taskRef).flatMap((row) => { const parsed = externalObjectSchema.safeParse(row.payload); return parsed.success ? [{ id: row.id, object: parsed.data, createdAt: row.createdAt }] : [] })
  } finally { store.close() }
}
export function attachLink(input: BindingRequest & { taskDir: string; object: ExternalObject }): ExternalLink[] {
  const { connection, binding } = resolveBinding(input)
  if (!integrationRegistry.get(connection.public.providerId).repository || input.object.providerId !== connection.public.providerId || input.object.instanceId !== connection.instanceId || input.object.repository !== binding.scope || !remoteUrl(input.object.url)) throw new IntegrationError('远端对象与所选项目仓库不匹配')
  const context = taskContext(input.expectedRoot, input.taskDir)
  const store = new LocalControlStore(localRuntimeDirOf(context.root))
  try {
    store.open()
    store.upsertAlias(context.taskRef, context.task.record?.id || null, context.relative)
    store.upsertIntegrationLink(context.workspaceId, context.taskRef, JSON.stringify([input.object.instanceId, input.object.repository, input.object.kind, input.object.id]), input.object)
  } finally { store.close() }
  return listLinks(input.expectedRoot, input.taskDir)
}
export function unlink(expectedRoot: string, taskDir: string, linkId: number): ExternalLink[] {
  const context = taskContext(expectedRoot, taskDir)
  const store = new LocalControlStore(localRuntimeDirOf(context.root))
  try { store.open(); store.removeIntegrationLink(context.workspaceId, context.taskRef, linkId) } finally { store.close() }
  return listLinks(expectedRoot, taskDir)
}
export function previewNotification(input: BindingRequest & { taskDir: string }): NotificationPreview {
  const { binding, connection } = resolveBinding(input)
  if (!integrationRegistry.get(connection.public.providerId).notification) throw new IntegrationError('此绑定不支持发送通知')
  const { task, taskRef } = taskContext(input.expectedRoot, input.taskDir)
  const record = task.record
  if (!record) throw new IntegrationError('工作项不存在')
  return { taskRef, destination: binding.label, title: record.title.slice(0, 200), body: [`工作项：${record.id || task.dirName}`, `状态：${record.status}`, `优先级：${record.priority}`, record.description?.slice(0, 500) || ''].filter(Boolean).join('\n') }
}
export async function sendNotification(input: BindingRequest & { taskDir: string; requestId: string; preview: NotificationPreview }): Promise<DeliveryReceipt> {
  const { connection, binding } = resolveBinding(input)
  const port = integrationRegistry.get(connection.public.providerId).notification
  if (!port) throw new IntegrationError('此连接不支持通知')
  const preview = previewNotification(input)
  if (preview.title !== input.preview.title || preview.body !== input.preview.body || preview.taskRef !== input.preview.taskRef || preview.destination !== input.preview.destination) throw new IntegrationError('工作项或目的地已变化，请重新预览', 'conflict')
  const existing = readIntegrationState().receipts.find((r) => r.requestId === input.requestId)
  if (existing) {
    if (existing.taskRef !== preview.taskRef || existing.bindingId !== binding.id || existing.connectionRevision !== connection.public.revision) throw new IntegrationError('发送标识已被其他操作使用', 'conflict')
    return existing.state === 'pending' ? { ...existing, state: 'uncertain', detail: '该请求已提交，请先核实目标群，勿重复发送' } : existing
  }
  const pending: DeliveryReceipt = { requestId: input.requestId, connectionId: connection.public.id, connectionRevision: connection.public.revision, bindingId: binding.id, taskRef: preview.taskRef, destination: preview.destination, createdAt: Date.now(), state: 'pending', detail: '发送中' }
  updateIntegrationState((state) => {
    state.receipts = [pending, ...state.receipts].slice(0, 100)
  })
  let receipt: DeliveryReceipt
  try { await port.send(connection, preview.title, preview.body); receipt = { ...pending, state: 'delivered', detail: '厂商已确认接收消息' } }
  catch (error) { receipt = { ...pending, state: error instanceof IntegrationError && error.kind !== 'uncertain' ? 'failed' : 'uncertain', detail: error instanceof IntegrationError ? error.message : '结果未知，请先核实目标群' } }
  try { updateIntegrationState((state) => { const index = state.receipts.findIndex((r) => r.requestId === input.requestId); if (index >= 0) state.receipts[index] = receipt }) }
  catch { return { ...pending, state: 'uncertain', detail: '已发起请求但结果保存失败，请先核实目标群' } }
  return receipt
}
