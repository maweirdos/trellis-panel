import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { readBounded, writeAtomic } from '../../daemon/files'
import { protectSecret, revealSecret } from '../integrations/credentials'
import { TeamHttp, type TeamFetch } from '../team-platform/http'
import { DesktopTeamError, type ConnectionRecord } from '../team-platform/types'
import { teamSessionSchema } from '../../../shared/team-platform'
import { taskInputReadSchema, taskInputBundleDigestText } from '../../../shared/team-task-inputs'
import { createHash } from 'node:crypto'
import { hifoxRemoteSnapshotSchema } from '../../../shared/hifox-remote'
import { taskProgressPinSchema, type TaskProgressPin } from '../../../shared/hifox-task-progress-native'
import { teamTaskProgressDtoSchema, teamTaskProgressCommandSchema, teamTaskProgressCommandReplySchema, type TeamTaskProgressCommand } from '../../../shared/team-task-progress'
import { proxiedFetch } from '../proxy'
import { teamTaskCodeResourceDtoSchema } from '../../../shared/team-code-resources'
import { TaskMaterialsTransport, taskMaterialTransportPinSchema } from '../team-platform/task-materials-transport'
import type { TeamTaskMaterialCommand } from '../../../shared/team-task-materials'

const credentialSchema = taskProgressPinSchema.pick({ connectionId: true, origin: true, pairingId: true, ownerId: true, deviceId: true, projectId: true }).extend({ version: z.literal(1), purpose: z.literal('task-progress'), token: z.string().min(1).max(16384) }).strict()
const fileSchema = z.object({ version: z.literal(1), connectionId: z.string().uuid(), protected: z.string().min(1).max(64 * 1024).nullable() }).strict()
function file(dataDir: string, connectionId: string): string {
  z.string().uuid().parse(connectionId)
  const root = realpathSync.native(dataDir), directory = join(root, 'task-progress-credentials')
  if (existsSync(directory) && realpathSync.native(directory).toLowerCase() !== resolve(directory).toLowerCase()) throw new DesktopTeamError('CREDENTIAL_UNAVAILABLE', '原任务进度凭据目录被重定向')
  return join(directory, `${connectionId}.json`)
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
  private route(): string { return `/api/projects/${this.pin.projectId}/hifox/tasks/${encodeURIComponent(this.pin.taskId)}/progress` }
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
    const result = await this.http.request(this.pin.origin, `/api/projects/${this.pin.projectId}/hifox/snapshot`, hifoxRemoteSnapshotSchema, c.value.token)
    this.current(c.fingerprint)
    if (result.instanceId !== this.pin.instanceId || result.epoch !== this.pin.epoch || result.projectId !== this.pin.projectId || result.actor.id !== this.pin.ownerId) throw new DesktopTeamError('WORKSPACE_EPOCH_CHANGED', '原任务正式状态的中心身份已改变')
    return result
  }
  async codeResource(): Promise<z.infer<typeof teamTaskCodeResourceDtoSchema>> {
    const c = await this.authorized()
    const result = await this.http.request(this.pin.origin, `/api/projects/${this.pin.projectId}/hifox/tasks/${encodeURIComponent(this.pin.taskId)}/code-resource`, teamTaskCodeResourceDtoSchema, c.value.token)
    this.current(c.fingerprint)
    if (result.instanceId !== this.pin.instanceId || result.epoch !== this.pin.epoch || result.projectId !== this.pin.projectId || result.taskId !== this.pin.taskId || result.spaceId !== this.pin.spaceId) {
      throw new DesktopTeamError('BINDING_CHANGED', '代码资源不属于原任务的服务与空间')
    }
    return result
  }
  async inputs(taskCreatedAt: string): Promise<z.infer<typeof taskInputReadSchema>> {
    const c = await this.authorized()
    const query = new URLSearchParams({ spaceId: this.pin.spaceId, taskCreatedAt })
    const result = await this.http.request(this.pin.origin, `/api/projects/${this.pin.projectId}/hifox/tasks/${encodeURIComponent(this.pin.taskId)}/inputs?${query}`, taskInputReadSchema, c.value.token)
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
  private check(result: z.infer<typeof teamTaskProgressDtoSchema>): void {
    if (result.instanceId !== this.pin.instanceId || result.epoch !== this.pin.epoch || result.projectId !== this.pin.projectId || result.taskId !== this.pin.taskId || result.spaceId !== this.pin.spaceId) throw new DesktopTeamError('BINDING_CHANGED', '任务进度返回了不同的原服务或任务身份')
  }
}
