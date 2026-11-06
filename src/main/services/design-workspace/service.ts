import { z } from 'zod'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import * as dto from '../../../shared/design-workspace'
import { buildDesignGenerationPrompt, DESIGN_PLACEHOLDER_BASE_REVISION, DESIGN_PLACEHOLDER_DOCUMENT_ID } from '../../../shared/design-generation'
import type { TimelineEvent } from '../../../shared/types'
import type { ConversationRead, ConversationSend } from '../../../shared/private-conversations'
import { IpcErrorCode } from '../../../shared/ipc-errors'
import { checkedDirectory, directoryIdentity, hash, pathKey, readRegular } from '../private-conversations/files'
import { saveSelectedFile } from '../private-conversations/files'
import { zipSync, strToU8 } from 'fflate'
import { buildDesignPrototype } from '../../../shared/design-prototype'
import { writeRevision } from '../private-conversations/requirement-files'
import { DesignStorage, defaultFrames, makeSnapshot } from './storage'
import { assertGenerationCurrent, assertPageHtml, generationEvents, readGeneration } from './source'
import {
  designIntentSchema, designRecordSchema, designRequestSchema, designScanSchema, DesignWorkspaceError,
  type DesignIntent, type DesignOwner, type DesignPorts, type DesignRecord, type DesignRequest, type DesignSnapshot
} from './types'

type Loaded = { record: DesignRecord; digest: string; owner: DesignOwner; current(): void }
const noop = (): void => {}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export class DesignWorkspace {
  private readonly storage: DesignStorage
  private lane: Promise<void> = Promise.resolve()
  private closing = false
  private scanned = new Map<string, { at: number; updatedAt: number }>()
  constructor(private readonly ports: DesignPorts) {
    this.storage = new DesignStorage(ports.directory)
    ports.conversations.setDesignHooks({ prepareSend: (id, input, current) => this.prepareSend(id, input, current), hasConversation: id => this.hasConversation(id) })
  }
  private async serial<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.lane
    let release: () => void = noop
    this.lane = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      if (this.closing) throw new DesignWorkspaceError('应用正在退出，请稍后重试', IpcErrorCode.Busy)
      return await action()
    } finally { release() }
  }
  async dispose(): Promise<void> { this.closing = true; await this.lane }
  private async owner(conversationId: string, writable: boolean, current: () => void): Promise<DesignOwner> {
    current()
    const original = await this.ports.conversations.workspaceAccess(conversationId, writable)
    const owner = { ...original, assertCurrent: (): void => {
      if (this.closing) throw new DesignWorkspaceError('应用正在退出，原设计已保留', IpcErrorCode.Busy)
      current(); original.assertCurrent()
    } }
    current(); owner.assertCurrent()
    return owner
  }
  private managed(documentId: string, current: () => void): { record: DesignRecord; digest: string } {
    z.string().uuid().parse(documentId)
    if (this.closing) throw new DesignWorkspaceError('应用正在退出，设计和原操作已保留', IpcErrorCode.Busy)
    current()
    const row = this.storage.read(`documents/${documentId}.json`, designRecordSchema)
    if (!row) throw new DesignWorkspaceError('设计不存在，请从原会话重新同步', IpcErrorCode.NotFound)
    if (row.value.id !== documentId || row.value.creatorId !== this.ports.conversations.creatorIdentity()) throw new DesignWorkspaceError('设计不属于当前本机创建者', IpcErrorCode.Denied)
    return { record: row.value, digest: row.digest }
  }
  private matchOwner(record: DesignRecord, owner: DesignOwner): void {
    if (record.sourceIdentity !== owner.sourceIdentity || record.creatorId !== owner.conversation.creatorId || pathKey(record.conversationRoot) !== pathKey(owner.conversation.workspace.root) || record.rootIdentity !== directoryIdentity(owner.conversation.workspace.root) || record.nativeSessionId !== owner.conversation.nativeRef?.sessionId) throw new DesignWorkspaceError('设计来源、目录或原生会话身份已改变', IpcErrorCode.Denied)
  }
  private async load(documentId: string, writable: boolean, current: () => void): Promise<Loaded> {
    const { record, digest } = this.managed(documentId, current)
    const owner = await this.owner(record.conversationId, writable, current)
    this.matchOwner(record, owner)
    const assertCurrent = (): void => { current(); owner.assertCurrent() }
    for (const source of record.sources) assertGenerationCurrent(owner, source)
    assertCurrent()
    return { record, digest, owner, current: assertCurrent }
  }
  private async sourceStatus(record: DesignRecord, current: () => void): Promise<{ readOnly?: boolean; sourceError?: string }> {
    try {
      const owner = await this.owner(record.conversationId, false, current)
      this.matchOwner(record, owner); owner.assertCurrent()
      for (const source of record.sources) assertGenerationCurrent(owner, source)
      if (owner.conversation.archivedAt !== undefined) return { readOnly: true, sourceError: '来源会话已归档，请恢复后继续编辑。' }
      return {}
    } catch (error) { current(); return { readOnly: true, sourceError: sourceMessage(error) } }
  }
  private persist(loaded: Loaded): void {
    loaded.current()
    this.storage.write(`documents/${loaded.record.id}.json`, designRecordSchema, loaded.record, loaded.digest, loaded.current)
  }
  private view(record: DesignRecord, selectedRevision = record.currentRevision): dto.DesignDocument {
    const snapshot = this.storage.snapshot(record.id, selectedRevision)
    return dto.designDocumentSchema.parse({
      id: record.id, conversationId: record.conversationId, updatedAt: record.updatedAt,
      pageCount: snapshot.pages.length, ...snapshot,
      candidates: record.candidates.map(candidate => ({ ...candidate, ...this.storage.snapshot(record.id, candidate.revision) })),
      history: record.history.filter(item => item.revision !== selectedRevision).map(item => ({ ...item, ...this.storage.snapshot(record.id, item.revision) }))
    })
  }
  private summary(record: DesignRecord): dto.DesignSummary {
    const value = this.storage.snapshot(record.id, record.currentRevision)
    return dto.designSummarySchema.parse({ id: record.id, title: value.title, conversationId: record.conversationId, updatedAt: record.updatedAt, pageCount: value.pages.length, revision: value.revision })
  }
  async get(raw: unknown, current: () => void = noop): Promise<dto.DesignDocument> {
    const input = dto.designGetSchema.parse(raw), loaded = this.managed(input.documentId, current)
    const status = await this.sourceStatus(loaded.record, current)
    const value = { ...this.view(loaded.record), ...status }; current(); return value
  }
  /** Read verified saved cards without waiting for native history synchronization. */
  async listConversation(raw: unknown, current: () => void = noop): Promise<dto.DesignConversationSummary[]> {
    const input = dto.designSyncSchema.parse(raw), owner = await this.owner(input.conversationId, false, current)
    const result: dto.DesignConversationSummary[] = []
    for (const id of this.storage.ids('documents')) {
      const row = this.storage.read(`documents/${id}.json`, designRecordSchema)
      if (row?.value.conversationId !== input.conversationId || row.value.creatorId !== owner.conversation.creatorId) continue
      const { record } = this.managed(id, current)
      for (const candidate of record.candidates) this.storage.snapshot(record.id, candidate.revision)
      const status = await this.sourceStatus(record, current)
      result.push(dto.designConversationSummarySchema.parse({ ...this.summary(record), ...status, candidates: record.candidates.map(candidate => ({ id: candidate.id })) }))
      current(); owner.assertCurrent()
    }
    current(); owner.assertCurrent()
    return result
  }
  async list(current: () => void = noop): Promise<dto.DesignLibrary> {
    current()
    const conversations = await this.ports.conversations.list({ archive: 'active' })
    current()
    let incomplete = false
    const related = new Set<string>()
    for (const id of this.storage.ids('documents')) {
      try { const row = this.storage.read(`documents/${id}.json`, designRecordSchema); if (row?.value.creatorId === this.ports.conversations.creatorIdentity()) related.add(row.value.conversationId) }
      catch (error) { current(); if (!recoverableSourceError(error)) throw error; incomplete = true }
    }
    // The authorized private catalog is the recovery inventory for completed output.
    for (const conversation of conversations) {
      if (conversation.nativeRef?.agentId !== 'pi') continue
      const previous = this.scanned.get(conversation.id)
      if (previous && previous.updatedAt === conversation.updatedAt && Date.now() - previous.at < 60_000) continue
      try { await this.sync({ conversationId: conversation.id }, current, true); this.scanned.set(conversation.id, { at: Date.now(), updatedAt: conversation.updatedAt }) }
      catch (error) {
        current()
        if (error instanceof z.ZodError) throw error
        if (related.has(conversation.id) || this.hasConversation(conversation.id)) incomplete = true
      }
    }
    const result: dto.DesignSummary[] = []
    for (const id of this.storage.ids('documents')) {
      try { const loaded = this.managed(id, current); result.push({ ...this.summary(loaded.record), ...await this.sourceStatus(loaded.record, current) }); current() }
      catch (error) { current(); if (!recoverableSourceError(error)) throw error; incomplete = true }
    }
    current()
    return { items: result.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)), incomplete }
  }
  async sync(raw: unknown, current: () => void = noop, metadataOnly = false): Promise<dto.DesignDocument[]> {
    const input = dto.designSyncSchema.parse(raw)
    return this.serial(async () => {
      const owner = await this.owner(input.conversationId, true, current)
      const scanPath = `scans/${input.conversationId}.json`, previousScan = this.storage.read(scanPath, designScanSchema)
      if (previousScan && (previousScan.value.sourceIdentity !== owner.sourceIdentity || previousScan.value.conversationId !== input.conversationId || previousScan.value.nativeSessionId !== owner.conversation.nativeRef?.sessionId)) throw new DesignWorkspaceError('原设计扫描来源已变化，未读取替代会话', IpcErrorCode.Denied)
      // Earlier versions permanently skipped rejected placeholder events. Revisit
      // that bounded history once; subsequent scans keep their normal cursor.
      const revisitRejected = Boolean(previousScan?.value.rejectedEvents.length && previousScan.value.placeholderRecoveryVersion !== 2)
      const scan = await generationEvents(this.ports.conversations, owner, current, revisitRejected ? undefined : previousScan?.value.afterCursor)
      let completeEvents: TimelineEvent[] | undefined = revisitRejected || !previousScan?.value.afterCursor ? scan.events : undefined
      const intent = this.storage.read(`conversations/${input.conversationId}.json`, designIntentSchema)?.value
      if (intent) this.assertIntent(owner, intent)
      const rejectedEvents = [...previousScan?.value.rejectedEvents ?? []]
      let rejected: DesignWorkspaceError | undefined
      const reject = (eventId: string, message: string): void => {
        if (!rejectedEvents.includes(eventId)) {
          if (rejectedEvents.length >= 256) throw new DesignWorkspaceError('设计输出核对记录已达上限；既有设计仍可阅读', IpcErrorCode.Busy)
          rejectedEvents.push(eventId)
        }
        rejected ??= new DesignWorkspaceError(message, IpcErrorCode.InvalidArg)
      }
      const changed = new Set<string>()
      for (const event of scan.events) {
        current(); owner.assertCurrent()
        const wasRejected = rejectedEvents.includes(event.id)
        const payload = object(event.payload), rawOutput = object(payload.rawOutput), details = object(rawOutput.details)
        const possiblePlaceholder = object(details.designOutput).documentId === DESIGN_PLACEHOLDER_DOCUMENT_ID || details.placeholderIdentity === true
        if (wasRejected && !possiblePlaceholder) continue
        const generated = readGeneration(owner, event)
        if (!generated) continue
        const legacyPlaceholder = generated.source.output.documentId === DESIGN_PLACEHOLDER_DOCUMENT_ID && generated.baseRevision === DESIGN_PLACEHOLDER_BASE_REVISION
        if (wasRejected && !legacyPlaceholder && !generated.placeholderIdentity) continue
        let documentId = legacyPlaceholder ? generated.source.output.revisionId : generated.source.output.documentId
        let baseRevision = legacyPlaceholder ? undefined : generated.baseRevision
        // A design turn is anchored by the sent user event and its retained request.
        // An incremental page may start after that event, so retrieve the complete
        // bounded history only when the event is not in the current page.
        let requestEvents = completeEvents ?? scan.events
        if (!completeEvents && !requestEvents.some(candidate => this.isGenerationUserEvent(owner, event, candidate))) {
          completeEvents = (await generationEvents(this.ports.conversations, owner, current)).events
          requestEvents = completeEvents
        }
        const request = this.generationRequest(owner, event, requestEvents, Boolean(intent || legacyPlaceholder || generated.placeholderIdentity))
        if (request) {
          const editing = Boolean(request.documentId || request.baseRevision)
          if (editing ? !request.documentId || !request.baseRevision || legacyPlaceholder || generated.placeholderIdentity || request.documentId !== documentId || request.baseRevision !== baseRevision
            : baseRevision !== undefined || Boolean(intent?.documentId && intent.documentId !== documentId)) {
            reject(event.id, '设计身份与原请求不符；原输出已保留，请重新生成')
            continue
          }
        } else if (legacyPlaceholder || generated.placeholderIdentity) {
          reject(event.id, '设计身份与原请求不符；原输出已保留，请重新生成')
          continue
        }
        const accept = (): void => { const index = rejectedEvents.indexOf(event.id); if (index >= 0) rejectedEvents.splice(index, 1) }
        const path = `documents/${documentId}.json`
        const existing = this.storage.read(path, designRecordSchema)
        if (!existing) {
          if (baseRevision !== undefined) { reject(event.id, '修改候选缺少原设计；原输出已保留，未误登记为新稿'); continue }
          const snapshot = makeSnapshot(generated.source.output.title, generated.pages, defaultFrames(generated.pages))
          const assertCurrent = (): void => { current(); owner.assertCurrent(); assertGenerationCurrent(owner, generated.source) }
          this.storage.saveSnapshot(documentId, snapshot, assertCurrent)
          const record: DesignRecord = {
            version: 1, id: documentId, creatorId: owner.conversation.creatorId, conversationId: input.conversationId,
            sourceIdentity: owner.sourceIdentity, conversationRoot: owner.conversation.workspace.root, rootIdentity: directoryIdentity(owner.conversation.workspace.root),
            nativeSessionId: generated.source.sessionId, currentRevision: snapshot.revision, updatedAt: event.ts,
            history: [{ revision: snapshot.revision, createdAt: event.ts, reason: 'generated' }], candidates: [], sources: [generated.source], receipts: []
          }
          this.storage.write(path, designRecordSchema, record, null, assertCurrent)
          this.bindIntent(owner, documentId, assertCurrent)
          accept(); changed.add(documentId)
          continue
        }
        const loaded = await this.load(documentId, true, current)
        if (loaded.record.conversationId !== input.conversationId) throw new DesignWorkspaceError('同名或同身份设计不能转移到另一个会话', IpcErrorCode.Denied)
        const known = loaded.record.sources.find(source => source.output.revisionId === generated.source.output.revisionId)
        if (known) {
          const identity = (source: typeof known): string => JSON.stringify({ ...source, output: { ...source.output, title: undefined } })
          if (identity(known) !== identity(generated.source)) throw new DesignWorkspaceError('已登记工具修订的身份已改变', IpcErrorCode.Denied)
          this.bindIntent(loaded.owner, documentId, loaded.current)
          accept(); changed.add(documentId); continue
        }
        if (!generated.baseRevision || !loaded.record.history.some(item => item.revision === generated.baseRevision)) { reject(event.id, '设计修改没有可核对的基础修订；原稿已保留，请重新生成候选'); continue }
        if (loaded.record.candidates.length >= 16 || loaded.record.sources.length >= 256) throw new DesignWorkspaceError('设计候选或生成记录已达上限，请处理候选后重试', IpcErrorCode.Busy)
        const base = this.storage.snapshot(documentId, generated.baseRevision)
        const replacements = new Map(generated.pages.map(page => [page.id, page]))
        const pages = dto.designPagesSchema.parse([...base.pages.map(page => replacements.get(page.id) ?? page), ...generated.pages.filter(page => !base.pages.some(original => original.id === page.id))])
        const snapshot = makeSnapshot(generated.source.output.title, pages, defaultFrames(pages, base.frames))
        const assertCurrent = (): void => { loaded.current(); assertGenerationCurrent(loaded.owner, generated.source) }
        this.storage.saveSnapshot(documentId, snapshot, assertCurrent)
        loaded.record.candidates.push({ id: generated.source.output.revisionId, baseRevision: generated.baseRevision, revision: snapshot.revision, createdAt: event.ts })
        loaded.record.sources.push(generated.source)
        loaded.record.updatedAt = Math.max(loaded.record.updatedAt, event.ts)
        this.persist({ ...loaded, current: assertCurrent }); changed.add(documentId)
      }
      // Include unchanged documents so reopening an already-synced conversation
      // resolves the same document identity without replaying the generation.
      for (const id of this.storage.ids('documents')) {
        const row = this.storage.read(`documents/${id}.json`, designRecordSchema)
        if (row?.value.conversationId === input.conversationId && row.value.creatorId === owner.conversation.creatorId) changed.add(id)
      }
      const result: dto.DesignDocument[] = []
      if (!metadataOnly) for (const id of changed) { const loaded = this.managed(id, current); result.push({ ...this.view(loaded.record), ...await this.sourceStatus(loaded.record, current) }) }
      if (owner.conversation.nativeRef?.agentId === 'pi') {
        const value = { version: 1 as const, conversationId: input.conversationId, sourceIdentity: owner.sourceIdentity, nativeSessionId: owner.conversation.nativeRef.sessionId, afterCursor: scan.afterCursor, rejectedEvents, placeholderRecoveryVersion: 2 as const }
        if (JSON.stringify(previousScan?.value) !== JSON.stringify(value)) this.storage.write(scanPath, designScanSchema, value, previousScan?.digest ?? null, () => { current(); owner.assertCurrent() })
      }
      current(); owner.assertCurrent()
      if (rejected) throw rejected
      return result
    })
  }
  private isGenerationUserEvent(owner: DesignOwner, event: TimelineEvent, candidate: TimelineEvent): boolean {
    const payload = object(candidate.payload), identity = object(payload.privateConversation)
    return candidate.source === 'pi' && candidate.kind === 'message' && payload.role === 'user' &&
      candidate.sessionId === event.sessionId && candidate.turnId === event.turnId &&
      candidate.connectionGeneration === event.connectionGeneration && pathKey(candidate.projectRoot) === pathKey(event.projectRoot) &&
      identity.id === owner.conversation.id && identity.creatorId === owner.conversation.creatorId
  }
  private generationRequest(owner: DesignOwner, event: TimelineEvent, events: TimelineEvent[], required: boolean): DesignRequest | undefined {
    const matches = events.filter(candidate => this.isGenerationUserEvent(owner, event, candidate))
    if (!matches.length) {
      if (required) throw new DesignWorkspaceError('暂时无法核对原设计请求，请稍后重试；生成文件已保留', IpcErrorCode.Busy)
      return undefined
    }
    if (matches.length !== 1) throw new DesignWorkspaceError('原设计请求存在重复回合，未登记输出', IpcErrorCode.Denied)
    const action = object(object(matches[0].payload).privateAction)
    const requestId = z.string().uuid().safeParse(action.requestId)
    if (!requestId.success || typeof action.expandedPrompt !== 'string') {
      if (required) throw new DesignWorkspaceError('暂时无法核对原设计请求，请稍后重试；生成文件已保留', IpcErrorCode.Busy)
      return undefined
    }
    const stored = this.storage.read(`requests/${owner.conversation.id}/${requestId.data}.json`, designRequestSchema, 1024 * 1024)
    if (!stored) {
      if (required) throw new DesignWorkspaceError('原设计请求暂不可用，请稍后重试；生成文件已保留', IpcErrorCode.Busy)
      return undefined
    }
    const request = stored.value
    if (request.creatorId !== owner.conversation.creatorId || request.conversationId !== owner.conversation.id ||
      request.sourceIdentity !== owner.sourceIdentity || request.requestId !== requestId.data ||
      request.input.requestId !== requestId.data || request.input.text !== action.expandedPrompt) {
      throw new DesignWorkspaceError('原设计请求来源不匹配；生成文件已保留', IpcErrorCode.Denied)
    }
    // The native user event is emitted only after promptStarted; paired with
    // the completed tool event it remains proof after daemon receipt rotation.
    owner.assertCurrent()
    return request
  }
  private bindIntent(owner: DesignOwner, documentId: string, current: () => void): void {
    const path = `conversations/${owner.conversation.id}.json`, intent = this.storage.read(path, designIntentSchema)
    if (!intent) return
    this.assertIntent(owner, intent.value)
    if (!intent.value.documentId) this.storage.write(path, designIntentSchema, { ...intent.value, documentId }, intent.digest, current)
  }
  private assertIntent(owner: DesignOwner, intent: DesignIntent): void {
    if (intent.conversationId !== owner.conversation.id || intent.creatorId !== owner.conversation.creatorId || intent.sourceIdentity !== owner.sourceIdentity) throw new DesignWorkspaceError('设计意图不属于原会话来源', IpcErrorCode.Denied)
    owner.assertCurrent()
  }
  hasConversation(id: string): boolean {
    try {
      z.string().uuid().parse(id)
      return this.storage.read(`conversations/${id}.json`, designIntentSchema) !== null
    } catch { return true }
  }
  async createConversation(raw: unknown = {}, current: () => void = noop): Promise<ConversationRead> {
    const input = dto.designCreateConversationSchema.parse(raw ?? {})
    return this.serial(async () => {
      current()
      const conversation = await this.ports.conversations.createDraft({ kind: 'work', runtimeId: 'pi', text: input.text ?? (input.kind === 'app' ? '设计一个应用界面' : input.kind === 'prototype' ? '设计一个可交互原型' : '设计一个网页') })
      const owner = await this.owner(conversation.conversation.id, true, current)
      this.storage.write(`conversations/${owner.conversation.id}.json`, designIntentSchema, {
        version: 1, conversationId: owner.conversation.id, creatorId: owner.conversation.creatorId, sourceIdentity: owner.sourceIdentity, kind: input.kind ?? 'web', createdAt: Date.now()
      }, null, () => { current(); owner.assertCurrent() })
      return conversation
    })
  }
  private rememberSnapshot(record: DesignRecord, snapshot: DesignSnapshot, reason: 'save' | 'adopt', current: () => void): void {
    this.storage.saveSnapshot(record.id, snapshot, current)
    if (!record.history.some(item => item.revision === snapshot.revision)) {
      if (record.history.length >= 64) throw new DesignWorkspaceError('设计历史已达上限；全部既有修订已保留', IpcErrorCode.Busy)
      record.history.push({ revision: snapshot.revision, createdAt: Date.now(), reason })
    }
    record.currentRevision = snapshot.revision; record.updatedAt = Date.now()
  }
  private receipt(record: DesignRecord, commandId: string, commandDigest: string): string | null {
    const receipt = record.receipts.find(item => item.commandId === commandId)
    if (receipt && receipt.digest !== commandDigest) throw new DesignWorkspaceError('同一操作身份不能用于不同内容')
    if (receipt) return receipt.revision
    if (record.receipts.length >= 256) throw new DesignWorkspaceError('设计操作回执已达上限；原操作均已保留', IpcErrorCode.Busy)
    return null
  }
  private finishCommand(loaded: Loaded, commandId: string, digest: string): dto.DesignDocument {
    loaded.record.receipts.push({ commandId, digest, revision: loaded.record.currentRevision })
    this.persist(loaded)
    return this.view(loaded.record)
  }
  private async replayCommand(documentId: string, commandId: string, commandDigest: string, current: () => void): Promise<dto.DesignDocument | null> {
    const { record } = this.managed(documentId, current), revision = this.receipt(record, commandId, commandDigest)
    if (!revision) return null
    const status = await this.sourceStatus(record, current)
    current()
    return { ...this.view(record, revision), ...status }
  }
  async save(raw: unknown, current: () => void = noop): Promise<dto.DesignDocument> {
    const input = dto.designSaveSchema.parse(raw), commandDigest = hash(JSON.stringify({ action: 'save', ...input }))
    return this.serial(async () => {
      const retained = await this.replayCommand(input.documentId, input.commandId, commandDigest, current)
      if (retained) return retained
      const loaded = await this.load(input.documentId, true, current), original = this.receipt(loaded.record, input.commandId, commandDigest)
      if (original) return this.view(loaded.record, original)
      if (loaded.record.currentRevision !== input.expectedRevision) throw new DesignWorkspaceError('设计已被修改，请刷新后再保存')
      const previous = this.storage.snapshot(input.documentId, loaded.record.currentRevision), pages = input.pages ?? previous.pages
      assertSelfContained(pages)
      const snapshot = makeSnapshot(previous.title, pages, input.frames ?? defaultFrames(pages, previous.frames))
      this.rememberSnapshot(loaded.record, snapshot, 'save', loaded.current)
      return this.finishCommand(loaded, input.commandId, commandDigest)
    })
  }
  async adopt(raw: unknown, current: () => void = noop): Promise<dto.DesignDocument> { return this.candidateCommand('adopt', raw, current) }
  async discard(raw: unknown, current: () => void = noop): Promise<dto.DesignDocument> { return this.candidateCommand('discard', raw, current) }
  private candidateCommand(action: 'adopt' | 'discard', raw: unknown, current: () => void): Promise<dto.DesignDocument> {
    const input = dto.designAdoptSchema.parse(raw), commandDigest = hash(JSON.stringify({ action, ...input }))
    return this.serial(async () => {
      const retained = await this.replayCommand(input.documentId, input.commandId, commandDigest, current)
      if (retained) return retained
      const loaded = await this.load(input.documentId, true, current), original = this.receipt(loaded.record, input.commandId, commandDigest)
      if (original) return this.view(loaded.record, original)
      if (loaded.record.currentRevision !== input.expectedRevision) throw new DesignWorkspaceError('当前设计已变化；候选和原稿均已保留')
      const candidate = loaded.record.candidates.find(item => item.id === input.candidateId)
      if (!candidate) throw new DesignWorkspaceError('候选已处理或不存在', IpcErrorCode.NotFound)
      if (action === 'adopt') {
        if (candidate.baseRevision !== loaded.record.currentRevision) throw new DesignWorkspaceError('候选基于旧稿，请重新生成；未覆盖当前设计')
        const snapshot = this.storage.snapshot(input.documentId, candidate.revision)
        assertSelfContained(snapshot.pages)
        this.rememberSnapshot(loaded.record, snapshot, 'adopt', loaded.current)
      }
      loaded.record.candidates = loaded.record.candidates.filter(item => item.id !== input.candidateId)
      loaded.record.updatedAt = Date.now()
      return this.finishCommand(loaded, input.commandId, commandDigest)
    })
  }
  private compileEdit(snapshot: DesignSnapshot, documentId: string, text: string, selection: dto.DesignSelection | undefined, owner: DesignOwner, current: () => void): string {
    const full = buildDesignGenerationPrompt(text, { documentId, baseRevision: snapshot.revision, pages: snapshot.pages, selection })
    if (full.length <= 195_000) return full
    // Large designs remain exact read-on-demand files within the original
    // private workspace; they are never silently clipped into model context.
    const sources = snapshot.pages.map(page => {
      const path = `outputs/design-context/${documentId}/${snapshot.revision}/${page.id}.html`, bytes = Buffer.from(page.html)
      let actual: ReturnType<typeof readRegular> | undefined
      try { actual = readRegular(owner.conversation.workspace.root, path, dto.DESIGN_PAGE_BYTES) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (actual && hash(actual.bytes) !== hash(bytes)) throw new DesignWorkspaceError('当前设计的上下文源已被修改，未覆盖实际文件')
      if (!actual) writeRevision(owner.conversation.workspace.root, path, bytes, null, current)
      return { id: page.id, path, revision: hash(bytes), width: page.width, height: page.height }
    })
    return buildDesignGenerationPrompt(text, { documentId, baseRevision: snapshot.revision, pages: snapshot.pages.map(page => ({ ...page, html: '' })), selection })
      + '\n\nThe HTML fields above are omitted to preserve the prompt budget. Before editing, read the exact complete current HTML from these application-owned source files. Do not edit these source files; return changed pages only through design_open. File references (JSON data):\n' + JSON.stringify(sources)
  }
  private checkSelection(snapshot: DesignSnapshot, selection?: dto.DesignSelection): void {
    if (!selection) return
    if (selection.revision !== snapshot.revision || !snapshot.pages.some(page => page.id === selection.pageId) || selection.frameId && !snapshot.frames.some(frame => frame.id === selection.frameId && frame.pageId === selection.pageId)) throw new DesignWorkspaceError('元素引用属于旧修订或其他页面，请重新选择')
  }
  private existingRequest(owner: Pick<DesignRequest, 'conversationId' | 'creatorId' | 'sourceIdentity'>, requestId: string, digest: string): DesignRequest | null {
    const value = this.storage.read(`requests/${owner.conversationId}/${requestId}.json`, designRequestSchema, 1024 * 1024)?.value
    if (!value) return null
    const receipt = { requestId, outcomeUnknown: true, outcome: 'unknown' }
    if (value.creatorId !== owner.creatorId || value.sourceIdentity !== owner.sourceIdentity || value.conversationId !== owner.conversationId || value.requestId !== requestId) throw new DesignWorkspaceError('原设计请求来源已变化', IpcErrorCode.Denied, receipt)
    if (value.originalDigest !== digest) throw new DesignWorkspaceError('同一请求身份不能发送不同设计要求', IpcErrorCode.Conflict, receipt)
    return value
  }
  private saveRequest(owner: DesignOwner, input: ConversationSend, text: string, displayText: string, digest: string, current: () => void, documentId?: string, baseRevision?: string): DesignRequest {
    const request: DesignRequest = { version: 1, creatorId: owner.conversation.creatorId, sourceIdentity: owner.sourceIdentity, conversationId: owner.conversation.id,
      requestId: input.requestId, originalDigest: digest, input: { ...input, images: undefined, text }, displayText, documentId, baseRevision }
    this.storage.write(`requests/${owner.conversation.id}/${input.requestId}.json`, designRequestSchema, request, null, current, 1024 * 1024)
    return request
  }
  private requestGuard(request: DesignRequest, owner: DesignOwner, current: () => void): () => void {
    return () => {
      current(); owner.assertCurrent()
      if (!request.documentId || !request.baseRevision) return
      const { record } = this.managed(request.documentId, current)
      this.matchOwner(record, owner)
      if (record.currentRevision !== request.baseRevision) throw new DesignWorkspaceError('发送前设计已变化；请保留原输入并刷新设计')
      for (const source of record.sources) assertGenerationCurrent(owner, source)
    }
  }
  async prepareSend(id: string, input: ConversationSend, assertCurrent: () => void = noop): Promise<{ input: ConversationSend; displayText?: string; assertCurrent?: () => void }> {
    const intent = this.storage.read(`conversations/${z.string().uuid().parse(id)}.json`, designIntentSchema)
    if (!intent) return { input }
    return this.serial(async () => {
      const owner = await this.owner(id, true, assertCurrent); this.assertIntent(owner, intent.value)
      if (owner.runtimeId !== 'pi') throw new DesignWorkspaceError('设计画布生成需要 Pi，请在新建设计会话中使用 Pi', IpcErrorCode.InvalidArg)
      if (!input.text.trim() || input.text.length > 16_000) throw new DesignWorkspaceError('请输入 16000 字以内的设计要求；草稿已保留', IpcErrorCode.InvalidArg)
      const digest = hash(JSON.stringify({ text: input.text, draftText: input.draftText, images: input.images?.map(image => ({ ...image, data: hash(image.data) })) }))
      const previous = this.existingRequest({ conversationId: id, creatorId: owner.conversation.creatorId, sourceIdentity: owner.sourceIdentity }, input.requestId, digest)
      if (previous) return { input: { ...previous.input, images: input.images, expectedConnectionGeneration: input.expectedConnectionGeneration }, displayText: previous.displayText, assertCurrent: this.requestGuard(previous, owner, assertCurrent) }
      const current = (): void => { assertCurrent(); owner.assertCurrent() }
      let prompt: string, baseRevision: string | undefined
      if (intent.value.documentId) {
        const loaded = await this.load(intent.value.documentId, true, current), snapshot = this.storage.snapshot(loaded.record.id, loaded.record.currentRevision)
        baseRevision = snapshot.revision; prompt = this.compileEdit(snapshot, loaded.record.id, input.text, undefined, owner, current)
      } else prompt = buildDesignGenerationPrompt(input.text) + `\n\nDesign medium: ${intent.value.kind}.`
      const request = this.saveRequest(owner, { ...input, draftText: input.draftText ?? input.text }, prompt, input.text, digest, current, intent.value.documentId, baseRevision)
      return { input: { ...request.input, images: input.images }, displayText: request.displayText, assertCurrent: this.requestGuard(request, owner, assertCurrent) }
    })
  }
  async send(raw: unknown, current: () => void = noop): Promise<dto.DesignSendReceipt> {
    const input = dto.designSendSchema.parse(raw)
    let dispatched = false, retainedRequest = false
    try {
    const request = await this.serial(async () => {
      const { record } = this.managed(input.documentId, current), digest = hash(JSON.stringify(input))
      const previous = this.existingRequest(record, input.requestId, digest)
      if (previous) {
        retainedRequest = true
        const owner = await this.owner(record.conversationId, false, current)
        this.matchOwner(record, owner)
        return previous
      }
      const loaded = await this.load(input.documentId, true, current)
      const snapshot = this.storage.snapshot(input.documentId, loaded.record.currentRevision)
      this.checkSelection(snapshot, input.selection)
      const prompt = this.compileEdit(snapshot, input.documentId, input.text, input.selection, loaded.owner, loaded.current)
      return this.saveRequest(loaded.owner, { requestId: input.requestId, text: input.text }, prompt, input.text, digest, loaded.current, input.documentId, snapshot.revision)
    })
    current()
    const owner = await this.owner(request.conversationId, false, current)
    if (owner.sourceIdentity !== request.sourceIdentity) throw new DesignWorkspaceError('发送前原设计来源已变化', IpcErrorCode.Denied)
    if (retainedRequest) {
      const receipt = await this.ports.conversations.requestReceipt(request.conversationId, request.requestId)
      current(); owner.assertCurrent()
      if (receipt.ok) {
        const completed = receipt.receipt.result?.inline
        const turnId = receipt.state === 'sent' ? receipt.turnId : completed?.ok ? completed.turnId : undefined
        if (turnId) return { conversationId: request.conversationId, requestId: request.requestId, session: receipt.session, turnId }
      }
    }
    dispatched = true
    const result = await this.ports.conversations.send(request.conversationId, request.input, request.displayText, () => { current(); owner.assertCurrent() }, this.requestGuard(request, owner, current))
    current(); owner.assertCurrent()
    if (!result.ok) {
      const failure = result as dto.DesignSendFailure
      throw new DesignWorkspaceError(result.error, result.code, { requestId: input.requestId, ...(failure.notSent === true ? { notSent: true } : { outcomeUnknown: true }), ...(failure.outcome ? { outcome: failure.outcome } : {}) })
    }
    return { conversationId: request.conversationId, requestId: request.requestId, session: result.value.session, turnId: result.value.turnId }
    } catch (error) {
      if (error instanceof DesignWorkspaceError && error.receipt) throw error
      const code = error && typeof error === 'object' && 'code' in error && Object.values(IpcErrorCode).includes(error.code as typeof IpcErrorCode.Io) ? error.code as typeof IpcErrorCode.Io : error instanceof z.ZodError ? IpcErrorCode.InvalidArg : IpcErrorCode.Io
      const notAdmitted = error !== null && typeof error === 'object' && 'outcome' in error && error.outcome === 'not-admitted'
      throw new DesignWorkspaceError(sourceMessage(error), code, { requestId: input.requestId, ...(!dispatched && !retainedRequest || notAdmitted ? { notSent: true } : { outcomeUnknown: true, outcome: 'unknown' }) })
    }
  }
  async export(raw: unknown, current: () => void = noop): Promise<{ cancelled: boolean }> {
    const input = dto.designExportSchema.parse(raw), managed = this.managed(input.documentId, current)
    const snapshot = this.storage.snapshot(input.documentId, managed.record.currentRevision)
    if (input.expectedRevision && input.expectedRevision !== snapshot.revision) throw new DesignWorkspaceError('设计已变化，请重新选择要导出的修订')
    assertSelfContained(snapshot.pages)
    const prototype = buildDesignPrototype({ id: managed.record.id, title: snapshot.title, revision: snapshot.revision, pages: snapshot.pages })
    let bytes: Buffer
    if (input.format === 'prototype') bytes = Buffer.from(prototype)
    else {
      const entries: Record<string, Uint8Array> = { 'index.html': strToU8(prototype) }
      for (const page of snapshot.pages) entries[`pages/${page.id}.html`] = strToU8(page.html)
      entries['design.json'] = strToU8(JSON.stringify({ version: 1, id: managed.record.id, title: snapshot.title, revision: snapshot.revision, frames: snapshot.frames,
        pages: snapshot.pages.map(({ html, ...page }) => ({ ...page, path: `pages/${page.id}.html`, revision: hash(html) })) }, null, 2))
      bytes = Buffer.from(zipSync(entries, { level: 6 }))
    }
    if (!this.ports.chooseSave) throw new DesignWorkspaceError('原生保存选择器当前不可用', IpcErrorCode.Unavailable)
    current()
    const name = snapshot.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[ .]+$/, '').slice(0, 80) || 'design'
    const file = await this.ports.chooseSave({ title: snapshot.title, format: input.format, defaultName: `${name}.${input.format === 'source' ? 'zip' : 'html'}` })
    current()
    if (!file) return { cancelled: true }
    if (!isAbsolute(file)) throw new DesignWorkspaceError('保存选择器没有返回有效路径', IpcErrorCode.InvalidArg)
    const target = resolve(checkedDirectory(dirname(file)), basename(file))
    const dataRelative = relative(pathKey(checkedDirectory(this.ports.directory())), pathKey(target))
    if ((dataRelative === '' || !isAbsolute(dataRelative) && dataRelative !== '..' && !dataRelative.startsWith(`..${sep}`)) || target.split(/[\\/]/).some(part => part.toLowerCase() === '.tpanel-design')) throw new DesignWorkspaceError('请选择应用数据和设计历史目录以外的保存位置', IpcErrorCode.Denied)
    const assertCurrent = (): void => {
      current()
      const latest = this.managed(input.documentId, current)
      if (latest.record.currentRevision !== snapshot.revision) throw new DesignWorkspaceError('选择保存位置期间设计已变化；未写入所选文件')
      this.storage.snapshot(input.documentId, snapshot.revision)
    }
    saveSelectedFile(file, bytes, assertCurrent)
    return { cancelled: false }
  }
}

function sourceMessage(error: unknown): string { return (error instanceof Error ? error.message : '原设计来源当前不可用；已保存的设计仍可阅读').slice(0, 2000) }

function assertSelfContained(pages: readonly dto.DesignPage[]): void {
  for (const page of pages) assertPageHtml(page.html)
}

function recoverableSourceError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) return [IpcErrorCode.NotFound, IpcErrorCode.Denied, IpcErrorCode.Conflict, IpcErrorCode.Unavailable, 'ENOENT', 'ENOTDIR'].includes(String(error.code) as typeof IpcErrorCode.NotFound)
  return false
}
