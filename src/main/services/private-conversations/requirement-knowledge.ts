import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import {
  requirementKnowledgeConnectionSchema, requirementKnowledgeSearchSchema, requirementKnowledgeSelectionSchema,
  requirementKnowledgeSourceRefSchema, requirementKnowledgeSourceSnapshotSchema,
  type RequirementKnowledgeCollection, type RequirementKnowledgeConnection, type RequirementKnowledgeConnectionChoice,
  type RequirementKnowledgeSearchInput, type RequirementKnowledgeSearchResult, type RequirementKnowledgeSelection,
  type RequirementKnowledgeSourceRef, type RequirementKnowledgeSourceSnapshot
} from '../../../shared/conversation-requirement-knowledge'
import { resolveConnection } from '../integrations/service'
import { readIntegrationState } from '../integrations/repository'
import { integrationRegistry } from '../integrations/providers'
import { IntegrationError, type KnowledgePort, type ResolvedConnection } from '../integrations/types'
import { knowledgeAccess } from '../knowledge-access/service'
import { withKnowledgeOwner } from '../knowledge-access/workspace-host'
import type { KnowledgeOwner } from '../knowledge-access/types'

const MAX_SOURCES = 8
const MAX_SOURCE_BYTES = 64 * 1024
const MAX_CACHE_BYTES = 2 * 1024 * 1024
const CACHE_MS = 20 * 60_000
const referenceList = z.array(requirementKnowledgeSourceRefSchema).max(MAX_SOURCES)
  .refine(values => new Set(values.map(value => value.sourceId)).size === values.length, '来源引用不能重复')
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Main supplies an original private owner/operation fence, never renderer ownership fields. */
export interface RequirementKnowledgeOwner {
  conversationId: string
  creatorId: string
  root: string
  assertCurrent(): void
}
type CollectionPage = { items: RequirementKnowledgeCollection[]; hasMore: boolean }
export interface RequirementKnowledgePorts {
  connections(): RequirementKnowledgeConnectionChoice[]
  resolve(input: RequirementKnowledgeConnection): ResolvedConnection
  collections(owner: KnowledgeOwner, input: RequirementKnowledgeConnection, signal?: AbortSignal): Promise<CollectionPage>
  search: KnowledgePort['search']
}
const defaultPorts: RequirementKnowledgePorts = {
  connections: () => readIntegrationState().connections.filter(value => value.providerId === 'weknora' && value.enabled && !value.deleted)
    .map(value => ({ connectionId: value.id, connectionRevision: value.revision, name: value.name })),
  resolve: resolveConnection,
  collections: (owner, input) => knowledgeAccess.collections({ expectedRoot: owner.root, sessionId: owner.sessionId, ...input }),
  search: (connection, ids, query, limit, signal) => {
    const port = integrationRegistry.get('weknora').knowledge
    if (!port) throw new IntegrationError('知识连接读取能力尚未安装', 'denied')
    return port.search(connection, ids, query, limit, signal)
  }
}

function selectionKey(selection: RequirementKnowledgeSelection): string {
  return JSON.stringify({ ...selection, collectionIds: [...selection.collectionIds].sort() })
}
function revisionOf(source: Omit<RequirementKnowledgeSourceSnapshot, 'returnedRevision' | 'sourceId' | 'fetchedAt'>): string {
  return hash(JSON.stringify([selectionKey(source.selection), source.instanceId, source.collectionId, source.documentId, source.title, source.contentHash, source.truncated]))
}
function frozen(source: RequirementKnowledgeSourceSnapshot): RequirementKnowledgeSourceSnapshot {
  Object.freeze(source.selection.collectionIds); Object.freeze(source.selection)
  return Object.freeze(source)
}

/** Validates a server-sealed operation snapshot after persistence; it grants no new source access. */
export function validateRequirementKnowledgeSourceSnapshot(raw: unknown): RequirementKnowledgeSourceSnapshot {
  const source = requirementKnowledgeSourceSnapshotSchema.parse(raw)
  if (hash(source.excerpt) !== source.contentHash || revisionOf(source) !== source.returnedRevision) throw new IntegrationError('已封存的知识引用内容或版本已改变', 'conflict')
  return frozen(source)
}

/** Read cache only; the reserved operation must durably seal selected sources before native generation. */
export class RequirementKnowledgeService {
  private snapshots = new Map<string, { owner: string; source: RequirementKnowledgeSourceSnapshot; bytes: number; expires: number }>()
  private cachedBytes = 0
  private reading = 0
  constructor(private readonly ports: RequirementKnowledgePorts = defaultPorts) {}

  private guard(owner: RequirementKnowledgeOwner, signal?: AbortSignal): void {
    owner.assertCurrent()
    if (!owner.conversationId || !owner.creatorId || !isAbsolute(owner.root) || owner.root.includes('\0')) throw new IntegrationError('需求知识来源缺少原会话身份', 'denied')
    if (signal?.aborted) throw new IntegrationError('知识检索已取消', 'conflict')
  }
  private ownerKey(owner: RequirementKnowledgeOwner): string {
    const root = resolve(owner.root)
    return JSON.stringify([owner.conversationId, owner.creatorId, process.platform === 'win32' ? root.toLowerCase() : root])
  }
  private nativeOwner(owner: RequirementKnowledgeOwner): KnowledgeOwner {
    return { root: owner.root, projectGeneration: 0, sessionId: `requirement:${owner.conversationId}`, turnId: `knowledge-${randomUUID()}`,
      isCurrent: () => { try { owner.assertCurrent(); return true } catch { return false } } }
  }
  private connection(input: RequirementKnowledgeConnection): ResolvedConnection {
    const connection = this.ports.resolve({ connectionId: input.connectionId, connectionRevision: input.connectionRevision })
    if (connection.public.providerId !== 'weknora' || !connection.public.enabled || connection.public.id !== input.connectionId || connection.public.revision !== input.connectionRevision) throw new IntegrationError('知识连接已变化或不可读取', 'denied')
    return connection
  }
  private remove(id: string): void {
    const entry = this.snapshots.get(id)
    if (entry) this.cachedBytes -= entry.bytes
    this.snapshots.delete(id)
  }
  private prune(): void { for (const [id, entry] of this.snapshots) if (entry.expires <= Date.now()) this.remove(id) }

  async connections(owner: RequirementKnowledgeOwner): Promise<RequirementKnowledgeConnectionChoice[]> {
    this.guard(owner)
    const items = this.ports.connections()
    if (items.length > 100) throw new IntegrationError('知识连接列表超过读取上限', 'io')
    this.guard(owner)
    return items.map(value => ({ ...requirementKnowledgeConnectionSchema.parse({ connectionId: value.connectionId, connectionRevision: value.connectionRevision }), name: value.name }))
  }

  async collections(owner: RequirementKnowledgeOwner, raw: RequirementKnowledgeConnection, signal?: AbortSignal): Promise<CollectionPage> {
    this.guard(owner, signal)
    const input = requirementKnowledgeConnectionSchema.parse(raw), before = this.connection(input), native = this.nativeOwner(owner)
    const result = await withKnowledgeOwner(native, () => this.ports.collections(native, input, signal))
    this.guard(owner, signal)
    if (this.connection(input).instanceId !== before.instanceId) throw new IntegrationError('知识连接来源已变化', 'conflict')
    if (result.items.length > 100 || new Set(result.items.map(value => value.id)).size !== result.items.length) throw new IntegrationError('知识库列表身份或数量无效', 'upstream')
    return result
  }

  async search(owner: RequirementKnowledgeOwner, raw: RequirementKnowledgeSearchInput, signal?: AbortSignal): Promise<RequirementKnowledgeSearchResult> {
    this.guard(owner, signal)
    const input = requirementKnowledgeSearchSchema.parse(raw)
    if (this.reading >= 4) throw new IntegrationError('知识检索繁忙，请稍后重试', 'conflict')
    this.reading++
    const abort = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])
    try {
      const selection = input.selection, connection = this.connection(selection)
      const available = await this.collections(owner, { connectionId: selection.connectionId, connectionRevision: selection.connectionRevision }, abort)
      if (selection.collectionIds.some(id => !available.items.some(value => value.id === id))) throw new IntegrationError(available.hasMore ? '所选知识库未在已返回的可访问列表中，目录还有更多内容' : '所选知识库当前不可访问', 'denied')
      const native = this.nativeOwner(owner)
      const result = await withKnowledgeOwner(native, () => this.ports.search(connection, [...selection.collectionIds], input.query, input.limit, abort))
      this.guard(owner, abort)
      if (this.connection(selection).instanceId !== connection.instanceId) throw new IntegrationError('知识连接来源已变化', 'conflict')
      if (result.items.length > input.limit) throw new IntegrationError('知识搜索返回数量超过请求上限', 'upstream')
      const sources: RequirementKnowledgeSourceSnapshot[] = [], seen = new Set<string>()
      let bytes = 2, omittedCount = 0
      for (const hit of result.items) {
        if (!selection.collectionIds.includes(hit.collectionId)) throw new IntegrationError('知识搜索返回了选择范围外的文档', 'denied')
        const contentHash = hash(hit.text), key = JSON.stringify([hit.collectionId, hit.documentId, contentHash])
        if (seen.has(key) || !hit.text.trim()) { omittedCount++; continue }
        seen.add(key)
        const body = { selection: { ...selection, collectionIds: [...selection.collectionIds] }, instanceId: connection.instanceId,
          collectionId: hit.collectionId, documentId: hit.documentId, title: hit.title, excerpt: hit.text, contentHash, truncated: hit.truncated }
        const source = requirementKnowledgeSourceSnapshotSchema.parse({ ...body, sourceId: randomUUID(), fetchedAt: Date.now(), returnedRevision: revisionOf(body) })
        const size = Buffer.byteLength(JSON.stringify(source))
        const framedSize = size + (sources.length ? 1 : 0)
        if (sources.length >= MAX_SOURCES || bytes + framedSize > MAX_SOURCE_BYTES) { omittedCount++; continue }
        bytes += framedSize; sources.push(frozen(source))
      }
      this.guard(owner, abort); this.prune()
      for (const source of sources) {
        const size = Buffer.byteLength(JSON.stringify(source))
        while (this.snapshots.size >= 128 || this.cachedBytes + size > MAX_CACHE_BYTES) {
          const oldest = this.snapshots.keys().next().value
          if (!oldest) throw new IntegrationError('知识引用缓存超过读取上限', 'io')
          this.remove(oldest)
        }
        this.snapshots.set(source.sourceId, { owner: this.ownerKey(owner), source, bytes: size, expires: Date.now() + CACHE_MS }); this.cachedBytes += size
      }
      return { selection: { ...selection, collectionIds: [...selection.collectionIds] }, sources,
        items: sources.map(source => { let summary = source.excerpt.replace(/\s+/g, ' ').slice(0, 240); if (/[\uD800-\uDBFF]$/.test(summary)) summary = summary.slice(0, -1)
          return { sourceId: source.sourceId, returnedRevision: source.returnedRevision, title: source.title, summary, collectionId: source.collectionId, documentId: source.documentId, truncated: source.truncated } }),
        partial: result.partial || omittedCount > 0, omittedCount }
    } finally { this.reading-- }
  }

  resolveSources(owner: RequirementKnowledgeOwner, rawSelection: RequirementKnowledgeSelection, rawRefs: RequirementKnowledgeSourceRef[]): RequirementKnowledgeSourceSnapshot[] {
    this.guard(owner); this.prune()
    const selection = requirementKnowledgeSelectionSchema.parse(rawSelection), refs = referenceList.parse(rawRefs), connection = this.connection(selection)
    const sources = refs.map(reference => {
      const stored = this.snapshots.get(reference.sourceId), source = stored?.source
      if (!stored || !source || stored.owner !== this.ownerKey(owner) || selectionKey(source.selection) !== selectionKey(selection) || source.instanceId !== connection.instanceId || source.returnedRevision !== reference.returnedRevision || hash(source.excerpt) !== source.contentHash || revisionOf(source) !== source.returnedRevision) throw new IntegrationError('知识引用已失效或不属于原需求来源，请重新检索', 'conflict')
      return source
    })
    this.guard(owner)
    return sources
  }

  dispose(): void { this.snapshots.clear(); this.cachedBytes = 0 }
}
