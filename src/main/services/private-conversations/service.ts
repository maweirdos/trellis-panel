import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { z } from 'zod'
import * as contract from '../../../shared/private-conversations'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import type { AcpSessionRecord } from '../../../shared/types'
import type { AcpHistoryEventPage } from '../../../shared/acp-history'
import type { RuntimeBody, RuntimeBodyMethod, RuntimeCursor } from '../../../shared/daemon-runtime'
import { runtimeCall } from '../daemon-client/runtime'
import { hifoxWorkspaceGeneration, hifoxWorkspaceSnapshot, hifoxWorkspaceCurrentView, executeHifoxWorkspace } from '../hifox/connection-service'
import type { HifoxSnapshot } from '../../../shared/hifox'
import type { HifoxWorkspaceContext } from '../../../shared/hifox-remote'
import { ipcEvent } from '../../../shared/ipc-channels'
import { checkedDirectory, directoryIdentity, hash, ownedDirectory, readRegular, workspaceFiles, importSelectedFiles, removeImportedFiles, pathKey } from './files'
import { conversationConfigureSchema, conversationRecoverModelSchema } from '../../../shared/acp-configuration'

const rowSchema = z.object({ version: z.literal(1), revision: z.number().int().positive(), conversation: contract.conversationSchema,
  draft: z.object({ text: z.string().max(200_000), runtimeId: z.string().min(1).max(200).optional() }).strict(),
  rootIdentity: z.string().min(1), inputs: z.array(z.string().min(1).max(8192)).max(256),
  pending: z.object({ requestId: z.string().uuid(), digest: z.string().length(64), textDigest: z.string().length(64).optional(), state: z.enum(['preparing', 'dispatching', 'sent', 'unknown']), turnId: z.string().optional() }).strict().optional()
}).strict()
type Row = z.infer<typeof rowSchema>
type NativeSession = { ok: true; session: AcpSessionRecord } | IpcFail
type NativeSend = { ok: true; session: AcpSessionRecord; turnId?: string } | (IpcFail & { notSent?: boolean; outcome?: string })
type TeamProof = { generation: number; snapshot: HifoxSnapshot; context: HifoxWorkspaceContext; spaces: HifoxSnapshot['spaces']; creatorId: string }
export interface PrivateConversationPorts {
  directory(): string
  native<T, M extends RuntimeBodyMethod>(method: M, body: RuntimeBody<M>, commandId?: string, current?: () => boolean): Promise<T>
  publish(channel: string, payload: unknown): void
  active?(): boolean
}
export class ConversationError extends Error {
  constructor(message: string, readonly code: IpcFail['code'] = IpcErrorCode.Conflict) { super(message) }
}
const equalContext = (left: contract.ConversationContext, right: contract.ConversationContext): boolean => JSON.stringify(left) === JSON.stringify(right)
export class PrivateConversations {
  private previewSources = new Map<string, { conversation: contract.Conversation; rootIdentity: string }>()
  private grants = new Map<string, { root: string; identity: string; expires: number; owner?: object; timer: ReturnType<typeof setTimeout> }>()
  private sending = new Map<string, { requestId: string; digest: string; promise: Promise<contract.ConversationResult<{ conversation: contract.Conversation; session: AcpSessionRecord; turnId: string }>> }>()
  private cancelledSends = new Set<string>()
  private observers = new Map<string, { id: string; selected: boolean; busy: boolean; cursor: RuntimeCursor | null; nextAt: number; touchedAt: number; live: boolean }>()
  private observerTimer?: NodeJS.Timeout
  constructor(private readonly ports: PrivateConversationPorts) {}
  private directory(): string {
    const userData = checkedDirectory(this.ports.directory())
    return ownedDirectory(userData, 'private-conversations')
  }
  private localCreator(): string { return `local-${hash(JSON.stringify([pathKey(checkedDirectory(this.ports.directory())), userInfo().username]))}` }
  private rowFile(id: string): string { contract.conversationIdSchema.parse(id); return join(ownedDirectory(this.directory(), 'catalog'), `${id}.json`) }
  private load(id: string): Row { return rowSchema.parse(JSON.parse(readRegular(this.directory(), `catalog/${contract.conversationIdSchema.parse(id)}.json`, 1024 * 1024).bytes.toString('utf8'))) }
  private save(row: Row, expected?: number): void {
    const file = this.rowFile(row.conversation.id)
    if (existsSync(file) && (expected === undefined || this.load(row.conversation.id).revision !== expected)) throw new ConversationError('会话已更新，请重新读取草稿')
    const next = rowSchema.parse({ ...row, revision: (expected ?? 0) + 1 })
    const temporary = join(ownedDirectory(this.directory(), 'catalog'), `.${randomUUID()}.tmp`)
    writeFileSync(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file); row.revision = next.revision
  }
  private hasRemoteSelection(): boolean {
    const path = join(this.ports.directory(), 'hifox-remote', 'selection.json')
    if (!existsSync(path)) return false
    const value = z.object({ connectionId: z.string().uuid().nullable() }).strict().parse(JSON.parse(readRegular(this.ports.directory(), 'hifox-remote/selection.json', 4096).bytes.toString('utf8')))
    return value.connectionId !== null
  }
  private async team(context?: Extract<contract.ConversationContext, { kind: 'team' }>, cached = false): Promise<TeamProof> {
    if (!this.hasRemoteSelection() && !existsSync(join(this.ports.directory(), 'hifox', 'store.json'))) throw new ConversationError('请先选择有权访问的真实团队来源', IpcErrorCode.Denied)
    const generation = hifoxWorkspaceGeneration(), view = await (cached ? hifoxWorkspaceCurrentView() : hifoxWorkspaceSnapshot())
    if (generation !== hifoxWorkspaceGeneration() || !['local', 'connected'].includes(view.context.state) || !view.context.actorId || context && view.context.key !== context.workspaceKey) throw new ConversationError('团队来源或登录身份已改变，请保留原草稿并重新选择', IpcErrorCode.Denied)
    const actor = view.snapshot.members.find(member => member.id === view.context.actorId)
    if (!actor) throw new ConversationError('当前账号不属于此团队来源', IpcErrorCode.Denied)
    const spaces = view.snapshot.spaces.filter(space => !space.archived && (space.visibility !== 'private' || space.ownerId === actor.id || space.memberIds.includes(actor.id) || actor.role !== 'member'))
    if (context && !spaces.some(space => space.id === context.spaceId)) throw new ConversationError('原团队空间已不可访问', IpcErrorCode.Denied)
    return { ...view, generation, spaces, creatorId: `team-${hash(JSON.stringify([this.localCreator(), view.context.key, view.context.instanceId ?? 'local', view.context.origin ?? 'local', view.context.actorId]))}` }
  }
  private async creator(context: contract.ConversationContext): Promise<string> { return context.kind === 'personal' ? this.localCreator() : (await this.team(context)).creatorId }
  private async authorized(row: Row, proof?: TeamProof, fresh = false, cleanup = false): Promise<void> {
    const context = row.conversation.context
    const view = context.kind === 'team' ? proof ?? await this.team(context, !fresh) : undefined
    if (view && (view.generation !== hifoxWorkspaceGeneration() || context.kind !== 'team' || view.context.key !== context.workspaceKey || !view.spaces.some(space => space.id === context.spaceId))) throw new ConversationError('团队来源授权已变化', IpcErrorCode.Denied)
    if (row.conversation.creatorId !== (view?.creatorId ?? this.localCreator())) throw new ConversationError('此会话属于另一位创建者', IpcErrorCode.Denied)
    if (!cleanup && directoryIdentity(row.conversation.workspace.root) !== row.rootIdentity) throw new ConversationError('原会话目录已变化；未切换执行目录')
    if (context.kind === 'team' && view && row.conversation.projectId) {
      if (!view.snapshot.projects.some(project => project.id === row.conversation.projectId && project.spaceId === context.spaceId && project.status !== 'archived')) throw new ConversationError('原团队项目已不可访问', IpcErrorCode.Denied)
    }
  }
  private async owned(id: string, fresh = false, cleanup = false): Promise<Row> { const row = this.load(id); await this.authorized(row, undefined, fresh, cleanup); return row }
  private nativeOwner(row: Row): contract.PrivateNativeOwner {
    return { root: row.conversation.workspace.root, sessionId: row.conversation.nativeRef?.sessionId ?? `acp-private-${row.conversation.id}`, conversationId: row.conversation.id, creatorId: row.conversation.creatorId }
  }
  private async value(row: Row): Promise<contract.ConversationRead> {
    await this.authorized(row)
    let session: AcpSessionRecord | undefined, runtimeError: string | undefined
    try { row = await this.reconcile(row) } catch (error) { runtimeError = error instanceof Error ? error.message : '原消息回执暂不可用，草稿已保留' }
    if (row.conversation.nativeRef) {
      try {
        const read = await this.ports.native<NativeSession, 'runtime.privateRead'>('runtime.privateRead', { ...this.nativeOwner(row), operation: 'session' })
        if (read.ok) session = { ...read.session, events: [] }
        else runtimeError = read.error
      } catch (error) { runtimeError = error instanceof Error ? error.message : '原生连接当前不可用' }
      await this.authorized(row)
      this.observe(row.conversation.id)
    }
    return { conversation: row.conversation, draft: row.draft, ...(session ? { session } : {}), ...(runtimeError ? { runtimeError } : {}) }
  }
  private async reconcile(row: Row): Promise<Row> {
    if (!row.pending || !['dispatching', 'unknown'].includes(row.pending.state)) return row
    const receipt = await this.ports.native<{ ok: true; state: string; turnId?: string; receipt: { state: string; result?: { inline?: NativeSend } }; session: AcpSessionRecord } | IpcFail, 'runtime.privateRead'>('runtime.privateRead', { ...this.nativeOwner(row), operation: 'receipt', requestId: row.pending.requestId })
    await this.authorized(row)
    if (!receipt.ok) return row
    const latest = this.load(row.conversation.id)
    if (latest.pending?.requestId !== row.pending.requestId || latest.pending.digest !== row.pending.digest) return latest
    const completed = receipt.receipt.result?.inline
    const turnId = receipt.state === 'sent' ? receipt.turnId : completed?.ok ? completed.turnId : undefined
    if (turnId) {
      latest.pending.state = 'sent'; latest.pending.turnId = turnId
      if (latest.pending.textDigest && hash(latest.draft.text) === latest.pending.textDigest) latest.draft.text = ''
      this.save(latest, latest.revision)
    } else if (receipt.state === 'absent' || completed && !completed.ok && completed.notSent) {
      latest.pending.state = 'preparing'; this.save(latest, latest.revision)
    }
    return latest
  }
  async list(raw: unknown = {}): Promise<contract.Conversation[]> {
    const input = contract.conversationListSchema.parse(raw ?? {}), result: contract.Conversation[] = []
    const directory = ownedDirectory(this.directory(), 'catalog')
    const names = readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
    if (names.length > 5000) throw new ConversationError('会话索引超过读取上限', IpcErrorCode.Busy)
    const rows = names.map(name => this.load(name.slice(0, -5)))
    let proof: TeamProof | undefined
    if (rows.some(row => row.conversation.context.kind === 'team')) { try { proof = await this.team() } catch (error) { if (!(error instanceof ConversationError)) throw error } }
    for (const row of rows) {
      const conversation = row.conversation
      if (!row.draft.text.trim() && !row.inputs.length && !conversation.nativeRef) continue
      if (input.kind && input.kind !== conversation.kind || input.context && !equalContext(input.context, conversation.context) || input.projectId && input.projectId !== conversation.projectId || input.query && !conversation.title.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())) continue
      if (conversation.context.kind === 'team' && !proof) continue
      try { await this.authorized(row, proof); result.push(conversation) } catch (error) { if (!(error instanceof ConversationError)) throw error }
    }
    if (proof) { const current = await this.team(undefined, true); if (JSON.stringify([proof.generation, proof.context]) !== JSON.stringify([current.generation, current.context])) throw new ConversationError('列表读取期间团队来源已变化') }
    return result.sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
  }
  async createDraft(raw: unknown = {}, directoryOwner?: object): Promise<contract.ConversationRead> {
    const input = contract.conversationCreateDraftSchema.parse(raw ?? {}), id = randomUUID(), now = Date.now(), creatorId = await this.creator(input.context)
    if (input.kind === 'work' && input.directoryGrantId) throw new ConversationError('Work 使用应用持有的独立目录；请选择 Code 使用外部目录', IpcErrorCode.InvalidArg)
    await this.checkProject(input.context, input.projectId)
    const workspace = input.directoryGrantId ? this.consumeDirectory(input.directoryGrantId, directoryOwner) : { root: ownedDirectory(this.directory(), `workspaces/${id}`), kind: 'managed' as const }
    if (input.kind === 'code' && workspace.kind !== 'directory') throw new ConversationError('请为 Code 选择真实目录', IpcErrorCode.InvalidArg)
    const row: Row = { version: 1, revision: 1, conversation: { id, creatorId, title: '新对话', kind: input.kind, context: input.context, projectId: input.projectId, workspace, createdAt: now, updatedAt: now }, draft: { text: input.text, runtimeId: input.runtimeId }, rootIdentity: directoryIdentity(workspace.root), inputs: [] }
    await this.authorized(row); this.save(row)
    return this.value(row)
  }
  async updateDraft(id: string, raw: unknown, directoryOwner?: object): Promise<contract.ConversationRead> {
    const input = contract.conversationUpdateDraftSchema.parse(raw), row = await this.owned(id)
    if (row.conversation.nativeRef && (input.runtimeId !== undefined || input.directoryGrantId !== undefined)) throw new ConversationError('原生会话已绑定，不能改运行时或执行目录')
    if (input.directoryGrantId && row.conversation.kind === 'work') throw new ConversationError('Work 的执行目录由应用持有', IpcErrorCode.InvalidArg)
    if (input.text !== undefined) row.draft.text = input.text
    if (input.title !== undefined) row.conversation.title = input.title
    if (input.runtimeId !== undefined) row.draft.runtimeId = input.runtimeId
    if (input.directoryGrantId) { row.conversation.workspace = this.consumeDirectory(input.directoryGrantId, directoryOwner); row.rootIdentity = directoryIdentity(row.conversation.workspace.root); row.inputs = [] }
    row.conversation.updatedAt = Date.now(); this.save(row, row.revision)
    return this.value(row)
  }
  async read(id: string): Promise<contract.ConversationRead> { return this.value(await this.owned(id)) }
  async configure(id: string, raw: unknown): Promise<contract.ConversationResult<AcpSessionRecord>> {
    const input = conversationConfigureSchema.parse(raw), row = await this.owned(id, true)
    if (!row.conversation.nativeRef || this.sending.has(id)) return ipcFail(IpcErrorCode.Busy, '请等待原会话发送结束后调整参数')
    const generation = hifoxWorkspaceGeneration()
    const result = await this.ports.native<NativeSession, 'runtime.privateConfigure'>('runtime.privateConfigure', { ...this.nativeOwner(row), input }, undefined,
      () => row.conversation.context.kind === 'personal' || generation === hifoxWorkspaceGeneration())
    await this.authorized(row)
    return result.ok ? { ok: true, value: { ...result.session, events: [] } } : result
  }
  async recoverModel(id: string, raw: unknown): Promise<contract.ConversationResult<AcpSessionRecord>> {
    const input = conversationRecoverModelSchema.parse(raw), row = await this.owned(id, true)
    if (!row.conversation.nativeRef || this.sending.has(id)) return ipcFail(IpcErrorCode.Busy, '请等待原会话发送结束后核对模型')
    const generation = hifoxWorkspaceGeneration()
    const result = await this.ports.native<NativeSession, 'runtime.privateRecoverModel'>('runtime.privateRecoverModel', { ...this.nativeOwner(row), input }, undefined,
      () => row.conversation.context.kind === 'personal' || generation === hifoxWorkspaceGeneration())
    await this.authorized(row)
    return result.ok ? { ok: true, value: { ...result.session, events: [] } } : result
  }
  previewProject(sessionId: string): { root: string | null; generation: number } {
    try {
      let source = this.previewSources.get(sessionId)
      if (!source) {
        const row = this.load(sessionId.slice('acp-private-'.length))
        if (row.conversation.nativeRef?.sessionId !== sessionId) return { root: null, generation: 0 }
        source = { conversation: row.conversation, rootIdentity: row.rootIdentity }
        if (this.previewSources.size >= 16) this.previewSources.delete(this.previewSources.keys().next().value ?? '')
        this.previewSources.set(sessionId, source)
      }
      if (directoryIdentity(source.conversation.workspace.root) !== source.rootIdentity) return { root: null, generation: 0 }
      return { root: source.conversation.workspace.root, generation: source.conversation.context.kind === 'team' ? hifoxWorkspaceGeneration() : 0 }
    } catch { return { root: null, generation: 0 } }
  }
  async previewSession(root: string, sessionId: string): Promise<NativeSession> {
    const row = await this.owned(sessionId.slice('acp-private-'.length))
    if (row.conversation.nativeRef?.sessionId !== sessionId || pathKey(root) !== pathKey(row.conversation.workspace.root)) return ipcFail(IpcErrorCode.Denied, '预览来源与原会话不一致')
    const result = await this.ports.native<NativeSession, 'runtime.privateRead'>('runtime.privateRead', { ...this.nativeOwner(row), operation: 'session' })
    await this.authorized(row)
    return result
  }
  async events(id: string, paging?: { before?: string; after?: string; limit?: number }): Promise<contract.ConversationResult<AcpHistoryEventPage | null>> {
    const row = await this.owned(id)
    if (!row.conversation.nativeRef) return { ok: true, value: null }
    const value = await this.ports.native<AcpHistoryEventPage | IpcFail, 'runtime.privateRead'>('runtime.privateRead', { ...this.nativeOwner(row), operation: 'events', paging })
    await this.authorized(row)
    return value.ok ? { ok: true, value } : value
  }
  async send(id: string, raw: unknown): Promise<contract.ConversationResult<{ conversation: contract.Conversation; session: AcpSessionRecord; turnId: string }>> {
    const input = contract.conversationSendSchema.parse(raw), digest = hash(JSON.stringify({ text: input.text, images: input.images ?? [] }))
    const existing = this.sending.get(id)
    if (existing) return existing.requestId === input.requestId && existing.digest === digest ? existing.promise : ipcFail(IpcErrorCode.Busy, '原会话正在接纳消息，草稿已保留')
    const promise = this.sendOwned(id, input, digest)
    this.sending.set(id, { requestId: input.requestId, digest, promise })
    try { return await promise } finally { if (this.sending.get(id)?.promise === promise) this.sending.delete(id); this.cancelledSends.delete(input.requestId) }
  }
  private async sendOwned(id: string, input: contract.ConversationSend, digest: string): Promise<contract.ConversationResult<{ conversation: contract.Conversation; session: AcpSessionRecord; turnId: string }>> {
    let row = await this.reconcile(await this.owned(id, true))
    if (!input.text.trim() && !input.images?.length) return ipcFail(IpcErrorCode.InvalidArg, '请输入消息或选择图片')
    if (input.expectedConnectionGeneration && row.conversation.nativeRef) {
      const original = await this.ports.native<NativeSession, 'runtime.privateRead'>('runtime.privateRead', { ...this.nativeOwner(row), operation: 'session' })
      if (!original.ok) return original
      if (original.session.connectionGeneration !== input.expectedConnectionGeneration) return ipcFail(IpcErrorCode.Conflict, '原会话连接已变化，草稿已保留')
    }
    if (row.pending && (row.pending.state === 'dispatching' || row.pending.state === 'unknown')) return ipcFail(IpcErrorCode.Conflict, '原消息发送结果尚未核实；请读取原会话，不能自动重发', { requestId: row.pending.requestId, outcome: 'unknown' })
    if (row.pending?.requestId === input.requestId) {
      if (row.pending.digest !== digest) return ipcFail(IpcErrorCode.Conflict, '同一消息身份不能用于不同内容')
      if (row.pending.state === 'sent' && row.pending.turnId) {
        const current = await this.value(row)
        return current.session ? { ok: true, value: { conversation: row.conversation, session: current.session, turnId: row.pending.turnId } } : ipcFail(IpcErrorCode.Unavailable, '原消息已发送，当前连接状态不可用；未重发')
      }
    }
    row.draft.text = input.text
    row.conversation.nativeRef ??= { sessionId: `acp-private-${id}`, agentId: row.draft.runtimeId ?? 'pi' }
    row.pending = { requestId: input.requestId, digest, textDigest: hash(input.text), state: 'preparing' }
    row.conversation.updatedAt = Date.now(); this.save(row, row.revision)
    const generation = hifoxWorkspaceGeneration(), team = row.conversation.context.kind === 'team'
    const current = (): boolean => (!team || generation === hifoxWorkspaceGeneration()) && !this.cancelledSends.has(input.requestId)
      && this.sending.get(id)?.requestId === input.requestId && this.sending.get(id)?.digest === digest
    const prepared = await this.ports.native<NativeSend, 'runtime.privateSend'>('runtime.privateSend', { ...this.nativeOwner(row), agentId: row.conversation.nativeRef.agentId, operation: 'prepare', input }, undefined, current)
    if (!prepared.ok) return prepared
    row = await this.owned(id, true)
    if (!current() || this.cancelledSends.has(input.requestId)) return ipcFail(IpcErrorCode.Conflict, '原消息已停止或来源已变化，消息未发送', { notSent: true })
    const agentId = row.conversation.nativeRef?.agentId
    if (!agentId || !prepared.session.connectionGeneration) return ipcFail(IpcErrorCode.Conflict, '原生身份尚未确认')
    row.pending = { requestId: input.requestId, digest, textDigest: hash(input.text), state: 'dispatching' }; this.save(row, row.revision)
    let sent: NativeSend
    try {
      sent = await this.ports.native<NativeSend, 'runtime.privateSend'>('runtime.privateSend', { ...this.nativeOwner(row), agentId, operation: 'send', input: { ...input, expectedConnectionGeneration: prepared.session.connectionGeneration } }, input.requestId, current)
    } catch (error) {
      const latest = this.load(id)
      const notAdmitted = error !== null && typeof error === 'object' && 'outcome' in error && error.outcome === 'not-admitted'
      if (latest.pending?.requestId === input.requestId) { latest.pending.state = notAdmitted ? 'preparing' : 'unknown'; this.save(latest, latest.revision) }
      if (notAdmitted && this.cancelledSends.has(input.requestId)) return ipcFail(IpcErrorCode.Conflict, '原消息已取消，未发送；草稿已保留', { notSent: true, requestId: input.requestId })
      throw error
    }
    const latest = this.load(id)
    if (!sent.ok || !sent.turnId) {
      if (latest.pending?.requestId === input.requestId) { latest.pending.state = !sent.ok && sent.notSent ? 'preparing' : 'unknown'; this.save(latest, latest.revision) }
      return sent.ok ? ipcFail(IpcErrorCode.Conflict, '消息回执未确认，未重发') : sent
    }
    if (latest.pending?.requestId === input.requestId) {
      latest.pending = { requestId: input.requestId, digest, textDigest: hash(input.text), state: 'sent', turnId: sent.turnId }
      if (latest.draft.text === input.text) latest.draft.text = ''
      if (latest.conversation.title === '新对话') latest.conversation.title = input.text.trim().split(/\r?\n/, 1)[0].slice(0, 80) || '图片对话'
      latest.conversation.updatedAt = Date.now(); this.save(latest, latest.revision)
    }
    await this.authorized(latest); this.observe(id)
    return { ok: true, value: { conversation: latest.conversation, session: sent.session, turnId: sent.turnId } }
  }
  async control(operation: 'cancel' | 'end' | 'respond', id: string, raw: unknown = {}): Promise<contract.ConversationResult<null>> {
    const cleanup = operation !== 'respond'
    const input = operation === 'respond' ? contract.conversationRespondSchema.parse(raw) : contract.conversationConnectionSchema.parse(raw ?? {}), row = await this.owned(id, false, cleanup)
    const sending = this.sending.get(id)
    if (operation !== 'respond' && sending) this.cancelledSends.add(sending.requestId)
    await this.authorized(row, undefined, true, cleanup)
    if (!row.conversation.nativeRef) return { ok: true, value: null }
    const method = operation === 'cancel' ? 'runtime.privateCancel' : operation === 'end' ? 'runtime.privateEnd' : 'runtime.privateRespond'
    const value = await this.ports.native<{ ok: true } | IpcFail, typeof method>(method, { ...this.nativeOwner(row), ...input })
    await this.authorized(row, undefined, false, cleanup)
    return value.ok ? { ok: true, value: null } : value
  }
  grantDirectory(root: string, owner?: object): contract.ConversationDirectoryGrant {
    const canonical = checkedDirectory(root), grantId = randomUUID()
    for (const [id, grant] of this.grants) if (grant.expires < Date.now()) this.forgetDirectoryGrant(id)
    if (this.grants.size >= 32) throw new ConversationError('目录选择过多，请稍后重试', IpcErrorCode.Busy)
    const identity = directoryIdentity(canonical), expires = Date.now() + 10 * 60_000
    const timer = setTimeout(() => this.forgetDirectoryGrant(grantId), 10 * 60_000)
    timer.unref()
    this.grants.set(grantId, { root: canonical, identity, expires, owner, timer })
    return { grantId, path: canonical }
  }
  private forgetDirectoryGrant(id: string): void { const grant = this.grants.get(id); if (grant) clearTimeout(grant.timer); this.grants.delete(id) }
  releaseDirectoryGrants(owner?: object): void { for (const [id, grant] of this.grants) if (owner === undefined || grant.owner === owner) this.forgetDirectoryGrant(id) }
  private consumeDirectory(id: string, owner?: object): contract.Conversation['workspace'] {
    const grant = this.grants.get(id)
    if (!grant || grant.expires < Date.now()) { this.forgetDirectoryGrant(id); throw new ConversationError('目录授权已失效，请重新选择', IpcErrorCode.Denied) }
    if (grant.owner !== owner || directoryIdentity(grant.root) !== grant.identity) throw new ConversationError('目录授权不属于原页面或目录已变化', IpcErrorCode.Denied)
    this.forgetDirectoryGrant(id)
    return { root: grant.root, kind: 'directory' }
  }
  async files(id: string): Promise<contract.ConversationFile[]> { const row = await this.owned(id, true); return workspaceFiles(row.conversation.workspace.root, row.inputs, row.conversation.workspace.kind === 'managed') }
  async importFiles(id: string, paths: string[]): Promise<contract.ConversationFile[]> {
    const row = await this.owned(id, true)
    if (row.inputs.length + paths.length > 256) throw new ConversationError('会话已达到 256 个选入文件上限', IpcErrorCode.Busy)
    const directory = row.conversation.workspace.kind === 'managed' ? 'inputs' : `.trellis-panel/conversations/${id}/inputs`
    const files = importSelectedFiles(row.conversation.workspace.root, directory, paths)
    row.inputs.push(...files.map(file => file.relativePath)); row.conversation.updatedAt = Date.now()
    try { this.save(row, row.revision) } catch (error) { removeImportedFiles(row.conversation.workspace.root, files); throw error }
    return files
  }
  async file(id: string, fileId: string, revision?: string, limit?: number) {
    const row = await this.owned(id, true), file = workspaceFiles(row.conversation.workspace.root, row.inputs, row.conversation.workspace.kind === 'managed').find(file => file.id === fileId)
    if (!file) throw new ConversationError('会话文件已移除或不可访问', IpcErrorCode.NotFound)
    const actual = readRegular(row.conversation.workspace.root, file.relativePath, limit)
    if (revision && hash(actual.bytes) !== revision) throw new ConversationError('文件已更新，请重新读取后提交')
    return { ...actual, file: { ...file, revision: hash(actual.bytes), bytes: actual.bytes.length, modifiedAt: actual.modifiedAt } }
  }
  async projects(raw: unknown = {}): Promise<contract.ConversationProject[]> {
    const input = z.object({ context: contract.conversationContextSchema.optional() }).strict().parse(raw ?? {}), context = input.context ?? { kind: 'personal' as const }
    if (context.kind === 'team') { const view = await this.team(context); return view.snapshot.projects.filter(project => project.spaceId === context.spaceId && project.status !== 'archived').map(project => ({ id: project.id, name: project.name, context })) }
    const file = join(this.directory(), 'projects.json')
    return existsSync(file) ? z.array(contract.conversationProjectSchema).max(1000).parse(JSON.parse(readRegular(this.directory(), 'projects.json', 512 * 1024).bytes.toString('utf8'))) : []
  }
  private async checkProject(context: contract.ConversationContext, projectId?: string): Promise<void> { if (projectId && !(await this.projects({ context })).some(project => project.id === projectId)) throw new ConversationError('请选择当前来源中真实存在的项目', IpcErrorCode.Denied) }
  async createProject(raw: unknown): Promise<contract.ConversationProject> {
    const input = contract.conversationCreateProjectSchema.parse(raw)
    if (input.context.kind === 'team') {
      const context = input.context, prior = await this.team(context), view = await executeHifoxWorkspace('createProject', { spaceId: context.spaceId, name: input.name }, context.workspaceKey)
      const project = view.snapshot.projects.find(project => project.spaceId === context.spaceId && project.name === input.name && !prior.snapshot.projects.some(old => old.id === project.id))
      if (!project) throw new ConversationError('团队项目创建结果尚未核实')
      return { id: project.id, name: project.name, context: input.context }
    }
    const projects = await this.projects(), project = { id: randomUUID(), name: input.name, context: input.context }
    if (projects.length >= 1000) throw new ConversationError('个人项目数量已达到上限', IpcErrorCode.Busy)
    projects.push(project)
    const file = join(this.directory(), 'projects.json'), temporary = join(this.directory(), `.${randomUUID()}.tmp`)
    writeFileSync(temporary, JSON.stringify(projects), { flag: 'wx', mode: 0o600 }); renameSync(temporary, file)
    return project
  }
  async reclassify(id: string, raw: unknown): Promise<contract.ConversationRead> {
    const input = contract.conversationReclassifySchema.parse(raw), row = await this.owned(id)
    if (!equalContext(input.context, row.conversation.context)) throw new ConversationError('既有会话不能改变来源权限；请选择或创建该来源的草稿', IpcErrorCode.Denied)
    await this.checkProject(input.context, input.projectId ?? undefined)
    row.conversation.projectId = input.projectId ?? undefined; row.conversation.updatedAt = Date.now(); this.save(row, row.revision)
    return this.value(row)
  }
  async contexts(): Promise<contract.ConversationContextChoice[]> {
    const choices: contract.ConversationContextChoice[] = [{ context: { kind: 'personal' }, name: '个人' }]
    if (!this.hasRemoteSelection() && !existsSync(join(this.ports.directory(), 'hifox', 'store.json'))) return choices
    const view = await this.team()
    choices.push(...view.spaces.map(space => ({ context: { kind: 'team' as const, workspaceKey: view.context.key, spaceId: space.id }, name: space.name })))
    return choices
  }
  async image(id: string, imageId: string) {
    const row = await this.owned(id)
    const value = await this.ports.native<{ ok: true; image: { mimeType: import('../../../shared/acp-images').AcpImageMimeType; data: string } } | IpcFail, 'runtime.privateRead'>('runtime.privateRead', { ...this.nativeOwner(row), operation: 'image', imageId })
    await this.authorized(row)
    return value.ok ? { ok: true as const, value: value.image } : value
  }
  private observe(id: string): void {
    for (const state of this.observers.values()) state.selected = state.id === id
    const previous = this.observers.get(id)
    if (previous) { previous.selected = true; previous.touchedAt = Date.now(); return }
    for (const [key, state] of this.observers) if (!state.live && !state.selected && !state.busy) this.observers.delete(key)
    if (this.observers.size >= 8) return
    this.observers.set(id, { id, selected: true, busy: false, cursor: null, nextAt: 0, touchedAt: Date.now(), live: false })
    if (!this.observerTimer) { this.observerTimer = setInterval(() => { void this.observeTick() }, 750); this.observerTimer.unref() }
    void this.observeTick()
  }
  private async observeTick(): Promise<void> {
    const visible = this.ports.active?.() !== false
    await Promise.allSettled([...this.observers.values()].map(async state => {
      if (state.busy || state.nextAt > Date.now()) return
      if (!state.live && Date.now() - state.touchedAt > 15_000) { this.observers.delete(state.id); return }
      state.busy = true; state.nextAt = Date.now() + (visible ? 1500 : 15_000)
      try {
        const row = await this.owned(state.id)
        const page = await this.ports.native<{ ok: true; cursor: RuntimeCursor; resetRequired: boolean; hasMore: boolean; events: Array<{ channel: string; payload: unknown }>; session: AcpSessionRecord } | IpcFail, 'runtime.privateRead'>('runtime.privateRead', { ...this.nativeOwner(row), operation: 'updates', after: state.cursor })
        await this.authorized(row)
        if (this.observers.get(state.id) !== state || !page.ok) return
        state.cursor = page.cursor
        state.live = page.session.connectionOwned === true || page.session.cleanupRequired === true || Boolean(page.session.pendingPermissions?.length)
        const busy = ['starting', 'busy', 'awaiting_permission', 'cancelling'].includes(page.session.status)
        state.nextAt = Date.now() + (visible && page.hasMore ? 0 : visible && busy ? 750 : 15_000)
        if (page.resetRequired) { this.ports.publish(ipcEvent.acpState, { ...page.session, session: { ...page.session, events: [] } }); this.ports.publish(ipcEvent.daemonRuntimeReset, { projectRoot: row.conversation.workspace.root }) }
        for (const event of page.events) this.ports.publish(event.channel, event.payload)
      } catch (error) {
        if (error instanceof ConversationError && error.code === IpcErrorCode.Denied) this.observers.delete(state.id)
        else state.nextAt = Date.now() + 15_000
      } finally { state.busy = false }
    }))
    if (!this.observers.size && this.observerTimer) { clearInterval(this.observerTimer); this.observerTimer = undefined }
  }
  dispose(): void { this.releaseDirectoryGrants(); this.previewSources.clear(); this.observers.clear(); if (this.observerTimer) { clearInterval(this.observerTimer); this.observerTimer = undefined } }
}
export function privateConversationNative<T, M extends RuntimeBodyMethod>(method: M, body: RuntimeBody<M>, commandId?: string, current?: () => boolean): Promise<T> { return runtimeCall<T, M>('', method, body, commandId, current) }
