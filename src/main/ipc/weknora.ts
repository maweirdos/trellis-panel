import { ipcInvoke } from '../../shared/ipc-channels'
import type { WeknoraConfig } from '../../shared/types'
import { weknoraTest, weknoraSearch, weknoraListDocs, weknoraReadDoc, weknoraTestMcp, weknoraMcpTokenOf } from '../services/weknora'
import { getSettings } from '../services/store'
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

  handle(ipcInvoke.weknora.search, (_e, query: string, limit?: number) =>
    weknoraSearch(getSettings().weknora, String(query ?? ''), Math.min(Math.max(Number(limit) || 10, 1), 30))
  )

  handle(ipcInvoke.weknora.listDocs, (_e, kbId: string) => weknoraListDocs(getSettings().weknora, String(kbId ?? '')))

  handle(ipcInvoke.weknora.read, (_e, knowledgeId: string) => weknoraReadDoc(getSettings().weknora, String(knowledgeId ?? '')))

  handle(ipcInvoke.weknora.testMcp, (_e, url: string, token: string) => {
    const merged = mergeWeknoraDraft({ ...getSettings().weknora, mcpUrl: String(url ?? '') })
    const plainToken = typeof token === 'string' && token ? token : weknoraMcpTokenOf(merged)
    return weknoraTestMcp(merged.mcpUrl, plainToken)
  })
}
