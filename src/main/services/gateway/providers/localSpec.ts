import { join } from 'path'
import { existsSync, readdirSync } from 'fs'
import { kbSearch } from '../../knowledge'
import type { ContextHit, McpContextProvider } from '../types'
import type { KbHit } from '../../../../shared/types'

export const LocalSpecProvider: McpContextProvider = {
  id: 'local_spec',
  name: '本地规范基线 (Spec & FRAS)',
  description: '项目本地 .trellis/spec/** 与工作流规范约束，提供零延迟高密度红线规则',
  isRemote: false,

  isEnabled: (_root: string) => true,

  getItemCount: async (root: string) => {
    if (!root) return 0
    const specDir = join(root, '.trellis', 'spec')
    if (!existsSync(specDir)) return 0
    try {
      const files = readdirSync(specDir, { recursive: true }) as string[]
      return files.filter((f) => typeof f === 'string' && (f.endsWith('.md') || f.endsWith('.txt'))).length
    } catch {
      return 0
    }
  },

  testConnection: async (root?: string) => {
    if (!root) return { ok: false, error: '未打开有效项目' }
    const specDir = join(root, '.trellis', 'spec')
    const hasSpec = existsSync(specDir)
    return {
      ok: true,
      details: {
        specDir,
        exists: hasSpec
      }
    }
  },

  search: async (query: string, limit: number, root: string): Promise<ContextHit[]> => {
    if (!root) return []
    try {
      const res = kbSearch(root, 'spec', query)
      if (!res.ok || !res.hits) return []
      return res.hits.slice(0, limit).map((h: KbHit, i: number) => ({
        id: `local_spec:${h.doc.id || i}`,
        title: h.doc.title || h.doc.name,
        source: 'local_spec',
        sourceLabel: '本地 Spec',
        path: h.doc.path,
        snippet: h.snippet || '',
        score: h.score,
        metadata: {
          library: h.doc.library,
          mtime: h.doc.mtime,
          group: h.doc.group
        }
      }))
    } catch (e) {
      console.error('[LocalSpecProvider] search error:', e)
      return []
    }
  }
}
