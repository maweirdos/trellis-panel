import { ipcInvoke } from '../../shared/ipc-channels'
import type { WeknoraConfig } from '../../shared/types'
import { weknoraTest, weknoraTestMcp, weknoraMcpTokenOf } from '../services/weknora'
import { getSettings } from '../services/store'
import { getProjectRoot, getProjectGeneration } from '../state'
import { knowledgeAccess, knowledgeFailure } from '../services/knowledge-access/service'
import { noProject } from '../../shared/ipc-errors'
import { randomUUID } from 'node:crypto'
import { handle } from './registry'

/** 渲染层传入草稿配置：密钥留空则回落到已保存值（加密保存后无需重输即可测试） */
function mergeWeknoraDraft(cfg: WeknoraConfig | undefined): WeknoraConfig {
  const saved = getSettings().weknora
  if (!cfg || typeof cfg !== 'object') return saved
  return {
    ...saved,
    ...cfg,
    apiKey: typeof cfg.apiKey === 'string' && cfg.apiKey ? cfg.apiKey : saved.apiKey,
    apiKeyEncrypted: typeof cfg.apiKey === 'string' && cfg.apiKey ? false : saved.apiKeyEncrypted,
    mcpToken: typeof cfg.mcpToken === 'string' && cfg.mcpToken ? cfg.mcpToken : saved.mcpToken,
    mcpTokenEncrypted: typeof cfg.mcpToken === 'string' && cfg.mcpToken ? false : saved.mcpTokenEncrypted
  }
}

export function registerWeknoraIpc(): void {
  handle(ipcInvoke.weknora.test, (_e, cfg: WeknoraConfig) => weknoraTest(mergeWeknoraDraft(cfg)))

  handle(ipcInvoke.weknora.search, async (_e, query: string, limit?: number) => {
    const root = getProjectRoot(); if (!root) return { ...noProject(), hits: [], elapsedMs: 0 }
    try {
      const owner = { root, projectGeneration: getProjectGeneration(), sessionId: 'ui', turnId: `compat-${randomUUID()}` }
      const result = await knowledgeAccess.search(owner, knowledgeAccess.capture(owner), { requestId: randomUUID(), query: String(query ?? ''), limit: Math.min(Math.max(Number(limit) || 10, 1), 30) })
      return { ok: ['ok', 'empty'].includes(result.status), status: result.status, error: ['ok', 'empty'].includes(result.status) ? undefined : result.detail, hits: result.sources.filter((source) => source.kind === 'weknora').map((source) => ({ knowledgeId: source.sourceHandle, title: source.title, filename: source.title, sourceType: 'knowledge', score: 0, content: source.text })), elapsedMs: result.elapsedMs }
    } catch (error) { return { ...knowledgeFailure(error), hits: [], elapsedMs: 0 } }
  })
  handle(ipcInvoke.weknora.listDocs, async (_e, kbId: string) => {
    const root = getProjectRoot(); if (!root) return noProject()
    try { const result = await knowledgeAccess.documents({ expectedRoot: root, collectionId: String(kbId ?? ''), sessionId: 'ui' }); return { ok: true, docs: result.items.map((item) => ({ id: item.sourceHandle, title: item.title, fileName: item.title, fileType: item.fileType, parseStatus: item.parseStatus, createdAt: '', channel: '' })), hasMore: result.hasMore } }
    catch (error) { return knowledgeFailure(error) }
  })
  handle(ipcInvoke.weknora.read, async (_e, sourceHandle: string) => {
    const root = getProjectRoot(); if (!root) return noProject()
    try { const owner = { root, projectGeneration: getProjectGeneration(), sessionId: 'ui', turnId: `compat-${randomUUID()}` }; const result = await knowledgeAccess.read(owner, knowledgeAccess.capture(owner), { requestId: randomUUID(), sourceHandle: String(sourceHandle ?? '') }); return { ok: result.status === 'ok', error: result.status === 'ok' ? undefined : result.detail, title: result.source?.title, fileName: result.source?.title, content: result.source?.text, truncated: result.source?.truncated, mode: result.source?.mode } }
    catch (error) { return knowledgeFailure(error) }
  })

  handle(ipcInvoke.weknora.testMcp, (_e, url: string, token: string) => {
    const merged = mergeWeknoraDraft({ ...getSettings().weknora, mcpUrl: String(url ?? '') })
    const plainToken = typeof token === 'string' && token ? token : weknoraMcpTokenOf(merged)
    return weknoraTestMcp(merged.mcpUrl, plainToken)
  })
}
