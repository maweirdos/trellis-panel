import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { KnowledgeArtifact, KnowledgePublication, KnowledgeScope, KnowledgeSource } from '../../../shared/knowledge-access'
import { KNOWLEDGE_READ_PAGE_LIMIT } from '../../../shared/knowledge-access'
import { atomicWriteText } from '../local-task/prd'
import { IntegrationError } from '../integrations/types'

export function knowledgeHash(value: string): string { return createHash('sha256').update(value).digest('hex') }
const identifier = z.string().min(1).max(256)
const nullable = identifier.nullable()
const scopeSchema = z.object({ id: identifier, revision: identifier, root: z.string().max(4096), projectGeneration: z.number().int(), sessionId: identifier, collectionIds: z.array(identifier).max(20), overridden: z.boolean(), bindingId: nullable, bindingRevision: z.number().nullable(), connectionId: nullable, connectionRevision: z.number().nullable(), connectionName: z.string().max(100).nullable(), instanceId: z.string().max(5000).nullable(), status: z.enum(['ok', 'empty', 'partial', 'not_configured', 'denied', 'unavailable', 'cancelled']), detail: z.string().max(1000) })
const rangeSchema = z.object({ offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), length: z.number().int().nonnegative().max(KNOWLEDGE_READ_PAGE_LIMIT), total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), unit: z.literal('utf16-code-units'), totalIsComplete: z.boolean() })
const sourceSchema: z.ZodType<KnowledgeSource> = z.object({ id: identifier, sourceHandle: identifier, title: z.string().max(2000), text: z.string().max(100_000), contentHash: identifier, kind: z.enum(['local', 'weknora']), documentId: z.string().max(4096), collectionId: nullable, relativePath: z.string().max(4096).nullable(), instanceId: z.string().max(5000).nullable(), fetchedAt: z.number(), mode: z.enum(['excerpt', 'full', 'unsupported']), truncated: z.boolean(), sessionId: identifier, turnId: z.string().max(256), scopeRevision: identifier, suppliedToAgent: z.boolean(), historical: z.boolean(), parentSourceId: identifier.optional(), documentRevision: z.string().regex(/^[a-f0-9]{16}$/).optional(), range: rangeSchema.optional() }).superRefine((source, context) => {
  if (source.range && (source.mode !== 'excerpt' || source.range.length !== source.text.length || source.range.offset + source.range.length > source.range.total)) context.addIssue({ code: 'custom', message: 'Source page does not match its exact saved range' })
})
const artifactSchema: z.ZodType<KnowledgeArtifact> = z.object({ id: identifier, revision: identifier, title: z.string().min(1).max(200), kind: z.enum(['product-requirements', 'confirmed-note']), relativePath: z.string().max(4096), body: z.string().max(200_000), sourceIds: z.array(identifier).max(100), sessionId: identifier, turnId: z.string().max(256), createdAt: z.number(), confirmed: z.boolean(), origin: z.object({ kind: z.literal('agent-conversation'), connectionGeneration: identifier, userRequestHash: identifier, review: z.literal('not_asserted') }).optional() })
const publicationPayloadSchema = z.object({ version: z.literal(1), body: z.object({ title: z.string().max(200), content: z.string().max(200_000), status: z.literal('publish'), channel: z.literal('trellis-panel') }).strict() }).strict()
const publicationSchema: z.ZodType<KnowledgePublication> = z.object({ requestId: z.string().uuid(), state: z.enum(['previewed', 'pending', 'published', 'failed', 'uncertain']), artifactId: identifier, artifactRevision: identifier, title: z.string().max(200), body: z.string().max(200_000), payloadHash: identifier, requestPayload: publicationPayloadSchema.optional(), scope: scopeSchema, collectionId: identifier, collectionName: z.string().max(1000), createdAt: z.number(), updatedAt: z.number(), remoteDocumentId: nullable, detail: z.string().max(1000), indexing: z.literal('unknown') })
export interface StoredKnowledgeSource { source: KnowledgeSource; scope: KnowledgeScope; readRevision?: string }
const conversationActionSchema = z.object({
  operationId: z.string().uuid(), payloadHash: identifier, sessionId: identifier, turnId: identifier,
  userRequestHash: identifier, connectionGeneration: identifier, kind: z.enum(['save_document', 'publish_document', 'handoff']),
  state: z.enum(['pending', 'completed', 'uncertain', 'failed']), createdAt: z.number(), updatedAt: z.number(),
  artifactId: identifier, artifactRevision: identifier, relativePath: z.string().max(4096).optional(),
  taskDir: z.string().max(256).optional(), taskSlug: z.string().max(100).optional(), createdTask: z.boolean().optional(),
  prdRevision: identifier.optional(), publicationId: z.string().uuid().optional(), detail: z.string().max(1000)
})
const conversationActionsSchema = z.object({ version: z.literal(1), actions: z.array(conversationActionSchema).max(500) })
export type ConversationAction = z.infer<typeof conversationActionSchema>
const stateSchema = z.object({ version: z.literal(1), sources: z.array(z.object({ source: sourceSchema, scope: scopeSchema, readRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(1500), artifacts: z.array(artifactSchema).max(500), publications: z.array(publicationSchema).max(500), handoffs: z.array(z.object({ artifactId: identifier, artifactRevision: identifier, taskDir: z.string().max(4096), prdRevision: identifier, createdAt: z.number() })).max(500) })
export type KnowledgeState = z.infer<typeof stateSchema>
const MAX_STATE = 20 * 1024 * 1024

function contained(root: string, target: string): boolean { const rel = relative(root, target); return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !rel.includes(':')) }
function storagePath(root: string): string {
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  const base = realpathSync(userData)
  let rootIdentity = resolve(root)
  try { rootIdentity = realpathSync(rootIdentity) } catch { /* Missing project roots retain their normalized owner identity. */ }
  if (process.platform === 'win32') rootIdentity = rootIdentity.toLowerCase()
  const dir = join(base, 'knowledge', knowledgeHash(rootIdentity))
  for (const candidate of [join(base, 'knowledge'), dir]) {
    if (existsSync(candidate) && !contained(base, realpathSync(candidate))) throw new IntegrationError('知识缓存目录越界，已拒绝写入', 'io')
    mkdirSync(candidate, { recursive: true })
    if (!contained(base, realpathSync(candidate))) throw new IntegrationError('知识缓存目录越界，已拒绝写入', 'io')
  }
  const path = join(dir, 'state.json')
  if (existsSync(path) && !contained(dir, realpathSync(path))) throw new IntegrationError('知识缓存文件越界', 'io')
  return path
}
export function readKnowledgeState(root: string): KnowledgeState {
  try {
    const path = storagePath(root)
    if (!existsSync(path)) return { version: 1, sources: [], artifacts: [], publications: [], handoffs: [] }
    if (statSync(path).size > MAX_STATE) throw new Error('limit')
    const state = stateSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    for (const entry of state.sources) if (entry.source.contentHash !== knowledgeHash(entry.source.text)) throw new Error('source checksum')
    for (const artifact of state.artifacts) if (artifact.revision !== knowledgeHash(artifact.body)) throw new Error('artifact checksum')
    for (const receipt of state.publications) {
      const payload = receipt.requestPayload
      if (payload && (payload.body.title !== receipt.title || payload.body.content !== receipt.body)) throw new Error('publication payload identity')
      const actualHash = payload ? knowledgeHash(JSON.stringify(payload)) : knowledgeHash(JSON.stringify({ title: receipt.title, content: receipt.body, status: 'published', channel: 'trellis-panel' }))
      if (receipt.payloadHash !== actualHash) throw new Error('publication checksum')
    }
    return state
  } catch { throw new IntegrationError('知识证据存储不可读、损坏或版本不兼容，原文件已保留', 'io') }
}
function actionsPath(root: string): string {
  const path = join(storagePath(root), '..', 'conversation-actions.json')
  if (existsSync(path) && !contained(resolve(path, '..'), realpathSync(path))) throw new IntegrationError('Conversation action ledger escaped its project store', 'io')
  return path
}
export function readConversationActions(root: string): ConversationAction[] {
  try {
    const path = actionsPath(root)
    if (!existsSync(path)) return []
    if (!statSync(path).isFile() || statSync(path).size > 2 * 1024 * 1024) throw new Error('limit')
    return conversationActionsSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).actions
  } catch { throw new IntegrationError('Conversation action ledger is unreadable or incompatible; original bytes preserved', 'io') }
}
export function updateConversationActions<T>(root: string, action: (actions: ConversationAction[]) => T): T {
  const actions = readConversationActions(root)
  const result = action(actions)
  try {
    const text = JSON.stringify(conversationActionsSchema.parse({ version: 1, actions }))
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('limit')
    atomicWriteText(actionsPath(root), text)
    return result
  } catch { throw new IntegrationError('Conversation action ledger persistence failed or reached its bound; no automatic action retry', 'io') }
}
export function updateKnowledgeState<T>(root: string, action: (state: KnowledgeState) => T): T {
  const state = readKnowledgeState(root)
  const result = action(state)
  try {
    const text = JSON.stringify(stateSchema.parse(state))
    if (Buffer.byteLength(text) > MAX_STATE) throw new Error('limit')
    atomicWriteText(storagePath(root), text)
    return result
  } catch { throw new IntegrationError('知识证据存储失败或达到限额（20 MiB）；未确认持久化，请导出/清理不再需要的历史后重试', 'io') }
}
