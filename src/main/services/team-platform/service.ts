import { verifiedCutoverAdmission, originalExecutionCommand } from '../workflow-cutover/admission'
import { shell } from 'electron'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { cruxRemoteCommandSchema, cruxRemoteCommandReplySchema, cruxRemoteSnapshotSchema, type CruxRemoteCommand, type CruxRemoteSnapshot } from '../../../shared/crux-remote'
import { desktopAuthoredPublicationSchema, desktopConnectionIdSchema, desktopDocumentInputSchema, desktopFeedbackInputSchema, desktopFeedbackListSchema, desktopListInputSchema, desktopPairingInputSchema, desktopPublicationBaseSchema, desktopVersionsInputSchema, type DesktopAuthoredPublicationInput, type DesktopFeedbackInput, type DesktopMaterialPublicationInput, type DesktopTeamApi, type DesktopTeamConnection, type DesktopTeamConnectionContext, type DesktopTeamDocument, type DesktopTeamEventSync, type DesktopTeamOutbox, type DesktopTeamOutboxPage, type DesktopTeamPairing, type DesktopTeamSnapshot } from '../../../shared/team-desktop'
import { desktopTeamAccountIdSchema, desktopTeamAuthOptionsSchema, desktopTeamConnectWorkspaceSchema, desktopTeamCreateInvitationSchema, desktopTeamCreatedInvitationSchema, desktopTeamCreatedOrganizationSchema, desktopTeamCreatedWorkspaceSchema, desktopTeamCreateOrganizationSchema, desktopTeamCreateWorkspaceSchema, desktopTeamInvitationAcceptSchema, desktopTeamInvitationSchema, desktopTeamLoginSchema, desktopTeamPageOptionsSchema, desktopTeamRegisterSchema, type DesktopTeamAccount, type DesktopTeamAuthOptions, type DesktopTeamConnectWorkspaceInput, type DesktopTeamCreateInvitationInput, type DesktopTeamCreatedInvitation, type DesktopTeamCreatedOrganization, type DesktopTeamCreatedWorkspace, type DesktopTeamCreateOrganizationInput, type DesktopTeamCreateWorkspaceInput, type DesktopTeamInvitationAcceptInput, type DesktopTeamInvitationInput, type DesktopTeamLoginInput, type DesktopTeamPageOptions, type DesktopTeamRegisterInput } from '../../../shared/team-desktop-account'
import { TEAM_MAX_DOCUMENT_BYTES, TEAM_MAX_REQUEST_BYTES, createTeamProjectSchema, createTeamSchema, deviceApproveInputSchema, deviceEnrollmentInputSchema, publicationInputSchema, teamCommandIdSchema, teamCommandReplySchema, teamDeviceApprovalSchema, teamDeviceEnrollmentSchema, teamDeviceSchema, teamEventPageSchema, teamFeedbackInputSchema, teamFeedbackSchema, teamIdSchema, teamMaterialVersionSchema, teamPageSchema, teamProjectSchema, teamPublishedDocumentSchema, teamSessionSchema, teamTeamSchema, type TeamCommandReply, type TeamMaterialVersion, type TeamPage, type TeamFeedback, type TeamProject, type TeamSession, type TeamTeam } from '../../../shared/team-platform'
import { teamAuthOptionsSchema, teamLocalAuthReplySchema, teamLocalLoginSchema, teamLocalRegisterSchema } from '../../../shared/team-auth'
import { teamInvitationAcceptSchema, teamInvitationCreateSchema, teamInvitationInspectSchema, teamInvitationSchema, teamInvitationTokenSchema, type TeamInvitation } from '../../../shared/team-invitations'
import { protectSecret, revealSecret } from '../integrations/credentials'
import { proxiedFetch } from '../proxy'
import { DesktopTeamStore } from './store-client'
import { canonicalTeamJson, verifyTeamDocument } from './codec'
import { canonicalTeamOrigin, TeamHttp, verificationUrl, type TeamBrowserCredentials, type TeamFetch } from './http'
import { DesktopTeamError, accountRecordSchema, accountSessionEnvelopeSchema, invitationIntentEnvelopeSchema, invitationIntentRecordSchema, publicAccount, publicConnection, publicOutbox, type AccountRecord, type AccountSessionEnvelope, type CachedDocument, type ConnectionRecord, type InvitationIntentEnvelope, type InvitationIntentRecord, type OutboxRecord, type TrustedTeamMaterial } from './types'
import { creationListInputSchema, creationListSchema, creationViewInputSchema, creationViewSchema, creationHeadSchema, creationCommandSchema, creationCommandReplySchema, creationCommandResultSchema, type CreationCommand, type CreationView, type CreationCommandReply, type CreationHead } from '../../../shared/creations'
import { teamCodeResourceListInputSchema, teamCodeResourceListSchema, teamTaskCodeResourceDtoSchema, teamCodeResourceCommandSchema, teamCodeResourceCommandReplySchema, teamCodeResourceReceiptSchema, teamCodeResourceScopeIdSchema, type TeamCodeResourceList, type TeamTaskCodeResourceDto, type TeamCodeResourceCommand, type TeamCodeResourceCommandReply } from '../../../shared/team-code-resources'
import { teamTaskProgressResourceIdSchema, teamTaskProgressCommandSchema, teamTaskProgressCommandReplySchema, teamTaskProgressDtoSchema, teamTaskProgressReceiptSchema, type TeamTaskProgressCommand, type TeamTaskProgressDto, type TeamTaskProgressCommandReply, type TeamTaskProgressReceipt } from '../../../shared/team-task-progress'
import { writeBusinessHookCredential, writeTaskProgressCredential, NativeTaskProgressSender } from '../crux/task-progress-sender'
import type { TaskProgressPin } from '../../../shared/crux-task-progress-native'
import { TaskMaterialsTransport, taskMaterialTransportPinSchema, type TaskMaterialTransportPin } from './task-materials-transport'
import { GovernanceTransport, governanceTransportPinSchema, type GovernanceTransportPin } from './governance-transport'
import { nativeContentPinSchema, type NativeContentPin } from './content-transport'
import type { TeamContentRequest } from '../../../shared/team-content-transport'
import { teamTaskDevelopmentContextSchema, type TeamTaskDevelopmentContext } from '../../../shared/team-task-development'
import { desktopExecutionScopeSchema, desktopExecutionCommandSchema, desktopExecutionHistorySchema, desktopExecutionIntentSchema, desktopExecutionPendingInputSchema, desktopExecutionPendingPageSchema, teamTaskIdentity } from '../../../shared/team-task-execution'
import { executionInputCommandSchema, executionInputSelectionIdSchema, executionInputResourceViewSchema, type ExecutionInputView } from '../../../shared/team-execution-input'
import { TaskExecutionTransport } from './task-execution-transport'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const lockedCodes = new Set(['UNAUTHENTICATED', 'UNAUTHORIZED', 'FORBIDDEN', 'DEVICE_REVOKED', 'ACCOUNT_DISABLED', 'AUTHENTICATION_REQUIRED', 'CREDENTIAL_UNAVAILABLE', 'BINDING_CHANGED'])
const TEAM_AUTH_COOKIE = 'tp_team_auth'
const TEAM_SESSION_COOKIE = 'tp_team_session'
const CONNECT_WAIT_MS = 30_000
const logoutReplySchema = z.object({ loggedOut: z.literal(true) }).strict()
const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))
function responseCookie(setCookies: string[], name: string, valueSchema: z.ZodType<string>): string {
  const prefix = `${name}=`, matches: string[] = []
  for (const header of setCookies) {
    const pair = header.split(';', 1)[0]?.trim()
    if (pair?.startsWith(prefix)) matches.push(pair)
  }
  const pair = matches.length === 1 ? matches[0] : undefined
  if (!pair) throw new DesktopTeamError('INVALID_RESPONSE', '团队认证响应没有唯一的受保护会话 cookie')
  valueSchema.parse(pair.slice(prefix.length))
  return pair
}
type SyncRecord = { cursor: string | null; resetRequired: boolean; resetCursor: string | null; hasMore: boolean; snapshot: { items: TeamMaterialVersion[]; fetchedAt: number } | null }
export type DesktopTeamOptions = {
  dataDir: string; workerFile?: string; requestTimeoutMs?: number; httpTimeoutMs?: number; allowLoopbackHttp?: boolean;
  /** Main-only adapters; never accept these from IPC/renderer input. */
  protectSecret?: (value: string) => string; revealSecret?: (value: string) => string;
  openExternal?: (url: string) => Promise<void>; fetch?: TeamFetch
}
export class DesktopTeamService implements DesktopTeamApi {
  private async withExecution<T>(raw: z.infer<typeof desktopExecutionScopeSchema>, action: (transport: TaskExecutionTransport, c: ConnectionRecord) => Promise<T>): Promise<T> {
    return this.tracked(async () => {
      const input = desktopExecutionScopeSchema.parse(raw), c = await this.connection(input.connectionId, true)
      if (c.projectId !== input.task.projectId || !c.ownerId) throw new DesktopTeamError('BINDING_CHANGED', '原执行项目或账号已变化')
      await this.verifyActive(c)
      const original = canonicalTeamJson([c.origin, c.pairingId, c.deviceId, c.ownerId, c.projectId])
      const check = async (): Promise<void> => {
        const current = await this.connection(input.connectionId, true)
        if (canonicalTeamJson([current.origin, current.pairingId, current.deviceId, current.ownerId, current.projectId]) !== original) throw new DesktopTeamError('BINDING_CHANGED', '原执行连接已变化')
      }
      return action(new TaskExecutionTransport(input.task, c.ownerId, c.deviceId, async (path, schema, body) => {
        await check()
        const result = await this.request(c, path, schema, body)
        try { await check(); await this.verifyActive(c) }
        catch { throw new DesktopTeamError('BINDING_CHANGED', '请求期间原执行身份变化，请核对原命令', body !== undefined) }
        return result
      }), c)
    })
  }
  async executionRead(raw: z.infer<typeof desktopExecutionScopeSchema>): ReturnType<DesktopTeamApi['executionRead']> {
    return this.withExecution(desktopExecutionScopeSchema.parse(raw), transport => transport.read())
  }
  async executionHistory(raw: z.infer<typeof desktopExecutionHistorySchema>): ReturnType<DesktopTeamApi['executionHistory']> {
    const input = desktopExecutionHistorySchema.parse(raw)
    return this.withExecution({ connectionId: input.connectionId, task: input.task }, transport => transport.history(input.executionId))
  }
  /** Main-only capture through the original authenticated connection and retained command UUID. */
  async executionInputCapture(raw: { connectionId: string; task: z.infer<typeof desktopExecutionScopeSchema>['task']; command: z.infer<typeof executionInputCommandSchema> }): ReturnType<TaskExecutionTransport['captureInput']> {
    const input = desktopExecutionScopeSchema.extend({ command: executionInputCommandSchema }).strict().parse(raw)
    if (teamTaskIdentity(input.task) !== teamTaskIdentity(input.command.task)) throw new DesktopTeamError('EXECUTION_SCOPE_CONFLICT', 'Fixed input capture differs from the original task')
    return this.serial(`execution-input:${input.command.commandId}`, () => this.withExecution({ connectionId: input.connectionId, task: input.task }, transport => transport.captureInput(input.command)))
  }
  /** Main-only read of an already captured input, under the original execution connection. */
  async executionInputRead(raw: z.infer<typeof desktopExecutionHistorySchema> & { selectionId?: string }): Promise<ExecutionInputView | z.infer<typeof executionInputResourceViewSchema>> {
    const input = desktopExecutionHistorySchema.extend({ selectionId: executionInputSelectionIdSchema.optional() }).strict().parse(raw)
    return this.withExecution({ connectionId: input.connectionId, task: input.task }, async transport => {
      const source = transport.inputSource(input.executionId), view = await source.read()
      return input.selectionId === undefined ? view : source.readResource(input.selectionId)
    })
  }
  async executionPending(raw: z.input<typeof desktopExecutionPendingInputSchema>): ReturnType<DesktopTeamApi['executionPending']> {
    const input = desktopExecutionPendingInputSchema.parse(raw)
    return this.withExecution({ connectionId: input.connectionId, task: input.task }, async transport => {
      await transport.read()
      const page = desktopExecutionPendingPageSchema.parse(await this.store.call({ op: 'execution-pending', input }))
      if (page.connectionId !== input.connectionId || teamTaskIdentity(page.task) !== teamTaskIdentity(input.task)) throw new DesktopTeamError('EXECUTION_SCOPE_CONFLICT', '执行恢复页不属于原连接或任务')
      return page
    })
  }
  async executionCommand(raw: z.infer<typeof desktopExecutionCommandSchema>): ReturnType<DesktopTeamApi['executionCommand']> {
    const input = desktopExecutionCommandSchema.parse(raw)
    if (teamTaskIdentity(input.task) !== teamTaskIdentity(input.command.task)) throw new DesktopTeamError('EXECUTION_SCOPE_CONFLICT', '原执行命令与调用目标不一致')
    return this.serial(`execution:${input.command.commandId}`, () => this.withExecution({ connectionId: input.connectionId, task: input.task }, async (transport, c) => {
      const binding = { origin: c.origin, pairingId: c.pairingId, deviceId: c.deviceId, projectId: c.projectId, ownerId: c.ownerId }
      const previous = desktopExecutionIntentSchema.nullable().parse(await this.store.call({ op: 'execution-intent', input: { connectionId: input.connectionId, commandId: input.command.commandId } }))
      // Persist the exact original intent before transmission; retries are explicit calls only.
      const command = previous ? originalExecutionCommand(input.command, previous.command) : input.command
      if (!previous && command.kind === 'claim') {
        const proof = await verifiedCutoverAdmission(this.options.dataDir, input.task, c.ownerId ?? '', c.deviceId ?? '', transport.cutover(), { productClaim: command.ownership === 'product-managed' })
        if (command.cutoverAdmission && (!proof || canonicalTeamJson(command.cutoverAdmission) !== canonicalTeamJson(proof))) throw new DesktopTeamError('CUTOVER_CHANGED', 'Supplied claim proof differs from the verified original installation')
        if (proof) command.cutoverAdmission = proof
      }
      const record = desktopExecutionIntentSchema.parse({ connectionId: input.connectionId, command, state: previous?.receipt ? 'committed' : 'dispatching', receipt: previous?.receipt ?? null, updatedAt: Date.now() })
      await this.store.call({ op: 'save-execution-intent', input: { record, binding } })
      let dispatched = false
      try {
        if (previous) {
          const receipt = await transport.reconcile(command)
          if (receipt) {
            await this.store.call({ op: 'save-execution-intent', input: { record: { ...record, state: 'committed', receipt, updatedAt: Date.now() }, binding } })
            return { status: 'duplicate', commandId: command.commandId, result: receipt }
          }
          // An explicit retry may resend the exact retained UUID/body to the idempotent server.
          // Fresh claim admission must still match its saved proof; never rebuild the command.
          if (command.kind === 'claim') {
            const proof = await verifiedCutoverAdmission(this.options.dataDir, input.task, c.ownerId ?? '', c.deviceId ?? '', transport.cutover(), { productClaim: command.ownership === 'product-managed' })
            if (canonicalTeamJson(command.cutoverAdmission ?? null) !== canonicalTeamJson(proof)) throw new DesktopTeamError('CUTOVER_CHANGED', 'Original claim proof no longer matches the current verified activation')
          }
        }
        dispatched = true
        const reply = await transport.command(command)
        try { await this.store.call({ op: 'save-execution-intent', input: { record: { ...record, state: 'committed', receipt: reply.result, updatedAt: Date.now() }, binding } }) }
        catch { throw new DesktopTeamError('ACKNOWLEDGEMENT_UNKNOWN', '服务端已提交，但本地回执保存失败，请核对原命令', true) }
        return reply
      } catch (error) {
        const unknown = error instanceof DesktopTeamError && error.outcomeUnknown
          || !dispatched && !!previous && ['dispatching', 'acknowledgement-unknown'].includes(previous.state)
        await this.store.call({ op: 'save-execution-intent', input: { record: { ...record, state: record.receipt ? 'committed' : unknown ? 'acknowledgement-unknown' : 'rejected', updatedAt: Date.now() }, binding } }).catch(() => {})
        throw error
      }
    }))
  }
  /** Read-only editor probe; independent MCP has no directory path grant. */
  async cutoverCheck(raw: z.infer<typeof desktopExecutionScopeSchema>): Promise<{ admitted: boolean; operationId: string | null; task: z.infer<typeof desktopExecutionScopeSchema>['task'] }> {
    const input = desktopExecutionScopeSchema.parse(raw)
    return this.withExecution(input, async (transport, c) => {
      if (!c.deviceId) throw new DesktopTeamError('BINDING_CHANGED', 'Cutover check requires the original authorized device')
      const proof = await verifiedCutoverAdmission(this.options.dataDir, input.task, c.ownerId ?? '', c.deviceId, transport.cutover())
      return { admitted: true, operationId: proof?.operationId ?? null, task: input.task }
    })
  }
  async executionReconcile(raw: z.infer<typeof desktopExecutionCommandSchema>): ReturnType<DesktopTeamApi['executionReconcile']> {
    const input = desktopExecutionCommandSchema.parse(raw)
    if (teamTaskIdentity(input.task) !== teamTaskIdentity(input.command.task)) throw new DesktopTeamError('EXECUTION_SCOPE_CONFLICT', '原执行命令与调用目标不一致')
    return this.withExecution({ connectionId: input.connectionId, task: input.task }, async (transport, c) => {
      const previous = desktopExecutionIntentSchema.nullable().parse(await this.store.call({ op: 'execution-intent', input: { connectionId: input.connectionId, commandId: input.command.commandId } }))
      const command = previous ? originalExecutionCommand(input.command, previous.command) : input.command
      const receipt = await transport.reconcile(command)
      if (receipt) await this.store.call({ op: 'save-execution-intent', input: {
        record: { connectionId: input.connectionId, command, state: 'committed', receipt, updatedAt: Date.now() },
        binding: { origin: c.origin, pairingId: c.pairingId, deviceId: c.deviceId, projectId: c.projectId, ownerId: c.ownerId }
      } })
      return receipt
    })
  }
  /** Main-only content transport; the original device and selection are checked around every request. */
  async withContentTransport<T>(raw: NativeContentPin, assertCurrent: () => Promise<void>, action: (request: TeamContentRequest) => Promise<T>): Promise<T> {
    return this.tracked(async () => {
      const pin = nativeContentPinSchema.parse(raw)
      const connection = async (): Promise<ConnectionRecord> => {
        const c = await this.connection(pin.connectionId, true)
        if (c.origin !== pin.origin || c.ownerId !== pin.actorId || c.projectId !== pin.projectId || c.deviceId !== pin.deviceId || c.pairingId !== pin.pairingId) throw new DesktopTeamError('BINDING_CHANGED', '原内容操作的账号、设备或项目已变化。')
        return c
      }
      await assertCurrent()
      const c = await connection()
      await this.verifyActive(c)
      return action(async (path, schema, body, validate) => {
        await connection(); await assertCurrent()
        const value = await this.request(c, path, schema, body)
        try { await connection(); await assertCurrent(); validate?.(value) }
        catch (error) { throw new DesktopTeamError(error instanceof DesktopTeamError ? error.code : 'CONTENT_RESPONSE_MISMATCH', '原内容身份或回复在请求期间变化，请核对原操作。', body !== undefined) }
        return value
      })
    })
  }
  /** Main-owned governance routes keep the admitted original device and selection fence. */
  async withGovernanceTransport<T>(raw: GovernanceTransportPin, assertCurrent: () => Promise<void>, action: (transport: GovernanceTransport) => Promise<T>): Promise<T> {
    return this.tracked(async () => {
      const pin = governanceTransportPinSchema.parse(raw)
      const connection = async (): Promise<ConnectionRecord> => {
        const c = await this.connection(pin.connectionId, true)
        if (c.origin !== pin.origin || c.ownerId !== pin.actorId || c.projectId !== pin.projectId || c.deviceId !== pin.deviceId || c.pairingId !== pin.pairingId) throw new DesktopTeamError('BINDING_CHANGED', '规则与任务输入的原账号或设备已变化。')
        return c
      }
      await assertCurrent()
      const c = await connection()
      await this.verifyActive(c)
      return action(new GovernanceTransport(pin, async (path, schema, body) => {
        await connection(); await assertCurrent()
        const value = await this.request(c, path, schema, body)
        try { await connection(); await assertCurrent() }
        catch { throw new DesktopTeamError('BINDING_CHANGED', '原身份在请求期间变化，请回原来源核对命令。', body !== undefined) }
        return value
      }))
    })
  }
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
  /** GUI-authorized project identity for background business Hook effects. */
  async authorizeBusinessHook(connectionId: string): Promise<void> {
    return this.tracked(async () => {
      const c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const snapshot = await this.request(c, `/api/projects/${c.projectId}/crux/snapshot`, cruxRemoteSnapshotSchema)
      await this.verifyCruxSnapshot(c, snapshot)
      writeBusinessHookCredential(this.options.dataDir, c, this.token(c), this.protection, this.reveal, { instanceId: snapshot.instanceId, epoch: snapshot.epoch })
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
  private async account(accountId: string, active = false): Promise<AccountRecord> {
    const record = accountRecordSchema.parse(await this.store.call({ op: 'account', input: desktopTeamAccountIdSchema.parse(accountId) }))
    if (active && record.state !== 'active') throw new DesktopTeamError('ACCOUNT_SESSION_UNAVAILABLE', '原桌面账号需要重新登录')
    if (active) this.accountSession(record)
    return record
  }
  private accountSession(account: AccountRecord): AccountSessionEnvelope {
    if (account.state !== 'active' || account.encryptedSession === null) throw new DesktopTeamError('ACCOUNT_SESSION_UNAVAILABLE', '原桌面账号需要重新登录')
    try {
      const value = accountSessionEnvelopeSchema.parse(JSON.parse(this.reveal(account.encryptedSession)))
      if (value.accountId !== account.accountId || value.origin !== account.origin || value.userId !== account.person.userId) throw new Error('Account session tuple changed')
      return value
    } catch { throw new DesktopTeamError('CREDENTIAL_UNAVAILABLE', '原桌面账号会话无法由系统凭据库解密，请重新登录') }
  }
  private async accountRequest<T extends z.ZodType>(account: AccountRecord, path: string, schema: T, body?: unknown, outcomeUnknown = body !== undefined): Promise<z.output<T>> {
    const secret = this.accountSession(account), credentials: TeamBrowserCredentials = { cookie: secret.cookie, csrfToken: secret.csrfToken }
    const value = await this.http.browserRequest(account.origin, path, schema, credentials, body, outcomeUnknown)
    let current: AccountRecord
    try { current = await this.account(account.accountId) }
    catch (error) {
      if (!outcomeUnknown) throw error
      throw new DesktopTeamError(error instanceof DesktopTeamError ? error.code : 'STORE_UNAVAILABLE', '团队写入已返回，但原桌面账号会话无法完成本地复核；请按原命令核对', true)
    }
    if (current.revision !== account.revision || current.encryptedSession !== account.encryptedSession || current.origin !== account.origin || current.person.userId !== account.person.userId) throw new DesktopTeamError('ACCOUNT_CHANGED', '桌面账号会话在请求期间变化，请核对原操作', outcomeUnknown)
    return value
  }
  private async authChallenge(origin: string): Promise<{ options: z.infer<typeof teamAuthOptionsSchema>; credentials: TeamBrowserCredentials }> {
    const reply = await this.http.authOptions(origin, teamAuthOptionsSchema)
    const cookie = responseCookie(reply.setCookies, TEAM_AUTH_COOKIE, z.string().regex(/^[A-Za-z0-9_-]{43}$/))
    if (cookie !== `${TEAM_AUTH_COOKIE}=${reply.value.csrfToken}`) throw new DesktopTeamError('INVALID_RESPONSE', '团队登录挑战 cookie 与 CSRF 回执不一致')
    return { options: reply.value, credentials: { cookie, csrfToken: reply.value.csrfToken } }
  }
  async authOptions(rawOrigin: string): Promise<DesktopTeamAuthOptions> {
    return this.tracked(async () => {
      const origin = canonicalTeamOrigin(z.string().min(1).max(2048).parse(rawOrigin), this.options.allowLoopbackHttp)
      const { options } = await this.authChallenge(origin)
      return desktopTeamAuthOptionsSchema.parse({
        origin,
        localLogin: options.localLogin,
        selfRegistration: options.selfRegistration,
        supportsInitialTaskTypes: options.supportsInitialTaskTypes,
        externalLogin: options.oidcLogin ? { browserRequired: true, label: options.oidcLabel, url: new URL('/auth/login', origin).href } : null
      })
    })
  }
  async accounts(): Promise<DesktopTeamAccount[]> {
    return this.tracked(async () => {
      const records = z.array(accountRecordSchema).max(50).parse(await this.store.call({ op: 'accounts' }))
      return records.map((record) => {
        if (record.state !== 'active') return publicAccount(record)
        try { this.accountSession(record); return publicAccount(record) }
        catch (error) {
          return { ...publicAccount(record), state: 'reauthentication-required', lastErrorCode: error instanceof DesktopTeamError ? error.code : 'CREDENTIAL_UNAVAILABLE' }
        }
      })
    })
  }
  private async completeLocalAuth(operation: 'login' | 'register', origin: string, body: z.infer<typeof teamLocalLoginSchema> | z.infer<typeof teamLocalRegisterSchema>): Promise<DesktopTeamAccount> {
    const challenge = await this.authChallenge(origin)
    if (operation === 'register' && !challenge.options.selfRegistration) throw new DesktopTeamError('REGISTRATION_DISABLED', '此团队服务未开放自主注册')
    const reply = await this.http.localAuth(origin, operation, teamLocalAuthReplySchema, challenge.credentials, body)
    if (reply.value.session.authentication !== 'browser' || reply.value.session.csrfToken === null || !reply.value.session.person.active) throw new DesktopTeamError('INVALID_RESPONSE', '本地登录没有返回可用的浏览器账号会话', true)
    const cookie = responseCookie(reply.setCookies, TEAM_SESSION_COOKIE, z.string().regex(/^ts_[A-Za-z0-9_-]{43}$/))
    const records = z.array(accountRecordSchema).max(50).parse(await this.store.call({ op: 'accounts' }))
    const existing = records.find((item) => item.origin === origin && item.person.userId === reply.value.session.person.userId)
    const accountId = existing?.accountId ?? randomUUID(), now = Date.now(), revision = existing ? existing.revision + 1 : 1
    if (!Number.isSafeInteger(revision)) throw new DesktopTeamError('CAPACITY_EXCEEDED', '桌面账号版本已达限界')
    let encryptedSession: string
    try {
      encryptedSession = this.protection(JSON.stringify(accountSessionEnvelopeSchema.parse({ version: 1, accountId, origin, userId: reply.value.session.person.userId, cookie, csrfToken: reply.value.session.csrfToken })))
    } catch { throw new DesktopTeamError('CREDENTIAL_UNAVAILABLE', '系统凭据加密不可用，账号会话未保存；请恢复系统加密后重试') }
    const record = accountRecordSchema.parse({
      accountId,
      origin,
      person: reply.value.session.person,
      state: 'active',
      revision,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastVerifiedAt: now,
      lastErrorCode: null,
      encryptedSession
    })
    return publicAccount(accountRecordSchema.parse(await this.store.call({ op: 'save-account', input: { record, expectedRevision: existing?.revision ?? null } })))
  }
  async login(raw: DesktopTeamLoginInput): Promise<DesktopTeamAccount> {
    return this.tracked(async () => {
      const input = desktopTeamLoginSchema.parse(raw), origin = canonicalTeamOrigin(input.origin, this.options.allowLoopbackHttp)
      const body = teamLocalLoginSchema.parse({ username: input.username, password: input.password })
      return this.serial(`account-auth:${origin}`, () => this.completeLocalAuth('login', origin, body))
    })
  }
  async register(raw: DesktopTeamRegisterInput): Promise<DesktopTeamAccount> {
    return this.tracked(async () => {
      const input = desktopTeamRegisterSchema.parse(raw), origin = canonicalTeamOrigin(input.origin, this.options.allowLoopbackHttp)
      const body = teamLocalRegisterSchema.parse({ username: input.username, password: input.password, displayName: input.displayName })
      return this.serial(`account-auth:${origin}`, () => this.completeLocalAuth('register', origin, body))
    })
  }
  async logout(accountId: string): Promise<DesktopTeamAccount> {
    return this.serial(`account:${desktopTeamAccountIdSchema.parse(accountId)}`, async () => {
      const account = await this.account(accountId, true)
      await this.accountRequest(account, '/auth/logout', logoutReplySchema, {}, true)
      const now = Date.now(), record = accountRecordSchema.parse({ ...account, state: 'signed-out', encryptedSession: null, revision: account.revision + 1, updatedAt: now, lastVerifiedAt: now, lastErrorCode: null })
      return publicAccount(accountRecordSchema.parse(await this.store.call({ op: 'save-account', input: { record, expectedRevision: account.revision } })))
    })
  }
  private pagePath(path: string, raw: DesktopTeamPageOptions | undefined): string {
    const options = desktopTeamPageOptionsSchema.parse(raw ?? {}), query = new URLSearchParams({ limit: String(options.limit) })
    if (options.cursor) query.set('cursor', options.cursor)
    return `${path}?${query}`
  }
  async organizations(accountId: string, options?: DesktopTeamPageOptions): Promise<TeamPage<TeamTeam>> {
    return this.tracked(async () => {
      const account = await this.account(accountId, true)
      return this.accountRequest(account, this.pagePath('/api/teams', options), teamPageSchema(teamTeamSchema), undefined, false)
    })
  }
  async createOrganization(raw: DesktopTeamCreateOrganizationInput): Promise<TeamCommandReply<DesktopTeamCreatedOrganization>> {
    return this.tracked(async () => {
      const input = desktopTeamCreateOrganizationSchema.parse(raw), account = await this.account(input.accountId, true)
      const body = createTeamSchema.parse({ commandId: input.commandId, name: input.name })
      const result = await this.accountRequest(account, '/api/teams', teamCommandReplySchema(desktopTeamCreatedOrganizationSchema), body, true)
      if (result.commandId !== input.commandId) throw new DesktopTeamError('RECEIPT_MISMATCH', '组织创建回执不属于原命令', true)
      return result
    })
  }
  async workspaces(accountId: string, options?: DesktopTeamPageOptions): Promise<TeamPage<TeamProject>> {
    return this.tracked(async () => {
      const account = await this.account(accountId, true)
      return this.accountRequest(account, this.pagePath('/api/projects', options), teamPageSchema(teamProjectSchema), undefined, false)
    })
  }
  async createWorkspace(raw: DesktopTeamCreateWorkspaceInput): Promise<TeamCommandReply<DesktopTeamCreatedWorkspace>> {
    return this.tracked(async () => {
      const input = desktopTeamCreateWorkspaceSchema.parse(raw), account = await this.account(input.accountId, true)
      const body = createTeamProjectSchema.parse({ commandId: input.commandId, teamId: input.organizationId, name: input.name })
      const result = await this.accountRequest(account, '/api/projects', teamCommandReplySchema(desktopTeamCreatedWorkspaceSchema), body, true)
      if (result.commandId !== input.commandId || result.result.teamId !== input.organizationId) throw new DesktopTeamError('RECEIPT_MISMATCH', '工作区创建回执不属于原组织或命令', true)
      return result
    })
  }
  async createInvitation(raw: DesktopTeamCreateInvitationInput): Promise<DesktopTeamCreatedInvitation> {
    return this.tracked(async () => {
      const input = desktopTeamCreateInvitationSchema.parse(raw), account = await this.account(input.accountId, true)
      const payloadDigest = hash(canonicalTeamJson(input))
      let intent = await this.store.call<InvitationIntentRecord | null>({ op: 'invitation-intent', input: input.commandId })
      let workspace: TeamProject | null = null
      if (intent === null) {
        workspace = await this.workspaceForAccount(account, input.workspaceId)
        const envelope = invitationIntentEnvelopeSchema.parse({ version: 1, commandId: input.commandId, accountId: account.accountId, origin: account.origin, input, token: `ti_${randomBytes(32).toString('base64url')}` })
        let encryptedIntent: string
        try { encryptedIntent = this.protection(JSON.stringify(envelope)) }
        catch { throw new DesktopTeamError('CREDENTIAL_UNAVAILABLE', '系统凭据加密不可用，邀请密钥未保存且邀请未发送') }
        const now = Date.now()
        intent = invitationIntentRecordSchema.parse({ commandId: input.commandId, accountId: account.accountId, origin: account.origin, payloadDigest, encryptedIntent, createdAt: now, updatedAt: now, receipt: null })
        intent = invitationIntentRecordSchema.parse(await this.store.call({ op: 'save-invitation-intent', input: intent }))
      }
      if (intent.accountId !== account.accountId || intent.origin !== account.origin || intent.payloadDigest !== payloadDigest) throw new DesktopTeamError('COMMAND_CONFLICT', '同一邀请命令不能更换账号或语义载荷')
      let envelope: InvitationIntentEnvelope
      try {
        envelope = invitationIntentEnvelopeSchema.parse(JSON.parse(this.reveal(intent.encryptedIntent)))
        if (envelope.commandId !== input.commandId || envelope.accountId !== account.accountId || envelope.origin !== account.origin || canonicalTeamJson(envelope.input) !== canonicalTeamJson(input)) throw new Error('Invitation intent tuple changed')
      } catch { throw new DesktopTeamError('CREDENTIAL_UNAVAILABLE', '原邀请密钥无法由系统凭据库解密；不会生成第二条邀请') }
      workspace = workspace ?? await this.workspaceForAccount(account, input.workspaceId)
      const body = teamInvitationCreateSchema.parse({
        commandId: input.commandId,
        teamId: workspace.teamId,
        projectId: workspace.projectId,
        ...(input.spaceId ? { spaceId: input.spaceId } : {}),
        teamRoles: input.organizationRoles,
        projectRoles: input.projectRoles,
        recipient: { kind: 'local', username: input.recipientUsername },
        token: envelope.token,
        expiresInMs: input.expiresInMs
      })
      const result = await this.accountRequest(account, '/api/invitations', teamCommandReplySchema(teamInvitationSchema), body, true)
      const invitation = result.result
      const sameSpace = invitation.space?.id === (input.spaceId ?? undefined)
      const sameOrganizationRoles = canonicalTeamJson(invitation.teamRoles) === canonicalTeamJson(input.organizationRoles)
      const sameProjectRoles = canonicalTeamJson(invitation.projectRoles) === canonicalTeamJson(input.projectRoles)
      if (result.commandId !== input.commandId || invitation.teamId !== workspace.teamId || invitation.projectId !== workspace.projectId || invitation.status !== 'pending' || invitation.recipient.kind !== 'local' || invitation.recipient.username !== input.recipientUsername || !sameSpace || !sameOrganizationRoles || !sameProjectRoles) throw new DesktopTeamError('RECEIPT_MISMATCH', '邀请创建回执不属于原账号、角色、工作区或接收方', true)
      try { intent = invitationIntentRecordSchema.parse(await this.store.call({ op: 'complete-invitation-intent', input: { commandId: input.commandId, receipt: invitation } })) }
      catch { throw new DesktopTeamError('ACKNOWLEDGEMENT_UNKNOWN', '邀请已由服务端提交，但本地加密意图确认丢失；请使用同一命令重试核对', true) }
      if (!intent.receipt || intent.receipt.invitationId !== invitation.invitationId) throw new DesktopTeamError('RECEIPT_MISMATCH', '本地邀请意图没有保存原提交回执', true)
      const url = new URL('/', account.origin)
      url.searchParams.set('invitation', invitation.invitationId)
      url.hash = new URLSearchParams({ token: envelope.token }).toString()
      return desktopTeamCreatedInvitationSchema.parse({ invitation, url: url.href })
    })
  }
  private invitationLink(account: AccountRecord, raw: string): { invitationId: string; token: string } {
    let url: URL
    try { url = new URL(raw) } catch { throw new DesktopTeamError('INVALID_INVITATION_LINK', '邀请链接格式无效') }
    const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : '')
    if (url.origin !== account.origin || url.username || url.password || url.pathname !== '/' || url.searchParams.size !== 1 || fragment.size !== 1) throw new DesktopTeamError('INVALID_INVITATION_LINK', '邀请链接必须属于原账号服务且不含额外参数')
    const invitationId = teamIdSchema.safeParse(url.searchParams.get('invitation')), token = teamInvitationTokenSchema.safeParse(fragment.get('token'))
    if (!invitationId.success || !token.success) throw new DesktopTeamError('INVALID_INVITATION_LINK', '邀请链接缺少有效的邀请身份或密钥')
    return { invitationId: invitationId.data, token: token.data }
  }
  async inspectInvitation(raw: DesktopTeamInvitationInput): Promise<TeamInvitation> {
    return this.tracked(async () => {
      const input = desktopTeamInvitationSchema.parse(raw), account = await this.account(input.accountId, true), link = this.invitationLink(account, input.url)
      const invitation = await this.accountRequest(account, `/api/invitations/${encodeURIComponent(link.invitationId)}/inspect`, teamInvitationSchema, teamInvitationInspectSchema.parse({ token: link.token }), false)
      if (invitation.invitationId !== link.invitationId) throw new DesktopTeamError('RECEIPT_MISMATCH', '邀请检查回执不属于原链接')
      return invitation
    })
  }
  async acceptInvitation(raw: DesktopTeamInvitationAcceptInput): Promise<TeamCommandReply<TeamInvitation>> {
    return this.tracked(async () => {
      const input = desktopTeamInvitationAcceptSchema.parse(raw), account = await this.account(input.accountId, true), link = this.invitationLink(account, input.url)
      const inspected = await this.accountRequest(account, `/api/invitations/${encodeURIComponent(link.invitationId)}/inspect`, teamInvitationSchema, teamInvitationInspectSchema.parse({ token: link.token }), false)
      if (inspected.invitationId !== link.invitationId) throw new DesktopTeamError('RECEIPT_MISMATCH', '邀请检查回执不属于原链接')
      const body = teamInvitationAcceptSchema.parse({ commandId: input.commandId, token: link.token, expectedUserId: account.person.userId, expectedTeamId: inspected.teamId, expectedProjectId: inspected.projectId, ...(inspected.space ? { expectedSpaceId: inspected.space.id } : {}) })
      const result = await this.accountRequest(account, `/api/invitations/${encodeURIComponent(link.invitationId)}/accept`, teamCommandReplySchema(teamInvitationSchema), body, true)
      if (result.commandId !== input.commandId || result.result.invitationId !== link.invitationId || result.result.status !== 'accepted' || result.result.acceptedBy !== account.person.userId) throw new DesktopTeamError('RECEIPT_MISMATCH', '邀请接受回执不属于原账号或命令', true)
      return result
    })
  }
  private async noteError(c: ConnectionRecord, error: unknown, path?: string): Promise<void> {
    if (!(error instanceof DesktopTeamError)) return
    let lock = lockedCodes.has(error.code)
    // These domains keep no generic published-document body cache. A denied
    // private draft/space operation must not revoke an otherwise active device.
    const contentScoped = path !== undefined && (/^\/api\/teams\/[^/]+\/content(?:[/?]|$)/.test(path) || /^\/api\/projects\/[^/]+\/(?:content(?:[/?]|$)|crux\/tasks\/[^/]+\/content(?:[/?]|$))/.test(path))
    const scoped = contentScoped || path !== undefined && /^\/api\/projects\/[^/]+\/crux\/(?:tasks\/[^/]+\/(?:materials|inputs|executions|code-resource|development-context)|spaces\/[^/]+\/governance|code-resources)(?:[/?]|$)/.test(path)
    if (error.code === 'FORBIDDEN' && scoped) {
      try {
        const session = await this.http.request(c.origin, '/api/session', teamSessionSchema, this.token(c))
        lock = session.authentication !== 'device' || session.deviceId !== c.deviceId || session.person.userId !== c.ownerId || !session.person.active
      } catch (probe) {
        lock = probe instanceof DesktopTeamError && ['UNAUTHORIZED', 'FORBIDDEN', 'CREDENTIAL_UNAVAILABLE'].includes(probe.code)
      }
    }
    await this.store.call({ op: 'update-connection', input: { connectionId: c.connectionId, ...(lock ? { lock: true, ...(error.code === 'CREDENTIAL_UNAVAILABLE' ? { revokeOutbox: false } : {}) } : {}), ...(error.code === 'NETWORK_UNAVAILABLE' || error.code === 'ACKNOWLEDGEMENT_UNKNOWN' ? { network: 'offline' } : {}), errorCode: error.code } })
    if (lock) writeBusinessHookCredential(this.options.dataDir, c, null, this.protection)
  }
  private async request<T extends z.ZodType>(c: ConnectionRecord, path: string, schema: T, body?: unknown): Promise<z.output<T>> {
    try {
      const value = await this.http.request(c.origin, path, schema, this.token(c), body)
      // Do not insert a secondary metadata write between a committed remote POST
      // and its authoritative outbox settlement. Read/probe success updates reachability.
      if (body === undefined) await this.store.call({ op: 'update-connection', input: { connectionId: c.connectionId, network: 'reachable', errorCode: null } })
      return value
    }
    catch (error) { await this.noteError(c, error, path); throw error }
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
  /** Main-only fixed material routes, retaining the captured device and native selection fence. */
  async withTaskMaterialsTransport<T>(raw: TaskMaterialTransportPin, assertCurrent: () => Promise<void>, action: (transport: TaskMaterialsTransport) => Promise<T>): Promise<T> {
    return this.tracked(async () => {
      const pin = taskMaterialTransportPinSchema.parse(raw)
      const connection = async (): Promise<ConnectionRecord> => {
        const c = await this.connection(pin.connectionId, true)
        if (c.origin !== pin.origin || c.ownerId !== pin.actorId || c.projectId !== pin.projectId || c.deviceId !== pin.deviceId || c.pairingId !== pin.pairingId) {
          throw new DesktopTeamError('BINDING_CHANGED', '原任务材料的账号、设备或项目已变化。')
        }
        return c
      }
      await assertCurrent()
      const c = await connection()
      await this.verifyActive(c)
      return action(new TaskMaterialsTransport(pin, async (path, schema, body) => {
        await connection()
        await assertCurrent()
        const value = await this.request(c, path, schema, body)
        // A POST may already be committed when selection or device ownership changes.
        try { await connection(); await assertCurrent() }
        catch (error) { throw new DesktopTeamError(error instanceof DesktopTeamError ? error.code : 'BINDING_CHANGED', '原材料身份在请求期间变化，请回原身份核对命令。', body !== undefined) }
        return value
      }))
    })
  }
  private async verifyCruxSnapshot(c: ConnectionRecord, value: CruxRemoteSnapshot, write = false, expectedInstanceId?: string): Promise<CruxRemoteSnapshot> {
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
  async cruxSnapshot(connectionId: string, options: { afterRevision?: number; waitMs?: number; expectedInstanceId?: string } = {}): Promise<CruxRemoteSnapshot> {
    return this.tracked(async () => {
      const input = z.object({ afterRevision: z.number().int().nonnegative().safe().optional(), waitMs: z.number().int().min(0).max(8000).optional(), expectedInstanceId: z.string().uuid().optional() }).strict().parse(options)
      const c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const query = new URLSearchParams()
      if (input.afterRevision !== undefined) query.set('afterRevision', String(input.afterRevision))
      if (input.waitMs !== undefined) query.set('waitMs', String(input.waitMs))
      const value = await this.request(c, `/api/projects/${c.projectId}/crux/snapshot${query.size ? '?' + query : ''}`, cruxRemoteSnapshotSchema)
      // Revision ordering belongs to one instance/epoch. The coordinator owns
      // that durable head and must observe restore replies, including lower revisions.
      return this.verifyCruxSnapshot(c, value, false, input.expectedInstanceId)
    })
  }
  /** Main-only fresh development facts; each source read obtains a new server response. */
  async taskDevelopmentContext(connectionId: string, taskId: string, expectedInstanceId: string): Promise<TeamTaskDevelopmentContext> {
    return this.tracked(async () => {
      const task = teamTaskProgressResourceIdSchema.parse(taskId), instance = z.string().uuid().parse(expectedInstanceId)
      const c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const value = await this.request(c, `/api/projects/${c.projectId}/crux/tasks/${encodeURIComponent(task)}/development-context`, teamTaskDevelopmentContextSchema)
      await this.verifyCruxSnapshot(c, value.snapshot, false, instance)
      if (value.inputs.taskId !== task) throw new DesktopTeamError('BINDING_CHANGED', '开发上下文不属于原任务')
      return value
    })
  }
  async cruxCommand(connectionId: string, raw: CruxRemoteCommand, expectedInstanceId?: string): Promise<z.infer<typeof cruxRemoteCommandReplySchema>> {
    return this.tracked(async () => {
      const payload = cruxRemoteCommandSchema.parse(raw), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const reply = await this.request(c, `/api/projects/${c.projectId}/crux/commands`, cruxRemoteCommandReplySchema, payload)
      if (reply.commandId !== payload.commandId || reply.result.epoch !== payload.expectedEpoch || reply.result.revision !== payload.expectedRevision + 1) throw new DesktopTeamError('RECEIPT_MISMATCH', '远程协作回执与原命令或版本不一致', true)
      await this.verifyCruxSnapshot(c, reply.result, true, expectedInstanceId)
      return reply
    })
  }
  async cruxReceipt(connectionId: string, commandId: string, expectedInstanceId?: string): Promise<CruxRemoteSnapshot | null> {
    return this.tracked(async () => {
      const id = teamCommandIdSchema.parse(commandId), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const schema = z.object({ commandId: teamCommandIdSchema, kind: z.string().min(1).max(100), status: z.literal('committed'), recordedAt: z.number().int().nonnegative(), result: cruxRemoteSnapshotSchema }).strict()
      try {
        const receipt = await this.request(c, `/api/commands/${id}`, schema)
        if (receipt.commandId !== id || receipt.kind !== 'cruxCommand') throw new DesktopTeamError('RECEIPT_MISMATCH', '核对回执不属于原协作操作', true)
        return this.verifyCruxSnapshot(c, receipt.result, true, expectedInstanceId)
      } catch (error) { if (error instanceof DesktopTeamError && error.code === 'NOT_FOUND') return null; throw error }
    })
  }
  /** Protected native transport. Credentials and HTTP destinations never cross preload. */
  async cruxTaskProgress(connectionId: string, taskId: string, expectedInstanceId?: string): Promise<TeamTaskProgressDto> {
    return this.tracked(async () => {
      const id = teamTaskProgressResourceIdSchema.parse(taskId), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const value = await this.request(c, `/api/projects/${c.projectId}/crux/tasks/${encodeURIComponent(id)}/progress`, teamTaskProgressDtoSchema)
      await this.verifyTaskProgress(c, id, value, false, expectedInstanceId)
      return value
    })
  }
  async cruxTaskProgressCommand(connectionId: string, taskId: string, raw: TeamTaskProgressCommand, expectedInstanceId: string): Promise<TeamTaskProgressCommandReply> {
    return this.tracked(async () => {
      const id = teamTaskProgressResourceIdSchema.parse(taskId), command = teamTaskProgressCommandSchema.parse(raw), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const reply = await this.request(c, `/api/projects/${c.projectId}/crux/tasks/${encodeURIComponent(id)}/progress/commands`, teamTaskProgressCommandReplySchema, command)
      if (reply.commandId !== command.commandId || reply.result.epoch !== command.expectedEpoch) throw new DesktopTeamError('RECEIPT_MISMATCH', '进度回执与原命令或服务世代不一致', true)
      await this.verifyTaskProgress(c, id, reply.result, true, expectedInstanceId)
      return reply
    })
  }
  async cruxTaskProgressReceipt(connectionId: string, taskId: string, commandId: string): Promise<TeamTaskProgressReceipt | null> {
    return this.tracked(async () => {
      const id = teamTaskProgressResourceIdSchema.parse(taskId), command = teamCommandIdSchema.parse(commandId), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const reply = await this.request(c, `/api/projects/${c.projectId}/crux/tasks/${encodeURIComponent(id)}/progress/commands/${command}`, teamTaskProgressReceiptSchema.nullable())
      await this.creationOwner(c)
      if (reply && reply.commandId !== command) throw new DesktopTeamError('RECEIPT_MISMATCH', '进度回执不属于原命令', true)
      return reply
    })
  }
  private async verifyTaskProgress(c: ConnectionRecord, taskId: string, value: TeamTaskProgressDto, write: boolean, expectedInstanceId?: string): Promise<void> {
    if (value.projectId !== c.projectId || value.taskId !== taskId || expectedInstanceId !== undefined && value.instanceId !== expectedInstanceId) throw new DesktopTeamError('BINDING_CHANGED', '任务进度不属于原服务、项目或任务', write)
    await this.creationOwner(c)
  }
  async codeResources(connectionId: string, raw: z.input<typeof teamCodeResourceListInputSchema>, expected: { instanceId: string; epoch: string }): Promise<TeamCodeResourceList> {
    return this.tracked(async () => {
      const input = teamCodeResourceListInputSchema.parse(raw), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, String(value))
      const result = await this.request(c, `/api/projects/${c.projectId}/code-resources?${query}`, teamCodeResourceListSchema)
      if (result.projectId !== c.projectId || result.instanceId !== expected.instanceId || result.epoch !== expected.epoch
        || result.items.some((item) => item.projectId !== c.projectId)
        || input.spaceId !== undefined && result.spaceResources?.spaceId !== input.spaceId) {
        throw new DesktopTeamError('BINDING_CHANGED', '代码资源列表不属于原服务或空间')
      }
      await this.creationOwner(c)
      return result
    })
  }
  async taskCodeResource(connectionId: string, taskId: string, expected: { instanceId: string; epoch: string }): Promise<TeamTaskCodeResourceDto> {
    return this.tracked(async () => {
      const id = teamCodeResourceScopeIdSchema.parse(taskId), c = await this.connection(connectionId, true)
      await this.verifyActive(c)
      const result = await this.request(c, `/api/projects/${c.projectId}/crux/tasks/${encodeURIComponent(id)}/code-resource`, teamTaskCodeResourceDtoSchema)
      if (result.projectId !== c.projectId || result.instanceId !== expected.instanceId || result.epoch !== expected.epoch || result.taskId !== id) {
        throw new DesktopTeamError('BINDING_CHANGED', '任务代码资源不属于原服务或任务')
      }
      await this.creationOwner(c)
      return result
    })
  }
  async codeResourceCommand(connectionId: string, raw: TeamCodeResourceCommand, expectedInstanceId: string): Promise<TeamCodeResourceCommandReply> {
    return this.tracked(async () => {
      const input = teamCodeResourceCommandSchema.parse(raw), c = await this.connection(connectionId, true)
      await this.codeResources(connectionId, { limit: 1 }, { instanceId: expectedInstanceId, epoch: input.expectedEpoch })
      const result = await this.request(c, `/api/projects/${c.projectId}/code-resources/commands`, teamCodeResourceCommandReplySchema, input)
      const targetId = 'resourceId' in input && (input.kind === 'create' || input.kind === 'update') ? input.resourceId : input.kind === 'setSpaceResources' ? input.spaceId : input.kind === 'selectTaskResource' ? input.taskId : null
      if (result.commandId !== input.commandId || result.result.projectId !== c.projectId || result.result.epoch !== input.expectedEpoch
        || result.result.kind !== input.kind || result.result.targetId !== targetId || result.result.deviceId !== c.deviceId) {
        throw new DesktopTeamError('RECEIPT_MISMATCH', '代码资源保存回执不属于原操作', true)
      }
      await this.creationOwner(c)
      return result
    })
  }
  async codeResourceReceipt(connectionId: string, commandId: string, expected: { instanceId: string; epoch: string }): Promise<TeamCodeResourceCommandReply | null> {
    return this.tracked(async () => {
      const id = teamCommandIdSchema.parse(commandId), c = await this.connection(connectionId, true)
      await this.codeResources(connectionId, { limit: 1 }, expected)
      const receiptSchema = z.object({ commandId: teamCommandIdSchema, kind: z.literal('codeResourceCommand'), status: z.literal('committed'), recordedAt: z.number().int().nonnegative(), result: teamCodeResourceReceiptSchema }).strict()
      try {
        const receipt = await this.request(c, `/api/commands/${id}`, receiptSchema)
        if (receipt.commandId !== id || receipt.result.projectId !== c.projectId || receipt.result.epoch !== expected.epoch || receipt.result.deviceId !== c.deviceId) throw new DesktopTeamError('RECEIPT_MISMATCH', '代码资源回执不属于原设备或命令', true)
        await this.creationOwner(c)
        return { status: 'duplicate', commandId: id, result: receipt.result }
      } catch (error) { if (error instanceof DesktopTeamError && error.code === 'NOT_FOUND') return null; throw error }
    })
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
  private async workspaceForAccount(account: AccountRecord, workspaceId: string): Promise<TeamProject> {
    let cursor: string | undefined
    for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
      const page = await this.accountRequest(account, this.pagePath('/api/projects', { cursor, limit: 100 }), teamPageSchema(teamProjectSchema), undefined, false)
      const workspace = page.items.find((item) => item.projectId === workspaceId)
      if (workspace) return workspace
      if (!page.hasMore) throw new DesktopTeamError('NOT_FOUND', '选定工作区不属于原桌面账号')
      if (!page.nextCursor || page.nextCursor === cursor) throw new DesktopTeamError('CURSOR_CONFLICT', '工作区列表游标没有前进，请重新加载')
      cursor = page.nextCursor
    }
    throw new DesktopTeamError('CAPACITY_EXCEEDED', '工作区列表超过核对限界，不能猜测授权范围')
  }
  private async createPairing(raw: z.input<typeof desktopPairingInputSchema>, accountId: string | null, approvalCommandId: string | null, openBrowser: boolean): Promise<DesktopTeamPairing> {
    const input = desktopPairingInputSchema.parse(raw), origin = canonicalTeamOrigin(input.origin, this.options.allowLoopbackHttp)
    const { origin: _origin, ...enrollmentInput } = input
    const enrolled = await this.http.request(origin, '/api/device-pairings', teamDeviceEnrollmentSchema, undefined, deviceEnrollmentInputSchema.parse(enrollmentInput))
    const url = verificationUrl(origin, enrolled.verificationUri, enrolled.pairingId)
    if (enrolled.expiresAt <= Date.now() || enrolled.pollAfterMs > 300000) throw new DesktopTeamError('INVALID_RESPONSE', '配对已到期或轮询间隔无效')
    const connectionId = randomUUID()
    let encrypted: string
    try { encrypted = this.protection(JSON.stringify({ version: 1, connectionId, origin, pairingId: enrolled.pairingId, deviceId: enrolled.deviceId, token: enrolled.deviceToken })) } catch { throw new DesktopTeamError('CREDENTIAL_UNAVAILABLE', '系统加密不可用，配对凭据未保存') }
    const c: ConnectionRecord = { connectionId, accountId, approvalCommandId, origin, pairingId: enrolled.pairingId, deviceId: enrolled.deviceId, deviceName: input.deviceName, state: 'pending', projectId: input.projectId ?? null, ownerId: null, userCode: enrolled.userCode, verificationUri: url, expiresAt: enrolled.expiresAt, pollAfterMs: enrolled.pollAfterMs, nextPollAt: Date.now() + enrolled.pollAfterMs, encryptedToken: encrypted, capabilityClaims: input.capabilityClaims, sequence: -1, accessLocked: false, network: 'reachable', lastCheckedAt: Date.now(), lastErrorCode: null, remoteDevice: null }
    await this.store.call({ op: 'add-connection', input: c })
    let opened: DesktopTeamPairing['browser'] = openBrowser ? 'opened' : 'unavailable'
    if (openBrowser) try { await this.browser(url) } catch { opened = 'unavailable' }
    return { connection: publicConnection(c), browser: opened }
  }
  async connectWorkspace(raw: DesktopTeamConnectWorkspaceInput): Promise<DesktopTeamConnection> {
    const input = desktopTeamConnectWorkspaceSchema.parse(raw)
    return this.serial(`workspace-connect:${input.commandId}`, async () => {
      const account = await this.account(input.accountId, true)
      let connection = await this.store.call<ConnectionRecord | null>({ op: 'connection-by-approval-command', input: input.commandId })
      if (connection) {
        if (connection.accountId !== account.accountId || connection.origin !== account.origin || connection.projectId !== input.workspaceId || connection.deviceName !== input.deviceName || JSON.stringify(connection.capabilityClaims) !== JSON.stringify(input.capabilityClaims)) throw new DesktopTeamError('COMMAND_CONFLICT', '同一设备批准命令不能更换账号、工作区或设备声明')
      } else {
        await this.workspaceForAccount(account, input.workspaceId)
        const pairing = await this.createPairing({ origin: account.origin, deviceName: input.deviceName, projectId: input.workspaceId, capabilityClaims: input.capabilityClaims }, account.accountId, input.commandId, false)
        connection = await this.connection(pairing.connection.connectionId)
      }
      if (connection === null) throw new DesktopTeamError('STORE_UNAVAILABLE', '候选设备记录未能从本地存储读取')
      let currentConnection: ConnectionRecord = connection
      if (currentConnection.state === 'active') {
        if (currentConnection.ownerId !== account.person.userId) throw new DesktopTeamError('BINDING_CHANGED', '已批准设备不属于原桌面账号')
        await this.verifyActive(currentConnection)
        return publicConnection(currentConnection)
      }
      if (currentConnection.state !== 'pending' || currentConnection.expiresAt <= Date.now()) throw new DesktopTeamError('PAIRING_UNAVAILABLE', '原候选设备已不处于可批准状态')
      let approvalError: unknown = null
      try {
        const body = deviceApproveInputSchema.parse({ commandId: input.commandId, userCode: currentConnection.userCode, expectedProjectId: input.workspaceId })
        const approval = await this.accountRequest(account, `/api/device-pairings/${encodeURIComponent(currentConnection.pairingId)}/approve`, teamCommandReplySchema(teamDeviceApprovalSchema), body, true)
        if (approval.commandId !== input.commandId || approval.result.deviceId !== currentConnection.deviceId || approval.result.projectId !== input.workspaceId || approval.result.ownerId !== account.person.userId) throw new DesktopTeamError('RECEIPT_MISMATCH', '设备批准回执不属于原账号、工作区或候选设备', true)
      } catch (error) {
        if (!(error instanceof DesktopTeamError) || !error.outcomeUnknown) throw error
        approvalError = error
      }
      const deadline = Date.now() + CONNECT_WAIT_MS
      for (;;) {
        try {
          const current = await this.connection(currentConnection.connectionId)
          const device = await this.request(current, `/api/device-pairings/${encodeURIComponent(current.pairingId)}/status`, teamDeviceSchema)
          currentConnection = await this.store.call({ op: 'update-connection', input: { connectionId: current.connectionId, device, nextPollAt: Date.now() + current.pollAfterMs } })
          if (currentConnection.state === 'active') {
            if (currentConnection.ownerId !== account.person.userId || currentConnection.projectId !== input.workspaceId) throw new DesktopTeamError('BINDING_CHANGED', '设备状态不属于原账号或工作区')
            await this.verifyActive(currentConnection)
            return publicConnection(currentConnection)
          }
          if (currentConnection.state !== 'pending') throw new DesktopTeamError('PAIRING_UNAVAILABLE', '候选设备未获批准且已离开待处理状态')
        } catch (error) {
          if (approvalError) throw approvalError
          throw error
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        await wait(Math.min(currentConnection.pollAfterMs, remaining))
      }
      if (approvalError) throw approvalError
      throw new DesktopTeamError('PAIRING_PENDING', '设备批准已确认，但 active 状态尚未在限定时间内可见；原连接已保留')
    })
  }
  async beginPairing(raw: z.input<typeof desktopPairingInputSchema>): Promise<DesktopTeamPairing> {
    return this.serial('pairing-create', () => this.createPairing(raw, null, null, true))
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
    writeBusinessHookCredential(this.options.dataDir, c, null, this.protection)
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
