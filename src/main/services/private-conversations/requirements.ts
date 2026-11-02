import type { Conversation, ConversationFile, ConversationResult, ConversationSend } from '../../../shared/private-conversations'
import type { AcpSessionRecord, ProjectSnapshot } from '../../../shared/types'
import type { RequirementTargetSelection } from '../../../shared/conversation-requirements'
import type { RequirementKnowledgeSourceRef } from '../../../shared/conversation-requirement-knowledge'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, opendirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { z } from 'zod'
import * as dto from '../../../shared/conversation-requirements'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { createTaskRecordAt } from '../task-record'
import { checkedDirectory, directoryIdentity, hash, ownedDirectory, pathKey, readRegular } from './files'
import { RequirementError, readOptional, trellisTarget, utf8, writeRevision } from './requirement-files'
import { actionDisplay, actionPrompt, actionSourceDocument, confirmedRequirement, currentPlan, readActionCandidate, readActionSource, requirementActionSourceSchema, requirementSourceDigest, REQUIREMENT_SOURCE_BYTES } from './requirement-actions'
import { hasRequirementQuote } from './requirement-quote'
import { validateRequirementKnowledgeSourceSnapshot } from './requirement-knowledge'

export interface ConversationRequirementOwner { conversation: Conversation; assertCurrent(): void }
export interface RequirementNativeObservation {
  state: 'not-sent' | 'running' | 'completed' | 'cancelled' | 'failed' | 'unknown'
  requestId: string
  sessionId?: string
  connectionGeneration?: string
  turnId?: string
  detail?: string
}
export interface ConversationRequirementPorts {
  /** Existing app-owned userData/private-conversations directory. */
  metaDirectory(): string
  owner(conversationId: string): Promise<ConversationRequirementOwner>
  selectedFile(conversationId: string, fileId: string, revision: string): Promise<{ bytes: Uint8Array; file: ConversationFile }>
  resolveTarget(conversation: Conversation, selection: RequirementTargetSelection, directoryOwner?: object, assertCurrent?: () => void): string | Promise<string>
  openTask(root: string, taskDir: string, assertCurrent?: () => void): Promise<{ snapshot: ProjectSnapshot; taskDir: string }>
  /** Delegates to the original PrivateConversations.send; never another executor. */
  send(conversationId: string, input: ConversationSend, assertCurrent: () => void, displayText: string): Promise<ConversationResult<{ conversation: Conversation; session: AcpSessionRecord; turnId: string }>>
  /** Reconcile the original request/turn; an idle session alone is not terminal proof. */
  nativeObservation(conversationId: string, operation: dto.RequirementOperation, assertCurrent: () => void): Promise<RequirementNativeObservation>
  conversationContext?(conversationId: string, assertCurrent: () => void): Promise<{ text: string; revision: string }>
  knowledge?(conversationId: string, selection: dto.RequirementKnowledgeSelection, sources: RequirementKnowledgeSourceRef[], assertCurrent: () => void): Promise<dto.RequirementKnowledgeSnapshot[]>
}

export type RequirementResult<T> = ConversationResult<T>

const id = z.string().uuid()
const manifestPath = 'references/conversation-requirement.json'
const intentSchema = z.object({ commandId: id, draftRevision: id, targetId: id, taskId: z.string().min(1).max(100), taskDir: z.string().min(1).max(200), started: z.boolean(), body: z.string().max(200_000), title: z.string().max(200).optional(), manifest: z.string().max(64 * 1024), references: z.array(dto.requirementReferenceSchema).max(8), plan: dto.requirementPlanSchema.optional(), confirmed: dto.requirementConfirmedSchema.optional(), blocked: z.literal('manifest-budget').optional() }).strict()
const recordSchema = z.object({ version: z.literal(1), conversationRoot: z.string().min(1).max(8192), rootIdentity: z.string().min(1), creationCommandId: id, draft: dto.requirementDraftSchema, targetIdentity: z.string().optional(), intent: intentSchema.optional(), confirmations: z.array(z.object({ commandId: id, expectedRevision: id, confirmed: dto.requirementConfirmedSchema }).strict()).max(128).default([]) }).strict()
const createCommandSchema = z.object({ version: z.literal(1), conversationId: id, creatorId: z.string(), root: z.string(), rootIdentity: z.string(), commandId: id, inputDigest: z.string().length(64), draftId: id, createdAt: z.number().int().nonnegative(), state: z.enum(['registered', 'saved']).default('registered') }).strict()
type Record = z.infer<typeof recordSchema>
type Loaded = { record: Record; digest: string }
type Owner = ConversationRequirementOwner
const sameRoot = (left: string, right: string): boolean => pathKey(left) === pathKey(right)
const dayPrefix = (): string => { const now = new Date(); return `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` }
const referenceTarget = (reference: dto.RequirementReference, index: number): string => `references/requirement-files/${index}${extname(reference.snapshotPath)}`

export class ConversationRequirements {
  private lanes = new Map<string, Promise<void>>()
  private documents = new AsyncLocalStorage<() => void>()
  constructor(private readonly ports: ConversationRequirementPorts) {}
  private meta(): string { return checkedDirectory(this.ports.metaDirectory()) }
  private rowPath(conversationId: string, draftId: string): string { return `requirements/${id.parse(conversationId)}/drafts/${id.parse(draftId)}.json` }
  private async owner(conversationId: string, writable = false): Promise<Owner> {
    id.parse(conversationId)
    const document = this.documents.getStore() ?? (() => {})
    document()
    const captured = await this.ports.owner(conversationId)
    const owner: Owner = { conversation: captured.conversation, assertCurrent: () => { document(); captured.assertCurrent() } }
    owner.assertCurrent()
    if (owner.conversation.id !== conversationId) throw new RequirementError('需求来源与原会话不一致', 'E_DENIED')
    if (writable && owner.conversation.archivedAt !== undefined) throw new RequirementError('会话已归档，请恢复后再修改或交接需求')
    return owner
  }
  private async fresh(previous: Owner, writable = false): Promise<Owner> {
    previous.assertCurrent()
    const current = await this.owner(previous.conversation.id, writable)
    previous.assertCurrent(); current.assertCurrent()
    if (current.conversation.creatorId !== previous.conversation.creatorId || !sameRoot(current.conversation.workspace.root, previous.conversation.workspace.root)) throw new RequirementError('原会话创建者或执行目录已变化', 'E_DENIED')
    return current
  }
  private load(owner: Owner, draftId: string): Loaded {
    owner.assertCurrent()
    const bytes = readRegular(this.meta(), this.rowPath(owner.conversation.id, draftId), 2 * 1024 * 1024).bytes
    const record = recordSchema.parse(JSON.parse(utf8(bytes)))
    if (hash(record.draft.body) !== record.draft.bodyRevision || record.draft.plan && hash(record.draft.plan.body) !== record.draft.plan.bodyRevision) throw new RequirementError('已保存文档摘要与实际正文不一致', 'E_IO')
    if (record.draft.id !== draftId || record.draft.conversationId !== owner.conversation.id || record.draft.creatorId !== owner.conversation.creatorId || !sameRoot(record.conversationRoot, owner.conversation.workspace.root) || directoryIdentity(record.conversationRoot) !== record.rootIdentity) throw new RequirementError('需求不属于原会话或原目录', 'E_DENIED')
    owner.assertCurrent()
    return { record, digest: hash(bytes) }
  }
  private persist(owner: Owner, record: Record, previous: string | null): Loaded {
    owner.assertCurrent()
    const bytes = Buffer.from(JSON.stringify(recordSchema.parse(record)))
    if (bytes.length > 2 * 1024 * 1024) throw new RequirementError('需求记录超过存储上限', 'E_BUSY')
    writeRevision(this.meta(), this.rowPath(owner.conversation.id, record.draft.id), bytes, previous, owner.assertCurrent)
    owner.assertCurrent()
    return { record, digest: hash(bytes) }
  }
  private result<T>(action: () => Promise<T>, current?: () => void): Promise<RequirementResult<T>> {
    const document = current ?? this.documents.getStore() ?? (() => {})
    return this.documents.run(document, async (): Promise<RequirementResult<T>> => {
    try { document(); return { ok: true, value: await action() } }
    catch (error) {
      if (error instanceof z.ZodError) return ipcFail(IpcErrorCode.InvalidArg, error.issues[0]?.message ?? '需求参数无效')
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      const known = Object.values(IpcErrorCode).find(value => value === code)
      return ipcFail(known ?? IpcErrorCode.Io, error instanceof Error ? error.message : '需求操作尚未确认')
    }
    })
  }
  private async serial<T>(conversationId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(conversationId) ?? Promise.resolve()
    let release: () => void = () => {}
    const gate = new Promise<void>(done => { release = done })
    const tail = previous.then(() => gate)
    this.lanes.set(conversationId, tail)
    await previous
    try { return await action() }
    finally { release(); if (this.lanes.get(conversationId) === tail) this.lanes.delete(conversationId) }
  }
  hasDrafts(conversationId: string): boolean {
    try {
      const directory = join(this.meta(), 'requirements', id.parse(conversationId))
      if (!existsSync(directory)) return false
      checkedDirectory(directory)
      const stream = opendirSync(directory)
      try { return stream.readSync() !== null } finally { stream.closeSync() }
    } catch { return true }
  }
  private view(owner: Owner, record: Record): dto.RequirementView {
    owner.assertCurrent()
    const plan = record.draft.plan
    let planFileState: dto.RequirementView['planFileState'], planFileRevision: string | undefined
    if (plan) {
      try { const file = readOptional(record.conversationRoot, plan.relativePath); planFileRevision = file ? hash(file.bytes) : undefined; planFileState = file ? planFileRevision === plan.bodyRevision ? 'saved' : 'changed' : 'missing' }
      catch { planFileState = 'unavailable' }
    }
    const result = { draft: record.draft, planFileState, planFileRevision }
    try {
      const file = readOptional(record.conversationRoot, record.draft.relativePath)
      if (!file) return { ...result, fileState: 'missing', detail: '实际 Markdown 文件不存在；已保存的草稿仍保留' }
      utf8(file.bytes)
      const revision = hash(file.bytes)
      return { ...result, fileState: revision === record.draft.bodyRevision ? 'saved' : 'changed', fileRevision: revision }
    } catch (error) { return { ...result, fileState: 'unavailable', detail: error instanceof Error ? error.message : '需求文件不可读' } }
  }
  private cas(record: Record, revision: string): void { if (record.draft.revision !== revision) throw new RequirementError('需求草稿版本已变化，请重新读取') }
  private editable(record: Record): void { if (record.intent && record.draft.handoff?.state !== 'created') throw new RequirementError('原交接尚待核对；不能改变已确认的正文或引用') }
  private async references(owner: Owner, draftPath: string, selections: dto.RequirementFileSelection[]): Promise<dto.RequirementReference[]> {
    const prepared: Array<{ bytes: Buffer; reference: dto.RequirementReference }> = []
    let total = 0
    for (const [index, selected] of selections.entries()) {
      const actual = await this.ports.selectedFile(owner.conversation.id, selected.fileId, selected.revision)
      owner.assertCurrent()
      const bytes = Buffer.from(actual.bytes)
      total += bytes.length
      if (bytes.length > dto.REQUIREMENT_FILE_BYTES || total > dto.REQUIREMENT_REFERENCES_BYTES || actual.file.id !== selected.fileId || actual.file.revision !== selected.revision || hash(bytes) !== selected.revision) throw new RequirementError('所选文件版本已改变或超过引用大小限制')
      const suffix = extname(actual.file.name).slice(1).toLowerCase()
      const extension = /^[a-z0-9]{1,10}$/.test(suffix) ? suffix : 'bin'
      const snapshotPath = `${draftPath.slice(0, draftPath.lastIndexOf('/'))}/sources/${index}-${hash(selected.fileId).slice(0, 12)}-${selected.revision}.${extension}`
      prepared.push({ bytes, reference: dto.requirementReferenceSchema.parse({ ...selected, name: actual.file.name, relativePath: actual.file.relativePath, snapshotPath, bytes: bytes.length }) })
    }
    const current = await this.fresh(owner, true)
    for (const value of prepared) {
      current.assertCurrent()
      const existing = readOptional(owner.conversation.workspace.root, value.reference.snapshotPath, dto.REQUIREMENT_FILE_BYTES)
      if (existing) { if (hash(existing.bytes) !== value.reference.revision) throw new RequirementError('已保存的引用版本被修改') }
      else writeRevision(owner.conversation.workspace.root, value.reference.snapshotPath, value.bytes, null, current.assertCurrent)
    }
    return prepared.map(value => value.reference)
  }
  list(conversationId: string, current?: () => void): Promise<RequirementResult<dto.RequirementSummary[]>> {
    return this.result(async () => {
      const owner = await this.owner(conversationId), directory = join(this.meta(), 'requirements', conversationId, 'drafts')
      if (!existsSync(directory)) return []
      checkedDirectory(directory)
      const stream = opendirSync(directory), records: dto.RequirementSummary[] = []
      let scanned = 0
      try {
        for (let entry = stream.readSync(); entry; entry = stream.readSync()) {
          if (++scanned > 256) throw new RequirementError('需求目录超过读取上限', 'E_BUSY')
          if (!/^[a-f0-9-]{36}\.json$/.test(entry.name)) continue
          const { body: _body, references, plan, operations: _operations, ...draft } = this.load(owner, entry.name.slice(0, -5)).record.draft
          records.push({ ...draft, referenceCount: references.length, hasPlan: Boolean(plan), planStale: plan?.stale ?? false })
          if (records.length > 128) throw new RequirementError('此会话需求草稿超过 128 份', 'E_BUSY')
        }
      } finally { stream.closeSync() }
      owner.assertCurrent()
      return records.sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
    }, current)
  }
  create(conversationId: string, raw: unknown, current?: () => void): Promise<RequirementResult<dto.RequirementView>> {
    return this.result(() => this.serial(conversationId, async () => {
      const input = dto.requirementCreateSchema.parse(raw), owner = await this.owner(conversationId, true)
      const commandPath = `requirements/${conversationId}/creates/${input.commandId}.json`, digest = hash(JSON.stringify(input))
      const prior = readOptional(this.meta(), commandPath, 16 * 1024)
      let command: z.infer<typeof createCommandSchema>
      if (prior) {
        command = createCommandSchema.parse(JSON.parse(utf8(prior.bytes)))
        if (command.conversationId !== conversationId || command.creatorId !== owner.conversation.creatorId || command.inputDigest !== digest || !sameRoot(command.root, owner.conversation.workspace.root) || command.rootIdentity !== directoryIdentity(command.root)) throw new RequirementError('原创建命令的内容或归属不同，未创建另一份草稿')
        if (existsSync(join(this.meta(), this.rowPath(conversationId, command.draftId)))) {
          const record = this.load(owner, command.draftId).record
          if (record.creationCommandId !== input.commandId) throw new RequirementError('原创建回执身份不一致')
          const view = this.view(owner, record)
          if (command.state === 'registered' && view.fileState === 'missing') writeRevision(record.conversationRoot, record.draft.relativePath, Buffer.from(record.draft.body), null, owner.assertCurrent)
          if (command.state === 'registered' && this.view(owner, record).fileState === 'saved') this.completeCreate(owner, commandPath, command)
          return this.view(owner, record)
        }
      } else {
        const existing = await this.list(conversationId)
        if (!existing.ok) throw new RequirementError(existing.error, existing.code as RequirementError['code'])
        if (existing.value.length >= 128) throw new RequirementError('此会话最多保留 128 份需求草稿', 'E_BUSY')
        const directory = join(this.meta(), 'requirements', conversationId, 'creates')
        if (existsSync(directory)) {
          const stream = opendirSync(checkedDirectory(directory))
          let count = 0
          try { for (let entry = stream.readSync(); entry; entry = stream.readSync()) if (++count >= 128) throw new RequirementError('需求草稿与待恢复创建已达到 128 项上限，请核对原创建命令', 'E_BUSY') }
          finally { stream.closeSync() }
        }
        command = { version: 1, conversationId, creatorId: owner.conversation.creatorId, root: owner.conversation.workspace.root, rootIdentity: directoryIdentity(owner.conversation.workspace.root), commandId: input.commandId, inputDigest: digest, draftId: randomUUID(), createdAt: Date.now(), state: 'registered' }
        writeRevision(this.meta(), commandPath, Buffer.from(JSON.stringify(command)), null, owner.assertCurrent)
      }
      const relativePath = owner.conversation.workspace.kind === 'managed' ? `outputs/requirements/${command.draftId}/draft.md` : `.trellis-panel/conversations/${conversationId}/requirements/${command.draftId}/draft.md`
      const references = await this.references(owner, relativePath, input.references)
      const current = await this.fresh(owner, true)
      const draft = dto.requirementDraftSchema.parse({ id: command.draftId, conversationId, creatorId: current.conversation.creatorId, title: input.title, body: input.body, revision: randomUUID(), bodyRevision: hash(input.body), relativePath, references, createdAt: command.createdAt, updatedAt: command.createdAt })
      const record: Record = { version: 1, conversationRoot: command.root, rootIdentity: command.rootIdentity, creationCommandId: input.commandId, draft, confirmations: [] }
      this.persist(current, record, null)
      writeRevision(record.conversationRoot, relativePath, Buffer.from(input.body), null, current.assertCurrent)
      this.completeCreate(current, commandPath, command)
      return this.view(current, record)
    }), current)
  }
  private completeCreate(owner: Owner, path: string, command: z.infer<typeof createCommandSchema>): void {
    const original = readRegular(this.meta(), path, 16 * 1024).bytes
    const current = createCommandSchema.parse(JSON.parse(utf8(original)))
    if (current.commandId !== command.commandId || current.inputDigest !== command.inputDigest || current.draftId !== command.draftId || current.creatorId !== owner.conversation.creatorId) throw new RequirementError('原草稿创建身份已变化')
    if (current.state === 'saved') return
    writeRevision(this.meta(), path, Buffer.from(JSON.stringify({ ...current, state: 'saved' })), hash(original), owner.assertCurrent)
  }
  read(conversationId: string, draftId: string, current?: () => void): Promise<RequirementResult<dto.RequirementView>> {
    return this.result(() => this.serial(conversationId, async () => {
      const owner = await this.owner(conversationId)
      let loaded = this.load(owner, draftId)
      const pending = loaded.record.draft.operations.find(value => ['dispatching', 'running', 'unknown'].includes(value.state))
      if (pending) loaded = await this.refreshOperation(owner, loaded, pending.id)
      return this.view(owner, loaded.record)
    }), current)
  }
  save(conversationId: string, draftId: string, raw: unknown, current?: () => void): Promise<RequirementResult<dto.RequirementView>> {
    return this.result(() => this.serial(conversationId, async () => {
      const input = dto.requirementSaveSchema.parse(raw), owner = await this.owner(conversationId, true), original = this.load(owner, draftId)
      this.cas(original.record, input.expectedRevision); this.editable(original.record)
      const expected = input.expectedFileRevision === undefined ? original.record.draft.bodyRevision : input.expectedFileRevision
      const file = readOptional(original.record.conversationRoot, original.record.draft.relativePath)
      if ((file ? hash(file.bytes) : null) !== expected) throw new RequirementError('实际文件已改变，请明确核对文件后再保存；未覆盖内容')
      const references = await this.references(owner, original.record.draft.relativePath, input.references)
      const current = await this.fresh(owner, true), loaded = this.load(current, draftId)
      this.cas(loaded.record, input.expectedRevision); this.editable(loaded.record)
      writeRevision(loaded.record.conversationRoot, loaded.record.draft.relativePath, Buffer.from(input.body), expected, current.assertCurrent)
      const before = requirementSourceDigest(loaded.record.draft)
      loaded.record.draft = { ...loaded.record.draft, title: input.title, body: input.body, references, questions: input.questions ?? loaded.record.draft.questions, bodyRevision: hash(input.body), revision: randomUUID(), updatedAt: Date.now() }
      if (loaded.record.draft.plan && before !== requirementSourceDigest(loaded.record.draft)) loaded.record.draft.plan.stale = true
      this.persist(current, loaded.record, loaded.digest)
      return this.view(current, loaded.record)
    }), current)
  }
  sync(conversationId: string, draftId: string, raw: unknown, current?: () => void): Promise<RequirementResult<dto.RequirementView>> {
    return this.result(() => this.serial(conversationId, async () => {
      const input = dto.requirementSyncSchema.parse(raw), owner = await this.owner(conversationId, true), loaded = this.load(owner, draftId)
      this.cas(loaded.record, input.expectedRevision); this.editable(loaded.record)
      const file = readRegular(loaded.record.conversationRoot, loaded.record.draft.relativePath, dto.REQUIREMENT_BODY_BYTES)
      if (hash(file.bytes) !== input.fileRevision) throw new RequirementError('实际文件版本已变化，请重新读取')
      const body = utf8(file.bytes)
      dto.requirementDraftSchema.shape.body.parse(body)
      if (loaded.record.draft.plan && loaded.record.draft.bodyRevision !== input.fileRevision) loaded.record.draft.plan.stale = true
      loaded.record.draft = { ...loaded.record.draft, body, bodyRevision: input.fileRevision, revision: randomUUID(), updatedAt: Date.now() }
      this.persist(owner, loaded.record, loaded.digest)
      return this.view(owner, loaded.record)
    }), current)
  }
  private referencesCurrent(record: Record): void {
    for (const reference of record.draft.references) if (hash(readRegular(record.conversationRoot, reference.snapshotPath, dto.REQUIREMENT_FILE_BYTES).bytes) !== reference.revision) throw new RequirementError('所选资料快照已改变')
  }
  private saved(owner: Owner, record: Record): void {
    if (this.view(owner, record).fileState !== 'saved') throw new RequirementError('请先保存或明确同步实际需求文件，未覆盖外部编辑')
    this.referencesCurrent(record)
  }
  private confirmationCurrent(record: Record): dto.RequirementConfirmed {
    const confirmed = confirmedRequirement(record.draft)
    const bytes = readRegular(record.conversationRoot, confirmed.relativePath, REQUIREMENT_SOURCE_BYTES).bytes
    if (hash(bytes) !== confirmed.snapshotRevision) throw new RequirementError('已确认需求的固定快照发生变化')
    const saved = z.object({ draftId: id, revision: id, sourceDigest: z.string(), body: z.string(), bodyRevision: z.string() }).passthrough().parse(JSON.parse(utf8(bytes)))
    if (saved.draftId !== record.draft.id || saved.revision !== confirmed.revision || saved.sourceDigest !== confirmed.sourceDigest || saved.bodyRevision !== confirmed.bodyRevision || hash(saved.body) !== confirmed.bodyRevision) throw new RequirementError('已确认需求的固定快照身份不一致', 'E_DENIED')
    return confirmed
  }
  private operation(record: Record, operationId: string): dto.RequirementOperation {
    const operation = record.draft.operations.find(value => value.id === id.parse(operationId))
    if (!operation) throw new RequirementError('原需求操作不存在', 'E_NOT_FOUND')
    return operation
  }
  private observation(record: Record, operationId: string): dto.RequirementObservation {
    const operation = this.operation(record, operationId)
    if (operation.state !== 'candidate' && operation.state !== 'adopted') return { operation }
    readActionSource(record.conversationRoot, operation)
    const actual = readActionCandidate(record.conversationRoot, operation)
    if (actual.revision !== operation.candidateRevision || hash(actual.candidate.markdown) !== operation.candidateBodyRevision) throw new RequirementError('实际候选文件已变化，请重新核对；未采用不同内容')
    return { operation, candidate: actual.candidate }
  }
  private async refreshOperation(owner: Owner, loaded: Loaded, operationId: string): Promise<Loaded> {
    let operation = this.operation(loaded.record, operationId)
    if (!['dispatching', 'running', 'unknown'].includes(operation.state)) return loaded
    const before = JSON.stringify(operation)
    const proof = await this.ports.nativeObservation(owner.conversation.id, { ...operation }, owner.assertCurrent)
    const current = await this.fresh(owner)
    loaded = this.load(current, loaded.record.draft.id); operation = this.operation(loaded.record, operationId)
    if (!['dispatching', 'running', 'unknown'].includes(operation.state)) return loaded
    const mismatch = proof.requestId !== operation.requestId || (operation.sessionId !== undefined && operation.sessionId !== proof.sessionId)
      || (operation.connectionGeneration !== undefined && operation.connectionGeneration !== proof.connectionGeneration) || (operation.turnId !== undefined && operation.turnId !== proof.turnId)
      || (proof.sessionId !== undefined && current.conversation.nativeRef?.sessionId !== proof.sessionId)
    if (mismatch) { operation.state = 'unknown'; operation.detail = '原 native request/session/generation/turn 回执不一致；未重发或采用候选' }
    else {
      if (proof.sessionId) operation.sessionId = proof.sessionId
      if (proof.connectionGeneration) operation.connectionGeneration = proof.connectionGeneration
      if (proof.turnId) operation.turnId = proof.turnId
      const exact = Boolean(operation.sessionId && operation.connectionGeneration && operation.turnId)
      if (proof.state === 'not-sent') { operation.state = 'failed'; operation.detail = proof.detail ?? '原回执确认消息未发送；如需继续请明确发起新操作' }
      else if (proof.state === 'unknown' || !exact) { operation.state = 'unknown'; operation.detail = proof.detail ?? '原生终态尚未核实；保留原请求，未重发' }
      else if (proof.state === 'running') { operation.state = 'running'; operation.detail = proof.detail }
      else if (proof.state === 'completed') {
        try {
          readActionSource(loaded.record.conversationRoot, operation)
          const actual = readActionCandidate(loaded.record.conversationRoot, operation)
          operation.state = 'candidate'; operation.candidateRevision = actual.revision; operation.candidateBodyRevision = hash(actual.candidate.markdown); operation.detail = undefined
        } catch (error) { operation.state = 'failed'; operation.detail = `原生回合已结束，但候选未通过实际文件校验：${error instanceof Error ? error.message : '未知错误'}`.slice(0, 2000) }
      } else { operation.state = proof.state; operation.detail = proof.detail?.slice(0, 2000) }
    }
    if (JSON.stringify(operation) === before) return loaded
    operation.updatedAt = Date.now()
    return this.persist(current, loaded.record, loaded.digest)
  }
  run(conversationId: string, draftId: string, raw: unknown, current?: () => void): Promise<RequirementResult<dto.RequirementObservation>> {
    return this.result(() => this.serial(conversationId, async () => {
      const input = dto.requirementRunSchema.parse(raw), inputDigest = hash(JSON.stringify(input)), owner = await this.owner(conversationId, true)
      let loaded = this.load(owner, draftId)
      const prior = loaded.record.draft.operations.find(value => value.commandId === input.commandId)
      if (prior) {
        if (prior.inputDigest !== inputDigest) throw new RequirementError('原操作命令不能用于不同内容；未重新发送')
        loaded = await this.refreshOperation(owner, loaded, prior.id)
        return this.observation(loaded.record, prior.id)
      }
      this.cas(loaded.record, input.expectedRevision); this.editable(loaded.record); this.saved(owner, loaded.record)
      if (loaded.record.draft.operations.length >= dto.REQUIREMENT_OPERATIONS_LIMIT) throw new RequirementError('需求操作已达到有界存储上限；原回执仍保留', 'E_BUSY')
      if (loaded.record.draft.operations.some(value => ['reserved', 'dispatching', 'running', 'unknown'].includes(value.state))) throw new RequirementError('原需求操作尚待核对，请继续观察原操作，不能自动重发', 'E_BUSY')
      const sourceDocument = actionSourceDocument(loaded.record.draft, input)
      if (input.document === 'plan' && input.action !== 'plan' && this.view(owner, loaded.record).planFileState !== 'saved') throw new RequirementError('请先保存实际计划文件')
      if (input.document === 'plan') this.confirmationCurrent(loaded.record)
      if (input.quote && (input.quote.bodyRevision !== sourceDocument.bodyRevision || !hasRequirementQuote(sourceDocument.body, input.quote.text))) throw new RequirementError('选区不属于原文档版本，未发送修改请求')
      if ((input.knowledgeSources?.length ?? 0) > 0 && !input.knowledgeSelection) throw new RequirementError('知识来源缺少原连接与库选择', 'E_INVALID_ARG')
      const directory = loaded.record.draft.relativePath.slice(0, loaded.record.draft.relativePath.lastIndexOf('/'))
      const sourcePath = `${directory}/operations/${input.commandId}/source.json`, relativePath = `${directory}/operations/${input.commandId}/candidate.json`
      const existing = readOptional(loaded.record.conversationRoot, sourcePath, REQUIREMENT_SOURCE_BYTES)
      let source: z.infer<typeof requirementActionSourceSchema>, bytes: Buffer
      if (existing) {
        source = requirementActionSourceSchema.parse(JSON.parse(utf8(existing.bytes))); bytes = existing.bytes
        if (source.operationId !== input.commandId || source.conversationId !== conversationId || source.draftId !== draftId || source.draftRevision !== input.expectedRevision || source.inputDigest !== inputDigest || source.sourceDigest !== sourceDocument.sourceDigest || source.bodyRevision !== sourceDocument.bodyRevision) throw new RequirementError('原操作固定输入不一致；未重新发送')
      } else {
        const knowledge = input.knowledgeSelection && input.knowledgeSources?.length
          ? await this.resolveKnowledge(owner, input.knowledgeSelection, input.knowledgeSources) : []
        let conversationContext: z.infer<typeof requirementActionSourceSchema>['conversationContext']
        if (input.fromConversation) {
          if (!this.ports.conversationContext) throw new RequirementError('原会话上下文读取能力当前不可用', 'E_INVALID_ARG')
          const actual = await this.ports.conversationContext(conversationId, owner.assertCurrent)
          owner.assertCurrent(); conversationContext = { ...actual, contentHash: hash(actual.text) }
        }
        const fresh = await this.fresh(owner, true)
        loaded = this.load(fresh, draftId); this.cas(loaded.record, input.expectedRevision); this.editable(loaded.record); this.saved(fresh, loaded.record)
        source = requirementActionSourceSchema.parse({ version: 1, operationId: input.commandId, requestId: randomUUID(), inputDigest, createdAt: Date.now(), conversationId, draftId, draftRevision: input.expectedRevision,
          action: input.action, document: input.document, sourceDigest: sourceDocument.sourceDigest, title: loaded.record.draft.title, markdown: sourceDocument.body, bodyRevision: sourceDocument.bodyRevision,
          questions: loaded.record.draft.questions, confirmed: input.document === 'plan' ? loaded.record.draft.confirmed : undefined, references: loaded.record.draft.references, knowledge, text: input.text, quote: input.quote, conversationContext })
        bytes = Buffer.from(JSON.stringify(source))
        if (bytes.length > REQUIREMENT_SOURCE_BYTES) throw new RequirementError('固定操作输入超过存储上限', 'E_BUSY')
        writeRevision(loaded.record.conversationRoot, sourcePath, bytes, null, fresh.assertCurrent)
      }
      owner.assertCurrent()
      const reserved = readOptional(loaded.record.conversationRoot, relativePath, dto.REQUIREMENT_CANDIDATE_BYTES)
      if (reserved && hash(reserved.bytes) !== hash('{}')) throw new RequirementError('未发送操作的预留候选文件已被修改，未覆盖或发送')
      if (!reserved) writeRevision(loaded.record.conversationRoot, relativePath, Buffer.from('{}'), null, owner.assertCurrent)
      const operation = dto.requirementOperationSchema.parse({ id: input.commandId, commandId: input.commandId, action: input.action, document: input.document,
        sourceRevision: input.expectedRevision, sourceBodyRevision: sourceDocument.bodyRevision, sourceDigest: sourceDocument.sourceDigest, sourceFileRevision: hash(bytes), planSourceRevision: sourceDocument.planSourceRevision,
        inputDigest, displayText: actionDisplay(input), knowledgeSelection: input.knowledgeSelection,
        knowledge: source.knowledge.map(value => ({ sourceId: value.sourceId, returnedRevision: value.returnedRevision, title: value.title, connectionId: value.selection.connectionId, collectionId: value.collectionId, documentId: value.documentId, contentHash: value.contentHash, truncated: value.truncated })),
        sourcePath, relativePath, state: 'dispatching', requestId: source.requestId, createdAt: source.createdAt, updatedAt: Date.now() })
      loaded.record.draft.operations.push(operation)
      loaded = this.persist(owner, loaded.record, loaded.digest)
      let confirmedNotAdmitted = false
      try {
        owner.assertCurrent()
        readActionSource(loaded.record.conversationRoot, operation)
        const result = await this.ports.send(conversationId, { requestId: operation.requestId, text: actionPrompt(operation) }, owner.assertCurrent, operation.displayText)
        const fresh = await this.fresh(owner)
        loaded = this.load(fresh, draftId)
        const saved = this.operation(loaded.record, operation.id)
        if (result.ok) {
          if (result.value.conversation.id !== conversationId || result.value.conversation.creatorId !== fresh.conversation.creatorId || !sameRoot(result.value.conversation.workspace.root, loaded.record.conversationRoot)
            || result.value.session.sessionId !== fresh.conversation.nativeRef?.sessionId || !result.value.session.connectionGeneration || !result.value.turnId) throw new RequirementError('原发送回执身份不一致，未采用结果', 'E_DENIED')
          saved.sessionId = result.value.session.sessionId; saved.connectionGeneration = result.value.session.connectionGeneration; saved.turnId = result.value.turnId; saved.state = 'running'; saved.detail = undefined
        } else {
          confirmedNotAdmitted = 'notSent' in result && result.notSent === true || 'outcome' in result && result.outcome === 'not-admitted'
          saved.state = confirmedNotAdmitted ? 'failed' : 'unknown'; saved.detail = result.error.slice(0, 2000)
        }
        saved.updatedAt = Date.now(); loaded = this.persist(fresh, loaded.record, loaded.digest)
      } catch (error) {
        owner.assertCurrent(); loaded = this.load(owner, draftId)
        const saved = this.operation(loaded.record, operation.id)
        const notAdmitted = confirmedNotAdmitted || error !== null && typeof error === 'object' && 'outcome' in error && error.outcome === 'not-admitted'
        saved.state = notAdmitted ? 'failed' : 'unknown'; saved.detail = (error instanceof Error ? error.message : '发送回执尚未确认').slice(0, 2000); saved.updatedAt = Date.now()
        loaded = this.persist(owner, loaded.record, loaded.digest)
      }
      return this.observation(loaded.record, operation.id)
    }), current)
  }
  private async resolveKnowledge(owner: Owner, selection: dto.RequirementKnowledgeSelection, refs: RequirementKnowledgeSourceRef[]): Promise<dto.RequirementKnowledgeSnapshot[]> {
    if (!this.ports.knowledge) throw new RequirementError('知识来源读取能力当前不可用', 'E_INVALID_ARG')
    const values = await this.ports.knowledge(owner.conversation.id, selection, refs, owner.assertCurrent)
    owner.assertCurrent()
    if (values.length !== refs.length || new Set(refs.map(value => value.sourceId)).size !== refs.length || Buffer.byteLength(JSON.stringify(values)) > 128 * 1024) throw new RequirementError('知识来源数量或大小不一致')
    for (const ref of refs) {
      const actual = values.find(value => value.sourceId === ref.sourceId && value.returnedRevision === ref.returnedRevision)
      if (!actual || actual.selection.connectionId !== selection.connectionId || actual.selection.connectionRevision !== selection.connectionRevision || JSON.stringify(actual.selection.collectionIds) !== JSON.stringify(selection.collectionIds)) throw new RequirementError('知识来源不属于明确选择的原连接与库', 'E_DENIED')
    }
    return values
  }
  observe(conversationId: string, draftId: string, operationId: string, current?: () => void): Promise<RequirementResult<dto.RequirementObservation>> {
    return this.result(() => this.serial(conversationId, async () => {
      const owner = await this.owner(conversationId), loaded = await this.refreshOperation(owner, this.load(owner, draftId), operationId)
      owner.assertCurrent(); return this.observation(loaded.record, operationId)
    }), current)
  }
  private sealedKnowledge(owner: Owner, record: Record, operation: dto.RequirementOperation): dto.RequirementKnowledgeSnapshot[] {
    owner.assertCurrent()
    const source = readActionSource(record.conversationRoot, operation)
    if (source.conversationId !== owner.conversation.id || source.draftId !== record.draft.id) throw new RequirementError('知识摘录不属于原需求操作', 'E_DENIED')
    let snapshots: dto.RequirementKnowledgeSnapshot[]
    try { snapshots = source.knowledge.map(validateRequirementKnowledgeSourceSnapshot) }
    catch (error) { throw new RequirementError(error instanceof Error ? error.message : '原封存知识摘录校验失败') }
    owner.assertCurrent()
    return snapshots
  }
  evidence(conversationId: string, draftId: string, operationId: string, current?: () => void): Promise<RequirementResult<dto.RequirementKnowledgeSnapshot[]>> {
    return this.result(async () => {
      const owner = await this.owner(conversationId), record = this.load(owner, draftId).record
      return this.sealedKnowledge(owner, record, this.operation(record, operationId))
    }, current)
  }
  adopt(conversationId: string, draftId: string, operationId: string, raw: unknown, current?: () => void): Promise<RequirementResult<dto.RequirementView>> {
    return this.result(() => this.serial(conversationId, async () => {
      const input = dto.requirementAdoptSchema.parse(raw), owner = await this.owner(conversationId, true), loaded = this.load(owner, draftId)
      const operation = this.operation(loaded.record, operationId)
      if (operation.state === 'adopted') {
        if (operation.candidateRevision !== input.candidateRevision || operation.sourceRevision !== input.expectedRevision) throw new RequirementError('原采用命令与候选版本不一致')
        return this.view(owner, loaded.record)
      }
      this.cas(loaded.record, input.expectedRevision); this.editable(loaded.record)
      if (operation.state !== 'candidate' || operation.sourceRevision !== input.expectedRevision || operation.sourceDigest !== requirementSourceDigest(loaded.record.draft)) throw new RequirementError('文档已经编辑或操作尚无真实候选；保留当前内容，请比较后重新请求')
      const observed = this.observation(loaded.record, operationId)
      if (!observed.candidate || operation.candidateRevision !== input.candidateRevision) throw new RequirementError('候选文件版本已改变，未采用')
      this.saved(owner, loaded.record)
      const now = Date.now(), revision = randomUUID()
      if (operation.document === 'requirement') {
        writeRevision(loaded.record.conversationRoot, loaded.record.draft.relativePath, Buffer.from(observed.candidate.markdown), loaded.record.draft.bodyRevision, owner.assertCurrent)
        loaded.record.draft = { ...loaded.record.draft, title: observed.candidate.title, body: observed.candidate.markdown, bodyRevision: hash(observed.candidate.markdown), questions: observed.candidate.questions, revision, updatedAt: now }
        if (loaded.record.draft.plan) loaded.record.draft.plan.stale = true
      } else {
        const confirmed = this.confirmationCurrent(loaded.record)
        if (operation.planSourceRevision !== confirmed.revision) throw new RequirementError('候选计划不属于当前已确认需求')
        this.writePlan(owner, loaded, observed.candidate.markdown, operation.id)
      }
      operation.state = 'adopted'; operation.adoptedRevision = loaded.record.draft.revision; operation.updatedAt = now
      this.persist(owner, loaded.record, loaded.digest)
      return this.view(owner, loaded.record)
    }), current)
  }
  confirmRequirement(conversationId: string, draftId: string, raw: unknown, current?: () => void): Promise<RequirementResult<dto.RequirementView>> {
    return this.result(() => this.serial(conversationId, async () => {
      const input = dto.requirementConfirmSchema.parse(raw), owner = await this.owner(conversationId, true), loaded = this.load(owner, draftId)
      const prior = loaded.record.confirmations.find(value => value.commandId === input.commandId)
      if (prior) {
        if (prior.expectedRevision !== input.expectedRevision || loaded.record.draft.confirmed?.commandId !== input.commandId) throw new RequirementError('原需求确认已被后续版本替代；未改变当前确认')
        this.confirmationCurrent(loaded.record); return this.view(owner, loaded.record)
      }
      this.cas(loaded.record, input.expectedRevision); this.editable(loaded.record); this.saved(owner, loaded.record)
      if (!loaded.record.draft.body.trim()) throw new RequirementError('请先保存完整需求正文')
      if (loaded.record.confirmations.length >= 128) throw new RequirementError('需求确认回执达到存储上限', 'E_BUSY')
      const sourceDigest = requirementSourceDigest(loaded.record.draft), directory = loaded.record.draft.relativePath.slice(0, loaded.record.draft.relativePath.lastIndexOf('/'))
      const relativePath = `${directory}/confirmations/${input.commandId}.json`
      const snapshot = Buffer.from(JSON.stringify({ version: 1, conversationId, creatorId: loaded.record.draft.creatorId, draftId, revision: input.expectedRevision, sourceDigest, title: loaded.record.draft.title, body: loaded.record.draft.body, bodyRevision: loaded.record.draft.bodyRevision, questions: loaded.record.draft.questions, references: loaded.record.draft.references }))
      const existing = readOptional(loaded.record.conversationRoot, relativePath, REQUIREMENT_SOURCE_BYTES)
      if (existing) { if (hash(existing.bytes) !== hash(snapshot)) throw new RequirementError('原确认命令已经固定不同输入') }
      else writeRevision(loaded.record.conversationRoot, relativePath, snapshot, null, owner.assertCurrent)
      const confirmed = dto.requirementConfirmedSchema.parse({ revision: input.expectedRevision, bodyRevision: loaded.record.draft.bodyRevision, sourceDigest, commandId: input.commandId, confirmedAt: Date.now(), summary: loaded.record.draft.body.replace(/\s+/g, ' ').trim().slice(0, 2000), relativePath, snapshotRevision: hash(snapshot) })
      loaded.record.draft.confirmed = confirmed
      loaded.record.confirmations.push({ commandId: input.commandId, expectedRevision: input.expectedRevision, confirmed })
      if (loaded.record.draft.plan && loaded.record.draft.plan.sourceRevision !== confirmed.revision) loaded.record.draft.plan.stale = true
      this.persist(owner, loaded.record, loaded.digest)
      return this.view(owner, loaded.record)
    }), current)
  }
  private writePlan(owner: Owner, loaded: Loaded, body: string, operationId?: string, expectedFileRevision?: string | null): void {
    const confirmed = this.confirmationCurrent(loaded.record), prior = loaded.record.draft.plan
    const directory = loaded.record.draft.relativePath.slice(0, loaded.record.draft.relativePath.lastIndexOf('/')), relativePath = prior?.relativePath ?? `${directory}/plan.md`
    const expected = expectedFileRevision === undefined ? prior?.bodyRevision ?? null : expectedFileRevision
    writeRevision(loaded.record.conversationRoot, relativePath, Buffer.from(body), expected, owner.assertCurrent)
    const now = Date.now()
    loaded.record.draft.plan = { body, revision: randomUUID(), bodyRevision: hash(body), relativePath, sourceRevision: confirmed.revision, sourceDigest: confirmed.sourceDigest, stale: false, updatedAt: now, operationId }
    loaded.record.draft.revision = randomUUID(); loaded.record.draft.updatedAt = now
  }
  savePlan(conversationId: string, draftId: string, raw: unknown, current?: () => void): Promise<RequirementResult<dto.RequirementView>> {
    return this.result(() => this.serial(conversationId, async () => {
      const input = dto.requirementSavePlanSchema.parse(raw), owner = await this.owner(conversationId, true), loaded = this.load(owner, draftId)
      this.cas(loaded.record, input.expectedRevision); this.editable(loaded.record); this.saved(owner, loaded.record)
      if ((loaded.record.draft.plan?.revision ?? null) !== input.expectedPlanRevision) throw new RequirementError('计划修订已变化，未覆盖')
      if (loaded.record.draft.plan) currentPlan(loaded.record.draft)
      this.writePlan(owner, loaded, input.body, undefined, input.expectedFileRevision)
      this.persist(owner, loaded.record, loaded.digest)
      return this.view(owner, loaded.record)
    }), current)
  }
  target(conversationId: string, draftId: string, raw: unknown, directoryOwner?: object, current?: () => void): Promise<RequirementResult<dto.RequirementView>> {
    return this.result(() => this.serial(conversationId, async () => {
      const input = dto.requirementTargetInputSchema.parse(raw), owner = await this.owner(conversationId, true), original = this.load(owner, draftId)
      this.cas(original.record, input.expectedRevision)
      if (original.record.intent) throw new RequirementError('原交接目标已固定，请在原任务中继续后续变更')
      if (input.selection.kind === 'code' && owner.conversation.kind !== 'code') throw new RequirementError('Work 需求必须显式选择真实 Trellis 工程', 'E_INVALID_ARG')
      owner.assertCurrent()
      const chosen = await this.ports.resolveTarget(owner.conversation, input.selection, directoryOwner, owner.assertCurrent)
      const current = await this.fresh(owner, true), loaded = this.load(current, draftId), target = trellisTarget(chosen)
      this.cas(loaded.record, input.expectedRevision)
      if (loaded.record.intent) throw new RequirementError('交接目标已固定')
      loaded.record.targetIdentity = target.identity
      loaded.record.draft = { ...loaded.record.draft, target: { id: randomUUID(), root: target.root, selectedAt: Date.now() }, revision: randomUUID(), updatedAt: Date.now() }
      this.persist(current, loaded.record, loaded.digest)
      return this.view(current, loaded.record)
    }), current)
  }
  private receipt(record: Record, state: dto.RequirementReceipt['state'], task?: dto.RequirementTask, detail?: string): dto.RequirementReceipt {
    const intent = record.intent
    if (!intent) throw new RequirementError('没有原交接命令')
    return dto.requirementReceiptSchema.parse({ commandId: intent.commandId, draftId: record.draft.id, draftRevision: intent.draftRevision, targetId: intent.targetId, state, task,
      files: state === 'created' ? ['task.json', 'prd.md', manifestPath, 'references/requirement.md', ...(intent.plan ? ['plan.md', 'references/plan.md', 'references/requirement-confirmation.json'] : []), ...intent.references.map(referenceTarget)] : task ? ['task.json'] : [], detail, planRevision: intent.plan?.revision, confirmedRevision: intent.confirmed?.revision })
  }
  private origin(record: Record): dto.RequirementTaskOrigin {
    const intent = record.intent
    if (!intent) throw new RequirementError('没有原交接命令')
    return { version: 1, conversationId: record.draft.conversationId, creatorId: record.draft.creatorId, draftId: record.draft.id, draftRevision: intent.draftRevision, commandId: intent.commandId, bodyRevision: hash(intent.body), manifestRevision: hash(intent.manifest), manifestPath,
      ...(intent.plan && intent.confirmed ? { confirmedRevision: intent.confirmed.revision, sourceDigest: intent.confirmed.sourceDigest, planRevision: intent.plan.revision, planBodyRevision: intent.plan.bodyRevision, planSourceRevision: intent.plan.sourceRevision } : {}) }
  }
  private task(record: Record): dto.RequirementTask | undefined {
    const intent = record.intent, target = record.draft.target
    if (!intent || !target) throw new RequirementError('没有原任务目标')
    const bytes = readOptional(target.root, `.trellis/tasks/${intent.taskDir}/task.json`, 512 * 1024)
    if (!bytes) return undefined
    const raw = z.object({ id: z.string(), title: z.string(), status: z.string(), meta: z.object({ conversationRequirement: dto.requirementTaskOriginSchema }).passthrough() }).passthrough().parse(JSON.parse(utf8(bytes.bytes)))
    if (raw.id !== intent.taskId || JSON.stringify(raw.meta.conversationRequirement) !== JSON.stringify(this.origin(record))) throw new RequirementError('实际任务不属于原需求交接；未按同名任务替换', 'E_DENIED')
    return dto.requirementTaskSchema.parse({ root: target.root, taskDir: intent.taskDir, taskId: raw.id, title: raw.title, status: raw.status })
  }
  private finish(owner: Owner, loaded: Loaded): dto.RequirementReceipt {
    const record = loaded.record, intent = record.intent, target = record.draft.target
    if (!intent || !target) throw new RequirementError('交接意图不存在')
    if (intent.blocked === 'manifest-budget') throw new RequirementError('原交接的完整资料清单超过 64 KiB；原命令与固定输入已保留，未创建任务或截断证据', 'E_BUSY')
    const actual = trellisTarget(target.root)
    if (actual.identity !== record.targetIdentity) throw new RequirementError('原 Trellis 工程身份已变化')
    const assertTarget = (): void => {
      owner.assertCurrent()
      if (directoryIdentity(target.root) !== record.targetIdentity) throw new RequirementError('原 Trellis 工程物理身份已变化', 'E_DENIED')
    }
    assertTarget()
    if (record.draft.handoff?.state === 'created') {
      const task = this.task(record)
      if (!task) throw new RequirementError('原任务已移动、删除或归档；请到原工程任务归档核对，不会重新创建')
      return { ...record.draft.handoff, task }
    }
    let task: dto.RequirementTask | undefined
    try {
      task = this.task(record)
      if (!task) {
        if (intent.started) return this.saveReceipt(owner, loaded, this.receipt(record, 'uncertain', undefined, '原创建已进入写入边界但未找到可验证的 task.json；保留原命令，不重新创建'))
        intent.taskDir = `${dayPrefix()}-${intent.taskId}`
        if (existsSync(join(target.root, '.trellis/tasks', intent.taskDir))) return this.saveReceipt(owner, loaded, this.receipt(record, 'uncertain', undefined, '目标目录已存在且没有原交接证明，未覆盖'))
        intent.started = true
        loaded = this.persist(owner, record, loaded.digest)
        owner.assertCurrent()
        const result = createTaskRecordAt(target.root, { dirName: intent.taskId, title: intent.title ?? record.draft.title, description: intent.plan ? '来自本人会话的已确认需求与独立计划；尚未启动工程执行。' : '来自本人会话的已确认需求。', status: 'planning', priority: 'P2', assignee: '', prdContent: intent.body, conversationRequirement: this.origin(record) })
        if (result.ok && result.dirName !== intent.taskDir) { intent.taskDir = result.dirName; loaded = this.persist(owner, record, loaded.digest) }
        owner.assertCurrent()
        task = this.task(record)
        if (!task) return this.saveReceipt(owner, loaded, this.receipt(record, 'uncertain', undefined, '创建结果尚无可验证的任务身份；原命令保留'))
      }
      if (task.status !== 'planning') return this.saveReceipt(owner, loaded, this.receipt(record, 'partial', task, '原任务已进入后续阶段；不重写 PRD 或固定输入，请在原任务工作台继续'))
      const confirmation = intent.confirmed ? readRegular(record.conversationRoot, intent.confirmed.relativePath, REQUIREMENT_SOURCE_BYTES).bytes : undefined
      if (intent.confirmed && (!confirmation || hash(confirmation) !== intent.confirmed.snapshotRevision)) throw new RequirementError('原确认快照已改变，未继续交接')
      const files = [{ path: 'prd.md', bytes: Buffer.from(intent.body) }, { path: 'references/requirement.md', bytes: Buffer.from(intent.body) }, { path: manifestPath, bytes: Buffer.from(intent.manifest) },
        ...(intent.plan ? [{ path: 'plan.md', bytes: Buffer.from(intent.plan.body) }, { path: 'references/plan.md', bytes: Buffer.from(intent.plan.body) }] : []),
        ...(confirmation ? [{ path: 'references/requirement-confirmation.json', bytes: confirmation }] : []),
        ...intent.references.map((reference, index) => { const source = readRegular(record.conversationRoot, reference.snapshotPath, dto.REQUIREMENT_FILE_BYTES); if (hash(source.bytes) !== reference.revision) throw new RequirementError('原资料快照已改变'); return { path: referenceTarget(reference, index), bytes: source.bytes } })]
      for (const file of files) {
        assertTarget()
        if (this.task(record)?.status !== 'planning') throw new RequirementError('原任务已变化或进入后续阶段，未继续修改固定输入')
        const path = `.trellis/tasks/${intent.taskDir}/${file.path}`, existing = readOptional(target.root, path, Math.max(file.bytes.length, dto.REQUIREMENT_BODY_BYTES))
        if (existing) { if (hash(existing.bytes) !== hash(file.bytes)) throw new RequirementError(`实际 ${file.path} 已有不同正文，未覆盖`) }
        else writeRevision(target.root, path, file.bytes, null, assertTarget)
      }
      return this.saveReceipt(owner, loaded, this.receipt(record, 'created', task))
    } catch (error) {
      return this.saveReceipt(owner, loaded, this.receipt(record, task ? 'partial' : 'uncertain', task, error instanceof Error ? error.message.slice(0, 2000) : '原交接待核对'))
    }
  }
  private saveReceipt(owner: Owner, loaded: Loaded, receipt: dto.RequirementReceipt): dto.RequirementReceipt {
    loaded.record.draft.handoff = receipt
    this.persist(owner, loaded.record, loaded.digest)
    return receipt
  }
  commit(conversationId: string, draftId: string, raw: unknown, current?: () => void): Promise<RequirementResult<dto.RequirementReceipt>> {
    return this.result(() => this.serial(conversationId, async () => {
      const input = dto.requirementCommitSchema.parse(raw), owner = await this.owner(conversationId, true)
      let loaded = this.load(owner, draftId)
      const record = loaded.record, target = record.draft.target
      if (!target || target.id !== input.targetId) throw new RequirementError('请选择已核对的原 Trellis 目标')
      if (record.intent) {
        if (record.intent.commandId !== input.commandId || record.intent.draftRevision !== input.expectedRevision || record.intent.targetId !== input.targetId || record.intent.plan && record.intent.plan.revision !== input.expectedPlanRevision) throw new RequirementError('需求已经绑定原交接命令和计划版本，请打开原任务；不会重新创建')
        return this.finish(owner, loaded)
      }
      this.cas(record, input.expectedRevision)
      this.saved(owner, record)
      const confirmed = this.confirmationCurrent(record), plan = currentPlan(record.draft)
      if (!record.draft.body.trim() || !plan.body.trim() || this.view(owner, record).planFileState !== 'saved') throw new RequirementError('请先保存完整的实际需求与独立计划')
      if (plan.revision !== input.expectedPlanRevision) throw new RequirementError('计划版本已经变化，未交接不同计划')
      if (trellisTarget(target.root).identity !== record.targetIdentity) throw new RequirementError('原目标工程已变化')
      for (const reference of record.draft.references) if (hash(readRegular(record.conversationRoot, reference.snapshotPath, dto.REQUIREMENT_FILE_BYTES).bytes) !== reference.revision) throw new RequirementError('所选资料快照已变化')
      const taskId = `requirement-${draftId}`
      const intent: z.infer<typeof intentSchema> = { commandId: input.commandId, draftRevision: input.expectedRevision, targetId: input.targetId, taskId, taskDir: `${dayPrefix()}-${taskId}`, started: false, title: record.draft.title, body: record.draft.body, manifest: '', references: record.draft.references, plan: { ...plan }, confirmed: { ...confirmed } }
      const preserveBudgetFailure = (): never => {
        record.intent = { ...intent, blocked: 'manifest-budget' }
        this.persist(owner, record, loaded.digest)
        throw new RequirementError('完整资料清单超过 64 KiB；原交接命令与固定输入已保留，未创建任务或截断证据', 'E_BUSY')
      }
      const knowledgeByVersion = new Map<string, dto.RequirementKnowledgeSnapshot>()
      const adopted = record.draft.operations.filter(operation => operation.state === 'adopted')
      for (const operation of adopted) {
        for (const source of this.sealedKnowledge(owner, record, operation)) {
          const key = JSON.stringify([source.selection.connectionId, source.returnedRevision])
          if (!knowledgeByVersion.has(key)) knowledgeByVersion.set(key, source)
        }
        if (Buffer.byteLength(JSON.stringify([...knowledgeByVersion.values()])) > 64 * 1024) preserveBudgetFailure()
      }
      const manifest = JSON.stringify({ version: 2, conversationId, creatorId: record.draft.creatorId, draftId, draftRevision: record.draft.revision, bodyRevision: record.draft.bodyRevision, sourcePath: record.draft.relativePath,
        confirmed, plan: { revision: plan.revision, bodyRevision: plan.bodyRevision, sourceRevision: plan.sourceRevision, sourceDigest: plan.sourceDigest, path: 'plan.md' },
        knowledgeEvidence: [...knowledgeByVersion.values()],
        operations: adopted.map(operation => ({ id: operation.id, commandId: operation.commandId, action: operation.action, document: operation.document, sourceRevision: operation.sourceRevision, sourceDigest: operation.sourceDigest, sourceFileRevision: operation.sourceFileRevision,
          candidateRevision: operation.candidateRevision, candidateBodyRevision: operation.candidateBodyRevision, requestId: operation.requestId, sessionId: operation.sessionId, connectionGeneration: operation.connectionGeneration, turnId: operation.turnId, knowledgeSelection: operation.knowledgeSelection, knowledge: operation.knowledge })),
        references: record.draft.references.map((reference, index) => ({ fileId: reference.fileId, revision: reference.revision, name: reference.name, originalPath: reference.relativePath, path: referenceTarget(reference, index), bytes: reference.bytes })) })
      if (Buffer.byteLength(manifest) > 64 * 1024) preserveBudgetFailure()
      record.intent = { ...intent, manifest }
      record.draft.handoff = this.receipt(record, 'uncertain', undefined, '交接命令已保存，尚未确认实际任务文件')
      loaded = this.persist(owner, record, loaded.digest)
      return this.finish(owner, loaded)
    }), current)
  }
  open(conversationId: string, draftId: string, current?: () => void): Promise<RequirementResult<dto.RequirementOpen>> {
    return this.result(async () => {
      const owner = await this.owner(conversationId), record = this.load(owner, draftId).record, task = this.task(record)
      if (!task) throw new RequirementError('原任务尚无可验证的创建结果，或已移动/归档；请到原工程任务归档核对', 'E_NOT_FOUND')
      if (trellisTarget(task.root).identity !== record.targetIdentity) throw new RequirementError('原目标工程已变化')
      owner.assertCurrent()
      const opened = await this.ports.openTask(task.root, task.taskDir, owner.assertCurrent)
      owner.assertCurrent()
      const latest = this.task(record)
      const actual = [...opened.snapshot.tasks, ...opened.snapshot.archived].find(value => value.dirName === task.taskDir && value.record?.id === task.taskId)
      const origin = dto.requirementTaskOriginSchema.safeParse(actual?.record?.meta?.conversationRequirement)
      if (!latest || opened.taskDir !== task.taskDir || !sameRoot(opened.snapshot.meta.root, task.root) || !actual || !origin.success || JSON.stringify(origin.data) !== JSON.stringify(this.origin(record))) throw new RequirementError('打开结果不是原交接任务；未使用同名任务替代')
      return { conversationId, draftId, task: latest, taskDir: opened.taskDir, snapshot: opened.snapshot }
    }, current)
  }
  /** Main-only fixed handoff proof for the existing engineering execution entry. */
  async executionSource(conversationId: string, draftId: string, current: () => void): Promise<import('./requirement-execution').RequirementExecutionOwner> {
    return this.documents.run(current, async () => {
      const owner = await this.owner(conversationId, true), record = this.load(owner, draftId).record
      if (record.draft.handoff?.state !== 'created' || !record.targetIdentity) throw new RequirementError('请先完成原需求与计划的任务交接')
      const task = this.task(record)
      if (!task) throw new RequirementError('原任务当前不可读取，请到原工程核对')
      owner.assertCurrent()
      return { conversationId, creatorId: owner.conversation.creatorId, task, origin: this.origin(record), targetIdentity: record.targetIdentity, assertCurrent: owner.assertCurrent }
    })
  }
}
