import type { Conversation, ConversationFile, ConversationResult, ConversationSend } from '../../../shared/private-conversations'
import type { AcpSessionRecord, ProjectSnapshot } from '../../../shared/types'
import type { RequirementTargetSelection } from '../../../shared/conversation-requirements'
import type { RequirementKnowledgeSourceRef } from '../../../shared/conversation-requirement-knowledge'
import type { RequirementPredecessorReleaseProof } from './requirement-predecessor-release'
import { requirementDesignContextSchema, requirementDesignStandardSchema, requirementDesignSourceKey, type RequirementDesignContext, type RequirementDesignStandard } from '../../../shared/requirement-design-context'
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
import { actionDisplay, actionPrompt, actionSourceDocument, confirmedRequirement, currentPlan, quoteContext, readActionCandidate, readActionSource, requirementActionSourceSchema, requirementSourceDigest, REQUIREMENT_SOURCE_BYTES } from './requirement-actions'
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
/** Main-owned workflow preflight must use the same fixed configuration and serializer as execution. */
export interface RequirementHandoffPreflight {
  version: 1; targetRoot: string; targetIdentity: string; conversationRoot: string; draftId: string; draftRevision: string
  commandId: string; taskId: string; taskDir: string; requirement: string; plan: dto.RequirementPlan
  confirmed: dto.RequirementConfirmed; manifest: string; references: dto.RequirementReference[]; designFiles: dto.RequirementDesignSnapshot[]
}
export interface RequirementHandoffPreflightProof {
  inputDigest: string; workflowRevision: string; contextDigest: string; budgetBytes: number; promptBytes: number; complete: true
  designMaterials?: Array<{ path: string; revision: string; bytes: number }>
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
  authorizeSnapshots?(conversationId: string, sources: dto.RequirementKnowledgeSnapshot[], assertCurrent: () => void): Promise<dto.RequirementKnowledgeSnapshot[]>
  /** Absent or unverifiable preflight must not cross the task-creation boundary. */
  preflightContext?(input: RequirementHandoffPreflight, assertCurrent: () => void): Promise<RequirementHandoffPreflightProof>
  verifyPredecessorRelease?(predecessor: dto.RequirementPredecessor, assertCurrent: () => void): Promise<RequirementPredecessorReleaseProof>
}

export type RequirementResult<T> = ConversationResult<T>

const id = z.string().uuid()
const manifestPath = 'references/conversation-requirement.json'
const preflightProofSchema = z.object({ inputDigest: z.string().regex(/^[a-f0-9]{64}$/), workflowRevision: z.string().regex(/^[a-f0-9]{64}$/), contextDigest: z.string().regex(/^[a-f0-9]{64}$/), budgetBytes: z.number().int().min(1024).max(1024 * 1024), promptBytes: z.number().int().nonnegative(), complete: z.literal(true), designMaterials: z.array(z.object({ path: z.string().min(1).max(8192), revision: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative().max(dto.REQUIREMENT_FILE_BYTES) }).strict()).max(16).optional() }).strict()
const intentSchema = z.object({ commandId: id, inputDigest: z.string().length(64).optional(), knowledgeOperationIds: z.array(id).max(dto.REQUIREMENT_OPERATIONS_LIMIT).optional(), knowledgeSources: z.array(dto.requirementHandoffSourceSchema).max(128).optional(), directKnowledge: dto.requirementDirectKnowledgeSchema.optional(), designSources: z.array(requirementDesignStandardSchema).max(16).optional(), designContext: requirementDesignContextSchema.optional(), designFiles: z.array(dto.requirementDesignSnapshotSchema).max(16).optional(), predecessor: dto.requirementPredecessorSchema.optional(), preflight: preflightProofSchema.optional(), draftRevision: id, targetId: id, taskId: z.string().min(1).max(100), taskDir: z.string().min(1).max(200), started: z.boolean(), body: z.string().max(200_000), title: z.string().max(200).optional(), manifest: z.string().max(64 * 1024), references: z.array(dto.requirementReferenceSchema).max(8), plan: dto.requirementPlanSchema.optional(), confirmed: dto.requirementConfirmedSchema.optional(), blocked: z.enum(['manifest-budget', 'context-budget', 'preflight-unavailable', 'context-changed']).optional() }).strict()
const recordSchema = z.object({ version: z.literal(1), conversationRoot: z.string().min(1).max(8192), rootIdentity: z.string().min(1), creationCommandId: id, draft: dto.requirementDraftSchema, targetIdentity: z.string().optional(), intent: intentSchema.optional(), confirmations: z.array(z.object({ commandId: id, expectedRevision: id, confirmed: dto.requirementConfirmedSchema }).strict()).max(128).default([]), rejectedHandoffs: z.array(z.object({ intent: intentSchema, inputDigest: z.string().length(64).optional(), receipt: dto.requirementReceiptSchema }).strict()).max(128).default([]), recoveredFiles: z.array(z.object({ document: dto.requirementDocumentSchema, path: z.string(), revision: z.string().length(64) }).strict()).max(128).default([]), pendingSave: z.object({ document: dto.requirementDocumentSchema, expected: z.string().length(64).nullable(), next: dto.requirementDraftSchema }).strict().optional() }).strict()
const createCommandSchema = z.object({ version: z.literal(1), conversationId: id, creatorId: z.string(), root: z.string(), rootIdentity: z.string(), commandId: id, inputDigest: z.string().length(64), draftId: id, createdAt: z.number().int().nonnegative(), state: z.enum(['registered', 'saved']).default('registered') }).strict()
const successorCommandSchema = createCommandSchema.extend({ originalDraftId: id, expectedHandoffCommandId: id, targetId: id, seedDigest: z.string().length(64) }).strict()
type Record = z.infer<typeof recordSchema>
type Loaded = { record: Record; digest: string }
type Owner = ConversationRequirementOwner
const sameRoot = (left: string, right: string): boolean => pathKey(left) === pathKey(right)
const dayPrefix = (): string => { const now = new Date(); return `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` }
const referenceTarget = (reference: dto.RequirementReference, index: number): string => `references/requirement-files/${index}${extname(reference.snapshotPath)}`
const designTarget = (reference: dto.RequirementDesignSnapshot, index: number): string => {
  const suffix = extname(reference.source.name).slice(1).toLowerCase()
  return `references/requirement-design/${index}.${/^[a-z0-9]{1,10}$/.test(suffix) ? suffix : 'bin'}`
}

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
    let loaded = { record, digest: hash(bytes) }
    if (record.intent?.blocked === 'manifest-budget' && !record.intent.started && record.rejectedHandoffs.length < 128) {
      const receipt = this.receipt(record, 'not-admitted', undefined, '资料清单超限，原命令未越过任务创建边界；可调整资料后使用新命令')
      const recovered = { ...record, draft: { ...record.draft, handoff: receipt }, intent: undefined, rejectedHandoffs: [...record.rejectedHandoffs, { intent: record.intent, receipt }] }
      loaded = this.persist(owner, recovered, loaded.digest)
      Object.assign(record, recovered)
    }
    const pending = record.pendingSave
    if (pending) {
      const document = pending.document === 'plan' ? pending.next.plan : undefined
      const path = pending.document === 'plan' ? document?.relativePath : pending.next.relativePath
      const body = pending.document === 'plan' ? document?.body : pending.next.body
      if (!path || body === undefined || hash(pending.next.body) !== pending.next.bodyRevision || pending.next.plan && hash(pending.next.plan.body) !== pending.next.plan.bodyRevision || pending.next.id !== record.draft.id || pending.next.conversationId !== record.draft.conversationId || pending.next.creatorId !== record.draft.creatorId || path !== (pending.document === 'plan' ? record.draft.plan?.relativePath ?? `${record.draft.relativePath.slice(0, record.draft.relativePath.lastIndexOf('/'))}/plan.md` : record.draft.relativePath)) throw new RequirementError('待恢复保存的文档身份不一致', 'E_DENIED')
      try {
        const actual = readOptional(record.conversationRoot, path)
        const revision = actual ? hash(actual.bytes) : null
        if (revision === pending.expected && revision !== hash(body)) writeRevision(record.conversationRoot, path, Buffer.from(body), pending.expected, owner.assertCurrent)
        else if (revision !== hash(body)) return loaded
        const recovered = { ...record, draft: pending.next, pendingSave: undefined }
        loaded = this.persist(owner, recovered, loaded.digest)
      } catch { /* Keep both versions for an explicit recovery when the file is unavailable. */ }
    }
    return loaded
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
  private assertCreationCapacity(conversationId: string): void {
    let count = 0
    for (const name of ['creates', 'successors']) {
      const directory = join(this.meta(), 'requirements', id.parse(conversationId), name)
      if (!existsSync(directory)) continue
      const stream = opendirSync(checkedDirectory(directory))
      try { for (let entry = stream.readSync(); entry; entry = stream.readSync()) if (++count >= 128) throw new RequirementError('需求草稿与待恢复创建已达到 128 项上限，请核对原创建命令', 'E_BUSY') }
      finally { stream.closeSync() }
    }
  }
  private view(owner: Owner, record: Record): dto.RequirementView {
    owner.assertCurrent()
    const plan = record.draft.plan
    let planFileState: dto.RequirementView['planFileState'], planFileRevision: string | undefined, planFileBody: string | undefined
    if (plan) {
      try { const file = readOptional(record.conversationRoot, plan.relativePath); planFileRevision = file ? hash(file.bytes) : undefined; planFileState = file ? planFileRevision === plan.bodyRevision ? 'saved' : 'changed' : 'missing'; if (file && planFileState === 'changed') planFileBody = utf8(file.bytes) }
      catch { planFileState = 'unavailable' }
    }
    let pendingSave: dto.RequirementView['pendingSave']
    if (record.pendingSave) {
      const pending = record.pendingSave, document = pending.document
      const path = document === 'plan' ? pending.next.plan?.relativePath : pending.next.relativePath
      const pendingBody = document === 'plan' ? pending.next.plan?.body : pending.next.body
      let actual: NonNullable<dto.RequirementView['pendingSave']>['actual'] = { state: 'unavailable', detail: '待恢复文档身份不可用' }
      if (path && pendingBody !== undefined) {
        try {
          const file = readOptional(record.conversationRoot, path)
          if (!file) actual = { state: 'missing' }
          else {
            const revision = hash(file.bytes)
            try { actual = { state: revision === hash(pendingBody) ? 'matches-pending' : revision === pending.expected ? 'matches-previous' : 'changed', revision, body: utf8(file.bytes) } }
            catch (error) { actual = { state: 'unavailable', revision, detail: error instanceof Error ? error.message : '实际文件不可读取' } }
          }
        } catch (error) { actual = { state: 'unavailable', detail: error instanceof Error ? error.message : '实际文件不可读取' } }
      }
      pendingSave = { document, draft: pending.next, actual }
      if (document === 'plan') { planFileRevision = actual.revision; planFileState = actual.state === 'missing' ? 'missing' : actual.state === 'unavailable' ? 'unavailable' : 'changed' }
    }
    const result = { draft: record.draft, planFileState, planFileRevision, planFileBody, recoveredFiles: record.recoveredFiles, handoffHistory: record.rejectedHandoffs.map(value => ({ receipt: value.receipt, knowledgeOperationIds: value.intent.knowledgeOperationIds, knowledgeSources: value.intent.knowledgeSources, directKnowledge: value.intent.directKnowledge, designSources: value.intent.designSources })), ...(pendingSave ? { pendingSave, detail: '保存中断，文件与待保存内容需要核对；两份内容均已保留' } : {}) }
    try {
      const file = readOptional(record.conversationRoot, record.draft.relativePath)
      if (!file) return { ...result, fileState: 'missing', detail: '实际 Markdown 文件不存在；已保存的草稿仍保留' }
      const body = utf8(file.bytes)
      const revision = hash(file.bytes)
      return { ...result, fileState: record.pendingSave?.document === 'requirement' ? 'unavailable' : revision === record.draft.bodyRevision ? 'saved' : 'changed', fileRevision: revision, ...(revision !== record.draft.bodyRevision ? { fileBody: body } : {}) }
    } catch (error) { return { ...result, fileState: 'unavailable', detail: error instanceof Error ? error.message : '需求文件不可读' } }
  }
  private cas(record: Record, revision: string): void { if (record.pendingSave) throw new RequirementError('上次保存尚待核对；已保留待保存内容和实际文件'); if (record.draft.revision !== revision) throw new RequirementError('需求草稿版本已变化，请重新读取') }
  private saveDocument(owner: Owner, loaded: Loaded, next: dto.RequirementDraft, document: dto.RequirementDocument, expected: string | null): Loaded {
    const path = document === 'plan' ? next.plan?.relativePath : next.relativePath
    const body = document === 'plan' ? next.plan?.body : next.body
    if (!path || body === undefined) throw new RequirementError('待保存文档不存在')
    loaded.record.pendingSave = { document, expected, next }
    loaded = this.persist(owner, loaded.record, loaded.digest)
    writeRevision(loaded.record.conversationRoot, path, Buffer.from(body), expected, owner.assertCurrent)
    loaded.record.draft = next; loaded.record.pendingSave = undefined
    return this.persist(owner, loaded.record, loaded.digest)
  }
  private resolvePending(owner: Owner, loaded: Loaded, document: dto.RequirementDocument, expectedRevision: string, body: string, expectedFileRevision: string | null | undefined): void {
    const pending = loaded.record.pendingSave
    if (!pending || pending.document !== document || loaded.record.draft.revision !== expectedRevision || expectedFileRevision === undefined || body !== (document === 'plan' ? pending.next.plan?.body : pending.next.body)) throw new RequirementError('待恢复版本或实际文件版本不一致')
    const pendingPlan = pending.next.plan
    if (document === 'plan' && !pendingPlan) throw new RequirementError('待恢复计划不存在')
    const path = document === 'plan' && pendingPlan ? pendingPlan.relativePath : pending.next.relativePath
    const actual = readOptional(loaded.record.conversationRoot, path)
    if ((actual ? hash(actual.bytes) : null) !== expectedFileRevision) throw new RequirementError('实际文件再次变化，未覆盖')
    if (actual) {
      utf8(actual.bytes)
      if (loaded.record.recoveredFiles.length >= 128) throw new RequirementError('恢复文件记录达到存储上限', 'E_BUSY')
      const revision = hash(actual.bytes)
      const backup = `${loaded.record.draft.relativePath.slice(0, loaded.record.draft.relativePath.lastIndexOf('/'))}/recovery/${randomUUID()}-${revision}.md`
      writeRevision(loaded.record.conversationRoot, backup, actual.bytes, null, owner.assertCurrent)
      loaded.record.recoveredFiles.push({ document, path: backup, revision })
    }
    pending.expected = expectedFileRevision
    loaded = this.persist(owner, loaded.record, loaded.digest)
    writeRevision(loaded.record.conversationRoot, path, Buffer.from(body), expectedFileRevision, owner.assertCurrent)
    loaded.record.draft = pending.next; loaded.record.pendingSave = undefined
    this.persist(owner, loaded.record, loaded.digest)
  }
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
  private async designReferences(owner: Owner, draftPath: string, context: RequirementDesignContext | undefined): Promise<dto.RequirementDesignSnapshot[]> {
    if (!context) return []
    const unique = new Map<string, RequirementDesignStandard>()
    for (const source of [...context.standards, ...context.materials]) {
      if (source.kind === 'design') throw new RequirementError('设计工作区引用尚无可验证读取接口，请改用当前会话文件', 'E_INVALID_ARG')
      if (source.kind === 'project-file' && (owner.conversation.kind !== 'code' || owner.conversation.workspace.kind !== 'directory' || !sameRoot(source.projectRoot, owner.conversation.workspace.root))) throw new RequirementError('工程设计文件只能来自当前 Code 会话已授权的原目录', 'E_DENIED')
      const key = requirementDesignSourceKey(source), previous = unique.get(key)
      if (previous && JSON.stringify(previous) !== JSON.stringify(source)) throw new RequirementError('同一设计文件指定了不同版本或名称', 'E_INVALID_ARG')
      unique.set(key, source)
    }
    const prepared: Array<{ bytes: Buffer; snapshot: dto.RequirementDesignSnapshot }> = []
    let total = 0
    for (const source of unique.values()) {
      const fileId = source.kind === 'file' ? source.fileId : hash(source.relativePath.replaceAll('\\', '/'))
      const actual = await this.ports.selectedFile(owner.conversation.id, fileId, source.revision)
      owner.assertCurrent()
      const bytes = Buffer.from(actual.bytes); total += bytes.length
      if (actual.file.id !== fileId || actual.file.revision !== source.revision || actual.file.name !== source.name || hash(bytes) !== source.revision || bytes.length > dto.REQUIREMENT_FILE_BYTES || total > dto.REQUIREMENT_REFERENCES_BYTES || source.kind === 'project-file' && actual.file.relativePath !== source.relativePath) throw new RequirementError('设计文件身份、权限、摘要或大小不匹配', 'E_DENIED')
      const suffix = extname(actual.file.name).slice(1).toLowerCase(), extension = /^[a-z0-9]{1,10}$/.test(suffix) ? suffix : 'bin'
      const snapshotPath = `${draftPath.slice(0, draftPath.lastIndexOf('/'))}/sources/design-${hash(JSON.stringify(source))}.${extension}`
      prepared.push({ bytes, snapshot: dto.requirementDesignSnapshotSchema.parse({ source, relativePath: actual.file.relativePath, snapshotPath, bytes: bytes.length }) })
    }
    const fresh = await this.fresh(owner, true)
    for (const item of prepared) {
      const existing = readOptional(fresh.conversation.workspace.root, item.snapshot.snapshotPath, dto.REQUIREMENT_FILE_BYTES)
      if (existing) { if (hash(existing.bytes) !== item.snapshot.source.revision) throw new RequirementError('已固定的设计文件快照已变化') }
      else writeRevision(fresh.conversation.workspace.root, item.snapshot.snapshotPath, item.bytes, null, fresh.assertCurrent)
    }
    return prepared.map(item => item.snapshot)
  }
  private designReferencesCurrent(record: Record): void {
    const context = record.draft.designContext, files = record.draft.designContextFiles
    const selected = new Map<string, RequirementDesignStandard>()
    for (const source of [...context?.standards ?? [], ...context?.materials ?? []]) {
      if (source.kind === 'design') throw new RequirementError('设计工作区引用尚无可验证读取接口', 'E_DENIED')
      const key = requirementDesignSourceKey(source), previous = selected.get(key)
      if (previous && JSON.stringify(previous) !== JSON.stringify(source)) throw new RequirementError('设计文件版本不一致', 'E_DENIED')
      selected.set(key, source)
    }
    if (selected.size !== files.length) throw new RequirementError('设计资料与已固定快照不一致', 'E_DENIED')
    for (const file of files) {
      const source = selected.get(requirementDesignSourceKey(file.source)), actual = readRegular(record.conversationRoot, file.snapshotPath, dto.REQUIREMENT_FILE_BYTES)
      if (!source || JSON.stringify(source) !== JSON.stringify(file.source) || actual.bytes.length !== file.bytes || hash(actual.bytes) !== source.revision) throw new RequirementError('设计资料快照身份或摘要已变化', 'E_DENIED')
      selected.delete(requirementDesignSourceKey(file.source))
    }
  }
  private async authorizeDesignSources(owner: Owner, record: Record): Promise<void> {
    this.designReferencesCurrent(record)
    await this.authorizeDesignFiles(owner, record.conversationRoot, record.draft.designContextFiles)
  }
  private async authorizeDesignFiles(owner: Owner, root: string, files: dto.RequirementDesignSnapshot[]): Promise<void> {
    for (const file of files) {
      const source = file.source
      if (source.kind === 'project-file' && (owner.conversation.kind !== 'code' || owner.conversation.workspace.kind !== 'directory' || !sameRoot(source.projectRoot, root))) throw new RequirementError('工程设计文件不属于当前已授权目录', 'E_DENIED')
      const fileId = source.kind === 'file' ? source.fileId : hash(source.relativePath.replaceAll('\\', '/'))
      const actual = await this.ports.selectedFile(owner.conversation.id, fileId, source.revision)
      owner.assertCurrent()
      if (actual.file.id !== fileId || actual.file.name !== source.name || actual.file.relativePath !== file.relativePath || actual.file.revision !== source.revision || hash(Buffer.from(actual.bytes)) !== source.revision) throw new RequirementError('设计文件当前权限或摘要已变化，请重新选择', 'E_DENIED')
      const snapshot = readRegular(root, file.snapshotPath, dto.REQUIREMENT_FILE_BYTES).bytes
      if (snapshot.length !== file.bytes || hash(snapshot) !== source.revision) throw new RequirementError('设计文件固定快照已变化', 'E_DENIED')
    }
  }
  private designEvidence(context: RequirementDesignContext | undefined, files: dto.RequirementDesignSnapshot[]): dto.RequirementDesignEvidence[] {
    return files.map((file, index) => {
      const equal = (source: unknown): boolean => JSON.stringify(source) === JSON.stringify(file.source)
      const roles: Array<'standard' | 'material'> = []
      if (context?.standards.some(equal)) roles.push('standard')
      if (context?.materials.some(equal)) roles.push('material')
      if (!roles.length) throw new RequirementError('交接设计文件不属于原已确认设计语境', 'E_DENIED')
      return dto.requirementDesignEvidenceSchema.parse({ source: file.source, originalPath: file.relativePath, path: designTarget(file, index), revision: file.source.revision, bytes: file.bytes, roles })
    })
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
      if (readOptional(this.meta(), `requirements/${conversationId}/successors/${input.commandId}.json`, 16 * 1024)) throw new RequirementError('该命令已用于后继草稿，不能创建另一份需求')
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
        this.assertCreationCapacity(conversationId)
        command = { version: 1, conversationId, creatorId: owner.conversation.creatorId, root: owner.conversation.workspace.root, rootIdentity: directoryIdentity(owner.conversation.workspace.root), commandId: input.commandId, inputDigest: digest, draftId: randomUUID(), createdAt: Date.now(), state: 'registered' }
        writeRevision(this.meta(), commandPath, Buffer.from(JSON.stringify(command)), null, owner.assertCurrent)
      }
      const relativePath = owner.conversation.workspace.kind === 'managed' ? `outputs/requirements/${command.draftId}/draft.md` : `.trellis-panel/conversations/${conversationId}/requirements/${command.draftId}/draft.md`
      const references = await this.references(owner, relativePath, input.references)
      const designContextFiles = await this.designReferences(owner, relativePath, input.designContext)
      if (references.reduce((sum, item) => sum + item.bytes, 0) + designContextFiles.reduce((sum, item) => sum + item.bytes, 0) > dto.REQUIREMENT_REFERENCES_BYTES) throw new RequirementError('需求与设计引用文件总量超过上限', 'E_BUSY')
      const current = await this.fresh(owner, true)
      const body = input.body.trim() ? input.body : dto.REQUIREMENT_TEMPLATE
      const draft = dto.requirementDraftSchema.parse({ id: command.draftId, conversationId, creatorId: current.conversation.creatorId, title: input.title, body, revision: randomUUID(), bodyRevision: hash(body), relativePath, references, designContext: input.designContext, designContextFiles, createdAt: command.createdAt, updatedAt: command.createdAt })
      const record: Record = { version: 1, conversationRoot: command.root, rootIdentity: command.rootIdentity, creationCommandId: input.commandId, draft, confirmations: [], rejectedHandoffs: [], recoveredFiles: [] }
      this.persist(current, record, null)
      writeRevision(record.conversationRoot, relativePath, Buffer.from(body), null, current.assertCurrent)
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
  private successorSeed(owner: Owner, loaded: Loaded, expectedHandoffCommandId: string): { predecessor: dto.RequirementPredecessor; targetIdentity: string; title: string; body: string; questions: dto.RequirementQuestion[]; references: dto.RequirementReference[]; designContext?: RequirementDesignContext; designFiles: dto.RequirementDesignSnapshot[] } {
    const record = loaded.record, intent = record.intent
    if (!intent || intent.commandId !== expectedHandoffCommandId || record.draft.handoff?.state !== 'created' || !intent.confirmed || !intent.plan || !record.targetIdentity) throw new RequirementError('原需求交接尚未完成或命令不匹配，不能创建后继草稿')
    const task = this.task(record)
    if (!task || trellisTarget(task.root).identity !== record.targetIdentity) throw new RequirementError('原任务或工程身份不可核对，不能创建替代任务', 'E_DENIED')
    this.verifyHandoffFiles(owner, record)
    const prefix = `.trellis/tasks/${task.taskDir}/`
    if (hash(readRegular(task.root, `${prefix}references/requirement.md`, dto.REQUIREMENT_BODY_BYTES).bytes) !== intent.confirmed.bodyRevision || hash(readRegular(task.root, `${prefix}references/plan.md`, dto.REQUIREMENT_BODY_BYTES).bytes) !== intent.plan.bodyRevision || hash(readRegular(task.root, `${prefix}references/requirement-confirmation.json`, REQUIREMENT_SOURCE_BYTES).bytes) !== intent.confirmed.snapshotRevision) throw new RequirementError('原任务固定需求、计划或确认快照已变化，不能创建后继草稿', 'E_DENIED')
    const snapshotBytes = readRegular(record.conversationRoot, intent.confirmed.relativePath, REQUIREMENT_SOURCE_BYTES).bytes
    if (hash(snapshotBytes) !== intent.confirmed.snapshotRevision) throw new RequirementError('原需求确认快照已变化', 'E_DENIED')
    const snapshot = z.object({ conversationId: id, creatorId: z.string(), draftId: id, revision: id, sourceDigest: z.string(), title: z.string(), body: z.string(), bodyRevision: z.string(), questions: z.array(dto.requirementQuestionSchema).max(32), references: z.array(dto.requirementReferenceSchema).max(8), designContext: requirementDesignContextSchema.optional(), designContextFiles: z.array(dto.requirementDesignSnapshotSchema).max(16).optional(), predecessor: dto.requirementPredecessorSchema.optional() }).passthrough().parse(JSON.parse(utf8(snapshotBytes)))
    const designFiles = snapshot.designContextFiles ?? []
    if (snapshot.conversationId !== owner.conversation.id || snapshot.creatorId !== owner.conversation.creatorId || snapshot.draftId !== record.draft.id || snapshot.revision !== intent.confirmed.revision || snapshot.sourceDigest !== intent.confirmed.sourceDigest || snapshot.bodyRevision !== intent.confirmed.bodyRevision || hash(snapshot.body) !== snapshot.bodyRevision || snapshot.body !== intent.body || JSON.stringify(snapshot.references) !== JSON.stringify(intent.references) || JSON.stringify(snapshot.designContext) !== JSON.stringify(intent.designContext) || JSON.stringify(designFiles) !== JSON.stringify(intent.designFiles ?? [])) throw new RequirementError('原确认材料与任务交接身份不一致', 'E_DENIED')
    const baseline = dto.requirementDraftSchema.parse({ ...record.draft, title: snapshot.title, body: snapshot.body, bodyRevision: snapshot.bodyRevision, questions: snapshot.questions, references: snapshot.references, designContext: snapshot.designContext, designContextFiles: designFiles, predecessor: snapshot.predecessor })
    if (requirementSourceDigest(baseline) !== snapshot.sourceDigest) throw new RequirementError('原确认材料摘要无法核对', 'E_DENIED')
    const predecessor = dto.requirementPredecessorSchema.parse({ version: 1, draftId: record.draft.id, handoffCommandId: intent.commandId, draftRevision: intent.draftRevision, confirmedRevision: intent.confirmed.revision, planRevision: intent.plan.revision, bodyRevision: intent.confirmed.bodyRevision, manifestRevision: hash(intent.manifest), task: { root: task.root, taskDir: task.taskDir, taskId: task.taskId } })
    owner.assertCurrent()
    return { predecessor, targetIdentity: record.targetIdentity, title: snapshot.title, body: snapshot.body, questions: snapshot.questions, references: snapshot.references, designContext: snapshot.designContext, designFiles }
  }
  createSuccessor(conversationId: string, originalDraftId: string, raw: unknown, current?: () => void): Promise<RequirementResult<dto.RequirementView>> {
    return this.result(() => this.serial(conversationId, async () => {
      const input = dto.requirementCreateSuccessorSchema.parse(raw), owner = await this.owner(conversationId, true)
      const commandPath = `requirements/${conversationId}/successors/${input.commandId}.json`, inputDigest = hash(JSON.stringify({ originalDraftId, ...input }))
      if (readOptional(this.meta(), `requirements/${conversationId}/creates/${input.commandId}.json`, 16 * 1024)) throw new RequirementError('该命令已用于普通草稿，不能创建后继草稿')
      const prior = readOptional(this.meta(), commandPath, 16 * 1024)
      let command: z.infer<typeof successorCommandSchema> | undefined
      if (prior) {
        command = successorCommandSchema.parse(JSON.parse(utf8(prior.bytes)))
        if (command.conversationId !== conversationId || command.creatorId !== owner.conversation.creatorId || command.originalDraftId !== originalDraftId || command.expectedHandoffCommandId !== input.expectedHandoffCommandId || command.inputDigest !== inputDigest || !sameRoot(command.root, owner.conversation.workspace.root) || command.rootIdentity !== directoryIdentity(command.root)) throw new RequirementError('原后继草稿命令的身份或固定基线不一致', 'E_DENIED')
        if (existsSync(join(this.meta(), this.rowPath(conversationId, command.draftId)))) {
          const existing = this.load(owner, command.draftId).record
          if (existing.creationCommandId !== input.commandId || existing.draft.predecessor?.draftId !== originalDraftId || existing.draft.predecessor.handoffCommandId !== input.expectedHandoffCommandId) throw new RequirementError('原后继草稿回执身份不一致', 'E_DENIED')
          const view = this.view(owner, existing)
          if (command.state === 'registered' && view.fileState === 'missing') writeRevision(existing.conversationRoot, existing.draft.relativePath, Buffer.from(existing.draft.body), null, owner.assertCurrent)
          if (command.state === 'registered' && this.view(owner, existing).fileState === 'saved') this.completeSuccessor(owner, commandPath, command)
          return this.view(owner, existing)
        }
        if (command.state === 'saved') throw new RequirementError('原后继草稿记录不可读取；未创建替代草稿', 'E_NOT_FOUND')
      }
      const seed = this.successorSeed(owner, this.load(owner, originalDraftId), input.expectedHandoffCommandId), seedDigest = hash(JSON.stringify(seed))
      if (prior) {
        if (!command || command.seedDigest !== seedDigest) throw new RequirementError('原后继草稿的固定基线已变化，未创建替代草稿')
      } else {
        const existing = await this.list(conversationId)
        if (!existing.ok) throw new RequirementError(existing.error, existing.code as RequirementError['code'])
        if (existing.value.length >= 128) throw new RequirementError('此会话最多保留 128 份需求草稿', 'E_BUSY')
        this.assertCreationCapacity(conversationId)
        command = { version: 1, conversationId, creatorId: owner.conversation.creatorId, root: owner.conversation.workspace.root, rootIdentity: directoryIdentity(owner.conversation.workspace.root), commandId: input.commandId, inputDigest, originalDraftId, expectedHandoffCommandId: input.expectedHandoffCommandId, targetId: randomUUID(), seedDigest, draftId: randomUUID(), createdAt: Date.now(), state: 'registered' }
        writeRevision(this.meta(), commandPath, Buffer.from(JSON.stringify(command)), null, owner.assertCurrent)
      }
      if (!command) throw new RequirementError('原后继草稿命令不可读取', 'E_IO')
      const fresh = await this.fresh(owner, true), checked = this.successorSeed(fresh, this.load(fresh, originalDraftId), input.expectedHandoffCommandId)
      if (hash(JSON.stringify(checked)) !== command.seedDigest) throw new RequirementError('原任务基线在创建后继草稿期间发生变化')
      const relativePath = fresh.conversation.workspace.kind === 'managed' ? `outputs/requirements/${command.draftId}/draft.md` : `.trellis-panel/conversations/${conversationId}/requirements/${command.draftId}/draft.md`
      const draft = dto.requirementDraftSchema.parse({ id: command.draftId, conversationId, creatorId: fresh.conversation.creatorId, title: seed.title, body: seed.body, revision: randomUUID(), bodyRevision: hash(seed.body), relativePath, references: seed.references, designContext: seed.designContext, designContextFiles: seed.designFiles, questions: seed.questions, predecessor: seed.predecessor, target: { id: command.targetId, root: seed.predecessor.task.root, selectedAt: command.createdAt }, createdAt: command.createdAt, updatedAt: command.createdAt })
      const record: Record = { version: 1, conversationRoot: command.root, rootIdentity: command.rootIdentity, creationCommandId: input.commandId, draft, targetIdentity: seed.targetIdentity, confirmations: [], rejectedHandoffs: [], recoveredFiles: [] }
      this.persist(fresh, record, null)
      writeRevision(record.conversationRoot, relativePath, Buffer.from(seed.body), null, fresh.assertCurrent)
      this.completeSuccessor(fresh, commandPath, command)
      return this.view(fresh, record)
    }), current)
  }
  private completeSuccessor(owner: Owner, path: string, command: z.infer<typeof successorCommandSchema>): void {
    const bytes = readRegular(this.meta(), path, 16 * 1024).bytes, current = successorCommandSchema.parse(JSON.parse(utf8(bytes)))
    if (current.commandId !== command.commandId || current.inputDigest !== command.inputDigest || current.seedDigest !== command.seedDigest || current.draftId !== command.draftId || current.creatorId !== owner.conversation.creatorId) throw new RequirementError('原后继草稿回执已变化')
    if (current.state !== 'saved') writeRevision(this.meta(), path, Buffer.from(JSON.stringify({ ...current, state: 'saved' })), hash(bytes), owner.assertCurrent)
  }
  private predecessorCurrent(owner: Owner, record: Record): void {
    const predecessor = record.draft.predecessor
    if (!predecessor) return
    const original = this.load(owner, predecessor.draftId), seed = this.successorSeed(owner, original, predecessor.handoffCommandId)
    if (JSON.stringify(seed.predecessor) !== JSON.stringify(predecessor) || !record.targetIdentity || seed.targetIdentity !== record.targetIdentity || !record.draft.target || !sameRoot(record.draft.target.root, predecessor.task.root)) throw new RequirementError('原任务基线或后继目标已变化，请核对原任务；未创建替代任务', 'E_DENIED')
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
      if (input.resolvePending) { this.editable(original.record); this.resolvePending(owner, original, 'requirement', input.expectedRevision, input.body, input.expectedFileRevision); return this.view(owner, original.record) }
      this.cas(original.record, input.expectedRevision); this.editable(original.record)
      const expected = original.record.draft.bodyRevision
      if (input.expectedFileRevision !== undefined && input.expectedFileRevision !== expected) throw new RequirementError('普通保存只能使用已保存正文摘要；请先明确处理外部文件冲突')
      const file = readOptional(original.record.conversationRoot, original.record.draft.relativePath)
      if ((file ? hash(file.bytes) : null) !== expected) throw new RequirementError('实际文件已改变，请明确核对文件后再保存；未覆盖内容')
      const references = await this.references(owner, original.record.draft.relativePath, input.references)
      const designContext = input.designContext ?? original.record.draft.designContext
      const designContextFiles = input.designContext ? await this.designReferences(owner, original.record.draft.relativePath, input.designContext) : original.record.draft.designContextFiles
      if (references.reduce((sum, item) => sum + item.bytes, 0) + designContextFiles.reduce((sum, item) => sum + item.bytes, 0) > dto.REQUIREMENT_REFERENCES_BYTES) throw new RequirementError('需求与设计引用文件总量超过上限', 'E_BUSY')
      const current = await this.fresh(owner, true), loaded = this.load(current, draftId)
      this.cas(loaded.record, input.expectedRevision); this.editable(loaded.record)
      const before = requirementSourceDigest(loaded.record.draft)
      const next = structuredClone(loaded.record.draft)
      Object.assign(next, { title: input.title, body: input.body, references, designContext, designContextFiles, questions: input.questions ?? next.questions, bodyRevision: hash(input.body), revision: randomUUID(), updatedAt: Date.now() })
      if (next.plan && before !== requirementSourceDigest(next)) next.plan.stale = true
      this.saveDocument(current, loaded, next, 'requirement', expected)
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
      if (loaded.record.draft.bodyRevision !== input.fileRevision) {
        if (loaded.record.recoveredFiles.length >= 128) throw new RequirementError('恢复文件记录达到存储上限', 'E_BUSY')
        const directory = loaded.record.draft.relativePath.slice(0, loaded.record.draft.relativePath.lastIndexOf('/'))
        const path = `${directory}/recovery/${randomUUID()}-${loaded.record.draft.bodyRevision}.md`
        writeRevision(loaded.record.conversationRoot, path, Buffer.from(loaded.record.draft.body), null, owner.assertCurrent)
        loaded.record.recoveredFiles.push({ document: 'requirement', path, revision: loaded.record.draft.bodyRevision })
        if (hash(readRegular(loaded.record.conversationRoot, loaded.record.draft.relativePath, dto.REQUIREMENT_BODY_BYTES).bytes) !== input.fileRevision) throw new RequirementError('实际文件再次变化，未同步')
      }
      if (loaded.record.draft.plan && loaded.record.draft.bodyRevision !== input.fileRevision) loaded.record.draft.plan.stale = true
      loaded.record.draft = { ...loaded.record.draft, body, bodyRevision: input.fileRevision, revision: randomUUID(), updatedAt: Date.now() }
      this.persist(owner, loaded.record, loaded.digest)
      return this.view(owner, loaded.record)
    }), current)
  }
  resolveConflict(conversationId: string, draftId: string, raw: unknown, current?: () => void): Promise<RequirementResult<dto.RequirementView>> {
    return this.result(() => this.serial(conversationId, async () => {
      const input = dto.requirementResolveConflictSchema.parse(raw), owner = await this.owner(conversationId, true)
      let loaded = this.load(owner, draftId)
      this.cas(loaded.record, input.expectedRevision); this.editable(loaded.record); this.referencesCurrent(loaded.record)
      const draft = loaded.record.draft, previousPlan = draft.plan
      if (input.document === 'plan' && input.expectedPlanRevision !== (previousPlan?.revision ?? null)) throw new RequirementError('原计划版本已变化，请重新比较')
      const confirmed = input.document === 'plan' ? this.confirmationCurrent(loaded.record) : undefined
      if (input.document === 'plan') this.saved(owner, loaded.record)
      const directory = draft.relativePath.slice(0, draft.relativePath.lastIndexOf('/'))
      const path = input.document === 'plan' ? previousPlan?.relativePath ?? `${directory}/plan.md` : draft.relativePath
      const actual = readOptional(loaded.record.conversationRoot, path)
      if ((actual ? hash(actual.bytes) : null) !== input.expectedFileRevision) throw new RequirementError('实际文件再次变化，请重新比较；未覆盖')
      const fileBody = actual ? utf8(actual.bytes) : undefined
      if (input.decision === 'use-file' && fileBody === undefined) throw new RequirementError('实际文件不存在，不能采用文件版本')
      const savedBody = input.document === 'plan' ? previousPlan?.body : draft.body
      const backup = (text: string): void => {
        if (loaded.record.recoveredFiles.length >= 128) throw new RequirementError('恢复文件记录达到存储上限', 'E_BUSY')
        const revision = hash(text), backupPath = `${directory}/recovery/${randomUUID()}-${revision}.md`
        writeRevision(loaded.record.conversationRoot, backupPath, Buffer.from(text), null, owner.assertCurrent)
        loaded.record.recoveredFiles.push({ document: input.document, path: backupPath, revision })
      }
      if (input.decision === 'keep-local') { if (fileBody !== undefined) backup(fileBody) }
      else {
        if (savedBody !== undefined && savedBody !== fileBody) backup(savedBody)
        if (input.body !== undefined && input.body !== savedBody && input.body !== fileBody) backup(input.body)
      }
      if (input.decision === 'use-file') {
        const checked = readOptional(loaded.record.conversationRoot, path)
        if (!checked || hash(checked.bytes) !== input.expectedFileRevision) throw new RequirementError('实际文件再次变化，请重新比较；未采用')
      }
      const next = structuredClone(draft), body = input.decision === 'keep-local' ? input.body : fileBody, now = Date.now()
      if (body === undefined) throw new RequirementError('冲突解决缺少明确的正文')
      if (input.document === 'requirement') {
        const before = requirementSourceDigest(next)
        next.body = body; next.bodyRevision = hash(body)
        if (next.plan && before !== requirementSourceDigest(next)) next.plan.stale = true
      } else {
        if (!confirmed) throw new RequirementError('请先确认当前需求')
        next.plan = { body, bodyRevision: hash(body), revision: randomUUID(), relativePath: path, sourceRevision: confirmed.revision, sourceDigest: confirmed.sourceDigest, stale: false, updatedAt: now }
      }
      next.revision = randomUUID(); next.updatedAt = now
      if (input.decision === 'keep-local') {
        loaded = this.persist(owner, loaded.record, loaded.digest)
        this.saveDocument(owner, loaded, next, input.document, input.expectedFileRevision)
      } else { loaded.record.draft = next; this.persist(owner, loaded.record, loaded.digest) }
      return this.view(owner, loaded.record)
    }), current)
  }
  private referencesCurrent(record: Record): void {
    for (const reference of record.draft.references) if (hash(readRegular(record.conversationRoot, reference.snapshotPath, dto.REQUIREMENT_FILE_BYTES).bytes) !== reference.revision) throw new RequirementError('所选资料快照已改变')
    this.designReferencesCurrent(record)
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
    if (loaded.record.pendingSave) return loaded
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
      else if (proof.state === 'completed' && operation.action === 'discuss') { operation.state = 'completed'; operation.detail = undefined }
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
  run(conversationId: string, draftId: string, raw: unknown, current?: () => void): Promise<dto.RequirementRunResult> {
    let registrationMayHaveHappened = true
    return this.result(() => this.serial(conversationId, async () => {
      const input = dto.requirementRunSchema.parse(raw), inputDigest = hash(JSON.stringify(input)), owner = await this.owner(conversationId, true)
      let loaded = this.load(owner, draftId)
      const prior = loaded.record.draft.operations.find(value => value.commandId === input.commandId)
      if (prior) {
        if (prior.inputDigest !== inputDigest) throw new RequirementError('原操作命令不能用于不同内容；未重新发送')
        loaded = await this.refreshOperation(owner, loaded, prior.id)
        return this.observation(loaded.record, prior.id)
      }
      registrationMayHaveHappened = false
      this.cas(loaded.record, input.expectedRevision); this.editable(loaded.record); this.saved(owner, loaded.record)
      if (!dto.hasRequirementContent(loaded.record.draft.body)) throw new RequirementError('请先描述需求，空模板不能作为有效输入', 'E_INVALID_ARG')
      if (!input.quote?.comparisonOnly) await this.authorizeDesignSources(owner, loaded.record)
      const ownerAfterDesign = await this.fresh(owner, true), afterDesign = this.load(ownerAfterDesign, draftId)
      if (afterDesign.digest !== loaded.digest) throw new RequirementError('需求或设计语境在权限核对期间发生变化')
      loaded = afterDesign; this.saved(ownerAfterDesign, loaded.record)
      if (loaded.record.draft.operations.length >= dto.REQUIREMENT_OPERATIONS_LIMIT) throw new RequirementError('需求操作已达到有界存储上限；原回执仍保留', 'E_BUSY')
      if (loaded.record.draft.operations.some(value => ['reserved', 'dispatching', 'running', 'unknown'].includes(value.state))) throw new RequirementError('原需求操作尚待核对，请继续观察原操作，不能自动重发', 'E_BUSY')
      const sourceDocument = actionSourceDocument(loaded.record.draft, input)
      if (input.document === 'plan' && input.action !== 'plan' && this.view(owner, loaded.record).planFileState !== 'saved') throw new RequirementError('请先保存实际计划文件')
      if (input.document === 'plan') this.confirmationCurrent(loaded.record)
      if (input.quote?.comparisonOnly && (input.action !== 'revise' || input.quote.anchor || input.knowledgeSelection || input.knowledgeSources?.length || input.fromConversation)) throw new RequirementError('仅比较模式只能使用引文和用户指令，不能指定位置或附加资料', 'E_INVALID_ARG')
      if (input.quote?.comparisonOnly && (input.quote.bodyRevision !== sourceDocument.bodyRevision || !hasRequirementQuote(sourceDocument.body, input.quote.text))) throw new RequirementError('引文不属于当前已保存文档，请重新选择', 'E_INVALID_ARG')
      const fixedQuoteContext = input.quote && !input.quote.comparisonOnly ? quoteContext(sourceDocument.body, input.quote) : undefined
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
        const designContextFiles = (input.quote?.comparisonOnly ? [] : loaded.record.draft.designContextFiles).map(file => {
          const bytes = readRegular(loaded.record.conversationRoot, file.snapshotPath, dto.REQUIREMENT_FILE_BYTES).bytes
          const textual = /\.(?:md|txt|html?|svg|csv|tsv|json|css|m?js|tsx?|jsx|py|sql|xml)$/i.test(file.source.name)
          let text: string | undefined
          if (textual && bytes.length <= 64 * 1024 && !bytes.includes(0)) { try { text = utf8(bytes) } catch { /* The exact binary snapshot remains available by path. */ } }
          return { ...file, ...(text !== undefined ? { text } : {}) }
        })
        source = requirementActionSourceSchema.parse({ version: 1, operationId: input.commandId, requestId: randomUUID(), inputDigest, createdAt: Date.now(), conversationId, draftId, draftRevision: input.expectedRevision,
          action: input.action, document: input.document, sourceDigest: sourceDocument.sourceDigest, title: input.quote?.comparisonOnly ? '选区比较' : loaded.record.draft.title, markdown: input.quote?.comparisonOnly ? input.quote.text : sourceDocument.body, bodyRevision: sourceDocument.bodyRevision,
          questions: input.quote?.comparisonOnly ? [] : loaded.record.draft.questions, confirmed: input.quote?.comparisonOnly ? undefined : input.document === 'plan' ? loaded.record.draft.confirmed : undefined, references: input.quote?.comparisonOnly ? [] : loaded.record.draft.references, designContext: input.quote?.comparisonOnly ? undefined : loaded.record.draft.designContext, designContextFiles, knowledge, text: input.text, quote: input.quote, quoteContext: fixedQuoteContext, conversationContext })
        bytes = Buffer.from(JSON.stringify(source))
        if (bytes.length > REQUIREMENT_SOURCE_BYTES) throw new RequirementError('固定操作输入超过存储上限', 'E_BUSY')
        writeRevision(loaded.record.conversationRoot, sourcePath, bytes, null, fresh.assertCurrent)
      }
      owner.assertCurrent()
      if (input.action !== 'discuss') {
        const reserved = readOptional(loaded.record.conversationRoot, relativePath, dto.REQUIREMENT_CANDIDATE_BYTES)
        if (reserved && hash(reserved.bytes) !== hash('{}')) throw new RequirementError('未发送操作的预留候选文件已被修改，未覆盖或发送')
        if (!reserved) writeRevision(loaded.record.conversationRoot, relativePath, Buffer.from('{}'), null, owner.assertCurrent)
      }
      const operation = dto.requirementOperationSchema.parse({ id: input.commandId, commandId: input.commandId, action: input.action, document: input.document,
        sourceRevision: input.expectedRevision, sourceBodyRevision: sourceDocument.bodyRevision, sourceDigest: sourceDocument.sourceDigest, sourceFileRevision: hash(bytes), planSourceRevision: sourceDocument.planSourceRevision,
        inputDigest, displayText: actionDisplay(input), quote: input.quote, knowledgeSelection: input.knowledgeSelection,
        knowledge: source.knowledge.map(value => ({ sourceId: value.sourceId, returnedRevision: value.returnedRevision, title: value.title, connectionId: value.selection.connectionId, collectionId: value.collectionId, documentId: value.documentId, contentHash: value.contentHash, truncated: value.truncated })),
        sourcePath, relativePath, state: 'dispatching', requestId: source.requestId, createdAt: source.createdAt, updatedAt: Date.now() })
      loaded.record.draft.operations.push(operation)
      registrationMayHaveHappened = true
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
    }), current).then(result => !result.ok && !registrationMayHaveHappened ? { ...result, outcome: 'not-admitted' as const, notSent: true as const } : result)
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
  private async authorizeKnowledge(owner: Owner, snapshots: dto.RequirementKnowledgeSnapshot[]): Promise<void> {
    if (!snapshots.length) return
    if (!this.ports.authorizeSnapshots) throw new RequirementError('当前无法复核知识来源权限', 'E_DENIED')
    for (let offset = 0; offset < snapshots.length; offset += 8) {
      const batch = snapshots.slice(offset, offset + 8)
      const authorized = await this.ports.authorizeSnapshots(owner.conversation.id, batch, owner.assertCurrent)
      owner.assertCurrent()
      if (JSON.stringify(authorized) !== JSON.stringify(batch)) throw new RequirementError('已授权知识摘录与原固定版本不一致', 'E_DENIED')
    }
  }
  private async authorizeFiles(owner: Owner, references: dto.RequirementReference[]): Promise<void> {
    for (const reference of references) {
      const actual = await this.ports.selectedFile(owner.conversation.id, reference.fileId, reference.revision)
      owner.assertCurrent()
      if (actual.file.id !== reference.fileId || actual.file.revision !== reference.revision || actual.file.relativePath !== reference.relativePath || hash(Buffer.from(actual.bytes)) !== reference.revision) throw new RequirementError('所选文件权限或原版本已变化', 'E_DENIED')
    }
  }
  evidence(conversationId: string, draftId: string, operationId: string, current?: () => void): Promise<RequirementResult<dto.RequirementKnowledgeSnapshot[]>> {
    return this.result(() => this.serial(conversationId, async () => {
      const owner = await this.owner(conversationId), loaded = this.load(owner, draftId)
      const snapshots = this.sealedKnowledge(owner, loaded.record, this.operation(loaded.record, operationId))
      await this.authorizeKnowledge(owner, snapshots)
      const fresh = await this.fresh(owner), latest = this.load(fresh, draftId)
      if (latest.digest !== loaded.digest || JSON.stringify(this.sealedKnowledge(fresh, latest.record, this.operation(latest.record, operationId))) !== JSON.stringify(snapshots)) throw new RequirementError('原操作或来源在授权期间发生变化')
      return snapshots
    }), current)
  }
  applySelection(conversationId: string, draftId: string, operationId: string, raw: unknown, current?: () => void): Promise<RequirementResult<{ view: dto.RequirementView; receipt: dto.RequirementSelectionReceipt }>> {
    return this.result(() => this.serial(conversationId, async () => {
      const input = dto.requirementApplySelectionSchema.parse(raw), inputDigest = hash(JSON.stringify(input))
      const owner = await this.owner(conversationId, true), loaded = this.load(owner, draftId), record = loaded.record
      const operation = this.operation(record, operationId)
      if (operation.selectionReceipt) {
        if (operation.selectionReceipt.inputDigest !== inputDigest) throw new RequirementError('原选区采用回执不能用于不同输入')
        return { view: this.view(owner, record), receipt: operation.selectionReceipt }
      }
      this.cas(record, input.expectedRevision); this.editable(record); this.saved(owner, record)
      if (operation.state !== 'candidate' || operation.action !== 'revise' || operation.sourceRevision !== input.expectedRevision || operation.sourceDigest !== requirementSourceDigest(record.draft)) throw new RequirementError('原选区候选或文档版本已变化，未采用')
      const source = readActionSource(record.conversationRoot, operation), observed = this.observation(record, operation.id)
      const replacement = observed.candidate?.selectionReplacement
      if (source.quote?.comparisonOnly) throw new RequirementError('此候选仅供比较或复制，不能自动应用')
      if (!source.quote || replacement === undefined || operation.candidateRevision !== input.candidateRevision) throw new RequirementError('原选区候选身份不一致，未采用')
      const before = operation.document === 'plan' ? record.draft.plan?.body : record.draft.body
      if (before === undefined || hash(before) !== source.quote.bodyRevision || before !== source.markdown) throw new RequirementError('原选区文档版本已变化，未采用')
      const anchor = source.quote.anchor
      if (!anchor) throw new RequirementError('原候选缺少可验证的选区位置，请比较或复制后重新选择')
      const range = quoteContext(before, source.quote)
      if (input.body !== before.slice(0, range.from) + replacement + before.slice(range.to)) throw new RequirementError('无法证明编辑结果仅替换原选区，请比较或复制候选')
      const next = structuredClone(record.draft), now = Date.now(), adoptedRevision = randomUUID()
      const selected = next.operations.find(value => value.id === operation.id)
      if (!selected) throw new RequirementError('原选区操作不存在', 'E_NOT_FOUND')
      const receipt = dto.requirementSelectionReceiptSchema.parse({ operationId: operation.id, expectedRevision: input.expectedRevision, candidateRevision: input.candidateRevision, inputDigest, adoptedRevision, bodyRevision: hash(input.body) })
      selected.state = 'adopted'; selected.adoptedRevision = adoptedRevision; selected.selectionReceipt = receipt; selected.updatedAt = now
      next.revision = adoptedRevision; next.updatedAt = now
      let expected: string
      if (operation.document === 'requirement') {
        if (input.expectedPlanRevision !== undefined) throw new RequirementError('需求选区不能指定计划版本', 'E_INVALID_ARG')
        expected = record.draft.bodyRevision; next.body = input.body; next.bodyRevision = receipt.bodyRevision
        if (next.plan) next.plan.stale = true
      } else {
        const plan = currentPlan(record.draft); this.confirmationCurrent(record)
        if (input.expectedPlanRevision !== plan.revision || operation.planSourceRevision !== plan.sourceRevision || this.view(owner, record).planFileState !== 'saved') throw new RequirementError('原计划版本或文件已变化，未采用')
        expected = plan.bodyRevision
        next.plan = { ...plan, body: input.body, bodyRevision: receipt.bodyRevision, revision: randomUUID(), updatedAt: now, operationId: operation.id }
      }
      this.saveDocument(owner, loaded, next, operation.document, expected)
      return { view: this.view(owner, record), receipt }
    }), current)
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
      const source = readActionSource(loaded.record.conversationRoot, operation)
      if (operation.action === 'discuss') throw new RequirementError('普通讨论不会修改文档；请明确发起文档修改')
      if (source.quote) throw new RequirementError('选区候选只能在编辑器中核对位置后应用，不能整篇覆盖')
      const observed = this.observation(loaded.record, operationId)
      if (!observed.candidate || operation.candidateRevision !== input.candidateRevision) throw new RequirementError('候选文件版本已改变，未采用')
      this.saved(owner, loaded.record)
      const now = Date.now(), revision = randomUUID(), next = structuredClone(loaded.record.draft)
      const adopted = next.operations.find(value => value.id === operation.id)
      if (!adopted) throw new RequirementError('原候选操作不存在', 'E_NOT_FOUND')
      if (operation.document === 'requirement') {
        Object.assign(next, { title: observed.candidate.title, body: observed.candidate.markdown, bodyRevision: hash(observed.candidate.markdown), questions: observed.candidate.questions, revision, updatedAt: now })
        if (next.plan) next.plan.stale = true
        adopted.state = 'adopted'; adopted.adoptedRevision = next.revision; adopted.updatedAt = now
        this.saveDocument(owner, loaded, next, 'requirement', loaded.record.draft.bodyRevision)
      } else {
        const confirmed = this.confirmationCurrent(loaded.record)
        if (operation.planSourceRevision !== confirmed.revision) throw new RequirementError('候选计划不属于当前已确认需求')
        this.writePlan(owner, loaded, observed.candidate.markdown, operation.id)
      }
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
      if (!dto.hasRequirementContent(loaded.record.draft.body)) throw new RequirementError('请先描述需求，空模板不能作为有效输入')
      await this.authorizeDesignSources(owner, loaded.record)
      const fresh = await this.fresh(owner, true), latest = this.load(fresh, draftId)
      if (latest.digest !== loaded.digest) throw new RequirementError('需求或设计语境在权限核对期间发生变化')
      this.saved(fresh, latest.record)
      if (loaded.record.confirmations.length >= 128) throw new RequirementError('需求确认回执达到存储上限', 'E_BUSY')
      const sourceDigest = requirementSourceDigest(loaded.record.draft), directory = loaded.record.draft.relativePath.slice(0, loaded.record.draft.relativePath.lastIndexOf('/'))
      const relativePath = `${directory}/confirmations/${input.commandId}.json`
      const snapshot = Buffer.from(JSON.stringify({ version: 1, conversationId, creatorId: loaded.record.draft.creatorId, draftId, revision: input.expectedRevision, sourceDigest, title: loaded.record.draft.title, body: loaded.record.draft.body, bodyRevision: loaded.record.draft.bodyRevision, questions: loaded.record.draft.questions, references: loaded.record.draft.references, designContext: loaded.record.draft.designContext, designContextFiles: loaded.record.draft.designContextFiles, predecessor: loaded.record.draft.predecessor }))
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
    const now = Date.now()
    const next = structuredClone(loaded.record.draft)
    next.plan = { body, revision: randomUUID(), bodyRevision: hash(body), relativePath, sourceRevision: confirmed.revision, sourceDigest: confirmed.sourceDigest, stale: false, updatedAt: now, operationId }
    next.revision = randomUUID(); next.updatedAt = now
    if (operationId) { const operation = next.operations.find(value => value.id === operationId); if (!operation) throw new RequirementError('原计划操作不存在'); operation.state = 'adopted'; operation.adoptedRevision = next.revision; operation.updatedAt = now }
    this.saveDocument(owner, loaded, next, 'plan', expected)
  }
  savePlan(conversationId: string, draftId: string, raw: unknown, current?: () => void): Promise<RequirementResult<dto.RequirementView>> {
    return this.result(() => this.serial(conversationId, async () => {
      const input = dto.requirementSavePlanSchema.parse(raw), owner = await this.owner(conversationId, true), loaded = this.load(owner, draftId)
      if (input.resolvePending) { this.editable(loaded.record); if ((loaded.record.draft.plan?.revision ?? null) !== input.expectedPlanRevision) throw new RequirementError('原计划版本已变化，未恢复'); this.resolvePending(owner, loaded, 'plan', input.expectedRevision, input.body, input.expectedFileRevision); return this.view(owner, loaded.record) }
      this.cas(loaded.record, input.expectedRevision); this.editable(loaded.record); this.saved(owner, loaded.record)
      if ((loaded.record.draft.plan?.revision ?? null) !== input.expectedPlanRevision) throw new RequirementError('计划修订已变化，未覆盖')
      if (input.expectedFileRevision !== undefined && input.expectedFileRevision !== (loaded.record.draft.plan?.bodyRevision ?? null)) throw new RequirementError('普通计划保存只能使用已保存摘要；请先明确处理外部文件冲突')
      if (loaded.record.draft.plan) currentPlan(loaded.record.draft)
      await this.authorizeDesignSources(owner, loaded.record)
      const fresh = await this.fresh(owner, true), latest = this.load(fresh, draftId)
      if (latest.digest !== loaded.digest) throw new RequirementError('计划或设计语境在权限核对期间发生变化')
      this.saved(fresh, latest.record)
      this.writePlan(owner, loaded, input.body, undefined, input.expectedFileRevision)
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
      if (loaded.record.draft.predecessor && (!sameRoot(target.root, loaded.record.draft.predecessor.task.root) || target.identity !== loaded.record.targetIdentity)) throw new RequirementError('后继草稿只能关联原任务所在的已核对工程', 'E_DENIED')
      this.predecessorCurrent(current, loaded.record)
      loaded.record.targetIdentity = target.identity
      loaded.record.draft = { ...loaded.record.draft, target: { id: randomUUID(), root: target.root, selectedAt: Date.now() }, revision: randomUUID(), updatedAt: Date.now() }
      this.persist(current, loaded.record, loaded.digest)
      return this.view(current, loaded.record)
    }), current)
  }
  private receipt(record: Record, state: dto.RequirementReceipt['state'], task?: dto.RequirementTask, detail?: string): dto.RequirementReceipt {
    const intent = record.intent
    if (!intent) throw new RequirementError('没有原交接命令')
    return dto.requirementReceiptSchema.parse({ commandId: intent.commandId, draftId: record.draft.id, draftRevision: intent.draftRevision, targetId: intent.targetId, state, ...(task ? { task } : {}),
      files: state === 'created' ? ['task.json', 'prd.md', manifestPath, 'references/requirement.md', ...(intent.plan ? ['plan.md', 'references/plan.md', 'references/requirement-confirmation.json'] : []), ...intent.references.map(referenceTarget), ...(intent.designFiles ?? []).map(designTarget)] : task ? ['task.json'] : [], ...(detail !== undefined ? { detail } : {}), ...(intent.plan ? { planRevision: intent.plan.revision } : {}), ...(intent.confirmed ? { confirmedRevision: intent.confirmed.revision } : {}) })
  }
  private origin(record: Record): dto.RequirementTaskOrigin {
    const intent = record.intent
    if (!intent) throw new RequirementError('没有原交接命令')
    return { version: 1, conversationId: record.draft.conversationId, creatorId: record.draft.creatorId, draftId: record.draft.id, draftRevision: intent.draftRevision, commandId: intent.commandId, bodyRevision: hash(intent.body), manifestRevision: hash(intent.manifest), manifestPath,
      ...(intent.plan && intent.confirmed ? { confirmedRevision: intent.confirmed.revision, sourceDigest: intent.confirmed.sourceDigest, planRevision: intent.plan.revision, planBodyRevision: intent.plan.bodyRevision, planSourceRevision: intent.plan.sourceRevision } : {}), ...(intent.predecessor ? { predecessor: intent.predecessor } : {}) }
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
  private handoffPreflightInput(record: Record, intent: z.infer<typeof intentSchema>): RequirementHandoffPreflight {
    const target = record.draft.target
    if (!target || !record.targetIdentity || !intent.plan || !intent.confirmed) throw new RequirementError('交接预算预检缺少固定材料或目标身份')
    return { version: 1, targetRoot: target.root, targetIdentity: record.targetIdentity, conversationRoot: record.conversationRoot, draftId: record.draft.id, draftRevision: intent.draftRevision, commandId: intent.commandId, taskId: intent.taskId, taskDir: intent.taskDir, requirement: intent.body, plan: intent.plan, confirmed: intent.confirmed, manifest: intent.manifest, references: intent.references, designFiles: intent.designFiles ?? [] }
  }
  private rejectUnstarted(owner: Owner, loaded: Loaded, detail: string, blocked: 'preflight-unavailable' | 'context-changed'): dto.RequirementReceipt {
    const record = loaded.record, intent = record.intent
    if (!intent || intent.started) throw new RequirementError('原交接已越过创建边界，不能解除原命令')
    if (record.rejectedHandoffs.length >= 128) throw new RequirementError('交接回执达到存储上限', 'E_BUSY')
    const receipt = this.receipt(record, 'not-admitted', undefined, detail)
    record.rejectedHandoffs.push({ intent: { ...intent, blocked }, inputDigest: intent.inputDigest, receipt })
    record.intent = undefined; record.draft.handoff = receipt; this.persist(owner, record, loaded.digest)
    return receipt
  }
  private async finish(owner: Owner, loaded: Loaded): Promise<dto.RequirementReceipt> {
    const record = loaded.record, intent = record.intent, target = record.draft.target
    if (!intent || !target) throw new RequirementError('交接意图不存在')
    if (intent.blocked === 'manifest-budget') throw new RequirementError('原交接的完整资料清单超过 64 KiB；原命令与固定输入已保留，未创建任务或截断证据', 'E_BUSY')
    const expectedDesignMaterials = this.designEvidence(intent.designContext, intent.designFiles ?? []).map(({ path, revision, bytes }) => ({ path, revision, bytes }))
    const proofValid = Boolean(intent.preflight && intent.plan && intent.confirmed && record.targetIdentity && intent.preflight.inputDigest === hash(JSON.stringify(this.handoffPreflightInput(record, intent))) && intent.preflight.promptBytes <= intent.preflight.budgetBytes && JSON.stringify(intent.preflight.designMaterials ?? []) === JSON.stringify(expectedDesignMaterials))
    if ((!proofValid || !intent.started && intent.taskDir !== `${dayPrefix()}-${intent.taskId}`) && record.draft.handoff?.state !== 'created') {
      if (intent.started) return this.saveReceipt(owner, loaded, this.receipt(record, 'uncertain', this.task(record), '原交接已越过创建边界但缺少完整上下文预算证明；保留原身份，未继续写入或重新创建'))
      return this.rejectUnstarted(owner, loaded, '未能核实完整上下文预算，任务创建尚未开始；请核对工作流后使用新命令', 'preflight-unavailable')
    }
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
        if (existsSync(join(target.root, '.trellis/tasks', intent.taskDir))) return this.saveReceipt(owner, loaded, this.receipt(record, 'uncertain', undefined, '目标目录已存在且没有原交接证明，未覆盖'))
        if (!this.ports.preflightContext || !intent.preflight) return this.rejectUnstarted(owner, loaded, '原预算预检不可复核；任务创建尚未开始，请重新核对工作流', 'preflight-unavailable')
        const rulesRevision = (): string => {
          const workflow = readRegular(target.root, '.trellis/workflow.md', 1024 * 1024).bytes
          const agents = readOptional(target.root, 'AGENTS.md', 1024 * 1024)?.bytes
          return JSON.stringify([hash(workflow), agents ? hash(agents) : null])
        }
        let rulesBefore: string
        try { rulesBefore = rulesRevision() }
        catch (error) { return this.rejectUnstarted(owner, loaded, `创建前工程规则不可核对，未创建任务：${error instanceof Error ? error.message : '规则不可用'}`.slice(0, 2000), 'context-changed') }
        const capturedDigest = loaded.digest, fixedInput = this.handoffPreflightInput(record, intent)
        let repeated: z.infer<typeof preflightProofSchema>
        try { repeated = preflightProofSchema.parse(await this.ports.preflightContext(structuredClone(fixedInput), owner.assertCurrent)) }
        catch (error) {
          const fresh = await this.fresh(owner, true), latest = this.load(fresh, record.draft.id)
          if (latest.digest !== capturedDigest) throw new RequirementError('预算复核期间原交接已变化，请读取原状态')
          return this.rejectUnstarted(fresh, latest, `创建前预算复核失败，未创建任务：${error instanceof Error ? error.message : '预检不可用'}`.slice(0, 2000), 'context-changed')
        }
        const fresh = await this.fresh(owner, true), latest = this.load(fresh, record.draft.id)
        if (latest.digest !== capturedDigest) throw new RequirementError('预算复核期间原交接已变化，请读取原状态')
        if (JSON.stringify(repeated) !== JSON.stringify(intent.preflight) || repeated.inputDigest !== hash(JSON.stringify(fixedInput)) || repeated.promptBytes > repeated.budgetBytes) return this.rejectUnstarted(fresh, latest, '预检后工作流规则、完整材料或上下文预算已变化；未创建任务，请重新核对', 'context-changed')
        const verifyBoundary = (): void => {
          fresh.assertCurrent()
          if (rulesRevision() !== rulesBefore) throw new RequirementError('工程规则在预算复核后发生变化')
          this.saved(fresh, record); this.confirmationCurrent(record)
          this.predecessorCurrent(fresh, record)
          if (this.view(fresh, record).planFileState !== 'saved' || trellisTarget(target.root).identity !== record.targetIdentity || intent.taskDir !== `${dayPrefix()}-${intent.taskId}`) throw new RequirementError('计划、工程或任务日期已变化')
        }
        try {
          verifyBoundary()
        } catch (error) { return this.rejectUnstarted(fresh, latest, `创建前固定材料已变化，未创建任务：${error instanceof Error ? error.message : '无法核对'}`.slice(0, 2000), 'context-changed') }
        if (existsSync(join(target.root, '.trellis/tasks', intent.taskDir))) return this.saveReceipt(owner, loaded, this.receipt(record, 'uncertain', undefined, '目标目录在预算复核期间出现，未覆盖'))
        intent.started = true
        loaded = this.persist(fresh, record, loaded.digest)
        verifyBoundary()
        const result = createTaskRecordAt(target.root, { dirName: intent.taskId, title: intent.title ?? record.draft.title, description: intent.plan ? '来自本人会话的已确认需求与独立计划；尚未启动工程执行。' : '来自本人会话的已确认需求。', status: 'planning', priority: 'P2', assignee: '', prdContent: intent.body, conversationRequirement: this.origin(record) })
        if (result.ok && result.dirName !== intent.taskDir) {
          intent.taskDir = result.dirName; loaded = this.persist(owner, record, loaded.digest)
          return this.saveReceipt(owner, loaded, this.receipt(record, 'uncertain', undefined, '实际创建目录与预算预检身份不同；保留原任务并停止后续写入'))
        }
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
        ...intent.references.map((reference, index) => { const source = readRegular(record.conversationRoot, reference.snapshotPath, dto.REQUIREMENT_FILE_BYTES); if (hash(source.bytes) !== reference.revision) throw new RequirementError('原资料快照已改变'); return { path: referenceTarget(reference, index), bytes: source.bytes } }),
        ...(intent.designFiles ?? []).map((file, index) => { const source = readRegular(record.conversationRoot, file.snapshotPath, dto.REQUIREMENT_FILE_BYTES); if (source.bytes.length !== file.bytes || hash(source.bytes) !== file.source.revision) throw new RequirementError('原设计资料快照已改变'); return { path: designTarget(file, index), bytes: source.bytes } })]
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
  private async authorizeFrozenHandoff(owner: Owner, record: Record): Promise<dto.RequirementKnowledgeSnapshot[]> {
    const intent = record.intent
    if (!intent || !intent.manifest) throw new RequirementError('原交接清单不可读取')
    const manifest = z.object({ conversationId: id, draftId: id, creatorId: z.string(), draftRevision: id, knowledgeEvidence: z.array(z.unknown()).max(128), knowledgeGrant: dto.requirementKnowledgeGrantSchema.optional(), designGrant: dto.requirementDesignGrantSchema.optional(), designEvidence: z.array(dto.requirementDesignEvidenceSchema).max(16).optional() }).passthrough().parse(JSON.parse(intent.manifest))
    if (manifest.conversationId !== owner.conversation.id || manifest.creatorId !== owner.conversation.creatorId || manifest.draftId !== record.draft.id || manifest.draftRevision !== intent.draftRevision) throw new RequirementError('原交接清单身份不一致', 'E_DENIED')
    const snapshots = manifest.knowledgeEvidence.map(validateRequirementKnowledgeSourceSnapshot)
    const grant = manifest.knowledgeGrant, direct = grant?.version === 2 ? grant.direct : undefined
    if ((snapshots.length || intent.directKnowledge || intent.knowledgeSources?.length) && (!grant || JSON.stringify(grant.sources) !== JSON.stringify(intent.knowledgeSources ?? []) || JSON.stringify(direct) !== JSON.stringify(intent.directKnowledge))) throw new RequirementError('原知识交接缺少可验证的逐条用户选择，不能重新授权', 'E_DENIED')
    const matchesDirect = (source: dto.RequirementKnowledgeSnapshot): boolean => Boolean(direct && JSON.stringify(source.selection) === JSON.stringify(direct.selection) && direct.sources.some(ref => ref.sourceId === source.sourceId && ref.returnedRevision === source.returnedRevision))
    if (grant && (grant.sources.some(ref => !snapshots.some(source => source.sourceId === ref.sourceId && source.returnedRevision === ref.returnedRevision)) || direct?.sources.some(ref => !snapshots.some(source => matchesDirect(source) && source.sourceId === ref.sourceId && source.returnedRevision === ref.returnedRevision)) || snapshots.some(source => !grant.sources.some(ref => ref.sourceId === source.sourceId && ref.returnedRevision === source.returnedRevision) && !matchesDirect(source)))) throw new RequirementError('知识交接清单与用户选择不一致', 'E_DENIED')
    for (const ref of manifest.knowledgeGrant?.sources ?? []) {
      const operation = this.operation(record, ref.operationId)
      if (operation.state !== 'adopted' || !this.sealedKnowledge(owner, record, operation).some(value => value.sourceId === ref.sourceId && value.returnedRevision === ref.returnedRevision && snapshots.some(source => JSON.stringify(source) === JSON.stringify(value)))) throw new RequirementError('知识交接来源不属于原已采用操作', 'E_DENIED')
    }
    const designFiles = intent.designFiles ?? [], expectedDesign = this.designEvidence(intent.designContext, designFiles)
    if (designFiles.length && (!manifest.designGrant || JSON.stringify(manifest.designGrant.sources) !== JSON.stringify(intent.designSources) || JSON.stringify(manifest.designEvidence) !== JSON.stringify(expectedDesign))) throw new RequirementError('设计文件交接授权或固定清单不一致', 'E_DENIED')
    if (!designFiles.length && ((manifest.designGrant?.sources.length ?? 0) || (manifest.designEvidence?.length ?? 0))) throw new RequirementError('设计文件交接缺少原固定快照', 'E_DENIED')
    await this.authorizeKnowledge(owner, snapshots)
    await this.authorizeDesignFiles(owner, record.conversationRoot, designFiles)
    return snapshots
  }
  private verifyHandoffFiles(owner: Owner, record: Record): void {
    const intent = record.intent, task = this.task(record)
    if (!intent || !task || trellisTarget(task.root).identity !== record.targetIdentity) throw new RequirementError('原交接任务或工程身份已变化', 'E_DENIED')
    owner.assertCurrent()
    if (hash(readRegular(task.root, `.trellis/tasks/${task.taskDir}/${manifestPath}`, 64 * 1024).bytes) !== hash(intent.manifest)) throw new RequirementError('原交接清单已变化', 'E_DENIED')
    for (const [index, reference] of intent.references.entries()) {
      if (hash(readRegular(record.conversationRoot, reference.snapshotPath, dto.REQUIREMENT_FILE_BYTES).bytes) !== reference.revision || hash(readRegular(task.root, `.trellis/tasks/${task.taskDir}/${referenceTarget(reference, index)}`, dto.REQUIREMENT_FILE_BYTES).bytes) !== reference.revision) throw new RequirementError('交接文件版本已变化', 'E_DENIED')
    }
    for (const [index, file] of (intent.designFiles ?? []).entries()) {
      const source = readRegular(record.conversationRoot, file.snapshotPath, dto.REQUIREMENT_FILE_BYTES).bytes
      const handed = readRegular(task.root, `.trellis/tasks/${task.taskDir}/${designTarget(file, index)}`, dto.REQUIREMENT_FILE_BYTES).bytes
      if (source.length !== file.bytes || handed.length !== file.bytes || hash(source) !== file.source.revision || hash(handed) !== file.source.revision) throw new RequirementError('交接设计文件版本已变化', 'E_DENIED')
    }
    owner.assertCurrent()
  }
  /** Recheck original task identity, fixed manifest and live access before workflow consumption. */
  async authorizeHandoffKnowledge(conversationId: string, draftId: string, current: () => void): Promise<dto.RequirementKnowledgeSnapshot[]> {
    return this.documents.run(current, () => this.serial(conversationId, async () => {
      const owner = await this.owner(conversationId), loaded = this.load(owner, draftId), record = loaded.record
      if (record.draft.handoff?.state !== 'created' || !record.intent || !record.targetIdentity) throw new RequirementError('原任务交接尚未确认')
      this.verifyHandoffFiles(owner, record)
      const snapshots = await this.authorizeFrozenHandoff(owner, record)
      await this.authorizeFiles(owner, record.intent.references)
      const fresh = await this.fresh(owner), latest = this.load(fresh, draftId)
      if (latest.digest !== loaded.digest) throw new RequirementError('交接材料在授权期间发生变化')
      this.verifyHandoffFiles(fresh, latest.record)
      return snapshots
    }))
  }
  commit(conversationId: string, draftId: string, raw: unknown, current?: () => void): Promise<RequirementResult<dto.RequirementReceipt>> {
    return this.result(() => this.serial(conversationId, async () => {
      const input = dto.requirementCommitSchema.parse(raw), owner = await this.owner(conversationId, true)
      let loaded = this.load(owner, draftId)
      const record = loaded.record, target = record.draft.target
      const rejected = record.rejectedHandoffs.find(value => value.intent.commandId === input.commandId)
      if (rejected) {
        if (rejected.intent.draftRevision !== input.expectedRevision || rejected.intent.targetId !== input.targetId || rejected.intent.plan?.revision !== input.expectedPlanRevision || rejected.inputDigest && rejected.inputDigest !== hash(JSON.stringify(input))) throw new RequirementError('原交接命令不能用于不同输入')
        return rejected.receipt
      }
      if (!target || target.id !== input.targetId) throw new RequirementError('请选择已核对的原 Trellis 目标')
      if (record.intent) {
        if (record.intent.commandId !== input.commandId || record.intent.inputDigest && record.intent.inputDigest !== hash(JSON.stringify(input)) || record.intent.draftRevision !== input.expectedRevision || record.intent.targetId !== input.targetId || record.intent.plan && record.intent.plan.revision !== input.expectedPlanRevision) throw new RequirementError('需求已经绑定原交接命令和计划版本，请打开原任务；不会重新创建')
        await this.authorizeFrozenHandoff(owner, record)
        await this.authorizeFiles(owner, record.intent.references)
        const fresh = await this.fresh(owner, true), latest = this.load(fresh, draftId)
        if (latest.digest !== loaded.digest) throw new RequirementError('原交接在授权期间发生变化')
        if (record.draft.handoff?.state === 'created') this.verifyHandoffFiles(fresh, latest.record)
        return this.finish(owner, loaded)
      }
      this.cas(record, input.expectedRevision)
      this.saved(owner, record)
      this.predecessorCurrent(owner, record)
      const confirmed = this.confirmationCurrent(record), plan = currentPlan(record.draft)
      const selectedDesign = input.designSources ?? [], designFiles = record.draft.designContextFiles
      if (selectedDesign.length !== designFiles.length || designFiles.some(file => !selectedDesign.some(source => JSON.stringify(source) === JSON.stringify(file.source)))) throw new RequirementError('请明确选择全部已确认的设计文件；不交接的文件请先从设计语境移除并重新确认', 'E_INVALID_ARG')
      await this.authorizeDesignSources(owner, record)
      if (!dto.hasRequirementContent(record.draft.body) || !plan.body.trim() || this.view(owner, record).planFileState !== 'saved') throw new RequirementError('请先保存完整的实际需求与独立计划')
      if (plan.revision !== input.expectedPlanRevision) throw new RequirementError('计划版本已经变化，未交接不同计划')
      if (trellisTarget(target.root).identity !== record.targetIdentity) throw new RequirementError('原目标工程已变化')
      for (const reference of record.draft.references) if (hash(readRegular(record.conversationRoot, reference.snapshotPath, dto.REQUIREMENT_FILE_BYTES).bytes) !== reference.revision) throw new RequirementError('所选资料快照已变化')
      const taskId = `requirement-${draftId}`
      if (input.knowledgeOperationIds?.length) throw new RequirementError('请逐条明确选择要交接的知识摘录，而不是按历史操作全选', 'E_INVALID_ARG')
      const intent: z.infer<typeof intentSchema> = { commandId: input.commandId, inputDigest: hash(JSON.stringify(input)), knowledgeSources: input.knowledgeSources, directKnowledge: input.directKnowledge, designSources: designFiles.map(file => file.source), designContext: record.draft.designContext, designFiles: structuredClone(designFiles), predecessor: record.draft.predecessor, draftRevision: input.expectedRevision, targetId: input.targetId, taskId, taskDir: `${dayPrefix()}-${taskId}`, started: false, title: record.draft.title, body: record.draft.body, manifest: '', references: record.draft.references, plan: { ...plan }, confirmed: { ...confirmed } }
      const preserveHandoffFailure = (blocked: NonNullable<z.infer<typeof intentSchema>['blocked']>, detail: string, retainedManifest = ''): dto.RequirementReceipt => {
        if (record.rejectedHandoffs.length >= 128) throw new RequirementError('交接回执达到存储上限', 'E_BUSY')
        record.intent = { ...intent, manifest: retainedManifest, blocked }
        const receipt = this.receipt(record, 'not-admitted', undefined, detail)
        record.rejectedHandoffs.push({ intent: record.intent, inputDigest: hash(JSON.stringify(input)), receipt })
        record.intent = undefined
        record.draft.handoff = receipt
        this.persist(owner, record, loaded.digest)
        return receipt
      }
      const preserveBudgetFailure = (): dto.RequirementReceipt => preserveHandoffFailure('manifest-budget', '完整资料清单超过 64 KiB；未创建任务，请调整资料并使用新命令')
      const knowledgeByVersion = new Map<string, dto.RequirementKnowledgeSnapshot>()
      const allAdopted = record.draft.operations.filter(operation => operation.state === 'adopted')
      const chosen = input.knowledgeSources ?? []
      if (chosen.some(value => !allAdopted.some(operation => operation.id === value.operationId))) throw new RequirementError('交接来源必须属于已采用的原操作', 'E_INVALID_ARG')
      for (const operation of allAdopted.filter(value => chosen.some(source => source.operationId === value.id))) {
        const selected = chosen.filter(value => value.operationId === operation.id), sealed = this.sealedKnowledge(owner, record, operation)
        for (const ref of selected) {
          const source = sealed.find(value => value.sourceId === ref.sourceId && value.returnedRevision === ref.returnedRevision)
          if (!source) throw new RequirementError('所选摘录不属于原操作固定来源', 'E_DENIED')
          const key = JSON.stringify([source.selection.connectionId, source.sourceId, source.returnedRevision])
          if (!knowledgeByVersion.has(key)) knowledgeByVersion.set(key, source)
        }
        if (Buffer.byteLength(JSON.stringify([...knowledgeByVersion.values()])) > 64 * 1024) return preserveBudgetFailure()
      }
      if (input.directKnowledge) {
        let direct: dto.RequirementKnowledgeSnapshot[]
        try { direct = (await this.resolveKnowledge(owner, input.directKnowledge.selection, input.directKnowledge.sources)).map(validateRequirementKnowledgeSourceSnapshot) }
        catch (error) { throw new RequirementError(`直接交接摘录无法核实，请重新检索并选择：${error instanceof Error ? error.message : '原来源不可用'}`, 'E_DENIED') }
        for (const source of direct) {
          const key = JSON.stringify([source.selection.connectionId, source.sourceId, source.returnedRevision])
          const existing = knowledgeByVersion.get(key)
          if (existing && JSON.stringify(existing) !== JSON.stringify(source)) throw new RequirementError('同一知识摘录的固定内容不一致', 'E_DENIED')
          knowledgeByVersion.set(key, source)
        }
        if (Buffer.byteLength(JSON.stringify([...knowledgeByVersion.values()])) > 64 * 1024) return preserveBudgetFailure()
      }
      if (knowledgeByVersion.size > 128) throw new RequirementError('交接摘录超过 128 项，请减少选择后重试', 'E_BUSY')
      await this.authorizeKnowledge(owner, [...knowledgeByVersion.values()])
      await this.authorizeFiles(owner, record.draft.references)
      await this.authorizeDesignFiles(owner, record.conversationRoot, designFiles)
      const fresh = await this.fresh(owner, true), latest = this.load(fresh, draftId)
      if (latest.digest !== loaded.digest) throw new RequirementError('需求或来源在授权期间发生变化')
      this.saved(fresh, latest.record)
      this.confirmationCurrent(latest.record)
      for (const operation of latest.record.draft.operations.filter(value => chosen.some(source => source.operationId === value.id))) {
        const sealed = this.sealedKnowledge(fresh, latest.record, operation)
        for (const ref of chosen.filter(value => value.operationId === operation.id)) if (!sealed.some(value => value.sourceId === ref.sourceId && value.returnedRevision === ref.returnedRevision && JSON.stringify(value) === JSON.stringify(knowledgeByVersion.get(JSON.stringify([value.selection.connectionId, value.sourceId, value.returnedRevision]))))) throw new RequirementError('知识摘录在授权期间发生变化')
      }
      if (this.view(fresh, latest.record).planFileState !== 'saved' || trellisTarget(target.root).identity !== record.targetIdentity) throw new RequirementError('计划或目标在授权期间发生变化')
      const manifest = JSON.stringify({ version: 2, conversationId, creatorId: record.draft.creatorId, draftId, draftRevision: record.draft.revision, bodyRevision: record.draft.bodyRevision, sourcePath: record.draft.relativePath, predecessor: record.draft.predecessor,
        confirmed, plan: { revision: plan.revision, bodyRevision: plan.bodyRevision, sourceRevision: plan.sourceRevision, sourceDigest: plan.sourceDigest, path: 'plan.md' },
        knowledgeEvidence: [...knowledgeByVersion.values()], knowledgeGrant: dto.requirementKnowledgeGrantSchema.parse({ version: 2, sources: chosen, ...(input.directKnowledge ? { direct: input.directKnowledge } : {}) }),
        designGrant: dto.requirementDesignGrantSchema.parse({ version: 1, sources: designFiles.map(file => file.source) }), designEvidence: this.designEvidence(record.draft.designContext, designFiles),
        operations: allAdopted.map(operation => ({ id: operation.id, commandId: operation.commandId, action: operation.action, document: operation.document, sourceRevision: operation.sourceRevision, sourceDigest: operation.sourceDigest, sourceFileRevision: operation.sourceFileRevision,
          candidateRevision: operation.candidateRevision, candidateBodyRevision: operation.candidateBodyRevision, selectionReceipt: operation.selectionReceipt, requestId: operation.requestId, sessionId: operation.sessionId, connectionGeneration: operation.connectionGeneration, turnId: operation.turnId, knowledgeSelection: chosen.some(value => value.operationId === operation.id) ? operation.knowledgeSelection : undefined, knowledge: operation.knowledge.filter(source => chosen.some(value => value.operationId === operation.id && value.sourceId === source.sourceId && value.returnedRevision === source.returnedRevision)) })),
        references: record.draft.references.map((reference, index) => ({ fileId: reference.fileId, revision: reference.revision, name: reference.name, originalPath: reference.relativePath, path: referenceTarget(reference, index), bytes: reference.bytes })) })
      if (Buffer.byteLength(manifest) > 64 * 1024) return preserveBudgetFailure()
      const preflightInput = this.handoffPreflightInput(record, { ...intent, manifest })
      if (!this.ports.preflightContext) return preserveHandoffFailure('preflight-unavailable', '尚无法按实际工作流核实完整材料与规范的上下文预算；未创建任务，请完成工作流配置后使用新命令', manifest)
      let preflight: z.infer<typeof preflightProofSchema>
      try { preflight = preflightProofSchema.parse(await this.ports.preflightContext(preflightInput, owner.assertCurrent)) }
      catch (error) { owner.assertCurrent(); return preserveHandoffFailure('preflight-unavailable', `完整上下文预算未能核实；未创建任务：${error instanceof Error ? error.message : '预检不可用'}`.slice(0, 2000), manifest) }
      if (preflight.inputDigest !== hash(JSON.stringify(preflightInput)) || preflight.promptBytes > preflight.budgetBytes) return preserveHandoffFailure('context-budget', '完整材料、规范与执行上下文超限或预检身份不一致；未创建任务，请调整后使用新命令', manifest)
      const expectedDesignMaterials = this.designEvidence(intent.designContext, designFiles).map(({ path, revision, bytes }) => ({ path, revision, bytes }))
      if (JSON.stringify(preflight.designMaterials ?? []) !== JSON.stringify(expectedDesignMaterials)) return preserveHandoffFailure('preflight-unavailable', '预检尚未证明全部设计文件已按实际工作流完整计入预算；未创建任务', manifest)
      await this.authorizeKnowledge(owner, [...knowledgeByVersion.values()])
      await this.authorizeFiles(owner, intent.references)
      await this.authorizeDesignFiles(owner, record.conversationRoot, designFiles)
      const verified = await this.fresh(owner, true), checked = this.load(verified, draftId)
      if (checked.digest !== loaded.digest) throw new RequirementError('预算预检期间需求发生变化，未创建任务')
      this.saved(verified, checked.record); this.confirmationCurrent(checked.record)
      if (this.view(verified, checked.record).planFileState !== 'saved' || trellisTarget(target.root).identity !== record.targetIdentity) throw new RequirementError('预算预检期间计划或工程发生变化，未创建任务')
      record.intent = { ...intent, manifest, preflight }
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
      const owner = await this.owner(conversationId, true), loaded = this.load(owner, draftId), record = loaded.record
      if (record.draft.handoff?.state !== 'created' || !record.targetIdentity) throw new RequirementError('请先完成原需求与计划的任务交接')
      const task = this.task(record)
      if (!task) throw new RequirementError('原任务当前不可读取，请到原工程核对')
      const predecessor = record.intent?.predecessor
      let authorizePredecessor: (() => Promise<RequirementPredecessorReleaseProof>) | undefined
      if (predecessor) {
        const verifyPredecessorRelease = this.ports.verifyPredecessorRelease
        if (!verifyPredecessorRelease) throw new RequirementError('原任务释放证明不可用；未准备或启动后继执行', 'E_BUSY')
        if (JSON.stringify(record.draft.predecessor) !== JSON.stringify(predecessor)) throw new RequirementError('后继来源身份不一致', 'E_DENIED')
        const expectedOrigin = JSON.stringify(this.origin(record))
        const observe = async (): Promise<RequirementPredecessorReleaseProof> => {
          owner.assertCurrent()
          const before = this.load(owner, draftId)
          if (JSON.stringify(this.origin(before.record)) !== expectedOrigin || before.record.draft.handoff?.state !== 'created') throw new RequirementError('后继任务来源已变化', 'E_DENIED')
          this.predecessorCurrent(owner, before.record)
          const proof = await verifyPredecessorRelease(predecessor, owner.assertCurrent)
          const fresh = await this.fresh(owner, true), after = this.load(fresh, draftId)
          if (JSON.stringify(proof.predecessor) !== JSON.stringify(predecessor) || after.digest !== before.digest || JSON.stringify(this.origin(after.record)) !== expectedOrigin) throw new RequirementError('原任务释放证明或后继来源在核对期间发生变化', 'E_DENIED')
          this.predecessorCurrent(fresh, after.record)
          return proof
        }
        const initial = await observe()
        authorizePredecessor = async () => {
          const proof = await observe()
          if (JSON.stringify(proof) !== JSON.stringify(initial)) throw new RequirementError('原任务释放证据已变化，请重新核对后继执行', 'E_BUSY')
          return proof
        }
      }
      owner.assertCurrent()
      return { conversationId, creatorId: owner.conversation.creatorId, task, origin: this.origin(record), targetIdentity: record.targetIdentity, assertCurrent: owner.assertCurrent, ...(authorizePredecessor ? { authorizePredecessor } : {}) }
    })
  }
}
