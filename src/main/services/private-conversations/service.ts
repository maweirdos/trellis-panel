import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { userInfo } from 'node:os'
import * as contract from '../../../shared/private-conversations'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import type { AcpSessionRecord } from '../../../shared/types'
import type { AcpHistoryEventPage } from '../../../shared/acp-history'
import type { RuntimeBody, RuntimeBodyMethod, RuntimeCursor } from '../../../shared/daemon-runtime'
import { runtimeCall } from '../daemon-client/runtime'
import { ipcEvent } from '../../../shared/ipc-channels'
import { checkedDirectory, directoryIdentity, hash, ownedDirectory, readRegular, workspaceFiles, importSelectedFiles, removeImportedFiles, pathKey } from './files'
import { conversationConfigureSchema, conversationRecoverModelSchema } from '../../../shared/acp-configuration'
import { ConversationStorage, ConversationStorageError as ConversationError, type ConversationRow as Row, type ConversationMigrationBatch } from './storage'
export { ConversationStorageError as ConversationError } from './storage'

type NativeSession = { ok: true; session: AcpSessionRecord } | IpcFail
type NativeSend = { ok: true; session: AcpSessionRecord; turnId?: string } | (IpcFail & { notSent?: boolean; outcome?: string })
export interface PrivateConversationPorts {
  directory(): string
  native<T, M extends RuntimeBodyMethod>(method: M, body: RuntimeBody<M>, commandId?: string, current?: () => boolean): Promise<T>
  publish(channel: string, payload: unknown): void
  active?(): boolean
}
export class PrivateConversations {
  private storage?: ConversationStorage
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
  private catalog(): ConversationStorage { return this.storage ??= new ConversationStorage(this.directory(), this.localCreator(), this.ports.directory()) }
  private load(id: string): Row { return this.catalog().read(id) }
  private save(row: Row, expected?: number): void { this.catalog().save(row, expected) }
  private async authorized(row: Row, cleanup = false): Promise<void> {
    if (row.conversation.creatorId !== this.localCreator()) throw new ConversationError('此会话属于另一位本机创建者', IpcErrorCode.Denied)
    if (!cleanup && directoryIdentity(row.conversation.workspace.root) !== row.rootIdentity) throw new ConversationError('原会话目录已变化；未切换执行目录')
  }
  private async owned(id: string, cleanup = false): Promise<Row> { const row = await this.catalog().load(id); await this.authorized(row, cleanup); return row }
  private nativeOwner(row: Row): contract.PrivateNativeOwner {
    return { root: row.conversation.workspace.root, sessionId: row.conversation.nativeRef?.sessionId ?? `acp-private-${row.conversation.id}`, conversationId: row.conversation.id, creatorId: row.nativeCreatorId }
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
      if (session) row = this.rememberPreview(row, session)
      this.observe(row.conversation.id)
    }
    return { conversation: row.conversation, draft: row.draft, ...(session ? { session } : {}), ...(runtimeError ? { runtimeError } : {}) }
  }
  private rememberPreview(row: Row, session: AcpSessionRecord): Row {
    if (session.sessionId !== row.conversation.nativeRef?.sessionId || pathKey(session.projectRoot) !== pathKey(row.conversation.workspace.root) || typeof session.conversationPreview !== 'string' || !session.conversationPreview.trim()) return row
    let preview = session.conversationPreview.trim().slice(0, 500)
    if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1)
    const at = typeof session.conversationPreviewAt === 'number' && Number.isFinite(session.conversationPreviewAt) && session.conversationPreviewAt >= 0 ? session.conversationPreviewAt : undefined
    if (row.nativePreviewAt !== undefined && (at === undefined || at < row.nativePreviewAt)) return row
    if (preview === row.conversation.conversationPreview && (at === undefined || row.nativePreviewAt !== undefined && at <= row.nativePreviewAt)) return row
    const latest = this.load(row.conversation.id)
    if (latest.conversation.nativeRef?.sessionId !== session.sessionId || latest.nativeCreatorId !== row.nativeCreatorId || pathKey(latest.conversation.workspace.root) !== pathKey(row.conversation.workspace.root)) return latest
    if (latest.nativePreviewAt !== undefined && (at === undefined || at < latest.nativePreviewAt)) return latest
    if (preview === latest.conversation.conversationPreview && (at === undefined || latest.nativePreviewAt !== undefined && at <= latest.nativePreviewAt)) return latest
    latest.conversation.conversationPreview = preview
    if (at !== undefined) { latest.nativePreviewAt = at; latest.conversation.updatedAt = Math.max(latest.conversation.updatedAt, Math.floor(at)) }
    this.save(latest, latest.revision)
    return latest
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
    const batch: ConversationMigrationBatch = {}
    for (const name of names) {
      let row: Row
      try { row = await this.catalog().load(name.slice(0, -5), batch) }
      catch (error) { if (error instanceof ConversationError && error.code === IpcErrorCode.Denied) continue; throw error }
      const conversation = row.conversation
      if (!row.draft.text.trim() && !row.inputs.length && !conversation.nativeRef) continue
      if (input.archive === 'active' && conversation.archivedAt !== undefined || input.archive === 'archived' && conversation.archivedAt === undefined) continue
      if (input.kind && input.kind !== conversation.kind || input.projectId && input.projectId !== conversation.projectId || input.query && !conversation.title.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())) continue
      if (conversation.creatorId === this.localCreator()) result.push(conversation)
    }
    return result.sort((left, right) => Number(right.pinnedAt !== undefined) - Number(left.pinnedAt !== undefined) || right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
  }
  async createDraft(raw: unknown = {}, directoryOwner?: object): Promise<contract.ConversationRead> {
    const input = contract.conversationCreateDraftSchema.parse(raw ?? {}), id = randomUUID(), now = Date.now(), creatorId = this.localCreator()
    if (input.kind === 'work' && input.directoryGrantId) throw new ConversationError('Work 使用应用持有的独立目录；请选择 Code 使用外部目录', IpcErrorCode.InvalidArg)
    await this.checkProject(input.projectId)
    const workspace = input.directoryGrantId ? this.consumeDirectory(input.directoryGrantId, directoryOwner) : { root: ownedDirectory(this.directory(), `workspaces/${id}`), kind: 'managed' as const }
    if (input.kind === 'code' && workspace.kind !== 'directory') throw new ConversationError('请为 Code 选择真实目录', IpcErrorCode.InvalidArg)
    const row: Row = { version: 2, revision: 1, nativeCreatorId: creatorId, conversation: { id, creatorId, title: '新对话', kind: input.kind, projectId: input.projectId, workspace, createdAt: now, updatedAt: now }, draft: { text: input.text, runtimeId: input.runtimeId }, rootIdentity: directoryIdentity(workspace.root), inputs: [] }
    await this.authorized(row); this.save(row)
    return this.value(row)
  }
  async updateDraft(id: string, raw: unknown, directoryOwner?: object): Promise<contract.ConversationRead> {
    const input = contract.conversationUpdateDraftSchema.parse(raw), row = await this.owned(id)
    const before = JSON.stringify(row)
    if (row.conversation.nativeRef && (input.runtimeId !== undefined || input.directoryGrantId !== undefined)) throw new ConversationError('原生会话已绑定，不能改运行时或执行目录')
    if (input.directoryGrantId && row.conversation.kind === 'work') throw new ConversationError('Work 的执行目录由应用持有', IpcErrorCode.InvalidArg)
    if (input.text !== undefined) row.draft.text = input.text
    if (input.title !== undefined) row.conversation.title = input.title
    if (input.runtimeId !== undefined) row.draft.runtimeId = input.runtimeId
    if (input.directoryGrantId) { row.conversation.workspace = this.consumeDirectory(input.directoryGrantId, directoryOwner); row.rootIdentity = directoryIdentity(row.conversation.workspace.root); row.inputs = [] }
    if (input.pinned === true) row.conversation.pinnedAt ??= Date.now()
    else if (input.pinned === false) delete row.conversation.pinnedAt
    if (input.archived === true) row.conversation.archivedAt ??= Date.now()
    else if (input.archived === false) delete row.conversation.archivedAt
    if (before !== JSON.stringify(row)) { row.conversation.updatedAt = Date.now(); this.save(row, row.revision) }
    return this.value(row)
  }
  async read(id: string): Promise<contract.ConversationRead> { return this.value(await this.owned(id)) }
  async configure(id: string, raw: unknown): Promise<contract.ConversationResult<AcpSessionRecord>> {
    const input = conversationConfigureSchema.parse(raw), row = await this.owned(id)
    if (row.conversation.archivedAt !== undefined) return ipcFail(IpcErrorCode.Conflict, '会话已归档，请恢复后再调整参数')
    if (!row.conversation.nativeRef || this.sending.has(id)) return ipcFail(IpcErrorCode.Busy, '请等待原会话发送结束后调整参数')
    const result = await this.ports.native<NativeSession, 'runtime.privateConfigure'>('runtime.privateConfigure', { ...this.nativeOwner(row), input }, undefined,
      () => { const current = this.load(id).conversation; return current.creatorId === this.localCreator() && current.archivedAt === undefined })
    await this.authorized(row)
    return result.ok ? { ok: true, value: { ...result.session, events: [] } } : result
  }
  async recoverModel(id: string, raw: unknown): Promise<contract.ConversationResult<AcpSessionRecord>> {
    const input = conversationRecoverModelSchema.parse(raw), row = await this.owned(id)
    if (row.conversation.archivedAt !== undefined) return ipcFail(IpcErrorCode.Conflict, '会话已归档，请恢复后再核对模型')
    if (!row.conversation.nativeRef || this.sending.has(id)) return ipcFail(IpcErrorCode.Busy, '请等待原会话发送结束后核对模型')
    const result = await this.ports.native<NativeSession, 'runtime.privateRecoverModel'>('runtime.privateRecoverModel', { ...this.nativeOwner(row), input }, undefined,
      () => { const current = this.load(id).conversation; return current.creatorId === this.localCreator() && current.archivedAt === undefined })
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
      if (source.conversation.creatorId !== this.localCreator() || directoryIdentity(source.conversation.workspace.root) !== source.rootIdentity) return { root: null, generation: 0 }
      return { root: source.conversation.workspace.root, generation: 0 }
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
    let row = await this.reconcile(await this.owned(id))
    if (row.conversation.archivedAt !== undefined) return ipcFail(IpcErrorCode.Conflict, '会话已归档，请恢复后再发送')
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
    const current = (): boolean => !this.cancelledSends.has(input.requestId)
      && this.sending.get(id)?.requestId === input.requestId && this.sending.get(id)?.digest === digest && this.load(id).conversation.archivedAt === undefined
    const prepared = await this.ports.native<NativeSend, 'runtime.privateSend'>('runtime.privateSend', { ...this.nativeOwner(row), agentId: row.conversation.nativeRef.agentId, operation: 'prepare', input }, undefined, current)
    if (!prepared.ok) return prepared
    row = await this.owned(id)
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
    const input = operation === 'respond' ? contract.conversationRespondSchema.parse(raw) : contract.conversationConnectionSchema.parse(raw ?? {}), row = await this.owned(id, cleanup)
    const sending = this.sending.get(id)
    if (operation !== 'respond' && sending) this.cancelledSends.add(sending.requestId)
    await this.authorized(row, cleanup)
    if (!row.conversation.nativeRef) return { ok: true, value: null }
    const method = operation === 'cancel' ? 'runtime.privateCancel' : operation === 'end' ? 'runtime.privateEnd' : 'runtime.privateRespond'
    const value = await this.ports.native<{ ok: true } | IpcFail, typeof method>(method, { ...this.nativeOwner(row), ...input })
    await this.authorized(row, cleanup)
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
  async files(id: string): Promise<contract.ConversationFile[]> { const row = await this.owned(id); return workspaceFiles(row.conversation.workspace.root, row.inputs, row.conversation.workspace.kind === 'managed') }
  async importFiles(id: string, paths: string[]): Promise<contract.ConversationFile[]> {
    const row = await this.owned(id)
    if (row.inputs.length + paths.length > 256) throw new ConversationError('会话已达到 256 个选入文件上限', IpcErrorCode.Busy)
    const directory = row.conversation.workspace.kind === 'managed' ? 'inputs' : `.trellis-panel/conversations/${id}/inputs`
    const files = importSelectedFiles(row.conversation.workspace.root, directory, paths)
    row.inputs.push(...files.map(file => file.relativePath)); row.conversation.updatedAt = Date.now()
    try { this.save(row, row.revision) } catch (error) { removeImportedFiles(row.conversation.workspace.root, files); throw error }
    return files
  }
  async file(id: string, fileId: string, revision?: string, limit?: number) {
    const row = await this.owned(id), file = workspaceFiles(row.conversation.workspace.root, row.inputs, row.conversation.workspace.kind === 'managed').find(file => file.id === fileId)
    if (!file) throw new ConversationError('会话文件已移除或不可访问', IpcErrorCode.NotFound)
    const actual = readRegular(row.conversation.workspace.root, file.relativePath, limit)
    if (revision && hash(actual.bytes) !== revision) throw new ConversationError('文件已更新，请重新读取后提交')
    return { ...actual, file: { ...file, revision: hash(actual.bytes), bytes: actual.bytes.length, modifiedAt: actual.modifiedAt } }
  }
  async projects(): Promise<contract.ConversationProject[]> { return this.catalog().projects() }
  private async checkProject(projectId?: string): Promise<void> { if (projectId && !this.catalog().projects().some(project => project.id === projectId)) throw new ConversationError('请选择已存在的私人主题分组', IpcErrorCode.Denied) }
  async createProject(raw: unknown): Promise<contract.ConversationProject> {
    const input = contract.conversationCreateProjectSchema.parse(raw)
    return this.catalog().createProject(input.name)
  }
  async reclassify(id: string, raw: unknown): Promise<contract.ConversationRead> {
    const input = contract.conversationReclassifySchema.parse(raw), row = await this.owned(id)
    await this.checkProject(input.projectId ?? undefined)
    row.conversation.projectId = input.projectId ?? undefined; row.conversation.updatedAt = Date.now(); this.save(row, row.revision)
    return this.value(row)
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
        if (!busy) this.rememberPreview(row, page.session)
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
