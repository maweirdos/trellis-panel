import type { IpcFail } from './ipc-errors'
import type { KnowledgeArtifactImage, KnowledgeArtifactImageInput, KnowledgeArtifactOpenLocalInput, KnowledgeArtifactOpenLocalResult } from './knowledge-document-assets'

export const KNOWLEDGE_READ_PAGE_LIMIT = 6000

export type KnowledgeResult<T> = { ok: true; data: T } | IpcFail
export type KnowledgeStatus = 'ok' | 'empty' | 'partial' | 'not_configured' | 'denied' | 'unavailable' | 'cancelled'
export interface KnowledgeCollection { id: string; name: string; knowledgeCount: number }
export interface KnowledgeScope {
  id: string; revision: string; root: string; projectGeneration: number
  sessionId: string; collectionIds: string[]; overridden: boolean
  bindingId: string | null; bindingRevision: number | null
  connectionId: string | null; connectionRevision: number | null
  connectionName: string | null; instanceId: string | null
  status: KnowledgeStatus; detail: string
}
export interface KnowledgeSource {
  id: string; sourceHandle: string; title: string; text: string; contentHash: string
  kind: 'local' | 'weknora'; documentId: string; collectionId: string | null
  relativePath: string | null; instanceId: string | null; fetchedAt: number
  mode: 'excerpt' | 'full' | 'unsupported'; truncated: boolean
  sessionId: string; turnId: string; scopeRevision: string
  suppliedToAgent: boolean; historical: boolean
  range?: KnowledgeSourceRange
}
export interface KnowledgeSourceRange {
  offset: number; length: number; total: number; unit: 'utf16-code-units'
  totalIsComplete: boolean
}
export interface KnowledgeSearchResult {
  operationId: string; status: KnowledgeStatus; detail: string; scope: KnowledgeScope
  sources: KnowledgeSource[]; elapsedMs: number; persistence: 'durable' | 'degraded'
}
export interface KnowledgeReadResult {
  operationId: string; status: KnowledgeStatus; detail: string
  source: KnowledgeSource | null; persistence: 'durable' | 'degraded'
  range?: KnowledgeSourceRange; nextOffset?: number | null
}
export interface KnowledgeDocument { sourceHandle: string; id: string; title: string; fileType: string; parseStatus: string; collectionId: string }
export interface KnowledgeArtifact {
  id: string; revision: string; title: string; kind: 'product-requirements' | 'confirmed-note'
  relativePath: string; body: string; sourceIds: string[]; sessionId: string; turnId: string
  createdAt: number; confirmed: boolean
  origin?: { kind: 'agent-conversation'; connectionGeneration: string; userRequestHash: string; review: 'not_asserted' }
}
export interface KnowledgePublication {
  requestId: string; state: 'previewed' | 'pending' | 'published' | 'failed' | 'uncertain'
  artifactId: string; artifactRevision: string; title: string; body: string; payloadHash: string
  scope: KnowledgeScope; collectionId: string; collectionName: string
  createdAt: number; updatedAt: number; remoteDocumentId: string | null
  detail: string; indexing: 'unknown'
}
export interface KnowledgeContext { scope: KnowledgeScope; legacyImportAvailable: boolean }
export interface KnowledgeProjectInput { expectedRoot: string; sessionId?: string }
export interface KnowledgeArtifactSaveInput extends KnowledgeProjectInput {
  id?: string; expectedRevision?: string | null; title: string; body: string
  kind: KnowledgeArtifact['kind']; sourceIds?: string[]; turnId?: string
}
export interface KnowledgeApi {
  artifactImage(input: KnowledgeArtifactImageInput): Promise<KnowledgeResult<KnowledgeArtifactImage>>
  artifactOpenLocal(input: KnowledgeArtifactOpenLocalInput): Promise<KnowledgeResult<KnowledgeArtifactOpenLocalResult>>
  context(input: KnowledgeProjectInput): Promise<KnowledgeResult<KnowledgeContext>>
  collections(input: KnowledgeProjectInput & { connectionId?: string; connectionRevision?: number }): Promise<KnowledgeResult<{ items: KnowledgeCollection[]; hasMore: boolean }>>
  updateScope(input: KnowledgeProjectInput & { collectionIds: string[] | null }): Promise<KnowledgeResult<KnowledgeScope>>
  search(input: KnowledgeProjectInput & { requestId: string; query: string; limit?: number }): Promise<KnowledgeResult<KnowledgeSearchResult>>
  documents(input: KnowledgeProjectInput & { collectionId: string; page?: number }): Promise<KnowledgeResult<{ items: KnowledgeDocument[]; page: number; hasMore: boolean }>>
  read(input: KnowledgeProjectInput & { requestId: string; sourceHandle: string }): Promise<KnowledgeResult<KnowledgeReadResult>>
  source(input: KnowledgeProjectInput & { sourceId: string }): Promise<KnowledgeResult<KnowledgeSource>>
  sources(input: KnowledgeProjectInput): Promise<KnowledgeResult<KnowledgeSource[]>>
  cancel(input: { requestId: string }): Promise<KnowledgeResult<null>>
  importLegacy(input: KnowledgeProjectInput & { bindProject: boolean }): Promise<KnowledgeResult<KnowledgeContext>>
  saveArtifact(input: KnowledgeArtifactSaveInput): Promise<KnowledgeResult<KnowledgeArtifact>>
  artifacts(input: KnowledgeProjectInput): Promise<KnowledgeResult<KnowledgeArtifact[]>>
  artifact(input: KnowledgeProjectInput & { artifactId: string; revision: string }): Promise<KnowledgeResult<KnowledgeArtifact>>
  taskPrd(input: KnowledgeProjectInput & { taskDir: string }): Promise<KnowledgeResult<{ body: string; revision: string | null }>>
  handoff(input: KnowledgeProjectInput & { artifactId: string; revision: string; taskDir: string; developerBody: string; expectedPrdRevision: string | null }): Promise<KnowledgeResult<{ taskDir: string; prdRevision: string; productPath: string; productRevision: string }>>
  previewPublication(input: KnowledgeProjectInput & { artifactId: string; revision: string; collectionId: string; requestId: string }): Promise<KnowledgeResult<KnowledgePublication>>
  confirmPublication(input: KnowledgeProjectInput & { requestId: string }): Promise<KnowledgeResult<KnowledgePublication>>
  publications(input: KnowledgeProjectInput): Promise<KnowledgeResult<KnowledgePublication[]>>
  publicationPage(input: KnowledgeProjectInput & { cursor?: string; limit?: number }): Promise<KnowledgeResult<{ items: KnowledgePublication[]; nextCursor: string | null }>>
  resolvePublication(input: KnowledgeProjectInput & { requestId: string; outcome: 'verified_absent' | 'verified_published'; remoteDocumentId?: string; acknowledgeDuplicateRisk: boolean }): Promise<KnowledgeResult<KnowledgePublication>>
  clearHistory(input: KnowledgeProjectInput): Promise<KnowledgeResult<{ removed: number; retained: number }>>
}
