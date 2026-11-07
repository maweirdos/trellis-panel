import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { readBounded, writeAtomic } from '../../daemon/files'
import { protectSecret, revealSecret } from '../integrations/credentials'
import { TeamHttp, type TeamFetch } from '../team-platform/http'
import { DesktopTeamError, type ConnectionRecord } from '../team-platform/types'
import { teamCommandIdSchema, teamSessionSchema } from '../../../shared/team-platform'
import { taskInputReadSchema, taskInputBundleDigestText } from '../../../shared/team-task-inputs'
import { createHash } from 'node:crypto'
import { cruxRemoteCommandSchema, cruxRemoteCommandReplySchema, cruxRemoteSnapshotSchema } from '../../../shared/crux-remote'
import { taskProgressPinSchema, type TaskProgressPin } from '../../../shared/crux-task-progress-native'
import { teamTaskProgressDtoSchema, teamTaskProgressCommandSchema, teamTaskProgressCommandReplySchema, type TeamTaskProgressCommand } from '../../../shared/team-task-progress'
import { proxiedFetch } from '../proxy'
import { teamTaskCodeResourceDtoSchema } from '../../../shared/team-code-resources'
import { TaskMaterialsTransport, taskMaterialTransportPinSchema } from '../team-platform/task-materials-transport'
import type { TeamTaskMaterialCommand } from '../../../shared/team-task-materials'
import { teamTaskRefSchema, teamTaskIdentity, teamExecutionCommandSchema, type TeamTaskRef } from '../../../shared/team-task-execution'
import type { TeamContentRequest } from '../../../shared/team-content-transport'
import { jiraBusinessEffectSchema, jiraBusinessEventCommandSchema, jiraBusinessMappingCommandSchema, jiraBusinessMappingQuerySchema, jiraBusinessTaskMappingSchema, type JiraBusinessEffect, type JiraBusinessTaskMapping } from '../../../shared/jira-business-hooks'

const credentialSchema = taskProgressPinSchema.pick({ connectionId: true, origin: true, pairingId: true, ownerId: true, deviceId: true, projectId: true }).extend({ version: z.literal(1), purpose: z.enum(['task-progress', 'business-hook']), token: z.string().min(1).max(16384) }).strict()
const businessCredentialSchema = credentialSchema.extend({ instanceId: z.string().uuid(), epoch: z.string().uuid() }).strict()
const fileSchema = z.object({ version: z.literal(1), connectionId: z.string().uuid(), protected: z.string().min(1).max(64 * 1024).nullable() }).strict()
function file(dataDir: string, connectionId: string, purpose: 'task-progress' | 'business-hook' = 'task-progress'): string {
  z.string().uuid().parse(connectionId)
  const root = realpathSync.native(dataDir), directory = join(root, 'task-progress-credentials')
  if (existsSync(directory) && realpathSync.native(directory).toLowerCase() !== resolve(directory).toLowerCase()) throw new DesktopTeamError('CREDENTIAL_UNAVAILABLE', '原任务进度凭据目录被重定向')
  return join(directory, `${connectionId}${purpose === 'business-hook' ? '.business' : ''}.json`)
}
/** Only DesktopTeamService's existing SQLite owner issues/revokes this native credential. */
export function writeTaskProgressCredential(dataDir: string, c: ConnectionRecord, token: string | null, seal: (body: string) => string = protectSecret, unseal: (body: string) => string = revealSecret): void {
  const path = file(dataDir, c.connectionId)
  if (token !== null && existsSync(path)) {
    const previous = fileSchema.parse(JSON.parse(readBounded(path, 96 * 1024)))
    if (previous.protected) {
      const original = credentialSchema.parse(JSON.parse(unseal(previous.protected)))
      if (original.connectionId !== c.connectionId || original.origin !== c.origin || original.ownerId !== c.ownerId || original.deviceId !== c.deviceId || original.projectId !== c.projectId || original.pairingId !== c.pairingId || original.token !== token) throw new DesktopTeamError('BINDING_CHANGED', '原任务进度凭据不能换成其他身份')
      return
    }
    throw new DesktopTeamError('CREDENTIAL_UNAVAILABLE', '原任务进度发送授权已撤销，不能自动恢复')
  }
  const value = token === null ? null : seal(JSON.stringify(credentialSchema.parse({ version: 1, purpose: 'task-progress', connectionId: c.connectionId,
    origin: c.origin, pairingId: c.pairingId, ownerId: c.ownerId, deviceId: c.deviceId, projectId: c.projectId, token })))
  writeAtomic(path, JSON.stringify(fileSchema.parse({ version: 1, connectionId: c.connectionId, protected: value })))
}

/** Separate protected purpose for GUI-independent business Hook effects. */
export function writeBusinessHookCredential(dataDir: string, c: ConnectionRecord, token: string | null, seal: (body: string) => string = protectSecret, unseal: (body: string) => string = revealSecret, binding?: { instanceId: string; epoch: string }): void {
  const path = file(dataDir, c.connectionId, 'business-hook')
  if (token !== null && existsSync(path)) {
    const previous = fileSchema.parse(JSON.parse(readBounded(path, 96 * 1024)))
    if (previous.protected) {
      const original = businessCredentialSchema.parse(JSON.parse(unseal(previous.protected)))
      if (original.purpose !== 'business-hook' || original.connectionId !== c.connectionId || original.origin !== c.origin || original.ownerId !== c.ownerId || original.deviceId !== c.deviceId || original.projectId !== c.projectId || original.pairingId !== c.pairingId || original.token !== token || !binding || original.instanceId !== binding.instanceId || original.epoch !== binding.epoch) throw new DesktopTeamError('BINDING_CHANGED', '业务 Hook 凭据不能换成其他身份')
      return
    }
    throw new DesktopTeamError('CREDENTIAL_UNAVAILABLE', '业务 Hook 授权已撤销，不能自动恢复')
  }
  if (token !== null && !binding) throw new DesktopTeamError('BINDING_CHANGED', '业务 Hook 凭据必须绑定当前服务世代')
  const value = token === null ? null : seal(JSON.stringify(businessCredentialSchema.parse({ version: 1, purpose: 'business-hook', connectionId: c.connectionId,
    origin: c.origin, pairingId: c.pairingId, ownerId: c.ownerId, deviceId: c.deviceId, projectId: c.projectId, token, ...binding })))
  writeAtomic(path, JSON.stringify(fileSchema.parse({ version: 1, connectionId: c.connectionId, protected: value })))
}

/** Fixed-purpose protected HTTP sender. It never opens or writes the team SQLite store. */
export class NativeTaskProgressSender {
  private readonly http: TeamHttp
  constructor(private readonly dataDir: string, private readonly pin: TaskProgressPin, fetcher?: TeamFetch, private readonly unseal: (body: string) => string = revealSecret) {
    taskProgressPinSchema.parse(pin)
    this.http = new TeamHttp(fetcher ?? ((url, init) => proxiedFetch(url, init as unknown as Record<string, unknown>)), 15_000)
  }
  private credential() {
    try {
      const saved = fileSchema.parse(JSON.parse(readBounded(file(this.dataDir, this.pin.connectionId), 96 * 1024)))
      if (saved.connectionId !== this.pin.connectionId || !saved.protected) throw new Error('revoked')
      const value = credentialSchema.parse(JSON.parse(this.unseal(saved.protected)))
      for (const name of ['connectionId', 'origin', 'pairingId', 'ownerId', 'deviceId', 'projectId'] as const) if (value[name] !== this.pin[name]) throw new Error('identity')
      return { value, fingerprint: saved.protected }
    } catch { throw new DesktopTeamError('CREDENTIAL_UNAVAILABLE', '原任务进度发送凭据不可用、已撤销或身份不一致') }
  }
  private current(fingerprint: string, write = false): void {
    try { if (this.credential().fingerprint === fingerprint) return } catch { /* The original in-flight POST may still have committed. */ }
    throw new DesktopTeamError('BINDING_CHANGED', '原任务进度凭据在请求期间已变化', write)
  }
  private async authorized() {
    const credential = this.credential()
    const session = await this.http.request(this.pin.origin, '/api/session', teamSessionSchema, credential.value.token)
    this.current(credential.fingerprint)
    if (session.authentication !== 'device' || session.deviceId !== this.pin.deviceId || session.person.userId !== this.pin.ownerId || !session.person.active
      ) throw new DesktopTeamError('BINDING_CHANGED', '原任务进度设备或账号权限已变化')
    // Each fixed project/task endpoint independently checks current project and space authorization.
    return credential
  }
  private route(): string { return `/api/projects/${this.pin.projectId}/crux/tasks/${encodeURIComponent(this.pin.taskId)}/progress` }
  async status() {
    const c = await this.authorized()
    const result = await this.http.request(this.pin.origin, this.route(), teamTaskProgressDtoSchema, c.value.token)
    this.current(c.fingerprint)
    this.check(result)
    return result
  }
  async command(raw: TeamTaskProgressCommand) {
    const command = teamTaskProgressCommandSchema.parse(raw)
    if (command.expectedEpoch !== this.pin.epoch) throw new DesktopTeamError('WORKSPACE_EPOCH_CHANGED', '旧任务进度命令不能跨服务世代发送')
    const c = await this.authorized()
    const result = await this.http.request(this.pin.origin, `${this.route()}/commands`, teamTaskProgressCommandReplySchema, c.value.token, command)
    this.current(c.fingerprint, true)
    this.check(result.result)
    if (result.commandId !== command.commandId) throw new DesktopTeamError('RECEIPT_MISMATCH', '任务进度回执不属于原命令', true)
    return result
  }
  async snapshot() {
    const c = await this.authorized()
    const result = await this.http.request(this.pin.origin, `/api/projects/${this.pin.projectId}/crux/snapshot`, cruxRemoteSnapshotSchema, c.value.token)
    this.current(c.fingerprint)
    if (result.instanceId !== this.pin.instanceId || result.epoch !== this.pin.epoch || result.projectId !== this.pin.projectId || result.actor.id !== this.pin.ownerId) throw new DesktopTeamError('WORKSPACE_EPOCH_CHANGED', '原任务正式状态的中心身份已改变')
    return result
  }
  async codeResource(): Promise<z.infer<typeof teamTaskCodeResourceDtoSchema>> {
    const c = await this.authorized()
    const result = await this.http.request(this.pin.origin, `/api/projects/${this.pin.projectId}/crux/tasks/${encodeURIComponent(this.pin.taskId)}/code-resource`, teamTaskCodeResourceDtoSchema, c.value.token)
    this.current(c.fingerprint)
    if (result.instanceId !== this.pin.instanceId || result.epoch !== this.pin.epoch || result.projectId !== this.pin.projectId || result.taskId !== this.pin.taskId || result.spaceId !== this.pin.spaceId) {
      throw new DesktopTeamError('BINDING_CHANGED', '代码资源不属于原任务的服务与空间')
    }
    return result
  }
  async inputs(taskCreatedAt: string): Promise<z.infer<typeof taskInputReadSchema>> {
    const c = await this.authorized()
    const query = new URLSearchParams({ spaceId: this.pin.spaceId, taskCreatedAt })
    const result = await this.http.request(this.pin.origin, `/api/projects/${this.pin.projectId}/crux/tasks/${encodeURIComponent(this.pin.taskId)}/inputs?${query}`, taskInputReadSchema, c.value.token)
    this.current(c.fingerprint)
    if (result.instanceId !== this.pin.instanceId || result.epoch !== this.pin.epoch || result.projectId !== this.pin.projectId || result.taskId !== this.pin.taskId || result.spaceId !== this.pin.spaceId || result.taskCreatedAt !== taskCreatedAt) throw new DesktopTeamError('BINDING_CHANGED', '任务输入不属于原服务、任务或创建身份')
    if (result.current && createHash('sha256').update(taskInputBundleDigestText(result.current), 'utf8').digest('hex') !== result.current.digest) throw new DesktopTeamError('TASK_INPUT_CHANGED', '当前采用输入的固定摘要无法核对')
    return result
  }
  /** Output synchronization retains the original native device, task and credential fingerprint. */
  async outputMaterials(taskCreatedAt: string): Promise<Pick<TaskMaterialsTransport, 'list' | 'read' | 'command' | 'receipt'>> {
    const c = await this.authorized()
    const { ownerId, handlerId: _handler, ...original } = this.pin
    const pin = taskMaterialTransportPinSchema.parse({ ...original, actorId: ownerId, taskCreatedAt })
    const transport = new TaskMaterialsTransport(pin, async (path, schema, body) => {
      this.current(c.fingerprint)
      const value = await this.http.request(this.pin.origin, path, schema, c.value.token, body)
      this.current(c.fingerprint, body !== undefined)
      return value
    })
    const allowed = (command: TeamTaskMaterialCommand): void => {
      if (command.action !== 'create' && command.action !== 'saveDraft') throw new DesktopTeamError('OUTPUT_ACTION_DENIED', '本机产物只能回传共享草稿，不能批准、采纳或推进任务')
    }
    return { list: input => transport.list(input), read: (id, input) => transport.read(id, input),
      command: command => { allowed(command); return transport.command(command) }, receipt: command => { allowed(command); return transport.receipt(command) } }
  }
  /** Task-scoped v2 port using the same issued credential, with no second SQLite owner. */
  executionRequest(raw: TeamTaskRef, assertCurrent: () => Promise<void>): TeamContentRequest {
    const task = teamTaskRefSchema.parse(raw)
    if (task.instanceId !== this.pin.instanceId || task.projectId !== this.pin.projectId || task.taskId !== this.pin.taskId || task.spaceId !== this.pin.spaceId) throw new DesktopTeamError('BINDING_CHANGED', 'Original v2 task differs from the protected sender')
    const base = `/api/projects/${task.projectId}/crux/tasks/${encodeURIComponent(task.taskId)}`
    return async (path, schema, body, validate) => {
      const url = new URL(path, 'http://native.invalid')
      if (url.origin !== 'http://native.invalid' || url.hash || url.username || url.password) throw new DesktopTeamError('EXECUTION_SCOPE_CONFLICT', 'Only fixed native task routes are allowed')
      const suffix = url.pathname.slice(base.length)
      const read = body === undefined && url.pathname.startsWith(base) && (suffix === '/code-resource'
        || /^\/executions(?:\/[\w-]+)?$/.test(suffix)
        || /^\/executions\/[\w-]+\/inputs(?:\/resources\/[^/]+)?$/.test(suffix)
        || /^\/executions\/[\w-]+\/artifacts\/[\w-]+$/.test(suffix))
      const write = body !== undefined && url.pathname.startsWith(base) && ['/executions/commands', '/executions/reconcile'].includes(suffix) && url.search === ''
      if (!read && !write) throw new DesktopTeamError('EXECUTION_SCOPE_CONFLICT', 'Native sender route is outside its fixed v2 task')
      if (read && suffix !== '/code-resource') {
        if (url.searchParams.get('contractVersion') !== '2' || url.searchParams.get('instanceId') !== task.instanceId
          || url.searchParams.get('spaceId') !== task.spaceId || url.searchParams.get('taskCreatedAt') !== task.taskCreatedAt
          || [...url.searchParams.keys()].some(key => !['contractVersion', 'instanceId', 'spaceId', 'taskCreatedAt', 'purpose'].includes(key))) throw new DesktopTeamError('EXECUTION_SCOPE_CONFLICT', 'Native read changed its original task incarnation')
      }
      if (write) {
        const command = teamExecutionCommandSchema.parse(body)
        if (teamTaskIdentity(command.task) !== teamTaskIdentity(task) || command.expectedEpoch !== this.pin.epoch || command.expectedActorId !== this.pin.ownerId
          || command.expectedDeviceId !== this.pin.deviceId || ['claim', 'transition', 'release'].includes(command.kind)) throw new DesktopTeamError('EXECUTION_SCOPE_CONFLICT', 'Native sender cannot change task ownership or business state')
      }
      await assertCurrent()
      const c = await this.authorized()
      // This fixed task read fences actual service instance/epoch/incarnation even
      // for artifact response shapes which carry no epoch field themselves.
      const resource = await this.codeResource()
      if (resource.taskCreatedAt !== task.taskCreatedAt) throw new DesktopTeamError('BINDING_CHANGED', 'Original task incarnation changed')
      await assertCurrent(); this.current(c.fingerprint)
      const result = await this.http.request(this.pin.origin, path, schema, c.value.token, body)
      this.current(c.fingerprint, body !== undefined); await assertCurrent(); validate?.(result)
      return result
    }
  }
  private check(result: z.infer<typeof teamTaskProgressDtoSchema>): void {
    if (result.instanceId !== this.pin.instanceId || result.epoch !== this.pin.epoch || result.projectId !== this.pin.projectId || result.taskId !== this.pin.taskId || result.spaceId !== this.pin.spaceId) throw new DesktopTeamError('BINDING_CHANGED', '任务进度返回了不同的原服务或任务身份')
  }
}

/** Project-scoped business Hook sender. It never opens team SQLite and uses only the current desktop device credential. */
export class NativeTeamBusinessSender {
  private readonly http: TeamHttp
  constructor(private readonly dataDir: string, private readonly connectionId: string, fetcher?: TeamFetch, private readonly unseal: (body: string) => string = revealSecret) {
    z.string().uuid().parse(connectionId)
    this.http = new TeamHttp(fetcher ?? ((url, init) => proxiedFetch(url, init as unknown as Record<string, unknown>)), 15_000)
  }
  private credential(): { value: z.infer<typeof businessCredentialSchema>; fingerprint: string } {
    try {
      const saved = fileSchema.parse(JSON.parse(readBounded(file(this.dataDir, this.connectionId, 'business-hook'), 96 * 1024)))
      if (saved.connectionId !== this.connectionId || !saved.protected) throw new Error('revoked')
      const value = businessCredentialSchema.parse(JSON.parse(this.unseal(saved.protected)))
      if (value.purpose !== 'business-hook' || value.connectionId !== this.connectionId) throw new Error('purpose')
      return { value, fingerprint: saved.protected }
    } catch { throw new DesktopTeamError('CREDENTIAL_UNAVAILABLE', '业务 Hook 凭据不可用、已撤销或身份不一致') }
  }
  private current(fingerprint: string, write = false): void {
    try { if (this.credential().fingerprint === fingerprint) return } catch { /* The original effect may already have committed. */ }
    throw new DesktopTeamError('BINDING_CHANGED', '业务 Hook 凭据在请求期间变化', write)
  }
  private assertProject(projectId: string, credential: ReturnType<NativeTeamBusinessSender['credential']>): void {
    if (projectId !== credential.value.projectId) throw new DesktopTeamError('BINDING_CHANGED', '业务 Hook 请求跨越了受保护凭据项目', true)
  }
  private async authorized(): Promise<{ credential: ReturnType<NativeTeamBusinessSender['credential']>; session: z.infer<typeof teamSessionSchema> }> {
    const credential = this.credential()
    const session = await this.http.request(credential.value.origin, '/api/session', teamSessionSchema, credential.value.token)
    this.current(credential.fingerprint)
    if (session.authentication !== 'device' || session.deviceId !== credential.value.deviceId || session.person.userId !== credential.value.ownerId || !session.person.active) throw new DesktopTeamError('BINDING_CHANGED', '业务 Hook 设备或账号权限已变化')
    return { credential, session }
  }
  private async remoteSnapshot(credential: ReturnType<NativeTeamBusinessSender['credential']>, write = false): Promise<z.infer<typeof cruxRemoteSnapshotSchema>> {
    const value = await this.http.request(credential.value.origin, `/api/projects/${credential.value.projectId}/crux/snapshot`, cruxRemoteSnapshotSchema, credential.value.token)
    this.current(credential.fingerprint, write)
    if (value.instanceId !== credential.value.instanceId || value.epoch !== credential.value.epoch || value.projectId !== credential.value.projectId || value.actor.id !== credential.value.ownerId) {
      throw new DesktopTeamError('WORKSPACE_EPOCH_CHANGED', '业务 Hook 快照不属于原服务世代、项目或账号', write)
    }
    return value
  }
  async snapshot(): Promise<z.infer<typeof cruxRemoteSnapshotSchema>> {
    const { credential } = await this.authorized()
    return this.remoteSnapshot(credential)
  }
  async command(operation: string, input: unknown, commandId: string): Promise<z.infer<typeof cruxRemoteCommandReplySchema>> {
    const { credential } = await this.authorized(), current = await this.remoteSnapshot(credential)
    const command = cruxRemoteCommandSchema.parse({ commandId, expectedEpoch: current.epoch, expectedRevision: current.revision, operation, input })
    const result = await this.http.request(credential.value.origin, `/api/projects/${credential.value.projectId}/crux/commands`, cruxRemoteCommandReplySchema, credential.value.token, command)
    this.current(credential.fingerprint, true)
    if (result.commandId !== commandId || result.result.projectId !== credential.value.projectId || result.result.instanceId !== credential.value.instanceId || result.result.epoch !== current.epoch || result.result.actor.id !== credential.value.ownerId) throw new DesktopTeamError('RECEIPT_MISMATCH', '业务 Hook 回执不属于原命令、账号或服务世代', true)
    return result
  }
  async businessMapping(input: { projectId: string; instanceId: string; issueId: string }): Promise<JiraBusinessTaskMapping | null> {
    const { credential } = await this.authorized()
    const query = jiraBusinessMappingQuerySchema.parse(input)
    this.assertProject(query.projectId, credential)
    await this.remoteSnapshot(credential)
    const value = await this.http.request(credential.value.origin, `/api/projects/${query.projectId}/crux/jira/mappings?${new URLSearchParams({ instanceId: query.instanceId, issueId: query.issueId })}`, jiraBusinessTaskMappingSchema.nullable(), credential.value.token)
    this.current(credential.fingerprint)
    if (value && (value.projectId !== credential.value.projectId || value.task.instanceId !== credential.value.instanceId)) throw new DesktopTeamError('RECEIPT_MISMATCH', 'Jira 平台任务映射不属于原项目或服务世代')
    return value
  }
  async linkBusinessTask(input: z.input<typeof jiraBusinessMappingCommandSchema>): Promise<JiraBusinessTaskMapping> {
    const { credential } = await this.authorized()
    const current = await this.remoteSnapshot(credential)
    const command = jiraBusinessMappingCommandSchema.parse(input)
    this.assertProject(command.projectId, credential)
    if (command.expectedEpoch !== current.epoch) throw new DesktopTeamError('WORKSPACE_EPOCH_CHANGED', 'Jira 平台任务映射命令属于旧服务世代', true)
    const value = await this.http.request(credential.value.origin, `/api/projects/${command.projectId}/crux/jira/mappings/commands`, z.object({ status: z.enum(['committed', 'duplicate']), commandId: teamCommandIdSchema, result: jiraBusinessTaskMappingSchema }).strict(), credential.value.token, command)
    this.current(credential.fingerprint, true)
    if (value.commandId !== command.commandId || value.result.projectId !== command.projectId || value.result.task.instanceId !== credential.value.instanceId) throw new DesktopTeamError('RECEIPT_MISMATCH', 'Jira 平台任务映射回执不属于原命令、项目或服务世代', true)
    await this.remoteSnapshot(credential, true)
    return value.result
  }
  async recordBusinessEffect(input: z.input<typeof jiraBusinessEventCommandSchema>): Promise<JiraBusinessEffect> {
    const { credential } = await this.authorized()
    const current = await this.remoteSnapshot(credential)
    const command = jiraBusinessEventCommandSchema.parse(input)
    this.assertProject(command.projectId, credential)
    if (command.expectedEpoch !== current.epoch) throw new DesktopTeamError('WORKSPACE_EPOCH_CHANGED', 'Jira 业务事件命令属于旧服务世代', true)
    const value = await this.http.request(credential.value.origin, `/api/projects/${command.projectId}/crux/jira/business-effects/commands`, z.object({ status: z.enum(['committed', 'duplicate']), commandId: teamCommandIdSchema, result: jiraBusinessEffectSchema }).strict(), credential.value.token, command)
    this.current(credential.fingerprint, true)
    if (value.commandId !== command.commandId || value.result.projectId !== command.projectId || value.result.effectId !== command.effectId || value.result.task.instanceId !== credential.value.instanceId) throw new DesktopTeamError('RECEIPT_MISMATCH', 'Jira 业务事件回执不属于原命令、项目或服务世代', true)
    await this.remoteSnapshot(credential, true)
    return value.result
  }
}
