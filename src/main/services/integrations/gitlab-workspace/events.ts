import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { WorkspaceGrant } from '../../../../shared/daemon'
import type { GitlabBinding } from '../../../../shared/gitlab-integration'
import { IntegrationError } from '../types'
import { recordOf } from '../transport'
import { gitlabNumericId } from './adapter'
import { digest } from './mapping'
import type { GitlabWorkspacePorts } from './ports'
import { assertBindingOwner, sameSource } from './work'

/** Mount only behind the native owner's configured HTTPS receiver adapter.
 * GitLab 18 uses X-Gitlab-Token, not newer signing headers. Persist event intent
 * before enqueue; acknowledge only after the common command is durable. */
export function createGitlabWebhookReceiver(ports: GitlabWorkspacePorts) {
  return async (input: { bindingId: string; token: string; event: string; deliveryId?: string; body: Uint8Array; workspace: WorkspaceGrant }): Promise<{ accepted: true; duplicate: boolean }> => {
    if (!ports.receiver) throw new IntegrationError('GitLab 接收端未配置', 'denied')
    if (input.body.byteLength > 256 * 1024 || input.token.length > 8192 || input.deliveryId && input.deliveryId.length > 256) throw new IntegrationError('GitLab 事件超出容量限制', 'invalid')
    const binding = ports.repository.read().bindings.find((b) => b.plan.id === input.bindingId)
    if (!binding || binding.plan.transport !== 'webhook' || !['active', 'degraded'].includes(binding.plan.state)) throw new IntegrationError('此 GitLab 接收绑定不可用', 'denied')
    const connection = await ports.connection({ connectionId: binding.plan.source.connectionId, connectionRevision: binding.plan.source.connectionRevision })
    ports.assertWorkspace(input.workspace); assertBindingOwner(binding, input.workspace, connection, ports.profileId)
    const config = await ports.receiver.configuration(binding)
    const hash = (value: string) => createHash('sha256').update(value).digest()
    if (config.token.length < 32 || config.token.length > 256 || /[\u0000-\u001f\u007f]/.test(config.token) || !timingSafeEqual(hash(input.token), hash(config.token))) throw new IntegrationError('GitLab Webhook 身份验证失败', 'denied')
    let body: Record<string, unknown>
    try { body = recordOf(JSON.parse(Buffer.from(input.body).toString('utf8'))) } catch { throw new IntegrationError('GitLab 事件 JSON 无效', 'invalid') }
    const attributes = recordOf(body.object_attributes), projectId = gitlabNumericId(recordOf(body.project).id)
    if (projectId !== binding.project.id || !((input.event === 'Issue Hook' && body.object_kind === 'issue' && gitlabNumericId(attributes.project_id) === projectId) || (input.event === 'Note Hook' && body.object_kind === 'note' && attributes.noteable_type === 'Issue' && gitlabNumericId(recordOf(body.issue).project_id) === projectId && gitlabNumericId(attributes.noteable_id) === gitlabNumericId(recordOf(body.issue).id)))) throw new IntegrationError('GitLab 事件不是此绑定的 Issue 或 Issue Note', 'denied')
    gitlabNumericId(attributes.id)
    // Event headers and project are hints until secret verification. Instance is
    // pinned by the receiver route/binding, never accepted from callback JSON.
    const bodyDigest = digest(Buffer.from(input.body).toString('base64'))
    const eventId = digest([binding.plan.id, binding.plan.source.instanceId, projectId, input.deliveryId ?? bodyDigest])
    const previous = ports.repository.read().hookEvents.find((e) => e.id === eventId)
    if (previous && previous.bindingId !== binding.plan.id) throw new IntegrationError('GitLab 事件不属于此接收绑定', 'conflict')
    if (previous && previous.bodyDigest !== bodyDigest) throw new IntegrationError('同一 GitLab 事件标识携带不同内容', 'conflict')
    await ports.credentials.assertCurrent(connection); ports.assertWorkspace(input.workspace)
    const current = ports.repository.read().bindings.find((b) => b.plan.id === binding.plan.id)
    if (!current || !sameSource(current.plan.source, binding.plan.source) || current.plan.transport !== 'webhook' || !['active', 'degraded'].includes(current.plan.state)) throw new IntegrationError('GitLab 接收绑定在提交前已变更', 'conflict')
    assertBindingOwner(current, input.workspace, connection, ports.profileId)
    const admitted = ports.repository.change((state) => {
      const retained = state.hookEvents.find((e) => e.id === eventId)
      if (retained) {
        if (retained.bodyDigest !== bodyDigest || retained.bindingId !== binding.plan.id) throw new IntegrationError('GitLab 重复事件内容不一致', 'conflict')
        return { commandId: retained.commandId, duplicate: true }
      }
      const commandId = randomUUID()
      state.hookEvents.push({ id: eventId, bodyDigest, bindingId: binding.plan.id, commandId, at: new Date().toISOString() })
      return { commandId, duplicate: false }
    })
    await ports.enqueue(input.workspace, binding.plan.source, { kind: 'sync', planId: binding.plan.id, planRevision: binding.plan.revision }, admitted.commandId)
    ports.repository.change((state) => { const b = state.bindings.find((v) => v.plan.id === binding.plan.id); if (b && sameSource(b.plan.source, binding.plan.source) && b.plan.transport === 'webhook') { b.hook.state = 'receiving'; b.hook.lastEventAt = new Date().toISOString(); b.hook.detail = '已验证事件并提交持久追赶作业' } })
    return { accepted: true, duplicate: admitted.duplicate }
  }
}

/** Host calls on its existing timer. This owns no timer, process or job ledger. */
export function createGitlabPollingAdmission(ports: GitlabWorkspacePorts) {
  return async (grantFor: (binding: GitlabBinding) => WorkspaceGrant | null): Promise<void> => {
    for (const binding of ports.repository.read().bindings) {
      if (!['active', 'degraded'].includes(binding.plan.state) || binding.nextPollAt > Date.now()) continue
      const workspace = grantFor(binding)
      if (!workspace) continue
      try {
        ports.assertWorkspace(workspace)
        const c = await ports.connection({ connectionId: binding.plan.source.connectionId, connectionRevision: binding.plan.source.connectionRevision })
        assertBindingOwner(binding, workspace, c, ports.profileId)
        let after: string | null = null, active = false
        do { const page = await ports.jobs(workspace, after); active ||= page.items.some((j) => j.source.bindingId === binding.plan.id && ['queued', 'dispatched', 'running', 'cancel-requested', 'unknown'].includes(j.state)); after = page.next } while (!active && after)
        if (active) continue
        await ports.credentials.assertCurrent(c); ports.assertWorkspace(workspace)
        const latest = ports.repository.read().bindings.find((b) => b.plan.id === binding.plan.id)
        if (!latest || !sameSource(latest.plan.source, binding.plan.source) || !['active', 'degraded'].includes(latest.plan.state)) continue
        assertBindingOwner(latest, workspace, c, ports.profileId)
        // Stable minute command identity survives reply loss without re-enqueue.
        const hash = digest([binding.plan.id, binding.plan.revision, binding.nextPollAt])
        const commandId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
        await ports.enqueue(workspace, binding.plan.source, { kind: 'sync', planId: binding.plan.id, planRevision: binding.plan.revision }, commandId)
      } catch (error) {
        ports.repository.change((state) => { const b = state.bindings.find((v) => v.plan.id === binding.plan.id); if (b && sameSource(b.plan.source, binding.plan.source) && ['active', 'degraded'].includes(b.plan.state)) { b.failures++; b.plan.state = 'degraded'; b.lastError = error instanceof IntegrationError ? error.message.slice(0, 400) : '定时同步暂不可用，请检查后台服务'; b.nextPollAt = Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(b.failures, 6)) } })
      }
    }
  }
}
