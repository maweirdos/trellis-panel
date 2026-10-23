import type { IntegrationRegistry } from '../registry'
import { GitlabIssueAdapter } from './adapter'
import type { GitlabWorkspacePorts } from './ports'
import { assertBindingOwner, createGitlabWorkPort, sameSource } from './work'
import { createGitlabWorkspaceActions } from './procedures/workspace'
import { createGitlabPollingAdmission, createGitlabWebhookReceiver } from './events'
import { gitlabWriteAuthorization } from '../providers/gitlab-authorization'
import type { ResolvedConnection } from '../types'
import { IntegrationError } from '../types'
import type { IntegrationAdmissionPort } from '../work-ports'

export { GitlabWorkspaceRepository } from './repository'
export { createGitlabTaskAdapter } from './tasks'
export type { GitlabWorkspacePorts } from './ports'
export type { GitlabWorkspaceActions } from './procedures/workspace'
export type { GitlabCredentialPort } from './adapter'

/** Call once in daemon composition after the existing GitLab provider is registered.
 * No duplicate provider, manifest, credential or repository implementation. */
export function installGitlabWorkspace(registry: IntegrationRegistry, ports: GitlabWorkspacePorts) {
  const provider = registry.get('gitlab')
  if (provider.work || provider.accounts || provider.sync) throw new IntegrationError('GitLab 工作区适配器已安装', 'conflict')
  const adapter = new GitlabIssueAdapter(ports.credentials), work = createGitlabWorkPort(ports, adapter)
  const admission: IntegrationAdmissionPort = { async resolve(workspace, source) {
    ports.assertWorkspace(workspace)
    const connection = await ports.connection({ connectionId: source.connectionId, connectionRevision: source.connectionRevision })
    await ports.credentials.assertCurrent(connection)
    ports.assertWorkspace(workspace)
    const binding = ports.repository.read().bindings.find((b) => b.plan.id === source.bindingId)
    if (!binding || !sameSource(binding.plan.source, source) || binding.plan.target.profileId !== ports.profileId) throw new IntegrationError('GitLab 原作业来源或本机配置已变更', 'conflict')
    assertBindingOwner(binding, workspace, connection, ports.profileId)
    return connection
  } }
  provider.work = work
  provider.accounts = { async list(connection) { await ports.credentials.assertCurrent(connection); return ports.repository.read().accounts.filter((a) => a.instanceId === connection.instanceId && a.account.connectionId === connection.public.id).map((a) => a.verifiedRevision === connection.public.revision || a.account.state !== 'linked' ? a.account : { ...a.account, state: 'unverified' as const }) } }
  provider.sync = { async validate(plan, connection) { const binding = ports.repository.read().bindings.find((b) => b.plan.id === plan.id); if (!binding || binding.plan.revision !== plan.revision || binding.plan.source.instanceId !== connection.instanceId || binding.plan.source.connectionId !== connection.public.id || binding.plan.source.connectionRevision !== connection.public.revision) return { supported: false, reason: '绑定或连接修订不一致' }; const permission = await adapter.inspect(connection, binding.project.id); return { supported: plan.direction === 'inbound' || permission.write === 'granted', reason: permission.evidence } } }
  return { actions: createGitlabWorkspaceActions(ports, adapter, work), admission, work, poll: createGitlabPollingAdmission(ports), receiveWebhook: createGitlabWebhookReceiver(ports) }
}

/** GUI-native authorization adapter. Main injects a protected credential-owner CAS
 * commit; never call legacy updateIntegrationState after daemon cutover. */
export async function authorizeGitlabWritesThroughOwner(connection: ResolvedConnection, signal: AbortSignal, owner: { assertCurrent(connection: ResolvedConnection): Promise<void>; commit(connection: ResolvedConnection, secrets: Record<string, string>, detail: string): Promise<number> }): Promise<{ connectionRevision: number; detail: string }> {
  await owner.assertCurrent(connection)
  const result = await gitlabWriteAuthorization.authorize(connection, signal)
  if (signal.aborted) throw new IntegrationError('授权会话已取消', 'denied')
  await owner.assertCurrent(connection)
  const revision = await owner.commit(connection, result.secrets, result.detail)
  return { connectionRevision: revision, detail: '已明确授权 api 范围；请重新验证项目并更新绑定修订。' }
}
