import { getSettings } from '../../store'
import { weknoraSearch, weknoraTest, weknoraListDocs } from '../../weknora'
import type { ContextHit, McpContextProvider } from '../types'
import type { WeknoraHit, WeknoraKbSummary } from '../../../../shared/types'

export const WeKnoraProvider: McpContextProvider = {
  id: 'weknora',
  name: 'WeKnora 企业知识库',
  description: '腾讯开源 WeKnora 知识库插件，连接企业级文档、跨团队标准与 RAG 向量检索',
  isRemote: true,

  isEnabled: (_root: string) => {
    const s = getSettings()
    return !!s?.weknora?.enabled
  },

  getItemCount: async () => {
    const s = getSettings()
    if (!s?.weknora?.enabled) return 0
    const kbIds = s.weknora.searchKbIds || []
    if (kbIds.length === 0) return 0
    let count = 0
    for (const kbId of kbIds) {
      try {
        const res = await weknoraListDocs(s.weknora, kbId)
        if (res.ok && res.docs) {
          count += res.docs.length
        }
      } catch {
        // ignore
      }
    }
    return count
  },

  testConnection: async () => {
    const s = getSettings()
    if (!s?.weknora?.enabled) {
      return { ok: false, error: 'WeKnora 插件未启用' }
    }
    const res = await weknoraTest(s.weknora)
    return {
      ok: res.ok,
      error: res.error,
      details: {
        kbs: res.kbs?.map((k: WeknoraKbSummary) => k.name)
      }
    }
  },

  search: async (query: string, limit: number): Promise<ContextHit[]> => {
    const s = getSettings()
    if (!s?.weknora?.enabled) return []
    try {
      const res = await weknoraSearch(s.weknora, query, limit)
      if (!res.ok || !res.hits) return []
      return res.hits.map((h: WeknoraHit, i: number) => ({
        id: `weknora:${h.knowledgeId || i}`,
        title: h.title || h.filename || '企业知识文档',
        source: 'weknora',
        sourceLabel: 'WeKnora 公司库',
        path: h.filename,
        snippet: h.content,
        score: h.score,
        metadata: {
          knowledgeId: h.knowledgeId,
          sourceType: h.sourceType
        }
      }))
    } catch (e) {
      console.error('[WeKnoraProvider] search error:', e)
      return []
    }
  }
}
