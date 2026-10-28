import { z } from 'zod'
import { canonicalDirectory } from '../services/acp/metadata'
import { ipcInvoke } from '../../shared/ipc-channels'
import { errorText } from '../../shared/errors'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { kbSearch, noteUpsert, noteDelete, qaHistoryList, qaHistorySave, qaHistoryClear } from '../services/knowledge'
import { browseLocalKnowledge, searchLocalKnowledge } from '../services/knowledge-browse-service'
import { kbMcpInstall, kbMcpStatus } from '../services/kbmcp'
import { getProjectRoot, getProjectGeneration } from '../state'
import { handle } from './registry'
import { app } from 'electron'

const KB_SEARCH_FAIL = { ok: false, hits: [], docs: [], totalDocs: 0, elapsedMs: 0 }
const LIBS = ['requirements', 'spec', 'wiki', 'archive', 'notes']
const folderPathSchema = z.string().max(4096).refine((value) => !value.includes('\\') && !value.includes(':') && !value.startsWith('/') && (value === '' || value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')))

export function registerKnowledgeIpc(): void {
  handle(ipcInvoke.kb.search, (_e, library: string, query: string, scope?: unknown) => {
    const root = getProjectRoot()
    if (!root) return { ...KB_SEARCH_FAIL, error: '未打开项目' }
    if (scope !== undefined) {
      const parsed = z.object({ expectedRoot: z.string().min(1).max(4096), folderPath: folderPathSchema, folderRecursive: z.boolean().optional() }).strict().safeParse(scope)
      const validLibrary = z.enum(['all', 'requirements', 'spec', 'wiki', 'archive', 'notes']).safeParse(library)
      const validQuery = z.string().max(2000).refine((value) => value.trim().length > 0).safeParse(query)
      if (!parsed.success || !validLibrary.success || !validQuery.success) return { ...KB_SEARCH_FAIL, ...ipcFail(IpcErrorCode.InvalidArg, '目录搜索参数无效') }
      const generation = getProjectGeneration()
      if (canonicalDirectory(root) !== canonicalDirectory(parsed.data.expectedRoot)) return { ...KB_SEARCH_FAIL, ...ipcFail(IpcErrorCode.Conflict, '项目已切换，请重新搜索') }
      return searchLocalKnowledge(root, generation, validLibrary.data, validQuery.data, parsed.data).then((result) => {
        if (getProjectRoot() !== root || getProjectGeneration() !== generation) return { ...KB_SEARCH_FAIL, ...ipcFail(IpcErrorCode.Conflict, '项目已切换，请重新搜索') }
        return result
      }).catch((error: unknown) => ({ ...KB_SEARCH_FAIL, ...ipcFail(IpcErrorCode.Io, errorText(error, '目录搜索失败')) }))
    }
    try {
      const lib = LIBS.includes(library) ? library : 'all'
      return kbSearch(root, lib as 'all', String(query ?? ''))
    } catch (e) {
      return { ...KB_SEARCH_FAIL, error: errorText(e, '检索失败') }
    }
  })

  handle(ipcInvoke.kb.browse, async (_e, raw: unknown) => {
    const schema = z.object({
      expectedRoot: z.string().min(1).max(4096), sessionId: z.string().min(1).max(256).optional(),
      library: z.enum(['all', 'requirements', 'spec', 'wiki', 'archive', 'notes']).optional(),
      page: z.number().int().min(1).max(1_000_000).optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
      folderPath: folderPathSchema.optional(),
      folderRecursive: z.boolean().optional(), forceRefresh: z.boolean().optional()
    }).strict()
    const parsed = schema.safeParse(raw)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '本地知识分页参数无效')
    const root = getProjectRoot(), generation = getProjectGeneration()
    if (!root) return noProject()
    if (canonicalDirectory(root) !== canonicalDirectory(parsed.data.expectedRoot)) return ipcFail(IpcErrorCode.Conflict, '项目已切换，请重新加载知识列表')
    try {
      const result = await browseLocalKnowledge(root, generation, parsed.data)
      if (getProjectRoot() !== root || getProjectGeneration() !== generation) return ipcFail(IpcErrorCode.Conflict, '项目已切换，请重新加载知识列表')
      return result
    } catch (error) { return ipcFail(IpcErrorCode.Io, errorText(error, '本地知识分页读取失败')) }
  })

  handle(ipcInvoke.kb.saveNote, (_e, fileName: string, content: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const res = noteUpsert(root, String(fileName ?? ''), String(content ?? ''))
    if (!res.ok) return ipcFail(IpcErrorCode.InvalidArg, res.error ?? '保存失败')
    return { ok: true, path: res.path }
  })

  handle(ipcInvoke.kb.deleteNote, (_e, fileName: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const res = noteDelete(root, String(fileName ?? ''))
    if (!res.ok) return ipcFail(IpcErrorCode.InvalidArg, res.error ?? '删除失败')
    return { ok: true }
  })

  /* 问答历史（userData，个人维度） */
  handle(ipcInvoke.kb.qaHistory, () => ({ ok: true, entries: qaHistoryList(app) }))
  handle(ipcInvoke.kb.qaSave, (_e, entry: Record<string, unknown>) => {
    const e = entry as { question?: string; answer?: string; sources?: Array<{ title: string; path: string; library?: string }> }
    if (!e?.question || !e?.answer) return ipcFail(IpcErrorCode.InvalidArg, '问答内容不完整')
    const saved = {
      id: `qa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      question: String(e.question),
      answer: String(e.answer),
      sources: Array.isArray(e.sources) ? e.sources.slice(0, 10) : [],
      createdAt: Date.now()
    }
    return { ok: true, entries: qaHistorySave(app, saved) }
  })
  handle(ipcInvoke.kb.qaClear, () => {
    qaHistoryClear(app)
    return { ok: true }
  })

  handle(ipcInvoke.kbmcp.install, () => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return kbMcpInstall(root)
  })

  // kbMcpStatus 原生接受 null（未打开项目时返回未安装态），保持原语义
  handle(ipcInvoke.kbmcp.status, () => kbMcpStatus(getProjectRoot()))
}
