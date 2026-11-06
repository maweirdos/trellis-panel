import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { userInfo } from 'node:os'
import { extname } from 'node:path'
import * as contract from '../../../shared/private-conversations'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import type { AcpSessionRecord } from '../../../shared/types'
import type { AcpHistoryEventPage } from '../../../shared/acp-history'
import type { RuntimeBody, RuntimeBodyMethod, RuntimeCursor } from '../../../shared/daemon-runtime'
import { runtimeCall } from '../daemon-client/runtime'
import { ipcEvent } from '../../../shared/ipc-channels'
import { checkedDirectory, directoryIdentity, eligibleWorkspaceFile, FileSizeLimitError, hash, ownedDirectory, readRegular, workspaceFiles, importSelectedFiles, removeImportedFiles, pathKey } from './files'
import { conversationConfigureSchema, conversationRecoverModelSchema } from '../../../shared/acp-configuration'
import { ConversationStorage, ConversationStorageError as ConversationError, type ConversationRow as Row, type ConversationMigrationBatch } from './storage'
export { ConversationStorageError as ConversationError } from './storage'

type NativeSession = { ok: true; session: AcpSessionRecord } | IpcFail
type NativeSend = { ok: true; session: AcpSessionRecord; turnId?: string } | (IpcFail & { notSent?: boolean; outcome?: string })
type PdfLocator = { owner: object; conversationId: string; fileId: string; relativePath: string; kind: 'input' | 'output'; sourceIdentity: string; revision: string; expires: number; maxBytes?: number }
const PDF_LOCATOR_LIMIT = 32
const PDF_LOCATOR_IDLE_MS = 2 * 60_000
export type PrivateRequestReceipt = { ok: true; state: string; turnId?: string; receipt: { state: string; result?: { inline?: NativeSend } }; session: AcpSessionRecord }
export interface PrivateConversationPorts {
  directory(): string
  native<T, M extends RuntimeBodyMethod>(method: M, body: RuntimeBody<M>, commandId?: string, current?: () => boolean): Promise<T>
  publish(channel: string, payload: unknown): void
  active?(): boolean
  workspaceHasRequirements?(conversationId: string): boolean
}
export class PrivateConversations {
  private storage?: ConversationStorage
  private previewSources = new Map<string, { conversation: contract.Conversation; rootIdentity: string }>()
  private pdfLocators = new Map<string, PdfLocator>()
  private grants = new Map<string, { root: string; identity: string; expires: number; owner?: object; timer: ReturnType<typeof setTimeout> }>()
  private sending = new Map<string, { requestId: string; digest: string; promise: Promise<contract.ConversationResult<{ conversation: contract.Conversation; session: AcpSessionRecord; turnId: string }>> }>()
  private configuring = new Set<string>()
  private cancelledSends = new Set<string>()
  private observers = new Map<string, { id: string; selected: boolean; busy: boolean; cursor: RuntimeCursor | null; nextAt: number; touchedAt: number; live: boolean }>()
  private observerTimer?: NodeJS.Timeout
  private designHooks?: {
    prepareSend(id: string, input: contract.ConversationSend, current?: () => void): Promise<{ input: contract.ConversationSend; displayText?: string; assertCurrent?: () => void }>
    hasConversation(id: string): boolean
  }
  constructor(private readonly ports: PrivateConversationPorts) {}
  /** Main-owned design intent; neither paths nor expanded display text are renderer inputs. */
  setDesignHooks(hooks: NonNullable<PrivateConversations['designHooks']>): void { this.designHooks = hooks }
  creatorIdentity(): string { return this.localCreator() }
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
  metadataDirectory(): string { return this.directory() }
  async workspaceAccess(id: string, writable = false): Promise<{ conversation: contract.Conversation; sourceIdentity: string; runtimeId: string; assertCurrent(): void }> {
    const row = await this.owned(id)
    const root = row.conversation.workspace.root, rootKey = pathKey(root), identity = row.rootIdentity
    const creator = row.conversation.creatorId, nativeCreator = row.nativeCreatorId, nativeRef = row.conversation.nativeRef
    const sourceGeneration = row.sourceGeneration
    const runtimeId = nativeRef?.agentId ?? row.draft.runtimeId ?? 'pi'
    const assertCurrent = (): void => {
      const current = this.load(id)
      if (writable && current.conversation.archivedAt !== undefined) throw new ConversationError('会话已归档，请恢复后再继续')
      if (current.conversation.creatorId !== creator || current.nativeCreatorId !== nativeCreator || current.sourceGeneration !== sourceGeneration || (current.conversation.nativeRef?.agentId ?? current.draft.runtimeId ?? 'pi') !== runtimeId || pathKey(current.conversation.workspace.root) !== rootKey || current.rootIdentity !== identity || directoryIdentity(root) !== identity || nativeRef && JSON.stringify(current.conversation.nativeRef) !== JSON.stringify(nativeRef)) throw new ConversationError('原会话目录或执行身份已变化，请重新打开。')
    }
    assertCurrent()
    return { conversation: row.conversation, sourceIdentity: hash(JSON.stringify([id, creator, nativeCreator, rootKey, identity, row.conversation.workspace.kind])), runtimeId, assertCurrent }
  }
  consumeWorkspaceGrant(id: string, owner?: object): { root: string; kind: 'directory' } {
    const directory = this.consumeDirectory(id, owner)
    return { root: directory.root, kind: 'directory' }
  }
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
    return { conversation: row.conversation, draft: row.draft, ...(session ? { session } : {}), ...(runtimeError ? { runtimeError } : {}), ...(row.pending?.modelChangeUncertain ? { modelConfirmationRequired: true } : {}) }
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
    const row: Row = { version: 2, revision: 1, nativeCreatorId: creatorId, conversation: { id, creatorId, title: '新对话', kind: input.kind, projectId: input.projectId, workspace, createdAt: now, updatedAt: now }, draft: { text: input.text, runtimeId: input.runtimeId, modelId: input.modelId }, rootIdentity: directoryIdentity(workspace.root), inputs: [] }
    await this.authorized(row); this.save(row)
    return this.value(row)
  }
  async updateDraft(id: string, raw: unknown, directoryOwner?: object): Promise<contract.ConversationRead> {
    const input = contract.conversationUpdateDraftSchema.parse(raw), row = await this.owned(id)
    const before = JSON.stringify(row)
    // A text save may arrive after first-send reserved the same native engine.
    // Repeating unchanged draft settings is not a request to reconfigure it.
    if (row.conversation.nativeRef && (input.runtimeId !== undefined && input.runtimeId !== row.conversation.nativeRef.agentId
      || input.modelId !== undefined && (input.modelId ?? undefined) !== row.draft.modelId
      || input.directoryGrantId !== undefined)) throw new ConversationError('原生会话已绑定，不能改运行时或执行目录')
    if (input.directoryGrantId && row.conversation.kind === 'work') throw new ConversationError('Work 的执行目录由应用持有', IpcErrorCode.InvalidArg)
    if (input.directoryGrantId && (this.ports.workspaceHasRequirements?.(id) || this.designHooks?.hasConversation(id))) throw new ConversationError('此会话已保存需求或设计，请为其他工程新建对话')
    if (input.text !== undefined) row.draft.text = input.text
    if (input.title !== undefined) row.conversation.title = input.title
    if (input.runtimeId !== undefined) row.draft.runtimeId = input.runtimeId
    if (input.modelId !== undefined) row.draft.modelId = input.modelId ?? undefined
    if (input.directoryGrantId) { row.conversation.workspace = this.consumeDirectory(input.directoryGrantId, directoryOwner); row.rootIdentity = directoryIdentity(row.conversation.workspace.root); row.inputs = [] }
    if (input.pinned === true) row.conversation.pinnedAt ??= Date.now()
    else if (input.pinned === false) delete row.conversation.pinnedAt
    if (input.archived === true) row.conversation.archivedAt ??= Date.now()
    else if (input.archived === false) delete row.conversation.archivedAt
    if (before !== JSON.stringify(row)) { row.conversation.updatedAt = Date.now(); this.save(row, row.revision) }
    return this.value(row)
  }
  async read(id: string): Promise<contract.ConversationRead> { return this.value(await this.owned(id)) }
  private markInitialModelChange(row: Row): string | undefined {
    if (!row.pending?.initial || row.pending.state !== 'preparing') return undefined
    row.pending.modelChangeUncertain = true
    this.save(row, row.revision)
    return row.pending.requestId
  }
  private confirmInitialModelChange(row: Row, requestId: string | undefined, session: AcpSessionRecord, modelId: string): boolean {
    if (!requestId) return true
    const latest = this.load(row.conversation.id)
    if (latest.pending?.requestId !== requestId || !latest.pending.modelChangeUncertain || latest.conversation.nativeRef?.sessionId !== row.conversation.nativeRef?.sessionId || session.sessionId !== row.conversation.nativeRef?.sessionId || session.currentModelId !== modelId) return false
    latest.pending.initialModelPending = false
    delete latest.pending.modelChangeUncertain
    this.save(latest, latest.revision)
    return true
  }
  async configure(id: string, raw: unknown): Promise<contract.ConversationResult<AcpSessionRecord>> {
    const input = conversationConfigureSchema.parse(raw)
    if (this.sending.has(id) || this.configuring.has(id)) return ipcFail(IpcErrorCode.Busy, '请等待原会话操作结束后调整参数')
    this.configuring.add(id)
    try {
      const row = await this.owned(id)
      if (row.conversation.archivedAt !== undefined) return ipcFail(IpcErrorCode.Conflict, '会话已归档，请恢复后再调整参数')
      if (!row.conversation.nativeRef) return ipcFail(IpcErrorCode.Busy, '请等待原会话发送结束后调整参数')
      const pendingChange = input.configuration.kind === 'model' ? this.markInitialModelChange(row) : undefined
      const result = await this.ports.native<NativeSession, 'runtime.privateConfigure'>('runtime.privateConfigure', { ...this.nativeOwner(row), input }, undefined,
        () => { const current = this.load(id).conversation; return current.creatorId === this.localCreator() && current.archivedAt === undefined })
      await this.authorized(row)
      if (result.ok && pendingChange && (result.session.connectionGeneration !== input.expectedConnectionGeneration || !this.confirmInitialModelChange(row, pendingChange, result.session, input.configuration.id))) return ipcFail(IpcErrorCode.Conflict, '模型变更尚未确认，请重新选择模型后发送')
      return result.ok ? { ok: true, value: { ...result.session, events: [] } } : result
    } finally { this.configuring.delete(id) }
  }
  async recoverModel(id: string, raw: unknown): Promise<contract.ConversationResult<AcpSessionRecord>> {
    const input = conversationRecoverModelSchema.parse(raw)
    if (this.sending.has(id) || this.configuring.has(id)) return ipcFail(IpcErrorCode.Busy, '请等待原会话操作结束后核对模型')
    this.configuring.add(id)
    try {
      const row = await this.owned(id)
      if (row.conversation.archivedAt !== undefined) return ipcFail(IpcErrorCode.Conflict, '会话已归档，请恢复后再核对模型')
      if (!row.conversation.nativeRef) return ipcFail(IpcErrorCode.Busy, '请等待原会话发送结束后核对模型')
      const pendingChange = this.markInitialModelChange(row)
      const result = await this.ports.native<NativeSession, 'runtime.privateRecoverModel'>('runtime.privateRecoverModel', { ...this.nativeOwner(row), input }, undefined,
        () => { const current = this.load(id).conversation; return current.creatorId === this.localCreator() && current.archivedAt === undefined })
      await this.authorized(row)
      if (result.ok && pendingChange && (!result.session.connectionGeneration || !this.confirmInitialModelChange(row, pendingChange, result.session, input.modelId))) return ipcFail(IpcErrorCode.Conflict, '模型恢复尚未确认，请重新选择模型后发送')
      return result.ok ? { ok: true, value: { ...result.session, events: [] } } : result
    } finally { this.configuring.delete(id) }
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
  /** Main-owned action reconciliation; the renderer cannot issue arbitrary native RPCs. */
  async requestReceipt(id: string, requestId: string): Promise<PrivateRequestReceipt | IpcFail> {
    contract.conversationIdSchema.parse(requestId)
    const row = await this.owned(id)
    if (!row.conversation.nativeRef) return ipcFail(IpcErrorCode.NotFound, '原需求操作尚未建立原生会话')
    const result = await this.ports.native<PrivateRequestReceipt | IpcFail, 'runtime.privateRead'>('runtime.privateRead', { ...this.nativeOwner(row), operation: 'receipt', requestId })
    await this.authorized(row)
    return result
  }
  async send(id: string, raw: unknown, visibleText?: string, assertCurrent?: () => void, assertDispatch?: () => void): Promise<contract.ConversationResult<{ conversation: contract.Conversation; session: AcpSessionRecord; turnId: string }>> {
    assertCurrent?.()
    const original = contract.conversationSendSchema.parse(raw)
    const prepared = visibleText === undefined && this.designHooks ? await this.designHooks.prepareSend(id, original, assertCurrent) : { input: original, displayText: visibleText }
    const ownerCurrent = (): void => { assertCurrent?.(); assertDispatch?.(); if ('assertCurrent' in prepared) prepared.assertCurrent?.() }
    const displayText = contract.privateNativeSendSchema.shape.displayText.parse(prepared.displayText)
    const input = contract.conversationSendSchema.parse(prepared.input), digest = hash(JSON.stringify({ text: input.text, images: input.images ?? [], ...(input.draftText === undefined ? {} : { draftText: input.draftText }), ...(displayText === undefined ? {} : { displayText }) }))
    if (this.configuring.has(id)) return ipcFail(IpcErrorCode.Busy, '请等待原会话配置结束后发送')
    const existing = this.sending.get(id)
    if (existing) return existing.requestId === input.requestId && existing.digest === digest ? existing.promise : ipcFail(IpcErrorCode.Busy, '原会话正在接纳消息，草稿已保留')
    const promise = this.sendOwned(id, input, digest, displayText, assertCurrent, ownerCurrent)
    this.sending.set(id, { requestId: input.requestId, digest, promise })
    try { return await promise } finally { if (this.sending.get(id)?.promise === promise) this.sending.delete(id); this.cancelledSends.delete(input.requestId) }
  }
  private async sendOwned(id: string, input: contract.ConversationSend, digest: string, displayText?: string, assertCurrent?: () => void, assertDispatch?: () => void): Promise<contract.ConversationResult<{ conversation: contract.Conversation; session: AcpSessionRecord; turnId: string }>> {
    assertCurrent?.()
    let row = await this.reconcile(await this.owned(id))
    if (row.conversation.archivedAt !== undefined) return ipcFail(IpcErrorCode.Conflict, '会话已归档，请恢复后再发送')
    if (!input.text.trim() && !input.images?.length) return ipcFail(IpcErrorCode.InvalidArg, '请输入消息或选择图片')
    if (row.pending?.modelChangeUncertain) return ipcFail(IpcErrorCode.Conflict, '模型变更结果尚未确认，请重新选择模型后发送，草稿已保留', { notSent: true })
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
    const initial = !row.conversation.nativeRef || row.pending?.initial === true && row.pending.state === 'preparing'
    const initialModelPending = initial && (!row.conversation.nativeRef || row.pending?.initialModelPending === true)
    const initialModelId = initialModelPending && (row.conversation.nativeRef?.agentId ?? row.draft.runtimeId ?? 'pi') === 'pi' ? row.draft.modelId : undefined
    row.conversation.nativeRef ??= { sessionId: `acp-private-${id}`, agentId: row.draft.runtimeId ?? 'pi' }
    const textDigest = input.draftText === undefined ? undefined : hash(input.draftText)
    row.pending = { requestId: input.requestId, digest, textDigest, initial, initialModelPending, state: 'preparing' }
    row.conversation.updatedAt = Date.now(); this.save(row, row.revision)
    const current = (): boolean => {
      try { assertCurrent?.(); assertDispatch?.() } catch { return false }
      return !this.cancelledSends.has(input.requestId) && this.sending.get(id)?.requestId === input.requestId && this.sending.get(id)?.digest === digest && this.load(id).conversation.archivedAt === undefined
    }
    let prepared: NativeSend
    try {
      prepared = await this.ports.native<NativeSend, 'runtime.privateSend'>('runtime.privateSend', { ...this.nativeOwner(row), agentId: row.conversation.nativeRef.agentId, operation: 'prepare', initialModelId, displayText, input }, undefined, current)
    } catch (error) {
      // Prepare reserves/connects the original owner and may configure its
      // model; only the separate send operation can dispatch this request.
      const code = error && typeof error === 'object' && 'code' in error && Object.values(IpcErrorCode).includes(error.code as typeof IpcErrorCode.Io) ? error.code as typeof IpcErrorCode.Io : IpcErrorCode.Io
      return ipcFail(code, `${error instanceof Error ? error.message : '原会话接纳尚未完成'}；消息未发送`, { notSent: true, requestId: input.requestId })
    }
    if (!prepared.ok) return ipcFail(prepared.code, `${prepared.error}；原执行身份已保留，此会话不能切换执行引擎`, { notSent: true })
    row = await this.owned(id)
    if (!current() || this.cancelledSends.has(input.requestId)) return ipcFail(IpcErrorCode.Conflict, '原消息已停止或来源已变化，消息未发送', { notSent: true })
    const agentId = row.conversation.nativeRef?.agentId
    if (!agentId || !prepared.session.connectionGeneration) return ipcFail(IpcErrorCode.Conflict, '原生身份尚未确认')
    row.pending = { requestId: input.requestId, digest, textDigest, initial, initialModelPending: false, state: 'dispatching' }; this.save(row, row.revision)
    let sent: NativeSend
    try {
      sent = await this.ports.native<NativeSend, 'runtime.privateSend'>('runtime.privateSend', { ...this.nativeOwner(row), agentId, operation: 'send', displayText, input: { ...input, expectedConnectionGeneration: prepared.session.connectionGeneration } }, input.requestId, current)
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
      latest.pending = { requestId: input.requestId, digest, textDigest, initial, initialModelPending: false, state: 'sent', turnId: sent.turnId }
      if (input.draftText !== undefined && latest.draft.text === input.draftText) latest.draft.text = ''
      if (latest.conversation.title === '新对话') latest.conversation.title = (displayText ?? input.text).trim().split(/\r?\n/, 1)[0].slice(0, 80) || '图片对话'
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
  private fileSourceIdentity(row: Row): string {
    return hash(JSON.stringify([row.conversation.id, row.conversation.creatorId, row.nativeCreatorId, pathKey(row.conversation.workspace.root), row.rootIdentity, row.conversation.workspace.kind, row.conversation.kind, row.conversation.archivedAt, row.sourceGeneration]))
  }
  async files(id: string): Promise<contract.ConversationFile[]> {
    const owner = await this.workspaceAccess(id), row = this.load(id)
    owner.assertCurrent()
    const sourceIdentity = this.fileSourceIdentity(row)
    const files = workspaceFiles(row.conversation.workspace.root, row.inputs, row.conversation.workspace.kind === 'managed')
    owner.assertCurrent()
    if (this.fileSourceIdentity(this.load(id)) !== sourceIdentity) throw new ConversationError('原会话来源已变化，请刷新文件')
    return files.map(({ fileIdentity, ...file }) => ({ ...file, sourceIdentity: hash(JSON.stringify([sourceIdentity, fileIdentity])) }))
  }
  async importFiles(id: string, paths: string[]): Promise<contract.ConversationFile[]> {
    const row = await this.owned(id)
    if (row.inputs.length + paths.length > 256) throw new ConversationError('会话已达到 256 个选入文件上限', IpcErrorCode.Busy)
    const directory = row.conversation.workspace.kind === 'managed' ? 'inputs' : `.trellis-panel/conversations/${id}/inputs`
    const files = importSelectedFiles(row.conversation.workspace.root, directory, paths)
    row.inputs.push(...files.map(file => file.relativePath)); row.conversation.updatedAt = Date.now()
    try { this.save(row, row.revision) } catch (error) { removeImportedFiles(row.conversation.workspace.root, files); throw error }
    return files
  }
  async file(id: string, fileId: string, revision?: string, limit?: number, expectedSourceIdentity?: string) {
    const owner = await this.workspaceAccess(id), row = this.load(id), sourceIdentity = this.fileSourceIdentity(row)
    owner.assertCurrent()
    if (expectedSourceIdentity && row.conversation.archivedAt !== undefined) throw new ConversationError('原会话已归档，请重新选择文件')
    const file = workspaceFiles(row.conversation.workspace.root, row.inputs, row.conversation.workspace.kind === 'managed').find(file => file.id === fileId)
    if (!file) throw new ConversationError('会话文件已移除或不可访问', IpcErrorCode.NotFound)
    const actual = readRegular(row.conversation.workspace.root, file.relativePath, limit)
    owner.assertCurrent()
    if (this.fileSourceIdentity(this.load(id)) !== sourceIdentity) throw new ConversationError('原会话来源已变化，请重新选择文件')
    if (expectedSourceIdentity && expectedSourceIdentity !== hash(JSON.stringify([sourceIdentity, actual.fileIdentity]))) throw new ConversationError('原会话来源或文件身份已变化，请重新选择文件')
    if (revision && hash(actual.bytes) !== revision) throw new ConversationError('原文件已修改，请刷新文件后重新选择')
    return { ...actual, file: { ...file, revision: hash(actual.bytes), bytes: actual.bytes.length, modifiedAt: actual.modifiedAt } }
  }
  private prunePdfLocators(): void {
    const now = Date.now()
    for (const [locator, entry] of this.pdfLocators) if (entry.expires <= now) this.pdfLocators.delete(locator)
  }
  private ensurePreviewLocatorCapacity(): void {
    this.prunePdfLocators()
    if (this.pdfLocators.size >= PDF_LOCATOR_LIMIT) throw new ConversationError('预览数量已达上限，请关闭其他预览后重试', IpcErrorCode.Busy)
  }
  releasePdfLocators(owner?: object): void {
    for (const [locator, entry] of this.pdfLocators) if (owner === undefined || entry.owner === owner) this.pdfLocators.delete(locator)
  }
  releasePdfLocator(locator: string, owner: object): void {
    this.prunePdfLocators()
    const entry = this.pdfLocators.get(locator)
    if (!entry || entry.owner !== owner) throw new ConversationError('PDF 定位记录已失效，请重新打开', IpcErrorCode.Denied)
    this.pdfLocators.delete(locator)
  }
  async previewPdf(id: string, input: { fileId: string; expectedRevision: string; expectedSourceIdentity: string }, owner: object, current: () => void) {
    const actual = await this.file(id, input.fileId, input.expectedRevision, contract.CONVERSATION_PDF_PREVIEW_MAX_BYTES, input.expectedSourceIdentity)
    current()
    if (extname(actual.path).toLowerCase() !== '.pdf' || !actual.bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new ConversationError('此文件不是可识别的 PDF', IpcErrorCode.InvalidArg)
    this.ensurePreviewLocatorCapacity()
    const locator = randomUUID()
    this.pdfLocators.set(locator, { owner, conversationId: id, fileId: input.fileId, relativePath: actual.file.relativePath, kind: actual.file.kind, sourceIdentity: input.expectedSourceIdentity, revision: input.expectedRevision, expires: Date.now() + PDF_LOCATOR_IDLE_MS })
    try { await this.validatePdfLocator(locator, owner, current); current() }
    catch (error) { this.pdfLocators.delete(locator); throw error }
    return { name: actual.file.name, revision: actual.file.revision, data: Uint8Array.from(actual.bytes), locator }
  }
  async previewDocx(id: string, input: { fileId: string; expectedRevision: string; expectedSourceIdentity: string }, owner: object, current: () => void) {
    const maxBytes = 8 * 1024 * 1024
    let actual: Awaited<ReturnType<PrivateConversations['file']>>
    try { actual = await this.file(id, input.fileId, input.expectedRevision, maxBytes, input.expectedSourceIdentity) }
    catch (error) {
      if (error instanceof FileSizeLimitError) throw new ConversationError('DOCX 超过 8 MiB 预览大小上限，请使用系统打开。', IpcErrorCode.InvalidArg)
      throw error
    }
    current()
    if (extname(actual.path).toLowerCase() !== '.docx' || actual.bytes.length < 4 || actual.bytes.readUInt32LE(0) !== 0x04034b50) throw new ConversationError('此文件不是可识别的 DOCX', IpcErrorCode.InvalidArg)
    this.ensurePreviewLocatorCapacity()
    const locator = randomUUID()
    this.pdfLocators.set(locator, { owner, conversationId: id, fileId: input.fileId, relativePath: actual.file.relativePath, kind: actual.file.kind, sourceIdentity: input.expectedSourceIdentity, revision: input.expectedRevision, expires: Date.now() + PDF_LOCATOR_IDLE_MS, maxBytes })
    try { await this.validatePdfLocator(locator, owner, current); current() }
    catch (error) { this.pdfLocators.delete(locator); throw error }
    return { name: actual.file.name, revision: actual.file.revision, data: Uint8Array.from(actual.bytes), locator }
  }
  async validatePdfLocator(locator: string, pageOwner: object, current: () => void): Promise<void> {
    current(); this.prunePdfLocators()
    const entry = this.pdfLocators.get(locator)
    if (!entry || entry.owner !== pageOwner) throw new ConversationError('PDF 定位记录已失效，请重新打开', IpcErrorCode.Denied)
    let owner: Awaited<ReturnType<PrivateConversations['workspaceAccess']>>
    try { owner = await this.workspaceAccess(entry.conversationId, true) }
    catch (error) { if (error instanceof ConversationError) throw error; throw new ConversationError('原会话目录不可访问，请重新选择') }
    const assertCurrent = (): void => {
      current(); this.prunePdfLocators()
      if (this.pdfLocators.get(locator) !== entry || entry.owner !== pageOwner) throw new ConversationError('PDF 定位记录已失效，请重新打开', IpcErrorCode.Denied)
      try { owner.assertCurrent() }
      catch (error) { if (error instanceof ConversationError) throw error; throw new ConversationError('原会话目录不可访问，请重新选择') }
    }
    assertCurrent()
    const row = this.load(entry.conversationId), sourceIdentity = this.fileSourceIdentity(row)
    if (row.conversation.archivedAt !== undefined || !row.draft.text.trim() && !row.inputs.length && !row.conversation.nativeRef || !eligibleWorkspaceFile(entry.relativePath, entry.kind, row.inputs, row.conversation.workspace.kind === 'managed') || hash(entry.relativePath) !== entry.fileId) throw new ConversationError('原会话或文件已不可用，请重新选择')
    let actual: ReturnType<typeof readRegular>
    try { actual = readRegular(row.conversation.workspace.root, entry.relativePath, entry.maxBytes ?? contract.CONVERSATION_PDF_PREVIEW_MAX_BYTES) }
    catch { throw new ConversationError('原文件已移除、不可访问或已被重定向，请重新选择', IpcErrorCode.NotFound) }
    assertCurrent()
    if (this.fileSourceIdentity(this.load(entry.conversationId)) !== sourceIdentity || hash(JSON.stringify([sourceIdentity, actual.fileIdentity])) !== entry.sourceIdentity) throw new ConversationError('原会话来源或文件身份已变化，请重新选择文件')
    if (hash(actual.bytes) !== entry.revision) throw new ConversationError('原文件已修改，请重新选择')
    entry.expires = Date.now() + PDF_LOCATOR_IDLE_MS
    this.pdfLocators.delete(locator); this.pdfLocators.set(locator, entry)
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
  dispose(): void { this.releaseDirectoryGrants(); this.releasePdfLocators(); this.previewSources.clear(); this.observers.clear(); if (this.observerTimer) { clearInterval(this.observerTimer); this.observerTimer = undefined } }
}
export function privateConversationNative<T, M extends RuntimeBodyMethod>(method: M, body: RuntimeBody<M>, commandId?: string, current?: () => boolean): Promise<T> { return runtimeCall<T, M>('', method, body, commandId, current) }
