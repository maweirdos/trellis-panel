import { shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { hifoxRemoteCommandSchema, hifoxRemoteCommandReplySchema, hifoxRemoteSnapshotSchema, type HifoxRemoteCommand, type HifoxRemoteSnapshot } from '../../../shared/hifox-remote'
import { desktopAuthoredPublicationSchema, desktopConnectionIdSchema, desktopDocumentInputSchema, desktopFeedbackInputSchema, desktopFeedbackListSchema, desktopListInputSchema, desktopPairingInputSchema, desktopPublicationBaseSchema, desktopVersionsInputSchema, type DesktopAuthoredPublicationInput, type DesktopFeedbackInput, type DesktopMaterialPublicationInput, type DesktopTeamApi, type DesktopTeamConnection, type DesktopTeamConnectionContext, type DesktopTeamDocument, type DesktopTeamEventSync, type DesktopTeamOutbox, type DesktopTeamOutboxPage, type DesktopTeamPairing, type DesktopTeamSnapshot } from '../../../shared/team-desktop'
import { TEAM_MAX_DOCUMENT_BYTES, TEAM_MAX_REQUEST_BYTES, deviceEnrollmentInputSchema, publicationInputSchema, teamCommandIdSchema, teamCommandReplySchema, teamDeviceEnrollmentSchema, teamDeviceSchema, teamEventPageSchema, teamFeedbackInputSchema, teamFeedbackSchema, teamIdSchema, teamMaterialVersionSchema, teamPageSchema, teamProjectSchema, teamPublishedDocumentSchema, teamSessionSchema, type TeamMaterialVersion, type TeamPage, type TeamFeedback, type TeamSession } from '../../../shared/team-platform'
import { protectSecret, revealSecret } from '../integrations/credentials'
import { proxiedFetch } from '../proxy'
import { DesktopTeamStore } from './store-client'
import { verifyTeamDocument } from './codec'
import { canonicalTeamOrigin, TeamHttp, verificationUrl, type TeamFetch } from './http'
import { DesktopTeamError, publicConnection, publicOutbox, type CachedDocument, type ConnectionRecord, type OutboxRecord, type TrustedTeamMaterial } from './types'
import { creationListInputSchema, creationListSchema, creationViewInputSchema, creationViewSchema, creationHeadSchema, creationCommandSchema, creationCommandReplySchema, creationCommandResultSchema, type CreationCommand, type CreationView, type CreationCommandReply, type CreationHead } from '../../../shared/creations'
import { teamTaskProgressResourceIdSchema, teamTaskProgressCommandSchema, teamTaskProgressCommandReplySchema, teamTaskProgressDtoSchema, teamTaskProgressReceiptSchema, type TeamTaskProgressCommand, type TeamTaskProgressDto, type TeamTaskProgressCommandReply, type TeamTaskProgressReceipt } from '../../../shared/team-task-progress'
import { writeTaskProgressCredential, NativeTaskProgressSender } from '../hifox/task-progress-sender'
import type { TaskProgressPin } from '../../../shared/hifox-task-progress-native'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const lockedCodes = new Set(['UNAUTHENTICATED', 'UNAUTHORIZED', 'FORBIDDEN', 'DEVICE_REVOKED', 'ACCOUNT_DISABLED', 'AUTHENTICATION_REQUIRED', 'CREDENTIAL_UNAVAILABLE', 'BINDING_CHANGED'])
type SyncRecord = { cursor: string | null; resetRequired: boolean; resetCursor: string | null; hasMore: boolean; snapshot: { items: TeamMaterialVersion[]; fetchedAt: number } | null }
export type DesktopTeamOptions = {
  dataDir: string; workerFile?: string; requestTimeoutMs?: number; httpTimeoutMs?: number; allowLoopbackHttp?: boolean;
  /** Main-only adapters; never accept these from IPC/renderer input. */
  protectSecret?: (value: string) => string; revealSecret?: (value: string) => string;
  openExternal?: (url: string) => Promise<void>; fetch?: TeamFetch
}
export class DesktopTeamService implements DesktopTeamApi {
  /** Native daemon factory, no SQLite acquisition and no renderer access. */
  static taskProgressSender(dataDir: string, pin: TaskProgressPin): NativeTaskProgressSender { return new NativeTaskProgressSender(dataDir, pin) }
  async authorizeTaskProgress(connectionId: string): Promise<void> {
    return this.tracked(async () => {
      const c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      await this.creationOwner(c)
      writeTaskProgressCredential(this.options.dataDir, c, this.token(c), this.protection, this.reveal)
    })
  }
  private readonly http: TeamHttp
  private readonly protection: (value: string) => string
  private readonly reveal: (value: string) => string
  private readonly browser: (url: string) => Promise<void>
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly inFlight = new Set<Promise<unknown>>()
  private closingTask: Promise<void> | null = null
  private closing = false
  private closed = false
  private constructor(private readonly store: DesktopTeamStore, private readonly options: DesktopTeamOptions) {
    this.http = new TeamHttp(options.fetch ?? ((url, init) => proxiedFetch(url, init as unknown as Record<string, unknown>)), options.httpTimeoutMs ?? 15000)
    this.protection = options.protectSecret ?? protectSecret; this.reveal = options.revealSecret ?? revealSecret; this.browser = options.openExternal ?? ((url) => shell.openExternal(url))
  }
  static async open(options: DesktopTeamOptions): Promise<DesktopTeamService> {
    if (!Number.isSafeInteger(options.httpTimeoutMs ?? 15000) || (options.httpTimeoutMs ?? 15000) < 1 || (options.httpTimeoutMs ?? 15000) > 120000) throw new DesktopTeamError('INVALID_INPUT', '团队服务等待时限无效')
    return new DesktopTeamService(await DesktopTeamStore.open(options), options)
  }
  private assertOpen(): void { if (this.closing || this.closed) throw new DesktopTeamError('SERVICE_CLOSED', '团队同步服务正在退出') }
  private async tracked<T>(action: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const work = Promise.resolve().then(action)
    this.inFlight.add(work)
    try { return await work } finally { this.inFlight.delete(work) }
  }
  private async connection(connectionId: string, active = false): Promise<ConnectionRecord> {
    this.assertOpen()
    const c = await this.store.call<ConnectionRecord>({ op: 'connection', input: desktopConnectionIdSchema.parse(connectionId) })
    if (active && (c.state !== 'active' || c.accessLocked || !c.projectId || !c.ownerId)) throw new DesktopTeamError('ACCESS_LOCKED', '原设备尚未获准或已失去访问权限；不会换用其他账号重发')
    if (active) {
      try { this.token(c) } catch (error) { await this.noteError(c, error); throw error }
    }
    return c
  }
  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const previous = this.operations.get(key) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(action)
    this.operations.set(key, work)
    try { return await work } finally { if (this.operations.get(key) === work) this.operations.delete(key) }
  }
  private token(c: ConnectionRecord): string {
    try {
      const saved = z.object({ version: z.literal(1), connectionId: desktopConnectionIdSchema, origin: z.string().url(), pairingId: teamIdSchema, deviceId: teamIdSchema, token: teamDeviceEnrollmentSchema.shape.deviceToken }).strict().parse(JSON.parse(this.reveal(c.encryptedToken)))
      if (saved.connectionId !== c.connectionId || saved.origin !== c.origin || saved.pairingId !== c.pairingId || saved.deviceId !== c.deviceId) throw new Error('Credential tuple changed')
      return saved.token
    } catch { throw new DesktopTeamError('CREDENTIAL_UNAVAILABLE', '原设备凭据无法解密或不属于原服务绑定，请保留队列；旧操作不会改用新凭据') }
  }
  private async noteError(c: ConnectionRecord, error: unknown): Promise<void> {
    if (!(error instanceof DesktopTeamError)) return
    await this.store.call({ op: 'update-connection', input: { connectionId: c.connectionId, ...(lockedCodes.has(error.code) ? { lock: true, ...(error.code === 'CREDENTIAL_UNAVAILABLE' ? { revokeOutbox: false } : {}) } : {}), ...(error.code === 'NETWORK_UNAVAILABLE' || error.code === 'ACKNOWLEDGEMENT_UNKNOWN' ? { network: 'offline' } : {}), errorCode: error.code } })
  }
  private async request<T extends z.ZodType>(c: ConnectionRecord, path: string, schema: T, body?: unknown): Promise<z.output<T>> {
    try {
      const value = await this.http.request(c.origin, path, schema, this.token(c), body)
      // Do not insert a secondary metadata write between a committed remote POST
      // and its authoritative outbox settlement. Read/probe success updates reachability.
      if (body === undefined) await this.store.call({ op: 'update-connection', input: { connectionId: c.connectionId, network: 'reachable', errorCode: null } })
      return value
    }
    catch (error) { await this.noteError(c, error); throw error }
  }
  private async verifyActive(c: ConnectionRecord): Promise<TeamSession> {
    const session = await this.request(c, '/api/session', teamSessionSchema)
    if (session.authentication !== 'device' || session.deviceId !== c.deviceId || session.person.userId !== c.ownerId || !session.person.active) {
      await this.store.call({ op: 'update-connection', input: { connectionId: c.connectionId, lock: true, errorCode: 'BINDING_CHANGED' } })
      throw new DesktopTeamError('BINDING_CHANGED', '当前服务身份不属于原设备和账号')
    }
    return session
  }
  async connections(): Promise<DesktopTeamConnection[]> { return this.tracked(async () => (await this.store.call<ConnectionRecord[]>({ op: 'connections' })).map(publicConnection)) }
  private async verifyHifoxSnapshot(c: ConnectionRecord, value: HifoxRemoteSnapshot, write = false, expectedInstanceId?: string): Promise<HifoxRemoteSnapshot> {
    const member = value.snapshot.members.find((item) => item.id === c.ownerId)
    if ((expectedInstanceId !== undefined && value.instanceId !== expectedInstanceId) || value.projectId !== c.projectId || value.actor.id !== c.ownerId || !member || member.role !== value.actor.role) {
      const error = new DesktopTeamError('BINDING_CHANGED', '远程协作回执不属于原设备、账号或项目', write)
      await this.noteError(c, error)
      throw error
    }
    // A disconnect/revocation while HTTP was in flight must not expose a stale grant.
    const current = await this.connection(c.connectionId, true)
    if (current.origin !== c.origin || current.ownerId !== c.ownerId || current.deviceId !== c.deviceId || current.projectId !== c.projectId || current.pairingId !== c.pairingId) throw new DesktopTeamError('BINDING_CHANGED', '远程协作连接身份已改变', write)
    return value
  }
  async hifoxSnapshot(connectionId: string, options: { afterRevision?: number; waitMs?: number; expectedInstanceId?: string } = {}): Promise<HifoxRemoteSnapshot> {
    return this.tracked(async () => {
      const input = z.object({ afterRevision: z.number().int().nonnegative().safe().optional(), waitMs: z.number().int().min(0).max(8000).optional(), expectedInstanceId: z.string().uuid().optional() }).strict().parse(options)
      const c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const query = new URLSearchParams()
      if (input.afterRevision !== undefined) query.set('afterRevision', String(input.afterRevision))
      if (input.waitMs !== undefined) query.set('waitMs', String(input.waitMs))
      const value = await this.request(c, `/api/projects/${c.projectId}/hifox/snapshot${query.size ? '?' + query : ''}`, hifoxRemoteSnapshotSchema)
      // Revision ordering belongs to one instance/epoch. The coordinator owns
      // that durable head and must observe restore replies, including lower revisions.
      return this.verifyHifoxSnapshot(c, value, false, input.expectedInstanceId)
    })
  }
  async hifoxCommand(connectionId: string, raw: HifoxRemoteCommand, expectedInstanceId?: string): Promise<z.infer<typeof hifoxRemoteCommandReplySchema>> {
    return this.tracked(async () => {
      const payload = hifoxRemoteCommandSchema.parse(raw), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const reply = await this.request(c, `/api/projects/${c.projectId}/hifox/commands`, hifoxRemoteCommandReplySchema, payload)
      if (reply.commandId !== payload.commandId || reply.result.epoch !== payload.expectedEpoch || reply.result.revision !== payload.expectedRevision + 1) throw new DesktopTeamError('RECEIPT_MISMATCH', '远程协作回执与原命令或版本不一致', true)
      await this.verifyHifoxSnapshot(c, reply.result, true, expectedInstanceId)
      return reply
    })
  }
  async hifoxReceipt(connectionId: string, commandId: string, expectedInstanceId?: string): Promise<HifoxRemoteSnapshot | null> {
    return this.tracked(async () => {
      const id = teamCommandIdSchema.parse(commandId), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const schema = z.object({ commandId: teamCommandIdSchema, kind: z.string().min(1).max(100), status: z.literal('committed'), recordedAt: z.number().int().nonnegative(), result: hifoxRemoteSnapshotSchema }).strict()
      try {
        const receipt = await this.request(c, `/api/commands/${id}`, schema)
        if (receipt.commandId !== id || receipt.kind !== 'hifoxCommand') throw new DesktopTeamError('RECEIPT_MISMATCH', '核对回执不属于原协作操作', true)
        return this.verifyHifoxSnapshot(c, receipt.result, true, expectedInstanceId)
      } catch (error) { if (error instanceof DesktopTeamError && error.code === 'NOT_FOUND') return null; throw error }
    })
  }
  /** Protected native transport. Credentials and HTTP destinations never cross preload. */
  async hifoxTaskProgress(connectionId: string, taskId: string, expectedInstanceId?: string): Promise<TeamTaskProgressDto> {
    return this.tracked(async () => {
      const id = teamTaskProgressResourceIdSchema.parse(taskId), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const value = await this.request(c, `/api/projects/${c.projectId}/hifox/tasks/${encodeURIComponent(id)}/progress`, teamTaskProgressDtoSchema)
      await this.verifyTaskProgress(c, id, value, false, expectedInstanceId)
      return value
    })
  }
  async hifoxTaskProgressCommand(connectionId: string, taskId: string, raw: TeamTaskProgressCommand, expectedInstanceId: string): Promise<TeamTaskProgressCommandReply> {
    return this.tracked(async () => {
      const id = teamTaskProgressResourceIdSchema.parse(taskId), command = teamTaskProgressCommandSchema.parse(raw), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const reply = await this.request(c, `/api/projects/${c.projectId}/hifox/tasks/${encodeURIComponent(id)}/progress/commands`, teamTaskProgressCommandReplySchema, command)
      if (reply.commandId !== command.commandId || reply.result.epoch !== command.expectedEpoch) throw new DesktopTeamError('RECEIPT_MISMATCH', '进度回执与原命令或服务世代不一致', true)
      await this.verifyTaskProgress(c, id, reply.result, true, expectedInstanceId)
      return reply
    })
  }
  async hifoxTaskProgressReceipt(connectionId: string, taskId: string, commandId: string): Promise<TeamTaskProgressReceipt | null> {
    return this.tracked(async () => {
      const id = teamTaskProgressResourceIdSchema.parse(taskId), command = teamCommandIdSchema.parse(commandId), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const reply = await this.request(c, `/api/projects/${c.projectId}/hifox/tasks/${encodeURIComponent(id)}/progress/commands/${command}`, teamTaskProgressReceiptSchema.nullable())
      await this.creationOwner(c)
      if (reply && reply.commandId !== command) throw new DesktopTeamError('RECEIPT_MISMATCH', '进度回执不属于原命令', true)
      return reply
    })
  }
  private async verifyTaskProgress(c: ConnectionRecord, taskId: string, value: TeamTaskProgressDto, write: boolean, expectedInstanceId?: string): Promise<void> {
    if (value.projectId !== c.projectId || value.taskId !== taskId || expectedInstanceId !== undefined && value.instanceId !== expectedInstanceId) throw new DesktopTeamError('BINDING_CHANGED', '任务进度不属于原服务、项目或任务', write)
    await this.creationOwner(c)
  }
  private async creationOwner(c: ConnectionRecord): Promise<void> {
    const current = await this.connection(c.connectionId, true)
    if (current.origin !== c.origin || current.ownerId !== c.ownerId || current.deviceId !== c.deviceId || current.projectId !== c.projectId || current.pairingId !== c.pairingId) {
      throw new DesktopTeamError('BINDING_CHANGED', '创作来源的账号或团队已变化，请回到原来源核对')
    }
  }
  async creationHead(connectionId: string): Promise<CreationHead> {
    return this.tracked(async () => {
      const c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const head = await this.request(c, `/api/projects/${c.projectId}/creations/head`, creationHeadSchema)
      if (head.projectId !== c.projectId) throw new DesktopTeamError('BINDING_CHANGED', '创作更新摘要不属于原团队')
      await this.creationOwner(c)
      return head
    })
  }
  async creationsList(connectionId: string, raw: z.input<typeof creationListInputSchema>): Promise<z.output<typeof creationListSchema>> {
    return this.tracked(async () => {
      const input = creationListInputSchema.parse(raw), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, String(value))
      const result = await this.request(c, `/api/projects/${c.projectId}/creations?${query}`, creationListSchema)
      if (result.items.some((item) => item.projectId !== c.projectId)) throw new DesktopTeamError('BINDING_CHANGED', '创作列表不属于原团队')
      await this.creationOwner(c)
      return result
    })
  }
  async creationGet(connectionId: string, creationId: string, raw: z.input<typeof creationViewInputSchema> = {}): Promise<CreationView> {
    return this.tracked(async () => {
      const id = teamIdSchema.parse(creationId), input = creationViewInputSchema.parse(raw), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, String(value))
      const result = await this.request(c, `/api/projects/${c.projectId}/creations/${id}?${query}`, creationViewSchema)
      if (result.summary.projectId !== c.projectId || result.summary.creationId !== id || hash(result.selected.body) !== result.selected.bodyDigest) throw new DesktopTeamError('BODY_MISMATCH', '原型内容或来源与固定修订不一致')
      await this.creationOwner(c)
      return result
    })
  }
  async creationCommand(connectionId: string, raw: CreationCommand): Promise<CreationCommandReply> {
    return this.tracked(async () => {
      const input = creationCommandSchema.parse(raw), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const reply = await this.request(c, `/api/projects/${c.projectId}/creations/commands`, creationCommandReplySchema, input)
      if (reply.commandId !== input.commandId || reply.result.projectId !== c.projectId || reply.result.creationId !== input.creationId || reply.result.action !== input.action) throw new DesktopTeamError('RECEIPT_MISMATCH', '创作保存回执不属于原操作', true)
      await this.creationOwner(c)
      return reply
    })
  }
  async creationReceipt(connectionId: string, commandId: string): Promise<CreationCommandReply | null> {
    return this.tracked(async () => {
      const id = teamIdSchema.parse(commandId), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const schema = z.object({ commandId: teamCommandIdSchema, kind: z.literal('creationCommand'), status: z.literal('committed'), recordedAt: z.number().int().nonnegative(), result: creationCommandResultSchema }).strict()
      try {
        const receipt = await this.request(c, `/api/commands/${id}`, schema)
        if (receipt.commandId !== id || receipt.result.projectId !== c.projectId) throw new DesktopTeamError('RECEIPT_MISMATCH', '创作保存回执来源不一致', true)
        await this.creationOwner(c)
        return { status: 'duplicate', commandId: id, result: receipt.result }
      } catch (error) { if (error instanceof DesktopTeamError && error.code === 'NOT_FOUND') return null; throw error }
    })
  }
  async gitlabIdentity(connectionId: string): Promise<{ provider: 'gitlab'; issuer: string; subject: string; baseUrl: string; clientId: string; username?: string }> {
    return this.tracked(async () => {
      const c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const schema = z.object({ provider: z.literal('gitlab'), issuer: z.string().url().max(2048), subject: z.string().min(1).max(1024), baseUrl: z.string().url().max(2048), clientId: z.string().min(1).max(1024), username: z.string().min(1).max(200).optional() }).strict()
      const identity = await this.request(c, '/api/identity', schema)
      for (const raw of [identity.issuer, identity.baseUrl]) {
        const url = new URL(raw)
        if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(this.options.allowLoopbackHttp && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && url.protocol === 'http:'))) throw new DesktopTeamError('INVALID_IDENTITY', 'GitLab 登录身份地址必须是明确的受保护来源')
      }
      const current = await this.connection(connectionId, true)
      if (current.origin !== c.origin || current.ownerId !== c.ownerId || current.deviceId !== c.deviceId || current.projectId !== c.projectId) throw new DesktopTeamError('BINDING_CHANGED', '登录身份查询期间原设备连接已改变')
      return identity
    })
  }
  async connectionContext(connectionId: string): Promise<DesktopTeamConnectionContext> {
    return this.tracked(async () => {
      const c = await this.connection(connectionId, true), session = await this.verifyActive(c)
      let cursor: string | undefined
      for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
        const query = new URLSearchParams({ limit: '100' }); if (cursor) query.set('cursor', cursor)
        const page = await this.request(c, '/api/projects?' + query, teamPageSchema(teamProjectSchema)), project = page.items.find((item) => item.projectId === c.projectId)
        if (project) return { person: session.person, project }
        if (!page.hasMore) { const error = new DesktopTeamError('FORBIDDEN', '原设备绑定的项目已不在当前授权列表中'); await this.noteError(c, error); throw error }
        if (!page.nextCursor || page.nextCursor === cursor) throw new DesktopTeamError('CURSOR_CONFLICT', '项目身份列表游标没有前进，请重新核对')
        cursor = page.nextCursor
      }
      throw new DesktopTeamError('CAPACITY_EXCEEDED', '项目身份列表超过核对限界，不能猜测项目名称或权限')
    })
  }
  async beginPairing(raw: z.input<typeof desktopPairingInputSchema>): Promise<DesktopTeamPairing> {
    return this.serial('pairing-create', async () => {
      const input = desktopPairingInputSchema.parse(raw), origin = canonicalTeamOrigin(input.origin, this.options.allowLoopbackHttp)
      const { origin: _origin, ...enrollmentInput } = input
      const enrolled = await this.http.request(origin, '/api/device-pairings', teamDeviceEnrollmentSchema, undefined, deviceEnrollmentInputSchema.parse(enrollmentInput))
      const url = verificationUrl(origin, enrolled.verificationUri, enrolled.pairingId)
      if (enrolled.expiresAt <= Date.now() || enrolled.pollAfterMs > 300000) throw new DesktopTeamError('INVALID_RESPONSE', '配对已到期或轮询间隔无效')
      const connectionId = randomUUID()
      let encrypted: string
      try { encrypted = this.protection(JSON.stringify({ version: 1, connectionId, origin, pairingId: enrolled.pairingId, deviceId: enrolled.deviceId, token: enrolled.deviceToken })) } catch { throw new DesktopTeamError('CREDENTIAL_UNAVAILABLE', '系统加密不可用，未打开浏览器；配对凭据未保存') }
      const c: ConnectionRecord = { connectionId, origin, pairingId: enrolled.pairingId, deviceId: enrolled.deviceId, deviceName: input.deviceName, state: 'pending', projectId: input.projectId ?? null, ownerId: null, userCode: enrolled.userCode, verificationUri: url, expiresAt: enrolled.expiresAt, pollAfterMs: enrolled.pollAfterMs, nextPollAt: Date.now() + enrolled.pollAfterMs, encryptedToken: encrypted, capabilityClaims: input.capabilityClaims, sequence: -1, accessLocked: false, network: 'reachable', lastCheckedAt: Date.now(), lastErrorCode: null, remoteDevice: null }
      await this.store.call({ op: 'add-connection', input: c })
      let opened: DesktopTeamPairing['browser'] = 'opened'
      try { await this.browser(url) } catch { opened = 'unavailable' }
      return { connection: publicConnection(c), browser: opened }
    })
  }
  async openPairing(connectionId: string): Promise<void> {
    return this.tracked(async () => {
    const c = await this.connection(connectionId)
    if (c.state !== 'pending' || c.expiresAt <= Date.now()) throw new DesktopTeamError('PAIRING_UNAVAILABLE', '原配对已不处于待批准状态')
    this.token(c) // The encrypted origin/device tuple also protects later browser dispatch.
    try { await this.browser(verificationUrl(c.origin, c.verificationUri, c.pairingId)) } catch { throw new DesktopTeamError('BROWSER_UNAVAILABLE', '无法打开原配对页面，设备凭据和配对记录仍已保留') }
    })
  }
  async pollPairing(connectionId: string): Promise<DesktopTeamConnection> {
    return this.serial(`connection:${connectionId}`, async () => {
      const c = await this.connection(connectionId)
      if (c.state === 'disconnected') return publicConnection(c)
      if (Date.now() < c.nextPollAt) return publicConnection(c)
      await this.store.call({ op: 'update-connection', input: { connectionId, nextPollAt: Date.now() + c.pollAfterMs } })
      const device = await this.request(c, `/api/device-pairings/${c.pairingId}/status`, teamDeviceSchema)
      const next = await this.store.call<ConnectionRecord>({ op: 'update-connection', input: { connectionId, device } })
      if (next.state === 'active') await this.verifyActive(next)
      return publicConnection(await this.connection(connectionId))
    })
  }
  async disconnect(connectionId: string): Promise<DesktopTeamConnection> {
    return this.tracked(async () => {
    const c = await this.connection(connectionId)
    writeTaskProgressCredential(this.options.dataDir, c, null, this.protection)
    return publicConnection(await this.store.call({ op: 'update-connection', input: { connectionId, disconnect: true, errorCode: 'LOCAL_DISCONNECTED' } }))
    })
  }
  async heartbeat(connectionId: string): Promise<DesktopTeamConnection> {
    return this.serial(`connection:${connectionId}`, async () => {
      const c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const reserved = await this.store.call<ConnectionRecord>({ op: 'reserve-heartbeat', input: connectionId })
      const device = await this.request(reserved, '/api/devices/heartbeat', teamDeviceSchema, { capabilityClaims: reserved.capabilityClaims, sequence: reserved.sequence })
      if (device.sequence !== reserved.sequence) throw new DesktopTeamError('INVALID_RESPONSE', '心跳回执序号不属于本次已记录请求')
      return publicConnection(await this.store.call({ op: 'update-connection', input: { connectionId, device } }))
    })
  }
  private binding(c: ConnectionRecord) { return { origin: c.origin, pairingId: c.pairingId, deviceId: c.deviceId, projectId: c.projectId, ownerId: c.ownerId } }
  private async alias(c: ConnectionRecord, kind: 'repository' | 'workspace' | 'task' | 'version', value: string): Promise<string> { return this.store.call({ op: 'alias', input: { connectionId: c.connectionId, kind, value } }) }
  async queueAuthoredPublication(raw: DesktopAuthoredPublicationInput): Promise<DesktopTeamOutbox> {
    return this.tracked(async () => {
    const input = desktopAuthoredPublicationSchema.parse(raw), c = await this.connection(input.connectionId, true)
    const payload = publicationInputSchema.parse({ commandId: input.commandId, materialId: input.materialId, projectId: c.projectId, title: input.title, kind: input.kind, visibility: input.visibility, text: input.text, source: { kind: 'authored', sourceId: input.materialId, version: await this.alias(c, 'version', input.sourceVersion) }, expectedVersion: input.expectedVersion, expectedDigest: hash(input.text) })
    this.validateEnvelope(payload)
    return this.store.call({ op: 'enqueue', input: { connectionId: c.connectionId, kind: 'publication', binding: this.binding(c), payload } })
    })
  }
  /** MAIN ONLY: caller first resolves actual selected reader/material membership. */
  async queueMaterialPublication(raw: DesktopMaterialPublicationInput, trusted: TrustedTeamMaterial): Promise<DesktopTeamOutbox> {
    return this.tracked(async () => {
    const input = desktopPublicationBaseSchema.parse(raw), c = await this.connection(input.connectionId, true)
    const material = z.object({ repositoryId: z.string().min(1).max(8192), workspaceId: z.string().min(1).max(8192), taskRef: z.string().min(1).max(8192).nullable(), relativePath: publicationInputSchema.shape.source.options[0].shape.relativePath, version: z.string().min(1).max(8192), text: publicationInputSchema.shape.text, bodyDigest: z.string().regex(/^[a-f0-9]{64}$/), kind: publicationInputSchema.shape.kind }).strict().parse(trusted)
    if (hash(material.text) !== material.bodyDigest) throw new DesktopTeamError('BODY_MISMATCH', '所选本地产物正文与固定摘要不一致')
    const source = { kind: 'local-material', repositoryId: await this.alias(c, 'repository', material.repositoryId), workspaceId: await this.alias(c, 'workspace', material.workspaceId), taskRef: material.taskRef === null ? null : await this.alias(c, 'task', material.taskRef), relativePath: material.relativePath, version: await this.alias(c, 'version', material.version) }
    const payload = publicationInputSchema.parse({ commandId: input.commandId, materialId: input.materialId, projectId: c.projectId, title: input.title, kind: material.kind, visibility: input.visibility, text: material.text, source, expectedVersion: input.expectedVersion, expectedDigest: material.bodyDigest })
    this.validateEnvelope(payload)
    return this.store.call({ op: 'enqueue', input: { connectionId: c.connectionId, kind: 'publication', binding: this.binding(c), payload } })
    })
  }
  private validateEnvelope(payload: z.infer<typeof publicationInputSchema>): void { if (Buffer.byteLength(payload.text) > TEAM_MAX_DOCUMENT_BYTES || Buffer.byteLength(JSON.stringify(payload)) > TEAM_MAX_REQUEST_BYTES) throw new DesktopTeamError('CAPACITY_EXCEEDED', '正文或 JSON 请求封装超过限界，原内容未发送') }
  private validateMetadata(c: ConnectionRecord, items: TeamMaterialVersion[], materialId?: string): void {
    if (items.some((item) => item.projectId !== c.projectId || (materialId && item.materialId !== materialId) || (item.visibility === 'personal' && item.ownerId !== c.ownerId))) throw new DesktopTeamError('BINDING_CHANGED', '共享材料列表不属于原设备的项目、人员或所选材料')
  }
  async queueFeedback(raw: DesktopFeedbackInput): Promise<DesktopTeamOutbox> {
    return this.tracked(async () => {
    const input = desktopFeedbackInputSchema.parse(raw), c = await this.connection(input.connectionId, true)
    const { connectionId: _id, ...fields } = input, payload = teamFeedbackInputSchema.parse(fields)
    const cached = await this.store.call<CachedDocument | null>({ op: 'cached-document', input: { connectionId: c.connectionId, materialId: payload.materialId, version: payload.version } })
    if (!cached) throw new DesktopTeamError('VERSION_NOT_CACHED', '请先查阅此固定版本，再记录与该版本关联的反馈')
    if (payload.anchor && (!payload.quote || payload.anchor.end > cached.document.text.length || cached.document.text.slice(payload.anchor.start, payload.anchor.end) !== payload.quote)) throw new DesktopTeamError('ANCHOR_MISMATCH', '批注范围不属于所选固定版本')
    if (payload.quote && !cached.document.text.includes(payload.quote)) throw new DesktopTeamError('ANCHOR_MISMATCH', '引用文字不属于所选固定版本')
    return this.store.call({ op: 'enqueue', input: { connectionId: c.connectionId, kind: 'feedback', binding: this.binding(c), payload } })
    })
  }
  async outbox(connectionId: string, options: { cursor?: string; limit?: number } = {}): Promise<DesktopTeamOutboxPage> { return this.tracked(async () => { await this.connection(connectionId); return this.store.call({ op: 'outbox', input: { connectionId, ...options } }) }) }
  async cancelQueued(commandId: string): Promise<DesktopTeamOutbox> { return this.tracked(async () => this.store.call({ op: 'cancel', input: teamCommandIdSchema.parse(commandId) })) }
  async dispatch(commandId: string, options: { retryUnknown?: boolean } = {}): Promise<DesktopTeamOutbox> {
    const retry = z.object({ retryUnknown: z.boolean().default(false) }).strict().parse(options)
    return this.serial(`command:${commandId}`, async () => {
      let record = await this.store.call<OutboxRecord>({ op: 'command', input: teamCommandIdSchema.parse(commandId) })
      return this.withOriginalOutcome(record, async () => {
        if (record.state === 'committed' || record.state === 'cancelled-before-dispatch') return publicOutbox(record)
        const c = await this.connection(record.connectionId, true)
        await this.verifyActive(c)
        if (record.state === 'access-revoked' && retry.retryUnknown) record = await this.store.call({ op: 'reverify-command', input: commandId })
        if (record.state !== 'queued') {
          if (!retry.retryUnknown || !['dispatching', 'acknowledgement-unknown'].includes(record.state)) throw new DesktopTeamError('RECONCILE_REQUIRED', '先核对原命令，再明确重试相同载荷')
          await this.reconcileOriginal(record, c)
          record = await this.store.call({ op: 'command', input: commandId })
          if (record.state === 'committed') return publicOutbox(record)
        }
        const previouslyUnknown = record.outcomeUnknown
        const claimed = await this.store.call<OutboxRecord>({ op: 'claim', input: { commandId, retryUnknown: retry.retryUnknown } })
        try {
          const resultSchema = claimed.kind === 'publication' ? teamMaterialVersionSchema : teamFeedbackSchema
          const response = await this.request(c, claimed.kind === 'publication' ? '/api/materials' : '/api/feedback', teamCommandReplySchema(resultSchema), claimed.payload)
          if (response.commandId !== commandId) throw new DesktopTeamError('RECEIPT_MISMATCH', '远端回执命令与原操作不一致', true)
          return await this.recordOutcome({ commandId, state: 'committed', errorCode: null, receipt: response.result })
        } catch (error) {
          const unknown = previouslyUnknown || !(error instanceof DesktopTeamError) || error.outcomeUnknown || ['ACKNOWLEDGEMENT_UNKNOWN', 'RECEIPT_MISMATCH', 'STORE_UNAVAILABLE'].includes(error.code)
          const code = error instanceof DesktopTeamError ? error.code : 'ACKNOWLEDGEMENT_UNKNOWN'
          return this.recordOutcome({ commandId, state: lockedCodes.has(code) ? 'access-revoked' : unknown ? 'acknowledgement-unknown' : 'conflict', outcomeUnknown: unknown, errorCode: code })
        }
      })
    })
  }
  async reconcile(commandId: string): Promise<DesktopTeamOutbox> {
    return this.serial(`command:${commandId}`, async () => {
      const record = await this.store.call<OutboxRecord>({ op: 'command', input: teamCommandIdSchema.parse(commandId) })
      return this.withOriginalOutcome(record, async () => { const c = await this.connection(record.connectionId, true); await this.verifyActive(c); return this.reconcileOriginal(record, c) })
    })
  }
  private async withOriginalOutcome<T>(record: OutboxRecord, work: () => Promise<T>): Promise<T> {
    try { return await work() }
    catch (error) {
      if (record.outcomeUnknown && !(error instanceof DesktopTeamError && error.outcomeUnknown)) throw new DesktopTeamError(error instanceof DesktopTeamError ? error.code : 'ACKNOWLEDGEMENT_UNKNOWN', error instanceof DesktopTeamError ? error.message + '；原操作结果仍未确认' : '原操作结果仍未确认，请保留原身份核对', true)
      throw error
    }
  }
  private async recordOutcome(input: { commandId: string; state: 'committed' | 'access-revoked' | 'acknowledgement-unknown' | 'conflict'; errorCode: string | null; outcomeUnknown?: boolean; receipt?: unknown }): Promise<DesktopTeamOutbox> {
    try { return await this.store.call({ op: 'outcome', input }) }
    catch (error) { throw new DesktopTeamError(error instanceof DesktopTeamError && error.code === 'RECEIPT_MISMATCH' ? error.code : 'ACKNOWLEDGEMENT_UNKNOWN', '远端操作与本地确认尚未完整核对，请保留原命令，不能作为未发送重建', true) }
  }
  private async reconcileOriginal(record: OutboxRecord, c: ConnectionRecord): Promise<DesktopTeamOutbox> {
    if (record.state === 'cancelled-before-dispatch') return publicOutbox(record)
    const schema = z.object({ commandId: teamCommandIdSchema, kind: z.enum(['publish', 'recordFeedback']), status: z.literal('committed'), recordedAt: z.number().int().nonnegative(), result: record.kind === 'publication' ? teamMaterialVersionSchema : teamFeedbackSchema }).strict()
    try {
      const receipt = await this.request(c, `/api/commands/${record.commandId}`, schema)
      if (receipt.commandId !== record.commandId || receipt.kind !== (record.kind === 'publication' ? 'publish' : 'recordFeedback')) throw new DesktopTeamError('RECEIPT_MISMATCH', '核对回执不属于原操作', true)
      return await this.recordOutcome({ commandId: record.commandId, state: 'committed', errorCode: null, receipt: receipt.result })
    } catch (error) {
      if (error instanceof DesktopTeamError && error.code === 'NOT_FOUND') return this.store.call({ op: 'missing-receipt', input: record.commandId })
      throw error
    }
  }
  async readDocument(raw: z.input<typeof desktopDocumentInputSchema>): Promise<DesktopTeamDocument> {
    return this.tracked(async () => {
    const input = desktopDocumentInputSchema.parse(raw), c = await this.connection(input.connectionId, true)
    try {
      const document = verifyTeamDocument(await this.request(c, `/api/materials/${input.materialId}/versions/${input.version}`, teamPublishedDocumentSchema))
      if (document.material.materialId !== input.materialId || document.material.version !== input.version) throw new DesktopTeamError('BODY_MISMATCH', '远端返回的文档不是请求的固定版本')
      const cached = await this.store.call<CachedDocument>({ op: 'cache-document', input: { connectionId: c.connectionId, document } })
      return { ...cached, freshness: 'remote', authorization: 'current-server' }
    } catch (error) {
      if (!input.allowOffline || !(error instanceof DesktopTeamError) || error.code !== 'NETWORK_UNAVAILABLE') throw error
      const cached = await this.store.call<CachedDocument | null>({ op: 'cached-document', input: { connectionId: c.connectionId, materialId: input.materialId, version: input.version } })
      if (!cached) throw new DesktopTeamError('VERSION_NOT_CACHED', '此固定版本尚未缓存；无法用其他版本替代')
      return { ...cached, freshness: 'cached-offline', authorization: 'last-observed' }
    }
    })
  }
  async listMaterials(raw: z.input<typeof desktopListInputSchema>): Promise<TeamPage<TeamMaterialVersion>> {
    return this.tracked(async () => {
    const input = desktopListInputSchema.parse(raw), c = await this.connection(input.connectionId, true), query = new URLSearchParams({ projectId: c.projectId ?? '', limit: String(input.limit) }); if (input.cursor) query.set('cursor', input.cursor)
    const page = await this.request(c, '/api/materials?' + query, teamPageSchema(teamMaterialVersionSchema)); this.validateMetadata(c, page.items); return page
    })
  }
  async listVersions(raw: z.input<typeof desktopVersionsInputSchema>): Promise<TeamPage<TeamMaterialVersion>> {
    return this.tracked(async () => {
    const input = desktopVersionsInputSchema.parse(raw), c = await this.connection(input.connectionId, true), query = new URLSearchParams({ limit: String(input.limit) }); if (input.cursor) query.set('cursor', input.cursor)
    const page = await this.request(c, `/api/materials/${input.materialId}/versions?${query}`, teamPageSchema(teamMaterialVersionSchema)); this.validateMetadata(c, page.items, input.materialId); return page
    })
  }
  async listFeedback(raw: z.input<typeof desktopFeedbackListSchema>): Promise<TeamPage<TeamFeedback>> {
    return this.tracked(async () => {
    const input = desktopFeedbackListSchema.parse(raw), c = await this.connection(input.connectionId, true), query = new URLSearchParams({ version: String(input.version), limit: String(input.limit) }); if (input.cursor) query.set('cursor', input.cursor)
    const page = await this.request(c, `/api/materials/${input.materialId}/feedback?${query}`, teamPageSchema(teamFeedbackSchema))
    if (page.items.some((item) => item.materialId !== input.materialId || item.version !== input.version)) throw new DesktopTeamError('BINDING_CHANGED', '反馈列表不属于所选固定材料版本')
    return page
    })
  }
  async syncEvents(connectionId: string): Promise<DesktopTeamEventSync> {
    return this.serial(`sync:${connectionId}`, async () => {
      const c = await this.connection(connectionId, true), sync = await this.store.call<SyncRecord>({ op: 'sync-read', input: connectionId }), query = new URLSearchParams({ projectId: c.projectId ?? '', limit: '100' }); if (sync.cursor) query.set('cursor', sync.cursor)
      const page = await this.request(c, '/api/events?' + query, teamEventPageSchema)
      if (page.items.some((item) => item.projectId !== c.projectId)) throw new DesktopTeamError('BINDING_CHANGED', '同步事件包含其他项目范围')
      await this.store.call({ op: 'sync-cursor', input: { connectionId, cursor: page.cursor, resetRequired: page.resetRequired, hasMore: page.hasMore } })
      return { page, snapshotRequired: page.resetRequired || sync.resetRequired }
    })
  }
  async refreshSharedSnapshot(connectionId: string): Promise<DesktopTeamSnapshot> {
    return this.serial(`sync:${connectionId}`, async () => {
      const c = await this.connection(connectionId, true), sync = await this.store.call<SyncRecord>({ op: 'sync-read', input: connectionId })
      // Establish a catch-up cursor BEFORE reading the snapshot. Subsequent
      // changes are consumed after that point, never skipped by a later head.
      if (sync.resetRequired && !sync.resetCursor) {
        const page = await this.request(c, `/api/events?projectId=${c.projectId}&limit=100`, teamEventPageSchema)
        await this.store.call({ op: 'sync-cursor', input: { connectionId, cursor: page.cursor, resetRequired: true, hasMore: page.hasMore } })
      }
      const items: TeamMaterialVersion[] = []; let cursor: string | undefined
      for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
        const page = await this.listMaterials({ connectionId, limit: 100, ...(cursor ? { cursor } : {}) }); items.push(...page.items)
        if (items.length > 1000 || Buffer.byteLength(JSON.stringify(items)) > 2 * 1024 * 1024) throw new DesktopTeamError('CAPACITY_EXCEEDED', '授权共享快照超过限界，未宣称完整同步')
        if (!page.hasMore) return this.store.call({ op: 'snapshot-save', input: { connectionId, items } })
        if (!page.nextCursor || page.nextCursor === cursor) throw new DesktopTeamError('CURSOR_CONFLICT', '分页游标没有前进')
        cursor = page.nextCursor
      }
      throw new DesktopTeamError('CAPACITY_EXCEEDED', '共享快照分页超过限界')
    })
  }
  async cachedSnapshot(connectionId: string): Promise<DesktopTeamSnapshot | null> { return this.tracked(async () => { await this.connection(connectionId, true); return this.store.call({ op: 'snapshot-read', input: connectionId }) }) }
  async close(): Promise<void> {
    if (this.closed) return
    if (this.closingTask) return this.closingTask
    this.closing = true
    this.closingTask = (async () => { await Promise.allSettled([...this.operations.values(), ...this.inFlight]); await this.store.close(); this.closed = true })()
    try { await this.closingTask } finally { this.closingTask = null }
  }
}
