import { randomUUID } from 'node:crypto'
import { protectedStorage as safeStorage } from '../../daemon/protected-storage'
import { z } from 'zod'
import type { KnowledgeArtifact, KnowledgeCollection, KnowledgeContext, KnowledgeDocument, KnowledgeFolderTree, KnowledgePublication, KnowledgeReadResult, KnowledgeScope, KnowledgeSearchResult, KnowledgeSource, KnowledgeSourceRange } from '../../../shared/knowledge-access'
import { KNOWLEDGE_READ_PAGE_LIMIT } from '../../../shared/knowledge-access'
import { IpcErrorCode, ipcFail, type IpcFail } from '../../../shared/ipc-errors'
import { IntegrationError, type KnowledgePort, type ResolvedConnection } from '../integrations/types'
import { readIntegrationState } from '../integrations/repository'
import { kbSearch } from '../knowledge'
import { readFileSync, statSync } from 'node:fs'
import { relative } from 'node:path'
import { computeRevision } from '../documents/controller'
import { materialPath } from './materials'
import { readKnowledgeState, updateKnowledgeState, knowledgeHash, type StoredKnowledgeSource } from './repository'
import { artifactRead, assertArtifactCurrent, handoffKnowledgeArtifact, readTaskPrd, saveKnowledgeArtifact } from './materials'
import { KnowledgeReadVersionError, type KnowledgeOwner, type KnowledgeReadInput } from './types'
import { knowledgeWorkspaceRoot, knowledgeWorkspaceGeneration } from './workspace-host'
import * as integrations from '../integrations/service'
import * as providers from '../integrations/providers'
import { getSettings } from '../store'
import { KnowledgeConversationWorkflow } from './conversation'
import type { KnowledgeConversationInput, KnowledgeConversationResult } from '../../../shared/knowledge-conversation'

const uuidSchema = z.string().uuid()
const readWindowSchema = z.object({ offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), limit: z.number().int().min(1).max(KNOWLEDGE_READ_PAGE_LIMIT) })
const MAX_READ_PAGE_JSON_BYTES = 10_000
const MAX_BROWSE_HANDLES = 1000
function integrationApi(): typeof integrations { return integrations }
function registryApi(): typeof providers { return providers }
function rootOf(): string | null { return knowledgeWorkspaceRoot() }
function generationOf(): number { return knowledgeWorkspaceGeneration() }
function canonicalRoot(root: string): string { return integrationApi().canonicalRoot(root) }
function publicFail(error: unknown): IpcFail {
  if (error instanceof IntegrationError) {
    const code = error.kind === 'conflict' ? IpcErrorCode.Conflict : error.kind === 'denied' ? IpcErrorCode.Denied : error.kind === 'io' ? IpcErrorCode.Io : error.kind === 'upstream' || error.kind === 'uncertain' ? IpcErrorCode.Upstream : IpcErrorCode.InvalidArg
    return ipcFail(code, error.message)
  }
  return ipcFail(IpcErrorCode.Upstream, '知识操作失败，请检查项目、连接与网络后重试')
}
function ensureOwner(owner: KnowledgeOwner): void {
  const root = rootOf()
  if (!root || canonicalRoot(root) !== canonicalRoot(owner.root) || generationOf() !== owner.projectGeneration || owner.isCurrent?.() === false) throw new IntegrationError('项目或 Agent 会话已变化，请重新发起知识操作', 'conflict')
}
function limitOf(value?: number): number { return Math.min(Math.max(Number(value) || 10, 1), 30) }
function revisionOf(binding: number | null, connection: number | null, generation: number, ids: string[], bindingId?: string, connectionId?: string): string { return knowledgeHash(JSON.stringify({ binding, connection, generation, ids, bindingId, connectionId })).slice(0, 32) }
interface ScopeResolution { scope: KnowledgeScope; connection: ResolvedConnection | null; binding: { id: string; revision: number; connectionId: string; knowledge?: { defaultCollectionIds: string[] } } | null }
interface ScopeOverride { baseRevision: string; collectionIds: string[] }
function resolveScope(owner: KnowledgeOwner, override?: string[] | null): ScopeResolution {
  ensureOwner(owner)
  const integrations = integrationApi(); const stored = readIntegrationState(); const root = canonicalRoot(owner.root)
  const binding = stored.bindings.find((item) => item.root === root && item.enabled && stored.connections.some((connection) => connection.id === item.connectionId && !connection.deleted && connection.enabled && connection.providerId === 'weknora')) as ScopeResolution['binding'] | undefined
  if (!binding) return { binding: null, connection: null, scope: { id: knowledgeHash(`${root}:${owner.sessionId}:none`), revision: revisionOf(null, null, owner.projectGeneration, []), root: owner.root, projectGeneration: owner.projectGeneration, sessionId: owner.sessionId, collectionIds: [], overridden: override !== undefined, bindingId: null, bindingRevision: null, connectionId: null, connectionRevision: null, connectionName: null, instanceId: null, status: 'not_configured', detail: '当前项目未绑定 WeKnora 知识范围；不会回退到全局连接' } }
  const record = stored.connections.find((item) => item.id === binding.connectionId)
  if (!record) throw new IntegrationError('知识绑定连接不存在', 'conflict')
  let connection: ResolvedConnection | null = null
  let unavailable: IntegrationError | null = null
  try { connection = integrations.resolveConnection({ connectionId: record.id, connectionRevision: record.revision }) }
  catch (error) { if (error instanceof IntegrationError && ['denied', 'io'].includes(error.kind)) unavailable = error; else throw error }
  const collectionIds = [...new Set((override === undefined ? binding.knowledge?.defaultCollectionIds ?? [] : override ?? []).map(String).map((id) => id.trim()).filter(Boolean))].slice(0, 20)
  return { binding, connection, scope: { id: knowledgeHash(`${root}:${binding.id}:${owner.sessionId}`), revision: revisionOf(binding.revision, record.revision, owner.projectGeneration, collectionIds, binding.id, record.id), root: owner.root, projectGeneration: owner.projectGeneration, sessionId: owner.sessionId, collectionIds, overridden: override !== undefined, bindingId: binding.id, bindingRevision: binding.revision, connectionId: record.id, connectionRevision: record.revision, connectionName: record.name, instanceId: connection?.instanceId ?? `weknora:${record.config.baseUrl}`, status: unavailable ? 'denied' : collectionIds.length ? 'ok' : 'not_configured', detail: unavailable ? `${unavailable.message}；本地项目知识仍可检索` : collectionIds.length ? '项目知识范围已捕获' : '项目未选择默认知识库；不会检索远端' } }
}
function ensureScope(owner: KnowledgeOwner, scope: KnowledgeScope): void {
  ensureOwner(owner); const current = resolveScope(owner, scope.overridden ? scope.collectionIds : undefined)
  if (current.scope.bindingId !== scope.bindingId || current.scope.revision !== scope.revision || current.scope.sessionId !== scope.sessionId) throw new IntegrationError('项目知识范围已变化，请重新发起操作', 'conflict')
}
function knowledgePort(connection: ResolvedConnection): KnowledgePort { const port = registryApi().integrationRegistry.get('weknora').knowledge; if (!port) throw new IntegrationError('WeKnora 知识能力未注册', 'denied'); return port }
function snapshot(scope: KnowledgeScope, item: { documentId: string; collectionId: string; title: string; text: string; truncated: boolean }, turnId: string, supplied = false): KnowledgeSource { const text = item.text; return { id: randomUUID(), sourceHandle: randomUUID(), title: item.title, text, contentHash: knowledgeHash(text), kind: 'weknora', documentId: item.documentId, collectionId: item.collectionId, relativePath: null, instanceId: scope.instanceId, fetchedAt: Date.now(), mode: 'excerpt', truncated: item.truncated, sessionId: scope.sessionId, turnId, scopeRevision: scope.revision, suppliedToAgent: supplied, historical: false } }
function storeSource(root: string, scope: KnowledgeScope, source: KnowledgeSource): void { updateKnowledgeState(root, (state) => { state.sources.unshift({ source, scope }) }) }
function ownerFor(input: { expectedRoot: string; sessionId?: string }): KnowledgeOwner { const root = rootOf(); if (!root || canonicalRoot(root) !== canonicalRoot(input.expectedRoot)) throw new IntegrationError('项目已切换，请刷新', 'conflict'); return { root, projectGeneration: generationOf(), sessionId: input.sessionId || 'ui', turnId: `ui-${randomUUID()}` } }
function legacyAvailable(): boolean { try { const { weknora } = getSettings(); return !!weknora.apiKey && !!weknora.baseUrl } catch { return false } }

export class KnowledgeAccessService {
  private readonly selectionSalt = randomUUID()
  private readonly selectionEpochs = new Map<string, number>()
  private readonly selectableSources = new Map<string, { key: string; epoch: number }>()
  private advanceSelectionEpoch(key: string): void {
    if (!this.selectionEpochs.has(key) && this.selectionEpochs.size >= 500) throw new IntegrationError('临时知识范围数量已达上限，请重启应用清理', 'io')
    this.selectionEpochs.set(key, (this.selectionEpochs.get(key) ?? 0) + 1)
  }
  selectionToken(owner: KnowledgeOwner): string {
    const scope = this.capture(owner), key = this.overrideKey(owner)
    return knowledgeHash(JSON.stringify([this.selectionSalt, key, scope.revision, this.selectionEpochs.get(key) ?? 0]))
  }
  private rememberSelectable(owner: KnowledgeOwner, sources: KnowledgeSource[], epoch: number): void {
    const key = this.overrideKey(owner)
    if ((this.selectionEpochs.get(key) ?? 0) !== epoch) throw new IntegrationError('项目知识范围已变化，请重新读取', 'conflict')
    for (const source of sources) {
      this.selectableSources.set(source.id, { key, epoch })
      while (this.selectableSources.size > 1500) this.selectableSources.delete(this.selectableSources.keys().next().value!)
    }
  }
  selectedSources(owner: KnowledgeOwner, references: Array<{ sourceId: string; contentHash: string }>): KnowledgeSource[] {
    const scope = this.capture(owner), key = this.overrideKey(owner), epoch = this.selectionEpochs.get(key) ?? 0
    const state = readKnowledgeState(owner.root)
    return references.map(reference => {
      const issued = this.selectableSources.get(reference.sourceId)
      const item = state.sources.find(entry => entry.source.id === reference.sourceId)
      if (!issued || issued.key !== key || issued.epoch !== epoch || !item || item.source.sessionId !== owner.sessionId || item.scope.id !== scope.id || item.scope.revision !== scope.revision || item.scope.projectGeneration !== scope.projectGeneration || item.source.contentHash !== reference.contentHash || knowledgeHash(item.source.text) !== reference.contentHash || item.source.mode === 'unsupported' || !item.source.text || item.source.kind === 'weknora' && (!item.source.collectionId || !scope.collectionIds.includes(item.source.collectionId))) throw new IntegrationError('知识来源已失效、范围或正文已改变，请重新读取并选择', 'conflict')
      return item.source
    })
  }
  async assertSelectedRemoteRevision(owner: KnowledgeOwner, source: KnowledgeSource, signal: AbortSignal): Promise<void> {
    const scope = this.capture(owner)
    const resolved = resolveScope(owner, scope.overridden ? scope.collectionIds : undefined)
    if (!source.collectionId || !scope.collectionIds.includes(source.collectionId) || !resolved.connection || scope.status !== 'ok'
        || !source.documentRevision) throw new IntegrationError('原知识来源已失权或无法核对，请重新选择', 'denied')
    const port = knowledgePort(resolved.connection)
    if (!port.authorizeDocument) throw new IntegrationError('原知识来源无法证明当前读取权限', 'denied')
    await port.authorizeDocument(resolved.connection, source.documentId, source.collectionId, signal)
    const live = await port.read(resolved.connection, source.documentId, source.collectionId, signal)
    ensureScope(owner, scope)
    if (signal.aborted || live.mode !== 'full' || live.documentRevision !== source.documentRevision) {
      throw new IntegrationError('原知识文档版本已变化或无法核对，请重新选择', 'conflict')
    }
  }
  recordSelectedDelivery(owner: KnowledgeOwner, references: Array<{ sourceId: string; contentHash: string }>, local: Array<{ relativePath: string; revision: string; text: string }>): string[] {
    const scope = this.capture(owner)
    const originals = this.selectedSources(owner, references)
    const sources: KnowledgeSource[] = originals.map(source => ({ ...source, id: randomUUID(), sourceHandle: randomUUID(), parentSourceId: source.id, sessionId: owner.sessionId, turnId: owner.turnId, scopeRevision: scope.revision, suppliedToAgent: true, historical: false }))
    for (const document of local) sources.push({ id: randomUUID(), sourceHandle: randomUUID(), title: document.relativePath.split('/').pop() || document.relativePath, text: document.text, contentHash: knowledgeHash(document.text), kind: 'local', documentId: document.relativePath, collectionId: null, relativePath: document.relativePath, instanceId: null, fetchedAt: Date.now(), mode: 'full', truncated: false, sessionId: owner.sessionId, turnId: owner.turnId, scopeRevision: scope.revision, suppliedToAgent: true, historical: false, documentRevision: document.revision })
    updateKnowledgeState(owner.root, state => { state.sources.unshift(...sources.map(source => ({ source, scope }))) })
    return sources.map(source => source.id)
  }
  rebindSource(owner: KnowledgeOwner, sourceId: string, contentHash: string): { source: KnowledgeSource; selectionToken: string } {
    const uiOwner: KnowledgeOwner = { ...owner, sessionId: 'ui' }
    const original = this.selectedSources(uiOwner, [{ sourceId, contentHash }])[0]
    const sourceScope = this.capture(uiOwner), targetScope = this.capture(owner)
    if (sourceScope.revision !== targetScope.revision || sourceScope.bindingId !== targetScope.bindingId || sourceScope.connectionId !== targetScope.connectionId || sourceScope.instanceId !== targetScope.instanceId || JSON.stringify(sourceScope.collectionIds) !== JSON.stringify(targetScope.collectionIds)) throw new IntegrationError('来源与目标会话的知识范围不同，请在目标会话重新读取', 'conflict')
    const source: KnowledgeSource = { ...original, id: randomUUID(), sourceHandle: randomUUID(), parentSourceId: original.id, sessionId: owner.sessionId, turnId: `ui-rebind-${randomUUID()}`, scopeRevision: targetScope.revision, suppliedToAgent: false, historical: false }
    updateKnowledgeState(owner.root, state => { state.sources.unshift({ source, scope: targetScope }) })
    this.rememberSelectable(owner, [source], this.selectionEpochs.get(this.overrideKey(owner)) ?? 0)
    return { source, selectionToken: this.selectionToken(owner) }
  }
  private readonly conversationWorkflow = new KnowledgeConversationWorkflow(this, ensureOwner, ensureScope)
  conversation(owner: KnowledgeOwner, scope: KnowledgeScope, input: KnowledgeConversationInput, signal?: AbortSignal): Promise<KnowledgeConversationResult> {
    return this.conversationWorkflow.run(owner, scope, input, signal)
  }
  private readonly browseHandles = new Map<string, StoredKnowledgeSource>()
  private readonly browseIdentities = new Map<string, string>()
  private browseIdentity(scope: KnowledgeScope, documentId: string, collectionId: string): string {
    return JSON.stringify([canonicalRoot(scope.root), scope.id, scope.sessionId, scope.revision, scope.projectGeneration, scope.connectionId, scope.instanceId, collectionId, documentId])
  }
  private rememberBrowseSource(scope: KnowledgeScope, item: { id: string; title: string }, collectionId: string, turnId: string): KnowledgeSource {
    const key = this.browseIdentity(scope, item.id, collectionId)
    const previousHandle = this.browseIdentities.get(key)
    const previous = previousHandle ? this.browseHandles.get(previousHandle) : undefined
    if (previous && previous.source.title === item.title) {
      this.browseHandles.delete(previous.source.sourceHandle)
      this.browseHandles.set(previous.source.sourceHandle, previous)
      return previous.source
    }
    const source = snapshot(scope, { documentId: item.id, collectionId, title: item.title, text: '', truncated: false }, turnId)
    this.browseHandles.set(source.sourceHandle, { source, scope })
    this.browseIdentities.set(key, source.sourceHandle)
    while (this.browseHandles.size > MAX_BROWSE_HANDLES) {
      const oldest = this.browseHandles.entries().next().value
      if (!oldest) break
      const [handle, entry] = oldest
      this.browseHandles.delete(handle)
      const identity = this.browseIdentity(entry.scope, entry.source.documentId, entry.source.collectionId ?? '')
      if (this.browseIdentities.get(identity) === handle) this.browseIdentities.delete(identity)
    }
    return source
  }
  private readonly overrides = new Map<string, ScopeOverride>()
  private readonly publicationsInFlight = new Map<string, Promise<KnowledgePublication>>()
  private overrideKey(owner: KnowledgeOwner): string { return `${canonicalRoot(owner.root)}:${owner.sessionId}` }
  capture(owner: KnowledgeOwner, collectionIds?: string[] | null): KnowledgeScope {
    const base = resolveScope(owner)
    if (collectionIds !== undefined) return resolveScope(owner, collectionIds).scope
    const key = this.overrideKey(owner); const override = this.overrides.get(key)
    if (override && override.baseRevision === base.scope.revision) return resolveScope(owner, override.collectionIds).scope
    if (override) { this.overrides.delete(key); base.scope.detail += '；旧的临时范围已因项目绑定变更重置' }
    return base.scope
  }
  async search(owner: KnowledgeOwner, scope: KnowledgeScope, input: { requestId: string; query: string; limit?: number }, signal?: AbortSignal): Promise<KnowledgeSearchResult> {
    const selectionEpoch = this.selectionEpochs.get(this.overrideKey(owner)) ?? 0
    uuidSchema.parse(input.requestId); ensureScope(owner, scope)
    if (!input.query.trim()) return { operationId: input.requestId, status: 'empty', detail: '请输入检索内容', scope, sources: [], elapsedMs: 0, persistence: 'durable' }
    if (input.query.length > 2000) throw new IntegrationError('检索内容超过 2000 字符')
    const started = Date.now(); const sources: KnowledgeSource[] = []
    const local = kbSearch(owner.root, 'all', input.query)
    for (const hit of local.hits.slice(0, limitOf(input.limit))) {
      const relativePath = relative(owner.root, hit.doc.path).replace(/\\/g, '/')
      try {
        const path = materialPath(owner.root, relativePath)
        if (statSync(path).size > 512 * 1024) continue
        const bytes = readFileSync(path); const body = bytes.toString('utf8'); const text = body.slice(0, 6000)
        sources.push({ id: randomUUID(), sourceHandle: randomUUID(), title: hit.doc.title, text, contentHash: knowledgeHash(text), kind: 'local', documentId: relativePath, collectionId: null, relativePath, instanceId: null, fetchedAt: Date.now(), mode: 'excerpt', truncated: body.length > text.length, sessionId: owner.sessionId, turnId: owner.turnId, scopeRevision: scope.revision, suppliedToAgent: false, historical: false, documentRevision: computeRevision(bytes) })
      } catch { /* Do not expose out-of-root or unreadable index entries. */ }
    }
    let status: KnowledgeSearchResult['status'] = sources.length ? 'ok' : 'empty'
    let detail = '本地项目检索完成'
    if (!scope.collectionIds.length) { status = sources.length ? 'partial' : 'not_configured'; detail = `${scope.detail}；本地项目知识仍可检索` }
    else {
      try {
        const resolved = resolveScope(owner, scope.overridden ? scope.collectionIds : undefined)
        if (!resolved.connection) throw new IntegrationError('WeKnora 连接不可用', 'denied')
        const result = await knowledgePort(resolved.connection).search(resolved.connection, scope.collectionIds, input.query.trim(), limitOf(input.limit), signal)
        sources.push(...result.items.map((item) => snapshot(scope, item, owner.turnId, false)))
        status = result.partial ? 'partial' : sources.length ? 'ok' : 'empty'
        detail = result.partial ? '部分远端知识库失败；仅展示成功取得的来源' : sources.length ? '已检索本地与项目远端范围' : '已检索项目范围，没有匹配结果'
      } catch (error) {
        if (signal?.aborted) { ensureOwner(owner); return { operationId: input.requestId, status: 'cancelled', detail: '知识检索已取消，未交付迟到结果', scope, sources: [], elapsedMs: Date.now() - started, persistence: 'durable' } }
        if (error instanceof IntegrationError && error.kind === 'conflict') throw error
        status = sources.length ? 'partial' : error instanceof IntegrationError && error.kind === 'denied' ? 'denied' : 'unavailable'
        detail = `远端检索失败；未将其视为无命中。${error instanceof IntegrationError ? error.message : 'WeKnora 不可用'}`
      }
    }
    ensureScope(owner, scope)
    if (signal?.aborted) return { operationId: input.requestId, status: 'cancelled', detail: '知识检索已取消', scope, sources: [], elapsedMs: Date.now() - started, persistence: 'durable' }
    let persistence: 'durable' | 'degraded' = 'durable'
    if ((this.selectionEpochs.get(this.overrideKey(owner)) ?? 0) !== selectionEpoch) throw new IntegrationError('项目知识范围已变化，请重新检索', 'conflict')
    try { updateKnowledgeState(owner.root, (state) => { state.sources.unshift(...sources.map((source) => ({ source, scope }))) }); this.rememberSelectable(owner, sources, selectionEpoch) } catch { persistence = 'degraded'; detail += '；证据未能持久化，重新打开后可能不可用' }
    return { operationId: input.requestId, status, detail, scope, sources, elapsedMs: Date.now() - started, persistence }
  }
  async read(owner: KnowledgeOwner, scope: KnowledgeScope, input: KnowledgeReadInput, signal?: AbortSignal): Promise<KnowledgeReadResult> {
    const selectionEpoch = this.selectionEpochs.get(this.overrideKey(owner)) ?? 0
    uuidSchema.parse(input.requestId); ensureScope(owner, scope); const state = readKnowledgeState(owner.root); const stored = state.sources.find((item) => item.source.sourceHandle === input.sourceHandle && item.source.sessionId === owner.sessionId) ?? this.browseHandles.get(input.sourceHandle)
    if (!stored || stored.source.sessionId !== owner.sessionId || canonicalRoot(stored.scope.root) !== canonicalRoot(owner.root) || stored.scope.id !== scope.id || stored.scope.revision !== scope.revision || stored.scope.connectionId !== scope.connectionId || stored.scope.projectGeneration !== scope.projectGeneration) throw new IntegrationError('来源句柄无效、已过期或不属于当前知识范围', 'denied')
    const ranged = input.offset !== undefined || input.limit !== undefined
    const window = ranged ? readWindowSchema.safeParse({ offset: input.offset === undefined ? 0 : input.offset, limit: input.limit === undefined ? KNOWLEDGE_READ_PAGE_LIMIT : input.limit }) : undefined
    if (window && !window.success) throw new IntegrationError('读取分页参数无效：offset 必须是非负整数，limit 必须是 1..6000 的整数', 'invalid')
    if (signal?.aborted) return { operationId: input.requestId, status: 'cancelled', detail: '读取已取消，未取得新正文', source: null, persistence: 'durable' }
    try {
      let value: Awaited<ReturnType<KnowledgePort['read']>>
      let documentRevision: string | undefined
      if (stored.source.kind === 'local') {
        if (!stored.source.relativePath) throw new IntegrationError('本地来源身份不完整', 'denied')
        const path = materialPath(owner.root, stored.source.relativePath)
        if (statSync(path).size > 512 * 1024) throw new IntegrationError('本地来源超过读取限额', 'io')
        const bytes = readFileSync(path); const body = bytes.toString('utf8')
        documentRevision = computeRevision(bytes)
        value = { title: stored.source.title, text: ranged ? body : body.slice(0, 100_000), mode: 'full', truncated: !ranged && body.length > 100_000 }
      } else {
        if (!stored.source.collectionId || !scope.collectionIds.includes(stored.source.collectionId)) throw new IntegrationError('来源不在当前知识范围', 'denied')
        const resolved = resolveScope(owner, scope.overridden ? scope.collectionIds : undefined)
        if (!resolved.connection) throw new IntegrationError('WeKnora 连接不可用', 'denied')
        value = await knowledgePort(resolved.connection).read(resolved.connection, stored.source.documentId, stored.source.collectionId, signal)
        if (value.mode === 'full') documentRevision = value.documentRevision
      }
      ensureScope(owner, scope)
      if ((this.selectionEpochs.get(this.overrideKey(owner)) ?? 0) !== selectionEpoch) throw new IntegrationError('项目知识范围已变化，请重新读取', 'conflict')
      if (signal?.aborted) return { operationId: input.requestId, status: 'cancelled', detail: '读取已取消，未交付迟到结果', source: null, persistence: 'durable' }
      let range: KnowledgeSourceRange | undefined
      let nextOffset: number | null | undefined
      let text = value.text
      let mode: KnowledgeSource['mode'] = value.mode
      let truncated = value.truncated
      if (window?.success && value.mode !== 'unsupported') {
        const { offset, limit } = window.data
        // An upstream size cap may already have cut a pair; expose only its valid prefix.
        if (value.truncated && /[\uD800-\uDBFF]$/u.test(value.text)) value.text = value.text.slice(0, -1)
        const splitsPair = (position: number): boolean => position > 0 && position < value.text.length && /[\uD800-\uDBFF]/u.test(value.text[position - 1]) && /[\uDC00-\uDFFF]/u.test(value.text[position])
        if (offset > value.text.length || splitsPair(offset)) throw new IntegrationError('读取 offset 超出可读正文范围或落在 UTF-16 代理对中间', 'invalid')
        let end = Math.min(offset + limit, value.text.length)
        // Leave room for labels/handles in the bounded MCP result, including JSON-escaped controls.
        if (Buffer.byteLength(JSON.stringify(value.text.slice(offset, end)), 'utf8') > MAX_READ_PAGE_JSON_BYTES) {
          let left = offset
          let right = end
          while (left < right) {
            const middle = Math.ceil((left + right) / 2)
            if (Buffer.byteLength(JSON.stringify(value.text.slice(offset, middle)), 'utf8') <= MAX_READ_PAGE_JSON_BYTES) left = middle
            else right = middle - 1
          }
          end = left
        }
        if (splitsPair(end)) end -= 1
        if (end === offset && offset < value.text.length) throw new IntegrationError('读取 limit 不足以容纳当前位置的 UTF-16 代理对，请至少使用 2', 'invalid')
        text = value.text.slice(offset, end)
        mode = 'excerpt'
        truncated = value.truncated || offset > 0 || end < value.text.length
        range = { offset, length: text.length, total: value.text.length, unit: 'utf16-code-units', totalIsComplete: !value.truncated }
        nextOffset = end < value.text.length ? end : null
      }
      const source: KnowledgeSource = { ...stored.source, id: randomUUID(), sourceHandle: randomUUID(), scopeRevision: scope.revision, sessionId: owner.sessionId, turnId: owner.turnId, title: value.title, text, contentHash: knowledgeHash(text), mode, truncated, fetchedAt: Date.now(), suppliedToAgent: false, historical: false, documentRevision }
      // A page handle retains document identity; a later full UI read has no inherited range.
      delete source.range
      if (range) source.range = range
      let persistence: 'durable' | 'degraded' = 'durable'
      if (window?.success && value.mode !== 'unsupported') {
        const readRevision = knowledgeHash(value.text)
        try {
          updateKnowledgeState(owner.root, (state) => {
            let original = state.sources.find((item) => item.source.sourceHandle === input.sourceHandle
              && item.source.sessionId === owner.sessionId && item.scope.revision === scope.revision)
            if (!original && this.browseHandles.get(input.sourceHandle) === stored) {
              original = { source: stored.source, scope: stored.scope }
              state.sources.unshift(original)
            }
            if (!original) throw new IntegrationError('分页来源已失效，请重新检索文档', 'conflict')
            if (original.readRevision !== undefined && original.readRevision !== readRevision) throw new KnowledgeReadVersionError()
            original.readRevision = readRevision
            state.sources.unshift({ source, scope, readRevision })
          })
          if (this.browseHandles.get(input.sourceHandle) === stored) {
            this.browseHandles.delete(input.sourceHandle)
            const key = this.browseIdentity(stored.scope, stored.source.documentId, stored.source.collectionId ?? '')
            if (this.browseIdentities.get(key) === input.sourceHandle) this.browseIdentities.delete(key)
          }
        } catch (error) {
          if (error instanceof IntegrationError && error.kind === 'conflict') throw error
          throw new IntegrationError('无法持久保存文档分页版本，未返回未固定版本的正文页', 'io')
        }
      } else {
        try { storeSource(owner.root, scope, source) } catch { persistence = 'degraded' }
      }
      if (persistence === 'durable') this.rememberSelectable(owner, [source], selectionEpoch)
      return { operationId: input.requestId, status: value.mode === 'unsupported' ? 'unavailable' : 'ok', detail: value.mode === 'unsupported' ? '此文档格式不支持正文读取；不代表已读全文' : range ? `已读取正文分页；${nextOffset === null ? range.totalIsComplete ? '已到正文末尾' : '已到可读内容末尾，上游正文仍有截断' : '尚有后续内容，请使用 nextOffset 继续读取'}` : value.truncated ? '正文超出限额，返回标记过的截断文本' : '已读取支持格式的正文', source, persistence, ...(range ? { range, nextOffset } : {}) }
    } catch (error) {
      ensureOwner(owner)
      if (error instanceof IntegrationError && ['conflict', 'denied', 'invalid'].includes(error.kind)) throw error
      return { operationId: input.requestId, status: signal?.aborted ? 'cancelled' : 'unavailable', detail: error instanceof IntegrationError ? error.message : '文档读取失败，未返回伪造正文', source: null, persistence: error instanceof IntegrationError && error.kind === 'io' ? 'degraded' : 'durable' }
    }
  }
  async markSupplied(owner: KnowledgeOwner, sourceIds: string[]): Promise<void> { ensureOwner(owner); const ids = new Set(sourceIds); updateKnowledgeState(owner.root, (state) => { for (const item of state.sources) if (ids.has(item.source.id) && item.source.sessionId === owner.sessionId && item.source.turnId === owner.turnId) item.source.suppliedToAgent = true }) }
  async context(input: { expectedRoot: string; sessionId?: string }): Promise<KnowledgeContext> { const owner = ownerFor(input); return { scope: this.capture(owner), selectionToken: this.selectionToken(owner), legacyImportAvailable: legacyAvailable() } }
  async collections(input: { expectedRoot: string; sessionId?: string; connectionId?: string; connectionRevision?: number }): Promise<{ items: KnowledgeCollection[]; hasMore: boolean }> {
    const owner = ownerFor(input); const stored = readIntegrationState()
    const resolved = resolveScope(owner)
    const record = input.connectionId ? stored.connections.find((item) => item.id === input.connectionId && !item.deleted && item.providerId === 'weknora') : stored.connections.find((item) => item.id === resolved.scope.connectionId)
    if (!record) return { items: [], hasMore: false }
    const connection = integrationApi().resolveConnection({ connectionId: record.id, connectionRevision: input.connectionRevision ?? record.revision })
    const result = await knowledgePort(connection).collections(connection)
    ensureOwner(owner); integrationApi().resolveConnection({ connectionId: record.id, connectionRevision: connection.public.revision })
    return result
  }
  async updateScope(input: { expectedRoot: string; sessionId?: string; collectionIds: string[] | null }): Promise<KnowledgeScope> {
    const owner = ownerFor(input); const base = resolveScope(owner); const key = this.overrideKey(owner)
    if (input.collectionIds === null) { this.advanceSelectionEpoch(key); this.overrides.delete(key); return base.scope }
    if (!base.connection) throw new IntegrationError('当前项目尚未绑定 WeKnora 连接', 'denied')
    const collections = await knowledgePort(base.connection).collections(base.connection)
    ensureScope(owner, base.scope)
    if (input.collectionIds.some((id) => !collections.items.some((collection) => collection.id === id))) throw new IntegrationError('临时范围包含不可访问或尚未列出的知识库', 'denied')
    if (this.overrides.size >= 500 && !this.overrides.has(key)) throw new IntegrationError('临时知识范围数量已达上限，请重启应用清理', 'io')
    this.advanceSelectionEpoch(key)
    this.overrides.set(key, { baseRevision: base.scope.revision, collectionIds: [...input.collectionIds] })
    return this.capture(owner)
  }
  async documents(input: { expectedRoot: string; sessionId?: string; collectionId: string; page?: number; folderPath?: string }): Promise<{ items: KnowledgeDocument[]; page: number; hasMore: boolean; total?: number }> {
    const owner = ownerFor(input); const scope = this.capture(owner); const resolved = resolveScope(owner, scope.overridden ? scope.collectionIds : undefined)
    if (!resolved.connection || !scope.collectionIds.includes(input.collectionId)) throw new IntegrationError('知识库不在项目范围内', 'denied')
    const port = knowledgePort(resolved.connection)
    // A legacy server may ignore folder_path. Require its directory endpoint before
    // accepting even an empty filtered page, and check every returned row in the port.
    if (input.folderPath !== undefined) {
      await port.folders(resolved.connection, input.collectionId)
      ensureScope(owner, scope)
      if (this.capture(owner).revision !== scope.revision) throw new IntegrationError('项目知识范围已变化，请重新发起操作', 'conflict')
    }
    const result = await port.documents(resolved.connection, input.collectionId, input.page ?? 1, undefined, input.folderPath)
    ensureScope(owner, scope)
    if (this.capture(owner).revision !== scope.revision) throw new IntegrationError('项目知识范围已变化，请重新发起操作', 'conflict')
    const records = result.items.map((item) => this.rememberBrowseSource(scope, item, input.collectionId, owner.turnId))
    return { ...result, items: result.items.map((item, index) => ({ ...item, sourceHandle: records[index].sourceHandle, collectionId: input.collectionId })) }
  }
  async folders(input: { expectedRoot: string; sessionId?: string; collectionId: string }): Promise<KnowledgeFolderTree> {
    const owner = ownerFor(input); const scope = this.capture(owner); const resolved = resolveScope(owner, scope.overridden ? scope.collectionIds : undefined)
    if (!resolved.connection || !scope.collectionIds.includes(input.collectionId)) throw new IntegrationError('知识库不在项目范围内', 'denied')
    const result = await knowledgePort(resolved.connection).folders(resolved.connection, input.collectionId)
    ensureScope(owner, scope)
    if (this.capture(owner).revision !== scope.revision) throw new IntegrationError('项目知识范围已变化，请重新发起操作', 'conflict')
    return result
  }
  async source(input: { expectedRoot: string; sessionId?: string; sourceId: string }): Promise<KnowledgeSource> { const owner = ownerFor(input); const state = readKnowledgeState(owner.root); const source = state.sources.find((item) => item.source.id === input.sourceId && (!input.sessionId || item.source.sessionId === owner.sessionId)); if (!source) throw new IntegrationError('来源不存在或不属于所选会话', 'invalid'); return { ...source.source, historical: true } }
  async sources(input: { expectedRoot: string; sessionId?: string }): Promise<KnowledgeSource[]> { const owner = ownerFor(input); let bytes = 0; return readKnowledgeState(owner.root).sources.filter((item) => !input.sessionId || item.source.sessionId === input.sessionId).slice(0, 50).flatMap((item) => { bytes += Buffer.byteLength(item.source.text); return bytes > 500_000 ? [] : [{ ...item.source, historical: true }] }) }
  cancel(_input: { requestId: string }): null { return null }
  async importLegacy(input: { expectedRoot: string; bindProject: boolean }): Promise<KnowledgeContext> {
    const owner = ownerFor(input)
    const cfg = getSettings().weknora
    if (!cfg.baseUrl || !cfg.apiKey) throw new IntegrationError('没有可导入的旧 WeKnora 连接', 'invalid')
    const existingState = readIntegrationState(); const importedId = existingState.legacyImports['settings.weknora']
    let connection = existingState.connections.find((record) => record.id === importedId && !record.deleted)
    if (!connection) {
      if (importedId) throw new IntegrationError('旧配置已导入过，但连接已删除；请显式新建连接，不能自动复活旧配置', 'conflict')
      let plain = cfg.apiKey
      if (cfg.apiKeyEncrypted) {
        try {
          if (!safeStorage.isEncryptionAvailable()) throw new Error('encryption unavailable')
          plain = safeStorage.decryptString(Buffer.from(cfg.apiKey, 'base64'))
        } catch { throw new IntegrationError('旧凭证无法解密；原设置未更改，请重新输入 API Key', 'denied') }
      }
      const baseUrl = /^https?:\/\//i.test(cfg.baseUrl) ? cfg.baseUrl : `http://${cfg.baseUrl}`
      const saved = integrationApi().saveImportedKnowledgeConnection({ providerId: 'weknora', name: 'WeKnora (imported)', enabled: cfg.enabled, config: { baseUrl }, secrets: { apiKey: { op: 'replace', value: plain } } })
      connection = readIntegrationState().connections.find((record) => record.id === saved.id)
    }
    ensureOwner(owner)
    if (input.bindProject && connection) {
      const state = readIntegrationState(); const prior = state.bindings.find((binding) => binding.root === canonicalRoot(owner.root) && binding.enabled && state.connections.some((c) => c.id === binding.connectionId && c.providerId === 'weknora'))
      if (prior && prior.connectionId !== connection.id) throw new IntegrationError('当前项目已有另一知识连接，请在集成页显式调整，不自动替换', 'conflict')
      if (!prior) integrationApi().saveBinding({ expectedRoot: owner.root, connectionId: connection.id, connectionRevision: connection.revision, label: 'WeKnora knowledge', enabled: connection.enabled && cfg.searchKbIds.length > 0, scope: '', knowledge: { defaultCollectionIds: [...new Set(cfg.searchKbIds)].slice(0, 20) } })
    }
    return this.context(input)
  }
  async saveArtifact(input: Parameters<typeof saveKnowledgeArtifact>[1] & { expectedRoot: string }): Promise<KnowledgeArtifact> { const owner = ownerFor(input); return saveKnowledgeArtifact(owner.root, input) }
  async artifacts(input: { expectedRoot: string }): Promise<KnowledgeArtifact[]> { const owner = ownerFor(input); const seen = new Set<string>(); return readKnowledgeState(owner.root).artifacts.filter((item) => { if (seen.has(item.id)) return false; seen.add(item.id); return true }).slice(0, 20) }
  async artifact(input: { expectedRoot: string; artifactId: string; revision: string }): Promise<KnowledgeArtifact> { const owner = ownerFor(input); return artifactRead(owner.root, input.artifactId, input.revision) }
  async taskPrd(input: { expectedRoot: string; taskDir: string }): Promise<{ body: string; revision: string | null }> { const owner = ownerFor(input); return readTaskPrd(owner.root, input) }
  async handoff(input: Parameters<typeof handoffKnowledgeArtifact>[1] & { expectedRoot: string }): Promise<{ taskDir: string; prdRevision: string; productPath: string; productRevision: string }> { const owner = ownerFor(input); const artifact = artifactRead(owner.root, input.artifactId, input.revision); assertArtifactCurrent(owner.root, artifact); return handoffKnowledgeArtifact(owner.root, input) }
  async previewPublication(input: { expectedRoot: string; sessionId?: string; artifactId: string; revision: string; collectionId: string; requestId: string }): Promise<KnowledgePublication> {
    uuidSchema.parse(input.requestId); const owner = ownerFor(input); const scope = this.capture(owner); const resolved = resolveScope(owner, scope.overridden ? scope.collectionIds : undefined)
    if (!resolved.connection || !resolved.scope.collectionIds.includes(input.collectionId)) throw new IntegrationError('目标知识库不在当前项目范围内', 'denied')
    const artifact = artifactRead(owner.root, input.artifactId, input.revision); assertArtifactCurrent(owner.root, artifact)
    if (!artifact.title.trim() || artifact.title.length > 200 || artifact.body.length > 200_000) throw new IntegrationError('发布标题或正文超限，请修改后重新保存、预览')
    const collections = await knowledgePort(resolved.connection).collections(resolved.connection)
    ensureScope(owner, resolved.scope); assertArtifactCurrent(owner.root, artifact)
    if (this.capture(owner).revision !== resolved.scope.revision) throw new IntegrationError('本次知识范围已变化，请重新预览', 'conflict')
    const collection = collections.items.find((item) => item.id === input.collectionId)
    if (!collection) throw new IntegrationError('目标知识库不存在或不可访问', 'denied')
    const now = Date.now()
    const requestPayload: NonNullable<KnowledgePublication['requestPayload']> = { version: 1, body: { title: artifact.title, content: artifact.body, status: 'publish', channel: 'trellis-panel' } }
    const publication: KnowledgePublication = { requestId: input.requestId, state: 'previewed', artifactId: artifact.id, artifactRevision: artifact.revision, title: artifact.title, body: artifact.body, requestPayload, payloadHash: knowledgeHash(JSON.stringify(requestPayload)), scope: resolved.scope, collectionId: collection.id, collectionName: collection.name, createdAt: now, updatedAt: now, remoteDocumentId: null, detail: '精确预览：正文不加内容；远端字段 status=publish、channel=trellis-panel。读取目标成功不证明写入权限；确认后才尝试创建。', indexing: 'unknown' }
    return updateKnowledgeState(owner.root, (state) => {
      const old = state.publications.find((item) => item.requestId === publication.requestId)
      if (old) {
        if (old.payloadHash !== publication.payloadHash || old.collectionId !== publication.collectionId || old.scope.connectionId !== publication.scope.connectionId || old.scope.revision !== publication.scope.revision || old.scope.sessionId !== owner.sessionId || old.artifactId !== publication.artifactId) throw new IntegrationError('请求标识已绑定其他内容、目标、会话或配置版本', 'conflict')
        return old
      }
      if (state.publications.some((item) => item.artifactId === publication.artifactId && item.collectionId === publication.collectionId && item.scope.connectionId === publication.scope.connectionId && ['pending', 'uncertain'].includes(item.state))) throw new IntegrationError('此材料在该目标有待核实的发布结果；请先核对远端并解决记录，不能直接重发', 'conflict')
      state.publications.unshift(publication); return publication
    })
  }
  async confirmPublication(input: { expectedRoot: string; sessionId?: string; requestId: string }): Promise<KnowledgePublication> {
    uuidSchema.parse(input.requestId); const owner = ownerFor(input); const key = `${canonicalRoot(owner.root)}:${input.requestId}`
    const previous = readKnowledgeState(owner.root).publications.find((item) => item.requestId === input.requestId)
    if (previous && previous.scope.sessionId !== owner.sessionId) throw new IntegrationError('发布预览不属于当前会话，请在原会话核对', 'denied')
    const running = this.publicationsInFlight.get(key)
    if (running) { const result = await running; ensureOwner(owner); return result }
    const operation = this.publishOnce(owner, input.requestId)
    this.publicationsInFlight.set(key, operation)
    try { const result = await operation; ensureOwner(owner); return result }
    finally { this.publicationsInFlight.delete(key) }
  }
  private async publishOnce(owner: KnowledgeOwner, requestId: string): Promise<KnowledgePublication> {
    const previous = readKnowledgeState(owner.root).publications.find((item) => item.requestId === requestId)
    if (!previous) throw new IntegrationError('发布预览不存在', 'invalid')
    if (previous.state !== 'previewed') {
      if (previous.state === 'pending') {
        const uncertain: KnowledgePublication = { ...previous, state: 'uncertain', updatedAt: Date.now(), detail: '上次发布未取得持久化结果；需核对 WeKnora，不能自动重发' }
        updateKnowledgeState(owner.root, (state) => { const item = state.publications.find((p) => p.requestId === requestId); if (item) Object.assign(item, uncertain) })
        return uncertain
      }
      return previous
    }
    if (!previous.requestPayload) throw new IntegrationError('旧版发布预览使用不同的远端请求，请使用新请求标识重新预览', 'conflict')
    const artifact = artifactRead(owner.root, previous.artifactId, previous.artifactRevision); assertArtifactCurrent(owner.root, artifact)
    const scope = this.capture(owner); const resolved = resolveScope(owner, scope.overridden ? scope.collectionIds : undefined)
    if (!resolved.connection || resolved.scope.revision !== previous.scope.revision || resolved.scope.connectionId !== previous.scope.connectionId || resolved.scope.projectGeneration !== previous.scope.projectGeneration) throw new IntegrationError('连接或项目范围已变化，请重新预览', 'conflict')
    if (previous.requestPayload.body.title !== artifact.title || previous.requestPayload.body.content !== artifact.body || previous.payloadHash !== knowledgeHash(JSON.stringify(previous.requestPayload))) throw new IntegrationError('确认材料与发布预览不一致', 'conflict')
    updateKnowledgeState(owner.root, (state) => { const item = state.publications.find((p) => p.requestId === requestId); if (!item || item.state !== 'previewed') throw new IntegrationError('发布请求已被处理', 'conflict'); item.state = 'pending'; item.updatedAt = Date.now(); item.detail = '已持久化待发送记录；本请求不会自动重试' })
    let outcome: KnowledgePublication
    try {
      ensureScope(owner, resolved.scope)
      const response = await knowledgePort(resolved.connection).publish(resolved.connection, previous.collectionId, previous.requestPayload.body)
      outcome = { ...previous, state: 'published', remoteDocumentId: response.documentId, updatedAt: Date.now(), detail: 'WeKnora 已返回文档 ID；解析、索引和可搜索状态尚未验证' }
    } catch (error) {
      const explicitRejection = error instanceof IntegrationError && ['invalid', 'denied'].includes(error.kind)
      outcome = { ...previous, state: explicitRejection ? 'failed' : 'uncertain', updatedAt: Date.now(), detail: error instanceof IntegrationError ? error.message : '远端结果无法确认，请先核对 WeKnora' }
    }
    try { updateKnowledgeState(owner.root, (state) => { const item = state.publications.find((p) => p.requestId === requestId); if (item) Object.assign(item, outcome) }) }
    catch { throw new IntegrationError('发布已尝试，但本地结果记录失败。远端可能已创建；保留 pending，重新打开后按 uncertain 处理，勿直接重发', 'uncertain') }
    return outcome
  }
  private publicationRecords(owner: KnowledgeOwner): KnowledgePublication[] {
    ensureOwner(owner); const state = readKnowledgeState(owner.root)
    const orphaned = state.publications.filter((p) => p.state === 'pending' && !this.publicationsInFlight.has(`${canonicalRoot(owner.root)}:${p.requestId}`))
    if (orphaned.length) updateKnowledgeState(owner.root, (next) => { for (const item of next.publications) if (orphaned.some((p) => p.requestId === item.requestId)) { item.state = 'uncertain'; item.detail = '上次发布未取得确认；请先核对远端，不能自动重发'; item.updatedAt = Date.now() } })
    return readKnowledgeState(owner.root).publications
  }
  async publications(input: { expectedRoot: string }): Promise<KnowledgePublication[]> { return this.publicationRecords(ownerFor(input)).slice(0, 50) }
  async publicationPage(input: { expectedRoot: string; sessionId?: string; cursor?: string; limit?: number }): Promise<{ items: KnowledgePublication[]; nextCursor: string | null }> {
    const owner = ownerFor(input)
    if (input.cursor) uuidSchema.parse(input.cursor)
    const limit = z.number().int().min(1).max(50).parse(input.limit ?? 10)
    const records = this.publicationRecords(owner)
    const anchor = input.cursor ? records.findIndex((item) => item.requestId === input.cursor) : -1
    if (input.cursor && anchor < 0) throw new IntegrationError('发布记录游标已失效或不属于当前项目，请重新加载', 'conflict')
    const items: KnowledgePublication[] = []; let bytes = 1024; let index = anchor + 1
    for (; index < records.length && items.length < limit; index++) {
      const item = records[index]; const size = Buffer.byteLength(JSON.stringify(item)) + 1
      if (bytes + size > 2 * 1024 * 1024) break
      items.push(item); bytes += size
    }
    if (!items.length && index < records.length) throw new IntegrationError('单条发布记录超过读取限额，原始记录已保留', 'io')
    return { items, nextCursor: index < records.length ? items[items.length - 1].requestId : null }
  }
  async resolvePublication(input: { expectedRoot: string; requestId: string; outcome: 'verified_absent' | 'verified_published'; remoteDocumentId?: string; acknowledgeDuplicateRisk: boolean }): Promise<KnowledgePublication> {
    const owner = ownerFor(input)
    if (this.publicationsInFlight.has(`${canonicalRoot(owner.root)}:${input.requestId}`)) throw new IntegrationError('发布仍在处理中，不能标记远端核对结果', 'conflict')
    if (!input.acknowledgeDuplicateRisk) throw new IntegrationError('请先实际核对远端，并确认再次发布的重复风险', 'denied')
    return updateKnowledgeState(owner.root, (state) => {
      const item = state.publications.find((p) => p.requestId === input.requestId)
      if (!item || !['pending', 'uncertain'].includes(item.state)) throw new IntegrationError('此记录不是待核实状态', 'conflict')
      if (input.outcome === 'verified_published' && !input.remoteDocumentId?.trim()) throw new IntegrationError('核对成功需填写实际远端文档 ID')
      item.state = input.outcome === 'verified_published' ? 'published' : 'failed'; item.remoteDocumentId = input.remoteDocumentId?.trim() || null
      item.detail = input.outcome === 'verified_published' ? '用户已在远端人工核对并提供文档 ID；索引状态未知' : '用户声明已在远端核对不存在，并已确认再次发布仍可能重复；原记录保留'
      item.updatedAt = Date.now(); return item
    })
  }
  async clearHistory(input: { expectedRoot: string }): Promise<{ removed: number; retained: number }> {
    const owner = ownerFor(input)
    return updateKnowledgeState(owner.root, (state) => { const pinned = new Set(state.artifacts.flatMap((artifact) => artifact.sourceIds)); const before = state.sources.length; state.sources = state.sources.filter((item) => pinned.has(item.source.id)); return { removed: before - state.sources.length, retained: state.sources.length } })
  }
}
export const knowledgeAccess = new KnowledgeAccessService()
export function knowledgeFailure(error: unknown): IpcFail { return publicFail(error) }
