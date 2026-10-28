import { z } from 'zod'
import { ipcEvent, ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import { handle } from './registry'
import { knowledgeFailure } from '../services/knowledge-access/service'
import { getProjectGeneration, getProjectRoot, createTaskRecord } from '../state'
import { randomUUID } from 'node:crypto'
import { runtimeCall } from '../services/daemon-client/runtime'
import { canonicalDirectory } from '../services/acp/metadata'
import type { KnowledgeRuntimeOperation } from '../../shared/daemon-runtime-knowledge'
import { DaemonError } from '../daemon/errors'
import { installKnowledgeWorkspaceHost } from '../services/knowledge-access/workspace-host'
import { IntegrationError } from '../services/integrations/types'
import { broadcastToWindows } from '../services/bridge'
import { KnowledgeDocumentError, openKnowledgeArtifactLocal, readKnowledgeArtifactImage } from '../services/knowledge-access/document-assets'
import { KNOWLEDGE_DOCUMENT_IMAGE_MAX_CONCURRENT } from '../../shared/knowledge-document-assets'
import { knowledgeReferenceDeliveryAvailable } from '../services/acp/knowledge-reference-admission'

const project = z.object({ expectedRoot: z.string().min(1).max(4096), sessionId: z.string().min(1).max(256).optional() })
const request = project.extend({ requestId: z.string().uuid() })
const withQuery = request.extend({ query: z.string().max(2000), limit: z.number().int().min(1).max(30).optional() })
const withScope = project.extend({ collectionIds: z.array(z.string().min(1).max(256)).max(20).nullable() })
const wrap = <T>(run: () => Promise<T> | T): Promise<unknown> => Promise.resolve().then(run).then((data) => ({ ok: true as const, data })).catch((error: unknown) => error instanceof z.ZodError ? ipcFail(IpcErrorCode.InvalidArg, '知识操作参数无效') : error instanceof DaemonError ? ipcFail(error.code, error.message, { outcome: error.outcome, ...('commandId' in error ? { commandId: error.commandId } : {}) }) : knowledgeFailure(error))
const knowledgeReaders = new Map<number, string>()
function readerFor(event: Electron.IpcMainInvokeEvent): string {
  let id = knowledgeReaders.get(event.sender.id)
  if (!id) { id = randomUUID(); knowledgeReaders.set(event.sender.id, id); event.sender.once('destroyed', () => { knowledgeReaders.delete(event.sender.id) }) }
  return id
}
const processReader = randomUUID()
async function nativeKnowledge(operation: KnowledgeRuntimeOperation, input: { expectedRoot: string }, readerId: string = processReader, signal?: AbortSignal): Promise<unknown> {
  const root = getProjectRoot(), generation = getProjectGeneration()
  if (!root || canonicalDirectory(root) !== canonicalDirectory(input.expectedRoot)) throw new IntegrationError('项目已切换，请回到来源项目重试', 'conflict')
  const cancel = (): void => {
    if ('requestId' in input && typeof input.requestId === 'string') void runtimeCall(root, 'runtime.knowledge', { operation: 'cancel', readerId, input: { expectedRoot: root, requestId: input.requestId } }).catch(() => {})
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    if (signal?.aborted) throw new IntegrationError('知识查询已取消', 'conflict')
    const result = await runtimeCall(root, 'runtime.knowledge', { operation, readerId, input: { ...input, expectedRoot: root } }, undefined, () => !signal?.aborted && getProjectRoot() === root && getProjectGeneration() === generation)
    if (getProjectRoot() !== root || getProjectGeneration() !== generation) throw new IntegrationError('来源项目在操作期间改变；已接纳的操作请回到来源项目核对', 'conflict')
    return result
  } finally { signal?.removeEventListener('abort', cancel) }
}
const remoteKnowledge = {
  context: (input: { expectedRoot: string }) => nativeKnowledge('context', input),
  collections: (input: { expectedRoot: string }) => nativeKnowledge('collections', input),
  updateScope: (input: { expectedRoot: string }) => nativeKnowledge('updateScope', input),
  documents: (input: { expectedRoot: string }) => nativeKnowledge('documents', input),
  folders: (input: { expectedRoot: string }) => nativeKnowledge('folders', input),
  source: (input: { expectedRoot: string }) => nativeKnowledge('source', input),
  sources: (input: { expectedRoot: string }) => nativeKnowledge('sources', input),
  importLegacy: (input: { expectedRoot: string }) => nativeKnowledge('importLegacy', input),
  saveArtifact: (input: { expectedRoot: string }) => nativeKnowledge('saveArtifact', input),
  artifacts: (input: { expectedRoot: string }) => nativeKnowledge('artifacts', input),
  artifact: (input: { expectedRoot: string }) => nativeKnowledge('artifact', input),
  taskPrd: (input: { expectedRoot: string }) => nativeKnowledge('taskPrd', input),
  handoff: (input: { expectedRoot: string }) => nativeKnowledge('handoff', input),
  previewPublication: (input: { expectedRoot: string }) => nativeKnowledge('previewPublication', input),
  confirmPublication: (input: { expectedRoot: string }) => nativeKnowledge('confirmPublication', input),
  publications: (input: { expectedRoot: string }) => nativeKnowledge('publications', input),
  publicationPage: (input: { expectedRoot: string }) => nativeKnowledge('publicationPage', input),
  resolvePublication: (input: { expectedRoot: string }) => nativeKnowledge('resolvePublication', input),
  clearHistory: (input: { expectedRoot: string }) => nativeKnowledge('clearHistory', input),
}
const documentContext = project.extend({ sessionId: z.string().min(1).max(256), artifactId: z.string().min(1).max(256), revision: z.string().min(1).max(128) })
export function registerKnowledgeAccessIpc(): void {
  installKnowledgeWorkspaceHost({ root: getProjectRoot, generation: getProjectGeneration, createTask: createTaskRecord })
  const c = ipcInvoke.knowledgeAccess
  handle(c.referenceCapability, async () => {
    if (!knowledgeReferenceDeliveryAvailable) return { supported: false }
    const root = getProjectRoot()
    if (!root) return { supported: false }
    try {
      const result = await nativeKnowledge('context', { expectedRoot: root }) as { selectionToken?: unknown }
      return { supported: typeof result.selectionToken === 'string' && /^[a-f0-9]{64}$/.test(result.selectionToken) }
    } catch { return { supported: false } }
  })
  const imageReads = new Map<number, number>()
  const withDocument = <T>(run: () => Promise<T>): Promise<unknown> => Promise.resolve().then(run).then(data => ({ ok: true as const, data })).catch(error => error instanceof KnowledgeDocumentError ? ipcFail(error.code, error.message) : error instanceof z.ZodError ? ipcFail(IpcErrorCode.InvalidArg, '文档操作参数无效') : knowledgeFailure(error))
  handle(c.artifactImage, (event, raw) => withDocument(async () => {
    const input = documentContext.extend({ src: z.string().min(1).max(4096) }).parse(raw)
    const senderId = event.sender.id, count = imageReads.get(senderId) ?? 0
    if (count >= KNOWLEDGE_DOCUMENT_IMAGE_MAX_CONCURRENT) throw new KnowledgeDocumentError(IpcErrorCode.Denied, '文档图片读取过多，请稍后重试。')
    imageReads.set(senderId, count + 1)
    try { return await readKnowledgeArtifactImage(input, () => !event.sender.isDestroyed()) }
    finally { const remaining = (imageReads.get(senderId) ?? 1) - 1; if (remaining > 0) imageReads.set(senderId, remaining); else imageReads.delete(senderId) }
  }))
  handle(c.artifactOpenLocal, (event, raw) => withDocument(() => openKnowledgeArtifactLocal(documentContext.extend({ acknowledgeChangedFile: z.boolean().optional() }).parse(raw), () => !event.sender.isDestroyed())))
  const reads = new Map<string, AbortController>()
  async function readOperation<T>(event: Electron.IpcMainInvokeEvent, input: z.infer<typeof request>, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = `${event.sender.id}:${input.requestId}`
    if (reads.has(key) || [...reads.keys()].filter((k) => k.startsWith(`${event.sender.id}:`)).length >= 4) throw new IntegrationError('知识查询已在执行或并发达到上限，请等待或取消', 'conflict')
    const controller = new AbortController(); const destroyed = (): void => controller.abort()
    reads.set(key, controller); event.sender.once('destroyed', destroyed)
    try { return await action(controller.signal) }
    finally { reads.delete(key); if (!event.sender.isDestroyed()) event.sender.removeListener('destroyed', destroyed) }
  }
  handle(c.context, (_e, raw) => wrap(async () => {
    const generation = getProjectGeneration()
    const result = await remoteKnowledge.context(project.parse(raw)) as { scope: { projectGeneration: number } }
    if (generation !== getProjectGeneration()) throw new IntegrationError('项目已切换，请重新选择知识引用', 'conflict')
    return { ...result, scope: { ...result.scope, projectGeneration: generation } }
  }))
  handle(c.rebindSource, (event, raw) => wrap(() => {
    const input = project.extend({ sessionId: z.string().min(1).max(200), sourceId: z.string().uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), expectedConnectionGeneration: z.string().min(1).max(200), expectedProjectGeneration: z.number().int().nonnegative() }).strict().parse(raw)
    if (input.expectedProjectGeneration !== getProjectGeneration()) throw new IntegrationError('项目已切换，请重新选择', 'conflict')
    return nativeKnowledge('rebindSource', input, readerFor(event))
  }))
  handle(c.collections, (_e, raw) => wrap(() => remoteKnowledge.collections(project.extend({ connectionId: z.string().max(256).optional(), connectionRevision: z.number().int().positive().optional() }).parse(raw))))
  handle(c.updateScope, (_e, raw) => wrap(() => remoteKnowledge.updateScope(withScope.parse(raw))))
  handle(c.search, (event, raw) => wrap(() => {
    const input = withQuery.parse(raw)
    return readOperation(event, input, signal => nativeKnowledge('search', input, readerFor(event), signal))
  }))
  handle(c.documents, (_e, raw) => wrap(() => remoteKnowledge.documents(project.extend({ collectionId: z.string().min(1).max(256), page: z.number().int().min(1).max(1000000).optional(), folderPath: z.string().max(4096).optional() }).parse(raw))))
  handle(c.folders, (_e, raw) => wrap(() => remoteKnowledge.folders(project.extend({ collectionId: z.string().min(1).max(256) }).parse(raw))))
  handle(c.read, (event, raw) => wrap(() => {
    const input = request.extend({ sourceHandle: z.string().min(1).max(512) }).parse(raw)
    return readOperation(event, input, signal => nativeKnowledge('read', input, readerFor(event), signal))
  }))
  handle(c.source, (_e, raw) => wrap(() => remoteKnowledge.source(project.extend({ sourceId: z.string().min(1).max(256) }).parse(raw))))
  handle(c.sources, (_e, raw) => wrap(() => remoteKnowledge.sources(project.parse(raw))))
  handle(c.cancel, (event, raw) => wrap(() => { const input = z.object({ requestId: z.string().uuid() }).parse(raw); reads.get(`${event.sender.id}:${input.requestId}`)?.abort(); return null }))
  handle(c.importLegacy, (_e, raw) => wrap(async () => { const result = await remoteKnowledge.importLegacy(project.extend({ bindProject: z.boolean() }).parse(raw)); broadcastToWindows(ipcEvent.integrationsChanged, {}); return result }))
  handle(c.saveArtifact, (_e, raw) => wrap(() => remoteKnowledge.saveArtifact(project.extend({ id: z.string().max(256).optional(), expectedRevision: z.string().max(128).nullable().optional(), title: z.string().trim().min(1).max(200), body: z.string().max(200_000), kind: z.enum(['product-requirements', 'confirmed-note']), sourceIds: z.array(z.string().max(256)).max(100).optional(), turnId: z.string().max(256).optional() }).parse(raw))))
  handle(c.artifacts, (_e, raw) => wrap(() => remoteKnowledge.artifacts(project.parse(raw))))
  handle(c.artifact, (_e, raw) => wrap(() => remoteKnowledge.artifact(project.extend({ artifactId: z.string().max(256), revision: z.string().max(128) }).parse(raw))))
  handle(c.taskPrd, (_e, raw) => wrap(() => remoteKnowledge.taskPrd(project.extend({ taskDir: z.string().min(1).max(4096) }).parse(raw))))
  handle(c.handoff, (_e, raw) => wrap(() => remoteKnowledge.handoff(project.extend({ artifactId: z.string().max(256), revision: z.string().max(128), taskDir: z.string().min(1).max(4096), developerBody: z.string().max(200_000), expectedPrdRevision: z.string().max(128).nullable() }).parse(raw))))
  handle(c.previewPublication, (_e, raw) => wrap(() => remoteKnowledge.previewPublication(project.extend({ artifactId: z.string().max(256), revision: z.string().max(128), collectionId: z.string().max(256), requestId: z.string().uuid() }).parse(raw))))
  handle(c.confirmPublication, (_e, raw) => wrap(() => remoteKnowledge.confirmPublication(project.extend({ requestId: z.string().uuid() }).parse(raw))))
  handle(c.publications, (_e, raw) => wrap(() => remoteKnowledge.publications(project.parse(raw))))
  handle(c.publicationPage, (_e, raw) => wrap(() => remoteKnowledge.publicationPage(project.extend({ cursor: z.string().uuid().optional(), limit: z.number().int().min(1).max(50).optional() }).parse(raw))))
  handle(c.resolvePublication, (_e, raw) => wrap(() => remoteKnowledge.resolvePublication(project.extend({ requestId: z.string().uuid(), outcome: z.enum(['verified_absent', 'verified_published']), remoteDocumentId: z.string().max(256).optional(), acknowledgeDuplicateRisk: z.boolean() }).parse(raw))))
  handle(c.clearHistory, (_e, raw) => wrap(() => remoteKnowledge.clearHistory(project.parse(raw))))
}
