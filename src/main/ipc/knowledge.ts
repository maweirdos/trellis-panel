import { ipcInvoke } from '../../shared/ipc-channels'
import { errorText } from '../../shared/errors'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { kbSearch, noteUpsert, noteDelete, qaHistoryList, qaHistorySave, qaHistoryClear } from '../services/knowledge'
import { kbMcpInstall, kbMcpStatus } from '../services/kbmcp'
import { getProjectRoot } from '../state'
import { handle } from './registry'
import { app } from 'electron'

const KB_SEARCH_FAIL = { ok: false, hits: [], docs: [], totalDocs: 0, elapsedMs: 0 }
const LIBS = ['requirements', 'spec', 'wiki', 'archive', 'notes']

export function registerKnowledgeIpc(): void {
  handle(ipcInvoke.kb.search, (_e, library: string, query: string) => {
    const root = getProjectRoot()
    if (!root) return { ...KB_SEARCH_FAIL, error: '未打开项目' }
    try {
      const lib = LIBS.includes(library) ? library : 'all'
      return kbSearch(root, lib as 'all', String(query ?? ''))
    } catch (e) {
      return { ...KB_SEARCH_FAIL, error: errorText(e, '检索失败') }
    }
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
