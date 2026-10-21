import { z } from 'zod'
import { ipcEvent, ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import { handle } from './registry'
import { knowledgeAccess, knowledgeFailure } from '../services/knowledge-access/service'
import { getProjectGeneration } from '../state'
import { IntegrationError } from '../services/integrations/types'
import { broadcastToWindows } from '../services/bridge'
import { KnowledgeDocumentError, openKnowledgeArtifactLocal, readKnowledgeArtifactImage } from '../services/knowledge-access/document-assets'
import { KNOWLEDGE_DOCUMENT_IMAGE_MAX_CONCURRENT } from '../../shared/knowledge-document-assets'

const project = z.object({ expectedRoot: z.string().min(1).max(4096), sessionId: z.string().min(1).max(256).optional() })
const request = project.extend({ requestId: z.string().uuid() })
const withQuery = request.extend({ query: z.string().max(2000), limit: z.number().int().min(1).max(30).optional() })
const withScope = project.extend({ collectionIds: z.array(z.string().min(1).max(256)).max(20).nullable() })
const wrap = <T>(run: () => Promise<T> | T): Promise<unknown> => Promise.resolve().then(run).then((data) => ({ ok: true as const, data })).catch((error) => error instanceof z.ZodError ? ipcFail(IpcErrorCode.InvalidArg, '知识操作参数无效') : knowledgeFailure(error))
const documentContext = project.extend({ sessionId: z.string().min(1).max(256), artifactId: z.string().min(1).max(256), revision: z.string().min(1).max(128) })
export function registerKnowledgeAccessIpc(): void {
  const c = ipcInvoke.knowledgeAccess
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
  handle(c.context, (_e, raw) => wrap(() => knowledgeAccess.context(project.parse(raw))))
  handle(c.collections, (_e, raw) => wrap(() => knowledgeAccess.collections(project.extend({ connectionId: z.string().max(256).optional(), connectionRevision: z.number().int().positive().optional() }).parse(raw))))
  handle(c.updateScope, (_e, raw) => wrap(() => knowledgeAccess.updateScope(withScope.parse(raw))))
  handle(c.search, (event, raw) => wrap(() => {
    const input = withQuery.parse(raw); const owner = { root: input.expectedRoot, projectGeneration: getProjectGeneration(), sessionId: input.sessionId || 'ui', turnId: `ui-${input.requestId}` }
    const scope = knowledgeAccess.capture(owner)
    return readOperation(event, input, (signal) => knowledgeAccess.search(owner, scope, input, signal))
  }))
  handle(c.documents, (_e, raw) => wrap(() => knowledgeAccess.documents(project.extend({ collectionId: z.string().min(1).max(256), page: z.number().int().min(1).max(200).optional() }).parse(raw))))
  handle(c.read, (event, raw) => wrap(() => {
    const input = request.extend({ sourceHandle: z.string().min(1).max(512) }).parse(raw)
    const owner = { root: input.expectedRoot, projectGeneration: getProjectGeneration(), sessionId: input.sessionId || 'ui', turnId: `ui-${input.requestId}` }; const scope = knowledgeAccess.capture(owner)
    return readOperation(event, input, (signal) => knowledgeAccess.read(owner, scope, input, signal))
  }))
  handle(c.source, (_e, raw) => wrap(() => knowledgeAccess.source(project.extend({ sourceId: z.string().min(1).max(256) }).parse(raw))))
  handle(c.sources, (_e, raw) => wrap(() => knowledgeAccess.sources(project.parse(raw))))
  handle(c.cancel, (event, raw) => wrap(() => { const input = z.object({ requestId: z.string().uuid() }).parse(raw); reads.get(`${event.sender.id}:${input.requestId}`)?.abort(); return null }))
  handle(c.importLegacy, (_e, raw) => wrap(async () => { const result = await knowledgeAccess.importLegacy(project.extend({ bindProject: z.boolean() }).parse(raw)); broadcastToWindows(ipcEvent.integrationsChanged, {}); return result }))
  handle(c.saveArtifact, (_e, raw) => wrap(() => knowledgeAccess.saveArtifact(project.extend({ id: z.string().max(256).optional(), expectedRevision: z.string().max(128).nullable().optional(), title: z.string().trim().min(1).max(200), body: z.string().max(200_000), kind: z.enum(['product-requirements', 'confirmed-note']), sourceIds: z.array(z.string().max(256)).max(100).optional(), turnId: z.string().max(256).optional() }).parse(raw))))
  handle(c.artifacts, (_e, raw) => wrap(() => knowledgeAccess.artifacts(project.parse(raw))))
  handle(c.artifact, (_e, raw) => wrap(() => knowledgeAccess.artifact(project.extend({ artifactId: z.string().max(256), revision: z.string().max(128) }).parse(raw))))
  handle(c.taskPrd, (_e, raw) => wrap(() => knowledgeAccess.taskPrd(project.extend({ taskDir: z.string().min(1).max(4096) }).parse(raw))))
  handle(c.handoff, (_e, raw) => wrap(() => knowledgeAccess.handoff(project.extend({ artifactId: z.string().max(256), revision: z.string().max(128), taskDir: z.string().min(1).max(4096), developerBody: z.string().max(200_000), expectedPrdRevision: z.string().max(128).nullable() }).parse(raw))))
  handle(c.previewPublication, (_e, raw) => wrap(() => knowledgeAccess.previewPublication(project.extend({ artifactId: z.string().max(256), revision: z.string().max(128), collectionId: z.string().max(256), requestId: z.string().uuid() }).parse(raw))))
  handle(c.confirmPublication, (_e, raw) => wrap(() => knowledgeAccess.confirmPublication(project.extend({ requestId: z.string().uuid() }).parse(raw))))
  handle(c.publications, (_e, raw) => wrap(() => knowledgeAccess.publications(project.parse(raw))))
  handle(c.publicationPage, (_e, raw) => wrap(() => knowledgeAccess.publicationPage(project.extend({ cursor: z.string().uuid().optional(), limit: z.number().int().min(1).max(50).optional() }).parse(raw))))
  handle(c.resolvePublication, (_e, raw) => wrap(() => knowledgeAccess.resolvePublication(project.extend({ requestId: z.string().uuid(), outcome: z.enum(['verified_absent', 'verified_published']), remoteDocumentId: z.string().max(256).optional(), acknowledgeDuplicateRisk: z.boolean() }).parse(raw))))
  handle(c.clearHistory, (_e, raw) => wrap(() => knowledgeAccess.clearHistory(project.parse(raw))))
}
